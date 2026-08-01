'use strict';

(function defineThemeManager(globalScope) {
  let preferredThemeMode = 'system';
  let systemTheme = 'dark';
  let effectiveTheme = null;

  function normalizeThemeMode(theme) {
    if (theme === 'dark' || theme === 'light' || theme === 'system') return theme;
    return 'system';
  }

  function setHtmlTheme(theme) {
    const html = document.documentElement;
    if (theme === 'light') {
      html.setAttribute('data-theme', 'light');
      return;
    }
    html.removeAttribute('data-theme');
  }

  function resolveEffectiveTheme(theme = preferredThemeMode) {
    return normalizeThemeMode(theme) === 'system' ? systemTheme : normalizeThemeMode(theme);
  }

  function emitThemeChanged() {
    globalScope.dispatchEvent(new CustomEvent('nest-theme-changed', {
      detail: {
        mode: preferredThemeMode,
        theme: effectiveTheme,
      },
    }));
  }

  function applyTheme(theme) {
    preferredThemeMode = normalizeThemeMode(theme);
    const nextTheme = resolveEffectiveTheme(preferredThemeMode);
    const changed = effectiveTheme !== nextTheme;
    effectiveTheme = nextTheme;
    setHtmlTheme(nextTheme);
    if (changed) emitThemeChanged();
    return effectiveTheme;
  }

  async function detectInitialSystemTheme() {
    try {
      if (globalScope.electronAPI?.getSystemTheme) {
        const result = await globalScope.electronAPI.getSystemTheme();
        const detected = result?.theme;
        if (detected === 'dark' || detected === 'light') {
          systemTheme = detected;
          return systemTheme;
        }
      }
    } catch {
      // Fall back to browser media query below.
    }

    if (globalScope.matchMedia) {
      systemTheme = globalScope.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return systemTheme;
  }

  function bindSystemThemeChanges() {
    if (globalScope.electronAPI?.onSystemThemeChanged) {
      globalScope.electronAPI.onSystemThemeChanged(({ theme } = {}) => {
        if (theme !== 'dark' && theme !== 'light') return;
        systemTheme = theme;
        if (preferredThemeMode === 'system') applyTheme('system');
      });
      return;
    }

    if (!globalScope.matchMedia) return;
    const media = globalScope.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = event => {
      systemTheme = event.matches ? 'dark' : 'light';
      if (preferredThemeMode === 'system') applyTheme('system');
    };

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handleChange);
    } else if (typeof media.addListener === 'function') {
      media.addListener(handleChange);
    }
  }

  async function init() {
    bindSystemThemeChanges();
    await detectInitialSystemTheme();
    applyTheme(preferredThemeMode);
  }

  globalScope.NestThemeManager = {
    applyTheme,
    init,
    getThemeMode: () => preferredThemeMode,
    getEffectiveTheme: () => effectiveTheme,
  };

  void init();
})(window);
