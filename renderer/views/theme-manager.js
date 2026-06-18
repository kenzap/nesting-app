'use strict';

(function defineThemeManager(globalScope) {
  const { t, setLanguage } = globalScope.NestI18n;

  /**
   * Applies the theme by setting data-theme on <html>.
   * 'dark' = no attribute (default CSS), 'light' = data-theme="light".
   */
  function applyTheme(theme) {
    const html = document.documentElement;
    if (theme === 'light') {
      html.setAttribute('data-theme', 'light');
    } else {
      html.removeAttribute('data-theme');
    }
  }

  /**
   * Translates all elements with data-i18n attributes.
   * Uses innerHTML for elements that may contain HTML (like <strong> tags).
   */
  function translateDOM() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const translated = t(key);
      // Use innerHTML only if the translation contains HTML tags
      if (/<[a-z][\s\S]*>/i.test(translated)) {
        el.innerHTML = translated;
      } else {
        el.textContent = translated;
      }
    });

    // Translate placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.placeholder = t(key);
    });

    // Translate titles
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      el.title = t(key);
    });

    // Translate <option> elements inside selects that have data-i18n-options
    document.querySelectorAll('select[data-i18n-options]').forEach(select => {
      select.querySelectorAll('option[data-i18n]').forEach(option => {
        const key = option.getAttribute('data-i18n');
        option.textContent = t(key);
      });
      if (typeof select._syncCustomSelect === 'function') {
        select._syncCustomSelect();
      }
    });

    // Update the <html> lang attribute
    const lang = globalScope.NestI18n.getLanguage();
    document.documentElement.lang = lang;
  }

  /**
   * Sets the language globally and re-translates the entire DOM.
   */
  function applyLanguage(lang) {
    setLanguage(lang);
    translateDOM();
  }

  globalScope.NestThemeManager = {
    applyTheme,
    applyLanguage,
    translateDOM,
  };
})(window);
