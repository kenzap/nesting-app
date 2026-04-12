const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  parseDXF:       (filePath) => ipcRenderer.invoke('parse-dxf', filePath),
});
