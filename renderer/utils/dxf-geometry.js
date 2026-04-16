(function attachNestDxfGeometry(global) {
  'use strict';

  // Shared numeric constants used throughout geometry calculations.
  // EPS is the "effectively zero area" threshold; LOOP_TOLERANCE is the snap
  // distance for merging nearly-identical graph nodes into one.
  const EPS = 1e-6;
  const TWO_PI = Math.PI * 2;
  const LOOP_TOLERANCE = 1e-3;

  // Ray-casting point-in-polygon test. Used to decide whether one contour
  // lies inside another when building the hole hierarchy.
  function pointInPoly(px, py, vertices) {
    let inside = false;
    const n = vertices.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = vertices[i].x;
      const yi = vertices[i].y;
      const xj = vertices[j].x;
      const yj = vertices[j].y;
      if (((yi > py) !== (yj > py)) &&
          (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // Euclidean distance between two {x, y} points. Used wherever edge lengths
  // or chord lengths need to be compared.
  function dist(a, b) {
    return Math.hypot((b.x || 0) - (a.x || 0), (b.y || 0) - (a.y || 0));
  }

  // Returns true when two points are within eps of each other.
  // Used to detect shared vertices when stitching edges into loops.
  function samePoint(a, b, eps = 1e-4) {
    return !!a && !!b && Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
  }

  // Extracts {start, end} from a LINE entity regardless of whether the parser
  // stored the data in ent.start/ent.end or ent.vertices, normalising the
  // two formats into one consistent shape.
  function getLineEndpoints(ent) {
    if (!ent || ent.type !== 'LINE') return null;
    if (ent.start && ent.end &&
        Number.isFinite(ent.start.x) && Number.isFinite(ent.start.y) &&
        Number.isFinite(ent.end.x) && Number.isFinite(ent.end.y)) {
      return { start: ent.start, end: ent.end };
    }
    if (Array.isArray(ent.vertices) && ent.vertices.length >= 2) {
      const start = ent.vertices[0];
      const end = ent.vertices[ent.vertices.length - 1];
      if (Number.isFinite(start?.x) && Number.isFinite(start?.y) &&
          Number.isFinite(end?.x) && Number.isFinite(end?.y)) {
        return { start, end };
      }
    }
    return null;
  }

  // Calculates the physical start and end {x, y} points of an ARC entity from
  // its centre, radius, and start/end angles so the arc can be treated as an
  // edge with known endpoints when building contour graphs.
  function getArcEndpoints(ent) {
    if (!ent || ent.type !== 'ARC' || !ent.center || !Number.isFinite(ent.radius)) return null;
    const startAngle = Number.isFinite(ent.startAngle) ? ent.startAngle : 0;
    const endAngle = Number.isFinite(ent.endAngle) ? ent.endAngle : 0;
    return {
      start: {
        x: ent.center.x + ent.radius * Math.cos(startAngle),
        y: ent.center.y + ent.radius * Math.sin(startAngle),
      },
      end: {
        x: ent.center.x + ent.radius * Math.cos(endAngle),
        y: ent.center.y + ent.radius * Math.sin(endAngle),
      },
    };
  }

  // Snaps a point to a grid of size eps and returns a string key so that
  // nearly-identical points are merged into the same node in the contour graph.
  function pointKey(point, eps = LOOP_TOLERANCE) {
    return `${Math.round(point.x / eps)},${Math.round(point.y / eps)}`;
  }

  // Removes consecutive duplicate points from an array to avoid zero-length
  // edges. When closed=true it also strips the repeated closing vertex so
  // polygon algorithms don't double-count it.
  function dedupePoints(points, closed = false) {
    const out = [];
    points.forEach(point => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      if (!out.length || !samePoint(out[out.length - 1], point)) out.push({ x: point.x, y: point.y });
    });
    if (closed && out.length > 2 && samePoint(out[0], out[out.length - 1])) out.pop();
    return out;
  }

  // Returns a compact string key for a single point, snapped to a coarser grid
  // than pointKey. Used to build Set-based signatures for whole-polygon
  // deduplication rather than graph-node merging.
  function pointSig(point, precision = 1e-4) {
    return `${Math.round(point.x / precision)},${Math.round(point.y / precision)}`;
  }

  // Generates a canonical string for a closed polygon that is identical
  // regardless of starting vertex or winding direction. Used to detect and
  // discard duplicate contours extracted from the same DXF layer.
  function normalizedClosedPointSignature(points, precision = 1e-4) {
    const ring = dedupePoints(points, true);
    if (!ring.length) return '';
    const forward = ring.map(point => pointSig(point, precision));
    const backward = [...forward].reverse();
    const rotations = sequence => {
      const out = [];
      for (let i = 0; i < sequence.length; i++) {
        out.push(sequence.slice(i).concat(sequence.slice(0, i)).join('|'));
      }
      return out;
    };
    return [...rotations(forward), ...rotations(backward)].sort()[0] || '';
  }

  // Computes the axis-aligned bounding box of a point array. Used as a quick
  // spatial index for containment pre-tests and layout calculations.
  function bboxFromPoints(points) {
    if (!points.length) return null;
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  }

  // Shoelace formula for signed polygon area. A positive result means CCW
  // winding; negative means CW. Used by normalizeWindingCCW to fix winding order.
  function polygonSignedArea(points) {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      area += a.x * b.y - b.x * a.y;
    }
    return area / 2;
  }

  // Reverses the point order if the polygon is CW so everything downstream
  // can assume CCW winding without needing to check itself.
  function normalizeWindingCCW(points) {
    if (polygonSignedArea(points) < 0) points.reverse();
    return points;
  }

  // Finds a point guaranteed to be inside the polygon, first trying the
  // centroid and falling back to a triangle centroid. Used as a probe point
  // for containment tests when building the hole hierarchy.
  function interiorPoint(points) {
    if (!points.length) return null;
    const avg = points.reduce((acc, point) => ({
      x: acc.x + point.x / points.length,
      y: acc.y + point.y / points.length,
    }), { x: 0, y: 0 });
    if (pointInPoly(avg.x, avg.y, points)) return avg;
    const a = points[0];
    const b = points[1] || points[0];
    const c = points[2] || points[0];
    return {
      x: (a.x + b.x + c.x) / 3,
      y: (a.y + b.y + c.y) / 3,
    };
  }

  // Quick bounding-box pre-test run before the more expensive pointInPoly check.
  // Avoids the full ray-cast for points that are obviously outside the bbox.
  function bboxContainsPoint(bbox, point, eps = 1e-4) {
    return point.x >= bbox.minX - eps && point.x <= bbox.maxX + eps &&
           point.y >= bbox.minY - eps && point.y <= bbox.maxY + eps;
  }

  // Merges two bounding boxes into one that covers both. Handles null inputs so
  // callers can accumulate a bbox by starting with null and unioning each entity.
  function unionBBox(a, b) {
    if (!a) return b || null;
    if (!b) return a || null;
    return {
      minX: Math.min(a.minX, b.minX),
      minY: Math.min(a.minY, b.minY),
      maxX: Math.max(a.maxX, b.maxX),
      maxY: Math.max(a.maxY, b.maxY),
    };
  }

  // Adjusts an end angle so the arc sweeps in the intended direction (CCW or CW)
  // without wrapping past the start angle unexpectedly. Required because DXF
  // arcs can straddle the 0/2π boundary.
  function normalizeAngleSpan(start, end, ccw) {
    let s = start;
    let e = end;
    if (ccw) {
      while (e <= s) e += TWO_PI;
    } else {
      while (e >= s) e -= TWO_PI;
    }
    return { start: s, end: e };
  }

  // Converts a DXF polyline bulge value into a sequence of arc points so that
  // curved polyline segments are tessellated correctly. Bulge encodes tan(θ/4)
  // of the included arc angle, which this function decodes into centre + radius.
  function bulgeToPoints(start, end, bulge, maxStepDeg = 12) {
    if (!bulge || Math.abs(bulge) < EPS) return [{ x: end.x, y: end.y }];
    const chord = dist(start, end);
    if (chord < EPS) return [];
    const theta = 4 * Math.atan(bulge);
    const radius = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const ux = (end.x - start.x) / chord;
    const uy = (end.y - start.y) / chord;
    const leftNormal = { x: -uy, y: ux };
    const offset = chord * (1 - bulge * bulge) / (4 * bulge);
    const center = { x: mid.x + leftNormal.x * offset, y: mid.y + leftNormal.y * offset };
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const rawEndAngle = Math.atan2(end.y - center.y, end.x - center.x);
    const span = normalizeAngleSpan(startAngle, rawEndAngle, bulge > 0);
    const delta = span.end - span.start;
    const step = (maxStepDeg * Math.PI) / 180;
    const steps = Math.max(2, Math.ceil(Math.abs(delta) / step));
    const points = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const angle = span.start + delta * t;
      points.push({
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
      });
    }
    points[points.length - 1] = { x: end.x, y: end.y };
    return points;
  }

  // Tessellates a DXF ELLIPSE entity into a flat point array, handling the
  // rotation of the major axis and partial ellipses (start/end parameters).
  // Needed because the nesting solver works with point polygons, not parametric curves.
  function ellipseToPoints(ent, forceClosed = false) {
    if (!ent.center || !ent.majorAxisEndPoint) return [];
    const rx = Math.hypot(ent.majorAxisEndPoint.x, ent.majorAxisEndPoint.y);
    const ry = rx * Math.abs(ent.axisRatio || 1);
    if (rx < EPS || ry < EPS) return [];
    const baseAngle = Math.atan2(ent.majorAxisEndPoint.y, ent.majorAxisEndPoint.x);
    const startParam = ent.startParameter ?? ent.startAngle ?? 0;
    const endParamRaw = ent.endParameter ?? ent.endAngle ?? TWO_PI;
    const closed = forceClosed || Math.abs((endParamRaw - startParam) % TWO_PI) < 1e-4 ||
      Math.abs(Math.abs(endParamRaw - startParam) - TWO_PI) < 1e-4;
    const span = normalizeAngleSpan(startParam, endParamRaw, true);
    const delta = closed ? TWO_PI : span.end - span.start;
    const stepCount = Math.max(24, Math.ceil(Math.abs(delta) / (Math.PI / 18)));
    const points = [];
    for (let i = 0; i <= stepCount; i++) {
      if (!closed && i === stepCount) {
        const angle = span.start + delta;
        points.push({
          x: ent.center.x + rx * Math.cos(angle) * Math.cos(baseAngle) - ry * Math.sin(angle) * Math.sin(baseAngle),
          y: ent.center.y + rx * Math.cos(angle) * Math.sin(baseAngle) + ry * Math.sin(angle) * Math.cos(baseAngle),
        });
        break;
      }
      if (closed && i === stepCount) break;
      const t = i / stepCount;
      const angle = span.start + delta * t;
      points.push({
        x: ent.center.x + rx * Math.cos(angle) * Math.cos(baseAngle) - ry * Math.sin(angle) * Math.sin(baseAngle),
        y: ent.center.y + rx * Math.cos(angle) * Math.sin(baseAngle) + ry * Math.sin(angle) * Math.cos(baseAngle),
      });
    }
    return dedupePoints(points, closed);
  }

  // Expands a LWPOLYLINE/POLYLINE vertex array into a flat point array by
  // converting any bulge values to arc point sequences. This is the primary
  // path for turning polyline geometry into solver-ready polygons.
  function polylineVerticesToPoints(vertices, close = true) {
    if (!vertices || vertices.length < 2) return [];
    const points = [{ x: vertices[0].x, y: vertices[0].y }];
    for (let i = 0; i < vertices.length - 1; i++) {
      points.push(...bulgeToPoints(vertices[i], vertices[i + 1], vertices[i].bulge || 0));
    }
    if (close) {
      const last = vertices[vertices.length - 1];
      points.push(...bulgeToPoints(last, vertices[0], last.bulge || 0));
    }
    return dedupePoints(points, close);
  }

  // Returns the fit points (preferred) or control points of a SPLINE as a simple
  // point array. Accurate enough for nesting polygon approximation without needing
  // full B-spline evaluation.
  function splineToPoints(ent) {
    const raw = (ent.fitPoints && ent.fitPoints.length > 1)
      ? ent.fitPoints
      : (ent.controlPoints || []);
    return dedupePoints(raw.map(point => ({ x: point.x, y: point.y })), !!ent.closed);
  }

  // Tessellates a CIRCLE into 48 evenly-spaced points so it can be treated as
  // a closed polygon by the nesting solver and geometry helpers.
  function circleToPoints(ent) {
    if (!ent.center || !ent.radius || ent.radius < EPS) return [];
    const steps = 48;
    const points = [];
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * TWO_PI;
      points.push({
        x: ent.center.x + ent.radius * Math.cos(angle),
        y: ent.center.y + ent.radius * Math.sin(angle),
      });
    }
    return points;
  }

  // Returns any one representative point from an entity without full tessellation.
  // Used as a quick containment probe to decide which layer or group an entity
  // belongs to.
  function samplePoint(ent) {
    if (!ent || typeof ent !== 'object') return null;
    switch (ent.type) {
      case 'CIRCLE':
      case 'ARC':
      case 'ELLIPSE':
        return ent.center && Number.isFinite(ent.center.x) && Number.isFinite(ent.center.y) ? ent.center : null;
      case 'LINE': {
        const endpoints = getLineEndpoints(ent);
        if (!endpoints) return null;
        return {
          x: (endpoints.start.x + endpoints.end.x) / 2,
          y: (endpoints.start.y + endpoints.end.y) / 2,
        };
      }
      case 'LWPOLYLINE':
      case 'POLYLINE':
        return ent.vertices?.find(vertex => Number.isFinite(vertex?.x) && Number.isFinite(vertex?.y)) || null;
      case 'SPLINE': {
        const points = (ent.fitPoints && ent.fitPoints.length) ? ent.fitPoints : (ent.controlPoints || []);
        const valid = points.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
        return valid[Math.floor(valid.length / 2)] || null;
      }
      default:
        return null;
    }
  }

  // Same as samplePoint but wrapped in try/catch so a malformed entity doesn't
  // crash the caller. Returns null on any error.
  function safeSamplePoint(ent) {
    try {
      return samplePoint(ent);
    } catch (_) {
      return null;
    }
  }

  // Returns the unit vector pointing from point a to point b. Used when
  // comparing edge directions to detect nearly-collinear segments.
  function vectorBetween(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  // Returns the absolute angle in radians between two direction vectors.
  // Used to measure how sharply two edges diverge at a shared vertex.
  function angleDelta(a, b) {
    const dot = (a.x * b.x) + (a.y * b.y);
    const cross = (a.x * b.y) - (a.y * b.x);
    return Math.abs(Math.atan2(cross, dot));
  }

  // Computes the bounding box of any supported DXF entity type by tessellating
  // or reading its geometry. Used for spatial indexing and layout bounds checks.
  function entityBBox(ent) {
    const xs = [];
    const ys = [];
    switch (ent.type) {
      case 'LWPOLYLINE':
      case 'POLYLINE':
        if (!ent.vertices) return null;
        polylineVerticesToPoints(ent.vertices, ent.closed !== false).forEach(vertex => { xs.push(vertex.x); ys.push(vertex.y); });
        break;
      case 'LINE': {
        const endpoints = getLineEndpoints(ent);
        if (!endpoints) return null;
        xs.push(endpoints.start.x, endpoints.end.x);
        ys.push(endpoints.start.y, endpoints.end.y);
        break;
      }
      case 'CIRCLE':
      case 'ARC':
        xs.push(ent.center.x - ent.radius, ent.center.x + ent.radius);
        ys.push(ent.center.y - ent.radius, ent.center.y + ent.radius);
        break;
      case 'ELLIPSE':
        ellipseToPoints(ent, false).forEach(point => { xs.push(point.x); ys.push(point.y); });
        break;
      case 'SPLINE':
        splineToPoints(ent).forEach(point => { xs.push(point.x); ys.push(point.y); });
        break;
      default:
        return null;
    }
    if (!xs.length) return null;
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  }

  // Ensures a polygon point array ends with a copy of the first point (the
  // "closed ring" convention the nesting solver expects) without creating a
  // duplicate if the ring is already closed.
  function closePointRing(points) {
    const ring = dedupePoints(points, true);
    if (!ring.length) return [];
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!samePoint(first, last)) ring.push({ x: first.x, y: first.y });
    return ring;
  }

  global.NestDxfGeometry = {
    EPS,
    TWO_PI,
    LOOP_TOLERANCE,
    pointInPoly,
    dist,
    samePoint,
    getLineEndpoints,
    getArcEndpoints,
    pointKey,
    dedupePoints,
    pointSig,
    normalizedClosedPointSignature,
    bboxFromPoints,
    polygonSignedArea,
    normalizeWindingCCW,
    interiorPoint,
    bboxContainsPoint,
    unionBBox,
    normalizeAngleSpan,
    bulgeToPoints,
    ellipseToPoints,
    polylineVerticesToPoints,
    splineToPoints,
    circleToPoints,
    samplePoint,
    safeSamplePoint,
    vectorBetween,
    angleDelta,
    entityBBox,
    closePointRing,
  };
})(window);
