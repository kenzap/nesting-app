const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ── Minimal DOM: just enough for the tooltip's own element handling ──────────
class FakeClassList {
  constructor() { this.names = new Set(); }
  add(name) { this.names.add(name); }
  remove(name) { this.names.delete(name); }
  contains(name) { return this.names.has(name); }
}

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.classList = new FakeClassList();
    this.style = {};
    this.children = [];
    this.attributes = {};
    this.hidden = false;
    this.textContent = '';
  }
  set className(value) { value.split(/\s+/).filter(Boolean).forEach(name => this.classList.add(name)); }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...nodes) { this.children.push(...nodes); }
  // Rendered size grows with the text, like a real wrapped label would.
  get offsetWidth() {
    const text = this.children.map(child => child.textContent).join('');
    return Math.min(340, 20 + 7 * text.length);
  }
  get offsetHeight() { return this.children.some(child => child.textContent && !child.hidden) ? 40 : 26; }
}

const body = new FakeElement('body');
body.appendChild = node => body.children.push(node);
const document = { createElement: tag => new FakeElement(tag), body };
const windowListeners = {};
const window = { addEventListener(type, fn) { windowListeners[type] = fn; } };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '../renderer/views/part-hover-tooltip.js'), 'utf8'),
  { window, document },
);
const { createPartHoverTooltip, itemIdFromHref, describePart, placeTooltip } = window.NestPartHoverTooltip;

// ── itemIdFromHref: only part and collision-outline instances count ──────────
assert.equal(itemIdFromHref('#item_12'), 12);
assert.equal(itemIdFromHref('#cd_shape_3'), 3);
assert.equal(itemIdFromHref('#container_5'), null);
assert.equal(itemIdFromHref('item_1'), null);
assert.equal(itemIdFromHref(''), null);
assert.equal(itemIdFromHref(null), null);

// ── describePart ─────────────────────────────────────────────────────────────
const state = {
  files: [
    { id: 'f1', name: 'Plate A.DXF', path: '/jobs/Plate A.DXF', shapes: [{ id: 'shape_0', name: 'Sketch 1' }] },
    { id: 'f2', name: 'Bracket.dxf', path: '/jobs/Bracket.dxf', shapes: [
      { id: 'shape_0', name: 'Sketch 1' }, { id: 'shape_1', name: 'Sketch 2' },
    ] },
  ],
  lastPlacementExportItems: {
    0: { source_file_id: 'f1', source_name: 'Plate A.DXF', source_shape_id: 'shape_0' },
    1: { source_file_id: 'f2', source_name: 'Bracket.dxf', source_shape_id: 'shape_1' },
    // Stale file id (file was re-added): still resolvable by name.
    2: { source_file_id: 'gone', source_name: 'Bracket.dxf', source_shape_id: 'shape_0' },
    // No source_name and no file that can be resolved: use the path's basename.
    3: { source_file_id: 'gone', source_file: 'C:\\jobs\\Fallback.DXF' },
    // No source_name but the file still exists: the file's own name wins.
    4: { source_file_id: 'f1', source_file: 'C:\\jobs\\Elsewhere.DXF' },
  },
};
assert.deepEqual({ ...describePart(state, 0) }, { name: 'Plate A.DXF', sketch: '' }, 'single-sketch files show no sketch line');
assert.deepEqual({ ...describePart(state, 1) }, { name: 'Bracket.dxf', sketch: 'Sketch 2' }, 'multi-sketch files name the sketch');
assert.equal(describePart(state, 2).sketch, 'Sketch 1', 'falls back to name lookup when the file id is stale');
assert.equal(describePart(state, 3).name, 'Fallback.DXF', 'falls back to the path basename');
assert.equal(describePart(state, 4).name, 'Plate A.DXF', 'a resolvable file supplies its own name');
assert.equal(describePart(state, 99), null, 'unknown item');
assert.equal(describePart({ files: [] }, 0), null, 'no run yet');
assert.equal(describePart({ files: [], lastPlacementExportItems: { 5: {} } }, 5), null, 'metadata without any name');

// ── placeTooltip: offset, flip, clamp ────────────────────────────────────────
const bounds = { left: 0, top: 0, right: 1000, bottom: 600 };
assert.deepEqual({ ...placeTooltip({ x: 100, y: 100, width: 200, height: 40, bounds }) }, { left: 114, top: 118 }, 'below-right of the cursor');
assert.deepEqual({ ...placeTooltip({ x: 900, y: 100, width: 200, height: 40, bounds }) }, { left: 686, top: 118 }, 'flips left near the right edge');
assert.deepEqual({ ...placeTooltip({ x: 100, y: 580, width: 200, height: 40, bounds }) }, { left: 114, top: 531 }, 'flips above near the bottom edge');
assert.equal(placeTooltip({ x: 5, y: 5, width: 2000, height: 40, bounds }).left, 8, 'too wide to fit anywhere: pinned to the left margin');
assert.equal(placeTooltip({ x: 5, y: 5, width: 200, height: 2000, bounds }).top, 8, 'too tall to fit anywhere: pinned to the top margin');

// ── Behaviour: hover → show, move away / leave / disabled / drag → hide ─────
const handlers = {};
const viewport = {
  classList: new FakeClassList(),
  addEventListener(type, fn) { handlers[type] = fn; },
  getBoundingClientRect: () => bounds,
};
const svgInside = new Set();
const svgContainer = { contains: node => svgInside.has(node) };
let enabled = true;
const tooltip = createPartHoverTooltip({ state, dom: { viewport, svgContainer }, isEnabled: () => enabled });
tooltip.init();
assert.ok(windowListeners.blur, 'hides when the window loses focus');

function partTarget(href, { inside = true } = {}) {
  const use = { getAttribute: name => (name === 'href' ? href : null) };
  if (inside) svgInside.add(use);
  return { closest: selector => (selector === 'use' ? use : null) };
}
const emptyTarget = { closest: () => null };
const move = (target, x = 100, y = 100) => handlers.mousemove({ target, clientX: x, clientY: y });
const tip = () => body.children[0];
const isShown = () => !!tip() && tip().classList.contains('visible');
const nameText = () => tip().children[0].textContent;
const subText = () => tip().children[1];

assert.equal(tip(), undefined, 'nothing is created until a part is hovered');
move(emptyTarget);
assert.equal(tip(), undefined, 'hovering empty sheet area creates nothing');

move(partTarget('#item_0'));
assert.ok(isShown());
assert.equal(nameText(), 'Plate A.DXF');
assert.equal(subText().hidden, true, 'no sketch line for single-sketch files');
assert.ok(/translate\(114px, 118px\)/.test(tip().style.transform), 'positioned beside the cursor');

move(partTarget('#item_0'), 300, 250);
assert.ok(/translate\(314px, 268px\)/.test(tip().style.transform), 'follows the cursor within the same part');

move(partTarget('#item_1'));
assert.equal(nameText(), 'Bracket.dxf', 'content switches when the hovered part changes');
assert.equal(subText().textContent, 'Sketch 2');
assert.equal(subText().hidden, false);

move(partTarget('#cd_shape_0'));
assert.equal(nameText(), 'Plate A.DXF', 'the dashed collision outline of a part counts as the part');

move(emptyTarget);
assert.equal(isShown(), false, 'hides once the pointer leaves the part');

move(partTarget('#item_0', { inside: false }));
assert.equal(isShown(), false, 'ignores <use> elements outside the nesting SVG');

move(partTarget('#item_0'));
assert.ok(isShown());
enabled = false;
move(partTarget('#item_0'));
assert.equal(isShown(), false, 'hidden when cursor readouts are off or the measure tool is active');
enabled = true;

viewport.classList.add('dragging');
move(partTarget('#item_0'));
assert.equal(isShown(), false, 'hidden while panning');
viewport.classList.remove('dragging');

move(partTarget('#item_0'));
assert.ok(isShown());
handlers.mouseleave();
assert.equal(isShown(), false, 'hidden when the pointer leaves the canvas');

move(partTarget('#item_0'));
handlers.mousedown();
assert.equal(isShown(), false, 'hidden on click/drag start');

// A new run reuses item ids for different files: stale text must not linger.
move(partTarget('#item_0'));
assert.equal(nameText(), 'Plate A.DXF');
state.lastPlacementExportItems = { 0: { source_file_id: 'f2', source_name: 'Bracket.dxf', source_shape_id: 'shape_0' } };
move(partTarget('#item_0'));
assert.equal(nameText(), 'Bracket.dxf', 'content refreshes when the run changes the id → file mapping');
assert.equal(subText().textContent, 'Sketch 1');

move(partTarget('#item_77'));
assert.equal(isShown(), false, 'an id with no metadata shows nothing rather than a blank tooltip');

console.log('Part tooltip names the hovered part\'s source file, follows the cursor, flips at edges, and hides when it should.');
