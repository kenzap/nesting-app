'use strict';
const assert = require('node:assert/strict');
const editor = require('../shared/placement-editor');
const rectangle = [[0, 0], [10, 0], [10, 10], [0, 10]];
const items = { 1: { shape: { data: rectangle } } };
const placed = (x, y = 0, rotation = 0) => ({ item_id: 1, transformation: { rotation, translation: [x, y] } });
const frame = { width: 100, height: 60, margin: 5 };
const original = [placed(0), placed(20), placed(40)];
const saved = JSON.stringify(original);
const edits = editor.editsFor(original);
edits[1].translation = [25, 15];
const result = editor.validateEdits(original, edits, items, frame, 2);
assert.deepEqual(result[1].transformation.translation, [25, 15]);
assert.equal(JSON.stringify(original), saved, 'source result remains immutable');
assert.equal(editor.applyEdits(original, edits.filter(e => e.sourceIndex !== 1)).length, 2, 'delete one of three identical copies');
assert.equal(editor.applyEdits(original, []).length, 0, 'empty sheet is a valid edit');
assert.deepEqual(editor.applyEdits(original, editor.editsFor(original)), original, 'reset restores exact placements');
assert.throws(() => editor.applyEdits(original, [edits[0], edits[0]]), /Invalid/);
assert.throws(() => editor.applyEdits(original, [{ sourceIndex: 8, translation: [0, 0] }]), /Invalid/);
assert.throws(() => editor.applyEdits(original, [{ sourceIndex: 0, translation: [NaN, 0] }]), /Invalid/);
assert.throws(() => editor.applyEdits(original, [{ sourceIndex: 0, translation: [0, 0], rotation: NaN }]), /Invalid/);
assert.throws(() => editor.applyEdits(original, [{ sourceIndex: 0, translation: [0, 0], rotation: '90' }]), /Invalid/);
assert.equal(editor.applyEdits(original, [{ sourceIndex: 0, translation: [0, 0] }])[0].transformation.rotation, 0,
  'legacy translation-only edits preserve the original angle');
const offsetItem = { shape: { data: [[-10, -5], [30, -5], [30, 15], [-10, 15]] } };
const initialRotation = placed(35, 20, 30);
let rotated = initialRotation;
let rotatedEdit = editor.editsFor([rotated])[0];
const pivotBefore = editor.transform([[10, 5]], rotated)[0];
for (let i = 0; i < 4; i++) {
  rotatedEdit = editor.rotateEdit(rotatedEdit, rotated, offsetItem, -90);
  rotated = editor.applyEdits([initialRotation], [rotatedEdit])[0];
  const pivotAfter = editor.transform([[10, 5]], rotated)[0];
  assert.ok(pivotAfter.every((v, axis) => Math.abs(v - pivotBefore[axis]) < 1e-9), 'rotation preserves center');
}
assert.equal(rotated.transformation.rotation, 30, 'four turns restore angle');
assert.ok(rotated.transformation.translation.every((v, axis) => Math.abs(v - initialRotation.transformation.translation[axis]) < 1e-9));
const fractionalEdit = editor.rotateEdit(editor.editsFor([initialRotation])[0], initialRotation, offsetItem, 12.75);
const fractional = editor.applyEdits([initialRotation], [fractionalEdit])[0];
assert.equal(fractional.transformation.rotation, 42.75);
assert.ok(editor.rotationCenter(fractional, offsetItem).every((v, axis) => Math.abs(v - pivotBefore[axis]) < 1e-9));
assert.deepEqual(editor.rotationCenter(initialRotation, offsetItem, 5), pivotBefore.map(v => v + 5));
const rotationOnly = editor.editsFor([placed(0)]);
rotationOnly[0].rotation = 90;
assert.throws(() => editor.validateEdits([placed(0)], rotationOnly, items, frame, 0), /bounds/,
  'export validates rotation-only changes even when translation is unchanged');
const centeredItems = { 1: { shape: { data: [[-20, -5], [20, -5], [20, 5], [-20, 5]] } } };
const centered = [placed(40, 20), placed(40, 40)];
const centerEdits = editor.editsFor(centered);
centerEdits[0] = editor.rotateEdit(centerEdits[0], centered[0], centeredItems[1], 90);
assert.throws(() => editor.validateEdits(centered, centerEdits, centeredItems, frame, 0), /collision/);
const spaced = [placed(40, 20), placed(40, 46)];
const spacedEdits = editor.editsFor(spaced);
spacedEdits[0] = centerEdits[0];
assert.throws(() => editor.validateEdits(spaced, spacedEdits, centeredItems, frame, 2), /spacing/);
assert.equal(editor.validateMove([placed(-1)], 0, items, frame), 'bounds');
assert.equal(editor.validateMove([placed(81)], 0, items, frame), 'bounds');
assert.equal(editor.validateMove([placed(0, 41)], 0, items, frame), 'bounds');
assert.equal(editor.validateMove([placed(80, 40)], 0, items, frame), null, 'exact margin contact');
assert.equal(editor.validateMove([placed(0), placed(5)], 0, items, frame), 'collision');
assert.equal(editor.validateMove([placed(0), placed(0)], 0, items, frame), 'collision', 'identical overlapping outlines');
assert.equal(editor.validateMove([placed(0), placed(10)], 0, items, frame), null, 'shared-edge contact allowed at zero spacing');
assert.equal(editor.validateMove([placed(0), placed(11)], 0, items, frame, 2), 'spacing');
assert.equal(editor.validateMove([placed(0), placed(12)], 0, items, frame, 2), null);
assert.equal(editor.validateMove([placed(10, 0, 90)], 0, items, frame), null, 'rotated outline is bounded in world coordinates');
assert.equal(editor.validateMove([placed(0, 0, 90)], 0, items, frame), 'bounds');
assert.equal(editor.validateMove([placed(0)], 0, items, { ...frame, width: NaN }), 'geometry');
const concave = { 1: { shape: { data: [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]] } },
  2: { shape: { data: [[0, 0], [3, 0], [3, 3], [0, 3]] } } };
assert.equal(editor.validateMove([placed(0), { ...placed(4, 4), item_id: 2 }], 1, concave, frame), null,
  'overlapping bounding boxes do not imply a collision in a concave notch');
assert.deepEqual(editor.transform([[0, 0]], placed(12, 20), 5), [[17, 25]], 'margin applied once');
assert.equal(editor.stats([placed(0)], items, frame).item_count, 1);
assert.equal(editor.stats([], items, frame).density, 0);
assert.deepEqual(editor.readPlacements({ solution: { placed_items: original } }), original, 'unlimited schema');
assert.deepEqual(editor.readPlacements({ solution: { layout: { placed_items: original } } }), original, 'multi-sheet schema');
const invalid = editor.editsFor(original); invalid[0].translation = [20, 0];
assert.throws(() => editor.validateEdits(original, invalid, items, frame, 0), /collision/, 'export revalidates edits');

function snapFixture({ moving = placed(29.5, 20, 1), target = placed(40, 20), spacing = 0,
  distanceLimit = 2, fixtureItems = items, others = [], snapFrame = frame } = {}) {
  const placements = [moving, target, ...others];
  return editor.findEdgeSnap(placements, 0, editor.editsFor(placements)[0], fixtureItems, snapFrame, spacing,
    editor.prepareEdgeSnap(placements, 0, fixtureItems), { distanceLimit });
}
const snapped = snapFixture();
assert.ok(snapped, 'nearly parallel neighboring edges snap');
assert.ok(Math.abs(snapped.edit.rotation) < 1e-9, 'snap corrects the small angular mismatch');
assert.ok(Math.abs(snapped.edit.translation[0] - 30) < 1e-9, 'zero spacing produces edge contact');
assert.equal(editor.validateMove([snapped.placement, placed(40,20)], 0, items, frame, 0), null);
assert.equal(snapFixture({ moving:placed(29.5,20,4) }), null, 'angles beyond three degrees are not snapped');
assert.equal(snapFixture({ distanceLimit:0.05 }), null, 'screen-distance threshold limits magnetic reach');
const spacedSnap = snapFixture({ moving:placed(27.5,20,1), spacing:2 });
assert.ok(spacedSnap);
assert.ok(Math.abs(spacedSnap.edit.translation[0] - 28) < 1e-9);
assert.equal(editor.validateMove([spacedSnap.placement, placed(40,20)], 0, items, frame, 2), null);
assert.equal(snapFixture({ others:[placed(30,20)] }), null, 'snap cannot collide with a third part');
assert.equal(snapFixture({ snapFrame:{width:39,height:60,margin:5} }), null, 'snap cannot violate sheet margins');
assert.equal(snapFixture({ fixtureItems:{1:{...items[1],shared_edge_segments:[]}} }), null, 'curve-only source metadata excludes tessellated chords');
assert.equal(snapFixture({ fixtureItems:{1:{...items[1],shared_edge_segments:[[2,2,8,2]]}} }), null, 'internal lines are not outer-edge snap targets');
const sourcedItems = {1:{...items[1],shared_edge_segments:rectangle.map((a,i)=>[...a,...rectangle[(i+1)%4]])}};
assert.ok(snapFixture({fixtureItems:sourcedItems}), 'source-confirmed straight contours are supported');
const mixedItems = {...items, 2:{shape:{data:[[0,0],[10,0],[10,30],[0,30]]}}};
assert.ok(snapFixture({fixtureItems:mixedItems,target:{...placed(40,10),item_id:2}}), 'partial overlap with a longer edge is supported');
const corner = snapFixture({ moving: placed(29.5, 19.5), others: [placed(30, 30)] });
assert.equal(corner?.contacts?.length, 2, 'corner snaps to two adjacent parts simultaneously');
assert.deepEqual(corner.edit.translation, [30, 20]);
assert.equal(editor.validateMove([corner.placement, placed(40, 20), placed(30, 30)], 0, items, frame), null);
const rotatedCorner = snapFixture({ moving: placed(29.5, 19.5, 1), others: [placed(30, 30)] });
assert.equal(rotatedCorner?.contacts?.length, 2, 'compatible angular correction aligns both contacts');
assert.equal(rotatedCorner.edit.rotation, 0);
assert.deepEqual(rotatedCorner.edit.translation, [30, 20]);
const spacedCorner = snapFixture({ moving: placed(27.5, 17.5), target: placed(40, 18),
  others: [placed(28, 30)], spacing: 2 });
assert.equal(spacedCorner?.contacts?.length, 2);
assert.deepEqual(spacedCorner.edit.translation, [28, 18]);
assert.equal(editor.validateMove([spacedCorner.placement, placed(40, 18), placed(28, 30)], 0, items, frame, 2), null,
  'both contacts maintain configured spacing');
const turnPlacement = p => ({ ...p, transformation: { rotation: p.transformation.rotation + 30,
  translation: editor.transform([p.transformation.translation], placed(30, 0, 30))[0] } });
const tiltedCorner = snapFixture({ moving: turnPlacement(placed(29.5, 19.5)), target: turnPlacement(placed(40, 20)),
  others: [turnPlacement(placed(30, 30))], snapFrame: {width: 150, height: 150, margin: 0} });
assert.equal(tiltedCorner?.contacts?.length, 2, 'corner snapping is not limited to sheet axes');
assert.ok(tiltedCorner.edit.translation.every((v, i) => Math.abs(v - turnPlacement(placed(30, 20)).transformation.translation[i]) < 1e-6));
const angledItems = { ...items,
  2: {shape: {data: [[0,0],[10,0],[5,10]]}},
  3: {shape: {data: [[0,0],[-6,8],[5,10]]}} };
const angledCorner = snapFixture({ moving: {...placed(20.3,20.4), item_id:2}, target: placed(20,10),
  others: [{...placed(20,20), item_id:3}], fixtureItems: angledItems });
assert.equal(angledCorner?.contacts?.length, 2, 'non-perpendicular edges can form a simultaneous snap');
assert.ok(angledCorner.edit.translation.every(v => Math.abs(v - 20) < 1e-6));
const tooFarCorner = snapFixture({ moving: placed(29.2, 19.2), others: [placed(30, 30)], distanceLimit: 1 });
assert.ok(tooFarCorner && !tooFarCorner.contacts, 'combined displacement cannot exceed snap reach; single-edge fallback remains');
const incompatibleCorner = snapFixture({ moving: placed(29.5, 19.5), others: [placed(30, 30, 1)] });
assert.ok(!incompatibleCorner?.contacts, 'incompatible target angles cannot claim simultaneous contact');
const blockedCorner = snapFixture({ moving: placed(29.5, 19.5), others: [placed(30, 30), placed(30, 20)] });
assert.equal(blockedCorner, null, 'corner snapping cannot overlap another placed part');
const boundedCorner = snapFixture({ moving: placed(29.5, 19.5), others: [placed(30, 30)],
  snapFrame: {width: 39.9, height: 60, margin: 0} });
assert.ok(!boundedCorner?.contacts, 'two-edge snapping cannot bypass sheet bounds');
// A block seated in a single neighbour's notch snaps flush to both inner
// walls at once, at any rotation (both contacts are on the same part).
{
  const notched = { shape: { data: [[0, 0], [100, 0], [100, 60], [30, 60], [30, 30], [0, 30]] } };
  const block = { shape: { data: [[0, 0], [28, 0], [28, 28], [0, 28]] } };
  const notchItems = { 0: notched, 1: block };
  const notchFrame = { width: 1000, height: 1000, margin: 0 };
  for (const angle of [0, 30, 170, -47.3]) {
    const rad = angle * Math.PI / 180;
    const turn = ([x, y]) => [x * Math.cos(rad) - y * Math.sin(rad), x * Math.sin(rad) + y * Math.cos(rad)];
    const [dx, dy] = turn([1, 31]);
    const layout = [
      { item_id: 0, transformation: { rotation: angle, translation: [200, 100] } },
      { item_id: 1, transformation: { rotation: angle, translation: [200 + dx, 100 + dy] } },
    ];
    const edit = { sourceIndex: 1, rotation: angle, translation: layout[1].transformation.translation.slice() };
    const snap = editor.findEdgeSnap(layout, 1, edit, notchItems, notchFrame, 0,
      editor.prepareEdgeSnap(layout, 1, notchItems), { distanceLimit: 3 });
    assert.equal(snap?.contacts?.length, 2, `notch corner snaps both walls at ${angle}°`);
    const after = layout.slice(); after[1] = snap.placement;
    const nudged = (x, y) => {
      const moved = JSON.parse(JSON.stringify(after)), [a, b] = turn([x, y]);
      moved[1].transformation.translation[0] += a; moved[1].transformation.translation[1] += b;
      return editor.validateMove(moved, 1, notchItems, notchFrame, 0);
    };
    assert.equal(editor.validateMove(after, 1, notchItems, notchFrame, 0), null);
    assert.equal(nudged(0.01, 0), 'collision', `flush against the inner wall at ${angle}°`);
    assert.equal(nudged(0, -0.01), 'collision', `flush against the notch floor at ${angle}°`);
  }
}

console.log('Placement editing: copy identity, deletion, reset, rotation, concavity, collisions, spacing, margins, and export validation passed.');

// Exercise the actual IPC loader with finished on-disk artifacts. The renderer
// supplies only a run ID, never arbitrary file paths to read.
(async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  const sourcePath = path.resolve(__dirname, '../main/ipc/sparrow.js');
  const handlers = {}, mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8') + '\nmodule.exports.testRuns = sparrowRuns;', {
    module: mod, process, console, __dirname: path.dirname(sourcePath),
    require(name) {
      if (name === 'electron') return { app: { on() {} }, ipcMain: { handle(key, fn) { handlers[key] = fn; } } };
      return createRequire(sourcePath)(name);
    },
  });
  mod.exports.registerSparrowIpc();
  const load = id => handlers['load-placement-editor'](null, id);
  assert.equal((await load('unknown')).success, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-editor-test-'));
  try {
    const run = { status: 'running', runDir: dir, safeName: 'job', inputPath: path.join(dir, 'job.json') };
    mod.exports.testRuns.set('test', run);
    assert.equal((await load('test')).success, false, 'running jobs cannot be edited');
    run.status = 'completed';
    assert.equal((await load('test')).success, false, 'missing final artifacts cannot be edited');
    fs.writeFileSync(run.inputPath, JSON.stringify({ items: [{ id: 1, ...items[1] }], sheets: [{ width: 100, height: 60 }] }));
    fs.mkdirSync(path.join(dir, 'output/final_job'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'output/final_job/strip_01.svg'), '<svg/>');
    fs.writeFileSync(path.join(dir, 'output/final_job/strip_01.json'), JSON.stringify({ solution: { layout: { placed_items: original } } }));
    fs.writeFileSync(path.join(dir, 'output/final_job/summary.json'), JSON.stringify({ strips: [{ index: 1,
      svg_path: 'output/final_job/strip_01.svg', json_path: 'output/final_job/strip_01.json' }] }));
    for (const status of ['completed', 'stopped']) {
      run.status = status;
      const result = await load('test');
      assert.equal(result.success, true, result.error);
      assert.equal(result.strips[0].placements.length, 3);
      assert.equal(result.items[1].shape.data.length, 4);
    }
    console.log('Placement IPC: completed and early-stopped jobs load; running, missing, and unknown jobs are rejected.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
