'use strict';

(function defineThemeManager(globalScope) {
  function applyTheme(theme) {
    const html = document.documentElement;
    if (theme === 'light') {
      html.setAttribute('data-theme', 'light');
      return;
    }
    html.removeAttribute('data-theme');
  }

  globalScope.NestThemeManager = {
    applyTheme,
  };
})(window);
