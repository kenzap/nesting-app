const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;
let activeSparrowProcess = null;
let activeSparrowRun = null;

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Parse a DXF file and return structured entity data
ipcMain.handle('parse-dxf', async (event, filePath) => {
  try {
    const DxfParser = require('dxf-parser');
    const parser    = new DxfParser();
    const content   = fs.readFileSync(filePath, 'utf-8');
    const dxf       = parser.parseSync(content);
    return { success: true, data: dxf, raw: content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Open file dialog for DXF files
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select DXF Files',
    filters: [{ name: 'DXF Files', extensions: ['dxf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return [];
  return result.filePaths.map((p) => ({
    path: p,
    name: path.basename(p),
    size: fs.statSync(p).size,
  }));
});

ipcMain.handle('save-placement-json', async (event, payload) => {
  try {
    const safeName = String(payload?.name || 'nesting-job')
      .replace(/[^a-z0-9-_]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'nesting-job';
    const tempDir = path.join(app.getPath('temp'), 'nestkit-debug');
    fs.mkdirSync(tempDir, { recursive: true });

    const fileName = `${safeName}-placement.json`;
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');

    return { success: true, path: filePath, directory: tempDir };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('load-app-settings', async () => {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      return { success: true, settings: {} };
    }

    const raw = fs.readFileSync(settingsPath, 'utf-8');
    return { success: true, settings: JSON.parse(raw) || {} };
  } catch (err) {
    return { success: false, error: err.message, settings: {} };
  }
});

ipcMain.handle('save-app-settings', async (event, settings) => {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings || {}, null, 2), 'utf-8');
    return { success: true, path: settingsPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('load-job-state', async () => {
  try {
    const statePath = path.join(app.getPath('userData'), 'job-state.json');
    if (!fs.existsSync(statePath)) {
      return { success: true, state: null };
    }

    const raw = fs.readFileSync(statePath, 'utf-8');
    return { success: true, state: JSON.parse(raw) || null };
  } catch (err) {
    return { success: false, error: err.message, state: null };
  }
});

ipcMain.handle('save-job-state', async (event, jobState) => {
  try {
    const statePath = path.join(app.getPath('userData'), 'job-state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(jobState || {}, null, 2), 'utf-8');
    return { success: true, path: statePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-native-engine-info', async () => {
  try {
    const baseDir = path.join(__dirname, 'native', 'macos', 'bin');
    const sparrowPath = path.join(baseDir, 'sparrow');
    const dxfPreprocessPath = path.join(baseDir, 'dxf_preprocess');

    return {
      success: true,
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

    const baseDir = path.join(__dirname, 'native', 'macos', 'bin');
    const sparrowPath = path.join(baseDir, 'sparrow');
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

// Open a folder picker for DXF export destination
ipcMain.handle('choose-export-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Export Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { path: result.filePaths[0] };
});

// Write one DXF per strip using placement data from the strip JSON files
ipcMain.handle('export-sheets-dxf', async (event, { outputDir, jobName, inputPath, strips }) => {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const safeName = String(jobName || 'sheet')
      .replace(/[^a-z0-9-_]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'sheet';

    // Load global item shapes from the original input JSON.
    // placed_items[*].item_id references GLOBAL IDs from the input, NOT the
    // per-strip local IDs (0..N) in strip.json — they are a different namespace.
    const globalItemsById = {};
    if (inputPath && fs.existsSync(inputPath)) {
      try {
        const inputData = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
        (inputData.items || []).forEach(item => { globalItemsById[item.id] = item; });
      } catch (e) {
        // Fall through — will produce empty polygons rather than crash
      }
    }

    const RAD = Math.PI / 180;

    function applyTransform(pts, rotation, tx, ty) {
      const cos = Math.cos(rotation * RAD);
      const sin = Math.sin(rotation * RAD);
      return pts.map(([x, y]) => [
        +(cos * x - sin * y + tx).toFixed(4),
        +(sin * x + cos * y + ty).toFixed(4),
      ]);
    }

    // Build a minimal DXF string from a list of closed polygons
    // Each polygon is an array of [x, y] pairs (open ring, last pt != first pt)
    function buildDXF(polygons, sheetW, sheetH) {
      const lines = [];
      const L = s => lines.push(s);

      // Header (minimal)
      L('0'); L('SECTION');
      L('2'); L('HEADER');
      L('9'); L('$ACADVER');
      L('1'); L('AC1015');
      L('0'); L('ENDSEC');

      // Tables (just LTYPE and LAYER)
      L('0'); L('SECTION');
      L('2'); L('TABLES');

      L('0'); L('TABLE');
      L('2'); L('LTYPE');
      L('70'); L('1');
      L('0'); L('LTYPE');
      L('2'); L('CONTINUOUS');
      L('70'); L('0');
      L('3'); L('Solid line');
      L('72'); L('65');
      L('73'); L('0');
      L('40'); L('0.0');
      L('0'); L('ENDTAB');

      L('0'); L('TABLE');
      L('2'); L('LAYER');
      L('70'); L('2');
      // Layer 0: parts
      L('0'); L('LAYER');
      L('2'); L('0');
      L('70'); L('0');
      L('62'); L('7');
      L('6'); L('CONTINUOUS');
      // Layer SHEET: sheet boundary
      L('0'); L('LAYER');
      L('2'); L('SHEET');
      L('70'); L('0');
      L('62'); L('3');
      L('6'); L('CONTINUOUS');
      L('0'); L('ENDTAB');

      L('0'); L('ENDSEC');

      // Entities
      L('0'); L('SECTION');
      L('2'); L('ENTITIES');

      // Sheet boundary rectangle on SHEET layer
      if (sheetW > 0 && sheetH > 0) {
        const rect = [[0,0],[sheetW,0],[sheetW,sheetH],[0,sheetH]];
        L('0'); L('LWPOLYLINE');
        L('8'); L('SHEET');
        L('90'); L(String(rect.length));
        L('70'); L('1'); // closed
        rect.forEach(([x, y]) => { L('10'); L(x.toFixed(4)); L('20'); L(y.toFixed(4)); });
      }

      // Part polygons on layer 0
      polygons.forEach(pts => {
        if (!pts || pts.length < 3) return;
        L('0'); L('LWPOLYLINE');
        L('8'); L('0');
        L('90'); L(String(pts.length));
        L('70'); L('1'); // closed
        pts.forEach(([x, y]) => { L('10'); L(x.toFixed(4)); L('20'); L(y.toFixed(4)); });
      });

      L('0'); L('ENDSEC');
      L('0'); L('EOF');

      return lines.join('\n');
    }

    let fileCount = 0;

    for (const strip of strips) {
      if (!strip.json_path || !fs.existsSync(strip.json_path)) continue;

      let stripData;
      try {
        stripData = JSON.parse(fs.readFileSync(strip.json_path, 'utf-8'));
      } catch (e) {
        continue;
      }

      const placedItems = stripData.solution?.layout?.placed_items || [];
      const polygons = [];

      placedItems.forEach(placement => {
        // item_id is the GLOBAL id from the input JSON — look up there
        const item = globalItemsById[placement.item_id];
        if (!item?.shape?.data) return;
        const { rotation, translation: [tx, ty] } = placement.transformation;
        const transformed = applyTransform(item.shape.data, rotation, tx, ty);
        // Remove the closing duplicate point if present
        const pts = transformed[0] && transformed[transformed.length - 1] &&
          Math.abs(transformed[0][0] - transformed[transformed.length - 1][0]) < 0.01 &&
          Math.abs(transformed[0][1] - transformed[transformed.length - 1][1]) < 0.01
          ? transformed.slice(0, -1) : transformed;
        polygons.push(pts);
      });

      const sheetW = Math.ceil(strip.strip_width || 0);
      const sheetH = Math.ceil(strip.strip_height || 0);
      const idx    = String(strip.index).padStart(2, '0');
      const dxf    = buildDXF(polygons, sheetW, sheetH);
      const outPath = path.join(outputDir, `${safeName}_sheet_${idx}.dxf`);
      fs.writeFileSync(outPath, dxf, 'utf-8');
      fileCount++;
    }

    return { success: true, fileCount, outputDir };
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
