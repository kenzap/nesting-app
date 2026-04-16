(function attachNestDxfPreviewShapesListView(global) {
  'use strict';

  const { f, f1 } = global.NestDxfSvg;

  function createDxfPreviewShapesListView({ pv, getShapesList, getShapeCount, getFileMeta, getStats, syncActions }) {
    // Rebuilds the entire shapes panel list so the UI reflects the latest shape state.
    // Groups shapes by layer with a coloured header, floats removed shapes to the bottom,
    // and wires up thumbnail SVGs, qty +/- buttons, direct qty input, and the restore button.
    function renderList({ onSelectShape, onChangeQty, onSetQty, onRestoreShape }) {
      const visible = pv.shapes.filter(shape => shape.visible);
      const total = visible.reduce((acc, shape) => acc + shape.qty, 0);
      getShapeCount().textContent = `${visible.length}/${pv.shapes.length}`;
      getFileMeta().textContent = `${pv.shapes.length} shape${pv.shapes.length !== 1 ? 's' : ''} · ${pv.layers.length} layer${pv.layers.length !== 1 ? 's' : ''}`;
      getStats().textContent = `${total} piece${total !== 1 ? 's' : ''} queued for nesting`;

      const listEl = getShapesList();
      listEl.innerHTML = '';
      const layerOrder = pv.layers.map(layer => layer.name);
      const grouped = [...pv.shapes].sort((a, b) => {
        const layerCmp = layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer);
        if (layerCmp !== 0) return layerCmp;
        if ((a.visible !== false) !== (b.visible !== false)) return a.visible === false ? 1 : -1;
        return a.name.localeCompare(b.name);
      });

      let lastLayer = null;
      grouped.forEach(shape => {
        if (shape.layer !== lastLayer) {
          lastLayer = shape.layer;
          const color = (pv.layers.find(layer => layer.name === shape.layer) || {}).color || '#888';
          const header = document.createElement('div');
          header.className = 'shapes-group-hdr';
          header.innerHTML = `<span class="layer-dot" style="background:${color}"></span>${shape.layer}`;
          listEl.appendChild(header);
        }

        const scale = Math.min(40 / shape.bbox.w, 30 / shape.bbox.h) * 0.9;
        const thumbWidth = f(shape.bbox.w * scale);
        const thumbHeight = f(shape.bbox.h * scale);
        const scaledDecor = (shape.decorSVG || []).map(svg =>
          svg.replace(/stroke-width="([^"]+)"/g, (_, value) => `stroke-width="${f(+value / scale)}"`)).join('');
        const scaledBoundary = (shape.outerBoundaryItems || []).map(item =>
          item.svg.replace(/stroke-width="([^"]+)"/g, (_, value) => `stroke-width="${f(+value / scale)}"`)).join('');
        const thumb = `<svg viewBox="0 0 ${f(shape.bbox.w)} ${f(shape.bbox.h)}" width="${thumbWidth}" height="${thumbHeight}">
          ${!shape.hasSyntheticOuter && !shape.mixedOuterLayers ? `<path d="${shape.pathData}" fill="${shape.layerColor}" fill-opacity="${shape.selectionFillAllowed ? (shape.mixedOuterLayers ? '1' : '0.18') : '0'}" fill-rule="${shape.fillRule}" stroke="${shape.layerColor}" stroke-width="${f(1.6 / scale)}" stroke-linejoin="round"/>` : ''}
          ${scaledBoundary}
          ${scaledDecor}
        </svg>`;

        const row = document.createElement('div');
        row.className = `pvw-shape-row${shape.id === pv.selectedId ? ' selected' : ''}${shape.visible === false ? ' dimmed' : ''}`;
        row.dataset.id = shape.id;
        row.innerHTML = `
          <div class="pvw-thumb">${thumb}</div>
          <div class="pvw-info">
            <div class="pvw-name">${shape.name}</div>
            <div class="pvw-dims">${f1(shape.bbox.w)} × ${f1(shape.bbox.h)} mm${shape.visible === false ? ' · removed' : ''}</div>
          </div>
          <div class="pvw-controls">
            ${shape.visible === false
              ? `<button class="qty-btn pvw-restore" data-id="${shape.id}" title="Restore shape">↺</button>`
              : `<button class="qty-btn pvw-dec" data-id="${shape.id}">−</button>
                 <input class="qty-value qty-input pvw-qty-input" data-id="${shape.id}" type="number" min="1" step="1" value="${shape.qty}" aria-label="Quantity for ${shape.name}">
                 <button class="qty-btn pvw-inc" data-id="${shape.id}">+</button>`}
          </div>`;
        row.addEventListener('click', event => {
          if (!event.target.closest('.pvw-controls')) onSelectShape(shape.id);
        });
        listEl.appendChild(row);
      });

      listEl.querySelectorAll('.pvw-dec').forEach(button =>
        button.addEventListener('click', event => { event.stopPropagation(); onChangeQty(button.dataset.id, -1); }));
      listEl.querySelectorAll('.pvw-inc').forEach(button =>
        button.addEventListener('click', event => { event.stopPropagation(); onChangeQty(button.dataset.id, 1); }));
      listEl.querySelectorAll('.pvw-qty-input').forEach(input => {
        input.addEventListener('click', event => event.stopPropagation());
        input.addEventListener('keydown', event => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            onSetQty(input.dataset.id, input.value);
          }
        });
        input.addEventListener('blur', () => onSetQty(input.dataset.id, input.value));
      });
      listEl.querySelectorAll('.pvw-restore').forEach(button =>
        button.addEventListener('click', event => { event.stopPropagation(); onRestoreShape(button.dataset.id); }));
      syncActions();
    }

    return { renderList };
  }

  global.NestDxfPreviewShapesListView = {
    createDxfPreviewShapesListView,
  };
})(window);
