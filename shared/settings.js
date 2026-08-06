'use strict';

(function defineNestSettings(globalScope) {
  const SKETCH_CONTOUR_METHODS = [
    'auto',
    'arrangement',
  ];

  const SHEET_WIDTH_PRIORITY_WEIGHTS = {
    'by-width': 0.0,
    'by-height': 1.0,
  };

  // Single source of truth for the consolidated multi-sheet strategy.
  // Each value maps to a (multiStripMode, bucketFillWeight) pair that the
  // renderer hands to Sparrow's IPC layer.
  //
  // `bucketFillWeight: null` means "omit from sparrow CLI" — for barriers
  // mode the flag is irrelevant; for `by-height-or-length` it triggers
  // Sparrow's built-in auto-pick over [0.0, 1.0, 2.0].
  const MULTI_SHEET_STRATEGIES = [
    'auto',
    'by-height',
    'by-length',
    'by-height-or-length',
  ];
  const MULTI_SHEET_STRATEGY_OPTIONS = {
    'auto': { multiStripMode: 'barriers', bucketFillWeight: null },
    'by-height': { multiStripMode: 'prebucket', bucketFillWeight: 1.0 },
    'by-length': { multiStripMode: 'prebucket', bucketFillWeight: 0.0 },
    'by-height-or-length': { multiStripMode: 'prebucket', bucketFillWeight: null },
  };

  const PREFERRED_ALIGNMENTS = [
    'top',
    'top-left',
    'top-right',
    'bottom',
    'bottom-left',
    'bottom-right',
  ];

  const ENGRAVING_STYLES = [
    'simple',
    'stroked',
    'last-char',
    'last-two-chars',
    'last-three-chars',
    'first-char',
    'first-two-chars',
    'first-three-chars',
  ];

  const SETTINGS_DEFAULTS = {
    partSpacing: 0,
    sheetMargin: 0,
    rotationStep: '90',
    mirrorParts: false,
    earlyStopping: true,
    preferredAlignment: 'top',
    timeLimit: 60,
    rngSeed: 42,
    workers: 3,
    exportFormat: 'dxf',
    exportDebug: false,
    joinConnectedLinework: false,
    includeSheetOutline: false,
    engravingLayer: '2',
    engravingStyle: 'simple',
    sketchContourMethod: 'arrangement',
    multiSketchDetection: true,
    // Combined multi-sheet strategy. Replaces the older `useBarrierMode`
    // (boolean) + `sheetWidthPriority` (dropdown) pair. Migration of stored
    // legacy values is handled in `normalizeSettings`.
    multiSheetStrategy: 'auto',
    theme: 'system',
    colorPartsBySource: true,
    showCursorCoords: true,
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

    // Legacy migration: collapse `useBarrierMode` + `sheetWidthPriority` into
    // the unified `multiSheetStrategy`. Only fires when the new field isn't
    // already present, so re-saving doesn't clobber an explicit user choice.
    if (!('multiSheetStrategy' in raw)) {
      const legacyBarrier = raw.useBarrierMode === true
        || raw.useBarrierMode === 'true'
        || raw.useBarrierMode === 1;
      if (legacyBarrier) {
        raw.multiSheetStrategy = 'auto';
      } else if ('sheetWidthPriority' in raw) {
        const swp = String(raw.sheetWidthPriority || '').toLowerCase();
        if (['by-width', 'width'].includes(swp)) {
          raw.multiSheetStrategy = 'by-length';
        } else if (['by-height', 'height'].includes(swp)) {
          raw.multiSheetStrategy = 'by-height';
        } else if (['default', 'auto', ''].includes(swp)) {
          raw.multiSheetStrategy = 'by-height-or-length';
        }
        // Unknown legacy values fall through to the default ('auto').
      }
    }
    delete raw.useBarrierMode;
    delete raw.sheetWidthPriority;

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

    if (!PREFERRED_ALIGNMENTS.includes(normalized.preferredAlignment)) {
      normalized.preferredAlignment = SETTINGS_DEFAULTS.preferredAlignment;
    }

    if (!['svg', 'dxf', 'pdf'].includes(normalized.exportFormat)) {
      normalized.exportFormat = SETTINGS_DEFAULTS.exportFormat;
    }

    if (normalized.engravingStyle === 'last-digit') {
      normalized.engravingStyle = 'last-char';
    } else if (normalized.engravingStyle === 'last-two-digits') {
      normalized.engravingStyle = 'last-two-chars';
    }

    if (!ENGRAVING_STYLES.includes(normalized.engravingStyle)) {
      normalized.engravingStyle = SETTINGS_DEFAULTS.engravingStyle;
    }

    if (!SKETCH_CONTOUR_METHODS.includes(normalized.sketchContourMethod)) {
      normalized.sketchContourMethod = SETTINGS_DEFAULTS.sketchContourMethod;
    }

    if (!MULTI_SHEET_STRATEGIES.includes(normalized.multiSheetStrategy)) {
      normalized.multiSheetStrategy = SETTINGS_DEFAULTS.multiSheetStrategy;
    }

    if (!['system', 'dark', 'light'].includes(normalized.theme)) {
      normalized.theme = SETTINGS_DEFAULTS.theme;
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
    normalized.rngSeed = Math.max(0, Math.trunc(Number(normalized.rngSeed) || SETTINGS_DEFAULTS.rngSeed));
    normalized.workers = Math.max(1, Math.trunc(Number(normalized.workers) || SETTINGS_DEFAULTS.workers));
    normalized.partSpacing = Math.max(0, Number(normalized.partSpacing) || 0);
    normalized.sheetMargin = Math.max(0, Number(normalized.sheetMargin) || 0);

    return normalized;
  }

  const settingsApi = {
    SETTINGS_DEFAULTS,
    SKETCH_CONTOUR_METHODS,
    SHEET_WIDTH_PRIORITY_WEIGHTS,
    MULTI_SHEET_STRATEGIES,
    MULTI_SHEET_STRATEGY_OPTIONS,
    PREFERRED_ALIGNMENTS,
    ENGRAVING_STYLES,
    normalizeSettings,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = settingsApi;
  }

  globalScope.NestSettings = settingsApi;
})(typeof window !== 'undefined' ? window : globalThis);
