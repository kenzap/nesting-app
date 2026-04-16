const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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

function latestSvgPerStrip(runDir, safeName) {
  const solsDir = path.join(runDir, 'output', `sols_${safeName}`);
  if (!fs.existsSync(solsDir)) return [];

  const stripDirs = fs.readdirSync(solsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^strip_\d+$/i.test(entry.name))
    .map(entry => entry.name)
    .sort();

  return stripDirs.map(dirName => {
    const stripDir = path.join(solsDir, dirName);
    const svgFiles = fs.readdirSync(stripDir)
      .filter(name => name.toLowerCase().endsWith('.svg'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const latest = svgFiles[svgFiles.length - 1];
    if (!latest) return null;
    const svgPath = path.join(stripDir, latest);
    return {
      index: Number(dirName.match(/\d+/)?.[0] || 0),
      svg_path: svgPath,
      json_path: null,
      svg: fs.readFileSync(svgPath, 'utf-8'),
      is_preview: true,
    };
  }).filter(Boolean);
}

function collectSparrowArtifacts(runDir, safeName) {
  const finalDir = path.join(runDir, 'output', `final_${safeName}`);
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

  const strips = latestSvgPerStrip(runDir, safeName);
  return {
    summaryPath,
    summary: strips.length ? {
      name: safeName,
      strip_count: strips.length,
      strips,
      is_preview: true,
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
      const runDir = path.join(app.getPath('temp'), 'nestkit-runs', `${safeName}-${Date.now()}`);
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

    const artifacts = collectSparrowArtifacts(activeSparrowRun.runDir, activeSparrowRun.safeName);
    const status = activeSparrowRun.status;
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
