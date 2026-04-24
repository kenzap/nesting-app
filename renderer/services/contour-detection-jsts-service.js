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
    // Deduplicate snapped segments. Order-insensitive key so reverse duplicates
    // (e.g. 1161603Adaptor lines 130/158) collapse. Exact duplicates (e.g.
    // lines 125/126/128 after snap) collapse too. This eliminates the "double
    // wall" sliver faces that otherwise confuse the polygonizer.
    const seen = new Set();
    let dedupCount = 0;
    for (const [a, b] of segments) {
      const ax = snap(a.x);
      const ay = snap(a.y);
      const bx = snap(b.x);
      const by = snap(b.y);
      if (ax === bx && ay === by) continue;
      const forward = `${ax},${ay}|${bx},${by}`;
      const reverse = `${bx},${by}|${ax},${ay}`;
      if (seen.has(forward) || seen.has(reverse)) {
        dedupCount++;
        continue;
      }
      seen.add(forward);
      out.push(factory.createLineString([
        new jsts.geom.Coordinate(ax, ay),
        new jsts.geom.Coordinate(bx, by),
      ]));
    }
    out._dedupCount = dedupCount;
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

  // Classic JSTS UnaryUnionOp uses legacy OverlayOp, which can throw
  // "found non-noded intersection" on dense arc-sampled inputs because
  // the PrecisionModel on the factory is metadata-only — overlay does
  // not snap intermediate intersections to it. We layer progressively
  // more aggressive robustness strategies and return the first one that
  // succeeds, tagging the strategy for debug.
  function robustUnaryUnion(geometries, factory, scale) {
    if (!geometries || !geometries.length) return { result: null, strategy: 'empty-input' };
    let collection;
    try {
      collection = factory.createGeometryCollection(geometries);
    } catch (error) {
      return { result: null, strategy: 'collection-failed', error: error?.message || String(error) };
    }

    // Strategy 1: straight union (fast path for well-behaved inputs).
    try {
      return { result: jsts.operation.union.UnaryUnionOp.union(collection), strategy: 'direct' };
    } catch (_e) { /* fall through */ }

    // Strategy 2: explicit precision reduction on inputs.
    try {
      const reduced = jsts.precision.GeometryPrecisionReducer.reduce(collection, factory.getPrecisionModel());
      return { result: jsts.operation.union.UnaryUnionOp.union(reduced), strategy: 'precision-reduced' };
    } catch (_e) { /* fall through */ }

    // Strategy 3: snap near-coincident features within the geometry to itself.
    try {
      const snap = jsts.operation.overlay.snap.GeometrySnapper;
      const tol = snap.computeSizeBasedSnapTolerance(collection);
      const snapped = snap.snapToSelf(collection, tol, true);
      return { result: jsts.operation.union.UnaryUnionOp.union(snapped), strategy: 'snap-to-self' };
    } catch (_e) { /* fall through */ }

    // Strategy 4: coarsen the snap grid 10× and retry precision reduction.
    const coarserScale = Math.max(1, Math.round(Math.max(1, scale) / 10));
    try {
      const coarsePm = new jsts.geom.PrecisionModel(coarserScale);
      const reduced = jsts.precision.GeometryPrecisionReducer.reduce(collection, coarsePm);
      return { result: jsts.operation.union.UnaryUnionOp.union(reduced), strategy: 'coarsened' };
    } catch (error) {
      return {
        result: null,
        strategy: 'all-failed',
        error: error?.message || String(error),
        coarserScale,
      };
    }
  }

  // Build a concaveman hull over every sampled endpoint. Returns a candidate
  // shaped like `jstsPolygonToCandidate` output (plus `source`) or null if
  // the hull can't be produced. Used:
  //   - as a fallback when JSTS succeeds but the winner doesn't cover the
  //     source bbox / leaves components behind
  //   - as a last-resort when polygonize emits zero faces (e.g. curved glyphs
  //     in Text.dxf where ARC endpoints don't snap-connect cleanly and no
  //     bounded cycle exists for the polygonizer to close)
  function buildConcavemanCandidate(segments, { tolerance, scale, concavity, lengthThreshold }) {
    if (typeof global.concaveman !== 'function') {
      return { candidate: null, reason: 'concaveman-unavailable', pointCount: 0 };
    }
    const seenPts = new Set();
    const pointCloud = [];
    const quant = Math.max(tolerance, 1 / Math.max(1, scale));
    for (const [a, b] of segments) {
      for (const p of [a, b]) {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const key = `${Math.round(p.x / quant)},${Math.round(p.y / quant)}`;
        if (seenPts.has(key)) continue;
        seenPts.add(key);
        pointCloud.push([p.x, p.y]);
      }
    }
    if (pointCloud.length < 3) {
      return { candidate: null, reason: 'insufficient-points-for-concaveman', pointCount: pointCloud.length };
    }
    try {
      const hullPts = global.concaveman(
        pointCloud,
        Number.isFinite(concavity) ? concavity : 2,
        Number.isFinite(lengthThreshold) ? lengthThreshold : 0,
      );
      if (!Array.isArray(hullPts) || hullPts.length < 3) {
        return { candidate: null, reason: 'concaveman-degenerate', pointCount: pointCloud.length };
      }
      const pts = hullPts.map(([x, y]) => ({ x, y }));
      const ringPts = closePointRing(pts);
      const area = Math.abs(polygonSignedArea(ringPts.slice(0, -1)));
      return {
        candidate: {
          polygonPoints: ringPts,
          source: 'jsts-arrangement-concaveman',
          tolerance,
          area,
          holes: [],
          containsCentroid: true,
        },
        reason: null,
        pointCount: pointCloud.length,
      };
    } catch (error) {
      return {
        candidate: null,
        reason: `concaveman-failed: ${error?.message || error}`,
        pointCount: pointCloud.length,
      };
    }
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
    // Use the robust wrapper because classic overlay throws "non-noded
    // intersection" on dense curve samples without snap-rounding the
    // intermediate intersections.
    const nodingUnion = robustUnaryUnion(lineStrings, factory, scale);
    if (!nodingUnion.result) {
      return reportEmpty('union-failed', {
        strategy: nodingUnion.strategy,
        error: nodingUnion.error || null,
      });
    }
    const nodedGeometry = nodingUnion.result;
    const nodingStrategy = nodingUnion.strategy;

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
    if (!facePolygons.length) {
      // Polygonize found zero bounded faces. This happens for shapes made of
      // open curves whose endpoints don't snap-connect — e.g. curved-letter
      // glyphs in Text.dxf, where each ARC is sampled into many segments but
      // consecutive arcs share only float-drift-close endpoints, so no cycle
      // closes under snap-rounding. We have a dense point cloud but nothing
      // for the polygonizer to chew on. Fall through to concaveman so the
      // letter still gets a usable silhouette instead of an empty contour.
      const hull = buildConcavemanCandidate(segments, {
        tolerance,
        scale,
        concavity: options.concavity,
        lengthThreshold: options.lengthThreshold,
      });
      if (!hull.candidate) {
        return reportEmpty('no-faces', {
          lineCount: lineStrings.length,
          fallbackReason: hull.reason,
        });
      }
      const rescueDebug = {
        ...debugBase,
        stage: 'success',
        segmentCount: segments.length,
        lineCount: lineStrings.length,
        dedupedSegments: lineStrings._dedupCount || 0,
        faceCount: 0,
        componentCount: 0,
        centroidTieredCount: 0,
        componentAreas: [],
        sourceBboxArea: bbox ? Math.max(0, (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY)) : 0,
        winnerBboxArea: null,
        bboxCoverage: null,
        bboxCoverageThreshold: Number.isFinite(options.bboxCoverageThreshold) ? options.bboxCoverageThreshold : 0.6,
        needsFallback: true,
        usingFallback: true,
        fallbackReason: 'no-faces',
        jstsWinnerArea: null,
        chosenArea: hull.candidate.area,
        chosenContainsCentroid: true,
        holeCount: 0,
        nodingStrategy,
        silhouetteStrategy: 'concaveman-no-faces',
        source: hull.candidate.source,
        concavemanPointCount: hull.pointCount,
      };
      debugDXF('Arrangement contour', rescueDebug);
      return {
        ...hull.candidate,
        coverage: null,
        rankedCandidates: [{
          candidate: hull.candidate,
          area: hull.candidate.area,
          containsCentroid: true,
          mergeCount: 0,
          closureGap: 0,
          pathLength: hull.candidate.polygonPoints.length,
        }],
        components: [{
          polygonPoints: hull.candidate.polygonPoints,
          area: hull.candidate.area,
          holes: [],
          containsCentroid: true,
        }],
        builderMode: 'jsts-arrangement',
        builderDebug: rescueDebug,
      };
    }

    // 5. Union the faces into the silhouette. One face = silhouette is itself.
    let silhouette;
    let silhouetteStrategy = 'single-face';
    if (facePolygons.length === 1) {
      silhouette = facePolygons[0];
    } else {
      const silhouetteUnion = robustUnaryUnion(facePolygons, factory, scale);
      if (!silhouetteUnion.result) {
        return reportEmpty('silhouette-union-failed', {
          faceCount: facePolygons.length,
          strategy: silhouetteUnion.strategy,
          error: silhouetteUnion.error || null,
        });
      }
      silhouette = silhouetteUnion.result;
      silhouetteStrategy = silhouetteUnion.strategy;
    }
    if (!silhouette) return reportEmpty('silhouette-empty', { faceCount: facePolygons.length });

    // 6. Extract outer rings. The silhouette may be a MultiPolygon (disjoint
    // tabs, or a fragmented main body after noding). Rather than collapsing
    // to the largest-area outer, we expose all components as ranked
    // candidates and pick the primary using a centroid-containment
    // heuristic: the component whose interior contains the source-entity
    // bbox centroid is almost certainly the main body, even if an interior
    // feature (e.g. LWPOLYLINE 131 triangle in 1161603Adaptor) happens to
    // have a larger area after fragmentation.
    const outerPolygons = extractPolygonsFromGeometry(silhouette);
    if (!outerPolygons.length) return reportEmpty('no-outer-polygons', { faceCount: facePolygons.length });

    const centroid = bbox && Number.isFinite(bbox.minX)
      ? { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 }
      : null;
    const centroidPoint = centroid
      ? factory.createPoint(new jsts.geom.Coordinate(centroid.x, centroid.y))
      : null;

    const componentEntries = outerPolygons
      .map(polygon => {
        const candidate = jstsPolygonToCandidate(polygon);
        let containsCentroid = false;
        if (centroidPoint) {
          try {
            containsCentroid = polygon.contains(centroidPoint);
          } catch (_e) { /* fall through, treated as false */ }
        }
        return { polygon, candidate, containsCentroid };
      })
      .filter(entry => Array.isArray(entry.candidate.polygonPoints) && entry.candidate.polygonPoints.length >= 4);

    if (!componentEntries.length) return reportEmpty('no-valid-outer', { faceCount: facePolygons.length });

    const ranked = componentEntries
      .map(entry => ({
        candidate: {
          polygonPoints: entry.candidate.polygonPoints,
          source: 'jsts-arrangement',
          tolerance,
          area: entry.candidate.area,
          holes: entry.candidate.holes,
          containsCentroid: entry.containsCentroid,
        },
        area: entry.candidate.area,
        containsCentroid: entry.containsCentroid,
        mergeCount: 0,
        closureGap: 0,
        pathLength: entry.candidate.polygonPoints.length,
      }))
      // Tier 1: components containing the source centroid.
      // Tier 2: everything else (tabs, fragments, stray interior shells).
      // Within each tier: largest area first.
      .sort((a, b) => {
        if (a.containsCentroid !== b.containsCentroid) {
          return a.containsCentroid ? -1 : 1;
        }
        return (b.area || 0) - (a.area || 0);
      });

    const jstsWinner = ranked[0];

    // Expose all components on the winner so downstream can opt into the
    // full MultiPolygon silhouette (tabs etc.) instead of just the primary
    // ring. Shape: [{ polygonPoints, area, holes, containsCentroid }, ...]
    const components = componentEntries.map(entry => ({
      polygonPoints: entry.candidate.polygonPoints,
      area: entry.candidate.area,
      holes: entry.candidate.holes,
      containsCentroid: entry.containsCentroid,
    }));

    // ---- Sanity gate: does the JSTS winner actually look like the outer? ---
    //
    // Two failure modes this gate catches:
    //   Case A — door/screen with 93 closed splines where the outer frame
    //            spline didn't close under snap-rounding. polygonize drops
    //            it as a dangle and only emits the interior decorative
    //            splines as faces, so the "winner" is a small interior
    //            shape floating in empty space.
    //   Case B — part with disjoint tabs (1161603Adaptor). The winner is the
    //            main body but the tabs exist as separate components that
    //            the single-polygon contract silently drops.
    //
    // Gate:
    //   (1) winnerBboxArea / sourceBboxArea — low means "winner is smaller
    //       than the source bbox" i.e. only covers part of the drawing
    //   (2) componentCount > 1 — multi-region silhouette; tabs will be
    //       dropped unless we wrap them
    //
    // When the gate trips, we swap in a concaveman envelope over every
    // sampled segment endpoint. That hull encloses every source entity by
    // construction, so it can't follow an interior cut (Case A) and it
    // can't omit a tab (Case B). Trade-off is piecewise-linear precision
    // instead of sharp JSTS polygon edges — acceptable when the only
    // alternative is a wrong outline.
    const sourceBboxArea = bbox
      ? Math.max(0, (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY))
      : 0;
    const winnerBboxArea = (() => {
      const pts = jstsWinner?.candidate?.polygonPoints;
      if (!Array.isArray(pts) || pts.length < 3) return 0;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (!p) continue;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return (maxX - minX) * (maxY - minY);
    })();
    const bboxCoverage = sourceBboxArea > 0 ? winnerBboxArea / sourceBboxArea : 0;

    const bboxCoverageThreshold = Number.isFinite(options.bboxCoverageThreshold)
      ? options.bboxCoverageThreshold
      : 0.6;
    const needsFallback = (
      (sourceBboxArea > 0 && bboxCoverage < bboxCoverageThreshold) ||
      componentEntries.length > 1
    );

    let fallbackPolygon = null;
    let fallbackReason = null;
    let fallbackArea = null;
    if (needsFallback) {
      const hull = buildConcavemanCandidate(segments, {
        tolerance,
        scale,
        concavity: options.concavity,
        lengthThreshold: options.lengthThreshold,
      });
      if (hull.candidate) {
        fallbackPolygon = hull.candidate;
        fallbackArea = hull.candidate.area;
        fallbackReason = componentEntries.length > 1
          ? (bboxCoverage < bboxCoverageThreshold ? 'multi-component+low-coverage' : 'multi-component')
          : 'low-bbox-coverage';
      } else {
        fallbackReason = hull.reason;
      }
    }

    const usingFallback = !!fallbackPolygon;
    const winner = usingFallback
      ? {
          candidate: fallbackPolygon,
          area: fallbackArea,
          containsCentroid: true,
          mergeCount: 0,
          closureGap: 0,
          pathLength: fallbackPolygon.polygonPoints.length,
        }
      : jstsWinner;

    // Ranked list: concaveman fallback first (when used), then all JSTS
    // components in their tiered order. Downstream selection can still
    // inspect the disjoint JSTS pieces even when the primary is the hull.
    const finalRanked = usingFallback ? [winner, ...ranked] : ranked;

    const successDebug = {
      ...debugBase,
      stage: 'success',
      segmentCount: segments.length,
      lineCount: lineStrings.length,
      dedupedSegments: lineStrings._dedupCount || 0,
      faceCount: facePolygons.length,
      componentCount: componentEntries.length,
      centroidTieredCount: componentEntries.filter(e => e.containsCentroid).length,
      componentAreas: componentEntries.map(e => ({
        area: e.candidate.area,
        containsCentroid: e.containsCentroid,
        pointCount: e.candidate.polygonPoints?.length || 0,
        holeCount: e.candidate.holes?.length || 0,
      })),
      sourceBboxArea,
      winnerBboxArea,
      bboxCoverage,
      bboxCoverageThreshold,
      needsFallback,
      usingFallback,
      fallbackReason,
      jstsWinnerArea: jstsWinner?.area ?? null,
      chosenArea: winner.area ?? null,
      chosenContainsCentroid: winner.containsCentroid,
      holeCount: winner.candidate.holes?.length || 0,
      nodingStrategy,
      silhouetteStrategy,
      source: winner.candidate.source,
    };
    debugDXF('Arrangement contour', successDebug);

    return {
      ...winner.candidate,
      coverage: null,
      rankedCandidates: finalRanked,
      components,
      builderMode: 'jsts-arrangement',
      builderDebug: successDebug,
    };
  }

  global.NestDxfContourDetectionJstsService = {
    buildArrangementContour,
  };
})(window);
