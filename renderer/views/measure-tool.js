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

    // Sheet-space mm → viewport-local pixel coordinates (relative to the
    // .canvas-viewport element, since overlays are absolutely positioned in
    // that container).
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
      const viewportRect = dom.viewport.getBoundingClientRect();
      return {
        x: screenPt.x - viewportRect.left,
        y: screenPt.y - viewportRect.top,
      };
    }

    // ── snap targets ─────────────────────────────────────────────────────

    // Extracts every segment endpoint from an SVG path `d` string — the
    // sharp corners a user would actually want to snap to. Handles the
    // command set Sparrow (and typical DXF→SVG converters) emit: M/m, L/l,
    // H/h, V/v, C/c, S/s, Q/q, T/t, A/a, Z/z. Skips Bezier control points
    // and arc parameters — only endpoints qualify as "vertices". After an
    // M, additional coordinate pairs behave as implicit L (SVG spec §8.3.2).
    function parsePathVertices(d) {
      const verts = [];
      if (!d) return verts;
      const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g);
      if (!tokens) return verts;
      let cmd = null;
      let x = 0, y = 0;
      let startX = 0, startY = 0;
      let i = 0;
      const num = () => Number(tokens[i++]);
      while (i < tokens.length) {
        const t = tokens[i];
        if (/^[a-zA-Z]$/.test(t)) {
          cmd = t; i++;
          if (cmd === 'M' || cmd === 'm') {
            const nx = cmd === 'M' ? num() : x + num();
            const ny = cmd === 'M' ? num() : y + num();
            x = nx; y = ny; startX = x; startY = y;
            verts.push({ x, y });
            // Implicit L (or l) for subsequent coord pairs on this command.
            cmd = cmd === 'M' ? 'L' : 'l';
          } else if (cmd === 'Z' || cmd === 'z') {
            x = startX; y = startY;
          }
          continue;
        }
        const rel = cmd === cmd.toLowerCase();
        if (cmd === 'L' || cmd === 'l' || cmd === 'T' || cmd === 't') {
          x = rel ? x + num() : num();
          y = rel ? y + num() : num();
          verts.push({ x, y });
        } else if (cmd === 'H' || cmd === 'h') {
          x = rel ? x + num() : num();
          verts.push({ x, y });
        } else if (cmd === 'V' || cmd === 'v') {
          y = rel ? y + num() : num();
          verts.push({ x, y });
        } else if (cmd === 'C' || cmd === 'c') {
          num(); num(); num(); num(); // two control points
          x = rel ? x + num() : num();
          y = rel ? y + num() : num();
          verts.push({ x, y });
        } else if (cmd === 'S' || cmd === 's' || cmd === 'Q' || cmd === 'q') {
          num(); num(); // one control point
          x = rel ? x + num() : num();
          y = rel ? y + num() : num();
          verts.push({ x, y });
        } else if (cmd === 'A' || cmd === 'a') {
          num(); num(); num(); num(); num(); // rx ry x-rot large sweep
          x = rel ? x + num() : num();
          y = rel ? y + num() : num();
          verts.push({ x, y });
        } else {
          i++; // unknown token — skip to stay unstuck
        }
      }
      return verts;
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

    // Enumerates snap targets in sheet-coord space:
    //   • the four corners of the sheet
    //   • every path-segment endpoint of every placed part
    // Sparrow's coordinate space equals sheet-mm 1:1 (its <use> transforms
    // are what its own solver reports), so applying the <use> transform to
    // each defs-side vertex yields the sheet-space snap point directly —
    // no getScreenCTM round-trip, no dependence on the visual flip.
    // Cached until the SVG resizes (see ResizeObserver in init()).
    function getSnapTargets() {
      if (snapTargetsCache) return snapTargetsCache;
      const targets = [];
      const sheet = activeSheet();
      const w = Number(sheet?.width) || 0;
      const h = Number(sheet?.height) || 0;
      if (w > 0 && h > 0) {
        targets.push({ x: 0, y: 0 });
        targets.push({ x: w, y: 0 });
        targets.push({ x: w, y: h });
        targets.push({ x: 0, y: h });
      }
      const svg = activeSvgEl();
      if (!svg) { snapTargetsCache = targets; return targets; }

      // Parse each unique defs entry once — many <use>s typically share the
      // same #item_N reference, so caching pays off on any real layout.
      const localVertsById = new Map();
      const uses = svg.querySelectorAll('#items > use');
      uses.forEach(useEl => {
        const href = useEl.getAttribute('href') || useEl.getAttribute('xlink:href') || '';
        const id = href.replace(/^#/, '');
        if (!id) return;
        let localVerts = localVertsById.get(id);
        if (!localVerts) {
          const def = svg.getElementById(id);
          localVerts = [];
          if (def) {
            def.querySelectorAll('path').forEach(p => {
              const d = p.getAttribute('d') || '';
              parsePathVertices(d).forEach(pt => localVerts.push(pt));
            });
          }
          localVertsById.set(id, localVerts);
        }
        if (!localVerts.length) return;
        const t = parseUseTransform(useEl.getAttribute('transform'));
        localVerts.forEach(v => {
          // Rotate (about local origin) then translate — SVG right-to-left.
          const rx = v.x * t.cos - v.y * t.sin;
          const ry = v.x * t.sin + v.y * t.cos;
          targets.push({ x: rx + t.tx, y: ry + t.ty });
        });
      });
      snapTargetsCache = targets;
      return targets;
    }

    // Returns the snap target closest to the cursor within SNAP_RADIUS_PX,
    // or null if none is close enough. Distance is computed in viewport-local
    // screen pixels so the radius stays visually constant across zoom levels.
    function findSnap(clientX, clientY) {
      if (!dom.viewport) return null;
      const targets = getSnapTargets();
      if (!targets.length) return null;
      const vpRect = dom.viewport.getBoundingClientRect();
      const cx = clientX - vpRect.left;
      const cy = clientY - vpRect.top;
      let best = null;
      let bestDist = SNAP_RADIUS_PX;
      targets.forEach(target => {
        const px = sheetToViewportPx(target);
        if (!px) return;
        const d = Math.hypot(px.x - cx, px.y - cy);
        if (d < bestDist) {
          best = target;
          bestDist = d;
        }
      });
      return best;
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
        <span class="measure-mode-label">Measure</span>
        <button class="measure-mode-close" type="button" aria-label="Exit measure mode" title="Exit">
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
      rulerBtn.title = 'Measure';
      rulerBtn.setAttribute('aria-label', 'Toggle measure tool');
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

    // Little green diamond drawn on a snap target so the user can see the
    // snap is engaged. Placed on the exact corner; the anchor circle beside
    // it is rendered hollow so the corner geometry stays visible through it.
    function snapIndicatorMarkup(sheetPt) {
      const px = sheetToViewportPx(sheetPt);
      if (!px) return '';
      const size = 7;
      return `<rect x="${px.x - size}" y="${px.y - size}"
                    width="${size * 2}" height="${size * 2}"
                    transform="rotate(45 ${px.x} ${px.y})"
                    fill="none" stroke="#22c55e" stroke-width="1.6"/>`;
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

    function redrawOverlay() {
      if (!overlaySvgEl || !dom.viewport) return;
      pinToVisibleFrame();
      const vpRect = dom.viewport.getBoundingClientRect();
      overlaySvgEl.setAttribute('viewBox', `0 0 ${vpRect.width} ${vpRect.height}`);
      overlaySvgEl.setAttribute('width', String(vpRect.width));
      overlaySvgEl.setAttribute('height', String(vpRect.height));

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
      const label = `${distance.toFixed(1)} mm`;

      const midX = (anchorPx.x + endpointPx.x) / 2;
      const midY = (anchorPx.y + endpointPx.y) / 2;
      const isOrtho = shiftDown && anchorSheet && cursorSheet;
      const lineDash = committed ? '' : 'stroke-dasharray="4 3"';
      const chipFill = committed ? 'var(--accent)' : 'var(--surface)';
      const chipStroke = committed ? 'var(--accent)' : 'var(--accent)';
      const chipTextColor = committed ? '#ffffff' : 'var(--accent)';
      const chipWidth = 12 + label.length * 7.2;

      // Position the chip OFF the line (perpendicular offset in screen space)
      // so it never covers the endpoints — matters for short measurements
      // where midpoint-of-line lands right between the two anchor circles.
      // Prefer the "up" side of the line so the chip clears part geometry
      // that typically extends downward.
      const CHIP_OFFSET_PX = 18;
      const lineDx = endpointPx.x - anchorPx.x;
      const lineDy = endpointPx.y - anchorPx.y;
      const lineLen = Math.hypot(lineDx, lineDy);
      let perpX = 0;
      let perpY = -1; // fallback: straight up for zero-length lines
      if (lineLen > 0.1) {
        perpX = -lineDy / lineLen;
        perpY = lineDx / lineLen;
        // Flip toward the "up" screen direction so the chip stays out of
        // most part geometry (which naturally extends into the sheet body).
        if (perpY > 0) { perpX = -perpX; perpY = -perpY; }
      }
      const chipCenterX = midX + perpX * CHIP_OFFSET_PX;
      const chipCenterY = midY + perpY * CHIP_OFFSET_PX;
      const chipY = chipCenterY;

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
      // While rubber-banding, show the snap diamond on the live cursor snap
      // — but suppress it if Shift is held, since ortho beats corner snap and
      // the line would go somewhere other than the highlighted corner.
      const liveSnapMarker = !committed && hoverSnap && !shiftDown
        ? snapIndicatorMarkup(hoverSnap)
        : '';
      const anchorSnapMarker = anchorSnapped ? snapIndicatorMarkup(anchorSheet) : '';
      const endpointSnapMarker = committed && endpointSnapped
        ? snapIndicatorMarkup(endpointSheet)
        : '';

      overlaySvgEl.innerHTML = `
        <line x1="${anchorPx.x}" y1="${anchorPx.y}" x2="${endpointPx.x}" y2="${endpointPx.y}"
              stroke="var(--accent)" stroke-width="1.5" ${lineDash}/>
        ${anchorSnapMarker}
        ${endpointSnapMarker}
        ${liveSnapMarker}
        ${anchorMarker}
        ${endpointMarker}
        <g transform="translate(${chipCenterX} ${chipY})">
          <rect x="${-chipWidth / 2}" y="-12" width="${chipWidth}" height="24" rx="12"
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
        </g>`;
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
      const base = `x: ${sheetPt.x.toFixed(1)} · y: ${sheetPt.y.toFixed(1)} mm`;
      if (measureMode && anchorSheet && !committed) {
        const endpoint = orthoAdjusted(anchorSheet, sheetPt);
        const distance = Math.hypot(endpoint.x - anchorSheet.x, endpoint.y - anchorSheet.y);
        coordChipEl.textContent = `${base} · Δ ${distance.toFixed(1)}`;
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
      setShowCursorCoords(next) {
        showCursorCoords = !!next;
        if (!showCursorCoords && coordChipEl) coordChipEl.hidden = true;
      },
      isShowCursorCoords() { return showCursorCoords; },
      /** Called by canvas-view when a new SVG is rendered so we resize the
       *  overlay and re-project any committed measurement. */
      onCanvasUpdated() {
        invalidateSnapCache();
        redrawOverlay();
      },
    };
  }

  globalScope.NestMeasureTool = { createMeasureTool };
})(window);
