(function attachNestDxfPreviewService(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  const svg = global.NestDxfSvg;
  const { createLayerResolver, FALLBACK_PALETTE } = global.NestDxfLayerService;
  const { groupByContour, contourEntityToPath, contourEntityToPoints, debugDXF } = global.NestDxfShapeDetectionService;
  const { serializeEntityForExport } = global.NestDxfExportMetadataService;
  const { clonePreviewData, applyPartLabelsToPreviewData } = global.NestDxfPreviewState;
  const { normalizeSettings } = global.NestSettings;

  const { f1, mkRng, hashStr } = svg;
  const { unionBBox, entityBBox, closePointRing } = geometry;

  function dedupeRenderedItems(items) {
    const seen = new Set();
    return (items || []).filter(item => {
      if (!item?.svg) return false;
      const key = `${item.layer || '0'}::${item.svg}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Reads the raw DXF text line-by-line to pull out fields that dxf-parser
  // doesn't expose (handle, ACI color, true color, extrusion vector).
  // Returns a Map keyed by entity handle so callers can look up metadata fast.
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
        const entity = { type: value.trim() };
        i += 2;
        while (i < lines.length - 1) {
          const groupCode = lines[i].trim();
          const groupValue = lines[i + 1];
          if (groupCode === '0') break;
          if (groupCode === '5') entity.handle = groupValue.trim();
          if (groupCode === '62') entity.aciColor = parseInt(groupValue, 10);
          if (groupCode === '420') entity.trueColor = parseInt(groupValue, 10);
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

  // When an entity's extrusion Z is negative it was drawn on a mirrored UCS.
  // Flips all X coordinates so the geometry appears the correct way round in
  // the preview instead of being mirrored horizontally.
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

  // Merges raw-text metadata (color, extrusion) back onto the parsed entity
  // objects by matching entity handles. Also triggers the mirroring fix for
  // any entity whose extrusion Z came back negative.
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
      if (Number.isFinite(info.aciColor)) entity.rawAciColor = info.aciColor;
      if (Number.isFinite(info.trueColor)) entity.rawTrueColor = info.trueColor;
      entity.extrusion = extrusion;
      if (Math.abs(extrusion.x) < 1e-6 && Math.abs(extrusion.y) < 1e-6 && extrusion.z < 0) {
        applyNegativeZExtrusionTransform(entity);
      }
      return entity;
    });
  }

  // Collapses the multi-group result into one sketch when multi-sketch
  // detection is disabled. We keep the largest contour as the nesting boundary
  // and treat every other group as supporting geometry within the same sketch.
  function mergeGroupsIntoSingleSketch(groups) {
    if (!groups.length) return groups;
    const primary = groups
      .slice()
      .sort((a, b) => ((b.outer?.area || 0) - (a.outer?.area || 0)))[0];
    if (!primary?.outer) return groups;

    const merged = {
      outer: primary.outer,
      contours: [...primary.contours],
      decorators: [...primary.decorators],
      bbox: primary.bbox,
      layer: primary.layer,
    };

    groups.forEach(group => {
      if (group === primary) return;
      merged.bbox = unionBBox(merged.bbox, group.bbox);
      group.contours.forEach(contour => {
        if (contour.id === group.outer?.id) {
          merged.contours.push({ ...contour, depth: 0, parentId: primary.outer.id });
        } else {
          merged.contours.push({ ...contour, depth: 0, parentId: contour.parentId || primary.outer.id });
        }
      });
      group.decorators.forEach(entity => merged.decorators.push(entity));
    });

    return [merged];
  }

  // Builds one preview shape from the entire DXF entity set. Used when
  // multi-sketch detection is off: we still need one reliable polygon for
  // nesting, but we should render all parsed geometry instead of only the
  // entities that contour grouping happened to attach to a sub-shape.
  function buildWholeSketchShape(entities, groups, layerTable, context) {
    if (!groups.length) return null;
    const primary = groups
      .slice()
      .sort((a, b) => ((b.outer?.area || 0) - (a.outer?.area || 0)))[0];
    const outer = primary?.outer;
    if (!outer) return null;

    const { layerColor, resolveEntityColor, layerOrder, layerMap } = context;
    const renderEntities = [];
    const seenEntities = new Set();
    const skippedRenderEntities = [];
    const addEntity = entity => {
      if (!entity || seenEntities.has(entity)) return;
      seenEntities.add(entity);
      renderEntities.push(entity);
    };

    entities.forEach(addEntity);

    let renderBBox = outer.bbox;
    groups.forEach(group => {
      renderBBox = unionBBox(renderBBox, group.bbox);
      group.contours.forEach(contour => { renderBBox = unionBBox(renderBBox, contour.bbox); });
    });
    renderEntities.forEach(entity => { renderBBox = unionBBox(renderBBox, entityBBox(entity)); });
    if (!renderBBox) return null;

    const { minX, maxY, maxX, minY } = renderBBox;
    const width = maxX - minX;
    const height = maxY - minY;
    if (width < 0.5 || height < 0.5) return null;

    const hasSyntheticOuter = outer.entity?.type === 'LINE_LOOP';
    const outerPath = contourEntityToPath(outer.entity, minX, maxY);
    if (!outerPath) return null;

    const outerSourceEntities = hasSyntheticOuter ? (outer.entity?.sourceEntities || []) : [outer.entity];
    const outerEntitySet = new Set(outerSourceEntities.filter(Boolean));

    const decorItems = [];
    renderEntities.forEach(entity => {
      if (!entity || ['HATCH', 'TEXT', 'MTEXT', 'DIMENSION', 'INSERT'].includes(entity.type)) return;
      if (outerEntitySet.has(entity)) return;
      const layerName = entity.layer || outer.layer || '0';
      const color = resolveEntityColor(entity, layerName);
      const svgStr = svg.entityToSVGStr(entity, minX, maxY, color);
      if (!svgStr) {
        skippedRenderEntities.push({
          type: entity.type || 'UNKNOWN',
          handle: entity.handle || null,
          layer: layerName,
        });
        return;
      }
      layerMap.set(layerName, layerColor(layerName));
      decorItems.push({
        type: 'entity',
        layer: layerName,
        color,
        svg: svgStr,
      });
    });

    const contourLayers = [...new Set(groups.flatMap(group => group.contours.map(contour => contour.layer || '0').filter(Boolean)))];
    const preferredOuterLayer = layerOrder.find(layerName => contourLayers.includes(layerName)) || contourLayers[0] || outer.layer || '0';
    layerMap.set(preferredOuterLayer, layerColor(preferredOuterLayer));

    const exportEntityMap = new Map();
    const addExportEntity = entity => {
      if (!entity) return;
      const key = entity.handle || JSON.stringify([
        entity.type, entity.layer,
        entity.start?.x, entity.start?.y,
        entity.end?.x, entity.end?.y,
        entity.center?.x, entity.center?.y,
        entity.radius, entity.startAngle, entity.endAngle,
        entity.vertices?.length,
      ]);
      if (!exportEntityMap.has(key)) {
        const serialized = serializeEntityForExport(entity, contourEntityToPoints);
        if (serialized) exportEntityMap.set(key, serialized);
      }
    };
    renderEntities.forEach(addExportEntity);

    const outerBoundaryItems = outerSourceEntities.map(entity => {
      const layerName = entity.layer || '0';
      const color = resolveEntityColor(entity, layerName);
      const svgStr = svg.entityToSVGStr(entity, minX, maxY, color);
      if (!svgStr) return null;
      return { layer: layerName, color, svg: svgStr };
    }).filter(Boolean);

    debugDXF('Single sketch build', {
      totalEntities: entities.length,
      renderedEntities: decorItems.length + outerBoundaryItems.length,
      skippedEntities: skippedRenderEntities.length,
      skippedByType: skippedRenderEntities.reduce((acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + 1;
        return acc;
      }, {}),
      skippedEntities: skippedRenderEntities,
    });

    return {
      id: 's_0',
      name: 'Sketch 1',
      layer: preferredOuterLayer,
      layerColor: resolveEntityColor(outer.entity, preferredOuterLayer),
      hasSyntheticOuter,
      mixedOuterLayers: false,
      selectionFillAllowed: false,
      outerBoundaryItems,
      pathData: outerPath,
      selectionPathData: outerPath,
      fillRule: 'nonzero',
      polygonPoints: closePointRing(outer.points),
      bbox: { w: width, h: height },
      decorSVG: decorItems.map(item => item.svg),
      decorItems,
      exportEntities: [...exportEntityMap.values()],
      ownerLayers: [preferredOuterLayer],
      involvedLayers: [...new Set([preferredOuterLayer, ...decorItems.map(item => item.layer)])],
      holes: [],
      qty: 1,
      visible: true,
      selected: false,
    };
  }

  // Core DXF-to-shapes pipeline. Takes a parsed DXF object and the original raw
  // text, detects contours, builds SVG path data, collects decorator entities,
  // and returns the shape + layer list the rest of the app uses.
  function parseDXFToShapes(dxf, raw, settingsInput = {}) {
    const settings = normalizeSettings(settingsInput);
    const entities = enrichEntitiesFromRaw([...(dxf.entities || [])], raw);
    const layerTable = (dxf.tables && dxf.tables.layer && dxf.tables.layer.layers) || {};
    const layerOrder = Object.keys(layerTable);
    const { layerColor, resolveEntityColor } = createLayerResolver(layerTable);
    const detectedGroups = groupByContour(entities);
    if (!detectedGroups.length) return null;

    const shapes = [];
    const layerMap = new Map();
    let idx = 0;

    if (settings.multiSketchDetection === false) {
      const wholeSketch = buildWholeSketchShape(
        entities,
        detectedGroups,
        layerTable,
        { layerColor, resolveEntityColor, layerOrder, layerMap }
      );
      if (wholeSketch) shapes.push(wholeSketch);
    } else {
      const groups = detectedGroups;

    groups.forEach(group => {
      const { outer, contours, decorators, bbox } = group;
      let renderBBox = bbox;
      const peerOuterContours = contours.filter(contour =>
        contour.id !== outer.id &&
        contour.depth === 0 &&
        !contour.entity?.isAlphaShape
      );
      const syntheticSupportContours = contours.filter(contour =>
        contour.id !== outer.id &&
        contour.entity?.type === 'LINE_LOOP' &&
        !contour.entity?.isAlphaShape
      );

      const holeContours = contours.filter(contour =>
        contour.id !== outer.id &&
        contour.depth % 2 === 1 &&
        contour.entity?.type !== 'LINE_LOOP'
      );

      const closedDecorContours = contours.filter(contour =>
        contour.id !== outer.id &&
        contour.depth !== 0 &&
        !(contour.layer === outer.layer && contour.depth % 2 === 1)
      );

      closedDecorContours.forEach(contour => { renderBBox = unionBBox(renderBBox, contour.bbox); });
      decorators.forEach(decorator => { renderBBox = unionBBox(renderBBox, entityBBox(decorator)); });

      const { minX, maxY, maxX, minY } = renderBBox;
      const width = maxX - minX;
      const height = maxY - minY;
      if (width < 0.5 || height < 0.5) return;

      const topLevelContours = [outer, ...peerOuterContours];
      const boundaryContourPaths = [];
      const boundaryItems = [];

      topLevelContours.forEach(contour => {
        const path = contourEntityToPath(contour.entity, minX, maxY);
        if (path) {
          boundaryContourPaths.push(path);
          return;
        }
        if (contour.entity?.type === 'LINE_LOOP') {
          (contour.entity?.sourceEntities || []).forEach(entity => {
            const layerName = entity.layer || contour.layer || '0';
            const color = resolveEntityColor(entity, layerName);
            const svgStr = svg.entityToSVGStr(entity, minX, maxY, color);
            if (!svgStr) return;
            boundaryItems.push({ layer: layerName, color, svg: svgStr, contourId: contour.id });
          });
        }
      });

      syntheticSupportContours.forEach(contour => {
        (contour.entity?.sourceEntities || []).forEach(entity => {
          const layerName = entity.layer || contour.layer || '0';
          const color = resolveEntityColor(entity, layerName);
          const svgStr = svg.entityToSVGStr(entity, minX, maxY, color);
          if (!svgStr) return;
          boundaryItems.push({ layer: layerName, color, svg: svgStr, contourId: contour.id });
        });
      });

      const contourPaths = [
        ...boundaryContourPaths,
        ...holeContours.map(contour => svg.pathFromPoints([...contour.points].reverse(), minX, maxY, true)).filter(Boolean),
      ];
      const pathData = contourPaths.join(' ');
      const selectionPathData = contourEntityToPath(outer.entity, minX, maxY) || boundaryContourPaths[0] || '';
      const fillRule = contourPaths.length > 1 ? 'evenodd' : 'nonzero';

      const decorItems = [];
      const renderedDecoratorHandles = [];
      const skippedDecoratorHandles = [];
      closedDecorContours.forEach(contour => {
        if (contour.entity?.type === 'LINE_LOOP') return;
        const layerName = contour.layer || '0';
        const path = contourEntityToPath(contour.entity, minX, maxY);
        if (!path) return;
        const color = resolveEntityColor(contour.entity, layerName);
        decorItems.push({
          type: 'closed-contour',
          layer: layerName,
          color,
          svg: `<path d="${path}" stroke="${color}" stroke-width="0.8" opacity="0.9" fill="none" stroke-linejoin="round"/>`,
        });
      });

      decorators.forEach(decorator => {
        const color = resolveEntityColor(decorator, outer.layer || '0');
        const svgStr = svg.entityToSVGStr(decorator, minX, maxY, color);
        if (!svgStr) {
          skippedDecoratorHandles.push({
            handle: decorator.handle || null,
            type: decorator.type || 'UNKNOWN',
            layer: decorator.layer || outer.layer || '0',
          });
          return;
        }
        renderedDecoratorHandles.push({
          handle: decorator.handle || null,
          type: decorator.type || 'UNKNOWN',
          layer: decorator.layer || outer.layer || '0',
        });
        decorItems.push({
          type: 'entity',
          layer: decorator.layer || outer.layer || '0',
          color,
          svg: svgStr,
        });
      });

      contours.slice(1).forEach(contour => layerMap.set(contour.layer || '0', layerColor(contour.layer || '0')));
      decorators.forEach(decorator => layerMap.set(decorator.layer || '0', layerColor(decorator.layer || '0')));

      const hasSyntheticOuter = outer.entity?.type === 'LINE_LOOP';
      const mixedOuterLayers = hasSyntheticOuter && Array.isArray(outer.entity?.sourceLayers) && outer.entity.sourceLayers.length > 1;
      const contourLayers = [...new Set(contours.map(contour => contour.layer || '0').filter(Boolean))];
      const preferredOuterLayer = layerOrder.find(layerName => contourLayers.includes(layerName)) || contourLayers[0] || outer.layer || '0';
      const ownerContour = contours
        .filter(contour => (contour.layer || '0') === preferredOuterLayer)
        .sort((a, b) => b.area - a.area)[0] || outer;
      const ownerLayers = [preferredOuterLayer];
      ownerLayers.forEach(layerName => layerMap.set(layerName, layerColor(layerName)));
      const involvedLayers = [...new Set([...contourLayers, ...decorItems.map(item => item.layer)])];
      const selectionFillAllowed = !hasSyntheticOuter && !mixedOuterLayers && involvedLayers.length <= 1 && closedDecorContours.length === 0 && decorators.length === 0 && peerOuterContours.length === 0;

      const exportEntityMap = new Map();
      const addExportEntity = entity => {
        if (!entity) return;
        const key = entity.handle || JSON.stringify([
          entity.type, entity.layer,
          entity.start?.x, entity.start?.y,
          entity.end?.x, entity.end?.y,
          entity.center?.x, entity.center?.y,
          entity.radius, entity.startAngle, entity.endAngle,
          entity.vertices?.length,
        ]);
        if (!exportEntityMap.has(key)) {
          const serialized = serializeEntityForExport(entity, contourEntityToPoints);
          if (serialized) exportEntityMap.set(key, serialized);
        }
      };

      if (hasSyntheticOuter) (outer.entity?.sourceEntities || []).forEach(addExportEntity);
      else addExportEntity(outer.entity);
      holeContours.forEach(contour => addExportEntity(contour.entity));
      closedDecorContours.forEach(contour => addExportEntity(contour.entity));
      decorators.forEach(addExportEntity);

      // When the chosen outer is a synthetic LINE_LOOP, pathData is suppressed by
      // the canvas (renderSyntheticPath = false). LINE_LOOP peer outers are covered
      // by syntheticSupportContours → boundaryItems, but non-LINE_LOOP peer outers
      // (e.g. LWPOLYLINE c_0, c_1) end up in neither boundaryItems nor
      // outerBoundaryItems, making them invisible. Add them explicitly here.
      const nonSyntheticPeerOuterItems = hasSyntheticOuter
        ? peerOuterContours
            .filter(c => c.entity?.type !== 'LINE_LOOP')
            .flatMap(contour => {
              const path = contourEntityToPath(contour.entity, minX, maxY);
              if (!path) return [];
              const layerName = contour.layer || '0';
              const color = resolveEntityColor(contour.entity, layerName);
              return [{ layer: layerName, color, svg: `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>` }];
            })
        : [];

      const outerBoundaryItems = dedupeRenderedItems([
        ...boundaryItems,
        ...nonSyntheticPeerOuterItems,
        ...(hasSyntheticOuter
        ? (outer.entity?.sourceEntities || []).map(entity => {
            const layerName = entity.layer || '0';
            const color = resolveEntityColor(entity, layerName);
            const svgStr = svg.entityToSVGStr(entity, minX, maxY, color);
            if (!svgStr) return null;
            return { layer: layerName, color, svg: svgStr };
          }).filter(Boolean)
        : []),
      ]);

      debugDXF('Shape render summary', {
        shapeId: `s_${idx}`,
        outerId: outer.id,
        contourIds: contours.map(contour => contour.id),
        decoratorHandles: decorators.map(entity => ({
          handle: entity.handle || null,
          type: entity.type || 'UNKNOWN',
          layer: entity.layer || outer.layer || '0',
        })),
        renderedDecoratorHandles,
        skippedDecoratorHandles,
        topLevelContours: topLevelContours.map(contour => ({
          id: contour.id,
          type: contour.entity?.type || 'UNKNOWN',
          pathRendered: !!contourEntityToPath(contour.entity, minX, maxY),
          boundaryItemCount: boundaryItems.filter(item => item.contourId === contour.id).length,
          sourceEntityHandles: Array.isArray(contour.entity?.sourceEntities)
            ? contour.entity.sourceEntities.map(entity => ({
                handle: entity.handle || null,
                type: entity.type || 'UNKNOWN',
                layer: entity.layer || contour.layer || '0',
              }))
            : [],
        })),
        syntheticSupportContours: syntheticSupportContours.map(contour => ({
          id: contour.id,
          depth: contour.depth,
          sourceEntityHandles: Array.isArray(contour.entity?.sourceEntities)
            ? contour.entity.sourceEntities.map(entity => ({
                handle: entity.handle || null,
                type: entity.type || 'UNKNOWN',
                layer: entity.layer || contour.layer || '0',
              }))
            : [],
          boundaryItemCount: boundaryItems.filter(item => item.contourId === contour.id).length,
        })),
      });

      debugDXF('Shape svg fragment', {
        shapeId: `s_${idx}`,
        outerId: outer.id,
        contourIds: contours.map(contour => contour.id),
        pathData,
        selectionPathData,
        fillRule,
        outerBoundaryItems: outerBoundaryItems.map(item => ({
          layer: item.layer,
          color: item.color,
          svg: item.svg,
        })),
        decorItems: decorItems.map(item => ({
          type: item.type,
          layer: item.layer,
          color: item.color,
          svg: item.svg,
        })),
      });

      debugDXF('Shape contour sources', {
        shapeId: `s_${idx}`,
        outerId: outer.id,
        contours: contours.map(contour => ({
          id: contour.id,
          depth: contour.depth,
          type: contour.entity?.type || 'UNKNOWN',
          isAlphaShape: !!contour.entity?.isAlphaShape,
          isPrimary: !!contour.entity?.isPrimary,
          isOuterBoundary: !!contour.entity?.isOuterBoundary,
          sourceEntities: Array.isArray(contour.entity?.sourceEntities)
            ? contour.entity.sourceEntities.map(entity => ({
                handle: entity.handle || null,
                type: entity.type || 'UNKNOWN',
                layer: entity.layer || contour.layer || '0',
                svg: svg.entityToSVGStr(entity, minX, maxY, resolveEntityColor(entity, entity.layer || contour.layer || '0')),
              }))
            : [],
        })),
      });

      debugDXF('Shape contour geometry', {
        shapeId: `s_${idx}`,
        outerId: outer.id,
        contours: contours.map(contour => ({
          id: contour.id,
          type: contour.entity?.type || 'UNKNOWN',
          handle: contour.entity?.handle || null,
          depth: contour.depth,
          bbox: contour.bbox,
          points: Array.isArray(contour.points)
            ? contour.points.map(point => ({
                x: +point.x.toFixed(3),
                y: +point.y.toFixed(3),
              }))
            : [],
          entityVertices: Array.isArray(contour.entity?.vertices)
            ? contour.entity.vertices.map(vertex => ({
                x: +vertex.x.toFixed(3),
                y: +vertex.y.toFixed(3),
                bulge: Number.isFinite(vertex.bulge) ? +vertex.bulge.toFixed(6) : null,
              }))
            : [],
          entityCenter: contour.entity?.center
            ? {
                x: +contour.entity.center.x.toFixed(3),
                y: +contour.entity.center.y.toFixed(3),
              }
            : null,
          entityRadius: Number.isFinite(contour.entity?.radius)
            ? +contour.entity.radius.toFixed(3)
            : null,
        })),
      });

      shapes.push({
          id: `s_${idx++}`,
          name: `Shape ${idx}`,
          layer: preferredOuterLayer,
          layerColor: resolveEntityColor(ownerContour.entity, preferredOuterLayer),
          hasSyntheticOuter,
          mixedOuterLayers,
          selectionFillAllowed,
          outerBoundaryItems,
          pathData,
          selectionPathData,
          fillRule,
          polygonPoints: closePointRing(outer.points),
          bbox: { w: width, h: height },
          decorSVG: decorItems.map(item => item.svg),
          decorItems,
          exportEntities: [...exportEntityMap.values()],
          ownerLayers,
          involvedLayers,
          holes: [],
          qty: 1,
          visible: true,
          selected: false,
        });
      });
    }

    if (!shapes.length) return null;

    const orderedLayers = layerOrder.map(name => ({ name, color: layerColor(name) })).filter(layer => layer.name);
    const extraLayers = [...layerMap.entries()]
      .filter(([name]) => !layerOrder.includes(name))
      .map(([name, color]) => ({ name, color }));
    const layers = [...orderedLayers, ...extraLayers];

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

  const LAYER_DEFS = [
    { name: 'BODY', color: '#4f8ef7' },
    { name: 'CUT', color: '#f75f5f' },
    { name: 'DRILL', color: '#4fcf8e' },
    { name: 'FOLD', color: '#f7c34f' },
    { name: 'ENGRAVE', color: '#cf4ff7' },
  ];
  const GENERATORS = [
    r => { const w = 50 + r() * 110; const h = 32 + r() * 80; return { d: `M0,0 H${svg.f(w)} V${svg.f(h)} H0 Z`, w, h, name: 'Plate' }; },
    r => { const w = 72 + r() * 65; const h = 62 + r() * 55; const fw = 18 + r() * 20; const fh = 18 + r() * 20; return { d: `M0,0 H${svg.f(w)} V${svg.f(fh)} H${svg.f(fw)} V${svg.f(h)} H0 Z`, w, h, name: 'L-Bracket' }; },
    r => { const w = 82 + r() * 62; const h = 52 + r() * 45; const tw = 14 + r() * 12; const fw = 14 + r() * 12; return { d: `M0,0 H${svg.f(w)} V${svg.f(h)} H${svg.f(w - fw)} V${svg.f(tw)} H${svg.f(fw)} V${svg.f(h)} H0 Z`, w, h, name: 'U-Channel' }; },
  ];

  // Generates deterministic fake shape data from a hash of the filename.
  // Used so the preview modal always shows something plausible even before a
  // real parse completes or when no DXF path is available yet.
  function mockDXFData(filename) {
    const rng = mkRng(hashStr(filename));
    const numLayers = 2 + Math.floor(rng() * 3);
    const layers = LAYER_DEFS.slice(0, numLayers);
    const shapes = [];
    let idx = 0;
    layers.forEach(layer => {
      if (['DRILL', 'FOLD', 'ENGRAVE'].includes(layer.name)) return;
      const count = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < count; i++) {
        const generated = GENERATORS[Math.floor(rng() * GENERATORS.length)](rng);
        shapes.push({
          id: `s_${idx++}`,
          name: generated.name + (count > 1 ? ` ${String.fromCharCode(65 + i)}` : ''),
          layer: layer.name,
          layerColor: layer.color,
          pathData: generated.d,
          fillRule: generated.fillRule || 'nonzero',
          bbox: { w: generated.w, h: generated.h },
          decorSVG: [],
          holes: [],
          qty: 1,
          visible: true,
          selected: false,
        });
      }
    });
    return { shapes, layers };
  }

  function createDxfPreviewService() {
    // Entry point for opening a DXF preview. Tries three sources in priority
    // order: already-parsed shapes in state → parse from disk via Electron →
    // mock data. Always returns something so the UI never hangs on a blank modal.
    async function preparePreviewData({ state, fileId, filename }) {
      const file = state.files.find(entry => entry.id === fileId);
      const settings = typeof global.getCurrentNestingSettings === 'function'
        ? global.getCurrentNestingSettings()
        : {};
      const matchesSketchMode = file?._multiSketchDetection === !!settings.multiSketchDetection;
      let data = null;
      let source = 'mock';

      if (matchesSketchMode && file?.shapes?.length) {
        data = applyPartLabelsToPreviewData(clonePreviewData({ shapes: file.shapes, layers: file.layers || [] }), filename);
        source = 'saved';
      }

      if (!data && file && file.path && global.electronAPI?.parseDXF) {
        try {
          const result = await global.electronAPI.parseDXF(file.path);
          if (result.success && result.data) {
            const parsed = parseDXFToShapes(result.data, result.raw, settings);
            if (parsed) {
              data = applyPartLabelsToPreviewData(clonePreviewData(parsed), filename);
              file.shapes = clonePreviewData(data).shapes;
              file.layers = clonePreviewData(data).layers;
              file._multiSketchDetection = !!settings.multiSketchDetection;
              source = 'real';
            }
          }
        } catch (error) {
          console.error('[DXF] Unexpected error:', error);
        }
      }

      if (!data) data = applyPartLabelsToPreviewData(clonePreviewData(mockDXFData(filename)), filename);
      return { data, source, file };
    }

    // Writes the user's shape edits (qty changes, visibility toggles) back into
    // the file record in state and triggers a re-render and a persist so the
    // changes survive a page reload.
    function applyPreviewToFile({ state, fileId, shapes, layers, renderFiles, schedulePersistJobState }) {
      const file = state.files.find(entry => entry.id === fileId);
      if (!file) return;
      file.shapes = shapes.map(shape => global.NestDxfPreviewState.clonePreviewShape(shape));
      file.layers = layers.map(layer => ({ ...layer }));
      if (typeof global.getCurrentNestingSettings === 'function') {
        file._multiSketchDetection = !!global.getCurrentNestingSettings().multiSketchDetection;
      }
      file.qty = file.shapes
        .filter(shape => shape.visible !== false)
        .reduce((acc, shape) => acc + Math.max(1, parseInt(shape.qty || 1, 10)), 0);
      renderFiles();
      if (typeof schedulePersistJobState === 'function') schedulePersistJobState();
    }

    return {
      preparePreviewData,
      applyPreviewToFile,
      parseDXFToShapes,
      mockDXFData,
    };
  }

  global.NestDxfPreviewService = {
    parseDXFToShapes,
    mockDXFData,
    createDxfPreviewService,
  };
})(window);
