(function attachNestDxfOuterContourBuilder(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };
  const makerJsHelpers = global.NestDxfMakerJsHelpers || {};

  function emptyResult(builderMode, builderDebug = null) {
    return {
      polygonPoints: null,
      source: null,
      coverage: null,
      rankedCandidates: [],
      builderMode,
      builderDebug,
    };
  }

  if (!geometry) {
    global.NestDxfNestingPolygonService = {
      buildMakerJsChainContour() {
        return emptyResult('missing-geometry');
      },
      detectNestingPolygon() {
        return emptyResult('missing-geometry');
      },
    };
    return;
  }

  const {
    EPS,
    LOOP_TOLERANCE,
    unionBBox,
    entityBBox,
  } = geometry;

  const {
    buildMakerJsChains,
    getOuterNestingContour,
  } = makerJsHelpers;

  function computeEntitiesBBox(entities) {
    let bbox = null;
    (entities || []).forEach(entity => {
      bbox = unionBBox(bbox, entityBBox(entity));
    });
    return bbox;
  }

  function bboxSpan(bbox) {
    if (!bbox) return 0;
    return Math.max(EPS, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
  }

  function compareMakerJsChainEntries(a, b) {
    if (Math.abs((b.area || 0) - (a.area || 0)) > EPS) return (b.area || 0) - (a.area || 0);
    if ((a.mergeCount || 0) !== (b.mergeCount || 0)) return (a.mergeCount || 0) - (b.mergeCount || 0);
    if (Math.abs((a.closureGap || 0) - (b.closureGap || 0)) > EPS) return (a.closureGap || 0) - (b.closureGap || 0);
    return (b.pathLength || 0) - (a.pathLength || 0);
  }

  function buildMakerJsChainContour(shapeRecord, options = {}) {
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

    const outerContour = typeof getOuterNestingContour === 'function'
      ? getOuterNestingContour(dxfData, makerJsOptions)
      : null;

    const chainBuild = typeof buildMakerJsChains === 'function'
      ? buildMakerJsChains(dxfData, makerJsOptions)
      : { available: false, candidates: [], pathCount: 0 };

    const debugBase = {
      shapeId: shapeRecord?.id || null,
      stage: 'makerjs-unavailable',
      gapTolerance,
      directOuterContourApplied: !!outerContour?.polygonPoints,
      sourceEntityCount: shapeRecord?.entities?.length || 0,
      pathCount: chainBuild.pathCount || 0,
      makerjsVersion: chainBuild.makerjs?.version || null,
    };

    if (!chainBuild.available) {
      const debug = {
        ...debugBase,
        stage: 'makerjs-unavailable',
      };
      debugDXF('Outer contour builder', debug);
      return emptyResult('makerjs-chains', debug);
    }

    if (chainBuild.error) {
      const debug = {
        ...debugBase,
        stage: 'makerjs-chain-error',
        error: chainBuild.error,
      };
      debugDXF('Outer contour builder', debug);
      return emptyResult('makerjs-chains', debug);
    }

    const ranked = (chainBuild.candidates || [])
      .map(candidate => ({
        candidate: {
          polygonPoints: candidate.polygonPoints,
          source: 'makerjs-chains',
          tolerance,
          gapTolerance,
          area: candidate.area,
          chainIndex: candidate.chainIndex ?? null,
          chainIndices: candidate.chainIndices || [],
          mergeCount: candidate.mergeCount || 0,
          closureGap: candidate.closureGap ?? null,
          chainSource: candidate.source || null,
          pathLength: candidate.pathLength || null,
        },
        area: candidate.area,
        pathLength: candidate.pathLength || 0,
        chainIndex: candidate.chainIndex ?? null,
        mergeCount: candidate.mergeCount || 0,
        closureGap: candidate.closureGap ?? null,
      }))
      .filter(entry => Array.isArray(entry.candidate.polygonPoints) && entry.candidate.polygonPoints.length >= 4)
      .sort(compareMakerJsChainEntries);

    const winner = outerContour?.polygonPoints
      ? {
          candidate: {
            polygonPoints: outerContour.polygonPoints,
            source: 'makerjs-chains',
            tolerance,
            gapTolerance,
            area: outerContour.area,
            chainIndex: null,
            chainIndices: outerContour.chainIndices || [],
            mergeCount: Math.max(0, (outerContour.chainIndices || []).length - 1),
            closureGap: outerContour.closureGap ?? null,
            chainSource: outerContour.source || null,
            pathLength: null,
          },
          area: outerContour.area,
          pathLength: 0,
          chainIndex: null,
          mergeCount: Math.max(0, (outerContour.chainIndices || []).length - 1),
          closureGap: outerContour.closureGap ?? null,
        }
      : (ranked[0] || null);

    if (!winner) {
      return {
        ...emptyResult('makerjs-chains'),
        rankedCandidates: ranked,
        builderDebug: {
          ...debugBase,
          stage: 'makerjs-no-candidates',
          chainEntryCount: chainBuild.chains?.length || 0,
          candidateCount: ranked.length,
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
        chainEntryCount: chainBuild.chains?.length || 0,
        candidateCount: ranked.length,
        chosenSource: winner.candidate.chainSource || winner.candidate.source || null,
      },
    };
  }

  function detectNestingPolygon(input, options = {}) {
    if (Array.isArray(input)) return emptyResult('array-input-unsupported');
    const shapeRecord = input;
    if (!shapeRecord?.entities?.length) return emptyResult('missing-shape-record');
    return buildMakerJsChainContour(shapeRecord, options);
  }

  global.NestDxfNestingPolygonService = {
    buildMakerJsChainContour,
    detectNestingPolygon,
  };
})(window);
