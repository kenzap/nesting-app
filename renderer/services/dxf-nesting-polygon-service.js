(function attachNestDxfOuterContourBuilder(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };

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

  function bboxGap(a, b) {
    if (!a || !b) return Infinity;
    const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
    const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
    return Math.hypot(dx, dy);
  }

  function ringBBox(points) {
    let bbox = null;
    (points || []).forEach(point => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      bbox = bbox
        ? {
            minX: Math.min(bbox.minX, point.x),
            minY: Math.min(bbox.minY, point.y),
            maxX: Math.max(bbox.maxX, point.x),
            maxY: Math.max(bbox.maxY, point.y),
          }
        : { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
    });
    return bbox;
  }

  function ringCenter(points) {
    const ring = closePointRing(points || []);
    if (ring.length < 4) return null;
    const core = ring.slice(0, -1);
    const total = core.reduce((acc, point) => ({
      x: acc.x + point.x,
      y: acc.y + point.y,
    }), { x: 0, y: 0 });
    return {
      x: total.x / core.length,
      y: total.y / core.length,
    };
  }

  function pointOnSegment(point, a, b, tolerance) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 <= EPS) return dist(point, a) <= tolerance;
    const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2;
    if (t < -EPS || t > 1 + EPS) return false;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    return Math.hypot(point.x - px, point.y - py) <= tolerance;
  }

  function segmentIntersectionPoint(a1, a2, b1, b2, tolerance) {
    const r = { x: a2.x - a1.x, y: a2.y - a1.y };
    const s = { x: b2.x - b1.x, y: b2.y - b1.y };
    const denom = (r.x * s.y) - (r.y * s.x);
    if (Math.abs(denom) <= EPS) return null;
    const qp = { x: b1.x - a1.x, y: b1.y - a1.y };
    const t = ((qp.x * s.y) - (qp.y * s.x)) / denom;
    const u = ((qp.x * r.y) - (qp.y * r.x)) / denom;
    if (t < -tolerance || t > 1 + tolerance || u < -tolerance || u > 1 + tolerance) return null;
    return {
      x: a1.x + (r.x * t),
      y: a1.y + (r.y * t),
    };
  }

  function orderedPointsAlongSegment(start, end, points, tolerance) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len2 = (dx * dx) + (dy * dy);
    const ordered = points
      .filter(point => pointOnSegment(point, start, end, tolerance))
      .slice()
      .sort((a, b) => {
        const ta = len2 <= EPS ? 0 : (((a.x - start.x) * dx) + ((a.y - start.y) * dy)) / len2;
        const tb = len2 <= EPS ? 0 : (((b.x - start.x) * dx) + ((b.y - start.y) * dy)) / len2;
        return ta - tb;
      });

    const unique = [];
    ordered.forEach(point => {
      if (!unique.some(existing => samePoint(existing, point, tolerance))) unique.push(point);
    });
    return unique;
  }

  function edgeKey(a, b) {
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  }

  function ensureNode(point, nodes, tolerance) {
    const match = nodes.findIndex(existing => samePoint(existing, point, tolerance));
    if (match >= 0) return match;
    nodes.push({ x: point.x, y: point.y });
    return nodes.length - 1;
  }

  function addSegment(a, b, nodes, adjacency, edgeKeys, tolerance) {
    if (!a || !b || dist(a, b) <= EPS) return;
    const ai = ensureNode(a, nodes, tolerance);
    const bi = ensureNode(b, nodes, tolerance);
    if (ai === bi) return;
    const key = edgeKey(ai, bi);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    if (!adjacency.has(ai)) adjacency.set(ai, []);
    if (!adjacency.has(bi)) adjacency.set(bi, []);
    adjacency.get(ai).push(bi);
    adjacency.get(bi).push(ai);
  }

  function canonicalizeCycle(indices) {
    if (!Array.isArray(indices) || indices.length < 3) return '';
    const n = indices.length;
    let best = null;
    const consider = cycle => {
      for (let offset = 0; offset < n; offset++) {
        const rotated = [];
        for (let i = 0; i < n; i++) rotated.push(cycle[(offset + i) % n]);
        const key = rotated.join('_');
        if (!best || key < best) best = key;
      }
    };
    consider(indices);
    consider(indices.slice().reverse());
    return best || '';
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

  function enumerateSimpleCycles(nodes, adjacency, maxCycles = 500) {
    const seen = new Set();
    const cycles = [];

    const visit = (startNode, currentNode, path, visited) => {
      if (cycles.length >= maxCycles) return;
      for (const next of (adjacency.get(currentNode) || [])) {
        if (next === startNode) {
          if (path.length < 3) continue;
          const cycle = path.slice();
          const key = canonicalizeCycle(cycle);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const points = cycle.map(index => nodes[index]);
          if (points.length < 3) continue;
          const area = Math.abs(polygonSignedArea(points));
          if (area <= EPS) continue;
          if (ringSelfIntersectionCount(points) > 0) continue;
          cycles.push(points);
          continue;
        }
        if (visited.has(next)) continue;
        if (next < startNode) continue;
        if (path.length >= Math.min(48, nodes.length + 1)) continue;
        visited.add(next);
        path.push(next);
        visit(startNode, next, path, visited);
        path.pop();
        visited.delete(next);
      }
    };

    [...adjacency.keys()].sort((a, b) => a - b).forEach(startNode => {
      if (cycles.length >= maxCycles) return;
      for (const next of (adjacency.get(startNode) || []).filter(index => index >= startNode)) {
        const visited = new Set([startNode, next]);
        visit(startNode, next, [startNode, next], visited);
        if (cycles.length >= maxCycles) break;
      }
    });

    return cycles;
  }

  function buildEntitySegments(entity, tolerance) {
    const points = entityToPathPoints(entity, true);
    if (points.length < 2) return [];
    const segments = [];
    for (let i = 0; i < points.length - 1; i++) {
      if (dist(points[i], points[i + 1]) <= EPS) continue;
      segments.push([points[i], points[i + 1]]);
    }
    return segments;
  }

  function pointInsideRing(points, point) {
    const ring = closePointRing(points || []);
    const bbox = ringBBox(ring);
    if (!ring.length || !bbox || !point || !bboxContainsPoint(bbox, point, LOOP_TOLERANCE * 12)) return false;
    return pointInPoly(point.x, point.y, ring);
  }

  function findAttachedOpenEntities(shapeRecord, seedPoints, tolerance) {
    const seedBBox = ringBBox(seedPoints);
    const openEntities = (shapeRecord?.openEntities || []).filter(isRenderableEntity);
    return openEntities.filter(entity => {
      const box = entityBBox(entity);
      if (!box || bboxGap(seedBBox, box) > tolerance * 80) return false;
      const pathPoints = entityToPathPoints(entity, true);
      if (!pathPoints.length) return false;
      const touchesSeed = pathPoints.some(point => {
        for (let i = 0; i < seedPoints.length - 1; i++) {
          if (pointOnSegment(point, seedPoints[i], seedPoints[i + 1], tolerance * 12)) return true;
        }
        return false;
      });
      if (!touchesSeed) return false;
      return box.minX < seedBBox.minX - tolerance ||
        box.maxX > seedBBox.maxX + tolerance ||
        box.minY < seedBBox.minY - tolerance ||
        box.maxY > seedBBox.maxY + tolerance;
    });
  }

  function buildLocalGraph(seedPoints, attachedEntities, tolerance) {
    const nodes = [];
    const adjacency = new Map();
    const edgeKeys = new Set();
    const ring = closePointRing(seedPoints);
    const contourSegments = [];
    for (let i = 0; i < ring.length - 1; i++) contourSegments.push([ring[i], ring[i + 1]]);
    const attachedSegments = attachedEntities.flatMap(entity => buildEntitySegments(entity, tolerance));

    const contourSplitPoints = contourSegments.map(([start, end]) => [start, end]);
    contourSegments.forEach(([start, end], index) => {
      attachedSegments.forEach(([a, b]) => {
        const hits = [];
        const startHit = pointOnSegment(start, a, b, tolerance * 8);
        const endHit = pointOnSegment(end, a, b, tolerance * 8);
        if (startHit) hits.push(start);
        if (endHit) hits.push(end);
        const intersection = segmentIntersectionPoint(start, end, a, b, tolerance * 8);
        if (intersection) hits.push(intersection);
        hits.forEach(point => {
          if (!contourSplitPoints[index].some(existing => samePoint(existing, point, tolerance * 4))) {
            contourSplitPoints[index].push(point);
          }
        });
      });
    });

    contourSegments.forEach(([start, end], index) => {
      const ordered = orderedPointsAlongSegment(start, end, contourSplitPoints[index], tolerance * 4);
      for (let i = 0; i < ordered.length - 1; i++) addSegment(ordered[i], ordered[i + 1], nodes, adjacency, edgeKeys, tolerance * 4);
    });

    attachedSegments.forEach(([start, end]) => {
      const splitPoints = [start, end];
      contourSegments.forEach(([a, b]) => {
        const intersection = segmentIntersectionPoint(start, end, a, b, tolerance * 8);
        if (intersection && !splitPoints.some(existing => samePoint(existing, intersection, tolerance * 4))) splitPoints.push(intersection);
      });
      const ordered = orderedPointsAlongSegment(start, end, splitPoints, tolerance * 4);
      for (let i = 0; i < ordered.length - 1; i++) addSegment(ordered[i], ordered[i + 1], nodes, adjacency, edgeKeys, tolerance * 4);
    });

    return { nodes, adjacency };
  }

  function buildGraphFromSegments(segments, tolerance) {
    const nodes = [];
    const adjacency = new Map();
    const edgeKeys = new Set();

    segments.forEach(([a, b]) => addSegment(a, b, nodes, adjacency, edgeKeys, tolerance));
    return { nodes, adjacency };
  }

  function splitSegmentsAtIntersections(segments, tolerance) {
    const splitPointsBySegment = segments.map(([start, end]) => [start, end]);

    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const [a1, a2] = segments[i];
        const [b1, b2] = segments[j];
        const intersection = segmentIntersectionPoint(a1, a2, b1, b2, tolerance * 8);
        if (!intersection) continue;

        if (!splitPointsBySegment[i].some(point => samePoint(point, intersection, tolerance * 4))) {
          splitPointsBySegment[i].push(intersection);
        }
        if (!splitPointsBySegment[j].some(point => samePoint(point, intersection, tolerance * 4))) {
          splitPointsBySegment[j].push(intersection);
        }
      }
    }

    const splitSegments = [];
    segments.forEach(([start, end], index) => {
      const ordered = orderedPointsAlongSegment(start, end, splitPointsBySegment[index], tolerance * 4);
      for (let i = 0; i < ordered.length - 1; i++) {
        if (dist(ordered[i], ordered[i + 1]) <= EPS) continue;
        splitSegments.push([ordered[i], ordered[i + 1]]);
      }
    });
    return splitSegments;
  }

  function extractOutermostSimpleLoop(points, tolerance) {
    const ring = closePointRing(points || []);
    if (ring.length < 4) return null;
    const sourceBBox = ringBBox(ring);
    const sourceBBoxArea = sourceBBox
      ? Math.max(EPS, (sourceBBox.maxX - sourceBBox.minX) * (sourceBBox.maxY - sourceBBox.minY))
      : 0;
    const segments = [];
    for (let i = 0; i < ring.length - 1; i++) {
      if (dist(ring[i], ring[i + 1]) <= EPS) continue;
      segments.push([ring[i], ring[i + 1]]);
    }
    if (!segments.length) return null;

    const splitSegments = splitSegmentsAtIntersections(segments, tolerance);
    const graph = buildGraphFromSegments(splitSegments, tolerance * 4);
    const cycles = enumerateSimpleCycles(graph.nodes, graph.adjacency, graph.nodes.length > 60 ? 300 : 800);
    if (!cycles.length) return closePointRing(normalizeWindingCCW(ring));

    const ranked = cycles
      .map(cycle => {
        const closed = closePointRing(normalizeWindingCCW(cycle));
        const area = Math.abs(polygonSignedArea(closed.slice(0, -1)));
        const bbox = ringBBox(closed);
        const bboxArea = bbox ? Math.max(EPS, (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY)) : area;
        const bboxCoverage = sourceBBoxArea > EPS ? (bboxArea / sourceBBoxArea) : 0;
        return {
          points: closed,
          area,
          bboxArea,
          bboxCoverage,
        };
      })
      .sort((a, b) => {
        if (Math.abs((b.bboxCoverage || 0) - (a.bboxCoverage || 0)) > 1e-6) return (b.bboxCoverage || 0) - (a.bboxCoverage || 0);
        if (Math.abs((b.area || 0) - (a.area || 0)) > 1e-6) return (b.area || 0) - (a.area || 0);
        return (b.bboxArea || 0) - (a.bboxArea || 0);
      });

    return ranked[0]?.points || closePointRing(normalizeWindingCCW(ring));
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

    const attachedEntities = findAttachedOpenEntities(shapeRecord, seedPoints, tolerance);
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

    const graph = buildLocalGraph(seedPoints, attachedEntities, tolerance);
    const graphEdgeCount = [...graph.adjacency.values()].reduce((sum, neighbors) => sum + neighbors.length, 0) / 2;
    const cycles = enumerateSimpleCycles(graph.nodes, graph.adjacency, graph.nodes.length > 40 ? 300 : 800);
    if (!cycles.length) {
      const debug = {
        shapeId: shapeRecord?.id || null,
        seedContourId: parentContour?.id || null,
        stage: 'no-cycles',
        attachedEntityIds: attachedEntities.map(entity => entity.handle || entity.id || entity.type),
        graphNodeCount: graph.nodes.length,
        graphEdgeCount,
      };
      debugDXF('Outer contour builder', debug);
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'parent-builder', builderDebug: debug };
    }

    const seedCenter = ringCenter(seedPoints);
    const seedArea = Math.abs(polygonSignedArea(seedPoints.slice(0, -1)));
    const attachedIds = attachedEntities.map(entity => entity.handle || entity.id || entity.type);
    const ranked = cycles
      .map(points => {
        const ring = closePointRing(normalizeWindingCCW(points));
        const coverage = scorePolygonCoverage({ polygonPoints: ring }, shapeRecord.entities || []);
        const enclosesSeed = seedCenter ? pointInsideRing(ring, seedCenter) : false;
        const area = Math.abs(polygonSignedArea(ring.slice(0, -1)));
        const areaGain = seedArea > EPS ? (area / seedArea) : 1;
        return {
          candidate: {
            polygonPoints: ring,
            source: 'parent-extended',
            tolerance,
            seedContourId: parentContour.id || null,
            attachedEntityIds: attachedIds,
            area,
          },
          score: coverage,
          enclosesSeed,
          areaGain,
        };
      })
      .filter(entry => entry.score && entry.enclosesSeed && entry.areaGain >= 1)
      .sort((a, b) => {
        if ((a.score?.outerMissCount || 0) !== (b.score?.outerMissCount || 0)) return (a.score?.outerMissCount || 0) - (b.score?.outerMissCount || 0);
        if (Math.abs((b.score?.outerCoverage || 0) - (a.score?.outerCoverage || 0)) > 1e-6) return (b.score?.outerCoverage || 0) - (a.score?.outerCoverage || 0);
        if (Math.abs((b.areaGain || 0) - (a.areaGain || 0)) > 1e-6) return (b.areaGain || 0) - (a.areaGain || 0);
        if (Math.abs((b.score?.pointCoverage || 0) - (a.score?.pointCoverage || 0)) > 1e-6) return (b.score?.pointCoverage || 0) - (a.score?.pointCoverage || 0);
        return (b.score?.score || 0) - (a.score?.score || 0);
      });

    if (!ranked.length) {
      const debug = {
        shapeId: shapeRecord?.id || null,
        seedContourId: parentContour.id || null,
        stage: 'no-ranked-cycles',
        attachedEntityIds: attachedIds,
        graphNodeCount: graph.nodes.length,
        graphEdgeCount,
        cycleCount: cycles.length,
      };
      debugDXF('Outer contour builder', debug);
      return { polygonPoints: null, source: null, coverage: null, builderMode: 'parent-builder', builderDebug: debug };
    }

    const debug = {
      shapeId: shapeRecord?.id || null,
      seedContourId: parentContour.id || null,
      stage: 'success',
      attachedEntityIds: attachedIds,
      graphNodeCount: graph.nodes.length,
      graphEdgeCount,
      rawCycleCount: cycles.length,
      cycleCount: ranked.length,
      chosenSource: ranked[0]?.candidate?.source || null,
      candidates: ranked.slice(0, 10).map(entry => ({
        source: entry.candidate.source,
        polygonPointCount: entry.candidate.polygonPoints?.length || 0,
        areaGain: entry.areaGain,
        coverage: entry.score,
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

  function detectNestingPolygon(input, options = {}) {
    if (Array.isArray(input)) return { polygonPoints: null, source: null, coverage: null, builderMode: 'array-input-unsupported', builderDebug: null };
    const shapeRecord = input;
    if (!shapeRecord?.entities?.length) return { polygonPoints: null, source: null, coverage: null, builderMode: 'missing-shape-record', builderDebug: null };

    const built = buildExtendedOuterContourFromParent(shapeRecord, options);
    return built;
  }

  global.NestDxfNestingPolygonService = {
    tryPolygonizeWithTolerance: () => null,
    scorePolygonCoverage,
    findBestPolygonizedCandidate: () => null,
    buildConcaveHullFallback: () => null,
    buildExtendedOuterContourFromParent,
    detectNestingPolygon,
  };
})(window);
