const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const packageJson = require('../package.json');

const productName = packageJson.productName || 'Kenzap Nesting';
const appDescription = packageJson.description || 'DXF nesting application';
const WEBSITE_URL = 'https://kenzap.com/nesting/';
const SUPPORT_URL = 'https://kenzap.com/nesting-support/';
const RELEASES_URL = 'https://github.com/kenzap/nesting-app/releases';
const REDDIT_URL = 'https://www.reddit.com/r/kenzap/';
const LINKEDIN_URL = 'https://www.linkedin.com/company/kenzap';

let mainWindow = null;
let appMenuIpcRegistered = false;

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
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
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
          click: () => { void shell.openExternal(SUPPORT_URL); },
        },
        {
          label: 'Release Notes',
          click: () => { void shell.openExternal(RELEASES_URL); },
        },
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
      websiteUrl: WEBSITE_URL,
      supportUrl: SUPPORT_URL,
      releasesUrl: RELEASES_URL,
      redditUrl: REDDIT_URL,
      linkedInUrl: LINKEDIN_URL,
    },
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
        default:
          return { success: false, error: `Unknown app menu action: ${action}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
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
