(function attachNestDxfLayerService(global) {
  'use strict';

  const { aciToHex, normalizeHexColor, normalizeAci, trueColorToHex } = global.NestDxfColor;

  const FALLBACK_PALETTE = ['#4f8ef7', '#f75f5f', '#4fcf8e', '#f7c34f', '#cf4ff7', '#4ff7e8', '#f77f4f'];

  function createLayerResolver(layerTable) {
    let paletteIndex = 0;
    const colorCache = {};

    function findLayerDef(name) {
      if (layerTable[name]) return layerTable[name];
      const trimmed = String(name || '').trim();
      if (trimmed && layerTable[trimmed]) return layerTable[trimmed];
      const matchKey = Object.keys(layerTable).find(key => key.trim() === trimmed);
      return matchKey ? layerTable[matchKey] : null;
    }

    function resolveLayerDefColor(def) {
      if (!def) return null;
      const explicitHex = normalizeHexColor(def.color) || normalizeHexColor(def.trueColor) || normalizeHexColor(def.rgb);
      if (explicitHex) return explicitHex;
      const trueColor = trueColorToHex(def.trueColor ?? def.color24 ?? def.rgb24);
      if (trueColor) return trueColor;
      const aci = normalizeAci(def.colorNumber ?? def.colorIndex ?? def.aciColor ?? def.color ?? def.aci);
      if (aci !== null) {
        const mapped = aciToHex(aci);
        if (mapped) return mapped;
      }
      return null;
    }

    function layerColor(name) {
      if (colorCache[name]) return colorCache[name];
      const def = findLayerDef(name);
      colorCache[name] = resolveLayerDefColor(def) || FALLBACK_PALETTE[paletteIndex++ % FALLBACK_PALETTE.length];
      return colorCache[name];
    }

    function resolveEntityColor(entity, fallbackLayer = '0') {
      if (!entity) return layerColor(fallbackLayer);
      const explicitHex = normalizeHexColor(entity.color) || normalizeHexColor(entity.trueColor);
      if (explicitHex) return explicitHex;
      const trueColor = trueColorToHex(entity.rawTrueColor ?? entity.trueColor ?? entity.color24);
      if (trueColor) return trueColor;
      const aci = normalizeAci(entity.rawAciColor ?? entity.colorNumber ?? entity.colorIndex ?? entity.color);
      if (aci !== null) {
        if (aci === 256 || aci === 0) return layerColor(entity.layer || fallbackLayer);
        const mapped = aciToHex(aci);
        if (mapped) return mapped;
      }
      return layerColor(entity.layer || fallbackLayer);
    }

    return {
      layerColor,
      resolveEntityColor,
      findLayerDef,
      resolveLayerDefColor,
    };
  }

  global.NestDxfLayerService = {
    FALLBACK_PALETTE,
    createLayerResolver,
  };
})(window);
