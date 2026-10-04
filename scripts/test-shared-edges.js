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
const fields = [
  { dataset: { settingKey: 'partSpacing' }, type: 'number', value: '0', min: '0', max: '', addEventListener() {} },
  { dataset: { settingKey: 'favorSharedEdges' }, type: 'checkbox', checked: false },
];
Object.assign(window, { NestSettings: settings, NestUnits: {
  resolveMeasurementSystem: () => 'metric', unitLabel: () => 'mm',
  fromDisplayLength: n => n, formatInputLength: String,
} });
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/views/settings-modal.js'), 'utf8'), {
  window, document: { querySelectorAll: () => [] },
});
const modal = window.NestSettingsModal.createSettingsModal({ state: {}, dom: { settingsFields: fields } });
modal.applySettingsToDialog(settings.normalizeSettings({ favorSharedEdges: true, partSpacing: 2 }));
assert.equal(fields[1].checked, true);
assert.equal(fields[1].disabled, true);
modal.applySettingsToDialog(settings.normalizeSettings({ favorSharedEdges: true, partSpacing: 0 }));
assert.equal(fields[1].checked, true);
assert.equal(fields[1].disabled, false);

console.log('Shared-edge settings persist; non-zero spacing disables the option; curved DXF segments are excluded.');
