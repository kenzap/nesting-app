(function attachNestDxfPreviewCanvasView(global) {
  'use strict';

  const { f } = global.NestDxfSvg;
  const { buildPreviewLabelSvg } = global.NestDxfEngravingPreviewService;

  const DEFAULT_CANVAS_W = 560;
  const PAD = 18;

  // Target longest-dimension size in canvas pixels for a shape rendered at its
  // natural display scale.  Shapes smaller or larger than this are scaled so
  // every shape appears at a legible, consistent size regardless of its real-
  // world mm dimensions.
  const TARGET_DISPLAY_PX = 700;
  const MIN_DISPLAY_SCALE = 0.15;   // don't crush very large shapes below 15 %
  const MAX_DISPLAY_SCALE = 40;     // don't blow up very tiny shapes above 40×

  // Returns the scale factor to apply to a shape's SVG so its longest side is
  // approximately TARGET_DISPLAY_PX pixels, clamped to a sensible range.
  function shapeDisplayScale(shape) {
    const longest = Math.max(shape.bbox.w || 0, shape.bbox.h || 0);
    if (!longest) return 1;
    return Math.max(MIN_DISPLAY_SCALE, Math.min(MAX_DISPLAY_SCALE, TARGET_DISPLAY_PX / longest));
  }

  function createDxfPreviewCanvasView({ pv, getCanvasWrap, getLayerConfig }) {
    // Reads the live rendered width of the canvas column so the SVG fills the
    // actual available space instead of falling back to the hardcoded default.
    function getCanvasWidth() {
      const fallback = DEFAULT_CANVAS_W;
      const col = getCanvasWrap()?.parentElement;
      if (!col) return fallback;
      const style = window.getComputedStyle(col);
      const colWidth = col.clientWidth
        - parseFloat(style.paddingLeft || 0)
        - parseFloat(style.paddingRight || 0);
      return Math.max(fallback, Math.floor(colWidth - 8));
    }

    // Arranges shapes into rows, wrapping to a new row whenever the next shape
    // would overflow the canvas width. Returns an {x,y} position for each shape
    // in the same order as the input array so buildPreviewSVG can translate them.
    function autoLayout(shapes, canvasWidth) {
      let x = PAD;
      let y = PAD;
      let rowH = 0;
      return shapes.map(shape => {
        const scale = shapeDisplayScale(shape);
        const displayW = shape.bbox.w * scale;
        const displayH = shape.bbox.h * scale;
        if (x + displayW + PAD > canvasWidth && x > PAD) {
          x = PAD;
          y += rowH + PAD;
          rowH = 0;
        }
        const pos = { x, y };
        x += displayW + PAD;
        rowH = Math.max(rowH, displayH);
        return pos;
      });
    }

    // Assembles the full SVG markup for the preview canvas — background, dot
    // grid, and one <g> per shape with selection glow, decor layers, boundary
    // items, engraving label, and a name caption underneath.
    function buildPreviewSVG(shapes, positions, activeLayer, selectedId, canvasWidth) {
      const maxX = positions.reduce((max, pos, index) => Math.max(max, pos.x + shapes[index].bbox.w * shapeDisplayScale(shapes[index]) + PAD), 0);
      const maxY = positions.reduce((max, pos, index) => Math.max(max, pos.y + shapes[index].bbox.h * shapeDisplayScale(shapes[index]) + 14), 0) + PAD;
      const width = Math.max(canvasWidth, maxX, DEFAULT_CANVAS_W);
      const height = Math.max(maxY, 220);

      const grid = [];
      for (let gx = 0; gx <= width; gx += 24) grid.push(`<line x1="${gx}" y1="0" x2="${gx}" y2="${height}" stroke="#1a1d2a" stroke-width="0.5"/>`);
      for (let gy = 0; gy <= height; gy += 24) grid.push(`<line x1="0" y1="${gy}" x2="${width}" y2="${gy}" stroke="#1a1d2a" stroke-width="0.5"/>`);

      const shapeEls = shapes.map((shape, index) => {
        const pos = positions[index];
        const isSelected = shape.id === selectedId;
        const hasActiveLayer = activeLayer !== null;
        const renderSyntheticPath = !shape.hasSyntheticOuter;
        const selectableLayers = shape.ownerLayers || [shape.layer];
        const layerMatch = !hasActiveLayer || selectableLayers.includes(activeLayer);
        const isDimmed = !shape.visible || !layerMatch;
        const showOuter = !hasActiveLayer || activeLayer === shape.layer || !layerMatch;
        const visibleDecorItems = layerMatch
          ? (shape.decorItems || []).filter(item => !hasActiveLayer || item.layer === activeLayer)
          : [];
        const visibleBoundaryItems = layerMatch
          ? (shape.outerBoundaryItems || []).filter(item => !hasActiveLayer || item.layer === activeLayer)
          : [];
        const allowSelectionFill = !!shape.selectionFillAllowed;
        const selectionPath = shape.selectionPathData || null;
        const dimmedOuterOpacity = hasActiveLayer && activeLayer !== shape.layer && layerMatch ? 0.05 : (isSelected ? 0.34 : 0.09);
        const dimmedStrokeOpacity = hasActiveLayer && activeLayer !== shape.layer && layerMatch ? 0.25 : (isSelected ? 0.9 : 1);
        const selectedGeometryOpacity = isSelected ? 0.9 : 1;
        const baseStrokeOpacity = isSelected ? dimmedStrokeOpacity : 0.85;
        const baseStrokeWidth = isSelected ? 1.2 : 0.8;
        const previewLabel = getLayerConfig(shape);
        const previewLabelSvg = previewLabel.enabled && shape.partLabel
          ? buildPreviewLabelSvg(
            String(shape.partLabel || ''),
            shape.bbox,
            previewLabel.color,
            previewLabel.style,
            shape.engravingPolygonPoints,
            shape.engravingHoles || []
          )
          : '';

        const displayScale = shapeDisplayScale(shape);
        const displayW = shape.bbox.w * displayScale;
        const displayH = shape.bbox.h * displayScale;
        // All stroke widths in the pre-built SVG strings are in mm units.
        // Dividing by displayScale keeps them visually consistent after the
        // scale() transform is applied to the group.
        const normaliseStrokes = svgStr => svgStr.replace(
          /stroke-width="([^"]+)"/g,
          (_, v) => `stroke-width="${f(+v / displayScale)}"`
        );
        const strokeW = f(baseStrokeWidth / displayScale);
        const selStrokeW = f(2.8 / displayScale);
        const normBoundaryItems = visibleBoundaryItems.map(item => normaliseStrokes(item.svg));
        const normDecorItems    = visibleDecorItems.map(item => normaliseStrokes(item.svg));
        return `
<g class="pvw-shape" data-id="${shape.id}"
   transform="translate(${f(pos.x)},${f(pos.y)})"
   opacity="${isDimmed ? 0.12 : 1}" style="cursor:pointer">
  <g transform="scale(${f(displayScale)})">
    ${showOuter && isSelected && allowSelectionFill && selectionPath ? `<path d="${selectionPath}" fill="white" fill-opacity="0.06" fill-rule="${shape.fillRule}" stroke="none"/>` : ''}
    ${showOuter && isSelected && selectionPath ? `<path d="${selectionPath}" fill="none" stroke="${shape.layerColor}" stroke-width="${selStrokeW}" stroke-opacity="0.75" stroke-linejoin="round" fill-rule="${shape.fillRule}" filter="url(#pvwGlow)"/>` : ''}
    ${showOuter && renderSyntheticPath && !shape.mixedOuterLayers && !isSelected ? `<path d="${shape.pathData}" fill="${shape.layerColor}" fill-opacity="${allowSelectionFill ? dimmedOuterOpacity : 0}" fill-rule="${shape.fillRule}" stroke="${shape.layerColor}" stroke-opacity="${baseStrokeOpacity}" stroke-width="${strokeW}" stroke-linejoin="round"/>` : ''}
    <g opacity="${selectedGeometryOpacity}">
      ${normBoundaryItems.join('\n')}
      ${normDecorItems.join('\n')}
    </g>
    ${previewLabelSvg}
  </g>
  <text x="${f(displayW / 2)}" y="${f(displayH + 11)}" text-anchor="middle" font-size="8" fill="${shape.layerColor}" opacity="0.6" font-family="monospace">${shape.name}</text>
  <title>${shape.name} · outer: ${(shape.ownerLayers || [shape.layer]).join(', ')} · all: ${(shape.involvedLayers || [shape.layer]).join(', ')} · ${global.NestDxfSvg.f1(shape.bbox.w)}×${global.NestDxfSvg.f1(shape.bbox.h)} mm</title>
</g>`;
      }).join('');

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" id="pvwSVGInner" style="display:block;width:${width}px">
  <defs>
    <filter id="pvwGlow" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="#0d0f18"/>
  ${grid.join('')}
  ${shapeEls}
</svg>`;
    }

    // Scales the inner SVG element via CSS transform and expands its wrapper div
    // to match, so the scrollable container reports the correct zoomed dimensions.
    function applyZoomTransform() {
      const inner = document.getElementById('pvwSVGInner');
      const canvasInner = document.getElementById('pvCanvasInner');
      if (!inner || !canvasInner) return;
      inner.style.transformOrigin = 'top left';
      inner.style.transform = `scale(${pv.zoom})`;
      const viewBox = (inner.getAttribute('viewBox') || '').split(/\s+/).map(Number);
      const svgWidth = Number.isFinite(viewBox[2]) ? viewBox[2] : pv.canvasWidth;
      const svgHeight = Number.isFinite(viewBox[3]) ? viewBox[3] : 220;
      canvasInner.style.width = `${Math.max(pv.canvasWidth, svgWidth * pv.zoom)}px`;
      canvasInner.style.height = `${svgHeight * pv.zoom}px`;
    }

    // Top-level render entry point — computes fresh layout, injects the SVG into
    // the DOM, applies the current zoom, then attaches click listeners so each
    // shape <g> fires the caller-supplied onSelectShape callback.
    function renderSVG(onSelectShape) {
      pv.canvasWidth = getCanvasWidth();
      pv.positions = autoLayout(pv.shapes, pv.canvasWidth);
      const canvasWrap = getCanvasWrap();
      canvasWrap.innerHTML = `<div class="pvw-canvas-inner" id="pvCanvasInner">${buildPreviewSVG(pv.shapes, pv.positions, pv.activeLayer, pv.selectedId, pv.canvasWidth)}</div>`;
      applyZoomTransform();
      canvasWrap.querySelectorAll('.pvw-shape').forEach(group => {
        group.addEventListener('click', () => onSelectShape(group.dataset.id));
      });
    }

    // Replaces the canvas area with a spinner while the DXF file is being parsed,
    // so the user sees feedback instead of an empty or stale canvas.
    function showLoading() {
      const canvasWrap = getCanvasWrap();
      canvasWrap.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:200px;gap:10px;color:var(--text-muted);font-size:13px;">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style="animation:spin 1s linear infinite">
            <circle cx="16" cy="16" r="13" stroke="var(--border-light)" stroke-width="2.5"/>
            <path d="M16 3 A13 13 0 0 1 29 16" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
          Parsing DXF…
        </div>`;
    }

    return {
      DEFAULT_CANVAS_W,
      getCanvasWidth,
      autoLayout,
      buildPreviewSVG,
      applyZoomTransform,
      renderSVG,
      showLoading,
    };
  }

  global.NestDxfPreviewCanvasView = {
    DEFAULT_CANVAS_W,
    PAD,
    createDxfPreviewCanvasView,
  };
})(window);
