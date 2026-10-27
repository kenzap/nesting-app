'use strict';

// Cursor-following label for the nesting canvas: names the source DXF of the
// part under the pointer.
//
// Placed parts are <use href="#item_N"> elements (the dashed collision outline
// of the same part is <use href="#cd_shape_N">). N is the solver item id, which
// state.lastPlacementExportItems maps back to the file it came from — the same
// mapping per-source colouring uses — so the browser's own hit-testing tells us
// which part is hovered without any geometry maths.

(function definePartHoverTooltip(globalScope) {
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const CURSOR_OFFSET_X = 14;
  const CURSOR_OFFSET_Y = 18;
  const EDGE_MARGIN = 8;

  function itemIdFromHref(href) {
    const match = /^#(?:item|cd_shape)_(\d+)$/.exec(String(href || ''));
    return match ? Number(match[1]) : null;
  }

  function basename(filePath) {
    return String(filePath || '').split(/[\\/]/).pop();
  }

  // Resolves a solver item id to what the tooltip shows. Returns null when the
  // id has no export metadata (e.g. a stale result from before the last edit).
  function describePart(state, itemId) {
    const items = state?.lastPlacementExportItems;
    const meta = items?.[itemId] ?? items?.[String(itemId)];
    if (!meta) return null;

    const files = Array.isArray(state.files) ? state.files : [];
    const file = files.find(entry => entry.id === meta.source_file_id)
      || files.find(entry => entry.name === meta.source_name || entry.path === meta.source_file);
    const name = String(meta.source_name || file?.name || basename(meta.source_file)).trim();
    if (!name) return null;

    // One DXF can hold several sketches (multi-sketch detection); name the
    // one this part came from so identical-looking siblings can be told apart.
    const shapes = Array.isArray(file?.shapes) ? file.shapes : [];
    const sketch = shapes.length > 1
      ? String(shapes.find(shape => shape.id === meta.source_shape_id)?.name || '')
      : '';
    return { name, sketch };
  }

  // Puts the tooltip just below-right of the cursor, flips to the other side
  // when it would run past the canvas edge, and finally clamps so it can never
  // leave the canvas area. All values are in client (viewport) pixels.
  function placeTooltip({ x, y, width, height, bounds }) {
    let left = x + CURSOR_OFFSET_X;
    let top = y + CURSOR_OFFSET_Y;
    if (left + width + EDGE_MARGIN > bounds.right) left = x - CURSOR_OFFSET_X - width;
    if (top + height + EDGE_MARGIN > bounds.bottom) top = y - CURSOR_OFFSET_Y / 2 - height;
    left = Math.max(bounds.left + EDGE_MARGIN, Math.min(left, bounds.right - width - EDGE_MARGIN));
    top = Math.max(bounds.top + EDGE_MARGIN, Math.min(top, bounds.bottom - height - EDGE_MARGIN));
    return { left, top };
  }

  function createPartHoverTooltip({ state, dom, isEnabled = () => true }) {
    let tipEl = null;
    let nameEl = null;
    let subEl = null;
    let size = { width: 0, height: 0 };
    // Content is rebuilt only when the hovered part (or the run's id → file
    // mapping) changes; moving within one part just repositions the tooltip.
    let activeItemId = null;
    let activeItems = null;

    function ensureTooltip() {
      if (tipEl) return;
      tipEl = document.createElement('div');
      tipEl.className = 'part-tooltip';
      tipEl.setAttribute('role', 'tooltip');
      nameEl = document.createElement('div');
      nameEl.className = 'part-tooltip-name';
      nameEl.dir = 'auto';
      subEl = document.createElement('div');
      subEl.className = 'part-tooltip-sub';
      tipEl.append(nameEl, subEl);
      document.body.appendChild(tipEl);
    }

    function hide() {
      activeItemId = null;
      activeItems = null;
      if (tipEl) tipEl.classList.remove('visible');
    }

    function hoveredItemId(event) {
      const target = event.target;
      if (typeof target?.closest !== 'function') return null;
      const use = target.closest('use');
      if (!use || !dom.svgContainer?.contains(use)) return null;
      return itemIdFromHref(use.getAttribute('href') || use.getAttributeNS?.(XLINK_NS, 'href'));
    }

    function onMouseMove(event) {
      if (!isEnabled() || dom.viewport.classList.contains('dragging')) {
        hide();
        return;
      }
      const itemId = hoveredItemId(event);
      if (itemId === null) {
        hide();
        return;
      }

      const items = state.lastPlacementExportItems;
      if (itemId !== activeItemId || items !== activeItems) {
        const part = describePart(state, itemId);
        if (!part) {
          hide();
          return;
        }
        ensureTooltip();
        nameEl.textContent = part.name;
        subEl.textContent = part.sketch;
        subEl.hidden = !part.sketch;
        activeItemId = itemId;
        activeItems = items;
        // Measured once per content change — reading offset sizes forces layout.
        size = { width: tipEl.offsetWidth, height: tipEl.offsetHeight };
      }

      const { left, top } = placeTooltip({
        x: event.clientX,
        y: event.clientY,
        width: size.width,
        height: size.height,
        bounds: dom.viewport.getBoundingClientRect(),
      });
      tipEl.style.transform = `translate(${left}px, ${top}px)`;
      tipEl.classList.add('visible');
    }

    return {
      init() {
        if (!dom.viewport || !dom.svgContainer) return;
        dom.viewport.addEventListener('mousemove', onMouseMove);
        dom.viewport.addEventListener('mouseleave', hide);
        dom.viewport.addEventListener('mousedown', hide);
        dom.viewport.addEventListener('wheel', hide, { passive: true });
        dom.viewport.addEventListener('scroll', hide, { passive: true });
        globalScope.addEventListener('blur', hide);
      },
      hide,
    };
  }

  globalScope.NestPartHoverTooltip = {
    createPartHoverTooltip,
    itemIdFromHref,
    describePart,
    placeTooltip,
  };
})(window);
