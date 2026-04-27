'use strict';

(function defineNestStore(globalScope) {
  function createAppStore() {
    // The single source of truth for the whole renderer. All modules read from
    // and write to this object — no hidden module-level caches.
    const state = {
      files: [],
      sheets: [],
      status: 'idle',
      zoom: 1,
      nestResult: null,
      lastExportPath: null,
      settings: {},
      editingSheetId: null,
      activeStripIndex: 0,
      lastPlacementExportItems: null,
      nestInputPath: null,
    };

    let persistJobTimer = null;

    // Serialises just the job-relevant subset of state (files + sheets), leaving
    // out runtime-only fields like nestResult or zoom. This is the shape that
    // gets written to the job-state JSON file on disk.
    function snapshotJobState() {
      const { clonePlain, effectiveFileQty } = globalScope.NestHelpers;
      return {
        files: state.files.map(file => ({
          id: file.id,
          name: file.name,
          size: file.size || 0,
          path: file.path || null,
          bookmark: file.bookmark || null,
          qty: effectiveFileQty(file),
          shapes: clonePlain(file.shapes || null),
          layers: clonePlain(file.layers || null),
        })),
        sheets: state.sheets.map(sheet => ({
          id: sheet.id,
          width: sheet.width ?? null,
          height: sheet.height ?? null,
          widthMode: sheet.widthMode || 'fixed',
          material: sheet.material || '',
        })),
      };
    }

    // Sends the current job snapshot to the main process via IPC so it can be
    // written to the job-state JSON file. Logs an error if the save fails so
    // silent data-loss is visible in the console.
    async function persistJobStateNow() {
      if (!window.electronAPI?.saveJobState) return;
      const result = await window.electronAPI.saveJobState(snapshotJobState());
      if (!result?.success) {
        console.error('[Job State] Failed to save:', result?.error);
      }
    }

    // Debounces disk writes with a 120 ms timer so rapid state changes (e.g.
    // clicking quantity up/down repeatedly) are coalesced into a single write
    // instead of hammering the filesystem on every keystroke.
    function schedulePersistJobState() {
      if (persistJobTimer) window.clearTimeout(persistJobTimer);
      persistJobTimer = window.setTimeout(() => {
        persistJobTimer = null;
        persistJobStateNow();
      }, 120);
    }

    // Reads the saved job-state file on startup and restores files + sheets into
    // state. Returns true if anything was restored so the caller can skip the
    // blank-slate initialisation path.
    async function hydrateJobState() {
      if (!window.electronAPI?.loadJobState) return false;
      const result = await window.electronAPI.loadJobState();
      if (!result?.success) {
        console.warn('[Job State] Failed to load:', result?.error);
        return false;
      }
      if (!result.state) return false;

      const { effectiveFileQty } = globalScope.NestHelpers;
      state.files = Array.isArray(result.state.files)
        ? result.state.files.map(file => ({ ...file, qty: effectiveFileQty(file) }))
        : [];
      state.sheets = Array.isArray(result.state.sheets) ? result.state.sheets : [];
      return state.files.length > 0 || state.sheets.length > 0;
    }

    return {
      state,
      snapshotJobState,
      persistJobStateNow,
      schedulePersistJobState,
      hydrateJobState,
    };
  }

  globalScope.NestStore = { createAppStore };
})(window);
