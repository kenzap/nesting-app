'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const settings = require('../shared/settings');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-fit-settings-'));

assert.equal(settings.SETTINGS_DEFAULTS.exactFitAssist, true);
assert.equal(settings.normalizeSettings({}).exactFitAssist, true);
assert.equal(settings.normalizeSettings({ partSpacing: 5 }).exactFitAssist, true);
for (const value of [true, false]) {
  assert.equal(settings.normalizeSettings(JSON.parse(JSON.stringify({ exactFitAssist: value }))).exactFitAssist, value);
}
for (const [locale, translation] of Object.entries(require('../shared/locales'))) {
  for (const key of ['exactFitAssist', 'exactFitAssistHelp', 'exactFitAssistInactive', 'exactFitAssistUnavailable']) {
    assert.ok(translation.settings[key], `${locale}: ${key}`);
  }
}
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
assert.match(html, /data-setting-key="exactFitAssist"/);
assert.match(html, />Allow exact fits<\/label>/);
assert.equal(require('../shared/locales/en/translation.json').settings.exactFitAssist, 'Allow exact fits');

async function checkModal() {
  const fields = [
    { dataset: { settingKey: 'exactFitAssist' }, type: 'checkbox', checked: false },
    { dataset: { settingKey: 'partSpacing' }, type: 'number', value: '0', min: '0', max: '' },
    { dataset: { settingKey: 'multiSheetStrategy' }, type: 'select-one', value: 'auto' },
  ];
  const hint = {};
  const unavailableHint = {};
  let saved;
  const state = {};
  const window = { dispatchEvent() {}, NestSettings: settings, NestUnits: {
    resolveMeasurementSystem: () => 'metric', unitLabel: () => 'mm', fromDisplayLength: Number, formatInputLength: String,
  }, NestI18n: { t: key => key }, electronAPI: { async saveAppSettings(value) { saved = structuredClone(value); return { success: true }; } } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'renderer/views/settings-modal.js'), 'utf8'), {
    window, CustomEvent, document: {
      documentElement: { dataset: {} }, querySelectorAll: () => [],
      getElementById: id => ({ exactFitAssistHint: hint, exactFitAssistUnavailableHint: unavailableHint })[id] || null,
    },
  });
  const modal = window.NestSettingsModal.createSettingsModal({ state, dom: { settingsFields: fields } });
  for (const [spacing, strategy, inactive] of [[0, 'auto', false], [0.001, 'auto', true], [0, 'by-height', true], [0, 'auto', false]]) {
    modal.applySettingsToDialog(settings.normalizeSettings({ exactFitAssist: true, partSpacing: spacing, multiSheetStrategy: strategy }));
    assert.equal(fields[0].disabled, inactive);
    assert.equal(hint.hidden, !inactive);
    assert.equal(unavailableHint.hidden, true);
    await modal.persistCurrentSettings();
    assert.equal(saved.exactFitAssist, true, 'inactivity must not erase the preference');
  }
  for (const supported of [false, true]) {
    window.electronAPI.getNativeEngineInfo = async () => ({ success: true, supportsExactFitAssist: supported });
    await modal.loadPersistedSettings();
    assert.equal(state.supportsExactFitAssist, supported);
    assert.equal(fields[0].checked, true, 'new installs should enable exact fits by default');
    assert.equal(fields[0].disabled, !supported);
    assert.equal(unavailableHint.hidden, supported);
    assert.equal(hint.hidden, true);
    await modal.persistCurrentSettings();
    assert.equal(saved.exactFitAssist, true, 'older engines must not erase the preference');
  }
  window.electronAPI.loadAppSettings = async () => ({ success: true, settings: { exactFitAssist: false } });
  await modal.loadPersistedSettings();
  assert.equal(fields[0].checked, false, 'existing opt-outs must remain off after loading');
}

async function checkIpc(options, { supported = true, expected = false } = {}) {
  const filename = path.join(root, 'main/ipc/sparrow.js');
  const module = { exports: {} };
  const handlers = new Map();
  const warnings = [];
  const diagnostics = [];
  let args;
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const realRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename), process: { platform: process.platform, resourcesPath: temp, argv: [], env: {} },
    console: { ...console, warn: message => warnings.push(message) },
    require(name) {
      if (name === 'electron') return { app: { isPackaged: true, on() {}, getPath: () => temp }, ipcMain: { handle: (key, fn) => handlers.set(key, fn) } };
      if (name === 'fs') return { ...fs, existsSync: () => true, statSync: () => ({ mtimeMs: 1 }) };
      if (name === 'child_process') return {
        execFile(file, argv, config, callback) { callback(null, supported ? '--exact-fit-assist --favor-shared-edges' : '--favor-shared-edges'); },
        spawn(file, argv) { args = argv; return child; },
      };
      if (name === '../utils/temp-retention') return { cleanupTempArtifacts() {} };
      if (name === '../utils/diagnostics') return { logDiagnostic: (name, data) => diagnostics.push({ name, data }), stderrTail: text => text };
      if (name === './cutouts') return { registerCutoutIpc() {}, supportsCutouts: async () => false };
      return realRequire(name);
    },
  });
  module.exports.registerSparrowIpc();
  const info = await handlers.get('get-native-engine-info')();
  assert.equal(info.success, true, info.error);
  assert.equal(info.supportsExactFitAssist, supported);
  const result = await handlers.get('run-sparrow')(null, { name: 'exact-fit-test' }, options);
  assert.equal(result.success, true, result.error);
  assert.equal(args.includes('--exact-fit-assist'), expected && supported);
  assert.equal(diagnostics.find(entry => entry.name === 'nesting-helper-started').data.options.exactFitAssist, expected && supported);
  if (expected && !supported) {
    assert.match(warnings.join('\n'), /Allow exact fits is unavailable.*continuing normal nesting/);
  } else {
    assert.equal(warnings.length, 0);
  }
  child.emit('close', 0, null);
}

(async () => {
  try {
    await checkModal();
    const active = { exactFitAssist: true, minItemSeparation: 0, maxStripLength: 400, multiStripMode: 'barriers' };
    await checkIpc(active, { expected: true });
    await checkIpc(active, { expected: true, supported: false });
    for (const change of [{ exactFitAssist: false }, { minItemSeparation: 0.001 }, { maxStripLength: null }, { multiStripMode: 'prebucket' }]) {
      await checkIpc({ ...active, ...change });
    }
    console.log('Exact-fit assist: defaults, persistence, availability, all locales, IPC flags, and older-engine handling passed.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
