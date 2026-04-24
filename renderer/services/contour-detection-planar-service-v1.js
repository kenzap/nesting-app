(function attachNestDxfContourDetectionPlanarService(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const Flatten = global.Flatten || global['@flatten-js/core'] || null;
  const svg = global.NestDxfSvg || {};
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };
  const contourHelpers = global.NestDxfContourHelpers || {};
  const electronAPI = global.electronAPI || {};

  const {
    emptyContourResult = (builderMode, builderDebug = null) => ({
      polygonPoints: null,
      source: null,
      coverage: null,
      rankedCandidates: [],
      builderMode,
      builderDebug,
    }),
    computeEntitiesBBox = () => null,
    bboxSpan = () => 0,
    compareContourCandidatesByGeometry = () => 0,
  } = contourHelpers;

  if (!geometry || typeof electronAPI.toPlanarGraph !== 'function' || typeof electronAPI.discoverPlanarFaces !== 'function') {
    global.NestDxfContourDetectionPlanarService = {
      buildPlanarContour() {
        return emptyContourResult('missing-planar-deps');
      },
    };
    return;
  }

  const {
    EPS,
    LOOP_TOLERANCE,
    dist,
    samePoint,
    pointKey,
    getLineEndpoints,
    getArcEndpoints,
    bulgeToPoints,
    polylineVerticesToPoints,
    ellipseToPoints,
    splineToPoints,
    circleToPoints,
    closePointRing,
    polygonSignedArea,
    normalizedClosedPointSignature,
  } = geometry;
  const {
    pathFromPoints = () => '',
    entityToSVGStr = () => '',
  } = svg;

  const DEBUG_COLORS = ['#5eead4', '#f59e0b', '#60a5fa', '#f472b6', '#22c55e', '#f97316', '#a78bfa', '#ef4444'];

  function safeNumber(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
  }

  function safeName(value, fallback = 'planar-debug') {
    return String(value || fallback)
      .replace(/[^a-z0-9-_]+/gi, '-')
      .replace(/^-+|-+$/g, '') || fallback;
  }

  function bboxFromNodes(nodes) {
    if (!Array.isArray(nodes) || !nodes.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    nodes.forEach(([x, y]) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    });
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  function computeDebugViewport(shapeRecord, initialGraph, existingBBox) {
    const nodeBBox = bboxFromNodes(initialGraph?.nodes || []);
    const bbox = existingBBox || nodeBBox || { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const spanX = Math.max(1, bbox.maxX - bbox.minX);
    const spanY = Math.max(1, bbox.maxY - bbox.minY);
    const pad = Math.max(5, Math.max(spanX, spanY) * 0.08);
    return {
      bbox,
      ox: bbox.minX - pad,
      originMaxY: bbox.maxY + pad,
      width: spanX + pad * 2,
      height: spanY + pad * 2,
    };
  }

  function buildCandidateSummary(entry, index) {
    const candidate = entry?.candidate || entry || {};
    return {
      rank: index + 1,
      source: candidate.source || null,
      area: candidate.area ?? entry?.area ?? null,
      cycleDepth: candidate.cycleDepth ?? null,
      cycleIndexCount: Array.isArray(candidate.cycleIndices) ? candidate.cycleIndices.length : 0,
      polygonPointCount: Array.isArray(candidate.polygonPoints) ? candidate.polygonPoints.length : 0,
      pathLength: entry?.pathLength ?? null,
      closureGap: entry?.closureGap ?? null,
      mergeCount: entry?.mergeCount ?? null,
    };
  }

  function renderDebugPolygon(points, viewport, color, strokeWidth = 2, opacity = 1, close = true, dash = '') {
    if (!Array.isArray(points) || points.length < 3) return '';
    const sourcePoints = close && points.length > 1 ? points.slice(0, -1) : points;
    const d = pathFromPoints(sourcePoints, viewport.ox, viewport.originMaxY, close);
    if (!d) return '';
    const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" opacity="${opacity}"${dashAttr}/>`;
  }

  function renderDebugEdge(start, end, viewport, color, opacity = 0.8) {
    const d = pathFromPoints([{ x: start[0], y: start[1] }, { x: end[0], y: end[1] }], viewport.ox, viewport.originMaxY, false);
    return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.2" opacity="${opacity}"/>` : '';
  }

  function buildAggregateGroups(forest, planarNodes, offsets) {
    return (forest || []).map((tree, treeIndex) => ({
      treeIndex,
      polygons: collectTreeCycles(tree, []).map(cycle => cycleToPolygon(cycle, planarNodes, offsets)),
    }));
  }

  function buildPlanarDebugSvg(shapeRecord, viewport, initialGraph, faceCandidates, aggregateGroups, aggregateCandidates, rankedCandidates) {
    const parts = [];
    (shapeRecord?.entities || []).forEach(entity => {
      const rendered = entityToSVGStr(entity, viewport.ox, viewport.originMaxY, '#2f3648');
      if (rendered) parts.push(rendered);
    });

    (initialGraph?.edges || []).forEach(([a, b]) => {
      const start = initialGraph.nodes?.[a];
      const end = initialGraph.nodes?.[b];
      if (!start || !end) return;
      parts.push(renderDebugEdge(start, end, viewport, '#64748b', 0.55));
    });

    faceCandidates.forEach((candidate, index) => {
      parts.push(renderDebugPolygon(candidate.polygonPoints, viewport, DEBUG_COLORS[index % DEBUG_COLORS.length], 1.8, 0.9));
    });

    aggregateGroups.forEach((group, groupIndex) => {
      const color = DEBUG_COLORS[groupIndex % DEBUG_COLORS.length];
      (group.polygons || []).forEach(points => {
        parts.push(renderDebugPolygon(points, viewport, color, 1.2, 0.45, true, '4 4'));
      });
    });

    aggregateCandidates.forEach((candidate, index) => {
      parts.push(renderDebugPolygon(candidate.polygonPoints, viewport, DEBUG_COLORS[(index + 3) % DEBUG_COLORS.length], 2.4, 0.95, true, '10 6'));
    });

    (rankedCandidates || []).slice(0, 3).forEach((entry, index) => {
      const points = entry?.candidate?.polygonPoints;
      if (!Array.isArray(points) || points.length < 4) return;
      const color = index === 0 ? '#ffffff' : DEBUG_COLORS[(index + 5) % DEBUG_COLORS.length];
      parts.push(renderDebugPolygon(points, viewport, color, index === 0 ? 3.2 : 2.2, 1));
    });

    const legend = [
      { label: 'entities', color: '#2f3648' },
      { label: 'raw graph', color: '#64748b' },
      { label: 'single faces', color: DEBUG_COLORS[0] },
      { label: 'aggregate groups', color: DEBUG_COLORS[1] },
      { label: 'aggregate unions', color: DEBUG_COLORS[3] },
      { label: 'winner', color: '#ffffff' },
    ];
    const legendItems = legend.map((item, index) =>
      `<g transform="translate(18 ${22 + index * 16})"><line x1="0" y1="0" x2="18" y2="0" stroke="${item.color}" stroke-width="2"/><text x="24" y="4" fill="#cbd5e1" font-size="11" font-family="Menlo, Monaco, monospace">${item.label}</text></g>`
    ).join('');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}">
  <rect width="${viewport.width}" height="${viewport.height}" fill="#0d0f18"/>
  ${parts.join('\n  ')}
  ${legendItems}
</svg>`;
  }

  function writePlanarDebugArtifacts(shapeRecord, viewport, payload) {
    const baseName = `planar-${safeName(shapeRecord?.id || 'shape')}-${Date.now()}`;
    const svgOutput = buildPlanarDebugSvg(
      shapeRecord,
      viewport,
      payload.initialGraph,
      payload.faceCandidates || [],
      payload.aggregateGroups || [],
      payload.aggregateCandidates || [],
      payload.rankedCandidates || []
    );
    const jsonOutput = {
      shapeId: shapeRecord?.id || null,
      stage: payload.stage || null,
      discoveryMode: payload.discoveryMode || null,
      rawNodeCount: payload.initialGraph?.nodes?.length || 0,
      rawEdgeCount: payload.initialGraph?.edges?.length || 0,
      planarNodeCount: payload.planarGraph?.nodes?.length || 0,
      planarEdgeCount: payload.planarGraph?.edges?.length || 0,
      cyclesFound: payload.cycles?.length || 0,
      faceCandidateCount: payload.faceCandidates?.length || 0,
      aggregateGroupCount: payload.aggregateGroups?.length || 0,
      aggregateCandidateCount: payload.aggregateCandidates?.length || 0,
      rankedCandidateCount: payload.rankedCandidates?.length || 0,
      winner: payload.rankedCandidates?.[0] ? buildCandidateSummary(payload.rankedCandidates[0], 0) : null,
      rankedCandidates: (payload.rankedCandidates || []).slice(0, 10).map(buildCandidateSummary),
      faceCandidates: (payload.faceCandidates || []).map((candidate, index) => ({
        index,
        source: candidate.source || null,
        area: candidate.area ?? null,
        cycleDepth: candidate.cycleDepth ?? null,
        polygonPointCount: candidate.polygonPoints?.length || 0,
      })),
      aggregateCandidates: (payload.aggregateCandidates || []).map((candidate, index) => ({
        index,
        source: candidate.source || null,
        area: candidate.area ?? null,
        treeIndex: candidate.treeIndex ?? null,
        aggregateCycleCount: candidate.aggregateCycleCount ?? null,
        polygonPointCount: candidate.polygonPoints?.length || 0,
      })),
      aggregateGroups: (payload.aggregateGroups || []).map(group => ({
        treeIndex: group.treeIndex,
        polygonCount: group.polygons?.length || 0,
        polygonPointCounts: (group.polygons || []).map(points => points.length),
      })),
      rawEdgeEntries: payload.initialGraph?.edgeEntries || [],
    };
    if (typeof electronAPI.writeDebugSVG === 'function') {
      Promise.resolve(electronAPI.writeDebugSVG({ name: baseName, svg: svgOutput })).catch(() => {});
    }
    if (typeof electronAPI.writeDebugJSON === 'function') {
      Promise.resolve(electronAPI.writeDebugJSON({ name: baseName, data: jsonOutput })).catch(() => {});
    }
    return baseName;
  }

  function sampleArcPoints(entity, maxStepDeg = 10) {
    const endpoints = getArcEndpoints(entity);
    if (!entity?.center || !Number.isFinite(entity.radius) || !endpoints) return [];

    const start = Number.isFinite(entity.startAngle) ? entity.startAngle : 0;
    let end = Number.isFinite(entity.endAngle) ? entity.endAngle : start;
    while (end <= start) end += Math.PI * 2;
    const span = end - start;
    const step = Math.max((maxStepDeg * Math.PI) / 180, Math.PI / 72);
    const steps = Math.max(8, Math.ceil(Math.abs(span) / step));
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angle = start + span * t;
      points.push({
        x: entity.center.x + entity.radius * Math.cos(angle),
        y: entity.center.y + entity.radius * Math.sin(angle),
      });
    }
    points[0] = endpoints.start;
    points[points.length - 1] = endpoints.end;
    return points;
  }

  function entityToOpenPointPath(entity, tolerance) {
    if (!entity?.type) return [];
    switch (entity.type) {
      case 'LINE': {
        const endpoints = getLineEndpoints(entity);
        return endpoints ? [endpoints.start, endpoints.end] : [];
      }
      case 'ARC':
        return sampleArcPoints(entity, 10);
      case 'CIRCLE':
        return closePointRing(circleToPoints(entity));
      case 'LWPOLYLINE':
      case 'POLYLINE':
        return Array.isArray(entity.vertices)
          ? polylineVerticesToPoints(entity.vertices, entity.closed !== false)
          : [];
      case 'ELLIPSE':
        return ellipseToPoints(entity, false);
      case 'SPLINE':
        return splineToPoints(entity);
      default:
        return [];
    }
  }

  function pointsToSegments(points, close = false, tolerance = LOOP_TOLERANCE) {
    if (!Array.isArray(points) || points.length < 2) return [];
    const segments = [];
    const limit = close ? points.length : points.length - 1;
    for (let i = 0; i < limit; i++) {
      const start = points[i];
      const end = points[(i + 1) % points.length];
      if (!start || !end) continue;
      if (dist(start, end) <= tolerance) continue;
      segments.push([
        { x: start.x, y: start.y },
        { x: end.x, y: end.y },
      ]);
    }
    return segments;
  }

  function entityToSegments(entity, tolerance) {
    if (!entity?.type) return [];
    switch (entity.type) {
      case 'LINE': {
        const endpoints = getLineEndpoints(entity);
        if (!endpoints || dist(endpoints.start, endpoints.end) <= tolerance) return [];
        return [[endpoints.start, endpoints.end]];
      }
      case 'ARC':
        return pointsToSegments(sampleArcPoints(entity, 10), false, tolerance);
      case 'CIRCLE':
        return pointsToSegments(circleToPoints(entity), true, tolerance);
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const vertices = Array.isArray(entity.vertices) ? entity.vertices : [];
        if (vertices.length < 2) return [];
        const segments = [];
        const count = entity.closed !== false ? vertices.length : vertices.length - 1;
        for (let i = 0; i < count; i++) {
          const start = vertices[i];
          const end = vertices[(i + 1) % vertices.length];
          if (!start || !end) continue;
          const bulge = Number(start.bulge) || 0;
          if (Math.abs(bulge) > EPS) {
            const arcPoints = [{ x: start.x, y: start.y }, ...bulgeToPoints(start, end, bulge, 10)];
            segments.push(...pointsToSegments(arcPoints, false, tolerance));
          } else if (dist(start, end) > tolerance) {
            segments.push([
              { x: start.x, y: start.y },
              { x: end.x, y: end.y },
            ]);
          }
        }
        return segments;
      }
      case 'ELLIPSE':
        return pointsToSegments(ellipseToPoints(entity, false), false, tolerance);
      case 'SPLINE':
        return pointsToSegments(splineToPoints(entity), !!entity.closed, tolerance);
      default:
        return [];
    }
  }

  function segmentKey(startIndex, endIndex) {
    return startIndex < endIndex
      ? `${startIndex}:${endIndex}`
      : `${endIndex}:${startIndex}`;
  }

  function buildGraphInput(entities, tolerance) {
    const nodes = [];
    const edges = [];
    const edgeEntries = [];
    const edgeSeen = new Set();
    const nodeIndexByKey = new Map();

    function findOrCreateNode(point) {
      const key = pointKey(point, tolerance);
      const existingIndex = nodeIndexByKey.get(key);
      if (Number.isInteger(existingIndex)) return existingIndex;
      const nextIndex = nodes.length;
      nodes.push([point.x, point.y]);
      nodeIndexByKey.set(key, nextIndex);
      return nextIndex;
    }

    (entities || []).forEach((entity, entityIndex) => {
      const segments = entityToSegments(entity, tolerance);
      segments.forEach(([start, end], segmentIndex) => {
        const startIndex = findOrCreateNode(start);
        const endIndex = findOrCreateNode(end);
        const startKey = pointKey(start, tolerance);
        const endKey = pointKey(end, tolerance);
        const degenerate = startIndex === endIndex;
        const key = degenerate ? null : segmentKey(startIndex, endIndex);
        const duplicate = !!key && edgeSeen.has(key);
        edgeEntries.push({
          entityIndex,
          entityId: entity?.handle || entity?.id || null,
          entityType: entity?.type || null,
          layer: entity?.layer || null,
          segmentIndex,
          start: { x: start.x, y: start.y },
          end: { x: end.x, y: end.y },
          startKey,
          endKey,
          startIndex,
          endIndex,
          degenerate,
          duplicate,
        });
        if (degenerate) return;
        if (duplicate) return;
        edgeSeen.add(key);
        edges.push([startIndex, endIndex]);
      });
    });

    return { nodes, edges, edgeEntries };
  }

  function offsetGraphPositive(nodes) {
    let minX = Infinity;
    let minY = Infinity;
    (nodes || []).forEach(([x, y]) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
    });

    const offsetX = minX < 0 ? (-minX + 1) : 0;
    const offsetY = minY < 0 ? (-minY + 1) : 0;
    if (offsetX === 0 && offsetY === 0) {
      return { nodes, offsetX, offsetY };
    }

    return {
      nodes: nodes.map(([x, y]) => [x + offsetX, y + offsetY]),
      offsetX,
      offsetY,
    };
  }

  function extractCyclesFromForest(forest, out = [], depth = 0) {
    (forest || []).forEach(tree => {
      if (Array.isArray(tree?.cycle) && tree.cycle.length >= 3) {
        out.push({
          cycle: tree.cycle.slice(),
          depth,
        });
      }
      if (Array.isArray(tree?.children) && tree.children.length) {
        extractCyclesFromForest(tree.children, out, depth + 1);
      }
    });
    return out;
  }

  function cycleToPolygon(cycle, planarNodes, offsets) {
    const raw = cycle.map(index => ({
      x: safeNumber(planarNodes[index]?.[0]) - offsets.offsetX,
      y: safeNumber(planarNodes[index]?.[1]) - offsets.offsetY,
    }));
    return closePointRing(raw);
  }

  function collectTreeCycles(tree, out = []) {
    if (Array.isArray(tree?.cycle) && tree.cycle.length >= 3) {
      out.push(tree.cycle.slice());
    }
    (tree?.children || []).forEach(child => collectTreeCycles(child, out));
    return out;
  }

  function polygonToFlattenPolygon(polygonPoints) {
    if (!Flatten || !Array.isArray(polygonPoints) || polygonPoints.length < 4) return null;
    try {
      return new Flatten.Polygon(
        polygonPoints
          .slice(0, -1)
          .map(point => [point.x, point.y])
      );
    } catch (_error) {
      return null;
    }
  }

  function flattenFaceToPolygonPoints(face) {
    if (!face) return [];
    const points = [];
    for (const edge of face) {
      const start = edge?.shape?.start;
      if (!start || !Number.isFinite(start.x) || !Number.isFinite(start.y)) continue;
      points.push({ x: start.x, y: start.y });
    }
    return closePointRing(points);
  }

  function buildAggregateCandidateFromCycles(cycles, planarNodes, offsets, tolerance, treeIndex = null) {
    if (!Flatten || !Array.isArray(cycles) || cycles.length < 2) return [];
    const flattenPolygons = cycles
      .map(cycle => polygonToFlattenPolygon(cycleToPolygon(cycle, planarNodes, offsets)))
      .filter(Boolean);
    if (flattenPolygons.length < 2) return [];

    let unionPolygon = flattenPolygons[0];
    for (let i = 1; i < flattenPolygons.length; i++) {
      try {
        unionPolygon = Flatten.BooleanOperations.unify(unionPolygon, flattenPolygons[i]);
      } catch (_error) {
        return [];
      }
    }

    const aggregateCandidates = [];
    for (const face of unionPolygon.faces || []) {
      const polygonPoints = flattenFaceToPolygonPoints(face);
      if (polygonPoints.length < 4) continue;
      const area = Math.abs(polygonSignedArea(polygonPoints.slice(0, -1)));
      if (!Number.isFinite(area) || area <= Math.max(EPS, tolerance * tolerance)) continue;
      aggregateCandidates.push({
        polygonPoints,
        area,
        source: 'planar-face-aggregate',
        cycleIndices: cycles.flat(),
        cycleDepth: null,
        treeIndex,
        aggregateCycleCount: cycles.length,
      });
    }
    return aggregateCandidates;
  }

  function buildCandidates(cycles, planarNodes, offsets, tolerance) {
    const seen = new Set();
    return (cycles || [])
      .map((entry, index) => {
        const polygonPoints = cycleToPolygon(entry.cycle, planarNodes, offsets);
        if (polygonPoints.length < 4) return null;
        const signature = normalizedClosedPointSignature(polygonPoints.slice(0, -1));
        if (!signature || seen.has(signature)) return null;
        seen.add(signature);
        const area = Math.abs(polygonSignedArea(polygonPoints.slice(0, -1)));
        if (!Number.isFinite(area) || area <= Math.max(EPS, tolerance * tolerance)) return null;
        return {
          polygonPoints,
          area,
          source: 'planar-face-discovery',
          cycleIndices: entry.cycle,
          cycleDepth: entry.depth,
          candidateIndex: index,
        };
      })
      .filter(Boolean);
  }

  function buildAggregateCandidates(forest, planarNodes, offsets, tolerance) {
    const candidates = [];
    (forest || []).forEach((tree, treeIndex) => {
      const treeCycles = collectTreeCycles(tree, []);
      candidates.push(...buildAggregateCandidateFromCycles(treeCycles, planarNodes, offsets, tolerance, treeIndex));
    });
    return candidates;
  }

  function toRankedCandidate(candidate, tolerance, gapTolerance) {
    return {
      candidate: {
        polygonPoints: candidate.polygonPoints,
        source: candidate.source,
        tolerance,
        gapTolerance,
        area: candidate.area,
        cycleIndices: candidate.cycleIndices || [],
        cycleDepth: candidate.cycleDepth ?? null,
      },
      area: candidate.area,
      mergeCount: 0,
      closureGap: 0,
      pathLength: candidate.polygonPoints.length,
    };
  }

  function buildPlanarContour(shapeRecord, options = {}) {
    const tolerance = Math.max(LOOP_TOLERANCE * 4, options.tolerance || LOOP_TOLERANCE * 8);
    const bbox = computeEntitiesBBox(shapeRecord?.entities || []);
    const span = bboxSpan(bbox);
    const gapTolerance = Number.isFinite(options.gapTolerance)
      ? Math.max(0, options.gapTolerance)
      : Math.max(tolerance * 64, span * 0.005, 1);

    const initialGraph = buildGraphInput(shapeRecord?.entities || [], tolerance);
    if (initialGraph.nodes.length < 3 || initialGraph.edges.length < 3) {
      const viewport = computeDebugViewport(shapeRecord, initialGraph, bbox);
      const debugDumpName = writePlanarDebugArtifacts(shapeRecord, viewport, {
        stage: 'planar-insufficient-graph',
        discoveryMode: 'raw',
        initialGraph,
        planarGraph: { nodes: initialGraph.nodes, edges: initialGraph.edges },
        cycles: [],
        faceCandidates: [],
        aggregateGroups: [],
        aggregateCandidates: [],
        rankedCandidates: [],
      });
      return emptyContourResult('planar-insufficient-graph', {
        shapeId: shapeRecord?.id || null,
        stage: 'planar-insufficient-graph',
        sourceEntityCount: shapeRecord?.entities?.length || 0,
        rawNodeCount: initialGraph.nodes.length,
        rawEdgeCount: initialGraph.edges.length,
        debugDumpName,
      });
    }

    const offsets = offsetGraphPositive(initialGraph.nodes);
    let discoveryMode = 'raw';
    let discoveryResult = null;
    let planarGraph = {
      nodes: offsets.nodes,
      edges: initialGraph.edges,
    };

    try {
      discoveryResult = electronAPI.discoverPlanarFaces(offsets.nodes, initialGraph.edges);
    } catch (error) {
      debugDXF('Planar raw face discovery fallback', {
        shapeId: shapeRecord?.id || null,
        stage: 'raw-face-discovery-failed',
        error: error?.message || String(error),
      });
    }

    if (!discoveryResult || discoveryResult.type !== 'RESULT' || !(discoveryResult.forest || []).length) {
      try {
        const result = electronAPI.toPlanarGraph(offsets.nodes, initialGraph.edges, gapTolerance);
        if (result?.nodes?.length && result?.edges?.length) {
          planarGraph = result;
          discoveryMode = 'planarized';
          discoveryResult = electronAPI.discoverPlanarFaces(planarGraph.nodes, planarGraph.edges);
        }
      } catch (error) {
        debugDXF('Planar contour graph fallback', {
          shapeId: shapeRecord?.id || null,
          stage: 'to-planar-graph-failed',
          error: error?.message || String(error),
        });
      }
    }

    if (!discoveryResult || discoveryResult.type !== 'RESULT') {
      const viewport = computeDebugViewport(shapeRecord, initialGraph, bbox);
      const debugDumpName = writePlanarDebugArtifacts(shapeRecord, viewport, {
        stage: 'planar-face-discovery-error',
        discoveryMode,
        initialGraph,
        planarGraph,
        cycles: [],
        faceCandidates: [],
        aggregateGroups: [],
        aggregateCandidates: [],
        rankedCandidates: [],
      });
      return emptyContourResult('planar-face-discovery-error', {
        shapeId: shapeRecord?.id || null,
        stage: 'planar-face-discovery-error',
        error: discoveryResult?.reason || 'Unknown planar face discovery error',
        rawNodeCount: initialGraph.nodes.length,
        rawEdgeCount: initialGraph.edges.length,
        planarNodeCount: planarGraph.nodes.length,
        planarEdgeCount: planarGraph.edges.length,
        discoveryMode,
        rawNodes: initialGraph.nodes,
        rawEdges: initialGraph.edges,
        rawEdgeEntries: initialGraph.edgeEntries,
        debugDumpName,
      });
    }

    if (!(discoveryResult.forest || []).length) {
      const viewport = computeDebugViewport(shapeRecord, initialGraph, bbox);
      const debugDumpName = writePlanarDebugArtifacts(shapeRecord, viewport, {
        stage: 'planar-no-faces',
        discoveryMode,
        initialGraph,
        planarGraph,
        cycles: [],
        faceCandidates: [],
        aggregateGroups: [],
        aggregateCandidates: [],
        rankedCandidates: [],
      });
      return emptyContourResult('planar-no-faces', {
        shapeId: shapeRecord?.id || null,
        stage: 'planar-no-faces',
        rawNodeCount: initialGraph.nodes.length,
        rawEdgeCount: initialGraph.edges.length,
        planarNodeCount: planarGraph.nodes.length,
        planarEdgeCount: planarGraph.edges.length,
        discoveryMode,
        rawNodes: initialGraph.nodes,
        rawEdges: initialGraph.edges,
        rawEdgeEntries: initialGraph.edgeEntries,
        debugDumpName,
      });
    }

    const cycles = extractCyclesFromForest(discoveryResult.forest || []);
    const faceCandidates = buildCandidates(cycles, planarGraph.nodes, offsets, tolerance);
    const aggregateGroups = buildAggregateGroups(discoveryResult.forest || [], planarGraph.nodes, offsets);
    const aggregateCandidates = buildAggregateCandidates(discoveryResult.forest || [], planarGraph.nodes, offsets, tolerance);
    const candidates = [
      ...faceCandidates,
      ...aggregateCandidates,
    ];
    const rankedCandidates = candidates
      .map(candidate => toRankedCandidate(candidate, tolerance, gapTolerance))
      .sort(compareContourCandidatesByGeometry);
    const winner = rankedCandidates[0] || null;
    const viewport = computeDebugViewport(shapeRecord, initialGraph, bbox);
    const debugDumpName = writePlanarDebugArtifacts(shapeRecord, viewport, {
      stage: winner ? 'planar-success' : 'planar-no-candidates',
      discoveryMode,
      initialGraph,
      planarGraph,
      cycles,
      faceCandidates,
      aggregateGroups,
      aggregateCandidates,
      rankedCandidates,
    });

    if (!winner) {
      return {
        ...emptyContourResult('planar-no-candidates'),
        rankedCandidates,
        builderDebug: {
          shapeId: shapeRecord?.id || null,
          stage: 'planar-no-candidates',
          sourceEntityCount: shapeRecord?.entities?.length || 0,
          rawNodeCount: initialGraph.nodes.length,
          rawEdgeCount: initialGraph.edges.length,
          planarNodeCount: planarGraph.nodes.length,
          planarEdgeCount: planarGraph.edges.length,
          cyclesFound: cycles.length,
          discoveryMode,
          rawNodes: initialGraph.nodes,
          rawEdges: initialGraph.edges,
          rawEdgeEntries: initialGraph.edgeEntries,
          debugDumpName,
        },
      };
    }

    return {
      ...winner.candidate,
      coverage: null,
      rankedCandidates,
      builderMode: 'planar-face-discovery',
      builderDebug: {
        shapeId: shapeRecord?.id || null,
        stage: 'planar-success',
        sourceEntityCount: shapeRecord?.entities?.length || 0,
        rawNodeCount: initialGraph.nodes.length,
        rawEdgeCount: initialGraph.edges.length,
        planarNodeCount: planarGraph.nodes.length,
        planarEdgeCount: planarGraph.edges.length,
        cyclesFound: cycles.length,
        candidateCount: rankedCandidates.length,
        chosenArea: winner.area ?? null,
        gapTolerance,
        discoveryMode,
        debugDumpName,
      },
    };
  }

  global.NestDxfContourDetectionPlanarService = {
    buildPlanarContour,
  };
})(window);
