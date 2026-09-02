'use strict';

const i18next = require('i18next');
const translations = require('./locales');

const DEFAULT_LANGUAGE = 'en';
const SUPPORTED_LANGUAGES = Object.keys(translations);
const LANGUAGE_PREFERENCES = ['auto', ...SUPPORTED_LANGUAGES];

function normalizeLanguagePreference(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  return LANGUAGE_PREFERENCES.includes(normalized) ? normalized : 'auto';
}

function resolveLanguage(preference = 'auto', systemLocale = '') {
  const normalizedPreference = normalizeLanguagePreference(preference);
  if (normalizedPreference !== 'auto') return normalizedPreference;
  const systemLanguage = String(systemLocale || '').trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  return SUPPORTED_LANGUAGES.includes(systemLanguage) ? systemLanguage : DEFAULT_LANGUAGE;
}

function createI18n(language = DEFAULT_LANGUAGE) {
  const instance = i18next.createInstance();
  instance.init({
    lng: resolveLanguage(language),
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    resources: Object.fromEntries(
      Object.entries(translations).map(([code, translation]) => [code, { translation }]),
    ),
    interpolation: { escapeValue: false },
    initImmediate: false,
    showSupportNotice: false,
    returnNull: false,
  });
  return instance;
}

function getTranslationResources() {
  return translations;
}

module.exports = {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  LANGUAGE_PREFERENCES,
  normalizeLanguagePreference,
  resolveLanguage,
  createI18n,
  getTranslationResources,
};
