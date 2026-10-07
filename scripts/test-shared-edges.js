const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const settings = require('../shared/settings');

const window = { NestDxfGeometry: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname,
  '../renderer/services/dxf-export-metadata-service.js'), 'utf8'), { window });
const segments = entities => JSON.parse(JSON.stringify(
  window.NestDxfExportMetadataService.sharedStraightSegments(entities)));

assert.deepEqual(segments([
  { type: 'LINE', start: { x: 10, y: 20 }, end: { x: 40, y: 20 } },
  { type: 'ARC', center: { x: 20, y: 20 }, radius: 10 },
  { type: 'CIRCLE', center: { x: 20, y: 20 }, radius: 10 },
  { type: 'SPLINE', controlPoints: [{ x: 0, y: 0 }, { x: 40, y: 0 }] },
]), [[10, 20, 40, 20]]);

// The bulge belongs to the segment leaving that vertex. Do not accidentally
// promote an arc or a spline-fit polyline's sampled chords to shared edges.
const mixedPolyline = { type: 'LWPOLYLINE', closed: true, vertices: [
  { x: 0, y: 0, bulge: 1 }, { x: 20, y: 0 }, { x: 20, y: 30 },
] };
assert.deepEqual(segments([mixedPolyline]), [[20, 0, 20, 30], [20, 30, 0, 0]]);
assert.deepEqual(segments([{ ...mixedPolyline, includesSplineFitVertices: true }]), []);
assert.deepEqual(segments([{ type: 'LINE', start: { x: NaN, y: 0 }, end: { x: 20, y: 0 } }]), []);

assert.equal(settings.normalizeSettings({}).favorSharedEdges, false);
assert.equal(settings.normalizeSettings(JSON.parse(JSON.stringify({ favorSharedEdges: true }))).favorSharedEdges, true);

// Exercise the actual modal's spacing gate while retaining the saved choice.
let onSpacingInput;
const fields = [
  { dataset: { settingKey: 'partSpacing' }, type: 'number', value: '0', min: '0', max: '',
    addEventListener(type, fn) { if (type === 'input') onSpacingInput = fn; } },
  { dataset: { settingKey: 'favorSharedEdges' }, type: 'checkbox', checked: false },
];
// The inline hint under the toggle: visible only while spacing makes the
// option inert, with a one-click "set spacing to 0" action.
const hint = { hidden: true };
const hintText = { textContent: '' };
let onHintAction;
const elements = {
  sharedEdgesHint: hint,
  sharedEdgesHintText: hintText,
  sharedEdgesHintAction: { addEventListener(type, fn) { if (type === 'click') onHintAction = fn; } },
};
const windowListeners = {};
let language = 'en';
Object.assign(window, {
  NestSettings: settings,
  NestUnits: {
    resolveMeasurementSystem: () => 'metric', unitLabel: () => 'mm',
    fromDisplayLength: n => n, formatInputLength: String,
  },
  NestI18n: { t: (key, options = {}) => `${language}:${key}|${options.value ?? ''}` },
  addEventListener(type, fn) { windowListeners[type] = fn; },
});
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/views/settings-modal.js'), 'utf8'), {
  window, document: { querySelectorAll: () => [], getElementById: id => elements[id] || null },
});
const noopTarget = { addEventListener() {} };
const modal = window.NestSettingsModal.createSettingsModal({ state: {}, dom: {
  settingsFields: fields, openSettings: noopTarget, closeSettings: noopTarget,
  applySettings: noopTarget, resetSettings: noopTarget,
} });
modal.bind();

modal.applySettingsToDialog(settings.normalizeSettings({ favorSharedEdges: true, partSpacing: 2 }));
assert.equal(fields[1].checked, true);
assert.equal(fields[1].disabled, true);
assert.equal(hint.hidden, false, 'positive spacing explains why the option is inactive');
assert.equal(hintText.textContent, 'en:settings.favorSharedEdgesInactive|2 mm');
modal.applySettingsToDialog(settings.normalizeSettings({ favorSharedEdges: true, partSpacing: 0 }));
assert.equal(fields[1].checked, true);
assert.equal(fields[1].disabled, false);
assert.equal(hint.hidden, true, 'no hint while the option can apply');

// Clearing the field to retype it is effectively 0 and must not flash the hint.
fields[0].value = '';
onSpacingInput();
assert.equal(fields[1].disabled, false);
assert.equal(hint.hidden, true);

// Typing a spacing shows the hint; its action sets spacing to 0 and re-enables
// the option without losing the saved choice.
fields[0].value = '3';
onSpacingInput();
assert.equal(fields[1].disabled, true);
assert.equal(hint.hidden, false);
assert.equal(hintText.textContent, 'en:settings.favorSharedEdgesInactive|3 mm');
onHintAction();
assert.equal(fields[0].value, '0');
assert.equal(fields[1].disabled, false);
assert.equal(fields[1].checked, true, 'the saved preference survives the round trip');
assert.equal(hint.hidden, true);

// The hint text is built at runtime, so it must follow language changes.
fields[0].value = '3';
onSpacingInput();
language = 'de';
windowListeners['nest-language-changed']();
assert.equal(hintText.textContent, 'de:settings.favorSharedEdgesInactive|3 mm');

console.log('Shared-edge settings persist; positive spacing disables the option with an inline hint and one-click fix; curved DXF segments are excluded.');
