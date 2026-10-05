(function attachNestDxfExportMetadataService(global) {
  'use strict';

  const { getLineEndpoints } = global.NestDxfGeometry;

  // Normalises a point to a plain {x, y, z} object, stripping any extra
  // properties that parsed DXF entities carry so the export JSON stays clean.
  // Returns null if the point lacks finite x/y coordinates.
  function serializePoint(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return {
      x: +point.x,
      y: +point.y,
      z: Number.isFinite(point.z) ? +point.z : 0,
    };
  }

  // Creates a stripped-down, JSON-safe copy of a DXF entity keeping only the
  // fields the export pipeline needs (type, layer, geometry, color). Falls back
  // to contourEntityToPoints for polylines that lack explicit vertex data.
  function serializeEntityForExport(ent, contourEntityToPoints) {
    if (!ent || !ent.type) return null;

    const isClosedPolyline = !!(
      ent.closed ||
      ent.shape ||
      ent.is3dPolygonMeshClosed
    );

    const out = {
      type: ent.type,
      layer: ent.layer || '0',
      closed: isClosedPolyline,
    };

    if (ent.handle) out.handle = ent.handle;
    if (Number.isFinite(ent.colorNumber)) out.colorNumber = ent.colorNumber;
    if (Number.isFinite(ent.colorIndex)) out.colorIndex = ent.colorIndex;
    if (Number.isFinite(ent.aci)) out.aci = ent.aci;
    if (Number.isFinite(ent.trueColor)) out.trueColor = ent.trueColor;
    if (typeof ent.color === 'string') out.color = ent.color;

    if (ent.center) out.center = serializePoint(ent.center);
    if (ent.start) out.start = serializePoint(ent.start);
    if (ent.end) out.end = serializePoint(ent.end);
    if (Number.isFinite(ent.radius)) out.radius = +ent.radius;
    if (Number.isFinite(ent.startAngle)) out.startAngle = +ent.startAngle;
    if (Number.isFinite(ent.endAngle)) out.endAngle = +ent.endAngle;
    if (Number.isFinite(ent.angleLength)) out.angleLength = +ent.angleLength;
    if (Number.isFinite(ent.axisRatio)) out.axisRatio = +ent.axisRatio;
    if (ent.majorAxisEndPoint) out.majorAxisEndPoint = serializePoint(ent.majorAxisEndPoint);
    if (Number.isFinite(ent.startParameter)) out.startParameter = +ent.startParameter;
    if (Number.isFinite(ent.endParameter)) out.endParameter = +ent.endParameter;

    if (ent.type === 'LINE' && (!out.start || !out.end)) {
      const endpoints = getLineEndpoints(ent);
      if (endpoints) {
        out.start = serializePoint(endpoints.start);
        out.end = serializePoint(endpoints.end);
      }
    }

    if (Array.isArray(ent.vertices)) {
      out.vertices = ent.vertices
        .map(vertex => ({
          ...(serializePoint(vertex) || {}),
          ...(Number.isFinite(vertex?.startWidth) ? { startWidth: +vertex.startWidth } : {}),
          ...(Number.isFinite(vertex?.endWidth) ? { endWidth: +vertex.endWidth } : {}),
          ...(Number.isFinite(vertex?.bulge) ? { bulge: +vertex.bulge } : {}),
          ...(Number.isFinite(vertex?.faceA) ? { faceA: +vertex.faceA } : {}),
          ...(Number.isFinite(vertex?.faceB) ? { faceB: +vertex.faceB } : {}),
          ...(Number.isFinite(vertex?.faceC) ? { faceC: +vertex.faceC } : {}),
          ...(Number.isFinite(vertex?.faceD) ? { faceD: +vertex.faceD } : {}),
          ...(typeof vertex?.curveFittingVertex === 'boolean' ? { curveFittingVertex: vertex.curveFittingVertex } : {}),
          ...(typeof vertex?.curveFitTangent === 'boolean' ? { curveFitTangent: vertex.curveFitTangent } : {}),
          ...(typeof vertex?.splineVertex === 'boolean' ? { splineVertex: vertex.splineVertex } : {}),
          ...(typeof vertex?.splineControlPoint === 'boolean' ? { splineControlPoint: vertex.splineControlPoint } : {}),
          ...(typeof vertex?.threeDPolylineVertex === 'boolean' ? { threeDPolylineVertex: vertex.threeDPolylineVertex } : {}),
          ...(typeof vertex?.threeDPolylineMesh === 'boolean' ? { threeDPolylineMesh: vertex.threeDPolylineMesh } : {}),
          ...(typeof vertex?.polyfaceMeshVertex === 'boolean' ? { polyfaceMeshVertex: vertex.polyfaceMeshVertex } : {}),
        }))
        .filter(vertex => Number.isFinite(vertex.x) && Number.isFinite(vertex.y));
    }

    if ((ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') && (!out.vertices || !out.vertices.length)) {
      const points = contourEntityToPoints(ent);
      if (Array.isArray(points) && points.length) {
        out.vertices = points.map(point => ({
          x: +point.x,
          y: +point.y,
          z: Number.isFinite(point.z) ? +point.z : 0,
        }));
      }
    }

    if (Array.isArray(ent.fitPoints)) {
      out.fitPoints = ent.fitPoints.map(serializePoint).filter(Boolean);
    }
    if (Array.isArray(ent.controlPoints)) {
      out.controlPoints = ent.controlPoints.map(serializePoint).filter(Boolean);
    }
    if (Array.isArray(ent.knotValues)) {
      out.knotValues = ent.knotValues.filter(Number.isFinite).map(Number);
    } else if (Array.isArray(ent.knots)) {
      out.knotValues = ent.knots.filter(Number.isFinite).map(Number);
    }
    if (Number.isFinite(ent.degreeOfSplineCurve)) {
      out.degreeOfSplineCurve = ent.degreeOfSplineCurve;
    }
    if (typeof ent.shape === 'boolean') out.shape = ent.shape;
    if (typeof ent.hasContinuousLinetypePattern === 'boolean') out.hasContinuousLinetypePattern = ent.hasContinuousLinetypePattern;
    if (Number.isFinite(ent.width)) out.width = +ent.width;
    if (Number.isFinite(ent.elevation)) out.elevation = +ent.elevation;
    if (Number.isFinite(ent.depth)) out.depth = +ent.depth;
    if (Number.isFinite(ent.thickness)) out.thickness = +ent.thickness;
    if (Number.isFinite(ent.extrusionDirectionX)) out.extrusionDirectionX = +ent.extrusionDirectionX;
    if (Number.isFinite(ent.extrusionDirectionY)) out.extrusionDirectionY = +ent.extrusionDirectionY;
    if (Number.isFinite(ent.extrusionDirectionZ)) out.extrusionDirectionZ = +ent.extrusionDirectionZ;
    if (ent.extrusionDirection) out.extrusionDirection = serializePoint(ent.extrusionDirection);
    if (typeof ent.includesCurveFitVertices === 'boolean') out.includesCurveFitVertices = ent.includesCurveFitVertices;
    if (typeof ent.includesSplineFitVertices === 'boolean') out.includesSplineFitVertices = ent.includesSplineFitVertices;
    if (typeof ent.is3dPolyline === 'boolean') out.is3dPolyline = ent.is3dPolyline;
    if (typeof ent.is3dPolygonMesh === 'boolean') out.is3dPolygonMesh = ent.is3dPolygonMesh;
    if (typeof ent.is3dPolygonMeshClosed === 'boolean') out.is3dPolygonMeshClosed = ent.is3dPolygonMeshClosed;
    if (typeof ent.isPolyfaceMesh === 'boolean') out.isPolyfaceMesh = ent.isPolyfaceMesh;
    if (ent.startTangent) out.startTangent = serializePoint(ent.startTangent);
    if (ent.endTangent) out.endTangent = serializePoint(ent.endTangent);
    if (ent.normalVector) out.normalVector = serializePoint(ent.normalVector);
    if (typeof ent.periodic === 'boolean') out.periodic = ent.periodic;
    if (typeof ent.rational === 'boolean') out.rational = ent.rational;
    if (typeof ent.planar === 'boolean') out.planar = ent.planar;
    if (typeof ent.linear === 'boolean') out.linear = ent.linear;

    return out;
  }

  // Only actual straight DXF segments may earn shared-edge credit. Curves
  // remain in collision geometry but their tessellated chords are excluded.
  function sharedStraightSegments(entities) {
    const segments = [];
    const add = (a, b) => {
      if ([a?.x, a?.y, b?.x, b?.y].every(Number.isFinite) &&
          Math.hypot(b.x - a.x, b.y - a.y) > 0.001) {
        segments.push([a.x, a.y, b.x, b.y]);
      }
    };
    for (const entity of entities || []) {
      if (entity.type === 'LINE') {
        add(entity.start || entity.vertices?.[0], entity.end || entity.vertices?.[1]);
      } else if (['LWPOLYLINE', 'POLYLINE'].includes(entity.type) &&
          !entity.includesCurveFitVertices && !entity.includesSplineFitVertices &&
          !entity.is3dPolyline && !entity.is3dPolygonMesh && !entity.isPolyfaceMesh) {
        const vertices = entity.vertices || [];
        const closed = entity.closed || entity.shape;
        const count = closed ? vertices.length : vertices.length - 1;
        for (let i = 0; i < count; i++) {
          const a = vertices[i];
          if (!a.bulge && !a.curveFittingVertex && !a.splineVertex) {
            add(a, vertices[(i + 1) % vertices.length]);
          }
        }
      }
    }
    return segments;
  }

  // Recover original straight cuts from small contour-extraction rounding.
  // This is a correspondence limit, NOT the shared-cut/contact tolerance.
  // Require a complete unambiguous match; never turn curve chords into cuts.
  function recoverStraightContour(points, entities, engravingLayer = null) {
    const original = points;
    const limit = 0.05;
    const epsilon = 1e-7;
    if (!Array.isArray(points) || points.length < 3) return original;
    let ring = points.map(p => ({ x: p.x, y: p.y }));
    if (ring.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return original;
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const closed = distance(ring[0], ring.at(-1)) < epsilon;
    if (closed) ring.pop();
    if (ring.length < 3 || ring.length > 2048) return original;
    const cuts = (entities || []).filter(e => e.layer !== engravingLayer);
    // Conservative fallback for mixed curved/3D linework: even a tiny arc
    // must not be mistaken for a nearby tangent or engraving segment.
    if (cuts.some(e => !['LINE', 'LWPOLYLINE', 'POLYLINE'].includes(e.type)
      || e.includesCurveFitVertices || e.includesSplineFitVertices || e.is3dPolyline
      || e.is3dPolygonMesh || e.isPolyfaceMesh
      || e.width || e.elevation || e.depth || e.thickness
      || e.extrusionDirectionX || e.extrusionDirectionY
      || (e.extrusionDirectionZ !== undefined && e.extrusionDirectionZ !== 1)
      || (e.extrusionDirection && (e.extrusionDirection.x || e.extrusionDirection.y || e.extrusionDirection.z !== 1))
      || (e.vertices || []).some(p => p.bulge || p.z || p.curveFittingVertex || p.splineVertex)
      || e.start?.z || e.end?.z)) return original;
    const sourceSegments = sharedStraightSegments(cuts);
    if (sourceSegments.length > 4096) return original;
    const segments = sourceSegments
      .map(([x, y, bx, by]) => {
        const length = Math.hypot(bx - x, by - y);
        return { x, y, ux: (bx - x) / length, uy: (by - y) / length, length };
      });
    const along = (s, p) => (p.x - s.x) * s.ux + (p.y - s.y) * s.uy;
    const offset = (s, p) => (p.y - s.y) * s.ux - (p.x - s.x) * s.uy;
    const covers = (s, p, tolerance) => Math.abs(offset(s, p)) <= tolerance
      && along(s, p) >= -tolerance && along(s, p) <= s.length + tolerance;
    const matched = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]; const b = ring[(i + 1) % ring.length];
      if (distance(a, b) <= epsilon) return original;
      const candidates = segments.filter(s => covers(s, a, limit) && covers(s, b, limit))
        .map(s => ({ s, error: Math.max(Math.abs(offset(s, a)), Math.abs(offset(s, b))) }))
        .sort((a, b) => a.error - b.error);
      if (!candidates.length) return original;
      const best = candidates[0];
      // Duplicate/overlapping source segments on the same line are harmless.
      if (candidates.some(c => c.error <= best.error + epsilon
        && (Math.abs(best.s.ux * c.s.uy - best.s.uy * c.s.ux) > epsilon
          || Math.abs(offset(best.s, c.s)) > epsilon))) return original;
      matched.push(best.s);
    }
    const corrected = ring.map((p, i) => {
      const a = matched[(i + ring.length - 1) % ring.length]; const b = matched[i];
      const cross = a.ux * b.uy - a.uy * b.ux;
      if (Math.abs(cross) <= epsilon) {
        if (Math.abs(offset(a, b)) > epsilon) return null;
        const t = along(b, p);
        return { x: b.x + t * b.ux, y: b.y + t * b.uy };
      }
      const t = ((b.x - a.x) * b.uy - (b.y - a.y) * b.ux) / cross;
      return { x: a.x + t * a.ux, y: a.y + t * a.uy };
    });
    if (corrected.some((p, i) => !p || distance(p, ring[i]) > limit
      || !covers(matched[i], p, epsilon)
      || !covers(matched[(i + ring.length - 1) % ring.length], p, epsilon))) return original;
    const area = r => r.reduce((sum, p, i) => {
      const q = r[(i + 1) % r.length]; return sum + p.x * q.y - p.y * q.x;
    }, 0);
    if (area(ring) * area(corrected) <= 0) return original;
    // Do not introduce crossings or collapse a narrow feature.
    const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const onSegment = (a, b, p) => Math.abs(orient(a, b, p)) <= epsilon
      && p.x >= Math.min(a.x, b.x) - epsilon && p.x <= Math.max(a.x, b.x) + epsilon
      && p.y >= Math.min(a.y, b.y) - epsilon && p.y <= Math.max(a.y, b.y) + epsilon;
    for (let i = 0; i < corrected.length; i++) {
      const a = corrected[i]; const b = corrected[(i + 1) % corrected.length];
      if (distance(a, b) <= epsilon) return original;
      for (let j = i + 2; j < corrected.length; j++) {
        if (i === 0 && j === corrected.length - 1) continue;
        const c = corrected[j]; const d = corrected[(j + 1) % corrected.length];
        if ((orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0)
          || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) return original;
      }
    }
    return closed ? [...corrected, { ...corrected[0] }] : corrected;
  }

  global.NestDxfExportMetadataService = {
    recoverStraightContour,
    sharedStraightSegments,
    serializePoint,
    serializeEntityForExport,
  };
})(window);
