'use strict';

(function defineFilesPane(globalScope) {
  function createFilesPane({ state, dom, schedulePersistJobState, hydrateFileShapesForList }) {
    const t = globalScope.NestI18n.t;
    const { uid, formatBytes, effectiveFileQty } = globalScope.NestHelpers;
    state.partFitWarnings = Array.isArray(state.partFitWarnings) ? state.partFitWarnings : [];

    function fitWarningForFile(fileId) {
      const matches = state.partFitWarnings.filter(warning => warning?.fileId === fileId);
      if (!matches.length) return null;
      return {
        count: matches.length,
        message: matches.map(warning => warning.message).filter(Boolean).join('\n'),
      };
    }

    // Rebuilds the DXF files sidebar so it matches current state.
    // Shows each file's shape count, size, and total qty, wires up the ✕ remove buttons,
    // and disables the Clear button when the list is empty.
    function renderFiles() {
      dom.fileList.innerHTML = '';
      if (dom.clearFilesBtn) dom.clearFilesBtn.disabled = state.files.length === 0;
      state.files.forEach(f => {
        const fitWarning = fitWarningForFile(f.id);
        const shapeCount = Array.isArray(f.shapes)
          ? f.shapes.filter(shape => shape.visible !== false).length
          : 0;
        const shapeLabel = t('parts.shapeCount', { count: shapeCount });
        const li = document.createElement('li');
        li.className = `file-item${fitWarning ? ' part-fit-error' : ''}`;
        if (fitWarning) {
          li.setAttribute('aria-invalid', 'true');
          li.setAttribute('aria-label', `${f.name}. ${fitWarning.message}`);
        }
        li.innerHTML = `
          <div class="file-icon">DXF</div>
          <div class="file-info">
            <div class="file-name" title="${f.name}">${f.name}${fitWarning ? `
              <span class="fit-pill" role="status">${t('parts.tooLarge')}</span>` : ''}</div>
            <div class="file-size">${shapeLabel} · ${formatBytes(f.size)}</div>
          </div>
          <div class="file-qty-total">${effectiveFileQty(f)}</div>
          <button class="file-remove" data-id="${f.id}" title="${t('common.remove')}">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M9 1L1 9M1 1l8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
          </button>`;
        const fitPill = li.querySelector('.fit-pill');
        if (fitPill) fitPill.title = fitWarning.message;
        li.addEventListener('click', e => {
          if (!e.target.closest('.file-remove')) {
            if (window.openDXFPreview) window.openDXFPreview(f.id, f.name);
          }
        });

        dom.fileList.appendChild(li);
      });

      dom.fileList.querySelectorAll('.file-remove').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          state.files = state.files.filter(x => x.id !== btn.dataset.id);
          renderFiles();
          schedulePersistJobState();
        });
      });

      dom.dropZone.style.display = 'flex';
    }

    function setFitWarnings(warnings = []) {
      state.partFitWarnings = Array.isArray(warnings) ? warnings.filter(warning => warning?.fileId) : [];
      renderFiles();
      if (!state.partFitWarnings.length) return;
      requestAnimationFrame(() => {
        dom.fileList.querySelector('.part-fit-error')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }

    // Accepts an array of file objects and adds them to state, skipping duplicates by name.
    // Kicks off background DXF parsing for each new file so shapes are ready before the user runs nesting.
    function addFiles(fileObjs) {
      const newlyAdded = [];
      fileObjs.forEach(f => {
        if (!state.files.find(x => x.name === f.name)) {
          const file = {
            id: uid(),
            name: f.name,
            size: f.size || 0,
            path: f.path || null,
            bookmark: f.bookmark || null,
            qty: 1,
          };
          state.files.push(file);
          newlyAdded.push(file);
        }
      });
      renderFiles();
      schedulePersistJobState();
      newlyAdded.forEach(file => {
        void hydrateFileShapesForList(file, () => {
          renderFiles();
          schedulePersistJobState();
        });
      });
    }

    // Removes a single file from state by its ID and refreshes the list.
    // Returns true when a file was actually found and removed, so callers can decide whether to persist.
    function removeJobFileById(fileId) {
      if (!fileId) return false;
      const before = state.files.length;
      state.files = state.files.filter(file => file.id !== fileId);
      if (state.files.length !== before) {
        renderFiles();
        return true;
      }
      return false;
    }

    // Wires the Clear-all button and the Add-file button to their respective actions.
    // In Electron the Add-file button opens the native file picker; in the browser it loads three demo files.
    function bind() {
      dom.clearFilesBtn?.addEventListener('click', () => {
        if (!state.files.length) return;
        state.files = [];
        renderFiles();
        schedulePersistJobState();
      });

      dom.addFileBtn.addEventListener('click', async () => {
        if (window.electronAPI) {
          const files = await window.electronAPI.openFileDialog();
          addFiles(files);
        } else {
          addFiles([
            { name: 'bracket_L.dxf', size: 14200 },
            { name: 'panel_A.dxf', size: 28400 },
            { name: 'gusset_01.dxf', size: 9100 },
          ]);
        }
      });
    }

    return {
      renderFiles,
      addFiles,
      removeJobFileById,
      setFitWarnings,
      bind,
    };
  }

  globalScope.NestFilesPane = { createFilesPane };
})(window);
