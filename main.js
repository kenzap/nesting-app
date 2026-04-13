const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

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
