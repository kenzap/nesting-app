(function attachNestDxfExportMetadataService(global) {
  'use strict';

  const { getLineEndpoints } = global.NestDxfGeometry;

  function serializePoint(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return {
      x: +point.x,
      y: +point.y,
      z: Number.isFinite(point.z) ? +point.z : 0,
    };
  }

  function serializeEntityForExport(ent, contourEntityToPoints) {
    if (!ent || !ent.type) return null;

    const out = {
      type: ent.type,
      layer: ent.layer || '0',
      closed: !!ent.closed,
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
          ...(Number.isFinite(vertex?.bulge) ? { bulge: +vertex.bulge } : {}),
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
    if (Array.isArray(ent.knots)) {
      out.knots = ent.knots.filter(Number.isFinite).map(Number);
    }
    if (Number.isFinite(ent.degreeOfSplineCurve)) {
      out.degreeOfSplineCurve = ent.degreeOfSplineCurve;
    }

    return out;
  }

  global.NestDxfExportMetadataService = {
    serializePoint,
    serializeEntityForExport,
  };
})(window);
