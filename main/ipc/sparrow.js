const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { cleanupTempArtifacts } = require('../utils/temp-retention');

let activeSparrowProcess = null;
let activeSparrowRun = null;

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
  const relativeParts = ['native', nativePlatformDir(), 'bin'];
  const packagedDir = path.join(process.resourcesPath, ...relativeParts);
  if (app.isPackaged && fs.existsSync(packagedDir)) return packagedDir;
  return path.join(__dirname, '..', '..', ...relativeParts);
}

function resolveNativeExecutable(baseName) {
  return path.join(nativeBaseDir(), nativeExecutableName(baseName));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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
  const continuousFinal = collectContinuousFinalArtifacts(outputDir, safeName);
  if (continuousFinal) return continuousFinal;

  const finalDir = resolveOutputSubdir(runDir, `final_${safeName}`, 'final_');
  if (!finalDir) {
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

  const summaryPath = path.join(finalDir, 'summary.json');
  const summary = readJsonIfExists(summaryPath);

  if (summary?.strips?.length) {
    return {
      summaryPath,
      summary: {
        ...summary,
        strips: summary.strips.map(strip => {
          const svgPath = path.resolve(runDir, strip.svg_path);
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
  return {
    summaryPath,
    summary: strips.length ? {
      name: safeName,
      strip_count: strips.length,
      strips,
      is_preview: false,
    } : null,
  };
}

function registerSparrowIpc() {
  ipcMain.handle('get-native-engine-info', async () => {
    try {
      const baseDir = nativeBaseDir();
      const sparrowPath = resolveNativeExecutable('sparrow');
      const dxfPreprocessPath = resolveNativeExecutable('dxf_preprocess');

      return {
        success: true,
        platform: process.platform,
        packaged: app.isPackaged,
        baseDir,
        sparrowPath,
        dxfPreprocessPath,
        exists: {
          sparrow: fs.existsSync(sparrowPath),
          dxfPreprocess: fs.existsSync(dxfPreprocessPath),
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('run-sparrow', async (event, payload, options = {}) => {
    try {
      if (activeSparrowProcess) {
        return { success: false, error: 'Sparrow is already running' };
      }

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
      if (options.align === 'top') args.push('--align-top');
      if (options.align === 'bottom') args.push('--align-bottom');

      const runId = `${safeName}-${Date.now()}`;
      const child = spawn(sparrowPath, args, { cwd: runDir });
      activeSparrowProcess = child;
      activeSparrowRun = {
        id: runId,
        safeName,
        runDir,
        inputPath,
        stdout: '',
        stderr: '',
        status: 'running',
        exitCode: null,
        error: null,
      };

      child.stdout.on('data', chunk => {
        if (activeSparrowRun) activeSparrowRun.stdout += chunk.toString();
      });
      child.stderr.on('data', chunk => {
        if (activeSparrowRun) activeSparrowRun.stderr += chunk.toString();
      });

      child.on('error', error => {
        if (activeSparrowRun) {
          activeSparrowRun.status = 'error';
          activeSparrowRun.error = error.message;
        }
        activeSparrowProcess = null;
      });

      child.on('close', code => {
        if (activeSparrowRun) {
          activeSparrowRun.exitCode = code;
          activeSparrowRun.status = code === 0 ? 'completed' : (activeSparrowRun.status === 'stopped' ? 'stopped' : 'error');
          if (code !== 0 && !activeSparrowRun.error && activeSparrowRun.status !== 'stopped') {
            activeSparrowRun.error = `Sparrow exited with code ${code}`;
          }
        }
        activeSparrowProcess = null;
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
      activeSparrowProcess = null;
      activeSparrowRun = null;
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('stop-sparrow', async () => {
    if (!activeSparrowProcess) {
      return { success: true, stopped: false };
    }

    try {
      if (activeSparrowRun) activeSparrowRun.status = 'stopped';
      activeSparrowProcess.kill('SIGTERM');
      return { success: true, stopped: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('poll-sparrow', async (event, runId) => {
    if (!activeSparrowRun || activeSparrowRun.id !== runId) {
      return { success: false, error: 'Run not found' };
    }

    const status = activeSparrowRun.status;
    const artifacts = status === 'running'
      ? {
          summaryPath: null,
          summary: (() => {
            const strips = latestSvgPerStrip(activeSparrowRun.runDir, activeSparrowRun.safeName);
            return strips.length ? {
              name: activeSparrowRun.safeName,
              strip_count: strips.length,
              strips,
              is_preview: true,
            } : null;
          })(),
        }
      : collectSparrowArtifacts(activeSparrowRun.runDir, activeSparrowRun.safeName);
    const error = status === 'error'
      ? (activeSparrowRun.stderr.trim() || activeSparrowRun.stdout.trim() || activeSparrowRun.error || 'Sparrow failed')
      : null;

    return {
      success: true,
      runId,
      status,
      runDir: activeSparrowRun.runDir,
      inputPath: activeSparrowRun.inputPath,
      stdout: activeSparrowRun.stdout,
      stderr: activeSparrowRun.stderr,
      exitCode: activeSparrowRun.exitCode,
      summaryPath: artifacts.summaryPath,
      summary: artifacts.summary,
      error,
    };
  });
}

module.exports = {
  registerSparrowIpc,
};
