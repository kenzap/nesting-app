'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DxfParser = require('dxf-parser');

const root = path.resolve(__dirname, '..');
const sandbox = { console, URL, Blob, setTimeout, clearTimeout };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'node_modules/@flatten-js/core/dist/main.umd.js'), 'utf8'), sandbox);
sandbox.Flatten = sandbox['@flatten-js/core'];
for (const file of [
  'shared/constants.js', 'shared/settings.js',
  'node_modules/jsts/dist/jsts.min.js', 'renderer/vendor/concaveman.js', 'node_modules/rbush/rbush.min.js',
  'renderer/utils/dxf-color.js', 'renderer/utils/dxf-geometry.js', 'renderer/utils/dxf-svg.js',
  'renderer/utils/dxf-preview-state.js', 'renderer/services/dxf-layer-service.js',
  'renderer/services/dxf-export-metadata-service.js', 'renderer/services/dxf-flatten-service.js',
  'renderer/services/dxf-shape-detection-service.js', 'renderer/utils/contour-helpers.js',
  'renderer/services/contour-detection-jsts-service.js', 'renderer/services/contour-detection-service.js',
  'renderer/services/dxf-shape-structure-service.js', 'renderer/services/dxf-cutout-eligibility-service.js',
  'renderer/services/dxf-preview-service.js',
]) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });

const rect = (x, y, w, h) => [{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const poly = (points, layer = 'CUT') => ({type:'LWPOLYLINE',closed:true,vertices:points,layer});
const line = (start, end, layer = 'CUT') => ({type:'LINE',start,end,layer});
const outer = poly(rect(0,0,100,100));
const hole = poly(rect(10,10,80,80));
const contour = entity => ({points:entity.vertices,sourceLayers:[entity.layer],sourceEntities:[entity]});
function eligible(entities, candidates = entities.filter(e => e.type === 'LWPOLYLINE'), outerPoints = outer.vertices) {
  const contours = candidates.map(contour);
  const record = {boundaryContours:contours,childClosedContours:contours.slice(1)};
  return sandbox.NestDxfCutoutEligibility.createClassifier(entities)(record,outerPoints).size;
}
assert.equal(eligible([outer,hole]),1,'clean same-layer hole');
assert.equal(eligible([outer,{...hole,layer:'ENGRAVE'}]),0,'different-layer hole');
assert.equal(eligible([outer,hole,poly(rect(20,20,5,5),'ENGRAVE')]),0,'nested geometry on any layer');
assert.equal(eligible([outer,hole,poly(rect(20,20,5,5))]),0,'solid island is not a usable leaf hole');
assert.equal(eligible([outer,hole,line({x:20,y:20},{x:30,y:30},'BEND')]),0,'open interior line');
assert.equal(eligible([outer,hole,line({x:-5,y:50},{x:105,y:50},'BEND')]),0,'crossing with both endpoints outside');
assert.equal(eligible([outer,hole,line({x:2,y:2},{x:8,y:8},'BEND')]),1,'unrelated layer outside hole');
assert.equal(eligible([outer,hole,poly(rect(5,5,90,90),'BEND')]),1,'enclosing non-cut frame is not a cut ancestor');
assert.equal(eligible([outer,hole,line({x:5,y:5},{x:10,y:10},'BEND')]),1,'corner connector only touches the boundary');
assert.equal(eligible([outer,hole,line({x:5,y:5},{x:10.01,y:10.01},'BEND')]),0,'corner connector entering the hole is rejected');
assert.equal(eligible([outer,poly(rect(0,10,80,80))]),0,'hole touching the parent boundary');
assert.equal(eligible([outer,poly(rect(90,10,20,20))]),0,'hole extending outside the parent');
assert.equal(eligible([outer,hole,{type:'POINT',position:{x:20,y:20},layer:'MARKS'}]),0,'unsupported geometry fails closed');
assert.equal(eligible([outer,hole], [outer,hole], rect(0,0,101,100)),0,'unproven outer boundary');
assert.equal(eligible([outer,hole], [outer,hole], rect(0.004,0.004,100,100)),1,
  'small contour-extraction rounding does not hide source layer provenance');
assert.equal(eligible([outer,hole,...Array(10001).fill(line({x:0,y:0},{x:1,y:1}))]),0,'bounded optional work');
const circle = {type:'CIRCLE',center:{x:30,y:30},radius:3,layer:'ENGRAVE'};
assert.equal(eligible([outer,hole,circle]),0,'curved geometry on another layer');
const repaired = contour(poly([{x:10,y:10},{x:90,y:90},{x:10,y:90},{x:90,y:10}]));
repaired.polygonPoints = hole.vertices;
assert.equal(sandbox.NestDxfCutoutEligibility.createClassifier([outer,...repaired.sourceEntities])({
  boundaryContours:[contour(outer),repaired],childClosedContours:[repaired],
},outer.vertices).size,0,'a repaired envelope is not evidence of a valid source cut');

const concave = poly([{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:60,y:100},
  {x:60,y:40},{x:40,y:40},{x:40,y:100},{x:0,y:100}]);
assert.equal(eligible([concave,poly(rect(20,50,60,20))],undefined,concave.vertices),0,
  'all vertices inside is insufficient when an edge crosses a concave notch');

function parseEntities(entities) {
  // Keep geometry in the VM realm, as required by Flatten's instanceof checks.
  sandbox.input = JSON.stringify({entities:entities.map((e,i)=>({...e,handle:String(i+1)})),
    tables:{layer:{layers:{ENGRAVE:{name:'ENGRAVE',color:2},CUT:{name:'CUT',color:3}}}}});
  vm.runInContext('var parsedInput = JSON.parse(input)',sandbox);
  return sandbox.NestDxfPreviewService.parseDXFToShapes(sandbox.parsedInput,'',{
    multiSketchDetection:true,sketchContourMethod:'auto',
  }).shapes;
}
const lines = (points, layers = ['CUT']) => points.map((p,i) => line(p,points[(i+1)%points.length],layers[i%layers.length]));
const frame = rect(5,5,90,90);
const framedEntities = [...lines(outer.vertices),...lines(frame,['BEND']),...lines(hole.vertices),
  ...frame.map((p,i)=>line(p,hole.vertices[i],'MARK'))];
const framed = parseEntities(framedEntities)[0];
assert.equal(framed.holes.filter(h=>h.nestingEligible).length,1,'empty center of connected multi-layer frame qualifies');
assert.equal(framed.holes.length,6,'all raw frame faces remain available');
assert.equal(framed.exportEntities.length,framedEntities.length,'frame source linework is not removed');
const markedFrame = parseEntities([...framedEntities,line({x:20,y:20},{x:30,y:30},'MARK')])[0];
assert.equal(markedFrame.holes.filter(h=>h.nestingEligible).length,0,'an actual interior mark still disqualifies the framed hole');
for (const [label, entities, expected] of [
  ['closed polylines',[outer,hole],1],
  ['line rings',[...lines(outer.vertices),...lines(hole.vertices)],1],
  ['mixed-layer hole',[...lines(outer.vertices),...lines(hole.vertices,['CUT','ENGRAVE'])],0],
  ['mixed-layer outer',[...lines(outer.vertices,['CUT','ENGRAVE']),...lines(hole.vertices)],0],
  ['unrelated display layer',[outer,hole,line({x:2,y:2},{x:8,y:8},'ENGRAVE')],1],
  ['interior marking',[outer,hole,line({x:20,y:20},{x:30,y:30},'ENGRAVE')],0],
  ['circular hole',[outer,{type:'CIRCLE',center:{x:50,y:50},radius:20,layer:'CUT'}],1],
]) {
  const shapes = parseEntities(entities);
  assert.equal(shapes.length,1,`${label}: one parent part`);
  assert.equal(shapes[0].holes.filter(h => h.nestingEligible).length,expected,label);
  assert.equal(shapes[0].holes.length,1,`${label}: original hole geometry remains available`);
  assert.equal(shapes[0].exportEntities.length,entities.length,`${label}: export linework unchanged`);
  assert.ok(shapes[0].holes.every(h => h.sourceLayers.length),`${label}: boundary provenance retained`);
}

// Source circles and extracted polygons have different sampling densities.
// A large circular parent must still prove its cut layer without a loose tolerance.
const circularOuter = {type:'CIRCLE',center:{x:0,y:0},radius:282.5,layer:'CUT'};
const circularHole = {type:'CIRCLE',center:{x:0,y:0},radius:147,layer:'CUT'};
const circular = parseEntities([circularOuter,circularHole])[0];
assert.equal(circular.holes.length,1);
assert.equal(circular.holes[0].nestingEligible,true,'large circular parent matches its source boundary');
assert.equal(parseEntities([circularOuter,{...circularHole,layer:'ENGRAVE'}])[0]
  .holes[0].nestingEligible,false,'source boundary matching still enforces the cut layer');

// Put the useful opening last, behind more than 64 small perforations.
const perforations = Array.from({length:81},(_,i)=>({type:'CIRCLE',layer:'CUT',radius:2,
  center:{x:220*Math.cos(i*2*Math.PI/81),y:220*Math.sin(i*2*Math.PI/81)}}));
const perforatedEntities = [circularOuter,...perforations,circularHole];
const perforated = parseEntities(perforatedEntities)[0];
assert.equal(perforated.holes.length,82,'all openings remain in the drawing');
assert.equal(perforated.exportEntities.length,perforatedEntities.length,'no source geometry is discarded');
const largestHole = perforated.holes.reduce((best,hole)=>
  Math.abs(sandbox.NestDxfGeometry.polygonSignedArea(hole.points))
    > Math.abs(sandbox.NestDxfGeometry.polygonSignedArea(best.points)) ? hole : best);
assert.equal(largestHole.nestingEligible,true,'largest opening is checked before small perforations');
assert.ok(perforated.holes.filter(h=>h.nestingEligible).length <= 64,'optional classification remains bounded');
const markedPerforated = parseEntities([...perforatedEntities,
  line({x:-10,y:0},{x:10,y:0},'ENGRAVE')])[0];
assert.ok(markedPerforated.holes.filter(h=>h.nestingEligible).every(h=>
  Math.abs(sandbox.NestDxfGeometry.polygonSignedArea(h.points)) < 100),
  'prioritizing large holes does not bypass interior-geometry checks');

// An optional local sample is never copied into the repository.
if (process.argv[2]) {
  const raw = fs.readFileSync(process.argv[2],'utf8');
  sandbox.input = JSON.stringify(new DxfParser().parseSync(raw));
  vm.runInContext('var sample = JSON.parse(input)',sandbox);
  const start = performance.now();
  const result = sandbox.NestDxfPreviewService.parseDXFToShapes(sandbox.sample,raw,{multiSketchDetection:true});
  console.log(`Sample: ${result.shapes.length} parts, ${result.shapes.reduce((n,s)=>n+s.holes.filter(h=>h.nestingEligible).length,0)} eligible holes (${Math.round(performance.now()-start)} ms).`);
}
console.log('Cutout eligibility: layer provenance, leaf regions, containment, mixed linework, bounded work and unchanged drawing geometry passed.');
