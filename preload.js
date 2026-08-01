const { contextBridge, ipcRenderer, webUtils } = require('electron');

const PRODUCT_NAME = 'Kenzap Nesting';
const APP_DESCRIPTION = 'DXF nesting desktop application with live preview and production DXF export.';
const WEBSITE_URL = 'https://kenzap.com/nesting/';
const SUPPORT_URL = 'https://kenzap.com/nesting-support/';
const RELEASES_URL = 'https://github.com/kenzap/nesting-app/releases';
const REDDIT_URL = 'https://www.reddit.com/r/kenzap/';
const LINKEDIN_URL = 'https://www.linkedin.com/company/kenzap';

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  getPathForDroppedFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  parseDXF:       (filePath, bookmark = null) => ipcRenderer.invoke('parse-dxf', { filePath, bookmark }),
  savePlacementJSON: (payload) => ipcRenderer.invoke('save-placement-json', payload),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  appMenuAction: (action) => ipcRenderer.invoke('app-menu-action', action),
  onAppMenuCommand: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app-menu-command', listener);
    return () => ipcRenderer.removeListener('app-menu-command', listener);
  },
  getAppMeta: async () => {
    try {
      const result = await ipcRenderer.invoke('get-app-meta');
      if (result?.success && result.meta) return result;
    } catch {
      // Fall through to local defaults when the handler is unavailable.
    }

    return {
      success: true,
      meta: {
        productName: PRODUCT_NAME,
        description: APP_DESCRIPTION,
        version: '',
        websiteUrl: WEBSITE_URL,
        supportUrl: SUPPORT_URL,
        releasesUrl: RELEASES_URL,
        redditUrl: REDDIT_URL,
        linkedInUrl: LINKEDIN_URL,
      },
    };
  },
  getSystemTheme: () => ipcRenderer.invoke('get-system-theme'),
  onSystemThemeChanged: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('system-theme-changed', listener);
    return () => ipcRenderer.removeListener('system-theme-changed', listener);
  },
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
  printSheetsReport: (payload) => ipcRenderer.invoke('print-sheets-report', payload),
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
