(function attachNestDxfShapeDetectionService(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const svg = global.NestDxfSvg;

  const {
    EPS,
    TWO_PI,
    LOOP_TOLERANCE,
    pointInPoly,
    samePoint,
    getLineEndpoints,
    getArcEndpoints,
    pointKey,
    dedupePoints,
    normalizedClosedPointSignature,
    bboxFromPoints,
    polygonSignedArea,
    normalizeWindingCCW,
    interiorPoint,
    bboxContainsPoint,
    samplePoint,
    safeSamplePoint,
  } = geometry;

  const { f, pathFromPoints } = svg;

  const DXF_DEBUG = true;

  // Logs a labelled diagnostic object to the console. Gated on DXF_DEBUG so
  // it produces no output in production without changing call sites.
  function debugDXF(label, payload) {
    if (!DXF_DEBUG) return;
    console.log(`[DXF DEBUG] ${label}`, payload);
  }

  // Returns true for entity types that inherently form a closed ring (circle,
  // closed polyline, closed ellipse, closed spline). These can be used directly
  // as contours without any edge-chaining work.
  function isClosedEntity(ent) {
    if (!ent) return false;
    if ((ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') && ent.vertices?.length >= 3) {
      return ent.closed !== false;
    }
    if (ent.type === 'CIRCLE') return true;
    if (ent.type === 'ELLIPSE') {
      const start = ent.startParameter ?? ent.startAngle ?? 0;
      const end = ent.endParameter ?? ent.endAngle ?? TWO_PI;
      return Math.abs(Math.abs(end - start) - TWO_PI) < 1e-4 || Math.abs((end - start) % TWO_PI) < 1e-4;
    }
    if (ent.type === 'SPLINE') return !!ent.closed && (ent.fitPoints?.length > 2 || ent.controlPoints?.length > 2);
    return false;
  }

  // Converts a closed contour entity into a flat array of {x,y} sample points
  // needed for polygon area calculations, point-in-polygon tests, and SVG path
  // generation when arc-accurate paths aren't required.
  function contourEntityToPoints(ent) {
    switch (ent.type) {
      case 'LINE_LOOP':
        return dedupePoints(ent.points || [], true);
      case 'LWPOLYLINE':
      case 'POLYLINE':
        return geometry.polylineVerticesToPoints(ent.vertices, true);
      case 'CIRCLE':
        return geometry.circleToPoints(ent);
      case 'ELLIPSE':
        return geometry.ellipseToPoints(ent, true);
      case 'SPLINE':
        return geometry.splineToPoints(ent);
      default:
        return [];
    }
  }

  // Builds the SVG arc path segment ("A…") for one ARC edge inside a LINE_LOOP.
  // Handles traversal direction (reversed flag) and the SVG large-arc flag so
  // arcs spanning more than 180° render correctly.
  function arcChainSegment(ent, ox, originMaxY, reversed) {
    const cx = ent.center.x - ox;
    const cy = originMaxY - ent.center.y;
    const r = ent.radius;
    const endAngle = reversed ? (ent.startAngle || 0) : (ent.endAngle || 0);
    let span = Number.isFinite(ent.angleLength) ? ent.angleLength : (ent.endAngle - ent.startAngle);
    if (span <= 0) span += TWO_PI;
    if (span >= TWO_PI - 1e-4) span = TWO_PI - 1e-4;
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy - r * Math.sin(endAngle);
    const large = span > Math.PI ? 1 : 0;
    const sweep = reversed ? 0 : 1;
    return `A${f(r)},${f(r)},0,${large},${sweep},${f(x2)},${f(y2)}`;
  }

  // Converts an ordered sequence of LINE/ARC half-edges into a single closed
  // SVG path string. Uses arcChainSegment for arcs so the output is geometrically
  // exact rather than a polygon approximation.
  function lineLoopToSVGPath(orderedEdges, ox, originMaxY) {
    if (!orderedEdges || !orderedEdges.length) return '';

    function edgeStartPoint(entity, reversed) {
      if (entity.type === 'LINE') {
        const endpoints = getLineEndpoints(entity);
        return reversed ? endpoints.end : endpoints.start;
      }
      if (entity.type === 'ARC') {
        const angle = reversed ? (entity.endAngle || 0) : (entity.startAngle || 0);
        return {
          x: entity.center.x + entity.radius * Math.cos(angle),
          y: entity.center.y + entity.radius * Math.sin(angle),
        };
      }
      return null;
    }

    const first = orderedEdges[0];
    const p0 = edgeStartPoint(first.entity, first.reversed);
    if (!p0) return '';

    let d = `M${f(p0.x - ox)},${f(originMaxY - p0.y)}`;

    orderedEdges.forEach(({ entity, reversed }) => {
      if (entity.type === 'LINE') {
        const endpoints = getLineEndpoints(entity);
        const end = reversed ? endpoints.start : endpoints.end;
        d += ` L${f(end.x - ox)},${f(originMaxY - end.y)}`;
      } else if (entity.type === 'ARC') {
        d += ` ${arcChainSegment(entity, ox, originMaxY, reversed)}`;
      }
    });

    return d + ' Z';
  }

  // Unified converter from a contour entity to an SVG path string. Routes
  // LINE_LOOPs through the arc-accurate lineLoopToSVGPath and everything else
  // through the point-sampling pathFromPoints fallback.
  function contourEntityToPath(ent, ox, originMaxY) {
    if (ent.type === 'LINE_LOOP' && ent.orderedEdges) {
      return lineLoopToSVGPath(ent.orderedEdges, ox, originMaxY);
    }
    const points = contourEntityToPoints(ent);
    return pathFromPoints(points, ox, originMaxY, true);
  }

  // Returns the {start, end} endpoints of an open LINE or ARC entity, or null
  // for any other type. Used by buildClosedContoursFromLines to build the graph
  // of connectable edges.
  function getOpenEdgeEndpoints(ent) {
    if (ent?.type === 'LINE') return getLineEndpoints(ent);
    if (ent?.type === 'ARC') return getArcEndpoints(ent);
    return null;
  }

  // Main graph-tracing algorithm that finds closed rings from loose LINE/ARC
  // entities. Builds a planar half-edge graph, traces interior faces using the
  // CCW left-turn rule, and recovers the exterior boundary via its complement.
  // Returns synthetic LINE_LOOP entities for every closed ring found.
  function buildClosedContoursFromLines(entities) {
    const openEdges = entities
      .filter(ent => (ent?.type === 'LINE' || ent?.type === 'ARC'))
      .map((entity, index) => {
        const endpoints = getOpenEdgeEndpoints(entity);
        if (!endpoints || samePoint(endpoints.start, endpoints.end, LOOP_TOLERANCE)) return null;
        return {
          id: `oe_${index}`,
          entity,
          start: { x: endpoints.start.x, y: endpoints.start.y },
          end: { x: endpoints.end.x, y: endpoints.end.y },
          layer: entity.layer || '0',
        };
      })
      .filter(Boolean);

    if (!openEdges.length) return [];

    const allPoints = openEdges.flatMap(edge => [edge.start, edge.end]);
    const xVals = allPoints.map(point => point.x);
    const yVals = allPoints.map(point => point.y);
    const span = Math.hypot(Math.max(...xVals) - Math.min(...xVals), Math.max(...yVals) - Math.min(...yVals));
    const snapTol = Math.max(LOOP_TOLERANCE, span * 1e-4);
    const adjacency = new Map();
    const nodes = new Map();

    function ensureNode(point) {
      const key = pointKey(point, snapTol);
      if (!adjacency.has(key)) adjacency.set(key, []);
      if (!nodes.has(key)) nodes.set(key, { x: point.x, y: point.y, key });
      return key;
    }

    openEdges.forEach((edge, index) => {
      edge.startKey = ensureNode(edge.start);
      edge.endKey = ensureNode(edge.end);
      adjacency.get(edge.startKey).push(index);
      adjacency.get(edge.endKey).push(index);
    });

    const edgeComponent = new Map();
    let componentSeq = 0;
    openEdges.forEach((edge, index) => {
      if (edgeComponent.has(index)) return;
      const queue = [index];
      edgeComponent.set(index, componentSeq);
      while (queue.length) {
        const currentIndex = queue.pop();
        const current = openEdges[currentIndex];
        [current.startKey, current.endKey].forEach(nodeKey => {
          (adjacency.get(nodeKey) || []).forEach(nextIndex => {
            if (edgeComponent.has(nextIndex)) return;
            edgeComponent.set(nextIndex, componentSeq);
            queue.push(nextIndex);
          });
        });
      }
      componentSeq += 1;
    });

    openEdges.forEach((edge, index) => {
      edge.entity.__openEdgeComponentId = edgeComponent.get(index);
    });

    const outgoing = new Map();
    function registerOutgoing(fromKey, edgeIndex, toKey) {
      if (!outgoing.has(fromKey)) outgoing.set(fromKey, []);
      const from = nodes.get(fromKey);
      const to = nodes.get(toKey);
      outgoing.get(fromKey).push({
        edgeIndex,
        fromKey,
        toKey,
        angle: Math.atan2(to.y - from.y, to.x - from.x),
      });
    }

    openEdges.forEach((edge, index) => {
      registerOutgoing(edge.startKey, index, edge.endKey);
      registerOutgoing(edge.endKey, index, edge.startKey);
    });
    outgoing.forEach(list => list.sort((a, b) => a.angle - b.angle));

    function halfEdgeKey(fromKey, edgeIndex, toKey) {
      return `${fromKey}|${edgeIndex}|${toKey}`;
    }

    function normalizeCycle(pointKeys) {
      const ring = pointKeys.slice(0, -1);
      if (!ring.length) return '';
      let best = null;
      for (let offset = 0; offset < ring.length; offset++) {
        const rotated = ring.slice(offset).concat(ring.slice(0, offset));
        const reversed = rotated.slice().reverse();
        const candidate = rotated.join('>');
        const reverseCandidate = reversed.join('>');
        const winner = candidate < reverseCandidate ? candidate : reverseCandidate;
        if (!best || winner < best) best = winner;
      }
      return best || '';
    }

    function traceFace(startHalfEdge) {
      const visitedInFace = new Set();
      const edgeIndices = [];
      const pointKeys = [startHalfEdge.fromKey];
      let current = startHalfEdge;
      let safety = 0;

      while (safety++ < openEdges.length * 2 + 8) {
        const currentKey = halfEdgeKey(current.fromKey, current.edgeIndex, current.toKey);
        if (visitedInFace.has(currentKey)) return null;
        visitedInFace.add(currentKey);
        edgeIndices.push(current.edgeIndex);
        pointKeys.push(current.toKey);

        if (current.toKey === startHalfEdge.fromKey) {
          const points = dedupePoints(pointKeys.map(key => nodes.get(key)), true);
          if (points.length < 3) return null;
          const area = polygonSignedArea(points);
          if (Math.abs(area) <= EPS) return null;
          return { points, pointKeys, edgeIndices, area };
        }

        const options = outgoing.get(current.toKey) || [];
        const reverseIndex = options.findIndex(option => option.edgeIndex === current.edgeIndex && option.toKey === current.fromKey);
        if (reverseIndex === -1 || !options.length) return null;
        current = options[(reverseIndex - 1 + options.length) % options.length];
      }

      return null;
    }

    const loops = [];
    const visitedHalfEdges = new Set();
    const ccwHalfEdges = new Set();
    const seenCycles = new Set();

    openEdges.forEach((edge, index) => {
      const halfEdges = [
        { fromKey: edge.startKey, toKey: edge.endKey, edgeIndex: index },
        { fromKey: edge.endKey, toKey: edge.startKey, edgeIndex: index },
      ];

      halfEdges.forEach(startHalfEdge => {
        const startKey = halfEdgeKey(startHalfEdge.fromKey, startHalfEdge.edgeIndex, startHalfEdge.toKey);
        if (visitedHalfEdges.has(startKey)) return;
        const loop = traceFace(startHalfEdge);
        if (!loop) {
          visitedHalfEdges.add(startKey);
          return;
        }

        loop.pointKeys.slice(0, -1).forEach((fromKey, i) => {
          const toKey = loop.pointKeys[i + 1];
          const edgeIndex = loop.edgeIndices[i];
          const hk = halfEdgeKey(fromKey, edgeIndex, toKey);
          visitedHalfEdges.add(hk);
          if (loop.area > EPS) ccwHalfEdges.add(hk);
        });

        if (loop.area <= EPS) return;

        const cycleKey = normalizeCycle(loop.pointKeys);
        if (!cycleKey || seenCycles.has(cycleKey)) return;
        seenCycles.add(cycleKey);

        const orderedEdges = loop.edgeIndices.map((edgeIdx, i) => {
          const currentEdge = openEdges[edgeIdx];
          const fromKey = loop.pointKeys[i];
          return { entity: currentEdge.entity, reversed: fromKey !== currentEdge.startKey };
        });

        const sourceEntities = [...new Set(orderedEdges.map(item => item.entity))];
        sourceEntities.forEach(entity => { entity.__inferredContour = true; });
        const dominantLayer = sourceEntities.reduce((acc, entity) => {
          const layer = entity.layer || '0';
          acc[layer] = (acc[layer] || 0) + 1;
          return acc;
        }, {});
        const sourceLayers = Object.keys(dominantLayer);
        const layer = Object.entries(dominantLayer).sort((a, b) => b[1] - a[1])[0]?.[0] || '0';

        loops.push({
          type: 'LINE_LOOP',
          layer,
          sourceLayers,
          isSingleLayer: sourceLayers.length <= 1,
          points: loop.points,
          sourceEntities,
          orderedEdges,
          componentId: edgeComponent.get(index),
        });
      });
    });

    const maxInteriorAreaByComponent = new Map();
    loops.forEach(loop => {
      const area = Math.abs(polygonSignedArea(loop.points));
      const prev = maxInteriorAreaByComponent.get(loop.componentId) || 0;
      if (area > prev) maxInteriorAreaByComponent.set(loop.componentId, area);
    });

    const visitedExterior = new Set();
    openEdges.forEach((edge, index) => {
      [
        { fromKey: edge.startKey, edgeIndex: index, toKey: edge.endKey },
        { fromKey: edge.endKey, edgeIndex: index, toKey: edge.startKey },
      ].forEach(startHE => {
        const startHK = halfEdgeKey(startHE.fromKey, startHE.edgeIndex, startHE.toKey);
        if (ccwHalfEdges.has(startHK) || visitedExterior.has(startHK)) return;

        const edgeIndices = [];
        const pointKeys = [startHE.fromKey];
        let curFrom = startHE.fromKey;
        let curEdgeIndex = startHE.edgeIndex;
        let curTo = startHE.toKey;
        let closed = false;
        let safety = 0;

        while (safety++ < openEdges.length + 8) {
          const hk = halfEdgeKey(curFrom, curEdgeIndex, curTo);
          if (visitedExterior.has(hk)) break;
          visitedExterior.add(hk);
          edgeIndices.push(curEdgeIndex);
          pointKeys.push(curTo);

          if (curTo === startHE.fromKey) {
            closed = true;
            break;
          }

          const options = outgoing.get(curTo) || [];
          const reverseIndex = options.findIndex(opt => opt.edgeIndex === curEdgeIndex && opt.toKey === curFrom);
          let nextEdge = null;
          if (reverseIndex !== -1) {
            for (let offset = 1; offset <= options.length; offset++) {
              const idx = (reverseIndex + offset) % options.length;
              const opt = options[idx];
              const optHK = halfEdgeKey(opt.fromKey, opt.edgeIndex, opt.toKey);
              if (!ccwHalfEdges.has(optHK) && !visitedExterior.has(optHK)) {
                nextEdge = opt;
                break;
              }
            }
          }
          if (!nextEdge) break;
          curFrom = nextEdge.fromKey;
          curEdgeIndex = nextEdge.edgeIndex;
          curTo = nextEdge.toKey;
        }

        if (!closed || edgeIndices.length < 3) return;
        const points = dedupePoints(pointKeys.map(key => nodes.get(key)), true);
        if (points.length < 3) return;
        const compId = edgeComponent.get(edgeIndices[0]);
        const area = polygonSignedArea(points);
        const absArea = Math.abs(area);
        const maxInterior = maxInteriorAreaByComponent.get(compId) || 0;
        if (absArea <= maxInterior * 1.001) return;

        const ccwPoints = area < 0 ? [...points].reverse() : points;
        const orderedEdgesCW = edgeIndices.map((edgeIdx, i) => {
          const currentEdge = openEdges[edgeIdx];
          const fromKey = pointKeys[i];
          return { entity: currentEdge.entity, reversed: fromKey !== currentEdge.startKey };
        });
        const ccwEdges = area < 0
          ? [...orderedEdgesCW].reverse().map(item => ({ entity: item.entity, reversed: !item.reversed }))
          : orderedEdgesCW;

        const sourceEntities = [...new Set(ccwEdges.map(item => item.entity))];
        sourceEntities.forEach(entity => { entity.__inferredContour = true; });
        const layerMap = sourceEntities.reduce((acc, entity) => {
          const layer = entity.layer || '0';
          acc[layer] = (acc[layer] || 0) + 1;
          return acc;
        }, {});
        const sourceLayers = Object.keys(layerMap);
        const layer = Object.entries(layerMap).sort((a, b) => b[1] - a[1])[0]?.[0] || '0';

        loops.push({
          type: 'LINE_LOOP',
          layer,
          sourceLayers,
          isSingleLayer: sourceLayers.length <= 1,
          points: ccwPoints,
          sourceEntities,
          orderedEdges: ccwEdges,
          componentId: compId,
          isOuterBoundary: true,
        });
      });
    });

    const bestLoopByComponent = new Map();
    loops.forEach(loop => {
      const area = Math.abs(polygonSignedArea(loop.points));
      const prev = bestLoopByComponent.get(loop.componentId);
      const score = [loop.isOuterBoundary ? 1 : 0, area, loop.isSingleLayer ? 1 : 0];
      if (!prev || score[0] > prev.score[0] ||
          (score[0] === prev.score[0] && score[1] > prev.score[1]) ||
          (score[0] === prev.score[0] && score[1] === prev.score[1] && score[2] > prev.score[2])) {
        bestLoopByComponent.set(loop.componentId, { area, loop, score });
      }
    });
    loops.forEach(loop => {
      const area = Math.abs(polygonSignedArea(loop.points));
      const best = bestLoopByComponent.get(loop.componentId);
      loop.isPrimary = !!best && best.loop === loop;
      loop.area = area;
    });

    debugDXF('Line loop result', {
      lineCount: openEdges.filter(edge => edge.entity.type === 'LINE').length,
      arcCount: openEdges.filter(edge => edge.entity.type === 'ARC').length,
      nodeCount: nodes.size,
      componentCount: componentSeq,
      inferredLoops: loops.length,
      selectedLoops: loops.filter(loop => loop.isPrimary).length,
    });

    return loops;
  }

  // Point-in-polygon test to decide whether one contour physically encloses
  // another. Used when building the parent-child nesting tree so holes and
  // inner shapes are attached to the correct outer boundary.
  function contourContainsContour(parent, child) {
    if (!bboxContainsPoint(parent.bbox, child.sample)) return false;
    return pointInPoly(child.sample.x, child.sample.y, parent.points);
  }

  // Walks up the parent chain to count how many contours enclose this one.
  // Odd depth means the contour is a hole; even depth means it is a solid region.
  function contourDepth(contour, contourById) {
    let depth = 0;
    let current = contour;
    while (current.parentId) {
      depth += 1;
      current = contourById.get(current.parentId);
      if (!current) break;
    }
    return depth;
  }

  // Scores a contour so that real DXF entities beat synthetic LINE_LOOPs when
  // two contours share the same geometry. Higher score = preferred.
  function contourPreferenceScore(contour) {
    const entity = contour?.entity || {};
    return [
      entity.type === 'LINE_LOOP' ? 0 : 1,
      entity.isPrimary ? 1 : 0,
      entity.isSingleLayer ? 1 : 0,
      contour.area || 0,
    ];
  }

  // Comparator that uses contourPreferenceScore to choose between two contours
  // with identical geometry during deduplication. Returns positive if a is better.
  function compareContourPreference(a, b) {
    const aa = contourPreferenceScore(a);
    const bb = contourPreferenceScore(b);
    for (let i = 0; i < aa.length; i++) {
      if (aa[i] !== bb[i]) return aa[i] - bb[i];
    }
    return 0;
  }

  // Top-level entry point. Classifies all entities into closed contours, builds
  // the parent-child nesting tree, marks holes vs solid rings, and returns each
  // top-level shape grouped with its descendants and loose decorator entities.
  function groupByContour(entities) {
    const contourEntities = [...entities.filter(isClosedEntity), ...buildClosedContoursFromLines(entities)];
    const closed = contourEntities
      .map((entity, index) => {
        const points = contourEntityToPoints(entity);
        if (points.length < 3) return null;
        const bbox = bboxFromPoints(points);
        if (!bbox) return null;
        const area = Math.abs(polygonSignedArea(points));
        if (area < EPS) return null;
        return {
          id: `c_${index}`,
          entity,
          points: normalizeWindingCCW(points),
          bbox,
          area,
          sample: interiorPoint(points) || points[0],
          layer: entity.layer || '0',
        };
      })
      .filter(Boolean);

    const dedupedClosed = [];
    const contourBySignature = new Map();
    closed.forEach(contour => {
      const signature = normalizedClosedPointSignature(contour.points);
      if (!signature) {
        dedupedClosed.push(contour);
        return;
      }
      const key = `${contour.layer}|${signature}`;
      const existingIndex = contourBySignature.get(key);
      if (existingIndex === undefined) {
        contourBySignature.set(key, dedupedClosed.length);
        dedupedClosed.push(contour);
        return;
      }
      const existing = dedupedClosed[existingIndex];
      if (compareContourPreference(contour, existing) > 0) {
        dedupedClosed[existingIndex] = contour;
      }
    });

    const uniqueClosed = dedupedClosed;
    const primarySyntheticByComponent = new Map();
    uniqueClosed.forEach((contour, index) => {
      if (contour.entity?.type === 'LINE_LOOP' && contour.entity.isPrimary) {
        primarySyntheticByComponent.set(contour.entity.componentId, index);
      }
    });

    const closedEntities = new Set();
    uniqueClosed.forEach(contour => {
      if (Array.isArray(contour.entity.sourceEntities)) {
        contour.entity.sourceEntities.forEach(src => closedEntities.add(src));
      } else {
        closedEntities.add(contour.entity);
      }
    });
    const others = entities.filter(entity => !closedEntities.has(entity));

    if (!uniqueClosed.length) return [];

    const parents = uniqueClosed.map((poly, i) => {
      let bestIndex = -1;
      let bestArea = Infinity;
      uniqueClosed.forEach((other, j) => {
        if (i === j || other.area >= bestArea || other.area <= poly.area) return;
        if (contourContainsContour(other, poly)) {
          bestIndex = j;
          bestArea = other.area;
        }
      });
      if (bestIndex === -1 && poly.entity?.type === 'LINE_LOOP' && !poly.entity.isPrimary) {
        const primaryIndex = primarySyntheticByComponent.get(poly.entity.componentId);
        if (primaryIndex !== undefined && primaryIndex !== i) bestIndex = primaryIndex;
      }
      return bestIndex;
    });

    const topIndexes = uniqueClosed.map((_, index) => index).filter(index => parents[index] === -1);

    return topIndexes.map(topIndex => {
      const outer = uniqueClosed[topIndex];
      const outerBBox = outer.bbox;
      const descendantIndexes = [];
      const collect = parentIndex => uniqueClosed.forEach((_, childIndex) => {
        if (parents[childIndex] === parentIndex) {
          descendantIndexes.push(childIndex);
          collect(childIndex);
        }
      });
      collect(topIndex);
      const contourIndexes = [topIndex, ...descendantIndexes];
      const enrichedContours = contourIndexes.map(index => ({
        ...uniqueClosed[index],
        parentId: parents[index] >= 0 ? uniqueClosed[parents[index]].id : null,
      }));
      const contourById = new Map(enrichedContours.map(contour => [contour.id, contour]));
      enrichedContours.forEach(contour => {
        contour.depth = contourDepth(contour, contourById);
      });

      const contourSourceEntities = new Set();
      enrichedContours.forEach(contour => {
        if (contour.entity?.type === 'LINE_LOOP') {
          if (contour.id === outer.id && Array.isArray(contour.entity?.sourceEntities)) {
            contour.entity.sourceEntities.forEach(entity => contourSourceEntities.add(entity));
          }
          return;
        }
        if (Array.isArray(contour.entity?.sourceEntities)) {
          contour.entity.sourceEntities.forEach(entity => contourSourceEntities.add(entity));
        } else if (contour.entity) {
          contourSourceEntities.add(contour.entity);
        }
      });

      let decorators = others.filter(entity => {
        if (['HATCH', 'TEXT', 'MTEXT', 'DIMENSION', 'INSERT'].includes(entity.type)) return false;
        const point = safeSamplePoint(entity);
        if (!point) return false;
        if (!bboxContainsPoint(outerBBox, point)) return false;
        return pointInPoly(point.x, point.y, outer.points);
      });

      if (outer.entity?.type === 'LINE_LOOP' && outer.entity?.componentId !== undefined) {
        const componentDecorators = entities.filter(entity =>
          (entity?.type === 'LINE' || entity?.type === 'ARC') &&
          entity.__openEdgeComponentId === outer.entity.componentId &&
          !contourSourceEntities.has(entity)
        );
        const seen = new Set(decorators);
        componentDecorators.forEach(entity => {
          if (!seen.has(entity)) decorators.push(entity);
        });
      }

      return {
        outer,
        contours: enrichedContours,
        decorators,
        bbox: outerBBox,
        layer: outer.layer,
      };
    });
  }

  global.NestDxfShapeDetectionService = {
    DXF_DEBUG,
    debugDXF,
    isClosedEntity,
    contourEntityToPoints,
    contourEntityToPath,
    buildClosedContoursFromLines,
    contourContainsContour,
    contourDepth,
    contourPreferenceScore,
    compareContourPreference,
    groupByContour,
    lineLoopToSVGPath,
  };
})(window);
