(function attachNestDxfOuterContourBuilder(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };
  const graphUtils = global.NestDxfNestingGraphUtils || {};
  const cycleRanking = global.NestDxfNestingCycleRanking || {};
  const openBuilderHelpers = global.NestDxfOpenBuilderHelpers || {};

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
  } = geometry;

  const {
    ringBBox,
    segmentsIntersect,
    enumerateSimpleCycles,
    splitSegmentsAtIntersections,
    buildGraphFromSegments,
  } = graphUtils;

  const {
    extractOutermostSimpleLoop,
  } = cycleRanking;

  const {
    findAttachedOpenEntities,
    buildLocalGraph,
    rankParentBuilderCycles,
    buildOpenGraphFromEntities,
    buildOpenGraphFromShape,
    buildExtendedOpenGraphFromShape,
    rankOpenBuilderCycles,
  } = openBuilderHelpers;

  function scorePolygonCoverage(polygon, entities) {
    const ring = closePointRing(polygon?.polygonPoints || polygon || []);
    if (ring.length < 4) return null;

    let supportedEntityCount = 0;
    let unsupportedEntityCount = 0;
    const unsupportedEntityIds = [];
    const unsupportedEntities = [];
    let insidePointCount = 0;
    let outsidePointCount = 0;
    let bbox = null;
    let totalEntityBBoxArea = 0;

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
      const supportedProbeCount = probes.filter(point => containsPointInRing(ring, point, LOOP_TOLERANCE * 16)).length;
      const supportRatio = probes.length ? (supportedProbeCount / probes.length) : 0;
      const supported = probes.length
        ? (supportRatio >= 0.5 || (supportedProbeCount >= 2 && supportRatio >= 0.34))
        : false;
      if (supported) supportedEntityCount += 1;
      else {
        unsupportedEntityCount += 1;
        const debugId = entityDebugId(entity, index);
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

      probes.forEach(point => {
        if (containsPointInRing(ring, point)) insidePointCount += 1;
        else outsidePointCount += 1;
      });

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
      supportedAreaRatio: coverage.supportedAreaRatio ?? null,
      compactness: coverage.compactness ?? null,
      selfIntersectionCount: coverage.selfIntersectionCount ?? null,
      repeatedVertexCount: coverage.repeatedVertexCount ?? null,
      score: coverage.score ?? null,
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
    const tolerance = Math.max(LOOP_TOLERANCE * 4, options.tolerance || LOOP_TOLERANCE * 8);
    const parentContour = shapeRecord?.parentContour || (shapeRecord?.peerOuters?.length === 1 ? shapeRecord.peerOuters[0] : null);
    const seedPoints = Array.isArray(parentContour?.points) && parentContour.points.length >= 4
      ? extractOutermostSimpleLoop(parentContour.points, tolerance) || closePointRing(normalizeWindingCCW(parentContour.points))
      : null;
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
      const coverage = scorePolygonCoverage({ polygonPoints: seedPoints }, shapeRecord.entities || []);
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
        polygonPoints: seedPoints,
        source: 'parent-seed',
        coverage,
        builderMode: 'parent-builder',
        builderDebug: debug,
        rankedCandidates: [{
          candidate: {
            polygonPoints: seedPoints,
            source: 'parent-seed',
            tolerance,
            seedContourId: parentContour?.id || null,
            attachedEntityIds: [],
            area: Math.abs(polygonSignedArea(seedPoints.slice(0, -1))),
          },
          score: coverage,
          enclosesSeed: true,
          areaGain: 1,
        }],
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
      rankedCandidates: ranked,
      builderMode: 'parent-builder',
      builderDebug: debug,
    };
  }

  function buildOuterContourFromOpenEntities(shapeRecord, options = {}) {
    const tolerance = Math.max(LOOP_TOLERANCE * 4, options.tolerance || LOOP_TOLERANCE * 8);
    const detectRasterShapes = global.NestDxfRasterEnvelopeService?.detectRasterShapes || (() => []);
    const openEntities = (shapeRecord?.openEntities || []).filter(isRenderableEntity);
    const openEntitySet = new Set(openEntities);
    const graphData = buildOpenGraphFromShape(
      shapeRecord,
      tolerance,
      entityToPathPoints,
      isRenderableEntity,
      splitSegmentsAtIntersections,
      buildGraphFromSegments
    );
    const graph = graphData.graph || { nodes: [], adjacency: new Map() };
    const graphEdgeCount = [...graph.adjacency.values()].reduce((sum, neighbors) => sum + neighbors.length, 0) / 2;
    const debugBase = {
      shapeId: shapeRecord?.id || null,
      stage: 'missing-seed',
      entityCount: graphData.entities?.length || 0,
      rawSegmentCount: graphData.segments?.length || 0,
      snappedSegmentCount: graphData.snappedSegments?.length || 0,
      repairedSegmentCount: graphData.repairedSegments?.length || 0,
      endpointSegmentRepairCount: graphData.endpointSegmentRepairCount || 0,
      bridgeSegmentCount: graphData.bridgeSegments?.length || 0,
      endpointBridgeCount: graphData.endpointBridgeCount || 0,
      splitSegmentCount: graphData.splitSegments?.length || 0,
      graphNodeCount: graph.nodes.length,
      graphEdgeCount,
    };

    if (!graphData.segments?.length) {
      const debug = { ...debugBase, stage: 'no-owned-segments' };
      debugDXF('Outer contour builder', debug);
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'open-builder', builderDebug: debug };
    }

    const cycles = enumerateSimpleCycles(graph.nodes, graph.adjacency, graph.nodes.length > 50 ? 400 : 900);
    const ranked = rankOpenBuilderCycles({
      cycles,
      bbox: graphData.bbox,
      shapeRecord,
      tolerance,
      scorePolygonCoverage,
    });
    const tracedRasterShapes = detectRasterShapes(shapeRecord.entities || [], {
      sampleStep: Math.max(0.5, tolerance * 18),
      boundaryMode: 'trace',
    });

    const subgroupGraphs = ((!cycles.length || !ranked.length) && openEntities.length > 1)
      ? (() => {
        const seenGroups = new Set();
          const subgroupSeeds = [
            ...detectRasterShapes(openEntities, {
              sampleStep: Math.max(0.5, tolerance * 18),
              boundaryMode: 'trace',
            }).map(candidate => ({
              source: 'open-raster',
              entities: candidate.entities || [],
            })),
            ...tracedRasterShapes.map(candidate => ({
              source: 'shape-raster',
              entities: (candidate.entities || []).filter(entity => openEntitySet.has(entity)),
            })),
          ];

          return subgroupSeeds
            .filter(candidate => Array.isArray(candidate.entities) && candidate.entities.length > 1)
            .filter(candidate => candidate.entities.length < openEntities.length)
            .map((candidate, subgroupIndex) => {
              const entityKey = candidate.entities
                .map(entity => entity?.handle || entity?.id || `${entity?.type || 'entity'}:${openEntities.indexOf(entity)}`)
                .sort()
                .join('|');
              if (!entityKey || seenGroups.has(entityKey)) return null;
              seenGroups.add(entityKey);

              const subgroupGraphData = buildOpenGraphFromEntities(
                candidate.entities,
                tolerance,
                entityToPathPoints,
                isRenderableEntity,
                splitSegmentsAtIntersections,
                buildGraphFromSegments
              );
              const subgroupGraph = subgroupGraphData.graph || { nodes: [], adjacency: new Map() };
              const subgroupCycles = enumerateSimpleCycles(
                subgroupGraph.nodes,
                subgroupGraph.adjacency,
                subgroupGraph.nodes.length > 50 ? 400 : 900
              );
              const subgroupRanked = rankOpenBuilderCycles({
                cycles: subgroupCycles,
                bbox: subgroupGraphData.bbox,
                shapeRecord,
                tolerance,
                scorePolygonCoverage,
              }).map(entry => ({
                ...entry,
                candidate: {
                  ...entry.candidate,
                  subgroupIndex,
                  subgroupEntityCount: subgroupGraphData.entities?.length || 0,
                  subgroupSource: candidate.source,
                },
              }));

              return {
                subgroupIndex,
                source: candidate.source,
                graphData: subgroupGraphData,
                cycles: subgroupCycles,
                ranked: subgroupRanked,
              };
            })
            .filter(Boolean);
        })()
      : [];
    const subgroupRanked = subgroupGraphs.flatMap(entry => entry.ranked);

    const extendedGraphData = buildExtendedOpenGraphFromShape(
      shapeRecord,
      graphData,
      tolerance,
      splitSegmentsAtIntersections,
      buildGraphFromSegments
    );
    const extendedGraph = extendedGraphData.extendedGraph || { nodes: [], adjacency: new Map() };
    const extendedGraphEdgeCount = [...extendedGraph.adjacency.values()].reduce((sum, neighbors) => sum + neighbors.length, 0) / 2;
    const extendedCycles = extendedGraphData.childContourSegments?.length
      ? enumerateSimpleCycles(extendedGraph.nodes, extendedGraph.adjacency, extendedGraph.nodes.length > 60 ? 500 : 1000)
      : [];
    const extendedRanked = rankOpenBuilderCycles({
      cycles: extendedCycles,
      bbox: extendedGraphData.extendedBBox || graphData.bbox,
      shapeRecord,
      tolerance,
      scorePolygonCoverage,
    }).map(entry => ({
      ...entry,
      candidate: {
        ...entry.candidate,
        source: 'open-builder-extended',
        childContourIds: (extendedGraphData.boundaryChildContours || []).map(contour => contour.id),
      },
    }));

    const allRanked = [...ranked, ...subgroupRanked, ...extendedRanked].sort((a, b) => {
      if ((a.score?.outerMissCount || 0) !== (b.score?.outerMissCount || 0)) return (a.score?.outerMissCount || 0) - (b.score?.outerMissCount || 0);
      if (Math.abs((b.bboxCoverage || 0) - (a.bboxCoverage || 0)) > 1e-6) return (b.bboxCoverage || 0) - (a.bboxCoverage || 0);
      if (Math.abs((b.area || 0) - (a.area || 0)) > 1e-6) return (b.area || 0) - (a.area || 0);
      if (Math.abs((b.score?.outerCoverage || 0) - (a.score?.outerCoverage || 0)) > 1e-6) return (b.score?.outerCoverage || 0) - (a.score?.outerCoverage || 0);
      if (Math.abs((b.score?.pointCoverage || 0) - (a.score?.pointCoverage || 0)) > 1e-6) return (b.score?.pointCoverage || 0) - (a.score?.pointCoverage || 0);
      return (b.score?.score || 0) - (a.score?.score || 0);
    });

    if (!allRanked.length) {
      const debug = {
        ...debugBase,
        stage: cycles.length ? 'no-ranked-open-cycles' : 'no-open-cycles',
        rawCycleCount: cycles.length,
        boundaryChildContourCount: extendedGraphData.boundaryChildContours?.length || 0,
        childContourSegmentCount: extendedGraphData.childContourSegments?.length || 0,
        extendedGraphNodeCount: extendedGraph.nodes.length,
        extendedGraphEdgeCount,
        extendedRawCycleCount: extendedCycles.length,
        subgroupGraphCount: subgroupGraphs.length,
        subgroupRawCycleCount: subgroupGraphs.reduce((sum, entry) => sum + (entry.cycles?.length || 0), 0),
      };
      debugDXF('Outer contour builder', debug);
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'open-builder', builderDebug: debug };
    }

    const usable = allRanked.filter(entry => {
      const coverage = entry.score || {};
      return (coverage.entityCoverage ?? 0) >= 0.9 &&
        (coverage.pointCoverage ?? 0) >= 0.8 &&
        (coverage.outerCoverage ?? 0) >= 0.85 &&
        (coverage.outerMissCount ?? Infinity) === 0 &&
        (coverage.selfIntersectionCount ?? Infinity) === 0 &&
        (coverage.repeatedVertexCount ?? Infinity) === 0;
    });
    const winner = usable[0] || null;
    const debug = {
      ...debugBase,
      stage: winner?.candidate?.source === 'open-builder-extended'
        ? 'success-open-builder-extended'
        : winner?.candidate?.subgroupIndex != null
          ? 'success-open-builder-subgroup'
        : winner
          ? 'success-open-builder'
          : 'rejected-open-cycles',
      rawCycleCount: cycles.length,
      rankedCycleCount: allRanked.length,
      boundaryChildContourCount: extendedGraphData.boundaryChildContours?.length || 0,
      childContourSegmentCount: extendedGraphData.childContourSegments?.length || 0,
      extendedGraphNodeCount: extendedGraph.nodes.length,
      extendedGraphEdgeCount,
      extendedRawCycleCount: extendedCycles.length,
      chosenSource: winner?.candidate?.source || null,
      subgroupGraphCount: subgroupGraphs.length,
      subgroupRawCycleCount: subgroupGraphs.reduce((sum, entry) => sum + (entry.cycles?.length || 0), 0),
      chosenSubgroupIndex: winner?.candidate?.subgroupIndex ?? null,
      chosenSubgroupEntityCount: winner?.candidate?.subgroupEntityCount ?? null,
      chosenSubgroupSource: winner?.candidate?.subgroupSource ?? null,
      candidates: allRanked.slice(0, 10).map(entry => ({
        source: entry.candidate?.source || null,
        polygonPointCount: entry.candidate?.polygonPoints?.length || 0,
        subgroupIndex: entry.candidate?.subgroupIndex ?? null,
        subgroupEntityCount: entry.candidate?.subgroupEntityCount ?? null,
        subgroupSource: entry.candidate?.subgroupSource ?? null,
        bboxCoverage: entry.bboxCoverage,
        coverage: summarizeCoverageMetrics(entry.score),
      })),
    };
    debugDXF('Open builder ranking', {
      shapeId: shapeRecord?.id || null,
      stage: debug.stage,
      rawCycleCount: cycles.length,
      extendedRawCycleCount: extendedCycles.length,
      subgroupRawCycleCount: subgroupGraphs.reduce((sum, entry) => sum + (entry.cycles?.length || 0), 0),
      rankedCycleCount: allRanked.length,
      chosenSource: winner?.candidate?.source || null,
      chosenPolygonPointCount: winner?.candidate?.polygonPoints?.length || 0,
      chosenSubgroupIndex: winner?.candidate?.subgroupIndex ?? null,
      chosenSubgroupEntityCount: winner?.candidate?.subgroupEntityCount ?? null,
      chosenSubgroupSource: winner?.candidate?.subgroupSource ?? null,
      candidates: allRanked.slice(0, 8).map((entry, index) => ({
        rank: index + 1,
        source: entry.candidate?.source || null,
        polygonPointCount: entry.candidate?.polygonPoints?.length || 0,
        subgroupIndex: entry.candidate?.subgroupIndex ?? null,
        subgroupEntityCount: entry.candidate?.subgroupEntityCount ?? null,
        subgroupSource: entry.candidate?.subgroupSource ?? null,
        bboxCoverage: entry.bboxCoverage ?? null,
        area: entry.area ?? null,
        pointCoverage: entry.score?.pointCoverage ?? null,
        entityCoverage: entry.score?.entityCoverage ?? null,
        areaCoverage: entry.score?.areaCoverage ?? null,
        outerCoverage: entry.score?.outerCoverage ?? null,
        outerMissCount: entry.score?.outerMissCount ?? null,
        perimeter: entry.score?.perimeter ?? null,
        compactness: entry.score?.compactness ?? null,
        score: entry.score?.score ?? null,
      })),
    });
    debugDXF('Outer contour builder', debug);

    if (!winner) {
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'open-builder', builderDebug: debug, rankedCandidates: allRanked };
    }

    return {
      ...winner.candidate,
      coverage: winner.score,
      rankedCandidates: allRanked,
      builderMode: 'open-builder',
      builderDebug: debug,
    };
  }

  function shouldTryOpenBuilderAfterParent(parentBuilt, entityCount) {
    if (!parentBuilt) return true;

    const stage = parentBuilt.builderDebug?.stage || null;
    if (stage === 'missing-seed') return true;

    const polygonPoints = Array.isArray(parentBuilt.polygonPoints) ? parentBuilt.polygonPoints : [];
    const coverage = parentBuilt.coverage || null;
    if (polygonPoints.length < 4 || !coverage) return true;

    if ((coverage.selfIntersectionCount ?? 0) > 0 || (coverage.repeatedVertexCount ?? 0) > 0) return true;

    const maxUnsupported = Math.max(2, Math.floor((entityCount || 0) * 0.15));
    return (coverage.entityCoverage ?? 0) < 0.85 ||
      (coverage.pointCoverage ?? 0) < 0.75 ||
      (coverage.outerCoverage ?? 0) < 0.7 ||
      (coverage.outerMissCount ?? 0) > maxUnsupported ||
      (coverage.unsupportedEntityCount ?? 0) > maxUnsupported ||
      (coverage.supportedAreaRatio ?? 0) < 0.45 ||
      (coverage.score ?? -Infinity) < 0.45;
  }

  function hasMeaningfulBuilderOutput(result) {
    if (!result) return false;
    if (Array.isArray(result.polygonPoints) && result.polygonPoints.length >= 4) return true;
    return Array.isArray(result.rankedCandidates) && result.rankedCandidates.length > 0;
  }

  function detectNestingPolygon(input, options = {}) {
    if (Array.isArray(input)) return { polygonPoints: null, source: null, coverage: null, builderMode: 'array-input-unsupported', builderDebug: null };
    const shapeRecord = input;
    if (!shapeRecord?.entities?.length) return { polygonPoints: null, source: null, coverage: null, builderMode: 'missing-shape-record', builderDebug: null };

    const parentBuilt = buildExtendedOuterContourFromParent(shapeRecord, options);
    if (!shouldTryOpenBuilderAfterParent(parentBuilt, shapeRecord.entities.length || 0)) return parentBuilt;

    const openBuilt = buildOuterContourFromOpenEntities(shapeRecord, options);
    if (hasMeaningfulBuilderOutput(openBuilt)) return openBuilt;
    return parentBuilt;
  }

  global.NestDxfNestingPolygonService = {
    tryPolygonizeWithTolerance: () => null,
    scorePolygonCoverage,
    findBestPolygonizedCandidate: () => null,
    buildConcaveHullFallback: () => null,
    buildExtendedOuterContourFromParent,
    buildOuterContourFromOpenEntities,
    detectNestingPolygon,
  };
})(window);
