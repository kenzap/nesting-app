const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const flattenBundle = source('node_modules/@flatten-js/core/dist/main.umd.js');
const rbushBundle = source('node_modules/rbush/rbush.min.js');
const geometrySource = source('renderer/utils/dxf-geometry.js');
const groupingSource = source('renderer/services/dxf-flatten-service.js');

function groupingService(makeTree = Tree => Tree) {
  const context = vm.createContext({});
  context.window = context;
  vm.runInContext(flattenBundle, context);
  vm.runInContext(rbushBundle, context);
  assert.equal(typeof context.RBush, 'function', 'browser bundle must expose RBush');
  context.RBush = makeTree(context.RBush);
  vm.runInContext(geometrySource, context);
  vm.runInContext(groupingSource, context);
  return context.NestDxfFlattenService;
}

class AllPairsIndex {
  load(items) { this.items = items; }
  search() { return this.items; }
}

const indexed = groupingService();
const allPairs = groupingService(() => AllPairsIndex);
const line = (id, x1, y1, x2, y2) => ({
  id,
  type: 'LINE',
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
});
const circle = (id, x, y, radius) => ({
  id,
  type: 'CIRCLE',
  center: { x, y },
  radius,
});
const groupsAsIds = groups => Array.from(groups, group => Array.from(group, entity => entity.id));

function compare(entities) {
  assert.deepEqual(
    groupsAsIds(indexed.buildSketchGroups(entities)),
    groupsAsIds(allPairs.buildSketchGroups(entities)),
  );
}

const fixtures = [
  line('touching', 0, 0, 1, 0),
  line('near-endpoint', 1.0005, 0, 2, 0),
  line('separate', 2.005, 0, 3, 0),
  line('crossing', 0.5, -1, 0.5, 1),
  circle('outer', 20, 20, 5),
  line('inside', 19, 20, 21, 20),
  line('outside', 30, 20, 31, 20),
  { id: 'polyline', type: 'LWPOLYLINE', closed: true, vertices: [
    { x: 40, y: 40 }, { x: 43, y: 40 },
    { x: 43, y: 43 }, { x: 40, y: 43 },
  ] },
  line('polyline-inside', 41, 41, 42, 42),
];
compare(fixtures);
assert.deepEqual(groupsAsIds(indexed.buildSketchGroups(fixtures)), [
  ['touching', 'near-endpoint', 'crossing'],
  ['outer', 'inside'],
  ['polyline', 'polyline-inside'],
  ['separate'],
  ['outside'],
]);

for (let seed = 1; seed <= 10; seed++) {
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const entities = Array.from({ length: 60 }, (_, id) => {
    const x = random() * 20;
    const y = random() * 20;
    return line(id, x, y, x + random() * 3, y + random() * 3);
  });
  compare(entities);
}

const polyline = (id, vertices, closed = false) => ({ id, type: 'POLYLINE', vertices, closed });
const denseWave = (id, count, offset) => polyline(id, Array.from({ length: count + 1 }, (_, i) => ({
  x: -15 + 30 * i / count,
  y: Math.sin(6 * i / count) * 5 + offset,
})));

// These records have overlapping bounding boxes but no intersecting segments.
// The reference index deliberately returns every segment, not just nearby ones.
compare([denseWave('wave-a', 250, 0), denseWave('wave-b', 250, 1.5)]);
assert.equal(indexed.buildSketchGroups([denseWave('a', 250, 0), denseWave('b', 250, 1.5)]).length, 2);

const chain = polyline('dense-chain', Array.from({ length: 301 }, (_, i) => ({ x: i - 300, y: 0 })));
for (const gap of [0, 0.0005, 0.001, 0.0011, 0.005]) {
  const entities = [chain, line('near', gap, 0, 2, 0)];
  compare(entities);
  assert.equal(indexed.buildSketchGroups(entities).length, gap <= 0.001 ? 1 : 2);
  compare([...entities].reverse()); // Either record can own the larger segment index.
}
compare([chain, line('cross-interior', -150.5, -1, -150.5, 1)]);
compare([chain, line('collinear-overlap', -100.5, 0, -102.5, 0)]);
compare([chain, polyline('reverse-duplicate', [...chain.vertices].reverse())]);

const denseRing = polyline('dense-ring', Array.from({ length: 360 }, (_, i) => ({
  x: Math.cos(i * Math.PI / 180) * 10,
  y: Math.sin(i * Math.PI / 180) * 10,
})), true);
const contained = [denseRing, line('interior-line', -1, 0, 1, 0), circle('interior-circle', 3, 0, 0.5)];
compare(contained);
assert.equal(indexed.buildSketchGroups(contained).length, 1,
  'containment must still run when the segment index finds no edge contacts');

let segmentCandidates = 0;
let segmentTrees = 0;
const denseIndexed = groupingService(Tree => class CountingSegmentRBush extends Tree {
  load(items) {
    this.isSegmentIndex = !!items[0]?.segment;
    if (this.isSegmentIndex) segmentTrees++;
    return super.load(items);
  }
  search(box) {
    const found = super.search(box);
    if (this.isSegmentIndex) segmentCandidates += found.length;
    return found;
  }
});
assert.equal(denseIndexed.buildSketchGroups([
  denseWave('dense-a', 3000, 0), denseWave('dense-b', 3000, 1.5),
  denseWave('dense-c', 3000, 3),
]).length, 3);
assert.equal(segmentTrees, 2, 'segment trees are built lazily and reused across record pairs');
assert.ok(segmentCandidates < 270000, 'prune at least 99% of the 27 million dense segment pairs');

let candidates = 0;
const disjoint = groupingService(Tree => class CountingRBush extends Tree {
  search(box) {
    const found = super.search(box);
    candidates += found.length;
    return found;
  }
});
const largeDrawing = Array.from({ length: 20214 }, (_, id) =>
  line(id, id * 10, 0, id * 10 + 1, 0));
assert.equal(disjoint.buildSketchGroups(largeDrawing).length, largeDrawing.length);
assert.equal(candidates, largeDrawing.length, 'disjoint records should only find themselves');

console.log(`DXF grouping matches all-pairs checks, including dense curves and tolerance boundaries. Dense segment candidates: ${segmentCandidates}/27000000; 20,214 disjoint records produce 20,214 candidates.`);
