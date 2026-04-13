const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  parseDXF:       (filePath) => ipcRenderer.invoke('parse-dxf', filePath),
  savePlacementJSON: (payload) => ipcRenderer.invoke('save-placement-json', payload),
  loadAppSettings: () => ipcRenderer.invoke('load-app-settings'),
  saveAppSettings: (settings) => ipcRenderer.invoke('save-app-settings', settings),
  loadJobState: () => ipcRenderer.invoke('load-job-state'),
  saveJobState: (jobState) => ipcRenderer.invoke('save-job-state', jobState),
});
