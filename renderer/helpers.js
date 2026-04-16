'use strict';

/**
 * Pure helpers shared by the renderer.
 *
 * The goal of this module is to hold logic that can be understood in isolation:
 * no DOM access, no Electron bridge calls, and no hidden dependence on global
 * app state. That makes the code easier to test, easier to move around later,
 * and much easier to read when we revisit the project after a while.
 */
(function attachNestHelpers(globalScope) {
  /**
   * Create a short client-side id for temporary UI objects.
   *
   * This is intentionally lightweight. We use it for renderer-side list items,
   * not for anything that needs cryptographic uniqueness.
   */
  function uid() {
    return Math.random().toString(36).slice(2, 9);
  }

  /**
   * Convert a raw byte count into the compact text users expect in file lists.
   *
   * The output is intentionally human-first rather than machine-precise, because
   * it is only shown as quick context in the UI.
   */
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Present a sheet or strip width in meters for the bottom status bar.
   *
   * We keep this forgiving because solver output may occasionally omit width or
   * report a non-positive value while a run is still warming up.
   */
  function formatWidthMeters(mm) {
    if (!Number.isFinite(mm) || mm <= 0) return 'n/a';
    return `${(mm / 1000).toFixed(2)} m`;
  }

  /**
   * Normalize coordinates to a stable precision before we compare or export
   * polygon data.
   *
   * Four decimals has been a good compromise so far: it keeps geometry stable
   * enough for deduplication without inflating exported JSON with noisy digits.
   */
  function roundCoord(value) {
    return Math.round((Number(value) + Number.EPSILON) * 1e4) / 1e4;
  }

  /**
   * Turn a DXF filename into a short engraving-friendly label.
   *
   * Example:
   * `1k.dxf` -> `1k`
   */
  function partLabelFromName(name) {
    return String(name || '').replace(/\.dxf$/i, '').trim();
  }

  /**
   * Convert the rotation step setting from UI text into a usable numeric step.
   *
   * `none` means "do not rotate at all", so we deliberately return `null`
   * instead of a number in that case.
   */
  function normalizeRotationStep(value) {
    if (value === 'none') return null;
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  /**
   * Expand a single rotation step into the list of solver orientations.
   *
   * Example:
   * `90` -> `[0, 90, 180, 270]`
   */
  function buildAllowedOrientations(rotationStepValue) {
    const step = normalizeRotationStep(rotationStepValue);
    if (!step) return [0];

    const orientations = [];
    for (let angle = 0; angle < 360; angle += step) {
      orientations.push(angle);
    }

    if (!orientations.length) return [0];
    return [...new Set(orientations.map(angle => roundCoord(angle)))];
  }

  /**
   * Compare two export points after normalization.
   *
   * We treat points as equal when their rounded coordinates match. That makes
   * duplicate cleanup resilient to tiny parser or transform drift.
   */
  function sameExportPoint(a, b) {
    return !!a && !!b && roundCoord(a.x) === roundCoord(b.x) && roundCoord(a.y) === roundCoord(b.y);
  }

  /**
   * Clean polygon points before they are handed to the nesting solver.
   *
   * This routine intentionally does a few practical repairs:
   * - drops invalid points
   * - removes consecutive duplicates
   * - removes repeated interior vertices
   * - ensures the ring closes cleanly
   *
   * The result is still simple and predictable, which is important because
   * overly clever polygon repair can create geometry that no longer matches the
   * original part.
   */
  function sanitizePolygonPoints(points) {
    if (!Array.isArray(points) || !points.length) return [];

    const normalized = points
      .filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))
      .map(point => ({ x: roundCoord(point.x), y: roundCoord(point.y) }));

    const dedupedConsecutive = [];
    normalized.forEach(point => {
      if (!dedupedConsecutive.length || !sameExportPoint(dedupedConsecutive[dedupedConsecutive.length - 1], point)) {
        dedupedConsecutive.push(point);
      }
    });

    if (dedupedConsecutive.length < 3) return [];

    const isClosed = sameExportPoint(dedupedConsecutive[0], dedupedConsecutive[dedupedConsecutive.length - 1]);
    const openRing = isClosed ? dedupedConsecutive.slice(0, -1) : [...dedupedConsecutive];

    const seen = new Set();
    const uniqueRing = [];
    openRing.forEach(point => {
      const key = `${point.x},${point.y}`;
      if (seen.has(key)) return;
      seen.add(key);
      uniqueRing.push(point);
    });

    if (uniqueRing.length < 3) return [];

    uniqueRing.push({ ...uniqueRing[0] });
    return uniqueRing;
  }

  /**
   * Deep-clone plain JSON-compatible structures.
   *
   * This is intentionally limited: it is perfect for our saved renderer state
   * and export payloads, but not for Dates, Maps, or richer classes.
   */
  function clonePlain(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  /**
   * Calculate the effective quantity for a part file.
   *
   * Once a DXF has been split into shapes, the real demand should come from the
   * visible per-shape quantities rather than the file's old top-level quantity.
   */
  function effectiveFileQty(file) {
    if (Array.isArray(file?.shapes) && file.shapes.length) {
      const visibleTotal = file.shapes
        .filter(shape => shape.visible !== false)
        .reduce((sum, shape) => sum + Math.max(1, parseInt(shape.qty || 1, 10)), 0);
      return Math.max(1, visibleTotal || 0);
    }
    return Math.max(1, parseInt(file?.qty || 1, 10));
  }

  /**
   * Generate a readable job name for exported placement payloads.
   *
   * We preserve the single-file case because it makes debug files and solver
   * folders much easier to recognize. For multi-file jobs we fall back to a
   * timestamped name that stays stable and sortable.
   */
  function buildJobName(files, now = new Date()) {
    if (Array.isArray(files) && files.length === 1 && files[0]?.name) {
      return partLabelFromName(files[0].name);
    }

    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');

    return `nesting-job-${stamp}`;
  }

  globalScope.NestHelpers = {
    uid,
    formatBytes,
    formatWidthMeters,
    roundCoord,
    partLabelFromName,
    normalizeRotationStep,
    buildAllowedOrientations,
    sameExportPoint,
    sanitizePolygonPoints,
    clonePlain,
    effectiveFileQty,
    buildJobName,
  };
})(window);
