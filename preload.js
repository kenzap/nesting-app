const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  getPathForDroppedFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  parseDXF:       (filePath) => ipcRenderer.invoke('parse-dxf', filePath),
  savePlacementJSON: (payload) => ipcRenderer.invoke('save-placement-json', payload),
  loadAppSettings: () => ipcRenderer.invoke('load-app-settings'),
  saveAppSettings: (settings) => ipcRenderer.invoke('save-app-settings', settings),
  loadJobState: () => ipcRenderer.invoke('load-job-state'),
  saveJobState: (jobState) => ipcRenderer.invoke('save-job-state', jobState),
  writeDebugSVG: (payload) => ipcRenderer.invoke('write-debug-svg', payload),
  writeDebugJSON: (payload) => ipcRenderer.invoke('write-debug-json', payload),
  getNativeEngineInfo: () => ipcRenderer.invoke('get-native-engine-info'),
  runSparrow: (payload, options) => ipcRenderer.invoke('run-sparrow', payload, options),
  pollSparrow: (runId) => ipcRenderer.invoke('poll-sparrow', runId),
  stopSparrow: () => ipcRenderer.invoke('stop-sparrow'),
  chooseExportFolder: () => ipcRenderer.invoke('choose-export-folder'),
  exportSheetsDXF: (payload) => ipcRenderer.invoke('export-sheets-dxf', payload),
  toPlanarGraph: (nodes, edges, gapTolerance) => {
    const response = ipcRenderer.sendSync('to-planar-graph-sync', {
      nodes,
      edges,
      gapTolerance,
    });
    if (response?.success) return response.data;
    throw new Error(response?.error || 'to-planar-graph failed');
  },
  discoverPlanarFaces: (nodes, edges) => {
    const response = ipcRenderer.sendSync('discover-planar-faces-sync', {
      nodes,
      edges,
    });
    if (response?.success) return response.data;
    throw new Error(response?.error || 'planar-face-discovery failed');
  },
});
