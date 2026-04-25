(function attachNestDxfPreviewService(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const svg = global.NestDxfSvg;
  const { createLayerResolver, FALLBACK_PALETTE } = global.NestDxfLayerService;
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };
  const {
    buildSketchGroups,
    extractPolygonForEntities,
  } = global.NestDxfFlattenService || {
    buildSketchGroups: () => [],
    extractPolygonForEntities: () => null,
  };
  const { detectShapes: detectStructuredShapes } = global.NestDxfShapeStructureService || {
    detectShapes: () => [],
  };
  const { detectContour } = global.NestDxfContourDetectionService || {
    detectContour: () => null,
  };
  const { serializeEntityForExport } = global.NestDxfExportMetadataService;
  const { clonePreviewData, applyPartLabelsToPreviewData } = global.NestDxfPreviewState;
  const {
    normalizeSettings,
    SKETCH_CONTOUR_METHODS = [],
  } = global.NestSettings;

  const { f1, mkRng, hashStr } = svg;
  const {
    unionBBox,
    entityBBox,
    closePointRing,
    polylineVerticesToPoints,
    ellipseToPoints,
    splineToPoints,
    circleToPoints,
  } = geometry;

  function dedupeRenderedItems(items) {
    const seen = new Set();
    return (items || []).filter(item => {
      if (!item?.svg) return false;
      const key = `${item.layer || '0'}::${item.svg}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function rectPath(width, height) {
    return `M0,0 H${svg.f(width)} V${svg.f(height)} H0 Z`;
  }

  function rectPolygonFromBBox(bbox) {
    return closePointRing([
      { x: bbox.minX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.maxY },
      { x: bbox.minX, y: bbox.maxY },
    ]);
  }

  function pointsToPathData(polygonPoints, minX, maxY) {
    const pathPoints = polygonPoints.length > 1 && polygonPoints[polygonPoints.length - 1]?.x === polygonPoints[0]?.x &&
      polygonPoints[polygonPoints.length - 1]?.y === polygonPoints[0]?.y
      ? polygonPoints.slice(0, -1)
      : polygonPoints;
    return pathPoints.length >= 3 ? svg.pathFromPoints(pathPoints, minX, maxY, true) : '';
  }

  function pointsToLocalPreviewCoords(points, minX, maxY) {
    return Array.isArray(points)
      ? points
        .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
        .map(point => ({
          x: point.x - minX,
          y: maxY - point.y,
        }))
      : [];
  }

  function normalizeSketchContourMethod(method) {
    const normalized = method == null ? 'auto' : String(method);
    return SKETCH_CONTOUR_METHODS.includes(normalized) ? normalized : 'auto';
  }

  function isForcedSketchContourMethod(method) {
    return normalizeSketchContourMethod(method) !== 'auto';
  }

  function isTrustedSelectionCandidate(candidate, entityCount) {
    const coverage = candidate?.coverage;
    if (!coverage) return false;
    const source = candidate?.source || '';
    if ((coverage.selfIntersectionCount ?? 0) > 0 || (coverage.repeatedVertexCount ?? 0) > 0) return false;
    const baseMaxUnsupported = Math.max(0, Math.floor((entityCount || 0) * 0.05));
    const isOpenChain = source === 'exact-open-chain';
    const isTinyShape = (entityCount || 0) <= 3;

    if (isOpenChain) {
      return (coverage.entityCoverage ?? 0) >= 0.9 &&
        (coverage.pointCoverage ?? 0) >= (isTinyShape ? 0.98 : 0.8) &&
        (coverage.unsupportedEntityCount ?? Infinity) <= Math.max(2, baseMaxUnsupported) &&
        (coverage.outerCoverage ?? 0) >= 0.9 &&
        (coverage.outerMissCount ?? Infinity) === 0 &&
        (coverage.selfIntersectionCount ?? Infinity) === 0 &&
        (coverage.repeatedVertexCount ?? Infinity) === 0;
    }

    return (coverage.entityCoverage ?? 0) >= 0.9 &&
      (coverage.pointCoverage ?? 0) >= 0.85 &&
      (coverage.unsupportedEntityCount ?? Infinity) <= baseMaxUnsupported &&
      (coverage.areaCoverage ?? 0) >= 0.1;
  }

  function isValidSelectionCandidate(candidate) {
    const coverage = candidate?.coverage;
    if (!coverage) return false;
    return (coverage.selfIntersectionCount ?? 0) === 0 &&
      (coverage.repeatedVertexCount ?? 0) === 0;
  }

  function isUsableSelectionCandidate(candidate) {
    const coverage = candidate?.coverage;
    if (!coverage) return false;
    return (coverage.entityCoverage ?? 0) >= 0.6 &&
      (coverage.pointCoverage ?? 0) >= 0.6 &&
      (coverage.outerCoverage ?? 0) >= 0.5;
  }

  function sortSelectionCandidates(a, b) {
    const aScore = a?.coverage?.score ?? -Infinity;
    const bScore = b?.coverage?.score ?? -Infinity;
    if (Math.abs(bScore - aScore) > 0.025) return bScore - aScore;
    const aEntity = a.coverage?.entityCoverage ?? -Infinity;
    const bEntity = b.coverage?.entityCoverage ?? -Infinity;
    if (Math.abs(bEntity - aEntity) > 0.025) return bEntity - aEntity;
    const aPoint = a.coverage?.pointCoverage ?? -Infinity;
    const bPoint = b.coverage?.pointCoverage ?? -Infinity;
    if (Math.abs(bPoint - aPoint) > 0.025) return bPoint - aPoint;
    return b.priority - a.priority;
  }

  function summarizeCoverageMetrics(coverage) {
    if (!coverage) return null;
    return {
      entityCoverage: coverage.entityCoverage ?? null,
      pointCoverage: coverage.pointCoverage ?? null,
      areaCoverage: coverage.areaCoverage ?? null,
      outerCoverage: coverage.outerCoverage ?? null,
      outerMissCount: coverage.outerMissCount ?? null,
      outerMissIds: (coverage.outerMissIds || []).slice(0, 8),
      unsupportedEntityCount: coverage.unsupportedEntityCount ?? null,
      unsupportedEntityIds: (coverage.unsupportedEntityIds || []).slice(0, 8),
      partialEntityCount: coverage.partialEntityCount ?? null,
      partialEntityIds: (coverage.partialEntityIds || []).slice(0, 8),
      partialEntities: (coverage.partialEntities || []).slice(0, 5).map(item => ({
        id: item.id ?? null,
        type: item.type ?? null,
        layer: item.layer ?? null,
        samplePointCount: item.samplePointCount ?? null,
        supportedProbeCount: item.supportedProbeCount ?? null,
        insideProbeCount: item.insideProbeCount ?? null,
        outsideProbeCount: item.outsideProbeCount ?? null,
        supportRatio: item.supportRatio ?? null,
        outsideSamplePoints: (item.outsideSamplePoints || []).slice(0, 3),
      })),
      supportedAreaRatio: coverage.supportedAreaRatio ?? null,
      compactness: coverage.compactness ?? null,
      selfIntersectionCount: coverage.selfIntersectionCount ?? null,
      repeatedVertexCount: coverage.repeatedVertexCount ?? null,
      score: coverage.score ?? null,
    };
  }

  function summarizeCandidateCoverageMetrics(coverage) {
    if (!coverage) return null;
    return {
      entityCoverage: coverage.entityCoverage ?? null,
      pointCoverage: coverage.pointCoverage ?? null,
      areaCoverage: coverage.areaCoverage ?? null,
      outerCoverage: coverage.outerCoverage ?? null,
      outerMissCount: coverage.outerMissCount ?? null,
      outerMissIds: (coverage.outerMissIds || []).slice(0, 6),
      unsupportedEntityCount: coverage.unsupportedEntityCount ?? null,
      unsupportedEntityIds: (coverage.unsupportedEntityIds || []).slice(0, 6),
      partialEntityCount: coverage.partialEntityCount ?? null,
      partialEntityIds: (coverage.partialEntityIds || []).slice(0, 6),
      supportedAreaRatio: coverage.supportedAreaRatio ?? null,
      compactness: coverage.compactness ?? null,
      selfIntersectionCount: coverage.selfIntersectionCount ?? null,
      repeatedVertexCount: coverage.repeatedVertexCount ?? null,
      score: coverage.score ?? null,
    };
  }

  function isSelectableContourCandidate(candidate, entityCount) {
    if (!isValidSelectionCandidate(candidate)) return false;
    const source = candidate?.source || '';
    if (source === 'structure-envelope') {
      return isTrustedSelectionCandidate(candidate, entityCount);
    }
    return isUsableSelectionCandidate(candidate);
  }

  function buildRankedSelectionCandidate(entry) {
    const source = entry?.candidate?.source || null;
    const polygonPoints = entry?.candidate?.polygonPoints || null;
    if (!Array.isArray(polygonPoints) || polygonPoints.length < 4) return null;
    return {
      source,
      polygonPoints,
      coverage: entry.score,
      priority: 3,
    };
  }

  function buildSelectionCandidateSummary(candidate, entityCount, trusted) {
    return {
      source: candidate.source,
      priority: candidate.priority,
      polygonPointCount: candidate.polygonPoints?.length || 0,
      coverage: summarizeCoverageMetrics(candidate.coverage),
      highlightEligible: isValidSelectionCandidate(candidate),
      trusted: !!trusted,
    };
  }

  function resolveSelectionNestingCandidate(nestingPolygon, entities, forcedSource = 'auto') {
    if (!nestingPolygon) return null;
    const normalizedForcedSource = normalizeSketchContourMethod(forcedSource);

    const directCandidate = Array.isArray(nestingPolygon.polygonPoints) && nestingPolygon.polygonPoints.length >= 4
      ? {
          source: nestingPolygon.source,
          polygonPoints: nestingPolygon.polygonPoints,
          coverage: nestingPolygon.coverage,
          priority: 3,
        }
      : null;

    const rankedCandidates = Array.isArray(nestingPolygon.rankedCandidates)
      ? nestingPolygon.rankedCandidates
          .map(entry => buildRankedSelectionCandidate(entry))
          .filter(Boolean)
      : [];

    if (normalizedForcedSource !== 'auto') {
      const forcedMatch = [directCandidate, ...rankedCandidates]
        .filter(Boolean)
        .find(candidate =>
          candidate.source === normalizedForcedSource ||
          nestingPolygon.builderMode === normalizedForcedSource
        );
      return forcedMatch || directCandidate || rankedCandidates[0] || null;
    }

    if (directCandidate && isValidSelectionCandidate(directCandidate)) {
      return directCandidate;
    }

    return rankedCandidates.find(isValidSelectionCandidate) || directCandidate;
  }

  function chooseSelectionPolygon({ entities, structurePolygonPoints, envelopePolygonPoints, nestingPolygon, forcedSource = 'auto' }) {
    const normalizedForcedSource = normalizeSketchContourMethod(forcedSource);
    const forcedMode = normalizedForcedSource !== 'auto';
    const candidates = [];
    const entityCount = entities?.length || 0;

    const resolvedNestingCandidate = resolveSelectionNestingCandidate(nestingPolygon, entities, normalizedForcedSource);
    if (resolvedNestingCandidate?.polygonPoints?.length) {
      candidates.push(resolvedNestingCandidate);
    }

    if (!forcedMode && Array.isArray(structurePolygonPoints) && structurePolygonPoints.length >= 4) {
      candidates.push({
        source: 'structure-polygon',
        polygonPoints: structurePolygonPoints,
        priority: 2,
      });
    }

    if (!forcedMode && Array.isArray(envelopePolygonPoints) && envelopePolygonPoints.length >= 4) {
      candidates.push({
        source: 'structure-envelope',
        polygonPoints: envelopePolygonPoints,
        priority: 0,
      });
    }

    if (forcedMode) {
      if (resolvedNestingCandidate?.polygonPoints?.length) {
        return {
          ...resolvedNestingCandidate,
          candidateSummaries: candidates.map(candidate =>
            buildSelectionCandidateSummary(candidate, entityCount, candidate === resolvedNestingCandidate)
          ),
        };
      }

      return {
        source: null,
        polygonPoints: [],
        coverage: null,
        priority: -1,
        candidateSummaries: [],
      };
    }

    if (resolvedNestingCandidate && isValidSelectionCandidate(resolvedNestingCandidate)) {
      return {
        ...resolvedNestingCandidate,
        candidateSummaries: candidates.map(candidate =>
          buildSelectionCandidateSummary(
            candidate,
            entityCount,
            candidate === resolvedNestingCandidate || isTrustedSelectionCandidate(candidate, entityCount)
          )
        ),
      };
    }

    const selectableCandidates = candidates
      .filter(candidate => candidate !== resolvedNestingCandidate)
      .filter(candidate => isSelectableContourCandidate(candidate, entityCount));
    if (selectableCandidates.length) {
      const selected = selectableCandidates[0];
      return {
        ...selected,
        candidateSummaries: candidates.map(candidate =>
          buildSelectionCandidateSummary(
            candidate,
            entityCount,
            candidate === selected || isTrustedSelectionCandidate(candidate, entityCount)
          )
        ),
      };
    }

    const validCandidates = candidates.filter(isValidSelectionCandidate).sort(sortSelectionCandidates);
    if (validCandidates.length) {
      const fallback = validCandidates[0];
      return {
        ...fallback,
        candidateSummaries: candidates.map(candidate =>
          buildSelectionCandidateSummary(
            candidate,
            entityCount,
            candidate === fallback || isTrustedSelectionCandidate(candidate, entityCount)
          )
        ),
      };
    }

    return {
      source: null,
      polygonPoints: [],
      coverage: null,
      priority: -1,
      candidateSummaries: candidates.map(candidate =>
        buildSelectionCandidateSummary(candidate, entityCount, false)
      ),
    };
  }

  function summarizeNestingCandidateEntry(entry) {
    if (!entry) return null;
    return {
      source: entry.candidate?.source || null,
      subgroupIndex: entry.candidate?.subgroupIndex ?? null,
      subgroupEntityCount: entry.candidate?.subgroupEntityCount ?? null,
      subgroupSource: entry.candidate?.subgroupSource ?? null,
      tolerance: entry.candidate?.tolerance || null,
      alpha: entry.candidate?.alpha || null,
      polygonPointCount: entry.candidate?.polygonPoints?.length || 0,
      bboxCoverage: entry.bboxCoverage ?? null,
      area: entry.area ?? entry.candidate?.area ?? null,
      areaGain: entry.areaGain ?? null,
      enclosesSeed: entry.enclosesSeed ?? null,
      rootDepth: entry.rootDepth ?? null,
      coverage: summarizeCandidateCoverageMetrics(entry.score),
      dominantRootPreservation: entry.dominantRootPreservation || null,
      unionGeometryDominantPenalty: entry.unionGeometryDominantPenalty || null,
    };
  }

  function buildRawPreviewShape({
    entities,
    index,
    layerOrder,
    layerColor,
    resolveEntityColor,
    forceBoundingBoxPolygon = false,
  }) {
    if (!Array.isArray(entities) || !entities.length) return null;

    let renderBBox = null;
    entities.forEach(entity => { renderBBox = unionBBox(renderBBox, entityBBox(entity)); });
    if (!renderBBox) return null;

    const { minX, minY, maxX, maxY } = renderBBox;
    const width = maxX - minX;
    const height = maxY - minY;
    if (width < 0.5 || height < 0.5) return null;

    const usedLayers = [...new Set(entities.map(entity => entity.layer || '0'))];
    const preferredLayer = layerOrder.find(name => usedLayers.includes(name)) || usedLayers[0] || '0';

    const outerBoundaryItems = dedupeRenderedItems(entities.map(entity => {
      const layerName = entity.layer || '0';
      const color = resolveEntityColor(entity, layerName);
      const svgStr = svg.entityToSVGStr(entity, minX, maxY, color);
      if (!svgStr) return null;
      return { layer: layerName, color, svg: svgStr };
    }).filter(Boolean));

    const exportEntityMap = new Map();
    entities.forEach(entity => {
      const key = entity.handle || JSON.stringify([
        entity.type, entity.layer,
        entity.start?.x, entity.start?.y,
        entity.end?.x, entity.end?.y,
        entity.center?.x, entity.center?.y,
        entity.radius, entity.startAngle, entity.endAngle,
        entity.vertices?.length,
      ]);
      if (!exportEntityMap.has(key)) {
        const serialized = serializeEntityForExport(entity, entityToPointsForExport);
        if (serialized) exportEntityMap.set(key, serialized);
      }
    });

    const extractedPolygon = forceBoundingBoxPolygon ? null : extractPolygonForEntities(entities);
    const polygonPoints = forceBoundingBoxPolygon
      ? rectPolygonFromBBox(renderBBox)
      : (extractedPolygon?.polygonPoints || rectPolygonFromBBox(renderBBox));
    const polygonPath = forceBoundingBoxPolygon ? '' : pointsToPathData(polygonPoints, minX, maxY);
    const fallbackPath = rectPath(width, height);
    const selectionPath = polygonPath || fallbackPath;
    return {
      id: `s_${index}`,
      name: `Sketch ${index + 1}`,
      layer: preferredLayer,
      layerColor: layerColor(preferredLayer),
      hasSyntheticOuter: true,
      hasExtractedPolygon: !forceBoundingBoxPolygon && !!extractedPolygon,
      mixedOuterLayers: usedLayers.length > 1,
      selectionFillAllowed: false,
      selectionPolygonSource: forceBoundingBoxPolygon
        ? 'bbox-forced'
        : (extractedPolygon ? 'raw-extracted' : 'bbox-fallback'),
      outerBoundaryItems,
      pathData: polygonPath,
      selectionPathData: selectionPath,
      fillRule: 'nonzero',
      polygonPoints,
      engravingPolygonPoints: pointsToLocalPreviewCoords(polygonPoints, minX, maxY),
      engravingHoles: [],
      bbox: { w: width, h: height },
      decorSVG: [],
      decorItems: [],
      exportEntities: [...exportEntityMap.values()],
      ownerLayers: usedLayers,
      involvedLayers: usedLayers,
      holes: [],
      qty: 1,
      visible: true,
      selected: false,
    };
  }

  function buildStructuredPreviewShape({
    shapeRecord,
    index,
    layerOrder,
    layerColor,
    resolveEntityColor,
    nestingPolygon,
    forcedContourMethod = 'auto',
  }) {
    const entities = Array.isArray(shapeRecord?.entities) ? shapeRecord.entities : [];
    if (!entities.length) return null;

    let renderBBox = shapeRecord?.bbox || null;
    entities.forEach(entity => { renderBBox = unionBBox(renderBBox, entityBBox(entity)); });
    if (!renderBBox) return null;

    const { minX, minY, maxX, maxY } = renderBBox;
    const width = maxX - minX;
    const height = maxY - minY;
    if (width < 0.5 || height < 0.5) return null;

    const usedLayers = [...new Set(entities.map(entity => entity.layer || '0'))];
    const preferredLayer = layerOrder.find(name => usedLayers.includes(name)) || shapeRecord.layer || usedLayers[0] || '0';

    const outerBoundaryItems = dedupeRenderedItems(entities.map(entity => {
      const layerName = entity.layer || '0';
      const color = resolveEntityColor(entity, layerName);
      const svgStr = svg.entityToSVGStr(entity, minX, maxY, color);
      if (!svgStr) return null;
      return { layer: layerName, color, svg: svgStr };
    }).filter(Boolean));

    const exportEntityMap = new Map();
    entities.forEach(entity => {
      const key = entity.handle || JSON.stringify([
        entity.type, entity.layer,
        entity.start?.x, entity.start?.y,
        entity.end?.x, entity.end?.y,
        entity.center?.x, entity.center?.y,
        entity.radius, entity.startAngle, entity.endAngle,
        entity.vertices?.length,
      ]);
      if (!exportEntityMap.has(key)) {
        const serialized = serializeEntityForExport(entity, entityToPointsForExport);
        if (serialized) exportEntityMap.set(key, serialized);
      }
    });

    const directParentSourcePoints = Array.isArray(shapeRecord?.parentContour?.polygonPoints) && shapeRecord.parentContour.polygonPoints.length >= 4
      ? shapeRecord.parentContour.polygonPoints
      : (Array.isArray(shapeRecord?.parentContour?.points) && shapeRecord.parentContour.points.length >= 4
        ? shapeRecord.parentContour.points
        : null);
    const directParentPolygonPoints = Array.isArray(directParentSourcePoints) && directParentSourcePoints.length >= 4
      ? closePointRing(directParentSourcePoints)
      : null;
    const directPeerSourcePoints = Array.isArray(shapeRecord?.peerOuters) && shapeRecord.peerOuters.length === 1
      ? (Array.isArray(shapeRecord.peerOuters[0]?.polygonPoints) && shapeRecord.peerOuters[0].polygonPoints.length >= 4
        ? shapeRecord.peerOuters[0].polygonPoints
        : (Array.isArray(shapeRecord.peerOuters[0]?.points) && shapeRecord.peerOuters[0].points.length >= 4
          ? shapeRecord.peerOuters[0].points
          : null))
      : null;
    const directPeerPolygonPoints = Array.isArray(directPeerSourcePoints) && directPeerSourcePoints.length >= 4
      ? closePointRing(directPeerSourcePoints)
      : null;
    const polygonPoints = Array.isArray(shapeRecord?.polygonPoints) && shapeRecord.polygonPoints.length
      ? shapeRecord.polygonPoints
      : rectPolygonFromBBox(renderBBox);
    const structureOwnsPolygon = !!shapeRecord?.parentContour || !!(shapeRecord?.peerOuters && shapeRecord.peerOuters.length);
    const structurePolygonPoints = structureOwnsPolygon
      ? (directParentPolygonPoints || directPeerPolygonPoints || polygonPoints)
      : null;
    const envelopePolygonPoints = Array.isArray(shapeRecord?.envelopePoints) && shapeRecord.envelopePoints.length
      ? shapeRecord.envelopePoints
      : rectPolygonFromBBox(renderBBox);
    const normalizedForcedContourMethod = normalizeSketchContourMethod(forcedContourMethod);
    const forcedMode = isForcedSketchContourMethod(normalizedForcedContourMethod);
    const selectionChoice = chooseSelectionPolygon({
      entities,
      structurePolygonPoints,
      envelopePolygonPoints,
      nestingPolygon,
      forcedSource: normalizedForcedContourMethod,
    });
    const selectionPolygonPoints = selectionChoice.polygonPoints?.length ? selectionChoice.polygonPoints : null;
    const displayPolygonPoints = forcedMode && selectionPolygonPoints?.length
      ? selectionPolygonPoints
      : (structurePolygonPoints || polygonPoints);
    const polygonPath = pointsToPathData(displayPolygonPoints, minX, maxY);
    const selectionPolygonPath = selectionPolygonPoints ? pointsToPathData(selectionPolygonPoints, minX, maxY) : null;
    const fallbackPath = rectPath(width, height);
    const selectionPath = selectionPolygonPath || null;
    const holePolygons = (shapeRecord.childClosedContours || [])
      .map(contour => contour.polygonPoints || contour.points || [])
      .filter(points => Array.isArray(points) && points.length >= 3);

    return {
      id: shapeRecord.id || `s_${index}`,
      name: `Sketch ${index + 1}`,
      layer: preferredLayer,
      layerColor: layerColor(preferredLayer),
      hasSyntheticOuter: !shapeRecord?.parentContour,
      hasExtractedPolygon: !!shapeRecord?.polygonPoints?.length,
      mixedOuterLayers: usedLayers.length > 1,
      selectionFillAllowed: false,
      selectionPolygonSource: selectionChoice.source,
      selectionPolygonCoverage: summarizeCoverageMetrics(selectionChoice.coverage),
      selectionPolygonCandidates: selectionChoice.candidateSummaries || [],
      forcedContourMethod: forcedMode ? normalizedForcedContourMethod : null,
      forcedContourApplied: forcedMode ? !!selectionPolygonPoints?.length : false,
      nestingPolygonFailure: nestingPolygon?.failedOpenChain || null,
      nestingPolygonBuilderMode: nestingPolygon?.builderMode || null,
      nestingPolygonBuilderDebug: nestingPolygon?.builderDebug || null,
      nestingPolygonCandidates: (nestingPolygon?.rankedCandidates || [])
        .slice(0, 4)
        .map(summarizeNestingCandidateEntry)
        .filter(Boolean),
      nestingPolygon: nestingPolygon || null,
      outerBoundaryItems,
      pathData: polygonPath || fallbackPath,
      selectionPathData: selectionPath,
      fillRule: 'nonzero',
      polygonPoints: displayPolygonPoints,
      selectionPolygonPoints,
      engravingPolygonPoints: pointsToLocalPreviewCoords(displayPolygonPoints, minX, maxY),
      engravingHoles: holePolygons.map(points => pointsToLocalPreviewCoords(points, minX, maxY)),
      bbox: { w: width, h: height },
      decorSVG: [],
      decorItems: [],
      exportEntities: [...exportEntityMap.values()],
      ownerLayers: usedLayers,
      involvedLayers: usedLayers,
      holes: (shapeRecord.childClosedContours || []).map(contour => ({
        id: contour.id,
        points: contour.polygonPoints || contour.points || [],
      })),
      qty: 1,
      visible: true,
      selected: false,
    };
  }

  function entityToPointsForExport(entity) {
    if (!entity?.type) return [];
    switch (entity.type) {
      case 'LWPOLYLINE':
      case 'POLYLINE':
        return Array.isArray(entity.vertices)
          ? polylineVerticesToPoints(entity.vertices, entity.closed !== false)
          : [];
      case 'CIRCLE':
        return circleToPoints(entity);
      case 'ELLIPSE':
        return ellipseToPoints(entity, false);
      case 'SPLINE':
        return splineToPoints(entity);
      default:
        return [];
    }
  }

  // Reads the raw DXF text line-by-line to pull out fields that dxf-parser
  // doesn't expose (handle, ACI color, true color, extrusion vector).
  // Returns a Map keyed by entity handle so callers can look up metadata fast.
  function parseRawEntityMeta(raw) {
    if (!raw) return new Map();
    const lines = raw.split(/\r\n|\r|\n/g);
    const meta = new Map();
    let i = 0;
    let inEntities = false;
    while (i < lines.length - 1) {
      const code = lines[i].trim();
      const value = lines[i + 1];
      if (code === '0' && value === 'SECTION' && lines[i + 2]?.trim() === '2' && lines[i + 3] === 'ENTITIES') {
        inEntities = true;
        i += 4;
        continue;
      }
      if (inEntities && code === '0' && value === 'ENDSEC') break;
      if (inEntities && code === '0') {
        const entity = { type: value.trim() };
        i += 2;
        while (i < lines.length - 1) {
          const groupCode = lines[i].trim();
          const groupValue = lines[i + 1];
          if (groupCode === '0') break;
          if (groupCode === '5') entity.handle = groupValue.trim();
          if (groupCode === '62') entity.aciColor = parseInt(groupValue, 10);
          if (groupCode === '420') entity.trueColor = parseInt(groupValue, 10);
          if (groupCode === '210') entity.extrusionX = parseFloat(groupValue);
          if (groupCode === '220') entity.extrusionY = parseFloat(groupValue);
          if (groupCode === '230') entity.extrusionZ = parseFloat(groupValue);
          i += 2;
        }
        if (entity.handle) meta.set(entity.handle, entity);
        continue;
      }
      i += 2;
    }
    return meta;
  }

  // When an entity's extrusion Z is negative it was drawn on a mirrored UCS.
  // Flips all X coordinates so the geometry appears the correct way round in
  // the preview instead of being mirrored horizontally.
  function applyNegativeZExtrusionTransform(entity) {
    if (!entity) return entity;
    const mirrorPoint = point => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return point;
      return { ...point, x: -point.x };
    };
    if (entity.center) entity.center = mirrorPoint(entity.center);
    if (entity.start) entity.start = mirrorPoint(entity.start);
    if (entity.end) entity.end = mirrorPoint(entity.end);
    if (Array.isArray(entity.vertices)) entity.vertices = entity.vertices.map(vertex => mirrorPoint(vertex));
    if (Array.isArray(entity.controlPoints)) entity.controlPoints = entity.controlPoints.map(point => mirrorPoint(point));
    if (Array.isArray(entity.fitPoints)) entity.fitPoints = entity.fitPoints.map(point => mirrorPoint(point));
    if (entity.majorAxisEndPoint && Number.isFinite(entity.majorAxisEndPoint.x)) {
      entity.majorAxisEndPoint = { ...entity.majorAxisEndPoint, x: -entity.majorAxisEndPoint.x };
    }
    if (entity.type === 'ARC' && Number.isFinite(entity.startAngle) && Number.isFinite(entity.endAngle)) {
      entity.startAngle = Math.PI - entity.startAngle;
      entity.endAngle = Math.PI - entity.endAngle;
    }
    return entity;
  }

  // Merges raw-text metadata (color, extrusion) back onto the parsed entity
  // objects by matching entity handles. Also triggers the mirroring fix for
  // any entity whose extrusion Z came back negative.
  function enrichEntitiesFromRaw(entities, raw) {
    const rawMeta = parseRawEntityMeta(raw);
    if (!rawMeta.size) return entities;
    return entities.map(entity => {
      const info = rawMeta.get(entity.handle);
      if (!info) return entity;
      const extrusion = {
        x: Number.isFinite(info.extrusionX) ? info.extrusionX : 0,
        y: Number.isFinite(info.extrusionY) ? info.extrusionY : 0,
        z: Number.isFinite(info.extrusionZ) ? info.extrusionZ : 1,
      };
      if (Number.isFinite(info.aciColor)) entity.rawAciColor = info.aciColor;
      if (Number.isFinite(info.trueColor)) entity.rawTrueColor = info.trueColor;
      entity.extrusion = extrusion;
      if (Math.abs(extrusion.x) < 1e-6 && Math.abs(extrusion.y) < 1e-6 && extrusion.z < 0) {
        applyNegativeZExtrusionTransform(entity);
      }
      return entity;
    });
  }

  // Parser-driven DXF-to-preview pipeline. We intentionally avoid contour or
  // shape inference here and instead render the DXF entities directly, grouped
  // only by Flatten-based connectivity. This keeps the modal faithful to the
  // source file and removes custom contour heuristics from the active path.
  function parseDXFToShapes(dxf, raw, settingsInput = {}) {
    const settings = normalizeSettings(settingsInput);
    const sketchContourMethod = normalizeSketchContourMethod(settings.sketchContourMethod);
    const singleSketchMode = settings?.multiSketchDetection === false;
    const entities = enrichEntitiesFromRaw([...(dxf.entities || [])], raw);
    const layerTable = (dxf.tables && dxf.tables.layer && dxf.tables.layer.layers) || {};
    const layerOrder = Object.keys(layerTable);
    const { layerColor, resolveEntityColor } = createLayerResolver(layerTable);
    const renderableEntities = entities.filter(entity => {
      if (!entity?.type) return false;
      if (['HATCH', 'TEXT', 'MTEXT', 'DIMENSION', 'INSERT', 'POINT'].includes(entity.type)) return false;
      return !!entityBBox(entity) && !!svg.entityToSVGStr(entity, 0, 0, '#fff');
    });
    if (!renderableEntities.length) return null;

    const groups = singleSketchMode
      ? [renderableEntities]
      : buildSketchGroups(renderableEntities);
    const rawPreviewShapes = groups
      .map((groupEntities, index) => buildRawPreviewShape({
        entities: groupEntities,
        index,
        layerOrder,
        layerColor,
        resolveEntityColor,
        forceBoundingBoxPolygon: singleSketchMode,
      }))
      .filter(Boolean);
    if (!rawPreviewShapes.length) return null;

    const structuredShapes = singleSketchMode
      ? []
      : detectStructuredShapes(renderableEntities, {
        singleSketch: false,
      });
    debugDXF('Sketch contour method', {
      rawSetting: settingsInput?.sketchContourMethod ?? null,
      normalizedSetting: settings.sketchContourMethod,
      methodPassedToDetect: sketchContourMethod,
      shapeCount: structuredShapes.length,
      knownMethods: SKETCH_CONTOUR_METHODS,
      singleSketchMode,
    });
    const nestingPolygons = singleSketchMode
      ? []
      : structuredShapes.map(shape => detectContour(shape, {
        contourMethod: sketchContourMethod,
        gapTolerance: 100,
        tolerance: 0.001
      }));

    const shapes = structuredShapes.length
      ? structuredShapes
          .map((shapeRecord, index) => buildStructuredPreviewShape({
            shapeRecord,
            index,
            layerOrder,
            layerColor,
            resolveEntityColor,
            nestingPolygon: nestingPolygons[index] || null,
            forcedContourMethod: sketchContourMethod,
          }))
          .filter(Boolean)
      : rawPreviewShapes;
    if (!shapes.length) return null;

    const usedLayers = [...new Set(shapes.flatMap(shape => shape.involvedLayers || [shape.layer]))];
    const layerMap = new Map(usedLayers.map(name => [name, layerColor(name)]));
    const orderedLayers = layerOrder.map(name => ({ name, color: layerColor(name) })).filter(layer => layer.name && usedLayers.includes(layer.name));
    const extraLayers = [...layerMap.entries()]
      .filter(([name]) => !layerOrder.includes(name))
      .map(([name, color]) => ({ name, color }));
    const layers = [...orderedLayers, ...extraLayers];

    return { shapes, layers };
  }

  const LAYER_DEFS = [
    { name: 'BODY', color: '#4f8ef7' },
    { name: 'CUT', color: '#f75f5f' },
    { name: 'DRILL', color: '#4fcf8e' },
    { name: 'FOLD', color: '#f7c34f' },
    { name: 'ENGRAVE', color: '#cf4ff7' },
  ];
  const GENERATORS = [
    r => { const w = 50 + r() * 110; const h = 32 + r() * 80; return { d: `M0,0 H${svg.f(w)} V${svg.f(h)} H0 Z`, w, h, name: 'Plate' }; },
    r => { const w = 72 + r() * 65; const h = 62 + r() * 55; const fw = 18 + r() * 20; const fh = 18 + r() * 20; return { d: `M0,0 H${svg.f(w)} V${svg.f(fh)} H${svg.f(fw)} V${svg.f(h)} H0 Z`, w, h, name: 'L-Bracket' }; },
    r => { const w = 82 + r() * 62; const h = 52 + r() * 45; const tw = 14 + r() * 12; const fw = 14 + r() * 12; return { d: `M0,0 H${svg.f(w)} V${svg.f(h)} H${svg.f(w - fw)} V${svg.f(tw)} H${svg.f(fw)} V${svg.f(h)} H0 Z`, w, h, name: 'U-Channel' }; },
  ];

  // Generates deterministic fake shape data from a hash of the filename.
  // Used so the preview modal always shows something plausible even before a
  // real parse completes or when no DXF path is available yet.
  function mockDXFData(filename) {
    const rng = mkRng(hashStr(filename));
    const numLayers = 2 + Math.floor(rng() * 3);
    const layers = LAYER_DEFS.slice(0, numLayers);
    const shapes = [];
    let idx = 0;
    layers.forEach(layer => {
      if (['DRILL', 'FOLD', 'ENGRAVE'].includes(layer.name)) return;
      const count = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < count; i++) {
        const generated = GENERATORS[Math.floor(rng() * GENERATORS.length)](rng);
        shapes.push({
          id: `s_${idx++}`,
          name: generated.name + (count > 1 ? ` ${String.fromCharCode(65 + i)}` : ''),
          layer: layer.name,
          layerColor: layer.color,
          pathData: generated.d,
          fillRule: generated.fillRule || 'nonzero',
          bbox: { w: generated.w, h: generated.h },
          decorSVG: [],
          holes: [],
          qty: 1,
          visible: true,
          selected: false,
        });
      }
    });
    return { shapes, layers };
  }

  function createDxfPreviewService() {
    // Entry point for opening a DXF preview. Tries three sources in priority
    // order: already-parsed shapes in state → parse from disk via Electron →
    // mock data. Always returns something so the UI never hangs on a blank modal.
    async function preparePreviewData({ state, fileId, filename }) {
      const file = state.files.find(entry => entry.id === fileId);
      const settings = typeof global.getCurrentNestingSettings === 'function'
        ? global.getCurrentNestingSettings()
        : {};
      const sketchContourMethod = normalizeSketchContourMethod(settings.sketchContourMethod);
      const matchesSketchMode = file?._multiSketchDetection === !!settings.multiSketchDetection;
      const matchesContourMethod = normalizeSketchContourMethod(file?._sketchContourMethod) === sketchContourMethod;
      let data = null;
      let source = 'mock';

      if (matchesSketchMode && matchesContourMethod && file?.shapes?.length) {
        data = applyPartLabelsToPreviewData(clonePreviewData({ shapes: file.shapes, layers: file.layers || [] }), filename);
        source = 'saved';
      }

      if (!data && file && file.path && global.electronAPI?.parseDXF) {
        try {
          const result = await global.electronAPI.parseDXF(file.path);
          if (result.success && result.data) {
            const parsed = parseDXFToShapes(result.data, result.raw, settings);
            if (parsed) {
              data = applyPartLabelsToPreviewData(clonePreviewData(parsed), filename);
              file.shapes = clonePreviewData(data).shapes;
              file.layers = clonePreviewData(data).layers;
              file._multiSketchDetection = !!settings.multiSketchDetection;
              file._sketchContourMethod = sketchContourMethod;
              source = 'real';
            }
          }
        } catch (error) {
          console.error('[DXF] Unexpected error:', error);
        }
      }

      if (!data) data = applyPartLabelsToPreviewData(clonePreviewData(mockDXFData(filename)), filename);
      return { data, source, file };
    }

    // Writes the user's shape edits (qty changes, visibility toggles) back into
    // the file record in state and triggers a re-render and a persist so the
    // changes survive a page reload.
    function applyPreviewToFile({ state, fileId, shapes, layers, renderFiles, schedulePersistJobState }) {
      const file = state.files.find(entry => entry.id === fileId);
      if (!file) return;
      file.shapes = shapes.map(shape => global.NestDxfPreviewState.clonePreviewShape(shape));
      file.layers = layers.map(layer => ({ ...layer }));
      if (typeof global.getCurrentNestingSettings === 'function') {
        const settings = global.getCurrentNestingSettings();
        file._multiSketchDetection = !!settings.multiSketchDetection;
        file._sketchContourMethod = normalizeSketchContourMethod(settings.sketchContourMethod);
      }
      file.qty = file.shapes
        .filter(shape => shape.visible !== false)
        .reduce((acc, shape) => acc + Math.max(1, parseInt(shape.qty || 1, 10)), 0);
      renderFiles();
      if (typeof schedulePersistJobState === 'function') schedulePersistJobState();
    }

    return {
      preparePreviewData,
      applyPreviewToFile,
      parseDXFToShapes,
      mockDXFData,
    };
  }

  global.NestDxfPreviewService = {
    parseDXFToShapes,
    mockDXFData,
    createDxfPreviewService,
  };
})(window);
