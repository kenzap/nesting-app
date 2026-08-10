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
    const { FALLBACK_PALETTE = [] } = globalScope.NestDxfLayerService || {};
    const FIT_INSET_X = 40;
    const FIT_INSET_Y = 28;
    const SVG_PREVIEW_MARGIN_X = 80;
    const SVG_PREVIEW_MARGIN_Y = 44;
    const SHEET_LABEL_FONT_SIZE = 22;
    const SHEET_LABEL_OFFSET_Y = 8;
    const MIN_ZOOM = 0.2;
    const MAX_ZOOM = 4;
    const ZOOM_STEP = 0.15;

    function isLightTheme() {
      return typeof document !== 'undefined'
        && document.documentElement.getAttribute('data-theme') === 'light';
    }

    // Per-source part palettes. Each source DXF gets one entry; if more than 8
    // sources are loaded the palette wraps. Ordering alternates warm/cool so
    // consecutive sources stay perceptually distinct. Blue (index 0) matches
    // the app accent so single-file jobs look identical to the pre-coloring
    // behavior.
    const PART_PALETTE_LIGHT = Object.freeze([
      { fill: '#bfdbfe', stroke: '#3b7de8' },
      { fill: '#fde68a', stroke: '#f59e0b' },
      { fill: '#a7f3d0', stroke: '#10b981' },
      { fill: '#fecdd3', stroke: '#f43f5e' },
      { fill: '#ddd6fe', stroke: '#8b5cf6' },
      { fill: '#fed7aa', stroke: '#f97316' },
      { fill: '#bae6fd', stroke: '#0ea5e9' },
      { fill: '#cbd5e1', stroke: '#64748b' },
    ]);
    const PART_PALETTE_DARK = Object.freeze([
      { fill: '#1a2744', stroke: '#4f8ef7' },
      { fill: '#3a2c0d', stroke: '#fbbf24' },
      { fill: '#12332a', stroke: '#34d399' },
      { fill: '#3a1e26', stroke: '#fb7185' },
      { fill: '#241f3a', stroke: '#a78bfa' },
      { fill: '#3a2617', stroke: '#fb923c' },
      { fill: '#0f2b3a', stroke: '#38bdf8' },
      { fill: '#252c37', stroke: '#94a3b8' },
    ]);

    // Assigns a palette entry to each item_id based on its source DXF.
    // Items sharing a source file share a color; new sources cycle through
    // the palette in the order they first appear. Returns Map<itemId, color>.
    // Returns null when the Appearance → "Color parts by source" toggle is off
    // so callers fall back to the theme default (single color for all parts).
    function buildItemColorMap() {
      const settings = getCurrentNestingSettings();
      if (settings?.colorPartsBySource === false) return null;
      const items = state.lastPlacementExportItems;
      if (!items || typeof items !== 'object') return null;
      const ids = Object.keys(items).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      if (!ids.length) return null;

      const palette = isLightTheme() ? PART_PALETTE_LIGHT : PART_PALETTE_DARK;
      const sourceColor = new Map();
      const itemColor = new Map();
      let nextIndex = 0;

      ids.forEach(id => {
        const src = items[id]?.source_file || items[id]?.source_name || `__id_${id}`;
        let color = sourceColor.get(src);
        if (!color) {
          color = palette[nextIndex % palette.length];
          sourceColor.set(src, color);
          nextIndex += 1;
        }
        itemColor.set(id, color);
      });

      return itemColor;
    }

    function previewThemeColors() {
      if (isLightTheme()) {
        // Light-theme palette follows the "paper on desk" convention used by
        // Fusion 360, Illustrator, and Rhino: the sheet is pure white, sitting
        // above the light-gray .canvas-viewport workspace. Parts use a tinted
        // blue-200 fill so they read as clean shapes against the white sheet
        // (ΔL* ~13, well within the 5–35 clear-separation band). The accent
        // stroke matches the app --accent token exactly. No glow filter in
        // light theme — the Gaussian blur softens edges on a light background
        // instead of adding depth.
        return {
          background: '#ffffff',
          gridStroke: '#e2e4ec',
          sheetStroke: '#bcc2d0',
          partFill: '#bfdbfe',
          partStroke: '#3b7de8',
          partFillOpacity: '1',
          partFilter: '',
          dashStroke: '#bcc2d0',
          dashOpacity: '0.55',
          metaText: '#4a5070',
          labelText: '#64748b',
          labelChipFill: '#ffffff',
          labelChipOpacity: '0.85',
        };
      }

      return {
        background: '#0d0f18',
        gridStroke: '#1b1f2b',
        sheetStroke: '#2e3550',
        partFill: '#1a2744',
        partStroke: '#4f8ef7',
        partFillOpacity: '1',
        partFilter: ' filter="url(#partGlow)"',
        dashStroke: '#3a5080',
        dashOpacity: '0.35',
        metaText: '#3a4566',
        labelText: '#8a97b3',
        labelChipFill: '#0d0f18',
        labelChipOpacity: '0.75',
      };
    }

    // Same logic as renderer.js — returns the 1-based engraving layer number,
    // or null if engraving is turned off. Kept here so the canvas view is self-contained.
    function engravingLayerIndex(settings = getCurrentNestingSettings()) {
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

    // Picks the best available hex colour for engraving labels.
    // Falls back through the configured engraving layer → layer 2 → layer 1 → the app default.
    function resolveEngravingColor(layers = []) {
      const idx = engravingLayerIndex();
      if (idx !== null && layers[idx - 1]?.color) return layers[idx - 1].color;
      if (idx !== null && batchLayerAtIndex(idx)?.color) return batchLayerAtIndex(idx).color;
      if (idx !== null && FALLBACK_PALETTE.length) return FALLBACK_PALETTE[(idx - 1) % FALLBACK_PALETTE.length];
      if (layers[0]?.color) return layers[0].color;
      return DEFAULT_ENGRAVING_COLOR;
    }

    // Convenience accessor — only one sheet config is supported at a time,
    // so always pull from index 0 rather than scattering that assumption everywhere.
    function currentSheetConfig() {
      return state.sheets[0] || {};
    }

    function stripSheetConfig(strip, fallbackSheet = currentSheetConfig()) {
      const runMode = String(strip?.sheet_width_mode || '').trim();
      const fallbackMode = String(fallbackSheet?.widthMode || 'fixed');
      const runWidth = Number(strip?.sheet_width);
      const fallbackWidth = Number(fallbackSheet?.width);
      const runHeight = Number(strip?.strip_height);
      const fallbackHeight = Number(fallbackSheet?.height);
      const runMargin = Number(strip?.sheet_margin);
      const currentMargin = Number(getCurrentNestingSettings()?.sheetMargin);

      return {
        widthMode: runMode || fallbackMode,
        width: Number.isFinite(runWidth) && runWidth > 0 ? runWidth : fallbackWidth,
        height: Number.isFinite(runHeight) && runHeight > 0 ? runHeight : fallbackHeight,
        margin: Math.max(0, Number.isFinite(runMargin) ? runMargin : (currentMargin || 0)),
      };
    }

    // Sparrow reports the usable strip width. Auto-sized sheets need the left
    // and right sheet margins added back; fixed sheets use their configured
    // outer width.
    function displayStripWidth(strip, sheet = currentSheetConfig()) {
      const config = stripSheetConfig(strip, sheet);
      if (config.widthMode === 'fixed') {
        const configuredWidth = Number(config.width);
        if (Number.isFinite(configuredWidth) && configuredWidth > 0) return configuredWidth;
      }
      const stripWidth = Number(strip?.strip_width) || 0;
      return stripWidth > 0 ? stripWidth + (config.margin * 2) : 0;
    }

    // Re-derive utilisation against the visible outer sheet whenever fixed
    // dimensions or sheet margins make it larger than Sparrow's usable area.
    function displayStripDensity(strip, sheet = currentSheetConfig()) {
      if (!strip) return null;
      const rawDensity = Number(strip?.density);
      if (!Number.isFinite(rawDensity)) return null;

      const config = stripSheetConfig(strip, sheet);
      const rawWidth = Number(strip?.strip_width);
      const outerHeight = Number(config.height);
      const rawHeight = outerHeight - (config.margin * 2);
      const targetWidth = displayStripWidth(strip, sheet);

      if (!Number.isFinite(rawWidth) || rawWidth <= 0 || !Number.isFinite(rawHeight) || rawHeight <= 0 ||
          !Number.isFinite(outerHeight) || outerHeight <= 0) {
        return rawDensity;
      }
      if (config.widthMode !== 'fixed' && config.margin === 0) return rawDensity;

      const usedArea = rawDensity * rawWidth * rawHeight;
      const outerArea = targetWidth * outerHeight;
      if (!Number.isFinite(outerArea) || outerArea <= 0) return rawDensity;
      return usedArea / outerArea;
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

    function parseSolverPolygonPoints(pathData) {
      const points = [];
      const coordinatePair = /[ML]\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)[,\s]+([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gi;
      let match;
      while ((match = coordinatePair.exec(pathData || ''))) {
        const x = Number(match[1]);
        const y = Number(match[2]);
        if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
      }
      return points;
    }

    function parseSolverPlacementTransform(value) {
      const transform = String(value || '');
      const translate = transform.match(/translate\(\s*([-\d.eE+]+)[,\s]+([-\d.eE+]+)\s*\)/i);
      const rotate = transform.match(/rotate\(\s*([-\d.eE+]+)/i);
      const angle = (Number(rotate?.[1]) || 0) * Math.PI / 180;
      return {
        tx: Number(translate?.[1]) || 0,
        ty: Number(translate?.[2]) || 0,
        cos: Math.cos(angle),
        sin: Math.sin(angle),
      };
    }

    function placedItemBounds(root) {
      const pointsByItemId = new Map();
      root.querySelectorAll('g[id^="item_"]').forEach(itemGroup => {
        const points = [];
        itemGroup.querySelectorAll('path[d]').forEach(path => {
          points.push(...parseSolverPolygonPoints(path.getAttribute('d')));
        });
        if (points.length) pointsByItemId.set(itemGroup.id, points);
      });

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let pointCount = 0;
      root.querySelectorAll('#items use').forEach(use => {
        const href = use.getAttribute('href')
          || use.getAttribute('xlink:href')
          || use.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href')
          || '';
        const points = pointsByItemId.get(String(href).replace(/^#/, ''));
        if (!points?.length) return;

        const transform = parseSolverPlacementTransform(use.getAttribute('transform'));
        points.forEach(point => {
          const x = point.x * transform.cos - point.y * transform.sin + transform.tx;
          const y = point.x * transform.sin + point.y * transform.cos + transform.ty;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          pointCount += 1;
        });
      });

      return pointCount ? { minX, minY, maxX, maxY } : null;
    }

    function ensureTranslatedChildWrapper(group, childSelector, tx, ty, markerName) {
      if (!group || (!tx && !ty)) return false;

      let wrapper = Array.from(group.children)
        .find(node => node.getAttribute?.(markerName) === '1');
      if (!wrapper) {
        const children = Array.from(group.children)
          .filter(node => node.matches?.(childSelector));
        if (!children.length) return false;
        wrapper = group.ownerDocument.createElementNS(rootSvgNamespace(group), 'g');
        wrapper.setAttribute(markerName, '1');
        wrapper.setAttribute('transform', `translate(${Number(tx.toFixed(6))} ${Number(ty.toFixed(6))})`);
        group.insertBefore(wrapper, children[0]);
        children.forEach(node => wrapper.appendChild(node));
      } else {
        wrapper.setAttribute('transform', `translate(${Number(tx.toFixed(6))} ${Number(ty.toFixed(6))})`);
      }
      return true;
    }

    function rootSvgNamespace(node) {
      return node?.ownerSVGElement?.namespaceURI || node?.namespaceURI || 'http://www.w3.org/2000/svg';
    }

    // Per-sheet SVGs contain only Sparrow's usable nesting area. Rebuild the
    // visible outer sheet and restore the margin removed by --strip-margin.
    function adjustSvgForSheet(svg, strip) {
      if (!svg) return svg;

      const parser = new DOMParser();
      // Sparrow's generated markup is browser-renderable but some multi-strip
      // files are rejected by Chromium's strict XML parser. Parse it through
      // the browser's SVG-aware HTML path so frame normalization is not skipped.
      const doc = parser.parseFromString(svg, 'text/html');
      const root = doc.querySelector('svg');
      if (!root) return svg;

      const viewBoxParts = (root.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
      const vb = {
        x: viewBoxParts[0] || 0,
        y: viewBoxParts[1] || 0,
        w: viewBoxParts[2] || 0,
        h: viewBoxParts[3] || 0,
      };
      if (!Number.isFinite(vb.w) || vb.w <= 0) return svg;

      const config = stripSheetConfig(strip);
      const configuredHeight = Number(config.height);
      const configuredWidth = Number(config.width);
      const sheetMargin = config.margin;
      const firstFramePath = root.querySelector('g[id^="container_"] path');
      const firstFrameRect = parseRectPathData(firstFramePath?.getAttribute('d'));
      const rawFrameWidth = firstFrameRect ? firstFrameRect.x1 - firstFrameRect.x0 : Number(strip?.strip_width);
      const rawFrameHeight = firstFrameRect ? firstFrameRect.y2 - firstFrameRect.y1 : vb.h;
      // Preview mirrors the DXF export's shift rule: with a non-zero sheet
      // margin, Sparrow usually returns placements relative to the usable-only
      // frame, and both the export and this preview add the margin back so the
      // parts render inside a visible border.
      //
      // During finalization Sparrow can hand back a usable-area frame while
      // its parts have already been translated into outer-sheet coordinates.
      // Applying our own margin shift on top moves the whole layout toward the
      // top-right for one visible frame. Raw <use> translations cannot detect
      // this reliably because item-local origins can sit far outside an
      // outline. Instead, measure the transformed outlines: pre-shifted parts
      // extend beyond the still-usable frame by approximately one margin.
      const isFixedSheet = config.widthMode === 'fixed'
        && Number.isFinite(configuredWidth) && configuredWidth > 0;
      let shouldShiftForMargin = sheetMargin > 0;
      if (shouldShiftForMargin) {
        const itemBounds = placedItemBounds(root);
        const frameMinX = firstFrameRect?.x0 || 0;
        const frameMinY = firstFrameRect?.y0 || 0;
        const frameMaxX = frameMinX + rawFrameWidth;
        const frameMaxY = frameMinY + rawFrameHeight;
        const overflowTolerance = 0.5;
        const startsInsideOuterMargin = itemBounds
          && itemBounds.minX >= frameMinX + sheetMargin - overflowTolerance
          && itemBounds.minY >= frameMinY + sheetMargin - overflowTolerance;
        const exceedsUsableFrame = itemBounds
          && (itemBounds.maxX > frameMaxX + overflowTolerance
            || itemBounds.maxY > frameMaxY + overflowTolerance);
        if (startsInsideOuterMargin && exceedsUsableFrame) {
          shouldShiftForMargin = false;
        }
      }
      const targetWidth = isFixedSheet
        ? configuredWidth
        : rawFrameWidth + (sheetMargin * 2);
      const targetHeight = Number.isFinite(configuredHeight) && configuredHeight > 0
        ? configuredHeight
        : rawFrameHeight;
      if (!Number.isFinite(targetWidth) || targetWidth <= 0 || !Number.isFinite(targetHeight) || targetHeight <= 0) {
        return svg;
      }
      const previewMinX = -SVG_PREVIEW_MARGIN_X;
      const previewMinY = -SVG_PREVIEW_MARGIN_Y;
      const previewWidth = targetWidth + (SVG_PREVIEW_MARGIN_X * 2);
      const previewHeight = targetHeight + (SVG_PREVIEW_MARGIN_Y * 2);

      root.setAttribute('viewBox', `${previewMinX} ${previewMinY} ${previewWidth} ${previewHeight}`);
      root.setAttribute('width', `${previewWidth}`);
      root.setAttribute('height', `${previewHeight}`);

      const frameOriginX = 0;
      const frameOriginY = 0;
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
        const nextFrameHeight = targetHeight;
        const nextFrameY = frameOriginY;
        framePath.setAttribute('d', formatRectPathData(frameOriginX, nextFrameY, targetWidth, targetHeight));
        normalizedAnyFrame = true;

        const title = group.querySelector('title');
        if (title) {
          title.textContent = title.textContent.replace(
            /bbox:\s*\[x_min:\s*[-\d.]+,\s*y_min:\s*[-\d.]+,\s*x_max:\s*[-\d.]+,\s*y_max:\s*[-\d.]+\]/i,
            `bbox: [x_min: ${frameOriginX.toFixed(3)}, y_min: ${nextFrameY.toFixed(3)}, x_max: ${(frameOriginX + targetWidth).toFixed(3)}, y_max: ${(nextFrameY + nextFrameHeight).toFixed(3)}]`
          );
        }
      });

      const dashedOutline = root.querySelector('#highlight_cd_shapes > path:last-of-type');
      if (dashedOutline) {
        const rect = parseRectPathData(dashedOutline.getAttribute('d'));
        if (rect) {
          const width = rect.x1 - rect.x0;
          const height = rect.y2 - rect.y1;
          if (Number.isFinite(width) && Number.isFinite(height) && normalizedAnyFrame) {
            dashedOutline.setAttribute('d', formatRectPathData(0, frameOriginY, targetWidth, targetHeight));
          }
        }
      }

      if (shouldShiftForMargin) {
        ensureTranslatedChildWrapper(root.querySelector('#items'), 'use', sheetMargin, sheetMargin, 'data-preview-sheet-margin');
        ensureTranslatedChildWrapper(root.querySelector('#highlight_cd_shapes'), 'use', sheetMargin, sheetMargin, 'data-preview-sheet-margin');
      }

      const serializer = new XMLSerializer();
      return serializer.serializeToString(root);
    }

    // Sparrow works in the same Y-up math convention as DXF (why the DXF export
    // path is correct without any Y-flip). When it renders layouts to SVG for
    // the live/final previews it dumps Y-up coordinates straight into the SVG
    // without a compensating transform — and SVG's default rendering is Y-down,
    // so every shape appears vertically flipped. That's what reads as "mirrored"
    // or "as if looking from behind" in the preview.
    //
    // We wrap all inner SVG markup in a <g> whose matrix reflects Y around the
    // viewBox horizontal midline. The matrix (1 0 0 -1 0 D) maps (x, y) →
    // (x, D - y); choosing D = 2*vbY + vbH lands the reflected content inside
    // the same viewBox.
    //
    // This is done as a pure string replacement (rather than DOMParser round-trip)
    // for two reasons: (1) so it survives whatever attribute-order or whitespace
    // changes downstream style regexes rely on, and (2) so it can't be defeated
    // by nested <defs>/namespace/namespace-URI edge cases in Chromium's parser.
    // The <!--pf--> HTML comment marker at the wrapper start makes the flip
    // idempotent — a second call on already-flipped output is a no-op.
    function flipSolverSvgVertically(svg) {
      if (!svg) return '';
      if (svg.includes('<!--pf-->')) return svg;

      const svgOpenMatch = svg.match(/<svg\b[^>]*>/i);
      if (!svgOpenMatch) return svg;

      const svgOpen = svgOpenMatch[0];
      const viewBoxMatch = svgOpen.match(/viewBox="([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)"/i);
      if (!viewBoxMatch) return svg;
      const vbY = Number(viewBoxMatch[2]);
      const vbH = Number(viewBoxMatch[4]);
      if (!Number.isFinite(vbY) || !Number.isFinite(vbH) || vbH <= 0) return svg;
      const flipTy = 2 * vbY + vbH;

      const svgOpenEnd = svgOpenMatch.index + svgOpen.length;
      const svgCloseIdx = svg.lastIndexOf('</svg>');
      if (svgCloseIdx < svgOpenEnd) return svg;

      const inner = svg.slice(svgOpenEnd, svgCloseIdx);
      const wrapper = `<!--pf--><g transform="matrix(1 0 0 -1 0 ${Number(flipTy.toFixed(6))})" data-preview-flip="1">${inner}</g>`;
      return svg.slice(0, svgOpenEnd) + wrapper + svg.slice(svgCloseIdx);
    }

    // Cheap stable signature for an SVG string used to detect "same content"
    // across polls. djb2 over ~32 byte-strided samples — enough collision
    // resistance for our usage (same-poll equality check, not security) and
    // O(1) regardless of SVG length.
    function quickSvgHash(text) {
      if (!text) return '0';
      const len = text.length;
      const step = Math.max(1, Math.floor(len / 32));
      let hash = 5381;
      for (let i = 0; i < len; i += step) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
      }
      return String(hash);
    }

    // Main SVG post-processor for the raw solver output.
    // Injects the preview grid, applies the active theme palette, strips solver
    // stat labels, and normalises the frame when the sheet is in fixed-width mode.
    function styleStripSVG(svg, strip = null) {
      if (!svg) return '';

      let styled = svg;
      // Solver debug overlays such as collision guides are useful for
      // diagnostics, but they clutter the end-user preview and can flash
      // prominently during live updates. Remove them from the in-app SVG only.
      styled = styled.replace(/<g\b[^>]*id="collision_lines"[^>]*>[\s\S]*?<\/g>/gi, '');
      if (strip) {
        styled = adjustSvgForSheet(styled, strip);
      }
      const viewBoxMatch = styled.match(/viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/i);
      const vb = viewBoxMatch
        ? { x: Number(viewBoxMatch[1]), y: Number(viewBoxMatch[2]), w: Number(viewBoxMatch[3]), h: Number(viewBoxMatch[4]) }
        : { x: 0, y: 0, w: 3000, h: 1250 };
      const colors = previewThemeColors();

      const bgMarkup = `
<defs>
<pattern id="nestGrid" width="40" height="40" patternUnits="userSpaceOnUse">
<path d="M40 0 L0 0 0 40" fill="none" stroke="${colors.gridStroke}" stroke-width="0.8"/>
</pattern>
<filter id="partGlow" x="-4%" y="-4%" width="108%" height="108%">
<feGaussianBlur stdDeviation="${vb.w * 0.0015}" result="blur"/>
<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
</defs>`;

      styled = styled.replace(/<svg([^>]*)>/i, `<svg$1>\n${bgMarkup}`);
      styled = styled.replace(
        /fill="#D3D3D3"\s+stroke="black"\s+stroke-width="([\d.]+)"/gi,
        (_, sw) => `fill="url(#nestGrid)" stroke="${colors.sheetStroke}" stroke-width="${sw}"`
      );
      styled = styled.replace(
        /fill="#7A7A7A"\s+fill-opacity="0\.5"\s+fill-rule="nonzero"\s+stroke="black"\s+stroke-width="([\d.]+)"/gi,
        (_, sw) => `fill="${colors.partFill}" fill-opacity="${colors.partFillOpacity}" fill-rule="nonzero" stroke="${colors.partStroke}" stroke-width="${(sw * 0.7).toFixed(4)}"${colors.partFilter}`
      );
      styled = styled.replace(
        /fill="none"\s+stroke="black"\s+stroke-dasharray="([^"]+)"\s+stroke-linecap="([^"]+)"\s+stroke-linejoin="([^"]+)"\s+stroke-opacity="0\.3"\s+stroke-width="([\d.]+)"/gi,
        (_, da, lc, lj, sw) => `fill="none" stroke="${colors.dashStroke}" stroke-dasharray="${da}" stroke-linecap="${lc}" stroke-linejoin="${lj}" stroke-opacity="${colors.dashOpacity}" stroke-width="${(sw * 0.6).toFixed(4)}"`
      );
      styled = styled.replace(/stroke="black"/gi, `stroke="${colors.sheetStroke}"`);
      styled = styled.replace(/<text[^>]*>[\s\S]*?h:[\s\S]*?<\/text>/gi, '');
      // Per-source coloring: each item_id maps to a source DXF; items sharing
      // a source share a color. This runs after the general color pass so any
      // item without a mapping falls back to the theme default set above.
      const itemColorMap = buildItemColorMap();
      if (itemColorMap && itemColorMap.size > 0) {
        styled = styled.replace(
          /<g id="item_(\d+)">\s*<path([^>]*)\/>/g,
          (match, idStr, attrs) => {
            const color = itemColorMap.get(Number(idStr));
            if (!color) return match;
            const newAttrs = attrs
              .replace(/fill="[^"]*"/, `fill="${color.fill}"`)
              .replace(/stroke="[^"]*"/, `stroke="${color.stroke}"`);
            return `<g id="item_${idStr}"><path${newAttrs}/>`;
          }
        );
      }
      // Apply the vertical flip last so it is guaranteed to survive every
      // preceding regex pass and cannot be defeated by any DOM round-trip.
      styled = flipSolverSvgVertically(styled);
      // Sheet dimension label. Rendered at SVG root (outside the flip wrapper)
      // so text sits upright. Positioned in the top-right corner above the
      // sheet, with a soft chip backdrop so a part touching the top edge
      // doesn't reduce legibility. Only shown when we have concrete
      // dimensions — `unlimited` mode has no width to state.
      styled = styled.replace(/<\/svg>\s*$/i, `${buildSheetDimensionLabel(colors)}</svg>`);
      return styled;
    }

    // Builds the SVG markup for the sheet dimension chip. Reads sheet
    // dimensions from the current config; returns an empty string when the
    // sheet has no fixed width (unlimited mode) so we don't emit "auto × H".
    function buildSheetDimensionLabel(colors) {
      const sheet = currentSheetConfig();
      const sheetW = Number(sheet?.width);
      const sheetH = Number(sheet?.height);
      if (!Number.isFinite(sheetW) || !Number.isFinite(sheetH) || sheetW <= 0 || sheetH <= 0) return '';
      if (sheet?.widthMode !== 'fixed' && sheet?.widthMode !== 'max') return '';

      const label = `${Math.round(sheetW)} × ${Math.round(sheetH)} mm`;
      const fontSize = SHEET_LABEL_FONT_SIZE;
      // Reasonable chip dimensions based on approximate glyph width (0.6em for
      // monospace) + horizontal padding.
      const chipPadX = fontSize * 0.6;
      const chipHeight = fontSize * 1.5;
      const chipWidth = fontSize * 0.6 * label.length + chipPadX * 2;
      // baseline offset so the text sits inside the chip
      const baselineY = -SHEET_LABEL_OFFSET_Y - (chipHeight - fontSize) / 2 - fontSize * 0.15;
      const chipY = -SHEET_LABEL_OFFSET_Y - chipHeight;
      const chipX = sheetW - chipWidth;

      return `<g class="pf-sheet-dim-label" pointer-events="none">
  <rect x="${chipX.toFixed(2)}" y="${chipY.toFixed(2)}" width="${chipWidth.toFixed(2)}" height="${chipHeight.toFixed(2)}" rx="${(chipHeight / 2).toFixed(2)}" fill="${colors.labelChipFill}" fill-opacity="${colors.labelChipOpacity}"/>
  <text x="${(sheetW - chipPadX).toFixed(2)}" y="${baselineY.toFixed(2)}" text-anchor="end" dominant-baseline="alphabetic" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${fontSize}" font-weight="500" fill="${colors.labelText}">${label}</text>
</g>`;
    }

    // Reconciles the sheet tab row with the current solver result.
    //
    // Key invariant: we DO NOT recreate tab buttons unless the strip count
    // actually changed. In barrier mode the poll handler may fire several
    // times per second with the same `strip_count`, and a naive
    // `innerHTML = ''` + rebuild would (a) destroy in-flight clicks, and
    // (b) snap the scroll position back to the active tab on every poll —
    // making manual navigation between sheets impossible.
    function renderTabs() {
      if (!state.nestResult?.strips?.length) {
        dom.canvasTabs.innerHTML = '';
        return;
      }

      const stripCount = state.nestResult.strips.length;
      const activeIndex = Math.min(state.activeStripIndex || 0, Math.max(0, stripCount - 1));
      state.activeStripIndex = activeIndex;

      // Walk the existing buttons in-place. Add missing tail buttons, remove
      // extras if compress collapsed sheets, update the active class. The
      // smooth scroll only fires on the very first render or when the strip
      // count grew — never on a same-count re-poll.
      const existing = Array.from(dom.canvasTabs.querySelectorAll('.canvas-tab'));
      const initialCount = existing.length;

      for (let i = initialCount; i < stripCount; i++) {
        const btn = document.createElement('button');
        btn.className = 'canvas-tab';
        btn.textContent = `Sheet ${i + 1}`;
        btn.addEventListener('click', () => {
          dom.canvasTabs.querySelectorAll('.canvas-tab').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          state.activeStripIndex = i;
          btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
          showNestResult(i);
          // Ruler is placed in sheet-mm coords, which don't map meaningfully
          // across different sheets — clear the current measurement so it
          // doesn't hover on top of parts it wasn't drawn against.
          window.measureToolApi?.resetMeasurement?.();
        });
        dom.canvasTabs.appendChild(btn);
        existing.push(btn);
      }
      while (existing.length > stripCount) {
        const btn = existing.pop();
        btn.remove();
      }

      existing.forEach((btn, i) => {
        btn.classList.toggle('active', i === activeIndex);
      });

      const countGrew = stripCount > initialCount;
      if (countGrew) {
        requestAnimationFrame(() => {
          existing[activeIndex]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        });
      }
    }

    // Generates a fake placement SVG from the currently loaded files and sheet config.
    // Used only before a real nesting result exists; once Sparrow has started
    // returning strips we must never swap this in for a sheet whose SVG is still
    // being written, otherwise the user sees a brief fake "placeholder placement"
    // before the real preview arrives.
    function generateMockNestSVG(sheetIndex) {
      const sheet = state.sheets[sheetIndex];
      if (!sheet) return null;
      const colors = previewThemeColors();

      const previewWidth = sheet.widthMode === 'unlimited' ? 3000 : (sheet.width || 3000);
      const W = 800;
      const H = Math.round(800 * sheet.height / previewWidth);
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

          shape.id = fi;
          if (tryPlace(shape, 80)) { placed.push(shape); shapes.push(shape); }
        }
      });

      const defs = `
        <defs>
          <pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M 16 0 L 0 0 0 16" fill="none" stroke="${colors.gridStroke}" stroke-width="0.5"/>
          </pattern>
          <filter id="partGlow" x="-6%" y="-6%" width="112%" height="112%">
            <feGaussianBlur stdDeviation="1.5" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>`;

      const shapesSVG = shapes.map(s => {
        const { x, y, w, h, type } = s;
        const fill = colors.partFill;
        const stroke = colors.partStroke;
        const strokeOpacity = '0.75';
        let path = '';

        if (type === 'rect') {
          path = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2"${colors.partFilter}/>`;
        } else if (type === 'L') {
          const hw = (w * 0.45).toFixed(1), hh = (h * 0.45).toFixed(1);
          path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${hh} h${-hw} v${(h - parseFloat(hh)).toFixed(1)} h${-(w - parseFloat(hw)).toFixed(1)} Z" fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2"${colors.partFilter}/>`;
        } else if (type === 'notch') {
          const nw = (w * 0.25).toFixed(1), nh = (h * 0.35).toFixed(1);
          const nx = (x + w / 2 - parseFloat(nw) / 2).toFixed(1);
          path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${h.toFixed(1)} h${-w.toFixed(1)} Z M${nx},${y.toFixed(1)} h${nw} v${nh} h${-nw} Z" fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2" fill-rule="evenodd"${colors.partFilter}/>`;
        } else {
          const tw = (w * 0.4).toFixed(1);
          const stemH = (h * 0.55).toFixed(1);
          path = `<path d="M${x.toFixed(1)},${y.toFixed(1)} h${w.toFixed(1)} v${(h - parseFloat(stemH)).toFixed(1)} h${-(w / 2 - parseFloat(tw) / 2).toFixed(1)} v${stemH} h${-parseFloat(tw).toFixed(1)} v${-stemH} h${-(w / 2 - parseFloat(tw) / 2).toFixed(1)} Z" fill="${fill}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2"${colors.partFilter}/>`;
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
          <rect width="${W}" height="${H}" fill="${colors.background}"/>
          <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="3" fill="none" stroke="${colors.sheetStroke}" stroke-width="1" stroke-dasharray="6 4"/>
          ${shapesSVG}
          <text x="${W / 2}" y="${H - 8}" text-anchor="middle" font-size="9" fill="${colors.metaText}" font-family="monospace">
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
    //
    // Skips the heavy DOM swap when (a) the same sheet is already displayed
    // and (b) its SVG content hasn't changed. Without this guard, polling
    // re-runs `innerHTML = ...` + `applyZoom(true)` several times per second
    // during barrier-mode optimization, which re-centers the viewport and
    // makes pan/zoom feel jittery.
    function showNestResult(sheetIndex) {
      const strip = state.nestResult?.strips?.[sheetIndex] || null;
      if (strip?.svg) {
        const sheet = currentSheetConfig();
        state.activeStripIndex = sheetIndex;
        const styled = styleStripSVG(strip.svg, strip);
        const previousIndex = dom.svgContainer.dataset.activeIndex;
        const sameStrip = previousIndex === String(sheetIndex);
        const sourcePath = String(strip.svg_path || '');
        const sourcePreviewState = String(!!(strip.is_preview || state.nestResult.is_preview));
        const sameSvg = sameStrip && dom.svgContainer.dataset.svgLen === String(styled.length)
          && dom.svgContainer.dataset.svgHash === quickSvgHash(styled);
        const sameSource = sameStrip
          && dom.svgContainer.dataset.svgSource === sourcePath
          && dom.svgContainer.dataset.svgPreview === sourcePreviewState;
        if (!(sameSvg && sameSource)) {
          dom.svgContainer.innerHTML = styled;
          dom.svgContainer.dataset.activeIndex = String(sheetIndex);
          dom.svgContainer.dataset.svgLen = String(styled.length);
          dom.svgContainer.dataset.svgHash = quickSvgHash(styled);
          dom.svgContainer.dataset.svgSource = sourcePath;
          dom.svgContainer.dataset.svgPreview = sourcePreviewState;
        }
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
        // Only re-center the viewport when the SVG actually got swapped — a
        // no-op call to `applyZoom(true)` still resets scrollLeft/scrollTop,
        // which is exactly what we want to avoid on same-sheet re-polls.
        if (!sameSvg) applyZoom(true);
        return;
      }

      if (strip) {
        state.activeStripIndex = sheetIndex;
        const totalSheets = state.nestResult?.strips?.length || state.nestResult?.strip_count || 0;
        const waitingPrefix = strip.is_preview || state.nestResult?.is_preview ? 'Preview · ' : '';
        setNestStatsTone('');
        dom.nestStats.textContent = `${waitingPrefix}Sheet ${sheetIndex + 1} of ${totalSheets} · Waiting for geometry`;
        return;
      }

      const result = generateMockNestSVG(sheetIndex);
      if (!result) return;
      dom.svgContainer.innerHTML = result.svg;
      dom.svgContainer.dataset.activeIndex = String(sheetIndex);
      dom.svgContainer.dataset.svgLen = String(result.svg.length);
      dom.svgContainer.dataset.svgHash = quickSvgHash(result.svg);
      dom.svgContainer.dataset.svgSource = 'mock-preview';
      dom.svgContainer.dataset.svgPreview = 'false';
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

    function clampZoom(value) {
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    }

    function setZoom(nextZoom, { recenter = false, anchorEvent = null } = {}) {
      const svg = dom.svgContainer.querySelector('svg');
      const beforeRect = anchorEvent && svg ? svg.getBoundingClientRect() : null;
      const anchorX = beforeRect?.width
        ? (anchorEvent.clientX - beforeRect.left) / beforeRect.width
        : null;
      const anchorY = beforeRect?.height
        ? (anchorEvent.clientY - beforeRect.top) / beforeRect.height
        : null;

      state.zoom = clampZoom(nextZoom);
      applyZoom(recenter);

      if (!beforeRect || anchorX === null || anchorY === null || !dom.viewport) return;
      const afterRect = svg.getBoundingClientRect();
      dom.viewport.scrollLeft += afterRect.left + (anchorX * afterRect.width) - anchorEvent.clientX;
      dom.viewport.scrollTop += afterRect.top + (anchorY * afterRect.height) - anchorEvent.clientY;
    }

    function zoomIn() {
      setZoom(state.zoom + ZOOM_STEP);
    }

    function zoomOut() {
      setZoom(state.zoom - ZOOM_STEP);
    }

    function fitView() {
      setZoom(1, { recenter: true });
    }

    function handleViewportWheel(event) {
      const isPinchZoom = event.ctrlKey || event.metaKey;
      const isDiscreteWheel = event.deltaMode !== 0
        || (Math.abs(event.deltaY) >= 40 && Math.abs(event.deltaX) < 2);
      if (!isPinchZoom && !isDiscreteWheel) return;

      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      setZoom(state.zoom + (direction * ZOOM_STEP), { anchorEvent: event });
    }

    // Wires up all canvas interaction: zoom-in/out/fit buttons update state.zoom and call
    // applyZoom, while mousedown/mousemove/mouseup on the viewport implement click-drag panning.
    // Also re-applies zoom on window resize so the fit scale stays accurate.
    function bind() {
      dom.zoomIn.addEventListener('click', zoomIn);
      dom.zoomOut.addEventListener('click', zoomOut);
      dom.fitView.addEventListener('click', fitView);
      dom.viewport?.addEventListener('wheel', handleViewportWheel, { passive: false });

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
      zoomIn,
      zoomOut,
      fitView,
      bind,
    };
  }

  globalScope.NestCanvasView = { createCanvasView };
})(window);
