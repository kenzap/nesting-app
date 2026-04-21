(function attachNestDxfShapeStructureService(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const {
    buildSketchGroups,
    extractPolygonForEntities,
  } = global.NestDxfFlattenService || {
    buildSketchGroups: () => [],
    extractPolygonForEntities: () => null,
  };
  const {
    debugDXF,
    buildClosedContoursFromLines,
  } = global.NestDxfShapeDetectionService || {
    debugDXF: () => {},
    buildClosedContoursFromLines: () => [],
  };

  if (!geometry) {
    global.NestDxfShapeStructureService = {
      detectShapes() { return []; },
      detectShapeGroups() { return []; },
      selectParentContour() { return null; },
    };
    return;
  }

  const {
    EPS,
    TWO_PI,
    LOOP_TOLERANCE,
    unionBBox,
    entityBBox,
    samplePoint,
    safeSamplePoint,
    pointInPoly,
    bboxContainsPoint,
    closePointRing,
    polylineVerticesToPoints,
    ellipseToPoints,
    splineToPoints,
    circleToPoints,
  } = geometry;

  function isRenderableEntity(entity) {
    return !!entity?.type && !['HATCH', 'TEXT', 'MTEXT', 'DIMENSION', 'INSERT', 'POINT'].includes(entity.type);
  }

  function isClosedArc(entity) {
    if (entity?.type !== 'ARC' || !entity.center || !Number.isFinite(entity.radius)) return false;
    let span = Number.isFinite(entity.angleLength)
      ? Math.abs(entity.angleLength)
      : Math.abs((entity.endAngle || 0) - (entity.startAngle || 0));
    while (span > TWO_PI) span -= TWO_PI;
    if (span <= 0) span += TWO_PI;
    return span >= TWO_PI - 1e-3;
  }

  function isClosedEntity(entity) {
    if (!entity?.type) return false;
    if (entity.type === 'CIRCLE') return true;
    if (entity.type === 'ARC') return isClosedArc(entity);
    if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.vertices?.length >= 3) {
      return entity.closed !== false;
    }
    if (entity.type === 'ELLIPSE') {
      const start = entity.startParameter ?? entity.startAngle ?? 0;
      const end = entity.endParameter ?? entity.endAngle ?? TWO_PI;
      return Math.abs(Math.abs(end - start) - TWO_PI) < 1e-4 || Math.abs((end - start) % TWO_PI) < 1e-4;
    }
    if (entity.type === 'SPLINE') return !!entity.closed;
    return false;
  }

  function entityToPoints(entity) {
    if (!entity?.type) return [];
    switch (entity.type) {
      case 'LWPOLYLINE':
      case 'POLYLINE':
        return Array.isArray(entity.vertices)
          ? polylineVerticesToPoints(entity.vertices, entity.closed !== false)
          : [];
      case 'CIRCLE':
        return circleToPoints(entity);
      case 'ARC':
        return isClosedArc(entity)
          ? circleToPoints({ center: entity.center, radius: entity.radius })
          : [];
      case 'ELLIPSE':
        return ellipseToPoints(entity, isClosedEntity(entity));
      case 'SPLINE':
        return splineToPoints(entity);
      default:
        return [];
    }
  }

  function containsPoint(candidate, point, eps = LOOP_TOLERANCE * 8) {
    if (!candidate?.bbox || !point) return false;
    if (!bboxContainsPoint(candidate.bbox, point, eps)) return false;
    if (!candidate.points?.length) return false;
    if (pointInPoly(point.x, point.y, candidate.points)) return true;

    // Boundary-friendly fallback so geometry that sits on the outline still
    // belongs to the parent instead of being kicked out as a separate sketch.
    for (let i = 0; i < candidate.points.length; i++) {
      const a = candidate.points[i];
      const b = candidate.points[(i + 1) % candidate.points.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 <= EPS) continue;
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2));
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      if (Math.hypot(point.x - px, point.y - py) <= eps) return true;
    }

    return false;
  }

  function bboxGap(a, b) {
    if (!a || !b) return Infinity;
    const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
    const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
    return Math.hypot(dx, dy);
  }

  function collectContourCandidates(entities) {
    return entities
      .filter(isClosedEntity)
      .map((entity, index) => {
        const points = closePointRing(entityToPoints(entity));
        const bbox = entityBBox(entity);
        if (!bbox || points.length < 4) return null;
        const polygon = extractPolygonForEntities([entity]);
        const area = polygon?.area || Math.abs(geometry.polygonSignedArea(points.slice(0, -1)));
        return {
          id: entity.handle || `cc_${index}`,
          entity,
          layer: entity.layer || '0',
          bbox,
          points,
          polygonPoints: polygon?.polygonPoints || points,
          area,
          sample: safeSamplePoint(entity) || points[0] || null,
          isClosed: true,
        };
      })
      .filter(candidate => candidate && candidate.area > EPS);
  }

  function scoreParentContour(candidate, entities, groupBBox) {
    let insideCount = 0;
    let touchCount = 0;
    let closedInsideCount = 0;

    entities.forEach(entity => {
      if (entity === candidate.entity) return;
      const probe = samplePoint(entity);
      const bbox = entityBBox(entity);
      const inside = probe ? containsPoint(candidate, probe) : false;
      const near = bbox ? bboxGap(candidate.bbox, bbox) <= LOOP_TOLERANCE * 40 : false;
      if (inside) {
        insideCount += 1;
        if (isClosedEntity(entity)) closedInsideCount += 1;
      }
      if (inside || near) touchCount += 1;
    });

    const groupWidth = Math.max(EPS, groupBBox.maxX - groupBBox.minX);
    const groupHeight = Math.max(EPS, groupBBox.maxY - groupBBox.minY);
    const candidateWidth = Math.max(EPS, candidate.bbox.maxX - candidate.bbox.minX);
    const candidateHeight = Math.max(EPS, candidate.bbox.maxY - candidate.bbox.minY);
    const bboxCoverage = (candidateWidth * candidateHeight) / (groupWidth * groupHeight);
    const aspect = Math.max(candidateWidth, candidateHeight) / Math.max(EPS, Math.min(candidateWidth, candidateHeight));
    const stripPenalty = aspect > 20 ? 2 : aspect > 10 ? 1 : 0;

    return {
      insideCount,
      touchCount,
      closedInsideCount,
      bboxCoverage,
      stripPenalty,
      area: candidate.area,
      isSynthetic: false,
    };
  }

  function compareScores(a, b) {
    if (a.closedInsideCount !== b.closedInsideCount) return b.closedInsideCount - a.closedInsideCount;
    if (a.insideCount !== b.insideCount) return b.insideCount - a.insideCount;
    if (a.touchCount !== b.touchCount) return b.touchCount - a.touchCount;
    if (a.stripPenalty !== b.stripPenalty) return a.stripPenalty - b.stripPenalty;
    if (Math.abs(a.bboxCoverage - b.bboxCoverage) > 1e-6) return b.bboxCoverage - a.bboxCoverage;
    return b.area - a.area;
  }

  function findPeerOuterCandidates(ranked) {
    if (!ranked.length) return [];
    const leader = ranked[0];
    if (!leader) return [];
    return ranked
      .filter(entry => {
        const score = entry.score;
        return Math.abs(score.closedInsideCount - leader.score.closedInsideCount) <= 0 &&
          Math.abs(score.insideCount - leader.score.insideCount) <= 0 &&
          Math.abs(score.touchCount - leader.score.touchCount) <= 0 &&
          Math.abs(score.stripPenalty - leader.score.stripPenalty) <= 0 &&
          Math.abs(score.bboxCoverage - leader.score.bboxCoverage) <= 0.02 &&
          Math.abs(score.area - leader.score.area) <= Math.max(leader.score.area * 0.05, 1);
      })
      .map(entry => entry.candidate);
  }

  function selectParentContour(entities) {
    const candidates = collectContourCandidates(entities);
    if (!candidates.length) return { parentContour: null, peerOuters: [], ranked: [] };

    let groupBBox = null;
    entities.forEach(entity => { groupBBox = unionBBox(groupBBox, entityBBox(entity)); });
    if (!groupBBox) {
      const sorted = candidates.slice().sort((a, b) => b.area - a.area);
      return {
        parentContour: sorted[0] || null,
        peerOuters: sorted[0] ? [sorted[0]] : [],
        ranked: sorted.map(candidate => ({ candidate, score: { area: candidate.area } })),
      };
    }

    const ranked = candidates.map(candidate => ({
      candidate,
      score: scoreParentContour(candidate, entities, groupBBox),
    }));
    ranked.sort((a, b) => compareScores(a.score, b.score));
    const peerOuters = findPeerOuterCandidates(ranked);

    debugDXF('Parent contour scoring', {
      entityCount: entities.length,
      candidateCount: ranked.length,
      chosenContourId: ranked[0]?.candidate?.id || null,
      peerOuterIds: peerOuters.map(candidate => candidate.id),
      scores: ranked.map(entry => ({
        contourId: entry.candidate.id,
        layer: entry.candidate.layer,
        score: entry.score,
      })),
    });

    return {
      parentContour: ranked[0]?.candidate || null,
      peerOuters,
      ranked,
    };
  }

  function assignEntitiesToParent(parentContour, entities) {
    if (!parentContour) {
      return {
        ownedEntities: [...entities],
        insideEntities: [],
        attachedEntities: [...entities],
      };
    }

    const ownedEntities = [];
    const insideEntities = [];
    const attachedEntities = [];

    entities.forEach(entity => {
      const probe = samplePoint(entity);
      const bbox = entityBBox(entity);
      const inside = probe ? containsPoint(parentContour, probe) : false;
      const attached = bbox ? bboxGap(parentContour.bbox, bbox) <= LOOP_TOLERANCE * 40 : false;
      if (inside || attached || entity === parentContour.entity) {
        ownedEntities.push(entity);
        if (inside) insideEntities.push(entity);
        if (attached) attachedEntities.push(entity);
      }
    });

    return { ownedEntities, insideEntities, attachedEntities };
  }

  function pointsBBox(points) {
    if (!Array.isArray(points) || !points.length) return null;
    let minX = points[0].x;
    let maxX = points[0].x;
    let minY = points[0].y;
    let maxY = points[0].y;
    points.forEach(point => {
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    });
    return { minX, minY, maxX, maxY };
  }

  function containsPointInRing(points, point) {
    if (!Array.isArray(points) || points.length < 4 || !point) return false;
    const bbox = pointsBBox(points);
    if (!bbox || !bboxContainsPoint(bbox, point, LOOP_TOLERANCE * 12)) return false;
    return pointInPoly(point.x, point.y, points);
  }

  function polygonArea(points) {
    if (!Array.isArray(points) || points.length < 4) return 0;
    return Math.abs(geometry.polygonSignedArea(points.slice(0, -1)));
  }

  function bboxArea(bbox) {
    if (!bbox) return 0;
    return Math.max(0, bbox.maxX - bbox.minX) * Math.max(0, bbox.maxY - bbox.minY);
  }

  function groupBBox(group) {
    let bbox = null;
    (group?.entities || []).forEach(entity => { bbox = unionBBox(bbox, entityBBox(entity)); });
    return bbox;
  }

  function splitGroupsByClosedness(groups) {
    return groups.map(entities => {
      const closedContours = collectContourCandidates(entities);
      const openEntities = entities.filter(entity => !isClosedEntity(entity));
      return {
        entities,
        closedContours,
        openEntities,
        closedCount: closedContours.length,
        openCount: openEntities.length,
      };
    });
  }

  function buildEnvelopeOwnersForOpenGroups(groupMeta) {
    const { buildRasterEnvelopes } = global.NestDxfRasterEnvelopeService || {
      buildRasterEnvelopes: () => [],
    };

    return groupMeta
      .map(group => {
        const extracted = extractPolygonForEntities(group.entities);
        const polygonPoints = extracted?.polygonPoints?.length
          ? extracted.polygonPoints
          : null;
        const inferredLoop = !polygonPoints
          ? buildClosedContoursFromLines(group.entities)
              .slice()
              .sort((a, b) => polygonArea(b?.points || []) - polygonArea(a?.points || []))[0]
          : null;
        const inferredPoints = Array.isArray(inferredLoop?.points) && inferredLoop.points.length >= 4
          ? closePointRing(inferredLoop.points)
          : null;
        let envelope = null;
        if (!polygonPoints && !inferredPoints && group.openCount > 0) {
          const envelopes = buildRasterEnvelopes(group.entities, {
            strokeRadius: undefined,
            sampleStep: undefined,
            paddingCells: 3,
          });
          envelope = envelopes
            .slice()
            .sort((a, b) => (b.entities?.length || 0) - (a.entities?.length || 0))[0];
        }
        const ownerPoints = polygonPoints ||
          inferredPoints ||
          (envelope?.polygonPoints?.length ? envelope.polygonPoints : null);
        return {
          group,
          envelopePoints: ownerPoints,
          envelopeBBox: ownerPoints ? pointsBBox(ownerPoints) : null,
          envelopeArea: ownerPoints ? polygonArea(ownerPoints) : 0,
        };
      })
      .filter(owner => Array.isArray(owner.envelopePoints) && owner.envelopePoints.length >= 4);
  }

  function isAbsorbableChildGroup(group) {
    if (!group) return false;
    if (group.closedCount <= 0) return false;
    if (group.openCount === 0) return true;
    if (group.entities.length <= 4 && group.openCount <= 2) return true;
    if (group.entities.length <= 5 && group.openCount <= 1) return true;
    return false;
  }

  function groupProbePoints(group) {
    const contourPoints = (group.closedContours || [])
      .map(contour => contour.sample || safeSamplePoint(contour.entity))
      .filter(Boolean);
    const openPoints = (group.openEntities || [])
      .map(entity => safeSamplePoint(entity))
      .filter(Boolean);
    return [...contourPoints, ...openPoints];
  }

  function estimateGroupArea(group, ownerByGroup) {
    const owner = ownerByGroup?.get(group);
    if (owner?.envelopeArea > EPS) return owner.envelopeArea;

    const closedArea = (group?.closedContours || []).reduce((maxArea, contour) => {
      const area = Math.abs(contour?.area || 0);
      return area > maxArea ? area : maxArea;
    }, 0);
    if (closedArea > EPS) return closedArea;

    return bboxArea(groupBBox(group));
  }

  function ownerContainsGroup(owner, probes) {
    if (!owner?.envelopeBBox || !Array.isArray(owner.envelopePoints) || owner.envelopePoints.length < 4) return false;
    if (!Array.isArray(probes) || !probes.length) return false;
    return probes.every(point =>
      bboxContainsPoint(owner.envelopeBBox, point, LOOP_TOLERANCE * 12) &&
      containsPointInRing(owner.envelopePoints, point)
    );
  }

  function mergeClosedGroupsIntoOpenOwners(groupMeta) {
    if (!groupMeta.length) return groupMeta.map(group => ({
      entities: group.entities,
      envelopePoints: null,
    }));
    const openOwners = buildEnvelopeOwnersForOpenGroups(groupMeta);
    if (!openOwners.length) {
      return groupMeta.map(group => ({
        entities: group.entities,
        envelopePoints: null,
      }));
    }

    const ownerByGroup = new Map(openOwners.map(owner => [owner.group, owner]));
    const absorbedByGroup = new Map();
    const absorbedIdsByOwner = new Map(openOwners.map(owner => [owner.group, []]));
    const absorbedGroups = new Set();

    // Merge any child group whose representative points all sit inside a
    // larger open-owner envelope. This covers open-inside-open sketches, not
    // just the original closed-inside-open fallback.
    const rankedGroups = groupMeta
      .map(group => ({
        group,
        probes: groupProbePoints(group),
        area: estimateGroupArea(group, ownerByGroup),
      }))
      .filter(entry => entry.probes.length)
      .sort((a, b) => a.area - b.area);

    rankedGroups.forEach(({ group, probes, area }) => {
      const candidateOwners = openOwners
        .filter(owner => owner.group !== group)
        .filter(owner => owner.envelopeArea > Math.max(area + EPS, area * 1.02))
        .filter(owner => ownerContainsGroup(owner, probes));

      if (!candidateOwners.length) return;

      candidateOwners.sort((a, b) => a.envelopeArea - b.envelopeArea);
      const owner = candidateOwners[0];
      absorbedByGroup.set(group, owner.group);
      absorbedGroups.add(group);
      absorbedIdsByOwner.get(owner.group).push(...group.closedContours.map(contour => contour.id));
    });

    const resolveRootGroup = group => {
      let current = group;
      const seen = new Set([current]);
      while (absorbedByGroup.has(current)) {
        current = absorbedByGroup.get(current);
        if (!current || seen.has(current)) break;
        seen.add(current);
      }
      return current;
    };

    const mergedEntitiesByRoot = new Map();
    groupMeta.forEach(group => {
      const root = resolveRootGroup(group);
      const current = mergedEntitiesByRoot.get(root) || [];
      current.push(...group.entities);
      mergedEntitiesByRoot.set(root, current);
    });

    const outputGroups = [];
    groupMeta.forEach(group => {
      if (absorbedGroups.has(group)) return;
      const owner = ownerByGroup.get(group);
      outputGroups.push({
        entities: mergedEntitiesByRoot.get(group) || group.entities,
        envelopePoints: owner?.envelopePoints || null,
      });
    });

    return outputGroups;
  }

  function shouldRecoverEnvelopeParent(groupEntities, contourSelection) {
    const parentContour = contourSelection?.parentContour || null;
    const ranked = contourSelection?.ranked || [];
    const peerOuters = contourSelection?.peerOuters || [];
    const leaderScore = ranked[0]?.score || null;
    if (!parentContour || !leaderScore) return false;

    const entityCount = groupEntities?.length || 0;
    const minTouchCount = Math.max(1, Math.min(entityCount - 1, 3));
    const dominantCoverage = (leaderScore.bboxCoverage ?? 0) >= 0.6;
    const strongAttachment = (leaderScore.touchCount ?? 0) >= minTouchCount;
    const clearLeader = peerOuters.length <= 1;

    return clearLeader && dominantCoverage && strongAttachment;
  }

  function buildShapeRecord(groupRecord, index) {
    const groupEntities = groupRecord.entities || [];
    const hasEnvelopeParent = Array.isArray(groupRecord.envelopePoints) && groupRecord.envelopePoints.length >= 4;
    const recoveredContourSelection = hasEnvelopeParent ? selectParentContour(groupEntities) : null;
    const recoverEnvelopeParent = hasEnvelopeParent && shouldRecoverEnvelopeParent(groupEntities, recoveredContourSelection);
    const contourSelection = hasEnvelopeParent && !recoverEnvelopeParent
      ? { parentContour: null, peerOuters: [], ranked: [] }
      : (recoveredContourSelection || selectParentContour(groupEntities));
    const parentContour = contourSelection.parentContour;
    const peerOuters = contourSelection.peerOuters || [];
    const usePeerOuters = !hasEnvelopeParent && peerOuters.length > 1;
    const assignment = assignEntitiesToParent(parentContour, groupEntities);
    const singleClearParent = !hasEnvelopeParent && !usePeerOuters && contourSelection.ranked?.length === 1 && !!parentContour;
    const ownedEntities = (hasEnvelopeParent || usePeerOuters || singleClearParent)
      ? groupEntities
      : assignment.ownedEntities;
    let bbox = null;
    ownedEntities.forEach(entity => { bbox = unionBBox(bbox, entityBBox(entity)); });

    const childClosedContours = collectContourCandidates(ownedEntities)
      .filter(candidate => !peerOuters.some(peer => peer.id === candidate.id));
    const openEntities = ownedEntities.filter(entity => !isClosedEntity(entity));
    const fallbackPolygon = groupRecord.envelopePoints?.length ? groupRecord.envelopePoints : null;
    const primaryPolygon = usePeerOuters
      ? (extractPolygonForEntities(ownedEntities)?.polygonPoints || null)
      : parentContour?.polygonPoints || null;

    return {
      id: `shape_${index}`,
      parentContour: usePeerOuters ? null : parentContour,
      peerOuters,
      childClosedContours,
      openEntities,
      entities: ownedEntities,
      bbox,
      polygonPoints: primaryPolygon || fallbackPolygon || null,
      envelopePoints: fallbackPolygon,
      layer: parentContour?.layer || ownedEntities[0]?.layer || '0',
      usedWholeGroup: hasEnvelopeParent || usePeerOuters || singleClearParent,
    };
  }

  function buildShapeGroupRecords(entities, options = {}) {
    const renderableEntities = (entities || []).filter(isRenderableEntity);
    if (!renderableEntities.length) return { renderableEntities: [], groupRecords: [] };

    const initialGroups = options.singleSketch
      ? [renderableEntities]
      : buildSketchGroups(renderableEntities);
    const groupRecords = options.singleSketch
      ? initialGroups
      : mergeClosedGroupsIntoOpenOwners(splitGroupsByClosedness(initialGroups));

    return { renderableEntities, groupRecords };
  }

  function detectShapeGroups(entities, options = {}) {
    return buildShapeGroupRecords(entities, options).groupRecords.map(group => group.entities);
  }

  function detectShapes(entities, options = {}) {
    const { groupRecords } = buildShapeGroupRecords(entities, options);
    const shapes = groupRecords
      .map((groupRecord, index) => buildShapeRecord(groupRecord, index))
      .filter(Boolean);

    return shapes;
  }

  global.NestDxfShapeStructureService = {
    detectShapes,
    detectShapeGroups,
    selectParentContour,
    assignEntitiesToParent,
    collectContourCandidates,
  };
})(window);
