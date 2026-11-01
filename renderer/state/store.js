'use strict';

(function defineNestStore(globalScope) {
  const PARTS_HISTORY_LIMIT = 10;

  function createAppStore() {
    // The single source of truth for the whole renderer. All modules read from
    // and write to this object — no hidden module-level caches.
    const state = {
      files: [],
      partsHistory: [],
      sheets: [],
      status: 'idle',
      zoom: 1,
      nestResult: null,
      lastExportPath: null,
      settings: {},
      editingSheetId: null,
      activeStripIndex: 0,
      lastPlacementExportItems: null,
      partFitWarnings: [],
      nestInputPath: null,
      // Part spacing (mm) the current nestResult was computed with. Kept apart
      // from the live setting so the result's stats stay correct if the user
      // edits spacing after the run.
      nestRunPartSpacing: 0,
    };

    let persistJobTimer = null;

    function snapshotFiles(files) {
      const { clonePlain, effectiveFileQty } = globalScope.NestHelpers;
      return (Array.isArray(files) ? files : [])
        .filter(file => file && typeof file === 'object' && !Array.isArray(file))
        .map(file => ({
          id: file.id,
          name: file.name,
          size: file.size || 0,
          path: file.path || null,
          bookmark: file.bookmark || null,
          qty: effectiveFileQty(file),
          shapes: clonePlain(file.shapes || null),
          layers: clonePlain(file.layers || null),
          _multiSketchDetection: typeof file._multiSketchDetection === 'boolean' ? file._multiSketchDetection : null,
          _sketchContourMethod: file._sketchContourMethod || null,
          _shapeCacheVersion: Number.isFinite(file._shapeCacheVersion) ? file._shapeCacheVersion : null,
        }));
    }

    function snapshotPartsHistory(entries) {
      return (Array.isArray(entries) ? entries : [])
        .filter(entry => entry && typeof entry.id === 'string' && entry.id
          && Number.isFinite(entry.timestamp) && entry.timestamp >= 0
          && Array.isArray(entry.snapshot))
        .slice(-PARTS_HISTORY_LIMIT)
        .map(entry => ({
          id: entry.id,
          timestamp: entry.timestamp,
          source: entry.source === 'loaded' ? 'loaded' : 'run',
          snapshot: snapshotFiles(entry.snapshot),
        }));
    }

    // Serialises job files, sheets and recent parts history, leaving
    // out runtime-only fields like nestResult or zoom. This is the shape that
    // gets written to the job-state JSON file on disk.
    function snapshotJobState() {
      return {
        files: snapshotFiles(state.files),
        partsHistory: snapshotPartsHistory(state.partsHistory),
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
      if (persistJobTimer) window.clearTimeout(persistJobTimer);
      persistJobTimer = null;
      if (!window.electronAPI?.saveJobState) return;
      try {
        const result = await window.electronAPI.saveJobState(snapshotJobState());
        if (!result?.success) {
          console.error('[Job State] Failed to save:', result?.error);
        }
      } catch (error) {
        console.error('[Job State] Failed to save:', error);
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

    // Reads the saved job-state file on startup and restores files, sheets and history into
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
        ? result.state.files.map(file => ({
            ...file,
            qty: effectiveFileQty(file),
            _multiSketchDetection: typeof file?._multiSketchDetection === 'boolean' ? file._multiSketchDetection : null,
            _sketchContourMethod: file?._sketchContourMethod || null,
            _shapeCacheVersion: Number.isFinite(file?._shapeCacheVersion) ? file._shapeCacheVersion : null,
          }))
        : [];
      state.sheets = Array.isArray(result.state.sheets) ? result.state.sheets : [];
      state.partsHistory = snapshotPartsHistory(result.state.partsHistory);
      return state.files.length > 0 || state.sheets.length > 0 || state.partsHistory.length > 0;
    }

    return {
      state,
      snapshotJobState,
      persistJobStateNow,
      schedulePersistJobState,
      hydrateJobState,
    };
  }

  globalScope.NestStore = { createAppStore, PARTS_HISTORY_LIMIT };
})(window);
