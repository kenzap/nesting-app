(function attachNestDxfContourDetectionService(global) {
  'use strict';

  const contourHelpers = global.NestDxfContourHelpers || {};
  const makerJsService = global.NestDxfContourDetectionMakerJsService || {};

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

  function detectContour(input, options = {}) {
    if (Array.isArray(input)) return emptyContourResult('array-input-unsupported');
    const shapeRecord = input;
    if (!shapeRecord?.entities?.length) return emptyContourResult('missing-shape-record');
    return typeof buildMakerJsContour === 'function'
      ? buildMakerJsContour(shapeRecord, options)
      : emptyContourResult('missing-contour-detector');
  }

  const api = {
    detectContour,
    buildMakerJsContour,
  };

  global.NestDxfContourDetectionService = api;
})(window);
