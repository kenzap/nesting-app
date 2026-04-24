(function attachNestDxfContourDetectionJstsService(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const jsts = global.jsts;
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };
  const contourHelpers = global.NestDxfContourHelpers || {};

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
  } = contourHelpers;

  if (!geometry || !jsts) {
    global.NestDxfContourDetectionJstsService = {
      buildArrangementContour() {
        return emptyContourResult(jsts ? 'missing-geometry' : 'missing-jsts');
      },
    };
    return;
  }

  const {
    EPS,
    LOOP_TOLERANCE,
    dist,
    getLineEndpoints,
    getArcEndpoints,
    bulgeToPoints,
    polylineVerticesToPoints,
    ellipseToPoints,
    splineToPoints,
    circleToPoints,
    closePointRing,
    polygonSignedArea,
  } = geometry;

  // ---- Curve sampling ------------------------------------------------------

  function sampleArcPoints(entity, maxStepDeg = 6) {
    const endpoints = getArcEndpoints(entity);
    if (!entity?.center || !Number.isFinite(entity.radius) || !endpoints) return [];
    const start = Number.isFinite(entity.startAngle) ? entity.startAngle : 0;
    let end = Number.isFinite(entity.endAngle) ? entity.endAngle : start;
    while (end <= start) end += Math.PI * 2;
    const span = end - start;
    const step = Math.max((maxStepDeg * Math.PI) / 180, Math.PI / 90);
    const steps = Math.max(8, Math.ceil(Math.abs(span) / step));
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const angle = start + span * (i / steps);
      points.push({
        x: entity.center.x + entity.radius * Math.cos(angle),
        y: entity.center.y + entity.radius * Math.sin(angle),
      });
    }
    points[0] = endpoints.start;
    points[points.length - 1] = endpoints.end;
    return points;
  }

  function pointsToSegments(points, close, tolerance) {
    if (!Array.isArray(points) || points.length < 2) return [];
    const segments = [];
    const limit = close ? points.length : points.length - 1;
    for (let i = 0; i < limit; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (!a || !b) continue;
      if (dist(a, b) <= tolerance) continue;
      segments.push([a, b]);
    }
    return segments;
  }

  function entityToSegments(entity, tolerance) {
    if (!entity?.type) return [];
    switch (entity.type) {
      case 'LINE': {
        const ep = getLineEndpoints(entity);
        if (!ep || dist(ep.start, ep.end) <= tolerance) return [];
        return [[ep.start, ep.end]];
      }
      case 'ARC':
        return pointsToSegments(sampleArcPoints(entity), false, tolerance);
      case 'CIRCLE':
        return pointsToSegments(circleToPoints(entity), true, tolerance);
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const verts = Array.isArray(entity.vertices) ? entity.vertices : [];
        if (verts.length < 2) return [];
        const segs = [];
        const closed = entity.closed !== false;
        const count = closed ? verts.length : verts.length - 1;
        for (let i = 0; i < count; i++) {
          const a = verts[i];
          const b = verts[(i + 1) % verts.length];
          if (!a || !b) continue;
          const bulge = Number(a.bulge) || 0;
          if (Math.abs(bulge) > EPS) {
            const arcPts = [{ x: a.x, y: a.y }, ...bulgeToPoints(a, b, bulge, 6)];
            segs.push(...pointsToSegments(arcPts, false, tolerance));
          } else if (dist(a, b) > tolerance) {
            segs.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
          }
        }
        // Use polyline helper as backup if the manual walk produced nothing
        // (handles rare bulge-only or vertex-format quirks).
        if (!segs.length) {
          return pointsToSegments(polylineVerticesToPoints(verts, closed), closed, tolerance);
        }
        return segs;
      }
      case 'ELLIPSE':
        return pointsToSegments(ellipseToPoints(entity, false), false, tolerance);
      case 'SPLINE':
        return pointsToSegments(splineToPoints(entity), !!entity.closed, tolerance);
      default:
        return [];
    }
  }

  // ---- JSTS pipeline -------------------------------------------------------

  // Pick a precision scale for snap-rounding. We want enough resolution to
  // resolve the shape without merging real features, but coarse enough that
  // float noise in DXF coordinates collapses onto shared vertices.
  function pickPrecisionScale(span) {
    if (!Number.isFinite(span) || span <= 0) return 1e4;
    // Target ~1e-5 of the span as the snap grid (e.g. 0.001mm on a 100mm part).
    const targetSnap = Math.max(span * 1e-5, 1e-6);
    return Math.min(1e8, Math.max(1, Math.round(1 / targetSnap)));
  }

  function segmentsToLineStrings(segments, factory, scale) {
    const out = [];
    const snap = (v) => Math.round(v * scale) / scale;
    for (const [a, b] of segments) {
      const ax = snap(a.x);
      const ay = snap(a.y);
      const bx = snap(b.x);
      const by = snap(b.y);
      if (ax === bx && ay === by) continue;
      out.push(factory.createLineString([
        new jsts.geom.Coordinate(ax, ay),
        new jsts.geom.Coordinate(bx, by),
      ]));
    }
    return out;
  }

  function jstsCoordsToPoints(coords) {
    const pts = [];
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
      pts.push({ x: c.x, y: c.y });
    }
    return pts;
  }

  // Convert a JSTS Polygon into our { polygonPoints, area, holes } record.
  function jstsPolygonToCandidate(polygon) {
    const exterior = polygon.getExteriorRing();
    const outerPts = closePointRing(jstsCoordsToPoints(exterior.getCoordinates()));
    const area = Math.abs(polygonSignedArea(outerPts.slice(0, -1)));
    const holes = [];
    const holeCount = polygon.getNumInteriorRing();
    for (let i = 0; i < holeCount; i++) {
      const ring = polygon.getInteriorRingN(i);
      holes.push(closePointRing(jstsCoordsToPoints(ring.getCoordinates())));
    }
    return { polygonPoints: outerPts, area, holes };
  }

  function extractPolygonsFromGeometry(geom) {
    const out = [];
    if (!geom) return out;
    const type = typeof geom.getGeometryType === 'function' ? geom.getGeometryType() : null;
    if (type === 'Polygon') {
      out.push(geom);
    } else if (type === 'MultiPolygon' || type === 'GeometryCollection') {
      const n = geom.getNumGeometries();
      for (let i = 0; i < n; i++) {
        out.push(...extractPolygonsFromGeometry(geom.getGeometryN(i)));
      }
    }
    return out;
  }

  function buildArrangementContour(shapeRecord, options = {}) {
    const tolerance = Math.max(LOOP_TOLERANCE * 4, options.tolerance || LOOP_TOLERANCE * 8);
    const bbox = computeEntitiesBBox(shapeRecord?.entities || []);
    const span = bboxSpan(bbox);
    const scale = Number.isFinite(options.precisionScale)
      ? Math.max(1, options.precisionScale)
      : pickPrecisionScale(span);

    const debugBase = {
      shapeId: shapeRecord?.id || null,
      sourceEntityCount: shapeRecord?.entities?.length || 0,
      tolerance,
      precisionScale: scale,
    };
    const reportEmpty = (stage, extras = {}) => {
      const debug = { ...debugBase, stage, ...extras };
      debugDXF('Arrangement contour', debug);
      return emptyContourResult('jsts-arrangement', debug);
    };

    // 1. Sample entities into segments.
    const segments = [];
    (shapeRecord?.entities || []).forEach(entity => {
      segments.push(...entityToSegments(entity, tolerance));
    });
    if (segments.length < 3) return reportEmpty('insufficient-segments', { segmentCount: segments.length });

    // 2. Build snap-rounded LineStrings.
    const pm = new jsts.geom.PrecisionModel(scale);
    const factory = new jsts.geom.GeometryFactory(pm);
    const lineStrings = segmentsToLineStrings(segments, factory, scale);
    if (lineStrings.length < 3) return reportEmpty('insufficient-linestrings', { lineCount: lineStrings.length });

    // 3. Self-union all segments — JTS does the noding internally.
    let nodedGeometry;
    try {
      const collection = factory.createGeometryCollection(lineStrings);
      nodedGeometry = jsts.operation.union.UnaryUnionOp.union(collection);
    } catch (error) {
      return reportEmpty('union-failed', { error: error?.message || String(error) });
    }
    if (!nodedGeometry) return reportEmpty('union-empty');

    // 4. Polygonize the noded line network — yields all bounded faces.
    const polygonizer = new jsts.operation.polygonize.Polygonizer();
    polygonizer.add(nodedGeometry);
    const polygonsCollection = polygonizer.getPolygons();
    const facePolygons = [];
    if (polygonsCollection) {
      const iter = typeof polygonsCollection.iterator === 'function'
        ? polygonsCollection.iterator()
        : null;
      if (iter) {
        while (iter.hasNext()) facePolygons.push(iter.next());
      } else if (typeof polygonsCollection.size === 'function') {
        for (let i = 0; i < polygonsCollection.size(); i++) facePolygons.push(polygonsCollection.get(i));
      } else if (Array.isArray(polygonsCollection)) {
        facePolygons.push(...polygonsCollection);
      }
    }
    if (!facePolygons.length) return reportEmpty('no-faces', { lineCount: lineStrings.length });

    // 5. Union the faces into the silhouette. One face = silhouette is itself.
    let silhouette;
    if (facePolygons.length === 1) {
      silhouette = facePolygons[0];
    } else {
      try {
        const facesCollection = factory.createGeometryCollection(facePolygons);
        silhouette = jsts.operation.union.UnaryUnionOp.union(facesCollection);
      } catch (error) {
        return reportEmpty('silhouette-union-failed', {
          faceCount: facePolygons.length,
          error: error?.message || String(error),
        });
      }
    }
    if (!silhouette) return reportEmpty('silhouette-empty', { faceCount: facePolygons.length });

    // 6. Extract outer rings — pick the largest area as the primary nesting contour.
    const outerPolygons = extractPolygonsFromGeometry(silhouette);
    if (!outerPolygons.length) return reportEmpty('no-outer-polygons', { faceCount: facePolygons.length });

    const ranked = outerPolygons
      .map(p => jstsPolygonToCandidate(p))
      .filter(c => Array.isArray(c.polygonPoints) && c.polygonPoints.length >= 4)
      .map(c => ({
        candidate: {
          polygonPoints: c.polygonPoints,
          source: 'jsts-arrangement',
          tolerance,
          area: c.area,
          holes: c.holes,
        },
        area: c.area,
        mergeCount: 0,
        closureGap: 0,
        pathLength: c.polygonPoints.length,
      }))
      .sort((a, b) => (b.area || 0) - (a.area || 0));

    const winner = ranked[0] || null;
    if (!winner) return reportEmpty('no-valid-outer', { faceCount: facePolygons.length });

    return {
      ...winner.candidate,
      coverage: null,
      rankedCandidates: ranked,
      builderMode: 'jsts-arrangement',
      builderDebug: {
        ...debugBase,
        stage: 'success',
        segmentCount: segments.length,
        lineCount: lineStrings.length,
        faceCount: facePolygons.length,
        componentCount: outerPolygons.length,
        chosenArea: winner.area ?? null,
        holeCount: winner.candidate.holes?.length || 0,
      },
    };
  }

  global.NestDxfContourDetectionJstsService = {
    buildArrangementContour,
  };
})(window);
