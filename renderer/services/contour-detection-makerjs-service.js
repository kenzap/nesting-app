(function attachNestDxfContourDetectionMakerJsService(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };
  const makerJsHelpers = global.NestDxfMakerJsHelpers || {};
  const contourHelpers = global.NestDxfContourHelpers || {};

  if (!geometry) {
    global.NestDxfContourDetectionMakerJsService = {
      buildMakerJsContour() {
        return contourHelpers.emptyContourResult
          ? contourHelpers.emptyContourResult('missing-geometry')
          : {
              polygonPoints: null,
              source: null,
              coverage: null,
              rankedCandidates: [],
              builderMode: 'missing-geometry',
              builderDebug: null,
            };
      },
    };
    return;
  }

  const { LOOP_TOLERANCE } = geometry;
  const {
    emptyContourResult,
    computeEntitiesBBox,
    bboxSpan,
    compareContourCandidatesByGeometry,
  } = contourHelpers;
  const { buildMakerJsChains } = makerJsHelpers;

  // Project a raw candidate from buildMakerJsChains into the ranked-entry
  // shape expected by compareContourCandidatesByGeometry and downstream UI.
  // Entry fields (area, mergeCount, closureGap, pathLength) feed the sort;
  // candidate fields are what the spread-to-result and debug summarizers read.
  function toRankedEntry(candidate, tolerance) {
    return {
      candidate: {
        polygonPoints: candidate.polygonPoints,
        source: 'makerjs-chains',
        chainSource: candidate.source || null,
        tolerance,
        area: candidate.area,
      },
      area: candidate.area,
      mergeCount: candidate.mergeCount || 0,
      closureGap: candidate.closureGap ?? null,
      pathLength: candidate.pathLength || 0,
    };
  }

  function buildMakerJsContour(shapeRecord, options = {}) {
    const tolerance = Math.max(LOOP_TOLERANCE * 4, options.tolerance || LOOP_TOLERANCE * 8);
    const bbox = computeEntitiesBBox(shapeRecord?.entities || []);
    const span = bboxSpan(bbox);
    const gapTolerance = Number.isFinite(options.makerjsGapTolerance)
      ? Math.max(0, options.makerjsGapTolerance)
      : Math.max(tolerance * 64, span * 0.005, 1);
    const dxfData = shapeRecord?.dxfData
      || shapeRecord?._dxfData
      || { entities: shapeRecord?.entities || [] };
    const makerJsOptions = {
      approximateSplines: true,
      splineTolerance: Math.max(tolerance, 0.01),
      maxArcFacet: Math.max(tolerance * 8, 0.5),
      gapTolerance,
    };

    const chainBuild = typeof buildMakerJsChains === 'function'
      ? buildMakerJsChains(dxfData, makerJsOptions)
      : { available: false, candidates: [], pathCount: 0 };

    const debugBase = {
      shapeId: shapeRecord?.id || null,
      gapTolerance,
      sourceEntityCount: shapeRecord?.entities?.length || 0,
      pathCount: chainBuild.pathCount || 0,
      makerjsVersion: chainBuild.makerjs?.version || null,
    };

    const reportAndReturn = (stage, extras = {}) => {
      const debug = { ...debugBase, stage, ...extras };
      debugDXF('Contour builder', debug);
      return emptyContourResult('makerjs-chains', debug);
    };

    if (!chainBuild.available) return reportAndReturn('makerjs-unavailable');
    if (chainBuild.error) return reportAndReturn('makerjs-chain-error', { error: chainBuild.error });

    const ranked = (chainBuild.candidates || [])
      .filter(c => Array.isArray(c.polygonPoints) && c.polygonPoints.length >= 4)
      .map(c => toRankedEntry(c, tolerance))
      .sort(compareContourCandidatesByGeometry);

    const winner = ranked[0] || null;
    const chainEntryCount = chainBuild.chains?.length || 0;

    if (!winner) {
      return {
        ...emptyContourResult('makerjs-chains'),
        rankedCandidates: ranked,
        builderDebug: {
          ...debugBase,
          stage: 'makerjs-no-candidates',
          chainEntryCount,
          candidateCount: 0,
        },
      };
    }

    return {
      ...winner.candidate,
      coverage: null,
      rankedCandidates: ranked,
      builderMode: 'makerjs-chains',
      builderDebug: {
        ...debugBase,
        stage: 'makerjs-success',
        chainEntryCount,
        candidateCount: ranked.length,
        chosenSource: winner.candidate.chainSource || winner.candidate.source || null,
      },
    };
  }

  global.NestDxfContourDetectionMakerJsService = {
    buildMakerJsContour,
  };
})(window);
