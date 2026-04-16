'use strict';

(function defineSettingsModal(globalScope) {
  function createSettingsModal({ state, dom, onSettingsApplied }) {
    const { SETTINGS_DEFAULTS, normalizeSettings } = globalScope.NestSettings;
    const settingsFields = dom.settingsFields;

    function settingFieldValue(field) {
      if (field.type === 'checkbox') return field.checked;
      if (field.type === 'number') return field.value === '' ? '' : Number(field.value);
      return field.value;
    }

    function applySettingFieldValue(field, value) {
      if (value === undefined) return;
      if (field.type === 'checkbox') {
        field.checked = !!value;
        return;
      }
      field.value = `${value}`;
    }

    function collectSettingsFromDialog() {
      return settingsFields.reduce((acc, field) => {
        acc[field.dataset.settingKey] = settingFieldValue(field);
        return acc;
      }, {});
    }

    function dialogDefaults() {
      return { ...SETTINGS_DEFAULTS };
    }

    function applySettingsToDialog(settings) {
      settingsFields.forEach(field => applySettingFieldValue(field, settings[field.dataset.settingKey]));
    }

    function currentNestingSettings() {
      return { ...dialogDefaults(), ...state.settings };
    }

    async function persistCurrentSettings() {
      state.settings = normalizeSettings(collectSettingsFromDialog());
      if (!window.electronAPI?.saveAppSettings) return;
      const result = await window.electronAPI.saveAppSettings(state.settings);
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to save settings');
      }
    }

    async function loadPersistedSettings() {
      const defaults = dialogDefaults();
      state.settings = { ...defaults };
      applySettingsToDialog(state.settings);

      if (!window.electronAPI?.loadAppSettings) return;
      const result = await window.electronAPI.loadAppSettings();
      if (!result?.success) {
        console.warn('[Settings] Failed to load persisted settings:', result?.error);
        return;
      }

      state.settings = normalizeSettings(result.settings || {});
      applySettingsToDialog(state.settings);
    }

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
        state.settings = normalizeSettings(dialogDefaults());
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
