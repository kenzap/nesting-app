(function attachNestDxfContourDetectionService(global) {
  'use strict';

  const contourHelpers = global.NestDxfContourHelpers || {};
  const makerJsService = global.NestDxfContourDetectionMakerJsService || {};
  const intersectionService = global.NestDxfContourDetectionIntersectionService || {};
  const planarService = global.NestDxfContourDetectionPlanarService || {};
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

  const { buildMakerJsContour } = makerJsService;
  const { buildIntersectionContour } = intersectionService;
  const { buildPlanarContour } = planarService;
  const { buildArrangementContour } = jstsService;

  function detectContour(input, options = {}) {
    if (Array.isArray(input)) return emptyContourResult('array-input-unsupported');
    const shapeRecord = input;
    if (!shapeRecord?.entities?.length) return emptyContourResult('missing-shape-record');

    const rawMethod = options?.contourMethod;
    const method = rawMethod == null ? 'auto' : String(rawMethod);

    // Surface the routing decision so the debug log shows which detector
    // actually ran. Without this, a misconfigured setting silently falls
    // through to the default detector and nothing upstream knows.
    const routingDebug = {
      shapeId: shapeRecord?.id || null,
      rawMethodType: typeof rawMethod,
      rawMethod,
      resolvedMethod: method,
      jstsAvailable: typeof buildArrangementContour === 'function',
      intersectionAvailable: typeof buildPlanarContour === 'function',
      makerjsAvailable: typeof buildMakerJsContour === 'function',
    };

    let selected;
    if (method === 'arrangement' || method === 'jsts') {
      selected = 'arrangement';
    } else if (method === 'intersection') {
      selected = 'intersection';
    } else {
      selected = 'makerjs';
    }

    debugDXF('Contour routing', { ...routingDebug, selected });

    if (selected === 'arrangement') {
      return typeof buildArrangementContour === 'function'
        ? buildArrangementContour(shapeRecord, options)
        : emptyContourResult('missing-arrangement-detector', routingDebug);
    }

    if (selected === 'intersection') {
      return typeof buildPlanarContour === 'function'
        ? buildPlanarContour(shapeRecord, options)
        : emptyContourResult('missing-planar-detector', routingDebug);
    }

    return typeof buildMakerJsContour === 'function'
      ? buildMakerJsContour(shapeRecord, options)
      : emptyContourResult('missing-contour-detector', routingDebug);
  }

  const api = {
    detectContour,
    buildMakerJsContour,
    buildPlanarContour,
    buildIntersectionContour,
    buildArrangementContour,
  };

  global.NestDxfContourDetectionService = api;
})(window);
