'use strict';

(function definePlacementEditor(root) {
  const Flatten = typeof module !== 'undefined' && module.exports
    ? require('@flatten-js/core') : (root.Flatten || root['@flatten-js/core']);
  const cutouts = typeof module !== 'undefined' && module.exports
    ? require('./cutout-packages') : root.NestCutoutPackages;
  const EPS = 1e-6;
  const CORNER_ANGLE_TOLERANCE = 0.01;
  const EDIT_VERSION = 2;
  const clone = value => JSON.parse(JSON.stringify(value));

  // Expand solver packages without changing the optimizer input. Stable item
  // IDs and copy indices are rebuilt identically in the renderer and exporter.
  function editableLayout(original, items, manualEdits, version) {
    const ids = Object.keys(items).map(Number).sort((a, b) => a - b);
    if (ids.some(id => !Number.isSafeInteger(id) || id < 0)) throw new Error('Invalid part identity.');
    let nextId = (ids.at(-1) ?? -1) + 1;
    const editableItems = {}, components = new Map();
    for (const id of ids) {
      const item = items[id];
      components.set(id, cutouts.components(item).map((component, index) => {
        const itemId = index === 0 ? id : nextId++;
        if (!Number.isSafeInteger(itemId)) throw new Error('Invalid part identity.');
        const metadata = { ...component.export };
        delete metadata.cutout_children;
        editableItems[itemId] = { ...component.item, id: itemId, export: metadata };
        return { itemId, transformation: component.transformation };
      }));
    }
    const expand = placement => {
      const parts = components.get(Number(placement.item_id));
      if (!parts) throw new Error('Part geometry is unavailable.');
      return parts.map((part, index) => ({ ...placement, item_id: part.itemId,
        transformation: index === 0 ? clone(placement.transformation)
          : cutouts.compose(placement.transformation, part.transformation) }));
    };
    const offsets = [], placements = [];
    original.forEach(placement => { offsets.push(placements.length); placements.push(...expand(placement)); });
    let edits = editsFor(placements);
    if (manualEdits !== undefined) {
      if (version === EDIT_VERSION) {
        edits = editsFor(applyEdits(placements, manualEdits)).map((edit, index) => ({
          ...edit, sourceIndex: manualEdits[index].sourceIndex,
        }));
      } else if (version === undefined || version === 1) {
        edits = applyEdits(original, manualEdits).flatMap((placement, index) =>
          editsFor(expand(placement)).map(edit => ({ ...edit,
            sourceIndex: offsets[manualEdits[index].sourceIndex] + edit.sourceIndex })));
      } else throw new Error('Unsupported placement edit version.');
    }
    return { original: placements, items: editableItems, edits,
      exportItems: Object.fromEntries(Object.entries(editableItems).map(([id, item]) => [id, item.export])) };
  }

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
    // Boolean operations require consistent solid-ring winding. DXF outer,
    // cutout, and child contours can each arrive in either direction.
    if ([...result.faces][0].orientation() === Flatten.ORIENTATION.CW) result.reverse();
    return result;
  }

  const materialCache = new WeakMap();
  function materialPolygon(item, placement) {
    const points = outline(item);
    // Only proven empty cutouts are free space, not engraving/bend contours.
    // Legacy package edits keep their solid envelope until explicitly expanded.
    const holes = item.export?.cutout_children?.length ? undefined : item.export?.cutout_holes;
    let cached = materialCache.get(item);
    if (!cached || cached.points !== points || cached.holes !== holes) {
      const outer = polygon(points);
      let material = outer;
      for (const ring of holes || []) {
        const hole = polygon(ring);
        if (hole.area() >= outer.area() || Flatten.BooleanOperations.subtract(hole, outer).area() > EPS) {
          throw new Error('Invalid cutout geometry.');
        }
        material = Flatten.BooleanOperations.subtract(material, hole);
      }
      cached = { points, holes, material };
      materialCache.set(item, cached);
    }
    const rotation = Number(placement.transformation.rotation);
    const [tx, ty] = placement.transformation.translation;
    if (cached.world && cached.rotation === rotation && cached.tx === tx && cached.ty === ty) return cached.world;
    const angle = rotation * Math.PI / 180;
    const world = cached.material.transform(new Flatten.Matrix(Math.cos(angle), Math.sin(angle),
      -Math.sin(angle), Math.cos(angle), tx, ty));
    // Keep only the last transform per type: stationary neighbours are reused
    // throughout a contact search without accumulating every trial position.
    Object.assign(cached, { rotation, tx, ty, world });
    return world;
  }

  // Test interiors directly instead of constructing a boolean intersection.
  // Boolean clipping repeatedly splits/relinks dense contours near contact;
  // the editor only needs to know whether any material would overlap.
  function boundaryEntersMaterial(source, target) {
    const targetBox = target.box;
    for (const edge of source.edges) {
      const segment = edge.shape, { start, end } = segment;
      const dx = end.x - start.x, dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length <= EPS) continue;
      const box = segment.box;
      if (box.xmin > targetBox.xmax + EPS || box.xmax < targetBox.xmin - EPS
          || box.ymin > targetBox.ymax + EPS || box.ymax < targetBox.ymin - EPS) continue;
      const cuts = [0, 1];
      const nearby = target.edges.search(new Flatten.Box(box.xmin - EPS, box.ymin - EPS,
        box.xmax + EPS, box.ymax + EPS));
      for (const other of nearby) {
        const hits = segment.intersect(other.shape);
        // Normalized rings keep material on the left, including hole walls.
        // Coincident edges with opposite directions are valid shared cuts;
        // the same direction means material on the same side (an overlap).
        if (hits.length > 1 && hits[0].distanceTo(hits[1])[0] > EPS
            && dx * (other.end.x - other.start.x) + dy * (other.end.y - other.start.y) > 0) return true;
        for (const point of hits) cuts.push(Math.max(0, Math.min(1,
          ((point.x - start.x) * dx + (point.y - start.y) * dy) / (length * length))));
      }
      cuts.sort((a, b) => a - b);
      // Split at every crossing so narrow overlaps and concave notches cannot
      // be missed by checking only vertices or a whole edge's midpoint.
      for (let i = 1; i < cuts.length; i++) {
        if ((cuts[i] - cuts[i - 1]) * length <= EPS) continue;
        const t = (cuts[i] + cuts[i - 1]) / 2;
        if (Flatten.ray_shoot(target, new Flatten.Point(start.x + dx * t, start.y + dy * t)) === Flatten.INSIDE) return true;
      }
    }
    return false;
  }

  function materialOverlaps(first, second) {
    if (first.edges.size > second.edges.size) [first, second] = [second, first];
    return boundaryEntersMaterial(first, second) || boundaryEntersMaterial(second, first);
  }

  // Check only the moved copy. An existing solver result is never silently
  // rearranged or rejected just because another pair uses a different tolerance.
  function validateMove(placements, index, items, frame, spacing = 0) {
    try {
      if (![frame.width, frame.height, frame.margin, spacing].every(Number.isFinite)
          || frame.margin < 0 || spacing < 0 || frame.width <= frame.margin * 2 || frame.height <= frame.margin * 2
          || !Number.isFinite(Number(placements[index]?.transformation?.rotation))) return 'geometry';
      const item = items[placements[index].item_id];
      if (item.export?.cutout_children?.length && !cutouts.allows(item.allowed_orientations,
        Number(placements[index].transformation.rotation))) return 'geometry';
      const points = transform(outline(item), placements[index]);
      if (points.some(([x, y]) => x < -EPS || y < -EPS
          || x > frame.width - 2 * frame.margin + EPS || y > frame.height - 2 * frame.margin + EPS)) return 'bounds';
      const moved = materialPolygon(item, placements[index]);
      for (let i = 0; i < placements.length; i++) {
        if (i === index) continue;
        const otherPoints = transform(outline(items[placements[i].item_id]), placements[i]);
        const xs = otherPoints.map(p => p[0]), ys = otherPoints.map(p => p[1]);
        const box = moved.box;
        if (Math.min(...xs) > box.xmax + spacing || Math.max(...xs) < box.xmin - spacing
            || Math.min(...ys) > box.ymax + spacing || Math.max(...ys) < box.ymin - spacing) continue;
        const other = materialPolygon(items[placements[i].item_id], placements[i]);
        if (materialOverlaps(moved, other)) return 'collision';
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
    const rings = [outline(item), ...(item.export?.cutout_holes || [])], segments = item.shared_edge_segments;
    // Snapping is optional assistance; very dense contours still move freely.
    if (rings.reduce((sum, ring) => sum + ring.length, 0) > 4096 || (segments?.length || 0) > 8192) return [];
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
    return rings.flatMap(points => points.map((a, i) => [a, points[(i + 1) % points.length]]))
      .filter(([a, b]) => distance(a, b) > EPS && (!Array.isArray(segments)
        || segments.some(s => s.length === 4 && s.every(Number.isFinite)
          && onSegment(a, s.slice(0, 2), s.slice(2)) && onSegment(b, s.slice(0, 2), s.slice(2)))));
  }

  // Build once per drag. Outer contours and approved cutout boundaries must
  // match original straight DXF segments; curve chords remain ineligible.
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
    const hasPackages = Object.values(items).some(item => item.export?.cutout_children?.length);
    const area = placements.reduce((sum, placement) => sum + cutouts.materialArea(items[placement.item_id]), 0);
    const usableArea = (frame.width - 2 * frame.margin) * (frame.height - 2 * frame.margin);
    const itemCount = hasPackages ? placements.reduce((sum, p) => sum + cutouts.count(items[p.item_id].export), 0) : placements.length;
    return { item_count: itemCount, density: usableArea > 0 ? area / usableArea : 0 };
  }

  const api = { EDIT_VERSION, editableLayout, readPlacements, editsFor, applyEdits, transform, outline, rotationCenter, rotateEdit, validateMove, validateEdits,
    prepareEdgeSnap, findEdgeSnap, stats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NestPlacementEditor = api;
})(typeof window !== 'undefined' ? window : globalThis);
