'use strict';

(function defineSheetModal(globalScope) {
  function createSheetModal({ state, dom, schedulePersistJobState, renderSheets }) {
    // Returns true when the current form values exactly match a preset button's dimensions.
    // Used by syncSheetPresetButtons to decide which preset (if any) should appear highlighted.
    function presetMatches(btn) {
      return (
        dom.sheetWidthMode.value === 'fixed' &&
        String(dom.sheetWidth.value) === String(btn.dataset.w) &&
        String(dom.sheetHeight.value) === String(btn.dataset.h)
      );
    }

    // Adds or removes the "active" class on every preset button to reflect the current form state.
    // Called whenever the width, height, or mode inputs change.
    function syncSheetPresetButtons() {
      document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.classList.toggle('active', presetMatches(btn));
      });
    }

    // Resets the modal form to default values (3000 × 1250, fixed mode) and clears the editing ID.
    // Clearing the ID ensures a subsequent submit creates a new sheet instead of overwriting one.
    function resetSheetForm() {
      state.editingSheetId = null;
      dom.sheetWidthMode.value = 'fixed';
      if (typeof dom.sheetWidthMode._syncCustomSelect === 'function') dom.sheetWidthMode._syncCustomSelect();
      dom.sheetHeight.value = '1250';
      dom.sheetWidth.value = '3000';
      dom.sheetMaterial.value = '';
      dom.confirmSheet.textContent = 'Add Sheet';
      updateSheetModeControls();
    }

    // Opens the sheet modal in add mode (blank form) or edit mode (pre-filled from an existing sheet).
    // Guards against adding a second sheet since only one is currently supported.
    function openSheetEditor(sheetId = null) {
      if (!sheetId) {
        if (state.sheets.length >= 1) return;
        resetSheetForm();
        dom.sheetModal.classList.add('open');
        return;
      }

      const sheet = state.sheets.find(entry => entry.id === sheetId);
      if (!sheet) return;

      state.editingSheetId = sheet.id;
      dom.sheetWidthMode.value = sheet.widthMode || 'fixed';
      if (typeof dom.sheetWidthMode._syncCustomSelect === 'function') dom.sheetWidthMode._syncCustomSelect();
      dom.sheetHeight.value = sheet.height ?? 1250;
      dom.sheetWidth.value = sheet.width ?? 3000;
      dom.sheetMaterial.value = sheet.material || '';
      dom.confirmSheet.textContent = 'Save Sheet';
      updateSheetModeControls();
      dom.sheetModal.classList.add('open');
    }

    // Closes the sheet modal and resets the form so the next open always starts clean.
    function closeSheetDialog() {
      dom.sheetModal.classList.remove('open');
      resetSheetForm();
    }

    // Disables the width input when "unlimited" mode is selected and updates the help text
    // to explain what each mode means, then syncs the preset button highlights. Also
    // reflects the current mode on the segmented control and adapts the length field's
    // label and appearance so users see one input treatment per mode instead of a
    // generic "Length" that means different things in different modes.
    function updateSheetModeControls() {
      const mode = dom.sheetWidthMode.value;
      const unlimited = mode === 'unlimited';

      dom.sheetWidth.disabled = unlimited;

      if (unlimited) {
        dom.sheetModeHelp.textContent = 'Strip length has no limit; the engine uses whatever it needs.';
      } else if (mode === 'max') {
        dom.sheetModeHelp.textContent = 'Length is the maximum; sheets may be shorter and the count is calculated automatically.';
      } else {
        dom.sheetModeHelp.textContent = 'Fixed sheet size; the number of sheets is calculated automatically.';
      }

      const lengthLabelEl = document.getElementById('sheetLengthLabel');
      if (lengthLabelEl) {
        lengthLabelEl.textContent = unlimited ? 'Length (∞)' : (mode === 'max' ? 'Up to' : 'Length');
      }
      const lengthWrap = document.getElementById('sheetLengthWrap');
      if (lengthWrap) lengthWrap.classList.toggle('length-infinite', unlimited);

      const seg = document.getElementById('sheetModeSeg');
      if (seg) {
        seg.querySelectorAll('.sheet-mode-btn').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.mode === mode);
          btn.setAttribute('aria-selected', btn.dataset.mode === mode ? 'true' : 'false');
        });
      }

      syncSheetPresetButtons();
    }

    // Wires all modal interactions: open/close buttons, mode dropdown, width/height inputs for
    // preset sync, preset button clicks, and the confirm button that creates or updates the sheet.
    function bind() {
      dom.addSheetBtnDialog.addEventListener('click', () => openSheetEditor());
      dom.closeSheet.addEventListener('click', closeSheetDialog);
      dom.cancelSheet.addEventListener('click', closeSheetDialog);

      dom.sheetWidthMode.addEventListener('change', updateSheetModeControls);
      dom.sheetWidth.addEventListener('input', syncSheetPresetButtons);
      dom.sheetHeight.addEventListener('input', syncSheetPresetButtons);

      // Segmented mode buttons drive the hidden <select> so the rest of the
      // code path (validation, persistence, existing helpers) is unchanged.
      document.querySelectorAll('#sheetModeSeg .sheet-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          dom.sheetWidthMode.value = btn.dataset.mode;
          updateSheetModeControls();
        });
      });

      document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          dom.sheetWidthMode.value = 'fixed';
          if (typeof dom.sheetWidthMode._syncCustomSelect === 'function') dom.sheetWidthMode._syncCustomSelect();
          dom.sheetWidth.value = btn.dataset.w;
          dom.sheetHeight.value = btn.dataset.h;
          updateSheetModeControls();
        });
      });

      dom.confirmSheet.addEventListener('click', () => {
        const mode = dom.sheetWidthMode.value;
        const w = mode === 'unlimited' ? null : parseInt(dom.sheetWidth.value);
        const h = parseInt(dom.sheetHeight.value);
        const mat = dom.sheetMaterial.value.trim();
        if (!h || (mode !== 'unlimited' && !w)) return;

        const sheetData = { width: w, height: h, widthMode: mode, material: mat };

        if (state.editingSheetId) {
          state.sheets = state.sheets.map(sheet =>
            sheet.id === state.editingSheetId ? { ...sheet, ...sheetData } : sheet
          );
        } else {
          if (state.sheets.length >= 1) {
            renderSheets();
            closeSheetDialog();
            return;
          }
          state.sheets.push({ id: globalScope.NestHelpers.uid(), ...sheetData });
        }
        renderSheets();
        closeSheetDialog();
        schedulePersistJobState();
      });
    }

    return {
      openSheetEditor,
      closeSheetDialog,
      updateSheetModeControls,
      bind,
    };
  }

  globalScope.NestSheetModal = { createSheetModal };
})(window);
