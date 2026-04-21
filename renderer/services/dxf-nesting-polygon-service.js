(function attachNestDxfOuterContourBuilder(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };
  const graphUtils = global.NestDxfNestingGraphUtils || {};
  const cycleRanking = global.NestDxfNestingCycleRanking || {};
  const openBuilderHelpers = global.NestDxfOpenBuilderHelpers || {};
  const makerJsHelpers = global.NestDxfMakerJsHelpers || {};

  if (!geometry) {
    global.NestDxfNestingPolygonService = {
      tryPolygonizeWithTolerance() { return null; },
      scorePolygonCoverage() { return null; },
      findBestPolygonizedCandidate() { return null; },
      buildConcaveHullFallback() { return null; },
      detectNestingPolygon() { return null; },
    };
    return;
  }

  const {
    EPS,
    TWO_PI,
    LOOP_TOLERANCE,
    samePoint,
    dist,
    unionBBox,
    entityBBox,
    closePointRing,
    pointInPoly,
    bboxContainsPoint,
    getLineEndpoints,
    polylineVerticesToPoints,
    splineToPoints,
    ellipseToPoints,
    circleToPoints,
    polygonSignedArea,
    normalizeWindingCCW,
    interiorPoint,
  } = geometry;

  const {
    ringBBox,
    pointOnSegment,
    segmentsIntersect,
    enumerateSimpleCycles,
    splitSegmentsAtIntersections,
    polygonizeSegments,
  } = graphUtils;

  const {
    extractOutermostSimpleLoop,
  } = cycleRanking;

  const {
    buildEntitySegments,
    findAttachedOpenEntities,
    buildLocalGraph,
    rankParentBuilderCycles,
  } = openBuilderHelpers;

  const {
    buildMakerJsChains,
    getOuterNestingContour,
  } = makerJsHelpers;

  const FORCED_CONTOUR_SOURCES = new Set([
    'parent-seed',
    'parent-extended',
    'makerjs-chains',
    'shapely-polygonize',
  ]);

  function normalizeRequestedContourSource(source) {
    const normalizedRaw = source == null ? 'auto' : String(source);
    const normalized = normalizedRaw === 'makerjs-outline' ? 'makerjs-chains' : normalizedRaw;
    return normalized === 'auto' || FORCED_CONTOUR_SOURCES.has(normalized)
      ? normalized
      : 'auto';
  }

  function containsPointInRing(points, point, eps = LOOP_TOLERANCE * 8) {
    const bboxLocal = ringBBox(points);
    if (!bboxLocal || !bboxContainsPoint(bboxLocal, point, eps)) return false;
    if (pointInPoly(point.x, point.y, points)) return true;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 <= EPS) continue;
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2));
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      if (Math.hypot(point.x - px, point.y - py) <= eps) return true;
    }
    return false;
  }

  function scorePolygonCoverage(polygon, entities) {
    const ring = closePointRing(polygon?.polygonPoints || polygon || []);
    if (ring.length < 4) return null;

    let supportedEntityCount = 0;
    let unsupportedEntityCount = 0;
    const unsupportedEntityIds = [];
    const unsupportedEntities = [];
    let partialEntityCount = 0;
    const partialEntityIds = [];
    const partialEntities = [];
    let insidePointCount = 0;
    let outsidePointCount = 0;
    let bbox = null;
    let totalEntityBBoxArea = 0;

    function sampleCoveragePoints(entity) {
      const points = entityToPathPoints(entity, false);
      if (!points.length) return [];
      if (points.length <= 8) return points;
      const step = Math.max(1, Math.floor(points.length / 8));
      return points.filter((_, index) => index % step === 0 || index === points.length - 1);
    }

    function entityDebugId(entity, index) {
      return entity?.handle || `${entity?.type || 'entity'}_${index}`;
    }

    function polygonDiagnostics(points) {
      const closed = closePointRing(points || []);
      if (closed.length < 4) {
        return { repeatedVertexCount: 0, selfIntersectionCount: 0, perimeter: 0, compactness: 0 };
      }

      const seen = new Set();
      let repeatedVertexCount = 0;
      for (let i = 0; i < closed.length - 1; i++) {
        const key = `${closed[i].x},${closed[i].y}`;
        if (seen.has(key)) repeatedVertexCount += 1;
        else seen.add(key);
      }

      let selfIntersectionCount = 0;
      for (let i = 0; i < closed.length - 1; i++) {
        const a1 = closed[i];
        const a2 = closed[i + 1];
        for (let j = i + 1; j < closed.length - 1; j++) {
          if (Math.abs(i - j) <= 1) continue;
          if (i === 0 && j === closed.length - 2) continue;
          const b1 = closed[j];
          const b2 = closed[j + 1];
          if (segmentsIntersect(a1, a2, b1, b2)) selfIntersectionCount += 1;
        }
      }

      let perimeter = 0;
      for (let i = 0; i < closed.length - 1; i++) perimeter += dist(closed[i], closed[i + 1]);
      const area = Math.abs(polygonSignedArea(closed.slice(0, -1)));
      const compactness = perimeter > EPS ? ((4 * Math.PI * area) / (perimeter * perimeter)) : 0;

      return {
        repeatedVertexCount,
        selfIntersectionCount,
        perimeter,
        compactness,
      };
    }

    (entities || []).filter(isRenderableEntity).forEach((entity, index) => {
      const probes = sampleCoveragePoints(entity);
      const debugId = entityDebugId(entity, index);
      const supportedProbeCount = probes.filter(point => containsPointInRing(ring, point, LOOP_TOLERANCE * 16)).length;
      const supportRatio = probes.length ? (supportedProbeCount / probes.length) : 0;
      const outsideProbePoints = probes.filter(point => !containsPointInRing(ring, point));
      const insideProbeCount = probes.length - outsideProbePoints.length;
      const outsideProbeCount = outsideProbePoints.length;
      const supported = probes.length
        ? (supportRatio >= 0.5 || (supportedProbeCount >= 2 && supportRatio >= 0.34))
        : false;
      if (supported) supportedEntityCount += 1;
      else {
        unsupportedEntityCount += 1;
        unsupportedEntityIds.push(debugId);
        unsupportedEntities.push({
          id: debugId,
          handle: entity?.handle || null,
          type: entity?.type || null,
          layer: entity?.layer || '0',
          bbox: entityBBox(entity),
          samplePointCount: probes.length,
          summary: `${debugId}:${entity?.type || 'UNKNOWN'}:${entity?.layer || '0'}`,
        });
      }

      insidePointCount += insideProbeCount;
      outsidePointCount += outsideProbeCount;

      if (probes.length && outsideProbeCount > 0) {
        partialEntityCount += 1;
        partialEntityIds.push(debugId);
        partialEntities.push({
          id: debugId,
          handle: entity?.handle || null,
          type: entity?.type || null,
          layer: entity?.layer || '0',
          samplePointCount: probes.length,
          supportedProbeCount,
          insideProbeCount,
          outsideProbeCount,
          supportRatio,
          outsideSamplePoints: outsideProbePoints.slice(0, 3).map(point => ({
            x: Number(point.x.toFixed(3)),
            y: Number(point.y.toFixed(3)),
          })),
        });
      }

      const entityBox = entityBBox(entity);
      bbox = unionBBox(bbox, entityBox);
      if (entityBox) {
        totalEntityBBoxArea += Math.max(EPS, (entityBox.maxX - entityBox.minX) * (entityBox.maxY - entityBox.minY));
      }
    });

    const polygonArea = Math.abs(polygonSignedArea(ring.slice(0, -1)));
    const pointCoverage = insidePointCount / Math.max(1, insidePointCount + outsidePointCount);
    const entityCoverage = supportedEntityCount / Math.max(1, supportedEntityCount + unsupportedEntityCount);
    const bboxArea = bbox ? Math.max(EPS, (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY)) : polygonArea;
    const bboxFillRatio = polygonArea / Math.max(EPS, bboxArea);
    const areaCoverage = Math.max(0, Math.min(1, bboxFillRatio));
    const polygonBBox = ringBBox(ring);
    const polygonBBoxArea = polygonBBox
      ? Math.max(EPS, (polygonBBox.maxX - polygonBBox.minX) * (polygonBBox.maxY - polygonBBox.minY))
      : polygonArea;
    const outerCoverage = bbox ? Math.max(0, Math.min(1, polygonBBoxArea / bboxArea)) : 1;
    const supportedAreaRatio = totalEntityBBoxArea > EPS
      ? Math.max(0, Math.min(1, polygonArea / totalEntityBBoxArea))
      : 1;
    const diagnostics = polygonDiagnostics(ring);
    const bboxWidth = bbox ? Math.max(EPS, bbox.maxX - bbox.minX) : 0;
    const bboxHeight = bbox ? Math.max(EPS, bbox.maxY - bbox.minY) : 0;
    const outerBand = bbox ? Math.max(LOOP_TOLERANCE * 32, Math.max(bboxWidth, bboxHeight) * 0.03) : 0;
    const outerMisses = bbox
      ? unsupportedEntities.filter(item => {
          const box = item?.bbox;
          if (!box) return false;
          return Math.abs(box.minX - bbox.minX) <= outerBand ||
            Math.abs(box.maxX - bbox.maxX) <= outerBand ||
            Math.abs(box.minY - bbox.minY) <= outerBand ||
            Math.abs(box.maxY - bbox.maxY) <= outerBand;
        })
      : [];
    const outerMissCount = outerMisses.length;
    const outerMissRatio = unsupportedEntityCount > 0 ? outerMissCount / unsupportedEntityCount : 0;

    return {
      pointCoverage,
      entityCoverage,
      supportedEntityCount,
      unsupportedEntityCount,
      unsupportedEntityIds,
      unsupportedEntities,
      partialEntityCount,
      partialEntityIds,
      partialEntities,
      insidePointCount,
      outsidePointCount,
      polygonArea,
      looseness: bboxFillRatio,
      areaCoverage,
      outerCoverage,
      outerMissCount,
      outerMissRatio,
      outerMissIds: outerMisses.map(item => item.id),
      supportedAreaRatio,
      repeatedVertexCount: diagnostics.repeatedVertexCount,
      selfIntersectionCount: diagnostics.selfIntersectionCount,
      perimeter: diagnostics.perimeter,
      compactness: diagnostics.compactness,
      score: (entityCoverage * 0.35) + (pointCoverage * 0.25) + (areaCoverage * 0.15) + (outerCoverage * 0.25)
        - (outerMissCount * 0.12)
        - (outerMissRatio * 0.2)
        - (diagnostics.selfIntersectionCount * 0.15)
        - (diagnostics.repeatedVertexCount * 0.03),
    };
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

  function buildParentSeedCandidate(shapeRecord, options = {}) {
    const tolerance = Math.max(LOOP_TOLERANCE * 4, options.tolerance || LOOP_TOLERANCE * 8);
    const parentContour = shapeRecord?.parentContour || (shapeRecord?.peerOuters?.length === 1 ? shapeRecord.peerOuters[0] : null);
    const seedPoints = Array.isArray(parentContour?.points) && parentContour.points.length >= 4
      ? extractOutermostSimpleLoop(parentContour.points, tolerance) || closePointRing(normalizeWindingCCW(parentContour.points))
      : null;
    if (!seedPoints || seedPoints.length < 4) {
      return {
        tolerance,
        parentContour,
        seedPoints: null,
        coverage: null,
        rankedEntry: null,
      };
    }

    const coverage = scorePolygonCoverage({ polygonPoints: seedPoints }, shapeRecord?.entities || []);
    const area = Math.abs(polygonSignedArea(seedPoints.slice(0, -1)));
    return {
      tolerance,
      parentContour,
      seedPoints,
      coverage,
      rankedEntry: {
        candidate: {
          polygonPoints: seedPoints,
          source: 'parent-seed',
          tolerance,
          seedContourId: parentContour?.id || null,
          attachedEntityIds: [],
          area,
        },
        score: coverage,
        enclosesSeed: true,
        areaGain: 1,
      },
    };
  }

  function selectForcedResultBySource(result, source) {
    if (!result || !source || source === 'auto') return null;
    if (result.source === source && Array.isArray(result.polygonPoints) && result.polygonPoints.length >= 4) {
      return { ...result };
    }

    const rankedEntry = Array.isArray(result.rankedCandidates)
      ? result.rankedCandidates.find(entry =>
          entry?.candidate?.source === source &&
          Array.isArray(entry.candidate?.polygonPoints) &&
          entry.candidate.polygonPoints.length >= 4
        )
      : null;
    if (!rankedEntry) return null;

    return {
      ...rankedEntry.candidate,
      coverage: rankedEntry.score || null,
      rankedCandidates: result.rankedCandidates || [],
      builderMode: result.builderMode || null,
      builderDebug: result.builderDebug || null,
    };
  }

  function withForcedBuilderMetadata(result, forcedSource, forcedApplied) {
    const originalChosenSource = result?.builderDebug?.chosenSource ?? result?.source ?? null;
    return {
      ...result,
      builderDebug: {
        ...(result?.builderDebug || {}),
        autoChosenSource: originalChosenSource,
        chosenSource: forcedApplied ? forcedSource : null,
        forcedSource,
        forcedApplied: !!forcedApplied,
      },
    };
  }

  function polygonizedFaceRank(a, b) {
    if ((a.rootDepth ?? Infinity) !== (b.rootDepth ?? Infinity)) return (a.rootDepth ?? Infinity) - (b.rootDepth ?? Infinity);
    if (Math.abs(((b.dominantRootPreservation?.preservationRatio) || 0) - ((a.dominantRootPreservation?.preservationRatio) || 0)) > 1e-6) {
      return ((b.dominantRootPreservation?.preservationRatio) || 0) - ((a.dominantRootPreservation?.preservationRatio) || 0);
    }
    if (Math.abs(((b.dominantRootPreservation?.preservedDominantLength) || 0) - ((a.dominantRootPreservation?.preservedDominantLength) || 0)) > 1e-6) {
      return ((b.dominantRootPreservation?.preservedDominantLength) || 0) - ((a.dominantRootPreservation?.preservedDominantLength) || 0);
    }
    if (((a.dominantRootPreservation?.droppedDominantCount) || 0) !== ((b.dominantRootPreservation?.droppedDominantCount) || 0)) {
      return ((a.dominantRootPreservation?.droppedDominantCount) || 0) - ((b.dominantRootPreservation?.droppedDominantCount) || 0);
    }
    const aPenaltyActive = !!a.unionGeometryDominantPenalty?.active;
    const bPenaltyActive = !!b.unionGeometryDominantPenalty?.active;
    if (aPenaltyActive !== bPenaltyActive) return aPenaltyActive ? 1 : -1;
    if (aPenaltyActive && bPenaltyActive) {
      if (Math.abs(((a.unionGeometryDominantPenalty?.droppedDominantLength) || 0) - ((b.unionGeometryDominantPenalty?.droppedDominantLength) || 0)) > 1e-6) {
        return ((a.unionGeometryDominantPenalty?.droppedDominantLength) || 0) - ((b.unionGeometryDominantPenalty?.droppedDominantLength) || 0);
      }
      if (((a.unionGeometryDominantPenalty?.droppedDominantCount) || 0) !== ((b.unionGeometryDominantPenalty?.droppedDominantCount) || 0)) {
        return ((a.unionGeometryDominantPenalty?.droppedDominantCount) || 0) - ((b.unionGeometryDominantPenalty?.droppedDominantCount) || 0);
      }
    }
    const aArea = a.area || 0;
    const bArea = b.area || 0;
    if (Math.abs(bArea - aArea) > 1e-6) return bArea - aArea;
    if ((a.score?.outerMissCount || 0) !== (b.score?.outerMissCount || 0)) return (a.score?.outerMissCount || 0) - (b.score?.outerMissCount || 0);
    if (Math.abs((b.score?.outerCoverage || 0) - (a.score?.outerCoverage || 0)) > 1e-6) return (b.score?.outerCoverage || 0) - (a.score?.outerCoverage || 0);
    if (Math.abs((b.score?.pointCoverage || 0) - (a.score?.pointCoverage || 0)) > 1e-6) return (b.score?.pointCoverage || 0) - (a.score?.pointCoverage || 0);
    return (b.score?.score || 0) - (a.score?.score || 0);
  }

  function entityDebugId(entity, index) {
    return entity?.handle || `${entity?.type || 'entity'}_${index}`;
  }

  function segmentAlignment(a1, a2, b1, b2) {
    const adx = a2.x - a1.x;
    const ady = a2.y - a1.y;
    const bdx = b2.x - b1.x;
    const bdy = b2.y - b1.y;
    const alen = Math.hypot(adx, ady);
    const blen = Math.hypot(bdx, bdy);
    if (alen <= EPS || blen <= EPS) return 0;
    return Math.abs(((adx * bdx) + (ady * bdy)) / (alen * blen));
  }

  function buildEntitySegmentDescriptors(entities, tolerance) {
    return (entities || []).filter(isRenderableEntity).flatMap((entity, index) =>
      buildEntitySegments(entity, tolerance, entityToPathPoints).map(([start, end]) => ({
        entityId: entityDebugId(entity, index),
        type: entity?.type || null,
        layer: entity?.layer || '0',
        start,
        end,
      }))
    );
  }

  function buildEntitySegmentRecords(entities, tolerance) {
    return (entities || []).filter(isRenderableEntity).flatMap((entity, index) => {
      const entityId = entityDebugId(entity, index);
      const segments = buildEntitySegments(entity, tolerance, entityToPathPoints);
      return segments.map(([start, end], segmentIndex) => ({
        entityId,
        type: entity?.type || null,
        layer: entity?.layer || '0',
        segmentIndex,
        entitySegmentCount: segments.length,
        sourceRecordIndex: `${entityId}:${segmentIndex}`,
        start: { x: start.x, y: start.y },
        end: { x: end.x, y: end.y },
      }));
    });
  }

  function buildEntitySegmentDescriptorsFromRecords(records) {
    return (records || []).map(record => ({
      entityId: record.entityId,
      type: record.type,
      layer: record.layer,
      start: record.start,
      end: record.end,
      sourceRecordIndex: record.sourceRecordIndex ?? null,
    }));
  }

  function segmentMatchesDescriptor(start, end, descriptor, tolerance) {
    if (!start || !end || !descriptor?.start || !descriptor?.end) return false;
    if (segmentAlignment(start, end, descriptor.start, descriptor.end) < 0.999) return false;
    return pointOnSegment(start, descriptor.start, descriptor.end, tolerance) &&
      pointOnSegment(end, descriptor.start, descriptor.end, tolerance);
  }

  function summarizeEntityCoverageFromSegments(segments, entitySegmentDescriptors, tolerance) {
    const perEntity = new Map();
    (segments || []).forEach(([start, end]) => {
      if (!start || !end || dist(start, end) <= EPS) return;
      const length = dist(start, end);
      const matchedIds = new Set();
      (entitySegmentDescriptors || []).forEach(descriptor => {
        if (!segmentMatchesDescriptor(start, end, descriptor, tolerance)) return;
        if (matchedIds.has(descriptor.entityId)) return;
        matchedIds.add(descriptor.entityId);
        const existing = perEntity.get(descriptor.entityId) || {
          id: descriptor.entityId,
          type: descriptor.type,
          layer: descriptor.layer,
          segmentCount: 0,
          totalLength: 0,
        };
        existing.segmentCount += 1;
        existing.totalLength += length;
        perEntity.set(descriptor.entityId, existing);
      });
    });
    return [...perEntity.values()]
      .sort((a, b) => {
        if (Math.abs((b.totalLength || 0) - (a.totalLength || 0)) > 1e-6) return (b.totalLength || 0) - (a.totalLength || 0);
        return (b.segmentCount || 0) - (a.segmentCount || 0);
      })
      .map(item => ({
        ...item,
        totalLength: Number(item.totalLength.toFixed(3)),
      }));
  }

  function ringToSegments(points) {
    const ring = closePointRing(points || []);
    const segments = [];
    for (let i = 0; i < ring.length - 1; i++) {
      if (dist(ring[i], ring[i + 1]) <= EPS) continue;
      segments.push([ring[i], ring[i + 1]]);
    }
    return segments;
  }

  function coordinatesToSegments(coords) {
    const points = (coords || [])
      .map(coord => ({ x: coord.x, y: coord.y }))
      .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    const segments = [];
    for (let i = 0; i < points.length - 1; i++) {
      if (dist(points[i], points[i + 1]) <= EPS) continue;
      segments.push([points[i], points[i + 1]]);
    }
    return segments;
  }

  function extractSegmentsFromJstsGeometry(geometry) {
    if (!geometry) return [];
    const geometryType = typeof geometry.getGeometryType === 'function' ? geometry.getGeometryType() : null;
    if (geometryType === 'LineString' || geometryType === 'LinearRing') {
      return coordinatesToSegments(geometry.getCoordinates?.() || []);
    }
    if (geometryType === 'Polygon') {
      const segments = [];
      const exterior = geometry.getExteriorRing?.();
      if (exterior) segments.push(...coordinatesToSegments(exterior.getCoordinates?.() || []));
      const holeCount = typeof geometry.getNumInteriorRing === 'function' ? geometry.getNumInteriorRing() : 0;
      for (let i = 0; i < holeCount; i++) {
        const hole = geometry.getInteriorRingN(i);
        if (hole) segments.push(...coordinatesToSegments(hole.getCoordinates?.() || []));
      }
      return segments;
    }
    const parts = [];
    const count = typeof geometry.getNumGeometries === 'function' ? geometry.getNumGeometries() : 0;
    for (let i = 0; i < count; i++) {
      parts.push(...extractSegmentsFromJstsGeometry(geometry.getGeometryN(i)));
    }
    return parts;
  }

  function buildEntityBoundaryStageReport({
    entitySegmentDescriptors,
    rawSegments,
    unionedLinework,
    polygons,
    unionGeometry,
    winner,
    tolerance,
  }) {
    const stageSummaries = {
      raw: summarizeEntityCoverageFromSegments(rawSegments, entitySegmentDescriptors, tolerance),
      lineUnion: summarizeEntityCoverageFromSegments(extractSegmentsFromJstsGeometry(unionedLinework), entitySegmentDescriptors, tolerance),
      faceBoundary: summarizeEntityCoverageFromSegments((polygons || []).flatMap(polygon => extractSegmentsFromJstsGeometry(polygon)), entitySegmentDescriptors, tolerance),
      polygonUnionBoundary: summarizeEntityCoverageFromSegments(extractSegmentsFromJstsGeometry(unionGeometry?.geometry?.getBoundary?.() || null), entitySegmentDescriptors, tolerance),
      exteriorRing: summarizeEntityCoverageFromSegments(ringToSegments(winner?.candidate?.polygonPoints || []), entitySegmentDescriptors, tolerance),
    };

    const entityBase = new Map();
    (entitySegmentDescriptors || []).forEach(descriptor => {
      if (!entityBase.has(descriptor.entityId)) {
        entityBase.set(descriptor.entityId, {
          id: descriptor.entityId,
          type: descriptor.type,
          layer: descriptor.layer,
        });
      }
    });

    Object.values(stageSummaries).forEach(items => {
      (items || []).forEach(item => {
        if (!entityBase.has(item.id)) {
          entityBase.set(item.id, {
            id: item.id,
            type: item.type,
            layer: item.layer,
          });
        }
      });
    });

    const report = [...entityBase.values()].map(base => {
      const stageMetrics = {};
      let maxLength = 0;
      ['raw', 'lineUnion', 'faceBoundary', 'polygonUnionBoundary', 'exteriorRing'].forEach(stage => {
        const match = (stageSummaries[stage] || []).find(item => item.id === base.id) || null;
        stageMetrics[`${stage}SegmentCount`] = match?.segmentCount ?? 0;
        stageMetrics[`${stage}Length`] = match?.totalLength ?? 0;
        maxLength = Math.max(maxLength, match?.totalLength ?? 0);
      });
      return {
        ...base,
        ...stageMetrics,
        maxStageLength: Number(maxLength.toFixed(3)),
      };
    }).filter(item => item.maxStageLength > 0);

    report.sort((a, b) => {
      if (Math.abs((b.maxStageLength || 0) - (a.maxStageLength || 0)) > 1e-6) return (b.maxStageLength || 0) - (a.maxStageLength || 0);
      return (b.rawLength || 0) - (a.rawLength || 0);
    });

    return report.slice(0, 10);
  }

  function buildPolygonFaceMembershipReport(polygons, faceEntries, entitySegmentDescriptors, tolerance) {
    return (polygons || []).map((polygon, index) => {
      const boundarySegments = extractSegmentsFromJstsGeometry(polygon);
      const contributors = summarizeEntityCoverageFromSegments(boundarySegments, entitySegmentDescriptors, tolerance);
      const entry = (faceEntries || [])[index] || null;
      return {
        faceIndex: index,
        area: entry?.area != null ? Number(entry.area.toFixed(3)) : null,
        rootDepth: entry?.rootDepth ?? null,
        polygonPointCount: entry?.candidate?.polygonPoints?.length || 0,
        contributorIds: contributors.slice(0, 8).map(item => item.id),
        contributors: contributors.slice(0, 6),
      };
    }).sort((a, b) => {
      if (Math.abs((b.area || 0) - (a.area || 0)) > 1e-6) return (b.area || 0) - (a.area || 0);
      return (a.faceIndex || 0) - (b.faceIndex || 0);
    }).slice(0, 8);
  }

  function buildDominantRootFaceContributorReport(polygons, faceEntries, entitySegmentDescriptors, tolerance) {
    return (faceEntries || []).filter(entry => (entry?.rootDepth || 0) === 0).map(entry => {
      const faceIndex = entry?.candidate?.faceIndex;
      const polygon = Number.isInteger(faceIndex) ? polygons?.[faceIndex] : null;
      const boundarySegments = extractSegmentsFromJstsGeometry(polygon);
      const contributors = summarizeEntityCoverageFromSegments(boundarySegments, entitySegmentDescriptors, tolerance);
      const totalLength = contributors.reduce((sum, item) => sum + (item?.totalLength || 0), 0);
      const leadLength = contributors[0]?.totalLength || 0;
      const runnerUpLength = contributors[1]?.totalLength || 0;
      const dominantEntities = contributors.filter((item, index) => {
        const length = item?.totalLength || 0;
        const ratio = totalLength > EPS ? (length / totalLength) : 0;
        if (length <= Math.max(tolerance * 24, 1)) return false;
        if (ratio >= 0.55) return true;
        if (index !== 0) return false;
        return ratio >= 0.45 && length >= Math.max(runnerUpLength * 1.6, tolerance * 48);
      }).map(item => ({
        id: item.id,
        type: item.type,
        layer: item.layer,
        totalLength: item.totalLength,
        contributionRatio: totalLength > EPS ? Number((item.totalLength / totalLength).toFixed(3)) : 0,
      }));

      return {
        faceIndex: faceIndex ?? null,
        area: entry?.area != null ? Number(entry.area.toFixed(3)) : null,
        contributorCount: contributors.length,
        contributorIds: contributors.slice(0, 8).map(item => item.id),
        dominantEntities,
      };
    }).filter(face => face.dominantEntities.length > 0);
  }

  function annotateCandidateDominantRootPreservation(entry, dominantRootFaces, entitySegmentDescriptors, tolerance) {
    if (!entry) return entry;
    const dominantEntities = (dominantRootFaces || []).flatMap(face =>
      (face?.dominantEntities || []).map(item => ({
        ...item,
        faceIndex: face.faceIndex,
        rootFaceArea: face.area,
      }))
    );
    if (!dominantEntities.length) {
      entry.dominantRootPreservation = {
        preservationRatio: 0,
        preservedDominantLength: 0,
        totalDominantLength: 0,
        preservedDominantCount: 0,
        droppedDominantCount: 0,
        preservedEntityIds: [],
        droppedEntityIds: [],
      };
      return entry;
    }

    const candidateSegments = ringToSegments(entry?.candidate?.polygonPoints || []);
    const candidateCoverage = summarizeEntityCoverageFromSegments(candidateSegments, entitySegmentDescriptors, tolerance);
    const candidateCoverageById = new Map(candidateCoverage.map(item => [item.id, item]));
    const preservedEntities = [];
    const droppedEntities = [];
    let totalDominantLength = 0;
    let preservedDominantLength = 0;

    dominantEntities.forEach(item => {
      const targetLength = item?.totalLength || 0;
      const candidateMatch = candidateCoverageById.get(item.id) || null;
      const coveredLength = Math.min(targetLength, candidateMatch?.totalLength || 0);
      const coveredRatio = targetLength > EPS ? (coveredLength / targetLength) : 0;
      const detail = {
        faceIndex: item.faceIndex ?? null,
        rootFaceArea: item.rootFaceArea ?? null,
        id: item.id,
        type: item.type,
        layer: item.layer,
        totalLength: targetLength,
        coveredLength: Number(coveredLength.toFixed(3)),
        coveredRatio: Number(coveredRatio.toFixed(3)),
      };
      totalDominantLength += targetLength;
      preservedDominantLength += targetLength * Math.max(0, Math.min(1, coveredRatio));
      if (coveredRatio >= 0.5) preservedEntities.push(detail);
      else droppedEntities.push(detail);
    });

    entry.dominantRootPreservation = {
      preservationRatio: totalDominantLength > EPS
        ? Number((preservedDominantLength / totalDominantLength).toFixed(3))
        : 0,
      preservedDominantLength: Number(preservedDominantLength.toFixed(3)),
      totalDominantLength: Number(totalDominantLength.toFixed(3)),
      preservedDominantCount: preservedEntities.length,
      droppedDominantCount: droppedEntities.length,
      preservedEntityIds: preservedEntities.slice(0, 8).map(item => item.id),
      droppedEntityIds: droppedEntities.slice(0, 8).map(item => item.id),
      preservedEntities: preservedEntities.slice(0, 6),
      droppedEntities: droppedEntities.slice(0, 6),
    };
    return entry;
  }

  function annotateUnionGeometryDominantPenalty(entry, tolerance) {
    if (!entry) return entry;
    const preservation = entry.dominantRootPreservation || null;
    const totalDominantLength = preservation?.totalDominantLength || 0;
    const preservedDominantLength = preservation?.preservedDominantLength || 0;
    const droppedDominantLength = Math.max(0, totalDominantLength - preservedDominantLength);
    const droppedDominantCount = preservation?.droppedDominantCount || 0;
    const droppedRatio = totalDominantLength > EPS ? (droppedDominantLength / totalDominantLength) : 0;
    const active = !!entry?.candidate?.unionGeometry &&
      droppedDominantCount > 0 &&
      droppedDominantLength > Math.max(tolerance * 48, 1) &&
      droppedRatio >= 0.5;

    entry.unionGeometryDominantPenalty = {
      active,
      droppedDominantLength: Number(droppedDominantLength.toFixed(3)),
      droppedDominantCount,
      droppedRatio: Number(droppedRatio.toFixed(3)),
      droppedEntityIds: (preservation?.droppedEntityIds || []).slice(0, 8),
    };
    return entry;
  }

  function classifyEntityBoundaryDrops(stageReport) {
    const stageOrder = ['raw', 'lineUnion', 'faceBoundary', 'polygonUnionBoundary', 'exteriorRing'];
    const stageLabels = {
      raw: 'raw',
      lineUnion: 'line-union',
      faceBoundary: 'face-boundary',
      polygonUnionBoundary: 'polygon-union-boundary',
      exteriorRing: 'exterior-ring',
    };
    const reasonLabels = {
      lineUnion: 'dissolved-or-altered-during-line-union',
      faceBoundary: 'not-part-of-any-polygonized-face',
      polygonUnionBoundary: 'internalized-during-polygon-union',
      exteriorRing: 'not-on-final-exterior-ring',
    };

    return (stageReport || []).map(item => {
      let lastPresentStage = null;
      let firstMissingAfterPresent = null;
      for (const stage of stageOrder) {
        const length = item[`${stage}Length`] || 0;
        if (length > 0) {
          lastPresentStage = stage;
          continue;
        }
        if (lastPresentStage) {
          firstMissingAfterPresent = stage;
          break;
        }
      }

      if (!firstMissingAfterPresent) return null;

      return {
        id: item.id,
        type: item.type,
        layer: item.layer,
        lastPresentStage: stageLabels[lastPresentStage] || lastPresentStage,
        firstMissingStage: stageLabels[firstMissingAfterPresent] || firstMissingAfterPresent,
        reason: reasonLabels[firstMissingAfterPresent] || 'stage-drop',
        rawLength: item.rawLength ?? 0,
        lineUnionLength: item.lineUnionLength ?? 0,
        faceBoundaryLength: item.faceBoundaryLength ?? 0,
        polygonUnionBoundaryLength: item.polygonUnionBoundaryLength ?? 0,
        exteriorRingLength: item.exteriorRingLength ?? 0,
      };
    }).filter(Boolean).sort((a, b) => {
      if (Math.abs((b.rawLength || 0) - (a.rawLength || 0)) > 1e-6) return (b.rawLength || 0) - (a.rawLength || 0);
      return String(a.id || '').localeCompare(String(b.id || ''));
    }).slice(0, 10);
  }

  function formatDebugPoint(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return {
      x: Number(point.x.toFixed(3)),
      y: Number(point.y.toFixed(3)),
    };
  }

  function buildEntityLookup(entities) {
    const lookup = new Map();
    (entities || []).filter(isRenderableEntity).forEach((entity, index) => {
      lookup.set(entityDebugId(entity, index), entity);
    });
    return lookup;
  }

  function matchEntityIdsForSegment(start, end, entitySegmentDescriptors, tolerance) {
    const matchedIds = new Set();
    (entitySegmentDescriptors || []).forEach(descriptor => {
      if (!segmentMatchesDescriptor(start, end, descriptor, tolerance)) return;
      matchedIds.add(descriptor.entityId);
    });
    return [...matchedIds];
  }

  function buildUnionConnectivityNodes(unionedLinework, entitySegmentDescriptors, tolerance) {
    const nodes = [];
    const segments = extractSegmentsFromJstsGeometry(unionedLinework);

    function ensureNode(point) {
      const existing = nodes.find(node => dist(node.point, point) <= tolerance);
      if (existing) return existing;
      const node = {
        point: { x: point.x, y: point.y },
        degree: 0,
        entityIds: new Set(),
      };
      nodes.push(node);
      return node;
    }

    segments.forEach(([start, end]) => {
      if (!start || !end || dist(start, end) <= EPS) return;
      const matchedEntityIds = matchEntityIdsForSegment(start, end, entitySegmentDescriptors, tolerance);
      const startNode = ensureNode(start);
      const endNode = ensureNode(end);
      startNode.degree += 1;
      endNode.degree += 1;
      matchedEntityIds.forEach(entityId => {
        startNode.entityIds.add(entityId);
        endNode.entityIds.add(entityId);
      });
    });

    return nodes.map(node => ({
      point: node.point,
      degree: node.degree,
      entityIds: [...node.entityIds].sort(),
    }));
  }

  function summarizeEndpointConnectivity(point, nodes, faceBoundarySegments, tolerance) {
    if (!point) {
      return {
        point: null,
        nearestNode: null,
        nearestDistance: null,
        onFaceBoundary: false,
      };
    }

    let nearestNode = null;
    let nearestDistance = Infinity;
    (nodes || []).forEach(node => {
      const distance = dist(point, node.point);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestNode = node;
      }
    });

    const onFaceBoundary = (faceBoundarySegments || []).some(([start, end]) =>
      pointOnSegment(point, start, end, tolerance)
    );

    return {
      point: formatDebugPoint(point),
      nearestNode: nearestNode ? {
        point: formatDebugPoint(nearestNode.point),
        degree: nearestNode.degree,
        entityIds: nearestNode.entityIds.slice(0, 8),
      } : null,
      nearestDistance: Number.isFinite(nearestDistance) ? Number(nearestDistance.toFixed(4)) : null,
      onFaceBoundary,
    };
  }

  function buildMissingFaceConnectivityReport({
    sourceEntities,
    entitySegmentDescriptors,
    unionedLinework,
    polygons,
    boundaryDropReasons,
    tolerance,
  }) {
    const droppedBeforeFace = (boundaryDropReasons || [])
      .filter(item => item.firstMissingStage === 'face-boundary')
      .slice(0, 6);
    if (!droppedBeforeFace.length) return [];

    const entityLookup = buildEntityLookup(sourceEntities);
    const unionNodes = buildUnionConnectivityNodes(unionedLinework, entitySegmentDescriptors, tolerance);
    const faceBoundarySegments = (polygons || []).flatMap(polygon => extractSegmentsFromJstsGeometry(polygon));

    return droppedBeforeFace.map(item => {
      const entity = entityLookup.get(item.id) || null;
      const points = entityToPathPoints(entity, true);
      const startPoint = points[0] || null;
      const endPoint = points.length > 1 ? points[points.length - 1] : startPoint;
      const startConnectivity = summarizeEndpointConnectivity(startPoint, unionNodes, faceBoundarySegments, tolerance);
      const endConnectivity = summarizeEndpointConnectivity(endPoint, unionNodes, faceBoundarySegments, tolerance);
      const sameEndpoint = startPoint && endPoint && dist(startPoint, endPoint) <= tolerance;

      return {
        id: item.id,
        type: item.type,
        layer: item.layer,
        reason: item.reason,
        endpointCount: sameEndpoint ? 1 : 2,
        startEndpoint: startConnectivity,
        endEndpoint: sameEndpoint ? null : endConnectivity,
      };
    });
  }

  function polygonizerCollectionToArray(collection) {
    if (!collection) return [];
    if (typeof collection.toArray === 'function') return collection.toArray();
    if (Array.isArray(collection)) return collection.slice();
    return Array.from(collection || []);
  }

  function summarizePolygonizerGeometryEntities(collection, entitySegmentDescriptors, tolerance, limit = 8) {
    const geometries = polygonizerCollectionToArray(collection);
    const segments = geometries.flatMap(geometry => extractSegmentsFromJstsGeometry(geometry));
    return summarizeEntityCoverageFromSegments(segments, entitySegmentDescriptors, tolerance).slice(0, limit);
  }

  function buildPolygonizerDiagnosticsReport(polygonizer, entitySegmentDescriptors, tolerance) {
    const dangles = polygonizer?.getDangles?.() || null;
    const cutEdges = polygonizer?.getCutEdges?.() || null;
    const invalidRingLines = polygonizer?.getInvalidRingLines?.() || null;
    const dangleArray = polygonizerCollectionToArray(dangles);
    const cutEdgeArray = polygonizerCollectionToArray(cutEdges);
    const invalidRingArray = polygonizerCollectionToArray(invalidRingLines);

    return {
      dangleCount: dangleArray.length,
      cutEdgeCount: cutEdgeArray.length,
      invalidRingLineCount: invalidRingArray.length,
      dangleEntities: summarizePolygonizerGeometryEntities(dangleArray, entitySegmentDescriptors, tolerance),
      cutEdgeEntities: summarizePolygonizerGeometryEntities(cutEdgeArray, entitySegmentDescriptors, tolerance),
      invalidRingEntities: summarizePolygonizerGeometryEntities(invalidRingArray, entitySegmentDescriptors, tolerance),
    };
  }

  function isCurveLikeEntityType(type) {
    return type === 'ARC' || type === 'ELLIPSE' || type === 'SPLINE';
  }

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

  function projectPointToSegmentInterior(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 <= EPS) return null;
    const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2;
    if (t <= EPS || t >= 1 - EPS) return null;
    const projection = {
      x: a.x + dx * t,
      y: a.y + dy * t,
    };
    return {
      point: projection,
      distance: dist(point, projection),
    };
  }

  function findBestForeignConnectionForPoint(point, sourceEntityId, entitySegmentDescriptors, tolerance, maxDistance) {
    if (!point || !Number.isFinite(maxDistance) || maxDistance <= EPS) return null;
    let best = null;

    (entitySegmentDescriptors || []).forEach(descriptor => {
      if (!descriptor || descriptor.entityId === sourceEntityId) return;

      [descriptor.start, descriptor.end].forEach(targetPoint => {
        if (!targetPoint) return;
        const distance = dist(point, targetPoint);
        if (distance <= EPS || distance > maxDistance) return;
        if (!best || distance < best.distance - EPS || (Math.abs(distance - best.distance) <= EPS && best.mode !== 'endpoint')) {
          best = {
            mode: 'endpoint',
            targetPoint: { x: targetPoint.x, y: targetPoint.y },
            targetEntityId: descriptor.entityId,
            distance,
          };
        }
      });

      const projection = projectPointToSegmentInterior(point, descriptor.start, descriptor.end);
      if (!projection || projection.distance <= EPS || projection.distance > maxDistance) return;
      if (!best || projection.distance < best.distance - EPS) {
        best = {
          mode: 'segment',
          targetPoint: projection.point,
          targetEntityId: descriptor.entityId,
          targetRecordIndex: descriptor.sourceRecordIndex ?? null,
          distance: projection.distance,
        };
      }
    });

    return best
      ? {
          ...best,
          distance: Number(best.distance.toFixed(4)),
        }
      : null;
  }

  function splitRecordAtPoint(records, recordIndex, splitPoint) {
    const record = records[recordIndex];
    if (!record || !splitPoint) return;
    if (dist(record.start, splitPoint) <= EPS || dist(record.end, splitPoint) <= EPS) return;
    const first = {
      ...record,
      end: { x: splitPoint.x, y: splitPoint.y },
    };
    const second = {
      ...record,
      start: { x: splitPoint.x, y: splitPoint.y },
      segmentIndex: record.segmentIndex + 0.5,
    };
    records.splice(recordIndex, 1, first, second);
  }


  function normalizeCurveEndpointsBeforeUnion(entitySegmentRecords, tolerance) {
    const records = (entitySegmentRecords || []).map(record => ({
      ...record,
      start: { x: record.start.x, y: record.start.y },
      end: { x: record.end.x, y: record.end.y },
      sourceRecordIndex: record.sourceRecordIndex ?? null,
    }));
    const entityIds = [...new Set(records.map(record => record.entityId))];
    if (!entityIds.length) {
      return {
        records,
        applied: false,
        snapCount: 0,
        snappedEntities: [],
        snaps: [],
      };
    }

    const snapDistanceLimit = Math.max(tolerance * 8, 0.01);
    const snaps = [];

    entityIds.forEach(entityId => {
      const endpointKeys = ['start', 'end'];
      endpointKeys.forEach(key => {
        const entityRecords = records
          .filter(record => record.entityId === entityId)
          .sort((left, right) => left.segmentIndex - right.segmentIndex);
        if (!entityRecords.length || !isCurveLikeEntityType(entityRecords[0].type)) return;

        const target = key === 'start'
          ? {
              record: entityRecords[0],
              key: 'start',
              point: entityRecords[0].start,
            }
          : {
              record: entityRecords[entityRecords.length - 1],
              key: 'end',
              point: entityRecords[entityRecords.length - 1].end,
            };
        const descriptors = buildEntitySegmentDescriptorsFromRecords(records);
        const match = findBestForeignConnectionForPoint(target.point, entityId, descriptors, tolerance, snapDistanceLimit);
        if (!match) return;
        const fromPoint = { x: target.point.x, y: target.point.y };
        if (target.key === 'start') {
          target.record.start = { x: match.targetPoint.x, y: match.targetPoint.y };
        } else {
          target.record.end = { x: match.targetPoint.x, y: match.targetPoint.y };
        }
        if (match.mode === 'segment' && match.targetRecordIndex) {
          const targetIndex = records.findIndex(record =>
            record.sourceRecordIndex === match.targetRecordIndex &&
            pointOnSegment(match.targetPoint, record.start, record.end, tolerance * 4)
          );
          if (targetIndex >= 0) splitRecordAtPoint(records, targetIndex, match.targetPoint);
        }
        snaps.push({
          entityId,
          type: entityRecords[0].type,
          from: formatDebugPoint(fromPoint),
          to: formatDebugPoint(match.targetPoint),
          mode: match.mode,
          targetEntityId: match.targetEntityId,
          distance: match.distance,
        });
      });
    });

    return {
      records,
      applied: snaps.length > 0,
      snapCount: snaps.length,
      snappedEntities: [...new Set(snaps.map(item => item.entityId))].slice(0, 6),
      snaps: snaps.slice(0, 8),
    };
  }

  function buildCurveEndpointRepair({
    sourceEntities,
    entitySegmentDescriptors,
    missingFaceConnectivity,
    boundaryDropReasons,
    tolerance,
  }) {
    const droppedCurves = (boundaryDropReasons || [])
      .filter(item => item.firstMissingStage === 'face-boundary' && isCurveLikeEntityType(item.type))
      .map(item => item.id);
    if (!droppedCurves.length) {
      return {
        attempted: false,
        bridgeSegments: [],
        repairs: [],
      };
    }

    const bbox = computeEntitiesBBox(sourceEntities);
    const span = bboxSpan(bbox);
    const repairLimit = Math.min(
      Math.max(12, span * 0.08),
      Math.max(4, tolerance * 48, span * 0.03)
    );

    const bridgeSegments = [];
    const repairs = [];
    const seenBridgeKeys = new Set();

    (missingFaceConnectivity || [])
      .filter(item => droppedCurves.includes(item.id))
      .forEach(item => {
        const endpointEntries = [item.startEndpoint, item.endEndpoint].filter(Boolean);
        if (!endpointEntries.length) return;

        const endpointRepairs = endpointEntries.map(endpoint => {
          const nodeEntityIds = endpoint?.nearestNode?.entityIds || [];
          const isolatedSelfNode = (endpoint?.nearestNode?.degree ?? 0) === 1 &&
            nodeEntityIds.length === 1 &&
            nodeEntityIds[0] === item.id;
          if (!isolatedSelfNode || !endpoint?.point) return null;
          return {
            endpoint,
            connection: findBestForeignConnectionForPoint(endpoint.point, item.id, entitySegmentDescriptors, tolerance, repairLimit),
          };
        });

        if (!endpointRepairs.length || endpointRepairs.some(entry => !entry?.connection)) return;

        endpointRepairs.forEach(entry => {
          const start = entry.endpoint.point;
          const end = entry.connection.targetPoint;
          const keyA = `${start.x.toFixed(4)},${start.y.toFixed(4)}`;
          const keyB = `${end.x.toFixed(4)},${end.y.toFixed(4)}`;
          const bridgeKey = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
          if (seenBridgeKeys.has(bridgeKey)) return;
          seenBridgeKeys.add(bridgeKey);
          bridgeSegments.push([
            { x: start.x, y: start.y },
            { x: end.x, y: end.y },
          ]);
          repairs.push({
            entityId: item.id,
            type: item.type,
            from: formatDebugPoint(start),
            to: formatDebugPoint(end),
            mode: entry.connection.mode,
            targetEntityId: entry.connection.targetEntityId,
            targetRecordIndex: entry.connection.targetRecordIndex ?? null,
            distance: entry.connection.distance,
          });
        });
      });

    return {
      attempted: true,
      repairLimit: Number(repairLimit.toFixed(3)),
      bridgeSegments,
      repairs,
    };
  }

  function cloneSegmentRecords(records) {
    return (records || []).map(record => ({
      ...record,
      start: { x: record.start.x, y: record.start.y },
      end: { x: record.end.x, y: record.end.y },
    }));
  }

  function applyCurveRepairsToRecords(records, repairs, tolerance) {
    const repairedRecords = cloneSegmentRecords(records);
    let appliedCount = 0;

    (repairs || []).forEach(repair => {
      const entityRecords = repairedRecords
        .filter(record => record.entityId === repair.entityId)
        .sort((left, right) => left.segmentIndex - right.segmentIndex);
      if (!entityRecords.length || !repair?.from || !repair?.to) return;

      const first = entityRecords[0];
      const last = entityRecords[entityRecords.length - 1];
      if (dist(first.start, repair.from) <= tolerance) {
        first.start = { x: repair.to.x, y: repair.to.y };
        appliedCount += 1;
      } else if (dist(last.end, repair.from) <= tolerance) {
        last.end = { x: repair.to.x, y: repair.to.y };
        appliedCount += 1;
      } else {
        return;
      }

      if (repair.mode === 'segment' && repair.targetRecordIndex) {
        const targetIndex = repairedRecords.findIndex(record =>
          record.sourceRecordIndex === repair.targetRecordIndex &&
          pointOnSegment(repair.to, record.start, record.end, tolerance * 4)
        );
        if (targetIndex >= 0) splitRecordAtPoint(repairedRecords, targetIndex, repair.to);
      }
    });

    return {
      records: repairedRecords,
      appliedCount,
    };
  }

  function countMissingCurveFaces(boundaryDropReasons) {
    return (boundaryDropReasons || []).filter(item =>
      item.firstMissingStage === 'face-boundary' && isCurveLikeEntityType(item.type)
    ).length;
  }

  function shouldPreferPolygonizedPass(currentPass, candidatePass) {
    if (!candidatePass?.winner) return false;
    if (!currentPass?.winner) return true;

    const currentMissingCurves = countMissingCurveFaces(currentPass.boundaryDropReasons);
    const candidateMissingCurves = countMissingCurveFaces(candidatePass.boundaryDropReasons);
    if (candidateMissingCurves !== currentMissingCurves) return candidateMissingCurves < currentMissingCurves;

    const currentOuterMiss = currentPass.winner?.score?.outerMissCount ?? Infinity;
    const candidateOuterMiss = candidatePass.winner?.score?.outerMissCount ?? Infinity;
    if (candidateOuterMiss !== currentOuterMiss) return candidateOuterMiss < currentOuterMiss;

    const currentScore = currentPass.winner?.score?.score ?? -Infinity;
    const candidateScore = candidatePass.winner?.score?.score ?? -Infinity;
    if (Math.abs(candidateScore - currentScore) > 1e-6) return candidateScore > currentScore;

    return (candidatePass.winner?.area || 0) > (currentPass.winner?.area || 0) + EPS;
  }

  function summarizePolygonizedEntityProvenance({
    winner,
    polygonized,
    unionBoundary,
    entitySegmentDescriptors,
    tolerance,
  }) {
    if (!winner) return null;
    const chosenSegments = ringToSegments(winner?.candidate?.polygonPoints || []);
    const chosenEntities = summarizeEntityCoverageFromSegments(chosenSegments, entitySegmentDescriptors, tolerance);

    const sharedEdgeSegments = [];
    const rootEntries = (unionBoundary?.rootEntries || []).filter(Boolean);
    if (rootEntries.length > 1) {
      if (polygonized?.edges?.length && polygonized?.nodes?.length) {
        const edgeUseCount = new Map();
        rootEntries.forEach(entry => {
          (entry?.candidate?.edgeIndices || []).forEach(edgeIndex => {
            edgeUseCount.set(edgeIndex, (edgeUseCount.get(edgeIndex) || 0) + 1);
          });
        });
        edgeUseCount.forEach((count, edgeIndex) => {
          if (count < 2) return;
          const edge = polygonized?.edges?.[edgeIndex];
          const start = edge ? polygonized?.nodes?.[edge.startIndex] : null;
          const end = edge ? polygonized?.nodes?.[edge.endIndex] : null;
          if (!start || !end || dist(start, end) <= EPS) return;
          sharedEdgeSegments.push([
            { x: start.x, y: start.y },
            { x: end.x, y: end.y },
          ]);
        });
      } else {
        const rootFaceSegments = rootEntries.flatMap(entry => ringToSegments(entry?.candidate?.polygonPoints || []));
        const chosenKeys = new Set(chosenSegments.map(([start, end]) =>
          `${start.x.toFixed(6)},${start.y.toFixed(6)}|${end.x.toFixed(6)},${end.y.toFixed(6)}`
        ));
        rootFaceSegments.forEach(([start, end]) => {
          const forwardKey = `${start.x.toFixed(6)},${start.y.toFixed(6)}|${end.x.toFixed(6)},${end.y.toFixed(6)}`;
          const reverseKey = `${end.x.toFixed(6)},${end.y.toFixed(6)}|${start.x.toFixed(6)},${start.y.toFixed(6)}`;
          if (chosenKeys.has(forwardKey) || chosenKeys.has(reverseKey)) return;
          sharedEdgeSegments.push([start, end]);
        });
      }
    }

    const droppedSharedEntities = summarizeEntityCoverageFromSegments(sharedEdgeSegments, entitySegmentDescriptors, tolerance)
      .filter(item => !chosenEntities.some(chosen => chosen.id === item.id));

    return {
      chosenContourEntities: chosenEntities.slice(0, 8),
      droppedSharedEntities: droppedSharedEntities.slice(0, 8),
      chosenContourSegmentCount: chosenSegments.length,
      droppedSharedSegmentCount: sharedEdgeSegments.length,
    };
  }

  function buildPolygonizedEntryFromFace(face, index, source, tolerance, entities, extraCandidate = {}) {
    const ring = closePointRing(normalizeWindingCCW(face?.points || []));
    if (ring.length < 4) return null;
    const coverage = scorePolygonCoverage({ polygonPoints: ring }, entities || []);
    if (!coverage) return null;
    const area = Math.abs(polygonSignedArea(ring.slice(0, -1)));
    const samplePoint = interiorPoint(ring) || ring[0] || null;
    return {
      candidate: {
        polygonPoints: ring,
        source,
        tolerance,
        area,
        faceIndex: index,
        edgeIndices: Array.isArray(face?.edgeIndices) ? face.edgeIndices.slice() : [],
        ...extraCandidate,
      },
      score: coverage,
      area,
      samplePoint,
      rootDepth: 0,
    };
  }

  function assignPolygonizedRootDepth(entries) {
    (entries || []).forEach((entry, index) => {
      if (!entry?.samplePoint) return;
      let depth = 0;
      (entries || []).forEach((other, otherIndex) => {
        if (otherIndex === index) return;
        if ((other?.area || 0) <= (entry?.area || 0) + EPS) return;
        if (containsPointInRing(other?.candidate?.polygonPoints || [], entry.samplePoint)) depth += 1;
      });
      entry.rootDepth = depth;
    });
    return entries || [];
  }

  function buildUnionBoundaryEntriesFromPolygonizedRoots(entries, polygonized, shapeRecord, tolerance) {
    const rootEntries = (entries || []).filter(entry => (entry?.rootDepth || 0) === 0);
    if (rootEntries.length < 2) {
      return {
        entries: [],
        boundarySegments: [],
        polygonizedFaces: [],
        rootEntries,
      };
    }

    const edgeUseCount = new Map();
    rootEntries.forEach(entry => {
      (entry?.candidate?.edgeIndices || []).forEach(edgeIndex => {
        edgeUseCount.set(edgeIndex, (edgeUseCount.get(edgeIndex) || 0) + 1);
      });
    });

    const boundarySegments = [];
    edgeUseCount.forEach((count, edgeIndex) => {
      if (count !== 1) return;
      const edge = polygonized?.edges?.[edgeIndex];
      const start = edge ? polygonized?.nodes?.[edge.startIndex] : null;
      const end = edge ? polygonized?.nodes?.[edge.endIndex] : null;
      if (!start || !end || dist(start, end) <= EPS) return;
      boundarySegments.push([
        { x: start.x, y: start.y },
        { x: end.x, y: end.y },
      ]);
    });

    if (!boundarySegments.length) {
      return {
        entries: [],
        boundarySegments: [],
        polygonizedFaces: [],
      };
    }

    const unionPolygonized = polygonizeSegments(boundarySegments, tolerance);
    const unionFaces = Array.isArray(unionPolygonized?.faces) ? unionPolygonized.faces : [];
    const unionEntries = assignPolygonizedRootDepth(unionFaces.map((face, index) =>
      buildPolygonizedEntryFromFace(
        face,
        index,
        'shapely-polygonize',
        tolerance,
        shapeRecord?.entities || [],
        {
          unionBoundary: true,
          mergedFaceCount: rootEntries.length,
          boundaryLoopIndex: index,
        }
      )
    ).filter(Boolean));

    return {
      entries: unionEntries,
      boundarySegments,
      polygonizedFaces: unionFaces,
      rootEntries,
    };
  }

  function extractPolygonGeometries(geometry) {
    if (!geometry) return [];
    if (typeof geometry.getExteriorRing === 'function') return [geometry];
    const parts = [];
    const count = typeof geometry.getNumGeometries === 'function' ? geometry.getNumGeometries() : 0;
    for (let i = 0; i < count; i++) {
      const child = geometry.getGeometryN(i);
      if (child && typeof child.getExteriorRing === 'function') parts.push(child);
    }
    return parts;
  }

  function buildPolygonizedEntryFromJstsPolygon(polygon, index, source, tolerance, entities, extraCandidate = {}) {
    const exterior = polygon?.getExteriorRing?.();
    const coords = exterior?.getCoordinates?.();
    if (!coords?.length) return null;
    const ring = closePointRing(normalizeWindingCCW(coords
      .map(coord => ({ x: coord.x, y: coord.y }))
      .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))));
    if (ring.length < 4) return null;
    const coverage = scorePolygonCoverage({ polygonPoints: ring }, entities || []);
    if (!coverage) return null;
    const area = typeof polygon?.getArea === 'function'
      ? Math.abs(polygon.getArea())
      : Math.abs(polygonSignedArea(ring.slice(0, -1)));
    const samplePoint = interiorPoint(ring) || ring[0] || null;
    return {
      candidate: {
        polygonPoints: ring,
        source,
        tolerance,
        area,
        faceIndex: index,
        ...extraCandidate,
      },
      score: coverage,
      area,
      samplePoint,
      rootDepth: 0,
    };
  }

  function buildUnionGeometryEntriesFromJstsPolygons(polygons, shapeRecord, tolerance) {
    const jsts = global.jsts || null;
    if (!Array.isArray(polygons) || !polygons.length || !jsts?.geom?.GeometryFactory) {
      return {
        entries: [],
        componentCount: 0,
        unionAvailable: !!jsts?.geom?.GeometryFactory,
      };
    }

    try {
      const geometryFactory = new jsts.geom.GeometryFactory();
      const polygonCollection = geometryFactory.createGeometryCollection(polygons);
      const unionGeometry = polygonCollection?.union?.();
      const components = extractPolygonGeometries(unionGeometry);
      const entries = assignPolygonizedRootDepth(components.map((polygon, index) =>
        buildPolygonizedEntryFromJstsPolygon(
          polygon,
          index,
          'shapely-polygonize',
          tolerance,
          shapeRecord?.entities || [],
          {
            unionGeometry: true,
            mergedFaceCount: polygons.length,
            unionGeometryComponentIndex: index,
          }
        )
      ).filter(Boolean));
      return {
        entries,
        componentCount: components.length,
        geometry: unionGeometry,
        unionAvailable: true,
      };
    } catch (error) {
      return {
        entries: [],
        componentCount: 0,
        geometry: null,
        unionAvailable: true,
        error: error?.message || String(error),
      };
    }
  }

  function buildUnionGeometryEntriesFromPolygonizedFaces(entries, shapeRecord, tolerance) {
    const rootEntries = (entries || []).filter(entry => (entry?.rootDepth || 0) === 0);
    const jsts = global.jsts || null;
    if (rootEntries.length < 2 || !jsts?.geom?.GeometryFactory || !jsts?.geom?.Coordinate) {
      return {
        entries: [],
        componentCount: 0,
        rootEntries,
        unionAvailable: !!(jsts?.geom?.GeometryFactory && jsts?.geom?.Coordinate),
      };
    }

    try {
      const geometryFactory = new jsts.geom.GeometryFactory();
      const Coordinate = jsts.geom.Coordinate;
      const polygons = rootEntries.map(entry => {
        const ring = closePointRing(entry?.candidate?.polygonPoints || []);
        if (ring.length < 4) return null;
        const coordinates = ring.map(point => new Coordinate(point.x, point.y));
        return geometryFactory.createPolygon(geometryFactory.createLinearRing(coordinates));
      }).filter(Boolean);

      if (!polygons.length) {
        return {
          entries: [],
          componentCount: 0,
          rootEntries,
          unionAvailable: true,
        };
      }

      let unionGeometry = polygons[0];
      for (let i = 1; i < polygons.length; i++) {
        unionGeometry = unionGeometry.union(polygons[i]);
      }

      const components = [];
      const numGeometries = typeof unionGeometry?.getNumGeometries === 'function'
        ? unionGeometry.getNumGeometries()
        : 0;
      if (numGeometries > 0) {
        for (let i = 0; i < numGeometries; i++) {
          const geometry = unionGeometry.getGeometryN(i);
          if (geometry?.getExteriorRing) components.push(geometry);
        }
      } else if (unionGeometry?.getExteriorRing) {
        components.push(unionGeometry);
      }

      const unionEntries = assignPolygonizedRootDepth(components.map((polygon, index) => {
        const exterior = polygon?.getExteriorRing?.();
        const coords = exterior?.getCoordinates?.();
        if (!coords?.length) return null;
        const face = {
          points: coords
            .map(coord => ({ x: coord.x, y: coord.y }))
            .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)),
        };
        return buildPolygonizedEntryFromFace(
          face,
          index,
          'shapely-polygonize',
          tolerance,
          shapeRecord?.entities || [],
          {
            unionGeometry: true,
            mergedFaceCount: rootEntries.length,
            unionGeometryComponentIndex: index,
            area: typeof polygon?.getArea === 'function' ? Math.abs(polygon.getArea()) : undefined,
          }
        );
      }).filter(Boolean));

      return {
        entries: unionEntries,
        componentCount: components.length,
        rootEntries,
        unionAvailable: true,
      };
    } catch (error) {
      return {
        entries: [],
        componentCount: 0,
        rootEntries,
        unionAvailable: true,
        error: error?.message || String(error),
      };
    }
  }

  function buildJstsLineStringsFromSegments(segments, geometryFactory, Coordinate) {
    return (segments || []).map(([start, end]) => {
      if (!start || !end || dist(start, end) <= EPS) return null;
      return geometryFactory.createLineString([
        new Coordinate(start.x, start.y),
        new Coordinate(end.x, end.y),
      ]);
    }).filter(Boolean);
  }

  function unionJstsLinework(rawSegments, tolerance, jsts) {
    const geometryFactory = new jsts.geom.GeometryFactory();
    const Coordinate = jsts.geom.Coordinate;
    const UnaryUnionOp = jsts.operation?.union?.UnaryUnionOp || null;
    const lineStrings = buildJstsLineStringsFromSegments(rawSegments, geometryFactory, Coordinate);
    const linework = geometryFactory.createMultiLineString(lineStrings);

    try {
      const unioned = UnaryUnionOp?.union
        ? UnaryUnionOp.union(linework)
        : linework?.union?.();
      return {
        geometryFactory,
        Coordinate,
        linework,
        unionedLinework: unioned,
        lineUnionStrategy: UnaryUnionOp?.union ? 'jsts-unary-union' : 'geometry-union',
        lineUnionFallbackUsed: false,
        lineUnionError: null,
      };
    } catch (error) {
      const nodedSegments = splitSegmentsAtIntersections(rawSegments, tolerance);
      const fallbackLineStrings = buildJstsLineStringsFromSegments(nodedSegments, geometryFactory, Coordinate);
      const fallbackLinework = geometryFactory.createMultiLineString(fallbackLineStrings);
      return {
        geometryFactory,
        Coordinate,
        linework: fallbackLinework,
        unionedLinework: fallbackLinework,
        lineUnionStrategy: 'noded-fallback',
        lineUnionFallbackUsed: true,
        lineUnionError: error?.message || String(error),
        nodedSegmentCount: nodedSegments.length,
      };
    }
  }

  function resolveShapelyPolygonizeTolerance(options = {}) {
    const requestedTolerance = Number(options.tolerance);
    const baseTolerance = Number.isFinite(requestedTolerance) && requestedTolerance > 0
      ? requestedTolerance
      : LOOP_TOLERANCE * 8;
    const multiplier = Math.min(
      10,
      Math.max(0.1, Number(options.shapelyPolygonizeToleranceMultiplier) || 1)
    );
    return {
      multiplier,
      tolerance: Math.max(LOOP_TOLERANCE * 4, baseTolerance * multiplier),
    };
  }

  function runShapelyPolygonizePass({
    shapeRecord,
    sourceEntities,
    rawSegments,
    entitySegmentDescriptors,
    tolerance,
    multiplier,
    debugBase,
    extraDebug = {},
  }) {
    const jsts = global.jsts || null;
    const polygonizer = new jsts.operation.polygonize.Polygonizer();
    const lineUnion = unionJstsLinework(rawSegments, tolerance, jsts);
    const unionedLinework = lineUnion.unionedLinework;
    if (!unionedLinework || unionedLinework.isEmpty?.()) {
      const debug = {
        ...debugBase,
        ...extraDebug,
        stage: 'no-line-union',
        lineUnionStrategy: lineUnion.lineUnionStrategy || null,
        lineUnionFallbackUsed: !!lineUnion.lineUnionFallbackUsed,
        lineUnionError: lineUnion.lineUnionError || null,
        nodedSegmentCount: lineUnion.nodedSegmentCount ?? null,
      };
      debugDXF('Outer contour builder', debug);
      return {
        winner: null,
        ranked: [],
        debug,
        boundaryDropReasons: [],
        missingFaceConnectivity: [],
      };
    }

    polygonizer.add(unionedLinework);
    const polygonizerDiagnostics = buildPolygonizerDiagnosticsReport(polygonizer, entitySegmentDescriptors, tolerance * 8);
    const polygonCollection = polygonizer.getPolygons();
    const polygons = typeof polygonCollection?.toArray === 'function'
      ? polygonCollection.toArray()
      : Array.from(polygonCollection || []);
    if (!polygons.length) {
      const debug = {
        ...debugBase,
        ...extraDebug,
        stage: 'no-polygonized-faces',
        lineUnionStrategy: lineUnion.lineUnionStrategy || null,
        lineUnionFallbackUsed: !!lineUnion.lineUnionFallbackUsed,
        lineUnionError: lineUnion.lineUnionError || null,
        lineUnionType: typeof unionedLinework?.getGeometryType === 'function' ? unionedLinework.getGeometryType() : null,
        lineUnionComponentCount: typeof unionedLinework?.getNumGeometries === 'function' ? unionedLinework.getNumGeometries() : 0,
        nodedSegmentCount: lineUnion.nodedSegmentCount ?? null,
        polygonizedFaceCount: 0,
        polygonizedRootCount: 0,
        polygonizerDiagnostics,
      };
      debugDXF('Outer contour builder', debug);
      return {
        winner: null,
        ranked: [],
        debug,
        boundaryDropReasons: [],
        missingFaceConnectivity: [],
      };
    }

    const faceEntries = assignPolygonizedRootDepth(polygons.map((polygon, index) =>
      buildPolygonizedEntryFromJstsPolygon(polygon, index, 'shapely-polygonize', tolerance, shapeRecord?.entities || [])
    ).filter(Boolean));
    const unionGeometry = buildUnionGeometryEntriesFromJstsPolygons(polygons, shapeRecord, tolerance);
    const unionBoundary = {
      entries: [],
      boundarySegments: [],
      polygonizedFaces: [],
      rootEntries: faceEntries.filter(entry => (entry?.rootDepth || 0) === 0),
    };
    const seenEntryKeys = new Set();
    const entries = [];
    [...(unionGeometry.entries || []), ...faceEntries].forEach(entry => {
      const ring = entry?.candidate?.polygonPoints || [];
      const key = `${entry?.candidate?.unionGeometry ? 'u' : 'f'}|${ring.length}|${Math.round((entry?.area || 0) * 1000)}`;
      if (seenEntryKeys.has(key)) return;
      seenEntryKeys.add(key);
      entries.push(entry);
    });
    const dominantRootFaceEntities = buildDominantRootFaceContributorReport(
      polygons,
      faceEntries,
      entitySegmentDescriptors,
      tolerance * 8
    );
    entries.forEach(entry => {
      annotateCandidateDominantRootPreservation(
        entry,
        dominantRootFaceEntities,
        entitySegmentDescriptors,
        tolerance * 8
      );
      annotateUnionGeometryDominantPenalty(entry, tolerance * 8);
    });
    const ranked = entries.sort(polygonizedFaceRank);
    const rootCandidates = ranked.filter(entry => (entry.rootDepth || 0) === 0);
    const usableRoots = rootCandidates.length ? rootCandidates : ranked;
    const winner = usableRoots[0] || null;
    const provenance = summarizePolygonizedEntityProvenance({
      winner,
      polygonized: null,
      unionBoundary,
      entitySegmentDescriptors,
      tolerance: tolerance * 8,
    });
    const entityBoundaryStages = buildEntityBoundaryStageReport({
      entitySegmentDescriptors,
      rawSegments,
      unionedLinework,
      polygons,
      unionGeometry,
      winner,
      tolerance: tolerance * 8,
    });
    const polygonFaceMembership = buildPolygonFaceMembershipReport(polygons, faceEntries, entitySegmentDescriptors, tolerance * 8);
    const boundaryDropReasons = classifyEntityBoundaryDrops(entityBoundaryStages);
    const missingFaceConnectivity = buildMissingFaceConnectivityReport({
      sourceEntities,
      entitySegmentDescriptors,
      unionedLinework,
      polygons,
      boundaryDropReasons,
      tolerance: tolerance * 8,
    });

    const debug = {
      ...debugBase,
      ...extraDebug,
      stage: winner ? 'success-shapely-polygonize' : 'rejected-shapely-polygonize',
      chosenSource: winner?.candidate?.source || null,
      chosenFaceIndex: winner?.candidate?.faceIndex ?? null,
      chosenUnionGeometry: !!winner?.candidate?.unionGeometry,
      chosenUnionBoundary: !!winner?.candidate?.unionBoundary,
      lineUnionStrategy: lineUnion.lineUnionStrategy || null,
      lineUnionFallbackUsed: !!lineUnion.lineUnionFallbackUsed,
      lineUnionError: lineUnion.lineUnionError || null,
      lineUnionType: typeof unionedLinework?.getGeometryType === 'function' ? unionedLinework.getGeometryType() : null,
      lineUnionComponentCount: typeof unionedLinework?.getNumGeometries === 'function' ? unionedLinework.getNumGeometries() : 0,
      nodedSegmentCount: lineUnion.nodedSegmentCount ?? null,
      polygonizedFaceCount: faceEntries.length,
      polygonizedRootCount: faceEntries.filter(entry => (entry.rootDepth || 0) === 0).length,
      unionGeometryAvailable: unionGeometry.unionAvailable,
      unionGeometryError: unionGeometry.error || null,
      unionGeometryComponentCount: unionGeometry.componentCount || 0,
      unionGeometryRootCount: (unionGeometry.entries || []).filter(entry => (entry.rootDepth || 0) === 0).length,
      unionBoundarySegmentCount: unionBoundary.boundarySegments?.length || 0,
      unionBoundaryFaceCount: unionBoundary.polygonizedFaces?.length || 0,
      unionBoundaryRootCount: (unionBoundary.entries || []).filter(entry => (entry.rootDepth || 0) === 0).length,
      rankedCandidateCount: ranked.length,
      chosenContourEntities: provenance?.chosenContourEntities || [],
      droppedSharedEntities: provenance?.droppedSharedEntities || [],
      entityBoundaryStages,
      polygonFaceMembership,
      boundaryDropReasons,
      missingFaceConnectivity,
      polygonizerDiagnostics,
      chosenContourSegmentCount: provenance?.chosenContourSegmentCount ?? null,
      droppedSharedSegmentCount: provenance?.droppedSharedSegmentCount ?? null,
      candidates: ranked.slice(0, 10).map(entry => ({
        source: entry.candidate?.source || null,
        faceIndex: entry.candidate?.faceIndex ?? null,
        unionGeometry: !!entry.candidate?.unionGeometry,
        unionBoundary: !!entry.candidate?.unionBoundary,
        polygonPointCount: entry.candidate?.polygonPoints?.length || 0,
        rootDepth: entry.rootDepth ?? 0,
        area: entry.area ?? null,
        coverage: summarizeCoverageMetrics(entry.score),
      })),
    };
    debugDXF('Outer contour builder', debug);

    return {
      winner,
      ranked,
      debug,
      boundaryDropReasons,
      missingFaceConnectivity,
    };
  }

  function buildPolygonizedContourFromEntities(shapeRecord, options = {}) {
    const { tolerance, multiplier } = resolveShapelyPolygonizeTolerance(options);
    const sourceEntities = (shapeRecord?.entities || []).filter(isRenderableEntity);
    const entitySegmentDescriptors = buildEntitySegmentDescriptors(sourceEntities, tolerance);
    const rawSegments = sourceEntities.flatMap(entity => buildEntitySegments(entity, tolerance, entityToPathPoints));
    const jsts = global.jsts || null;
    const debugBase = {
      shapeId: shapeRecord?.id || null,
      stage: 'missing-segments',
      entityCount: sourceEntities.length,
      rawSegmentCount: rawSegments.length,
      tolerance,
      toleranceMultiplier: multiplier,
    };

    if (!rawSegments.length || !jsts?.geom?.GeometryFactory || !jsts?.operation?.polygonize?.Polygonizer) {
      const debug = {
        ...debugBase,
        stage: !rawSegments.length ? 'no-segments' : 'jsts-unavailable',
      };
      debugDXF('Outer contour builder', debug);
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'shapely-polygonize', builderDebug: debug, rankedCandidates: [] };
    }

    const polygonizer = new jsts.operation.polygonize.Polygonizer();
    const lineUnion = unionJstsLinework(rawSegments, tolerance, jsts);
    const unionedLinework = lineUnion.unionedLinework;
    if (!unionedLinework || unionedLinework.isEmpty?.()) {
      const debug = {
        ...debugBase,
        stage: 'no-line-union',
        lineUnionStrategy: lineUnion.lineUnionStrategy || null,
        lineUnionFallbackUsed: !!lineUnion.lineUnionFallbackUsed,
        lineUnionError: lineUnion.lineUnionError || null,
        nodedSegmentCount: lineUnion.nodedSegmentCount ?? null,
      };
      debugDXF('Outer contour builder', debug);
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'shapely-polygonize', builderDebug: debug, rankedCandidates: [] };
    }

    polygonizer.add(unionedLinework);
    const polygonCollection = polygonizer.getPolygons();
    const polygons = typeof polygonCollection?.toArray === 'function'
      ? polygonCollection.toArray()
      : Array.from(polygonCollection || []);
    if (!polygons.length) {
      const debug = {
        ...debugBase,
        stage: 'no-polygonized-faces',
        lineUnionStrategy: lineUnion.lineUnionStrategy || null,
        lineUnionFallbackUsed: !!lineUnion.lineUnionFallbackUsed,
        lineUnionError: lineUnion.lineUnionError || null,
        lineUnionType: typeof unionedLinework?.getGeometryType === 'function' ? unionedLinework.getGeometryType() : null,
        lineUnionComponentCount: typeof unionedLinework?.getNumGeometries === 'function' ? unionedLinework.getNumGeometries() : 0,
        nodedSegmentCount: lineUnion.nodedSegmentCount ?? null,
        polygonizedFaceCount: 0,
        polygonizedRootCount: 0,
      };
      // ('Outer contour builder', debug);
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'shapely-polygonize', builderDebug: debug, rankedCandidates: [] };
    }

    const faceEntries = assignPolygonizedRootDepth(polygons.map((polygon, index) =>
      buildPolygonizedEntryFromJstsPolygon(polygon, index, 'shapely-polygonize', tolerance, shapeRecord?.entities || [])
    ).filter(Boolean));
    const unionGeometry = buildUnionGeometryEntriesFromJstsPolygons(polygons, shapeRecord, tolerance);
    const unionBoundary = {
      entries: [],
      boundarySegments: [],
      polygonizedFaces: [],
      rootEntries: faceEntries.filter(entry => (entry?.rootDepth || 0) === 0),
    };
    const seenEntryKeys = new Set();
    const entries = [];
    [...(unionGeometry.entries || []), ...faceEntries].forEach(entry => {
      const ring = entry?.candidate?.polygonPoints || [];
      const key = `${entry?.candidate?.unionGeometry ? 'u' : 'f'}|${ring.length}|${Math.round((entry?.area || 0) * 1000)}`;
      if (seenEntryKeys.has(key)) return;
      seenEntryKeys.add(key);
      entries.push(entry);
    });
    const ranked = entries.sort(polygonizedFaceRank);
    const rootCandidates = ranked.filter(entry => (entry.rootDepth || 0) === 0);
    const usableRoots = rootCandidates.length ? rootCandidates : ranked;
    const winner = usableRoots[0] || null;
    const provenance = summarizePolygonizedEntityProvenance({
      winner,
      polygonized: null,
      unionBoundary,
      entitySegmentDescriptors,
      tolerance: tolerance * 8,
    });
    const entityBoundaryStages = buildEntityBoundaryStageReport({
      entitySegmentDescriptors,
      rawSegments,
      unionedLinework,
      polygons,
      unionGeometry,
      winner,
      tolerance: tolerance * 8,
    });
    const polygonFaceMembership = buildPolygonFaceMembershipReport(polygons, faceEntries, entitySegmentDescriptors, tolerance * 8);
    const boundaryDropReasons = classifyEntityBoundaryDrops(entityBoundaryStages);
    const missingFaceConnectivity = buildMissingFaceConnectivityReport({
      sourceEntities,
      entitySegmentDescriptors,
      unionedLinework,
      polygons,
      boundaryDropReasons,
      tolerance: tolerance * 8,
    });

    if (!winner) {
      return {
        polygonPoints: null,
        source: null,
        coverage: null,
        rankedCandidates: ranked,
        builderMode: 'shapely-polygonize',
        builderDebug: debug,
      };
    }

    return {
      ...winner.candidate,
      coverage: winner.score,
      rankedCandidates: ranked,
      builderMode: 'shapely-polygonize',
      builderDebug: debug,
    };
  }

  function buildPolygonizedContourFromEntitiesWithCurveRepair(shapeRecord, options = {}) {
    const { tolerance, multiplier } = resolveShapelyPolygonizeTolerance(options);
    const sourceEntities = (shapeRecord?.entities || []).filter(isRenderableEntity);
    const segmentRecords = buildEntitySegmentRecords(sourceEntities, tolerance);
    const normalizedCurveEndpoints = normalizeCurveEndpointsBeforeUnion(segmentRecords, tolerance);
    const entitySegmentDescriptors = buildEntitySegmentDescriptorsFromRecords(normalizedCurveEndpoints.records);
    const rawSegments = normalizedCurveEndpoints.records
      .map(record => [record.start, record.end])
      .filter(([start, end]) => dist(start, end) > EPS);
    const jsts = global.jsts || null;
    const debugBase = {
      shapeId: shapeRecord?.id || null,
      stage: 'missing-segments',
      entityCount: sourceEntities.length,
      rawSegmentCount: rawSegments.length,
      tolerance,
      toleranceMultiplier: multiplier,
    };

    if (!rawSegments.length || !jsts?.geom?.GeometryFactory || !jsts?.operation?.polygonize?.Polygonizer) {

      return { polygonPoints: null, source: null, coverage: null, builderMode: 'shapely-polygonize', builderDebug: debug, rankedCandidates: [] };
    }

    const primaryPass = runShapelyPolygonizePass({
      shapeRecord,
      sourceEntities,
      rawSegments,
      entitySegmentDescriptors,
      tolerance,
      multiplier,
      debugBase,
    });

    let chosenPass = primaryPass;
    let repairSummary = null;
    let promotedRepairSummary = null;

    const curveRepair = buildCurveEndpointRepair({
      sourceEntities,
      entitySegmentDescriptors,
      missingFaceConnectivity: primaryPass.missingFaceConnectivity,
      boundaryDropReasons: primaryPass.boundaryDropReasons,
      tolerance: tolerance * 8,
    });

    if (curveRepair.attempted && curveRepair.bridgeSegments.length) {
      repairSummary = curveRepair;
      const promotedRecordsResult = applyCurveRepairsToRecords(
        normalizedCurveEndpoints.records,
        curveRepair.repairs,
        tolerance * 8
      );
      if (promotedRecordsResult.appliedCount > 0) {
        const promotedDescriptors = buildEntitySegmentDescriptorsFromRecords(promotedRecordsResult.records);
        const promotedRawSegments = promotedRecordsResult.records
          .map(record => [record.start, record.end])
          .filter(([start, end]) => dist(start, end) > EPS);
        const promotedPass = runShapelyPolygonizePass({
          shapeRecord,
          sourceEntities,
          rawSegments: promotedRawSegments,
          entitySegmentDescriptors: promotedDescriptors,
          tolerance,
          multiplier,
          debugBase: {
            ...debugBase,
            rawSegmentCount: promotedRawSegments.length,
          },
          extraDebug: {
            curveEndpointRepairPromoted: true,
            curveEndpointRepairPromotedCount: promotedRecordsResult.appliedCount,
            curveEndpointRepairEntities: [...new Set(curveRepair.repairs.map(item => item.entityId))].slice(0, 6),
            curveEndpointRepairBridges: curveRepair.repairs.slice(0, 8),
          },
        });
        promotedRepairSummary = promotedRecordsResult;
        if (shouldPreferPolygonizedPass(primaryPass, promotedPass)) chosenPass = promotedPass;
      }

      const repairedPass = runShapelyPolygonizePass({
        shapeRecord,
        sourceEntities,
        rawSegments: [...rawSegments, ...curveRepair.bridgeSegments],
        entitySegmentDescriptors,
        tolerance,
        multiplier,
        debugBase: {
          ...debugBase,
          rawSegmentCount: rawSegments.length + curveRepair.bridgeSegments.length,
        },
        extraDebug: {
          curveEndpointRepairAttempted: true,
          curveEndpointRepairApplied: true,
          curveEndpointRepairLimit: curveRepair.repairLimit ?? null,
          curveEndpointBridgeCount: curveRepair.bridgeSegments.length,
          curveEndpointRepairEntities: [...new Set(curveRepair.repairs.map(item => item.entityId))].slice(0, 6),
          curveEndpointRepairBridges: curveRepair.repairs.slice(0, 8),
        },
      });
      if (shouldPreferPolygonizedPass(chosenPass, repairedPass)) chosenPass = repairedPass;
    }

    const finalDebug = {
      ...(chosenPass.debug || {}),
      curveEndpointSnapApplied: !!normalizedCurveEndpoints.applied,
      curveEndpointSnapCount: normalizedCurveEndpoints.snapCount || 0,
      curveEndpointSnapEntities: normalizedCurveEndpoints.snappedEntities || [],
      curveEndpointSnaps: normalizedCurveEndpoints.snaps || [],
      curveEndpointRepairAttempted: !!repairSummary,
      curveEndpointRepairApplied: !!repairSummary && chosenPass !== primaryPass,
      curveEndpointRepairPromotedApplied: !!promotedRepairSummary && !!(chosenPass.debug?.curveEndpointRepairPromoted),
      curveEndpointRepairPromotedCount: promotedRepairSummary?.appliedCount ?? 0,
      curveEndpointRepairLimit: repairSummary?.repairLimit ?? null,
      curveEndpointBridgeCount: repairSummary?.bridgeSegments?.length ?? 0,
      curveEndpointRepairEntities: repairSummary
        ? [...new Set(repairSummary.repairs.map(item => item.entityId))].slice(0, 6)
        : [],
      curveEndpointRepairBridges: repairSummary?.repairs?.slice(0, 8) || [],
    };

    if (!chosenPass.winner) {
      return {
        polygonPoints: null,
        source: null,
        coverage: null,
        rankedCandidates: chosenPass.ranked || [],
        builderMode: 'shapely-polygonize',
        builderDebug: finalDebug,
      };
    }

    return {
      ...chosenPass.winner.candidate,
      coverage: chosenPass.winner.score,
      rankedCandidates: chosenPass.ranked || [],
      builderMode: 'shapely-polygonize',
      builderDebug: finalDebug,
    };
  }

  function isRenderableEntity(entity) {
    return !!entity?.type && !['HATCH', 'TEXT', 'MTEXT', 'DIMENSION', 'INSERT', 'POINT'].includes(entity.type);
  }

  function isClosedArc(entity) {
    if (entity?.type !== 'ARC' || !entity.center || !Number.isFinite(entity.radius)) return false;
    let span = Number.isFinite(entity.angleLength)
      ? Math.abs(entity.angleLength)
      : Math.abs((entity.endAngle || 0) - (entity.startAngle || 0));
    while (span > TWO_PI) span -= TWO_PI;
    if (span <= 0) span += TWO_PI;
    return span >= TWO_PI - 1e-3;
  }

  function isClosedEntity(entity) {
    if (!entity?.type) return false;
    if (entity.type === 'CIRCLE') return true;
    if (entity.type === 'ARC') return isClosedArc(entity);
    if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.vertices?.length >= 3) return entity.closed !== false;
    if (entity.type === 'ELLIPSE') {
      const start = entity.startParameter ?? entity.startAngle ?? 0;
      const end = entity.endParameter ?? entity.endAngle ?? TWO_PI;
      return Math.abs(Math.abs(end - start) - TWO_PI) < 1e-4 || Math.abs((end - start) % TWO_PI) < 1e-4;
    }
    if (entity.type === 'SPLINE') return !!entity.closed;
    return false;
  }

  function sampleArcPoints(entity) {
    if (!entity?.center || !Number.isFinite(entity.radius)) return [];
    const start = Number.isFinite(entity.startAngle) ? entity.startAngle : 0;
    let end = Number.isFinite(entity.endAngle) ? entity.endAngle : start;
    while (end <= start) end += TWO_PI;
    const span = end - start;
    const steps = Math.max(12, Math.ceil(span / (Math.PI / 18)));
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angle = start + span * t;
      points.push({
        x: entity.center.x + entity.radius * Math.cos(angle),
        y: entity.center.y + entity.radius * Math.sin(angle),
      });
    }
    return points;
  }

  function entityToPathPoints(entity, forceOpen = false) {
    if (!entity?.type) return [];
    switch (entity.type) {
      case 'LINE': {
        const endpoints = getLineEndpoints(entity);
        return endpoints ? [endpoints.start, endpoints.end] : [];
      }
      case 'ARC':
        return isClosedArc(entity) && !forceOpen
          ? circleToPoints({ center: entity.center, radius: entity.radius })
          : sampleArcPoints(entity);
      case 'CIRCLE':
        return circleToPoints(entity);
      case 'LWPOLYLINE':
      case 'POLYLINE':
        return Array.isArray(entity.vertices)
          ? polylineVerticesToPoints(entity.vertices, forceOpen ? false : entity.closed !== false)
          : [];
      case 'ELLIPSE':
        return ellipseToPoints(entity, forceOpen ? false : isClosedEntity(entity));
      case 'SPLINE':
        return splineToPoints(entity);
      default:
        return [];
    }
  }

  function buildExtendedOuterContourFromParent(shapeRecord, options = {}) {
    const seedCandidate = buildParentSeedCandidate(shapeRecord, options);
    const tolerance = seedCandidate.tolerance;
    const parentContour = seedCandidate.parentContour;
    const seedPoints = seedCandidate.seedPoints;
    if (!seedPoints || seedPoints.length < 4) {
      const debug = {
        shapeId: shapeRecord?.id || null,
        seedContourId: parentContour?.id || null,
        stage: 'missing-seed',
        openEntityCount: shapeRecord?.openEntities?.length || 0,
      };
      debugDXF('Outer contour builder', debug);
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'parent-builder', builderDebug: debug };
    }

    const attachedEntities = findAttachedOpenEntities(shapeRecord, seedPoints, tolerance, entityToPathPoints, isRenderableEntity);
    if (!attachedEntities.length) {
      const coverage = seedCandidate.coverage;
      const debug = {
        shapeId: shapeRecord?.id || null,
        seedContourId: parentContour?.id || null,
        stage: 'no-attached-entities',
        openEntityCount: shapeRecord?.openEntities?.length || 0,
        openEntityIds: (shapeRecord?.openEntities || []).map(entity => entity.handle || entity.id || entity.type),
      };
      debugDXF('Outer contour builder', debug);
      const usableSeed = (coverage?.entityCoverage ?? 0) >= 0.9 &&
        (coverage?.pointCoverage ?? 0) >= 0.9 &&
        (coverage?.outerCoverage ?? 0) >= 0.5 &&
        (coverage?.outerMissCount ?? Infinity) === 0 &&
        (coverage?.selfIntersectionCount ?? Infinity) === 0 &&
        (coverage?.repeatedVertexCount ?? Infinity) === 0;
      if (!usableSeed) {
        return {
          polygonPoints: null,
          source: null,
          coverage: null,
          builderMode: 'parent-builder',
          builderDebug: {
            ...debug,
            stage: 'rejected-seed',
            rejectedCoverage: coverage,
          },
        };
      }
      return {
        ...seedCandidate.rankedEntry.candidate,
        coverage,
        builderMode: 'parent-builder',
        builderDebug: debug,
        rankedCandidates: [seedCandidate.rankedEntry],
      };
    }

    const graph = buildLocalGraph(seedPoints, attachedEntities, tolerance, entityToPathPoints);
    const graphEdgeCount = [...graph.adjacency.values()].reduce((sum, neighbors) => sum + neighbors.length, 0) / 2;
    const cycles = enumerateSimpleCycles(graph.nodes, graph.adjacency, graph.nodes.length > 40 ? 300 : 800);
    if (!cycles.length) {
      const debug = {
        shapeId: shapeRecord?.id || null,
        seedContourId: parentContour?.id || null,
        stage: 'no-cycles',
        attachedEntityCount: attachedEntities.length,
        graphNodeCount: graph.nodes.length,
        graphEdgeCount,
        rawCycleCount: 0,
      };
      debugDXF('Outer contour builder', debug);
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'parent-builder', builderDebug: debug };
    }

    const attachedIds = attachedEntities.map(entity => entity.handle || entity.id || entity.type);
    const ranked = rankParentBuilderCycles({
      cycles,
      shapeRecord,
      seedPoints,
      tolerance,
      parentContourId: parentContour.id || null,
      attachedIds,
      scorePolygonCoverage,
    });

    if (!ranked.length) {
      const debug = {
        shapeId: shapeRecord?.id || null,
        seedContourId: parentContour.id || null,
        stage: 'no-ranked-cycles',
        attachedEntityCount: attachedIds.length,
        graphNodeCount: graph.nodes.length,
        graphEdgeCount,
        rawCycleCount: cycles.length,
        cycleCount: cycles.length,
      };
      debugDXF('Outer contour builder', debug);
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'parent-builder', builderDebug: debug };
    }

    const debug = {
      shapeId: shapeRecord?.id || null,
      seedContourId: parentContour.id || null,
      stage: 'success',
      attachedEntityCount: attachedIds.length,
      graphNodeCount: graph.nodes.length,
      graphEdgeCount,
      rawCycleCount: cycles.length,
      cycleCount: ranked.length,
      chosenSource: ranked[0]?.candidate?.source || null,
      candidates: ranked.slice(0, 10).map(entry => ({
        source: entry.candidate.source,
        polygonPointCount: entry.candidate.polygonPoints?.length || 0,
        areaGain: entry.areaGain,
        coverage: summarizeCoverageMetrics(entry.score),
      })),
    };
    debugDXF('Outer contour builder', debug);

    return {
      ...ranked[0].candidate,
      coverage: ranked[0].score,
      rankedCandidates: seedCandidate.rankedEntry ? [...ranked, seedCandidate.rankedEntry] : ranked,
      builderMode: 'parent-builder',
      builderDebug: debug,
    };
  }

  function hasMeaningfulBuilderOutput(result) {
    if (!result) return false;
    if (Array.isArray(result.polygonPoints) && result.polygonPoints.length >= 4) return true;
    return Array.isArray(result.rankedCandidates) && result.rankedCandidates.length > 0;
  }

  function compareCoverageEntries(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    const aScore = a.score || {};
    const bScore = b.score || {};
    if ((aScore.outerMissCount || 0) !== (bScore.outerMissCount || 0)) return (aScore.outerMissCount || 0) - (bScore.outerMissCount || 0);
    if (Math.abs((bScore.outerCoverage || 0) - (aScore.outerCoverage || 0)) > 1e-6) return (bScore.outerCoverage || 0) - (aScore.outerCoverage || 0);
    if (Math.abs((bScore.entityCoverage || 0) - (aScore.entityCoverage || 0)) > 1e-6) return (bScore.entityCoverage || 0) - (aScore.entityCoverage || 0);
    if (Math.abs((bScore.pointCoverage || 0) - (aScore.pointCoverage || 0)) > 1e-6) return (bScore.pointCoverage || 0) - (aScore.pointCoverage || 0);
    if (Math.abs((bScore.areaCoverage || 0) - (aScore.areaCoverage || 0)) > 1e-6) return (bScore.areaCoverage || 0) - (aScore.areaCoverage || 0);
    if (Math.abs((bScore.score || 0) - (aScore.score || 0)) > 1e-6) return (bScore.score || 0) - (aScore.score || 0);
    return (b.area || 0) - (a.area || 0);
  }

  function chooseBetterBuilderResult(left, right) {
    const leftUsable = hasMeaningfulBuilderOutput(left);
    const rightUsable = hasMeaningfulBuilderOutput(right);
    if (!leftUsable) return right;
    if (!rightUsable) return left;

    const leftEntry = {
      score: left.coverage || null,
      area: Math.abs(polygonSignedArea((left.polygonPoints || []).slice(0, -1))),
    };
    const rightEntry = {
      score: right.coverage || null,
      area: Math.abs(polygonSignedArea((right.polygonPoints || []).slice(0, -1))),
    };
    return compareCoverageEntries(leftEntry, rightEntry) <= 0 ? left : right;
  }

  function compareMakerJsChainEntries(a, b) {
    const aScore = a.score || {};
    const bScore = b.score || {};
    if ((aScore.outerMissCount || 0) !== (bScore.outerMissCount || 0)) return (aScore.outerMissCount || 0) - (bScore.outerMissCount || 0);
    if ((aScore.entityCoverage || 0) !== (bScore.entityCoverage || 0)) return (bScore.entityCoverage || 0) - (aScore.entityCoverage || 0);
    if (Math.abs((aScore.score || 0) - (bScore.score || 0)) <= 0.05) {
      if ((a.mergeCount || 0) !== (b.mergeCount || 0)) return (a.mergeCount || 0) - (b.mergeCount || 0);
      if (Math.abs((a.closureGap || 0) - (b.closureGap || 0)) > EPS) return (a.closureGap || 0) - (b.closureGap || 0);
    }
    if ((aScore.pointCoverage || 0) !== (bScore.pointCoverage || 0)) return (bScore.pointCoverage || 0) - (aScore.pointCoverage || 0);
    if ((aScore.areaCoverage || 0) !== (bScore.areaCoverage || 0)) return (bScore.areaCoverage || 0) - (aScore.areaCoverage || 0);
    if ((aScore.score || 0) !== (bScore.score || 0)) return (bScore.score || 0) - (aScore.score || 0);
    return (b.area || 0) - (a.area || 0);
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

    console.log("makerJsOptions", makerJsOptions)

    const outerContour = typeof getOuterNestingContour === 'function'
      ? getOuterNestingContour(dxfData, makerJsOptions)
      : null;

    const chainBuild = typeof buildMakerJsChains === 'function'
      ? buildMakerJsChains(
          dxfData,
          makerJsOptions
        )
      : { available: false, candidates: [], pathCount: 0 };

    const debugBase = {
      shapeId: shapeRecord?.id || null,
      stage: 'makerjs-unavailable',
      gapTolerance,
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
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'makerjs-chains', builderDebug: debug, rankedCandidates: [] };
    }

    if (chainBuild.error) {
      const debug = {
        ...debugBase,
        stage: 'makerjs-chain-error',
        error: chainBuild.error,
      };
      debugDXF('Outer contour builder', debug);
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'makerjs-chains', builderDebug: debug, rankedCandidates: [] };
    }

    const ranked = (chainBuild.candidates || [])
      .map(candidate => {
        const coverage = scorePolygonCoverage({ polygonPoints: candidate.polygonPoints }, shapeRecord.entities || []);
        if (!coverage) return null;
        return {
          candidate: {
            polygonPoints: candidate.polygonPoints,
            source: 'makerjs-chains',
            tolerance,
            gapTolerance,
            area: candidate.area,
            chainIndex: candidate.chainIndex,
            chainIndices: candidate.chainIndices || [],
            mergeCount: candidate.mergeCount || 0,
            closureGap: candidate.closureGap ?? null,
            chainSource: candidate.source || null,
          },
          score: coverage,
          area: candidate.area,
          chainIndex: candidate.chainIndex,
          mergeCount: candidate.mergeCount || 0,
          closureGap: candidate.closureGap ?? null,
        };
      })
      .filter(Boolean)
      .sort(compareMakerJsChainEntries);

    const outerCoverage = outerContour?.polygonPoints
      ? scorePolygonCoverage({ polygonPoints: outerContour.polygonPoints }, shapeRecord.entities || [])
      : null;
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
          },
          score: outerCoverage,
          area: outerContour.area,
          chainIndex: null,
          mergeCount: Math.max(0, (outerContour.chainIndices || []).length - 1),
          closureGap: outerContour.closureGap ?? null,
        }
      : (ranked[0] || null);
    const debug = {
      ...debugBase,
      stage: winner ? 'success-makerjs-chains' : 'no-makerjs-chain-candidates',
      chainCount: chainBuild.chains?.length || 0,
      closedChainCount: (chainBuild.chains || []).filter(entry => entry.endless).length,
      openChainCount: (chainBuild.chains || []).filter(entry => !entry.endless).length,
      candidateCount: ranked.length,
      directOuterContourApplied: Boolean(outerContour?.polygonPoints),
      chosenSource: winner?.candidate?.source || null,
      chosenChainIndex: winner?.candidate?.chainIndex ?? null,
      candidates: ranked.slice(0, 10).map(entry => ({
        source: entry.candidate?.source || null,
        chainSource: entry.candidate?.chainSource || null,
        chainIndex: entry.candidate?.chainIndex ?? null,
        chainIndices: (entry.candidate?.chainIndices || []).slice(0, 8),
        mergeCount: entry.mergeCount ?? 0,
        closureGap: entry.closureGap ?? null,
        polygonPointCount: entry.candidate?.polygonPoints?.length || 0,
        area: entry.area ?? null,
        coverage: summarizeCoverageMetrics(entry.score),
      })),
    };
    debugDXF('Outer contour builder', debug);

    if (!winner) {
      return {
        polygonPoints: null,
        source: null,
        coverage: null,
        rankedCandidates: ranked,
        builderMode: 'makerjs-chains',
        builderDebug: debug,
      };
    }

    return {
      ...winner.candidate,
      coverage: winner.score || null,
      rankedCandidates: ranked,
      builderMode: 'makerjs-chains',
      builderDebug: debug,
    };
  }

  function detectNestingPolygon(input, options = {}) {
    if (Array.isArray(input)) return { polygonPoints: null, source: null, coverage: null, builderMode: 'array-input-unsupported', builderDebug: null };
    const shapeRecord = input;
    if (!shapeRecord?.entities?.length) return { polygonPoints: null, source: null, coverage: null, builderMode: 'missing-shape-record', builderDebug: null };

    const forcedSource = normalizeRequestedContourSource(options.contourMethod);
    if (forcedSource === 'parent-seed') {
      const seedCandidate = buildParentSeedCandidate(shapeRecord, options);
      if (seedCandidate.rankedEntry) {
        return withForcedBuilderMetadata({
          ...seedCandidate.rankedEntry.candidate,
          coverage: seedCandidate.rankedEntry.score,
          rankedCandidates: [seedCandidate.rankedEntry],
          builderMode: 'parent-builder',
          builderDebug: {
            shapeId: shapeRecord?.id || null,
            seedContourId: seedCandidate.parentContour?.id || null,
            stage: 'success-parent-seed',
            chosenSource: 'parent-seed',
          },
        }, forcedSource, true);
      }
      return withForcedBuilderMetadata({
        polygonPoints: null,
        source: null,
        coverage: null,
        rankedCandidates: [],
        builderMode: 'parent-builder',
        builderDebug: {
          shapeId: shapeRecord?.id || null,
          stage: 'forced-source-unavailable',
        },
      }, forcedSource, false);
    }

    if (forcedSource === 'parent-extended') {
      const parentBuilt = buildExtendedOuterContourFromParent(shapeRecord, options);
      const forcedParent = selectForcedResultBySource(parentBuilt, forcedSource);
      if (forcedParent) return withForcedBuilderMetadata(forcedParent, forcedSource, true);
      return withForcedBuilderMetadata({
        ...parentBuilt,
        polygonPoints: null,
        source: null,
        coverage: null,
      }, forcedSource, false);
    }

    if (forcedSource === 'makerjs-chains') {
      const makerBuilt = buildMakerJsChainContour(shapeRecord, options);
      const forcedMaker = selectForcedResultBySource(makerBuilt, forcedSource);
      if (forcedMaker) return withForcedBuilderMetadata(forcedMaker, forcedSource, true);
      return withForcedBuilderMetadata({
        ...makerBuilt,
        polygonPoints: null,
        source: null,
        coverage: null,
      }, forcedSource, false);
    }

    if (forcedSource === 'shapely-polygonize') {
      const polygonized = buildPolygonizedContourFromEntitiesWithCurveRepair(shapeRecord, options);
      const forcedPolygonized = selectForcedResultBySource(polygonized, forcedSource);
      if (forcedPolygonized) return withForcedBuilderMetadata(forcedPolygonized, forcedSource, true);
      return withForcedBuilderMetadata({
        ...polygonized,
        polygonPoints: null,
        source: null,
        coverage: null,
      }, forcedSource, false);
    }

    const parentBuilt = buildExtendedOuterContourFromParent(shapeRecord, options);
    if (hasMeaningfulBuilderOutput(parentBuilt)) return parentBuilt;

    const makerBuilt = buildMakerJsChainContour(shapeRecord, options);
    const polygonized = buildPolygonizedContourFromEntitiesWithCurveRepair(shapeRecord, options);
    return chooseBetterBuilderResult(makerBuilt, polygonized) || makerBuilt || polygonized || parentBuilt;
  }

  global.NestDxfNestingPolygonService = {
    tryPolygonizeWithTolerance: () => null,
    scorePolygonCoverage,
    findBestPolygonizedCandidate: () => null,
    buildConcaveHullFallback: () => null,
    buildExtendedOuterContourFromParent,
    buildMakerJsChainContour,
    buildPolygonizedContourFromEntities,
    buildPolygonizedContourFromEntitiesWithCurveRepair,
    detectNestingPolygon,
  };
})(window);
