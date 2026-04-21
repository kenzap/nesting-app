(function attachNestDxfNestingGraphUtils(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  if (!geometry) {
    global.NestDxfNestingGraphUtils = {};
    return;
  }

  const {
    EPS,
    samePoint,
    dist,
    polygonSignedArea,
  } = geometry;

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

  function bboxGap(a, b) {
    if (!a || !b) return Infinity;
    const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
    const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
    return Math.hypot(dx, dy);
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

  function buildOutgoingHalfEdges(nodes, edges) {
    const outgoing = new Map();

    function register(fromIndex, edgeIndex, toIndex) {
      if (!outgoing.has(fromIndex)) outgoing.set(fromIndex, []);
      const from = nodes[fromIndex];
      const to = nodes[toIndex];
      outgoing.get(fromIndex).push({
        fromIndex,
        toIndex,
        edgeIndex,
        angle: Math.atan2(to.y - from.y, to.x - from.x),
      });
    }

    (edges || []).forEach((edge, edgeIndex) => {
      register(edge.startIndex, edgeIndex, edge.endIndex);
      register(edge.endIndex, edgeIndex, edge.startIndex);
    });

    outgoing.forEach(list => list.sort((a, b) => a.angle - b.angle));
    return outgoing;
  }

  function polygonizeSegments(segments, tolerance) {
    const nodedSegments = splitSegmentsAtIntersections(segments || [], tolerance);
    const nodes = [];
    const adjacency = new Map();
    const edgeKeys = new Set();
    const edges = [];

    nodedSegments.forEach(([a, b]) => {
      if (!a || !b || dist(a, b) <= EPS) return;
      const startIndex = ensureNode(a, nodes, tolerance);
      const endIndex = ensureNode(b, nodes, tolerance);
      if (startIndex === endIndex) return;
      const key = edgeKey(startIndex, endIndex);
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      if (!adjacency.has(startIndex)) adjacency.set(startIndex, []);
      if (!adjacency.has(endIndex)) adjacency.set(endIndex, []);
      adjacency.get(startIndex).push(endIndex);
      adjacency.get(endIndex).push(startIndex);
      edges.push({ startIndex, endIndex });
    });

    if (!edges.length) {
      return { nodes, adjacency, edges, nodedSegments, faces: [] };
    }

    const outgoing = buildOutgoingHalfEdges(nodes, edges);
    const visitedHalfEdges = new Set();
    const seenCycles = new Set();
    const faces = [];

    function halfEdgeKey(fromIndex, edgeIndex, toIndex) {
      return `${fromIndex}|${edgeIndex}|${toIndex}`;
    }

    function traceFace(startHalfEdge) {
      const pointIndices = [startHalfEdge.fromIndex];
      const edgeIndices = [];
      const visitedInFace = new Set();
      let current = startHalfEdge;
      let safety = 0;

      while (safety++ < edges.length * 2 + 8) {
        const key = halfEdgeKey(current.fromIndex, current.edgeIndex, current.toIndex);
        if (visitedInFace.has(key)) return null;
        visitedInFace.add(key);
        edgeIndices.push(current.edgeIndex);
        pointIndices.push(current.toIndex);

        if (current.toIndex === startHalfEdge.fromIndex) {
          const ringIndices = pointIndices.slice(0, -1);
          if (ringIndices.length < 3) return null;
          const points = ringIndices.map(index => nodes[index]);
          const area = polygonSignedArea(points);
          if (Math.abs(area) <= EPS) return null;
          return { pointIndices, edgeIndices, points, area };
        }

        const options = outgoing.get(current.toIndex) || [];
        const reverseIndex = options.findIndex(option =>
          option.edgeIndex === current.edgeIndex && option.toIndex === current.fromIndex
        );
        if (reverseIndex === -1 || !options.length) return null;
        current = options[(reverseIndex - 1 + options.length) % options.length];
      }

      return null;
    }

    edges.forEach((edge, edgeIndex) => {
      [
        { fromIndex: edge.startIndex, edgeIndex, toIndex: edge.endIndex },
        { fromIndex: edge.endIndex, edgeIndex, toIndex: edge.startIndex },
      ].forEach(startHalfEdge => {
        const startKey = halfEdgeKey(startHalfEdge.fromIndex, startHalfEdge.edgeIndex, startHalfEdge.toIndex);
        if (visitedHalfEdges.has(startKey)) return;

        const face = traceFace(startHalfEdge);
        if (!face) {
          visitedHalfEdges.add(startKey);
          return;
        }

        face.pointIndices.slice(0, -1).forEach((fromIndex, index) => {
          const toIndex = face.pointIndices[index + 1];
          const tracedEdgeIndex = face.edgeIndices[index];
          visitedHalfEdges.add(halfEdgeKey(fromIndex, tracedEdgeIndex, toIndex));
        });

        if (face.area <= EPS) return;

        const cycleKey = canonicalizeCycle(face.pointIndices.slice(0, -1));
        if (!cycleKey || seenCycles.has(cycleKey)) return;
        seenCycles.add(cycleKey);

        faces.push({
          points: face.points,
          area: Math.abs(face.area),
          edgeIndices: face.edgeIndices.slice(),
        });
      });
    });

    return {
      nodes,
      adjacency,
      edges,
      nodedSegments,
      faces,
    };
  }

  global.NestDxfNestingGraphUtils = {
    bboxGap,
    ringBBox,
    pointOnSegment,
    segmentIntersectionPoint,
    orderedPointsAlongSegment,
    segmentsIntersect,
    enumerateSimpleCycles,
    buildGraphFromSegments,
    splitSegmentsAtIntersections,
    polygonizeSegments,
    addSegment,
  };
})(window);
