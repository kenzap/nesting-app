const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const window = { NestDxfGeometry: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/services/dxf-export-metadata-service.js'), 'utf8'), { window });
const { recoverStraightContour, sharedStraightSegments } = window.NestDxfExportMetadataService;
const exact = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 }];
const entities = exact.map((start, i) => ({ type: 'LINE', layer: 'CUT', start, end: exact[(i + 1) % 4] }));
const approximate = exact.map((p, i) => ({ x: p.x + (i % 2 ? .009 : -.007), y: p.y + .012 }));
const clean = p => JSON.parse(JSON.stringify(p));
assert.deepEqual(clean(recoverStraightContour(approximate, entities)), exact);
assert.deepEqual(clean(recoverStraightContour([...approximate, approximate[0]], entities)), [...exact, exact[0]]);
assert.deepEqual(clean(recoverStraightContour([...approximate].reverse(), entities)), [...exact].reverse());
assert.deepEqual(clean(recoverStraightContour(approximate, [...entities, ...entities])), exact);
const withMidpoint = [approximate[0], { x: 50, y: .013 }, ...approximate.slice(1)];
const recovered = recoverStraightContour(withMidpoint, entities);
assert.equal(recovered.length, 5);
assert.equal(recovered[1].y, 0);
assert.equal(recovered[1].x, 50);
assert.equal(recoverStraightContour(approximate, entities.slice(1)), approximate, 'partial matching cannot alter a part');
const far = approximate.map(p => ({ ...p, y: p.y + .2 }));
assert.equal(recoverStraightContour(far, entities), far, 'do not reshape significant differences');
const arc = { type: 'ARC', center: { x: 0, y: 0 }, radius: 1 };
assert.equal(recoverStraightContour(approximate, [...entities, arc]), approximate);
const engraving = { ...arc, layer: 'ENGRAVE' };
assert.deepEqual(clean(recoverStraightContour(approximate, [...entities, engraving], 'ENGRAVE')), exact);
assert.equal(recoverStraightContour(approximate, entities.map(e => ({ ...e, layer: 'ENGRAVE' })), 'ENGRAVE'), approximate);
const ambiguous = entities.map(e => ({ ...e, start: { x: e.start.x, y: e.start.y + .024 }, end: { x: e.end.x, y: e.end.y + .024 } }));
assert.equal(recoverStraightContour(approximate, [...entities, ...ambiguous]), approximate, 'ambiguous source lines must not be guessed');
assert.equal(recoverStraightContour(approximate, [{ type: 'LWPOLYLINE', closed: true, vertices: exact.map((p, i) => ({ ...p, bulge: i === 0 ? .01 : 0 })) }]), approximate);
assert.deepEqual(clean(recoverStraightContour(approximate, [{ type: 'LWPOLYLINE', closed: true, vertices: exact }])), exact);
for (const extra of [{ extrusionDirectionZ: -1 }, { extrusionDirection: { x: 0, y: 0, z: -1 } }, { thickness: 1 }, { elevation: 2 }, { width: 1 }]) {
  assert.equal(recoverStraightContour(approximate, entities.map(e => ({ ...e, ...extra }))), approximate);
}

// Close an actual gap by placing source-faithful contours, not by changing the
// 0.001 mm contact threshold or changing the original exported line entities.
const sourceBefore = JSON.stringify(entities);
const segments = sharedStraightSegments(entities);
assert.ok(segments.length === 4);
assert.equal(JSON.stringify(entities), sourceBefore);
assert.equal(recovered[0].y, exact[0].y);
console.log('Source contours: exact lines recovered; closure, winding and split edges preserved; curves, ambiguity, engraving-only and unmatched geometry rejected.');

// Cached previews are also corrected when the job is built. Both the engine
// polygon and DXF export metadata must use the recovered coordinates.
const state = { files: [{ id: 'file', name: 'part.dxf', path: '/part.dxf',
  layers: [{ name: 'CUT' }, { name: 'ENGRAVE' }],
  _shapeCacheVersion: 1, _multiSketchDetection: true, _sketchContourMethod: 'auto',
  shapes: [{ id: 'part', qty: 2, polygonPoints: approximate, exportEntities: entities, holes: [] }],
}], sheets: [{ width: 3000, height: 1250 }] };
window.NestHelpers = {
  buildAllowedOrientations: () => [0, 90], sanitizePolygonPoints: p => p,
  clonePlain: clean, effectiveFileQty: () => 2,
  partLabelFromName: () => 'part', buildJobName: () => 'source-contour',
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/services/dxf-service.js'), 'utf8'), { window });
const service = window.NestDxfService.createDxfService({ state,
  getCurrentNestingSettings: () => ({ multiSketchDetection: true, sketchContourMethod: 'auto', engravingLayer: '2' }),
});
(async () => {
  const payload = await service.buildPlacementPayload();
  const expected = exact.map(p => [p.x, p.y]);
  assert.deepEqual(clean(payload.items[0].shape.data), expected);
  assert.deepEqual(clean(state.lastPlacementExportItems[0].polygon), expected);
  assert.deepEqual(clean(state.lastPlacementExportItems[0].entities), entities);
  assert.equal(payload.items[0].demand, 2);
  console.log('Placement payload and DXF metadata share exact source contours; original entities and quantities remain unchanged.');
})().catch(error => { console.error(error); process.exitCode = 1; });
