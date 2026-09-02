const isDevMode = process.argv.includes('--dev') || process.argv.includes('--devtools');
const isDxfDebugMode = process.argv.includes('--dxf-debug');
const packageJson = require('./package.json');
const {
  initializeDiagnostics,
  registerAppDiagnostics,
} = require('./main/utils/diagnostics');
const { initializeApp, getMainWindow, registerAppMenuIpc } = require('./main/app');
const { registerFileIpc } = require('./main/ipc/files');
const { registerSparrowIpc } = require('./main/ipc/sparrow');
const { registerExportDxfIpc } = require('./main/ipc/export-dxf');
const { registerExportReportIpc } = require('./main/ipc/export-report');

initializeDiagnostics({
  productName: packageJson.productName || 'Kenzap Nesting',
  version: packageJson.version,
});
registerAppDiagnostics();

registerFileIpc({ getMainWindow });
registerAppMenuIpc();
registerSparrowIpc();
registerExportDxfIpc();
registerExportReportIpc();

initializeApp({ isDevMode, isDxfDebugMode });
