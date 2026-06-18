'use strict';

(function defineNestI18n(globalScope) {
  const TRANSLATIONS = {
    en: {
      // ── Topbar ──
      run: 'Run',
      stop: 'Stop',
      idle: 'Idle',
      running: 'Running…',
      complete: 'Complete',
      error: 'Error',

      // ── Sidebar ──
      parts: 'Parts',
      sheets: 'Sheets',
      dropDxfFiles: 'Drop DXF files here',
      removeAllParts: 'Remove all parts',
      openDxfFiles: 'Open DXF files',
      addSheet: 'Add Sheet',
      remove: 'Remove',

      // ── Canvas ──
      noNestingResult: 'No nesting result yet',
      addPartsAndSheets: 'Add DXF parts and sheets, then press <strong>Run</strong>',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      fitToView: 'Fit to view',
      sheet: 'Sheet',
      sheetOf: 'of',
      partsLabel: 'parts',
      utilization: 'Utilization',
      width: 'Width',
      preview: 'Preview',
      waitingGeometry: 'Waiting for geometry',
      partsPlaced: 'parts placed',

      // ── Settings modal ──
      settings: 'Settings',
      appearance: 'Appearance',
      language: 'Language',
      theme: 'Theme',
      themeDark: 'Dark',
      themeLight: 'Light',
      spacingTolerances: 'Spacing & tolerances',
      partSpacing: 'Part spacing (mm)',
      sheetMargin: 'Sheet margin (mm)',
      rotation: 'Rotation',
      rotationStep: 'Rotation step',
      noRotation: 'No rotation',
      algorithm: 'Algorithm',
      earlyStopping: 'Early stopping',
      preferredAlignment: 'Preferred alignment',
      alignTop: 'Top',
      alignTopLeft: 'Top left',
      alignTopRight: 'Top right',
      alignBottom: 'Bottom',
      alignBottomLeft: 'Bottom left',
      alignBottomRight: 'Bottom right',
      timeLimit: 'Time limit',
      seconds: 'seconds',
      randomSeed: 'Random seed',
      seed: 'seed',
      workers: 'Workers',
      threads: 'threads',
      multiSheetStrategy: 'Multi-sheet strategy',
      strategyAuto: 'Auto',
      strategyByWidth: 'By width',
      strategyByLength: 'By length',
      strategyByWidthOrLength: 'By width or length',
      sketchContourMethod: 'Sketch contour method',
      contourAuto: 'Auto',
      contourArrangement: 'Arrangement (JSTS)',
      detectMultipleSketches: 'Detect multiple sketches in one DXF',
      output: 'Output',
      exportFormat: 'Export format',
      exportDebug: 'Export debug',
      joinConnectedLinework: 'Join connected linework',
      engravingLayer: 'Engraving layer',
      engravingDisabled: 'Disabled',
      engravingFirstLayer: '1st layer',
      engravingSecondLayer: '2nd layer',
      engravingThirdLayer: '3rd layer',
      engravingFourthLayer: '4th layer',
      engravingFifthLayer: '5th layer',
      engravingStyle: 'Engraving style',
      fullLabelSingleLine: 'Full label (single line)',
      fullLabelOutlined: 'Full label (outlined)',
      lastOneChar: 'Last 1 character',
      lastTwoChars: 'Last 2 characters',
      lastThreeChars: 'Last 3 characters',
      firstOneChar: 'First 1 character',
      firstTwoChars: 'First 2 characters',
      firstThreeChars: 'First 3 characters',
      resetDefaults: 'Reset defaults',
      apply: 'Apply',

      // ── Sheet modal ──
      presetSizes: 'Preset sizes',
      dimensions: 'Dimensions',
      mode: 'Mode',
      fixedSizeSheet: 'Fixed size sheet',
      optimizeUpToMaxLength: 'Optimize up to max length',
      unlimitedStripLength: 'Unlimited strip length',
      widthLabel: 'Width',
      lengthLabel: 'Length',
      material: 'Material',
      materialPlaceholder: 'e.g. Mild Steel 3mm',
      cancel: 'Cancel',
      saveSheet: 'Save Sheet',
      sheetHelpFixed: 'A fixed sheet size will be used. The number of sheets required is calculated automatically.',
      sheetHelpMax: 'Length is treated as a maximum. The algorithm may use less length when possible and will automatically calculate the number of sheets needed and their dimensions.',
      sheetHelpUnlimited: 'The strip can continue without a fixed length limit.',

      // ── Sheets pane ──
      noMaterial: 'No material',
      autoSheetsContinuous: 'Auto sheets · continuous strip',
      autoSheetsLengthCapped: 'Auto sheets · length capped',
      autoSheetsFixedSize: 'Auto sheets · fixed size',
      unlimited: 'Unlimited',

      // ── Files pane ──
      shapes: 'shapes',
      shape: 'shape',
      sketch: 'Sketch',

      // ── Export modal ──
      exportSheets: 'Export Sheets',
      avgUtilization: 'Avg Utilization',
      totalParts: 'Total Parts',
      totalLength: 'Total Length',
      sheetSizeMm: 'Sheet Size (mm)',
      partsColumn: 'Parts',
      utilizationColumn: 'Utilization',
      usedLength: 'Used Length',
      noFolderSelected: 'No folder selected',
      chooseFolder: 'Choose Folder',
      exportDXF: 'Export DXF',
      exporting: 'Exporting…',
      exported: '✓ Exported',
      waitingFinalResult: 'Waiting for final Sparrow result before export',
      filesSavedTo: 'files saved to',
      fileSavedTo: 'file saved to',

      // ── Nesting service ──
      addPartsAndSheetsRun: 'Add DXF parts and at least one sheet, then press Run.',
      addPartsBeforeRun: 'Add one or more DXF parts before running nesting.',
      addSheetsBeforeRun: 'Add at least one sheet before running nesting.',
      placementDataPrepared: 'Placement data prepared',
      exportFailed: 'Export failed',
      placementRunning: 'Placement running…',
      runningWaitingPreview: 'Running placement… waiting for first preview',
      runFailed: 'Run failed',
      placementStopped: 'Placement stopped',

      // ── DXF preview modal ──
      loading: 'Loading…',
      previewLabel: 'preview',
      layers: 'layers',
      layer: 'layer',
      all: 'All',
      restore: 'Restore',
      removePart: 'Remove Part',
      applyToJob: 'Apply to Job',
      removed: 'removed',
      piecesQueued: 'pieces queued for nesting',
      pieceQueued: 'piece queued for nesting',
      restoreShape: 'Restore shape',

      // ── Feedback banner ──
      feedbackBannerCopy: 'Leave us feedback or suggest an improvement!',
      shareFeedback: 'Share Feedback',

      // ── Drag and drop ──
      dropFilesImport: 'Drop DXF files here to import',
      importedFiles: 'Imported',
      noDxfFound: 'No DXF files found in the drop',
      dragDxfImport: 'Drag DXF files here to import',
    },

    es: {
      // ── Topbar ──
      run: 'Ejecutar',
      stop: 'Detener',
      idle: 'Inactivo',
      running: 'Ejecutando…',
      complete: 'Completado',
      error: 'Error',

      // ── Sidebar ──
      parts: 'Piezas',
      sheets: 'Láminas',
      dropDxfFiles: 'Arrastra archivos DXF aquí',
      removeAllParts: 'Eliminar todas las piezas',
      openDxfFiles: 'Abrir archivos DXF',
      addSheet: 'Agregar Lámina',
      remove: 'Eliminar',

      // ── Canvas ──
      noNestingResult: 'Sin resultado de anidamiento',
      addPartsAndSheets: 'Agrega piezas DXF y láminas, luego presiona <strong>Ejecutar</strong>',
      zoomIn: 'Acercar',
      zoomOut: 'Alejar',
      fitToView: 'Ajustar a la vista',
      sheet: 'Lámina',
      sheetOf: 'de',
      partsLabel: 'piezas',
      utilization: 'Utilización',
      width: 'Ancho',
      preview: 'Vista previa',
      waitingGeometry: 'Esperando geometría',
      partsPlaced: 'piezas colocadas',

      // ── Settings modal ──
      settings: 'Configuración',
      appearance: 'Apariencia',
      language: 'Idioma',
      theme: 'Tema',
      themeDark: 'Oscuro',
      themeLight: 'Claro',
      spacingTolerances: 'Espaciado y tolerancias',
      partSpacing: 'Espaciado entre piezas (mm)',
      sheetMargin: 'Margen de la lámina (mm)',
      rotation: 'Rotación',
      rotationStep: 'Paso de rotación',
      noRotation: 'Sin rotación',
      algorithm: 'Algoritmo',
      earlyStopping: 'Parada anticipada',
      preferredAlignment: 'Alineación preferida',
      alignTop: 'Arriba',
      alignTopLeft: 'Arriba izquierda',
      alignTopRight: 'Arriba derecha',
      alignBottom: 'Abajo',
      alignBottomLeft: 'Abajo izquierda',
      alignBottomRight: 'Abajo derecha',
      timeLimit: 'Tiempo límite',
      seconds: 'segundos',
      randomSeed: 'Semilla aleatoria',
      seed: 'semilla',
      workers: 'Trabajadores',
      threads: 'hilos',
      multiSheetStrategy: 'Estrategia multi-lámina',
      strategyAuto: 'Automático',
      strategyByWidth: 'Por ancho',
      strategyByLength: 'Por longitud',
      strategyByWidthOrLength: 'Por ancho o longitud',
      sketchContourMethod: 'Método de contorno del boceto',
      contourAuto: 'Automático',
      contourArrangement: 'Disposición (JSTS)',
      detectMultipleSketches: 'Detectar múltiples bocetos en un DXF',
      output: 'Salida',
      exportFormat: 'Formato de exportación',
      exportDebug: 'Exportar depuración',
      joinConnectedLinework: 'Unir líneas conectadas',
      engravingLayer: 'Capa de grabado',
      engravingDisabled: 'Deshabilitado',
      engravingFirstLayer: '1ra capa',
      engravingSecondLayer: '2da capa',
      engravingThirdLayer: '3ra capa',
      engravingFourthLayer: '4ta capa',
      engravingFifthLayer: '5ta capa',
      engravingStyle: 'Estilo de grabado',
      fullLabelSingleLine: 'Etiqueta completa (línea simple)',
      fullLabelOutlined: 'Etiqueta completa (contorneada)',
      lastOneChar: 'Último 1 carácter',
      lastTwoChars: 'Últimos 2 caracteres',
      lastThreeChars: 'Últimos 3 caracteres',
      firstOneChar: 'Primer 1 carácter',
      firstTwoChars: 'Primeros 2 caracteres',
      firstThreeChars: 'Primeros 3 caracteres',
      resetDefaults: 'Restablecer valores',
      apply: 'Aplicar',

      // ── Sheet modal ──
      presetSizes: 'Tamaños predefinidos',
      dimensions: 'Dimensiones',
      mode: 'Modo',
      fixedSizeSheet: 'Lámina de tamaño fijo',
      optimizeUpToMaxLength: 'Optimizar hasta longitud máxima',
      unlimitedStripLength: 'Longitud de tira ilimitada',
      widthLabel: 'Ancho',
      lengthLabel: 'Longitud',
      material: 'Material',
      materialPlaceholder: 'ej. Acero dulce 3mm',
      cancel: 'Cancelar',
      saveSheet: 'Guardar Lámina',
      sheetHelpFixed: 'Se usará un tamaño de lámina fijo. El número de láminas necesarias se calcula automáticamente.',
      sheetHelpMax: 'La longitud se trata como máximo. El algoritmo puede usar menos longitud cuando sea posible y calculará automáticamente el número de láminas necesarias y sus dimensiones.',
      sheetHelpUnlimited: 'La tira puede continuar sin un límite de longitud fijo.',

      // ── Sheets pane ──
      noMaterial: 'Sin material',
      autoSheetsContinuous: 'Auto láminas · tira continua',
      autoSheetsLengthCapped: 'Auto láminas · longitud limitada',
      autoSheetsFixedSize: 'Auto láminas · tamaño fijo',
      unlimited: 'Ilimitado',

      // ── Files pane ──
      shapes: 'formas',
      shape: 'forma',
      sketch: 'Boceto',

      // ── Export modal ──
      exportSheets: 'Exportar Láminas',
      avgUtilization: 'Utilización Prom.',
      totalParts: 'Total Piezas',
      totalLength: 'Longitud Total',
      sheetSizeMm: 'Tamaño Lámina (mm)',
      partsColumn: 'Piezas',
      utilizationColumn: 'Utilización',
      usedLength: 'Longitud Usada',
      noFolderSelected: 'Sin carpeta seleccionada',
      chooseFolder: 'Elegir Carpeta',
      exportDXF: 'Exportar DXF',
      exporting: 'Exportando…',
      exported: '✓ Exportado',
      waitingFinalResult: 'Esperando resultado final de Sparrow antes de exportar',
      filesSavedTo: 'archivos guardados en',
      fileSavedTo: 'archivo guardado en',

      // ── Nesting service ──
      addPartsAndSheetsRun: 'Agrega piezas DXF y al menos una lámina, luego presiona Ejecutar.',
      addPartsBeforeRun: 'Agrega una o más piezas DXF antes de ejecutar el anidamiento.',
      addSheetsBeforeRun: 'Agrega al menos una lámina antes de ejecutar el anidamiento.',
      placementDataPrepared: 'Datos de colocación preparados',
      exportFailed: 'Exportación fallida',
      placementRunning: 'Colocación en ejecución…',
      runningWaitingPreview: 'Ejecutando colocación… esperando primera vista previa',
      runFailed: 'Ejecución fallida',
      placementStopped: 'Colocación detenida',

      // ── DXF preview modal ──
      loading: 'Cargando…',
      previewLabel: 'vista previa',
      layers: 'capas',
      layer: 'capa',
      all: 'Todas',
      restore: 'Restaurar',
      removePart: 'Eliminar Pieza',
      applyToJob: 'Aplicar al Trabajo',
      removed: 'eliminada',
      piecesQueued: 'piezas en cola para anidamiento',
      pieceQueued: 'pieza en cola para anidamiento',
      restoreShape: 'Restaurar forma',

      // ── Feedback banner ──
      feedbackBannerCopy: '¡Déjanos tu opinión o sugiere una mejora!',
      shareFeedback: 'Compartir Opinión',

      // ── Drag and drop ──
      dropFilesImport: 'Arrastra archivos DXF aquí para importar',
      importedFiles: 'Importados',
      noDxfFound: 'No se encontraron archivos DXF en la selección',
      dragDxfImport: 'Arrastra archivos DXF aquí para importar',
    },
  };

  let currentLanguage = 'en';

  /**
   * Returns the translated string for the given key in the active language.
   * Falls back to English, then to the raw key if no translation exists.
   */
  function t(key) {
    const lang = TRANSLATIONS[currentLanguage];
    if (lang && key in lang) return lang[key];
    const fallback = TRANSLATIONS.en;
    if (fallback && key in fallback) return fallback[key];
    return key;
  }

  /**
   * Sets the active language. Only 'en' and 'es' are supported.
   * Returns the language actually set (falls back to 'en' for unknown codes).
   */
  function setLanguage(lang) {
    currentLanguage = TRANSLATIONS[lang] ? lang : 'en';
    return currentLanguage;
  }

  /**
   * Returns the current active language code.
   */
  function getLanguage() {
    return currentLanguage;
  }

  const i18nApi = {
    t,
    setLanguage,
    getLanguage,
    TRANSLATIONS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = i18nApi;
  }

  globalScope.NestI18n = i18nApi;
})(typeof window !== 'undefined' ? window : globalThis);
