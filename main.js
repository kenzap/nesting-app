const isDevMode = process.argv.includes('--dev') || process.argv.includes('--devtools');
const isDxfDebugMode = process.argv.includes('--dxf-debug');
const { initializeApp, getMainWindow, registerAppMenuIpc } = require('./main/app');
const { registerFileIpc } = require('./main/ipc/files');
const { registerSparrowIpc } = require('./main/ipc/sparrow');
const { registerExportDxfIpc } = require('./main/ipc/export-dxf');
const { registerExportReportIpc } = require('./main/ipc/export-report');

registerFileIpc({ getMainWindow });
registerAppMenuIpc();
registerSparrowIpc();
registerExportDxfIpc();
registerExportReportIpc();

initializeApp({ isDevMode, isDxfDebugMode });
