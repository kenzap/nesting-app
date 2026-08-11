'use strict';

(function defineDxfService(globalScope) {
  function createDxfService({ state, getCurrentNestingSettings }) {
    const { FALLBACK_PALETTE = [] } = globalScope.NestDxfLayerService || {};
    const { DXF_SHAPE_CACHE_VERSION = 1 } = globalScope.NestConstants || {};
    const {
      buildAllowedOrientations,
      sanitizePolygonPoints,
      clonePlain,
      effectiveFileQty,
      partLabelFromName,
      buildJobName,
    } = globalScope.NestHelpers;

    function engravingLayerIndex(settings = getCurrentNestingSettings()) {
      const raw = settings?.engravingLayer;
      if (raw === 'off' || raw === false || raw == null || raw === '') return null;
      const parsed = Number.parseInt(String(raw), 10);
      return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
    }

    function batchLayerTemplateAtIndex(targetIndex, excludeFileId = null) {
      if (!Number.isFinite(targetIndex) || targetIndex < 1) return null;
      for (const file of state.files || []) {
        if (excludeFileId && file?.id === excludeFileId) continue;
        const layer = Array.isArray(file?.layers) ? file.layers[targetIndex - 1] : null;
        if (layer?.name || layer?.color) return { ...layer };
      }
      return null;
    }

    function synthesizeEngravingLayer(layers, settings = getCurrentNestingSettings(), excludeFileId = null) {
      const targetIndex = engravingLayerIndex(settings);
      const sourceLayers = Array.isArray(layers) ? layers.map(layer => ({ ...layer })) : [];
      if (targetIndex === null) return sourceLayers;
      if (sourceLayers[targetIndex - 1]?.name) return sourceLayers;

      const batchTemplate = batchLayerTemplateAtIndex(targetIndex, excludeFileId);
      const fallbackColor = FALLBACK_PALETTE.length
        ? FALLBACK_PALETTE[(targetIndex - 1) % FALLBACK_PALETTE.length]
        : '#4488FF';
      sourceLayers[targetIndex - 1] = {
        name: batchTemplate?.name || `Layer ${targetIndex}`,
        color: batchTemplate?.color || sourceLayers[targetIndex - 1]?.color || fallbackColor,
      };
      return sourceLayers.filter(Boolean);
    }

    // Guarantees a file has parsed shapes with export metadata before they're used.
    // If the shapes are already fully populated, skips the expensive IPC round-trip.
    async function ensureFileShapes(file) {
      const settings = getCurrentNestingSettings();
      const matchesSketchMode = file._multiSketchDetection === !!settings.multiSketchDetection;
      const sketchContourMethod = String(settings?.sketchContourMethod || 'auto');
      const matchesContourMethod = String(file?._sketchContourMethod || 'auto') === sketchContourMethod;
      const hasUsableShapes = Array.isArray(file.shapes) && file.shapes.length;
      const hasExportMetadata = hasUsableShapes && file.shapes.every(shape => Array.isArray(shape.exportEntities));
      const hasLayerTable = Array.isArray(file.layers) && file.layers.length;
      const matchesCacheVersion = file._shapeCacheVersion === DXF_SHAPE_CACHE_VERSION;
      if (matchesSketchMode && matchesContourMethod && matchesCacheVersion && hasUsableShapes && hasExportMetadata && hasLayerTable) return file.shapes;
      if (!file.path || !window.electronAPI?.parseDXF || typeof window.parseDXFToShapes !== 'function') {
        throw new Error(`No parsed shapes available for ${file.name}`);
      }

      const result = await window.electronAPI.parseDXF(file.path, file.bookmark || null);
      if (!result?.success || !result.data) {
        throw new Error(result?.error || `Failed to parse ${file.name}`);
      }

      const parsed = window.parseDXFToShapes(result.data, result.raw, settings);
      if (!parsed?.shapes?.length) {
        throw new Error(`No nestable shapes found in ${file.name}`);
      }

      const savedShapesById = new Map((file.shapes || []).map(shape => [shape.id, shape]));
      file.shapes = parsed.shapes.map((shape, index) => {
        const saved = savedShapesById.get(shape.id) || file.shapes?.[index] || null;
        return {
          ...shape,
          qty: Math.max(1, Number.parseInt(saved?.qty, 10) || file.qty || shape.qty || 1),
          visible: saved ? saved.visible !== false : shape.visible,
        };
      });
      file.layers = synthesizeEngravingLayer(parsed.layers || [], settings, file.id);
      file._multiSketchDetection = !!settings.multiSketchDetection;
      file._sketchContourMethod = sketchContourMethod;
      file._shapeCacheVersion = DXF_SHAPE_CACHE_VERSION;
      file.qty = effectiveFileQty(file);
      return file.shapes;
    }

    // Best-effort background parse triggered right after a file is added to the list.
    // Silently swallows errors so a parse failure doesn't break the UI or file list rendering.
    async function hydrateFileShapesForList(file, onHydrated) {
      if (!file || !file.path || (Array.isArray(file.shapes) && file.shapes.length)) return;
      if (!window.electronAPI?.parseDXF || typeof window.parseDXFToShapes !== 'function') return;

      try {
        await ensureFileShapes(file);
        if (typeof onHydrated === 'function') onHydrated(file);
      } catch (error) {
        console.warn(`[DXF] Failed to pre-parse ${file.name}:`, error.message);
      }
    }

    // Assembles the full JSON payload the Sparrow solver expects.
    // Iterates all files, sanitises polygon points, assigns integer IDs, and builds
    // the exportItems side-table so the export pipeline can look up layer/entity data by ID.
    async function buildPlacementPayload() {
      const items = [];
      const exportItems = {};
      let nextId = 0;
      const settings = getCurrentNestingSettings();
      const allowedOrientations = buildAllowedOrientations(settings.rotationStep);

      for (const file of state.files) {
        await ensureFileShapes(file);
        file.layers = synthesizeEngravingLayer(file.layers || [], settings, file.id);
      }

      for (const file of state.files) {
        const shapes = (await ensureFileShapes(file)).filter(shape => shape.visible !== false);
        shapes.forEach(shape => {
          const points = sanitizePolygonPoints(shape.polygonPoints);
          if (points.length < 3) return;
          const itemId = nextId++;

          items.push({
            id: itemId,
            demand: Math.max(1, parseInt(shape.qty || 1, 10)),
            dxf: file.path || file.name,
            allowed_orientations: [...allowedOrientations],
            shape: {
              type: 'simple_polygon',
              data: points.map(point => [point.x, point.y]),
            },
          });

          exportItems[itemId] = {
            source_file_id: file.id,
            source_file: file.path || file.name,
            source_name: file.name,
            source_shape_id: shape.id,
            part_label: partLabelFromName(file.name),
            layers: clonePlain(synthesizeEngravingLayer(file.layers || [], settings, file.id)),
            entities: clonePlain(shape.exportEntities || []),
            polygon: points.map(point => [point.x, point.y]),
            holes: clonePlain(
              (shape.holes || [])
                .map(hole => sanitizePolygonPoints(hole?.points || []))
                .filter(holePoints => holePoints.length >= 4)
                .map(holePoints => holePoints.map(point => [point.x, point.y]))
            ),
          };
        });
      }

      if (!items.length) {
        throw new Error('No exportable shapes available');
      }

      state.lastPlacementExportItems = exportItems;

      return {
        name: buildJobName(state.files),
        settings,
        items,
        sheets: state.sheets.map(sheet => ({
          id: sheet.id,
          width: sheet.widthMode === 'unlimited' ? null : sheet.width,
          height: sheet.height,
          width_mode: sheet.widthMode || 'fixed',
          quantity: 'auto',
          material: sheet.material || '',
        })),
        strip_height: state.sheets[0]?.height || 0,
      };
    }

    // Calls buildPlacementPayload and writes the result to disk via the Electron bridge.
    // Returns the file path so the nesting service can log it and pass it to Sparrow.
    async function exportPlacementJSON() {
      const payload = await buildPlacementPayload();
      if (!window.electronAPI?.savePlacementJSON) {
        throw new Error('Placement JSON export is not available');
      }

      const result = await window.electronAPI.savePlacementJSON(payload);
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to save placement JSON');
      }

      state.lastExportPath = result.path;
      return { payload, path: result.path, directory: result.directory };
    }

    return {
      ensureFileShapes,
      hydrateFileShapesForList,
      buildPlacementPayload,
      exportPlacementJSON,
    };
  }

  globalScope.NestDxfService = { createDxfService };
})(window);
