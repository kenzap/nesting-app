'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const DxfParser = require('dxf-parser');
const { removeSharedEdges } = require('../main/utils/dxf-shared-edges');
const { normalizeSettings } = require('../shared/settings');

const transformPoint = (p, rotation = 0, tx = 0, ty = 0) => {
  const a = rotation * Math.PI / 180;
  return { x: +(p.x * Math.cos(a) - p.y * Math.sin(a) + tx).toFixed(4),
    y: +(p.x * Math.sin(a) + p.y * Math.cos(a) + ty).toFixed(4), z: p.z || 0 };
};
const signature = e => JSON.stringify([e.layer || '0', e.colorNumber || 0]);
const options = { transformPoint, signature };
const line = (a, b, extra = {}) => ({ type: 'LINE', layer: '0', start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, ...extra });
const record = (entity, owner, contour = null, extra = {}) => {
  const points = entity.vertices || [entity.start, entity.end];
  return { entity, owner, rotation: 0, tx: 0, ty: 0, engravingLayer: 'engrave',
    outerContour: contour || [...points.map(p => [p.x, p.y]), [999, 999]], ...extra };
};
const cleanup = records => removeSharedEdges(records, options);
const length = records => records.reduce((sum, r) => {
  const e = r.entity;
  const points = e.vertices || [e.start, e.end];
  return sum + points.slice(0, e.closed || e.shape ? points.length : -1).reduce((s, p, i) => {
    const q = points[(i + 1) % points.length];
    return s + Math.hypot(p.x - q.x, p.y - q.y);
  }, 0);
}, 0);

assert.equal(normalizeSettings({}).removeSharedEdges, false);
assert.equal(normalizeSettings({ removeSharedEdges: true }).removeSharedEdges, true);
for (const reverse of [false, true]) {
  const short = reverse ? [[300, 0], [100, 0]] : [[100, 0], [300, 0]];
  const out = cleanup([record(line([0, 0], [500, 0]), 0), record(line(...short), 1)]);
  assert.equal(out.removedLengthMm, 200);
  assert.equal(length(out.records), 500);
}
// A vertical long edge, processed second, must keep both non-overlapping tails.
const split = cleanup([record(line([0, 100], [0, 300]), 0), record(line([0, 0], [0, 500]), 1)]);
assert.equal(split.removedLengthMm, 200);
assert.equal(split.records.filter(r => r.owner === 1).length, 2);
assert.equal(length(split.records), 500);
const triple = cleanup([record(line([0, 0], [500, 0]), 0), record(line([100, 0], [300, 0]), 1), record(line([200, 0], [400, 0]), 2)]);
assert.equal(length(triple.records), 500);
assert.equal(triple.removedLengthMm, 400);

for (const [a, b] of [
  [line([0, 0], [10, 0]), line([0, 0.002], [10, 0.002])],
  [line([0, 0], [10, 0]), line([10, 0], [20, 0])],
  [line([0, 0], [10, 0]), line([5, -5], [5, 5])],
  [line([0, 0], [10, 0]), line([0, 0], [10, 0], { layer: 'other' })],
  [line([0, 0], [10, 0]), line([0, 0], [10, 0], { colorNumber: 1 })],
  [line([0, 0], [10, 0], { layer: 'engrave' }), line([0, 0], [10, 0], { layer: 'engrave' })],
]) {
  const input = [record(a, 0), record(b, 1)];
  assert.deepEqual(cleanup(input).records, input);
}
const near = cleanup([record(line([0, 0], [100, 0]), 0), record(line([0, 0.0002], [100, 0.0002]), 1)]);
assert.equal(near.removedLengthMm, 100);
const chain = cleanup([0, 0.0009, 0.0018].map((y, i) => record(line([0, y], [100, y]), i)));
assert.equal(chain.records.length, 2, 'removed edges cannot propagate tolerance to distant edges');
const internal = [0, 1].map(i => record(line([2, 5], [8, 5]), i, [[0, 0], [10, 0], [10, 10], [0, 10]]));
assert.deepEqual(cleanup(internal).records, internal, 'internal lines are not outer cutting boundaries');
for (const entity of [
  { type: 'ARC', layer: '0', center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI },
  { type: 'LWPOLYLINE', layer: '0', closed: true, vertices: [{ x: 0, y: 0, bulge: 1 }, { x: 10, y: 0 }] },
  { type: 'SPLINE', layer: '0', controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
  line([0, 0], [10, 0], { thickness: 1 }),
  line([0, 0], [10, 0], { extrusionDirection: { x: 0, y: 0, z: -1 } }),
]) {
  const input = [0, 1].map(owner => ({ entity, owner, rotation: 0, tx: 0, ty: 0, outerContour: [[0, 0], [10, 0], [10, 10]] }));
  assert.deepEqual(cleanup(input).records, input, 'unsupported entities pass through unchanged');
}
const rotated = cleanup([
  record(line([0, 0], [0, 10]), 0),
  record(line([0, 0], [10, 0]), 1, [[0, 0], [0, 10], [10, 10]], { rotation: 90 }),
]);
assert.equal(rotated.removedLengthMm, 10);

const exportPath = path.resolve(__dirname, '../main/ipc/export-dxf.js');
const source = fs.readFileSync(exportPath, 'utf8');
const joins = {};
vm.runInNewContext(source.slice(source.indexOf('      function approxAciFromHex'), source.indexOf('      function writeColor'))
  + '\nthis.join = joinConnectedLineworkEntities;', joins);
assert.equal(joins.join([line([0, 0], [10, 0]), line([10, 0], [0, 0])]).length, 1);
assert.equal(joins.join([line([0, 0], [10, 0]), line([0, 0], [10, 0])])[0].type, 'LINE');
const joinedGap = joins.join([line([0, 0], [10.0004, 0]), line([10.0006, 0], [20, 0])]);
assert.equal(joinedGap.length, 1);
assert.equal(joinedGap[0].type, 'LWPOLYLINE');
assert.equal(joinedGap[0].closed, false);

let exportDxf;
const mod = { exports: {} };
vm.runInNewContext(source, { module: mod, process, console, __dirname: path.dirname(exportPath), require(name) {
  if (name === 'electron') return { ipcMain: { handle(_, fn) { exportDxf = fn; } } };
  if (name === '../utils/security-scoped-bookmarks') return { withSecurityScopedAccess: (_, fn) => fn() };
  return createRequire(exportPath)(name);
} });
mod.exports.registerExportDxfIpc();

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxf-shared-export-'));
  try {
    const points = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const inputPath = path.join(dir, 'input.json');
    const jsonPath = path.join(dir, 'sheet.json');
    fs.writeFileSync(inputPath, JSON.stringify({ items: [{ id: 0, shape: { data: points } }],
      settings: { engravingLayer: 'off', sheetMargin: 0, removeSharedEdges: true } }));
    fs.writeFileSync(jsonPath, JSON.stringify({ solution: { layout: { placed_items: [0, 10].map(tx => ({
      item_id: 0, transformation: { rotation: 0, translation: [tx, 0] },
    })) } } }));
    for (const joinConnectedLinework of [false, true]) for (const removeSharedEdges of [false, true]) {
      const result = await exportDxf(null, { outputDir: dir, inputPath, strips: [{ index: 1,
        json_path: jsonPath, sheet_width: 20, strip_width: 20, strip_height: 10 }],
        includeSheetOutline: true, removeSharedEdges, joinConnectedLinework });
      assert.equal(result.success, true, result.error);
      const parsed = new DxfParser().parseSync(fs.readFileSync(path.join(dir, '01_sheet_10x20.dxf'), 'utf8'));
      const entities = parsed.entities.filter(e => e.layer !== 'SHEET_BOUNDARY');
      assert.equal(length(entities.map(entity => ({ entity }))), removeSharedEdges ? 70 : 80);
      assert.equal(parsed.entities.filter(e => e.layer === 'SHEET_BOUNDARY').length, 1);
      if (!removeSharedEdges) assert.ok(entities.every(e => e.shape), 'disabled leaves closed part contours intact');
    }
    console.log('Shared-edge export: partial/reversed overlaps, transforms, tolerances, protected geometry, joining, settings, and real DXF output passed.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
