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
    entityBBox,
    unionBBox,
    closePointRing,
    pointInPoly,
    bboxContainsPoint,
    polygonSignedArea,
    normalizeWindingCCW,
  } = geometry;

  const {
    bboxGap,
    ringBBox,
    pointOnSegment,
    segmentIntersectionPoint,
    orderedPointsAlongSegment,
    enumerateSimpleCycles,
    addSegment,
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

  function computeShapeBBox(entities) {
    let bbox = null;
    (entities || []).forEach(entity => {
      bbox = unionBBox(bbox, entityBBox(entity));
    });
    return bbox;
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

  function pointInsideRing(points, point) {
    const ring = closePointRing(points || []);
    const bbox = ringBBox(ring);
    if (!ring.length || !bbox || !point || !bboxContainsPoint(bbox, point, LOOP_TOLERANCE * 12)) return false;
    return pointInPoly(point.x, point.y, ring);
  }

  function findAttachedOpenEntities(shapeRecord, seedPoints, tolerance, entityToPathPoints, isRenderableEntity) {
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

  function buildLocalGraph(seedPoints, attachedEntities, tolerance, entityToPathPoints) {
    const nodes = [];
    const adjacency = new Map();
    const edgeKeys = new Set();
    const ring = closePointRing(seedPoints);
    const contourSegments = [];
    for (let i = 0; i < ring.length - 1; i++) contourSegments.push([ring[i], ring[i + 1]]);
    const attachedSegments = attachedEntities.flatMap(entity => buildEntitySegments(entity, tolerance, entityToPathPoints));

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
          if (!contourSplitPoints[index].some(existing => geometry.samePoint(existing, point, tolerance * 4))) {
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
        if (intersection && !splitPoints.some(existing => geometry.samePoint(existing, intersection, tolerance * 4))) splitPoints.push(intersection);
      });
      const ordered = orderedPointsAlongSegment(start, end, splitPoints, tolerance * 4);
      for (let i = 0; i < ordered.length - 1; i++) addSegment(ordered[i], ordered[i + 1], nodes, adjacency, edgeKeys, tolerance * 4);
    });

    return { nodes, adjacency };
  }

  function rankParentBuilderCycles({ cycles, shapeRecord, seedPoints, tolerance, parentContourId, attachedIds, scorePolygonCoverage }) {
    const seedCenter = ringCenter(seedPoints);
    const seedArea = Math.abs(polygonSignedArea(seedPoints.slice(0, -1)));
    return (cycles || [])
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

  function buildOwnedOpenSegments(shapeRecord, tolerance, entityToPathPoints, isRenderableEntity) {
    const entities = (shapeRecord?.openEntities?.length ? shapeRecord.openEntities : shapeRecord?.entities || [])
      .filter(isRenderableEntity);
    const rawSegments = entities.flatMap(entity => buildEntitySegments(entity, tolerance, entityToPathPoints));
    return {
      entities,
      segments: rawSegments,
      bbox: computeShapeBBox(entities),
    };
  }

  function buildOpenGraphFromShape(shapeRecord, tolerance, entityToPathPoints, isRenderableEntity, splitSegmentsAtIntersections, buildGraphFromSegments) {
    const owned = buildOwnedOpenSegments(shapeRecord, tolerance, entityToPathPoints, isRenderableEntity);
    const snappedSegments = snapSegments(owned.segments, tolerance);
    const splitSegments = splitSegmentsAtIntersections(snappedSegments, tolerance);
    const graph = buildGraphFromSegments(splitSegments, tolerance * 4);
    return {
      ...owned,
      snappedSegments,
      splitSegments,
      graph,
    };
  }

  function rankOpenBuilderCycles({ cycles, bbox, shapeRecord, tolerance, scorePolygonCoverage }) {
    const bboxArea = bbox
      ? Math.max(EPS, (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY))
      : 0;
    return (cycles || [])
      .map(points => {
        const ring = closePointRing(normalizeWindingCCW(points));
        const coverage = scorePolygonCoverage({ polygonPoints: ring }, shapeRecord.entities || []);
        const ringBox = ringBBox(ring);
        const ringBoxArea = ringBox
          ? Math.max(EPS, (ringBox.maxX - ringBox.minX) * (ringBox.maxY - ringBox.minY))
          : 0;
        const bboxCoverage = bboxArea > EPS ? (ringBoxArea / bboxArea) : 0;
        const area = Math.abs(polygonSignedArea(ring.slice(0, -1)));
        return {
          candidate: {
            polygonPoints: ring,
            source: 'open-builder',
            tolerance,
            area,
          },
          score: coverage,
          bboxCoverage,
          area,
        };
      })
      .filter(entry => entry.score)
      .sort((a, b) => {
        if ((a.score?.outerMissCount || 0) !== (b.score?.outerMissCount || 0)) return (a.score?.outerMissCount || 0) - (b.score?.outerMissCount || 0);
        if (Math.abs((b.bboxCoverage || 0) - (a.bboxCoverage || 0)) > 1e-6) return (b.bboxCoverage || 0) - (a.bboxCoverage || 0);
        if (Math.abs((b.area || 0) - (a.area || 0)) > 1e-6) return (b.area || 0) - (a.area || 0);
        if (Math.abs((b.score?.outerCoverage || 0) - (a.score?.outerCoverage || 0)) > 1e-6) return (b.score?.outerCoverage || 0) - (a.score?.outerCoverage || 0);
        if (Math.abs((b.score?.pointCoverage || 0) - (a.score?.pointCoverage || 0)) > 1e-6) return (b.score?.pointCoverage || 0) - (a.score?.pointCoverage || 0);
        return (b.score?.score || 0) - (a.score?.score || 0);
      });
  }

  global.NestDxfOpenBuilderHelpers = {
    buildEntitySegments,
    ringCenter,
    pointInsideRing,
    snapSegments,
    buildOwnedOpenSegments,
    buildOpenGraphFromShape,
    findAttachedOpenEntities,
    buildLocalGraph,
    rankParentBuilderCycles,
    rankOpenBuilderCycles,
  };
})(window);
