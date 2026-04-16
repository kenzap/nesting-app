const { initializeApp, getMainWindow } = require('./main/app');
const { registerFileIpc } = require('./main/ipc/files');
const { registerSparrowIpc } = require('./main/ipc/sparrow');
const { registerExportDxfIpc } = require('./main/ipc/export-dxf');

const isDevMode = process.argv.includes('--dev') || process.argv.includes('--devtools');

registerFileIpc({ getMainWindow });
registerSparrowIpc();
registerExportDxfIpc();
initializeApp({ isDevMode });
