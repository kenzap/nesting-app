'use strict';

(function defineCustomSelects(globalScope) {
  function createModalCustomSelects() {
    const isLinux = document.body.classList.contains('platform-linux');
    let openController = null;

    function closeOpenMenu() {
      if (!openController) return;
      openController.close();
      openController = null;
    }

    function optionLabel(option) {
      return option?.textContent?.trim() || '';
    }

    function enhanceSelect(select) {
      if (!isLinux || !select || select.dataset.customSelectEnhanced === 'true') return;

      const wrapper = document.createElement('div');
      wrapper.className = 'custom-select';

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'custom-select-trigger';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');

      const triggerLabel = document.createElement('span');
      triggerLabel.className = 'custom-select-label';

      const triggerCaret = document.createElement('span');
      triggerCaret.className = 'custom-select-caret';
      triggerCaret.setAttribute('aria-hidden', 'true');

      trigger.appendChild(triggerLabel);
      trigger.appendChild(triggerCaret);

      select.parentNode.insertBefore(wrapper, select);
      wrapper.appendChild(select);
      wrapper.appendChild(trigger);

      select.classList.add('custom-select-native');
      select.dataset.customSelectEnhanced = 'true';

      const measuredWidth = Math.ceil(select.getBoundingClientRect().width || 0);
      if (measuredWidth > 0) {
        wrapper.style.width = `${measuredWidth}px`;
      }

      function syncTrigger() {
        triggerLabel.textContent = optionLabel(select.selectedOptions?.[0] || select.options?.[0] || null);
      }

      function renderMenu() {
        const menu = document.createElement('div');
        menu.className = 'custom-select-menu';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', select.getAttribute('aria-label') || select.id || 'Select options');

        Array.from(select.options).forEach(option => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'custom-select-option';
          item.textContent = optionLabel(option);
          item.dataset.value = option.value;
          item.setAttribute('role', 'option');
          if (option.disabled) {
            item.disabled = true;
          }
          if (option.selected) {
            item.classList.add('selected');
            item.setAttribute('aria-selected', 'true');
          }
          item.addEventListener('click', () => {
            if (option.disabled) return;
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            syncTrigger();
            closeOpenMenu();
          });
          menu.appendChild(item);
        });

        return menu;
      }

      function positionMenu(menu) {
        const rect = trigger.getBoundingClientRect();
        const gap = 6;
        const menuHeight = menu.offsetHeight;
        const viewportHeight = window.innerHeight;
        const spaceBelow = viewportHeight - rect.bottom;
        const openAbove = spaceBelow < menuHeight + gap && rect.top > spaceBelow;
        const top = openAbove
          ? Math.max(gap, rect.top - menuHeight - gap)
          : Math.min(viewportHeight - menuHeight - gap, rect.bottom + gap);
        const maxLeft = Math.max(gap, window.innerWidth - menu.offsetWidth - gap);
        menu.style.left = `${Math.max(gap, Math.min(rect.left, maxLeft))}px`;
        menu.style.top = `${top}px`;
        menu.style.minWidth = `${Math.ceil(rect.width)}px`;
      }

      function openMenu() {
        closeOpenMenu();

        const menu = renderMenu();
        document.body.appendChild(menu);
        positionMenu(menu);

        wrapper.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');

        const selectedItem = menu.querySelector('.custom-select-option.selected');
        if (selectedItem) selectedItem.scrollIntoView({ block: 'nearest' });

        function close() {
          menu.remove();
          wrapper.classList.remove('open');
          trigger.setAttribute('aria-expanded', 'false');
          document.removeEventListener('pointerdown', handleOutsidePointer, true);
          document.removeEventListener('keydown', handleKeydown, true);
          window.removeEventListener('resize', close, true);
          window.removeEventListener('scroll', close, true);
          if (openController?.close === close) openController = null;
        }

        function handleOutsidePointer(event) {
          if (wrapper.contains(event.target) || menu.contains(event.target)) return;
          close();
        }

        function handleKeydown(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
            trigger.focus();
          }
        }

        document.addEventListener('pointerdown', handleOutsidePointer, true);
        document.addEventListener('keydown', handleKeydown, true);
        window.addEventListener('resize', close, true);
        window.addEventListener('scroll', close, true);
        openController = { close };
      }

      trigger.addEventListener('click', () => {
        if (wrapper.classList.contains('open')) {
          closeOpenMenu();
          return;
        }
        openMenu();
      });

      trigger.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          if (!wrapper.classList.contains('open')) openMenu();
        }
      });

      select.addEventListener('change', syncTrigger);
      select._syncCustomSelect = syncTrigger;
      syncTrigger();
    }

    function enhanceModalSelects() {
      if (!isLinux) return;
      // Skip hidden selects — they're placeholders whose value is driven by
      // a custom control (e.g. the sheet-mode segmented control) and should
      // not sprout a duplicate visible dropdown.
      document.querySelectorAll('.modal-body select:not([hidden])').forEach(enhanceSelect);
    }

    return {
      closeOpenMenu,
      enhanceModalSelects,
    };
  }

  globalScope.NestCustomSelects = { createModalCustomSelects };
})(window);
