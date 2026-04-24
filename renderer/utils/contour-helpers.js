(function attachNestDxfContourHelpers(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  if (!geometry) {
    global.NestDxfContourHelpers = {};
    return;
  }

  const {
    EPS,
    unionBBox,
    entityBBox,
  } = geometry;

  function emptyContourResult(builderMode, builderDebug = null) {
    console.log("emptyContourResult", builderDebug);
    return {
      polygonPoints: null,
      source: null,
      coverage: null,
      rankedCandidates: [],
      builderMode,
      builderDebug,
    };
  }

  function computeEntitiesBBox(entities) {
    let bbox = null;
    (entities || []).forEach(entity => {
      bbox = unionBBox(bbox, entityBBox(entity));
    });
    return bbox;
  }

  function bboxSpan(bbox) {
    if (!bbox) return 0;
    return Math.max(EPS, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
  }

  function compareContourCandidatesByGeometry(a, b) {
    if (Math.abs((b.area || 0) - (a.area || 0)) > EPS) return (b.area || 0) - (a.area || 0);
    if ((a.mergeCount || 0) !== (b.mergeCount || 0)) return (a.mergeCount || 0) - (b.mergeCount || 0);
    if (Math.abs((a.closureGap || 0) - (b.closureGap || 0)) > EPS) return (a.closureGap || 0) - (b.closureGap || 0);
    return (b.pathLength || 0) - (a.pathLength || 0);
  }

  global.NestDxfContourHelpers = {
    emptyContourResult,
    computeEntitiesBBox,
    bboxSpan,
    compareContourCandidatesByGeometry,
  };
})(window);
