const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { cleanupTempArtifacts } = require('../utils/temp-retention');

const activeSparrowProcesses = new Map();
const sparrowRuns = new Map();

function isDevMode() {
  return !app.isPackaged || process.argv.includes('--dev');
}

function nativePlatformDir() {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return process.platform;
  }
}

function nativeExecutableName(baseName) {
  return process.platform === 'win32' ? `${baseName}.exe` : baseName;
}

function nativeBaseDir() {
  if (app.isPackaged && process.platform === 'darwin') {
    const helperDir = path.join(process.resourcesPath, '..', 'Helpers');
    if (fs.existsSync(helperDir)) return helperDir;
  }
  const relativeParts = ['native', nativePlatformDir(), 'bin'];
  const packagedDir = path.join(process.resourcesPath, ...relativeParts);
  if (app.isPackaged && fs.existsSync(packagedDir)) return packagedDir;
  return path.join(__dirname, '..', '..', ...relativeParts);
}

function resolveNativeExecutable(baseName) {
  return path.join(nativeBaseDir(), nativeExecutableName(baseName));
}

function shellQuote(value) {
  const text = String(value ?? '');
  if (process.platform === 'win32') return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function resolveSparrowCargoManifestPath() {
  const repoRoot = path.join(__dirname, '..', '..');
  const candidates = [
    process.env.SPARROW_CARGO_MANIFEST_PATH,
    process.env.NESTING_CARGO_MANIFEST_PATH,
    path.join(repoRoot, '..', 'nesting', 'Cargo.toml'),
  ].filter(Boolean);

  return candidates.find(candidate => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

function buildCargoRunCommand(args) {
  const manifestPath = resolveSparrowCargoManifestPath();
  if (!manifestPath) return null;

  return [
    'cargo',
    'run',
    '--manifest-path',
    manifestPath,
    '--release',
    '--bin',
    'sparrow',
    '--',
    ...args,
  ].map(shellQuote).join(' ');
}

function buildSpawnCommand(executablePath, args) {
  return [executablePath, ...args].map(shellQuote).join(' ');
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function readLiveManifestIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(/window\.__SPARROW_LIVE_MANIFEST\s*=\s*(\{[\s\S]*\})\s*;/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function countPlacedItemsInSvg(svgText) {
  const text = String(svgText || '');
  const matches = text.match(/<use\b[^>]*href="#item_[^"]+"/g);
  return matches ? matches.length : 0;
}

function collectStripSvgsFromDir(baseDir, { isPreview }) {
  if (!baseDir || !fs.existsSync(baseDir)) return [];

  const stripDirs = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^strip_\d+$/i.test(entry.name))
    .map(entry => entry.name)
    .sort();

  if (stripDirs.length) {
    return stripDirs.map(dirName => {
      const stripDir = path.join(baseDir, dirName);
      const svgFiles = fs.readdirSync(stripDir)
        .filter(name => name.toLowerCase().endsWith('.svg'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const latest = svgFiles[svgFiles.length - 1];
      if (!latest) return null;
      const svgPath = path.join(stripDir, latest);
      const svgText = fs.readFileSync(svgPath, 'utf-8');
      return {
        index: Number(dirName.match(/\d+/)?.[0] || 0),
        svg_path: svgPath,
        json_path: null,
        svg: svgText,
        item_count: countPlacedItemsInSvg(svgText),
        is_preview: isPreview,
      };
    }).filter(Boolean);
  }

  const flatSvgFiles = fs.readdirSync(baseDir)
    .filter(name => name.toLowerCase().endsWith('.svg'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latestFlat = flatSvgFiles[flatSvgFiles.length - 1];
  if (!latestFlat) return [];

  const svgPath = path.join(baseDir, latestFlat);
  const stripWidthMatch = latestFlat.match(/^\d+_([-\d.]+)_/);
  const stripWidth = stripWidthMatch ? Number(stripWidthMatch[1]) : null;
  const svgText = fs.readFileSync(svgPath, 'utf-8');

  return [{
    index: 1,
    svg_path: svgPath,
    json_path: null,
    svg: svgText,
    strip_width: Number.isFinite(stripWidth) ? stripWidth : null,
    item_count: countPlacedItemsInSvg(svgText),
    is_preview: isPreview,
  }];
}

function collectContinuousFinalArtifacts(outputDir, safeName) {
  if (!outputDir || !fs.existsSync(outputDir)) return null;

  const finalJsonPath = path.join(outputDir, `final_${safeName}.json`);
  const finalSvgPath = path.join(outputDir, `final_${safeName}.svg`);
  if (!fs.existsSync(finalJsonPath) || !fs.existsSync(finalSvgPath)) return null;

  const finalJson = readJsonIfExists(finalJsonPath);
  const solution = finalJson?.solution;
  if (!solution) return null;

  const svgText = fs.readFileSync(finalSvgPath, 'utf-8');
  const stripWidth = Number(solution.strip_width);
  const density = Number(solution.density ?? finalJson?.density);
  const itemCount = Array.isArray(solution.placed_items)
    ? solution.placed_items.length
    : countPlacedItemsInSvg(svgText);

  return {
    summaryPath: finalJsonPath,
    summary: {
      name: finalJson?.name || safeName,
      strip_count: 1,
      density: Number.isFinite(density) ? density : null,
      is_preview: false,
      strips: [{
        index: 1,
        svg_path: finalSvgPath,
        json_path: finalJsonPath,
        svg: svgText,
        strip_width: Number.isFinite(stripWidth) ? stripWidth : null,
        density: Number.isFinite(density) ? density : null,
        item_count: Number.isFinite(itemCount) ? itemCount : 0,
        is_preview: false,
      }],
    },
  };
}

function collectLiveArtifacts(runDir, safeName) {
  const liveDir = path.join(runDir, 'data', 'live');
  if (!fs.existsSync(liveDir)) return null;

  const manifestPath = path.join(liveDir, '.live_manifest.js');
  const manifest = readLiveManifestIfExists(manifestPath);
  if (manifest?.mode === 'multi_strip' && Array.isArray(manifest.strips) && manifest.strips.length) {
    const strips = manifest.strips
      .map(strip => {
        const relativeSvgPath = String(strip.svg_path || '').trim();
        if (!relativeSvgPath) return null;
        const svgPath = path.resolve(liveDir, relativeSvgPath);
        if (!fs.existsSync(svgPath)) return null;
        const svgText = fs.readFileSync(svgPath, 'utf-8');
        return {
          index: Number(strip.index) || 0,
          svg_path: svgPath,
          json_path: null,
          svg: svgText,
          strip_width: Number.isFinite(Number(strip.strip_width)) ? Number(strip.strip_width) : null,
          density: Number.isFinite(Number(strip.density)) ? Number(strip.density) : null,
          item_count: countPlacedItemsInSvg(svgText),
          state: strip.state || null,
          is_preview: true,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    if (!strips.length) return null;
    return {
      summaryPath: manifestPath,
      summary: {
        name: manifest.name || safeName,
        strip_count: Number(manifest.strip_count) || strips.length,
        current_strip: Number.isFinite(Number(manifest.current_strip)) ? Number(manifest.current_strip) : null,
        strips,
        is_preview: true,
      },
    };
  }

  const singleLiveSvgPath = path.join(liveDir, '.live_solution.svg');
  if (fs.existsSync(singleLiveSvgPath)) {
    const svgText = fs.readFileSync(singleLiveSvgPath, 'utf-8');
    return {
      summaryPath: singleLiveSvgPath,
      summary: {
        name: safeName,
        strip_count: 1,
        strips: [{
          index: 1,
          svg_path: singleLiveSvgPath,
          json_path: null,
          svg: svgText,
          item_count: countPlacedItemsInSvg(svgText),
          is_preview: true,
        }],
        is_preview: true,
      },
    };
  }

  return null;
}

function resolveOutputSubdir(runDir, preferredName, prefix) {
  const preferredPath = path.join(runDir, 'output', preferredName);
  if (fs.existsSync(preferredPath)) return preferredPath;

  const outputDir = path.join(runDir, 'output');
  if (!fs.existsSync(outputDir)) return null;

  const matches = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(entry => path.join(outputDir, entry.name))
    .sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });

  return matches[0] || null;
}

function latestSvgPerStrip(runDir, safeName) {
  const solsDir = resolveOutputSubdir(runDir, `sols_${safeName}`, 'sols_');
  return collectStripSvgsFromDir(solsDir, { isPreview: true });
}

function collectSparrowArtifacts(runDir, safeName) {
  const outputDir = path.join(runDir, 'output');
  const finalDir = resolveOutputSubdir(runDir, `final_${safeName}`, 'final_');
  if (finalDir) {
    const summaryPath = path.join(finalDir, 'summary.json');
    const summary = readJsonIfExists(summaryPath);
    const singleStripFinalSvgPath = path.join(outputDir, `final_${safeName}.svg`);
    const useSingleStripFinalSvg = !!(
      summary?.strips?.length === 1
      && fs.existsSync(singleStripFinalSvgPath)
    );

    if (summary?.strips?.length) {
      return {
        summaryPath,
        summary: {
          ...summary,
          strips: summary.strips.map((strip, index) => {
            const svgPath = useSingleStripFinalSvg && index === 0
              ? singleStripFinalSvgPath
              : path.resolve(runDir, strip.svg_path);
            const jsonPath = path.resolve(runDir, strip.json_path);
            return {
              ...strip,
              svg_path: svgPath,
              json_path: jsonPath,
              svg: fs.existsSync(svgPath) ? fs.readFileSync(svgPath, 'utf-8') : '',
              is_preview: false,
            };
          }),
        },
      };
    }

    const strips = collectStripSvgsFromDir(finalDir, { isPreview: false });
    if (strips.length) {
      return {
        summaryPath,
        summary: {
          name: safeName,
          strip_count: strips.length,
          strips,
          is_preview: false,
        },
      };
    }
  }

  const continuousFinal = collectContinuousFinalArtifacts(outputDir, safeName);
  if (continuousFinal) return continuousFinal;

  const strips = latestSvgPerStrip(runDir, safeName);
  return {
    summaryPath: null,
    summary: strips.length ? {
      name: safeName,
      strip_count: strips.length,
      strips,
      is_preview: true,
    } : null,
  };
}

function markArtifactsAsPreview(artifacts) {
  if (!artifacts?.summary) return artifacts;
  return {
    ...artifacts,
    summary: {
      ...artifacts.summary,
      is_preview: true,
      strips: Array.isArray(artifacts.summary.strips)
        ? artifacts.summary.strips.map(strip => ({ ...strip, is_preview: true }))
        : [],
    },
  };
}

function attachRunSheetMetadata(artifacts, runDir, safeName) {
  if (!artifacts?.summary) return artifacts;

  const input = readJsonIfExists(path.join(runDir, `${safeName}.json`));
  const sheet = Array.isArray(input?.sheets) ? input.sheets[0] : null;
  const sheetMargin = Math.max(0, Number(input?.settings?.sheetMargin) || 0);
  const sheetWidth = Number(sheet?.width);
  const sheetHeight = Number(sheet?.height ?? input?.strip_height);
  const sheetWidthMode = String(sheet?.width_mode || 'fixed');
  const metadata = {
    sheet_width_mode: sheetWidthMode,
    sheet_width: Number.isFinite(sheetWidth) && sheetWidth > 0 ? sheetWidth : null,
    strip_height: Number.isFinite(sheetHeight) && sheetHeight > 0 ? sheetHeight : null,
    sheet_margin: sheetMargin,
  };

  return {
    ...artifacts,
    summary: {
      ...metadata,
      ...artifacts.summary,
      strips: Array.isArray(artifacts.summary.strips)
        ? artifacts.summary.strips.map(strip => ({ ...metadata, ...strip }))
        : [],
    },
  };
}

function collectRunningSparrowArtifacts(runDir, safeName) {
  try {
    const liveArtifacts = collectLiveArtifacts(runDir, safeName);
    if (liveArtifacts?.summary?.strips?.length) return liveArtifacts;
  } catch {
    // Ignore transient live-preview read failures while Sparrow is still writing files.
  }

  try {
    // Barrier-mode builds on some platforms emit only intermediate strip SVGs
    // under output/sols_* while the run is active, even though the final_*
    // directory already exists. Probe those first so the UI can stream
    // per-strip progress instead of waiting for the completed summary.
    const strips = latestSvgPerStrip(runDir, safeName);
    if (strips.length) {
      return {
        summaryPath: null,
        summary: {
          name: safeName,
          strip_count: strips.length,
          strips,
          is_preview: true,
        },
      };
    }
  } catch {
    // Ignore transient intermediate-preview read failures while Sparrow is
    // still writing files.
  }

  try {
    const artifacts = collectSparrowArtifacts(runDir, safeName);
    if (artifacts?.summary?.strips?.length) {
      return markArtifactsAsPreview(artifacts);
    }
  } catch {
    // Ignore transient parse/read failures while Sparrow is still writing files.
  }

  return {
    summaryPath: null,
    summary: null,
  };
}

function terminateSparrowRun(runId, { markStopped = true, forceAfterMs = 2000 } = {}) {
  const child = activeSparrowProcesses.get(runId);
  if (!child) return false;

  const run = sparrowRuns.get(runId);
  if (run && markStopped && run.status === 'running') {
    run.status = 'stopped';
  }

  try {
    child.kill('SIGTERM');
  } catch {
    try {
      child.kill();
    } catch {
      return false;
    }
  }

  if (Number.isFinite(forceAfterMs) && forceAfterMs > 0) {
    const timer = setTimeout(() => {
      if (activeSparrowProcesses.get(runId) !== child) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore force-kill failures during shutdown.
      }
    }, forceAfterMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return true;
}

function terminateAllSparrowRuns(options = {}) {
  let stopped = 0;
  [...activeSparrowProcesses.keys()].forEach(runId => {
    if (terminateSparrowRun(runId, options)) stopped += 1;
  });
  return stopped;
}

function registerSparrowIpc() {
  app.on('before-quit', () => {
    terminateAllSparrowRuns({ markStopped: true, forceAfterMs: 1000 });
  });

  ipcMain.handle('get-native-engine-info', async () => {
    try {
      const baseDir = nativeBaseDir();
      const sparrowPath = resolveNativeExecutable('sparrow');

      return {
        success: true,
        platform: process.platform,
        packaged: app.isPackaged,
        baseDir,
        sparrowPath,
        exists: {
          sparrow: fs.existsSync(sparrowPath),
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('run-sparrow', async (event, payload, options = {}) => {
    try {
      const sparrowPath = resolveNativeExecutable('sparrow');
      if (!fs.existsSync(sparrowPath)) {
        return { success: false, error: `Sparrow executable not found at ${sparrowPath}` };
      }

      const safeName = String(payload?.name || 'nesting-job')
        .replace(/[^a-z0-9-_]+/gi, '-')
        .replace(/^-+|-+$/g, '') || 'nesting-job';
      const runsRootDir = path.join(app.getPath('temp'), 'nestkit-runs');
      cleanupTempArtifacts(runsRootDir);
      const runDir = path.join(runsRootDir, `${safeName}-${Date.now()}`);
      fs.mkdirSync(runDir, { recursive: true });

      const inputPath = path.join(runDir, `${safeName}.json`);
      fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf-8');

      const args = ['--input', inputPath];
      if (Number.isFinite(options.globalTime) && options.globalTime > 0) {
        args.push('--global-time', String(options.globalTime));
      }
      if (Number.isFinite(options.rngSeed)) {
        args.push('--rng-seed', String(options.rngSeed));
      }
      if (Number.isFinite(options.workers) && options.workers >= 1) {
        args.push('--workers', String(Math.trunc(options.workers)));
      }
      if (options.earlyTermination) {
        args.push('--early-termination');
      }
      if (Number.isFinite(options.maxStripLength) && options.maxStripLength > 0) {
        args.push('--max-strip-length', String(options.maxStripLength));
      }
      if (Number.isFinite(options.stripMargin) && options.stripMargin >= 0) {
        args.push('--strip-margin', String(options.stripMargin));
      }
      if (Number.isFinite(options.minItemSeparation) && options.minItemSeparation >= 0) {
        args.push('--min-item-separation', String(options.minItemSeparation));
      }
      if (Number.isFinite(options.bucketFillWeight) && options.bucketFillWeight >= 0) {
        args.push('--bucket-fill-weight', String(options.bucketFillWeight));
      }
      // Multi-strip strategy: 'barriers' (new mode, single canvas with virtual
      // separators) or 'prebucket' (legacy bucket planner). Only emitted when
      // explicitly set so older sparrow binaries that don't recognize the flag
      // can still be driven from this app.
      if (options.multiStripMode === 'barriers' || options.multiStripMode === 'prebucket') {
        args.push('--multi-strip-mode', options.multiStripMode);
      }
      // Sparrow uses its native Y-up coordinates, while the app presents the
      // normalized Y-down sheet orientation. Swap the vertical preference at
      // the engine boundary so the setting label matches what users see.
      const sparrowAlignment = {
        top: 'bottom',
        'top-left': 'bottom-left',
        'top-right': 'bottom-right',
        bottom: 'top',
        'bottom-left': 'top-left',
        'bottom-right': 'top-right',
      }[options.align];
      if (sparrowAlignment) args.push(`--align-${sparrowAlignment}`);

      if (isDevMode()) {
        const cargoCommand = buildCargoRunCommand(args);
        console.info('[Sparrow][dev] Working directory:', runDir);
        if (cargoCommand) {
          console.info('[Sparrow][dev] Cargo command:\n' + cargoCommand);
        } else {
          console.info('[Sparrow][dev] Cargo manifest not found. Set SPARROW_CARGO_MANIFEST_PATH to enable cargo command logging.');
        }
        console.info('[Sparrow][dev] Spawn command:\n' + buildSpawnCommand(sparrowPath, args));
      }

      const runId = `${safeName}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const child = spawn(sparrowPath, args, { cwd: runDir });
      sparrowRuns.set(runId, {
        id: runId,
        safeName,
        runDir,
        inputPath,
        stdout: '',
        stderr: '',
        status: 'running',
        exitCode: null,
        error: null,
      });
      activeSparrowProcesses.set(runId, child);

      child.stdout.on('data', chunk => {
        const run = sparrowRuns.get(runId);
        if (run) run.stdout += chunk.toString();
      });
      child.stderr.on('data', chunk => {
        const run = sparrowRuns.get(runId);
        if (run) run.stderr += chunk.toString();
      });

      child.on('error', error => {
        const run = sparrowRuns.get(runId);
        if (run) {
          run.status = 'error';
          run.error = error.message;
        }
        activeSparrowProcesses.delete(runId);
      });

      child.on('close', code => {
        const run = sparrowRuns.get(runId);
        if (run) {
          run.exitCode = code;
          run.status = code === 0 ? 'completed' : (run.status === 'stopped' ? 'stopped' : 'error');
          if (code !== 0 && !run.error && run.status !== 'stopped') {
            run.error = `Sparrow exited with code ${code}`;
          }
        }
        activeSparrowProcesses.delete(runId);
      });

      return {
        success: true,
        runId,
        runDir,
        inputPath,
        stdout: '',
        stderr: '',
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('stop-sparrow', async (event, runId = null) => {
    try {
      if (runId) {
        return { success: true, stopped: terminateSparrowRun(runId, { markStopped: true, forceAfterMs: 1000 }) };
      }
      return { success: true, stopped: terminateAllSparrowRuns({ markStopped: true, forceAfterMs: 1000 }) > 0 };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('poll-sparrow', async (event, runId) => {
    const run = sparrowRuns.get(runId);
    if (!run) {
      return { success: false, error: 'Run not found' };
    }

    const status = run.status;
    const rawArtifacts = status === 'running'
      ? collectRunningSparrowArtifacts(run.runDir, run.safeName)
      : collectSparrowArtifacts(run.runDir, run.safeName);
    const artifacts = attachRunSheetMetadata(rawArtifacts, run.runDir, run.safeName);
    const error = status === 'error'
      ? (run.stderr.trim() || run.stdout.trim() || run.error || 'Sparrow failed')
      : null;

    return {
      success: true,
      runId,
      status,
      runDir: run.runDir,
      inputPath: run.inputPath,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      summaryPath: artifacts.summaryPath,
      summary: artifacts.summary,
      error,
    };
  });
}

module.exports = {
  registerSparrowIpc,
};
