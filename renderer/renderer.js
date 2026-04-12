'use strict';

// ── State ──────────────────────────────────────────────────
const state = {
  files: [],     // { id, name, size, qty }
  sheets: [],    // { id, width, height, qty, material }
  status: 'idle', // idle | running | done | error
  zoom: 1,
  nestResult: null,
};

let nestInterval = null;

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
const sheetQty     = document.getElementById('sheetQty');
const sheetMaterial = document.getElementById('sheetMaterial');
const zoomIn       = document.getElementById('zoomIn');
const zoomOut      = document.getElementById('zoomOut');
const fitView      = document.getElementById('fitView');

// ── Helpers ────────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2, 9); }

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function setStatus(s) {
  state.status = s;
  const dot = statusChip.querySelector('.status-dot');
  const label = statusChip.querySelector('.status-label');
  dot.className = 'status-dot ' + s;
  const labels = { idle: 'Idle', running: 'Running…', done: 'Complete', error: 'Error' };
  label.textContent = labels[s] || s;
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
      </div>
      <button class="file-remove" data-id="${f.id}" title="Remove">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M9 1L1 9M1 1l8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>`;
    // Click the row body → open DXF preview
    li.addEventListener('click', e => {
      if (!e.target.closest('.qty-control') && !e.target.closest('.file-remove')) {
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
    });
  });
  // remove buttons
  fileList.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      state.files = state.files.filter(x => x.id !== btn.dataset.id);
      renderFiles();
    });
  });

  dropZone.style.display = state.files.length > 3 ? 'none' : 'flex';
}

// ── Sheet list rendering ───────────────────────────────────
function renderSheets() {
  sheetList.innerHTML = '';
  state.sheets.forEach(s => {
    const li = document.createElement('li');
    li.className = 'sheet-item';
    li.innerHTML = `
      <div class="sheet-icon">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="1" y="2" width="12" height="10" rx="1.5" stroke="#4fcf8e" stroke-width="1.5"/>
        </svg>
      </div>
      <div class="sheet-info">
        <div class="sheet-dims">${s.width} × ${s.height} mm</div>
        <div class="sheet-material">${s.material || 'No material'} · ×${s.qty}</div>
      </div>
      <button class="file-remove" data-id="${s.id}" title="Remove">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M9 1L1 9M1 1l8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>`;
    sheetList.appendChild(li);
  });
  sheetList.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      state.sheets = state.sheets.filter(x => x.id !== btn.dataset.id);
      renderSheets();
      renderTabs();
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

  const W = 800, H = Math.round(800 * sheet.height / sheet.width);
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
startBtn.addEventListener('click', () => {
  if (state.status === 'running') return;
  if (!state.files.length) return;
  if (!state.sheets.length) return;

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
addSheetBtnDialog.addEventListener('click', () => sheetModal.classList.add('open'));
closeSheet.addEventListener('click', () => sheetModal.classList.remove('open'));
cancelSheet.addEventListener('click', () => sheetModal.classList.remove('open'));

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    sheetWidth.value = btn.dataset.w;
    sheetHeight.value = btn.dataset.h;
  });
});

confirmSheet.addEventListener('click', () => {
  const w = parseInt(sheetWidth.value);
  const h = parseInt(sheetHeight.value);
  const qty = parseInt(sheetQty.value) || 1;
  const mat = sheetMaterial.value.trim();
  if (!w || !h) return;
  state.sheets.push({ id: uid(), width: w, height: h, qty, material: mat });
  renderSheets();
  sheetModal.classList.remove('open');
});

// ── Settings dialog ────────────────────────────────────────
openSettings.addEventListener('click', () => settingsModal.classList.add('open'));
closeSettings.addEventListener('click', () => settingsModal.classList.remove('open'));
applySettings.addEventListener('click', () => settingsModal.classList.remove('open'));
resetSettings.addEventListener('click', () => {
  settingsModal.querySelectorAll('input[type=number]').forEach(i => {
    i.value = i.defaultValue;
  });
});

// Close on overlay click
[settingsModal, sheetModal].forEach(modal => {
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.remove('open');
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
  state.files = [
    { id: uid(), name: 'bracket_L.dxf',   size: 14200, qty: 4 },
    { id: uid(), name: 'panel_A.dxf',     size: 28400, qty: 2 },
    { id: uid(), name: 'gusset_01.dxf',   size:  9100, qty: 6 },
    { id: uid(), name: 'flange_round.dxf',size: 17800, qty: 3 },
  ];
  state.sheets = [
    { id: uid(), width: 2440, height: 1220, qty: 2, material: 'Mild Steel 3mm' },
    { id: uid(), width: 3000, height: 1500, qty: 1, material: 'Aluminium 5mm' },
  ];
  renderFiles();
  renderSheets();
})();
