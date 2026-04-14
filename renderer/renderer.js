'use strict';

// ── State ──────────────────────────────────────────────────
const state = {
  files: [],     // { id, name, size, qty }
  sheets: [],    // { id, width, height, widthMode, material }
  status: 'idle', // idle | running | done | error
  zoom: 1,
  nestResult: null,
  lastExportPath: null,
  settings: {},
  editingSheetId: null,
  activeStripIndex: 0,
};

let nestInterval = null;
let persistJobTimer = null;
let sparrowRunAborted = false;
let activeSparrowRunId = null;

// ── DOM refs ───────────────────────────────────────────────
const startBtn     = document.getElementById('startBtn');
const stopBtn      = document.getElementById('stopBtn');
const statusChip   = document.getElementById('statusChip');
const fileList     = document.getElementById('fileList');
const sheetList    = document.getElementById('sheetList');
const dropZone     = document.getElementById('dropZone');
const clearFilesBtn = document.getElementById('clearFilesBtn');
const addFileBtn   = document.getElementById('addFileBtn');
const addSheetBtn  = document.getElementById('addSheetBtn');
const emptyState   = document.getElementById('emptyState');
const svgContainer = document.getElementById('svgContainer');
const canvasTabs   = document.getElementById('canvasTabs');
const zoomLabel    = document.getElementById('zoomLabel');
const nestStats    = document.getElementById('nestStats');
const openSettings = document.getElementById('openSettings');
const settingsModal = document.getElementById('settingsModal');
const closeSettings = document.getElementById('closeSettings');
const applySettings = document.getElementById('applySettings');
const resetSettings = document.getElementById('resetSettings');
const sheetModal   = document.getElementById('sheetModal');
const addSheetBtnDialog = document.getElementById('addSheetBtn');
const confirmSheet = document.getElementById('confirmSheet');
const cancelSheet  = document.getElementById('cancelSheet');
const closeSheet   = document.getElementById('closeSheet');
const sheetWidth   = document.getElementById('sheetWidth');
const sheetHeight  = document.getElementById('sheetHeight');
const sheetWidthMode = document.getElementById('sheetWidthMode');
const sheetModeHelp = document.getElementById('sheetModeHelp');
const sheetMaterial = document.getElementById('sheetMaterial');
const zoomIn       = document.getElementById('zoomIn');
const zoomOut      = document.getElementById('zoomOut');
const fitView      = document.getElementById('fitView');
const settingsFields = Array.from(settingsModal.querySelectorAll('[data-setting-key]'));

// ── Helpers ────────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2, 9); }

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatWidthMeters(mm) {
  if (!Number.isFinite(mm) || mm <= 0) return 'n/a';
  return `${(mm / 1000).toFixed(2)} m`;
}

function presetMatches(btn) {
  return (
    sheetWidthMode.value === 'fixed' &&
    String(sheetWidth.value) === String(btn.dataset.w) &&
    String(sheetHeight.value) === String(btn.dataset.h)
  );
}

function syncSheetPresetButtons() {
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.toggle('active', presetMatches(btn));
  });
}

function setStatus(s) {
  state.status = s;
  const dot = statusChip.querySelector('.status-dot');
  const label = statusChip.querySelector('.status-label');
  dot.className = 'status-dot ' + s;
  const labels = { idle: 'Idle', running: 'Running…', done: 'Complete', error: 'Error' };
  label.textContent = labels[s] || s;
}

const DEFAULT_ALLOWED_ORIENTATIONS = [0, 30, 45, 90, 180, 270];
const DEFAULT_ENGRAVING_COLOR = '#4488FF';

function roundCoord(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;
}

function partLabelFromName(name) {
  return String(name || '').replace(/\.dxf$/i, '').trim();
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

function currentNestingSettings() {
  return { ...dialogDefaults(), ...state.settings };
}

function normalizeRotationStep(value) {
  if (value === 'none') return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function buildAllowedOrientations(rotationStepValue) {
  const step = normalizeRotationStep(rotationStepValue);
  if (!step) return [0];

  const orientations = [];
  for (let angle = 0; angle < 360; angle += step) {
    orientations.push(angle);
  }

  if (!orientations.length) return [0];
  return [...new Set(orientations.map(angle => roundCoord(angle)))];
}

function sameExportPoint(a, b) {
  return !!a && !!b && roundCoord(a.x) === roundCoord(b.x) && roundCoord(a.y) === roundCoord(b.y);
}

function sanitizePolygonPoints(points) {
  if (!Array.isArray(points) || !points.length) return [];

  const normalized = points
    .filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))
    .map(point => ({ x: roundCoord(point.x), y: roundCoord(point.y) }));

  const dedupedConsecutive = [];
  normalized.forEach(point => {
    if (!dedupedConsecutive.length || !sameExportPoint(dedupedConsecutive[dedupedConsecutive.length - 1], point)) {
      dedupedConsecutive.push(point);
    }
  });

  if (dedupedConsecutive.length < 3) return [];

  const isClosed = sameExportPoint(dedupedConsecutive[0], dedupedConsecutive[dedupedConsecutive.length - 1]);
  const openRing = isClosed ? dedupedConsecutive.slice(0, -1) : [...dedupedConsecutive];

  const seen = new Set();
  const uniqueRing = [];
  openRing.forEach(point => {
    const key = `${point.x},${point.y}`;
    if (seen.has(key)) return;
    seen.add(key);
    uniqueRing.push(point);
  });

  if (uniqueRing.length < 3) return [];

  uniqueRing.push({ ...uniqueRing[0] });
  return uniqueRing;
}

function clonePlain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function effectiveFileQty(file) {
  if (Array.isArray(file?.shapes) && file.shapes.length) {
    const visibleTotal = file.shapes
      .filter(shape => shape.visible !== false)
      .reduce((sum, shape) => sum + Math.max(1, parseInt(shape.qty || 1, 10)), 0);
    return Math.max(1, visibleTotal || 0);
  }
  return Math.max(1, parseInt(file?.qty || 1, 10));
}

function snapshotJobState() {
  return {
    files: state.files.map(file => ({
      id: file.id,
      name: file.name,
      size: file.size || 0,
      path: file.path || null,
      qty: effectiveFileQty(file),
      shapes: clonePlain(file.shapes || null),
      layers: clonePlain(file.layers || null),
    })),
    sheets: state.sheets.map(sheet => ({
      id: sheet.id,
      width: sheet.width ?? null,
      height: sheet.height ?? null,
      widthMode: sheet.widthMode || 'fixed',
      material: sheet.material || '',
    })),
  };
}

async function persistJobStateNow() {
  if (!window.electronAPI?.saveJobState) return;
  const result = await window.electronAPI.saveJobState(snapshotJobState());
  if (!result?.success) {
    console.error('[Job State] Failed to save:', result?.error);
  }
}

function schedulePersistJobState() {
  if (persistJobTimer) window.clearTimeout(persistJobTimer);
  persistJobTimer = window.setTimeout(() => {
    persistJobTimer = null;
    persistJobStateNow();
  }, 120);
}

async function hydrateJobState() {
  if (!window.electronAPI?.loadJobState) return false;
  const result = await window.electronAPI.loadJobState();
  if (!result?.success) {
    console.warn('[Job State] Failed to load:', result?.error);
    return false;
  }
  if (!result.state) return false;

  state.files = Array.isArray(result.state.files)
    ? result.state.files.map(file => ({ ...file, qty: effectiveFileQty(file) }))
    : [];
  state.sheets = Array.isArray(result.state.sheets) ? result.state.sheets : [];
  return state.files.length > 0 || state.sheets.length > 0;
}

window.schedulePersistJobState = schedulePersistJobState;
window.getCurrentNestingSettings = currentNestingSettings;
window.getPartLabelText = partLabelFromName;
window.getPartLabelConfig = (layers = []) => ({
  enabled: engravingLayerIndex() !== null,
  color: resolveEngravingColor(layers),
});

function baseJobName() {
  if (state.files.length === 1) {
    return state.files[0].name.replace(/\.dxf$/i, '');
  }
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return `nesting-job-${stamp}`;
}

async function ensureFileShapes(file) {
  if (Array.isArray(file.shapes) && file.shapes.length) return file.shapes;
  if (!file.path || !window.electronAPI?.parseDXF || typeof window.parseDXFToShapes !== 'function') {
    throw new Error(`No parsed shapes available for ${file.name}`);
  }

  const result = await window.electronAPI.parseDXF(file.path);
  if (!result?.success || !result.data) {
    throw new Error(result?.error || `Failed to parse ${file.name}`);
  }

  const parsed = window.parseDXFToShapes(result.data, result.raw);
  if (!parsed?.shapes?.length) {
    throw new Error(`No nestable shapes found in ${file.name}`);
  }

  file.shapes = parsed.shapes.map(shape => ({
    ...shape,
    qty: file.qty || shape.qty || 1,
  }));
  file.layers = Array.isArray(parsed.layers) ? parsed.layers.map(layer => ({ ...layer })) : [];
  file.qty = effectiveFileQty(file);
  return file.shapes;
}

async function hydrateFileShapesForList(file) {
  if (!file || !file.path || (Array.isArray(file.shapes) && file.shapes.length)) return;
  if (!window.electronAPI?.parseDXF || typeof window.parseDXFToShapes !== 'function') return;

  try {
    await ensureFileShapes(file);
    renderFiles();
    schedulePersistJobState();
  } catch (error) {
    console.warn(`[DXF] Failed to pre-parse ${file.name}:`, error.message);
  }
}

async function buildPlacementPayload() {
  const items = [];
  let nextId = 0;
  const settings = currentNestingSettings();
  const allowedOrientations = buildAllowedOrientations(settings.rotationStep);

  for (const file of state.files) {
    const shapes = (await ensureFileShapes(file)).filter(shape => shape.visible !== false);
    shapes.forEach(shape => {
      const points = sanitizePolygonPoints(shape.polygonPoints);
      if (points.length < 3) return;

      items.push({
        id: nextId++,
        demand: Math.max(1, parseInt(shape.qty || 1, 10)),
        dxf: file.path || file.name,
        allowed_orientations: [...allowedOrientations],
        shape: {
          type: 'simple_polygon',
          data: points.map(point => [point.x, point.y]),
        },
      });
    });
  }

  if (!items.length) {
    throw new Error('No exportable shapes available');
  }

  return {
    name: baseJobName(),
    settings,
    items,
    sheets: state.sheets.map(sheet => ({
      id: sheet.id,
      width: sheet.widthMode === 'unlimited' ? null : sheet.width,
      height: sheet.height,
      width_mode: sheet.widthMode || 'fixed',
      quantity: 'auto',
      material: sheet.material || '',
    })),
    strip_height: state.sheets[0]?.height || 0,
  };
}

function styleStripSVG(svg) {
  if (!svg) return '';

  let styled = svg;
  const viewBoxMatch = styled.match(/viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/i);
  const vb = viewBoxMatch
    ? {
        x: Number(viewBoxMatch[1]),
        y: Number(viewBoxMatch[2]),
        w: Number(viewBoxMatch[3]),
        h: Number(viewBoxMatch[4]),
      }
    : { x: 0, y: 0, w: 3000, h: 1250 };

  // Grid spacing: ~2% of sheet width so it scales with zoom
  const gridStep = Math.round(vb.w / 50 / 5) * 5 || 50;

  const bgMarkup = `
<defs>
<pattern id="nestGrid" width="${gridStep}" height="${gridStep}" patternUnits="userSpaceOnUse">
<path d="M${gridStep} 0 L0 0 0 ${gridStep}" fill="none" stroke="#1a1d2a" stroke-width="${(gridStep * 0.025).toFixed(1)}"/>
</pattern>
<filter id="partGlow" x="-4%" y="-4%" width="108%" height="108%">
<feGaussianBlur stdDeviation="${vb.w * 0.0015}" result="blur"/>
<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
</defs>
<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="#0d0f18"/>
<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="url(#nestGrid)"/>`;

  styled = styled.replace(/<svg([^>]*)>/i, `<svg$1>\n${bgMarkup}`);

  // ── Sheet container boundary ──────────────────────────────
  // Sparrow: fill="#D3D3D3" stroke="black" (the sheet rectangle)
  styled = styled.replace(
    /fill="#D3D3D3"\s+stroke="black"\s+stroke-width="([\d.]+)"/gi,
    (_, sw) => `fill="#12151f" stroke="#2e3550" stroke-width="${sw}"`
  );

  // ── Placed part fills ─────────────────────────────────────
  // Sparrow: fill="#7A7A7A" fill-opacity="0.5" fill-rule="nonzero" stroke="black" stroke-width="N"
  styled = styled.replace(
    /fill="#7A7A7A"\s+fill-opacity="0\.5"\s+fill-rule="nonzero"\s+stroke="black"\s+stroke-width="([\d.]+)"/gi,
    (_, sw) => `fill="#1a2744" fill-opacity="1" fill-rule="nonzero" stroke="#4f8ef7" stroke-width="${(sw * 0.7).toFixed(4)}" filter="url(#partGlow)"`
  );

  // ── Dashed collision-shape outlines (cd_shape) ────────────
  // Sparrow: fill="none" stroke="black" stroke-dasharray="A B" stroke-linecap stroke-linejoin stroke-opacity="0.3" stroke-width="N"
  // Make them a very subtle dark blue — they show the simplified polygon, not distracting
  styled = styled.replace(
    /fill="none"\s+stroke="black"\s+stroke-dasharray="([^"]+)"\s+stroke-linecap="([^"]+)"\s+stroke-linejoin="([^"]+)"\s+stroke-opacity="0\.3"\s+stroke-width="([\d.]+)"/gi,
    (_, da, lc, lj, sw) =>
      `fill="none" stroke="#3a5080" stroke-dasharray="${da}" stroke-linecap="${lc}" stroke-linejoin="${lj}" stroke-opacity="0.35" stroke-width="${(sw * 0.6).toFixed(4)}"`
  );

  // Catch-all: any remaining black strokes (labels, titles, etc.)
  styled = styled.replace(/stroke="black"/gi, 'stroke="#2e3550"');

  // ── Remove sparrow stats label (h: / w: / d:) ────────────
  // Sparrow emits a <text> element above the sheet with h/w/density info.
  // We show that in the bottom status bar instead, so strip it here.
  styled = styled.replace(/<text[^>]*>[\s\S]*?h:[\s\S]*?<\/text>/gi, '');

  return styled;
}

async function exportPlacementJSON() {
  const payload = await buildPlacementPayload();
  if (!window.electronAPI?.savePlacementJSON) {
    throw new Error('Placement JSON export is not available');
  }

  const result = await window.electronAPI.savePlacementJSON(payload);
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to save placement JSON');
  }

  state.lastExportPath = result.path;
  console.info('[Placement JSON] Saved to', result.path, payload);
  return { path: result.path, payload };
}

function settingFieldValue(field) {
  if (field.type === 'checkbox') return !!field.checked;
  if (field.type === 'number') return field.value === '' ? null : Number(field.value);
  return field.value;
}

function applySettingFieldValue(field, value) {
  if (value === undefined) return;
  if (field.type === 'checkbox') {
    field.checked = !!value;
    return;
  }
  field.value = `${value}`;
}

function collectSettingsFromDialog() {
  return settingsFields.reduce((acc, field) => {
    acc[field.dataset.settingKey] = settingFieldValue(field);
    return acc;
  }, {});
}

function dialogDefaults() {
  return settingsFields.reduce((acc, field) => {
    const key = field.dataset.settingKey;
    if (field.type === 'checkbox') {
      acc[key] = field.defaultChecked;
    } else {
      acc[key] = field.defaultValue;
      if (field.type === 'number' && acc[key] !== '') acc[key] = Number(acc[key]);
    }
    return acc;
  }, {});
}

function applySettingsToDialog(settings) {
  settingsFields.forEach(field => applySettingFieldValue(field, settings[field.dataset.settingKey]));
}

async function persistCurrentSettings() {
  state.settings = collectSettingsFromDialog();
  if (!window.electronAPI?.saveAppSettings) return;
  const result = await window.electronAPI.saveAppSettings(state.settings);
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to save settings');
  }
}

async function loadPersistedSettings() {
  const defaults = dialogDefaults();
  state.settings = { ...defaults };
  applySettingsToDialog(state.settings);

  if (!window.electronAPI?.loadAppSettings) return;
  const result = await window.electronAPI.loadAppSettings();
  if (!result?.success) {
    console.warn('[Settings] Failed to load persisted settings:', result?.error);
    return;
  }

  const persisted = { ...(result.settings || {}) };
  if (!('engravingLayer' in persisted) && 'showPartLabels' in persisted) {
    persisted.engravingLayer = persisted.showPartLabels ? '2' : 'off';
  }
  delete persisted.showPartLabels;
  state.settings = { ...defaults, ...persisted };
  applySettingsToDialog(state.settings);
}

// ── File list rendering ────────────────────────────────────
function renderFiles() {
  fileList.innerHTML = '';
  if (clearFilesBtn) clearFilesBtn.disabled = state.files.length === 0;
  state.files.forEach(f => {
    const shapeCount = Array.isArray(f.shapes)
      ? f.shapes.filter(shape => shape.visible !== false).length
      : 0;
    const shapeLabel = `${shapeCount} shape${shapeCount === 1 ? '' : 's'}`;
    const li = document.createElement('li');
    li.className = 'file-item';
    li.innerHTML = `
      <div class="file-icon">DXF</div>
      <div class="file-info">
        <div class="file-name" title="${f.name}">${f.name}</div>
        <div class="file-size">${shapeLabel} · ${formatBytes(f.size)}</div>
      </div>
      <div class="file-qty-total">${effectiveFileQty(f)}</div>
      <button class="file-remove" data-id="${f.id}" title="Remove">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M9 1L1 9M1 1l8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>`;
    // Click the row body → open DXF preview
    li.addEventListener('click', e => {
      if (!e.target.closest('.file-remove')) {
        if (window.openDXFPreview) window.openDXFPreview(f.id, f.name);
      }
    });

    fileList.appendChild(li);
  });

  fileList.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      state.files = state.files.filter(x => x.id !== btn.dataset.id);
      renderFiles();
      schedulePersistJobState();
    });
  });

  dropZone.style.display = 'flex';
}

window.removeJobFileById = fileId => {
  if (!fileId) return false;
  const before = state.files.length;
  state.files = state.files.filter(file => file.id !== fileId);
  if (state.files.length !== before) {
    renderFiles();
    return true;
  }
  return false;
};

clearFilesBtn?.addEventListener('click', () => {
  if (!state.files.length) return;
  state.files = [];
  renderFiles();
  schedulePersistJobState();
});

// ── Sheet list rendering ───────────────────────────────────
function renderSheets() {
  sheetList.innerHTML = '';
  state.sheets.forEach(s => {
    const widthLabel = s.widthMode === 'unlimited'
      ? `${s.height} × Unlimited mm`
      : `${s.height} × ${s.width} mm`;
    const modeLabel = s.widthMode === 'unlimited'
      ? 'Auto sheets · continuous strip'
      : s.widthMode === 'max'
        ? 'Auto sheets · width capped'
        : 'Auto sheets · fixed width';
    const li = document.createElement('li');
    li.className = 'sheet-item';
    li.innerHTML = `
      <div class="sheet-icon">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="1" y="2" width="12" height="10" rx="1.5" stroke="#4fcf8e" stroke-width="1.5"/>
        </svg>
      </div>
      <div class="sheet-info">
        <div class="sheet-dims">${widthLabel}</div>
        <div class="sheet-material">${s.material || 'No material'} · ${modeLabel}</div>
      </div>
      <button class="file-remove" data-id="${s.id}" title="Remove">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M9 1L1 9M1 1l8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>`;
    li.addEventListener('click', e => {
      if (e.target.closest('.file-remove')) return;
      openSheetEditor(s.id);
    });
    sheetList.appendChild(li);
  });
  sheetList.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      state.sheets = state.sheets.filter(x => x.id !== btn.dataset.id);
      renderSheets();
      renderTabs();
      schedulePersistJobState();
    });
  });
  renderTabs();
}

// ── Canvas tabs (one per sheet result) ────────────────────
function renderTabs() {
  canvasTabs.innerHTML = '';
  if (state.nestResult?.strips?.length) {
    const activeIndex = Math.min(
      state.activeStripIndex || 0,
      Math.max(0, state.nestResult.strips.length - 1),
    );
    state.activeStripIndex = activeIndex;
    state.nestResult.strips.forEach((strip, i) => {
      const btn = document.createElement('button');
      btn.className = 'canvas-tab' + (i === activeIndex ? ' active' : '');
      btn.textContent = `Sheet ${i + 1}`;
      btn.addEventListener('click', () => {
        canvasTabs.querySelectorAll('.canvas-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.activeStripIndex = i;
        showNestResult(i);
      });
      canvasTabs.appendChild(btn);
    });
  }
}

// ── Mock nesting SVG ───────────────────────────────────────
function generateMockNestSVG(sheetIndex) {
  const sheet = state.sheets[sheetIndex];
  if (!sheet) return null;

  const previewWidth = sheet.widthMode === 'unlimited' ? 3000 : (sheet.width || 3000);
  const W = 800, H = Math.round(800 * sheet.height / previewWidth);
  const colors = ['#4f8ef7', '#4fcf8e', '#f7c34f', '#f77f4f', '#cf4ff7', '#4ff7e8'];

  const shapes = [];
  const placed = [];

  const tryPlace = (shape, attempts = 60) => {
    for (let i = 0; i < attempts; i++) {
      const x = 20 + Math.random() * (W - shape.w - 40);
      const y = 20 + Math.random() * (H - shape.h - 40);
      const overlaps = placed.some(p =>
        x < p.x + p.w + 4 && x + shape.w + 4 > p.x &&
        y < p.y + p.h + 4 && y + shape.h + 4 > p.y
      );
      if (!overlaps) { shape.x = x; shape.y = y; return true; }
    }
    return false;
  };

  state.files.forEach((f, fi) => {
    for (let q = 0; q < Math.min(f.qty, 8); q++) {
      const type = (fi + q) % 4;
      const scale = 0.7 + Math.random() * 0.6;
      let shape;

      if (type === 0) {
        // Rectangle
        shape = { w: 80 * scale, h: 50 * scale, type: 'rect', name: f.name };
      } else if (type === 1) {
        // L-shape bounding box
        shape = { w: 90 * scale, h: 70 * scale, type: 'L', name: f.name };
      } else if (type === 2) {
        // Notched rect
        shape = { w: 100 * scale, h: 60 * scale, type: 'notch', name: f.name };
      } else {
        // T-shape
        shape = { w: 70 * scale, h: 80 * scale, type: 'T', name: f.name };
      }

      shape.color = colors[fi % colors.length];
      shape.id = fi;
      if (tryPlace(shape, 80)) { placed.push(shape); shapes.push(shape); }
    }
  });

  const defs = `
    <defs>
      <pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse">
        <path d="M 16 0 L 0 0 0 16" fill="none" stroke="#1a1d2a" stroke-width="0.5"/>
      </pattern>
      <filter id="partGlow" x="-6%" y="-6%" width="112%" height="112%">
        <feGaussianBlur stdDeviation="1.5" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>`;

  const shapesSVG = shapes.map(s => {
    const { x, y, w, h, type, color } = s;
    // Use a dark tinted fill derived from the file color, subtle accent stroke
    const fill = '#1a2744';
    const stroke = '#4f8ef7';
    const strokeOpacity = '0.75';
    let path = '';

    if (type === 'rect') {
      path = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2"
        fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2" filter="url(#partGlow)"/>`;
    } else if (type === 'L') {
      const hw = (w * 0.45).toFixed(1), hh = (h * 0.45).toFixed(1);
      path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${hh} h${-hw} v${(h - parseFloat(hh)).toFixed(1)} h${-(w - parseFloat(hw)).toFixed(1)} Z"
        fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2" filter="url(#partGlow)"/>`;
    } else if (type === 'notch') {
      const nw = (w * 0.25).toFixed(1), nh = (h * 0.35).toFixed(1);
      const nx = (x + w / 2 - parseFloat(nw) / 2).toFixed(1);
      path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${h.toFixed(1)} h${-w.toFixed(1)} Z
        M${nx},${y.toFixed(1)} h${nw} v${nh} h${-nw} Z"
        fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2" fill-rule="evenodd" filter="url(#partGlow)"/>`;
    } else {
      const tw = (w * 0.4).toFixed(1), tx = (x + w / 2 - parseFloat(tw) / 2).toFixed(1);
      const stemH = (h * 0.55).toFixed(1);
      path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${(h - parseFloat(stemH)).toFixed(1)} h${-(w / 2 - parseFloat(tw) / 2).toFixed(1)} v${stemH} h${-parseFloat(tw).toFixed(1)} v${-stemH} h${-(w / 2 - parseFloat(tw) / 2).toFixed(1)} Z"
        fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2" filter="url(#partGlow)"/>`;
    }
    const labelText = engravingLayerIndex() !== null ? partLabelFromName(s.name) : '';
    const labelFontSize = Math.max(7, Math.min(w, h) * 0.12);
    const labelStrokeWidth = 0.8;
    const label = labelText
      ? `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2).toFixed(1)}" text-anchor="middle"
          dominant-baseline="middle" font-size="${labelFontSize.toFixed(1)}"
          fill="none" stroke="${resolveEngravingColor()}" stroke-width="${labelStrokeWidth.toFixed(2)}"
          stroke-linejoin="round" stroke-linecap="round" opacity="0.96" font-family="monospace">${labelText}</text>`
      : '';
    return path + label;
  }).join('\n');

  const utilization = Math.round(60 + Math.random() * 25);

  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${defs}
  <rect width="${W}" height="${H}" fill="#0d0f18"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect x="8" y="8" width="${W-16}" height="${H-16}" rx="3" fill="none" stroke="#2e3550" stroke-width="1" stroke-dasharray="6 4"/>
  ${shapesSVG}
  <text x="${W/2}" y="${H-8}" text-anchor="middle" font-size="9" fill="#3a4566" font-family="monospace">
    ${sheet.width} × ${sheet.height} mm · Preview · ${utilization}% utilization
  </text>
</svg>`, utilization };
}

function showNestResult(sheetIndex) {
  if (state.nestResult?.strips?.[sheetIndex]?.svg) {
    const strip = state.nestResult.strips[sheetIndex];
    state.activeStripIndex = sheetIndex;
    svgContainer.innerHTML = styleStripSVG(strip.svg);
    svgContainer.style.display = 'flex';
    emptyState.style.display = 'none';
    const placed = state.nestResult.strips.reduce((sum, item) => sum + (item.item_count || 0), 0);
    const density = Number.isFinite(strip.density) ? `${(strip.density * 100).toFixed(1)}%` : 'n/a';
    const usedWidth = formatWidthMeters(strip.strip_width);
    const previewPrefix = strip.is_preview || state.nestResult.is_preview ? 'Preview · ' : '';
    nestStats.textContent = `${previewPrefix}Sheet ${sheetIndex + 1} of ${state.nestResult.strips.length} · ${placed} parts placed · Utilization: ${density} · Width: ${usedWidth}`;
    applyZoom();
    return;
  }

  const result = generateMockNestSVG(sheetIndex);
  if (!result) return;
  svgContainer.innerHTML = result.svg;
  svgContainer.style.display = 'flex';
  emptyState.style.display = 'none';
  const placed = state.files.reduce((a, f) => a + f.qty, 0);
  const mockWidth = formatWidthMeters(state.sheets[sheetIndex]?.width);
  nestStats.textContent = `Sheet ${sheetIndex + 1} of ${state.sheets.length} · ${placed} parts placed · Utilization: ${result.utilization}% · Width: ${mockWidth}`;
  applyZoom();
}

async function pollSparrowRun(runId) {
  if (!window.electronAPI?.pollSparrow) return;

  const result = await window.electronAPI.pollSparrow(runId);
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to poll Sparrow run');
  }

  if (result.summary?.strips?.length) {
    const previousIndex = state.activeStripIndex || 0;
    state.nestResult = result.summary;
    if (result.inputPath) state.nestInputPath = result.inputPath;
    if (!state.nestResult.strips[previousIndex]) {
      state.activeStripIndex = 0;
    }
    syncExportButton();
    renderTabs();
    showNestResult(state.activeStripIndex || 0);
  } else if (result.status === 'running') {
    nestStats.textContent = 'Running placement… waiting for first preview';
  }

  if (result.status === 'completed') {
    clearInterval(nestInterval);
    nestInterval = null;
    activeSparrowRunId = null;
    setStatus('done');
    startBtn.classList.remove('running');
    startBtn.disabled = false;
    stopBtn.disabled = true;
    stopBtn.classList.remove('active');
    return;
  }

  if (result.status === 'error') {
    clearInterval(nestInterval);
    nestInterval = null;
    activeSparrowRunId = null;
    throw new Error(result.error || 'Sparrow failed');
  }

  if (result.status === 'stopped') {
    clearInterval(nestInterval);
    nestInterval = null;
    activeSparrowRunId = null;
    return;
  }
}

// ── Run / Stop ─────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  if (state.status === 'running') return;
  if (!state.files.length) return;
  if (!state.sheets.length) return;

  let exported;
  try {
    exported = await exportPlacementJSON();
    nestStats.textContent = `Placement JSON saved to ${exported.path}`;
  } catch (err) {
    console.error('[Placement JSON] Export failed:', err);
    setStatus('error');
    nestStats.textContent = `Export failed: ${err.message}`;
    return;
  }

  setStatus('running');
  sparrowRunAborted = false;
  startBtn.classList.add('running');
  startBtn.disabled = true;
  stopBtn.disabled = false;
  stopBtn.classList.add('active');
  state.nestResult = null;
  state.activeStripIndex = 0;
  syncExportButton();

  try {
    const primarySheet = state.sheets[0] || {};
    const settings = currentNestingSettings();
    const result = await window.electronAPI.runSparrow(exported.payload, {
      globalTime: Number(settings.timeLimit) || 60,
      rngSeed: 42,
      earlyTermination: !!settings.earlyStopping,
      maxStripLength: primarySheet.widthMode === 'unlimited' ? null : Number(primarySheet.width) || null,
      align: settings.preferredAlignment === 'bottom' ? 'bottom' : 'top',
    });

    if (!result?.success || !result.runId) {
      throw new Error(result?.error || 'Failed to start Sparrow');
    }
    activeSparrowRunId = result.runId;
    nestStats.textContent = `Placement running… input saved to ${result.inputPath}`;

    if (nestInterval) clearInterval(nestInterval);
    await pollSparrowRun(result.runId);
    nestInterval = window.setInterval(async () => {
      if (!activeSparrowRunId || sparrowRunAborted) return;
      try {
        await pollSparrowRun(activeSparrowRunId);
      } catch (pollError) {
        if (sparrowRunAborted) return;
        console.error('[Sparrow] Live preview failed:', pollError);
        clearInterval(nestInterval);
        nestInterval = null;
        activeSparrowRunId = null;
        setStatus('error');
        nestStats.textContent = `Run failed: ${pollError.message}`;
        startBtn.classList.remove('running');
        startBtn.disabled = false;
        stopBtn.disabled = true;
        stopBtn.classList.remove('active');
      }
    }, 500);
  } catch (err) {
    if (sparrowRunAborted) return;
    console.error('[Sparrow] Run failed:', err);
    activeSparrowRunId = null;
    if (nestInterval) {
      clearInterval(nestInterval);
      nestInterval = null;
    }
    setStatus('error');
    nestStats.textContent = `Run failed: ${err.message}`;
    startBtn.classList.remove('running');
    startBtn.disabled = false;
    stopBtn.disabled = true;
    stopBtn.classList.remove('active');
  }
});

stopBtn.addEventListener('click', async () => {
  if (state.status !== 'running') return;
  sparrowRunAborted = true;
  activeSparrowRunId = null;
  if (window.electronAPI?.stopSparrow) {
    try {
      await window.electronAPI.stopSparrow();
    } catch (err) {
      console.error('[Sparrow] Stop failed:', err);
    }
  }
  clearInterval(nestInterval);
  nestInterval = null;
  setStatus('idle');
  nestStats.textContent = 'Placement stopped';
  startBtn.classList.remove('running');
  startBtn.disabled = false;
  stopBtn.disabled = true;
  stopBtn.classList.remove('active');
});

// ── File drop ──────────────────────────────────────────────
function addFiles(fileObjs) {
  const newlyAdded = [];
  fileObjs.forEach(f => {
    if (!state.files.find(x => x.name === f.name)) {
      // Always preserve path — dxf-preview.js needs it for real parsing
      const file = { id: uid(), name: f.name, size: f.size || 0, path: f.path || null, qty: 1 };
      state.files.push(file);
      newlyAdded.push(file);
    }
  });
  renderFiles();
  schedulePersistJobState();
  newlyAdded.forEach(file => {
    void hydrateFileShapesForList(file);
  });
}

function bindExplicitListScroll(listEl) {
  if (!listEl) return;
  listEl.addEventListener('wheel', e => {
    if (listEl.scrollHeight <= listEl.clientHeight) return;
    e.preventDefault();
    listEl.scrollTop += e.deltaY;
  }, { passive: false });
}

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = [...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith('.dxf'));
  // Electron adds .path to File objects — carry it through so preview can parse
  addFiles(files.map(f => ({ name: f.name, size: f.size, path: f.path || null })));
});

// Also allow dropping anywhere on the canvas area
document.getElementById('canvasArea').addEventListener('dragover', e => {
  e.preventDefault();
});
document.getElementById('canvasArea').addEventListener('drop', e => {
  e.preventDefault();
  const files = [...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith('.dxf'));
  if (files.length) addFiles(files.map(f => ({ name: f.name, size: f.size, path: f.path || null })));
});

bindExplicitListScroll(fileList);
bindExplicitListScroll(sheetList);

addFileBtn.addEventListener('click', async () => {
  if (window.electronAPI) {
    const files = await window.electronAPI.openFileDialog();
    addFiles(files);
  } else {
    // Browser fallback: inject mock files for demo
    addFiles([
      { name: 'bracket_L.dxf', size: 14200 },
      { name: 'panel_A.dxf', size: 28400 },
      { name: 'gusset_01.dxf', size: 9100 },
    ]);
  }
});

// ── Sheet dialog ───────────────────────────────────────────
function resetSheetForm() {
  state.editingSheetId = null;
  sheetWidthMode.value = 'fixed';
  sheetHeight.value = '1250';
  sheetWidth.value = '3000';
  sheetMaterial.value = '';
  confirmSheet.textContent = 'Add Sheet';
  updateSheetModeControls();
}

function openSheetEditor(sheetId = null) {
  if (!sheetId) {
    resetSheetForm();
    sheetModal.classList.add('open');
    return;
  }

  const sheet = state.sheets.find(entry => entry.id === sheetId);
  if (!sheet) return;

  state.editingSheetId = sheet.id;
  sheetWidthMode.value = sheet.widthMode || 'fixed';
  sheetHeight.value = sheet.height ?? 1250;
  sheetWidth.value = sheet.width ?? 3000;
  sheetMaterial.value = sheet.material || '';
  confirmSheet.textContent = 'Save Sheet';
  updateSheetModeControls();
  sheetModal.classList.add('open');
}

function closeSheetDialog() {
  sheetModal.classList.remove('open');
  resetSheetForm();
}

addSheetBtnDialog.addEventListener('click', () => openSheetEditor());
closeSheet.addEventListener('click', closeSheetDialog);
cancelSheet.addEventListener('click', closeSheetDialog);

function updateSheetModeControls() {
  const mode = sheetWidthMode.value;
  const unlimited = mode === 'unlimited';

  sheetWidth.disabled = unlimited;

  if (unlimited) {
    sheetModeHelp.textContent = 'The strip can continue without a fixed width limit.';
  } else if (mode === 'max') {
    sheetModeHelp.textContent = 'Width is treated as a maximum. The algorithm may use less width when possible and will automatically calculate the number of sheets needed and their dimensions.';
  } else {
    sheetModeHelp.textContent = 'A fixed sheet width will be used. The number of sheets required is calculated automatically.';
  }

  syncSheetPresetButtons();
}

sheetWidthMode.addEventListener('change', updateSheetModeControls);
sheetWidth.addEventListener('input', syncSheetPresetButtons);
sheetHeight.addEventListener('input', syncSheetPresetButtons);

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    sheetWidthMode.value = 'fixed';
    sheetWidth.value = btn.dataset.w;
    sheetHeight.value = btn.dataset.h;
    updateSheetModeControls();
  });
});

confirmSheet.addEventListener('click', () => {
  const mode = sheetWidthMode.value;
  const w = mode === 'unlimited' ? null : parseInt(sheetWidth.value);
  const h = parseInt(sheetHeight.value);
  const mat = sheetMaterial.value.trim();
  if (!h || (mode !== 'unlimited' && !w)) return;

  const sheetData = {
    width: w,
    height: h,
    widthMode: mode,
    material: mat,
  };

  if (state.editingSheetId) {
    state.sheets = state.sheets.map(sheet =>
      sheet.id === state.editingSheetId ? { ...sheet, ...sheetData } : sheet
    );
  } else {
    state.sheets.push({
      id: uid(),
      ...sheetData,
    });
  }
  renderSheets();
  closeSheetDialog();
  schedulePersistJobState();
});

// ── Export modal ───────────────────────────────────────────
const exportModal       = document.getElementById('exportModal');
const exportClose       = document.getElementById('exportClose');
const exportCancel      = document.getElementById('exportCancel');
const exportDXFBtn      = document.getElementById('exportDXF');
const exportChooseFolder = document.getElementById('exportChooseFolder');
const exportFolderLabel = document.getElementById('exportFolderLabel');
const exportTableBody   = document.getElementById('exportTableBody');
const exportSummarySheets = document.getElementById('exportSummarySheets');
const exportSummaryUtil   = document.getElementById('exportSummaryUtil');
const exportSummaryParts  = document.getElementById('exportSummaryParts');
const exportSummaryLength = document.getElementById('exportSummaryLength');
const openExportBtn     = document.getElementById('openExport');

let exportFolderPath = null;

function roundUpDim(mm) {
  return Math.ceil(mm);
}

function utilClass(pct) {
  if (pct >= 75) return '';
  if (pct >= 50) return 'warn';
  return 'low';
}

function shortPath(fullPath) {
  const parts = (fullPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function applyExportFolder(folderPath) {
  exportFolderPath = folderPath;
  exportFolderLabel.textContent = shortPath(folderPath);
  exportFolderLabel.classList.remove('export-folder-success', 'export-folder-error');
  exportDXFBtn.disabled = false;
  exportDXFBtn.textContent = 'Export DXF';
}

async function loadLastExportFolder() {
  if (!window.electronAPI?.loadAppSettings) return;
  const result = await window.electronAPI.loadAppSettings();
  const saved = result?.settings?.__lastExportFolder;
  if (saved) applyExportFolder(saved);
}

async function saveLastExportFolder(folderPath) {
  if (!window.electronAPI?.loadAppSettings || !window.electronAPI?.saveAppSettings) return;
  const result = await window.electronAPI.loadAppSettings();
  const settings = { ...(result?.settings || {}), __lastExportFolder: folderPath };
  await window.electronAPI.saveAppSettings(settings);
}

function populateExportModal() {
  const strips = state.nestResult?.strips || [];
  const sheet  = state.sheets[0] || {};

  exportSummarySheets.textContent = strips.length;
  const totalParts = strips.reduce((s, t) => s + (t.item_count || 0), 0);
  exportSummaryParts.textContent  = totalParts;
  const avgUtil = strips.length
    ? strips.reduce((s, t) => s + (t.density || 0), 0) / strips.length
    : 0;
  exportSummaryUtil.textContent   = `${(avgUtil * 100).toFixed(1)}%`;
  const totalMm = strips.reduce((s, t) => s + (t.strip_width || 0), 0);
  exportSummaryLength.textContent = `${(totalMm / 1000).toFixed(2)} m`;

  exportTableBody.innerHTML = '';
  strips.forEach((strip, i) => {
    const w   = roundUpDim(strip.strip_width || 0);
    const h   = roundUpDim(sheet.height || 0);
    const pct = Number.isFinite(strip.density) ? strip.density * 100 : 0;
    const cls = utilClass(pct);
    const tr  = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="export-sheet-num">${i + 1}</span></td>
      <td style="font-variant-numeric:tabular-nums">${h} × ${w}</td>
      <td style="color:var(--text-dim)">${sheet.material || '—'}</td>
      <td style="font-variant-numeric:tabular-nums">${strip.item_count || 0}</td>
      <td>
        <div class="export-util-bar-wrap">
          <div class="export-util-bar">
            <div class="export-util-fill ${cls}" style="width:${Math.min(100, pct).toFixed(1)}%"></div>
          </div>
          <span class="export-util-pct">${pct.toFixed(1)}%</span>
        </div>
      </td>
      <td style="font-variant-numeric:tabular-nums;color:var(--text-dim)">${formatWidthMeters(strip.strip_width)}</td>`;
    exportTableBody.appendChild(tr);
  });
}

function openExportModal() {
  if (!state.nestResult?.strips?.length) return;
  populateExportModal();
  // Restore last folder if we have one; otherwise reset to empty state
  if (exportFolderPath) {
    applyExportFolder(exportFolderPath);
  } else {
    exportFolderLabel.textContent = 'No folder selected';
    exportFolderLabel.classList.remove('export-folder-success', 'export-folder-error');
    exportDXFBtn.disabled = true;
    exportDXFBtn.textContent = 'Export DXF';
  }
  exportModal.classList.add('open');
}

openExportBtn?.addEventListener('click', openExportModal);
exportClose?.addEventListener('click', () => exportModal.classList.remove('open'));
exportCancel?.addEventListener('click', () => exportModal.classList.remove('open'));
exportModal?.addEventListener('click', e => { if (e.target === exportModal) exportModal.classList.remove('open'); });

exportChooseFolder?.addEventListener('click', async () => {
  if (!window.electronAPI?.chooseExportFolder) return;
  const result = await window.electronAPI.chooseExportFolder();
  if (result?.path) {
    applyExportFolder(result.path);
    saveLastExportFolder(result.path);
  }
});

exportDXFBtn?.addEventListener('click', async () => {
  if (!exportFolderPath || !state.nestResult?.strips?.length) return;
  exportDXFBtn.disabled = true;
  exportDXFBtn.textContent = 'Exporting…';
  exportFolderLabel.classList.remove('export-folder-success', 'export-folder-error');
  try {
    const sheet = state.sheets[0] || {};
    const strips = state.nestResult.strips.map(strip => ({
      index:        strip.index,
      json_path:    strip.json_path,
      strip_width:  strip.strip_width,
      strip_height: sheet.height || 0,
      density:      strip.density,
      item_count:   strip.item_count,
    }));
    const result = await window.electronAPI.exportSheetsDXF({
      outputDir:   exportFolderPath,
      jobName:     state.nestResult.name || 'nesting-job',
      inputPath:   state.nestInputPath || null,
      strips,
    });
    if (!result?.success) throw new Error(result?.error || 'Export failed');

    // ── Success state ──────────────────────────────────────
    exportDXFBtn.textContent = '✓ Exported';
    exportDXFBtn.classList.add('btn-success');
    exportFolderLabel.textContent = `${result.fileCount} file${result.fileCount !== 1 ? 's' : ''} saved to ${shortPath(result.outputDir)}`;
    exportFolderLabel.classList.add('export-folder-success');

    // Re-enable after a beat so user can export again if needed
    setTimeout(() => {
      exportDXFBtn.textContent = 'Export DXF';
      exportDXFBtn.classList.remove('btn-success');
      exportDXFBtn.disabled = false;
    }, 3000);
  } catch (err) {
    console.error('[Export DXF]', err);
    exportDXFBtn.textContent = 'Export DXF';
    exportDXFBtn.disabled = false;
    exportFolderLabel.textContent = `Error: ${err.message}`;
    exportFolderLabel.classList.add('export-folder-error');
  }
});

// Enable/disable export button based on result availability
function syncExportButton() {
  if (openExportBtn) {
    openExportBtn.disabled = !state.nestResult?.strips?.length;
  }
}

// ── Settings dialog ────────────────────────────────────────
openSettings.addEventListener('click', () => settingsModal.classList.add('open'));
closeSettings.addEventListener('click', () => settingsModal.classList.remove('open'));
applySettings.addEventListener('click', async () => {
  try {
    await persistCurrentSettings();
    settingsModal.classList.remove('open');
    if (typeof window.refreshDXFPreview === 'function') window.refreshDXFPreview();
    if (state.nestResult && state.sheets.length) showNestResult(0);
  } catch (err) {
    console.error('[Settings] Failed to persist settings:', err);
  }
});
resetSettings.addEventListener('click', async () => {
  state.settings = dialogDefaults();
  applySettingsToDialog(state.settings);
  try {
    await persistCurrentSettings();
    if (typeof window.refreshDXFPreview === 'function') window.refreshDXFPreview();
    if (state.nestResult && state.sheets.length) showNestResult(0);
  } catch (err) {
    console.error('[Settings] Failed to reset settings:', err);
  }
});

// Close on overlay click
[settingsModal, sheetModal].forEach(modal => {
  modal.addEventListener('click', e => {
    if (e.target !== modal) return;
    if (modal === sheetModal) {
      closeSheetDialog();
      return;
    }
    modal.classList.remove('open');
  });
});

// ── Zoom controls ──────────────────────────────────────────
function applyZoom() {
  const el = svgContainer.querySelector('svg');
  if (el) el.style.transform = `scale(${state.zoom})`;
  zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
}

zoomIn.addEventListener('click', () => { state.zoom = Math.min(4, state.zoom + 0.15); applyZoom(); });
zoomOut.addEventListener('click', () => { state.zoom = Math.max(0.2, state.zoom - 0.15); applyZoom(); });
fitView.addEventListener('click', () => { state.zoom = 1; applyZoom(); });

// ── Seed demo data ─────────────────────────────────────────
(function seedDemo() {
  loadPersistedSettings();
  loadLastExportFolder();
  updateSheetModeControls();
  hydrateJobState().then(restored => {
    if (!restored) {
      state.files = [];
      state.sheets = [];
    }
    renderFiles();
    renderSheets();
  });
})();
