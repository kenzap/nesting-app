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
    unionBBox,
    samplePoint,
    safeSamplePoint,
    entityBBox,
  } = geometry;

  const { f, pathFromPoints } = svg;

  const DXF_DEBUG = true;
  const DXF_DEBUG_STORE_KEY = '__NEST_DXF_DEBUG__';

  function ensureDebugStore() {
    if (!DXF_DEBUG) return null;
    if (!global[DXF_DEBUG_STORE_KEY]) {
      global[DXF_DEBUG_STORE_KEY] = {
        events: [],
        reset() {
          this.events.length = 0;
          return this;
        },
        toJSON() {
          return {
            capturedAt: new Date().toISOString(),
            count: this.events.length,
            events: this.events,
          };
        },
        stringify() {
          return JSON.stringify(this.toJSON(), null, 2);
        },
        copy() {
          const text = this.stringify();
          if (global.navigator?.clipboard?.writeText) {
            return global.navigator.clipboard.writeText(text).then(() => text);
          }
          return Promise.resolve(text);
        },
        download(filename = `dxf-debug-${Date.now()}.json`) {
          const blob = new Blob([this.stringify()], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = filename;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
      };
    }
    return global[DXF_DEBUG_STORE_KEY];
  }

  // Logs a labelled diagnostic object to the console. Gated on DXF_DEBUG so
  // it produces no output in production without changing call sites.
  function debugDXF(label, payload) {
    if (!DXF_DEBUG) return;
    const store = ensureDebugStore();
    store?.events.push({
      at: new Date().toISOString(),
      label,
      payload,
    });
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

  // Returns the intersection of two finite line segments in parametric form.
  // Used by the planar-arrangement splitter so T-junctions and crossings get
  // real graph nodes before face extraction begins.
  function intersectLineSegments(aStart, aEnd, bStart, bEnd, eps = LOOP_TOLERANCE) {
    const r = { x: aEnd.x - aStart.x, y: aEnd.y - aStart.y };
    const s = { x: bEnd.x - bStart.x, y: bEnd.y - bStart.y };
    const denom = r.x * s.y - r.y * s.x;
    const qp = { x: bStart.x - aStart.x, y: bStart.y - aStart.y };

    if (Math.abs(denom) <= eps) return null;

    const t = (qp.x * s.y - qp.y * s.x) / denom;
    const u = (qp.x * r.y - qp.y * r.x) / denom;
    if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;

    return {
      t: Math.max(0, Math.min(1, t)),
      u: Math.max(0, Math.min(1, u)),
      point: {
        x: aStart.x + r.x * t,
        y: aStart.y + r.y * t,
      },
    };
  }

  // Splits LINE entities at all line-line intersections so the half-edge graph
  // sees true planar vertices instead of long segments that skip over junctions.
  // ARC entities are preserved as-is for now and continue to rely on their DXF
  // endpoints.
  function buildPlanarOpenEdges(entities) {
    const rawEdges = entities
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
          sourceIndex: index,
        };
      })
      .filter(Boolean);

    const lineEdges = rawEdges.filter(edge => edge.entity?.type === 'LINE');
    const splitParamsByIndex = new Map();
    lineEdges.forEach((_, index) => splitParamsByIndex.set(index, [0, 1]));

    for (let i = 0; i < lineEdges.length; i++) {
      for (let j = i + 1; j < lineEdges.length; j++) {
        const a = lineEdges[i];
        const b = lineEdges[j];
        const hit = intersectLineSegments(a.start, a.end, b.start, b.end);
        if (!hit) continue;
        splitParamsByIndex.get(i).push(hit.t);
        splitParamsByIndex.get(j).push(hit.u);
      }
    }

    const planarEdges = [];
    lineEdges.forEach((edge, lineIndex) => {
      const params = [...new Set((splitParamsByIndex.get(lineIndex) || []).map(value => +value.toFixed(9)))]
        .sort((a, b) => a - b);
      for (let i = 0; i < params.length - 1; i++) {
        const t0 = params[i];
        const t1 = params[i + 1];
        if (t1 - t0 <= 1e-6) continue;
        const start = {
          x: edge.start.x + (edge.end.x - edge.start.x) * t0,
          y: edge.start.y + (edge.end.y - edge.start.y) * t0,
        };
        const end = {
          x: edge.start.x + (edge.end.x - edge.start.x) * t1,
          y: edge.start.y + (edge.end.y - edge.start.y) * t1,
        };
        if (samePoint(start, end, LOOP_TOLERANCE)) continue;
        planarEdges.push({
          ...edge,
          id: `${edge.id}_s${i}`,
          start,
          end,
          splitOf: edge.id,
        });
      }
    });

    rawEdges
      .filter(edge => edge.entity?.type !== 'LINE')
      .forEach(edge => planarEdges.push(edge));

    return {
      rawEdges,
      planarEdges,
      rawLineCount: rawEdges.filter(edge => edge.entity?.type === 'LINE').length,
      rawArcCount: rawEdges.filter(edge => edge.entity?.type === 'ARC').length,
    };
  }

  // Main graph-tracing algorithm that finds closed rings from loose LINE/ARC
  // entities. Builds a planar half-edge graph, traces interior faces using the
  // CCW left-turn rule, and recovers the exterior boundary via its complement.
  // Returns synthetic LINE_LOOP entities for every closed ring found.
  function buildClosedContoursFromLines(entities) {
    const {
      planarEdges: openEdges,
      rawLineCount,
      rawArcCount,
    } = buildPlanarOpenEdges(entities);

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
      lineCount: rawLineCount,
      arcCount: rawArcCount,
      planarEdgeCount: openEdges.length,
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

  // Returns true when the point sits on the finite line segment a->b. This is
  // important for DXFs that encode detail lines exactly on the outer contour:
  // pointInPoly alone treats many boundary cases as "outside", which makes the
  // preview silently drop geometry that visually belongs to the shape.
  function pointOnSegment(point, a, b, eps = LOOP_TOLERANCE) {
    if (!point || !a || !b) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < EPS) return samePoint(point, a, eps);
    const cross = Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx);
    if (cross > eps * Math.max(1, Math.sqrt(lenSq))) return false;
    const dot = (point.x - a.x) * dx + (point.y - a.y) * dy;
    if (dot < -eps) return false;
    if (dot > lenSq + eps) return false;
    return true;
  }

  // Boundary-aware contour membership test. We accept points that are clearly
  // inside the polygon and also points that lie exactly on any contour edge,
  // which is common in CAD files where decorators intentionally share edges
  // with the outer profile.
  function pointInsideOrOnContour(point, contour) {
    if (!point || !contour?.bbox || !contour?.points?.length) return false;
    if (!bboxContainsPoint(contour.bbox, point)) return false;
    if (pointInPoly(point.x, point.y, contour.points)) return true;
    const points = contour.points;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (pointOnSegment(point, a, b)) return true;
    }
    return false;
  }

  // Produces several representative probe points for an entity so assignment
  // decisions are not held hostage by one unlucky midpoint. This is especially
  // useful for one-layer DXFs where internal lines often touch or cross the
  // contour and their midpoint alone is not enough to determine ownership.
  function entityProbePoints(entity) {
    const probes = [];
    const addProbe = point => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      if (!probes.some(existing => samePoint(existing, point, LOOP_TOLERANCE))) {
        probes.push({ x: point.x, y: point.y });
      }
    };

    if (entity?.type === 'LINE') {
      const endpoints = getLineEndpoints(entity);
      if (endpoints) {
        addProbe(endpoints.start);
        addProbe(endpoints.end);
        addProbe({
          x: (endpoints.start.x + endpoints.end.x) / 2,
          y: (endpoints.start.y + endpoints.end.y) / 2,
        });
      }
    } else if (entity?.type === 'ARC') {
      const endpoints = getArcEndpoints(entity);
      if (endpoints) {
        addProbe(endpoints.start);
        addProbe(endpoints.end);
        const startAngle = Number.isFinite(entity.startAngle) ? entity.startAngle : 0;
        let endAngle = Number.isFinite(entity.endAngle) ? entity.endAngle : startAngle;
        while (endAngle <= startAngle) endAngle += TWO_PI;
        const midAngle = startAngle + ((endAngle - startAngle) / 2);
        addProbe({
          x: entity.center.x + entity.radius * Math.cos(midAngle),
          y: entity.center.y + entity.radius * Math.sin(midAngle),
        });
      }
    } else if (entity?.type === 'LWPOLYLINE' || entity?.type === 'POLYLINE') {
      const vertices = (entity.vertices || []).filter(vertex => Number.isFinite(vertex?.x) && Number.isFinite(vertex?.y));
      if (vertices.length) {
        addProbe(vertices[0]);
        addProbe(vertices[Math.floor(vertices.length / 2)]);
        addProbe(vertices[vertices.length - 1]);
      }
    } else if (entity?.type === 'SPLINE') {
      // Prefer fit points (the actual curve passthrough points) when present;
      // fall back to control points.  Always probe start, mid, and end so a
      // spline that begins or ends inside an outer contour is detected as
      // tier-3 "inside" even when its midpoint happens to fall outside.
      const pts = (entity.fitPoints?.length ? entity.fitPoints : entity.controlPoints || [])
        .filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));
      if (pts.length) {
        addProbe(pts[0]);
        addProbe(pts[Math.floor(pts.length / 2)]);
        addProbe(pts[pts.length - 1]);
      }
    } else if (entity?.type === 'CIRCLE') {
      // Probe center plus the four cardinal points on the circumference.
      // A single center probe fails when the circle straddles a contour
      // boundary; the cardinal points ensure at least one probe is inside.
      if (entity.center && Number.isFinite(entity.radius)) {
        addProbe(entity.center);
        const r = entity.radius;
        addProbe({ x: entity.center.x + r, y: entity.center.y });
        addProbe({ x: entity.center.x - r, y: entity.center.y });
        addProbe({ x: entity.center.x,     y: entity.center.y + r });
        addProbe({ x: entity.center.x,     y: entity.center.y - r });
      }
    } else if (entity?.type === 'ELLIPSE') {
      // Probe center plus the four axis tips.
      // majorAxisEndPoint is the major semi-axis vector relative to center;
      // the minor semi-axis is perpendicular with length = axisRatio * |major|.
      if (entity.center && entity.majorAxisEndPoint) {
        addProbe(entity.center);
        const mx = Number(entity.majorAxisEndPoint.x) || 0;
        const my = Number(entity.majorAxisEndPoint.y) || 0;
        const ratio = Number.isFinite(entity.axisRatio) ? entity.axisRatio : 1;
        // minor axis is the perpendicular unit vector scaled by ratio * |major|
        const minorScale = ratio;
        addProbe({ x: entity.center.x + mx,              y: entity.center.y + my });
        addProbe({ x: entity.center.x - mx,              y: entity.center.y - my });
        addProbe({ x: entity.center.x + (-my * minorScale), y: entity.center.y + (mx * minorScale) });
        addProbe({ x: entity.center.x - (-my * minorScale), y: entity.center.y - (mx * minorScale) });
      }
    }

    addProbe(safeSamplePoint(entity));
    return probes;
  }

  // Decides whether a loose entity belongs to the current top-level contour.
  // We combine probe points with a bbox overlap fallback so lines that sit on
  // the profile or partially extend outside the strict contour bbox still get
  // a fair chance to stay attached to the shape in the preview modal.
  function entityBelongsToOuterContour(entity, outer) {
    const outerBBox = outer?.bbox;
    if (!outerBBox) return false;
    const probes = entityProbePoints(entity);
    if (probes.some(point => pointInsideOrOnContour(point, outer))) return true;

    const bbox = entityBBox(entity);
    if (!bbox) return false;
    const overlaps =
      bbox.maxX >= outerBBox.minX - LOOP_TOLERANCE &&
      bbox.minX <= outerBBox.maxX + LOOP_TOLERANCE &&
      bbox.maxY >= outerBBox.minY - LOOP_TOLERANCE &&
      bbox.minY <= outerBBox.maxY + LOOP_TOLERANCE;
    if (!overlaps) return false;

    const corners = [
      { x: bbox.minX, y: bbox.minY },
      { x: bbox.minX, y: bbox.maxY },
      { x: bbox.maxX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.maxY },
    ];
    return corners.some(point => pointInsideOrOnContour(point, outer));
  }

  // Returns the overlapping area between two axis-aligned bounding boxes.
  // Used as a softer ownership hint when a loose entity sits next to a shape
  // rather than fully inside it.
  function bboxOverlapArea(a, b) {
    if (!a || !b) return 0;
    const overlapX = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
    const overlapY = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
    return overlapX * overlapY;
  }

  // Measures the gap between two bounding boxes. Returns 0 when they overlap.
  // Helpful for assigning "almost touching" open lines to the right sketch.
  function bboxGapDistance(a, b) {
    if (!a || !b) return Infinity;
    const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
    const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
    return Math.hypot(dx, dy);
  }

  // Scores how well a loose entity belongs to a top-level outer contour.
  // Strongest signal is true geometric containment; next best is bbox overlap;
  // final fallback is "very close to the contour", which catches adjacent open
  // construction lines that visually belong to the same sketch.
  function scoreEntityForOuterContour(entity, outer) {
    const probes = entityProbePoints(entity);
    const insideCount = probes.filter(point => pointInsideOrOnContour(point, outer)).length;
    if (insideCount > 0) {
      return {
        tier: 3,
        insideCount,
        overlapArea: 0,
        gap: 0,
        outerArea: outer.area || 0,
      };
    }

    const bbox = entityBBox(entity);
    if (!bbox) return null;
    const overlapArea = bboxOverlapArea(bbox, outer.bbox);
    if (overlapArea > 0) {
      return {
        tier: 2,
        insideCount: 0,
        overlapArea,
        gap: 0,
        outerArea: outer.area || 0,
      };
    }

    const gap = bboxGapDistance(bbox, outer.bbox);
    const entitySpan = Math.max(
      Math.abs((bbox.maxX || 0) - (bbox.minX || 0)),
      Math.abs((bbox.maxY || 0) - (bbox.minY || 0))
    );
    const nearThreshold = Math.max(LOOP_TOLERANCE * 10, Math.min(25, entitySpan * 0.35));
    if (gap <= nearThreshold) {
      return {
        tier: 1,
        insideCount: 0,
        overlapArea: 0,
        gap,
        outerArea: outer.area || 0,
      };
    }

    return null;
  }

  // Comparator for the ownership scores above. Higher tier wins, then stronger
  // evidence within that tier, then larger containing contour as the tie-break.
  function compareEntityOuterScore(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.insideCount !== b.insideCount) return a.insideCount - b.insideCount;
    if (a.overlapArea !== b.overlapArea) return a.overlapArea - b.overlapArea;
    if (a.gap !== b.gap) return b.gap - a.gap;
    if (a.outerArea !== b.outerArea) return a.outerArea - b.outerArea;
    return 0;
  }

  // Heuristic guardrail for inferred LINE_LOOP contours. When a synthetic loop
  // has a huge bbox but very little enclosed area, it is usually a by-product
  // of decorative/internal lines rather than a real standalone sketch.
  function isWeakSyntheticContour(contour) {
    if (contour?.entity?.type !== 'LINE_LOOP') return false;
    const bbox = contour.bbox;
    if (!bbox) return false;
    const bboxWidth = Math.max(0, bbox.maxX - bbox.minX);
    const bboxHeight = Math.max(0, bbox.maxY - bbox.minY);
    const bboxArea = Math.max(0, bboxWidth * bboxHeight);
    if (bboxArea <= EPS) return false;
    const sourceCount = Array.isArray(contour.entity?.sourceEntities) ? contour.entity.sourceEntities.length : 0;
    const fillRatio = (contour.area || 0) / bboxArea;
    const minDim = Math.min(bboxWidth, bboxHeight);
    const maxDim = Math.max(bboxWidth, bboxHeight);
    const aspectRatio = minDim > EPS ? maxDim / minDim : Infinity;
    const isThinStrip = sourceCount <= 8 && minDim <= 30 && aspectRatio >= 8;
    return (sourceCount <= 8 && fillRatio < 0.12) || isThinStrip;
  }

  // Finds a better parent for a weak synthetic top-level loop. Preference goes
  // to real closed contours on the same layer that contain it; otherwise we
  // fall back to the nearest larger real contour so the synthetic loop stops
  // becoming its own sketch.
  function findSyntheticContourParent(contour, contours) {
    let best = null;
    let bestScore = null;
    contours.forEach(candidate => {
      if (!candidate || candidate.id === contour.id) return;
      if (candidate.layer !== contour.layer) return;
      if (candidate.entity?.type === 'LINE_LOOP') return;
      if ((candidate.area || 0) <= (contour.area || 0)) return;

      const overlapArea = bboxOverlapArea(contour.bbox, candidate.bbox);
      const gap = bboxGapDistance(contour.bbox, candidate.bbox);
      const containsSample = contour.sample ? pointInsideOrOnContour(contour.sample, candidate) : false;
      const score = containsSample
        ? { tier: 3, overlapArea, gap, area: candidate.area || 0 }
        : overlapArea > 0
          ? { tier: 2, overlapArea, gap, area: candidate.area || 0 }
          : gap <= 30
            ? { tier: 1, overlapArea, gap, area: candidate.area || 0 }
            : null;
      if (!score) return;

      if (!bestScore ||
          score.tier > bestScore.tier ||
          (score.tier === bestScore.tier && score.overlapArea > bestScore.overlapArea) ||
          (score.tier === bestScore.tier && score.overlapArea === bestScore.overlapArea && score.gap < bestScore.gap) ||
          (score.tier === bestScore.tier && score.overlapArea === bestScore.overlapArea && score.gap === bestScore.gap && score.area > bestScore.area)) {
        best = candidate;
        bestScore = score;
      }
    });
    return best;
  }

  // Produces a compact debug summary for one entity so assignment logs stay
  // readable while still giving us enough geometry context to reason about
  // mistakes in one-layer sketches.
  function debugEntitySummary(entity) {
    const bbox = entityBBox(entity);
    return {
      handle: entity?.handle || null,
      type: entity?.type || 'UNKNOWN',
      layer: entity?.layer || '0',
      bbox: bbox ? {
        minX: +bbox.minX.toFixed(3),
        minY: +bbox.minY.toFixed(3),
        maxX: +bbox.maxX.toFixed(3),
        maxY: +bbox.maxY.toFixed(3),
      } : null,
    };
  }

  // Formats the ownership score in a human-readable way so the debug output
  // explains not just which sketch won, but why it won.
  function debugScoreSummary(score) {
    if (!score) return null;
    return {
      tier: score.tier,
      reason: score.tier === 3 ? 'inside-or-boundary'
        : score.tier === 2 ? 'bbox-overlap'
        : score.tier === 1 ? 'nearby'
        : 'none',
      insideCount: score.insideCount,
      overlapArea: +score.overlapArea.toFixed(3),
      gap: +score.gap.toFixed(3),
      outerArea: +(score.outerArea || 0).toFixed(3),
    };
  }

  // Chooses the primary outer contour for a merged sketch component. Real DXF
  // closed entities beat synthetic loops, then larger area wins.
  function preferredMergedOuter(a, b) {
    const aSynthetic = a?.entity?.type === 'LINE_LOOP' ? 1 : 0;
    const bSynthetic = b?.entity?.type === 'LINE_LOOP' ? 1 : 0;
    if (aSynthetic !== bSynthetic) return aSynthetic < bSynthetic ? a : b;
    return (a?.area || 0) >= (b?.area || 0) ? a : b;
  }

  // Computes how well one contour works as the "real outer boundary" of a
  // merged sketch component. The best candidate should explain most of the
  // component geometry, contain the other peer outers, and avoid being an
  // oversized synthetic frame when a tighter real contour is available.
  function scoreMergedOuterCandidate(candidate, group) {
    if (!candidate || !group) return null;
    const candidateBBox = candidate.bbox;
    if (!candidateBBox) return null;

    const peerOuters = (group.memberOuters || []).filter(outer => outer && outer.id !== candidate.id);
    const decorators = group.decorators || [];

    let containedPeerOuters = 0;
    peerOuters.forEach(outer => {
      if (outer.sample && pointInsideOrOnContour(outer.sample, candidate)) containedPeerOuters += 1;
    });

    let decoratorInsideCount = 0;
    let decoratorTouchCount = 0;
    decorators.forEach(entity => {
      const probes = entityProbePoints(entity);
      if (!probes.length) return;
      const insideProbeCount = probes.filter(point => pointInsideOrOnContour(point, candidate)).length;
      if (insideProbeCount > 0) {
        decoratorInsideCount += 1;
        if (insideProbeCount < probes.length) decoratorTouchCount += 1;
      } else {
        const bbox = entityBBox(entity);
        const overlapArea = bboxOverlapArea(candidateBBox, bbox);
        const gap = bboxGapDistance(candidateBBox, bbox);
        if (overlapArea > 0 || gap <= 20) decoratorTouchCount += 1;
      }
    });

    let explainedBBox = candidateBBox;
    peerOuters.forEach(outer => { explainedBBox = unionBBox(explainedBBox, outer.bbox); });
    decorators.forEach(entity => { explainedBBox = unionBBox(explainedBBox, entityBBox(entity)); });
    const candidateBBoxArea = Math.max(EPS, (candidateBBox.maxX - candidateBBox.minX) * (candidateBBox.maxY - candidateBBox.minY));
    const explainedBBoxArea = explainedBBox
      ? Math.max(EPS, (explainedBBox.maxX - explainedBBox.minX) * (explainedBBox.maxY - explainedBBox.minY))
      : candidateBBoxArea;
    const bboxCoverage = Math.min(1, explainedBBoxArea / candidateBBoxArea);

    const syntheticPenalty = candidate.entity?.type === 'LINE_LOOP' ? 1 : 0;
    const framePenalty = syntheticPenalty && bboxCoverage < 0.2 ? 1 : 0;

    return {
      candidateId: candidate.id,
      syntheticPenalty,
      framePenalty,
      containedPeerOuters,
      decoratorInsideCount,
      decoratorTouchCount,
      bboxCoverage,
      area: candidate.area || 0,
    };
  }

  // Comparator for merged-group outer scoring. Real contours that explain more
  // of the component win first; only then do we fall back to larger area.
  function compareMergedOuterScore(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.framePenalty !== b.framePenalty) return b.framePenalty - a.framePenalty;
    if (a.syntheticPenalty !== b.syntheticPenalty) return b.syntheticPenalty - a.syntheticPenalty;
    if (a.containedPeerOuters !== b.containedPeerOuters) return a.containedPeerOuters - b.containedPeerOuters;
    if (a.decoratorInsideCount !== b.decoratorInsideCount) return a.decoratorInsideCount - b.decoratorInsideCount;
    if (a.decoratorTouchCount !== b.decoratorTouchCount) return a.decoratorTouchCount - b.decoratorTouchCount;
    if (a.bboxCoverage !== b.bboxCoverage) return a.bboxCoverage - b.bboxCoverage;
    if (a.area !== b.area) return a.area - b.area;
    return 0;
  }

  // Scores an entity against every top-level outer contour inside a merged
  // sketch component and returns the strongest match. This keeps decorators
  // near a secondary closed region from being ignored just because the merged
  // component's primary outer contour sits elsewhere.
  function scoreEntityForMergedGroup(entity, group) {
    const outers = group?.memberOuters?.length ? group.memberOuters : [group?.outer].filter(Boolean);
    let bestScore = null;
    let bestOuter = null;
    outers.forEach(outer => {
      const score = scoreEntityForOuterContour(entity, outer);
      if (!score) return;
      if (!bestScore || compareEntityOuterScore(score, bestScore) > 0) {
        bestScore = score;
        bestOuter = outer;
      }
    });
    return bestScore ? { score: bestScore, matchedOuter: bestOuter } : null;
  }

  // ─── Alpha shape / concave hull of connected components ─────────────────────

  // Collects representative sample points from one entity.
  // Called once per entity when building the per-component point cloud.
  function sampleEntityPoints(entity) {
    const pts = [];
    const add = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y }); };
    if (!entity) return pts;
    switch (entity.type) {
      case 'LINE': {
        const ep = getLineEndpoints(entity);
        if (ep) { add(ep.start.x, ep.start.y); add(ep.end.x, ep.end.y); }
        break;
      }
      case 'ARC': {
        const ep = getArcEndpoints(entity);
        if (ep && entity.center && Number.isFinite(entity.radius)) {
          add(ep.start.x, ep.start.y); add(ep.end.x, ep.end.y);
          let sa = entity.startAngle || 0;
          let ea = entity.endAngle || sa;
          while (ea <= sa) ea += TWO_PI;
          const ma = sa + (ea - sa) / 2;
          add(entity.center.x + entity.radius * Math.cos(ma), entity.center.y + entity.radius * Math.sin(ma));
        }
        break;
      }
      case 'CIRCLE':
        if (entity.center && Number.isFinite(entity.radius)) {
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * TWO_PI;
            add(entity.center.x + entity.radius * Math.cos(a), entity.center.y + entity.radius * Math.sin(a));
          }
        }
        break;
      case 'LWPOLYLINE':
      case 'POLYLINE':
        (entity.vertices || []).forEach(v => add(v?.x, v?.y));
        break;
      case 'LINE_LOOP':
        (entity.points || []).forEach(p => add(p.x, p.y));
        break;
      case 'SPLINE':
        [...(entity.controlPoints || []), ...(entity.fitPoints || [])].forEach(p => add(p?.x, p?.y));
        break;
      case 'ELLIPSE':
        // Sample center and axis tips so ellipses contribute to the alpha-shape
        // point cloud even when the geometry library doesn't convert them.
        if (entity.center && entity.majorAxisEndPoint) {
          add(entity.center.x, entity.center.y);
          const mx = Number(entity.majorAxisEndPoint.x) || 0;
          const my = Number(entity.majorAxisEndPoint.y) || 0;
          const ratio = Number.isFinite(entity.axisRatio) ? entity.axisRatio : 1;
          add(entity.center.x + mx, entity.center.y + my);
          add(entity.center.x - mx, entity.center.y - my);
          add(entity.center.x + (-my * ratio), entity.center.y + (mx * ratio));
          add(entity.center.x - (-my * ratio), entity.center.y - (mx * ratio));
        }
        break;
      default: break;
    }
    return pts;
  }

  // Convex hull of a 2-D point set using Andrew's monotone chain (O(n log n)).
  // Returns a CCW-ordered polygon array, or null for degenerate inputs.
  // Used as a fallback when the alpha triangulation produces no boundary.
  function computeConvexHull(points) {
    if (!points?.length) return null;
    const sorted = [...points].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
    const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
    const lower = [], upper = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    const hull = [...lower, ...upper];
    return hull.length >= 3 ? hull : null;
  }

  // Returns the circumradius of triangle (a, b, c) using R = |AB|·|BC|·|CA| / (4·|area|).
  // Returns Infinity for collinear or degenerate triangles.
  function circumradius(a, b, c) {
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
    return area2 < 1e-12 ? Infinity : (ab * bc * ca) / (2 * area2);
  }

  // Returns true if p lies strictly inside the circumcircle of triangle (a, b, c).
  // Uses the standard 4×4 determinant; sign is corrected for triangle orientation
  // so the test works for both CW and CCW windings.
  function inCircumcircle(a, b, c, p) {
    const ax = a.x - p.x, ay = a.y - p.y;
    const bx = b.x - p.x, by = b.y - p.y;
    const cx = c.x - p.x, cy = c.y - p.y;
    const det =
      (ax * ax + ay * ay) * (bx * cy - by * cx) -
      (bx * bx + by * by) * (ax * cy - ay * cx) +
      (cx * cx + cy * cy) * (ax * by - ay * bx);
    const orient = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    return orient > 0 ? det > 0 : det < 0;
  }

  // Bowyer-Watson incremental Delaunay triangulation.
  // Returns triangles as [i0, i1, i2] index triples into the original points array.
  // Inserts a super-triangle, adds each point one at a time, and strips the
  // super-triangle vertices before returning.
  function bowyerWatson(points) {
    const n = points.length;
    if (n < 3) return [];

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const span = Math.max(maxX - minX, maxY - minY, 1) * 5;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

    // Super-triangle at indices n, n+1, n+2
    const all = [...points,
      { x: cx - span,     y: cy - span     },
      { x: cx,            y: cy + span * 2 },
      { x: cx + span,     y: cy - span     },
    ];
    let tris = [[n, n + 1, n + 2]];

    for (let pi = 0; pi < n; pi++) {
      const p = all[pi];
      const bad = [], good = [];
      for (const t of tris) {
        inCircumcircle(all[t[0]], all[t[1]], all[t[2]], p) ? bad.push(t) : good.push(t);
      }

      // Cavity boundary: edges belonging to exactly one bad triangle
      const boundary = [];
      for (const t of bad) {
        for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
          const shared = bad.some(other => other !== t && (
            (other[0] === a && other[1] === b) || (other[1] === a && other[2] === b) || (other[2] === a && other[0] === b) ||
            (other[0] === b && other[1] === a) || (other[1] === b && other[2] === a) || (other[2] === b && other[0] === a)
          ));
          if (!shared) boundary.push([a, b]);
        }
      }

      tris = good;
      for (const [a, b] of boundary) tris.push([a, b, pi]);
    }

    // Remove triangles that touch the super-triangle
    return tris.filter(t => t[0] < n && t[1] < n && t[2] < n);
  }

  // Heuristic alpha estimator based on nearest-neighbour distance distribution.
  // Takes the 75th-percentile NN distance × 2.5 so the hull bridges the normal
  // intra-sketch gaps without reaching across the gaps between independent sketches.
  function estimateAlpha(points) {
    if (points.length < 3) return Infinity;
    const sample = points.length > 150
      ? points.filter((_, i) => i % Math.ceil(points.length / 150) === 0)
      : points;
    const n = sample.length;
    const nnDists = sample.map((p, i) => {
      let minD = Infinity;
      for (let j = 0; j < n; j++) {
        if (j !== i) {
          const d = Math.hypot(sample[j].x - p.x, sample[j].y - p.y);
          if (d < minD) minD = d;
        }
      }
      return minD;
    }).filter(d => d < Infinity);
    if (!nnDists.length) return Infinity;
    nnDists.sort((a, b) => a - b);
    return nnDists[Math.floor(nnDists.length * 0.75)] * 2.5;
  }

  // Traces boundary edges (adjacency map node → [neighbors]) into the largest
  // closed ring found. Handles degree-2 nodes (simple polygon) and degree > 2
  // (branching from numeric noise) by greedily consuming unvisited edges.
  function traceLargestBoundaryRing(adj, points) {
    if (!adj.size) return null;
    let bestRing = null;

    adj.forEach((_, startNode) => {
      for (const firstNext of (adj.get(startNode) || [])) {
        const ring = [startNode];
        const used = new Set([`${startNode}_${firstNext}`, `${firstNext}_${startNode}`]);
        let cur = firstNext;

        for (let safety = 0; safety < adj.size * 2 + 10; safety++) {
          ring.push(cur);
          if (cur === startNode && ring.length > 2) break;

          let next = -1;
          for (const nb of (adj.get(cur) || [])) {
            if (!used.has(`${cur}_${nb}`)) { next = nb; break; }
          }
          if (next === -1) break;
          used.add(`${cur}_${next}`); used.add(`${next}_${cur}`);
          cur = next;
        }

        const closed = ring.length > 2 && ring[ring.length - 1] === startNode;
        if (closed) {
          const finalRing = ring.slice(0, -1);
          if (finalRing.length >= 3 && (!bestRing || finalRing.length > bestRing.length)) bestRing = finalRing;
        }
      }
    });

    return bestRing ? bestRing.map(i => ({ x: points[i].x, y: points[i].y })) : null;
  }

  // Computes the alpha shape (concave hull) of a point cloud.
  //
  // How it works:
  //   1. Delaunay triangulation of the point cloud (Bowyer-Watson).
  //   2. Discard any triangle whose circumradius > alpha. Large circumradii
  //      correspond to sparse "open" regions between clusters, so removing
  //      them cuts the hull inward along true gaps.
  //   3. Boundary edges of the surviving triangles (each appearing in exactly
  //      one triangle) form the alpha-shape contour.
  //   4. Trace the boundary into a closed polygon ring.
  //
  // Falls back to the convex hull when no alpha boundary can be extracted so
  // callers always receive a valid polygon for non-degenerate inputs.
  function computeAlphaShape(points, alpha) {
    if (!points?.length || points.length < 3) return null;

    // Cap for performance: Bowyer-Watson is O(n²) in the worst case
    const MAX_PTS = 300;
    const pts = points.length > MAX_PTS
      ? points.filter((_, i) => i % Math.ceil(points.length / MAX_PTS) === 0)
      : points;

    const tris = bowyerWatson(pts);
    if (!tris.length) return computeConvexHull(pts);

    const kept = tris.filter(t => circumradius(pts[t[0]], pts[t[1]], pts[t[2]]) <= alpha);
    if (!kept.length) return computeConvexHull(pts);

    // Count how many kept triangles each edge belongs to
    const edgeOcc = new Map();
    for (const t of kept) {
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (!edgeOcc.has(key)) edgeOcc.set(key, { a, b, count: 0 });
        edgeOcc.get(key).count++;
      }
    }

    // Boundary edges appear in exactly one triangle
    const adj = new Map();
    edgeOcc.forEach(({ a, b, count }) => {
      if (count !== 1) return;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b);
      adj.get(b).push(a);
    });

    const ring = adj.size >= 3 ? traceLargestBoundaryRing(adj, pts) : null;
    return ring || computeConvexHull(pts);
  }

  // Synthesises LINE_LOOP outer contours via alpha shapes for any edge-connected
  // component that buildClosedContoursFromLines left without a primary loop.
  //
  // When open lines don't form closed rings (e.g. construction geometry, frame
  // outlines, or incomplete sketches) the half-edge tracer returns nothing for
  // that component. This function steps in: it samples the component's geometry,
  // computes a concave hull that wraps tightly around the actual ink, and emits
  // a synthetic LINE_LOOP so the shape still appears as its own sketch in the
  // preview modal with correct boundary and correct separation from neighbours.
  function buildAlphaShapeContours(lineLoops, entities) {
    // Components already covered by the half-edge tracer don't need a fallback
    const coveredIds = new Set(
      lineLoops.map(l => l.componentId).filter(id => id !== undefined)
    );

    // Group open-edge entities by component, skipping covered ones
    const componentMap = new Map();
    entities.forEach(entity => {
      const cid = entity.__openEdgeComponentId;
      if (cid === undefined || coveredIds.has(cid)) return;
      if (!componentMap.has(cid)) componentMap.set(cid, []);
      componentMap.get(cid).push(entity);
    });

    if (!componentMap.size) return [];

    const alphaContours = [];
    const tol2 = LOOP_TOLERANCE * LOOP_TOLERANCE;
    const MAX_PTS = 500;

    componentMap.forEach((componentEntities, cid) => {
      // Collect and spatially deduplicate sample points from the component
      const pts = [];
      for (const entity of componentEntities) {
        for (const p of sampleEntityPoints(entity)) {
          if (!pts.some(q => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 < tol2)) {
            pts.push(p);
            if (pts.length >= MAX_PTS) break;
          }
        }
        if (pts.length >= MAX_PTS) break;
      }
      if (pts.length < 3) return;

      const alpha = estimateAlpha(pts);
      if (!Number.isFinite(alpha)) return;

      const hull = computeAlphaShape(pts, alpha);
      if (!hull || hull.length < 3) return;

      const normalized = normalizeWindingCCW([...hull]);
      if (!normalized.length) return;
      const area = Math.abs(polygonSignedArea(normalized));
      if (area < EPS) return;

      const sourceLayers = [...new Set(componentEntities.map(e => e.layer || '0'))];
      alphaContours.push({
        type: 'LINE_LOOP',
        layer: sourceLayers[0] || '0',
        sourceLayers,
        isSingleLayer: sourceLayers.length <= 1,
        points: normalized,
        sourceEntities: componentEntities,
        orderedEdges: [],
        componentId: cid,
        isOuterBoundary: true,
        isPrimary: true,
        isAlphaShape: true,
        area,
      });
    });

    debugDXF('Alpha shape contours', {
      coveredComponentCount: coveredIds.size,
      uncoveredComponentCount: componentMap.size,
      alphaContourCount: alphaContours.length,
      alphaContours: alphaContours.map(c => ({
        componentId: c.componentId,
        layer: c.layer,
        pointCount: c.points.length,
        area: +c.area.toFixed(3),
        sourceEntityCount: c.sourceEntities.length,
      })),
    });

    return alphaContours;
  }

  // Top-level entry point. Classifies all entities into closed contours, builds
  // the parent-child nesting tree, marks holes vs solid rings, and returns each
  // top-level shape grouped with its descendants and loose decorator entities.
  function groupByContour(entities) {
    // Run the half-edge loop tracer first so __openEdgeComponentId is stamped
    // onto all LINE/ARC entities before the alpha-shape step reads them.
    const lineLoops = buildClosedContoursFromLines(entities);

    // For components the half-edge tracer couldn't close, synthesise a concave
    // hull so they still appear as independent sketches in the preview modal.
    const alphaContours = buildAlphaShapeContours(lineLoops, entities);

    const contourEntities = [...entities.filter(isClosedEntity), ...lineLoops, ...alphaContours];
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

    uniqueClosed.forEach((contour, index) => {
      if (parents[index] !== -1) return;
      if (!isWeakSyntheticContour(contour)) return;
      const syntheticParent = findSyntheticContourParent(contour, uniqueClosed);
      if (!syntheticParent) return;
      const parentIndex = uniqueClosed.findIndex(candidate => candidate.id === syntheticParent.id);
      if (parentIndex >= 0 && parentIndex !== index) parents[index] = parentIndex;
    });

    const topIndexes = uniqueClosed.map((_, index) => index).filter(index => parents[index] === -1);

    debugDXF('Contour hierarchy', {
      contourCount: uniqueClosed.length,
      topLevelCount: topIndexes.length,
      contours: uniqueClosed.map((contour, index) => ({
        id: contour.id,
        entityType: contour.entity?.type || 'UNKNOWN',
        layer: contour.layer,
        area: +(contour.area || 0).toFixed(3),
        bbox: contour.bbox ? {
          minX: +contour.bbox.minX.toFixed(3),
          minY: +contour.bbox.minY.toFixed(3),
          maxX: +contour.bbox.maxX.toFixed(3),
          maxY: +contour.bbox.maxY.toFixed(3),
        } : null,
        isPrimarySynthetic: !!contour.entity?.isPrimary,
        isOuterBoundarySynthetic: !!contour.entity?.isOuterBoundary,
        parentId: parents[index] >= 0 ? uniqueClosed[parents[index]].id : null,
        isTopLevel: parents[index] === -1,
      })),
    });

    const resultGroups = topIndexes.map(topIndex => {
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

      return {
        outer,
        contours: enrichedContours,
        decorators: [],
        bbox: outerBBox,
        layer: outer.layer,
        contourSourceEntities,
      };
    });

    const groupParents = resultGroups.map((_, index) => index);
    const findGroup = index => {
      let current = index;
      while (groupParents[current] !== current) {
        groupParents[current] = groupParents[groupParents[current]];
        current = groupParents[current];
      }
      return current;
    };
    const unionGroups = (a, b) => {
      const ra = findGroup(a);
      const rb = findGroup(b);
      if (ra === rb) return;
      groupParents[rb] = ra;
    };
    const componentLinks = [];

    others.forEach(entity => {
      if (['HATCH', 'TEXT', 'MTEXT', 'DIMENSION', 'INSERT'].includes(entity.type)) return;
      const candidateIndexes = resultGroups
        .map((group, index) => ({ index, score: scoreEntityForOuterContour(entity, group.outer) }))
        .filter(item => item.score);
      if (candidateIndexes.length < 2) return;
      candidateIndexes.sort((a, b) => compareEntityOuterScore(b.score, a.score));
      const strongCandidates = candidateIndexes.filter(item => item.score.tier >= 2);
      const linkCandidates = strongCandidates.length >= 2 ? strongCandidates : candidateIndexes.filter(item => item.score.tier >= 1);
      if (linkCandidates.length < 2) return;
      const anchor = linkCandidates[0];
      linkCandidates.slice(1).forEach(candidate => {
        unionGroups(anchor.index, candidate.index);
        componentLinks.push({
          entity: debugEntitySummary(entity),
          fromOuterId: resultGroups[anchor.index].outer.id,
          toOuterId: resultGroups[candidate.index].outer.id,
          fromScore: debugScoreSummary(anchor.score),
          toScore: debugScoreSummary(candidate.score),
        });
      });
    });

    // Source-entity bridge: LINE_LOOP source entities are placed in
    // `closedEntities` and excluded from `others`, so the loop above never
    // sees them. But a source entity can physically span two separate sketch
    // groups (e.g. a long horizontal line that connects two regions). Check
    // every LINE_LOOP source entity from every contour against all other
    // groups and merge when the entity scores tier ≥ 2 for that group.
    resultGroups.forEach((group, groupIndex) => {
      group.contours.forEach(contour => {
        if (contour.entity?.type !== 'LINE_LOOP') return;
        const sources = contour.entity.sourceEntities;
        if (!Array.isArray(sources)) return;
        sources.forEach(entity => {
          if (entity?.type !== 'LINE' && entity?.type !== 'ARC') return;
          resultGroups.forEach((otherGroup, otherIndex) => {
            // Skip if already in the same union-find component
            if (findGroup(otherIndex) === findGroup(groupIndex)) return;
            const score = scoreEntityForOuterContour(entity, otherGroup.outer);
            if (!score || score.tier < 2) return;
            unionGroups(groupIndex, otherIndex);
            componentLinks.push({
              entity: debugEntitySummary(entity),
              fromOuterId: group.outer.id,
              toOuterId: otherGroup.outer.id,
              fromScore: null,
              toScore: debugScoreSummary(score),
              via: 'lineloop-source',
            });
          });
        });
      });
    });

    const mergedGroupMap = new Map();
    resultGroups.forEach((group, index) => {
      const root = findGroup(index);
      if (!mergedGroupMap.has(root)) {
        mergedGroupMap.set(root, {
          outer: group.outer,
          memberOuters: [group.outer],
          contours: [...group.contours],
          decorators: [],
          bbox: group.bbox,
          layer: group.layer,
          contourSourceEntities: new Set(group.contourSourceEntities),
          memberOuterIds: [group.outer.id],
        });
        return;
      }
      const merged = mergedGroupMap.get(root);
      merged.outer = preferredMergedOuter(merged.outer, group.outer);
      merged.memberOuters.push(group.outer);
      merged.contours.push(...group.contours);
      merged.bbox = unionBBox(merged.bbox, group.bbox);
      merged.layer = merged.outer.layer;
      group.contourSourceEntities.forEach(entity => merged.contourSourceEntities.add(entity));
      merged.memberOuterIds.push(group.outer.id);
    });

    const mergedGroups = [...mergedGroupMap.values()];

    debugDXF('Sketch component links', {
      linkCount: componentLinks.length,
      mergedGroupCount: mergedGroups.length,
      links: componentLinks,
      groups: mergedGroups.map(group => ({
        outerId: group.outer.id,
        memberOuterIds: group.memberOuterIds,
        contourCount: group.contours.length,
      })),
    });

    const assignmentTrace = [];
    const chainQueue = []; // entities not claimed by the main pass; retried by chain-closure

    others.forEach(entity => {
      if (['HATCH', 'TEXT', 'MTEXT', 'DIMENSION', 'INSERT'].includes(entity.type)) return;
      let bestGroup = null;
      let bestScore = null;
      let bestMatchedOuter = null;
      const candidates = [];
      mergedGroups.forEach(group => {
        const match = scoreEntityForMergedGroup(entity, group);
        if (match) {
          candidates.push({
            outerId: group.outer.id,
            outerLayer: group.outer.layer,
            matchedOuterId: match.matchedOuter?.id || group.outer.id,
            score: debugScoreSummary(match.score),
          });
        }
        if (!match) return;
        if (!bestScore || compareEntityOuterScore(match.score, bestScore) > 0) {
          bestScore = match.score;
          bestGroup = group;
          bestMatchedOuter = match.matchedOuter || group.outer;
        }
      });
      if (bestGroup) {
        bestGroup.decorators.push(entity);
        assignmentTrace.push({
          entity: debugEntitySummary(entity),
          assignedOuterId: bestGroup.outer.id,
          assignedOuterLayer: bestGroup.outer.layer,
          matchedOuterId: bestMatchedOuter?.id || bestGroup.outer.id,
          winningScore: debugScoreSummary(bestScore),
          candidates,
        });
      } else {
        chainQueue.push(entity);
        assignmentTrace.push({
          entity: debugEntitySummary(entity),
          assignedOuterId: null,
          assignedOuterLayer: null,
          matchedOuterId: null,
          winningScore: null,
          candidates,
        });
      }
    });

    // Chain-closure pass: entities whose bbox directly touches (gap ≈ 0) an
    // already-assigned decorator are pulled into the same sketch group.
    // This rescues intermediate spline or line segments that bridge two outer-
    // contour regions and are therefore too far from every outer-contour bbox to
    // pass the nearThreshold inside scoreEntityForOuterContour.
    // The loop repeats until nothing new is claimed, so chains of arbitrary
    // length are resolved in O(length) iterations.
    {
      let anyChained = true;
      let queue = chainQueue.slice();
      while (anyChained && queue.length > 0) {
        anyChained = false;
        const nextQueue = [];
        queue.forEach(entity => {
          const eBbox = entityBBox(entity);
          if (!eBbox) return; // can't compute geometry — leave unassigned
          let matchedGroup = null;
          for (let gi = 0; gi < mergedGroups.length; gi++) {
            const group = mergedGroups[gi];
            const touches = group.decorators.some(dec => {
              const db = entityBBox(dec);
              return db && bboxGapDistance(eBbox, db) <= LOOP_TOLERANCE * 10;
            });
            if (touches) { matchedGroup = group; break; }
          }
          if (matchedGroup) {
            matchedGroup.decorators.push(entity);
            // Update the trace entry so debug counts and UI stay accurate.
            const traceEntry = assignmentTrace.find(
              t => t.entity.handle === (entity.handle || null) && t.assignedOuterId === null
            );
            if (traceEntry) {
              traceEntry.assignedOuterId = matchedGroup.outer.id;
              traceEntry.assignedOuterLayer = matchedGroup.outer.layer;
              traceEntry.matchedOuterId = matchedGroup.outer.id;
              traceEntry.winningScore = {
                tier: 1,
                reason: 'chain-closure',
                insideCount: 0,
                overlapArea: 0,
                gap: 0,
                outerArea: matchedGroup.outer.area || 0,
              };
            }
            anyChained = true;
          } else {
            nextQueue.push(entity); // still unresolved; try again next round
          }
        });
        queue = nextQueue;
      }
    }

    mergedGroups.forEach(group => {
      const { contourSourceEntities, decorators, contours } = group;
      const outer = group.outer;
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

      let bestOuter = group.outer;
      let bestScore = null;
      (group.memberOuters || [group.outer]).forEach(candidate => {
        const score = scoreMergedOuterCandidate(candidate, group);
        if (!bestScore || compareMergedOuterScore(score, bestScore) > 0) {
          bestScore = score;
          bestOuter = candidate;
        }
      });
      group.outer = bestOuter;
      group.layer = bestOuter.layer;

      debugDXF('Decorator assignment', {
        outerId: group.outer.id,
        layer: group.outer.layer,
        candidateCount: others.length,
        decoratorCount: decorators.length,
        contourCount: contours.length,
      });
      debugDXF('Merged outer scoring', {
        chosenOuterId: group.outer.id,
        memberOuterIds: (group.memberOuters || []).map(outer => outer.id),
        scores: (group.memberOuters || [group.outer]).map(candidate => ({
          outerId: candidate.id,
          score: scoreMergedOuterCandidate(candidate, group),
        })),
      });
      delete group.contourSourceEntities;
    });

    debugDXF('Decorator assignment details', {
      totalCandidates: assignmentTrace.length,
      assignedCount: assignmentTrace.filter(item => item.assignedOuterId).length,
      unassignedCount: assignmentTrace.filter(item => !item.assignedOuterId).length,
      assignments: assignmentTrace,
    });

    return mergedGroups;
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
    // Alpha shape / concave hull
    sampleEntityPoints,
    computeConvexHull,
    circumradius,
    bowyerWatson,
    estimateAlpha,
    computeAlphaShape,
    buildAlphaShapeContours,
  };
})(window);
