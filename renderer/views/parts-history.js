'use strict';

// Session-scoped history of the Parts list. Snapshots are captured only at the
// moment a nesting run is initiated, and only when the current parts state
// differs from the previous snapshot. This keeps the stack meaningful —
// every entry represents "the parts list that was actually sent to Sparrow".
// Not persisted; history clears on reload.

(function definePartsHistory(globalScope) {
  const MAX_ENTRIES = 10;

  function createPartsHistory({ state, dom, renderFiles, schedulePersistJobState }) {
    state.partsHistory = Array.isArray(state.partsHistory) ? state.partsHistory : [];
    let initialSnapshot = deepClone(state.files || []);
    let popoverEl = null;
    let popoverOpen = false;
    let outsideClickHandler = null;
    let keyHandler = null;
    let tickInterval = null;

    function deepClone(obj) {
      return JSON.parse(JSON.stringify(obj || []));
    }

    // Signature keys only the fields the user actually controls in the list —
    // file identity + per-shape qty/visibility. Async fields (parsed shapes
    // beyond qty/visibility, layer palettes, bookmark tokens) are excluded so
    // hydration alone doesn't trigger a phantom "changed" snapshot.
    function signatureOfFiles(files) {
      if (!Array.isArray(files)) return '[]';
      return JSON.stringify(files.map(f => ({
        name: f?.name || '',
        qty: Number.isFinite(Number(f?.qty)) ? Number(f.qty) : 1,
        shapes: Array.isArray(f?.shapes)
          ? f.shapes.map(s => ({
              id: s?.id || null,
              qty: Number.isFinite(Number(s?.qty)) ? Number(s.qty) : 1,
              visible: s?.visible !== false,
            }))
          : [],
      })));
    }

    function summaryOfFiles(files) {
      const fileCount = Array.isArray(files) ? files.length : 0;
      let partCount = 0;
      (files || []).forEach(f => {
        const perFileQty = Number.isFinite(Number(f?.qty)) ? Math.max(1, Number(f.qty)) : 1;
        const shapes = Array.isArray(f?.shapes) ? f.shapes.filter(s => s?.visible !== false) : [];
        // Prefer per-shape qty when shapes are hydrated; fall back to file-level qty.
        if (shapes.length) {
          shapes.forEach(s => {
            const shapeQty = Number.isFinite(Number(s?.qty)) ? Math.max(1, Number(s.qty)) : 1;
            partCount += shapeQty;
          });
        } else {
          partCount += perFileQty;
        }
      });
      const fileWord = fileCount === 1 ? 'file' : 'files';
      const partWord = partCount === 1 ? 'part' : 'parts';
      return `${fileCount} ${fileWord} · ${partCount} ${partWord}`;
    }

    function pushEntry() {
      const entry = {
        id: `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        signature: signatureOfFiles(state.files),
        summary: summaryOfFiles(state.files),
        snapshot: deepClone(state.files),
      };
      state.partsHistory.push(entry);
      while (state.partsHistory.length > MAX_ENTRIES) state.partsHistory.shift();
      syncIcon();
      if (popoverOpen) renderPopover();
    }

    /**
     * Called right before a nesting run starts. Captures a snapshot only when
     * the current parts list is not identical to the newest existing snapshot
     * — so back-to-back runs on the same list don't spam the stack.
     */
    function recordRunStart() {
      const currentSig = signatureOfFiles(state.files);
      const last = state.partsHistory[state.partsHistory.length - 1];
      if (last && last.signature === currentSig) return;
      pushEntry();
    }

    function restore(entryId) {
      const idx = state.partsHistory.findIndex(e => e.id === entryId);
      if (idx < 0) return;
      const entry = state.partsHistory[idx];
      state.files = deepClone(entry.snapshot);
      renderFiles();
      schedulePersistJobState();
    }

    function restoreInitial() {
      state.files = deepClone(initialSnapshot);
      renderFiles();
      schedulePersistJobState();
    }

    function clearHistory() {
      state.partsHistory = [];
      initialSnapshot = deepClone(state.files);
      syncIcon();
      if (popoverOpen) closePopover();
    }

    // ── icon button in the Parts header ────────────────────────────────────
    function ensureIcon() {
      if (!dom.sidebarActions || dom.partsHistoryBtn) return;
      const btn = document.createElement('button');
      btn.className = 'icon-btn-sm parts-history-btn';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Parts history');
      btn.title = 'Parts history';
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M2 7a5 5 0 1 0 1.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>
          <path d="M2 2v3h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="parts-history-dot" aria-hidden="true"></span>`;
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (popoverOpen) closePopover();
        else openPopover();
      });
      // Insert at the FIRST position so order reads: [history] [trash] [add]
      dom.sidebarActions.insertBefore(btn, dom.sidebarActions.firstChild);
      dom.partsHistoryBtn = btn;
      syncIcon();
    }

    function syncIcon() {
      if (!dom.partsHistoryBtn) return;
      const count = state.partsHistory.length;
      const disabled = count === 0;
      dom.partsHistoryBtn.disabled = disabled;
      dom.partsHistoryBtn.title = disabled
        ? 'No run history yet'
        : `Run history (${count})`;
      dom.partsHistoryBtn.classList.toggle('has-history', !disabled);
      dom.partsHistoryBtn.classList.toggle('active', popoverOpen);
    }

    // ── popover ────────────────────────────────────────────────────────────
    function openPopover() {
      if (!dom.partsHistoryBtn || popoverOpen) return;
      if (!state.partsHistory.length) return;
      popoverEl = document.createElement('div');
      popoverEl.className = 'parts-history-popover';
      popoverEl.addEventListener('click', (e) => e.stopPropagation());
      document.body.appendChild(popoverEl);
      popoverOpen = true;
      renderPopover();
      positionPopover();
      outsideClickHandler = () => closePopover();
      keyHandler = (event) => { if (event.key === 'Escape') closePopover(); };
      window.addEventListener('resize', positionPopover);
      window.addEventListener('scroll', positionPopover, true);
      setTimeout(() => {
        document.addEventListener('click', outsideClickHandler);
        document.addEventListener('keydown', keyHandler);
      }, 0);
      // Refresh relative timestamps every 15s while open
      tickInterval = setInterval(() => { if (popoverOpen) renderPopover(); }, 15000);
      syncIcon();
    }

    function closePopover() {
      if (!popoverOpen) return;
      popoverOpen = false;
      if (popoverEl?.parentNode) popoverEl.parentNode.removeChild(popoverEl);
      popoverEl = null;
      if (outsideClickHandler) document.removeEventListener('click', outsideClickHandler);
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      window.removeEventListener('resize', positionPopover);
      window.removeEventListener('scroll', positionPopover, true);
      if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
      outsideClickHandler = null;
      keyHandler = null;
      syncIcon();
    }

    function positionPopover() {
      if (!popoverEl || !dom.partsHistoryBtn) return;
      const rect = dom.partsHistoryBtn.getBoundingClientRect();
      const w = 288;
      // Anchor top-right of popover under the icon's right edge
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.right - w + 4));
      const top = rect.bottom + 8;
      popoverEl.style.left = `${left}px`;
      popoverEl.style.top = `${top}px`;
    }

    function formatRelative(ts) {
      const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (seconds < 5) return 'just now';
      if (seconds < 60) return `${seconds}s ago`;
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.round(minutes / 60);
      return `${hours}h ago`;
    }

    function escapeHtml(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderPopover() {
      if (!popoverEl) return;
      const entries = [...state.partsHistory].reverse();
      // "Modified" pill on the newest run when the user has edited the list
      // after that run — so they know clicking it will discard those edits.
      const currentSig = signatureOfFiles(state.files);
      const newestSig = entries[0]?.signature;
      const isModifiedSinceLastRun = newestSig && newestSig !== currentSig;

      const items = entries.map((entry, i) => {
        const isNewest = i === 0;
        const badge = isNewest
          ? (isModifiedSinceLastRun
              ? '<span class="parts-history-badge modified">edited since</span>'
              : '<span class="parts-history-badge current">current</span>')
          : '';
        return `
          <li class="parts-history-item${isNewest ? ' newest' : ''}" data-entry-id="${entry.id}" role="button" tabindex="0">
            <span class="parts-history-dot-marker"></span>
            <span class="parts-history-action">
              <strong>${escapeHtml(entry.summary)}</strong>
              <span>Run · ${formatRelative(entry.timestamp)}</span>
            </span>
            ${badge}
          </li>`;
      }).join('');
      popoverEl.innerHTML = `
        <div class="parts-history-header">
          <span>Run history</span>
          <span class="parts-history-count">${state.partsHistory.length} ${state.partsHistory.length === 1 ? 'run' : 'runs'}</span>
        </div>
        <ul class="parts-history-list">${items}</ul>
        <div class="parts-history-footer">
          <button class="parts-history-link" data-history-action="restore-initial">Restore to first load</button>
          <button class="parts-history-link danger" data-history-action="clear">Clear history</button>
        </div>`;

      popoverEl.querySelectorAll('.parts-history-item').forEach(node => {
        node.addEventListener('click', () => {
          const id = node.dataset.entryId;
          if (!id) return;
          restore(id);
          closePopover();
        });
        node.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); node.click(); }
        });
      });
      popoverEl.querySelector('[data-history-action="restore-initial"]')?.addEventListener('click', () => {
        restoreInitial();
        closePopover();
      });
      popoverEl.querySelector('[data-history-action="clear"]')?.addEventListener('click', () => {
        clearHistory();
      });
    }

    // ── public API ─────────────────────────────────────────────────────────
    return {
      init() {
        ensureIcon();
        syncIcon();
      },
      recordRunStart,
      /** Marker for the "first load" baseline; call after initial hydration. */
      captureBaseline() {
        initialSnapshot = deepClone(state.files);
      },
    };
  }

  globalScope.NestPartsHistory = { createPartsHistory };
})(window);
