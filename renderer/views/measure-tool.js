'use strict';

// Measure tool for the nesting canvas. Ships two behaviors in one module:
//
//   • Tier A — an ambient coordinate readout chip in the bottom-left of the
//     canvas viewport. Always active whenever the cursor is over a rendered
//     nesting result. Coordinates are reported in millimetres from the sheet's
//     bottom-left corner (DXF convention, matches the export values 1:1).
//
//   • Tier B — click-to-measure. Toggled on by the ruler button in the canvas
//     toolbar, by the View → Measure menu item, or via the "×" on the mode
//     chip. First click anchors, cursor rubber-bands, second click commits.
//     Shift while rubber-banding snaps to the nearest axis. Esc exits.
//
// Coordinate transforms account for the vertical flip that
// `flipSolverSvgVertically` applies to Sparrow's SVG so what the user sees on
// screen maps 1:1 to sheet-space mm.

(function defineMeasureTool(globalScope) {
  function createMeasureTool({ state, dom }) {
    const t = globalScope.NestI18n.t;
    const { resolveMeasurementSystem, unitLabel, formatLength } = globalScope.NestUnits;
    let coordChipEl = null;
    let modeChipEl = null;
    let overlaySvgEl = null;
    let rulerBtn = null;

    let measureMode = false;
    // Anchor / cursor stored as sheet coords (source of truth). Screen coords
    // are re-derived on every redraw so pan / zoom / scroll never desync the
    // visible line from the geometry it's measuring.
    let anchorSheet = null;
    let cursorSheet = null;
    let committed = false;
    let shiftDown = false;
    // Ambient coord chip visibility. Backed by the showCursorCoords setting;
    // togglable from View → Live Coordinates.
    let showCursorCoords = true;

    function measurementSystem() {
      return resolveMeasurementSystem(state.settings?.measurementSystem);
    }

    function formatMeasuredLength(mm, includeUnit = true) {
      return formatLength(mm, {
        system: measurementSystem(),
        metricPrecision: 1,
        imperialPrecision: 3,
        includeUnit,
      });
    }

    // ── snap state ───────────────────────────────────────────────────────
    // Snap targets are cached because computing them touches the DOM
    // (getBoundingClientRect on every <use> element). The cache is
    // invalidated whenever the underlying SVG changes size — driven by
    // the ResizeObserver installed in init().
    const SNAP_RADIUS_PX = 10;
    let snapTargetsCache = null;
    let hoverSnap = null;      // the snap target under the cursor right now (or null)
    let anchorSnapped = false; // did the current anchor land on a snap target?
    let endpointSnapped = false; // did the second click land on a snap target?

    function activeSheet() {
      return state.sheets && state.sheets[0];
    }

    function activeSvgEl() {
      return dom.svgContainer ? dom.svgContainer.querySelector('svg') : null;
    }

    // ── coordinate transforms ────────────────────────────────────────────

    // Screen (client) coordinates → sheet-space mm with Y-up origin at the
    // sheet's bottom-left. Returns null if we can't project (no SVG rendered
    // yet, no sheet configured, etc.).
    function screenToSheet(clientX, clientY) {
      const svg = activeSvgEl();
      if (!svg || typeof svg.getScreenCTM !== 'function') return null;
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const inverse = ctm.inverse();
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const svgPt = pt.matrixTransform(inverse);
      const sheet = activeSheet();
      const sheetHeight = Number(sheet?.height) || 0;
      return {
        x: svgPt.x,
        // svg viewBox Y is down-positive after adjustSvgForSheet lands the
        // sheet at (0,0)..(w,h). Reverse to get Y-up mm from bottom-left.
        y: sheetHeight - svgPt.y,
      };
    }

    // Sheet-space mm → overlay-local pixel coordinates. Referenced against
    // the OVERLAY's own bounding rect (not the viewport's) because the
    // overlay's rendered top-left is what the SVG viewBox pins to — any
    // horizontal gap between the viewport's border-edge and the overlay's
    // padding-edge (scrollbar-gutter reserves one on some platforms, and
    // scroll compensation applies a transform to the overlay) would cause
    // marks to drift off the cursor by that gap. The symptom is subtle:
    // horizontal-edge snap looks fine because the foot moves along the
    // edge anyway, but vertical-edge snap visibly slides sideways off the
    // edge by the exact gap width.
    function sheetToViewportPx(sheetPt) {
      const svg = activeSvgEl();
      if (!svg || !sheetPt || typeof svg.getScreenCTM !== 'function') return null;
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const sheet = activeSheet();
      const sheetHeight = Number(sheet?.height) || 0;
      const pt = svg.createSVGPoint();
      pt.x = sheetPt.x;
      pt.y = sheetHeight - sheetPt.y;
      const screenPt = pt.matrixTransform(ctm);
      const originRect = (overlaySvgEl || dom.viewport).getBoundingClientRect();
      return {
        x: screenPt.x - originRect.left,
        y: screenPt.y - originRect.top,
      };
    }

    // ── snap targets ─────────────────────────────────────────────────────

    // Extracts vertices AND edges from an SVG path `d` string. Vertices are
    // segment endpoints (the sharp corners a user snaps to); edges are the
    // straight segments between consecutive vertices within a subpath (used
    // for edge-snap so the cursor can lock onto the closest point along a
    // side, not just its corners). Handles M/L/H/V/C/S/Q/T/A/Z (abs + rel);
    // curves are approximated as their chord (endpoint-to-endpoint straight
    // line) for edge-snap purposes — Sparrow's output is polygonal anyway.
    // After an M, additional coordinate pairs behave as implicit L per
    // SVG spec §8.3.2, so those still form edges.
    function parsePathVertices(d) {
      const vertices = [];
      const edges = [];
      if (!d) return { vertices, edges };
      const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g);
      if (!tokens) return { vertices, edges };
      let cmd = null;
      let x = 0, y = 0;
      let startX = 0, startY = 0;
      let subStart = null;
      let prev = null;
      let i = 0;
      const num = () => Number(tokens[i++]);
      const emit = () => {
        const cur = { x, y };
        vertices.push(cur);
        if (prev) edges.push([prev, cur]);
        prev = cur;
      };
      while (i < tokens.length) {
        const t = tokens[i];
        if (/^[a-zA-Z]$/.test(t)) {
          cmd = t; i++;
          if (cmd === 'M' || cmd === 'm') {
            const nx = cmd === 'M' ? num() : x + num();
            const ny = cmd === 'M' ? num() : y + num();
            x = nx; y = ny; startX = x; startY = y;
            const cur = { x, y };
            vertices.push(cur);
            subStart = cur;
            prev = cur;
            // Implicit L (or l) for subsequent coord pairs on this command
            // — so a `M x,y x2,y2 x3,y3` polyline produces edges.
            cmd = cmd === 'M' ? 'L' : 'l';
          } else if (cmd === 'Z' || cmd === 'z') {
            if (subStart && prev && (prev.x !== subStart.x || prev.y !== subStart.y)) {
              edges.push([prev, subStart]);
            }
            x = startX; y = startY;
            prev = subStart;
          }
          continue;
        }
        const rel = cmd === cmd.toLowerCase();
        if (cmd === 'L' || cmd === 'l' || cmd === 'T' || cmd === 't') {
          x = rel ? x + num() : num();
          y = rel ? y + num() : num();
          emit();
        } else if (cmd === 'H' || cmd === 'h') {
          x = rel ? x + num() : num();
          emit();
        } else if (cmd === 'V' || cmd === 'v') {
          y = rel ? y + num() : num();
          emit();
        } else if (cmd === 'C' || cmd === 'c') {
          num(); num(); num(); num();
          x = rel ? x + num() : num();
          y = rel ? y + num() : num();
          emit();
        } else if (cmd === 'S' || cmd === 's' || cmd === 'Q' || cmd === 'q') {
          num(); num();
          x = rel ? x + num() : num();
          y = rel ? y + num() : num();
          emit();
        } else if (cmd === 'A' || cmd === 'a') {
          num(); num(); num(); num(); num();
          x = rel ? x + num() : num();
          y = rel ? y + num() : num();
          emit();
        } else {
          i++;
        }
      }
      return { vertices, edges };
    }

    // Parses Sparrow's `<use>` transform: "translate(tx ty), rotate(θ_deg)".
    // Returns a lightweight applier — apply rotate first, then translate,
    // matching SVG's right-to-left transform composition semantics.
    function parseUseTransform(transformStr) {
      let tx = 0, ty = 0, cos = 1, sin = 0;
      if (transformStr) {
        const tr = transformStr.match(/translate\(\s*([-\d.eE]+)[\s,]+([-\d.eE]+)\s*\)/);
        if (tr) { tx = Number(tr[1]); ty = Number(tr[2]); }
        const rt = transformStr.match(/rotate\(\s*([-\d.eE]+)\s*\)/);
        if (rt) {
          const rad = Number(rt[1]) * Math.PI / 180;
          cos = Math.cos(rad); sin = Math.sin(rad);
        }
      }
      return { tx, ty, cos, sin };
    }

    // Robust href lookup for <use> — Sparrow emits plain `href`, but SVG1
    // markup can also carry `xlink:href`; the SVGAnimatedString API is the
    // safest fallback because it doesn't depend on attribute-name namespacing.
    function useHrefId(useEl) {
      const raw = useEl.getAttribute('href')
        || useEl.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        || useEl.getAttribute('xlink:href')
        || (useEl.href && useEl.href.baseVal)
        || '';
      return String(raw).replace(/^#/, '');
    }

    // Enumerates snap targets in sheet-coord space. Returns two parallel
    // lists so findSnap can prefer vertex-snap (sharp corners) and fall
    // back to edge-snap (foot of perpendicular on a segment):
    //   vertices — 4 sheet corners + every path-segment endpoint of every
    //              placed part
    //   edges    — 4 sheet edges + every straight segment between adjacent
    //              vertices within a part subpath (curves reduced to chords)
    // Sparrow's coordinate space equals sheet-mm 1:1 (its <use> transforms
    // are what its own solver reports), so applying the <use> transform to
    // each defs-side vertex yields the sheet-space snap point directly —
    // no getScreenCTM round-trip, no dependence on the visual flip.
    // Cached until the SVG resizes (see ResizeObserver in init()).
    function getSnapTargets() {
      if (snapTargetsCache) return snapTargetsCache;
      const vertices = [];
      const edges = [];
      const sheet = activeSheet();
      const w = Number(sheet?.width) || 0;
      const h = Number(sheet?.height) || 0;
      if (w > 0 && h > 0) {
        const c00 = { x: 0, y: 0 };
        const cW0 = { x: w, y: 0 };
        const cWH = { x: w, y: h };
        const c0H = { x: 0, y: h };
        vertices.push(c00, cW0, cWH, c0H);
        edges.push([c00, cW0], [cW0, cWH], [cWH, c0H], [c0H, c00]);
      }
      const svg = activeSvgEl();
      if (!svg) {
        snapTargetsCache = { vertices, edges };
        return snapTargetsCache;
      }

      // Parse each unique defs entry once — many <use>s typically share the
      // same #item_N reference, so caching pays off on any real layout.
      const parsedById = new Map();
      // Use a descendant selector (not direct-child): canvas-view wraps
      // Sparrow's <use> children in an intermediary <g translate(margin
      // margin)> when the preview needs to add the sheet margin band. Direct
      // child selectors miss the parts entirely in that case.
      const itemsGroup = svg.querySelector('#items');
      const uses = itemsGroup ? itemsGroup.querySelectorAll('use') : [];
      uses.forEach(useEl => {
        const id = useHrefId(useEl);
        if (!id) return;
        let parsed = parsedById.get(id);
        if (!parsed) {
          // getElementById is fine on SVG in browsers, but querySelector
          // with a CSS-escaped id works reliably even inside shadow-tree
          // edge cases; fall back to it if getElementById misses.
          let def = svg.getElementById(id);
          if (!def) {
            try { def = svg.querySelector('#' + (window.CSS?.escape ? CSS.escape(id) : id)); }
            catch { def = null; }
          }
          parsed = { vertices: [], edges: [] };
          if (def) {
            def.querySelectorAll('path').forEach(p => {
              const r = parsePathVertices(p.getAttribute('d') || '');
              r.vertices.forEach(v => parsed.vertices.push(v));
              r.edges.forEach(e => parsed.edges.push(e));
            });
          }
          parsedById.set(id, parsed);
        }
        if (!parsed.vertices.length) return;
        // Compose EVERY transform from the <use> up to (but not including)
        // #items itself — that covers the use's own translate+rotate and
        // any intermediary wrapper <g>s the preview pipeline inserts (e.g.
        // the sheet-margin translate). Applied innermost-first so a point
        // walks from local coords through each stage into sheet-mm space.
        const chain = [];
        for (let node = useEl; node && node !== itemsGroup; node = node.parentNode) {
          const tr = node.getAttribute?.('transform');
          if (tr) chain.push(parseUseTransform(tr));
        }
        const apply = (v) => {
          let x = v.x, y = v.y;
          for (const t of chain) {
            const rx = x * t.cos - y * t.sin;
            const ry = x * t.sin + y * t.cos;
            x = rx + t.tx;
            y = ry + t.ty;
          }
          return { x, y };
        };
        parsed.vertices.forEach(v => vertices.push(apply(v)));
        parsed.edges.forEach(([a, b]) => edges.push([apply(a), apply(b)]));
      });
      snapTargetsCache = { vertices, edges };
      return snapTargetsCache;
    }

    // Returns the snap target closest to the cursor within SNAP_RADIUS_PX,
    // or null if none is close enough. Distance is computed in viewport-local
    // screen pixels so the radius stays visually constant across zoom levels.
    // Vertex snap wins over edge snap when both are in range — CAD users
    // expect corners to "grab" more strongly than the middle of an edge.
    function findSnap(clientX, clientY) {
      if (!dom.viewport) return null;
      const { vertices, edges } = getSnapTargets();
      if (!vertices.length && !edges.length) return null;
      // Use the overlay's own origin, same as sheetToViewportPx — so the
      // distance calc happens in the same pixel space that marks are drawn in.
      const originRect = (overlaySvgEl || dom.viewport).getBoundingClientRect();
      const cx = clientX - originRect.left;
      const cy = clientY - originRect.top;

      let bestVertex = null;
      let bestVertexDist = SNAP_RADIUS_PX;
      for (const v of vertices) {
        const px = sheetToViewportPx(v);
        if (!px) continue;
        const d = Math.hypot(px.x - cx, px.y - cy);
        if (d < bestVertexDist) { bestVertex = v; bestVertexDist = d; }
      }
      if (bestVertex) return bestVertex;

      let bestEdge = null;
      let bestEdgeDist = SNAP_RADIUS_PX;
      for (const [a, b] of edges) {
        const pa = sheetToViewportPx(a);
        const pb = sheetToViewportPx(b);
        if (!pa || !pb) continue;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1) continue;
        // t = fraction along the segment where the cursor's perpendicular
        // foot lands, clamped to [0,1] so we stay on the segment.
        const t = Math.max(0, Math.min(1, ((cx - pa.x) * dx + (cy - pa.y) * dy) / len2));
        const fx = pa.x + t * dx;
        const fy = pa.y + t * dy;
        const d = Math.hypot(fx - cx, fy - cy);
        if (d < bestEdgeDist) {
          // Lerp in sheet space so the returned snap point matches the
          // screen-space foot after the round-trip through sheetToViewportPx.
          bestEdge = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
          bestEdgeDist = d;
        }
      }
      return bestEdge;
    }

    function invalidateSnapCache() { snapTargetsCache = null; }

    function cursorInsideSheet(sheetPt) {
      if (!sheetPt) return false;
      const sheet = activeSheet();
      const w = Number(sheet?.width) || 0;
      const h = Number(sheet?.height) || 0;
      if (w <= 0 || h <= 0) return false;
      return sheetPt.x >= 0 && sheetPt.x <= w && sheetPt.y >= 0 && sheetPt.y <= h;
    }

    // ── DOM: chips, button, overlay ──────────────────────────────────────

    function ensureCoordChip() {
      if (coordChipEl || !dom.viewport) return;
      coordChipEl = document.createElement('div');
      coordChipEl.className = 'measure-coord-chip';
      coordChipEl.hidden = true;
      dom.viewport.appendChild(coordChipEl);
    }

    function ensureModeChip() {
      if (modeChipEl || !dom.viewport) return;
      modeChipEl = document.createElement('div');
      modeChipEl.className = 'measure-mode-chip';
      modeChipEl.hidden = true;
      modeChipEl.innerHTML = `
        <span class="measure-mode-label">${t('measure.label')}</span>
        <button class="measure-mode-close" type="button" aria-label="${t('measure.exitMode')}" title="${t('measure.exit')}">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        </button>`;
      modeChipEl.querySelector('.measure-mode-close')
        .addEventListener('click', (e) => { e.stopPropagation(); setMeasureMode(false); });
      dom.viewport.appendChild(modeChipEl);
    }

    function ensureOverlay() {
      if (overlaySvgEl || !dom.viewport) return;
      const NS = 'http://www.w3.org/2000/svg';
      overlaySvgEl = document.createElementNS(NS, 'svg');
      overlaySvgEl.setAttribute('class', 'measure-overlay');
      // pixel-space viewBox — width/height updated on redraw
      overlaySvgEl.setAttribute('preserveAspectRatio', 'none');
      overlaySvgEl.style.pointerEvents = 'none';
      dom.viewport.appendChild(overlaySvgEl);
    }

    function ensureRulerButton() {
      if (rulerBtn || !dom.canvasZoom) return;
      // Visual break between the zoom group (which manipulates the viewport)
      // and the measure toggle (a mode-switching interaction). Inserted
      // alongside the button so both appear or disappear together — no stale
      // divider if the measure module never loads.
      const sep = document.createElement('span');
      sep.className = 'toolbar-sep';
      sep.setAttribute('aria-hidden', 'true');
      dom.canvasZoom.appendChild(sep);

      rulerBtn = document.createElement('button');
      rulerBtn.className = 'icon-btn-sm measure-btn';
      rulerBtn.type = 'button';
      rulerBtn.title = t('measure.label');
      rulerBtn.setAttribute('aria-label', t('measure.toggle'));
      rulerBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M1.5 8.5 L8.5 1.5 L12.5 5.5 L5.5 12.5 Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/>
          <path d="M4 7 l1 1 M6 5 l1.5 1.5 M8 3 l1 1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>`;
      rulerBtn.addEventListener('click', () => setMeasureMode(!measureMode));
      dom.canvasZoom.appendChild(rulerBtn);
      dom.measureBtn = rulerBtn;
    }

    // ── measure mode toggle ──────────────────────────────────────────────

    function setMeasureMode(next) {
      const target = !!next;
      if (measureMode === target) return;
      measureMode = target;
      anchorSheet = null;
      cursorSheet = null;
      committed = false;
      hoverSnap = null;
      anchorSnapped = false;
      endpointSnapped = false;
      if (dom.viewport) dom.viewport.classList.toggle('measure-active', measureMode);
      if (rulerBtn) rulerBtn.classList.toggle('active', measureMode);
      if (modeChipEl) modeChipEl.hidden = !measureMode;
      if (measureMode) invalidateSnapCache();
      redrawOverlay();
    }

    // ── rendering the overlay ────────────────────────────────────────────

    // Live snap indicator drawn while the cursor is hovering a snappable
    // point. A hollow ring in a distinct accent-green — reads as "locked
    // to this point" without obscuring the underlying geometry. The subtle
    // inner dot marks the exact snap coordinate so users can eyeball
    // precision on tight parts.
    function snapIndicatorMarkup(sheetPt) {
      const px = sheetToViewportPx(sheetPt);
      if (!px) return '';
      return `<g pointer-events="none">
        <circle cx="${px.x}" cy="${px.y}" r="6"
                fill="none" stroke="#22c55e" stroke-width="1.6"/>
        <circle cx="${px.x}" cy="${px.y}" r="1.4"
                fill="#22c55e"/>
      </g>`;
    }

    // Overlay and chips live INSIDE the viewport (a scroll container), so
    // they naturally scroll with the SVG content. That desyncs them from the
    // visible viewport frame where all our screen-space math anchors — marks
    // drift off cursor position by the scroll offset. Countering with an
    // inverse CSS transform pins them back to the visible frame so a click
    // at cursor (X, Y) lands at exactly (X, Y) on screen.
    function pinToVisibleFrame() {
      if (!dom.viewport) return;
      const dx = dom.viewport.scrollLeft;
      const dy = dom.viewport.scrollTop;
      const transform = (dx || dy) ? `translate(${dx}px, ${dy}px)` : '';
      if (overlaySvgEl) overlaySvgEl.style.transform = transform;
      if (modeChipEl) modeChipEl.style.transform = transform;
      if (coordChipEl) coordChipEl.style.transform = transform;
    }

    function chooseMeasurementLabelPosition({
      anchorPx,
      endpointPx,
      chipWidth,
      chipHeight,
      viewportWidth,
      viewportHeight,
    }) {
      const midX = (anchorPx.x + endpointPx.x) / 2;
      const midY = (anchorPx.y + endpointPx.y) / 2;
      const lineDx = endpointPx.x - anchorPx.x;
      const lineDy = endpointPx.y - anchorPx.y;
      const lineLen = Math.hypot(lineDx, lineDy);
      const unitX = lineLen > 0.1 ? lineDx / lineLen : 1;
      const unitY = lineLen > 0.1 ? lineDy / lineLen : 0;
      let perpX = -unitY;
      let perpY = unitX;
      if (perpY > 0) { perpX = -perpX; perpY = -perpY; }

      const halfWidth = chipWidth / 2;
      const halfHeight = chipHeight / 2;
      const edgePadding = 8;
      const endpointClearance = 9;
      const inflatedHalfWidth = halfWidth + endpointClearance;
      const inflatedHalfHeight = halfHeight + endpointClearance;
      const endpoints = [anchorPx, endpointPx];

      const fitsViewport = ({ x, y }) => (
        x - halfWidth >= edgePadding
        && x + halfWidth <= viewportWidth - edgePadding
        && y - halfHeight >= edgePadding
        && y + halfHeight <= viewportHeight - edgePadding
      );
      const clearsEndpoints = ({ x, y }) => endpoints.every(point => (
        Math.abs(point.x - x) > inflatedHalfWidth
        || Math.abs(point.y - y) > inflatedHalfHeight
      ));

      const candidates = [];
      // Prefer a compact perpendicular offset, increasing it only until both
      // endpoint handles are clear. Try the opposite side near canvas edges.
      for (const side of [1, -1]) {
        for (let offset = 18; offset <= 90; offset += 6) {
          candidates.push({
            x: midX + perpX * offset * side,
            y: midY + perpY * offset * side,
          });
        }
      }
      // Very narrow diagonal measurements can occupy the bubble's full width
      // on both perpendicular sides. Outside-end candidates are the fallback.
      const outsideOffset = lineLen / 2 + halfWidth + endpointClearance + 5;
      candidates.push(
        { x: midX + unitX * outsideOffset, y: midY + unitY * outsideOffset },
        { x: midX - unitX * outsideOffset, y: midY - unitY * outsideOffset },
      );

      let center = candidates.find(candidate => (
        fitsViewport(candidate) && clearsEndpoints(candidate)
      ));
      if (!center) {
        // On extremely small viewports, keep the label visible and maximize
        // endpoint clearance even if no candidate satisfies every constraint.
        center = candidates
          .map(candidate => ({
            x: Math.max(
              edgePadding + halfWidth,
              Math.min(viewportWidth - edgePadding - halfWidth, candidate.x),
            ),
            y: Math.max(
              edgePadding + halfHeight,
              Math.min(viewportHeight - edgePadding - halfHeight, candidate.y),
            ),
          }))
          .sort((a, b) => {
            const clearance = point => Math.min(...endpoints.map(endpoint => (
              Math.hypot(point.x - endpoint.x, point.y - endpoint.y)
            )));
            return clearance(b) - clearance(a);
          })[0] || { x: midX, y: midY - 30 };
      }

      const toMidX = midX - center.x;
      const toMidY = midY - center.y;
      const boundaryScale = Math.min(
        Math.abs(toMidX) > 0.01 ? halfWidth / Math.abs(toMidX) : Infinity,
        Math.abs(toMidY) > 0.01 ? halfHeight / Math.abs(toMidY) : Infinity,
      );
      const leaderEnd = Number.isFinite(boundaryScale)
        ? {
          x: center.x + toMidX * boundaryScale,
          y: center.y + toMidY * boundaryScale,
        }
        : { x: center.x, y: center.y + halfHeight };

      return {
        center,
        leaderStart: { x: midX, y: midY },
        leaderEnd,
      };
    }

    function redrawOverlay() {
      if (!overlaySvgEl || !dom.viewport) return;
      pinToVisibleFrame();
      // Size viewBox to the OVERLAY's actual rendered dimensions, not the
      // viewport's. Two reasons: (1) `width/height: 100%` in CSS renders
      // against the padding-box, which can be smaller than the border-box
      // this rect measures (e.g. scrollbar-gutter reserves horizontal space);
      // (2) `preserveAspectRatio="none"` then stretches the viewBox to fit
      // the smaller rendered box, so viewBox units and pixels are no longer
      // 1:1 — visible on right-side snaps as a small horizontal drift that
      // scales with distance from the origin. Matching them keeps 1 unit
      // = 1 pixel so screenPt - overlayRect.left maps directly to draw coord.
      const overlayRect = overlaySvgEl.getBoundingClientRect();
      overlaySvgEl.setAttribute('viewBox', `0 0 ${overlayRect.width} ${overlayRect.height}`);
      overlaySvgEl.setAttribute('width', String(overlayRect.width));
      overlaySvgEl.setAttribute('height', String(overlayRect.height));

      if (!measureMode) {
        overlaySvgEl.innerHTML = '';
        return;
      }

      // No anchor yet — just show the snap indicator while the user hovers,
      // so they can see when a click will lock to a corner.
      if (!anchorSheet) {
        overlaySvgEl.innerHTML = hoverSnap ? snapIndicatorMarkup(hoverSnap) : '';
        return;
      }

      const anchorPx = sheetToViewportPx(anchorSheet);
      if (!anchorPx) { overlaySvgEl.innerHTML = ''; return; }

      const endpointSheet = orthoAdjusted(anchorSheet, cursorSheet || anchorSheet);
      const endpointPx = sheetToViewportPx(endpointSheet) || anchorPx;

      const dx = endpointSheet.x - anchorSheet.x;
      const dy = endpointSheet.y - anchorSheet.y;
      const distance = Math.hypot(dx, dy);
      const label = formatMeasuredLength(distance);

      const isOrtho = shiftDown && anchorSheet && cursorSheet;
      const lineDash = committed ? '' : 'stroke-dasharray="4 3"';
      const chipFill = committed ? 'var(--accent)' : 'var(--surface)';
      const chipStroke = committed ? 'var(--accent)' : 'var(--accent)';
      const chipTextColor = committed ? '#ffffff' : 'var(--accent)';
      const chipWidth = 12 + label.length * 7.2;
      const chipHeight = 24;
      const labelPlacement = chooseMeasurementLabelPosition({
        anchorPx,
        endpointPx,
        chipWidth,
        chipHeight,
        viewportWidth: overlayRect.width,
        viewportHeight: overlayRect.height,
      });
      const chipCenterX = labelPlacement.center.x;
      const chipY = labelPlacement.center.y;

      // Snapped anchors render as hollow rings so the underlying corner
      // geometry stays visible; unsnapped anchors are solid dots.
      const anchorMarker = anchorSnapped
        ? `<circle cx="${anchorPx.x}" cy="${anchorPx.y}" r="4.5"
                  fill="#ffffff" stroke="var(--accent)" stroke-width="1.75"/>`
        : `<circle cx="${anchorPx.x}" cy="${anchorPx.y}" r="4"
                  fill="var(--accent)" stroke="#ffffff" stroke-width="1.5"/>`;
      const endpointMarker = committed
        ? (endpointSnapped
            ? `<circle cx="${endpointPx.x}" cy="${endpointPx.y}" r="4.5"
                      fill="#ffffff" stroke="var(--accent)" stroke-width="1.75"/>`
            : `<circle cx="${endpointPx.x}" cy="${endpointPx.y}" r="4"
                      fill="var(--accent)" stroke="#ffffff" stroke-width="1.5"/>`)
        : '';
      // Live snap indicator wherever the cursor currently snaps — shown
      // during rubber-band AND after commit, so the user can see where
      // the next click will anchor without exiting measure mode first.
      // Suppressed only while Shift is held mid-rubber-band, since ortho
      // wins over corner snap there and the line would go somewhere other
      // than the highlighted point. The hollow anchor/endpoint circles
      // still convey the "this landed on a snap target" fact for committed
      // marks; the ring on hover is about the NEXT click, not the last.
      const rubberBandOrtho = !committed && shiftDown;
      const liveSnapMarker = hoverSnap && !rubberBandOrtho
        ? snapIndicatorMarkup(hoverSnap)
        : '';

      overlaySvgEl.innerHTML = `
        <line x1="${anchorPx.x}" y1="${anchorPx.y}" x2="${endpointPx.x}" y2="${endpointPx.y}"
              stroke="var(--accent)" stroke-width="1.5" ${lineDash}/>
        <line x1="${labelPlacement.leaderStart.x}" y1="${labelPlacement.leaderStart.y}"
              x2="${labelPlacement.leaderEnd.x}" y2="${labelPlacement.leaderEnd.y}"
              stroke="var(--accent)" stroke-width="1" stroke-opacity="0.55"/>
        <g transform="translate(${chipCenterX} ${chipY})">
          <rect x="${-chipWidth / 2}" y="${-chipHeight / 2}" width="${chipWidth}" height="${chipHeight}" rx="12"
                fill="${chipFill}" stroke="${chipStroke}" stroke-width="1"/>
          <text x="0" y="4" text-anchor="middle"
                font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
                font-size="12" font-weight="500" fill="${chipTextColor}">${label}</text>
          ${isOrtho && !committed
            ? `<g transform="translate(${chipWidth / 2 + 8} 0)">
                 <rect x="0" y="-9" width="46" height="18" rx="3"
                       fill="color-mix(in oklab, var(--accent) 14%, transparent)"/>
                 <text x="23" y="4" text-anchor="middle"
                       font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
                       font-size="9.5" font-weight="600" fill="var(--accent)"
                       letter-spacing="0.06em">ORTHO</text>
               </g>`
            : ''
          }
        </g>
        ${liveSnapMarker}
        ${anchorMarker}
        ${endpointMarker}`;
    }

    // Ortho snap: if Shift is held during rubber-band phase, lock the endpoint
    // to whichever axis (horizontal/vertical) the cursor is currently closer
    // to. Applies before we compute distance so the numeric readout matches
    // what the user sees.
    function orthoAdjusted(anchor, cursor) {
      if (!shiftDown || !anchor || !cursor || committed) return cursor;
      const dx = Math.abs(cursor.x - anchor.x);
      const dy = Math.abs(cursor.y - anchor.y);
      return dx >= dy
        ? { x: cursor.x, y: anchor.y }
        : { x: anchor.x, y: cursor.y };
    }

    // ── coord chip content ───────────────────────────────────────────────

    function updateCoordChip(sheetPt) {
      if (!coordChipEl) return;
      if (!showCursorCoords) { coordChipEl.hidden = true; return; }
      if (!sheetPt) { coordChipEl.hidden = true; return; }
      const base = `x: ${formatMeasuredLength(sheetPt.x, false)} · y: ${formatMeasuredLength(sheetPt.y, false)} ${unitLabel(measurementSystem())}`;
      if (measureMode && anchorSheet && !committed) {
        const endpoint = orthoAdjusted(anchorSheet, sheetPt);
        const distance = Math.hypot(endpoint.x - anchorSheet.x, endpoint.y - anchorSheet.y);
        coordChipEl.textContent = `${base} · Δ ${formatMeasuredLength(distance, false)}`;
      } else {
        coordChipEl.textContent = base;
      }
      coordChipEl.hidden = false;
    }

    // ── event handlers ───────────────────────────────────────────────────

    function onMouseMove(event) {
      const svgVisible = dom.svgContainer && dom.svgContainer.style.display !== 'none';
      if (!svgVisible) {
        updateCoordChip(null);
        cursorSheet = null;
        hoverSnap = null;
        redrawOverlay();
        return;
      }
      // Snap only applies in measure mode. Outside of it the coord chip
      // just reflects raw cursor position; there's nothing to anchor to.
      const rawSheet = screenToSheet(event.clientX, event.clientY);
      let effectiveSheet = rawSheet;
      const priorHoverSnap = hoverSnap;
      hoverSnap = measureMode ? findSnap(event.clientX, event.clientY) : null;
      if (hoverSnap) effectiveSheet = { x: hoverSnap.x, y: hoverSnap.y };
      updateCoordChip(effectiveSheet);
      if (measureMode) {
        // Live-update rubber-band OR redraw only when the snap state changed
        // (so the green indicator appears/disappears crisply while hovering).
        if (!committed && anchorSheet) {
          cursorSheet = effectiveSheet;
          redrawOverlay();
        } else if (!!priorHoverSnap !== !!hoverSnap
          || (hoverSnap && priorHoverSnap
              && (priorHoverSnap.x !== hoverSnap.x || priorHoverSnap.y !== hoverSnap.y))) {
          redrawOverlay();
        }
      }
    }

    function onMouseLeave() {
      updateCoordChip(null);
      const wasHovering = !!hoverSnap;
      hoverSnap = null;
      if (measureMode && !committed) {
        cursorSheet = null;
        redrawOverlay();
      } else if (wasHovering) {
        redrawOverlay();
      }
    }

    function onClick(event) {
      if (!measureMode) return;
      // This handler runs in the capture phase (see init()) so it intercepts
      // clicks before canvas pan/click handlers can consume them. That means
      // it ALSO intercepts clicks on measure-tool UI (the mode chip's "×",
      // the coord chip, etc.) — let those pass through normally so their own
      // handlers still fire.
      const clickedUiControl = event.target instanceof Element
        && event.target.closest('.measure-mode-chip, .measure-coord-chip');
      if (clickedUiControl) return;
      // Prefer the snap target — that's the whole point. Falls back to the
      // raw cursor coord only when nothing is within snap range.
      const snap = findSnap(event.clientX, event.clientY);
      const sheetPt = snap ? { x: snap.x, y: snap.y } : screenToSheet(event.clientX, event.clientY);
      if (!sheetPt) return;
      event.stopPropagation();
      event.preventDefault();
      if (!anchorSheet || committed) {
        // Start new measurement.
        anchorSheet = sheetPt;
        cursorSheet = sheetPt;
        anchorSnapped = !!snap;
        endpointSnapped = false;
        committed = false;
      } else {
        // Second click commits — the snapped/ortho-corrected point becomes
        // the definitive endpoint so the numeric readout matches the visual.
        const adjusted = orthoAdjusted(anchorSheet, sheetPt);
        cursorSheet = adjusted;
        // Ortho snap trumps corner snap: if the user is holding Shift, the
        // endpoint is on the axis line, not on the snap target, so mark it
        // as unsnapped visually.
        endpointSnapped = !!snap && !shiftDown;
        committed = true;
      }
      redrawOverlay();
    }

    function onKeyDown(event) {
      if (event.key === 'Shift' && !shiftDown) {
        shiftDown = true;
        if (measureMode && anchorSheet && !committed) redrawOverlay();
      } else if (event.key === 'Escape' && measureMode) {
        setMeasureMode(false);
      }
    }

    function onKeyUp(event) {
      if (event.key === 'Shift' && shiftDown) {
        shiftDown = false;
        if (measureMode && anchorSheet && !committed) redrawOverlay();
      }
    }

    function onViewportChange() {
      // Zoom, pan, scroll, or window resize all mutate the SVG → screen
      // transform. Re-project the anchor/cursor so committed measurements
      // stick to the geometry they were placed on, and drop cached snap
      // targets since their screen-space rects have moved with the viewport.
      invalidateSnapCache();
      redrawOverlay();
    }

    // ── public API ───────────────────────────────────────────────────────

    return {
      init() {
        if (!dom.viewport || !dom.svgContainer) return;
        ensureCoordChip();
        ensureModeChip();
        ensureOverlay();
        ensureRulerButton();

        dom.viewport.addEventListener('mousemove', onMouseMove);
        dom.viewport.addEventListener('mouseleave', onMouseLeave);
        // Use capture on click so we run before canvas pan/click handlers
        // consume the event when measure mode is active.
        dom.viewport.addEventListener('click', onClick, true);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('resize', onViewportChange);
        dom.viewport.addEventListener('scroll', onViewportChange, { passive: true });

        // The zoom controls resize the SVG element via inline width/height
        // (see canvas-view.js `applyZoom`). ResizeObserver picks up those
        // changes and re-projects committed measurements so they follow the
        // zoom instead of visually drifting off the geometry.
        if (typeof ResizeObserver !== 'undefined' && dom.svgContainer) {
          const ro = new ResizeObserver(() => {
            invalidateSnapCache();
            redrawOverlay();
          });
          ro.observe(dom.svgContainer);
        }
      },
      toggle() { setMeasureMode(!measureMode); },
      setActive(next) { setMeasureMode(!!next); },
      isActive() { return measureMode; },
      /** Clear the current measurement (anchor + committed endpoint) without
       *  turning measure mode off. Called on sheet-tab switches so a ruler
       *  drawn against one sheet doesn't linger on top of another. */
      resetMeasurement() {
        if (!anchorSheet && !committed) return;
        anchorSheet = null;
        cursorSheet = null;
        committed = false;
        anchorSnapped = false;
        endpointSnapped = false;
        redrawOverlay();
      },
      setShowCursorCoords(next) {
        showCursorCoords = !!next;
        if (!showCursorCoords && coordChipEl) coordChipEl.hidden = true;
      },
      isShowCursorCoords() { return showCursorCoords; },
      onUnitsChanged() {
        if (cursorSheet) updateCoordChip(cursorSheet);
        redrawOverlay();
      },
      onLanguageChanged() {
        if (modeChipEl) {
          modeChipEl.querySelector('.measure-mode-label').textContent = t('measure.label');
          const closeButton = modeChipEl.querySelector('.measure-mode-close');
          closeButton.title = t('measure.exit');
          closeButton.setAttribute('aria-label', t('measure.exitMode'));
        }
        if (rulerBtn) {
          rulerBtn.title = t('measure.label');
          rulerBtn.setAttribute('aria-label', t('measure.toggle'));
        }
      },
      /** Called by canvas-view after rendering or resizing the SVG so the
       *  overlay and committed measurement follow its current transform. */
      onCanvasUpdated() {
        invalidateSnapCache();
        redrawOverlay();
      },
    };
  }

  globalScope.NestMeasureTool = { createMeasureTool };
})(window);
