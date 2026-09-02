'use strict';

(function defineSettingsModal(globalScope) {
  function createSettingsModal({ state, dom, onSettingsApplied }) {
    const { SETTINGS_DEFAULTS, normalizeSettings } = globalScope.NestSettings;
    const {
      resolveMeasurementSystem,
      unitLabel,
      fromDisplayLength,
      formatInputLength,
    } = globalScope.NestUnits;
    const settingsFields = dom.settingsFields;
    const lengthSettingKeys = new Set(['partSpacing', 'sheetMargin']);
    const measurementSystemField = settingsFields.find(field => field.dataset.settingKey === 'measurementSystem');
    const devOnlyRows = Array.from(document.querySelectorAll('[data-dev-only-setting]'));
    let isDevBuild = false;
    let dialogUnitSystem = resolveMeasurementSystem(SETTINGS_DEFAULTS.measurementSystem);

    // Reads the current value of a single settings field, normalising checkboxes to
    // booleans and number inputs to JS numbers so callers always get the right type.
    function settingFieldValue(field, unitSystem = dialogUnitSystem) {
      if (field.type === 'checkbox') return field.checked;
      if (field.type === 'number') {
        if (field.value === '') return '';
        const displayNumeric = Number(field.value);
        const numeric = lengthSettingKeys.has(field.dataset.settingKey)
          ? fromDisplayLength(displayNumeric, unitSystem)
          : displayNumeric;
        if (!Number.isFinite(numeric)) return '';
        if (lengthSettingKeys.has(field.dataset.settingKey)) return Math.max(0, numeric);
        const min = field.min === '' ? -Infinity : Number(field.min);
        const max = field.max === '' ? Infinity : Number(field.max);
        return Math.min(max, Math.max(min, numeric));
      }
      return field.value;
    }

    // Writes a value back to a settings form field, handling the checkbox/text distinction.
    // Silently skips fields whose key is not present in the provided settings object.
    function applySettingFieldValue(field, value, unitSystem = dialogUnitSystem) {
      if (value === undefined) return;
      if (field.type === 'checkbox') {
        field.checked = !!value;
        return;
      }
      field.value = lengthSettingKeys.has(field.dataset.settingKey)
        ? formatInputLength(value, unitSystem)
        : `${value}`;
      if (typeof field._syncCustomSelect === 'function') field._syncCustomSelect();
    }

    // Reads every [data-setting-key] field in the modal at once and returns them as a plain object.
    // Used before persisting so the saved data always reflects what the user currently sees in the form.
    function collectSettingsFromDialog() {
      const unitSystem = resolveMeasurementSystem(measurementSystemField?.value || 'auto');
      return settingsFields.reduce((acc, field) => {
        acc[field.dataset.settingKey] = settingFieldValue(field, unitSystem);
        return acc;
      }, {});
    }

    // Returns a fresh shallow copy of the built-in settings defaults.
    // Always returns a new object so callers cannot accidentally mutate the originals.
    function dialogDefaults() {
      return { ...SETTINGS_DEFAULTS };
    }

    function applyDevOnlyVisibility() {
      devOnlyRows.forEach(row => {
        row.hidden = !isDevBuild;
      });
    }

    function normalizeDialogSettings(settings) {
      const normalized = normalizeSettings(settings);
      if (!isDevBuild) {
        normalized.sketchContourMethod = SETTINGS_DEFAULTS.sketchContourMethod;
      }
      return normalized;
    }

    // Pushes a settings object into every form field in the modal.
    // Called both on initial open (to show current values) and on reset (to restore defaults).
    function updateLengthFieldPresentation() {
      const label = unitLabel(dialogUnitSystem);
      document.querySelectorAll('#settingsModal [data-length-unit]').forEach(node => {
        node.textContent = label;
      });
      settingsFields.forEach(field => {
        if (!lengthSettingKeys.has(field.dataset.settingKey)) return;
        field.step = dialogUnitSystem === 'imperial' ? '0.001' : (field.dataset.settingKey === 'partSpacing' ? '0.5' : '1');
      });
    }

    function applySettingsToDialog(settings) {
      const preference = settings.measurementSystem || SETTINGS_DEFAULTS.measurementSystem;
      if (measurementSystemField) applySettingFieldValue(measurementSystemField, preference);
      dialogUnitSystem = resolveMeasurementSystem(preference);
      updateLengthFieldPresentation();
      settingsFields.forEach(field => {
        if (field === measurementSystemField) return;
        applySettingFieldValue(field, settings[field.dataset.settingKey], dialogUnitSystem);
      });
    }

    function openSettingsDialog() {
      applySettingsToDialog(currentNestingSettings());
      dom.settingsModal.classList.add('open');
    }

    function closeSettingsDialog() {
      dom.settingsModal.classList.remove('open');
    }

    // Returns the active nesting settings: built-in defaults merged with anything saved to state.
    // Other modules call this instead of reading state.settings directly, so defaults always fill any gaps.
    function currentNestingSettings() {
      return { ...dialogDefaults(), ...state.settings };
    }

    function applyAppearanceSettings() {
      if (globalScope.NestThemeManager?.applyTheme) {
        globalScope.NestThemeManager.applyTheme(state.settings?.theme);
      }
      const measurementSystem = resolveMeasurementSystem(state.settings?.measurementSystem);
      document.documentElement.dataset.measurementSystem = measurementSystem;
      globalScope.dispatchEvent(new CustomEvent('nest-units-changed', {
        detail: { measurementSystem },
      }));
    }

    // Reads the form, normalises the values, saves them to state, and writes through to disk via Electron IPC.
    // Throws if the IPC bridge reports a failure so the caller can surface the error.
    async function persistCurrentSettings() {
      state.settings = normalizeDialogSettings(collectSettingsFromDialog());
      applySettingsToDialog(state.settings);
      if (!window.electronAPI?.saveAppSettings) return;
      const result = await window.electronAPI.saveAppSettings(state.settings);
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to save settings');
      }
    }

    // Loads saved settings from disk on startup and populates the form.
    // Falls back silently to defaults when no data is saved or the Electron bridge is unavailable.
    async function loadPersistedSettings() {
      const defaults = dialogDefaults();
      if (window.electronAPI?.getSystemLocale) {
        try {
          const localeInfo = await window.electronAPI.getSystemLocale();
          const locale = String(localeInfo?.locale || '');
          const countryCode = String(localeInfo?.countryCode || '').toUpperCase();
          const language = locale.replace(/_/g, '-').split('-')[0];
          globalScope.NestUnits.setSystemLocales([
            language && countryCode ? `${language}-${countryCode}` : '',
            locale,
          ]);
        } catch {
          // navigator.languages remains the cross-platform fallback.
        }
      }
      if (window.electronAPI?.getNativeEngineInfo) {
        try {
          const engineInfo = await window.electronAPI.getNativeEngineInfo();
          isDevBuild = !!(engineInfo?.success && !engineInfo?.packaged);
        } catch {
          isDevBuild = false;
        }
      }
      applyDevOnlyVisibility();

      state.settings = normalizeDialogSettings(defaults);
      applySettingsToDialog(state.settings);
      applyAppearanceSettings();

      if (!window.electronAPI?.loadAppSettings) return;
      const result = await window.electronAPI.loadAppSettings();
      if (!result?.success) {
        console.warn('[Settings] Failed to load persisted settings:', result?.error);
        return;
      }

      state.settings = normalizeDialogSettings(result.settings || {});
      applySettingsToDialog(state.settings);
      applyAppearanceSettings();
    }

    // Wires open, close, apply, and reset buttons for the settings modal.
    // Apply persists the form values and fires onSettingsApplied so previews refresh immediately.
    function bind() {
      dom.openSettings.addEventListener('click', openSettingsDialog);
      dom.closeSettings.addEventListener('click', closeSettingsDialog);
      measurementSystemField?.addEventListener('change', () => {
        const valuesMm = new Map(settingsFields
          .filter(field => lengthSettingKeys.has(field.dataset.settingKey))
          .map(field => [field, settingFieldValue(field, dialogUnitSystem)]));
        dialogUnitSystem = resolveMeasurementSystem(measurementSystemField.value);
        updateLengthFieldPresentation();
        valuesMm.forEach((value, field) => applySettingFieldValue(field, value, dialogUnitSystem));
      });
      dom.applySettings.addEventListener('click', async () => {
        try {
          await persistCurrentSettings();
          applyAppearanceSettings();
          closeSettingsDialog();
          if (typeof onSettingsApplied === 'function') onSettingsApplied();
        } catch (err) {
          console.error('[Settings] Failed to persist settings:', err);
        }
      });
      dom.resetSettings.addEventListener('click', async () => {
        state.settings = normalizeDialogSettings(dialogDefaults());
        applySettingsToDialog(state.settings);
        try {
          await persistCurrentSettings();
          applyAppearanceSettings();
          if (typeof onSettingsApplied === 'function') onSettingsApplied();
        } catch (err) {
          console.error('[Settings] Failed to reset settings:', err);
        }
      });
    }

    return {
      dialogDefaults,
      currentNestingSettings,
      loadPersistedSettings,
      persistCurrentSettings,
      applySettingsToDialog,
      open: openSettingsDialog,
      close: closeSettingsDialog,
      bind,
    };
  }

  globalScope.NestSettingsModal = { createSettingsModal };
})(window);
