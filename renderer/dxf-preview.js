'use strict';

// ══════════════════════════════════════════════════════════════
//  DXF Preview — real entity parsing + topological grouping
//
//  Supported entity types (Issue #1):
//    LWPOLYLINE, POLYLINE   closed → outer/inner contours
//                           open   → decorator line
//    LINE                   → decorator line
//    ARC                    → decorator arc
//    CIRCLE                 → decorator circle / hole marker
//    ELLIPSE                → decorator ellipse
//    SPLINE                 → decorator cubic bezier
//
//  Grouping strategy (Issue #3):
//    1. Collect all closed polylines → candidate contours
//    2. Build containment tree (point-in-polygon ray cast)
//    3. Top-level contours (depth 0) = independent nestable shapes
//    4. Inner contours (depth ≥ 1 inside a top-level) = holes
//       → included in compound path with fill-rule evenodd
//    5. All other entities (LINE/ARC/CIRCLE/…) whose sample point
//       falls inside a top-level contour → preserved at their
//       ORIGINAL relative position (just translate by -bbox.min)
//
//  Fallback: seeded-RNG procedural shapes when
//    • file has no path (demo seed data)
//    • dxf-parser throws
//    • parsed file has zero closed polylines
// ══════════════════════════════════════════════════════════════

// ── Section 1: Helpers ──────────────────────────────────────
const f  = n => (+n).toFixed(3);   // number formatter
const f1 = n => (+n).toFixed(1);

function mkRng(seed) {
  let s = (seed & 0x7fffffff) || 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h ^ str.charCodeAt(i)) >>> 0;
  return h;
}

// AutoCAD Color Index → hex (common indices)
const ACI = {
  1:'#FF4444', 2:'#FFFF44', 3:'#44DD44', 4:'#44DDDD',
  5:'#4488FF', 6:'#DD44DD', 7:'#CCCCCC', 8:'#888888', 9:'#BBBBBB',
  10:'#FF9999', 20:'#FFBB66', 30:'#FFCC55', 40:'#EEFF55',
  50:'#BBFF55', 60:'#55FF88', 70:'#55FFDD', 80:'#55BBFF',
  90:'#5588FF', 100:'#8866FF', 110:'#CC66FF', 120:'#FF66CC',
  130:'#FF6688', 140:'#FF8855', 150:'#FFAA55',
};
function aciToHex(n) {
  if (!n || n === 256 || n === 0) return null;
  return ACI[n] || ACI[Math.round(n / 10) * 10] || null;
}

// ── Section 2: Entity geometry ────────────────────────────
const EPS = 1e-6;
const TWO_PI = Math.PI * 2;
const LOOP_TOLERANCE = 1e-3;

/** Ray-cast point-in-polygon for a list of {x,y} vertices */
function pointInPoly(px, py, vertices) {
  let inside = false;
  const n = vertices.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function dist(a, b) {
  return Math.hypot((b.x || 0) - (a.x || 0), (b.y || 0) - (a.y || 0));
}

function samePoint(a, b, eps = 1e-4) {
  return !!a && !!b && Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

function getLineEndpoints(ent) {
  if (!ent || ent.type !== 'LINE') return null;

  if (ent.start && ent.end &&
      Number.isFinite(ent.start.x) && Number.isFinite(ent.start.y) &&
      Number.isFinite(ent.end.x) && Number.isFinite(ent.end.y)) {
    return { start: ent.start, end: ent.end };
  }

  if (Array.isArray(ent.vertices) && ent.vertices.length >= 2) {
    const start = ent.vertices[0];
    const end = ent.vertices[ent.vertices.length - 1];
    if (Number.isFinite(start?.x) && Number.isFinite(start?.y) &&
        Number.isFinite(end?.x) && Number.isFinite(end?.y)) {
      return { start, end };
    }
  }

  return null;
}

function getArcEndpoints(ent) {
  if (!ent || ent.type !== 'ARC' || !ent.center || !Number.isFinite(ent.radius)) return null;
  const startAngle = Number.isFinite(ent.startAngle) ? ent.startAngle : 0;
  const endAngle = Number.isFinite(ent.endAngle) ? ent.endAngle : 0;
  return {
    start: {
      x: ent.center.x + ent.radius * Math.cos(startAngle),
      y: ent.center.y + ent.radius * Math.sin(startAngle),
    },
    end: {
      x: ent.center.x + ent.radius * Math.cos(endAngle),
      y: ent.center.y + ent.radius * Math.sin(endAngle),
    },
  };
}

function pointKey(pt, eps = LOOP_TOLERANCE) {
  return `${Math.round(pt.x / eps)},${Math.round(pt.y / eps)}`;
}

function dedupePoints(points, closed = false) {
  const out = [];
  points.forEach(pt => {
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    if (!out.length || !samePoint(out[out.length - 1], pt)) out.push({ x: pt.x, y: pt.y });
  });
  if (closed && out.length > 2 && samePoint(out[0], out[out.length - 1])) out.pop();
  return out;
}

function pointSig(point, precision = 1e-4) {
  return `${Math.round(point.x / precision)},${Math.round(point.y / precision)}`;
}

function normalizedClosedPointSignature(points, precision = 1e-4) {
  const ring = dedupePoints(points, true);
  if (!ring.length) return '';

  const forward = ring.map(point => pointSig(point, precision));
  const backward = [...forward].reverse();

  const rotations = sequence => {
    const out = [];
    for (let i = 0; i < sequence.length; i++) {
      out.push(sequence.slice(i).concat(sequence.slice(0, i)).join('|'));
    }
    return out;
  };

  return [...rotations(forward), ...rotations(backward)].sort()[0] || '';
}

function bboxFromPoints(points) {
  if (!points.length) return null;
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function polygonSignedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function interiorPoint(points) {
  if (!points.length) return null;
  const avg = points.reduce((acc, pt) => ({
    x: acc.x + pt.x / points.length,
    y: acc.y + pt.y / points.length,
  }), { x: 0, y: 0 });
  if (pointInPoly(avg.x, avg.y, points)) return avg;

  const a = points[0];
  const b = points[1] || points[0];
  const c = points[2] || points[0];
  return {
    x: (a.x + b.x + c.x) / 3,
    y: (a.y + b.y + c.y) / 3,
  };
}

function bboxContainsPoint(bb, pt, eps = 1e-4) {
  return pt.x >= bb.minX - eps && pt.x <= bb.maxX + eps &&
         pt.y >= bb.minY - eps && pt.y <= bb.maxY + eps;
}

function unionBBox(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function normalizeAngleSpan(start, end, ccw) {
  let s = start;
  let e = end;
  if (ccw) {
    while (e <= s) e += TWO_PI;
  } else {
    while (e >= s) e -= TWO_PI;
  }
  return { start: s, end: e };
}

function bulgeToPoints(start, end, bulge, maxStepDeg = 12) {
  if (!bulge || Math.abs(bulge) < EPS) return [{ x: end.x, y: end.y }];
  const chord = dist(start, end);
  if (chord < EPS) return [];

  const theta = 4 * Math.atan(bulge);
  const radius = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const ux = (end.x - start.x) / chord;
  const uy = (end.y - start.y) / chord;
  const leftNormal = { x: -uy, y: ux };
  const offset = chord * (1 - bulge * bulge) / (4 * bulge);
  const center = {
    x: mid.x + leftNormal.x * offset,
    y: mid.y + leftNormal.y * offset,
  };

  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const rawEndAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const span = normalizeAngleSpan(startAngle, rawEndAngle, bulge > 0);
  const delta = span.end - span.start;
  const step = (maxStepDeg * Math.PI) / 180;
  const steps = Math.max(2, Math.ceil(Math.abs(delta) / step));

  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const angle = span.start + delta * t;
    pts.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  }
  pts[pts.length - 1] = { x: end.x, y: end.y };
  return pts;
}

function ellipseToPoints(ent, forceClosed = false) {
  if (!ent.center || !ent.majorAxisEndPoint) return [];

  const rx = Math.hypot(ent.majorAxisEndPoint.x, ent.majorAxisEndPoint.y);
  const ry = rx * Math.abs(ent.axisRatio || 1);
  if (rx < EPS || ry < EPS) return [];

  const baseAngle = Math.atan2(ent.majorAxisEndPoint.y, ent.majorAxisEndPoint.x);
  const startParam = ent.startParameter ?? ent.startAngle ?? 0;
  const endParamRaw = ent.endParameter ?? ent.endAngle ?? TWO_PI;
  const closed = forceClosed || Math.abs((endParamRaw - startParam) % TWO_PI) < 1e-4 ||
    Math.abs(Math.abs(endParamRaw - startParam) - TWO_PI) < 1e-4;
  const span = normalizeAngleSpan(startParam, endParamRaw, true);
  const delta = closed ? TWO_PI : span.end - span.start;
  const stepCount = Math.max(24, Math.ceil(Math.abs(delta) / (Math.PI / 18)));

  const pts = [];
  for (let i = 0; i <= stepCount; i++) {
    if (!closed && i === stepCount) {
      const angle = span.start + delta;
      pts.push({
        x: ent.center.x + rx * Math.cos(angle) * Math.cos(baseAngle) - ry * Math.sin(angle) * Math.sin(baseAngle),
        y: ent.center.y + rx * Math.cos(angle) * Math.sin(baseAngle) + ry * Math.sin(angle) * Math.cos(baseAngle),
      });
      break;
    }
    if (closed && i === stepCount) break;
    const t = i / stepCount;
    const angle = span.start + delta * t;
    pts.push({
      x: ent.center.x + rx * Math.cos(angle) * Math.cos(baseAngle) - ry * Math.sin(angle) * Math.sin(baseAngle),
      y: ent.center.y + rx * Math.cos(angle) * Math.sin(baseAngle) + ry * Math.sin(angle) * Math.cos(baseAngle),
    });
  }
  return dedupePoints(pts, closed);
}

function polylineVerticesToPoints(vertices, close = true) {
  if (!vertices || vertices.length < 2) return [];
  const pts = [{ x: vertices[0].x, y: vertices[0].y }];
  for (let i = 0; i < vertices.length - 1; i++) {
    pts.push(...bulgeToPoints(vertices[i], vertices[i + 1], vertices[i].bulge || 0));
  }
  if (close) {
    const last = vertices[vertices.length - 1];
    pts.push(...bulgeToPoints(last, vertices[0], last.bulge || 0));
  }
  return dedupePoints(pts, close);
}

function splineToPoints(ent) {
  const raw = (ent.fitPoints && ent.fitPoints.length > 1)
    ? ent.fitPoints
    : (ent.controlPoints || []);
  return dedupePoints(raw.map(p => ({ x: p.x, y: p.y })), !!ent.closed);
}

function circleToPoints(ent) {
  if (!ent.center || !ent.radius || ent.radius < EPS) return [];
  const steps = 48;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * TWO_PI;
    pts.push({
      x: ent.center.x + ent.radius * Math.cos(angle),
      y: ent.center.y + ent.radius * Math.sin(angle),
    });
  }
  return pts;
}

function pathFromPoints(points, ox, originMaxY, close = true) {
  if (!points || points.length < 2) return '';
  const tx = p => p.x - ox;
  const ty = p => originMaxY - p.y;
  let d = `M${f(tx(points[0]))},${f(ty(points[0]))}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L${f(tx(points[i]))},${f(ty(points[i]))}`;
  }
  if (close) d += ' Z';
  return d;
}

/** Get a representative point for containment testing */
function samplePoint(ent) {
  if (!ent || typeof ent !== 'object') return null;
  switch (ent.type) {
    case 'CIRCLE':
    case 'ARC':
    case 'ELLIPSE':
      return ent.center && Number.isFinite(ent.center.x) && Number.isFinite(ent.center.y)
        ? ent.center
        : null;
    case 'LINE':
      {
      const endpoints = getLineEndpoints(ent);
      if (!endpoints) return null;
      return {
        x: (endpoints.start.x + endpoints.end.x) / 2,
        y: (endpoints.start.y + endpoints.end.y) / 2,
      };
      }
    case 'LWPOLYLINE':
    case 'POLYLINE':
      return ent.vertices?.find(v => Number.isFinite(v?.x) && Number.isFinite(v?.y)) || null;
    case 'SPLINE': {
      const pts = (ent.fitPoints && ent.fitPoints.length)
        ? ent.fitPoints : (ent.controlPoints || []);
      const valid = pts.filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));
      return valid[Math.floor(valid.length / 2)] || null;
    }
    default: return null;
  }
}

function safeSamplePoint(ent) {
  try {
    const pt = samplePoint(ent);
    if (!pt && ent?.type) {
      console.warn('[DXF] No sample point for entity', {
        type: ent.type,
        layer: ent.layer || '0',
        handle: ent.handle,
      });
    }
    return pt;
  } catch (error) {
    console.warn('[DXF] Failed to sample entity', {
      type: ent?.type,
      layer: ent?.layer || '0',
      handle: ent?.handle,
      error: error.message,
    });
    return null;
  }
}

function vectorBetween(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function angleDelta(a, b) {
  const dot = (a.x * b.x) + (a.y * b.y);
  const cross = (a.x * b.y) - (a.y * b.x);
  return Math.abs(Math.atan2(cross, dot));
}

/** Axis-aligned bounding box of an entity */
function entityBBox(ent) {
  const xs = [], ys = [];
  switch (ent.type) {
    case 'LWPOLYLINE': case 'POLYLINE':
      if (!ent.vertices) return null;
      polylineVerticesToPoints(ent.vertices, ent.closed !== false).forEach(v => { xs.push(v.x); ys.push(v.y); });
      break;
    case 'LINE':
      {
        const endpoints = getLineEndpoints(ent);
        if (!endpoints) return null;
        xs.push(endpoints.start.x, endpoints.end.x);
        ys.push(endpoints.start.y, endpoints.end.y);
      }
      break;
    case 'CIRCLE': case 'ARC':
      xs.push(ent.center.x - ent.radius, ent.center.x + ent.radius);
      ys.push(ent.center.y - ent.radius, ent.center.y + ent.radius);
      break;
    case 'ELLIPSE': {
      ellipseToPoints(ent, false).forEach(p => { xs.push(p.x); ys.push(p.y); });
      break;
    }
    case 'SPLINE': {
      const pts = splineToPoints(ent);
      pts.forEach(p => { xs.push(p.x); ys.push(p.y); });
      break;
    }
    default: return null;
  }
  if (!xs.length) return null;
  return { minX: Math.min(...xs), maxX: Math.max(...xs),
           minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// ── Section 3: SVG conversion helpers ────────────────────

/** ARC entity centre → SVG path (handles full-circle edge case) */
function arcEntPath(ent, ox, originMaxY) {
  const cx = ent.center.x - ox;
  const cy = originMaxY - ent.center.y;
  const r  = ent.radius;
  const sR = ent.startAngle || 0;
  const eR = ent.endAngle || 0;
  const x1 = cx + r * Math.cos(sR), y1 = cy - r * Math.sin(sR);
  const x2 = cx + r * Math.cos(eR), y2 = cy - r * Math.sin(eR);
  let span = Number.isFinite(ent.angleLength) ? ent.angleLength : (eR - sR);
  if (span <= 0) span += TWO_PI;
  if (span >= TWO_PI - 1e-4) {
    // Full circle via two arcs
    return `M${f(cx - r)},${f(cy)} A${f(r)},${f(r)},0,1,0,${f(cx + r)},${f(cy)}` +
           ` A${f(r)},${f(r)},0,1,0,${f(cx - r)},${f(cy)} Z`;
  }
  const large = span > Math.PI ? 1 : 0;
  return `M${f(x1)},${f(y1)} A${f(r)},${f(r)},0,${large},1,${f(x2)},${f(y2)}`;
}

/** SPLINE control/fit points → Catmull-Rom cubic bezier path */
function splinePath(ent, ox, originMaxY) {
  const raw = (ent.fitPoints && ent.fitPoints.length > 1)
    ? ent.fitPoints : (ent.controlPoints || []);
  if (raw.length < 2) return '';
  const pts = raw.map(p => ({ x: p.x - ox, y: originMaxY - p.y }));
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
  if (pts.length === 2) return d + ` L${f(pts[1].x)},${f(pts[1].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i], p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    d += ` C${f(p1.x + (p2.x - p0.x) / 6)},${f(p1.y + (p2.y - p0.y) / 6)},` +
         `${f(p2.x - (p3.x - p1.x) / 6)},${f(p2.y - (p3.y - p1.y) / 6)},` +
         `${f(p2.x)},${f(p2.y)}`;
  }
  if (ent.closed) d += ' Z';
  return d;
}

/**
 * Convert any supported entity to an SVG string, already translated
 * into shape-local coordinates (origin at bbox top-left).
 */
function entityToSVGStr(ent, ox, originMaxY, color) {
  const sw = `stroke="${color}" stroke-width="0.8" opacity="0.85" fill="none"`;
  switch (ent.type) {
    case 'LINE': {
      const endpoints = getLineEndpoints(ent);
      if (!endpoints) return '';
      const x1 = f(endpoints.start.x - ox), y1 = f(originMaxY - endpoints.start.y);
      const x2 = f(endpoints.end.x   - ox), y2 = f(originMaxY - endpoints.end.y);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${sw} stroke-linecap="round"/>`;
    }
    case 'CIRCLE': {
      const cx = f(ent.center.x - ox), cy = f(originMaxY - ent.center.y), r = f(ent.radius);
      return `<circle cx="${cx}" cy="${cy}" r="${r}" ${sw}/>`;
    }
    case 'ARC': {
      const d = arcEntPath(ent, ox, originMaxY);
      return d ? `<path d="${d}" ${sw} stroke-linecap="round"/>` : '';
    }
    case 'ELLIPSE': {
      const cx  = f(ent.center.x - ox), cy = f(originMaxY - ent.center.y);
      const rx  = f(Math.sqrt(ent.majorAxisEndPoint.x ** 2 + ent.majorAxisEndPoint.y ** 2));
      const ry  = f(+rx * (ent.axisRatio || 1));
      const ang = f(-Math.atan2(ent.majorAxisEndPoint.y, ent.majorAxisEndPoint.x) * 180 / Math.PI);
      return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"` +
             ` transform="rotate(${ang} ${cx} ${cy})" ${sw}/>`;
    }
    case 'SPLINE': {
      const d = splinePath(ent, ox, originMaxY);
      return d ? `<path d="${d}" ${sw} stroke-linecap="round" stroke-linejoin="round"/>` : '';
    }
    case 'LWPOLYLINE': case 'POLYLINE': {
      // Open polyline appearing as a decorator inside a shape
      if (!ent.vertices || ent.vertices.length < 2) return '';
      const pts = polylineVerticesToPoints(ent.vertices, false);
      const d = pathFromPoints(pts, ox, originMaxY, false);
      return d ? `<path d="${d}" ${sw} stroke-linecap="round" stroke-linejoin="round"/>` : '';
    }
    default: return '';
  }
}

// ── Section 4: Topological grouping ─────────────────────

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

function contourEntityToPoints(ent) {
  switch (ent.type) {
    case 'LINE_LOOP':
      return dedupePoints(ent.points || [], true);
    case 'LWPOLYLINE':
    case 'POLYLINE':
      return polylineVerticesToPoints(ent.vertices, true);
    case 'CIRCLE':
      return circleToPoints(ent);
    case 'ELLIPSE':
      return ellipseToPoints(ent, true);
    case 'SPLINE':
      return splineToPoints(ent);
    default:
      return [];
  }
}

function contourEntityToPath(ent, ox, originMaxY) {
  const pts = contourEntityToPoints(ent);
  return pathFromPoints(pts, ox, originMaxY, true);
}

function getOpenEdgeEndpoints(ent) {
  if (ent?.type === 'LINE') return getLineEndpoints(ent);
  if (ent?.type === 'ARC') return getArcEndpoints(ent);
  return null;
}

function buildClosedContoursFromLines(entities) {
  const openEdges = entities
    .filter(ent =>
      (ent?.type === 'LINE' || ent?.type === 'ARC') &&
      (() => {
        const endpoints = getOpenEdgeEndpoints(ent);
        return !!endpoints && !samePoint(endpoints.start, endpoints.end, LOOP_TOLERANCE);
      })()
    )
    .map((entity, index) => {
      const endpoints = getOpenEdgeEndpoints(entity);
      return {
        id: `oe_${index}`,
        entity,
        start: { x: endpoints.start.x, y: endpoints.start.y },
        end: { x: endpoints.end.x, y: endpoints.end.y },
        layer: entity.layer || '0',
        used: false,
      };
    });

  if (!openEdges.length) {
    debugDXF('Line loop input', { lineCount: 0, arcCount: 0, nodeCount: 0, inferredLoops: 0 });
    return [];
  }

  const adjacency = new Map();
  const nodes = new Map();

  function ensureNode(pt) {
    const key = pointKey(pt);
    if (!adjacency.has(key)) adjacency.set(key, []);
    if (!nodes.has(key)) nodes.set(key, { x: pt.x, y: pt.y, key });
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
      const rev = rotated.slice().reverse();
      const candidate = rotated.join('>');
      const reverseCandidate = rev.join('>');
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
      const reverseIndex = options.findIndex(
        option => option.edgeIndex === current.edgeIndex && option.toKey === current.fromKey
      );
      if (reverseIndex === -1 || !options.length) return null;

      const next = options[(reverseIndex - 1 + options.length) % options.length];
      current = next;
    }

    return null;
  }

  const loops = [];
  const visitedHalfEdges = new Set();
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
        visitedHalfEdges.add(halfEdgeKey(fromKey, edgeIndex, toKey));
      });

      if (loop.area <= EPS) return;

      const cycleKey = normalizeCycle(loop.pointKeys);
      if (!cycleKey || seenCycles.has(cycleKey)) return;
      seenCycles.add(cycleKey);

      const sourceEntities = [...new Set(loop.edgeIndices.map(edgeIndex => openEdges[edgeIndex].entity))];
      sourceEntities.forEach(entity => { entity.__inferredContour = true; });
      const dominantLayer = sourceEntities.reduce((acc, ent) => {
        const layer = ent.layer || '0';
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
        componentId: edgeComponent.get(index),
      });
    });
  });

  const bestLoopByComponent = new Map();
  loops.forEach(loop => {
    const area = Math.abs(polygonSignedArea(loop.points));
    const prev = bestLoopByComponent.get(loop.componentId);
    const score = [
      loop.isSingleLayer ? 1 : 0,
      area,
    ];
    if (!prev || score[0] > prev.score[0] || (score[0] === prev.score[0] && score[1] > prev.score[1])) {
      bestLoopByComponent.set(loop.componentId, { area, loop, score });
    }
  });
  loops.forEach(loop => {
    const area = Math.abs(polygonSignedArea(loop.points));
    const best = bestLoopByComponent.get(loop.componentId);
    loop.isPrimary = !!best && best.loop === loop;
    loop.area = area;
  });

  const degreeHistogram = {};
  adjacency.forEach(indices => {
    const degree = indices.length;
    degreeHistogram[degree] = (degreeHistogram[degree] || 0) + 1;
  });
  debugDXF('Line loop result', {
    lineCount: openEdges.filter(edge => edge.entity.type === 'LINE').length,
    arcCount: openEdges.filter(edge => edge.entity.type === 'ARC').length,
    nodeCount: nodes.size,
    componentCount: componentSeq,
    degreeHistogram,
    inferredLoops: loops.length,
    selectedLoops: loops.filter(loop => loop.isPrimary).length,
    loops: loops.map((loop, index) => ({
      index,
      layer: loop.layer,
      componentId: loop.componentId,
      isPrimary: loop.isPrimary,
      pointCount: loop.points.length,
      area: loop.area,
      sourceEntityCount: loop.sourceEntities.length,
    })),
  });

  return loops;
}

function contourContainsContour(parent, child) {
  if (!bboxContainsPoint(parent.bbox, child.sample)) return false;
  return pointInPoly(child.sample.x, child.sample.y, parent.points);
}

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

function contourPreferenceScore(contour) {
  const entity = contour?.entity || {};
  return [
    entity.type === 'LINE_LOOP' ? 0 : 1,
    entity.isPrimary ? 1 : 0,
    entity.isSingleLayer ? 1 : 0,
    contour.area || 0,
  ];
}

function compareContourPreference(a, b) {
  const aa = contourPreferenceScore(a);
  const bb = contourPreferenceScore(b);
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return 0;
}

/**
 * Groups entities by outer contour.
 *
 * Returns an array of ShapeGroup:
 *   { outer, contours, decorators, bbox, layer }
 *
 * outer        — the top-level closed contour candidate
 * contours     — all descendant closed contours under outer
 * decorators   — all other entities inside outer (LINE/ARC/CIRCLE…)
 * bbox         — {minX,minY,maxX,maxY} in DXF space
 * layer        — layer name of outer contour
 */
function groupByContour(entities) {
  const syntheticLineLoops = buildClosedContoursFromLines(entities);
  const contourEntities = [
    ...entities.filter(isClosedEntity),
    ...syntheticLineLoops,
  ];

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
        points,
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

  // Everything else
  const closedEntities = new Set();
  uniqueClosed.forEach(c => {
    if (Array.isArray(c.entity.sourceEntities)) {
      c.entity.sourceEntities.forEach(src => closedEntities.add(src));
    } else {
      closedEntities.add(c.entity);
    }
  });
  const others = entities.filter(e => !closedEntities.has(e));

  if (uniqueClosed.length === 0) return [];

  // For each closed poly, find its direct parent (smallest containing poly)
  const parents = uniqueClosed.map((poly, i) => {
    let bestJ = -1, bestArea = Infinity;
    uniqueClosed.forEach((other, j) => {
      if (i === j || other.area >= bestArea || other.area <= poly.area) return;
      if (contourContainsContour(other, poly)) {
        bestJ = j; bestArea = other.area;
      }
    });

    if (bestJ === -1 && poly.entity?.type === 'LINE_LOOP' && !poly.entity.isPrimary) {
      const primaryIndex = primarySyntheticByComponent.get(poly.entity.componentId);
      if (primaryIndex !== undefined && primaryIndex !== i) {
        bestJ = primaryIndex;
      }
    }

    return bestJ;
  });

  // Top-level = no parent
  const topIdx = uniqueClosed.map((_, i) => i).filter(i => parents[i] === -1);

  return topIdx.map(ti => {
    const outer    = uniqueClosed[ti];
    const outerBB  = outer.bbox;

    // All descendants at any depth remain attached to this top-level shape.
    const descIdx = [];
    const collect = pi => uniqueClosed.forEach((_, ci) => {
      if (parents[ci] === pi) { descIdx.push(ci); collect(ci); }
    });
    collect(ti);
    const contourIndices = [ti, ...descIdx];
    const enrichedContours = contourIndices.map(index => ({
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

    // Non-polyline entities inside outer contour
    let decorators = others.filter(ent => {
      if (['HATCH','TEXT','MTEXT','DIMENSION','INSERT'].includes(ent.type)) return false;
      const pt = safeSamplePoint(ent);
      if (!pt) return false;
      if (!bboxContainsPoint(outerBB, pt)) return false;
      return pointInPoly(pt.x, pt.y, outer.points);
    });

    if (outer.entity?.type === 'LINE_LOOP' && outer.entity?.componentId !== undefined) {
      const componentDecorators = entities.filter(ent =>
        (ent?.type === 'LINE' || ent?.type === 'ARC') &&
        ent.__openEdgeComponentId === outer.entity.componentId &&
        !contourSourceEntities.has(ent)
      );

      const seen = new Set(decorators);
      componentDecorators.forEach(ent => {
        if (!seen.has(ent)) decorators.push(ent);
      });
    }

    return {
      outer,
      contours: enrichedContours,
      decorators,
      bbox: outerBB,
      layer: outer.layer,
    };
  });
}

// ── Section 5: Parse entry point ─────────────────────────
const FALLBACK_PALETTE = ['#4f8ef7','#f75f5f','#4fcf8e','#f7c34f','#cf4ff7','#4ff7e8','#f77f4f'];
const DXF_DEBUG = true;

function debugDXF(label, payload) {
  if (!DXF_DEBUG) return;
  console.log(`[DXF DEBUG] ${label}`, payload);
}

function parseRawEntityMeta(raw) {
  if (!raw) return new Map();

  const lines = raw.split(/\r\n|\r|\n/g);
  const meta = new Map();
  let i = 0;
  let inEntities = false;

  while (i < lines.length - 1) {
    const code = lines[i].trim();
    const value = lines[i + 1];

    if (code === '0' && value === 'SECTION' && lines[i + 2]?.trim() === '2' && lines[i + 3] === 'ENTITIES') {
      inEntities = true;
      i += 4;
      continue;
    }

    if (inEntities && code === '0' && value === 'ENDSEC') break;

    if (inEntities && code === '0') {
      const type = value.trim();
      const entity = { type };
      i += 2;
      while (i < lines.length - 1) {
        const groupCode = lines[i].trim();
        const groupValue = lines[i + 1];
        if (groupCode === '0') break;
        if (groupCode === '5') entity.handle = groupValue.trim();
        if (groupCode === '210') entity.extrusionX = parseFloat(groupValue);
        if (groupCode === '220') entity.extrusionY = parseFloat(groupValue);
        if (groupCode === '230') entity.extrusionZ = parseFloat(groupValue);
        i += 2;
      }
      if (entity.handle) meta.set(entity.handle, entity);
      continue;
    }

    i += 2;
  }

  return meta;
}

function applyNegativeZExtrusionTransform(entity) {
  if (!entity) return entity;

  const mirrorPoint = point => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return point;
    return { ...point, x: -point.x };
  };

  if (entity.center) entity.center = mirrorPoint(entity.center);
  if (entity.start) entity.start = mirrorPoint(entity.start);
  if (entity.end) entity.end = mirrorPoint(entity.end);
  if (Array.isArray(entity.vertices)) entity.vertices = entity.vertices.map(vertex => mirrorPoint(vertex));
  if (Array.isArray(entity.controlPoints)) entity.controlPoints = entity.controlPoints.map(point => mirrorPoint(point));
  if (Array.isArray(entity.fitPoints)) entity.fitPoints = entity.fitPoints.map(point => mirrorPoint(point));
  if (entity.majorAxisEndPoint && Number.isFinite(entity.majorAxisEndPoint.x)) {
    entity.majorAxisEndPoint = { ...entity.majorAxisEndPoint, x: -entity.majorAxisEndPoint.x };
  }

  if (entity.type === 'ARC' && Number.isFinite(entity.startAngle) && Number.isFinite(entity.endAngle)) {
    entity.startAngle = Math.PI - entity.startAngle;
    entity.endAngle = Math.PI - entity.endAngle;
  }

  return entity;
}

function enrichEntitiesFromRaw(entities, raw) {
  const rawMeta = parseRawEntityMeta(raw);
  if (!rawMeta.size) return entities;

  return entities.map(entity => {
    const info = rawMeta.get(entity.handle);
    if (!info) return entity;

    const extrusion = {
      x: Number.isFinite(info.extrusionX) ? info.extrusionX : 0,
      y: Number.isFinite(info.extrusionY) ? info.extrusionY : 0,
      z: Number.isFinite(info.extrusionZ) ? info.extrusionZ : 1,
    };

    entity.extrusion = extrusion;
    if (Math.abs(extrusion.x) < 1e-6 && Math.abs(extrusion.y) < 1e-6 && extrusion.z < 0) {
      applyNegativeZExtrusionTransform(entity);
    }
    return entity;
  });
}

function parseDXFToShapes(dxf, raw) {
  const entities   = enrichEntitiesFromRaw([...(dxf.entities || [])], raw);
  const layerTable = (dxf.tables && dxf.tables.layer && dxf.tables.layer.layers) || {};
  const entityTypeCounts = entities.reduce((acc, ent) => {
    const key = ent?.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  debugDXF('Parse start', {
    entityCount: entities.length,
    entityTypes: entityTypeCounts,
  });

  let palIdx = 0;
  const colorCache = {};
  function layerColor(name) {
    if (colorCache[name]) return colorCache[name];
    const def = layerTable[name];
    colorCache[name] = (def && aciToHex(def.color)) ||
                       FALLBACK_PALETTE[palIdx++ % FALLBACK_PALETTE.length];
    return colorCache[name];
  }

  const groups  = groupByContour(entities);
  debugDXF('Grouping result', {
    groupCount: groups.length,
    groups: groups.map(group => ({
      layer: group.layer,
      contourCount: group.contours.length,
      decoratorCount: group.decorators.length,
      bbox: group.bbox,
    })),
  });
  if (groups.length === 0) return null; // trigger mock fallback

  const shapes   = [];
  const layerMap = new Map();
  let   idx      = 0;

  groups.forEach(g => {
    const { outer, contours, decorators, bbox } = g;
    let renderBBox = bbox;

    const holeContours = contours.filter(contour =>
      contour.id !== outer.id &&
      contour.layer === outer.layer &&
      contour.depth % 2 === 1 &&
      contour.entity?.type !== 'LINE_LOOP'
    );

    const closedDecorContours = contours.filter(contour =>
      contour.id !== outer.id &&
      !(contour.layer === outer.layer && contour.depth % 2 === 1)
    );

    closedDecorContours.forEach(contour => {
      renderBBox = unionBBox(renderBBox, contour.bbox);
    });
    decorators.forEach(decorator => {
      renderBBox = unionBBox(renderBBox, entityBBox(decorator));
    });

    const { minX, minY, maxX, maxY } = renderBBox;
    const W = maxX - minX;
    const H = maxY - minY;
    if (W < 0.5 || H < 0.5) return;

    const contourPaths = [outer, ...holeContours]
      .map(contour => contourEntityToPath(contour.entity, minX, maxY))
      .filter(Boolean);
    const pathData  = contourPaths.join(' ');
    const fillRule  = contourPaths.length > 1 ? 'evenodd' : 'nonzero';

    const decorItems = [];

    closedDecorContours.forEach(contour => {
      if (contour.entity?.type === 'LINE_LOOP') return;
      const layerName = contour.layer || '0';
      const path = contourEntityToPath(contour.entity, minX, maxY);
      if (!path) return;
      decorItems.push({
        type: 'closed-contour',
        layer: layerName,
        color: layerColor(layerName),
        svg: `<path d="${path}" stroke="${layerColor(layerName)}" stroke-width="0.8" opacity="0.9" fill="none" stroke-linejoin="round"/>`,
      });
    });

    decorators.forEach(d => {
      const color = layerColor(d.layer || outer.layer || '0');
      const svg = entityToSVGStr(d, minX, maxY, color);
      if (!svg) return;
      decorItems.push({
        type: 'entity',
        layer: d.layer || outer.layer || '0',
        color,
        svg,
      });
    });

    contours.slice(1).forEach(ic => {
      const ln = ic.layer || '0';
      layerMap.set(ln, layerColor(ln));
    });
    decorators.forEach(d => {
      const ln = d.layer || '0';
      layerMap.set(ln, layerColor(ln));
    });

    const ln = outer.layer || '0';
    layerMap.set(ln, layerColor(ln));
    const involvedLayers = [...new Set([ln, ...decorItems.map(item => item.layer)])];
    const mixedOuterLayers = outer.entity?.type === 'LINE_LOOP' && Array.isArray(outer.entity?.sourceLayers) && outer.entity.sourceLayers.length > 1;
    const selectionFillAllowed = !mixedOuterLayers && involvedLayers.length <= 1 && closedDecorContours.length === 0 && decorators.length === 0;
    const outerBoundaryItems = mixedOuterLayers
      ? (outer.entity?.sourceEntities || []).map(entity => {
          const layerName = entity.layer || '0';
          const color = layerColor(layerName);
          const svg = entityToSVGStr(entity, minX, maxY, color);
          if (!svg) return null;
          return {
            layer: layerName,
            color,
            svg,
          };
        }).filter(Boolean)
      : [];

    shapes.push({
      id:         `s_${idx++}`,
      name:       `Shape ${idx}`,
      layer:      ln,
      layerColor: layerColor(ln),
      mixedOuterLayers,
      selectionFillAllowed,
      outerBoundaryItems,
      pathData,
      fillRule,
      bbox:       { w: W, h: H },
      decorSVG: decorItems.map(item => item.svg),
      decorItems,
      involvedLayers,
      holes:      [],     // legacy compat
      qty:        1,
      visible:    true,
      selected:   false,
    });
  });

  if (shapes.length === 0) return null;

  const layers = [...layerMap.entries()].map(([name, color]) => ({ name, color }));
  debugDXF('Parse complete', {
    shapeCount: shapes.length,
    layerCount: layers.length,
    shapes: shapes.map(shape => ({
      id: shape.id,
      layer: shape.layer,
      bbox: shape.bbox,
      fillRule: shape.fillRule,
      decorCount: shape.decorSVG.length,
    })),
  });
  return { shapes, layers };
}

// ── Section 6: Mock fallback ──────────────────────────────
const LAYER_DEFS = [
  { name: 'BODY',    color: '#4f8ef7' },
  { name: 'CUT',     color: '#f75f5f' },
  { name: 'DRILL',   color: '#4fcf8e' },
  { name: 'FOLD',    color: '#f7c34f' },
  { name: 'ENGRAVE', color: '#cf4ff7' },
];
const GENERATORS = [
  r => { const w=50+r()*110,h=32+r()*80; return {d:`M0,0 H${f(w)} V${f(h)} H0 Z`,w,h,name:'Plate'}; },
  r => { const w=72+r()*65,h=62+r()*55,fw=18+r()*20,fh=18+r()*20; return {d:`M0,0 H${f(w)} V${f(fh)} H${f(fw)} V${f(h)} H0 Z`,w,h,name:'L-Bracket'}; },
  r => { const w=82+r()*62,h=52+r()*45,tw=14+r()*12,fw=14+r()*12; return {d:`M0,0 H${f(w)} V${f(h)} H${f(w-fw)} V${f(tw)} H${f(fw)} V${f(h)} H0 Z`,w,h,name:'U-Channel'}; },
  r => { const w=82+r()*52,h=72+r()*52,tH=18+r()*16,fw=18+r()*16,sx=(w-fw)/2; return {d:`M0,0 H${f(w)} V${f(tH)} H${f(sx+fw)} V${f(h)} H${f(sx)} V${f(tH)} H0 Z`,w,h,name:'T-Shape'}; },
  r => { const w=82+r()*85,h=52+r()*55,c=10+r()*18; return {d:`M${f(c)},0 H${f(w-c)} L${f(w)},${f(c)} V${f(h-c)} L${f(w-c)},${f(h)} H${f(c)} L0,${f(h-c)} V${f(c)} Z`,w,h,name:'Chamfered Plate'}; },
  r => { const w=92+r()*65,h=52+r()*45,sw=18+r()*22,sh=12+r()*12,sx=(w-sw)/2,sy=(h-sh)/2; return {d:`M0,0 H${f(w)} V${f(h)} H0 Z M${f(sx)},${f(sy)} H${f(sx+sw)} V${f(sy+sh)} H${f(sx)} Z`,w,h,name:'Slotted Plate',fillRule:'evenodd'}; },
  r => { const w=62+r()*55,h=62+r()*55,cut=16+r()*22; return {d:`M0,0 H${f(w)} V${f(h)} L${f(cut)},${f(h)} L0,${f(h-cut)} Z`,w,h,name:'Gusset'}; },
  r => { const w=90+r()*60,h=55+r()*40,flH=10+r()*10,flW=12+r()*10; return {d:`M0,${f(flH)} H${f(flW)} V0 H${f(w-flW)} V${f(flH)} H${f(w)} V${f(h-flH)} H${f(w-flW)} V${f(h)} H${f(flW)} V${f(h-flH)} H0 Z`,w,h,name:'Flanged Plate'}; },
];

function mockDXFData(filename) {
  const rng = mkRng(hashStr(filename));
  const numL = 2 + Math.floor(rng() * 3);
  const layers = LAYER_DEFS.slice(0, numL);
  const shapes = [];
  let idx = 0;
  layers.forEach(layer => {
    if (['DRILL','FOLD','ENGRAVE'].includes(layer.name)) return;
    const count = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < count; i++) {
      const gen = GENERATORS[Math.floor(rng() * GENERATORS.length)](rng);
      const hN  = layer.name === 'BODY' ? Math.floor(rng() * 5) : 0;
      // Generate mock drill holes as SVG circle strings
      const decorSVG = [];
      for (let h = 0; h < hN; h++) {
        const cx = 12 + rng() * (gen.w - 24), cy = 12 + rng() * (gen.h - 24), r = 3 + rng() * 4;
        decorSVG.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" stroke="${layer.color}" stroke-width="0.8" opacity="0.7" fill="none"/>`);
      }
      shapes.push({
        id: `s_${idx++}`, name: gen.name + (count > 1 ? ` ${String.fromCharCode(65+i)}` : ''),
        layer: layer.name, layerColor: layer.color,
        pathData: gen.d, fillRule: gen.fillRule || 'nonzero',
        bbox: { w: gen.w, h: gen.h },
        decorSVG,
        holes: [], qty: 1, visible: true, selected: false,
      });
    }
  });
  return { shapes, layers };
}

// ── Section 7: Layout & SVG rendering ────────────────────
const DEFAULT_CANVAS_W = 560;
const PAD = 18;

function getCanvasWidth() {
  const fallback = DEFAULT_CANVAS_W;
  const col = pvCanvasWrap?.parentElement;
  if (!col) return fallback;

  const style = window.getComputedStyle(col);
  const colWidth = col.clientWidth
    - parseFloat(style.paddingLeft || 0)
    - parseFloat(style.paddingRight || 0);

  return Math.max(fallback, Math.floor(colWidth - 8));
}

function autoLayout(shapes, canvasWidth) {
  let x = PAD, y = PAD, rowH = 0;
  return shapes.map(s => {
    if (x + s.bbox.w + PAD > canvasWidth && x > PAD) { x = PAD; y += rowH + PAD; rowH = 0; }
    const pos = { x, y };
    x += s.bbox.w + PAD; rowH = Math.max(rowH, s.bbox.h);
    return pos;
  });
}

function buildPreviewSVG(shapes, positions, activeLayer, selectedId, canvasWidth) {
  const maxX = positions.reduce((m, p, i) => Math.max(m, p.x + shapes[i].bbox.w + PAD), 0);
  const maxY = positions.reduce((m, p, i) => Math.max(m, p.y + shapes[i].bbox.h + 14), 0) + PAD;
  const W = Math.max(canvasWidth, maxX, DEFAULT_CANVAS_W);
  const H = Math.max(maxY, 220);

  const grid = [];
  for (let gx = 0; gx <= W; gx += 24) grid.push(`<line x1="${gx}" y1="0" x2="${gx}" y2="${H}" stroke="#1a1d2a" stroke-width="0.5"/>`);
  for (let gy = 0; gy <= H; gy += 24) grid.push(`<line x1="0" y1="${gy}" x2="${W}" y2="${gy}" stroke="#1a1d2a" stroke-width="0.5"/>`);

  const shapeEls = shapes.map((s, i) => {
    const pos     = positions[i];
    const isSel   = s.id === selectedId;
    const hasActiveLayer = activeLayer !== null;
    const layerMatch = !hasActiveLayer || (s.involvedLayers || [s.layer]).includes(activeLayer);
    const isDimmed = !s.visible || !layerMatch;
    const showOuter = !hasActiveLayer || activeLayer === s.layer || !layerMatch;
    const visibleDecorItems = (s.decorItems || []).filter(item => !hasActiveLayer || item.layer === activeLayer);
    const visibleBoundaryItems = (s.outerBoundaryItems || []).filter(item => !hasActiveLayer || item.layer === activeLayer);
    const allowSelectionFill = !!s.selectionFillAllowed;
    const dimmedOuterOpacity = hasActiveLayer && activeLayer !== s.layer && layerMatch ? 0.05 : (isSel ? 0.25 : 0.09);
    const dimmedStrokeOpacity = hasActiveLayer && activeLayer !== s.layer && layerMatch ? 0.25 : 1;
    const outerFill = s.layerColor;
    const outerFillOpacity = allowSelectionFill ? dimmedOuterOpacity : 0;
    const outerStroke = s.layerColor;
    const outerStrokeOpacity = dimmedStrokeOpacity;

    return `
<g class="pvw-shape" data-id="${s.id}"
   transform="translate(${f(pos.x)},${f(pos.y)})"
   opacity="${isDimmed ? 0.12 : 1}" style="cursor:pointer">
  ${showOuter && isSel && allowSelectionFill ? `<path d="${s.pathData}" fill="white" fill-opacity="0.06" fill-rule="${s.fillRule}" stroke="none"/>` : ''}
  ${showOuter && !s.mixedOuterLayers ? `<path d="${s.pathData}"
    fill="${outerFill}" fill-opacity="${outerFillOpacity}" fill-rule="${s.fillRule}"
    stroke="${outerStroke}" stroke-opacity="${outerStrokeOpacity}" stroke-width="${isSel ? 2 : 1.4}" stroke-linejoin="round"
    ${isSel && (!hasActiveLayer || activeLayer === s.layer) ? 'filter="url(#pvwGlow)"' : ''}/>` : ''}
  ${showOuter && isSel ? `<path d="${s.pathData}" fill="none" stroke="${s.layerColor}" stroke-width="2.8" stroke-opacity="0.35" stroke-dasharray="5 3" fill-rule="${s.fillRule}"/>` : ''}
  ${visibleBoundaryItems.map(item => item.svg).join('\n')}
  ${visibleDecorItems.map(item => item.svg).join('\n')}
  <text x="${f(s.bbox.w / 2)}" y="${f(s.bbox.h + 11)}"
    text-anchor="middle" font-size="8" fill="${s.layerColor}" opacity="0.6"
    font-family="monospace">${s.name}</text>
  <title>${s.name} · ${(s.involvedLayers || [s.layer]).join(', ')} · ${f1(s.bbox.w)}×${f1(s.bbox.h)} mm</title>
</g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"
    id="pvwSVGInner" style="display:block;width:${W}px">
  <defs>
    <filter id="pvwGlow" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="#0d0f18"/>
  ${grid.join('')}
  ${shapeEls}
</svg>`;
}

// ── Section 8: State & DOM ────────────────────────────────
const pv = {
  fileId: null, filename: '', shapes: [], layers: [],
  activeLayer: null, selectedId: null, positions: [], zoom: 1,
  panelVisible: true, canvasWidth: DEFAULT_CANVAS_W,
};

const pvModal      = document.getElementById('dxfPreviewModal');
const pvClose      = document.getElementById('pvClose');
const pvCancel     = document.getElementById('pvCancel');
const pvApply      = document.getElementById('pvApply');
const pvLayerTabs  = document.getElementById('pvLayerTabs');
const pvCanvasWrap = document.getElementById('pvCanvasWrap');
const pvShapesList = document.getElementById('pvShapesList');
const pvFileName   = document.getElementById('pvFileName');
const pvFileMeta   = document.getElementById('pvFileMeta');
const pvShapeCount = document.getElementById('pvShapeCount');
const pvStats      = document.getElementById('pvStats');
const pvZoomIn     = document.getElementById('pvZoomIn');
const pvZoomOut    = document.getElementById('pvZoomOut');
const pvZoomFit    = document.getElementById('pvZoomFit');
const pvZoomLabel  = document.getElementById('pvZoomLabel');
const pvTogglePanel = document.getElementById('pvTogglePanel');

// ── Render SVG canvas ─────────────────────────────────────
function pvRenderSVG() {
  pv.canvasWidth = getCanvasWidth();
  pv.positions = autoLayout(pv.shapes, pv.canvasWidth);
  pvCanvasWrap.innerHTML = `<div class="pvw-canvas-inner" id="pvCanvasInner">${
    buildPreviewSVG(pv.shapes, pv.positions, pv.activeLayer, pv.selectedId, pv.canvasWidth)
  }</div>`;
  pvApplyZoomTransform();
  pvCanvasWrap.querySelectorAll('.pvw-shape').forEach(g =>
    g.addEventListener('click', () => pvSelectShape(g.dataset.id))
  );
}

function pvApplyZoomTransform() {
  const inner = document.getElementById('pvwSVGInner');
  const canvasInner = document.getElementById('pvCanvasInner');
  if (!inner || !canvasInner) return;
  inner.style.transformOrigin = 'top left';
  inner.style.transform = `scale(${pv.zoom})`;
  const viewBox = (inner.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  const svgWidth = Number.isFinite(viewBox[2]) ? viewBox[2] : pv.canvasWidth;
  const svgHeight = Number.isFinite(viewBox[3]) ? viewBox[3] : 220;
  canvasInner.style.width = `${Math.max(pv.canvasWidth, svgWidth * pv.zoom)}px`;
  canvasInner.style.height = `${svgHeight * pv.zoom}px`;
}

// ── Render shapes list ────────────────────────────────────
function pvRenderList() {
  const vis   = pv.shapes.filter(s => s.visible);
  const total = vis.reduce((a, s) => a + s.qty, 0);
  pvShapeCount.textContent = vis.length;
  pvFileMeta.textContent   = `${pv.shapes.length} shape${pv.shapes.length !== 1 ? 's' : ''} · ${pv.layers.length} layer${pv.layers.length !== 1 ? 's' : ''}`;
  pvStats.textContent      = `${total} piece${total !== 1 ? 's' : ''} queued for nesting`;

  pvShapesList.innerHTML = '';
  const layerOrder = pv.layers.map(l => l.name);
  const grouped    = [...vis].sort((a, b) => layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer));

  let lastLayer = null;
  grouped.forEach(s => {
    if (s.layer !== lastLayer) {
      lastLayer = s.layer;
      const col = (pv.layers.find(l => l.name === s.layer) || {}).color || '#888';
      const hdr = document.createElement('div');
      hdr.className = 'shapes-group-hdr';
      hdr.innerHTML = `<span class="layer-dot" style="background:${col}"></span>${s.layer}`;
      pvShapesList.appendChild(hdr);
    }

    // Thumbnail includes decorators
    const ts = Math.min(40 / s.bbox.w, 30 / s.bbox.h) * 0.9;
    const tw = f(s.bbox.w * ts), th = f(s.bbox.h * ts);
    const scaledDecors = (s.decorSVG || []).map(svg =>
      svg.replace(/stroke-width="([^"]+)"/g, (_, n) => `stroke-width="${f(+n / ts)}"`)
    ).join('');
    const scaledBoundary = (s.outerBoundaryItems || []).map(item =>
      item.svg.replace(/stroke-width="([^"]+)"/g, (_, n) => `stroke-width="${f(+n / ts)}"`)
    ).join('');
    const thumbFillOpacity = s.selectionFillAllowed ? (s.mixedOuterLayers ? '1' : '0.18') : '0';
    const thumbFill = s.layerColor;
    const thumbStroke = s.layerColor;
    const thumb = `<svg viewBox="0 0 ${f(s.bbox.w)} ${f(s.bbox.h)}" width="${tw}" height="${th}">
      ${!s.mixedOuterLayers ? `<path d="${s.pathData}" fill="${thumbFill}" fill-opacity="${thumbFillOpacity}" fill-rule="${s.fillRule}"
        stroke="${thumbStroke}" stroke-width="${f(1.6 / ts)}" stroke-linejoin="round"/>` : ''}
      ${scaledBoundary}
      ${scaledDecors}
    </svg>`;

    const row = document.createElement('div');
    row.className = `pvw-shape-row${s.id === pv.selectedId ? ' selected' : ''}`;
    row.dataset.id = s.id;
    row.innerHTML  = `
      <div class="pvw-thumb">${thumb}</div>
      <div class="pvw-info">
        <div class="pvw-name">${s.name}</div>
        <div class="pvw-dims">${f1(s.bbox.w)} × ${f1(s.bbox.h)} mm</div>
      </div>
      <div class="pvw-controls">
        <button class="qty-btn pvw-dec" data-id="${s.id}">−</button>
        <span class="qty-value">${s.qty}</span>
        <button class="qty-btn pvw-inc" data-id="${s.id}">+</button>
        <button class="pvw-del" data-id="${s.id}" title="Remove">
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <path d="M8 1L1 8M1 1l7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
        </button>
      </div>`;
    row.addEventListener('click', e => { if (!e.target.closest('.pvw-controls')) pvSelectShape(s.id); });
    pvShapesList.appendChild(row);
  });

  pvShapesList.querySelectorAll('.pvw-dec').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation(); pvChangeQty(b.dataset.id, -1); }));
  pvShapesList.querySelectorAll('.pvw-inc').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation(); pvChangeQty(b.dataset.id, 1); }));
  pvShapesList.querySelectorAll('.pvw-del').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation(); pvDeleteShape(b.dataset.id); }));
}

// ── Layer tabs ────────────────────────────────────────────
function pvRenderTabs() {
  pvLayerTabs.innerHTML = '';
  const mk = (label, dot, layerName) => {
    const active = pv.activeLayer === layerName;
    const btn = document.createElement('button');
    btn.className = `pvw-tab${active ? ' active' : ''}`;
    btn.innerHTML = `<span class="pvw-tab-dot" style="background:${dot}"></span>${label}`;
    btn.addEventListener('click', () => {
      pv.activeLayer = active ? null : layerName;
      pvRenderTabs(); pvRenderSVG();
    });
    return btn;
  };
  pvLayerTabs.appendChild(mk('All', 'var(--text-muted)', null));
  pv.layers.forEach(l => {
    const cnt   = pv.shapes.filter(s => (s.involvedLayers || [s.layer]).includes(l.name) && s.visible).length;
    const btn   = mk(l.name, l.color, l.name);
    const badge = document.createElement('span');
    badge.className = 'pvw-tab-count'; badge.textContent = cnt;
    btn.appendChild(badge);
    pvLayerTabs.appendChild(btn);
  });
}

// ── Interactions ──────────────────────────────────────────
function pvSelectShape(id) {
  pv.selectedId = pv.selectedId === id ? null : id;
  pvRenderSVG(); pvRenderList();
  if (pv.selectedId) {
    const el = pvShapesList.querySelector(`[data-id="${pv.selectedId}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
function pvChangeQty(id, delta) {
  const s = pv.shapes.find(x => x.id === id);
  if (s) { s.qty = Math.max(1, s.qty + delta); pvRenderList(); }
}
function pvDeleteShape(id) {
  const s = pv.shapes.find(x => x.id === id);
  if (!s) return;
  s.visible = false;
  if (pv.selectedId === id) pv.selectedId = null;
  pvRenderSVG(); pvRenderList(); pvRenderTabs();
}

// ── Zoom ──────────────────────────────────────────────────
function pvSetZoom(z) {
  pv.zoom = Math.max(0.25, Math.min(5, z));
  pvZoomLabel.textContent = Math.round(pv.zoom * 100) + '%';
  pvApplyZoomTransform();
}
pvZoomIn.addEventListener('click',  () => pvSetZoom(pv.zoom + 0.25));
pvZoomOut.addEventListener('click', () => pvSetZoom(pv.zoom - 0.25));
pvZoomFit.addEventListener('click', () => pvSetZoom(1));

// Mouse-wheel zoom on canvas
pvCanvasWrap.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  pvSetZoom(pv.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
}, { passive: false });

// ── Panel toggle ──────────────────────────────────────────
pvTogglePanel.addEventListener('click', () => {
  pv.panelVisible = !pv.panelVisible;
  const panel = document.querySelector('.pvw-shapes-panel');
  panel.classList.toggle('pvw-panel-hidden', !pv.panelVisible);
  pvTogglePanel.classList.toggle('active', !pv.panelVisible);
  requestAnimationFrame(() => pvRenderSVG());
});

// ── Loading state ─────────────────────────────────────────
function pvShowLoading() {
  pvCanvasWrap.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:200px;gap:10px;color:var(--text-muted);font-size:13px;">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none"
           style="animation:spin 1s linear infinite">
        <circle cx="16" cy="16" r="13" stroke="var(--border-light)" stroke-width="2.5"/>
        <path d="M16 3 A13 13 0 0 1 29 16" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
      Parsing DXF…
    </div>`;
  pvShapesList.innerHTML = '';
  pvLayerTabs.innerHTML  = '';
  pvFileMeta.textContent = 'Loading…';
}

// ── Open / close ──────────────────────────────────────────
async function openDXFPreview(fileId, filename) {
  pv.fileId = fileId; pv.filename = filename;
  pv.zoom = 1; pv.selectedId = null; pv.activeLayer = null;
  pv.shapes = []; pv.layers = []; pv.positions = [];
  pvFileName.textContent  = filename;
  pvZoomLabel.textContent = '100%';
  // Restore panel if it was hidden
  if (!pv.panelVisible) {
    pv.panelVisible = true;
    document.querySelector('.pvw-shapes-panel').classList.remove('pvw-panel-hidden');
    pvTogglePanel.classList.remove('active');
  }
  pvShowLoading();
  pvModal.classList.add('open');

  const file = state.files.find(f => f.id === fileId);
  let data   = null;
  let source = 'mock';

  if (file && file.path && window.electronAPI && window.electronAPI.parseDXF) {
    try {
      const result = await window.electronAPI.parseDXF(file.path);
      if (result.success && result.data) {
        const parsed = parseDXFToShapes(result.data, result.raw);
        if (parsed) { data = parsed; source = 'real'; }
        else console.warn('[DXF] No closed contours found — using mock');
      } else {
        console.warn('[DXF] Parse error:', result.error);
      }
    } catch (e) {
      console.error('[DXF] Unexpected error:', e);
    }
  }

  if (!data) data = mockDXFData(filename);

  pv.shapes    = data.shapes;
  pv.layers    = data.layers;
  pv.canvasWidth = getCanvasWidth();
  pv.positions = autoLayout(pv.shapes, pv.canvasWidth);

  const hint = source === 'real' ? '' : '  · preview';
  pvFileMeta.textContent =
    `${pv.shapes.length} shape${pv.shapes.length !== 1 ? 's' : ''} · ` +
    `${pv.layers.length} layer${pv.layers.length !== 1 ? 's' : ''}${hint}`;

  pvRenderTabs(); pvRenderSVG(); pvRenderList();
}

window.addEventListener('resize', () => {
  if (!pvModal.classList.contains('open')) return;
  pvRenderSVG();
});

function closeDXFPreview() { pvModal.classList.remove('open'); }

pvClose.addEventListener('click',  closeDXFPreview);
pvCancel.addEventListener('click', closeDXFPreview);
pvModal.addEventListener('click',  e => { if (e.target === pvModal) closeDXFPreview(); });

pvApply.addEventListener('click', () => {
  const file = state.files.find(f => f.id === pv.fileId);
  if (file) {
    file.shapes = pv.shapes.filter(s => s.visible).map(s => ({ ...s }));
    file.qty    = file.shapes.reduce((a, s) => a + s.qty, 0);
    renderFiles();
  }
  closeDXFPreview();
});

window.openDXFPreview = openDXFPreview;
