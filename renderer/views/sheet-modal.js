'use strict';

/**
 * Add / Edit Sheet dialog. Same model and building blocks as setup
 * assistant step 3: a live preview (onboarding-stage.js), a Predefined /
 * Unlimited switch, Width × Length fields and a length-optimization toggle.
 *
 * The hidden #sheetWidthMode select remains the source of truth:
 *   predefined, toggle off → "fixed"
 *   predefined, toggle on  → "max"
 *   unlimited              → "unlimited"
 *
 * Naming follows the sheet model: `sheet.width` / #sheetWidth is the length
 * along the strip (null when unlimited), `sheet.height` / #sheetHeight is the
 * material width across it.
 */
(function defineSheetModal(globalScope) {
  const DEFAULT_WIDTH_MM = 1250;
  const DEFAULT_LENGTH_MM = 3000;
  // Standard 4 × 8 ft stock, so imperial users don't get 49.21 × 118.11 in.
  const IMPERIAL_DEFAULT_WIDTH_MM = 48 * 25.4;
  const IMPERIAL_DEFAULT_LENGTH_MM = 96 * 25.4;

  function createSheetModal({ state, dom, schedulePersistJobState, renderSheets }) {
    const i18n = globalScope.NestI18n;
    const t = i18n.t;
    const tf = (key, fallback, vars) => {
      const translated = t(key, vars || {});
      return translated && translated !== key ? translated : fallback;
    };
    const {
      resolveMeasurementSystem,
      unitLabel,
      fromDisplayLength,
      formatInputLength,
    } = globalScope.NestUnits;

    const setupEl = document.getElementById('sheetSetup');
    const modeSeg = document.getElementById('sheetModeSeg');
    const modeBtns = Array.from(modeSeg.querySelectorAll('.ob-seg-btn[data-mode]'));
    const optCheck = document.getElementById('sheetAllowLengthOpt');
    const titleEl = document.getElementById('sheetModalTitle');
    const stage = globalScope.NestOnboardingStage.create({
      scene: document.getElementById('sheetStageScene'),
      badge: document.getElementById('sheetStageBadge'),
      badgeText: document.getElementById('sheetStageBadgeText'),
      t: tf,
    });

    // Last valid values in mm, so an empty or half-typed field never
    // collapses the preview.
    const dims = { width: DEFAULT_WIDTH_MM, length: DEFAULT_LENGTH_MM };

    function measurementSystem() {
      return resolveMeasurementSystem(state.settings?.measurementSystem);
    }

    function setLengthInput(input, mm) {
      input.value = formatInputLength(mm, measurementSystem(), { imperialPrecision: 2 });
    }

    function readLengthInput(input) {
      return fromDisplayLength(input.value, measurementSystem());
    }

    function formatForStage(mm, { approx = false } = {}) {
      const system = measurementSystem();
      if (approx) {
        const v = system === 'imperial' ? Math.round((mm / 25.4) * 2) / 2 : Math.round(mm / 10) * 10;
        return `≈ ${v} ${unitLabel(system)}`;
      }
      return `${formatInputLength(mm, system, { imperialPrecision: 2 })} ${unitLabel(system)}`;
    }

    function setDimensions(widthMm, lengthMm) {
      dims.width = widthMm;
      dims.length = lengthMm;
      setLengthInput(dom.sheetHeight, widthMm);
      setLengthInput(dom.sheetWidth, lengthMm);
    }

    function setWidthMode(mode) {
      dom.sheetWidthMode.value = mode;
      if (typeof dom.sheetWidthMode._syncCustomSelect === 'function') dom.sheetWidthMode._syncCustomSelect();
      updateSheetModeControls();
    }

    function pushStage() {
      const mode = dom.sheetWidthMode.value;
      stage.update({
        mode: mode === 'unlimited' ? 'unlimited' : 'predefined',
        opt: mode === 'max',
        width: dims.width,
        length: dims.length,
        spacing: Number(state.settings?.partSpacing) || 0,
      });
    }

    // Resets the form to workspace defaults and clears the editing ID, so a
    // subsequent confirm creates a new sheet instead of overwriting one.
    function resetSheetForm() {
      state.editingSheetId = null;
      setWidthMode(state.settings?.defaultSheetWidthMode || 'fixed');
      const imperial = measurementSystem() === 'imperial';
      setDimensions(
        state.settings?.defaultSheetHeight || (imperial ? IMPERIAL_DEFAULT_WIDTH_MM : DEFAULT_WIDTH_MM),
        state.settings?.defaultSheetLength || (imperial ? IMPERIAL_DEFAULT_LENGTH_MM : DEFAULT_LENGTH_MM),
      );
      dom.sheetMaterial.value = state.settings?.material || '';
      dom.confirmSheet.textContent = t('sheet.add');
      if (titleEl) titleEl.textContent = t('sheet.add');
      pushStage();
    }

    function showDialog() {
      dom.sheetModal.classList.add('open');
      stage.snap();
      stage.start();
      stage.replay();
    }

    // Opens in add mode (defaults) or edit mode (pre-filled from a sheet).
    // Only one sheet is supported, so add is a no-op when one exists.
    function openSheetEditor(sheetId = null) {
      if (!sheetId) {
        if (state.sheets.length >= 1) return;
        resetSheetForm();
        showDialog();
        return;
      }

      const sheet = state.sheets.find(entry => entry.id === sheetId);
      if (!sheet) return;

      state.editingSheetId = sheet.id;
      setWidthMode(sheet.widthMode || 'fixed');
      setDimensions(sheet.height ?? DEFAULT_WIDTH_MM, sheet.width ?? (state.settings?.defaultSheetLength || DEFAULT_LENGTH_MM));
      dom.sheetMaterial.value = sheet.material || '';
      dom.confirmSheet.textContent = t('sheet.save');
      if (titleEl) titleEl.textContent = tf('sheet.editTitle', 'Edit Sheet');
      pushStage();
      showDialog();
    }

    // Leaves the form as it is: resetting it here flipped the controls (e.g.
    // the length-optimization switch) back to defaults during the fade-out.
    // Every open fills the form again (add resets it, edit loads the sheet).
    function closeSheetDialog() {
      stage.stop();
      dom.sheetModal.classList.remove('open');
      state.editingSheetId = null;
    }

    // Reflects the select's mode on the switch, the optimization toggle,
    // the length field (∞ in unlimited), the help line and the preview.
    function updateSheetModeControls() {
      const mode = dom.sheetWidthMode.value;
      const uiMode = mode === 'unlimited' ? 'unlimited' : 'predefined';

      modeSeg.dataset.active = uiMode;
      modeBtns.forEach(btn => {
        btn.setAttribute('aria-selected', btn.dataset.mode === uiMode ? 'true' : 'false');
      });
      setupEl.dataset.mode = uiMode;
      setupEl.dataset.opt = mode === 'max' ? 'on' : 'off';
      // Unlimited hides the toggle; leave it as-is so switching back to
      // Predefined restores the user's choice.
      if (mode !== 'unlimited') optCheck.checked = mode === 'max';
      dom.sheetWidth.disabled = uiMode === 'unlimited';

      if (mode === 'unlimited') dom.sheetModeHelp.textContent = t('sheet.unlimitedHelp');
      else if (mode === 'max') dom.sheetModeHelp.textContent = t('sheet.maxHelp');
      else dom.sheetModeHelp.textContent = t('sheet.fixedHelp');

      pushStage();
    }

    function syncUnits() {
      const system = measurementSystem();
      const label = unitLabel(system);
      document.querySelectorAll('#sheetModal [data-sheet-length-unit]').forEach(node => {
        node.textContent = label;
      });
      const step = system === 'imperial' ? '0.001' : '1';
      [dom.sheetWidth, dom.sheetHeight].forEach(input => {
        input.step = step;
        input.min = step;
      });
      stage.setFormatter(formatForStage);
      setLengthInput(dom.sheetHeight, dims.width);
      setLengthInput(dom.sheetWidth, dims.length);
    }

    function onDimInput(key, input) {
      const mm = readLengthInput(input);
      if (!Number.isFinite(mm) || mm <= 0) return;
      dims[key] = mm;
      pushStage();
    }

    function bind() {
      dom.addSheetBtnDialog.addEventListener('click', () => openSheetEditor());
      dom.closeSheet.addEventListener('click', closeSheetDialog);
      dom.cancelSheet.addEventListener('click', closeSheetDialog);

      dom.sheetWidthMode.addEventListener('change', updateSheetModeControls);
      modeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.dataset.mode === 'unlimited') setWidthMode('unlimited');
          else setWidthMode(optCheck.checked ? 'max' : 'fixed');
        });
      });
      optCheck.addEventListener('change', () => setWidthMode(optCheck.checked ? 'max' : 'fixed'));

      dom.sheetHeight.addEventListener('input', () => onDimInput('width', dom.sheetHeight));
      dom.sheetWidth.addEventListener('input', () => onDimInput('length', dom.sheetWidth));
      [dom.sheetHeight, dom.sheetWidth].forEach(input => {
        input.addEventListener('blur', () => {
          setLengthInput(dom.sheetHeight, dims.width);
          setLengthInput(dom.sheetWidth, dims.length);
        });
      });

      globalScope.addEventListener('nest-language-changed', () => {
        if (titleEl) titleEl.textContent = state.editingSheetId ? tf('sheet.editTitle', 'Edit Sheet') : t('sheet.add');
        stage.refreshTranslations();
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
