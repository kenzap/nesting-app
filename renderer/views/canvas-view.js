'use strict';

(function defineCanvasView(globalScope) {
  function createCanvasView({
    state,
    dom,
    getCurrentNestingSettings,
    setNestStatsTone,
    syncViewportEmptyState,
  }) {
    const { formatWidthMeters, partLabelFromName } = globalScope.NestHelpers;
    const { DEFAULT_ENGRAVING_COLOR } = globalScope.NestConstants;
    const FIT_INSET_X = 40;
    const FIT_INSET_Y = 28;
    const SVG_PREVIEW_MARGIN_X = 80;
    const SVG_PREVIEW_MARGIN_Y = 24;

    // Same logic as renderer.js — returns the 1-based engraving layer number,
    // or null if engraving is turned off. Kept here so the canvas view is self-contained.
    function engravingLayerIndex(settings = getCurrentNestingSettings()) {
      const raw = settings?.engravingLayer;
      if (raw === 'off' || raw === false || raw == null || raw === '') return null;
      const parsed = Number.parseInt(String(raw), 10);
      return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
    }

    // Picks the best available hex colour for engraving labels.
    // Falls back through the configured engraving layer → layer 2 → layer 1 → the app default.
    function resolveEngravingColor(layers = []) {
      const idx = engravingLayerIndex();
      if (idx !== null && layers[idx - 1]?.color) return layers[idx - 1].color;
      if (layers[1]?.color) return layers[1].color;
      if (layers[0]?.color) return layers[0].color;
      return DEFAULT_ENGRAVING_COLOR;
    }

    // Convenience accessor — only one sheet config is supported at a time,
    // so always pull from index 0 rather than scattering that assumption everywhere.
    function currentSheetConfig() {
      return state.sheets[0] || {};
    }

    // When the sheet is in fixed-width mode the solver still reports its own strip width,
    // so we override the display value with the user's configured width instead.
    function displayStripWidth(strip, sheet = currentSheetConfig()) {
      if (sheet?.widthMode === 'fixed') {
        const configuredWidth = Number(sheet?.width);
        if (Number.isFinite(configuredWidth) && configuredWidth > 0) return configuredWidth;
      }
      return Number(strip?.strip_width) || 0;
    }

    // The solver calculates density against its own strip width, not the user's target width.
    // In fixed-width mode we re-derive utilisation so the status bar reflects the correct percentage.
    function displayStripDensity(strip, sheet = currentSheetConfig()) {
      if (!strip) return null;
      const rawDensity = Number(strip?.density);
      if (!Number.isFinite(rawDensity)) return null;

      const rawWidth = Number(strip?.strip_width);
      const rawHeight = Number(strip?.strip_height) || Number(sheet?.height);
      const targetWidth = displayStripWidth(strip, sheet);

      if (!Number.isFinite(rawWidth) || rawWidth <= 0 || !Number.isFinite(rawHeight) || rawHeight <= 0) {
        return rawDensity;
      }
      if (sheet?.widthMode !== 'fixed') return rawDensity;

      const usedArea = rawDensity * rawWidth * rawHeight;
      const fixedArea = targetWidth * rawHeight;
      if (!Number.isFinite(fixedArea) || fixedArea <= 0) return rawDensity;
      return usedArea / fixedArea;
    }

    // The Sparrow solver encodes sheet container frames as a strict 4-point path string.
    // This parser lets us read those coordinates back so we can rewrite the frame dimensions.
    function parseRectPathData(pathData) {
      const match = /^M([-\d.]+),([-\d.]+) L([-\d.]+),([-\d.]+) L([-\d.]+),([-\d.]+) L([-\d.]+),([-\d.]+) z$/i.exec((pathData || '').trim());
      if (!match) return null;
      return {
        x0: Number(match[1]),
        y0: Number(match[2]),
        x1: Number(match[3]),
        y1: Number(match[4]),
        x2: Number(match[5]),
        y2: Number(match[6]),
        x3: Number(match[7]),
        y3: Number(match[8]),
      };
    }

    // Inverse of parseRectPathData — builds the 4-point closed path string
    // from an origin and dimensions, ready to write back into the SVG DOM.
    function formatRectPathData(x, y, width, height) {
      return `M${x},${y} L${x + width},${y} L${x + width},${y + height} L${x},${y + height} z`;
    }

    // In fixed-width mode the solver's viewBox and frame rectangles are sized to the solver's
    // strip width, not the user's target. This rewrites those elements in-place and re-serialises
    // the SVG so that what gets rendered matches the configured sheet width.
    function adjustSvgForFixedWidth(svg, strip, targetWidth) {
      if (!svg || !Number.isFinite(targetWidth) || targetWidth <= 0) return svg;

      const parser = new DOMParser();
      const doc = parser.parseFromString(svg, 'image/svg+xml');
      const root = doc.documentElement;
      if (!root || root.nodeName.toLowerCase() !== 'svg') return svg;

      const viewBoxParts = (root.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
      const vb = {
        x: viewBoxParts[0] || 0,
        y: viewBoxParts[1] || 0,
        w: viewBoxParts[2] || 0,
        h: viewBoxParts[3] || 0,
      };
      if (!Number.isFinite(vb.w) || vb.w <= 0) return svg;

      const previewMinX = -SVG_PREVIEW_MARGIN_X;
      const previewMinY = vb.y - SVG_PREVIEW_MARGIN_Y;
      const previewWidth = targetWidth + (SVG_PREVIEW_MARGIN_X * 2);
      const previewHeight = vb.h + (SVG_PREVIEW_MARGIN_Y * 2);

      root.setAttribute('viewBox', `${previewMinX} ${previewMinY} ${previewWidth} ${previewHeight}`);
      root.setAttribute('width', `${previewWidth}`);

      const sourceWidth = Number(strip?.strip_width) || vb.w;
      const frameOriginX = 0;
      const frameGroups = Array.from(root.querySelectorAll('g[id^="container_"]'));
      let normalizedAnyFrame = false;
      frameGroups.forEach(group => {
        const framePath = group.querySelector('path');
        if (!framePath) return;
        const rect = parseRectPathData(framePath.getAttribute('d'));
        if (!rect) return;
        const width = rect.x1 - rect.x0;
        const height = rect.y2 - rect.y1;
        if (!Number.isFinite(width) || !Number.isFinite(height)) return;
        if (Math.abs(width - sourceWidth) > 0.1) return;
        framePath.setAttribute('d', formatRectPathData(frameOriginX, rect.y0, targetWidth, height));
        normalizedAnyFrame = true;

        const title = group.querySelector('title');
        if (title) {
          title.textContent = title.textContent.replace(
            /bbox:\s*\[x_min:\s*[-\d.]+,\s*y_min:\s*[-\d.]+,\s*x_max:\s*[-\d.]+,\s*y_max:\s*[-\d.]+\]/i,
            `bbox: [x_min: ${frameOriginX.toFixed(3)}, y_min: ${rect.y0.toFixed(3)}, x_max: ${(frameOriginX + targetWidth).toFixed(3)}, y_max: ${(rect.y0 + height).toFixed(3)}]`
          );
        }
      });

      const dashedOutline = root.querySelector('#highlight_cd_shapes > path:last-of-type');
      if (dashedOutline) {
        const rect = parseRectPathData(dashedOutline.getAttribute('d'));
        if (rect) {
          const width = rect.x1 - rect.x0;
          const height = rect.y2 - rect.y1;
          if (Number.isFinite(width) && Number.isFinite(height) && (Math.abs(width - sourceWidth) <= 0.1 || normalizedAnyFrame)) {
            dashedOutline.setAttribute('d', formatRectPathData(0, rect.y0, targetWidth, height));
          }
        }
      }

      const serializer = new XMLSerializer();
      return serializer.serializeToString(root);
    }

    // Main SVG post-processor — applies the dark colour scheme to the raw solver output.
    // Injects a grid background, recolours part fills to navy with a blue glow, tightens
    // the sheet border style, strips solver stat labels, and calls adjustSvgForFixedWidth
    // when the sheet is in fixed-width mode.
    function styleStripSVG(svg, strip = null) {
      if (!svg) return '';

      let styled = svg;
      const sheet = currentSheetConfig();
      const targetWidth = strip ? displayStripWidth(strip, sheet) : null;
      if (targetWidth) {
        styled = adjustSvgForFixedWidth(styled, strip, targetWidth);
      }
      const viewBoxMatch = styled.match(/viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/i);
      const vb = viewBoxMatch
        ? { x: Number(viewBoxMatch[1]), y: Number(viewBoxMatch[2]), w: Number(viewBoxMatch[3]), h: Number(viewBoxMatch[4]) }
        : { x: 0, y: 0, w: 3000, h: 1250 };

      const bgMarkup = `
<defs>
<pattern id="nestGrid" width="40" height="40" patternUnits="userSpaceOnUse">
<path d="M40 0 L0 0 0 40" fill="none" stroke="#1b1f2b" stroke-width="0.8"/>
</pattern>
<filter id="partGlow" x="-4%" y="-4%" width="108%" height="108%">
<feGaussianBlur stdDeviation="${vb.w * 0.0015}" result="blur"/>
<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
</defs>`;

      styled = styled.replace(/<svg([^>]*)>/i, `<svg$1>\n${bgMarkup}`);
      styled = styled.replace(/fill="#D3D3D3"\s+stroke="black"\s+stroke-width="([\d.]+)"/gi, (_, sw) => `fill="url(#nestGrid)" stroke="#2e3550" stroke-width="${sw}"`);
      styled = styled.replace(/fill="#7A7A7A"\s+fill-opacity="0\.5"\s+fill-rule="nonzero"\s+stroke="black"\s+stroke-width="([\d.]+)"/gi, (_, sw) => `fill="#1a2744" fill-opacity="1" fill-rule="nonzero" stroke="#4f8ef7" stroke-width="${(sw * 0.7).toFixed(4)}" filter="url(#partGlow)"`);
      styled = styled.replace(
        /fill="none"\s+stroke="black"\s+stroke-dasharray="([^"]+)"\s+stroke-linecap="([^"]+)"\s+stroke-linejoin="([^"]+)"\s+stroke-opacity="0\.3"\s+stroke-width="([\d.]+)"/gi,
        (_, da, lc, lj, sw) => `fill="none" stroke="#3a5080" stroke-dasharray="${da}" stroke-linecap="${lc}" stroke-linejoin="${lj}" stroke-opacity="0.35" stroke-width="${(sw * 0.6).toFixed(4)}"`
      );
      styled = styled.replace(/stroke="black"/gi, 'stroke="#2e3550"');
      styled = styled.replace(/<text[^>]*>[\s\S]*?h:[\s\S]*?<\/text>/gi, '');
      return styled;
    }

    // Rebuilds the sheet tab row above the canvas from the current solver result.
    // Each tab wires up a click handler to showNestResult and the active tab is
    // kept in view via smooth scrollIntoView.
    function renderTabs() {
      dom.canvasTabs.innerHTML = '';
      if (state.nestResult?.strips?.length) {
        const activeIndex = Math.min(state.activeStripIndex || 0, Math.max(0, state.nestResult.strips.length - 1));
        state.activeStripIndex = activeIndex;
        state.nestResult.strips.forEach((strip, i) => {
          const btn = document.createElement('button');
          btn.className = 'canvas-tab' + (i === activeIndex ? ' active' : '');
          btn.textContent = `Sheet ${i + 1}`;
          btn.addEventListener('click', () => {
            dom.canvasTabs.querySelectorAll('.canvas-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.activeStripIndex = i;
            btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            showNestResult(i);
          });
          dom.canvasTabs.appendChild(btn);
          if (i === activeIndex) {
            requestAnimationFrame(() => {
              btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            });
          }
        });
      }
    }

    // Generates a fake placement SVG from the currently loaded files and sheet config.
    // This keeps the canvas looking populated while the real solver is running,
    // rather than showing an empty viewport.
    function generateMockNestSVG(sheetIndex) {
      const sheet = state.sheets[sheetIndex];
      if (!sheet) return null;

      const previewWidth = sheet.widthMode === 'unlimited' ? 3000 : (sheet.width || 3000);
      const W = 800;
      const H = Math.round(800 * sheet.height / previewWidth);
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
          if (type === 0) shape = { w: 80 * scale, h: 50 * scale, type: 'rect', name: f.name };
          else if (type === 1) shape = { w: 90 * scale, h: 70 * scale, type: 'L', name: f.name };
          else if (type === 2) shape = { w: 100 * scale, h: 60 * scale, type: 'notch', name: f.name };
          else shape = { w: 70 * scale, h: 80 * scale, type: 'T', name: f.name };

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
        const { x, y, w, h, type } = s;
        const fill = '#1a2744';
        const stroke = '#4f8ef7';
        const strokeOpacity = '0.75';
        let path = '';

        if (type === 'rect') {
          path = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2" filter="url(#partGlow)"/>`;
        } else if (type === 'L') {
          const hw = (w * 0.45).toFixed(1), hh = (h * 0.45).toFixed(1);
          path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${hh} h${-hw} v${(h - parseFloat(hh)).toFixed(1)} h${-(w - parseFloat(hw)).toFixed(1)} Z" fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2" filter="url(#partGlow)"/>`;
        } else if (type === 'notch') {
          const nw = (w * 0.25).toFixed(1), nh = (h * 0.35).toFixed(1);
          const nx = (x + w / 2 - parseFloat(nw) / 2).toFixed(1);
          path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${h.toFixed(1)} h${-w.toFixed(1)} Z M${nx},${y.toFixed(1)} h${nw} v${nh} h${-nw} Z" fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2" fill-rule="evenodd" filter="url(#partGlow)"/>`;
        } else {
          const tw = (w * 0.4).toFixed(1);
          const stemH = (h * 0.55).toFixed(1);
          path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${(h - parseFloat(stemH)).toFixed(1)} h${-(w / 2 - parseFloat(tw) / 2).toFixed(1)} v${stemH} h${-parseFloat(tw).toFixed(1)} v${-stemH} h${-(w / 2 - parseFloat(tw) / 2).toFixed(1)} Z" fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2" filter="url(#partGlow)"/>`;
        }

        const labelText = engravingLayerIndex() !== null ? partLabelFromName(s.name) : '';
        const labelFontSize = Math.max(7, Math.min(w, h) * 0.12);
        const labelStrokeWidth = 0.8;
        const label = labelText
          ? `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="${labelFontSize.toFixed(1)}" fill="none" stroke="${resolveEngravingColor()}" stroke-width="${labelStrokeWidth.toFixed(2)}" stroke-linejoin="round" stroke-linecap="round" opacity="0.96" font-family="monospace">${labelText}</text>`
          : '';
        return path + label;
      }).join('\n');

      const utilization = Math.round(60 + Math.random() * 25);
      return {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
          ${defs}
          <rect width="${W}" height="${H}" fill="#0d0f18"/>
          <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="3" fill="none" stroke="#2e3550" stroke-width="1" stroke-dasharray="6 4"/>
          ${shapesSVG}
          <text x="${W / 2}" y="${H - 8}" text-anchor="middle" font-size="9" fill="#3a4566" font-family="monospace">
            ${sheet.width} × ${sheet.height} mm · Preview · ${utilization}% utilization
          </text>
        </svg>`,
        utilization,
      };
    }

    // Central display function for a given sheet index.
    // Prefers a real solver result (styled via styleStripSVG) and falls back to the mock
    // preview when none is available yet. Updates the status bar with parts count,
    // utilisation percentage, and strip width.
    function showNestResult(sheetIndex) {
      if (state.nestResult?.strips?.[sheetIndex]?.svg) {
        const strip = state.nestResult.strips[sheetIndex];
        const sheet = currentSheetConfig();
        state.activeStripIndex = sheetIndex;
        dom.svgContainer.innerHTML = styleStripSVG(strip.svg, strip);
        dom.svgContainer.style.display = 'grid';
        dom.emptyState.style.display = 'none';
        syncViewportEmptyState(false);
        const placed = Number(strip.item_count) || 0;
        const densityValue = displayStripDensity(strip, sheet);
        const density = Number.isFinite(densityValue) ? `${(densityValue * 100).toFixed(1)}%` : null;
        const usedWidth = formatWidthMeters(displayStripWidth(strip, sheet));
        const previewPrefix = strip.is_preview || state.nestResult.is_preview ? 'Preview · ' : '';
        setNestStatsTone('');
        const partsText = placed > 0 ? ` · ${placed} parts` : '';
        const utilText = density ? ` · Utilization: ${density}` : '';
        dom.nestStats.textContent = `${previewPrefix}Sheet ${sheetIndex + 1} of ${state.nestResult.strips.length}${partsText}${utilText} · Width: ${usedWidth}`;
        applyZoom(true);
        return;
      }

      const result = generateMockNestSVG(sheetIndex);
      if (!result) return;
      dom.svgContainer.innerHTML = result.svg;
      dom.svgContainer.style.display = 'grid';
      dom.emptyState.style.display = 'none';
      syncViewportEmptyState(false);
      const placed = state.files.reduce((a, f) => a + f.qty, 0);
      const mockWidth = formatWidthMeters(state.sheets[sheetIndex]?.width);
      setNestStatsTone('');
      dom.nestStats.textContent = `Sheet ${sheetIndex + 1} of ${state.sheets.length} · ${placed} parts placed · Utilization: ${result.utilization}% · Width: ${mockWidth}`;
      applyZoom(true);
    }

    // After a zoom change the SVG may be larger or smaller than the viewport.
    // This scrolls to the midpoint of the overflow so the content stays centred.
    function centerViewportOnContent() {
      if (!dom.viewport) return;
      const maxScrollLeft = Math.max(0, dom.viewport.scrollWidth - dom.viewport.clientWidth);
      const maxScrollTop = Math.max(0, dom.viewport.scrollHeight - dom.viewport.clientHeight);
      dom.viewport.scrollLeft = maxScrollLeft / 2;
      dom.viewport.scrollTop = maxScrollTop / 2;
    }

    // Resizes the SVG element to reflect state.zoom relative to the SVG's natural dimensions.
    // On the first call it reads and caches those natural dimensions from the viewBox so that
    // all subsequent zoom levels are calculated consistently from the same baseline.
    function applyZoom(recenter = false) {
      const el = dom.svgContainer.querySelector('svg');
      if (el) {
        const viewBox = (el.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
        const baseWidth = Number(el.dataset.baseWidth) || viewBox[2] || el.viewBox?.baseVal?.width || el.clientWidth || 1;
        const baseHeight = Number(el.dataset.baseHeight) || viewBox[3] || el.viewBox?.baseVal?.height || el.clientHeight || 1;
        const fitWidth = Math.max(1, (dom.viewport?.clientWidth || baseWidth) - (FIT_INSET_X * 2));
        const fitHeight = Math.max(1, (dom.viewport?.clientHeight || baseHeight) - (FIT_INSET_Y * 2));
        const fitScale = Math.min(fitWidth / baseWidth, fitHeight / baseHeight, 1);
        el.dataset.baseWidth = String(baseWidth);
        el.dataset.baseHeight = String(baseHeight);
        el.style.width = `${baseWidth * fitScale * state.zoom}px`;
        el.style.height = `${baseHeight * fitScale * state.zoom}px`;
        el.style.transform = '';
      }
      dom.zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
      if (recenter) {
        requestAnimationFrame(() => centerViewportOnContent());
      }
    }

    // Wires up all canvas interaction: zoom-in/out/fit buttons update state.zoom and call
    // applyZoom, while mousedown/mousemove/mouseup on the viewport implement click-drag panning.
    // Also re-applies zoom on window resize so the fit scale stays accurate.
    function bind() {
      dom.zoomIn.addEventListener('click', () => { state.zoom = Math.min(4, state.zoom + 0.15); applyZoom(); });
      dom.zoomOut.addEventListener('click', () => { state.zoom = Math.max(0.2, state.zoom - 0.15); applyZoom(); });
      dom.fitView.addEventListener('click', () => { state.zoom = 1; applyZoom(true); });

      let viewportDrag = null;
      dom.viewport?.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        viewportDrag = {
          startX: e.clientX,
          startY: e.clientY,
          scrollLeft: dom.viewport.scrollLeft,
          scrollTop: dom.viewport.scrollTop,
        };
        dom.viewport.classList.add('dragging');
      });

      window.addEventListener('mousemove', e => {
        if (!viewportDrag || !dom.viewport) return;
        dom.viewport.scrollLeft = viewportDrag.scrollLeft - (e.clientX - viewportDrag.startX);
        dom.viewport.scrollTop = viewportDrag.scrollTop - (e.clientY - viewportDrag.startY);
      });

      window.addEventListener('mouseup', () => {
        if (!viewportDrag || !dom.viewport) return;
        viewportDrag = null;
        dom.viewport.classList.remove('dragging');
      });

      window.addEventListener('resize', () => {
        applyZoom(true);
      });
    }

    return {
      renderTabs,
      showNestResult,
      applyZoom,
      bind,
    };
  }

  globalScope.NestCanvasView = { createCanvasView };
})(window);
