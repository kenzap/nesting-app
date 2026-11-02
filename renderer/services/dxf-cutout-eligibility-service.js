(function attachCutoutEligibility(global) {
  'use strict';

  // This is an eligibility filter, not a cutting-layer inference engine.
  // Ambiguous drawings keep their geometry but do not become nesting regions.
  function createClassifier(entities) {
    const geometry = global.NestDxfGeometry;
    const jsts = global.jsts;
    const toSegments = global.NestDxfContourDetectionJstsService?.entityToSegments;
    if (!geometry || !jsts || !toSegments || entities.length > 10000
        || entities.reduce((n, e) => n + (e?.vertices?.length || 0)
          + (e?.fitPoints?.length || 0) + (e?.controlPoints?.length || 0), 0) > 20000) return () => new Set();

    const factory = new jsts.geom.GeometryFactory();
    const coordinate = point => new jsts.geom.Coordinate(point.x, point.y);
    const tolerance = geometry.LOOP_TOLERANCE;
    // Match the export contour recovery's source-correspondence allowance.
    // This does not relax hole containment or part clearance.
    const boundaryMatchTolerance = 0.05;
    const entityCache = new Map();
    const boxes = new Map();
    let workRemaining = 2000000;
    const spend = amount => (workRemaining -= amount) >= 0;
    const overlaps = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX
      && a.minY <= b.maxY && a.maxY >= b.minY;
    function entityBox(entity) {
      if (!boxes.has(entity)) boxes.set(entity, geometry.entityBBox(entity));
      return boxes.get(entity);
    }

    function polygon(points) {
      if (!Array.isArray(points) || points.length < 3 || points.length > 1024
          || points.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) return null;
      const ring = geometry.closePointRing(points);
      if (ring.length < 4) return null;
      const poly = factory.createPolygon(factory.createLinearRing(ring.map(coordinate)));
      return poly.isValid() && poly.getArea() > geometry.EPS ? poly : null;
    }

    function entityGeometry(entity) {
      if (entityCache.has(entity)) return entityCache.get(entity);
      const segments = toSegments(entity);
      if (!segments.length || !spend(segments.length)) return null;
      const lines = segments.map(([a, b]) => factory.createLineString([coordinate(a), coordinate(b)]));
      const value = { linework: factory.createMultiLineString(lines) };
      entityCache.set(entity, value);
      return value;
    }

    return function eligibleHoles(shapeRecord, outerPoints) {
      const accepted = new Set();
      const holes = shapeRecord.childClosedContours || [];
      const contours = shapeRecord.boundaryContours || [];
      if (!holes.length || holes.length > 64 || contours.length > 512
          || contours.reduce((n, c) => n + (c.polygonPoints || c.points || []).length, 0) > 8192
          || workRemaining <= 0) return accepted;
      try {
        const outer = polygon(outerPoints);
        if (!outer) return accepted;
        const outerBoundary = outer.getBoundary();
        const outerBox = geometry.bboxFromPoints(outerPoints);
        let outerBand;
        const descriptors = contours.map(contour => {
          const points = contour.polygonPoints || contour.points || [];
          // Reject invalid source rings even if extraction repaired their
          // envelope. Curves can legitimately use a different tessellation.
          const source = polygon(contour.points || points);
          return { contour, points, bbox: geometry.bboxFromPoints(points), poly: source && polygon(points) };
        });
        // Match the complete boundary, not a display layer or just its bbox.
        const matchesOuter = d => {
          if (!d.poly || !d.bbox || ['minX', 'minY', 'maxX', 'maxY'].some(key =>
            Math.abs(d.bbox[key] - outerBox[key]) > boundaryMatchTolerance)) return false;
          if (!spend(d.points.length * outerPoints.length)) return false;
          if (d.poly.equalsTopo(outer)) return true;
          outerBand ||= outerBoundary.buffer(boundaryMatchTolerance);
          const boundary = d.poly.getBoundary();
          return outerBand.covers(boundary) && boundary.buffer(boundaryMatchTolerance).covers(outerBoundary);
        };
        const outerContours = descriptors.filter(matchesOuter);
        const layers = new Set(outerContours.flatMap(d => d.contour.sourceLayers || []));
        if (!outerContours.length || layers.size !== 1 || workRemaining <= 0) return accepted;
        const [cutLayer] = layers;
        const outerSet = new Set(outerContours);

        for (const hole of holes) {
          const candidate = descriptors.find(d => d.contour === hole);
          if (!candidate?.poly || hole.sourceLayers?.length !== 1 || hole.sourceLayers[0] !== cutLayer) continue;
          const { poly, points, bbox } = candidate;
          if (!spend(points.length * outerPoints.length)) break;
          if (!outer.contains(poly) || outerBoundary.distance(poly) <= tolerance) continue;

          // Only another cut-layer contour can establish a solid island.
          // Bend frames on other layers may enclose or touch a genuine hole.
          let ambiguous = false;
          for (const other of descriptors) {
            if (other === candidate || outerSet.has(other) || !other.bbox || !overlaps(bbox, other.bbox)) continue;
            if (!other.poly || !spend(points.length * other.points.length)) { ambiguous = true; break; }
            const otherLayers = other.contour.sourceLayers || [];
            if (otherLayers.length === 1 && otherLayers[0] === cutLayer
                && other.poly.contains(poly)) { ambiguous = true; break; }
          }
          if (ambiguous) continue;

          const boundarySources = new Set(hole.sourceEntities || []);
          if (!boundarySources.size) continue;
          for (const entity of entities) {
            if (boundarySources.has(entity)) continue;
            if (!spend(1)) { ambiguous = true; break; }
            const bounds = entityBox(entity);
            // Unknown geometry (including unsupported annotations) cannot be
            // certified empty. Fail closed instead of silently ignoring it.
            if (!bounds) { ambiguous = true; break; }
            if (!overlaps(bbox, bounds)) continue;
            const value = entityGeometry(entity);
            if (!value || !spend(points.length * value.linework.getNumPoints())
                || poly.relate(value.linework).matches('T********')) { ambiguous = true; break; }
          }
          if (!ambiguous) accepted.add(hole);
        }
      } catch (_) {
        // Topology/unsupported-input failures must not approve any region.
        accepted.clear();
      }
      return accepted;
    };
  }

  global.NestDxfCutoutEligibility = { createClassifier };
})(window);
