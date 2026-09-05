#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DxfParser = require('dxf-parser');
const Flatten = require('@flatten-js/core');

const projectRoot = path.resolve(__dirname, '..');
const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : null;

if (!inputPath || path.extname(inputPath).toLowerCase() !== '.dxf' || !fs.existsSync(inputPath)) {
  console.error('Usage: npm run debug:dxf-contour -- "/absolute/path/to/file.dxf"');
  process.exitCode = 1;
  return;
}

const debugMessages = [];
const sandboxConsole = {
  ...console,
  log(...args) {
    if (typeof args[0] === 'string' && args[0].startsWith('[DXF DEBUG]')) {
      debugMessages.push(args);
      return;
    }
    console.log(...args);
  },
};

const sandbox = {
  console: sandboxConsole,
  Flatten,
  URL,
  Blob,
  setTimeout,
  clearTimeout,
  location: { href: `file://${inputPath}?dxfDebug=1`, search: '?dxfDebug=1' },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function loadBrowserScript(absolutePath) {
  if (!absolutePath.startsWith(projectRoot + path.sep)) throw new Error(`Invalid script path`);
  const source = fs.readFileSync(absolutePath, 'utf8');
  vm.runInContext(source, sandbox, { filename: absolutePath });
}

[
  path.resolve(projectRoot, 'shared/constants.js'),
  path.resolve(projectRoot, 'shared/settings.js'),
  path.resolve(projectRoot, 'node_modules/jsts/dist/jsts.min.js'),
  path.resolve(projectRoot, 'renderer/vendor/concaveman.js'),
  path.resolve(projectRoot, 'renderer/utils/dxf-color.js'),
  path.resolve(projectRoot, 'renderer/utils/dxf-geometry.js'),
  path.resolve(projectRoot, 'renderer/utils/dxf-svg.js'),
  path.resolve(projectRoot, 'renderer/utils/dxf-preview-state.js'),
  path.resolve(projectRoot, 'renderer/services/dxf-layer-service.js'),
  path.resolve(projectRoot, 'renderer/services/dxf-export-metadata-service.js'),
  path.resolve(projectRoot, 'renderer/services/dxf-flatten-service.js'),
  path.resolve(projectRoot, 'renderer/services/dxf-shape-detection-service.js'),
  path.resolve(projectRoot, 'renderer/utils/contour-helpers.js'),
  path.resolve(projectRoot, 'renderer/services/contour-detection-jsts-service.js'),
  path.resolve(projectRoot, 'renderer/services/contour-detection-service.js'),
  path.resolve(projectRoot, 'renderer/services/dxf-shape-structure-service.js'),
  path.resolve(projectRoot, 'renderer/services/dxf-preview-service.js'),
].forEach(loadBrowserScript);

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function summarizeBBox(bbox) {
  if (!bbox) return null;
  return {
    minX: round(bbox.minX),
    minY: round(bbox.minY),
    maxX: round(bbox.maxX),
    maxY: round(bbox.maxY),
    width: round(bbox.maxX - bbox.minX),
    height: round(bbox.maxY - bbox.minY),
    area: round((bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY)),
  };
}

function unionEntityBBoxes(entities, bboxFn, unionFn) {
  return entities.reduce((bbox, entity) => unionFn(bbox, bboxFn(entity)), null);
}

function sampledBBox(entities, sampleFn, bboxFn) {
  const points = entities.flatMap(entity => sampleFn(entity, 0.001) || []);
  return bboxFn(points);
}

const dxfText = fs.readFileSync(inputPath, 'utf8');
const dxf = new DxfParser().parseSync(dxfText);
sandbox.__parsedDxfJson = JSON.stringify(dxf);
vm.runInContext(
  'window.__parsedDxf = JSON.parse(window.__parsedDxfJson); delete window.__parsedDxfJson;',
  sandbox,
);
const entities = sandbox.__parsedDxf.entities || [];
const geometry = sandbox.NestDxfGeometry;
const shapeDetection = sandbox.NestDxfShapeDetectionService;
const shapeStructure = sandbox.NestDxfShapeStructureService;
const contourDetection = sandbox.NestDxfContourDetectionService;
const previewService = sandbox.NestDxfPreviewService;

const typeCounts = entities.reduce((counts, entity) => {
  counts[entity.type] = (counts[entity.type] || 0) + 1;
  return counts;
}, {});
const loops = shapeDetection.buildClosedContoursFromLines(entities);
const shapes = shapeStructure.detectShapes(entities, { singleSketch: false });
const entityBounds = unionEntityBBoxes(entities, geometry.entityBBox, geometry.unionBBox);
const sampledBounds = sampledBBox(
  entities,
  shapeDetection.sampleEntityPoints,
  geometry.bboxFromPoints,
);

const contourResults = shapes.map(shape => {
  const result = contourDetection.detectContour(shape, {
    contourMethod: 'auto',
    gapTolerance: 100,
    tolerance: 0.001,
  });
  const debug = result.builderDebug || {};
  return {
    shapeId: shape.id,
    entityCount: shape.entities?.length || 0,
    structurePolygonPointCount: shape.polygonPoints?.length || 0,
    parentContourId: shape.parentContour?.id || null,
    chosenSource: result.source || null,
    chosenPointCount: result.polygonPoints?.length || 0,
    faceCount: debug.faceCount ?? null,
    componentCount: debug.componentCount ?? null,
    sourceBboxArea: round(debug.sourceBboxArea),
    winnerBboxArea: round(debug.winnerBboxArea),
    bboxCoverage: round(debug.bboxCoverage),
    bboxCoverageThreshold: round(debug.bboxCoverageThreshold),
    needsFallback: debug.needsFallback ?? null,
    usingFallback: debug.usingFallback ?? null,
    fallbackReason: debug.fallbackReason || null,
    arrangementArea: round(debug.jstsWinnerArea),
    chosenArea: round(debug.chosenArea),
    rankedCandidates: (result.rankedCandidates || []).map(candidate => ({
      source: candidate.candidate?.source || null,
      area: round(candidate.area),
      pointCount: candidate.candidate?.polygonPoints?.length || 0,
      containsCentroid: candidate.containsCentroid ?? null,
    })),
  };
});
const previewResults = ['auto', 'arrangement'].flatMap(sketchContourMethod => {
  const parsedDxf = JSON.parse(JSON.stringify(sandbox.__parsedDxf));
  const previewData = previewService.parseDXFToShapes(parsedDxf, dxfText, {
    multiSketchDetection: true,
    sketchContourMethod,
  });
  return (previewData?.shapes || []).map(shape => ({
    sketchContourMethod,
    shapeId: shape.id,
    selectionPolygonSource: shape.selectionPolygonSource || null,
    selectionPointCount: shape.selectionPolygonPoints?.length || 0,
    selectionPathData: shape.selectionPathData || null,
    nestingPolygonSource: shape.nestingPolygon?.source || null,
    nestingBuilderDebug: shape.nestingPolygonBuilderDebug || null,
  }));
});

const report = {
  file: inputPath,
  entityCount: entities.length,
  typeCounts,
  entityBounds: summarizeBBox(entityBounds),
  sampledGeometryBounds: summarizeBBox(sampledBounds),
  closedLoopCount: loops.length,
  closedLoops: loops.map(loop => ({
    id: loop.id || null,
    entityCount: loop.sourceEntities?.length || loop.entities?.length || 0,
    pointCount: loop.points?.length || 0,
    area: round(loop.area),
    isPrimary: !!loop.isPrimary,
    bbox: summarizeBBox(loop.bbox || geometry.bboxFromPoints(loop.points || [])),
  })),
  structuredShapeCount: shapes.length,
  contourResults,
  previewResults,
  debugEventLabels: (sandbox.__NEST_DXF_DEBUG__?.events || []).map(event => event.label),
};

console.log(JSON.stringify(report, null, 2));
