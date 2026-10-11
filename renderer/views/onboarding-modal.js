'use strict';

/**
 * Onboarding modal — 4-step wizard shown on first launch.
 *
 *   Step 1 — Pick language   (fires `NestI18n.changeLanguage` immediately so
 *                             the rest of the modal re-translates. Native-
 *                             language option labels mean the user can find
 *                             their language even when auto-detect was
 *                             wrong, which happens on Windows when the UI
 *                             display language differs from the regional
 *                             format.)
 *   Step 2 — Pick material    (seeds the workspace via `material-presets.js`)
 *   Step 3 — Confirm setup    (sheet size, part spacing, units toggle)
 *   Step 4 — Opt-in           (feedback / updates checkboxes + email)
 *
 * The modal only opens when `settings.onboardingCompleted === false`.
 * Clicking Skip or Finish both set it to `true`. Re-openable via
 * `open({ force: true })` from the "Setup assistant" row in Settings.
 *
 * Netlify submission (step 4) fires only when at least one opt-in box is
 * ticked AND the email is valid; see `main/ipc/feedback.js` for the
 * endpoint config.
 */
(function defineOnboardingModal(globalScope) {
  function createOnboardingModal({ state, dom, onApplied }) {
    const { SETTINGS_DEFAULTS, MATERIALS_PRIMARY, MATERIALS_OTHER, normalizeSettings } =
      globalScope.NestSettings;
    const { MATERIAL_PRESETS, EXTRA_ICONS = {}, getMaterialPreset } = globalScope.NestMaterialPresets;
    const uid = globalScope.NestHelpers?.uid || (() => 's_' + Math.random().toString(36).slice(2));
    const i18n = globalScope.NestI18n;
    // Translation helper with a safe English fallback. The modal is
    // rendered before i18next finishes initializing on some code paths
    // (e.g. first-launch straight to the modal), so we hard-code sensible
    // English for every key as the second arg.
    const t = (key, fallback, vars) => {
      if (i18n?.t) {
        const translated = vars ? i18n.t(key, vars) : i18n.t(key);
        // Mirror i18next's "missing key" convention — if it just returned
        // the key verbatim, assume no translation and use the fallback.
        if (translated && translated !== key) return translated;
      }
      return fallback;
    };

    const MATERIAL_LABEL_KEYS = {
      metal:      { nameKey: 'onboarding.materials.metalName',      nameFallback: 'Metal',      descKey: 'onboarding.materials.metalDesc',      descFallback: 'Steel, aluminum, stainless steel' },
      wood:       { nameKey: 'onboarding.materials.woodName',       nameFallback: 'Wood',       descKey: 'onboarding.materials.woodDesc',       descFallback: 'Plywood, MDF, hardwood' },
      plastics:   { nameKey: 'onboarding.materials.plasticsName',   nameFallback: 'Plastics',   descKey: 'onboarding.materials.plasticsDesc',   descFallback: 'Acrylic, PETG, polycarbonate' },
      leather:    { nameKey: 'onboarding.materials.leatherName',    nameFallback: 'Leather',    descKey: 'onboarding.materials.leatherDesc',    descFallback: 'Garments, upholstery, accessories' },
      foam:       { nameKey: 'onboarding.materials.foamName',       nameFallback: 'Foam',       descKey: 'onboarding.materials.foamDesc',       descFallback: 'EVA, polyethylene, packaging foam' },
      cardboard:  { nameKey: 'onboarding.materials.cardboardName',  nameFallback: 'Cardboard',  descKey: 'onboarding.materials.cardboardDesc',  descFallback: 'Packaging, prototyping' },
      composites: { nameKey: 'onboarding.materials.compositesName', nameFallback: 'Composites', descKey: 'onboarding.materials.compositesDesc', descFallback: 'Carbon fiber, fiberglass' },
      rubber:     { nameKey: 'onboarding.materials.rubberName',     nameFallback: 'Rubber',     descKey: 'onboarding.materials.rubberDesc',     descFallback: 'Gaskets, seals' },
      textile:    { nameKey: 'onboarding.materials.textileName',    nameFallback: 'Textiles',    descKey: 'onboarding.materials.textileDesc',    descFallback: 'Woven and nonwoven fabrics' },
      paper:      { nameKey: 'onboarding.materials.paperName',      nameFallback: 'Paper',      descKey: 'onboarding.materials.paperDesc',      descFallback: 'Die cutting, drag-knife cutting' },
    };

    const modal = document.getElementById('onboardingModal');
    if (!modal) return { open() {}, close() {} };

    const dots = Array.from(modal.querySelectorAll('.onboarding-dot'));
    const steps = Array.from(modal.querySelectorAll('.onboarding-step'));
    const languageSelect = modal.querySelector('#onboardingLanguage');
    const grid = modal.querySelector('#onboardingMaterialGrid');
    const gridOther = modal.querySelector('#onboardingMaterialGridOther');
    const otherWrap = modal.querySelector('#onboardingOtherWrap');
    // Step 3 naming follows the app's sheet model: `sheet.width` is the
    // length along the strip (null when unlimited), `sheet.height` is the
    // material width across it.
    const lengthInput = modal.querySelector('#onboardingSheetLength');
    const widthInput = modal.querySelector('#onboardingSheetWidth');
    const partSpacingInput = modal.querySelector('#onboardingPartSpacing');
    const setupEl = modal.querySelector('#onboardingSetup');
    const sheetModeSeg = modal.querySelector('#onboardingSheetModeSeg');
    const sheetModeBtns = Array.from(sheetModeSeg.querySelectorAll('.ob-seg-btn[data-mode]'));
    const unitSeg = modal.querySelector('#onboardingUnitSeg');
    const allowLengthOptCheck = modal.querySelector('#onboardingAllowLengthOpt');
    const unitTabs = Array.from(modal.querySelectorAll('.onboarding-tab[data-unit]'));
    const stage = globalScope.NestOnboardingStage.create({
      scene: modal.querySelector('#onboardingStageScene'),
      badge: modal.querySelector('#onboardingStageBadge'),
      badgeText: modal.querySelector('#onboardingStageBadgeText'),
      t,
    });
    const unitLabels = Array.from(modal.querySelectorAll('.onboarding-body [data-length-unit]'));
    const checkFeedback = modal.querySelector('#onboardingOptInFeedback');
    const checkUpdates = modal.querySelector('#onboardingOptInUpdates');
    const optinEl = modal.querySelector('#onboardingOptin');
    const emailBox = modal.querySelector('#onboardingEmailBox');
    const emailInput = modal.querySelector('#onboardingEmail');
    const emailHint = modal.querySelector('#onboardingEmailHint');
    const btnSkip = modal.querySelector('#onboardingSkip');
    const btnBack = modal.querySelector('#onboardingBack');
    const btnNext = modal.querySelector('#onboardingNext');
    const btnFinish = modal.querySelector('#onboardingFinish');

    const TOTAL_STEPS = steps.length; // 4

    // Local wizard state. Not persisted — only the selections that
    // survive Finish/Skip reach `state.settings`.
    let step = 1;
    let selectedMaterial = '';
    let otherExpanded = false;
    let unit = 'metric';
    // Two-dimensional mode state. The onboarding surface shows two tiles
    // ("predefined" vs "unlimited") plus a checkbox under Predefined that
    // allows the optimizer to shrink the length. The resulting
    // persisted `widthMode` is derived in applyPresetToWorkspace():
    //   predefined + no opt → "fixed"
    //   predefined + opt    → "max"
    //   unlimited           → "unlimited"
    // Keeping these as two separate flags here (rather than pre-collapsing)
    // means toggling the checkbox mid-flight doesn't need its own branch.
    let selectedUiMode = 'predefined';
    let allowLengthOpt = false;
    // Canonical values in mm. Inputs only display them, so toggling units
    // back and forth never accumulates rounding drift.
    const dims = { length: 2500, width: 1250, spacing: 3 };
    const DIM_INPUTS = [
      ['length', () => lengthInput],
      ['width', () => widthInput],
      ['spacing', () => partSpacingInput],
    ];

    // ─── Rendering ──────────────────────────────────────────────────────

    // The icons are SVG strings (not emoji) — see shared/material-presets.js.
    // They use `currentColor` for strokes so the card's text color
    // propagates to the glyph, which keeps it visually tied to the card
    // state (muted when idle, accented when selected).
    const CHECK_BADGE = '<span class="material-card-check" aria-hidden="true">'
      + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.4 6.8 11 12 5.4"/></svg></span>';

    function makeCard(key, icon, name, desc, index) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'material-card';
      btn.dataset.material = key;
      btn.style.setProperty('--i', String(index));
      btn.innerHTML = `
        <div class="material-card-icon">${icon}</div>
        <div class="material-card-name">${name}</div>
        <div class="material-card-desc">${desc}</div>
        ${CHECK_BADGE}
      `;
      return btn;
    }

    function renderMaterialGrid(container, keys) {
      container.innerHTML = '';
      keys.forEach((key, index) => {
        const labels = MATERIAL_LABEL_KEYS[key] || { nameKey: '', nameFallback: key, descKey: '', descFallback: '' };
        const btn = makeCard(key, MATERIAL_PRESETS[key]?.icon || '',
          t(labels.nameKey, labels.nameFallback), t(labels.descKey, labels.descFallback), index);
        btn.addEventListener('click', () => selectMaterial(key));
        container.appendChild(btn);
      });
    }

    function renderOtherCard() {
      const btn = makeCard('__other', EXTRA_ICONS.other || '',
        t('onboarding.otherName', 'Other'), t('onboarding.otherDesc', 'Choose another material'),
        MATERIALS_PRIMARY.length);
      btn.classList.add('material-card-other');
      btn.addEventListener('click', () => {
        otherExpanded = true;
        otherWrap.hidden = false;
        updateCardSelection();
        otherWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      grid.appendChild(btn);
    }

    // Rebuild both grids. Called on open and whenever the active language
    // changes so card labels / descriptions pick up the fresh translations.
    function renderAllCards() {
      grid.innerHTML = '';
      renderMaterialGrid(grid, MATERIALS_PRIMARY);
      renderOtherCard();
      renderMaterialGrid(gridOther, MATERIALS_OTHER);
      updateCardSelection();
    }

    function updateCardSelection() {
      const allCards = modal.querySelectorAll('.material-card');
      allCards.forEach(card => {
        const key = card.dataset.material;
        const isSelected = key === selectedMaterial
          || (key === '__other' && otherExpanded && MATERIALS_OTHER.includes(selectedMaterial));
        card.classList.toggle('selected', isSelected);
        card.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      });
    }

    // Replays the icon's spring "pop" on the card that was just picked.
    function popCard(key) {
      const card = modal.querySelector(`.material-card[data-material="${key}"]`);
      if (!card) return;
      card.classList.remove('pop');
      void card.offsetWidth;
      card.classList.add('pop');
    }

    // Cursor-following highlight on the material cards.
    function trackSpotlight(event) {
      const card = event.target.closest?.('.material-card');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - r.left}px`);
      card.style.setProperty('--my', `${event.clientY - r.top}px`);
    }

    function selectMaterial(key) {
      selectedMaterial = key;
      updateCardSelection();
      popCard(key);
      applyPresetToStepTwoFields(getMaterialPreset(key));
      updateFooterState();
    }

    function applyPresetToStepTwoFields(preset) {
      dims.length = preset.sheetWidth;
      dims.width = preset.sheetHeight;
      dims.spacing = preset.partSpacing;
      renderDimInputs();
    }

    const toDisplay = (mm) => (unit === 'imperial' ? mm / 25.4 : mm);
    const fromDisplay = (v) => (unit === 'imperial' ? v * 25.4 : v);
    function formatNumber(mm) {
      const v = toDisplay(mm);
      const p = unit === 'imperial' ? 100 : 10;
      return String(Math.round(v * p) / p);
    }
    function formatWithUnit(mm, { approx = false } = {}) {
      if (!approx) return `${formatNumber(mm)} ${unit === 'imperial' ? 'in' : 'mm'}`;
      const v = unit === 'imperial' ? Math.round((mm / 25.4) * 2) / 2 : Math.round(mm / 10) * 10;
      return `≈ ${v} ${unit === 'imperial' ? 'in' : 'mm'}`;
    }

    function renderDimInputs() {
      DIM_INPUTS.forEach(([key, el]) => {
        el().value = formatNumber(dims[key]);
      });
      pushStage();
    }

    function onDimInput(key, el) {
      const v = Number(el.value);
      if (el.value === '' || !Number.isFinite(v) || v < 0) return;
      if (key !== 'spacing' && v === 0) return;
      dims[key] = fromDisplay(v);
      pushStage();
    }

    function pushStage() {
      stage.update({
        mode: selectedUiMode,
        opt: allowLengthOpt,
        length: dims.length,
        width: dims.width,
        spacing: dims.spacing,
      });
    }

    function setUnit(nextUnit) {
      if (nextUnit !== 'metric' && nextUnit !== 'imperial') return;
      unit = nextUnit;
      unitTabs.forEach(tab => {
        tab.setAttribute('aria-selected', tab.dataset.unit === unit ? 'true' : 'false');
      });
      if (unitSeg) unitSeg.dataset.active = unit;
      const shortUnit = unit === 'imperial' ? 'in' : 'mm';
      unitLabels.forEach(el => { el.textContent = shortUnit; });
      stage.setFormatter(formatWithUnit);
      renderDimInputs();
    }

    function setUiMode(mode) {
      if (!['predefined', 'unlimited'].includes(mode)) return;
      selectedUiMode = mode;
      sheetModeBtns.forEach(btn => {
        btn.setAttribute('aria-selected', btn.dataset.mode === mode ? 'true' : 'false');
      });
      sheetModeSeg.dataset.active = mode;
      setupEl.dataset.mode = mode;
      lengthInput.disabled = mode === 'unlimited';
      pushStage();
    }

    // Switch under Predefined. On = optimizer may shrink the length
    // (persisted as `widthMode: "max"`); off = strict `"fixed"`.
    function setAllowLengthOpt(flag) {
      allowLengthOpt = !!flag;
      allowLengthOptCheck.checked = allowLengthOpt;
      setupEl.dataset.opt = allowLengthOpt ? 'on' : 'off';
      pushStage();
    }

    // Resolves the current (uiMode, allowLengthOpt) pair down to the
    // single-string `widthMode` the rest of the app stores on sheets.
    function resolvedWidthMode() {
      if (selectedUiMode === 'unlimited') return 'unlimited';
      return allowLengthOpt ? 'max' : 'fixed';
    }

    function updateStep(nextStep) {
      const prev = step;
      step = Math.max(1, Math.min(TOTAL_STEPS, nextStep));
      // Direction drives the slide-in keyframe (forward from the right,
      // back from the left).
      modal.dataset.dir = step < prev ? 'back' : 'fwd';
      steps.forEach(section => {
        section.hidden = Number(section.dataset.step) !== step;
      });
      if (step === 3) {
        stage.start();
        if (prev !== 3) stage.replay();
      } else {
        stage.stop();
      }
      dots.forEach(dot => {
        const idx = Number(dot.dataset.stepDot);
        dot.classList.toggle('active', idx === step);
        dot.classList.toggle('done', idx < step);
      });
      updateFooterState();
    }

    function updateFooterState() {
      btnSkip.hidden = step !== 1;
      btnBack.hidden = step === 1;
      btnNext.hidden = step === TOTAL_STEPS;
      btnFinish.hidden = step !== TOTAL_STEPS;
      // Step 1 (language): always valid — there's always a selection.
      // Step 2 (material): Next needs a card picked.
      // Step 3 (setup): fields have defaults, always valid.
      // Step 4 (opt-in): Finish is always enabled; email is validated on click.
      if (step === 2) {
        btnNext.disabled = !selectedMaterial;
      } else {
        btnNext.disabled = false;
      }
    }

    function updateEmailVisibility() {
      const needsEmail = checkFeedback.checked || checkUpdates.checked;
      optinEl.dataset.email = needsEmail ? 'on' : 'off';
      if (!needsEmail) setEmailError(false);
    }

    function setEmailError(on) {
      emailBox.classList.toggle('invalid', on);
      emailHint.hidden = !on;
      if (on) {
        emailBox.classList.remove('shake');
        void emailBox.offsetWidth;
        emailBox.classList.add('shake');
      }
    }

    function emailLooksValid(value) {
      const trimmed = String(value || '').trim();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    }

    // ─── Language handling ─────────────────────────────────────────────

    async function onLanguagePicked() {
      const nextPreference = languageSelect.value || 'auto';
      // Persist to state and the main process. `NestI18n.changeLanguage`
      // also triggers `applyTranslations` globally — the modal picks that
      // up via the `nest-language-changed` listener below, which re-renders
      // the dynamically-generated material cards.
      if (state.settings) state.settings.language = nextPreference;
      if (i18n?.changeLanguage) {
        try {
          await i18n.changeLanguage(nextPreference);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[onboarding] language change failed:', err);
        }
      }
    }

    function handleLanguageChanged() {
      i18n?.applyTranslations?.(modal);
      renderAllCards();
      stage.refreshTranslations();
    }

    // ─── Finalization ───────────────────────────────────────────────────

    function applyPresetToWorkspace() {
      const nextSettings = { ...(state.settings || SETTINGS_DEFAULTS) };
      // Language was already applied via NestI18n.changeLanguage, but we
      // still echo it into settings so `saveAppSettings` persists the
      // choice to disk.
      nextSettings.language = languageSelect.value || nextSettings.language || 'auto';
      nextSettings.material = selectedMaterial;
      nextSettings.measurementSystem = unit;

      nextSettings.partSpacing = Math.max(0, dims.spacing);
      nextSettings.defaultSheetWidthMode = resolvedWidthMode();
      nextSettings.defaultSheetLength = Math.max(1, Math.round(dims.length));
      nextSettings.defaultSheetHeight = Math.max(1, Math.round(dims.width));
      nextSettings.onboardingCompleted = true;
      nextSettings.optInFeedback = !!checkFeedback.checked;
      nextSettings.optInUpdates = !!checkUpdates.checked;
      nextSettings.email = (nextSettings.optInFeedback || nextSettings.optInUpdates)
        ? String(emailInput.value || '').trim()
        : '';
      state.settings = normalizeSettings(nextSettings);

      if (!Array.isArray(state.sheets)) state.sheets = [];
      const sheetData = {
        // Same shape the sheet editor writes: unlimited strips have no length.
        width: selectedUiMode === 'unlimited' ? null : state.settings.defaultSheetLength,
        height: state.settings.defaultSheetHeight,
        widthMode: state.settings.defaultSheetWidthMode,
        material: selectedMaterial,
      };
      if (state.sheets.length > 0) {
        state.sheets[0] = { ...state.sheets[0], ...sheetData };
      } else if (selectedMaterial) {
        state.sheets.push({ id: uid(), ...sheetData });
      }
    }

    async function persistSettings() {
      if (!window.electronAPI?.saveAppSettings) return;
      try {
        await window.electronAPI.saveAppSettings(state.settings);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[onboarding] failed to persist settings:', err);
      }
    }

    async function submitFeedback() {
      // Taken from the dialog's own selections, in canonical millimeters.
      const unlimited = selectedUiMode === 'unlimited';
      const payload = {
        materialType: selectedMaterial || '',
        mode: selectedUiMode,
        lengthOptimization: unlimited ? 'n/a' : (allowLengthOpt ? 'yes' : 'no'),
        sheetWidthMm: Math.round(dims.width),
        sheetLengthMm: unlimited ? '' : Math.round(dims.length),
        partSpacingMm: Math.round(dims.spacing * 10) / 10,
        units: state.settings?.measurementSystem || 'auto',
        language: state.settings?.language || 'auto',
        optInFeedback: state.settings?.optInFeedback ? 'yes' : 'no',
        optInUpdates: state.settings?.optInUpdates ? 'yes' : 'no',
        email: state.settings?.email || '',
      };
      if (!window.electronAPI?.submitOnboarding) return;
      try {
        const result = await window.electronAPI.submitOnboarding(payload);
        if (!result?.success) {
          // eslint-disable-next-line no-console
          console.warn('[onboarding] submission not accepted:', result?.error || 'unknown');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[onboarding] submission failed:', err);
      }
    }

    async function finish() {
      const needsEmail = checkFeedback.checked || checkUpdates.checked;
      if (needsEmail && !emailLooksValid(emailInput.value)) {
        setEmailError(true);
        emailInput.focus();
        return;
      }
      applyPresetToWorkspace();
      await persistSettings();
      if ((state.settings?.optInFeedback || state.settings?.optInUpdates)
          && state.settings?.email) {
        submitFeedback(); // fire and forget
      }
      close();
      onApplied?.();
    }

    async function skip() {
      // Language picked in step 1 counts even on Skip — if the user set
      // their language and then skipped the rest, we respect that.
      const nextSettings = {
        ...(state.settings || SETTINGS_DEFAULTS),
        language: languageSelect.value || state.settings?.language || 'auto',
        onboardingCompleted: true,
      };
      state.settings = normalizeSettings(nextSettings);
      await persistSettings();
      close();
      onApplied?.();
    }

    // ─── Open / close ───────────────────────────────────────────────────

    function open({ force = false } = {}) {
      if (!force && state.settings?.onboardingCompleted) return;

      // Prime state from current settings.
      selectedMaterial = state.settings?.material || '';
      otherExpanded = MATERIALS_OTHER.includes(selectedMaterial);
      otherWrap.hidden = !otherExpanded;
      languageSelect.value = state.settings?.language || 'auto';

      // Seed the width-mode tiles + length-opt checkbox from the first
      // sheet already in the workspace (common when re-opening the
      // assistant later). Mapping is the inverse of resolvedWidthMode().
      const existingSheet = state.sheets?.[0];
      const existingMode = existingSheet?.widthMode || state.settings?.defaultSheetWidthMode;
      if (existingMode === 'unlimited') {
        setUiMode('unlimited');
        setAllowLengthOpt(false);
      } else if (existingMode === 'max') {
        setUiMode('predefined');
        setAllowLengthOpt(true);
      } else {
        setUiMode('predefined');
        setAllowLengthOpt(false);
      }

      if (selectedMaterial) {
        applyPresetToStepTwoFields(getMaterialPreset(selectedMaterial));
      } else {
        applyPresetToStepTwoFields(getMaterialPreset(''));
      }
      dims.length = existingSheet?.width ?? (state.settings?.defaultSheetLength || dims.length);
      dims.width = existingSheet?.height ?? (state.settings?.defaultSheetHeight || dims.width);
      if (state.settings?.onboardingCompleted) dims.spacing = state.settings.partSpacing;
      setUnit(state.settings?.measurementSystem === 'imperial' ? 'imperial' : 'metric');
      stage.snap();
      renderAllCards();

      checkFeedback.checked = !!state.settings?.optInFeedback;
      checkUpdates.checked = !!state.settings?.optInUpdates;
      emailInput.value = state.settings?.email || '';
      updateEmailVisibility();

      updateStep(1);
      modal.classList.add('open');
    }

    function close() {
      stage.stop();
      modal.classList.remove('open');
    }

    // ─── Wire listeners ─────────────────────────────────────────────────

    btnNext.addEventListener('click', () => {
      if (step < TOTAL_STEPS) updateStep(step + 1);
    });
    btnBack.addEventListener('click', () => {
      if (step > 1) updateStep(step - 1);
    });
    btnSkip.addEventListener('click', skip);
    btnFinish.addEventListener('click', finish);
    dots.forEach(dot => {
      dot.addEventListener('click', () => {
        const idx = Number(dot.dataset.stepDot);
        // Allow jumping to step 1 (language) at any time, backward
        // navigation to any already-passed step, or forward past step 2
        // only if a material was picked.
        if (idx === 1 || idx <= step || (idx > 2 && selectedMaterial) || idx === 2) {
          updateStep(idx);
        }
      });
      dot.style.cursor = 'pointer';
    });
    unitTabs.forEach(tab => {
      tab.addEventListener('click', () => setUnit(tab.dataset.unit));
    });
    sheetModeBtns.forEach(btn => {
      btn.addEventListener('click', () => setUiMode(btn.dataset.mode));
    });
    allowLengthOptCheck.addEventListener('change', () => {
      setAllowLengthOpt(allowLengthOptCheck.checked);
    });
    DIM_INPUTS.forEach(([key, el]) => {
      el().addEventListener('input', () => onDimInput(key, el()));
      // Normalise the display (e.g. clear an invalid entry) once the
      // user leaves the field.
      el().addEventListener('blur', () => renderDimInputs());
    });
    [checkFeedback, checkUpdates].forEach(ch => {
      ch.addEventListener('change', updateEmailVisibility);
    });
    emailInput.addEventListener('input', () => {
      setEmailError(false);
    });
    languageSelect.addEventListener('change', onLanguagePicked);
    [grid, gridOther].forEach(g => g.addEventListener('pointermove', trackSpotlight));

    // Re-render dynamic content whenever the global i18n layer swaps
    // language. The static `data-i18n` nodes update themselves via
    // `applyTranslations` in i18n.js.
    globalScope.addEventListener('nest-language-changed', handleLanguageChanged);

    return { open, close };
  }

  globalScope.NestOnboardingModal = { createOnboardingModal };
})(typeof window !== 'undefined' ? window : globalThis);
