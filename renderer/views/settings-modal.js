'use strict';

(function defineSettingsModal(globalScope) {
  function createSettingsModal({ state, dom, onSettingsApplied }) {
    const { SETTINGS_DEFAULTS, normalizeSettings } = globalScope.NestSettings;
    const settingsFields = dom.settingsFields;
    const contourMethodField = settingsFields.find(field => field.dataset.settingKey === 'sketchContourMethod') || null;
    const contourMethodRow = contourMethodField?.closest('[data-dev-only-setting="sketchContourMethod"]') || null;
    let isDevBuild = false;

    // Reads the current value of a single settings field, normalising checkboxes to
    // booleans and number inputs to JS numbers so callers always get the right type.
    function settingFieldValue(field) {
      if (field.type === 'checkbox') return field.checked;
      if (field.type === 'number') return field.value === '' ? '' : Number(field.value);
      return field.value;
    }

    // Writes a value back to a settings form field, handling the checkbox/text distinction.
    // Silently skips fields whose key is not present in the provided settings object.
    function applySettingFieldValue(field, value) {
      if (value === undefined) return;
      if (field.type === 'checkbox') {
        field.checked = !!value;
        return;
      }
      field.value = `${value}`;
    }

    // Reads every [data-setting-key] field in the modal at once and returns them as a plain object.
    // Used before persisting so the saved data always reflects what the user currently sees in the form.
    function collectSettingsFromDialog() {
      return settingsFields.reduce((acc, field) => {
        acc[field.dataset.settingKey] = settingFieldValue(field);
        return acc;
      }, {});
    }

    // Returns a fresh shallow copy of the built-in settings defaults.
    // Always returns a new object so callers cannot accidentally mutate the originals.
    function dialogDefaults() {
      return { ...SETTINGS_DEFAULTS };
    }

    function applyDevOnlyVisibility() {
      if (contourMethodRow) contourMethodRow.hidden = !isDevBuild;
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
    function applySettingsToDialog(settings) {
      settingsFields.forEach(field => applySettingFieldValue(field, settings[field.dataset.settingKey]));
    }

    // Returns the active nesting settings: built-in defaults merged with anything saved to state.
    // Other modules call this instead of reading state.settings directly, so defaults always fill any gaps.
    function currentNestingSettings() {
      return { ...dialogDefaults(), ...state.settings };
    }

    // Reads the form, normalises the values, saves them to state, and writes through to disk via Electron IPC.
    // Throws if the IPC bridge reports a failure so the caller can surface the error.
    async function persistCurrentSettings() {
      state.settings = normalizeDialogSettings(collectSettingsFromDialog());
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

      if (!window.electronAPI?.loadAppSettings) return;
      const result = await window.electronAPI.loadAppSettings();
      if (!result?.success) {
        console.warn('[Settings] Failed to load persisted settings:', result?.error);
        return;
      }

      state.settings = normalizeDialogSettings(result.settings || {});
      applySettingsToDialog(state.settings);
    }

    // Wires open, close, apply, and reset buttons for the settings modal.
    // Apply persists the form values and fires onSettingsApplied so previews refresh immediately.
    function bind() {
      dom.openSettings.addEventListener('click', () => dom.settingsModal.classList.add('open'));
      dom.closeSettings.addEventListener('click', () => dom.settingsModal.classList.remove('open'));
      dom.applySettings.addEventListener('click', async () => {
        try {
          await persistCurrentSettings();
          dom.settingsModal.classList.remove('open');
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
      bind,
    };
  }

  globalScope.NestSettingsModal = { createSettingsModal };
})(window);
