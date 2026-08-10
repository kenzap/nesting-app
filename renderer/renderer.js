'use strict';

// ─── Platform detection ───────────────────────────────────────────────────────
// We sniff the OS once at startup so CSS can tweak things like scrollbar style
// or window-control spacing that differ between Mac, Windows and Linux.
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

// ─── DOM references ───────────────────────────────────────────────────────────
// Single lookup at startup so every other function can grab an element cheaply
// by name instead of calling getElementById each time.
const dom = {
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  statusChip: document.getElementById('statusChip'),
  feedbackBanner: document.getElementById('feedbackBanner'),
  feedbackBannerAction: document.getElementById('feedbackBannerAction'),
  feedbackBannerClose: document.getElementById('feedbackBannerClose'),
  fileList: document.getElementById('fileList'),
  sheetList: document.getElementById('sheetList'),
  dropZone: document.getElementById('dropZone'),
  clearFilesBtn: document.getElementById('clearFilesBtn'),
  addFileBtn: document.getElementById('addFileBtn'),
  sidebarActions: document.getElementById('partsSidebarActions'),
  addSheetBtn: document.getElementById('addSheetBtn'),
  emptyState: document.getElementById('emptyState'),
  viewport: document.getElementById('viewport'),
  svgContainer: document.getElementById('svgContainer'),
  canvasTabs: document.getElementById('canvasTabs'),
  canvasZoom: document.getElementById('canvasZoom'),
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
  printReportBtn: document.getElementById('printReport'),
  exportSheetsBtn: document.getElementById('exportSheets'),
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

// ─── App state + shared helpers ───────────────────────────────────────────────
// The store owns everything that needs to survive between UI actions: loaded
// files, sheets, the last solver result, etc. Persistence (save/load) is
// handled inside createAppStore so the rest of the app doesn't have to think
// about it.
const { state, schedulePersistJobState, hydrateJobState } = window.NestStore.createAppStore();
const { DEFAULT_ENGRAVING_COLOR } = window.NestConstants;
const { FALLBACK_PALETTE = [] } = window.NestDxfLayerService || {};
const { partLabelFromName } = window.NestHelpers;
const customSelectsApi = window.NestCustomSelects?.createModalCustomSelects?.() || null;
const linuxAppMenuApi = window.NestLinuxAppMenu?.createLinuxAppMenu?.() || null;
const FEEDBACK_BANNER_STORAGE_KEY = 'kenzap.feedback-banner.dismissedAt.v2';
const FEEDBACK_BANNER_FIRST_SEEN_KEY = 'kenzap.feedback-banner.firstSeenAt.v1';
const FEEDBACK_SUPPORT_URL = 'https://kenzap.com/nesting-support/';
const FEEDBACK_BANNER_COOLDOWN_MS = 60 * 24 * 60 * 60 * 1000;
const FEEDBACK_BANNER_FIRST_SHOW_DELAY_MS = 14 * 24 * 60 * 60 * 1000;

// Timer used to auto-clear drag-debug messages after a few seconds.
let dragDebugTimer = null;

// ─── Status chip ──────────────────────────────────────────────────────────────
// Updates the small coloured dot + text in the top bar that tells the user
// whether the solver is idle, running, finished or in an error state.
function setStatus(status) {
  state.status = status;
  const dot = dom.statusChip.querySelector('.status-dot');
  const label = dom.statusChip.querySelector('.status-label');
  dot.className = 'status-dot ' + status;
  const labels = { idle: 'Idle', running: 'Running…', done: 'Complete', error: 'Error' };
  label.textContent = labels[status] || status;
}

// Tints the bottom status bar red when the solver returns an error so the
// problem is obvious even if the user isn't looking at the chip.
function setNestStatsTone(tone = '') {
  if (!dom.canvasStatusbar) return;
  dom.canvasStatusbar.classList.toggle('error', tone === 'error');
  dom.canvasStatusbar.classList.toggle('warning', tone === 'warning');
}

// Toggles the dotted-grid placeholder that fills the canvas area when no
// nesting result is loaded yet.
function syncViewportEmptyState(isEmpty) {
  if (!dom.viewport) return;
  dom.viewport.classList.toggle('empty-grid', !!isEmpty);
}

function setFeedbackBannerVisible(isVisible) {
  if (!dom.feedbackBanner) return;
  dom.feedbackBanner.hidden = !isVisible;
}

function dismissFeedbackBanner() {
  try {
    window.localStorage?.setItem(FEEDBACK_BANNER_STORAGE_KEY, String(Date.now()));
  } catch {
    // Ignore persistence failures and still hide the banner for this session.
  }
  setFeedbackBannerVisible(false);
}

function openFeedbackUrl() {
  if (window.electronAPI?.openExternalUrl) {
    window.electronAPI.openExternalUrl(FEEDBACK_SUPPORT_URL).catch(error => {
      console.error('[Feedback Banner] Failed to open support URL:', error);
    });
    return;
  }
  window.open(FEEDBACK_SUPPORT_URL, '_blank', 'noopener');
}

function bindFeedbackBanner() {
  if (!dom.feedbackBanner || !dom.feedbackBannerAction || !dom.feedbackBannerClose) return;
  let showBanner = true;
  let dismissed = false;
  try {
    const now = Date.now();
    const firstSeenRaw = window.localStorage?.getItem(FEEDBACK_BANNER_FIRST_SEEN_KEY);
    let firstSeenAt = Number(firstSeenRaw);
    if (!Number.isFinite(firstSeenAt) || firstSeenAt <= 0) {
      firstSeenAt = now;
      window.localStorage?.setItem(FEEDBACK_BANNER_FIRST_SEEN_KEY, String(firstSeenAt));
    }

    const rawValue = window.localStorage?.getItem(FEEDBACK_BANNER_STORAGE_KEY);
    if (rawValue) {
      const dismissedAt = Number(rawValue);
      if (Number.isFinite(dismissedAt) && dismissedAt > 0) {
        dismissed = (now - dismissedAt) < FEEDBACK_BANNER_COOLDOWN_MS;
      } else {
        // Migrate any older non-timestamp value into a fresh cooldown window.
        window.localStorage?.setItem(FEEDBACK_BANNER_STORAGE_KEY, String(now));
        dismissed = true;
      }
    }
    showBanner = !dismissed && (now - firstSeenAt) >= FEEDBACK_BANNER_FIRST_SHOW_DELAY_MS;
  } catch {
    showBanner = false;
  }
  setFeedbackBannerVisible(showBanner);

  dom.feedbackBannerAction.addEventListener('click', () => {
    openFeedbackUrl();
    dismissFeedbackBanner();
  });
  dom.feedbackBannerClose.addEventListener('click', dismissFeedbackBanner);
}

// ─── Service APIs ─────────────────────────────────────────────────────────────
// Each "service" or "view" module is a self-contained unit that owns a slice of
// the UI. We wire them together here by passing in the shared state, dom refs,
// and any cross-module callbacks they need.

// Settings modal — reads/writes solver parameters (gap, spacing, rotation, etc.)
// and triggers a preview refresh whenever the user hits Apply.
const settingsModalApi = window.NestSettingsModal.createSettingsModal({
  state,
  dom,
  onSettingsApplied: () => {
    if (typeof window.refreshDXFPreview === 'function') window.refreshDXFPreview();
    if (state.nestResult && state.sheets.length) canvasViewApi.showNestResult(0);
  },
});
window.electronAPI?.onAppMenuCommand?.(({ action } = {}) => {
  if (action === 'open-settings') settingsModalApi.open();
  else if (action === 'toggle-measure') measureToolApi.toggle();
  else if (action === 'toggle-cursor-coords') toggleShowCursorCoords();
  else if (action === 'canvas-fit-view') canvasViewApi.fitView();
  else if (action === 'canvas-zoom-in') canvasViewApi.zoomIn();
  else if (action === 'canvas-zoom-out') canvasViewApi.zoomOut();
});

// View → Live Coordinates. Flips state.settings.showCursorCoords, persists it
// so the choice survives restart, and syncs the measure tool immediately so
// the chip appears / disappears without waiting for a redraw.
async function toggleShowCursorCoords() {
  if (!state.settings) return;
  const next = !state.settings.showCursorCoords;
  state.settings.showCursorCoords = next;
  measureToolApi?.setShowCursorCoords(next);
  try {
    await window.electronAPI?.saveAppSettings?.(state.settings);
  } catch (err) {
    console.error('[Settings] Failed to persist showCursorCoords toggle:', err);
  }
}

// Snapshot of the current solver settings so other modules don't have to reach
// into the settings modal directly.
function currentNestingSettings() {
  return settingsModalApi.currentNestingSettings();
}

// Returns which layer index (1-based) is designated for part labels / engraving
// marks, or null when engraving is turned off entirely.
function engravingLayerIndex(settings = currentNestingSettings()) {
  const raw = settings?.engravingLayer;
  if (raw === 'off' || raw === false || raw == null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
}

function batchLayerAtIndex(index) {
  if (!Number.isFinite(index) || index < 1) return null;
  for (const file of state.files || []) {
    const layer = Array.isArray(file?.layers) ? file.layers[index - 1] : null;
    if (layer?.name || layer?.color) return layer;
  }
  return null;
}

// Picks the best available colour for engraving text: uses the configured
// layer colour when present, then falls back through layers 2 → 1 → a constant
// default so the label is always visible regardless of DXF layer setup.
function resolveEngravingColor(layers = []) {
  const idx = engravingLayerIndex();
  if (idx !== null && layers[idx - 1]?.color) return layers[idx - 1].color;
  if (idx !== null && batchLayerAtIndex(idx)?.color) return batchLayerAtIndex(idx).color;
  if (idx !== null && FALLBACK_PALETTE.length) return FALLBACK_PALETTE[(idx - 1) % FALLBACK_PALETTE.length];
  if (layers[0]?.color) return layers[0].color;
  return DEFAULT_ENGRAVING_COLOR;
}

// Returns the engraving style: either the full-label visual modes
// ('simple'/'stroked') or one of the content-truncating first/last character
// variants. Unknown values fall back to 'stroked'.
function engravingStyle(settings = currentNestingSettings()) {
  const raw = settings?.engravingStyle;
  if (raw === 'simple' || raw === 'stroked'
      || raw === 'last-char' || raw === 'last-two-chars' || raw === 'last-three-chars'
      || raw === 'first-char' || raw === 'first-two-chars' || raw === 'first-three-chars') return raw;
  return 'stroked';
}

// DXF service — parses DXF files into shape data and builds the JSON payload
// that the solver and the export pipeline both consume.
const dxfServiceApi = window.NestDxfService.createDxfService({
  state,
  getCurrentNestingSettings: currentNestingSettings,
});

// Canvas view — renders the solver's SVG output into the viewport, manages
// per-sheet tabs, and handles pan/zoom.
const canvasViewApi = window.NestCanvasView.createCanvasView({
  state,
  dom,
  getCurrentNestingSettings: currentNestingSettings,
  setNestStatsTone,
  syncViewportEmptyState,
});

window.addEventListener('nest-theme-changed', () => {
  if (typeof window.refreshDXFPreview === 'function') window.refreshDXFPreview();
  if (state.sheets.length) {
    canvasViewApi.showNestResult(state.activeStripIndex || 0);
  }
});

// Sheets pane — the list of configured sheets in the left sidebar.  Keeps the
// tab row in sync whenever sheets are added, removed or reordered.
let sheetModalApi = null;
const sheetsPaneApi = window.NestSheetsPane.createSheetsPane({
  state,
  dom,
  schedulePersistJobState,
  getOpenSheetEditor: () => sheetModalApi?.openSheetEditor,
  renderTabs: canvasViewApi.renderTabs,
});

// Sheet modal — the dialog for adding or editing a single sheet (dimensions,
// material, infinite-roll vs fixed-size mode).
sheetModalApi = window.NestSheetModal.createSheetModal({
  state,
  dom,
  schedulePersistJobState,
  renderSheets: sheetsPaneApi.renderSheets,
});

// Export service — the DXF export modal that shows per-sheet utilisation and
// writes one .dxf file per sheet to a user-chosen folder.
const exportServiceApi = window.NestExportService.createExportService({
  state,
  dom,
  getCurrentNestingSettings: currentNestingSettings,
});

// Files pane — the list of loaded DXF files in the left sidebar with per-shape
// quantity controls and the sketch-preview button.
const filesPaneApi = window.NestFilesPane.createFilesPane({
  state,
  dom,
  schedulePersistJobState,
  hydrateFileShapesForList: dxfServiceApi.hydrateFileShapesForList,
});

// Parts history — session-scoped snapshot stack that powers the revert popover
// in the Parts header. Snapshots only fire when a nesting run starts, so this
// needs the files pane (for renderFiles) but must exist before the nesting
// service (which triggers the snapshot).
const partsHistoryApi = window.NestPartsHistory.createPartsHistory({
  state,
  dom,
  renderFiles: filesPaneApi.renderFiles,
  schedulePersistJobState,
});
partsHistoryApi.init();

// Nesting service — kicks off and monitors a solver run, polls for results, and
// hands the finished placement data to the canvas view.
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
  partsHistory: partsHistoryApi,
});

// DXF preview modal — opens the shape-selection overlay where users can pick
// which contours to include and set per-shape quantities.
const dxfPreviewModalApi = window.NestDxfPreviewModalView.createDxfPreviewModal({
  state,
});

// Measure tool — bottom-left coord readout (always on) + click-to-measure
// mode toggled by the ruler button in the canvas toolbar or by the
// View → Measure menu item.
const measureToolApi = window.NestMeasureTool.createMeasureTool({
  state,
  dom,
});
measureToolApi.init();
// Exposed globally so canvas-view (defined earlier) can reset the measurement
// when the user switches sheet tabs — otherwise a ruler drawn against one
// sheet lingers on top of another sheet's parts.
window.measureToolApi = measureToolApi;

// ─── Global surface ───────────────────────────────────────────────────────────
// A handful of functions need to be reachable from other script files (notably
// dxf-preview.js which runs in its own module scope).  We attach only what is
// genuinely cross-module; everything else stays local.
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

// ─── Drag-and-drop helpers ────────────────────────────────────────────────────

// Shows lightweight, user-facing import status during drag-and-drop without
// exposing raw browser event details in production builds.
function showDragDebug(message, details = '') {
  const normalized = String(message || '');
  const previousText = dom.nestStats.textContent;
  const previousTitle = dom.nestStats.title;
  let userMessage = 'Drop DXF files here to import';
  if (/^added\s+\d+/i.test(normalized)) {
    userMessage = normalized.replace(/^added/i, 'Imported');
  } else if (/^drop ignored:/i.test(normalized)) {
    userMessage = 'No DXF files found in the drop';
  }

  if (details) console.debug('[DND]', normalized, details);
  else if (normalized) console.debug('[DND]', normalized);

  setNestStatsTone('');
  dom.nestStats.textContent = userMessage;
  dom.nestStats.title = '';
  if (dragDebugTimer) window.clearTimeout(dragDebugTimer);
  dragDebugTimer = window.setTimeout(() => {
    if (dom.nestStats.textContent === userMessage) {
      dom.nestStats.textContent = previousText || 'Drag DXF files here to import';
      dom.nestStats.title = previousTitle || '';
    }
  }, 5000);
}

// Converts the browser's raw FileList into the plain objects the app uses
// internally, filtering out anything that isn't a .dxf file.  Electron exposes
// a real filesystem path on each File; we grab that so the solver can read it.
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

// Some Windows drag sources populate DataTransfer.items more reliably than
// DataTransfer.files, so we normalize from both and de-duplicate by path/name.
function extractDroppedFileObjects(dt) {
  const files = [];
  const seen = new Set();

  const pushFile = (file) => {
    if (!file) return;
    const name = String(file.name || '');
    if (!name) return;
    const path = file.path || window.electronAPI?.getPathForDroppedFile?.(file) || '';
    const key = `${path}::${name}::${file.size || 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };

  Array.from(dt?.files || []).forEach(pushFile);
  Array.from(dt?.items || [])
    .filter(item => item?.kind === 'file')
    .forEach(item => {
      try {
        pushFile(item.getAsFile());
      } catch {
        // Ignore per-item extraction failures and keep the rest of the drop.
      }
    });

  return files;
}

// Quick guard used in drag-enter/over handlers: returns true when the
// DataTransfer actually carries file content rather than, say, selected text.
function dataTransferHasFiles(dt) {
  if (!dt) return false;
  if (dt.files?.length) return true;
  return Array.from(dt.items || []).some(item => item.kind === 'file');
}

// Central handler for any drop event.  Extracts files from the DataTransfer,
// hands them to the files pane, and logs what happened to the debug bar.
// Returns true when at least one DXF was found and accepted.
function handleDroppedDataTransfer(dt) {
  showDragDebug(
    `drop received: ${dt?.files?.length || 0} file${dt?.files?.length === 1 ? '' : 's'}`,
    Array.from(dt?.files || []).map(f => `${f.name} :: ${f.path || 'no-path'}`).join('\n')
  );
  const files = normalizeDroppedFiles(extractDroppedFileObjects(dt));
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

// The left-side lists overflow vertically but they live inside a flex layout
// that prevents the default scroll behaviour.  This fixes wheel-scroll so
// they feel natural without breaking parent-container scroll.
function bindExplicitListScroll(listEl) {
  if (!listEl) return;
  listEl.addEventListener('wheel', e => {
    if (listEl.scrollHeight <= listEl.clientHeight) return;
    e.preventDefault();
    listEl.scrollTop += e.deltaY;
  }, { passive: false });
}

// Wires up all drag-and-drop surfaces: the dedicated drop zone in the sidebar,
// the canvas area (so you can drop onto a result mid-session), and a global
// window-level listener that catches drops landing anywhere else on the page.
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

  // Clicking the drop zone opens the native file picker as an alternative to
  // dragging — useful on touchpads or when files are buried deep in Finder.
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

  // Capture-phase listeners on the window catch drops that miss every named
  // target (e.g. the user drags onto the title bar area).
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

  // Remove the highlight when the drag leaves the entire browser window,
  // not just one individual element (dragleave fires for every child otherwise).
  window.addEventListener('dragleave', e => {
    if (e.target === document || e.target === document.documentElement || e.target === document.body) {
      dom.dropZone.classList.remove('drag-over');
    }
  }, true);
}

// Closes any modal when the user clicks the dark overlay behind it.
// The sheet modal has its own close logic, so we delegate to that API
// instead of just removing the class directly.
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

// ─── Bootstrap ────────────────────────────────────────────────────────────────
// Called once on page load.  Binds all event listeners, restores persisted job
// state (files + sheets from the last session), and brings every service module
// to life.  Order matters: sheets must render before tabs, and settings must
// load before the first preview attempt.
(async function bootstrapRenderer() {
  filesPaneApi.bind();
  sheetsPaneApi.renderSheets();
  sheetModalApi.bind();
  settingsModalApi.bind();
  canvasViewApi.bind();
  exportServiceApi.bind();
  nestingServiceApi.bind();
  bindFeedbackBanner();
  bindDragAndDrop();
  bindOverlayClose();
  bindExplicitListScroll(dom.fileList);
  bindExplicitListScroll(dom.sheetList);
  customSelectsApi?.enhanceModalSelects?.();
  linuxAppMenuApi?.bind?.();

  await settingsModalApi.loadPersistedSettings();
  measureToolApi?.setShowCursorCoords(state.settings?.showCursorCoords !== false);
  exportServiceApi.loadLastExportFolder();
  sheetModalApi.updateSheetModeControls();
  syncViewportEmptyState(true);

  // Restore the previous session's files and sheets, then re-render both lists.
  // If nothing was saved (first launch), we start clean.
  const restored = await hydrateJobState();
  if (!restored) {
    state.files = [];
    state.sheets = [];
  }

  // Older saved jobs may have shape quantities but not the preview-setting
  // metadata used to decide whether those saved shapes are still valid. When
  // that metadata is missing, opening the preview would reparse the DXF and
  // reset quantities back to 1. Backfill it once from the current settings.
  const currentSettings = currentNestingSettings();
  const contourMethod = String(currentSettings?.sketchContourMethod || 'auto');
  const multiSketchDetection = !!currentSettings?.multiSketchDetection;
  let backfilledLegacyFileMetadata = false;
  state.files.forEach(file => {
    if (!Array.isArray(file?.shapes) || !file.shapes.length) return;
    if (typeof file._multiSketchDetection !== 'boolean') {
      file._multiSketchDetection = multiSketchDetection;
      backfilledLegacyFileMetadata = true;
    }
    if (!file._sketchContourMethod) {
      file._sketchContourMethod = contourMethod;
      backfilledLegacyFileMetadata = true;
    }
  });
  if (backfilledLegacyFileMetadata) schedulePersistJobState();

  filesPaneApi.renderFiles();
  sheetsPaneApi.renderSheets();
  exportServiceApi.syncExportButton();
})();
