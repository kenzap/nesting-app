'use strict';

(function defineSheetModal(globalScope) {
  const METRIC_PRESETS = [
    { height: 1250, width: 3000 },
    { height: 1500, width: 3000 },
    { height: 2000, width: 4000 },
    { height: 2000, width: 6000 },
  ];
  const IMPERIAL_PRESETS = [
    { height: 48, width: 96 },
    { height: 48, width: 120 },
    { height: 60, width: 120 },
    { height: 72, width: 144 },
  ];

  function createSheetModal({ state, dom, schedulePersistJobState, renderSheets }) {
    const {
      resolveMeasurementSystem,
      unitLabel,
      fromDisplayLength,
      formatInputLength,
    } = globalScope.NestUnits;

    function measurementSystem() {
      return resolveMeasurementSystem(state.settings?.measurementSystem);
    }

    function setLengthInput(input, mm) {
      input.value = formatInputLength(mm, measurementSystem(), { imperialPrecision: 2 });
    }

    function readLengthInput(input) {
      return fromDisplayLength(input.value, measurementSystem());
    }

    function presetDimensions(index, system = measurementSystem()) {
      const preset = (system === 'imperial' ? IMPERIAL_PRESETS : METRIC_PRESETS)[index];
      if (system === 'imperial') {
        return {
          height: fromDisplayLength(preset.height, system),
          width: fromDisplayLength(preset.width, system),
          label: `${preset.height} × ${preset.width}`,
        };
      }
      return { ...preset, label: `${preset.height} × ${preset.width}` };
    }

    function setDefaultSheetDimensions() {
      const preset = presetDimensions(0);
      setLengthInput(dom.sheetHeight, preset.height);
      setLengthInput(dom.sheetWidth, preset.width);
    }

    // Returns true when the current form values exactly match a preset button's dimensions.
    // Used by syncSheetPresetButtons to decide which preset (if any) should appear highlighted.
    function presetMatches(btn) {
      const width = readLengthInput(dom.sheetWidth);
      const height = readLengthInput(dom.sheetHeight);
      return (
        dom.sheetWidthMode.value === 'fixed' &&
        Math.abs(width - Number(btn.dataset.w)) < 0.5 &&
        Math.abs(height - Number(btn.dataset.h)) < 0.5
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
      setDefaultSheetDimensions();
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
      setLengthInput(dom.sheetHeight, sheet.height ?? 1250);
      setLengthInput(dom.sheetWidth, sheet.width ?? 3000);
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

    function syncUnits() {
      const system = measurementSystem();
      const label = unitLabel(system);
      document.querySelectorAll('#sheetModal [data-sheet-length-unit]').forEach(node => {
        node.textContent = label;
      });
      dom.sheetWidth.step = system === 'imperial' ? '0.001' : '1';
      dom.sheetHeight.step = system === 'imperial' ? '0.001' : '1';
      dom.sheetWidth.min = system === 'imperial' ? '0.001' : '1';
      dom.sheetHeight.min = system === 'imperial' ? '0.001' : '1';
      document.querySelectorAll('.preset-btn').forEach((btn, index) => {
        const preset = presetDimensions(index, system);
        btn.dataset.h = String(preset.height);
        btn.dataset.w = String(preset.width);
        btn.textContent = preset.label;
      });

      const editing = state.sheets.find(sheet => sheet.id === state.editingSheetId);
      if (editing) {
        setLengthInput(dom.sheetHeight, editing.height ?? 1250);
        setLengthInput(dom.sheetWidth, editing.width ?? 3000);
      } else if (!dom.sheetModal.classList.contains('open')) {
        setDefaultSheetDimensions();
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
          setLengthInput(dom.sheetWidth, Number(btn.dataset.w));
          setLengthInput(dom.sheetHeight, Number(btn.dataset.h));
          updateSheetModeControls();
        });
      });

      dom.confirmSheet.addEventListener('click', () => {
        const mode = dom.sheetWidthMode.value;
        const w = mode === 'unlimited' ? null : readLengthInput(dom.sheetWidth);
        const h = readLengthInput(dom.sheetHeight);
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
      syncUnits,
      bind,
    };
  }

  globalScope.NestSheetModal = { createSheetModal };
})(window);
