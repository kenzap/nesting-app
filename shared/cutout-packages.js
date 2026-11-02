'use strict';

(function defineCutoutPackages(root) {
  const identity = () => ({ rotation: 0, translation: [0, 0] });
  const area = ring => Math.abs(ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0)) / 2;
  const angle = value => ((value % 360) + 360) % 360;
  const allows = (angles, value) => angles?.some(a => Math.abs(((angle(a) - angle(value) + 540) % 360) - 180) < 0.001);
  const transform = (ring, t) => {
    const r = t.rotation * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return ring.map(([x, y]) => [x * c - y * s + t.translation[0], x * s + y * c + t.translation[1]]);
  };
  function compose(outer, inner) {
    return { rotation: angle(outer.rotation + inner.rotation), translation: transform([inner.translation], outer)[0] };
  }
  const box = ring => ring.reduce((b, [x, y]) =>
    [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  const usable = ring => Array.isArray(ring) && ring.length >= 3 && ring.length <= 1024
    && ring.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) && area(ring) > 0.001;

  // These are rejection tests only. A successful bbox test is not a fit proof.
  function candidateJobs(items, exports, spacing) {
    const jobs = [];
    // Preparation is optional: bound both useful work and rejection-only work.
    // Excessively complex drawings still use the ordinary solver unchanged.
    let vertexBudget = 8192, holesChecked = 0;
    const candidatesById = new Map();
    for (const item of items.slice(0, 512)) {
      const ring = item.shape.data;
      if (!usable(ring) || ring.length > vertexBudget || !item.allowed_orientations?.length
          || item.allowed_orientations.length > 72) continue;
      vertexBudget -= ring.length;
      candidatesById.set(item.id, { item, area: area(ring), boxes: null });
    }
    const descriptors = [...candidatesById.values()].sort((a, b) => b.area - a.area);
    const hosts = descriptors.filter(d => exports[d.item.id]?.holes?.length).slice(0, 32).map(d => d.item);
    for (const host of hosts) {
      for (const hole of exports[host.id].holes) {
        if (++holesChecked > 64) return jobs;
        if (!usable(hole)) continue;
        const hb = box(hole), ha = area(hole);
        const candidates = [];
        for (const d of descriptors) {
          if (d.item.id === host.id || d.area >= ha) continue;
          if (!d.boxes) d.boxes = d.item.allowed_orientations.map(rotation => box(transform(d.item.shape.data, { rotation, translation: [0, 0] })));
          if (d.boxes.some(b => b[2] - b[0] + 2 * spacing <= hb[2] - hb[0]
              && b[3] - b[1] + 2 * spacing <= hb[3] - hb[1])) candidates.push(d.item);
          if (candidates.length >= 32) break;
        }
        if (!candidates.length) continue;
        const otherHoles = exports[host.id].holes.filter(other => other !== hole);
        if (otherHoles.reduce((sum, h) => sum + h.length, 0) > 4096) continue;
        const request = { hole, parent: host.shape.data, other_holes: otherHoles, items: candidates.map(item => ({
          id: item.id, demand: Math.min(item.demand, 64), shape: item.shape,
          allowed_orientations: item.allowed_orientations,
        })), spacing, budget_ms: 500 };
        // Exact keys intentionally include coordinates, rotations, spacing and demands.
        jobs.push({ hostId: host.id, key: JSON.stringify(request), request });
        if (jobs.length >= 32) return jobs;
      }
    }
    return jobs;
  }

  function packageItems(items, exports, jobs, ready) {
    if (items.some(item => !Number.isSafeInteger(item.demand) || item.demand <= 0)) return { items, exports };
    const remaining = new Map(items.map(item => [item.id, item.demand]));
    const byId = new Map(items.map(item => [item.id, item]));
    const output = [], outputExports = {};
    const add = (item, metadata, demand) => {
      if (!demand) return;
      const id = output.length;
      output.push({ ...item, id, demand });
      outputExports[id] = metadata;
    };
    for (const host of items.filter(item => jobs.some(job => job.hostId === item.id))
      .sort((a, b) => area(b.shape.data) - area(a.shape.data))) {
      const patterns = jobs.filter(job => job.hostId === host.id)
        .flatMap(job => ready.get(job.key)?.placements || []);
      while (remaining.get(host.id) > 0 && patterns.length) {
        const counts = new Map([[host.id, 1]]), children = [];
        let rotations = [...host.allowed_orientations];
        for (const placement of patterns) {
          const child = byId.get(placement.item_id);
          if (!child || child.id === host.id || (remaining.get(child.id) || 0) <= (counts.get(child.id) || 0)) continue;
          const allowed = rotations.filter(r => allows(child.allowed_orientations, r + placement.transformation.rotation));
          if (!allowed.length) continue;
          rotations = allowed;
          counts.set(child.id, (counts.get(child.id) || 0) + 1);
          children.push({ item: child, export: exports[child.id], transformation: placement.transformation });
        }
        if (!children.length) break;
        // Reuse a pattern for as many copies as inventory allows, without a per-copy loop.
        const copies = Math.min(...[...counts].map(([id, count]) => Math.floor(remaining.get(id) / count)));
        counts.forEach((count, id) => remaining.set(id, remaining.get(id) - count * copies));
        add({ ...host, allowed_orientations: rotations }, { ...exports[host.id], cutout_children: children }, copies);
      }
    }
    items.forEach(item => add(item, exports[item.id], remaining.get(item.id)));
    return { items: output, exports: outputExports };
  }

  function components(item, metadata = item?.export) {
    return [{ item, export: metadata, transformation: identity() }, ...(metadata?.cutout_children || [])];
  }
  function expandPlacements(placements, items, exports) {
    return placements.flatMap(placement => !exports[placement.item_id]?.cutout_children?.length
      ? [{ placement, item: { ...items[placement.item_id], export: exports[placement.item_id] } }]
      : components(items[placement.item_id], exports[placement.item_id]).map(component => ({
      item: { ...component.item, export: component.export },
      placement: { ...placement, transformation: compose(placement.transformation, component.transformation) },
    })));
  }
  function rings(item, metadata = item?.export) {
    return components(item, metadata).flatMap(component => [component.export?.polygon || component.item.shape.data,
      ...(component.export?.holes || [])].map(ring => transform(ring, component.transformation)));
  }
  const path = rings => rings.map(ring => `M${ring.map(p => p.join(',')).join(' L')} Z`).join(' ');
  const count = metadata => 1 + (metadata?.cutout_children?.length || 0);
  function materialArea(item, metadata = item?.export) {
    return components(item, metadata).reduce((sum, c) => sum + area(c.export?.polygon || c.item.shape.data)
      - (c.export?.holes || []).reduce((s, h) => s + area(h), 0), 0);
  }
  function decorateSummary(summary, exports) {
    if (!summary || !Object.values(exports || {}).some(item => item.cutout_children?.length)) return summary;
    const geometryStats = new Map();
    return { ...summary, total_shared_edge_length_mm: null, strips: (summary.strips || []).map(strip => {
      if (!strip.svg) return strip;
      let itemCount = 0, envelopeArea = 0, netArea = 0;
      for (const match of strip.svg.matchAll(/<use\b[^>]*\bhref="#item_(\d+)"/g)) {
        const metadata = exports[match[1]];
        if (!metadata?.polygon) return strip;
        if (!geometryStats.has(metadata)) geometryStats.set(metadata, {
          count: count(metadata), envelope: area(metadata.polygon), net: materialArea(null, metadata),
        });
        const stats = geometryStats.get(metadata);
        itemCount += stats.count;
        envelopeArea += stats.envelope;
        netArea += stats.net;
      }
      return { ...strip, item_count: itemCount,
        density: envelopeArea > 0 ? strip.density * netArea / envelopeArea : strip.density,
        shared_edge_length_mm: null };
    }) };
  }
  const api = { candidateJobs, packageItems, compose, transform, components, expandPlacements, rings, path, count, materialArea, area, allows, decorateSummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NestCutoutPackages = api;
})(typeof window !== 'undefined' ? window : globalThis);
