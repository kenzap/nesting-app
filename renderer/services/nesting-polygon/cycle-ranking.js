(function attachNestDxfNestingCycleRanking(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const graphUtils = global.NestDxfNestingGraphUtils || {};
  if (!geometry) {
    global.NestDxfNestingCycleRanking = {};
    return;
  }

  const {
    EPS,
    dist,
    closePointRing,
    polygonSignedArea,
    normalizeWindingCCW,
  } = geometry;

  const {
    ringBBox,
    splitSegmentsAtIntersections,
    buildGraphFromSegments,
    enumerateSimpleCycles,
  } = graphUtils;

  function extractOutermostSimpleLoop(points, tolerance) {
    const ring = closePointRing(points || []);
    if (ring.length < 4 || !ringBBox || !splitSegmentsAtIntersections || !buildGraphFromSegments || !enumerateSimpleCycles) return null;
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

  global.NestDxfNestingCycleRanking = {
    extractOutermostSimpleLoop,
  };
})(window);
