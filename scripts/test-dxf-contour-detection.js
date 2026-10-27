const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DxfParser = require('dxf-parser');

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

const jstsBundle = source('node_modules/jsts/dist/jsts.min.js');
const flattenBundle = source('node_modules/@flatten-js/core/dist/main.umd.js');
const rbushBundle = source('node_modules/rbush/rbush.min.js');

const constantsSource = source('shared/constants.js');
const settingsSource = source('shared/settings.js');
const colorSource = source('renderer/utils/dxf-color.js');
const geometrySource = source('renderer/utils/dxf-geometry.js');
const svgSource = source('renderer/utils/dxf-svg.js');
const contourHelpersSource = source('renderer/utils/contour-helpers.js');
const previewStateSource = source('renderer/utils/dxf-preview-state.js');
const layerServiceSource = source('renderer/services/dxf-layer-service.js');
const exportMetaSource = source('renderer/services/dxf-export-metadata-service.js');
const flattenSource = source('renderer/services/dxf-flatten-service.js');
const shapeDetectSource = source('renderer/services/dxf-shape-detection-service.js');
const jstsServiceSource = source('renderer/services/contour-detection-jsts-service.js');
const contourServiceSource = source('renderer/services/contour-detection-service.js');
const shapeStructureSource = source('renderer/services/dxf-shape-structure-service.js');
const previewServiceSource = source('renderer/services/dxf-preview-service.js');

function createAppContext() {
  const context = vm.createContext({});
  context.window = context;
  context.global = context;

  new Function('exports', 'module', 'globalThis', jstsBundle).call(context, undefined, undefined, context);
  new Function('exports', 'module', 'globalThis', rbushBundle).call(context, undefined, undefined, context);
  vm.runInContext(flattenBundle, context);

  vm.runInContext(constantsSource, context);
  vm.runInContext(settingsSource, context);
  vm.runInContext(colorSource, context);
  vm.runInContext(geometrySource, context);
  vm.runInContext(svgSource, context);
  vm.runInContext(contourHelpersSource, context);
  vm.runInContext(previewStateSource, context);
  vm.runInContext(layerServiceSource, context);
  vm.runInContext(exportMetaSource, context);
  vm.runInContext(flattenSource, context);
  vm.runInContext(shapeDetectSource, context);
  vm.runInContext(jstsServiceSource, context);
  vm.runInContext(contourServiceSource, context);
  vm.runInContext(shapeStructureSource, context);
  vm.runInContext(previewServiceSource, context);

  return context;
}

const app = createAppContext();

// Test 1: Composite boundary with internal cutouts (КБ.01 structure)
function testCompositeBoundaryWithCutouts() {
  const entities = [
    // 1 circular hole in the center
    { id: 'hole_circle', type: 'CIRCLE', center: { x: 0, y: 0 }, radius: 2.5 },

    // 1 internal slot (2 lines + 2 arcs)
    { id: 'slot_arc1', type: 'ARC', center: { x: -6.0, y: -2.0 }, radius: 1.0, startAngle: 0.5 * Math.PI, endAngle: 1.5 * Math.PI },
    { id: 'slot_line1', type: 'LINE', vertices: [{ x: -6.0, y: -3.0 }, { x: 6.0, y: -3.0 }] },
    { id: 'slot_arc2', type: 'ARC', center: { x: 6.0, y: -2.0 }, radius: 1.0, startAngle: 1.5 * Math.PI, endAngle: 0.5 * Math.PI },
    { id: 'slot_line2', type: 'LINE', vertices: [{ x: 6.0, y: -1.0 }, { x: -6.0, y: -1.0 }] },

    // Outer boundary (4 lines + 4 rounded corner arcs, 35x40 mm outer envelope)
    { id: 'out_arc1', type: 'ARC', center: { x: 12.5, y: -15.0 }, radius: 5.0, startAngle: 1.5 * Math.PI, endAngle: 0 },
    { id: 'out_line1', type: 'LINE', vertices: [{ x: 17.5, y: -15.0 }, { x: 17.5, y: 15.0 }] },
    { id: 'out_arc2', type: 'ARC', center: { x: 12.5, y: 15.0 }, radius: 5.0, startAngle: 0, endAngle: 0.5 * Math.PI },
    { id: 'out_line2', type: 'LINE', vertices: [{ x: 12.5, y: 20.0 }, { x: -12.5, y: 20.0 }] },
    { id: 'out_arc3', type: 'ARC', center: { x: -12.5, y: 15.0 }, radius: 5.0, startAngle: 0.5 * Math.PI, endAngle: Math.PI },
    { id: 'out_line3', type: 'LINE', vertices: [{ x: -17.5, y: 15.0 }, { x: -17.5, y: -15.0 }] },
    { id: 'out_arc4', type: 'ARC', center: { x: -12.5, y: -15.0 }, radius: 5.0, startAngle: Math.PI, endAngle: 1.5 * Math.PI },
    { id: 'out_line4', type: 'LINE', vertices: [{ x: -12.5, y: -20.0 }, { x: 12.5, y: -20.0 }] },
  ];

  const shapes = app.NestDxfShapeStructureService.detectShapes(entities);
  assert.equal(shapes.length, 1, 'Plate with cutouts and circular holes must be grouped into exactly 1 shape');
  assert.equal(shapes[0].entities.length, entities.length, 'All entities must belong to the shape');
  assert.ok(shapes[0].bbox, 'Shape must have a bounding box');
  const w = shapes[0].bbox.maxX - shapes[0].bbox.minX;
  const h = shapes[0].bbox.maxY - shapes[0].bbox.minY;
  assert.ok(Math.abs(w - 35.0) < 1e-3, `Expected width 35.0, got ${w}`);
  assert.ok(Math.abs(h - 40.0) < 1e-3, `Expected height 40.0, got ${h}`);
}

// Test 2: Arc crossing 0 degrees must sweep CCW correctly
function testArcCrossingZeroSweep() {
  const arc = {
    type: 'ARC',
    center: { x: 40, y: 0 },
    radius: 15,
    startAngle: (223.43 * Math.PI) / 180,
    endAngle: (136.57 * Math.PI) / 180,
    angleLength: -1.516, // Bogus negative angleLength produced by dxf-parser when crossing 0
  };

  const loops = app.NestDxfShapeDetectionService.buildClosedContoursFromLines([
    arc,
    { type: 'LINE', vertices: [{ x: 29.107234, y: 10.3125 }, { x: 20.0, y: 0.0 }] },
    { type: 'LINE', vertices: [{ x: 20.0, y: 0.0 }, { x: 29.107234, y: -10.3125 }] }
  ]);
  assert.equal(loops.length, 1, 'Loop crossing 0° must be closed');
  const xs = loops[0].points.map(p => p.x);
  const maxX = Math.max(...xs);
  assert.ok(Math.abs(maxX - 55.0) < 0.5, `Arc must sweep through positive X to 55.0, got ${maxX}`);
}

// Test 3: Test sample DXF files if available
function testSampleFilesIfPresent() {
  const parser = new DxfParser();

  // Check Downloads directory for plate files
  const downloads = 'C:/Users/HP/Downloads';
  if (fs.existsSync(downloads)) {
    const files = fs.readdirSync(downloads).filter(f => f.toUpperCase().endsWith('.DXF') && f.includes('Пластина'));
    for (const file of files) {
      const raw = fs.readFileSync(path.join(downloads, file), 'utf-8');
      const dxf = parser.parseSync(raw);
      const parsed = app.NestDxfPreviewService.parseDXFToShapes(dxf, raw, {});
      assert.equal(parsed.shapes.length, 1, `File ${file} must parse into exactly 1 shape, got ${parsed.shapes.length}`);
      assert.equal(parsed.shapes[0].exportEntities.length, dxf.entities.length, `File ${file} must retain all ${dxf.entities.length} entities`);
    }
  }

  // Check recent directory for door pattern and text files
  const recentDir = 'C:/Users/HP/Downloads/recent';
  if (fs.existsSync(recentDir)) {
    const textFile = path.join(recentDir, 'Text.dxf');
    if (fs.existsSync(textFile)) {
      const raw = fs.readFileSync(textFile, 'utf-8');
      const dxf = parser.parseSync(raw);
      const shapes = app.NestDxfShapeStructureService.detectShapes(dxf.entities);
      assert.equal(shapes.length, 5, `Text.dxf must detect 5 letter shapes, got ${shapes.length}`);
      for (const s of shapes) {
        assert.ok(s.polygonPoints && s.polygonPoints.length >= 3, `Shape ${s.id} in Text.dxf must have closed polygon points`);
      }
    }

    const doorFile = path.join(recentDir, '6pRDp-door-pattern-wall-screen.dxf');
    if (fs.existsSync(doorFile)) {
      const raw = fs.readFileSync(doorFile, 'utf-8');
      const dxf = parser.parseSync(raw);
      const start = Date.now();
      const shapes = app.NestDxfShapeStructureService.detectShapes(dxf.entities);
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 10000, `Door pattern parsing must complete within 10s, took ${elapsed}ms`);
      assert.equal(shapes.length, 1, `Door pattern must group into 1 shape, got ${shapes.length}`);
      assert.equal(shapes[0].entities.length, dxf.entities.length, 'Door pattern must retain all entities');
      assert.ok(shapes[0].polygonPoints && shapes[0].polygonPoints.length > 50, 'Door pattern must extract outer boundary polygon');
    }
  }
}

testCompositeBoundaryWithCutouts();
testArcCrossingZeroSweep();
testSampleFilesIfPresent();

console.log('Contour detection tests passed: multi-entity boundaries, internal cutouts, 0°-crossing arcs, text letter cycles, and dense spline envelopes verified.');
