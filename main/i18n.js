'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  createI18n,
  getTranslationResources,
  normalizeLanguagePreference,
  resolveLanguage,
} = require('../shared/i18n');

const i18n = createI18n('en');
let languagePreference = 'auto';

function readLanguagePreference() {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (!fs.existsSync(settingsPath)) return 'auto';
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
    return normalizeLanguagePreference(settings.language);
  } catch {
    return 'auto';
  }
}

function systemLocale() {
  try {
    return app.getLocale();
  } catch {
    return 'en';
  }
}

function applyLanguage(preference = languagePreference) {
  languagePreference = normalizeLanguagePreference(preference);
  const language = resolveLanguage(languagePreference, systemLocale());
  i18n.changeLanguage(language);
  return { preference: languagePreference, language };
}

function initializeMainI18n() {
  return applyLanguage(readLanguagePreference());
}

function getLocalizationState() {
  return {
    preference: languagePreference,
    language: resolveLanguage(languagePreference, systemLocale()),
    systemLocale: systemLocale(),
  };
}

module.exports = {
  t: i18n.t.bind(i18n),
  applyLanguage,
  getLocalizationState,
  initializeMainI18n,
  getTranslationResources,
};
