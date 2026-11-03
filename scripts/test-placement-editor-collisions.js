'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const Flatten = require('@flatten-js/core');
const editor = require('../shared/placement-editor');
const rect = (x, y, w, h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const item = data => ({ shape: { data } });
const placed = (id, x = 100, y = 100, rotation = 0) => ({
  item_id: id, transformation: { rotation, translation: [x,y] },
});
const frame = { width: 500, height: 500, margin: 0 };

function checkPair(first, second, expected, message) {
  for (const reversed of [false,true]) {
    const items = { 0: item(reversed ? first.slice().reverse() : first), 1: item(second) };
    const placements = [placed(0), placed(1)];
    for (const index of [0,1]) assert.equal(editor.validateMove(placements, index, items, frame), expected, message);
  }
}

checkPair(rect(0,4,10,2), rect(4,0,2,10), 'collision', 'crossing with no interior vertices');
checkPair(rect(0,0,10,10), [[0,5],[5,0],[10,5],[5,10]], 'collision', 'inscribed polygon vertices all touch');
checkPair(rect(0,0,10,10), rect(10,2,5,4), null, 'partial shared edge is not an overlap');
checkPair(rect(0,0,10,10), rect(10,10,5,4), null, 'single vertex contact');
checkPair(rect(0,0,10,10), [[0,0],[5,0],[10,0],[10,10],[0,10]], 'collision', 'identical area with subdivided edges');
checkPair(rect(0,0,10,10), rect(9.9999,2,5,4), 'collision', 'small but real penetration');
checkPair(rect(0,0,10,10), rect(10.0001,2,5,4), null, 'small positive gap');
checkPair([[0,0],[20,0],[20,20],[12,20],[12,5],[8,5],[8,20],[0,20]], rect(9,10,2,5), null, 'concave notch');
checkPair([[0,0],[20,0],[20,20],[12,20],[12,5],[8,5],[8,20],[0,20]], rect(7,10,6,5), 'collision', 'crossing a concave notch');

// Compare independent boundary predicates with full clipping on small, seeded
// polygons. Dense production contours are deliberately not used as an oracle.
let seed = 82741;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const star = () => Array.from({ length: 12 }, (_, i) => {
  const angle = i * Math.PI / 6, radius = 5 + random() * 15;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
});
const polygon = points => new Flatten.Polygon(points.map(p => new Flatten.Point(...p)));
for (let n = 0; n < 250; n++) {
  const items = { 0: item(star()), 1: item(star()) };
  const placements = [placed(0,100,100,random()*360), placed(1,75+random()*50,75+random()*50,random()*360)];
  const polygons = placements.map(p => polygon(editor.transform(editor.outline(items[p.item_id]), p)));
  const expected = Flatten.BooleanOperations.intersect(...polygons).area() > 1e-6 ? 'collision' : null;
  for (const index of [0,1]) assert.equal(editor.validateMove(placements,index,items,frame),expected,`seeded pair ${n}`);
}

// Repeatedly approach contact between a small curved arch and a dense rib.
// The timeout makes a synchronous geometry regression fail rather than hang CI.
function denseContact() {
  const ellipse = Array.from({length:6000}, (_, i) => {
    const a = i * Math.PI * 2 / 6000;
    return [6 * Math.cos(a), 80 * Math.sin(a)];
  });
  const arc = (r, reverse) => Array.from({length:101}, (_, i) => {
    const a = (reverse ? 100-i : i) * Math.PI / 100;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
  const items = { 0:item([...arc(12,false),...arc(8,true)]), 1:item(ellipse) };
  const original = [placed(0,100,180),placed(1,100,100)];
  const saved = JSON.stringify(items);
  const start = performance.now();
  let low = 0, high = 10;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    const pair = [placed(0,100,180-mid),original[1]];
    if (editor.validateMove(pair,0,items,frame)) high = mid; else low = mid;
  }
  assert.ok(Math.abs(low - 8) < 0.002, `curved contact remains accurate: ${low}`);
  assert.equal(editor.validateMove([placed(0,100,171),original[1]],0,items,frame),'collision');
  assert.equal(editor.validateMove([placed(0,100,173),original[1]],0,items,frame),null);
  assert.equal(JSON.stringify(items),saved,'cached geometry never modifies source contours');
  // The cache must not reuse a stationary copy after its transform changes.
  assert.equal(editor.validateMove([original[0],placed(1,100,110)],0,items,frame),'collision');
  assert.equal(editor.validateMove(original,0,items,frame),null);
  return performance.now() - start;
}
const elapsed = vm.runInNewContext('denseContact()', { denseContact }, { timeout: 5000 });
console.log(`Editor collisions: shared contact, winding, concavity, 250 reference pairs, and dense curved contact passed (${elapsed.toFixed(0)} ms).`);
