const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const settings = require('../shared/settings');
const root = path.join(__dirname, '..');

assert.equal(settings.normalizeSettings({}).preferredAlignment, 'bottom-left');
assert.equal(settings.normalizeSettings({ preferredAlignment: 'invalid' }).preferredAlignment, 'bottom-left');
assert.equal(settings.normalizeSettings({ preferredAlignment: 'auto' }).preferredAlignment, 'bottom-left');
for (const value of settings.PREFERRED_ALIGNMENTS) {
  const saved = JSON.parse(JSON.stringify(settings.normalizeSettings({ preferredAlignment: value })));
  assert.equal(settings.normalizeSettings(saved).preferredAlignment, value);
}

const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
assert.match(html, /<select data-setting-key="preferredAlignment">\s*<option value="none" data-i18n="settings.alignmentNone">None<\/option>/);
assert.doesNotMatch(html.match(/<select data-setting-key="preferredAlignment">[\s\S]*?<\/select>/)[0], /value="auto"/);
for (const entry of fs.readdirSync(path.join(root, 'shared/locales'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const locale = entry.name;
  const translations = JSON.parse(fs.readFileSync(path.join(root, 'shared/locales', locale, 'translation.json')));
  assert.ok(translations.settings.alignmentNone, `${locale}: missing None label`);
  assert.ok(translations.common.auto, `${locale}: missing Auto label`);
}

// Exercise the actual IPC flag mapping without launching Electron or a solver.
const source = fs.readFileSync(path.join(root, 'main/ipc/sparrow.js'), 'utf8');
const mapping = source.match(/const sparrowAlignment = \{[\s\S]*?if \(sparrowAlignment\) args\.push\(`--align-\$\{sparrowAlignment\}`\);/);
assert.ok(mapping, 'alignment flag mapping exists');
for (const [align, expected] of Object.entries({
  none: [], auto: ['--align-top-left'], top: ['--align-bottom'], bottom: ['--align-top'],
  'top-left': ['--align-bottom-left'], 'top-right': ['--align-bottom-right'],
  'bottom-left': ['--align-top-left'], 'bottom-right': ['--align-top-right'],
})) {
  const context = { options: { align }, args: [] };
  vm.runInNewContext(mapping[0], context);
  assert.deepEqual(context.args, expected);
}

const field = { dataset: { settingKey: 'preferredAlignment' }, type: 'select-one', value: 'bottom-left' };
let saved;
const state = {};
const window = { NestSettings: settings, NestUnits: {
  resolveMeasurementSystem: () => 'metric', unitLabel: () => 'mm',
  fromDisplayLength: Number, formatInputLength: String,
}, NestI18n: { t: key => key }, electronAPI: { async saveAppSettings(value) { saved = JSON.parse(JSON.stringify(value)); return { success: true }; } } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'renderer/views/settings-modal.js'), 'utf8'), {
  window, document: { querySelectorAll: () => [] },
});
const modal = window.NestSettingsModal.createSettingsModal({ state, dom: { settingsFields: [field] } });
(async () => {
  for (const value of settings.PREFERRED_ALIGNMENTS) {
    modal.applySettingsToDialog(settings.normalizeSettings({ preferredAlignment: value }));
    assert.equal(field.value, value);
    await modal.persistCurrentSettings();
    assert.equal(saved.preferredAlignment, value);
    assert.equal(modal.currentNestingSettings().preferredAlignment, value);
  }
  console.log('Alignment choices persist, None skips alignment, and legacy Auto migrates to Bottom Left.');
})().catch(error => { console.error(error); process.exitCode = 1; });
