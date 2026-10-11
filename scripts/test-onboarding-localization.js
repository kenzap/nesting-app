'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createI18n, getTranslationResources, resolveLanguage } = require('../shared/i18n');
const settings = require('../shared/settings');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
const modalHtml = html.slice(html.indexOf('id="onboardingModal"'), html.indexOf('id="onboardingFinish"') + 200);

// A small DOM fixture keeps the real controller, i18n service and SVG preview
// under test without starting Electron or submitting any onboarding data.
class Node {
  constructor(attrs = {}) {
    this.attrs = attrs;
    this.dataset = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('data-')) {
        this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      }
    }
    this.className = attrs.class || '';
    this.classList = {
      contains: name => this.classes.has(name),
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      toggle: (name, enabled) => {
        const on = enabled === undefined ? !this.classes.has(name) : enabled;
        if (on) this.classes.add(name);
        else this.classes.delete(name);
        return on;
      },
    };
    this.listeners = new Map();
    this.children = [];
    this.style = { setProperty() {} };
    this.hidden = Object.hasOwn(attrs, 'hidden');
    this.checked = false;
    this.value = '';
    this.textContent = '';
  }

  set className(value) { this.classes = new Set(value.split(/\s+/)); }
  set innerHTML(value) { this.markup = value; this.children = []; }
  get innerHTML() { return this.markup || ''; }
  setAttribute(key, value) { this.attrs[key] = value; }
  appendChild(child) { this.children.push(child); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  async fire(type) {
    for (const fn of this.listeners.get(type) || []) await fn({ target: this });
  }
  focus() {}
  scrollIntoView() {}
  querySelectorAll(selector) {
    const candidates = [...nodes, ...byId('onboardingMaterialGrid').children,
      ...byId('onboardingMaterialGridOther').children];
    return candidates.filter(node => {
      const cls = selector.match(/\.([\w-]+)/)?.[1];
      if (cls && !node.classList.contains(cls)) return false;
      const attr = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]/);
      if (attr && (!Object.hasOwn(node.attrs, attr[1]) &&
          !(attr[1].startsWith('data-') && Object.hasOwn(node.dataset,
            attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()))))) return false;
      if (attr?.[2] !== undefined) {
        const key = attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if ((node.attrs[attr[1]] ?? node.dataset[key]) !== attr[2]) return false;
      }
      return true;
    });
  }
  querySelector(selector) {
    if (selector.startsWith('#')) return byId(selector.slice(1));
    return this.querySelectorAll(selector)[0] || null;
  }
}

function parseNodes(markup) {
  return [...markup.matchAll(/<[a-z][^>]*>/gi)].map(([tag]) => {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
    if (/\shidden(?:\s|>)/.test(tag)) attrs.hidden = '';
    return new Node(attrs);
  });
}
const nodes = parseNodes(modalHtml);
const modal = new Node({ id: 'onboardingModal' });
const byId = id => id === 'onboardingModal' ? modal : nodes.find(node => node.attrs.id === id);
const document = {
  getElementById: byId,
  createElement: () => new Node(),
  querySelectorAll: selector => modal.querySelectorAll(selector),
  documentElement: {},
};
const events = new Map();
const frames = new Map();
let clock = 0;
let frameId = 0;
const context = vm.createContext({
  document, console,
  i18next: require('i18next'),
  NestSettings: settings,
  NestUnits: require('../shared/units'),
  NestHelpers: { uid: () => 'new-sheet' },
  NestMaterialPresets: require('../shared/material-presets'),
  performance: { now: () => clock },
  matchMedia: () => ({ matches: true }),
  requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
  cancelAnimationFrame: id => frames.delete(id),
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  addEventListener: (type, fn) => {
    if (!events.has(type)) events.set(type, []);
    events.get(type).push(fn);
  },
  dispatchEvent: event => { for (const fn of events.get(event.type) || []) fn(event); },
  electronAPI: {
    getLocalization: async () => ({ success: true, language: 'en', preference: 'en', resources: getTranslationResources() }),
    setAppLanguage: async preference => ({ success: true, preference, language: resolveLanguage(preference, 'es-ES') }),
    submitOnboarding: () => { throw new Error('Tests must not submit onboarding data'); },
  },
});
context.window = context;
for (const file of ['renderer/i18n.js', 'renderer/views/onboarding-stage.js', 'renderer/views/onboarding-modal.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

function settlePreview() {
  for (let i = 0; frames.size && i < 500; i++) {
    clock += 50;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(fn => fn(clock));
  }
  assert.equal(frames.size, 0, 'preview must return to idle');
}

async function main() {
  await context.NestI18n.initialize();
  const state = { settings: { ...settings.SETTINGS_DEFAULTS, language: 'en', onboardingCompleted: false }, sheets: [] };
  const controller = context.NestOnboardingModal.createOnboardingModal({ state, dom: {} });
  controller.open();
  const language = byId('onboardingLanguage');
  language.value = 'es';
  await language.fire('change');
  assert.equal(byId('onboardingNext').textContent, getTranslationResources().es.onboarding.next,
    'the language-selection step must translate immediately');
  await byId('onboardingNext').fire('click');
  await modal.querySelector('.material-card[data-material="__other"]').fire('click');
  await modal.querySelector('.material-card[data-material="rubber"]').fire('click');
  await byId('onboardingNext').fire('click');
  await modal.querySelector('.onboarding-tab[data-unit="imperial"]').fire('click');
  byId('onboardingSheetLength').value = '96';
  await byId('onboardingSheetLength').fire('input');
  byId('onboardingAllowLengthOpt').checked = true;
  await byId('onboardingAllowLengthOpt').fire('change');
  byId('onboardingOptInFeedback').checked = true;
  byId('onboardingEmail').value = 'unfinished-email';
  await byId('onboardingFinish').fire('click');
  settlePreview();

  const inputs = ['onboardingSheetLength', 'onboardingSheetWidth', 'onboardingPartSpacing'];
  const values = inputs.map(id => byId(id).value);
  const savedPct = Number(byId('onboardingStageBadgeText').textContent.match(/\d+/)[0]);
  for (const code of Object.keys(getTranslationResources())) {
    language.value = code;
    await language.fire('change');
    const expected = createI18n(code);
    for (const node of modal.querySelectorAll('[data-i18n]')) {
      assert.equal(node.textContent, expected.t(node.dataset.i18n), `${code}: ${node.dataset.i18n}`);
    }
    assert.equal(byId('onboardingEmail').placeholder, expected.t('onboarding.emailPlaceholder'));
    assert.equal(language.attrs['aria-label'], expected.t('language.label'));
    const selected = modal.querySelector('.material-card[data-material="rubber"]');
    assert.ok(selected.innerHTML.includes(expected.t('onboarding.materials.rubberName')));
    assert.ok(selected.innerHTML.includes(expected.t('onboarding.materials.rubberDesc')));
    assert.ok(selected.classList.contains('selected'));
    assert.equal(byId('onboardingOtherWrap').hidden, false);
    assert.deepEqual(inputs.map(id => byId(id).value), values);
    assert.equal(byId('onboardingUnitSeg').dataset.active, 'imperial');
    assert.equal(byId('onboardingEmail').value, 'unfinished-email');
    assert.equal(byId('onboardingEmailHint').hidden, false);
    assert.equal(byId('onboardingOptInFeedback').checked, true);
    assert.equal(modal.querySelectorAll('.onboarding-step').find(node => !node.hidden).dataset.step, '3');
    assert.equal(document.documentElement.dir, code === 'ar' ? 'rtl' : 'ltr');
    assert.equal(state.settings.language, code);
    assert.equal(byId('onboardingStageBadgeText').textContent, expected.t('onboarding.lengthSaved', { pct: savedPct }),
      `${code}: idle preview badge must update without waiting for animation`);
    settlePreview();
    byId('onboardingAllowLengthOpt').checked = false;
    await byId('onboardingAllowLengthOpt').fire('change');
    settlePreview();
    assert.ok(byId('onboardingStageScene').innerHTML.includes(expected.t('onboarding.unused')),
      `${code}: SVG waste label must translate`);
    byId('onboardingAllowLengthOpt').checked = true;
    await byId('onboardingAllowLengthOpt').fire('change');
    settlePreview();
  }
  language.value = 'auto';
  await language.fire('change');
  assert.equal(context.NestI18n.getLanguage(), 'es');
  assert.equal(state.settings.language, 'auto');
  assert.equal(document.documentElement.dir, 'ltr');
  controller.close();
  await testWorkspaceDefaults(state, controller);
  console.log('Onboarding localization verified across 14 languages, including live labels and preserved selections.');
}

async function testWorkspaceDefaults(state, wizard) {
  nodes.push(...parseNodes(html.slice(html.indexOf('<div class="modal-overlay" id="sheetModal"'), html.indexOf('<div class="app-shell"'))));
  for (const file of ['renderer/views/sheet-modal.js', 'renderer/views/settings-modal.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  let saved;
  context.electronAPI.saveAppSettings = async value => {
    saved = JSON.parse(JSON.stringify(value));
    return { success: true };
  };
  const dom = Object.fromEntries(['sheetModal', 'sheetWidthMode', 'sheetHeight', 'sheetWidth', 'sheetMaterial',
    'sheetModeHelp', 'confirmSheet', 'closeSheet', 'cancelSheet'].map(id => [id, byId(id)]));
  dom.addSheetBtnDialog = new Node();
  let persisted = 0;
  const editor = context.NestSheetModal.createSheetModal({
    state, dom, renderSheets() {}, schedulePersistJobState: () => { persisted++; },
  });
  editor.bind();
  state.settings.material = 'rubber';
  state.sheets = [{ id: 'existing-sheet', width: 3000, height: 1250, widthMode: 'fixed', material: 'metal', extra: 'preserved' }];

  for (const mode of ['unlimited', 'max', 'fixed']) {
    wizard.open({ force: true });
    await modal.querySelector('.onboarding-tab[data-unit="metric"]').fire('click');
    await modal.querySelector(`.ob-seg-btn[data-mode="${mode === 'unlimited' ? 'unlimited' : 'predefined'}"]`).fire('click');
    byId('onboardingAllowLengthOpt').checked = mode === 'max';
    await byId('onboardingAllowLengthOpt').fire('change');
    for (const [id, value] of [['onboardingSheetLength', '2800'], ['onboardingSheetWidth', '1100']]) {
      byId(id).value = value;
      await byId(id).fire('input');
    }
    byId('onboardingOptInFeedback').checked = false;
    byId('onboardingOptInUpdates').checked = false;
    await byId('onboardingFinish').fire('click');
    assert.equal(state.sheets.length, 1);
    assert.equal(state.sheets[0].id, 'existing-sheet');
    assert.equal(state.sheets[0].extra, 'preserved');
    assert.equal(state.sheets[0].widthMode, mode, 'rerunning the wizard must update the existing sheet');
    assert.equal(state.sheets[0].width, mode === 'unlimited' ? null : 2800);
    assert.equal(state.sheets[0].height, 1100);
    assert.equal(saved.defaultSheetWidthMode, mode);
    assert.equal(saved.defaultSheetLength, 2800);
    assert.equal(saved.defaultSheetHeight, 1100);

    // Simulate settings being loaded on restart and then edit the current sheet.
    state.settings = settings.normalizeSettings(JSON.parse(JSON.stringify(saved)));
    editor.openSheetEditor('existing-sheet');
    assert.equal(dom.sheetWidthMode.value, mode);
    assert.equal(dom.sheetWidth.disabled, mode === 'unlimited');
    editor.closeSheetDialog();
    const previousSheet = state.sheets[0];
    state.sheets = [];
    editor.syncUnits();
    editor.openSheetEditor();
    assert.equal(dom.sheetWidthMode.value, mode, 'Add Sheet must use the saved wizard mode');
    assert.equal(Number(dom.sheetWidth.value), 2800);
    assert.equal(Number(dom.sheetHeight.value), 1100);
    assert.equal(dom.sheetMaterial.value, 'rubber');
    await dom.confirmSheet.fire('click');
    assert.equal(state.sheets[0].widthMode, mode);
    assert.equal(state.sheets[0].width, mode === 'unlimited' ? null : 2800);
    state.sheets = [previousSheet];
    wizard.open({ force: true });
    assert.equal(byId('onboardingSetup').dataset.mode, mode === 'unlimited' ? 'unlimited' : 'predefined');
    assert.equal(byId('onboardingAllowLengthOpt').checked, mode === 'max');
    assert.equal(Number(byId('onboardingSheetLength').value), 2800);
    assert.equal(Number(byId('onboardingSheetWidth').value), 1100);
    wizard.close();
  }
  assert.equal(persisted, 3);
  state.settings.defaultSheetWidthMode = 'unlimited';
  const themeField = new Node({ 'data-setting-key': 'theme' });
  themeField.value = 'light';
  const settingsDialog = context.NestSettingsModal.createSettingsModal({ state, dom: { settingsFields: [themeField] } });
  await settingsDialog.persistCurrentSettings();
  assert.equal(state.settings.defaultSheetWidthMode, 'unlimited', 'ordinary Settings changes must retain wizard defaults');
  assert.equal(state.settings.onboardingCompleted, true);
  assert.equal(state.settings.material, 'rubber');

  state.settings = settings.normalizeSettings({ measurementSystem: 'imperial' });
  state.sheets = [];
  editor.openSheetEditor();
  assert.equal(dom.sheetWidthMode.value, 'fixed');
  assert.equal(Number(dom.sheetWidth.value), 96, 'legacy imperial defaults remain natural inch sizes');
  assert.equal(Number(dom.sheetHeight.value), 48);
  assert.equal(settings.normalizeSettings({ defaultSheetWidthMode: 'bad', defaultSheetLength: -2 }).defaultSheetWidthMode, 'fixed');
  assert.equal(settings.normalizeSettings({ defaultSheetLength: -2 }).defaultSheetLength, 0);
  editor.closeSheetDialog();
  state.settings.material = 'metal';
  wizard.open({ force: true });
  await modal.querySelector('.ob-seg-btn[data-mode="unlimited"]').fire('click');
  await byId('onboardingFinish').fire('click');
  assert.equal(state.sheets.length, 1, 'first-launch setup must still create the initial sheet');
  assert.equal(state.sheets[0].widthMode, 'unlimited');
  assert.equal(state.sheets[0].width, null);
  console.log('Wizard reruns, existing/new sheets, restart defaults and Settings preservation verified in all sheet modes.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
