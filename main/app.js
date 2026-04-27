const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const packageJson = require('../package.json');

const productName = packageJson.productName || 'KENZAP NEST';
const appDescription = packageJson.description || 'DXF nesting application';
const WEBSITE_URL = 'https://kenzap.com/nesting/';
const SUPPORT_URL = 'https://kenzap.com/nesting-support/';

let mainWindow = null;

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
        { role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `${productName} Website`,
          click: () => { void shell.openExternal(WEBSITE_URL); },
        },
        {
          label: 'Support',
          click: () => { void shell.openExternal(SUPPORT_URL); },
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

function createWindow({ isDevMode = false } = {}) {
  const windowIcon = path.join(__dirname, '..', 'assets', 'icon-square.png');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: windowIcon,
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  if (isDevMode) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  return mainWindow;
}

function initializeApp({ isDevMode = false } = {}) {
  configureAppMetadata();

  app.whenReady().then(() => {
    buildApplicationMenu({ isDevMode });
    createWindow({ isDevMode });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({ isDevMode });
  });
}

function getMainWindow() {
  return mainWindow;
}

module.exports = {
  initializeApp,
  getMainWindow,
};
