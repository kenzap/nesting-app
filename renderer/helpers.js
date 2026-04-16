'use strict';

/**
 * Pure utility functions shared across renderer modules.
 *
 * Nothing here touches the DOM, calls Electron, or reads global state —
 * it's just data-in / data-out logic.  Keeping it that way means any of
 * these can be unit-tested in isolation and safely reused wherever needed
 * without worrying about side effects.
 */
(function attachNestHelpers(globalScope) {
  /**
   * Makes a short random ID for temporary UI list items.
   *
   * Not cryptographically strong — that's fine, we just need something
   * unique enough to key DOM elements within a single session.
   */
  function uid() {
    return Math.random().toString(36).slice(2, 9);
  }

  /**
   * Turns a raw byte number into a readable string like "1.4 MB".
   *
   * Shown next to each file in the sidebar so users can quickly tell if they
   * accidentally loaded a huge file — precision beyond one decimal isn't useful.
   */
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Converts a millimetre width to a "X.XX m" string for the status bar.
   *
   * Gracefully returns "n/a" for missing or zero values — the solver sometimes
   * reports dimensions incrementally while a run is still starting up.
   */
  function formatWidthMeters(mm) {
    if (!Number.isFinite(mm) || mm <= 0) return 'n/a';
    return `${(mm / 1000).toFixed(2)} m`;
  }

  /**
   * Rounds a coordinate to 4 decimal places before any comparison or export.
   *
   * Four decimals is the sweet spot: tight enough to deduplicate near-identical
   * points from parser floating-point noise, loose enough not to bloat JSON
   * with meaningless trailing digits.
   */
  function roundCoord(value) {
    return Math.round((Number(value) + Number.EPSILON) * 1e4) / 1e4;
  }

  /**
   * Strips the ".dxf" extension so the filename can be used as a part label.
   *
   * Example: "bracket_v2.dxf" → "bracket_v2"
   */
  function partLabelFromName(name) {
    return String(name || '').replace(/\.dxf$/i, '').trim();
  }

  /**
   * Parses the "rotation step" dropdown value into a usable number.
   *
   * Returns null for "none" (no rotation allowed) so callers can treat null
   * as a clear off-switch without having to compare strings themselves.
   */
  function normalizeRotationStep(value) {
    if (value === 'none') return null;
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  /**
   * Builds the full list of allowed angles from a single step value.
   *
   * The solver needs an explicit array, not just a step size.
   * Example: step 90 → [0, 90, 180, 270]
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
   * Checks whether two polygon points are the same after rounding.
   *
   * Used during polygon cleanup to detect consecutive duplicates that arose
   * from floating-point drift in the DXF parser or coordinate transforms.
   */
  function sameExportPoint(a, b) {
    return !!a && !!b && roundCoord(a.x) === roundCoord(b.x) && roundCoord(a.y) === roundCoord(b.y);
  }

  /**
   * Cleans up a raw polygon ring before it goes to the solver or export.
   *
   * Does four lightweight repairs in order:
   *  1. Drops any points with non-finite coordinates.
   *  2. Collapses consecutive duplicate points.
   *  3. Removes any point that appears more than once in the ring interior.
   *  4. Re-closes the ring with a clean copy of the first vertex.
   *
   * Intentionally conservative — aggressive "healing" can silently change
   * the shape, which is worse than letting a slightly noisy polygon through.
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
   * Deep-clones any plain JSON-serialisable value.
   *
   * Good enough for state snapshots and export payloads.  Not suitable for
   * objects containing Dates, Maps, Sets or class instances — those lose their
   * type through JSON round-trip.
   */
  function clonePlain(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  /**
   * Figures out how many copies of a part the solver should actually cut.
   *
   * Once a DXF is split into individual shapes, each shape has its own qty
   * and visibility toggle.  The file-level qty becomes stale at that point,
   * so we sum the visible shape quantities instead.
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
   * Creates a human-readable name for a nesting job.
   *
   * Single-file jobs use the filename (e.g. "bracket_v2") so the resulting
   * solver folder is immediately recognisable.  Multi-file jobs get a
   * timestamp-based name that sorts chronologically in the filesystem.
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
