'use strict';

const CONTACT_TOLERANCE = 0.001;
const NUMERIC_EPSILON = 1e-8;

function plain2d(entity) {
  if (entity.is3dPolyline || entity.is3dPolygonMesh || entity.is3dPolygonMeshClosed || entity.isPolyfaceMesh
    || entity.includesCurveFitVertices || entity.includesSplineFitVertices) return false;
  if (['width', 'thickness', 'depth', 'elevation'].some(key => Number(entity[key] || 0) !== 0)) return false;
  const normal = entity.extrusionDirection || {
    x: entity.extrusionDirectionX, y: entity.extrusionDirectionY, z: entity.extrusionDirectionZ,
  };
  return !Number(normal.x || 0) && !Number(normal.y || 0) && Number(normal.z ?? 1) === 1;
}

function straightSegments(entity) {
  if (!plain2d(entity)) return null;
  let points;
  let closed = false;
  if (entity.type === 'LINE') {
    points = [entity.start || entity.vertices?.[0], entity.end || entity.vertices?.at(-1)];
  } else if (['LWPOLYLINE', 'POLYLINE'].includes(entity.type)) {
    points = entity.vertices;
    closed = !!(entity.closed || entity.shape);
  } else return null;
  if (!Array.isArray(points) || points.length < 2 || points.some(p => !p
    || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Number(p.z || 0) !== 0
    || Number(p.bulge || 0) !== 0 || Number(p.startWidth || 0) !== 0 || Number(p.endWidth || 0) !== 0)) return null;
  return points.slice(0, closed ? points.length : -1).map((a, i) => ({ a, b: points[(i + 1) % points.length] }));
}

function mergeIntervals(intervals) {
  const merged = [];
  for (const [lo, hi] of intervals.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && lo <= last[1] + NUMERIC_EPSILON) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}

function pointAt(edge, distance) {
  return { x: edge.a.x + edge.ux * distance, y: edge.a.y + edge.uy * distance };
}

function overlap(edge, a, b, tolerance) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const length = Math.hypot(vx, vy);
  if (length <= NUMERIC_EPSILON || Math.abs(edge.ux * vy - edge.uy * vx) > 1e-6 * length) return null;
  const distance = p => Math.abs(edge.ux * (p.y - edge.a.y) - edge.uy * (p.x - edge.a.x));
  if (distance(a) > tolerance || distance(b) > tolerance) return null;
  const project = p => edge.ux * (p.x - edge.a.x) + edge.uy * (p.y - edge.a.y);
  const p = project(a);
  const q = project(b);
  const lo = Math.max(0, Math.min(p, q));
  const hi = Math.min(edge.length, Math.max(p, q));
  return hi > lo + NUMERIC_EPSILON ? [lo, hi] : null;
}

function onOuterContour(edge, contour, tolerance) {
  if (!Array.isArray(contour) || contour.length < 3) return false;
  const intervals = [];
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % contour.length];
    const interval = overlap(edge, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, tolerance);
    if (interval) intervals.push(interval);
  }
  const merged = mergeIntervals(intervals);
  return merged.length === 1 && merged[0][0] <= NUMERIC_EPSILON
    && merged[0][1] >= edge.length - NUMERIC_EPSILON;
}

/** Remove only redundant straight outer edges; never union whole part polygons. */
function removeSharedEdges(records, { transformPoint, signature, tolerance = CONTACT_TOLERANCE }) {
  const byEntity = new Map();
  const groups = new Map();
  records.forEach((record, recordIndex) => {
    const entity = record.entity;
    if ((entity.layer || '0') === record.engravingLayer || entity.layer === 'SHEET_BOUNDARY') return;
    const segments = straightSegments(entity);
    if (!segments) return;
    const edges = segments.map(segment => {
      const a = transformPoint(segment.a, record.rotation, record.tx, record.ty);
      const b = transformPoint(segment.b, record.rotation, record.tx, record.ty);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      return { ...segment, sourceA: segment.a, sourceB: segment.b, a, b, length,
        ux: (b.x - a.x) / length, uy: (b.y - a.y) / length,
        minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
        remaining: [[0, length]], recordIndex };
    });
    byEntity.set(recordIndex, edges);
    const key = JSON.stringify([signature(entity), entity.lineType || entity.lineTypeName || null]);
    if (!groups.has(key)) groups.set(key, []);
    for (const edge of edges) {
      if (edge.length > tolerance && onOuterContour(edge, record.outerContour, tolerance)) groups.get(key).push(edge);
    }
  });

  let removedLengthMm = 0;
  const affectedOwners = new Set();
  const affectedEntities = new Set();
  for (const edges of groups.values()) {
    edges.sort((a, b) => a.minX - b.minX || a.recordIndex - b.recordIndex);
    let active = [];
    for (const edge of edges) {
      active = active.filter(other => other.maxX + tolerance >= edge.minX);
      const covered = [];
      for (const other of active) {
        if (other.minY > edge.maxY + tolerance || edge.minY > other.maxY + tolerance) continue;
        // Compare against retained intervals only: a chain of near-parallel
        // edges must not let a removed edge erase another distant edge.
        for (const [lo, hi] of other.remaining) {
          const interval = overlap(edge, pointAt(other, lo), pointAt(other, hi), tolerance);
          if (interval && interval[1] - interval[0] > tolerance) covered.push(interval);
        }
      }
      if (covered.length) {
        edge.remaining = [];
        let cursor = 0;
        for (const [lo, hi] of mergeIntervals(covered)) {
          if (lo > cursor + NUMERIC_EPSILON) edge.remaining.push([cursor, lo]);
          removedLengthMm += hi - lo;
          cursor = hi;
        }
        if (cursor < edge.length - NUMERIC_EPSILON) edge.remaining.push([cursor, edge.length]);
        affectedEntities.add(edge.recordIndex);
        affectedOwners.add(records[edge.recordIndex].owner);
      }
      if (edge.remaining.length) active.push(edge);
    }
  }

  const output = records.flatMap((record, index) => {
    if (!affectedEntities.has(index)) return [record];
    // Only affected polylines are split; all other entities pass through intact.
    return byEntity.get(index).flatMap(edge => edge.remaining.map(([lo, hi]) => {
      const interpolate = distance => {
        const t = distance / edge.length;
        return { x: edge.sourceA.x + (edge.sourceB.x - edge.sourceA.x) * t,
          y: edge.sourceA.y + (edge.sourceB.y - edge.sourceA.y) * t, z: 0 };
      };
      if (edge.length <= NUMERIC_EPSILON) return null;
      const start = interpolate(lo);
      const end = interpolate(hi);
      return { ...record, entity: { ...record.entity, type: 'LINE', start, end, vertices: [start, end], closed: false, shape: false } };
    }).filter(Boolean));
  });
  return { records: output, removedLengthMm, affectedOwners };
}

module.exports = { removeSharedEdges, CONTACT_TOLERANCE };
