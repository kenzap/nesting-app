(function attachNestDxfContourDetectionIntersectionService(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };
  const contourHelpers = global.NestDxfContourHelpers || {};
  // Flatten is loaded globally in this app via the UMD bundle.
  const flatten = global.Flatten || global['@flatten-js/core']
    || (typeof require === 'function' ? require('flatten-js') : null);

  if (!geometry || !flatten) {
    global.NestDxfContourDetectionIntersectionService = {
      buildIntersectionContour() {
        return contourHelpers.emptyContourResult
          ? contourHelpers.emptyContourResult('missing-deps')
          : {
              polygonPoints: null,
              source: null,
              coverage: null,
              rankedCandidates: [],
              builderMode: 'missing-deps',
              builderDebug: null,
            };
      },
    };
    return;
  }

  const {
    EPS,
    dist,
    closePointRing,
    polygonSignedArea,
    pointOnSegment,
    segmentsIntersect,
  } = geometry;

  const {
    emptyContourResult,
    computeEntitiesBBox,
    bboxSpan,
    compareContourCandidatesByGeometry,
  } = contourHelpers;

  // ----------------------------------------------------------------------
  // Helper: convert DXF entity to flatten-js shape
  // ----------------------------------------------------------------------
  function entityToFlattenShape(entity) {
    if (!entity) return null;
    switch (entity.type) {
      case 'LINE': {
        const start = entity.start || entity.vertices?.[0];
        const end = entity.end || entity.vertices?.[1];
        if (!start || !end) return null;
        return new flatten.Segment(
          new flatten.Point(start.x, start.y),
          new flatten.Point(end.x, end.y)
        );
      }
      case 'ARC': {
        const center = entity.center;
        const radius = entity.radius;
        const startAngle = entity.startAngle || 0;
        const endAngle = entity.endAngle || 0;
        // flatten.Arc expects start and end angles in radians, counter‑clockwise
        return new flatten.Arc(
          new flatten.Point(center.x, center.y),
          radius,
          startAngle,
          endAngle,
          true // ccw
        );
      }
      case 'CIRCLE':
        return new flatten.Circle(
          new flatten.Point(entity.center.x, entity.center.y),
          entity.radius
        );
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const vertices = entity.vertices || [];
        const closed = entity.closed !== false;
        if (vertices.length < 2) return null;
        const points = vertices.map(v => new flatten.Point(v.x, v.y));
        return new flatten.Polyline(points, closed);
      }
      // For SPLINE and ELLIPSE, approximate with a polyline using your existing samplers
      default:
        return null;
    }
  }

  // ----------------------------------------------------------------------
  // Step 1: collect all shapes, split at intersections
  // ----------------------------------------------------------------------
  function splitAtIntersections(shapes, tolerance) {
    // We'll store resulting non‑intersecting edges as flatten.Segment
    const edges = [];

    console.log("splitAtIntersections", shapes)

    // Prepare all possible intersection pairs
    for (let i = 0; i < shapes.length; i++) {
      const s1 = shapes[i];
      if (!s1) continue;
      // Split s1 against all shapes j > i and also against itself? No.
      // Instead, we'll collect all intersection points on s1, then split s1.
      const intersectionPoints = [];

      for (let j = 0; j < shapes.length; j++) {
        if (i === j) continue;
        const s2 = shapes[j];
        if (!s2) continue;
        const intersections = s1.intersect(s2);
        if (intersections && intersections.length) {
          intersections.forEach(ip => {
            if (ip instanceof flatten.Point) {
              intersectionPoints.push(ip);
            } else if (ip instanceof flatten.Segment) {
              // Intersection is a segment (overlap) – handle by adding endpoints
              intersectionPoints.push(ip.start, ip.end);
            }
          });
        }
      }

      // Remove duplicate points (within tolerance)
      const uniquePoints = [];
      intersectionPoints.forEach(p => {
        if (!uniquePoints.some(ex => ex.distanceTo(p) < tolerance)) {
          uniquePoints.push(p);
        }
      });

      // Split the shape at these points
      if (s1 instanceof flatten.Segment) {
        const pts = [s1.start, ...uniquePoints, s1.end].sort((a,b) => {
          const da = s1.start.distanceTo(a);
          const db = s1.start.distanceTo(b);
          return da - db;
        });
        for (let k = 0; k < pts.length - 1; k++) {
          const seg = new flatten.Segment(pts[k], pts[k+1]);
          if (seg.length > tolerance) edges.push(seg);
        }
      } else if (s1 instanceof flatten.Arc) {
        // For arc, we need to split by angle parameter
        const angles = uniquePoints.map(p => s1.angleToPoint(p)).filter(a => a !== null);
        angles.sort((a,b) => a - b);
        let startAngle = s1.startAngle;
        for (let ang of angles) {
          if (Math.abs(ang - startAngle) < tolerance) continue;
          const arc = new flatten.Arc(s1.center, s1.radius, startAngle, ang, s1.clockwise === false);
          if (arc.length > tolerance) edges.push(arc);
          startAngle = ang;
        }
        const lastArc = new flatten.Arc(s1.center, s1.radius, startAngle, s1.endAngle, s1.clockwise === false);
        if (lastArc.length > tolerance) edges.push(lastArc);
      } else if (s1 instanceof flatten.Circle) {
        // Circle: no start/end, we split by creating arcs from intersection points
        const angles = uniquePoints.map(p => Math.atan2(p.y - s1.center.y, p.x - s1.center.x));
        angles.sort((a,b) => a - b);
        if (angles.length === 0) {
          edges.push(s1);
        } else {
          for (let k = 0; k < angles.length; k++) {
            const start = angles[k];
            const end = angles[(k+1) % angles.length];
            if (Math.abs(end - start) < tolerance) continue;
            const arc = new flatten.Arc(s1.center, s1.radius, start, end, true);
            if (arc.length > tolerance) edges.push(arc);
          }
        }
      } else {
        // For polylines, we can flatten to segments and handle recursively
        // (simplification: treat polyline as list of segments)
        const segments = s1.toSegments();
        segments.forEach(seg => {
          const segSplit = splitAtIntersections([seg], tolerance);
          edges.push(...segSplit);
        });
      }
    }

    return edges;
  }

  // ----------------------------------------------------------------------
  // Step 2: build graph from edges (adjacency list)
  // ----------------------------------------------------------------------
  function buildGraph(edges, tolerance) {
    const vertices = [];
    const adj = new Map(); // key: point string, value: array of {toPoint, edge, fromPoint}

    function pointKey(p) {
      return `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    }

    edges.forEach(edge => {
      let start = edge.start;
      let end = edge.end;
      if (edge instanceof flatten.Arc) {
        // approximate arc as segments? No, we keep arc but need endpoints.
        // For graph traversal we can treat arc as a directed edge; but orientation matters.
        // For simplicity, we'll convert arcs to a polyline of short segments.
        const points = [];
        const angleStep = Math.PI / 36; // 5° steps
        let ang = edge.startAngle;
        while (ang < edge.endAngle - 1e-6) {
          const x = edge.center.x + edge.radius * Math.cos(ang);
          const y = edge.center.y + edge.radius * Math.sin(ang);
          points.push(new flatten.Point(x, y));
          ang += angleStep;
        }
        points.push(edge.end);
        for (let i = 0; i < points.length - 1; i++) {
          const seg = new flatten.Segment(points[i], points[i+1]);
          addSegmentToGraph(seg);
        }
      } else {
        addSegmentToGraph(edge);
      }

      function addSegmentToGraph(seg) {
        const p1 = seg.start;
        const p2 = seg.end;
        const key1 = pointKey(p1);
        const key2 = pointKey(p2);
        if (!adj.has(key1)) adj.set(key1, []);
        if (!adj.has(key2)) adj.set(key2, []);
        adj.get(key1).push({ toPoint: p2, edge: seg, fromPoint: p1 });
        adj.get(key2).push({ toPoint: p1, edge: seg, fromPoint: p2 });
        if (!vertices.some(v => v.distanceTo(p1) < tolerance)) vertices.push(p1);
        if (!vertices.some(v => v.distanceTo(p2) < tolerance)) vertices.push(p2);
      }
    });

    return { vertices, adj, pointKey };
  }

  // ----------------------------------------------------------------------
  // Step 3: extract cycles by walking with rightmost turn (for CW outer)
  // ----------------------------------------------------------------------
  function angleBetween(v1, v2) {
    return Math.atan2(v2.y - v1.y, v2.x - v1.x);
  }

  function rightmostTurn(fromPoint, currentPoint, neighbors, tolerance) {
    const incomingDir = { x: currentPoint.x - fromPoint.x, y: currentPoint.y - fromPoint.y };
    const incomingAngle = Math.atan2(incomingDir.y, incomingDir.x);
    let bestNeighbor = null;
    let bestAngleDiff = -Infinity;
    for (const nb of neighbors) {
      const toPoint = nb.toPoint;
      if (toPoint.distanceTo(currentPoint) < tolerance) continue;
      const outDir = { x: toPoint.x - currentPoint.x, y: toPoint.y - currentPoint.y };
      const outAngle = Math.atan2(outDir.y, outDir.x);
      let diff = outAngle - incomingAngle;
      // Normalize to [0, 2π)
      diff = ((diff % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
      // Rightmost turn = smallest positive angle? Actually for CW we want the smallest positive turn (right turn).
      // For CCW outer we would take largest positive turn (left turn).
      if (diff > bestAngleDiff) {
        bestAngleDiff = diff;
        bestNeighbor = nb;
      }
    }
    return bestNeighbor;
  }

  function extractAllCycles(vertices, adj, tolerance) {
    const cycles = [];
    const visitedEdges = new Set();

    function pointKey(p) {
      return `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    }

    for (const startVertex of vertices) {
      const startKey = pointKey(startVertex);
      const neighbors = adj.get(startKey) || [];
      for (const firstEdge of neighbors) {
        const edgeKey = `${startKey}-${pointKey(firstEdge.toPoint)}`;
        if (visitedEdges.has(edgeKey)) continue;

        const cycle = [];
        let current = startVertex;
        let from = firstEdge.toPoint;
        let currentEdge = firstEdge;
        let closed = false;

        while (!closed) {
          const fromKey = pointKey(from);
          const toKey = pointKey(current);
          const edgeKeyNow = `${fromKey}-${toKey}`;
          if (visitedEdges.has(edgeKeyNow)) break;
          visitedEdges.add(edgeKeyNow);
          cycle.push(current);

          const nextNeighbors = adj.get(pointKey(current)) || [];
          const nextEdge = rightmostTurn(from, current, nextNeighbors, tolerance);
          if (!nextEdge) break;
          from = current;
          current = nextEdge.toPoint;
          if (current.distanceTo(startVertex) < tolerance) {
            closed = true;
            cycle.push(startVertex);
            break;
          }
        }

        if (closed && cycle.length >= 3) {
          const polygon = cycle.map(p => ({ x: p.x, y: p.y }));
          cycles.push(polygon);
        }
      }
    }
    return cycles;
  }

  // ----------------------------------------------------------------------
  // Step 4: choose outer contour (largest area, CCW orientation)
  // ----------------------------------------------------------------------
  function selectOuterContour(cycles) {
    const candidates = cycles.map(polygon => {
      const closed = closePointRing(polygon);
      const area = Math.abs(polygonSignedArea(closed.slice(0, -1)));
      const orientation = polygonSignedArea(closed.slice(0, -1)) > 0 ? 'CCW' : 'CW';
      return { polygonPoints: closed, area, orientation };
    });

    // Prefer CCW outer (largest area among CCW)
    const ccwCandidates = candidates.filter(c => c.orientation === 'CCW');
    if (ccwCandidates.length) {
      ccwCandidates.sort((a,b) => b.area - a.area);
      return ccwCandidates[0];
    }
    // Fallback: largest area overall
    candidates.sort((a,b) => b.area - a.area);
    return candidates[0];
  }

  // ----------------------------------------------------------------------
  // Main entry point: buildIntersectionContour
  // ----------------------------------------------------------------------
  function buildIntersectionContour(shapeRecord, options = {}) {
    const tolerance = Math.max(geometry.LOOP_TOLERANCE, options.tolerance || 1e-4);
    const bbox = computeEntitiesBBox(shapeRecord?.entities || []);
    const span = bboxSpan(bbox);
    const gapTolerance = Number.isFinite(options.gapTolerance)
      ? options.gapTolerance
      : Math.max(tolerance * 10, span * 0.005, 1);

    // Convert all entities to flatten shapes
    const shapes = (shapeRecord?.entities || [])
      .map(entity => entityToFlattenShape(entity))
      .filter(s => s !== null);

    if (shapes.length === 0) {
      return emptyContourResult('no-shapes', { reason: 'No convertible entities' });
    }

    // Step 1: split at intersections
    const edges = splitAtIntersections(shapes, tolerance);
    if (edges.length === 0) {
      return emptyContourResult('no-edges', { reason: 'No edges after splitting' });
    }

    console.log("edges", edges);

    // Step 2: build graph
    const { vertices, adj } = buildGraph(edges, tolerance);
    if (vertices.length < 3) {
      return emptyContourResult('no-vertices', { reason: 'Graph has <3 vertices' });
    }

    console.log("vertices", vertices, adj);

    // Step 3: extract cycles using rightmost turn (CW outer)
    const cycles = extractAllCycles(vertices, adj, tolerance);
    if (cycles.length === 0) {
      return emptyContourResult('no-cycles', { reason: 'No closed cycles found' });
    }

    console.log("cycles", cycles);

    // Step 4: select outer contour
    const outer = selectOuterContour(cycles);
    if (!outer) {
      return emptyContourResult('no-outer', { reason: 'Failed to select outer contour' });
    }

    console.log("selectOuterContour", outer);

    // Build ranked candidates for consistency with maker.js service
    const ranked = cycles.map(poly => {
      const closed = closePointRing(poly);
      const area = Math.abs(polygonSignedArea(closed.slice(0, -1)));
      return {
        candidate: {
          polygonPoints: closed,
          source: 'intersection-tracer',
          tolerance,
          area,
        },
        area,
        mergeCount: 0,
        closureGap: 0,
        pathLength: closed.length,
      };
    }).sort(compareContourCandidatesByGeometry);

    const winner = ranked[0];

    return {
      ...winner.candidate,
      coverage: null,
      rankedCandidates: ranked,
      builderMode: 'intersection-tracer',
      builderDebug: {
        shapeId: shapeRecord?.id || null,
        sourceEntityCount: shapeRecord?.entities?.length || 0,
        edgesAfterSplit: edges.length,
        verticesCount: vertices.length,
        cyclesFound: cycles.length,
        chosenArea: winner.area,
        gapTolerance,
      },
    };
  }

  global.NestDxfContourDetectionIntersectionService = {
    buildIntersectionContour,
  };
})(window);
