// Regression: a part drawn as a single outline must not report that outline as
// a hole in itself. The phantom hole covers the whole part, so the engraving
// label layout (preview and DXF export alike) could never find room and the
// label silently vanished.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DxfParser = require('dxf-parser');
const Flatten = require('@flatten-js/core');

const root = path.resolve(__dirname, '..');
const sandbox = {
  console, Flatten, URL, Blob, setTimeout, clearTimeout,
  location: { href: 'file:///engraving-label-test', search: '' },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
[
  'shared/constants.js', 'shared/settings.js', 'shared/engraving-layout.js',
  'node_modules/jsts/dist/jsts.min.js', 'renderer/vendor/concaveman.js', 'node_modules/rbush/rbush.min.js',
  'renderer/utils/dxf-color.js', 'renderer/utils/dxf-geometry.js', 'renderer/utils/dxf-svg.js',
  'renderer/utils/dxf-preview-state.js', 'renderer/services/dxf-layer-service.js',
  'renderer/services/dxf-export-metadata-service.js', 'renderer/services/dxf-flatten-service.js',
  'renderer/services/dxf-shape-detection-service.js', 'renderer/utils/contour-helpers.js',
  'renderer/services/contour-detection-jsts-service.js', 'renderer/services/contour-detection-service.js',
  'renderer/services/dxf-shape-structure-service.js', 'renderer/services/dxf-engraving-preview-service.js',
  'renderer/services/dxf-preview-service.js',
].forEach(rel => vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), sandbox, { filename: rel }));

const { layoutEngravingLabel } = sandbox.NestEngravingLayout;

function parseShapes(dxfText) {
  sandbox.__json = JSON.stringify(new DxfParser().parseSync(dxfText));
  vm.runInContext('window.__parsed = JSON.parse(window.__json)', sandbox);
  return sandbox.NestDxfPreviewService.parseDXFToShapes(sandbox.__parsed, dxfText, {
    multiSketchDetection: true,
    sketchContourMethod: 'auto',
  }).shapes;
}

const dxf = body => `0\nSECTION\n2\nENTITIES\n${body}0\nENDSEC\n0\nEOF\n`;
const lwpolyline = (closedFlag, points) =>
  `0\nLWPOLYLINE\n8\nCUT\n90\n${points.length}\n70\n${closedFlag}\n`
  + points.map(([x, y]) => `10\n${x}\n20\n${y}\n`).join('');
// Old-style heavy POLYLINE as written by some CAD exporters: no closed flag,
// the outline closes by repeating its first vertex.
const legacyPolyline = points =>
  '0\nPOLYLINE\n8\nCUT\n66\n1\n'
  + points.map(([x, y]) => `0\nVERTEX\n8\nCUT\n10\n${x}\n20\n${y}\n`).join('')
  + '0\nSEQEND\n8\nCUT\n';
const circle = (x, y, r) => `0\nCIRCLE\n8\nCUT\n10\n${x}\n20\n${y}\n40\n${r}\n`;

// Long label on purpose for the big plate: it is what real file names look like.
// (A 43-character name genuinely cannot fit a 300 mm part, so small parts get a
// short label — the point is "fits when there is room", not "always fits".)
const LONG_LABEL = 'Metalowcow 2 - Rumia_plyty na stopni_1_Sto3';
const SHORT_LABEL = 'PART-1';
const labelFits = (shape, label) => !!layoutEngravingLabel({
  text: label, outerPolygon: shape.engravingPolygonPoints, holes: shape.engravingHoles,
});

function assertNoPhantomHole(name, text, label = SHORT_LABEL) {
  const shapes = parseShapes(text);
  assert.equal(shapes.length, 1, `${name}: one shape`);
  const [shape] = shapes;
  assert.equal(shape.engravingHoles.length, 0, `${name}: preview reports no hole`);
  assert.equal(shape.holes.length, 0, `${name}: export payload reports no hole`);
  assert.ok(labelFits(shape, label), `${name}: label fits`);
}

// The reporter's plate: 932 x 242 mm, single legacy polyline outline.
const plate = [[932.065, 241.875], [932.075, 0], [0.953, 0], [0, 241.875]];
assertNoPhantomHole('legacy polyline, repeated first vertex, no closed flag',
  dxf(legacyPolyline([...plate, plate[0]])), LONG_LABEL);

const rect = [[0, 0], [300, 0], [300, 100], [0, 100]];
assertNoPhantomHole('closed LWPOLYLINE', dxf(lwpolyline(1, rect)));
assertNoPhantomHole('open LWPOLYLINE closed by repeating its first vertex', dxf(lwpolyline(0, [...rect, rect[0]])));
assertNoPhantomHole('lone CIRCLE (round blank)', dxf(circle(200, 200, 150)));

// Real holes must survive: the filter only drops a contour that IS the outline.
const withHole = parseShapes(dxf(lwpolyline(1, rect) + circle(150, 50, 20)));
assert.equal(withHole.length, 1);
assert.equal(withHole[0].engravingHoles.length, 1, 'a real hole is kept');
assert.equal(withHole[0].holes.length, 1);
assert.ok(layoutEngravingLabel({ text: 'PART-1', outerPolygon: withHole[0].engravingPolygonPoints, holes: withHole[0].engravingHoles }));

const nested = parseShapes(dxf(lwpolyline(1, rect) + lwpolyline(1, [[100, 30], [200, 30], [200, 70], [100, 70]])));
assert.equal(nested[0].engravingHoles.length, 1, 'an inner outline is a hole');

// A hole that nearly fills the part but sits strictly inside it is still a hole.
const frame = parseShapes(dxf(lwpolyline(1, rect) + lwpolyline(1, [[10, 10], [290, 10], [290, 90], [10, 90]])));
assert.equal(frame[0].engravingHoles.length, 1, 'a close-fitting inner contour is not mistaken for the outline');

console.log('Single-outline parts report no phantom hole, so labels fit; real holes are preserved.');
