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

console.log('DXF grouping matches all-pairs checks; 20,214 disjoint records produce 20,214 candidates.');
