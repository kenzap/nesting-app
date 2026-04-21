const { app, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { cleanupTempArtifacts } = require('../utils/temp-retention');

function registerFileIpc({ getMainWindow }) {
  // Parse a DXF file and return structured entity data.
  ipcMain.handle('parse-dxf', async (event, filePath) => {
    try {
      const DxfParser = require('dxf-parser');
      const parser = new DxfParser();
      const content = fs.readFileSync(filePath, 'utf-8');
      const dxf = parser.parseSync(content);
      return { success: true, data: dxf, raw: content };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Open file dialog for DXF files.
  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Select DXF Files',
      filters: [{ name: 'DXF Files', extensions: ['dxf'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => ({
      path: filePath,
      name: path.basename(filePath),
      size: fs.statSync(filePath).size,
    }));
  });

  ipcMain.handle('save-placement-json', async (event, payload) => {
    try {
      const safeName = String(payload?.name || 'nesting-job')
        .replace(/[^a-z0-9-_]+/gi, '-')
        .replace(/^-+|-+$/g, '') || 'nesting-job';
      const tempDir = path.join(app.getPath('temp'), 'nestkit-debug');
      cleanupTempArtifacts(tempDir);
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

  ipcMain.handle('write-debug-svg', async (event, payload) => {
    try {
      const safeName = String(payload?.name || 'debug-contour')
        .replace(/[^a-z0-9-_]+/gi, '-')
        .replace(/^-+|-+$/g, '') || 'debug-contour';
      const debugDir = path.join(app.getAppPath(), 'etc', 'debug');
      fs.mkdirSync(debugDir, { recursive: true });

      const fileName = `${safeName}.svg`;
      const filePath = path.join(debugDir, fileName);
      fs.writeFileSync(filePath, String(payload?.svg || ''), 'utf-8');

      return { success: true, path: filePath, directory: debugDir };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.on('run-concaveman-hull-sync', (event, payload) => {
    try {
      const concavemanModule = require('concaveman');
      const concaveman = concavemanModule?.default || concavemanModule;
      event.returnValue = concaveman(
        Array.isArray(payload?.points) ? payload.points : [],
        Number.isFinite(payload?.concavity) ? payload.concavity : 2,
        Number.isFinite(payload?.lengthThreshold) ? payload.lengthThreshold : 0
      );
    } catch (err) {
      event.returnValue = null;
    }
  });

  // Open a folder picker for DXF export destination.
  ipcMain.handle('choose-export-folder', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Choose Export Folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return { path: result.filePaths[0] };
  });
}

module.exports = { registerFileIpc };
