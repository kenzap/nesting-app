(function attachNestDxfOpenBuilderHelpers(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const graphUtils = global.NestDxfNestingGraphUtils || {};
  if (!geometry) {
    global.NestDxfOpenBuilderHelpers = {};
    return;
  }

  const {
    EPS,
    LOOP_TOLERANCE,
    dist,
    samePoint,
    entityBBox,
    unionBBox,
    closePointRing,
    pointInPoly,
    bboxContainsPoint,
    polygonSignedArea,
    normalizeWindingCCW,
    interiorPoint,
  } = geometry;

  const {
    bboxGap,
    ringBBox,
    pointOnSegment,
    segmentIntersectionPoint,
    enumerateSimpleCycles,
    splitSegmentsAtIntersections,
    buildGraphFromSegments,
  } = graphUtils;

  function buildEntitySegments(entity, tolerance, entityToPathPoints) {
    const points = entityToPathPoints(entity, true);
    if (points.length < 2) return [];
    const segments = [];
    for (let i = 0; i < points.length - 1; i++) {
      if (dist(points[i], points[i + 1]) <= EPS) continue;
      segments.push([points[i], points[i + 1]]);
    }
    return segments;
  }

  function projectScalarOnSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 <= EPS) return null;
    return ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2;
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

  function clusterSnapPoints(points, tolerance) {
    const clusters = [];
    (points || []).forEach(point => {
      if (!point) return;
      let cluster = clusters.find(entry => dist(entry.center, point) <= tolerance);
      if (!cluster) {
        cluster = {
          points: [point],
          center: { x: point.x, y: point.y },
        };
        clusters.push(cluster);
        return;
      }
      cluster.points.push(point);
      const count = cluster.points.length;
      cluster.center = {
        x: ((cluster.center.x * (count - 1)) + point.x) / count,
        y: ((cluster.center.y * (count - 1)) + point.y) / count,
      };
    });
    return clusters;
  }

  function snapSegments(segments, tolerance) {
    const endpoints = [];
    (segments || []).forEach(([start, end]) => {
      if (start) endpoints.push(start);
      if (end) endpoints.push(end);
    });
    const clusters = clusterSnapPoints(endpoints, tolerance);
    const snapPoint = point => {
      const cluster = clusters.find(entry => dist(entry.center, point) <= tolerance);
      return cluster ? { x: cluster.center.x, y: cluster.center.y } : point;
    };
    return (segments || []).map(([start, end]) => [snapPoint(start), snapPoint(end)])
      .filter(([start, end]) => dist(start, end) > EPS);
  }

  function projectPointToSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 <= EPS) return null;
    const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2;
    if (t <= EPS || t >= 1 - EPS) return null;
    return {
      x: a.x + dx * t,
      y: a.y + dy * t,
      t,
      distance: Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)),
    };
  }

  function repairEndpointToSegment(segments, tolerance) {
    const repaired = (segments || []).map(([start, end]) => [
      { x: start.x, y: start.y },
      { x: end.x, y: end.y },
    ]);
    let repairCount = 0;

    const endpoints = [];
    repaired.forEach(([start, end], segmentIndex) => {
      endpoints.push({ point: start, segmentIndex, endpointIndex: 0 });
      endpoints.push({ point: end, segmentIndex, endpointIndex: 1 });
    });

    endpoints.forEach(endpoint => {
      let best = null;
      repaired.forEach(([a, b], targetIndex) => {
        if (targetIndex === endpoint.segmentIndex) return;
        const projection = projectPointToSegment(endpoint.point, a, b);
        if (!projection || projection.distance > tolerance) return;
        if (!best || projection.distance < best.distance) {
          best = {
            targetIndex,
            projection,
          };
        }
      });

      if (!best) return;
      const snappedPoint = { x: best.projection.x, y: best.projection.y };
      repaired[endpoint.segmentIndex][endpoint.endpointIndex] = snappedPoint;
      repairCount += 1;
    });

    return {
      segments: repaired.filter(([start, end]) => dist(start, end) > EPS),
      repairCount,
    };
  }

  function bboxSpan(bbox) {
    if (!bbox) return 0;
    return Math.max(EPS, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
  }

  function computeBridgeLengthLimit(bbox, tolerance, options = {}) {
    const toleranceFactor = Number.isFinite(options.toleranceFactor) ? options.toleranceFactor : 6;
    const spanRatio = Number.isFinite(options.spanRatio) ? options.spanRatio : 0.015;
    const minAbsolute = Number.isFinite(options.minAbsolute) ? options.minAbsolute : 0;
    const maxAbsolute = Number.isFinite(options.maxAbsolute) ? options.maxAbsolute : Infinity;
    return Math.min(maxAbsolute, Math.max(minAbsolute, tolerance * toleranceFactor, bboxSpan(bbox) * spanRatio));
  }

  function buildEndpointBridges(segments, bbox, tolerance, options = {}) {
    const repaired = (segments || []).map(([start, end]) => [start, end]);
    const endpoints = [];
    repaired.forEach(([start, end], segmentIndex) => {
      endpoints.push({ point: start, segmentIndex, endpointIndex: 0 });
      endpoints.push({ point: end, segmentIndex, endpointIndex: 1 });
    });

    const maxBridgeLength = computeBridgeLengthLimit(bbox, tolerance, options);
    const candidates = [];

    for (let i = 0; i < endpoints.length; i++) {
      for (let j = i + 1; j < endpoints.length; j++) {
        const a = endpoints[i];
        const b = endpoints[j];
        if (a.segmentIndex === b.segmentIndex) continue;
        const length = dist(a.point, b.point);
        if (length <= EPS || length > maxBridgeLength) continue;
        candidates.push({ a, b, length });
      }
    }

    candidates.sort((a, b) => a.length - b.length);
    const used = new Set();
    const bridges = [];
    const maxBridges = Math.min(4, Math.max(1, Math.floor(endpoints.length / 4)));
    candidates.forEach(candidate => {
      if (bridges.length >= maxBridges) return;
      const aKey = `${candidate.a.segmentIndex}:${candidate.a.endpointIndex}`;
      const bKey = `${candidate.b.segmentIndex}:${candidate.b.endpointIndex}`;
      if (used.has(aKey) || used.has(bKey)) return;
      used.add(aKey);
      used.add(bKey);
      bridges.push([
        { x: candidate.a.point.x, y: candidate.a.point.y },
        { x: candidate.b.point.x, y: candidate.b.point.y },
      ]);
    });

    return {
      bridges,
      bridgeCount: bridges.length,
    };
  }

  function distancePointToSegment(point, a, b) {
    const projection = projectPointToSegment(point, a, b);
    if (!projection) return Math.min(dist(point, a), dist(point, b));
    return projection.distance;
  }

  function simplifyCollinearRing(points, tolerance, closePointRingFn, samePointFn) {
    const ring = closePointRingFn(points || []);
    if (ring.length < 4) return ring;
    const core = ring.slice(0, -1);
    let changed = true;
    while (changed && core.length >= 3) {
      changed = false;
      for (let i = 0; i < core.length; i++) {
        const prev = core[(i - 1 + core.length) % core.length];
        const curr = core[i];
        const next = core[(i + 1) % core.length];
        if (distancePointToSegment(curr, prev, next) <= tolerance) {
          core.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    const deduped = [];
    core.forEach(point => {
      if (!deduped.length || !samePointFn(deduped[deduped.length - 1], point, tolerance)) deduped.push(point);
    });
    if (deduped.length >= 2 && samePointFn(deduped[0], deduped[deduped.length - 1], tolerance)) deduped.pop();
    return closePointRingFn(deduped);
  }

  function computeSegmentsBBox(segments) {
    let bbox = null;
    (segments || []).forEach(([start, end]) => {
      if (!start || !end) return;
      bbox = unionBBox(bbox, {
        minX: Math.min(start.x, end.x),
        minY: Math.min(start.y, end.y),
        maxX: Math.max(start.x, end.x),
        maxY: Math.max(start.y, end.y),
      });
    });
    return bbox;
  }

  function normalizeVector(dx, dy) {
    const length = Math.hypot(dx, dy);
    if (length <= EPS) return null;
    return {
      x: dx / length,
      y: dy / length,
      length,
    };
  }

  function signedDistanceToLine(point, origin, direction) {
    if (!point || !origin || !direction) return Infinity;
    return (direction.x * (point.y - origin.y)) - (direction.y * (point.x - origin.x));
  }

  function projectScalarOnLine(point, origin, direction) {
    if (!point || !origin || !direction) return null;
    return ((point.x - origin.x) * direction.x) + ((point.y - origin.y) * direction.y);
  }

  function pointOnLine(origin, direction, scalar) {
    return {
      x: origin.x + (direction.x * scalar),
      y: origin.y + (direction.y * scalar),
    };
  }

  function lineIntersection(lineA, lineB) {
    if (!lineA?.point || !lineA?.direction || !lineB?.point || !lineB?.direction) return null;
    const denom = (lineA.direction.x * lineB.direction.y) - (lineA.direction.y * lineB.direction.x);
    if (Math.abs(denom) <= EPS) return null;
    const deltaX = lineB.point.x - lineA.point.x;
    const deltaY = lineB.point.y - lineA.point.y;
    const t = ((deltaX * lineB.direction.y) - (deltaY * lineB.direction.x)) / denom;
    return pointOnLine(lineA.point, lineA.direction, t);
  }

  function projectPointToLine(point, line) {
    const scalar = projectScalarOnLine(point, line?.point, line?.direction);
    return scalar == null ? null : pointOnLine(line.point, line.direction, scalar);
  }

  function measureIntervalCoverage(intervals) {
    if (!Array.isArray(intervals) || !intervals.length) return 0;
    const ordered = intervals
      .map(interval => [Math.min(interval[0], interval[1]), Math.max(interval[0], interval[1])])
      .filter(interval => Number.isFinite(interval[0]) && Number.isFinite(interval[1]) && interval[1] - interval[0] > EPS)
      .sort((left, right) => left[0] - right[0]);
    if (!ordered.length) return 0;

    let total = 0;
    let [currentStart, currentEnd] = ordered[0];
    for (let i = 1; i < ordered.length; i++) {
      const [start, end] = ordered[i];
      if (start <= currentEnd + EPS) {
        currentEnd = Math.max(currentEnd, end);
        continue;
      }
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
    total += currentEnd - currentStart;
    return total;
  }

  function normalizeIntervals(intervals, minValue = -Infinity, maxValue = Infinity) {
    if (!Array.isArray(intervals) || !intervals.length) return [];
    const ordered = intervals
      .map(interval => [
        Math.max(minValue, Math.min(interval[0], interval[1])),
        Math.min(maxValue, Math.max(interval[0], interval[1])),
      ])
      .filter(interval => Number.isFinite(interval[0]) && Number.isFinite(interval[1]) && interval[1] - interval[0] > EPS)
      .sort((left, right) => left[0] - right[0]);
    if (!ordered.length) return [];

    const merged = [];
    let [currentStart, currentEnd] = ordered[0];
    for (let i = 1; i < ordered.length; i++) {
      const [start, end] = ordered[i];
      if (start <= currentEnd + EPS) {
        currentEnd = Math.max(currentEnd, end);
        continue;
      }
      merged.push([currentStart, currentEnd]);
      currentStart = start;
      currentEnd = end;
    }
    merged.push([currentStart, currentEnd]);
    return merged;
  }

  function invertIntervals(intervals, minValue, maxValue) {
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || maxValue - minValue <= EPS) return [];
    const normalized = normalizeIntervals(intervals, minValue, maxValue);
    if (!normalized.length) return [[minValue, maxValue]];

    const gaps = [];
    let cursor = minValue;
    normalized.forEach(([start, end]) => {
      if (start - cursor > EPS) gaps.push([cursor, start]);
      cursor = Math.max(cursor, end);
    });
    if (maxValue - cursor > EPS) gaps.push([cursor, maxValue]);
    return gaps;
  }

  function createShellRun(ring, startIndex, endIndex) {
    const start = ring[startIndex];
    const end = ring[endIndex];
    if (!start || !end) return null;
    const vector = normalizeVector(end.x - start.x, end.y - start.y);
    if (!vector) return null;
    return {
      startIndex,
      endIndex,
      start,
      end,
      direction: { x: vector.x, y: vector.y },
      length: vector.length,
    };
  }

  function buildShellRuns(ring, mergeTolerance) {
    const edges = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const edge = createShellRun(ring, i, i + 1);
      if (edge) edges.push(edge);
    }
    if (edges.length < 2) return edges;

    const runs = [];
    let current = {
      startIndex: edges[0].startIndex,
      endIndex: edges[0].endIndex,
    };

    function flushCurrent() {
      const run = createShellRun(ring, current.startIndex, current.endIndex);
      if (run) runs.push(run);
    }

    for (let i = 1; i < edges.length; i++) {
      const edge = edges[i];
      const runStart = ring[current.startIndex];
      const runEnd = ring[current.endIndex];
      const candidateEnd = ring[edge.endIndex];
      const sharedPoint = ring[edge.startIndex];
      const align = segmentAlignment(runStart, runEnd, edge.start, edge.end);
      const collinear = align >= 0.985 &&
        distancePointToSegment(sharedPoint, runStart, candidateEnd) <= mergeTolerance;

      if (collinear) {
        current.endIndex = edge.endIndex;
        continue;
      }

      flushCurrent();
      current = {
        startIndex: edge.startIndex,
        endIndex: edge.endIndex,
      };
    }

    flushCurrent();
    return runs.length ? runs : edges;
  }

  function buildShellEdgeRuns(ring) {
    const edges = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const edge = createShellRun(ring, i, i + 1);
      if (edge) edges.push(edge);
    }
    return edges;
  }

  function buildRunSupportClusters(run, sourceSegments, params) {
    const {
      corridor,
      extensionSlack,
      lineOffsetTolerance,
      interiorTolerance,
    } = params;

    const clusters = [];
    const runLength = Math.max(run.length, EPS);
    const runDirection = run.direction;

    (sourceSegments || []).forEach(([a, b]) => {
      if (!a || !b || dist(a, b) <= EPS) return;

      let start = a;
      let end = b;
      let segmentVector = normalizeVector(end.x - start.x, end.y - start.y);
      if (!segmentVector) return;

      const directionDot = (segmentVector.x * runDirection.x) + (segmentVector.y * runDirection.y);
      if (Math.abs(directionDot) < 0.96) return;
      if (directionDot < 0) {
        start = b;
        end = a;
        segmentVector = normalizeVector(end.x - start.x, end.y - start.y);
        if (!segmentVector) return;
      }

      const midpoint = {
        x: (start.x + end.x) * 0.5,
        y: (start.y + end.y) * 0.5,
      };
      const midpointOffset = signedDistanceToLine(midpoint, run.start, runDirection);

      const lineDistanceStart = Math.abs(signedDistanceToLine(start, run.start, runDirection));
      const lineDistanceEnd = Math.abs(signedDistanceToLine(end, run.start, runDirection));
      const lineDistanceMid = Math.abs(midpointOffset);
      // The traced shell can sit a bit outside or inside the original source
      // boundary, so accept nearby parallel support on either side of the run.
      if (Math.min(lineDistanceStart, lineDistanceEnd, lineDistanceMid) > corridor) return;

      const scalarStart = projectScalarOnLine(start, run.start, runDirection);
      const scalarEnd = projectScalarOnLine(end, run.start, runDirection);
      if (scalarStart == null || scalarEnd == null) return;

      const intervalMin = Math.min(scalarStart, scalarEnd);
      const intervalMax = Math.max(scalarStart, scalarEnd);
      if (intervalMax < -extensionSlack || intervalMin > runLength + extensionSlack) return;

      const overlapStart = Math.max(0, intervalMin);
      const overlapEnd = Math.min(runLength, intervalMax);
      const overlapLength = Math.max(0, overlapEnd - overlapStart);
      const segmentWeight = Math.max(
        overlapLength,
        Math.min(runLength * 0.12, Math.max(EPS, segmentVector.length))
      );

      let cluster = clusters.find(entry => Math.abs(entry.averageOffset - midpointOffset) <= lineOffsetTolerance);
      if (!cluster) {
        cluster = {
          averageOffset: midpointOffset,
          offsetWeightedSum: 0,
          weightSum: 0,
          directionWeightedX: 0,
          directionWeightedY: 0,
          midpointWeightedX: 0,
          midpointWeightedY: 0,
          overlapIntervals: [],
          totalSegmentLength: 0,
          minAbsOffset: Infinity,
          segmentCount: 0,
        };
        clusters.push(cluster);
      }

      cluster.offsetWeightedSum += midpointOffset * segmentWeight;
      cluster.weightSum += segmentWeight;
      cluster.averageOffset = cluster.offsetWeightedSum / Math.max(cluster.weightSum, EPS);
      cluster.directionWeightedX += segmentVector.x * segmentWeight;
      cluster.directionWeightedY += segmentVector.y * segmentWeight;
      cluster.midpointWeightedX += midpoint.x * segmentWeight;
      cluster.midpointWeightedY += midpoint.y * segmentWeight;
      cluster.totalSegmentLength += segmentVector.length;
      cluster.minAbsOffset = Math.min(cluster.minAbsOffset, lineDistanceMid);
      cluster.segmentCount += 1;
      if (overlapLength > EPS) cluster.overlapIntervals.push([overlapStart, overlapEnd]);
    });

    return clusters
      .map(cluster => {
        const coveredIntervals = normalizeIntervals(cluster.overlapIntervals, 0, runLength);
        const overlapLength = measureIntervalCoverage(cluster.overlapIntervals);
        const directionVector = normalizeVector(cluster.directionWeightedX, cluster.directionWeightedY) ||
          { x: runDirection.x, y: runDirection.y };
        const direction = ((directionVector.x * runDirection.x) + (directionVector.y * runDirection.y)) >= 0
          ? { x: directionVector.x, y: directionVector.y }
          : { x: -directionVector.x, y: -directionVector.y };
        const anchorWeight = Math.max(cluster.weightSum, EPS);
        const anchor = {
          x: cluster.midpointWeightedX / anchorWeight,
          y: cluster.midpointWeightedY / anchorWeight,
        };
        const overlapRatio = overlapLength / runLength;
        const normalizedOffset = cluster.minAbsOffset / Math.max(corridor, EPS);
        const normalizedAverageOffset = Math.abs(cluster.averageOffset) / Math.max(corridor, EPS);
        return {
          averageOffset: cluster.averageOffset,
          overlapLength,
          overlapRatio,
          totalSegmentLength: cluster.totalSegmentLength,
          minAbsOffset: cluster.minAbsOffset,
          segmentCount: cluster.segmentCount,
          coveredIntervals,
          line: {
            point: anchor,
            direction,
          },
          score: overlapRatio - (normalizedOffset * 0.3) - (normalizedAverageOffset * 0.1),
        };
      })
      .filter(cluster => cluster.overlapLength > EPS)
      .sort((left, right) => {
        if (Math.abs(right.score - left.score) > 1e-6) return right.score - left.score;
        if (Math.abs(right.overlapRatio - left.overlapRatio) > 0.02) return right.overlapRatio - left.overlapRatio;
        if (Math.abs(left.minAbsOffset - right.minAbsOffset) > lineOffsetTolerance * 0.25) return left.minAbsOffset - right.minAbsOffset;
        return right.totalSegmentLength - left.totalSegmentLength;
      });
  }

  function chooseDominantSupportCluster(run, sourceSegments, params) {
    const clusters = buildRunSupportClusters(run, sourceSegments, params);
    if (!clusters.length) return null;
    const best = clusters[0];
    const shortRun = run.length <= Math.max(params.corridor * 0.75, params.lineOffsetTolerance * 4);
    const minOverlapRatio = shortRun ? 0.15 : 0.25;
    if (best.overlapRatio < minOverlapRatio && best.minAbsOffset > params.lineOffsetTolerance * 1.5) return null;
    return best;
  }

  function buildSourcePathGraph(sourceSegments, tolerance) {
    const snappedSegments = snapSegments(sourceSegments || [], tolerance);
    // Keep reroutes on explicit source connectivity. The more permissive
    // endpoint/segment repair can invent shortcut nodes inside a profile and
    // steer the shell through interior detail instead of the actual outline.
    const graph = buildGraphFromSegments(snappedSegments, tolerance * 2);
    return {
      nodes: graph.nodes || [],
      adjacency: graph.adjacency || new Map(),
    };
  }

  function collectNearestGraphNodeCandidates(graph, point, maxDistance, limit = 6) {
    if (!graph?.nodes?.length || !point || !Number.isFinite(maxDistance) || maxDistance <= EPS) return [];
    const sorted = graph.nodes
      .map((node, index) => ({
        index,
        point: node,
        distance: dist(point, node),
      }))
      .filter(candidate => candidate.distance <= maxDistance)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, limit);
    if (!sorted.length) return sorted;

    const nearestDistance = sorted[0].distance;
    const distanceLimit = Math.min(maxDistance, nearestDistance * 2.5);
    return sorted.filter(candidate => candidate.distance <= distanceLimit + EPS);
  }

  function shortestGraphNodePath(graph, startIndex, endIndex, maxLength = Infinity) {
    const nodes = graph?.nodes || [];
    const adjacency = graph?.adjacency || new Map();
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return null;
    if (!nodes[startIndex] || !nodes[endIndex]) return null;
    if (startIndex === endIndex) {
      return {
        nodeIndices: [startIndex],
        length: 0,
      };
    }

    const distances = new Array(nodes.length).fill(Infinity);
    const previous = new Array(nodes.length).fill(-1);
    const visited = new Set();
    distances[startIndex] = 0;

    while (true) {
      let currentIndex = -1;
      let currentDistance = Infinity;
      for (let index = 0; index < distances.length; index += 1) {
        if (visited.has(index)) continue;
        if (distances[index] >= currentDistance) continue;
        currentIndex = index;
        currentDistance = distances[index];
      }

      if (currentIndex < 0 || !Number.isFinite(currentDistance) || currentDistance > maxLength) break;
      if (currentIndex === endIndex) break;
      visited.add(currentIndex);

      (adjacency.get(currentIndex) || []).forEach(nextIndex => {
        if (visited.has(nextIndex) || !nodes[nextIndex]) return;
        const edgeLength = dist(nodes[currentIndex], nodes[nextIndex]);
        if (!Number.isFinite(edgeLength) || edgeLength <= EPS) return;
        const candidateDistance = currentDistance + edgeLength;
        if (candidateDistance + EPS >= distances[nextIndex]) return;
        distances[nextIndex] = candidateDistance;
        previous[nextIndex] = currentIndex;
      });
    }

    if (!Number.isFinite(distances[endIndex]) || distances[endIndex] > maxLength) return null;

    const nodeIndices = [];
    let cursor = endIndex;
    while (cursor >= 0) {
      nodeIndices.push(cursor);
      if (cursor === startIndex) break;
      cursor = previous[cursor];
    }
    if (nodeIndices[nodeIndices.length - 1] !== startIndex) return null;

    nodeIndices.reverse();
    return {
      nodeIndices,
      length: distances[endIndex],
    };
  }

  function enumerateGraphNodePaths(graph, startIndex, endIndex, maxLength = Infinity, limit = 12) {
    const nodes = graph?.nodes || [];
    const adjacency = graph?.adjacency || new Map();
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return [];
    if (!nodes[startIndex] || !nodes[endIndex]) return [];
    if (startIndex === endIndex) return [{ nodeIndices: [startIndex], length: 0 }];
    if (nodes.length > 48) {
      const shortest = shortestGraphNodePath(graph, startIndex, endIndex, maxLength);
      return shortest ? [shortest] : [];
    }

    const results = [];
    const visited = new Set([startIndex]);
    const path = [startIndex];
    let bestLength = Infinity;

    function pushResult(nodeIndices, length) {
      results.push({ nodeIndices: nodeIndices.slice(), length });
      results.sort((left, right) => left.length - right.length);
      if (results.length > limit) results.length = limit;
      bestLength = Math.min(bestLength, results[0]?.length ?? Infinity);
    }

    function dfs(currentIndex, currentLength) {
      if (currentLength > maxLength + EPS) return;
      const directLowerBound = dist(nodes[currentIndex], nodes[endIndex]);
      if (currentLength + directLowerBound > maxLength + EPS) return;
      if (results.length >= limit && currentLength + directLowerBound > (results[results.length - 1]?.length ?? Infinity) + EPS) {
        return;
      }

      const neighbors = Array.from(adjacency.get(currentIndex) || [])
        .sort((left, right) => dist(nodes[left], nodes[endIndex]) - dist(nodes[right], nodes[endIndex]));
      for (const nextIndex of neighbors) {
        if (visited.has(nextIndex) || !nodes[nextIndex]) continue;
        const edgeLength = dist(nodes[currentIndex], nodes[nextIndex]);
        if (!Number.isFinite(edgeLength) || edgeLength <= EPS) continue;
        const nextLength = currentLength + edgeLength;
        if (nextLength > maxLength + EPS) continue;

        path.push(nextIndex);
        if (nextIndex === endIndex) {
          pushResult(path, nextLength);
          path.pop();
          continue;
        }

        visited.add(nextIndex);
        dfs(nextIndex, nextLength);
        visited.delete(nextIndex);
        path.pop();
      }
    }

    dfs(startIndex, 0);
    return results;
  }

  function distancePointToPolyline(point, polylinePoints) {
    if (!point || !Array.isArray(polylinePoints) || polylinePoints.length < 2) return Infinity;
    let best = Infinity;
    for (let index = 0; index < polylinePoints.length - 1; index += 1) {
      best = Math.min(best, distancePointToSegment(point, polylinePoints[index], polylinePoints[index + 1]));
    }
    return best;
  }

  function computeGuideDeviation(guidePoints, polylinePoints) {
    if (!Array.isArray(guidePoints) || guidePoints.length === 0) return 0;
    if (!Array.isArray(polylinePoints) || polylinePoints.length < 2) return Infinity;
    let total = 0;
    let count = 0;
    guidePoints.forEach(point => {
      if (!point) return;
      const deviation = distancePointToPolyline(point, polylinePoints);
      if (!Number.isFinite(deviation)) return;
      total += deviation;
      count += 1;
    });
    return count ? (total / count) : 0;
  }

  function computeClosedRingDeviation(referenceRing, candidateRing) {
    const reference = closePointRing(referenceRing || []);
    const candidate = closePointRing(candidateRing || []);
    if (reference.length < 4 || candidate.length < 4) return Infinity;

    const referenceOpen = reference.slice(0, -1);
    const candidateOpen = candidate.slice(0, -1);
    let total = 0;
    let count = 0;

    referenceOpen.forEach(point => {
      const deviation = distancePointToPolyline(point, candidate);
      if (!Number.isFinite(deviation)) return;
      total += deviation;
      count += 1;
    });
    candidateOpen.forEach(point => {
      const deviation = distancePointToPolyline(point, reference);
      if (!Number.isFinite(deviation)) return;
      total += deviation;
      count += 1;
    });

    return count ? (total / count) : Infinity;
  }

  function findBestSourceReroute(graph, startPoint, endPoint, options = {}) {
    const maxEndpointDistance = Number.isFinite(options.maxEndpointDistance)
      ? options.maxEndpointDistance
      : Infinity;
    const blockLength = Number.isFinite(options.blockLength) ? options.blockLength : 0;
    const preferredCenter = options.preferredCenter || null;
    const outwardPreference = Number.isFinite(options.outwardPreference)
      ? options.outwardPreference
      : 0;
    const guidePoints = Array.isArray(options.guidePoints) ? options.guidePoints : [];
    const directDistance = dist(startPoint, endPoint);
    const maxCombinedLength = Number.isFinite(options.maxCombinedLength)
      ? options.maxCombinedLength
      : Math.max(blockLength * 2.5, directDistance * 3, maxEndpointDistance * 6);
    const outwardLengthSlack = Number.isFinite(options.outwardLengthSlack)
      ? options.outwardLengthSlack
      : Math.max(maxEndpointDistance * 0.75, directDistance * 0.05);
    const guideLengthSlack = Number.isFinite(options.guideLengthSlack)
      ? options.guideLengthSlack
      : Math.max(maxEndpointDistance, blockLength * 0.12, directDistance * 0.08);

    const startCandidates = collectNearestGraphNodeCandidates(graph, startPoint, maxEndpointDistance);
    const endCandidates = collectNearestGraphNodeCandidates(graph, endPoint, maxEndpointDistance);
    if (!startCandidates.length || !endCandidates.length) return null;

    const viableCandidates = [];
    startCandidates.forEach(startCandidate => {
      endCandidates.forEach(endCandidate => {
        const pathCandidates = enumerateGraphNodePaths(
          graph,
          startCandidate.index,
          endCandidate.index,
          maxCombinedLength,
          12
        );
        pathCandidates.forEach(path => {
          if (!path) return;

          const totalLength = path.length + startCandidate.distance + endCandidate.distance;
          if (totalLength > maxCombinedLength + EPS) return;

          const averagePathRadius = preferredCenter && path.nodeIndices.length
            ? path.nodeIndices.reduce((sum, nodeIndex) => sum + dist(graph.nodes[nodeIndex], preferredCenter), 0) / path.nodeIndices.length
            : 0;
          const maxPathRadius = preferredCenter && path.nodeIndices.length
            ? path.nodeIndices.reduce((maxRadius, nodeIndex) => Math.max(maxRadius, dist(graph.nodes[nodeIndex], preferredCenter)), 0)
            : 0;
          const endpointDistance = startCandidate.distance + endCandidate.distance;
          const pathPoints = path.nodeIndices.map(index => ({
            x: graph.nodes[index].x,
            y: graph.nodes[index].y,
          }));
          const fullPolyline = [startPoint, ...pathPoints, endPoint];
          const guideDeviation = computeGuideDeviation(guidePoints, fullPolyline);
          const score = totalLength +
            (endpointDistance * 0.5) +
            guideDeviation -
            (averagePathRadius * outwardPreference);
          viableCandidates.push({
            score,
            totalLength,
            pathLength: path.length,
            startDistance: startCandidate.distance,
            endDistance: endCandidate.distance,
            endpointDistance,
            nodeIndices: path.nodeIndices,
            averagePathRadius,
            maxPathRadius,
            guideDeviation,
          });
        });
      });
    });

    if (!viableCandidates.length) return null;

    const lengthOrdered = viableCandidates
      .slice()
      .sort((left, right) => {
        if (Math.abs(left.totalLength - right.totalLength) > 1e-6) return left.totalLength - right.totalLength;
        if (Math.abs(left.endpointDistance - right.endpointDistance) > 1e-6) return left.endpointDistance - right.endpointDistance;
        return left.pathLength - right.pathLength;
      });
    const shortestTotalLength = lengthOrdered[0].totalLength;
    const outwardCandidates = preferredCenter && outwardPreference > 0
      ? lengthOrdered.filter(candidate => candidate.totalLength <= shortestTotalLength + outwardLengthSlack + EPS)
      : lengthOrdered;
    const guideCandidates = guidePoints.length
      ? outwardCandidates.filter(candidate => candidate.totalLength <= shortestTotalLength + guideLengthSlack + EPS)
      : outwardCandidates;
    const best = guideCandidates
      .slice()
      .sort((left, right) => {
        if (guidePoints.length && Math.abs(left.guideDeviation - right.guideDeviation) > 1e-6) {
          return left.guideDeviation - right.guideDeviation;
        }
        if (preferredCenter && outwardPreference > 0) {
          if (Math.abs(right.averagePathRadius - left.averagePathRadius) > 1e-6) {
            return right.averagePathRadius - left.averagePathRadius;
          }
          if (Math.abs(right.maxPathRadius - left.maxPathRadius) > 1e-6) {
            return right.maxPathRadius - left.maxPathRadius;
          }
        }
        if (Math.abs(left.totalLength - right.totalLength) > 1e-6) return left.totalLength - right.totalLength;
        if (Math.abs(left.endpointDistance - right.endpointDistance) > 1e-6) return left.endpointDistance - right.endpointDistance;
        if (Math.abs(left.score - right.score) > 1e-6) return left.score - right.score;
        return left.pathLength - right.pathLength;
      })[0];

    if (!best) return null;
    return {
      ...best,
      points: best.nodeIndices.map(index => ({
        x: graph.nodes[index].x,
        y: graph.nodes[index].y,
      })),
    };
  }

  function countRingSelfIntersections(points, tolerance = LOOP_TOLERANCE * 8) {
    const ring = closePointRing(points || []);
    if (ring.length < 5) return 0;
    let intersections = 0;

    for (let index = 0; index < ring.length - 1; index += 1) {
      const aStart = ring[index];
      const aEnd = ring[index + 1];
      if (!aStart || !aEnd || dist(aStart, aEnd) <= EPS) continue;

      for (let otherIndex = index + 1; otherIndex < ring.length - 1; otherIndex += 1) {
        if (Math.abs(index - otherIndex) <= 1) continue;
        if (index === 0 && otherIndex === ring.length - 2) continue;

        const bStart = ring[otherIndex];
        const bEnd = ring[otherIndex + 1];
        if (!bStart || !bEnd || dist(bStart, bEnd) <= EPS) continue;

        const hit = segmentIntersectionPoint(aStart, aEnd, bStart, bEnd, tolerance);
        if (hit) intersections += 1;
      }
    }

    return intersections;
  }

  function rotateRingToMinimizeIntersections(points, samePointFn, tolerance = LOOP_TOLERANCE * 8) {
    const ring = closePointRing(points || []);
    if (ring.length < 5) return ring;

    let bestRing = ring;
    let bestIntersectionCount = countRingSelfIntersections(ring, tolerance);
    let bestClosureLength = dist(ring[ring.length - 2], ring[0]);

    for (let startIndex = 1; startIndex < ring.length - 1; startIndex += 1) {
      const rotatedOpen = [...ring.slice(startIndex, -1), ...ring.slice(0, startIndex)];
      const rotated = closePointRing(rotatedOpen);
      if (rotated.length < 4) continue;

      const intersectionCount = countRingSelfIntersections(rotated, tolerance);
      const closureLength = dist(rotated[rotated.length - 2], rotated[0]);
      if (intersectionCount > bestIntersectionCount) continue;

      if (intersectionCount < bestIntersectionCount ||
          closureLength + tolerance < bestClosureLength) {
        bestRing = rotated;
        bestIntersectionCount = intersectionCount;
        bestClosureLength = closureLength;
        if (bestIntersectionCount === 0 && bestClosureLength <= tolerance) break;
      }
    }

    const deduped = [];
    bestRing.slice(0, -1).forEach(point => {
      const previous = deduped[deduped.length - 1];
      if (previous && samePointFn(previous, point, tolerance)) return;
      deduped.push(point);
    });
    return closePointRing(deduped);
  }

  function trimClosureTail(points, samePointFn, tolerance = LOOP_TOLERANCE * 8) {
    let open = closePointRing(points || []).slice(0, -1);
    if (open.length < 4) return closePointRing(open);

    let changed = true;
    while (changed && open.length >= 4) {
      changed = false;
      const first = open[0];
      const second = open[1];
      const last = open[open.length - 1];
      const penultimate = open[open.length - 2];

      if (first && second && last &&
          pointOnSegment(last, first, second, tolerance) &&
          !samePointFn(last, first, tolerance) &&
          !samePointFn(last, second, tolerance)) {
        open = open.slice(1);
        changed = true;
        continue;
      }

      if (first && penultimate && last &&
          pointOnSegment(first, penultimate, last, tolerance) &&
          !samePointFn(first, last, tolerance) &&
          !samePointFn(first, penultimate, tolerance)) {
        open = open.slice(0, -1);
        changed = true;
      }
    }

    return closePointRing(open);
  }

  function reconstructCornerPoint(prevSupport, nextSupport, fallbackPoint, maxShift) {
    let candidate = null;
    if (prevSupport?.line && nextSupport?.line) candidate = lineIntersection(prevSupport.line, nextSupport.line);
    if (!candidate && nextSupport?.line) candidate = projectPointToLine(fallbackPoint, nextSupport.line);
    if (!candidate && prevSupport?.line) candidate = projectPointToLine(fallbackPoint, prevSupport.line);
    if (!candidate) return { x: fallbackPoint.x, y: fallbackPoint.y };

    if (dist(candidate, fallbackPoint) <= maxShift) return candidate;

    const fallbackProjections = [
      prevSupport?.line ? projectPointToLine(fallbackPoint, prevSupport.line) : null,
      nextSupport?.line ? projectPointToLine(fallbackPoint, nextSupport.line) : null,
    ]
      .filter(Boolean)
      .sort((left, right) => dist(left, fallbackPoint) - dist(right, fallbackPoint));

    if (fallbackProjections.length && dist(fallbackProjections[0], fallbackPoint) <= maxShift) {
      return fallbackProjections[0];
    }

    return { x: fallbackPoint.x, y: fallbackPoint.y };
  }

  function reconstructShellWithSourceSegments(shellPoints, sourceSegments, tolerance, closePointRingFn, samePointFn, pathSegments) {
    const ring = closePointRingFn(normalizeWindingCCW(shellPoints || []));
    if (ring.length < 4) {
      return {
        polygonPoints: ring,
        sourceBackedPerimeterRatio: 0,
        sourceBackedSupportDebug: {
          selectedStrategy: null,
          fallbackTriggered: false,
          runCount: 0,
          supportedRunCount: 0,
          backedPerimeter: 0,
          totalPerimeter: 0,
          selectedRunDiagnostics: [],
          reroutedBlocks: [],
          attemptedStrategies: [],
        },
      };
    }

    const sourceBBox = computeSegmentsBBox(sourceSegments);
    const shellBBox = ringBBox(ring);
    const span = bboxSpan(sourceBBox || shellBBox);
    const corridor = Math.max(tolerance * 24, span * 0.015);
    const endpointExtensionLimit = Math.max(tolerance * 48, span * 0.04);
    const dedupeTolerance = Math.max(tolerance * 4, corridor * 0.08);
    const simplifyTolerance = Math.max(tolerance * 6, corridor * 0.03);
    const mergeTolerance = Math.max(tolerance * 16, simplifyTolerance * 0.75);
    const extensionSlack = Math.max(corridor * 0.8, endpointExtensionLimit);
    const lineOffsetTolerance = Math.max(tolerance * 32, corridor * 0.08);
    const interiorTolerance = Math.max(tolerance * 16, corridor * 0.06);
    const maxCornerShift = Math.max(endpointExtensionLimit, corridor * 0.9);
    const rerouteEndpointDistance = Math.max(tolerance * 36, endpointExtensionLimit * 0.75, corridor * 0.25);
    const rerouteAnchorSnapDistance = Math.max(
      tolerance * 8,
      corridor * 0.1,
      endpointExtensionLimit * 0.2
    );
    const reroutePreferenceCenter = ringCenter(ring) || bboxCenter(sourceBBox || shellBBox);
    const sourcePathGraph = buildSourcePathGraph(
      Array.isArray(pathSegments) && pathSegments.length ? pathSegments : sourceSegments,
      tolerance
    );

    function clonePoint(point) {
      return { x: point.x, y: point.y };
    }

    function pushPoint(points, point) {
      if (!point) return;
      if (!points.length || !samePointFn(points[points.length - 1], point, dedupeTolerance)) {
        points.push(clonePoint(point));
      }
    }

    function serializeRunIntervals(run, intervals) {
      return normalizeIntervals(intervals, 0, run.length).map(([start, end]) => ({
        scalarStart: start,
        scalarEnd: end,
        ratioStart: run.length > EPS ? (start / run.length) : 0,
        ratioEnd: run.length > EPS ? (end / run.length) : 0,
        length: end - start,
        startPoint: pointOnLine(run.start, run.direction, start),
        endPoint: pointOnLine(run.start, run.direction, end),
      }));
    }

    function reconstructWithRuns(runs, strategy, options = {}) {
      if (!Array.isArray(runs) || runs.length < 3) return null;
      const useSourceReroute = options.useSourceReroute !== false;

      const reconstructed = [];
      let totalPerimeter = 0;
      let backedPerimeter = 0;
      let supportedRunCount = 0;

      const runSupports = runs.map(run => chooseDominantSupportCluster(run, sourceSegments, supportParams));
      runs.forEach((run, index) => {
        totalPerimeter += run.length;
        const support = runSupports[index];
        if (!support) return;
        supportedRunCount += 1;
        backedPerimeter += Math.min(run.length, support.overlapLength || 0);
      });

      let contourOffset = 0;
      const runDiagnostics = runs.map((run, index) => {
        const support = runSupports[index];
        const supportedLength = Math.min(run.length, support?.overlapLength || 0);
        const coveredIntervals = support?.coveredIntervals || [];
        const uncoveredIntervals = invertIntervals(coveredIntervals, 0, run.length);
        const diagnostic = {
          runIndex: index,
          startIndex: run.startIndex,
          endIndex: run.endIndex,
          startPoint: clonePoint(run.start),
          endPoint: clonePoint(run.end),
          length: run.length,
          contourStartLength: contourOffset,
          contourEndLength: contourOffset + run.length,
          supported: !!support,
          supportedLength,
          supportedRatio: run.length > EPS ? (supportedLength / run.length) : 0,
          unsupportedLength: Math.max(0, run.length - supportedLength),
          unsupportedRatio: run.length > EPS ? Math.max(0, 1 - (supportedLength / run.length)) : 0,
          averageOffset: support?.averageOffset ?? null,
          minAbsOffset: support?.minAbsOffset ?? null,
          supportScore: support?.score ?? null,
          supportSegmentCount: support?.segmentCount ?? 0,
          backedRanges: serializeRunIntervals(run, coveredIntervals),
          unbackedRanges: serializeRunIntervals(run, uncoveredIntervals),
        };
        contourOffset += run.length;
        return diagnostic;
      }).map(diagnostic => ({
        ...diagnostic,
        contourStartRatio: totalPerimeter > EPS ? (diagnostic.contourStartLength / totalPerimeter) : 0,
        contourEndRatio: totalPerimeter > EPS ? (diagnostic.contourEndLength / totalPerimeter) : 0,
      }));

      const corners = runs.map((run, index) => {
        const nextIndex = (index + 1) % runs.length;
        const fallbackCorner = ring[run.endIndex];
        return reconstructCornerPoint(
          runSupports[index],
          runSupports[nextIndex],
          fallbackCorner,
          maxCornerShift
        );
      });
      const rerouteDiagnostics = [];
      const firstSupportedIndex = runSupports.findIndex(Boolean);

      if (firstSupportedIndex < 0 || supportedRunCount < 2 || !sourcePathGraph.nodes.length) {
        corners.forEach(point => pushPoint(reconstructed, point));
      } else {
        pushPoint(reconstructed, corners[(firstSupportedIndex - 1 + runs.length) % runs.length]);
        let processed = 0;

        while (processed < runs.length) {
          const runIndex = (firstSupportedIndex + processed) % runs.length;
          if (runSupports[runIndex]) {
            pushPoint(reconstructed, corners[runIndex]);
            processed += 1;
            continue;
          }

          const blockIndices = [];
          let blockLength = 0;
          while (processed + blockIndices.length < runs.length) {
            const candidateIndex = (firstSupportedIndex + processed + blockIndices.length) % runs.length;
            if (runSupports[candidateIndex]) break;
            blockIndices.push(candidateIndex);
            blockLength += runs[candidateIndex].length;
          }

          if (!blockIndices.length) {
            processed += 1;
            continue;
          }

          const blockEndIndex = blockIndices[blockIndices.length - 1];
          const blockEndPoint = corners[blockEndIndex];
          const guidePoints = [];
          const guideSeen = [];
          const pushGuidePoint = point => {
            if (!point) return;
            if (guideSeen.some(existing => samePointFn(existing, point, dedupeTolerance))) return;
            guideSeen.push(point);
            guidePoints.push(clonePoint(point));
          };
          pushGuidePoint(reconstructed[reconstructed.length - 1]);
          blockIndices.forEach(index => {
            const run = runs[index];
            pushGuidePoint(run?.start);
            pushGuidePoint(run?.end);
            pushGuidePoint(ring[run?.endIndex]);
          });
          pushGuidePoint(blockEndPoint);
          const reroute = useSourceReroute
            ? findBestSourceReroute(
              sourcePathGraph,
              reconstructed[reconstructed.length - 1],
              blockEndPoint,
              {
                maxEndpointDistance: rerouteEndpointDistance,
                blockLength,
                preferredCenter: reroutePreferenceCenter,
                outwardPreference: 0.5,
                outwardLengthSlack: Math.max(rerouteEndpointDistance * 0.75, blockLength * 0.08),
                guideLengthSlack: Math.max(rerouteEndpointDistance, blockLength * 0.15),
                guidePoints,
              }
            )
            : null;

          if (reroute && useSourceReroute) {
            const reroutePoints = Array.isArray(reroute.points) ? reroute.points.slice() : [];
            const currentPoint = reconstructed[reconstructed.length - 1] || null;
            const firstReroutePoint = reroutePoints[0] || null;
            const finalReroutePoint = reroutePoints[reroutePoints.length - 1] || null;
            const shouldReplaceCurrentPoint = currentPoint &&
              firstReroutePoint &&
              dist(currentPoint, firstReroutePoint) <= rerouteAnchorSnapDistance;

            if (shouldReplaceCurrentPoint) reconstructed.pop();
            reroutePoints.forEach(point => pushPoint(reconstructed, point));

            const shouldAppendBlockEndPoint = !finalReroutePoint ||
              dist(finalReroutePoint, blockEndPoint) > rerouteAnchorSnapDistance;
            if (shouldAppendBlockEndPoint) pushPoint(reconstructed, blockEndPoint);
            rerouteDiagnostics.push({
              startRunIndex: blockIndices[0],
              endRunIndex: blockEndIndex,
              runCount: blockIndices.length,
              blockLength,
              applied: true,
              mode: 'graph-reroute',
              pathPointCount: reroute.points.length,
              pathLength: reroute.pathLength,
              totalLength: reroute.totalLength,
              startDistance: reroute.startDistance,
              endDistance: reroute.endDistance,
            });
          } else if (!useSourceReroute) {
            blockIndices.forEach(index => {
              pushPoint(reconstructed, ring[runs[index].endIndex]);
            });
            rerouteDiagnostics.push({
              startRunIndex: blockIndices[0],
              endRunIndex: blockEndIndex,
              runCount: blockIndices.length,
              blockLength,
              applied: false,
              mode: 'shell-guided',
              pathPointCount: blockIndices.length,
              pathLength: blockLength,
              totalLength: blockLength,
              startDistance: 0,
              endDistance: 0,
            });
          } else {
            blockIndices.forEach(index => pushPoint(reconstructed, corners[index]));
            rerouteDiagnostics.push({
              startRunIndex: blockIndices[0],
              endRunIndex: blockEndIndex,
              runCount: blockIndices.length,
              blockLength,
              applied: false,
              mode: 'corner-fallback',
              pathPointCount: 0,
              pathLength: null,
              totalLength: null,
              startDistance: null,
              endDistance: null,
            });
          }

          processed += blockIndices.length;
        }
      }

      const simplified = simplifyCollinearRing(
        reconstructed,
        simplifyTolerance,
        closePointRingFn,
        (left, right, eps) => samePointFn(left, right, Math.max(eps || 0, dedupeTolerance))
      );
      const trimmed = trimClosureTail(
        simplified,
        samePointFn,
        dedupeTolerance
      );
      const normalized = rotateRingToMinimizeIntersections(
        trimmed,
        samePointFn,
        dedupeTolerance
      );

      return {
        strategy,
        polygonPoints: normalized.length >= 4 ? normalized : ring,
        runCount: runs.length,
        supportedRunCount,
        backedPerimeter,
        totalPerimeter,
        sourceBackedPerimeterRatio: totalPerimeter > EPS ? (backedPerimeter / totalPerimeter) : 0,
        runDiagnostics,
        rerouteDiagnostics,
        shellDeviation: computeClosedRingDeviation(ring, normalized.length >= 4 ? normalized : ring),
      };
    }

    const supportParams = {
      corridor,
      extensionSlack,
      lineOffsetTolerance,
      interiorTolerance,
    };
    const attempts = [];
    const primaryRuns = buildShellRuns(ring, mergeTolerance);
    const primaryAttempt = reconstructWithRuns(primaryRuns, 'merged');
    if (primaryAttempt) attempts.push(primaryAttempt);
    const guidedAttempt = reconstructWithRuns(primaryRuns, 'guided-shell', { useSourceReroute: false });
    if (guidedAttempt) attempts.push(guidedAttempt);

    const shouldRetryWithFinerRuns = !primaryAttempt ||
      primaryAttempt.supportedRunCount === 0 ||
      primaryAttempt.sourceBackedPerimeterRatio < 0.05;

    if (shouldRetryWithFinerRuns) {
      const fineMergeTolerance = Math.max(tolerance * 6, simplifyTolerance * 0.35);
      if (fineMergeTolerance + EPS < mergeTolerance) {
        const fineRuns = buildShellRuns(ring, fineMergeTolerance);
        const fineAttempt = reconstructWithRuns(fineRuns, 'fine-merged');
        if (fineAttempt && fineAttempt.runCount !== (primaryAttempt?.runCount || 0)) attempts.push(fineAttempt);
      }

      const rawEdgeRuns = buildShellEdgeRuns(ring);
      const rawEdgeAttempt = reconstructWithRuns(rawEdgeRuns, 'raw-edges');
      if (rawEdgeAttempt && rawEdgeAttempt.runCount !== (primaryAttempt?.runCount || 0)) attempts.push(rawEdgeAttempt);
    }

    const strategyPriority = {
      merged: 0,
      'fine-merged': 1,
      'raw-edges': 2,
    };
    const winner = attempts
      .slice()
      .sort((left, right) => {
        if (Math.abs((right.sourceBackedPerimeterRatio || 0) - (left.sourceBackedPerimeterRatio || 0)) > 1e-6) {
          return (right.sourceBackedPerimeterRatio || 0) - (left.sourceBackedPerimeterRatio || 0);
        }
        if ((right.supportedRunCount || 0) !== (left.supportedRunCount || 0)) {
          return (right.supportedRunCount || 0) - (left.supportedRunCount || 0);
        }
        if (Math.abs((right.backedPerimeter || 0) - (left.backedPerimeter || 0)) > 1e-6) {
          return (right.backedPerimeter || 0) - (left.backedPerimeter || 0);
        }
        if (Math.abs((left.shellDeviation || 0) - (right.shellDeviation || 0)) > 1e-6) {
          return (left.shellDeviation || 0) - (right.shellDeviation || 0);
        }
        return (strategyPriority[left.strategy] ?? 99) - (strategyPriority[right.strategy] ?? 99);
      })[0];

    const sourceBackedSupportDebug = {
      selectedStrategy: winner?.strategy || null,
      fallbackTriggered: shouldRetryWithFinerRuns,
      runCount: winner?.runCount ?? 0,
      supportedRunCount: winner?.supportedRunCount ?? 0,
      backedPerimeter: winner?.backedPerimeter ?? 0,
      totalPerimeter: winner?.totalPerimeter ?? 0,
      selectedRunDiagnostics: winner?.runDiagnostics || [],
      reroutedBlocks: winner?.rerouteDiagnostics || [],
      attemptedStrategies: attempts.map(attempt => ({
        strategy: attempt.strategy,
        runCount: attempt.runCount,
        supportedRunCount: attempt.supportedRunCount,
        backedPerimeter: attempt.backedPerimeter,
        totalPerimeter: attempt.totalPerimeter,
        sourceBackedPerimeterRatio: attempt.sourceBackedPerimeterRatio,
        polygonPointCount: attempt.polygonPoints?.length || 0,
        reroutedBlockCount: attempt.rerouteDiagnostics?.filter(entry => entry.applied).length || 0,
        shellDeviation: attempt.shellDeviation ?? null,
      })),
    };

    if (!winner) {
      return {
        polygonPoints: ring,
        sourceBackedPerimeterRatio: 0,
        sourceBackedSupportDebug,
      };
    }

    return {
      polygonPoints: winner.polygonPoints,
      sourceBackedPerimeterRatio: winner.sourceBackedPerimeterRatio,
      sourceBackedSupportDebug,
    };
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

  function bboxCenter(bbox) {
    if (!bbox) return null;
    return {
      x: (bbox.minX + bbox.maxX) * 0.5,
      y: (bbox.minY + bbox.maxY) * 0.5,
    };
  }

  function buildSeedProbePoints(points, tolerance) {
    const ring = closePointRing(points || []);
    if (ring.length < 4) return [];
    const core = ring.slice(0, -1);
    const bbox = ringBBox(ring);
    const candidates = [
      interiorPoint(core),
      bboxCenter(bbox),
      ringCenter(ring),
    ];

    for (let i = 0; i < core.length; i++) {
      const a = core[i];
      const b = core[(i + 1) % core.length];
      const c = core[(i + 2) % core.length];
      candidates.push({
        x: (a.x + b.x + c.x) / 3,
        y: (a.y + b.y + c.y) / 3,
      });
    }

    const valid = [];
    candidates.forEach(point => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      if (!pointInsideRing(ring, point)) return;
      if (valid.some(existing => samePoint(existing, point, tolerance * 4))) return;
      valid.push(point);
    });
    return valid;
  }

  function pointInsideRing(points, point) {
    const ring = closePointRing(points || []);
    const bbox = ringBBox(ring);
    if (!ring.length || !bbox || !point || !bboxContainsPoint(bbox, point, LOOP_TOLERANCE * 12)) return false;
    return pointInPoly(point.x, point.y, ring);
  }

  function bboxExtendsBeyond(baseBBox, candidateBBox, tolerance) {
    if (!baseBBox || !candidateBBox) return false;
    return candidateBBox.minX < baseBBox.minX - tolerance ||
      candidateBBox.maxX > baseBBox.maxX + tolerance ||
      candidateBBox.minY < baseBBox.minY - tolerance ||
      candidateBBox.maxY > baseBBox.maxY + tolerance;
  }

  function segmentsTouch(segmentsA, segmentsB, tolerance) {
    if (!segmentsA?.length || !segmentsB?.length) return false;
    for (const [a1, a2] of segmentsA) {
      for (const [b1, b2] of segmentsB) {
        if (pointOnSegment(a1, b1, b2, tolerance) ||
            pointOnSegment(a2, b1, b2, tolerance) ||
            pointOnSegment(b1, a1, a2, tolerance) ||
            pointOnSegment(b2, a1, a2, tolerance) ||
            segmentIntersectionPoint(a1, a2, b1, b2, tolerance * 2)) {
          return true;
        }
      }
    }
    return false;
  }

  function segmentsBridgeableByEndpoints(segmentsA, segmentsB, maxGap) {
    if (!segmentsA?.length || !segmentsB?.length || !Number.isFinite(maxGap) || maxGap <= EPS) return false;
    for (const [a1, a2] of segmentsA) {
      for (const [b1, b2] of segmentsB) {
        if (dist(a1, b1) <= maxGap ||
            dist(a1, b2) <= maxGap ||
            dist(a2, b1) <= maxGap ||
            dist(a2, b2) <= maxGap) {
          return true;
        }
      }
    }
    return false;
  }

  function findAttachedOpenEntities(shapeRecord, seedPoints, tolerance, entityToPathPoints, isRenderableEntity) {
    const seedBBox = ringBBox(seedPoints);
    const seedConnectionLimit = computeBridgeLengthLimit(seedBBox, tolerance, {
      toleranceFactor: 80,
      spanRatio: 0.02,
      minAbsolute: 24,
      maxAbsolute: 32,
    });
    const seedSegments = [];
    for (let i = 0; i < seedPoints.length - 1; i++) {
      if (dist(seedPoints[i], seedPoints[i + 1]) <= EPS) continue;
      seedSegments.push([seedPoints[i], seedPoints[i + 1]]);
    }
    const openEntities = (shapeRecord?.openEntities || []).filter(isRenderableEntity);
    const candidates = openEntities
      .map(entity => {
        const box = entityBBox(entity);
        const pathPoints = entityToPathPoints(entity, true);
        const segments = buildEntitySegments(entity, tolerance, entityToPathPoints);
        if (!box || !pathPoints.length || !segments.length) return null;
        return { entity, box, pathPoints, segments };
      })
      .filter(Boolean)
      .filter(entry => !seedBBox || bboxGap(seedBBox, entry.box) <= seedConnectionLimit);

    const attached = [];
    const attachedSegments = [];
    let attachedBBox = seedBBox || null;
    const pending = candidates.slice();

    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      const touchesSeed = segmentsTouch(entry.segments, seedSegments, tolerance * 8);
      const bridgeableToSeed = !touchesSeed && segmentsBridgeableByEndpoints(entry.segments, seedSegments, seedConnectionLimit);
      if (!touchesSeed && !bridgeableToSeed) continue;
      if (!bboxExtendsBeyond(seedBBox, entry.box, tolerance)) continue;
      pending.splice(i, 1);
      attached.push(entry);
      attachedSegments.push(...entry.segments);
      attachedBBox = unionBBox(attachedBBox, entry.box);
    }

    let changed = true;
    while (changed && pending.length) {
      changed = false;
      const referenceSegments = [...seedSegments, ...attachedSegments];
      const referenceConnectionLimit = computeBridgeLengthLimit(attachedBBox || seedBBox, tolerance, {
        toleranceFactor: 80,
        spanRatio: 0.02,
        minAbsolute: 24,
        maxAbsolute: 32,
      });
      for (let i = pending.length - 1; i >= 0; i--) {
        const entry = pending[i];
        const touchesReference = segmentsTouch(entry.segments, referenceSegments, tolerance * 8);
        const bridgeableToReference = !touchesReference &&
          segmentsBridgeableByEndpoints(entry.segments, referenceSegments, referenceConnectionLimit);
        if (!touchesReference && !bridgeableToReference) continue;
        const nearAttached = !attachedBBox || bboxGap(attachedBBox, entry.box) <= referenceConnectionLimit;
        const expandsSeed = bboxExtendsBeyond(seedBBox, entry.box, tolerance);
        if (!nearAttached && !expandsSeed) continue;
        pending.splice(i, 1);
        attached.push(entry);
        attachedSegments.push(...entry.segments);
        attachedBBox = unionBBox(attachedBBox, entry.box);
        changed = true;
      }
    }

    return attached.map(entry => entry.entity);
  }

  function buildLocalGraph(seedPoints, attachedEntities, tolerance, entityToPathPoints) {
    const ring = closePointRing(seedPoints);
    const contourSegments = [];
    for (let i = 0; i < ring.length - 1; i++) contourSegments.push([ring[i], ring[i + 1]]);
    const attachedSegments = attachedEntities.flatMap(entity => buildEntitySegments(entity, tolerance, entityToPathPoints));
    const combinedSegments = [...contourSegments, ...attachedSegments];
    const snappedSegments = snapSegments(combinedSegments, tolerance);
    const repaired = repairEndpointToSegment(snappedSegments, tolerance * 1.5);
    let graphBBox = ringBBox(ring);
    attachedEntities.forEach(entity => {
      graphBBox = unionBBox(graphBBox, entityBBox(entity));
    });
    const bridges = buildEndpointBridges(repaired.segments, graphBBox, tolerance, {
      spanRatio: 0.02,
      minAbsolute: 24,
      maxAbsolute: 32,
    });
    const bridgedSegments = [...repaired.segments, ...bridges.bridges];
    const splitSegments = splitSegmentsAtIntersections(bridgedSegments, tolerance);
    return buildGraphFromSegments(splitSegments, tolerance * 4);
  }

  function rankParentBuilderCycles({ cycles, shapeRecord, seedPoints, tolerance, parentContourId, attachedIds, scorePolygonCoverage }) {
    const seedProbes = buildSeedProbePoints(seedPoints, tolerance);
    const seedArea = Math.abs(polygonSignedArea(seedPoints.slice(0, -1)));
    return (cycles || [])
      .map(points => {
        const ring = closePointRing(normalizeWindingCCW(points));
        const coverage = scorePolygonCoverage({ polygonPoints: ring }, shapeRecord.entities || []);
        const enclosesSeed = seedProbes.length
          ? seedProbes.some(point => pointInsideRing(ring, point))
          : false;
        const area = Math.abs(polygonSignedArea(ring.slice(0, -1)));
        const areaGain = seedArea > EPS ? (area / seedArea) : 1;
        return {
          candidate: {
            polygonPoints: ring,
            source: 'parent-extended',
            tolerance,
            seedContourId: parentContourId || null,
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
  }

  global.NestDxfOpenBuilderHelpers = {
    buildEntitySegments,
    ringCenter,
    pointInsideRing,
    snapSegments,
    repairEndpointToSegment,
    buildEndpointBridges,
    findAttachedOpenEntities,
    buildLocalGraph,
    rankParentBuilderCycles,
  };
})(window);
