'use strict';

(function definePlacementEditorView(root) {
  function createPlacementEditorView({ state, dom, canvasView }) {
    const core = root.NestPlacementEditor;
    const label = (key, options = {}) => root.NestI18n.t(`layoutEditor.${key}`, { key: isMac ? 'Option' : 'Alt', ...options });
    const clone = value => JSON.parse(JSON.stringify(value));
    const models = new Map();
    let result = null, active = false, loading = false, selected = null, drag = null;
    let undo = [], redo = [];
    // `selection` holds every selected copy (source indices); `selected` is the
    // primary one (last clicked), or null when nothing is selected. Rotation,
    // the angle field and the rotation handle act on a single part only.
    const selection = new Set();
    let nudgeGroup = null;
    let displayedStrip = null;
    let reportedResetAvailability = null;
    let reportedEditState = '';
    const toggle = document.getElementById('editLayout');
    const toolbar = document.getElementById('layoutEditTools');
    const message = document.getElementById('layoutEditMessage');
    const angleInput = document.getElementById('layoutEdit-angle');
    const angleLabel = document.getElementById('layoutEdit-angleLabel');
    const rotationHandle = document.getElementById('layoutEdit-rotationHandle');
    const buttons = Object.fromEntries(['rotateLeft', 'rotateRight', 'delete', 'undo', 'redo'].map(action =>
      [action, document.getElementById(`layoutEdit-${action}`)]));
    const currentStrip = () => state.nestResult?.strips?.[state.activeStripIndex || 0];
    const currentModel = () => models.get(currentStrip());
    const single = () => selection.size === 1;
    const selectedIndex = () => (single() ? currentModel()?.edits.findIndex(e => e.sourceIndex === selected) ?? -1 : -1);
    const nodeFor = id => dom.svgContainer.querySelector(`[data-placement-source-index="${id}"]`);
    const selectedNode = () => (single() ? nodeFor(selected) : null);
    const groupIndices = model => model.edits.map((e, index) => (selection.has(e.sourceIndex) ? index : -1)).filter(i => i >= 0);
    const selectionKey = () => [...selection].sort((a, b) => a - b).join(',');
    function clearSelection() { selection.clear(); selected = null; }
    function selectOnly(id) { selection.clear(); selection.add(id); selected = id; }
    const spacing = () => Number(state.nestRunPartSpacing) || 0;
    // First failing reason when every moved copy is checked, or null.
    const validateGroup = (placements, indices, model) => indices.reduce((reason, index) =>
      reason || core.validateMove(placements, index, model.items, model.frame, spacing()), null);
    function announceSelection() {
      if (selection.size > 1) say('selectedCount', '', { count: selection.size });
      else say('hint');
    }
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    const mod = isMac ? '⌘' : 'Ctrl+';
    const shortcuts = { rotateLeft: 'Shift+R', rotateRight: 'R', delete: isMac ? '⌫' : 'Del',
      undo: `${mod}Z`, redo: isMac ? '⇧⌘Z' : 'Ctrl+Shift+Z' };
    const WARNINGS = new Set(['bounds', 'collision', 'spacing', 'geometry', 'unavailable']);
    const SUCCESSES = new Set(['edgeSnapped']);
    function say(key, extra = '', options = {}) {
      const text = extra ? `${label(key, options)} ${extra}` : label(key, options);
      message.textContent = text;
      message.title = text;
      const status = message.parentElement;
      status?.classList.toggle('is-warning', WARNINGS.has(key));
      status?.classList.toggle('is-success', SUCCESSES.has(key));
      return text;
    }
    // A click is not a drag: pointer jitter below this many screen pixels
    // must not move or rotate the part (or add an invisible undo step).
    const DRAG_THRESHOLD_PX = 4;
    const pastThreshold = (drag, event) => drag.moved
      || (drag.moved = Math.hypot(event.clientX - drag.clientStart[0], event.clientY - drag.clientStart[1]) >= DRAG_THRESHOLD_PX);
    // Edits that differ only by floating-point noise are the same edit.
    const editKey = edits => JSON.stringify(edits, (_key, value) =>
      typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value);
    const angleText = angle => String(Number((((angle % 360) + 360) % 360).toFixed(4)));

    function syncAngle() {
      const index = selectedIndex();
      angleInput.disabled = !active || index < 0 || !!drag;
      angleInput.value = index < 0 ? '' : angleText(Number(currentModel().placements[index].transformation.rotation));
    }

    function positionHandle() {
      const node = selectedNode(), viewport = dom.viewport.getBoundingClientRect();
      rotationHandle.hidden = !active || !node || (!!drag && drag.kind !== 'rotate');
      if (rotationHandle.hidden) return;
      const box = node.getBoundingClientRect();
      if (box.right < viewport.left || box.left > viewport.right || box.bottom < viewport.top || box.top > viewport.bottom) {
        rotationHandle.hidden = true; return;
      }
      const tint = node.querySelector('use')?.getAttribute('stroke');
      if (tint) rotationHandle.style.setProperty('--handle-color', tint);
      if (drag?.kind === 'rotate') return;
      rotationHandle.style.left = `${Math.max(viewport.left + 20, Math.min(viewport.right - 20, box.x + box.width / 2))}px`;
      rotationHandle.style.top = `${Math.max(viewport.top + 20, Math.min(viewport.bottom - 20, box.top - 26))}px`;
    }
    const eligible = () => state.status === 'done' && state.nestRunId
      && state.nestResult?.strips?.length && !state.nestResult.is_preview;

    function sync() {
      if (result && result !== state.nestResult) {
        cancelDrag();
        active = false; result = null; models.clear(); undo = []; redo = []; clearSelection(); drag = null;
      }
      if (!eligible()) { active = false; cancelDrag(); }
      toggle.disabled = !eligible() || loading;
      const toggleText = label(loading ? 'loading' : active ? 'done' : 'edit');
      toggle.setAttribute('aria-label', toggleText);
      toggle.title = active ? `${toggleText} (Esc)` : toggleText;
      toggle.classList.toggle('is-loading', loading);
      toggle.setAttribute('aria-pressed', String(active));
      toolbar.hidden = !active;
      dom.viewport.classList.toggle('layout-edit-active', active);
      Object.entries(buttons).forEach(([key, button]) => {
        const text = label(key);
        button.setAttribute('aria-label', text);
        button.title = shortcuts[key] ? `${text} (${shortcuts[key]})` : text;
      });
      buttons.delete.disabled = selection.size === 0;
      buttons.rotateLeft.disabled = !single();
      buttons.rotateRight.disabled = !single();
      buttons.undo.disabled = undo.length === 0;
      buttons.redo.disabled = redo.length === 0;
      // Edit → Edit Layout / Save Layout mirrors the pencil toggle.
      const editState = { canEdit: !!eligible() && !loading, active };
      const editStateKey = JSON.stringify(editState);
      if (editStateKey !== reportedEditState) {
        reportedEditState = editStateKey;
        root.electronAPI?.setLayoutEditState?.(editState);
      }
      // Reset lives in the app's Edit menu; keep its enabled state in step.
      const resetAvailable = canReset();
      if (resetAvailable !== reportedResetAvailability) {
        reportedResetAvailability = resetAvailable;
        root.electronAPI?.setLayoutResetAvailable?.(resetAvailable);
      }
      angleLabel.textContent = label('angle');
      angleInput.title = label('rotationHint');
      rotationHandle.title = label('rotationHint');
      rotationHandle.setAttribute('aria-label', label('rotationHint'));
      if (document.activeElement !== angleInput) syncAngle();
      positionHandle();
    }

    function draw() {
      canvasView.showNestResult(state.activeStripIndex || 0, { preserveView: true });
      root.measureToolApi?.resetMeasurement?.();
      sync();
    }

    function update(model) {
      model.placements = core.applyEdits(model.original, model.edits);
      const changed = JSON.stringify(model.edits) !== JSON.stringify(core.editsFor(model.original));
      if (changed) {
        model.strip.manual_edits = clone(model.edits);
        Object.assign(model.strip, core.stats(model.placements, model.items, model.frame));
      } else {
        delete model.strip.manual_edits;
        model.strip.item_count = model.originalStats.item_count;
        model.strip.density = model.originalStats.density;
      }
      const modified = [...models.values()].some(m => m.strip.manual_edits !== undefined);
      // Solver shared-edge totals no longer describe an edited layout.
      state.nestResult.total_shared_edge_length_mm = modified ? null : result.originalSharedLength;
    }

    function commit(model, edits, group = null) {
      if (editKey(edits) === editKey(model.edits)) return;
      const previous = undo[undo.length - 1];
      if (group && previous?.group === group) previous.after = clone(edits);
      else undo.push({ model, before: clone(model.edits), after: clone(edits), group });
      if (undo.length > 100) undo.shift();
      redo = [];
      model.edits = edits; update(model); draw();
    }

    async function enter() {
      if (loading || !eligible()) return;
      loading = true; sync();
      const snapshot = state.nestResult;
      try {
        if (result !== snapshot) {
          const data = await root.electronAPI.loadPlacementEditor(state.nestRunId);
          if (state.nestResult !== snapshot || !eligible()) return;
          if (!data.success) throw new Error(data.error);
          const pending = [];
          for (const strip of snapshot.strips) {
            const source = data.strips.find(s => s.json_path === strip.json_path);
            if (!source) throw new Error(label('unavailable'));
            const margin = Number(strip.sheet_margin) || 0;
            const width = strip.sheet_width_mode === 'fixed' ? Number(strip.sheet_width)
              : Number(strip.strip_width) + margin * 2;
            const frame = { width, height: Number(strip.strip_height), margin };
            if (!(width > margin * 2 && frame.height > margin * 2)) throw new Error(label('unavailable'));
            const items = Object.fromEntries(Object.entries(data.items).map(([id, item]) =>
              [id, { ...item, export: state.lastPlacementExportItems?.[id] }]));
            source.placements.forEach(p => core.outline(items[p.item_id]));
            pending.push([strip, { strip, frame, items, original: clone(source.placements),
              placements: clone(source.placements), edits: core.editsFor(source.placements),
              originalStats: { density: strip.density, item_count: strip.item_count } }]);
          }
          pending.forEach(([strip, model]) => models.set(strip, model));
          result = snapshot;
          result.originalSharedLength = result.total_shared_edge_length_mm;
        }
        if (root.measureToolApi?.isActive()) root.measureToolApi.toggle();
        active = true; clearSelection(); say('hint'); draw();
      } catch (error) {
        dom.nestStats.textContent = say('unavailable', error.message || '');
      } finally { loading = false; sync(); }
    }

    const canReset = () => !loading && (undo.length > 0
      || [...models.values()].some(m => m.strip.manual_edits !== undefined));

    function resetLayout() {
      if (!canReset() || !root.confirm(label('confirmReset'))) return false;
      cancelDrag();
      models.forEach(model => { model.edits = core.editsFor(model.original); update(model); });
      undo = []; redo = []; clearSelection(); draw(); say('hint');
      return true;
    }

    function exit() { active = false; clearSelection(); cancelDrag(); draw(); }

    function markSelection() {
      dom.svgContainer.querySelectorAll('.manual-placement').forEach(el =>
        el.classList.toggle('selected', selection.has(Number(el.dataset.placementSourceIndex))));
      updateSelectionOverlay();
    }

    const setAttr = (el, name, value) => {
      if (value === null) { if (el.hasAttribute(name)) el.removeAttribute(name); }
      else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
    };
    // SVG paints in document order, so a highlight drawn on the selected part
    // itself can disappear under parts drawn after it. The highlight is drawn
    // instead in an overlay group after #items: an outline-only copy of the
    // selected shape in the part's own color with the same blurred glow as the
    // contour selection in the preview modal. Its transforms are mirrored from
    // the selected part, so drag and rotate previews stay in step, and the blur
    // is rescaled on zoom so the glow keeps a constant on-screen size. Only
    // changed attributes are written, which keeps the MutationObserver that
    // calls this from looping.
    const GLOW_ID = 'placementSelectionGlow';
    const GLOW_SCREEN_PX = 3;
    function updateSelectionOverlay() {
      const overlay = dom.svgContainer.querySelector('.placement-selection-overlay');
      if (!overlay) return;
      const sources = active ? [...selection].map(id => [id, nodeFor(id)]).filter(([, node]) => node?.querySelector('use')) : [];
      // One outline per selected copy; rebuilt only when the set of copies,
      // their shapes or colors change, otherwise just re-synced.
      const signature = sources.map(([id, node]) => {
        const use = node.querySelector('use');
        return `${id}:${use.getAttribute('href')}:${use.getAttribute('stroke') || ''}`;
      }).join('|');
      if (overlay.getAttribute('data-signature') !== signature) {
        setAttr(overlay, 'data-signature', signature);
        overlay.innerHTML = sources.map(([id, node]) => {
          const use = node.querySelector('use');
          return `<g data-source-index="${id}"><use class="placement-selection-line" href="${use.getAttribute('href')}" fill="none" stroke="${use.getAttribute('stroke') || ''}"/></g>`;
        }).join('');
      }
      if (!sources.length) return;
      const matrix = overlay.ownerSVGElement?.getScreenCTM();
      const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 0;
      const blur = dom.svgContainer.querySelector(`#${GLOW_ID} feGaussianBlur`);
      if (blur && scale > 0) setAttr(blur, 'stdDeviation', String(Number((GLOW_SCREEN_PX / scale).toFixed(3))));
      sources.forEach(([id, node], i) => {
        const copy = overlay.children[i];
        if (!copy) return;
        setAttr(copy, 'transform', node.getAttribute('transform'));
        setAttr(copy.firstElementChild, 'transform', node.querySelector('use').getAttribute('transform'));
      });
    }

    function svgForStrip(strip, { colors, itemColors }) {
      const model = models.get(strip);
      if (!model || (!active && strip.manual_edits === undefined)) return null;
      const { width, height, margin } = model.frame;
      const path = points => 'M' + points.map(([x, y]) => `${x},${y}`).join(' L') + ' Z';
      const definitions = new Map();
      const shapes = model.placements.map((p, index) => {
        const item = model.items[p.item_id];
        const id = model.edits[index].sourceIndex;
        const color = itemColors?.get(Number(p.item_id));
        const d = [path(core.outline(item)), ...(item.export?.holes || []).map(path)].join(' ');
        definitions.set(p.item_id, `<g id="item_${Number(p.item_id)}"><path d="${d}" fill-rule="evenodd" vector-effect="non-scaling-stroke"/></g>`);
        const [x, y] = p.transformation.translation;
        return `<g data-placement-source-index="${id}" class="manual-placement${active && selection.has(id) ? ' selected' : ''}"><use href="#item_${Number(p.item_id)}" transform="translate(${x + margin} ${y + margin}) rotate(${p.transformation.rotation})" fill="${color?.fill || colors.partFill}" stroke="${color?.stroke || colors.partStroke}" color="${color?.stroke || colors.partStroke}" stroke-width="1"/></g>`;
      }).join('');
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-80 -44 ${width + 160} ${height + 88}" width="${width + 160}" height="${height + 88}" data-sheet-width="${width}" data-sheet-height="${height}"><defs>${[...definitions.values()].join('')}<filter id="${GLOW_ID}" filterUnits="userSpaceOnUse" x="${-width}" y="${-height}" width="${width * 3}" height="${height * 3}"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect width="${width}" height="${height}" fill="${colors.background}" stroke="${colors.sheetStroke}" stroke-width="2" vector-effect="non-scaling-stroke"/><g transform="translate(0 ${height}) scale(1 -1)"><g id="items">${shapes}</g><g class="placement-selection-overlay" filter="url(#${GLOW_ID})" pointer-events="none"></g></g></svg>`;
    }

    function point(event, svg) {
      const matrix = svg.getScreenCTM();
      if (!matrix) return null;
      return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    }

    function cancelDrag() {
      if (drag) {
        if (drag.snapFrame) cancelAnimationFrame(drag.snapFrame);
        drag.guide?.remove();
        (drag.members || []).forEach(member => member.node.querySelector('use')?.setAttribute('transform', member.originalUseTransform));
        drag.node.removeAttribute('transform');
        if (dom.viewport.hasPointerCapture(drag.pointerId)) dom.viewport.releasePointerCapture(drag.pointerId);
      }
      drag = null;
      dom.viewport.classList.remove('layout-dragging');
      syncAngle();
      positionHandle();
    }

    const useTransform = (edit, margin) =>
      `translate(${edit.translation[0] + margin} ${edit.translation[1] + margin}) rotate(${edit.rotation})`;

    // Moves the dragged copy (and every other selected copy by the same
    // offset). Only the copy under the pointer snaps, and only to parts outside
    // the selection. A group never auto-rotates while snapping: only edges that
    // are already parallel qualify, and rotations are kept as they are.
    function previewMove(altKey) {
      if (drag?.kind !== 'move') return;
      if (drag.snapFrame) cancelAnimationFrame(drag.snapFrame);
      drag.snapFrame = null;
      const { model, index, dx, dy, members } = drag;
      const isGroup = members.length > 1;
      const moved = members.map(({ index: i }) => {
        const edit = clone(model.edits[i]);
        edit.translation[0] += dx; edit.translation[1] += dy;
        return edit;
      });
      const placements = model.placements.slice();
      members.forEach(({ index: i }, k) => {
        placements[i] = { ...model.placements[i], transformation: {
          ...model.placements[i].transformation, translation: moved[k].translation } };
      });
      const anchor = members.findIndex(member => member.index === index);
      const matrix = drag.svg.getScreenCTM();
      const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 0;
      drag.snap = !altKey && scale > 0 && Math.hypot(dx, dy) > 1e-6
        ? core.findEdgeSnap(placements, index, moved[anchor], model.items, model.frame, spacing(), drag.snapContext,
          isGroup ? { distanceLimit: 10 / scale, angleLimit: 1e-3 } : { distanceLimit: 10 / scale }) : null;
      if (drag.snap && isGroup) {
        const shift = drag.snap.edit.translation.map((value, axis) => value - moved[anchor].translation[axis]);
        moved.forEach(edit => { edit.translation = edit.translation.map((value, axis) => value + shift[axis]); });
      } else if (drag.snap) {
        moved[anchor] = drag.snap.edit;
      }
      drag.pendingEdits = moved;
      members.forEach((member, k) => member.node.querySelector('use')
        .setAttribute('transform', useTransform(moved[k], model.frame.margin)));
      drag.guide?.remove(); drag.guide = null;
      if (drag.snap) {
        const guide = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const screenPoint = p => `${p[0] + model.frame.margin},${model.frame.height - model.frame.margin - p[1]}`;
        const contacts = drag.snap.contacts || [drag.snap];
        guide.setAttribute('d', contacts.flatMap(contact => [contact.target, contact.edge])
          .map(([a, b]) => `M${screenPoint(a)} L${screenPoint(b)}`).join(' '));
        guide.setAttribute('class', 'layout-snap-guide');
        guide.setAttribute('vector-effect', 'non-scaling-stroke');
        drag.svg.appendChild(guide); drag.guide = guide;
      }
      if (!isGroup) angleInput.value = angleText(moved[anchor].rotation);
      say(drag.snap ? 'edgeSnapped' : 'snapHint');
    }

    function remove() {
      const model = currentModel();
      if (!active || !model || selection.size === 0) return;
      const count = selection.size;
      const next = model.edits.filter(e => !selection.has(e.sourceIndex));
      clearSelection(); commit(model, next); say(count > 1 ? 'deletedSelection' : 'deleted');
    }

    function rotate(degrees) {
      const model = currentModel();
      if (!active || !model || selection.size === 0 || drag) return;
      if (!single()) { say('groupRotation'); return; }
      const index = selectedIndex();
      if (index < 0) return;
      try {
        const edits = clone(model.edits), placement = model.placements[index];
        edits[index] = core.rotateEdit(edits[index], placement, model.items[placement.item_id], degrees);
        const placements = core.applyEdits(model.original, edits);
        const reason = core.validateMove(placements, index, model.items, model.frame, spacing());
        if (reason) { say(reason); syncAngle(); return; }
        commit(model, edits); say('hint');
        syncAngle();
      } catch (_) { say('geometry'); syncAngle(); }
    }

    function nudge(event) {
      const model = currentModel();
      if (!model || selection.size === 0 || drag) return;
      const indices = groupIndices(model);
      if (!indices.length) return;
      const imperial = root.NestUnits.resolveMeasurementSystem(state.settings?.measurementSystem) === 'imperial';
      const step = (imperial ? 0.254 : 1) * (event.shiftKey ? 10 : 1);
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      const direction = directions[event.key];
      if (!direction) return;
      const key = selectionKey();
      if (!event.repeat || nudgeGroup?.model !== model || nudgeGroup?.selection !== key
          || nudgeGroup?.key !== event.key || nudgeGroup?.step !== step) {
        nudgeGroup = { model, selection: key, key: event.key, step };
      }
      const shifted = distance => {
        const edits = clone(model.edits);
        indices.forEach(index => {
          edits[index].translation = edits[index].translation.map((value, axis) => value + direction[axis] * distance);
        });
        return edits;
      };
      const check = edits => validateGroup(core.applyEdits(model.original, edits), indices, model);
      let edits = shifted(step);
      const reason = check(edits);
      let snapped = false;
      if (reason) {
        // The full step is blocked, but there may be room for part of it: move
        // as far as is still valid (touching, or at the required spacing),
        // then snap flush like a drag would. Only the rejected remainder is lost.
        let low = 0, high = step;
        for (let i = 0; i < 24 && high - low > 1e-6; i++) {
          const mid = (low + high) / 2;
          if (check(shifted(mid))) high = mid; else low = mid;
        }
        if (low < 1e-4) { say(reason); return; }
        edits = shifted(low);
        const anchorIndex = model.edits.findIndex(e => e.sourceIndex === selected);
        if (anchorIndex >= 0) {
          const group = new Set(indices);
          const placements = core.applyEdits(model.original, edits);
          const context = core.prepareEdgeSnap(placements, anchorIndex, model.items);
          context.targets = context.targets.filter(target => !group.has(target.placementIndex));
          const snap = core.findEdgeSnap(placements, anchorIndex, edits[anchorIndex], model.items, model.frame,
            spacing(), context, { distanceLimit: step, angleLimit: 1e-3 });
          if (snap) {
            const delta = snap.edit.translation.map((value, axis) => value - edits[anchorIndex].translation[axis]);
            const candidate = clone(edits);
            indices.forEach(index => {
              candidate[index].translation = candidate[index].translation.map((value, axis) => value + delta[axis]);
            });
            if (!check(candidate)) { edits = candidate; snapped = true; }
          }
        }
      }
      commit(model, edits, nudgeGroup);
      if (snapped) say('edgeSnapped'); else announceSelection();
    }

    function travel(from, to, key) {
      cancelDrag();
      const entry = from.pop();
      if (!entry) return;
      to.push(entry); entry.model.edits = clone(entry[key]); update(entry.model);
      state.activeStripIndex = state.nestResult.strips.indexOf(entry.model.strip);
      clearSelection(); canvasView.renderTabs(); draw(); say('hint');
    }

    function bind() {
      toggle.addEventListener('click', () => toggleEditing());
      buttons.delete.addEventListener('click', remove);
      buttons.rotateLeft.addEventListener('click', () => rotate(90));
      buttons.rotateRight.addEventListener('click', () => rotate(-90));
      angleInput.addEventListener('change', () => {
        const index = selectedIndex(), value = angleInput.valueAsNumber;
        if (index < 0 || !Number.isFinite(value)) { syncAngle(); return; }
        rotate(value - Number(currentModel().placements[index].transformation.rotation));
      });
      angleInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); angleInput.blur(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); syncAngle(); angleInput.blur(); }
      });
      buttons.undo.addEventListener('click', () => travel(undo, redo, 'before'));
      buttons.redo.addEventListener('click', () => travel(redo, undo, 'after'));
      dom.viewport.addEventListener('mousedown', event => {
        if (active && event.target.closest('[data-placement-source-index], #layoutEdit-rotationHandle')) event.stopImmediatePropagation();
      }, true);
      dom.viewport.addEventListener('pointerdown', event => {
        if (!active || event.button !== 0 || drag) return;
        nudgeGroup = null;
        if (event.target.closest('#layoutEdit-rotationHandle')) {
          const model = currentModel(), index = selectedIndex(), node = selectedNode();
          if (!model || index < 0 || !node) return;
          event.preventDefault(); event.stopPropagation();
          const svg = node.ownerSVGElement, start = point(event, svg);
          if (!start) return;
          const placement = model.placements[index];
          const pivot = core.rotationCenter(placement, model.items[placement.item_id], model.frame.margin);
          const center = { x: pivot[0], y: model.frame.height - pivot[1] };
          drag = { kind: 'rotate', node, model, svg, index, pivot, center, degrees: 0,
            clientStart: [event.clientX, event.clientY], moved: false,
            startAngle: Math.atan2(center.y - start.y, start.x - center.x),
            pointerId: event.pointerId, sourceIndex: selected };
          dom.viewport.setPointerCapture(event.pointerId);
          say('rotationHint'); syncAngle();
          return;
        }
        const node = event.target.closest('[data-placement-source-index]');
        if (!node) {
          cancelDrag();
          clearSelection();
          markSelection();
          say('hint');
          sync();
          return;
        }
        event.preventDefault(); event.stopPropagation();
        const model = currentModel(), svg = node.ownerSVGElement, start = point(event, svg);
        if (!model || !start) return;
        const id = Number(node.dataset.placementSourceIndex);
        const index = model.edits.findIndex(e => e.sourceIndex === id);
        if (index < 0) return;
        // Shift (or Cmd/Ctrl) + click adds a copy to the selection or removes it.
        // A plain press on a member of a multi-selection keeps the group so it
        // can be dragged together; releasing without dragging selects only it.
        let collapseTo = null;
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
          if (selection.has(id)) {
            selection.delete(id);
            if (selected === id) selected = selection.size ? [...selection].at(-1) : null;
            markSelection(); announceSelection(); sync();
            return;
          }
          selection.add(id); selected = id;
        } else if (selection.has(id) && selection.size > 1) {
          selected = id; collapseTo = id;
        } else {
          selectOnly(id);
        }
        markSelection(); announceSelection();
        const indices = groupIndices(model), group = new Set(indices);
        const snapContext = core.prepareEdgeSnap(model.placements, index, model.items);
        if (indices.length > 1) snapContext.targets = snapContext.targets.filter(target => !group.has(target.placementIndex));
        drag = { kind: 'move', node, model, svg, index, start, dx: 0, dy: 0, pointerId: event.pointerId, collapseTo,
          clientStart: [event.clientX, event.clientY], moved: false, snapContext,
          members: indices.map(i => {
            const member = nodeFor(model.edits[i].sourceIndex);
            return { index: i, sourceIndex: model.edits[i].sourceIndex, node: member,
              originalUseTransform: member?.querySelector('use')?.getAttribute('transform') };
          }).filter(member => member.node) };
        dom.viewport.setPointerCapture(event.pointerId); sync();
      });
      dom.viewport.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!pastThreshold(drag, event)) return;
        // other parts fade while a part is moved or rotated (styles.css)
        dom.viewport.classList.add('layout-dragging');
        const next = point(event, drag.svg);
        if (!next) return;
        if (drag.kind === 'rotate') {
          if (Math.hypot(next.x - drag.center.x, next.y - drag.center.y) < 1e-6) return;
          const initial = Number(drag.model.placements[drag.index].transformation.rotation);
          let degrees = (Math.atan2(drag.center.y - next.y, next.x - drag.center.x) - drag.startAngle) * 180 / Math.PI;
          if (event.shiftKey) degrees = Math.round((initial + degrees) / 15) * 15 - initial;
          drag.degrees = degrees;
          drag.node.setAttribute('transform', `rotate(${degrees} ${drag.pivot[0]} ${drag.pivot[1]})`);
          rotationHandle.style.left = `${event.clientX}px`;
          rotationHandle.style.top = `${event.clientY}px`;
          angleInput.value = angleText(initial + degrees);
          return;
        }
        drag.dx = next.x - drag.start.x; drag.dy = -(next.y - drag.start.y);
        if (drag.snapFrame) cancelAnimationFrame(drag.snapFrame);
        drag.snapFrame = requestAnimationFrame(() => previewMove(event.altKey));
      });
      dom.viewport.addEventListener('pointerup', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (drag.kind === 'rotate') {
          const degrees = drag.degrees;
          cancelDrag();
          if (Math.abs(degrees % 360) > 1e-6) rotate(degrees);
          return;
        }
        if (!drag.moved) {
          // A click, not a drag: nothing moves and no undo step is added.
          const { collapseTo } = drag;
          cancelDrag();
          if (collapseTo !== null) { selectOnly(collapseTo); markSelection(); announceSelection(); sync(); }
          return;
        }
        previewMove(event.altKey);
        const { model, members, dx, dy, pendingEdits, snap } = drag;
        cancelDrag();
        if (Math.hypot(dx, dy) < 1e-6 || !pendingEdits) { positionHandle(); return; }
        const edits = clone(model.edits), indices = [];
        members.forEach((member, k) => {
          const index = edits.findIndex(e => e.sourceIndex === member.sourceIndex);
          if (index >= 0) { edits[index] = pendingEdits[k]; indices.push(index); }
        });
        if (!indices.length) return;
        const placements = core.applyEdits(model.original, edits);
        const reason = validateGroup(placements, indices, model);
        if (reason) { say(reason); return; }
        commit(model, edits);
        if (snap) say('edgeSnapped'); else announceSelection();
      });
      dom.viewport.addEventListener('pointercancel', cancelDrag);
      dom.viewport.addEventListener('lostpointercapture', cancelDrag);
      window.addEventListener('keydown', event => {
        if (!active || event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
            || document.querySelector('.modal-overlay.open, .modal.open')) return;
        if (event.key === 'Alt' && drag?.kind === 'move') { previewMove(true); return; }
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          if (selection.size === 0 || event.ctrlKey || event.metaKey || event.altKey || drag) return;
          event.preventDefault();
          nudge(event);
          return;
        }
        nudgeGroup = null;
        if (event.key === 'Escape') {
          event.preventDefault();
          if (drag) { cancelDrag(); say('hint'); } else exit();
        }
        else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
        else if (event.key.toLowerCase() === 'r' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault(); if (!event.repeat) rotate(event.shiftKey ? 90 : -90);
        }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault(); event.shiftKey ? travel(redo, undo, 'after') : travel(undo, redo, 'before');
        }
      });
      window.addEventListener('keyup', event => {
        if (event.key === nudgeGroup?.key) nudgeGroup = null;
        if (event.key === 'Alt' && drag?.kind === 'move') previewMove(false);
      });
      window.addEventListener('blur', () => { nudgeGroup = null; cancelDrag(); });
      window.addEventListener('nest-status-changed', sync);
      // SVG transforms change on zoom and pan; keep the handle a constant screen size.
      const observer = new MutationObserver(() => { updateSelectionOverlay(); positionHandle(); });
      observer.observe(dom.svgContainer, { attributes: true, childList: true, subtree: true });
      new ResizeObserver(positionHandle).observe(dom.viewport);
      dom.viewport.addEventListener('scroll', positionHandle, { passive: true });
      window.addEventListener('resize', positionHandle);
      window.addEventListener('nest-language-changed', () => { sync(); say('hint'); });
      window.addEventListener('nest-canvas-rendered', () => {
        cancelDrag();
        if (displayedStrip !== currentStrip()) clearSelection();
        displayedStrip = currentStrip();
        sync();
      });
      sync();
    }

    const toggleEditing = () => (active ? exit() : enter());
    return { bind, sync, svgForStrip, exit, toggle: toggleEditing, resetLayout, canReset, isActive: () => active };
  }
  root.NestPlacementEditorView = { createPlacementEditorView };
})(window);
