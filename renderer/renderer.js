'use strict';

const platformString = String(
  navigator.userAgentData?.platform ||
  navigator.platform ||
  navigator.userAgent ||
  ''
).toLowerCase();

if (platformString.includes('win')) {
  document.body.classList.add('platform-win');
} else if (platformString.includes('mac')) {
  document.body.classList.add('platform-mac');
} else {
  document.body.classList.add('platform-linux');
}

const dom = {
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  statusChip: document.getElementById('statusChip'),
  fileList: document.getElementById('fileList'),
  sheetList: document.getElementById('sheetList'),
  dropZone: document.getElementById('dropZone'),
  clearFilesBtn: document.getElementById('clearFilesBtn'),
  addFileBtn: document.getElementById('addFileBtn'),
  addSheetBtn: document.getElementById('addSheetBtn'),
  emptyState: document.getElementById('emptyState'),
  viewport: document.getElementById('viewport'),
  svgContainer: document.getElementById('svgContainer'),
  canvasTabs: document.getElementById('canvasTabs'),
  zoomLabel: document.getElementById('zoomLabel'),
  nestStats: document.getElementById('nestStats'),
  canvasStatusbar: document.getElementById('canvasStatusbar'),
  openSettings: document.getElementById('openSettings'),
  settingsModal: document.getElementById('settingsModal'),
  closeSettings: document.getElementById('closeSettings'),
  applySettings: document.getElementById('applySettings'),
  resetSettings: document.getElementById('resetSettings'),
  settingsFields: Array.from(document.getElementById('settingsModal').querySelectorAll('[data-setting-key]')),
  sheetModal: document.getElementById('sheetModal'),
  addSheetBtnDialog: document.getElementById('addSheetBtn'),
  confirmSheet: document.getElementById('confirmSheet'),
  cancelSheet: document.getElementById('cancelSheet'),
  closeSheet: document.getElementById('closeSheet'),
  sheetWidth: document.getElementById('sheetWidth'),
  sheetHeight: document.getElementById('sheetHeight'),
  sheetWidthMode: document.getElementById('sheetWidthMode'),
  sheetModeHelp: document.getElementById('sheetModeHelp'),
  sheetMaterial: document.getElementById('sheetMaterial'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  fitView: document.getElementById('fitView'),
  exportModal: document.getElementById('exportModal'),
  exportClose: document.getElementById('exportClose'),
  exportCancel: document.getElementById('exportCancel'),
  exportDXFBtn: document.getElementById('exportDXF'),
  exportChooseFolder: document.getElementById('exportChooseFolder'),
  exportFolderLabel: document.getElementById('exportFolderLabel'),
  exportTableBody: document.getElementById('exportTableBody'),
  exportSummarySheets: document.getElementById('exportSummarySheets'),
  exportSummaryUtil: document.getElementById('exportSummaryUtil'),
  exportSummaryParts: document.getElementById('exportSummaryParts'),
  exportSummaryLength: document.getElementById('exportSummaryLength'),
  openExportBtn: document.getElementById('openExport'),
  canvasArea: document.getElementById('canvasArea'),
};

const { state, schedulePersistJobState, hydrateJobState } = window.NestStore.createAppStore();
const { DEFAULT_ENGRAVING_COLOR } = window.NestConstants;
const { partLabelFromName } = window.NestHelpers;

let dragDebugTimer = null;

function setStatus(status) {
  state.status = status;
  const dot = dom.statusChip.querySelector('.status-dot');
  const label = dom.statusChip.querySelector('.status-label');
  dot.className = 'status-dot ' + status;
  const labels = { idle: 'Idle', running: 'Running…', done: 'Complete', error: 'Error' };
  label.textContent = labels[status] || status;
}

function setNestStatsTone(tone = '') {
  if (!dom.canvasStatusbar) return;
  dom.canvasStatusbar.classList.toggle('error', tone === 'error');
}

function syncViewportEmptyState(isEmpty) {
  if (!dom.viewport) return;
  dom.viewport.classList.toggle('empty-grid', !!isEmpty);
}

const settingsModalApi = window.NestSettingsModal.createSettingsModal({
  state,
  dom,
  onSettingsApplied: () => {
    if (typeof window.refreshDXFPreview === 'function') window.refreshDXFPreview();
    if (state.nestResult && state.sheets.length) canvasViewApi.showNestResult(0);
  },
});

function currentNestingSettings() {
  return settingsModalApi.currentNestingSettings();
}

function engravingLayerIndex(settings = currentNestingSettings()) {
  const raw = settings?.engravingLayer;
  if (raw === 'off' || raw === false || raw == null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
}

function resolveEngravingColor(layers = []) {
  const idx = engravingLayerIndex();
  if (idx !== null && layers[idx - 1]?.color) return layers[idx - 1].color;
  if (layers[1]?.color) return layers[1].color;
  if (layers[0]?.color) return layers[0].color;
  return DEFAULT_ENGRAVING_COLOR;
}

function engravingStyle(settings = currentNestingSettings()) {
  return settings?.engravingStyle === 'simple' ? 'simple' : 'stroked';
}

const dxfServiceApi = window.NestDxfService.createDxfService({
  state,
  getCurrentNestingSettings: currentNestingSettings,
});

const canvasViewApi = window.NestCanvasView.createCanvasView({
  state,
  dom,
  getCurrentNestingSettings: currentNestingSettings,
  setNestStatsTone,
  syncViewportEmptyState,
});

let sheetModalApi = null;
const sheetsPaneApi = window.NestSheetsPane.createSheetsPane({
  state,
  dom,
  schedulePersistJobState,
  getOpenSheetEditor: () => sheetModalApi?.openSheetEditor,
  renderTabs: canvasViewApi.renderTabs,
});

sheetModalApi = window.NestSheetModal.createSheetModal({
  state,
  dom,
  schedulePersistJobState,
  renderSheets: sheetsPaneApi.renderSheets,
});

const exportServiceApi = window.NestExportService.createExportService({
  state,
  dom,
});

const nestingServiceApi = window.NestNestingService.createNestingService({
  state,
  dom,
  getCurrentNestingSettings: currentNestingSettings,
  exportPlacementJSON: dxfServiceApi.exportPlacementJSON,
  setStatus,
  setNestStatsTone,
  showNestResult: canvasViewApi.showNestResult,
  renderTabs: canvasViewApi.renderTabs,
  syncExportButton: exportServiceApi.syncExportButton,
});

const filesPaneApi = window.NestFilesPane.createFilesPane({
  state,
  dom,
  schedulePersistJobState,
  hydrateFileShapesForList: dxfServiceApi.hydrateFileShapesForList,
});

const dxfPreviewModalApi = window.NestDxfPreviewModalView.createDxfPreviewModal({
  state,
});

window.state = state;
window.renderFiles = filesPaneApi.renderFiles;
window.schedulePersistJobState = schedulePersistJobState;
window.getCurrentNestingSettings = currentNestingSettings;
window.getPartLabelText = partLabelFromName;
window.getPartLabelConfig = (layers = []) => ({
  enabled: engravingLayerIndex() !== null,
  color: resolveEngravingColor(layers),
  style: engravingStyle(),
});
window.removeJobFileById = filesPaneApi.removeJobFileById;
window.openDXFPreview = dxfPreviewModalApi.openDXFPreview;
window.parseDXFToShapes = window.NestDxfPreviewService.parseDXFToShapes;
window.refreshDXFPreview = dxfPreviewModalApi.refreshDXFPreview;

function showDragDebug(message, details = '') {
  setNestStatsTone('');
  dom.nestStats.textContent = `[DND] ${message}`;
  dom.nestStats.title = details || message;
  if (dragDebugTimer) window.clearTimeout(dragDebugTimer);
  dragDebugTimer = window.setTimeout(() => {
    if (dom.nestStats.textContent.startsWith('[DND]')) {
      dom.nestStats.textContent = state.nestResult?.strips?.length
        ? dom.nestStats.textContent
        : 'Drag DXF files here to import';
      dom.nestStats.title = '';
    }
  }, 5000);
}

function normalizeDroppedFiles(fileList) {
  const files = [...fileList]
    .filter(f => f.name.toLowerCase().endsWith('.dxf'))
    .map(f => ({
      name: f.name,
      size: f.size,
      path: f.path || window.electronAPI?.getPathForDroppedFile?.(f) || null,
    }));
  showDragDebug(
    `normalized ${files.length} DXF file${files.length === 1 ? '' : 's'}`,
    files.map(f => `${f.name} :: ${f.path || 'no-path'}`).join('\n')
  );
  return files;
}

function dataTransferHasFiles(dt) {
  if (!dt) return false;
  if (dt.files?.length) return true;
  return Array.from(dt.items || []).some(item => item.kind === 'file');
}

function handleDroppedDataTransfer(dt) {
  showDragDebug(
    `drop received: ${dt?.files?.length || 0} file${dt?.files?.length === 1 ? '' : 's'}`,
    Array.from(dt?.files || []).map(f => `${f.name} :: ${f.path || 'no-path'}`).join('\n')
  );
  const files = normalizeDroppedFiles(dt?.files || []);
  if (!files.length) {
    showDragDebug('drop ignored: no DXF files found');
    return false;
  }
  filesPaneApi.addFiles(files);
  showDragDebug(
    `added ${files.length} DXF file${files.length === 1 ? '' : 's'}`,
    files.map(f => `${f.name} :: ${f.path || 'no-path'}`).join('\n')
  );
  return true;
}

function bindExplicitListScroll(listEl) {
  if (!listEl) return;
  listEl.addEventListener('wheel', e => {
    if (listEl.scrollHeight <= listEl.clientHeight) return;
    e.preventDefault();
    listEl.scrollTop += e.deltaY;
  }, { passive: false });
}

function bindDragAndDrop() {
  dom.dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dom.dropZone.classList.add('drag-over');
  });
  dom.dropZone.addEventListener('dragenter', e => {
    e.preventDefault();
    dom.dropZone.classList.add('drag-over');
  });
  dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('drag-over'));
  dom.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    handleDroppedDataTransfer(e.dataTransfer);
  });

  dom.dropZone.addEventListener('click', async () => {
    if (window.electronAPI?.openFileDialog) {
      const files = await window.electronAPI.openFileDialog();
      filesPaneApi.addFiles(files);
    }
  });

  dom.canvasArea.addEventListener('dragover', e => e.preventDefault());
  dom.canvasArea.addEventListener('drop', e => {
    e.preventDefault();
    handleDroppedDataTransfer(e.dataTransfer);
  });

  window.addEventListener('dragenter', e => {
    e.preventDefault();
    showDragDebug(`dragenter: files=${e.dataTransfer?.files?.length || 0} items=${e.dataTransfer?.items?.length || 0}`);
    if (dataTransferHasFiles(e.dataTransfer)) dom.dropZone.classList.add('drag-over');
  }, true);

  window.addEventListener('dragover', e => {
    e.preventDefault();
    showDragDebug(`dragover: files=${e.dataTransfer?.files?.length || 0} items=${e.dataTransfer?.items?.length || 0}`);
    if (dataTransferHasFiles(e.dataTransfer)) dom.dropZone.classList.add('drag-over');
  }, true);

  window.addEventListener('drop', e => {
    e.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    handleDroppedDataTransfer(e.dataTransfer);
  }, true);

  window.addEventListener('dragleave', e => {
    if (e.target === document || e.target === document.documentElement || e.target === document.body) {
      dom.dropZone.classList.remove('drag-over');
    }
  }, true);
}

function bindOverlayClose() {
  [dom.settingsModal, dom.sheetModal].forEach(modal => {
    modal.addEventListener('click', e => {
      if (e.target !== modal) return;
      if (modal === dom.sheetModal) {
        sheetModalApi.closeSheetDialog();
        return;
      }
      modal.classList.remove('open');
    });
  });
}

(function bootstrapRenderer() {
  filesPaneApi.bind();
  sheetsPaneApi.renderSheets();
  sheetModalApi.bind();
  settingsModalApi.bind();
  canvasViewApi.bind();
  exportServiceApi.bind();
  nestingServiceApi.bind();
  bindDragAndDrop();
  bindOverlayClose();
  bindExplicitListScroll(dom.fileList);
  bindExplicitListScroll(dom.sheetList);

  settingsModalApi.loadPersistedSettings();
  exportServiceApi.loadLastExportFolder();
  sheetModalApi.updateSheetModeControls();
  syncViewportEmptyState(true);

  hydrateJobState().then(restored => {
    if (!restored) {
      state.files = [];
      state.sheets = [];
    }
    filesPaneApi.renderFiles();
    sheetsPaneApi.renderSheets();
    exportServiceApi.syncExportButton();
  });
})();
