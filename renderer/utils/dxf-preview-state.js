(function attachNestDxfPreviewState(global) {
  'use strict';

  // Deep-clones a single shape object so that edits made inside the preview
  // modal don't mutate the original. Uses shallow spread for scalar fields but
  // explicitly clones all arrays (polygonPoints, decorItems, exportEntities, etc.).
  function clonePreviewShape(shape) {
    return {
      ...shape,
      bbox: shape?.bbox ? { ...shape.bbox } : shape.bbox,
      polygonPoints: Array.isArray(shape?.polygonPoints)
        ? shape.polygonPoints.map(point => ({ ...point }))
        : shape.polygonPoints,
      holes: Array.isArray(shape?.holes) ? shape.holes.map(hole => ({ ...hole })) : shape.holes,
      involvedLayers: Array.isArray(shape?.involvedLayers) ? [...shape.involvedLayers] : shape.involvedLayers,
      ownerLayers: Array.isArray(shape?.ownerLayers) ? [...shape.ownerLayers] : shape.ownerLayers,
      decorSVG: Array.isArray(shape?.decorSVG) ? [...shape.decorSVG] : shape.decorSVG,
      decorItems: Array.isArray(shape?.decorItems) ? shape.decorItems.map(item => ({ ...item })) : shape.decorItems,
      outerBoundaryItems: Array.isArray(shape?.outerBoundaryItems)
        ? shape.outerBoundaryItems.map(item => ({ ...item }))
        : shape.outerBoundaryItems,
      exportEntities: Array.isArray(shape?.exportEntities)
        ? shape.exportEntities.map(entity => JSON.parse(JSON.stringify(entity)))
        : shape.exportEntities,
      partLabel: shape?.partLabel,
    };
  }

  // Clones a full {shapes, layers} preview data object by running clonePreviewShape
  // on every shape. Keeps the preview session fully isolated from the source data
  // so any modal edits can be discarded or committed deliberately.
  function clonePreviewData(data) {
    if (!data) return null;
    return {
      shapes: Array.isArray(data.shapes) ? data.shapes.map(clonePreviewShape) : [],
      layers: Array.isArray(data.layers) ? data.layers.map(layer => ({ ...layer })) : [],
    };
  }

  // Stamps the DXF filename (without extension) as the partLabel on every shape.
  // Called after cloning so each preview session gets a fresh label derived from
  // the current filename without affecting the stored originals.
  function applyPartLabelsToPreviewData(data, filename) {
    if (!data?.shapes?.length) return data;
    const labelText = typeof global.getPartLabelText === 'function'
      ? global.getPartLabelText(filename)
      : String(filename || '').replace(/\.dxf$/i, '');
    data.shapes.forEach(shape => {
      shape.partLabel = labelText;
    });
    return data;
  }

  global.NestDxfPreviewState = {
    clonePreviewShape,
    clonePreviewData,
    applyPartLabelsToPreviewData,
  };
})(window);
