(function attachNestDxfPreviewModalView(global) {
  'use strict';

  function createDxfPreviewModal({ state }) {
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

    function renderSVG() {
      canvasView.renderSVG(selectShape);
    }

    function renderList() {
      shapesListView.renderList({
        onSelectShape: selectShape,
        onChangeQty: changeQty,
        onSetQty: setQty,
        onRestoreShape: restoreShape,
      });
    }

    function selectShape(id) {
      pv.selectedId = pv.selectedId === id ? null : id;
      renderSVG();
      renderList();
      if (pv.selectedId) {
        const element = dom.shapesList.querySelector(`[data-id="${pv.selectedId}"]`);
        if (element) element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    function changeQty(id, delta) {
      const shape = pv.shapes.find(entry => entry.id === id);
      if (shape) {
        shape.qty = Math.max(1, shape.qty + delta);
        renderList();
      }
    }

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

    function deleteShape(id) {
      const shape = pv.shapes.find(entry => entry.id === id);
      if (!shape) return;
      shape.visible = false;
      pv.selectedId = id;
      renderSVG();
      renderList();
      renderTabs();
    }

    function restoreShape(id) {
      const shape = pv.shapes.find(entry => entry.id === id);
      if (!shape) return;
      shape.visible = true;
      pv.selectedId = id;
      renderSVG();
      renderList();
      renderTabs();
    }

    function setZoom(nextZoom) {
      pv.zoom = Math.max(0.25, Math.min(5, nextZoom));
      dom.zoomLabel.textContent = `${Math.round(pv.zoom * 100)}%`;
      canvasView.applyZoomTransform();
    }

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

    function closeDXFPreview() {
      dom.modal.classList.remove('open');
    }

    function refreshDXFPreview() {
      if (!dom.modal.classList.contains('open')) return;
      renderSVG();
      renderList();
    }

    dom.removeShape?.addEventListener('click', () => {
      if (!pv.selectedId) return;
      const selected = pv.shapes.find(shape => shape.id === pv.selectedId);
      if (!selected) return;
      if (selected.visible === false) restoreShape(pv.selectedId);
      else deleteShape(pv.selectedId);
    });

    dom.removePart?.addEventListener('click', () => {
      if (!pv.fileId || typeof global.removeJobFileById !== 'function') return;
      const removed = global.removeJobFileById(pv.fileId);
      if (removed && typeof global.schedulePersistJobState === 'function') global.schedulePersistJobState();
      if (removed) closeDXFPreview();
    });

    dom.zoomIn.addEventListener('click', () => setZoom(pv.zoom + 0.25));
    dom.zoomOut.addEventListener('click', () => setZoom(pv.zoom - 0.25));
    dom.zoomFit.addEventListener('click', () => setZoom(1));
    dom.canvasWrap.addEventListener('wheel', event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(pv.zoom + (event.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });

    dom.togglePanel.addEventListener('click', () => {
      pv.panelVisible = !pv.panelVisible;
      dom.panel.classList.toggle('pvw-panel-hidden', !pv.panelVisible);
      dom.togglePanel.classList.toggle('active', !pv.panelVisible);
      requestAnimationFrame(() => renderSVG());
    });

    window.addEventListener('resize', () => {
      if (!dom.modal.classList.contains('open')) return;
      renderSVG();
    });

    window.addEventListener('keydown', event => {
      if (!dom.modal.classList.contains('open')) return;
      if (!pv.selectedId) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      event.preventDefault();
      deleteShape(pv.selectedId);
    });

    dom.close.addEventListener('click', closeDXFPreview);
    dom.cancel.addEventListener('click', closeDXFPreview);
    dom.modal.addEventListener('click', event => {
      if (event.target === dom.modal) closeDXFPreview();
    });

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
