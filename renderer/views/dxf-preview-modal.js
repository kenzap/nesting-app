(function attachNestDxfPreviewModalView(global) {
  'use strict';

  function createDxfPreviewModal({ state }) {
    // Local preview state for the currently open file. Declared here so it
    // resets to a clean slate each time a new file is opened, with no
    // leftover selection, zoom, or layer filter from a previous session.
    const pv = {
      fileId: null,
      filename: '',
      shapes: [],
      layers: [],
      activeLayer: null,
      selectedId: null,
      positions: [],
      zoom: 1,
      panelVisible: true,
      canvasWidth: global.NestDxfPreviewCanvasView.DEFAULT_CANVAS_W,
    };

    const dom = {
      modal: document.getElementById('dxfPreviewModal'),
      close: document.getElementById('pvClose'),
      cancel: document.getElementById('pvCancel'),
      apply: document.getElementById('pvApply'),
      layerTabs: document.getElementById('pvLayerTabs'),
      canvasWrap: document.getElementById('pvCanvasWrap'),
      shapesList: document.getElementById('pvShapesList'),
      fileName: document.getElementById('pvFileName'),
      fileMeta: document.getElementById('pvFileMeta'),
      shapeCount: document.getElementById('pvShapeCount'),
      stats: document.getElementById('pvStats'),
      zoomIn: document.getElementById('pvZoomIn'),
      zoomOut: document.getElementById('pvZoomOut'),
      zoomFit: document.getElementById('pvZoomFit'),
      zoomLabel: document.getElementById('pvZoomLabel'),
      togglePanel: document.getElementById('pvTogglePanel'),
      removeShape: document.getElementById('pvRemoveShape'),
      removeShapeLabel: document.getElementById('pvRemoveShapeLabel'),
      removePart: document.getElementById('pvRemovePart'),
      panel: document.querySelector('.pvw-shapes-panel'),
    };

    const previewService = global.NestDxfPreviewService.createDxfPreviewService();
    const canvasView = global.NestDxfPreviewCanvasView.createDxfPreviewCanvasView({
      pv,
      getCanvasWrap: () => dom.canvasWrap,
      getLayerConfig: () => (typeof global.getPartLabelConfig === 'function' ? global.getPartLabelConfig(pv.layers) : { enabled: false, color: '#4488FF', style: 'stroked' }),
    });

    // Keeps the Remove/Restore button in sync with the current selection:
    // disabled when nothing is selected, and labelled "Restore" when the
    // selected shape has already been hidden.
    function syncActions() {
      const selected = pv.shapes.find(shape => shape.id === pv.selectedId);
      dom.removeShape.disabled = !selected;
      dom.removeShapeLabel.textContent = selected?.visible === false ? 'Restore' : 'Remove';
    }

    const shapesListView = global.NestDxfPreviewShapesListView.createDxfPreviewShapesListView({
      pv,
      getShapesList: () => dom.shapesList,
      getShapeCount: () => dom.shapeCount,
      getFileMeta: () => dom.fileMeta,
      getStats: () => dom.stats,
      syncActions,
    });

    // Rebuilds the layer-filter tab row from scratch so counts and active state
    // always reflect the latest shapes array. Clicking a tab sets activeLayer;
    // clicking the already-active tab resets the filter back to "All".
    function renderTabs() {
      dom.layerTabs.innerHTML = '';
      const makeTab = (label, dot, layerName) => {
        const active = pv.activeLayer === layerName;
        const button = document.createElement('button');
        button.className = `pvw-tab${active ? ' active' : ''}`;
        button.innerHTML = `<span class="pvw-tab-dot" style="background:${dot}"></span>${label}`;
        button.addEventListener('click', () => {
          pv.activeLayer = active ? null : layerName;
          renderTabs();
          renderSVG();
        });
        return button;
      };
      dom.layerTabs.appendChild(makeTab('All', 'var(--text-muted)', null));
      pv.layers.forEach(layer => {
        const count = pv.shapes.filter(shape => (shape.ownerLayers || [shape.layer]).includes(layer.name) && shape.visible).length;
        const button = makeTab(layer.name, layer.color, layer.name);
        const badge = document.createElement('span');
        badge.className = 'pvw-tab-count';
        badge.textContent = count;
        button.appendChild(badge);
        dom.layerTabs.appendChild(button);
      });
    }

    // Thin wrapper so callers don't need to know about canvasView directly;
    // always passes the local selectShape handler as the click callback.
    function renderSVG() {
      canvasView.renderSVG(selectShape);
    }

    // Thin wrapper that wires all four action callbacks into shapesListView so
    // the list view stays decoupled from this module's internal functions.
    function renderList() {
      shapesListView.renderList({
        onSelectShape: selectShape,
        onChangeQty: changeQty,
        onSetQty: setQty,
        onRestoreShape: restoreShape,
      });
    }

    // Toggles selection: clicking the already-selected shape deselects it;
    // clicking a different shape selects it and scrolls its list row into view.
    function selectShape(id) {
      pv.selectedId = pv.selectedId === id ? null : id;
      renderSVG();
      renderList();
      if (pv.selectedId) {
        const element = dom.shapesList.querySelector(`[data-id="${pv.selectedId}"]`);
        if (element) element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    // Adjusts a shape's copy count by delta, enforcing a minimum of 1 so the
    // user can never reduce a quantity below a single instance.
    function changeQty(id, delta) {
      const shape = pv.shapes.find(entry => entry.id === id);
      if (shape) {
        shape.qty = Math.max(1, shape.qty + delta);
        renderList();
      }
    }

    // Validates a quantity typed directly into the input field. Rejects
    // non-integer or sub-1 values by re-rendering without saving, which
    // visually restores the previous valid number.
    function setQty(id, value) {
      const shape = pv.shapes.find(entry => entry.id === id);
      if (!shape) return;
      const parsed = Number.parseInt(String(value), 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        renderList();
        return;
      }
      shape.qty = parsed;
      renderList();
    }

    // Soft-deletes a shape by flagging it invisible rather than removing it from
    // the array, so restoreShape can bring it back without data loss.
    function deleteShape(id) {
      const shape = pv.shapes.find(entry => entry.id === id);
      if (!shape) return;
      shape.visible = false;
      pv.selectedId = id;
      renderSVG();
      renderList();
      renderTabs();
    }

    // Reverses a soft-delete, making the shape visible again and refreshing all
    // three views (canvas, list, tabs) so counts update immediately.
    function restoreShape(id) {
      const shape = pv.shapes.find(entry => entry.id === id);
      if (!shape) return;
      shape.visible = true;
      pv.selectedId = id;
      renderSVG();
      renderList();
      renderTabs();
    }

    // Clamps zoom to the [0.25, 5] range, updates the percentage label, then
    // applies the CSS transform without re-parsing or re-building the SVG.
    function setZoom(nextZoom) {
      pv.zoom = Math.max(0.25, Math.min(5, nextZoom));
      dom.zoomLabel.textContent = `${Math.round(pv.zoom * 100)}%`;
      canvasView.applyZoomTransform();
    }

    // Entry point for opening the modal. Resets all preview state for the new
    // file, shows a loading spinner, triggers the async DXF parse, then renders
    // tabs, canvas, and shape list once data is ready.
    async function openDXFPreview(fileId, filename) {
      pv.fileId = fileId;
      pv.filename = filename;
      pv.zoom = 1;
      pv.selectedId = null;
      pv.activeLayer = null;
      pv.shapes = [];
      pv.layers = [];
      pv.positions = [];
      dom.fileName.textContent = filename;
      dom.zoomLabel.textContent = '100%';
      syncActions();
      if (!pv.panelVisible) {
        pv.panelVisible = true;
        dom.panel.classList.remove('pvw-panel-hidden');
        dom.togglePanel.classList.remove('active');
      }
      canvasView.showLoading();
      dom.shapesList.innerHTML = '';
      dom.layerTabs.innerHTML = '';
      dom.fileMeta.textContent = 'Loading…';
      dom.modal.classList.add('open');

      const { data, source } = await previewService.preparePreviewData({ state, fileId, filename });
      pv.shapes = data.shapes;
      pv.layers = data.layers;
      pv.canvasWidth = canvasView.getCanvasWidth();
      pv.positions = canvasView.autoLayout(pv.shapes, pv.canvasWidth);
      const hint = source === 'mock' ? '  · preview' : '';
      dom.fileMeta.textContent = `${pv.shapes.length} shape${pv.shapes.length !== 1 ? 's' : ''} · ${pv.layers.length} layer${pv.layers.length !== 1 ? 's' : ''}${hint}`;
      renderTabs();
      renderSVG();
      renderList();
    }

    // Hides the modal by removing the "open" class; does not discard pv state
    // so a re-open of the same file can still diff against the previous session.
    function closeDXFPreview() {
      dom.modal.classList.remove('open');
    }

    // Re-renders the canvas and list without re-parsing the DXF — used when a
    // setting such as the engraving layer changes while the modal is already open.
    function refreshDXFPreview() {
      if (!dom.modal.classList.contains('open')) return;
      renderSVG();
      renderList();
    }

    // Toggles between delete and restore for the selected shape depending on its
    // current visible flag, so the same button serves both actions.
    dom.removeShape?.addEventListener('click', () => {
      if (!pv.selectedId) return;
      const selected = pv.shapes.find(shape => shape.id === pv.selectedId);
      if (!selected) return;
      if (selected.visible === false) restoreShape(pv.selectedId);
      else deleteShape(pv.selectedId);
    });

    // Removes the entire file from the job (not just a single shape) and
    // persists state; closes the modal only if the removal succeeded.
    dom.removePart?.addEventListener('click', () => {
      if (!pv.fileId || typeof global.removeJobFileById !== 'function') return;
      const removed = global.removeJobFileById(pv.fileId);
      if (removed && typeof global.schedulePersistJobState === 'function') global.schedulePersistJobState();
      if (removed) closeDXFPreview();
    });

    // Zoom buttons and ctrl/cmd+wheel all funnel through setZoom so clamping
    // and label updates are handled in one place.
    dom.zoomIn.addEventListener('click', () => setZoom(pv.zoom + 0.25));
    dom.zoomOut.addEventListener('click', () => setZoom(pv.zoom - 0.25));
    dom.zoomFit.addEventListener('click', () => setZoom(1));
    dom.canvasWrap.addEventListener('wheel', event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(pv.zoom + (event.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });

    // Collapses or expands the shapes panel; re-renders the SVG in a rAF so the
    // layout recalculates after the panel's CSS transition has started.
    dom.togglePanel.addEventListener('click', () => {
      pv.panelVisible = !pv.panelVisible;
      dom.panel.classList.toggle('pvw-panel-hidden', !pv.panelVisible);
      dom.togglePanel.classList.toggle('active', !pv.panelVisible);
      requestAnimationFrame(() => renderSVG());
    });

    // Re-renders the SVG on window resize so the canvas fills the new column
    // width; skipped when the modal is not open to avoid unnecessary work.
    window.addEventListener('resize', () => {
      if (!dom.modal.classList.contains('open')) return;
      renderSVG();
    });

    // Delete/Backspace keyboard shortcut for removing the selected shape;
    // ignored when focus is inside a text input to avoid swallowing edits.
    window.addEventListener('keydown', event => {
      if (!dom.modal.classList.contains('open')) return;
      if (!pv.selectedId) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      event.preventDefault();
      deleteShape(pv.selectedId);
    });

    // All three close triggers (X button, Cancel, overlay click) route to the
    // same closeDXFPreview so behaviour is consistent.
    dom.close.addEventListener('click', closeDXFPreview);
    dom.cancel.addEventListener('click', closeDXFPreview);
    dom.modal.addEventListener('click', event => {
      if (event.target === dom.modal) closeDXFPreview();
    });

    // Apply commits the edited shapes back to the file in app state, triggers a
    // persist, re-renders the file list, then closes the modal.
    dom.apply.addEventListener('click', () => {
      previewService.applyPreviewToFile({
        state,
        fileId: pv.fileId,
        shapes: pv.shapes,
        layers: pv.layers,
        renderFiles: global.renderFiles,
        schedulePersistJobState: global.schedulePersistJobState,
      });
      closeDXFPreview();
    });

    return {
      pv,
      openDXFPreview,
      closeDXFPreview,
      refreshDXFPreview,
    };
  }

  global.NestDxfPreviewModalView = {
    createDxfPreviewModal,
  };
})(window);
