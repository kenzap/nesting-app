'use strict';

(function defineDxfService(globalScope) {
  function createDxfService({ state, getCurrentNestingSettings }) {
    const {
      buildAllowedOrientations,
      sanitizePolygonPoints,
      clonePlain,
      effectiveFileQty,
      partLabelFromName,
      buildJobName,
    } = globalScope.NestHelpers;

    // Guarantees a file has parsed shapes with export metadata before they're used.
    // If the shapes are already fully populated, skips the expensive IPC round-trip.
    async function ensureFileShapes(file) {
      const settings = getCurrentNestingSettings();
      const matchesSketchMode = file._multiSketchDetection === !!settings.multiSketchDetection;
      const sketchContourMethod = String(settings?.sketchContourMethod || 'auto');
      const shapelyPolygonizeToleranceMultiplier = Number(settings?.shapelyPolygonizeToleranceMultiplier || 1);
      const matchesContourMethod = String(file?._sketchContourMethod || 'auto') === sketchContourMethod;
      const matchesShapelyTolerance = Number(file?._shapelyPolygonizeToleranceMultiplier || 1) === shapelyPolygonizeToleranceMultiplier;
      const hasUsableShapes = Array.isArray(file.shapes) && file.shapes.length;
      const hasExportMetadata = hasUsableShapes && file.shapes.every(shape => Array.isArray(shape.exportEntities));
      const hasLayerTable = Array.isArray(file.layers) && file.layers.length;
      if (matchesSketchMode && matchesContourMethod && matchesShapelyTolerance && hasUsableShapes && hasExportMetadata && hasLayerTable) return file.shapes;
      if (!file.path || !window.electronAPI?.parseDXF || typeof window.parseDXFToShapes !== 'function') {
        throw new Error(`No parsed shapes available for ${file.name}`);
      }

      const result = await window.electronAPI.parseDXF(file.path);
      if (!result?.success || !result.data) {
        throw new Error(result?.error || `Failed to parse ${file.name}`);
      }

      const parsed = window.parseDXFToShapes(result.data, result.raw, settings);
      if (!parsed?.shapes?.length) {
        throw new Error(`No nestable shapes found in ${file.name}`);
      }

      file.shapes = parsed.shapes.map(shape => ({
        ...shape,
        qty: file.qty || shape.qty || 1,
      }));
      file.layers = Array.isArray(parsed.layers) ? parsed.layers.map(layer => ({ ...layer })) : [];
      file._multiSketchDetection = !!settings.multiSketchDetection;
      file._sketchContourMethod = sketchContourMethod;
      file._shapelyPolygonizeToleranceMultiplier = shapelyPolygonizeToleranceMultiplier;
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
            source_file: file.path || file.name,
            source_name: file.name,
            source_shape_id: shape.id,
            part_label: partLabelFromName(file.name),
            layers: clonePlain(file.layers || []),
            entities: clonePlain(shape.exportEntities || []),
            polygon: points.map(point => [point.x, point.y]),
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
