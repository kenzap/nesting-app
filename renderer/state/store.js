'use strict';

(function defineNestStore(globalScope) {
  function createAppStore() {
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

    function snapshotJobState() {
      const { clonePlain, effectiveFileQty } = globalScope.NestHelpers;
      return {
        files: state.files.map(file => ({
          id: file.id,
          name: file.name,
          size: file.size || 0,
          path: file.path || null,
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

    async function persistJobStateNow() {
      if (!window.electronAPI?.saveJobState) return;
      const result = await window.electronAPI.saveJobState(snapshotJobState());
      if (!result?.success) {
        console.error('[Job State] Failed to save:', result?.error);
      }
    }

    function schedulePersistJobState() {
      if (persistJobTimer) window.clearTimeout(persistJobTimer);
      persistJobTimer = window.setTimeout(() => {
        persistJobTimer = null;
        persistJobStateNow();
      }, 120);
    }

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
