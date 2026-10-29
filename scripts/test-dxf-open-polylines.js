const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DxfParser = require('dxf-parser');

const root = path.resolve(__dirname, '..');
const sandbox = { console, URL, Blob, setTimeout, clearTimeout };
sandbox.window = sandbox;
vm.createContext(sandbox);
// Flatten uses instanceof Array internally; load it in the same realm as the
// services so polygon operations are exercised rather than silently rejected.
vm.runInContext(fs.readFileSync(path.join(root, 'node_modules/@flatten-js/core/dist/main.umd.js'), 'utf8'), sandbox);
const Flatten = sandbox['@flatten-js/core'];
let degenerateUnionAttempts = 0;
const guardedFlatten = {
  ...Flatten,
  BooleanOperations: {
    ...Flatten.BooleanOperations,
    unify(a, b) {
      if (Math.abs(a.area()) <= 1e-6 || Math.abs(b.area()) <= 1e-6) {
        degenerateUnionAttempts++;
        // Fail safely instead of allowing a regressed implementation to hang.
        throw new Error('Zero-area polygon reached Boolean union');
      }
      return Flatten.BooleanOperations.unify(a, b);
    },
  },
};
sandbox.Flatten = guardedFlatten;
[
  'shared/constants.js', 'shared/settings.js',
  'node_modules/jsts/dist/jsts.min.js', 'renderer/vendor/concaveman.js',
  'node_modules/rbush/rbush.min.js',
  'renderer/utils/dxf-color.js', 'renderer/utils/dxf-geometry.js', 'renderer/utils/dxf-svg.js',
  'renderer/utils/dxf-preview-state.js', 'renderer/services/dxf-layer-service.js',
  'renderer/services/dxf-export-metadata-service.js', 'renderer/services/dxf-flatten-service.js',
  'renderer/services/dxf-shape-detection-service.js', 'renderer/utils/contour-helpers.js',
  'renderer/services/dxf-raster-envelope-service.js',
  'renderer/services/contour-detection-jsts-service.js', 'renderer/services/contour-detection-service.js',
  'renderer/services/dxf-shape-structure-service.js', 'renderer/services/dxf-preview-service.js',
].forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file }));

const geometry = sandbox.NestDxfGeometry;
const document = body => `0\nSECTION\n2\nENTITIES\n${body}0\nENDSEC\n0\nEOF\n`;
function polyline(type, points, flags = 0) {
  if (type === 'LWPOLYLINE') {
    return `0\n${type}\n8\nCUT\n70\n${flags}\n90\n${points.length}\n`
      + points.map(p => `10\n${p.x}\n20\n${p.y}\n`).join('');
  }
  return `0\nPOLYLINE\n8\nCUT\n66\n1\n70\n${flags}\n`
    + points.map(p => `0\nVERTEX\n8\nCUT\n10\n${p.x}\n20\n${p.y}\n30\n0\n`).join('')
    + '0\nSEQEND\n8\nCUT\n';
}
const line = (a, b) => `0\nLINE\n8\nCUT\n10\n${a.x}\n20\n${a.y}\n11\n${b.x}\n21\n${b.y}\n`;
const parse = text => new DxfParser().parseSync(text);
const arch = (radius, count, x = 0, y = 0) => Array.from({ length: count + 1 }, (_, i) => ({
  x: x + radius * Math.sin(Math.PI * i / count),
  y: y + radius * (1 - Math.cos(Math.PI * i / count)),
}));

for (const type of ['POLYLINE', 'LWPOLYLINE']) {
  const points = arch(10, 80);
  const raw = document(polyline(type, points, type === 'POLYLINE' ? 8 : 0));
  const [curve] = parse(raw).entities;
  assert.equal(curve.shape, false, `${type}: parser reports an open curve`);
  assert.equal(curve.closed, undefined);
  assert.equal(geometry.isPolylineClosed(curve), false);
  const svg = sandbox.NestDxfSvg.entityToSVGStr(curve, 0, 20, '#000');
  assert.ok(!/\bZ\s*["']/i.test(svg), `${type}: no artificial closing chord in SVG`);
  assert.equal(sandbox.NestDxfFlattenService.extractPolygonForEntities([curve]), null);
  assert.equal(geometry.isPolylineClosed({ ...curve, shape: true }), true);
  assert.equal(geometry.isPolylineClosed({ ...curve, vertices: [...points, points[0]] }), true);
  assert.equal(geometry.isPolylineClosed({ type, vertices: points }), false);

  // The source curve and adjoining line use different rounding precisions.
  // The joins straddle quantization boundaries but are only 0.00002 apart.
  points[0].x = 0.00049;
  points[points.length - 1].x = 0.00049;
  const closingLine = line({ x: 0.00051, y: 20 }, { x: 0.00051, y: 0 });
  const hole = arch(2, 30, 3, 8);
  const text = document(polyline(type, points) + closingLine
    + polyline(type, hole) + line(hole[hole.length - 1], hole[0]));
  const dxf = parse(text);
  const original = JSON.stringify(dxf.entities);
  const loops = sandbox.NestDxfShapeDetectionService.buildClosedContoursFromLines(dxf.entities);
  assert.equal(loops.length, 2, `${type}: outer contour and cutout assembled from two edges each`);
  assert.ok(Math.max(...loops.map(loop => Math.abs(geometry.polygonSignedArea(loop.points)))) > 156);
  for (const mode of ['auto', 'arrangement']) {
    const result = sandbox.NestDxfPreviewService.parseDXFToShapes(parse(text), text, {
      multiSketchDetection: true, sketchContourMethod: mode,
    });
    assert.equal(result.shapes.length, 1, `${type}/${mode}: cutout stays with its parent`);
    const [shape] = result.shapes;
    assert.equal(shape.holes.length, 1, `${type}/${mode}: real cutout is retained`);
    assert.equal(shape.engravingHoles.length, 1);
    assert.equal(shape.exportEntities.length, 4, 'source entities survive export metadata');
    assert.ok(shape.exportEntities.filter(e => e.type === type).every(e => !e.closed),
      'export does not invent closing lines');
    assert.equal(shape.nestingPolygon.source, 'jsts-arrangement');
  }
  // Loop inference may add private metadata but must not alter source vertices.
  assert.deepEqual(dxf.entities.map(e => e.vertices), JSON.parse(original).map(e => e.vertices));
}

// A dense sampled curve must not become disconnected when individual segments
// are shorter than the join tolerance. Precision reduction can collapse points,
// but must retain the intervening chain rather than simply deleting segments.
const dense = arch(2, 4000);
const denseText = document(polyline('POLYLINE', dense) + line(dense[dense.length - 1], dense[0]));
const entities = parse(denseText).entities;
const arrangement = sandbox.NestDxfContourDetectionJstsService.buildArrangementContour({ entities }, { tolerance: 0.001 });
assert.equal(arrangement.source, 'jsts-arrangement');
assert.ok(Math.abs(Math.abs(geometry.polygonSignedArea(arrangement.polygonPoints)) - 2 * Math.PI) < 0.02);

const snap = geometry.createEndpointSnapper(0.001);
assert.equal(snap({ x: 0.00099, y: 0 }), snap({ x: 0.00101, y: 0 }), 'joins cross cell boundaries');
assert.notEqual(snap({ x: 1, y: 1 }), snap({ x: 1.002, y: 1 }), 'gaps outside tolerance stay open');

// dxf-parser reports a negative angleLength for an arc crossing zero degrees.
// Taking its absolute value would draw the long arc and a spurious loop.
const arcText = document('0\nARC\n8\nCUT\n10\n0\n20\n0\n40\n2\n50\n270\n51\n0\n'
  + line({ x: 2, y: 0 }, { x: 0, y: -2 }));
const arcLoops = sandbox.NestDxfShapeDetectionService.buildClosedContoursFromLines(parse(arcText).entities);
assert.equal(arcLoops.length, 1);
assert.ok(Math.abs(Math.abs(geometry.polygonSignedArea(arcLoops[0].points)) - (Math.PI - 2)) < 0.03);

const rectangle = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }];
const partitionedText = document(rectangle.map((p, i) => line(p, rectangle[(i + 1) % 4])).join('')
  + line({ x: 20, y: 0 }, { x: 20, y: 20 }));
const partitioned = sandbox.NestDxfPreviewService.parseDXFToShapes(parse(partitionedText), partitionedText, {
  multiSketchDetection: true,
});
assert.equal(partitioned.shapes.length, 1);
assert.equal(partitioned.shapes[0].holes.length, 0, 'construction faces touching the outer contour are not holes');
// A hole concentric with a rounded corner may already share the initial group
// with the open outline. It must not replace the assembled outer boundary.
const circle = (x, y) => `0\nCIRCLE\n8\nCUT\n10\n${x}\n20\n${y}\n40\n0.5\n`;
const rounded = document('0\nARC\n8\nCUT\n10\n2\n20\n2\n40\n2\n50\n180\n51\n270\n'
  + line({ x: 2, y: 0 }, { x: 10, y: 0 })
  + line({ x: 10, y: 0 }, { x: 10, y: 10 })
  + line({ x: 10, y: 10 }, { x: 0, y: 10 })
  + line({ x: 0, y: 10 }, { x: 0, y: 2 })
  + circle(2, 2) + circle(5, 2) + circle(8, 2) + circle(8, 8));
const roundedResult = sandbox.NestDxfPreviewService.parseDXFToShapes(parse(rounded), rounded, {
  multiSketchDetection: true,
});
assert.equal(roundedResult.shapes.length, 1, 'all four holes belong to the rounded plate');
assert.equal(roundedResult.shapes[0].holes.length, 4);
assert.equal(roundedResult.shapes[0].exportEntities.length, 9);
const roundedEntities = parse(rounded).entities;
const preGrouped = sandbox.NestDxfShapeStructureService.detectShapes(roundedEntities, {
  initialGroups: [roundedEntities.slice(0, 6), ...roundedEntities.slice(6).map(entity => [entity])],
});
assert.equal(preGrouped.length, 1, 'a pre-grouped hole must not hide the assembled outline');
assert.equal(preGrouped[0].childClosedContours.length, 4);

// A separate part inside a concave outline's bounding box is not a hole when
// it sits in the empty notch rather than inside the actual material boundary.
const concavePoints = [
  { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 3 },
  { x: 3, y: 3 }, { x: 3, y: 10 }, { x: 0, y: 10 },
];
const concaveEntities = parse(document(polyline('POLYLINE', concavePoints)
  + line(concavePoints.at(-1), concavePoints[0])
  + circle(1, 1) + circle(2, 8) + circle(7, 7))).entities;
const concaveGroups = sandbox.NestDxfShapeStructureService.detectShapes(concaveEntities, {
  initialGroups: [concaveEntities.slice(0, 3), ...concaveEntities.slice(3).map(entity => [entity])],
});
assert.equal(concaveGroups.length, 2, 'a part in the empty notch remains independent');
assert.equal(concaveGroups.find(group => group.entities.length === 4)?.childClosedContours.length, 2);

// Closed, linear splines can retrace a boundary without enclosing any area.
// They are source linework, not filled polygons or additional cutouts.
const retracedSpline = '0\nSPLINE\n8\nCUT\n70\n11\n71\n3\n72\n8\n73\n4\n'
  + [0, 0, 0, 0, 1, 1, 1, 1].map(knot => `40\n${knot}\n`).join('')
  + [0, 2, 4, 0].map(x => `10\n${x}\n20\n20\n30\n0\n`).join('');
const degenerateText = document(polyline('LWPOLYLINE', rectangle, 1)
  + retracedSpline + circle(5, 5) + circle(15, 5));
const degenerateEntities = parse(degenerateText).entities;
assert.equal(sandbox.NestDxfFlattenService.extractPolygonForEntities([degenerateEntities[1]]), null);
const validPolygon = sandbox.NestDxfFlattenService.extractPolygonForEntities(degenerateEntities.slice(0, 2));
assert.equal(validPolygon.area, 800, 'zero-area spline does not alter the filled outline');
const degenerateResult = sandbox.NestDxfPreviewService.parseDXFToShapes(parse(degenerateText), degenerateText, {
  multiSketchDetection: true,
});
assert.equal(degenerateUnionAttempts, 0, 'zero-area polygons never reach Boolean union');
assert.equal(degenerateResult.shapes.length, 1);
assert.equal(degenerateResult.shapes[0].holes.length, 2, 'real cutouts are retained');
assert.equal(degenerateResult.shapes[0].exportEntities.length, 4, 'degenerate source linework is retained');
assert.ok(degenerateResult.shapes[0].exportEntities.some(entity => entity.type === 'SPLINE'));
// A notched plate with a short break in a straight top edge and an overshoot
// at the bottom of the notch. Interior slots must not become a hull outline.
function notchedPlate(gap = 0.3, verticalOffset = 0) {
  const outline = [
    [[0, 0], [50, 0]], [[50, 0], [50, 65]],
    [[50, 65], [27 + gap, 65]], [[27, 65 - verticalOffset], [27, 48]],
    [[27, 48], [23.7, 48]], [[24, 48], [24, 65]],
    [[24, 65], [0, 65]], [[0, 65], [0, 0]],
  ];
  const holes = [[4, 26], [29, 26], [4, 51], [29, 51]].flatMap(([x, y]) => {
    const points = [[x, y], [x + 15, y], [x + 15, y + 3], [x, y + 3]];
    return points.map((p, i) => [p, points[(i + 1) % 4]]);
  });
  return document([...outline, ...holes].map(([a, b]) =>
    line({ x: a[0], y: a[1] }, { x: b[0], y: b[1] })).join(''));
}
const notchedText = notchedPlate();
const notchedEntities = parse(notchedText).entities;
const notchedOriginal = JSON.stringify(notchedEntities);
const notchedResult = sandbox.NestDxfPreviewService.parseDXFToShapes({ entities: notchedEntities }, notchedText, {
  multiSketchDetection: true,
});
assert.equal(notchedResult.shapes.length, 1);
const notched = notchedResult.shapes[0];
assert.equal(notched.selectionPolygonSource, 'jsts-arrangement');
assert.equal(notched.nestingPolygonBuilderDebug.gapBridgeCount, 1);
assert.equal(notched.holes.length, 4);
assert.equal(notched.exportEntities.length, 24, 'repair is not added to exported source linework');
assert.ok(Math.abs(notched.nestingPolygon.area - 3199) < 0.1, 'notch is retained, slots do not distort the outer');
assert.deepEqual(notchedEntities.map(e => e.vertices), JSON.parse(notchedOriginal).map(e => e.vertices));
const detectNotched = text => sandbox.NestDxfContourDetectionJstsService.buildArrangementContour({
  entities: parse(text).entities,
}, { tolerance: 0.001 });
assert.equal(detectNotched(notchedPlate(0)).builderDebug.gapBridgeCount, undefined, 'valid outline needs no repair');
assert.equal(detectNotched(notchedPlate(2)).builderDebug.gapBridgeCount, undefined, 'large openings are not bridged');
assert.equal(detectNotched(notchedPlate(0.3, 0.3)).builderDebug.gapBridgeCount, undefined, 'no diagonal invented edges');
const appendLinework = body => notchedText.replace('0\nENDSEC', `${body}0\nENDSEC`);
assert.equal(detectNotched(appendLinework(line({ x: 27.1, y: 65 }, { x: 27.1, y: 60 })))
  .builderDebug.gapBridgeCount, undefined, 'ambiguous competing endpoints are not bridged');
assert.equal(detectNotched(appendLinework(line({ x: 27.1, y: 64 }, { x: 27.1, y: 66 })))
  .builderDebug.gapBridgeCount, undefined, 'a repair must not cross other linework');
const reversed = parse(notchedText).entities.reverse().map(e => ({ ...e, vertices: [...e.vertices].reverse() }));
const reverseResult = sandbox.NestDxfContourDetectionJstsService.buildArrangementContour({ entities: reversed });
assert.equal(reverseResult.builderDebug.gapBridgeCount, 1, 'repair is independent of line order and direction');
assert.ok(Math.abs(reverseResult.area - 3199) < 0.1);
console.log('Open DXF curves, cutouts, degenerate splines, and bounded straight-gap repair passed.');
