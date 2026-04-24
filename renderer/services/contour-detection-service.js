(function attachNestDxfContourDetectionService(global) {
  'use strict';

  const contourHelpers = global.NestDxfContourHelpers || {};
  const jstsService = global.NestDxfContourDetectionJstsService || {};
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };

  const {
    emptyContourResult = (builderMode, builderDebug = null) => ({
      polygonPoints: null,
      source: null,
      coverage: null,
      rankedCandidates: [],
      builderMode,
      builderDebug,
    }),
  } = contourHelpers;

  const { buildArrangementContour } = jstsService;

  // Only the JSTS arrangement detector remains. The legacy 'makerjs-chains'
  // and 'intersection' methods were removed; any stale setting value now
  // routes to arrangement the same as 'auto' / 'arrangement'.
  function detectContour(input, options = {}) {
    if (Array.isArray(input)) return emptyContourResult('array-input-unsupported');
    const shapeRecord = input;
    if (!shapeRecord?.entities?.length) return emptyContourResult('missing-shape-record');

    const rawMethod = options?.contourMethod;
    const method = rawMethod == null ? 'auto' : String(rawMethod);

    const routingDebug = {
      shapeId: shapeRecord?.id || null,
      rawMethodType: typeof rawMethod,
      rawMethod,
      resolvedMethod: method,
      jstsAvailable: typeof buildArrangementContour === 'function',
      selected: 'arrangement',
    };
    debugDXF('Contour routing', routingDebug);

    return typeof buildArrangementContour === 'function'
      ? buildArrangementContour(shapeRecord, options)
      : emptyContourResult('missing-arrangement-detector', routingDebug);
  }

  const api = {
    detectContour,
    buildArrangementContour,
  };

  global.NestDxfContourDetectionService = api;
})(window);
