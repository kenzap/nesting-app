const { app, BrowserWindow, Menu, shell, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const packageJson = require('../package.json');
const {
  handlePendingCrashReports,
  logDiagnostic,
  openDiagnosticsFolder,
} = require('./utils/diagnostics');

const productName = packageJson.productName || 'Kenzap Nesting';
const appDescription = packageJson.description || 'DXF nesting application';
const WEBSITE_URL = 'https://kenzap.com/nesting/';
const SUPPORT_URL = 'https://kenzap.com/nesting-support/';
const RELEASES_URL = 'https://github.com/kenzap/nesting-app/releases';
const REDDIT_URL = 'https://www.reddit.com/r/kenzap/';
const LINKEDIN_URL = 'https://www.linkedin.com/company/kenzap';

let mainWindow = null;
let appMenuIpcRegistered = false;
let nativeThemeBridgeRegistered = false;

function getLinuxEnvironmentName() {
  try {
    const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
    const prettyName = osRelease.match(/^PRETTY_NAME=(.*)$/m)?.[1]?.trim();
    if (prettyName) {
      return prettyName
        .replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  } catch {
    // Some packaged Linux environments do not expose /etc/os-release.
  }
  return 'Linux';
}

function getEnvironmentName() {
  const systemVersion = typeof process.getSystemVersion === 'function'
    ? process.getSystemVersion()
    : '';

  if (process.platform === 'win32') {
    const buildNumber = Number.parseInt(String(systemVersion).split('.')[2], 10);
    return Number.isFinite(buildNumber) && buildNumber >= 22000 ? 'Windows 11' : 'Windows 10';
  }
  if (process.platform === 'darwin') {
    return systemVersion ? `macOS ${systemVersion}` : 'macOS';
  }
  if (process.platform === 'linux') return getLinuxEnvironmentName();
  return systemVersion ? `${process.platform} ${systemVersion}` : process.platform;
}

function buildSupportUrl(source = 'help-menu') {
  const url = new URL(SUPPORT_URL);
  url.searchParams.set('environment', getEnvironmentName());
  url.searchParams.set('version', packageJson.version);
  url.searchParams.set('source', source);
  url.hash = 'form';
  return url.href;
}

function dispatchRendererMenuAction(action, targetWindow = mainWindow) {
  const win = targetWindow && !targetWindow.isDestroyed() ? targetWindow : mainWindow;
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  win.webContents.send('app-menu-command', { action: String(action || '') });
  return true;
}

function configureAppMetadata() {
  app.setName(productName);
  app.setAboutPanelOptions({
    applicationName: productName,
    applicationVersion: packageJson.version,
    version: packageJson.version,
    copyright: 'Copyright © Kenzap Pte Ltd',
    credits: `${appDescription}\n\nDXF nesting desktop application with live preview and production DXF export.\n\nAll nesting and preprocessing run locally using bundled helper executables. The app does not download code at runtime, does not require network access for core functionality, and terminates helper processes when quitting.`,
  });
}

function buildApplicationMenu({ isDevMode = false, isDxfDebugMode = false } = {}) {
  if (process.platform === 'linux') {
    Menu.setApplicationMenu(null);
    return;
  }

  const viewSubmenu = [
    {
      label: 'Fit to View',
      accelerator: 'CmdOrCtrl+0',
      click: (_menuItem, browserWindow) => {
        dispatchRendererMenuAction('canvas-fit-view', browserWindow || mainWindow);
      },
    },
    {
      label: 'Zoom In',
      accelerator: 'CmdOrCtrl+=',
      click: (_menuItem, browserWindow) => {
        dispatchRendererMenuAction('canvas-zoom-in', browserWindow || mainWindow);
      },
    },
    {
      label: 'Zoom Out',
      accelerator: 'CmdOrCtrl+-',
      click: (_menuItem, browserWindow) => {
        dispatchRendererMenuAction('canvas-zoom-out', browserWindow || mainWindow);
      },
    },
    { type: 'separator' },
    {
      label: 'Measure',
      click: (_menuItem, browserWindow) => {
        dispatchRendererMenuAction('toggle-measure', browserWindow || mainWindow);
      },
    },
    {
      label: 'Live Coordinates',
      click: (_menuItem, browserWindow) => {
        dispatchRendererMenuAction('toggle-cursor-coords', browserWindow || mainWindow);
      },
    },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  if (isDevMode) {
    viewSubmenu.unshift(
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
    );
  }

  const template = [
    {
      label: productName,
      submenu: [
        { role: 'about', label: `About ${productName}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${productName}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${productName}` },
      ],
    },
    {
      label: 'File',
      submenu: [
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: (_menuItem, browserWindow) => {
            dispatchRendererMenuAction('open-settings', browserWindow || mainWindow);
          },
        },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: viewSubmenu,
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: productName,
          accelerator: 'CmdOrCtrl+1',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              if (!mainWindow.isVisible()) mainWindow.show();
              mainWindow.focus();
            } else {
              createWindow({ isDevMode, isDxfDebugMode });
            }
          },
        },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Support',
          click: () => { void shell.openExternal(buildSupportUrl()); },
        },
        {
          label: 'Release Notes',
          click: () => { void shell.openExternal(RELEASES_URL); },
        },
        {
          label: 'Diagnostics Folder',
          click: () => { void openDiagnosticsFolder().catch(() => {}); },
        },
        { type: 'separator' },
        {
          label: 'Reddit Community',
          click: () => { void shell.openExternal(REDDIT_URL); },
        },
        {
          label: 'LinkedIn',
          click: () => { void shell.openExternal(LINKEDIN_URL); },
        },
        {
          label: `${productName} Website`,
          click: () => { void shell.openExternal(WEBSITE_URL); },
        },
      ],
    },
  ];

  if (process.platform !== 'darwin') {
    template[0] = {
      label: productName,
      submenu: [
        { role: 'about', label: `About ${productName}` },
        { type: 'separator' },
        { role: 'quit', label: `Exit ${productName}` },
      ],
    };
    template[4].submenu = [
      { role: 'minimize' },
      { role: 'close' },
    ];
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerAppMenuIpc() {
  if (appMenuIpcRegistered) return;
  appMenuIpcRegistered = true;

  ipcMain.handle('get-app-meta', async () => ({
    success: true,
    meta: {
      productName,
      description: appDescription,
      version: packageJson.version,
      environment: getEnvironmentName(),
      websiteUrl: WEBSITE_URL,
      supportUrl: SUPPORT_URL,
      releasesUrl: RELEASES_URL,
      redditUrl: REDDIT_URL,
      linkedInUrl: LINKEDIN_URL,
    },
  }));

  ipcMain.handle('get-system-locale', async () => ({
    success: true,
    locale: app.getLocale(),
    countryCode: typeof app.getLocaleCountryCode === 'function' ? app.getLocaleCountryCode() : '',
  }));

  ipcMain.handle('get-system-theme', async () => ({
    success: true,
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  }));

  ipcMain.handle('app-menu-action', async (event, action) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
      switch (String(action || '')) {
        case 'about':
          app.showAboutPanel();
          break;
        case 'quit':
          app.quit();
          break;
        case 'close-window':
          win?.close();
          break;
        case 'minimize-window':
          win?.minimize();
          break;
        case 'toggle-maximize-window':
          if (!win) break;
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
          break;
        case 'toggle-fullscreen':
          if (win) win.setFullScreen(!win.isFullScreen());
          break;
        case 'zoom-in':
          win?.webContents.zoomIn();
          break;
        case 'zoom-out':
          win?.webContents.zoomOut();
          break;
        case 'reset-zoom':
          win?.webContents.setZoomLevel(0);
          break;
        case 'canvas-fit-view':
        case 'canvas-zoom-in':
        case 'canvas-zoom-out':
          if (!dispatchRendererMenuAction(action, win)) {
            return { success: false, error: 'No active window to receive canvas zoom action' };
          }
          break;
        case 'open-settings':
          if (!dispatchRendererMenuAction('open-settings', win)) {
            return { success: false, error: 'No active window to receive settings action' };
          }
          break;
        case 'open-diagnostics-folder':
          await openDiagnosticsFolder();
          break;
        default:
          return { success: false, error: `Unknown app menu action: ${action}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  if (!nativeThemeBridgeRegistered) {
    nativeThemeBridgeRegistered = true;
    nativeTheme.on('updated', () => {
      const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      BrowserWindow.getAllWindows().forEach(win => {
        if (win.isDestroyed()) return;
        win.webContents.send('system-theme-changed', { theme });
      });
    });
  }
}

function createWindow({ isDevMode = false, isDxfDebugMode = false, minimalStartup = false } = {}) {
  const windowIcon = path.join(__dirname, '..', 'assets', 'icon-square.png');
  const windowOptions = {
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1117',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: windowIcon,
  };

  if (!minimalStartup) {
    windowOptions.webPreferences.preload = path.join(__dirname, '..', 'preload.js');
  }

  if (process.platform === 'darwin' && !minimalStartup) {
    windowOptions.titleBarStyle = 'hiddenInset';
  }

  mainWindow = new BrowserWindow(windowOptions);
  // On macOS, closing the window should hide it (preserving in-flight nesting
  // work in the renderer) rather than destroying the window. Cmd+Q still quits
  // properly because `before-quit` flips `app.isQuiting` first.
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !app.isQuiting && !mainWindow.isDestroyed()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  if (minimalStartup) {
    mainWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${productName}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0f1117;
        color: #f5f7fb;
        font: 16px -apple-system, BlinkMacSystemFont, sans-serif;
      }
    </style>
  </head>
  <body>
    <p>MAS diagnostic startup</p>
  </body>
</html>`)}`);
  } else {
    const loadOptions = isDxfDebugMode ? { query: { dxfDebug: '1' } } : {};
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), loadOptions);
    mainWindow.webContents.once('did-finish-load', () => {
      void handlePendingCrashReports(mainWindow).catch(error => {
        logDiagnostic('crash-report-flow-failed', { error });
      });
    });
  }
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  if (isDevMode) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  return mainWindow;
}

function initializeApp({ isDevMode = false, isDxfDebugMode = false, minimalStartup = false } = {}) {
  configureAppMetadata();

  app.whenReady().then(() => {
    if (!minimalStartup) {
      buildApplicationMenu({ isDevMode, isDxfDebugMode });
    }
    createWindow({ isDevMode, isDxfDebugMode, minimalStartup });
  });

  app.on('before-quit', () => { app.isQuiting = true; });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow({ isDevMode, isDxfDebugMode, minimalStartup });
    }
  });
}

function getMainWindow() {
  return mainWindow;
}

module.exports = {
  initializeApp,
  getMainWindow,
  registerAppMenuIpc,
};
