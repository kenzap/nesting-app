'use strict';

(function definePlacementEditor(root) {
  const Flatten = typeof module !== 'undefined' && module.exports
    ? require('@flatten-js/core') : (root.Flatten || root['@flatten-js/core']);
  const EPS = 1e-6;
  const CORNER_ANGLE_TOLERANCE = 0.01;
  const clone = value => JSON.parse(JSON.stringify(value));

  function readPlacements(data) {
    const placements = data?.solution?.layout?.placed_items ?? data?.solution?.placed_items;
    if (!Array.isArray(placements)) throw new Error('Final placement data is unavailable.');
    return placements;
  }

  function editsFor(placements) {
    return placements.map((p, sourceIndex) => ({
      sourceIndex, translation: [...p.transformation.translation], rotation: Number(p.transformation.rotation),
    }));
  }

  function applyEdits(original, edits) {
    if (!Array.isArray(edits) || edits.length > original.length) throw new Error('Invalid placement edits.');
    const seen = new Set();
    return edits.map(edit => {
      const index = edit.sourceIndex;
      if (!Number.isInteger(index) || index < 0 || index >= original.length || seen.has(index)
          || !Array.isArray(edit.translation) || edit.translation.length !== 2
          || !edit.translation.every(Number.isFinite)
          || (edit.rotation !== undefined && !Number.isFinite(edit.rotation))) throw new Error('Invalid placement edits.');
      seen.add(index);
      const placement = clone(original[index]);
      placement.transformation.translation = [...edit.translation];
      if (edit.rotation !== undefined) placement.transformation.rotation = edit.rotation;
      return placement;
    });
  }

  function transform(points, placement, margin = 0) {
    const angle = Number(placement.transformation.rotation) * Math.PI / 180;
    const [tx, ty] = placement.transformation.translation;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return points.map(([x, y]) => [cos * x - sin * y + tx + margin, sin * x + cos * y + ty + margin]);
  }

  function outline(item) {
    const points = item?.export?.polygon || item?.shape?.data;
    if (!Array.isArray(points) || points.length < 3
        || !points.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      throw new Error('Part geometry is unavailable.');
    }
    return points;
  }

  function rotationCenter(placement, item, margin = 0) {
    const points = outline(item);
    const bounds = points.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
      [Infinity, Infinity, -Infinity, -Infinity]);
    return transform([[(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]], placement, margin)[0];
  }

  function rotateEdit(edit, placement, item, degrees) {
    if (!Number.isFinite(degrees)) throw new Error('Invalid rotation.');
    const rotation = ((Number(placement.transformation.rotation) + degrees) % 360 + 360) % 360;
    const before = rotationCenter(placement, item);
    const after = rotationCenter({ transformation: { rotation, translation: [0, 0] } }, item);
    // Keep the local bounding-box center fixed in sheet coordinates.
    return { ...edit, rotation, translation: before.map((value, axis) => value - after[axis]) };
  }

  function polygon(points) {
    const ring = Array.from(points, p => new Flatten.Point(p[0], p[1]));
    if (ring.length > 3 && ring[0].equalTo(ring[ring.length - 1])) ring.pop();
    const result = new Flatten.Polygon(ring);
    if (result.area() <= EPS || !result.isValid()) throw new Error('Invalid part geometry.');
    return result;
  }

  // Check only the moved copy. An existing solver result is never silently
  // rearranged or rejected just because another pair uses a different tolerance.
  function validateMove(placements, index, items, frame, spacing = 0) {
    try {
      if (![frame.width, frame.height, frame.margin, spacing].every(Number.isFinite)
          || frame.margin < 0 || spacing < 0 || frame.width <= frame.margin * 2 || frame.height <= frame.margin * 2
          || !Number.isFinite(Number(placements[index]?.transformation?.rotation))) return 'geometry';
      const points = transform(outline(items[placements[index].item_id]), placements[index]);
      if (points.some(([x, y]) => x < -EPS || y < -EPS
          || x > frame.width - 2 * frame.margin + EPS || y > frame.height - 2 * frame.margin + EPS)) return 'bounds';
      const moved = polygon(points);
      for (let i = 0; i < placements.length; i++) {
        if (i === index) continue;
        const otherPoints = transform(outline(items[placements[i].item_id]), placements[i]);
        const xs = otherPoints.map(p => p[0]), ys = otherPoints.map(p => p[1]);
        const box = moved.box;
        if (Math.min(...xs) > box.xmax + spacing || Math.max(...xs) < box.xmin - spacing
            || Math.min(...ys) > box.ymax + spacing || Math.max(...ys) < box.ymin - spacing) continue;
        const other = polygon(otherPoints);
        if (Flatten.BooleanOperations.intersect(moved, other).area() > EPS) return 'collision';
        if (spacing > EPS && moved.distanceTo(other)[0] < spacing - EPS) return 'spacing';
      }
      return null;
    } catch (_) {
      return 'geometry';
    }
  }

  function validateEdits(original, edits, items, frame, spacing) {
    const placements = applyEdits(original, edits);
    edits.forEach((edit, index) => {
      const before = original[edit.sourceIndex].transformation;
      if (before.translation.every((value, axis) => value === edit.translation[axis])
          && Number(before.rotation) === Number(placements[index].transformation.rotation)) return;
      const reason = validateMove(placements, index, items, frame, spacing);
      if (reason) throw new Error(`Invalid manual placement: ${reason}`);
    });
    return placements;
  }

  const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const distance = (a, b) => Math.hypot(...subtract(a, b));

  function straightEdges(item) {
    const points = outline(item), segments = item.shared_edge_segments;
    // Snapping is optional assistance; very dense contours still move freely.
    if (points.length > 4096 || (segments?.length || 0) > 8192) return [];
    // Source metadata distinguishes true lines from polygonized arcs/splines.
    // Without it, only plain polygon inputs are safe to treat as straight.
    if (!Array.isArray(segments) && item.export?.entities?.length) return [];
    const onSegment = (p, a, b) => {
      const v = subtract(b, a), len = Math.hypot(...v);
      if (len < EPS) return false;
      const rel = subtract(p, a), projection = dot(rel, v) / len;
      return Math.abs(rel[0] * v[1] - rel[1] * v[0]) / len < 0.001
        && projection >= -0.001 && projection <= len + 0.001;
    };
    return points.map((a, i) => [a, points[(i + 1) % points.length]])
      .filter(([a, b]) => distance(a, b) > EPS && (!Array.isArray(segments)
        || segments.some(s => s.length === 4 && s.every(Number.isFinite)
          && onSegment(a, s.slice(0, 2), s.slice(2)) && onSegment(b, s.slice(0, 2), s.slice(2)))));
  }

  // Build once per drag, not once per pointer event. Only outer contour edges
  // matching original straight DXF segments are eligible snapping targets.
  function prepareEdgeSnap(placements, index, items) {
    const cache = new Map();
    const edges = id => {
      if (!cache.has(id)) cache.set(id, straightEdges(items[id]));
      return cache.get(id);
    };
    const targets = [];
    placements.forEach((placement, i) => {
      if (i === index) return;
      edges(placement.item_id).forEach(edge => {
        const [a, b] = transform(edge, placement);
        targets.push({ a, b, placementIndex: i, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]),
          minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
      });
    });
    targets.sort((a, b) => a.minX - b.minX);
    return { edges: edges(placements[index].item_id), targets };
  }

  function findEdgeSnap(placements, index, edit, items, frame, spacing, context,
    { distanceLimit, angleLimit = 3 } = {}) {
    if (!(distanceLimit > 0) || !Number.isFinite(distanceLimit) || !Number.isFinite(angleLimit)
        || angleLimit <= 0 || !Number.isFinite(spacing) || spacing < 0) return null;
    const placement = placements[index], candidates = [];
    let checks = 0, visits = 0;
    outer: for (const edge of context.edges) {
      const [a, b] = transform(edge, placement), v = subtract(b, a), len = Math.hypot(...v);
      const reach = distanceLimit + spacing;
      for (const target of context.targets) {
        if (++visits > 100000) break outer;
        if (target.minX > Math.max(a[0], b[0]) + reach) break;
        if (target.maxX < Math.min(a[0], b[0]) - reach
            || target.minY > Math.max(a[1], b[1]) + reach || target.maxY < Math.min(a[1], b[1]) - reach) continue;
        if (++checks > 20000) break outer;
        const tv = subtract(target.b, target.a), targetLength = Math.hypot(...tv);
        const tangent = tv.map(value => value / targetLength), normal = [-tangent[1], tangent[0]];
        let degrees = (Math.atan2(tv[1], tv[0]) - Math.atan2(v[1], v[0])) * 180 / Math.PI;
        degrees = ((degrees + 270) % 180 + 180) % 180 - 90;
        if (Math.abs(degrees) > angleLimit) continue;
        const midpoint = a.map((value, axis) => (value + b[axis]) / 2);
        const gap = dot(subtract(midpoint, target.a), normal);
        if (Math.abs(Math.abs(gap) - spacing) > distanceLimit) continue;
        const localMidpoint = edge[0].map((value, axis) => (value + edge[1][axis]) / 2);
        const rotation = ((Number(placement.transformation.rotation) + degrees) % 360 + 360) % 360;
        const rotatedMidpoint = transform([localMidpoint], { transformation: { rotation, translation: [0, 0] } })[0];
        for (const side of spacing > EPS ? [1, -1] : [0]) {
          const translation = midpoint.map((value, axis) => value - rotatedMidpoint[axis] + normal[axis] * (side * spacing - gap));
          const snapped = { ...placement, transformation: { ...placement.transformation, rotation, translation } };
          const [sa, sb] = transform(edge, snapped);
          const displacement = Math.max(distance(a, sa), distance(b, sb));
          if (displacement > distanceLimit) continue;
          const pa = dot(subtract(sa, target.a), tangent), pb = dot(subtract(sb, target.a), tangent);
          const overlap = Math.min(targetLength, Math.max(pa, pb)) - Math.max(0, Math.min(pa, pb));
          if (overlap < Math.min(len, targetLength) * 0.05 || overlap <= EPS) continue;
          candidates.push({ edit: { ...edit, rotation, translation }, placement: snapped,
            localEdge: edge, normal, targetIndex: target.placementIndex,
            target: [target.a, target.b], edge: [sa, sb],
            score: displacement / distanceLimit + Math.abs(degrees) / angleLimit * 0.15 - overlap / Math.min(len, targetLength) * 0.05 });
          // Bound both memory and the expensive geometry validations per update.
          if (candidates.length > 24) { candidates.sort((a, b) => a.score - b.score); candidates.length = 12; }
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    const corners = [];
    const nearby = candidates.slice(0, 24);
    const originalPoints = transform(outline(items[placement.item_id]), placement);
    for (let i = 0; i < nearby.length; i++) {
      for (let j = i + 1; j < nearby.length; j++) {
        const first = nearby[i], second = nearby[j];
        // Both contacts may be on the same neighbour (a part seated in its
        // notch or inside corner), as long as they are different edges.
        if (first.localEdge === second.localEdge
            || (first.target[0] === second.target[0] && first.target[1] === second.target[1])) continue;
        // Polygonised DXF corners are rarely exactly square; a hundredth of a
        // degree still reads as flush on both sides.
        const angleDifference = ((first.edit.rotation - second.edit.rotation + 540) % 360) - 180;
        if (Math.abs(angleDifference) > CORNER_ANGLE_TOLERANCE) continue;
        const [nx, ny] = first.normal, [mx, my] = second.normal;
        const determinant = nx * my - ny * mx;
        if (Math.abs(determinant) < 0.01) continue;
        // Solve both line-offset constraints together. Sliding to the second
        // contact must not break the first, including at non-right-angle corners.
        const c = dot(first.normal, first.edit.translation);
        const d = dot(second.normal, second.edit.translation);
        const translation = [(c * my - ny * d) / determinant, (nx * d - c * mx) / determinant];
        const snapped = { ...placement, transformation: { ...placement.transformation,
          rotation: first.edit.rotation, translation } };
        const points = transform(outline(items[placement.item_id]), snapped);
        const displacement = points.reduce((max, p, k) => Math.max(max, distance(p, originalPoints[k])), 0);
        if (displacement > distanceLimit) continue;
        const contacts = [first, second].map(candidate => ({ target: candidate.target,
          edge: transform(candidate.localEdge, snapped) }));
        if (!contacts.every(({ target: [a, b], edge: [sa, sb] }) => {
          const length = distance(a, b), edgeLength = distance(sa, sb);
          const tangent = subtract(b, a).map(value => value / length);
          const pa = dot(subtract(sa, a), tangent), pb = dot(subtract(sb, a), tangent);
          const overlap = Math.min(length, Math.max(pa, pb)) - Math.max(0, Math.min(pa, pb));
          return overlap > EPS && overlap >= Math.min(length, edgeLength) * 0.05;
        })) continue;
        corners.push({ edit: { ...edit, rotation: first.edit.rotation, translation }, placement: snapped,
          ...contacts[0], contacts, score: displacement / distanceLimit + (first.score + second.score) * 0.05 });
      }
    }
    corners.sort((a, b) => a.score - b.score);
    // Prefer two real contacts, but fall back to a single edge if the corner
    // would collide or violate spacing/margins. Geometry checks stay bounded.
    for (const candidate of [...corners.slice(0, 12), ...candidates.slice(0, 12)]) {
      const proposed = placements.slice(); proposed[index] = candidate.placement;
      if (!validateMove(proposed, index, items, frame, spacing)) return candidate;
    }
    return null;
  }

  function stats(placements, items, frame) {
    const area = placements.reduce((sum, placement) => {
      const pts = outline(items[placement.item_id]);
      return sum + Math.abs(pts.reduce((a, p, i) => {
        const q = pts[(i + 1) % pts.length];
        return a + p[0] * q[1] - q[0] * p[1];
      }, 0)) / 2;
    }, 0);
    const usableArea = (frame.width - 2 * frame.margin) * (frame.height - 2 * frame.margin);
    return { item_count: placements.length, density: usableArea > 0 ? area / usableArea : 0 };
  }

  const api = { readPlacements, editsFor, applyEdits, transform, outline, rotationCenter, rotateEdit, validateMove, validateEdits,
    prepareEdgeSnap, findEdgeSnap, stats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NestPlacementEditor = api;
})(typeof window !== 'undefined' ? window : globalThis);
