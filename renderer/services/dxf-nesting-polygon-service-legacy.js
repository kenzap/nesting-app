(function attachNestDxfNestingPolygonService(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const {
    extractPolygonForEntities,
  } = global.NestDxfFlattenService || {
    extractPolygonForEntities: () => null,
  };
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };

  if (!geometry) {
    global.NestDxfNestingPolygonLegacyService = {
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
    vectorBetween,
    angleDelta,
    pointInPoly,
    bboxContainsPoint,
    bboxFromPoints,
    polygonSignedArea,
    normalizeWindingCCW,
    closePointRing,
    getLineEndpoints,
    circleToPoints,
    ellipseToPoints,
    splineToPoints,
    polylineVerticesToPoints,
    getArcEndpoints,
    unionBBox,
    entityBBox,
  } = geometry;

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
    if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.vertices?.length >= 3) {
      return entity.closed !== false;
    }
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

  function gridCell(point, tolerance) {
    return {
      gx: Math.floor(point.x / tolerance),
      gy: Math.floor(point.y / tolerance),
    };
  }

  function gridCellKey(gx, gy) {
    return `${gx},${gy}`;
  }

  function snapPoint(point, bucketMap, tolerance) {
    const { gx, gy } = gridCell(point, tolerance);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = bucketMap.get(gridCellKey(gx + dx, gy + dy));
        if (!bucket) continue;
        const match = bucket.find(existing => dist(existing, point) <= tolerance);
        if (match) return match;
      }
    }

    const snapped = { x: point.x, y: point.y };
    const key = gridCellKey(gx, gy);
    if (!bucketMap.has(key)) bucketMap.set(key, []);
    bucketMap.get(key).push(snapped);
    return snapped;
  }

  function buildSnappedSegmentGraph(entities, tolerance) {
    const pointBuckets = new Map();
    const nodeIds = new Map();
    const nodes = [];
    const adjacency = new Map();
    const edges = [];
    const edgeKeys = new Set();

    const ensureNode = point => {
      const snapped = snapPoint(point, pointBuckets, tolerance);
      const key = `${snapped.x},${snapped.y}`;
      if (!nodeIds.has(key)) {
        nodeIds.set(key, nodes.length);
        nodes.push(snapped);
      }
      return nodeIds.get(key);
    };

    const renderable = (entities || []).filter(isRenderableEntity);
    const lineEntities = renderable
      .map(entity => {
        if (entity?.type !== 'LINE') return null;
        const endpoints = getLineEndpoints(entity);
        if (!endpoints?.start || !endpoints?.end || dist(endpoints.start, endpoints.end) <= EPS) return null;
        return {
          entity,
          start: endpoints.start,
          end: endpoints.end,
          splitPoints: [endpoints.start, endpoints.end],
        };
      })
      .filter(Boolean);

    const segmentIntersectionPoint = (a1, a2, b1, b2) => {
      const r = { x: a2.x - a1.x, y: a2.y - a1.y };
      const s = { x: b2.x - b1.x, y: b2.y - b1.y };
      const denom = (r.x * s.y) - (r.y * s.x);
      if (Math.abs(denom) <= EPS) return null;
      const qp = { x: b1.x - a1.x, y: b1.y - a1.y };
      const t = ((qp.x * s.y) - (qp.y * s.x)) / denom;
      const u = ((qp.x * r.y) - (qp.y * r.x)) / denom;
      if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
      return {
        x: a1.x + (r.x * t),
        y: a1.y + (r.y * t),
      };
    };

    for (let i = 0; i < lineEntities.length; i++) {
      for (let j = i + 1; j < lineEntities.length; j++) {
        const a = lineEntities[i];
        const b = lineEntities[j];
        const intersection = segmentIntersectionPoint(a.start, a.end, b.start, b.end);
        if (!intersection) continue;
        if (!a.splitPoints.some(point => samePoint(point, intersection, tolerance))) a.splitPoints.push(intersection);
        if (!b.splitPoints.some(point => samePoint(point, intersection, tolerance))) b.splitPoints.push(intersection);
      }
    }

    const lineSubsegments = lineEntities.flatMap(line => {
      const dx = line.end.x - line.start.x;
      const dy = line.end.y - line.start.y;
      const len2 = (dx * dx) + (dy * dy);
      const ordered = line.splitPoints
        .slice()
        .sort((a, b) => {
          const ta = len2 <= EPS ? 0 : (((a.x - line.start.x) * dx) + ((a.y - line.start.y) * dy)) / len2;
          const tb = len2 <= EPS ? 0 : (((b.x - line.start.x) * dx) + ((b.y - line.start.y) * dy)) / len2;
          return ta - tb;
        });

      const deduped = [];
      ordered.forEach(point => {
        if (!deduped.some(existing => samePoint(existing, point, tolerance))) deduped.push(point);
      });

      const segments = [];
      for (let i = 0; i < deduped.length - 1; i++) {
        if (dist(deduped[i], deduped[i + 1]) <= EPS) continue;
        segments.push([deduped[i], deduped[i + 1]]);
      }
      return segments;
    });

    lineSubsegments.forEach(([a, b]) => {
      const ai = ensureNode(a);
      const bi = ensureNode(b);
      if (ai === bi) return;
      const edgeKey = ai < bi ? `${ai}_${bi}` : `${bi}_${ai}`;
      if (edgeKeys.has(edgeKey)) return;
      edgeKeys.add(edgeKey);
      edges.push({ a: ai, b: bi, key: edgeKey });
      if (!adjacency.has(ai)) adjacency.set(ai, []);
      if (!adjacency.has(bi)) adjacency.set(bi, []);
      adjacency.get(ai).push(bi);
      adjacency.get(bi).push(ai);
    });

    renderable.filter(entity => entity?.type !== 'LINE').forEach(entity => {
      const points = entityToPathPoints(entity, true);
      if (points.length < 2) return;
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        if (!a || !b || dist(a, b) <= EPS) continue;
        const ai = ensureNode(a);
        const bi = ensureNode(b);
        if (ai === bi) continue;
        const edgeKey = ai < bi ? `${ai}_${bi}` : `${bi}_${ai}`;
        if (edgeKeys.has(edgeKey)) continue;
        edgeKeys.add(edgeKey);
        edges.push({ a: ai, b: bi, key: edgeKey });
        if (!adjacency.has(ai)) adjacency.set(ai, []);
        if (!adjacency.has(bi)) adjacency.set(bi, []);
        adjacency.get(ai).push(bi);
        adjacency.get(bi).push(ai);
      }
    });

    return { nodes, adjacency, edges };
  }

  function normalizedTurnAngle(incoming, outgoing) {
    const incomingAngle = Math.atan2(incoming.y, incoming.x);
    const outgoingAngle = Math.atan2(outgoing.y, outgoing.x);
    let delta = outgoingAngle - incomingAngle;
    while (delta < 0) delta += TWO_PI;
    while (delta >= TWO_PI) delta -= TWO_PI;
    return delta;
  }

  function chooseBoundaryNext(nodes, adjacency, previous, current, used, mode = 'min') {
    const currentPoint = nodes[current];
    const previousPoint = nodes[previous];
    if (!currentPoint || !previousPoint) return -1;

    const incoming = vectorBetween(previousPoint, currentPoint);
    const candidates = (adjacency.get(current) || [])
      .filter(candidate => candidate !== previous && !used.has(`${current}_${candidate}`));

    if (!candidates.length) return -1;

    let best = candidates[0];
    let bestTurn = mode === 'max' ? -Infinity : Infinity;
    let bestStraightness = Infinity;
    let bestDistance = Infinity;

    candidates.forEach(candidate => {
      const candidatePoint = nodes[candidate];
      if (!candidatePoint) return;
      const outgoing = vectorBetween(currentPoint, candidatePoint);
      const turn = normalizedTurnAngle(incoming, outgoing);
      const straightness = angleDelta(incoming, outgoing);
      const stepDistance = dist(currentPoint, candidatePoint);

      const betterTurn = mode === 'max'
        ? turn > bestTurn + 1e-9
        : turn < bestTurn - 1e-9;
      const sameTurn = Math.abs(turn - bestTurn) <= 1e-9;

      if (betterTurn ||
          (sameTurn && straightness < bestStraightness - 1e-9) ||
          (sameTurn && Math.abs(straightness - bestStraightness) <= 1e-9 && stepDistance < bestDistance)) {
        best = candidate;
        bestTurn = turn;
        bestStraightness = straightness;
        bestDistance = stepDistance;
      }
    });

    return best;
  }

  function ringHasRepeatedVertices(points) {
    const seen = new Set();
    for (let i = 0; i < points.length; i++) {
      const key = `${points[i].x},${points[i].y}`;
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  }

  function ringSelfIntersectionCount(points) {
    let count = 0;
    for (let i = 0; i < points.length; i++) {
      const a1 = points[i];
      const a2 = points[(i + 1) % points.length];
      for (let j = i + 1; j < points.length; j++) {
        if (Math.abs(i - j) <= 1) continue;
        if (i === 0 && j === points.length - 1) continue;
        const b1 = points[j];
        const b2 = points[(j + 1) % points.length];
        if (segmentsIntersect(a1, a2, b1, b2)) count += 1;
      }
    }
    return count;
  }

  function ringBBoxArea(points) {
    const bbox = bboxFromPoints(points);
    if (!bbox) return 0;
    return Math.max(EPS, (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY));
  }

  function traceCandidateRings(nodes, adjacency, mode) {
    const rings = [];
    adjacency.forEach((neighbors, startNode) => {
      if ((neighbors || []).length < 2) return;
      neighbors.forEach(firstNext => {
        const ring = [startNode];
        const used = new Set([`${startNode}_${firstNext}`, `${firstNext}_${startNode}`]);
        let previous = startNode;
        let current = firstNext;

        for (let safety = 0; safety < adjacency.size * 3; safety++) {
          ring.push(current);
          if (current === startNode && ring.length > 3) break;
          if ((adjacency.get(current) || []).length < 2) break;
          const next = chooseBoundaryNext(nodes, adjacency, previous, current, used, mode);
          if (next === -1) break;
          used.add(`${current}_${next}`);
          used.add(`${next}_${current}`);
          previous = current;
          current = next;
        }

        if (ring[ring.length - 1] !== startNode) return;
        const points = ring.slice(0, -1).map(index => nodes[index]);
        if (points.length < 3) return;
        const area = Math.abs(polygonSignedArea(points));
        if (area <= EPS) return;
        const repeated = ringHasRepeatedVertices(points);
        const selfIntersections = ringSelfIntersectionCount(points);
        const perimeter = points.reduce((sum, point, index) => sum + dist(point, points[(index + 1) % points.length]), 0);
        const compactness = perimeter > EPS ? ((4 * Math.PI * area) / (perimeter * perimeter)) : 0;

        if (repeated || selfIntersections > 0) return;
        rings.push({
          points,
          area,
          compactness,
          bboxArea: ringBBoxArea(points),
        });
      });
    });

    return rings;
  }

  function canonicalizeCycleIndices(indices) {
    if (!Array.isArray(indices) || indices.length < 3) return '';
    const cycle = indices.slice();
    const n = cycle.length;
    let best = null;

    const consider = sequence => {
      for (let offset = 0; offset < n; offset++) {
        const rotated = [];
        for (let i = 0; i < n; i++) rotated.push(sequence[(offset + i) % n]);
        const key = rotated.join('_');
        if (!best || key < best) best = key;
      }
    };

    consider(cycle);
    consider(cycle.slice().reverse());
    return best || '';
  }

  function enumerateSimpleCycleRings(nodes, adjacency, options = {}) {
    const maxCycles = Math.max(50, options.maxCycles || 600);
    const maxDepth = Math.max(6, options.maxDepth || Math.min(48, adjacency.size + 1));
    const seen = new Set();
    const rings = [];

    const visit = (startNode, currentNode, path, visited) => {
      if (rings.length >= maxCycles) return;
      const neighbors = adjacency.get(currentNode) || [];
      for (const next of neighbors) {
        if (next === startNode) {
          if (path.length < 3) continue;
          const cycle = path.slice();
          const canonical = canonicalizeCycleIndices(cycle);
          if (!canonical || seen.has(canonical)) continue;
          seen.add(canonical);
          const points = cycle.map(index => nodes[index]).filter(Boolean);
          if (points.length < 3) continue;
          const area = Math.abs(polygonSignedArea(points));
          if (area <= EPS) continue;
          const repeated = ringHasRepeatedVertices(points);
          const selfIntersections = ringSelfIntersectionCount(points);
          const perimeter = points.reduce((sum, point, index) => sum + dist(point, points[(index + 1) % points.length]), 0);
          const compactness = perimeter > EPS ? ((4 * Math.PI * area) / (perimeter * perimeter)) : 0;
          if (repeated || selfIntersections > 0) continue;
          rings.push({
            points,
            area,
            compactness,
            bboxArea: ringBBoxArea(points),
          });
          continue;
        }

        if (visited.has(next)) continue;
        if (next < startNode) continue;
        if (path.length >= maxDepth) continue;

        visited.add(next);
        path.push(next);
        visit(startNode, next, path, visited);
        path.pop();
        visited.delete(next);
      }
    };

    [...adjacency.keys()]
      .sort((a, b) => a - b)
      .forEach(startNode => {
        if (rings.length >= maxCycles) return;
        const neighbors = (adjacency.get(startNode) || []).filter(next => next >= startNode);
        neighbors.forEach(next => {
          if (rings.length >= maxCycles) return;
          const visited = new Set([startNode, next]);
          visit(startNode, next, [startNode, next], visited);
        });
      });

    return rings;
  }

  function supportedClosedEntities(entities) {
    return (entities || []).filter(entity => isRenderableEntity(entity) && isClosedEntity(entity));
  }

  function entityGroupBBox(entities) {
    let bbox = null;
    (entities || []).filter(isRenderableEntity).forEach(entity => {
      bbox = unionBBox(bbox, entityBBox(entity));
    });
    return bbox;
  }

  function buildToleranceLadder(entities) {
    const bbox = entityGroupBBox(entities);
    const maxSpan = bbox
      ? Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, 1)
      : 1;
    const ladder = [
      LOOP_TOLERANCE * 10,
      LOOP_TOLERANCE * 25,
      LOOP_TOLERANCE * 50,
      LOOP_TOLERANCE * 100,
      maxSpan * 0.0005,
      maxSpan * 0.001,
      maxSpan * 0.0025,
      maxSpan * 0.005,
      maxSpan * 0.01,
    ]
      .filter(value => Number.isFinite(value) && value > LOOP_TOLERANCE)
      .sort((a, b) => a - b);

    const unique = [];
    ladder.forEach(value => {
      if (!unique.some(existing => Math.abs(existing - value) <= Math.max(LOOP_TOLERANCE, value * 0.05))) {
        unique.push(value);
      }
    });
    return unique;
  }

  function traceBestOpenBoundaryPolygon(entities, tolerance) {
    const graph = buildSnappedSegmentGraph((entities || []).filter(isRenderableEntity), Math.max(tolerance, LOOP_TOLERANCE));
    const candidates = [
      ...traceCandidateRings(graph.nodes, graph.adjacency, 'min'),
      ...traceCandidateRings(graph.nodes, graph.adjacency, 'max'),
      ...enumerateSimpleCycleRings(graph.nodes, graph.adjacency, {
        maxCycles: graph.adjacency.size > 60 ? 300 : 800,
        maxDepth: Math.min(64, graph.adjacency.size + 2),
      }),
    ];

    if (!candidates.length) {
      const degreeCounts = [...graph.adjacency.values()].map(neighbors => neighbors.length);
      return {
        polygonPoints: null,
        area: 0,
        source: 'exact-open-chain',
        tolerance,
        failure: {
          reason: 'no-ring-traced',
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          degree1Count: degreeCounts.filter(count => count <= 1).length,
          branchCount: degreeCounts.filter(count => count > 2).length,
          maxDegree: degreeCounts.length ? Math.max(...degreeCounts) : 0,
        },
      };
    }

    const ranked = candidates
      .map(candidate => ({
        candidate,
        coverage: scorePolygonCoverage({ polygonPoints: candidate.points }, entities),
      }))
      .filter(entry => entry.coverage)
      .sort((a, b) => {
        const aCoverage = a.coverage;
        const bCoverage = b.coverage;
        if ((aCoverage.outerMissCount || 0) !== (bCoverage.outerMissCount || 0)) {
          return (aCoverage.outerMissCount || 0) - (bCoverage.outerMissCount || 0);
        }
        if (Math.abs((bCoverage.outerCoverage || 0) - (aCoverage.outerCoverage || 0)) > 1e-6) {
          return (bCoverage.outerCoverage || 0) - (aCoverage.outerCoverage || 0);
        }
        if (Math.abs((bCoverage.entityCoverage || 0) - (aCoverage.entityCoverage || 0)) > 1e-6) {
          return (bCoverage.entityCoverage || 0) - (aCoverage.entityCoverage || 0);
        }
        if (Math.abs((bCoverage.pointCoverage || 0) - (aCoverage.pointCoverage || 0)) > 1e-6) {
          return (bCoverage.pointCoverage || 0) - (aCoverage.pointCoverage || 0);
        }
        if (Math.abs((bCoverage.score || 0) - (aCoverage.score || 0)) > 1e-6) return (bCoverage.score || 0) - (aCoverage.score || 0);
        return (b.candidate.area || 0) - (a.candidate.area || 0);
      });

    const bestRing = ranked[0]?.candidate?.points || null;
    const ring = bestRing ? closePointRing(normalizeWindingCCW([...bestRing])) : null;
    if (!ring || ring.length < 4) {
      const degreeCounts = [...graph.adjacency.values()].map(neighbors => neighbors.length);
      return {
        polygonPoints: null,
        area: 0,
        source: 'exact-open-chain',
        tolerance,
        failure: {
          reason: 'no-ranked-ring',
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          degree1Count: degreeCounts.filter(count => count <= 1).length,
          branchCount: degreeCounts.filter(count => count > 2).length,
          maxDegree: degreeCounts.length ? Math.max(...degreeCounts) : 0,
        },
      };
    }
    return {
      polygonPoints: ring,
      area: Math.abs(polygonSignedArea(ring.slice(0, -1))),
      source: 'exact-open-chain',
      tolerance,
    };
  }

  function tryExactClosedPolygon(entities) {
    const polygon = extractPolygonForEntities(supportedClosedEntities(entities));
    if (!polygon?.polygonPoints?.length) return null;
    return {
      polygonPoints: polygon.polygonPoints,
      area: polygon.area || Math.abs(polygonSignedArea(polygon.polygonPoints.slice(0, -1))),
      source: 'exact-closed',
      tolerance: 0,
    };
  }

  function tryPolygonizeWithTolerance(entities, tolerance = LOOP_TOLERANCE * 50) {
    const renderable = (entities || []).filter(isRenderableEntity);
    if (!renderable.length) return null;

    const exact = tryExactClosedPolygon(renderable);
    if (exact) return exact;

    const traced = traceBestOpenBoundaryPolygon(renderable, tolerance);
    if (!traced) return null;
    return {
      ...traced,
      source: tolerance <= LOOP_TOLERANCE * 6 ? 'exact-open-chain' : 'polygonized-tolerance',
    };
  }

  function containsPointInRing(points, point, eps = LOOP_TOLERANCE * 8) {
    const bbox = bboxFromPoints(points);
    if (!bbox || !bboxContainsPoint(bbox, point, eps)) return false;
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

  function orientation(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function onSegment(a, b, p, eps = EPS) {
    return p.x >= Math.min(a.x, b.x) - eps &&
      p.x <= Math.max(a.x, b.x) + eps &&
      p.y >= Math.min(a.y, b.y) - eps &&
      p.y <= Math.max(a.y, b.y) + eps;
  }

  function segmentsIntersect(a1, a2, b1, b2, eps = EPS) {
    const o1 = orientation(a1, a2, b1);
    const o2 = orientation(a1, a2, b2);
    const o3 = orientation(b1, b2, a1);
    const o4 = orientation(b1, b2, a2);

    if ((o1 > eps && o2 < -eps || o1 < -eps && o2 > eps) &&
        (o3 > eps && o4 < -eps || o3 < -eps && o4 > eps)) return true;

    if (Math.abs(o1) <= eps && onSegment(a1, a2, b1, eps)) return true;
    if (Math.abs(o2) <= eps && onSegment(a1, a2, b2, eps)) return true;
    if (Math.abs(o3) <= eps && onSegment(b1, b2, a1, eps)) return true;
    if (Math.abs(o4) <= eps && onSegment(b1, b2, a2, eps)) return true;
    return false;
  }

  function polygonDiagnostics(ring) {
    const points = closePointRing(ring || []);
    if (points.length < 4) {
      return {
        repeatedVertexCount: 0,
        selfIntersectionCount: 0,
        perimeter: 0,
        compactness: 0,
      };
    }

    const seen = new Set();
    let repeatedVertexCount = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const key = `${points[i].x},${points[i].y}`;
      if (seen.has(key)) repeatedVertexCount += 1;
      else seen.add(key);
    }

    let selfIntersectionCount = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a1 = points[i];
      const a2 = points[i + 1];
      for (let j = i + 1; j < points.length - 1; j++) {
        if (Math.abs(i - j) <= 1) continue;
        if (i === 0 && j === points.length - 2) continue;
        const b1 = points[j];
        const b2 = points[j + 1];
        if (segmentsIntersect(a1, a2, b1, b2)) selfIntersectionCount += 1;
      }
    }

    let perimeter = 0;
    for (let i = 0; i < points.length - 1; i++) perimeter += dist(points[i], points[i + 1]);
    const area = Math.abs(polygonSignedArea(points.slice(0, -1)));
    const compactness = perimeter > EPS ? ((4 * Math.PI * area) / (perimeter * perimeter)) : 0;

    return {
      repeatedVertexCount,
      selfIntersectionCount,
      perimeter,
      compactness,
    };
  }

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
    const allEntityBoxes = [];

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
      if (entityBox) allEntityBoxes.push(entityBox);
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
    const polygonBBox = bboxFromPoints(ring);
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
    const outerMissRatio = unsupportedEntityCount > 0
      ? outerMissCount / unsupportedEntityCount
      : 0;

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

  function computeConvexHull(points) {
    if (!points?.length) return null;
    const sorted = [...points].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    const upper = [];
    for (const point of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
      lower.push(point);
    }
    for (let i = sorted.length - 1; i >= 0; i--) {
      const point = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
      upper.push(point);
    }
    lower.pop();
    upper.pop();
    const hull = lower.concat(upper);
    return hull.length >= 3 ? hull : null;
  }

  function circumradius(a, b, c) {
    const ab = dist(a, b);
    const bc = dist(b, c);
    const ca = dist(c, a);
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
    return area2 < 1e-12 ? Infinity : (ab * bc * ca) / (2 * area2);
  }

  function inCircumcircle(a, b, c, p) {
    const ax = a.x - p.x, ay = a.y - p.y;
    const bx = b.x - p.x, by = b.y - p.y;
    const cx = c.x - p.x, cy = c.y - p.y;
    const det =
      (ax * ax + ay * ay) * (bx * cy - by * cx) -
      (bx * bx + by * by) * (ax * cy - ay * cx) +
      (cx * cx + cy * cy) * (ax * by - ay * bx);
    const orient = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    return orient > 0 ? det > 0 : det < 0;
  }

  function bowyerWatson(points) {
    const n = points.length;
    if (n < 3) return [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    const span = Math.max(maxX - minX, maxY - minY, 1) * 5;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const all = [...points,
      { x: cx - span, y: cy - span },
      { x: cx, y: cy + span * 2 },
      { x: cx + span, y: cy - span },
    ];
    let tris = [[n, n + 1, n + 2]];
    for (let pi = 0; pi < n; pi++) {
      const point = all[pi];
      const bad = [];
      const good = [];
      for (const tri of tris) {
        if (inCircumcircle(all[tri[0]], all[tri[1]], all[tri[2]], point)) bad.push(tri);
        else good.push(tri);
      }
      const boundary = [];
      for (const tri of bad) {
        for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
          const shared = bad.some(other => other !== tri && (
            (other[0] === a && other[1] === b) || (other[1] === a && other[2] === b) || (other[2] === a && other[0] === b) ||
            (other[0] === b && other[1] === a) || (other[1] === b && other[2] === a) || (other[2] === b && other[0] === a)
          ));
          if (!shared) boundary.push([a, b]);
        }
      }
      tris = good;
      for (const [a, b] of boundary) tris.push([a, b, pi]);
    }
    return tris.filter(tri => tri[0] < n && tri[1] < n && tri[2] < n);
  }

  function estimateAlpha(points) {
    if (points.length < 3) return Infinity;
    const sample = points.length > 150
      ? points.filter((_, index) => index % Math.ceil(points.length / 150) === 0)
      : points;
    const nn = sample.map((point, i) => {
      let minDistance = Infinity;
      for (let j = 0; j < sample.length; j++) {
        if (j === i) continue;
        minDistance = Math.min(minDistance, dist(point, sample[j]));
      }
      return minDistance;
    }).filter(value => value < Infinity);
    if (!nn.length) return Infinity;
    nn.sort((a, b) => a - b);
    return nn[Math.floor(nn.length * 0.75)] * 2.5;
  }

  function traceLargestBoundaryRing(adj, points) {
    if (!adj.size) return null;
    let bestRing = null;
    adj.forEach((_, startNode) => {
      for (const firstNext of (adj.get(startNode) || [])) {
        const ring = [startNode];
        const used = new Set([`${startNode}_${firstNext}`, `${firstNext}_${startNode}`]);
        let current = firstNext;
        for (let safety = 0; safety < adj.size * 2 + 10; safety++) {
          ring.push(current);
          if (current === startNode && ring.length > 2) break;
          let next = -1;
          for (const neighbor of (adj.get(current) || [])) {
            if (!used.has(`${current}_${neighbor}`)) {
              next = neighbor;
              break;
            }
          }
          if (next === -1) break;
          used.add(`${current}_${next}`);
          used.add(`${next}_${current}`);
          current = next;
        }
        const closed = ring.length > 2 && ring[ring.length - 1] === startNode;
        if (!closed) continue;
        const finalRing = ring.slice(0, -1);
        if (finalRing.length >= 3 && (!bestRing || finalRing.length > bestRing.length)) bestRing = finalRing;
      }
    });
    return bestRing ? bestRing.map(index => ({ x: points[index].x, y: points[index].y })) : null;
  }

  function computeAlphaShape(points, alpha) {
    if (!points?.length || points.length < 3) return null;
    const maxPoints = 300;
    const pts = points.length > maxPoints
      ? points.filter((_, index) => index % Math.ceil(points.length / maxPoints) === 0)
      : points;
    const tris = bowyerWatson(pts);
    if (!tris.length) return computeConvexHull(pts);
    const kept = tris.filter(tri => circumradius(pts[tri[0]], pts[tri[1]], pts[tri[2]]) <= alpha);
    if (!kept.length) return computeConvexHull(pts);
    const edgeOcc = new Map();
    for (const tri of kept) {
      for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (!edgeOcc.has(key)) edgeOcc.set(key, { a, b, count: 0 });
        edgeOcc.get(key).count += 1;
      }
    }
    const adj = new Map();
    edgeOcc.forEach(({ a, b, count }) => {
      if (count !== 1) return;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b);
      adj.get(b).push(a);
    });
    const ring = adj.size >= 3 ? traceLargestBoundaryRing(adj, pts) : null;
    return ring || computeConvexHull(pts);
  }

  function uniqueSampledPoints(entities, tolerance) {
    const points = [];
    const tol = Math.max(tolerance, LOOP_TOLERANCE * 4);
    (entities || []).filter(isRenderableEntity).forEach(entity => {
      entityToPathPoints(entity, false).forEach(point => {
        if (!points.some(existing => samePoint(existing, point, tol))) points.push({ x: point.x, y: point.y });
      });
    });
    return points;
  }

  function buildConcaveHullFallback(entities, options = {}) {
    const points = uniqueSampledPoints(entities, options.tolerance || LOOP_TOLERANCE * 30);
    if (points.length < 3) return null;
    const alpha = Number.isFinite(options.alpha) ? options.alpha : estimateAlpha(points);
    if (!Number.isFinite(alpha)) return null;
    const hull = computeAlphaShape(points, alpha);
    if (!hull || hull.length < 3) return null;
    const ring = closePointRing(normalizeWindingCCW([...hull]));
    if (ring.length < 4) return null;
    return {
      polygonPoints: ring,
      area: Math.abs(polygonSignedArea(ring.slice(0, -1))),
      source: 'concave-hull',
      alpha,
    };
  }

  function findBestPolygonizedCandidate(entities, tolerances = null) {
    const candidates = [];
    const toleranceLadder = Array.isArray(tolerances) && tolerances.length
      ? tolerances
      : buildToleranceLadder(entities);
    const exact = tryExactClosedPolygon(entities);
    if (exact) {
      const score = scorePolygonCoverage(exact, entities);
      candidates.push({ candidate: exact, score });
    }

    const exactOpen = traceBestOpenBoundaryPolygon(entities, LOOP_TOLERANCE * 4);
    if (exactOpen?.polygonPoints?.length) {
      const score = scorePolygonCoverage(exactOpen, entities);
      candidates.push({ candidate: exactOpen, score });
    }

    toleranceLadder.forEach(tolerance => {
      const candidate = tryPolygonizeWithTolerance(entities, tolerance);
      if (!candidate?.polygonPoints?.length) return;
      if (candidates.some(entry =>
        entry.candidate?.source === candidate.source &&
        entry.candidate?.tolerance === candidate.tolerance &&
        entry.candidate?.polygonPoints?.length === candidate.polygonPoints?.length
      )) return;
      const score = scorePolygonCoverage(candidate, entities);
      candidates.push({ candidate, score });
    });

    const fallback = buildConcaveHullFallback(entities);
    if (fallback?.polygonPoints?.length) {
      const score = scorePolygonCoverage(fallback, entities);
      candidates.push({ candidate: fallback, score });
    }

    const ranked = candidates
      .filter(entry => entry.score)
      .sort((a, b) => {
        if ((a.score?.outerMissCount || 0) !== (b.score?.outerMissCount || 0)) {
          return (a.score?.outerMissCount || 0) - (b.score?.outerMissCount || 0);
        }
        if (Math.abs((b.score?.outerCoverage || 0) - (a.score?.outerCoverage || 0)) > 1e-6) {
          return (b.score?.outerCoverage || 0) - (a.score?.outerCoverage || 0);
        }
        if (Math.abs((b.score?.score || 0) - (a.score?.score || 0)) > 1e-6) return (b.score?.score || 0) - (a.score?.score || 0);
        if ((b.score?.entityCoverage || 0) !== (a.score?.entityCoverage || 0)) return (b.score?.entityCoverage || 0) - (a.score?.entityCoverage || 0);
        return (a.score?.looseness || Infinity) - (b.score?.looseness || Infinity);
      });

    const best = ranked[0] || null;

    debugDXF('Nesting polygon candidates', {
      entityCount: (entities || []).filter(isRenderableEntity).length,
      candidateCount: ranked.length,
      chosenSource: best?.candidate?.source || null,
      failedOpenChain: exactOpen && !exactOpen.polygonPoints ? exactOpen.failure : null,
      candidates: ranked.map(entry => ({
        source: entry.candidate.source,
        tolerance: entry.candidate.tolerance || null,
        alpha: entry.candidate.alpha || null,
        polygonPointCount: entry.candidate.polygonPoints?.length || 0,
        score: entry.score,
      })),
    });

    return best ? {
      ...best.candidate,
      coverage: best.score,
      rankedCandidates: ranked,
      failedOpenChain: exactOpen && !exactOpen.polygonPoints ? exactOpen.failure : null,
    } : null;
  }

  function detectNestingPolygon(entities, options = {}) {
    const tolerances = Array.isArray(options.tolerances) && options.tolerances.length
      ? options.tolerances
      : undefined;
    return findBestPolygonizedCandidate(entities, tolerances);
  }

  global.NestDxfNestingPolygonLegacyService = {
    tryPolygonizeWithTolerance,
    scorePolygonCoverage,
    findBestPolygonizedCandidate,
    buildConcaveHullFallback,
    detectNestingPolygon,
  };
})(window);
