'use strict';

(function defineLinuxAppMenu(globalScope) {
  function createLinuxAppMenu() {
    const t = globalScope.NestI18n.t;
    const isLinux = document.body.classList.contains('platform-linux');
    const HELP_URLS = {
      supportUrl: 'https://kenzap.com/nesting-support/',
      releasesUrl: 'https://github.com/kenzap/nesting-app/releases',
      redditUrl: 'https://www.reddit.com/r/kenzap/',
      linkedInUrl: 'https://www.linkedin.com/company/kenzap',
      websiteUrl: 'https://kenzap.com/nesting/',
    };

    const MENUS = {
      app: [
        { key: 'menu.about', options: { product: 'Kenzap Nesting' }, action: 'about', type: 'local' },
        { type: 'separator' },
        { key: 'menu.exit', options: { product: 'Kenzap Nesting' }, action: 'quit', type: 'ipc' },
      ],
      edit: [
        { key: 'menu.settings', action: 'open-settings', type: 'ipc' },
      ],
      view: [
        { key: 'menu.fitToView', action: 'canvas-fit-view', type: 'ipc' },
        { key: 'menu.zoomIn', action: 'canvas-zoom-in', type: 'ipc' },
        { key: 'menu.zoomOut', action: 'canvas-zoom-out', type: 'ipc' },
      ],
      window: [
        { key: 'menu.minimize', action: 'minimize-window', type: 'ipc' },
        { key: 'menu.zoom', action: 'toggle-maximize-window', type: 'ipc' },
        { key: 'menu.close', action: 'close-window', type: 'ipc' },
      ],
      help: [
        { key: 'menu.support', action: 'supportUrl', type: 'url' },
        { key: 'menu.releaseNotes', action: 'releasesUrl', type: 'url' },
        { key: 'menu.diagnosticsFolder', action: 'open-diagnostics-folder', type: 'ipc' },
        { type: 'separator' },
        { key: 'menu.redditCommunity', action: 'redditUrl', type: 'url' },
        { label: 'LinkedIn', action: 'linkedInUrl', type: 'url' },
        { key: 'menu.website', options: { product: 'Kenzap Nesting' }, action: 'websiteUrl', type: 'url' },
      ],
    };

    let openMenuState = null;
    let appMeta = {
      productName: 'Kenzap Nesting',
      description: 'DXF nesting desktop application with live preview and production DXF export.',
      version: '',
      ...HELP_URLS,
    };
    let aboutDialog = null;

    function buildSupportUrl(source) {
      const url = new URL(appMeta.supportUrl || HELP_URLS.supportUrl);
      const environment = String(appMeta.environment || '').trim();
      const version = String(appMeta.version || '').trim();
      if (environment) url.searchParams.set('environment', environment);
      if (version) url.searchParams.set('version', version);
      url.searchParams.set('source', source);
      url.hash = 'form';
      return url.href;
    }

    function ensureAboutDialog() {
      if (aboutDialog) return aboutDialog;

      const overlay = document.createElement('div');
      overlay.className = 'linux-about-overlay';
      overlay.hidden = true;

      const dialog = document.createElement('div');
      dialog.className = 'linux-about-dialog';

      dialog.innerHTML = `
        <button type="button" class="linux-about-close" aria-label="${t('common.close')}">×</button>
        <div class="linux-about-logo" aria-hidden="true">
          <svg width="46" height="46" viewBox="0 0 22 22" fill="none">
            <rect x="1" y="1" width="9" height="6" rx="1.5" fill="#4f8ef7"/>
            <rect x="12" y="1" width="9" height="9" rx="1.5" fill="#4f8ef7" opacity="0.7"/>
            <rect x="1" y="9" width="5" height="12" rx="1.5" fill="#4f8ef7" opacity="0.5"/>
            <rect x="8" y="12" width="13" height="9" rx="1.5" fill="#4f8ef7" opacity="0.85"/>
          </svg>
        </div>
        <div class="linux-about-name"></div>
        <div class="linux-about-version"></div>
        <div class="linux-about-description"></div>
        <div class="linux-about-copy">Copyright © Kenzap Pte Ltd</div>
        <div class="linux-about-actions">
          <button type="button" class="linux-about-btn" data-about-link="websiteUrl">${t('menu.websiteShort')}</button>
          <button type="button" class="linux-about-btn" data-about-link="supportUrl">${t('menu.support')}</button>
        </div>
      `;

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      function close() {
        overlay.hidden = true;
      }

      function open() {
        updateAboutDialog();
        overlay.hidden = false;
      }

      overlay.addEventListener('click', event => {
        if (event.target === overlay) close();
      });

      dialog.querySelector('.linux-about-close').addEventListener('click', close);
      dialog.querySelectorAll('[data-about-link]').forEach(button => {
        button.addEventListener('click', () => {
          const url = button.dataset.aboutLink === 'supportUrl'
            ? buildSupportUrl('about-dialog')
            : appMeta[button.dataset.aboutLink] || HELP_URLS[button.dataset.aboutLink];
          if (url) window.electronAPI?.openExternalUrl?.(url);
        });
      });

      document.addEventListener('keydown', event => {
        if (!overlay.hidden && event.key === 'Escape') close();
      });

      aboutDialog = { overlay, dialog, open, close };
      return aboutDialog;
    }

    function updateAboutDialog() {
      const dialog = ensureAboutDialog().dialog;
      dialog.querySelector('.linux-about-name').textContent = appMeta.productName || 'Kenzap Nesting';
      dialog.querySelector('.linux-about-version').textContent = appMeta.version ? t('common.version', { version: appMeta.version }) : '';
      dialog.querySelector('.linux-about-description').textContent =
        t('app.description');
    }

    async function preloadAppMeta() {
      try {
        const result = await window.electronAPI?.getAppMeta?.();
        if (result?.success && result.meta) {
          appMeta = { ...appMeta, ...result.meta };
          updateAboutDialog();
        }
      } catch {
        // Fall back to local defaults.
      }
    }

    async function invokeMenuItem(item) {
      if (item.type === 'ipc') {
        await window.electronAPI?.appMenuAction?.(item.action);
        return;
      }
      if (item.type === 'url') {
        const targetUrl = item.action === 'supportUrl'
          ? buildSupportUrl('help-menu')
          : appMeta[item.action] || HELP_URLS[item.action];
        if (targetUrl) await window.electronAPI?.openExternalUrl?.(targetUrl);
        return;
      }
      if (item.type === 'local' && item.action === 'about') {
        ensureAboutDialog().open();
      }
    }

    function closeOpenMenu() {
      if (!openMenuState) return;
      const { menu, button, cleanup } = openMenuState;
      cleanup();
      menu.remove();
      button.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
      openMenuState = null;
    }

    function positionMenu(button, menu) {
      const rect = button.getBoundingClientRect();
      const gap = 4;
      const menuRect = menu.getBoundingClientRect();
      const maxLeft = Math.max(gap, window.innerWidth - menuRect.width - gap);
      menu.style.left = `${Math.max(gap, Math.min(rect.left, maxLeft))}px`;
      menu.style.top = `${rect.bottom + gap}px`;
    }

    function openMenu(button, menuName) {
      const items = MENUS[menuName];
      if (!items?.length) return;

      if (openMenuState?.button === button) {
        closeOpenMenu();
        return;
      }
      closeOpenMenu();

      const menu = document.createElement('div');
      menu.className = 'linux-menu-popup';
      menu.setAttribute('role', 'menu');

      items.forEach(item => {
        if (item.type === 'separator') {
          const separator = document.createElement('div');
          separator.className = 'linux-menu-separator';
          menu.appendChild(separator);
          return;
        }

        const entry = document.createElement('button');
        entry.type = 'button';
        entry.className = 'linux-menu-item';
        entry.textContent = t(item.key, item.options);
        entry.setAttribute('role', 'menuitem');
        entry.addEventListener('click', async () => {
          closeOpenMenu();
          await invokeMenuItem(item);
        });
        menu.appendChild(entry);
      });

      document.body.appendChild(menu);
      positionMenu(button, menu);
      button.classList.add('open');
      button.setAttribute('aria-expanded', 'true');

      function onOutsidePointer(event) {
        if (button.contains(event.target) || menu.contains(event.target)) return;
        closeOpenMenu();
      }

      function onKeydown(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeOpenMenu();
          button.focus();
        }
      }

      function cleanup() {
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        document.removeEventListener('keydown', onKeydown, true);
        window.removeEventListener('resize', closeOpenMenu, true);
        window.removeEventListener('scroll', closeOpenMenu, true);
      }

      document.addEventListener('pointerdown', onOutsidePointer, true);
      document.addEventListener('keydown', onKeydown, true);
      window.addEventListener('resize', closeOpenMenu, true);
      window.addEventListener('scroll', closeOpenMenu, true);

      openMenuState = { menu, button, cleanup };
    }

    function bind() {
      if (!isLinux) return;
      const menuBar = document.getElementById('linuxMenuBar');
      if (!menuBar) return;
      menuBar.hidden = false;
      preloadAppMeta();
      ensureAboutDialog();
      globalScope.addEventListener('nest-language-changed', () => {
        closeOpenMenu();
        updateAboutDialog();
      });
      menuBar.querySelectorAll('[data-linux-menu]').forEach(button => {
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => openMenu(button, button.dataset.linuxMenu));
      });
    }

    return {
      bind,
      closeOpenMenu,
    };
  }

  globalScope.NestLinuxAppMenu = { createLinuxAppMenu };
})(window);
