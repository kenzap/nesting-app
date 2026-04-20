(function attachNestDxfRasterEnvelopeService(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const { debugDXF } = global.NestDxfShapeDetectionService || { debugDXF: () => {} };

  if (!geometry) {
    global.NestDxfRasterEnvelopeService = {
      detectRasterShapes() { return []; },
      buildRasterEnvelopes() { return []; },
    };
    return;
  }

  const {
    EPS,
    unionBBox,
    entityBBox,
    closePointRing,
    getLineEndpoints,
    polylineVerticesToPoints,
    ellipseToPoints,
    splineToPoints,
    circleToPoints,
    safeSamplePoint,
    samePoint,
    polygonSignedArea,
  } = geometry;

  function isRenderableEntity(entity) {
    return !!entity?.type && !['HATCH', 'TEXT', 'MTEXT', 'DIMENSION', 'INSERT', 'POINT'].includes(entity.type);
  }

  function sampleArcPoints(entity) {
    if (!entity?.center || !Number.isFinite(entity.radius)) return [];
    const start = Number.isFinite(entity.startAngle) ? entity.startAngle : 0;
    let end = Number.isFinite(entity.endAngle) ? entity.endAngle : start;
    while (end <= start) end += Math.PI * 2;
    const span = end - start;
    const steps = Math.max(16, Math.ceil(span / (Math.PI / 24)));
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angle = start + span * t;
      points.push({
        x: entity.center.x + entity.radius * Math.cos(angle),
        y: entity.center.y + entity.radius * Math.sin(angle),
      });
    }
    return points;
  }

  function entityToPoints(entity) {
    if (!entity?.type) return [];
    switch (entity.type) {
      case 'LINE': {
        const endpoints = getLineEndpoints(entity);
        return endpoints ? [endpoints.start, endpoints.end] : [];
      }
      case 'ARC':
        return sampleArcPoints(entity);
      case 'CIRCLE':
        return circleToPoints(entity);
      case 'LWPOLYLINE':
      case 'POLYLINE':
        return Array.isArray(entity.vertices)
          ? polylineVerticesToPoints(entity.vertices, entity.closed !== false)
          : [];
      case 'ELLIPSE':
        return ellipseToPoints(entity, false);
      case 'SPLINE':
        return splineToPoints(entity);
      default:
        return [];
    }
  }

  function densifyPoints(points, step) {
    if (!Array.isArray(points) || points.length < 2) return points || [];
    const out = [{ x: points[0].x, y: points[0].y }];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len <= EPS) continue;
      const segments = Math.max(1, Math.ceil(len / Math.max(step, EPS)));
      for (let s = 1; s <= segments; s++) {
        const t = s / segments;
        out.push({ x: a.x + dx * t, y: a.y + dy * t });
      }
    }
    return out;
  }

  function buildBounds(entities) {
    let bbox = null;
    entities.forEach(entity => { bbox = unionBBox(bbox, entityBBox(entity)); });
    return bbox;
  }

  function buildGrid(bounds, cellSize, paddingCells) {
    const padding = cellSize * paddingCells;
    const minX = bounds.minX - padding;
    const minY = bounds.minY - padding;
    const maxX = bounds.maxX + padding;
    const maxY = bounds.maxY + padding;
    const width = Math.max(1, Math.ceil((maxX - minX) / cellSize));
    const height = Math.max(1, Math.ceil((maxY - minY) / cellSize));
    return {
      minX,
      minY,
      maxX,
      maxY,
      width,
      height,
      cellSize,
      cells: new Uint8Array(width * height),
    };
  }

  function cellIndex(grid, x, y) {
    return y * grid.width + x;
  }

  function clampCell(grid, x, y) {
    return {
      x: Math.max(0, Math.min(grid.width - 1, x)),
      y: Math.max(0, Math.min(grid.height - 1, y)),
    };
  }

  function pointToCell(grid, point) {
    const x = Math.floor((point.x - grid.minX) / grid.cellSize);
    const y = Math.floor((point.y - grid.minY) / grid.cellSize);
    return clampCell(grid, x, y);
  }

  function markDisc(grid, cx, cy, radiusCells) {
    const r2 = radiusCells * radiusCells;
    for (let dy = -radiusCells; dy <= radiusCells; dy++) {
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        if ((dx * dx) + (dy * dy) > r2) continue;
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || py < 0 || px >= grid.width || py >= grid.height) continue;
        grid.cells[cellIndex(grid, px, py)] = 1;
      }
    }
  }

  function rasterizeEntities(grid, entities, options) {
    const strokeRadiusCells = Math.max(1, Math.round((options.strokeRadius || (grid.cellSize * 1.2)) / grid.cellSize));
    const sampleStep = options.sampleStep || Math.max(grid.cellSize * 0.5, 0.5);

    entities.forEach(entity => {
      const densePoints = densifyPoints(entityToPoints(entity), sampleStep);
      densePoints.forEach(point => {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
        const cell = pointToCell(grid, point);
        markDisc(grid, cell.x, cell.y, strokeRadiusCells);
      });
    });
  }

  function labelRegions(grid) {
    const labels = new Int32Array(grid.width * grid.height);
    const regions = [];
    let nextLabel = 1;

    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const idx = cellIndex(grid, x, y);
        if (!grid.cells[idx] || labels[idx]) continue;

        const queue = [[x, y]];
        labels[idx] = nextLabel;
        const cells = [];
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;

        while (queue.length) {
          const [cx, cy] = queue.pop();
          cells.push([cx, cy]);
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          const neighbors = [
            [cx + 1, cy],
            [cx - 1, cy],
            [cx, cy + 1],
            [cx, cy - 1],
            [cx + 1, cy + 1],
            [cx - 1, cy - 1],
            [cx + 1, cy - 1],
            [cx - 1, cy + 1],
          ];

          neighbors.forEach(([nx, ny]) => {
            if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) return;
            const nIdx = cellIndex(grid, nx, ny);
            if (!grid.cells[nIdx] || labels[nIdx]) return;
            labels[nIdx] = nextLabel;
            queue.push([nx, ny]);
          });
        }

        regions.push({
          id: `re_${nextLabel - 1}`,
          label: nextLabel,
          cells,
          bboxCells: { minX, maxX, minY, maxY },
        });
        nextLabel += 1;
      }
    }

    return { labels, regions };
  }

  function edgeKey(a, b) {
    return `${a.x},${a.y}|${b.x},${b.y}`;
  }

  function traceRegionPolygon(grid, region) {
    const regionCellSet = new Set(region.cells.map(([x, y]) => `${x},${y}`));
    const edges = new Map();

    function addEdge(a, b) {
      const forward = edgeKey(a, b);
      const reverse = edgeKey(b, a);
      if (edges.has(reverse)) {
        edges.delete(reverse);
      } else {
        edges.set(forward, { a, b });
      }
    }

    region.cells.forEach(([x, y]) => {
      const left = `${x - 1},${y}`;
      const right = `${x + 1},${y}`;
      const top = `${x},${y - 1}`;
      const bottom = `${x},${y + 1}`;

      const x0 = grid.minX + x * grid.cellSize;
      const y0 = grid.minY + y * grid.cellSize;
      const x1 = x0 + grid.cellSize;
      const y1 = y0 + grid.cellSize;

      if (!regionCellSet.has(top)) addEdge({ x: x0, y: y0 }, { x: x1, y: y0 });
      if (!regionCellSet.has(right)) addEdge({ x: x1, y: y0 }, { x: x1, y: y1 });
      if (!regionCellSet.has(bottom)) addEdge({ x: x1, y: y1 }, { x: x0, y: y1 });
      if (!regionCellSet.has(left)) addEdge({ x: x0, y: y1 }, { x: x0, y: y0 });
    });

    if (!edges.size) return [];

    const adjacency = new Map();
    edges.forEach(({ a, b }) => {
      const aKey = `${a.x},${a.y}`;
      const bKey = `${b.x},${b.y}`;
      if (!adjacency.has(aKey)) adjacency.set(aKey, []);
      if (!adjacency.has(bKey)) adjacency.set(bKey, []);
      adjacency.get(aKey).push({ from: a, to: b });
      adjacency.get(bKey).push({ from: b, to: a });
    });

    let startKey = null;
    adjacency.forEach((_, key) => {
      if (!startKey || key < startKey) startKey = key;
    });
    if (!startKey) return [];

    const start = adjacency.get(startKey)?.[0]?.from;
    if (!start) return [];

    const polygon = [start];
    let currentKey = startKey;
    let prevDir = { x: 1, y: 0 };
    let safety = 0;

    while (safety++ < edges.size + 10) {
      const options = adjacency.get(currentKey) || [];
      if (!options.length) break;

      options.sort((lhs, rhs) => {
        const lv = { x: lhs.to.x - lhs.from.x, y: lhs.to.y - lhs.from.y };
        const rv = { x: rhs.to.x - rhs.from.x, y: rhs.to.y - rhs.from.y };
        const la = Math.atan2(lv.y, lv.x) - Math.atan2(prevDir.y, prevDir.x);
        const ra = Math.atan2(rv.y, rv.x) - Math.atan2(prevDir.y, prevDir.x);
        const ln = (la + Math.PI * 4) % (Math.PI * 2);
        const rn = (ra + Math.PI * 4) % (Math.PI * 2);
        return ln - rn;
      });

      const next = options[0];
      polygon.push(next.to);
      prevDir = { x: next.to.x - next.from.x, y: next.to.y - next.from.y };
      currentKey = `${next.to.x},${next.to.y}`;
      if (samePoint(next.to, start, grid.cellSize * 0.25)) break;
    }

    return closePointRing(polygon);
  }

  function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  function convexHull(points) {
    const unique = [];
    const seen = new Set();
    points.forEach(point => {
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
      const key = `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
      if (seen.has(key)) return;
      seen.add(key);
      unique.push({ x: point.x, y: point.y });
    });
    if (unique.length < 3) return closePointRing(unique);

    unique.sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const lower = [];
    unique.forEach(point => {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
      lower.push(point);
    });
    const upper = [];
    for (let i = unique.length - 1; i >= 0; i--) {
      const point = unique[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
      upper.push(point);
    }
    upper.pop();
    lower.pop();
    const hull = lower.concat(upper);
    if (hull.length < 3) return closePointRing(unique.slice(0, 3));
    if (polygonSignedArea(hull) < 0) hull.reverse();
    return closePointRing(hull);
  }

  function regionCellCenters(grid, region) {
    return region.cells.map(([x, y]) => ({
      x: grid.minX + (x + 0.5) * grid.cellSize,
      y: grid.minY + (y + 0.5) * grid.cellSize,
    }));
  }

  function simplifyRegionBoundary(points, tolerance) {
    const ring = closePointRing(points || []);
    if (ring.length < 4) return ring;
    const core = ring.slice(0, -1);
    const simplified = [];

    core.forEach(point => {
      if (!simplified.length || !samePoint(simplified[simplified.length - 1], point, tolerance * 0.25)) {
        simplified.push(point);
      }
    });

    let changed = true;
    while (changed && simplified.length >= 3) {
      changed = false;
      for (let i = 0; i < simplified.length; i++) {
        const prev = simplified[(i - 1 + simplified.length) % simplified.length];
        const curr = simplified[i];
        const next = simplified[(i + 1) % simplified.length];
        const area2 = Math.abs((curr.x - prev.x) * (next.y - prev.y) - (curr.y - prev.y) * (next.x - prev.x));
        if (area2 <= tolerance * tolerance * 0.5) {
          simplified.splice(i, 1);
          changed = true;
          break;
        }
      }
    }

    return closePointRing(simplified);
  }

  function assignEntitiesToRegions(grid, labels, regions, entities) {
    const regionMap = new Map(regions.map(region => [region.label, { ...region, entities: [] }]));
    entities.forEach(entity => {
      const probe = safeSamplePoint(entity);
      const bbox = entityBBox(entity);
      const candidates = [];

      if (probe) {
        const cell = pointToCell(grid, probe);
        const label = labels[cellIndex(grid, cell.x, cell.y)];
        if (label) candidates.push(label);
      }

      if (!candidates.length && bbox) {
        const minCell = pointToCell(grid, { x: bbox.minX, y: bbox.minY });
        const maxCell = pointToCell(grid, { x: bbox.maxX, y: bbox.maxY });
        for (let y = minCell.y; y <= maxCell.y; y++) {
          for (let x = minCell.x; x <= maxCell.x; x++) {
            const label = labels[cellIndex(grid, x, y)];
            if (label && !candidates.includes(label)) candidates.push(label);
          }
        }
      }

      const chosen = candidates[0];
      if (chosen && regionMap.has(chosen)) {
        regionMap.get(chosen).entities.push(entity);
      }
    });

    return [...regionMap.values()].filter(region => region.entities.length);
  }

  function buildRasterEnvelopes(entities, options = {}) {
    const renderableEntities = (entities || []).filter(isRenderableEntity);
    if (!renderableEntities.length) return [];

    const bounds = buildBounds(renderableEntities);
    if (!bounds) return [];

    const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
    const cellSize = options.cellSize || Math.max(1, extent / 240);
    const paddingCells = options.paddingCells ?? 2;
    const grid = buildGrid(bounds, cellSize, paddingCells);
    rasterizeEntities(grid, renderableEntities, {
      strokeRadius: options.strokeRadius || cellSize * 1.2,
      sampleStep: options.sampleStep || cellSize * 0.6,
    });

    const { labels, regions } = labelRegions(grid);
    const assignedRegions = assignEntitiesToRegions(grid, labels, regions, renderableEntities)
      .map((region, index) => {
        const tracedBoundary = traceRegionPolygon(grid, region);
        const polygonPoints = options.boundaryMode === 'trace'
          ? (tracedBoundary.length >= 4
              ? simplifyRegionBoundary(tracedBoundary, grid.cellSize)
              : convexHull(regionCellCenters(grid, region)))
          : convexHull(regionCellCenters(grid, region));
        let bbox = null;
        region.entities.forEach(entity => { bbox = unionBBox(bbox, entityBBox(entity)); });
        return {
          id: `raster_${index}`,
          entities: region.entities,
          polygonPoints,
          bbox,
          layer: region.entities[0]?.layer || '0',
          cellCount: region.cells.length,
        };
      });

    debugDXF('Raster envelope result', {
      entityCount: renderableEntities.length,
      regionCount: assignedRegions.length,
      cellSize,
      shapes: assignedRegions.map(region => ({
        id: region.id,
        entityCount: region.entities.length,
        polygonPointCount: region.polygonPoints.length,
        layer: region.layer,
      })),
    });

    return assignedRegions;
  }

  function detectRasterShapes(entities, options = {}) {
    return buildRasterEnvelopes(entities, options).map((region, index) => ({
      id: `rshape_${index}`,
      layer: region.layer,
      entities: region.entities,
      polygonPoints: region.polygonPoints,
      bbox: region.bbox,
      source: 'raster-envelope',
    }));
  }

  global.NestDxfRasterEnvelopeService = {
    buildRasterEnvelopes,
    detectRasterShapes,
  };
})(window);
