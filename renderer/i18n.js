'use strict';

(function defineRendererI18n(globalScope) {
  const instance = globalScope.i18next?.createInstance?.();
  let language = 'en';
  let preference = 'auto';
  let pendingState = null;
  let lastAnnouncement = '';

  function t(key, options = {}) {
    if (!instance?.isInitialized) return String(key || '');
    return instance.t(String(key || ''), options);
  }

  function applyTranslations(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(node => {
      node.textContent = t(node.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(node => {
      node.title = t(node.dataset.i18nTitle);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(node => {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    });
    root.querySelectorAll('[data-i18n-aria-label]').forEach(node => {
      node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
    });
    root.querySelectorAll('select[data-custom-select-enhanced="true"]').forEach(select => {
      select._syncCustomSelect?.();
    });
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    document.title = 'Kenzap Nesting';
  }

  function announceChange(nextState = {}) {
    language = nextState.language || language;
    preference = nextState.preference || preference;
    const signature = `${preference}:${language}`;
    if (signature === lastAnnouncement) return;
    lastAnnouncement = signature;
    applyTranslations();
    globalScope.dispatchEvent(new CustomEvent('nest-language-changed', {
      detail: { language, preference },
    }));
  }

  async function initialize() {
    try {
      const result = await globalScope.electronAPI?.getLocalization?.();
      if (!result?.success || !instance || !result.resources) {
        applyTranslations();
        return { language, preference };
      }
      const initialState = pendingState || result;
      language = initialState.language || result.language || language;
      preference = initialState.preference || result.preference || preference;
      const supportedLanguages = Object.keys(result.resources);
      await instance.init({
        lng: language,
        fallbackLng: 'en',
        supportedLngs: supportedLanguages,
        resources: Object.fromEntries(
          supportedLanguages.map(code => [code, { translation: result.resources[code] }]),
        ),
        interpolation: { escapeValue: false },
        showSupportNotice: false,
        returnNull: false,
      });
      announceChange({ language, preference });
    } catch {
      applyTranslations();
    }
    return { language, preference };
  }

  async function changeLanguage(nextPreference) {
    try {
      const result = await globalScope.electronAPI?.setAppLanguage?.(nextPreference);
      if (result?.success) {
        if (instance?.isInitialized) await instance.changeLanguage(result.language);
        announceChange(result);
        return result;
      }
    } catch (error) {
      console.warn('[Localization] Could not change language:', error);
    }
    return { success: false, language, preference };
  }

  globalScope.electronAPI?.onAppLanguageChanged?.(async nextState => {
    if (!instance?.isInitialized) {
      pendingState = nextState;
      return;
    }
    if (nextState?.language) await instance.changeLanguage(nextState.language);
    announceChange(nextState);
  });
  globalScope.NestI18n = {
    t,
    initialize,
    changeLanguage,
    applyTranslations,
    getLanguage: () => language,
    getPreference: () => preference,
  };
})(window);
