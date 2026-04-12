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
