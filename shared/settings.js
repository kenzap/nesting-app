'use strict';

(function defineNestSettings(globalScope) {
  const SKETCH_CONTOUR_METHODS = [
    'auto',
    'arrangement',
  ];

  const SETTINGS_DEFAULTS = {
    partSpacing: 0,
    sheetMargin: 0,
    rotationStep: '90',
    mirrorParts: false,
    earlyStopping: true,
    preferredAlignment: 'top',
    timeLimit: 60,
    exportFormat: 'dxf',
    engravingLayer: '2',
    engravingStyle: 'simple',
    sketchContourMethod: 'auto',
    multiSketchDetection: true,
  };

  function coerceByDefault(value, fallback) {
    if (typeof fallback === 'boolean') return !!value;
    if (typeof fallback === 'number') {
      const num = Number(value);
      return Number.isFinite(num) ? num : fallback;
    }
    return value == null ? fallback : String(value);
  }

  /**
   * Normalize persisted or imported settings into the shape the app expects.
   *
   * This keeps migration and fallback rules in one place so renderer and main
   * process logic do not drift apart over time.
   */
  function normalizeSettings(input = {}) {
    const normalized = { ...SETTINGS_DEFAULTS };
    const raw = { ...(input || {}) };

    if (!('engravingLayer' in raw) && 'showPartLabels' in raw) {
      raw.engravingLayer = raw.showPartLabels ? '2' : 'off';
    }
    delete raw.showPartLabels;

    Object.keys(SETTINGS_DEFAULTS).forEach(key => {
      if (!(key in raw)) return;
      normalized[key] = coerceByDefault(raw[key], SETTINGS_DEFAULTS[key]);
    });

    // Deprecated contour methods ('makerjs-outline', 'makerjs-chains',
    // 'intersection') migrate to 'auto'. The validation pass below will
    // collapse any other unknown value to the default too.
    if (['makerjs-outline', 'makerjs-chains', 'intersection'].includes(normalized.sketchContourMethod)) {
      normalized.sketchContourMethod = 'auto';
    }

    if (!['top', 'bottom'].includes(normalized.preferredAlignment)) {
      normalized.preferredAlignment = SETTINGS_DEFAULTS.preferredAlignment;
    }

    if (!['svg', 'dxf', 'pdf'].includes(normalized.exportFormat)) {
      normalized.exportFormat = SETTINGS_DEFAULTS.exportFormat;
    }

    if (!['simple', 'stroked'].includes(normalized.engravingStyle)) {
      normalized.engravingStyle = SETTINGS_DEFAULTS.engravingStyle;
    }

    if (!SKETCH_CONTOUR_METHODS.includes(normalized.sketchContourMethod)) {
      normalized.sketchContourMethod = SETTINGS_DEFAULTS.sketchContourMethod;
    }

    const engravingLayerRaw = normalized.engravingLayer;
    if (engravingLayerRaw !== 'off') {
      const parsed = Number.parseInt(String(engravingLayerRaw), 10);
      normalized.engravingLayer = Number.isFinite(parsed) && parsed >= 1 ? String(parsed) : SETTINGS_DEFAULTS.engravingLayer;
    }

    if (normalized.rotationStep !== 'none') {
      normalized.rotationStep = String(normalized.rotationStep);
    }

    normalized.timeLimit = Math.max(10, Number(normalized.timeLimit) || SETTINGS_DEFAULTS.timeLimit);
    normalized.partSpacing = Math.max(0, Number(normalized.partSpacing) || 0);
    normalized.sheetMargin = Math.max(0, Number(normalized.sheetMargin) || 0);

    return normalized;
  }

  const settingsApi = {
    SETTINGS_DEFAULTS,
    SKETCH_CONTOUR_METHODS,
    normalizeSettings,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = settingsApi;
  }

  globalScope.NestSettings = settingsApi;
})(typeof window !== 'undefined' ? window : globalThis);
