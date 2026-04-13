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
};

let nestInterval = null;
let persistJobTimer = null;

// ── DOM refs ───────────────────────────────────────────────
const startBtn     = document.getElementById('startBtn');
const stopBtn      = document.getElementById('stopBtn');
const statusChip   = document.getElementById('statusChip');
const fileList     = document.getElementById('fileList');
const sheetList    = document.getElementById('sheetList');
const dropZone     = document.getElementById('dropZone');
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

function roundCoord(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;
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

function snapshotJobState() {
  return {
    files: state.files.map(file => ({
      id: file.id,
      name: file.name,
      size: file.size || 0,
      path: file.path || null,
      qty: file.qty || 1,
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

  state.files = Array.isArray(result.state.files) ? result.state.files : [];
  state.sheets = Array.isArray(result.state.sheets) ? result.state.sheets : [];
  return state.files.length > 0 || state.sheets.length > 0;
}

window.schedulePersistJobState = schedulePersistJobState;

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
  return file.shapes;
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

  state.settings = { ...defaults, ...(result.settings || {}) };
  applySettingsToDialog(state.settings);
}

// ── File list rendering ────────────────────────────────────
function renderFiles() {
  fileList.innerHTML = '';
  state.files.forEach(f => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.innerHTML = `
      <div class="file-icon">DXF</div>
      <div class="file-info">
        <div class="file-name" title="${f.name}">${f.name}</div>
        <div class="file-size">${formatBytes(f.size)}</div>
      </div>
      <div class="qty-control">
        <button class="qty-btn" data-id="${f.id}" data-delta="-1">−</button>
        <span class="qty-value">${f.qty}</span>
        <button class="qty-btn" data-id="${f.id}" data-delta="1">+</button>
      </div>`;
    // Click the row body → open DXF preview
    li.addEventListener('click', e => {
      if (!e.target.closest('.qty-control')) {
        if (window.openDXFPreview) window.openDXFPreview(f.id, f.name);
      }
    });

    fileList.appendChild(li);
  });

  // qty buttons
  fileList.querySelectorAll('.qty-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const f = state.files.find(x => x.id === btn.dataset.id);
      if (!f) return;
      f.qty = Math.max(1, f.qty + parseInt(btn.dataset.delta));
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
  if (state.nestResult && state.sheets.length) {
    state.sheets.forEach((s, i) => {
      const btn = document.createElement('button');
      btn.className = 'canvas-tab' + (i === 0 ? ' active' : '');
      btn.textContent = `Sheet ${i + 1}`;
      btn.addEventListener('click', () => {
        canvasTabs.querySelectorAll('.canvas-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
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
      <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#1e2130" stroke-width="0.5"/>
      </pattern>
      <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
        <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="rgba(0,0,0,0.4)"/>
      </filter>
    </defs>`;

  const shapesSVG = shapes.map(s => {
    const { x, y, w, h, type, color } = s;
    const fill = color + '22';
    const stroke = color;
    let path = '';

    if (type === 'rect') {
      path = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3"
        fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#shadow)"/>`;
    } else if (type === 'L') {
      const hw = (w * 0.45).toFixed(1), hh = (h * 0.45).toFixed(1);
      path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${hh} h${-hw} v${(h - parseFloat(hh)).toFixed(1)} h${-(w - parseFloat(hw)).toFixed(1)} Z"
        fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#shadow)"/>`;
    } else if (type === 'notch') {
      const nw = (w * 0.25).toFixed(1), nh = (h * 0.35).toFixed(1);
      const nx = (x + w / 2 - parseFloat(nw) / 2).toFixed(1);
      path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${h.toFixed(1)} h${-w.toFixed(1)} Z
        M${nx},${y.toFixed(1)} h${nw} v${nh} h${-nw} Z"
        fill="${fill}" stroke="${stroke}" stroke-width="1.5" fill-rule="evenodd" filter="url(#shadow)"/>`;
    } else {
      const tw = (w * 0.4).toFixed(1), tx = (x + w / 2 - parseFloat(tw) / 2).toFixed(1);
      const stemH = (h * 0.55).toFixed(1);
      path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${(h - parseFloat(stemH)).toFixed(1)} h${-(w / 2 - parseFloat(tw) / 2).toFixed(1)} v${stemH} h${-parseFloat(tw).toFixed(1)} v${-stemH} h${-(w / 2 - parseFloat(tw) / 2).toFixed(1)} Z"
        fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#shadow)"/>`;
    }
    return path;
  }).join('\n');

  const utilization = Math.round(60 + Math.random() * 25);

  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${defs}
  <rect width="${W}" height="${H}" fill="#12141c" rx="6"/>
  <rect width="${W}" height="${H}" fill="url(#grid)" rx="6"/>
  <rect x="10" y="10" width="${W-20}" height="${H-20}" rx="4" fill="none" stroke="#2a2f42" stroke-width="1" stroke-dasharray="6 3"/>
  ${shapesSVG}
  <text x="${W/2}" y="${H-10}" text-anchor="middle" font-size="11" fill="#4b5270" font-family="monospace">
    ${sheet.width} × ${sheet.height} mm · Utilization: ${utilization}%
  </text>
</svg>`, utilization };
}

function showNestResult(sheetIndex) {
  const result = generateMockNestSVG(sheetIndex);
  if (!result) return;
  svgContainer.innerHTML = result.svg;
  svgContainer.style.display = 'flex';
  emptyState.style.display = 'none';
  const placed = state.files.reduce((a, f) => a + f.qty, 0);
  nestStats.textContent = `Sheet ${sheetIndex + 1} of ${state.sheets.length} · ${placed} parts placed · Utilization: ${result.utilization}%`;
}

// ── Run / Stop ─────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  if (state.status === 'running') return;
  if (!state.files.length) return;
  if (!state.sheets.length) return;

  try {
    const exported = await exportPlacementJSON();
    nestStats.textContent = `Placement JSON saved to ${exported.path}`;
  } catch (err) {
    console.error('[Placement JSON] Export failed:', err);
    setStatus('error');
    nestStats.textContent = `Export failed: ${err.message}`;
    return;
  }

  setStatus('running');
  startBtn.classList.add('running');
  startBtn.disabled = true;
  stopBtn.disabled = false;
  stopBtn.classList.add('active');
  state.nestResult = true;

  renderTabs();

  // Simulate progressive nesting
  let progress = 0;
  nestInterval = setInterval(() => {
    progress += Math.random() * 18;
    if (progress >= 100) {
      clearInterval(nestInterval);
      nestInterval = null;
      setStatus('done');
      startBtn.classList.remove('running');
      startBtn.disabled = false;
      stopBtn.disabled = true;
      stopBtn.classList.remove('active');
      showNestResult(0);
    }
  }, 300);
});

stopBtn.addEventListener('click', () => {
  if (state.status !== 'running') return;
  clearInterval(nestInterval);
  nestInterval = null;
  setStatus('idle');
  startBtn.classList.remove('running');
  startBtn.disabled = false;
  stopBtn.disabled = true;
  stopBtn.classList.remove('active');
});

// ── File drop ──────────────────────────────────────────────
function addFiles(fileObjs) {
  fileObjs.forEach(f => {
    if (!state.files.find(x => x.name === f.name)) {
      // Always preserve path — dxf-preview.js needs it for real parsing
      state.files.push({ id: uid(), name: f.name, size: f.size || 0, path: f.path || null, qty: 1 });
    }
  });
  renderFiles();
  schedulePersistJobState();
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

// ── Settings dialog ────────────────────────────────────────
openSettings.addEventListener('click', () => settingsModal.classList.add('open'));
closeSettings.addEventListener('click', () => settingsModal.classList.remove('open'));
applySettings.addEventListener('click', async () => {
  try {
    await persistCurrentSettings();
    settingsModal.classList.remove('open');
  } catch (err) {
    console.error('[Settings] Failed to persist settings:', err);
  }
});
resetSettings.addEventListener('click', async () => {
  state.settings = dialogDefaults();
  applySettingsToDialog(state.settings);
  try {
    await persistCurrentSettings();
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
