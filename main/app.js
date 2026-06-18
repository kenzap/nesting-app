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

function buildApplicationMenu({ isDevMode = false } = {}) {
  if (process.platform === 'linux') {
    Menu.setApplicationMenu(null);
    return;
  }

  const fs = require('fs');
  let lang = 'en';
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings && settings.language) {
        lang = settings.language;
      }
    }
  } catch (err) {
    // default to 'en'
  }

  const isEs = lang === 'es';

  const viewSubmenu = [
    { role: 'resetZoom', label: isEs ? 'Restablecer zoom' : 'Actual Size' },
    { role: 'zoomIn', label: isEs ? 'Acercar' : 'Zoom In' },
    { role: 'zoomOut', label: isEs ? 'Alejar' : 'Zoom Out' },
    { type: 'separator' },
    { role: 'togglefullscreen', label: isEs ? 'Pantalla completa' : 'Toggle Full Screen' },
  ];

  if (isDevMode) {
    viewSubmenu.unshift(
      { role: 'reload', label: isEs ? 'Recargar' : 'Reload' },
      { role: 'forceReload', label: isEs ? 'Forzar recarga' : 'Force Reload' },
      { role: 'toggleDevTools', label: isEs ? 'Herramientas de desarrollo' : 'Toggle Developer Tools' },
      { type: 'separator' },
    );
  }

  const template = [
    {
      label: productName,
      submenu: [
        { role: 'about', label: isEs ? `Acerca de ${productName}` : `About ${productName}` },
        { type: 'separator' },
        { role: 'services', label: isEs ? 'Servicios' : 'Services' },
        { type: 'separator' },
        { role: 'hide', label: isEs ? `Ocultar ${productName}` : `Hide ${productName}` },
        { role: 'hideOthers', label: isEs ? 'Ocultar otros' : 'Hide Others' },
        { role: 'unhide', label: isEs ? 'Mostrar todos' : 'Show All' },
        { type: 'separator' },
        { role: 'quit', label: isEs ? `Salir de ${productName}` : `Quit ${productName}` },
      ],
    },
    {
      label: isEs ? 'Archivo' : 'File',
      submenu: [
        { role: 'close', label: isEs ? 'Cerrar' : 'Close' },
      ],
    },
    {
      label: isEs ? 'Editar' : 'Edit',
      submenu: [
        { role: 'undo', label: isEs ? 'Deshacer' : 'Undo' },
        { role: 'redo', label: isEs ? 'Rehacer' : 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: isEs ? 'Cortar' : 'Cut' },
        { role: 'copy', label: isEs ? 'Copiar' : 'Copy' },
        { role: 'paste', label: isEs ? 'Pegar' : 'Paste' },
        { role: 'selectAll', label: isEs ? 'Seleccionar todo' : 'Select All' },
      ],
    },
    {
      label: isEs ? 'Ver' : 'View',
      submenu: viewSubmenu,
    },
    {
      label: isEs ? 'Ventana' : 'Window',
      submenu: [
        { role: 'minimize', label: isEs ? 'Minimizar' : 'Minimize' },
        { role: 'zoom', label: isEs ? 'Zoom' : 'Zoom' },
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
              createWindow({ isDevMode });
            }
          },
        },
        { type: 'separator' },
        { role: 'front', label: isEs ? 'Traer todo al frente' : 'Bring All to Front' },
      ],
    },
    {
      label: isEs ? 'Ayuda' : 'Help',
      submenu: [
        {
          label: isEs ? 'Soporte' : 'Support',
          click: () => { void shell.openExternal(SUPPORT_URL); },
        },
        {
          label: isEs ? 'Notas de versión' : 'Release Notes',
          click: () => { void shell.openExternal(RELEASES_URL); },
        },
        {
          label: isEs ? 'Comunidad de Reddit' : 'Reddit Community',
          click: () => { void shell.openExternal(REDDIT_URL); },
        },
        {
          label: 'LinkedIn',
          click: () => { void shell.openExternal(LINKEDIN_URL); },
        },
        {
          label: isEs ? `Sitio web de ${productName}` : `${productName} Website`,
          click: () => { void shell.openExternal(WEBSITE_URL); },
        },
      ],
    },
  ];

  if (process.platform !== 'darwin') {
    template[0] = {
      label: productName,
      submenu: [
        { role: 'about', label: isEs ? `Acerca de ${productName}` : `About ${productName}` },
        { type: 'separator' },
        { role: 'quit', label: isEs ? `Salir de ${productName}` : `Exit ${productName}` },
      ],
    };
    template[4].submenu = [
      { role: 'minimize', label: isEs ? 'Minimizar' : 'Minimize' },
      { role: 'close', label: isEs ? 'Cerrar' : 'Close' },
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

function createWindow({ isDevMode = false, minimalStartup = false } = {}) {
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
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  if (isDevMode) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  return mainWindow;
}

function initializeApp({ isDevMode = false, minimalStartup = false } = {}) {
  configureAppMetadata();

  app.whenReady().then(() => {
    if (!minimalStartup) {
      buildApplicationMenu({ isDevMode });
    }
    createWindow({ isDevMode, minimalStartup });
  });

  app.on('rebuild-menu', () => {
    if (!minimalStartup) {
      buildApplicationMenu({ isDevMode });
    }
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
      createWindow({ isDevMode, minimalStartup });
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
