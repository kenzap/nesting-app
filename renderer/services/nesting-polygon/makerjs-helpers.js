(function attachNestDxfMakerJsHelpers(global) {
  'use strict';

  const geometry = global.NestDxfGeometry;
  if (!geometry) {
    global.NestDxfMakerJsHelpers = {};
    return;
  }

  // Concaveman is an ESM-only package, and this Electron renderer runs with
  // contextIsolation: true / nodeIntegration: false — so neither `require`
  // nor dynamic `import()` of a bare/file specifier works here. The package
  // is pre-bundled to an IIFE via esbuild (see renderer/vendor/concaveman.js)
  // and loaded through a classic <script> tag in index.html, which attaches
  // it to window.concaveman. resolveConcaveman() just reads that global and
  // returns a settled Promise so the existing async-friendly call sites keep
  // working without change.
  function resolveConcaveman() {
    const lib = global.concaveman;
    if (typeof lib === 'function') return Promise.resolve(lib);
    console.warn('[makerjs-helpers] window.concaveman is not a function — is renderer/vendor/concaveman.js loaded in index.html?');
    return Promise.resolve(null);
  }

  const {
    EPS,
    TWO_PI,
    dist,
    closePointRing,
    bulgeToPoints,
    ellipseToPoints,
    splineToPoints,
    polygonSignedArea,
  } = geometry;

  function resolveMakerJs() {
    if (global.makerjs) return global.makerjs;
    const candidates = [
      () => (typeof require === 'function' ? require('makerjs') : null),
      () => (typeof global.require === 'function' ? global.require('makerjs') : null),
      () => (global.module && typeof global.module.require === 'function' ? global.module.require('makerjs') : null),
    ];
    for (const candidate of candidates) {
      try {
        const resolved = candidate();
        if (resolved) {
          global.makerjs = resolved;
          return resolved;
        }
      } catch (error) {
        // Ignore resolution failures here. Callers can report unavailability.
      }
    }
    return null;
  }

  function radToDeg(angle) {
    return angle * 180 / Math.PI;
  }

  function normalizeArcDegrees(startDeg, endDeg, ccw = true) {
    let start = Number(startDeg) || 0;
    let end = Number(endDeg) || 0;
    if (ccw) {
      while (end <= start + 1e-9) end += 360;
    } else {
      while (start <= end + 1e-9) start += 360;
    }
    return { start, end };
  }

  function toMakerPoint(point) {
    return [point.x, point.y];
  }

  function dedupePoints(points, tolerance) {
    const deduped = [];
    (points || []).forEach(point => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      if (!deduped.length || dist(deduped[deduped.length - 1], point) > tolerance) {
        deduped.push({ x: point.x, y: point.y });
      }
    });
    return deduped;
  }

  function addPath(model, pathId, path) {
    if (!model.paths) model.paths = {};
    model.paths[pathId] = path;
  }

  function linePathFromPoints(makerjs, start, end) {
    return new makerjs.paths.Line(toMakerPoint(start), toMakerPoint(end));
  }

  function createPolylineFromPoints(makerjs, points, model, idPrefix, closed = false, tolerance = EPS) {
    const deduped = dedupePoints(points, tolerance);
    if (deduped.length < 2) return 0;
    let count = 0;
    for (let i = 0; i < deduped.length - 1; i++) {
      if (dist(deduped[i], deduped[i + 1]) <= tolerance) continue;
      addPath(model, `${idPrefix}_line_${count++}`, linePathFromPoints(makerjs, deduped[i], deduped[i + 1]));
    }
    if (closed && deduped.length > 2 && dist(deduped[deduped.length - 1], deduped[0]) > tolerance) {
      addPath(model, `${idPrefix}_line_${count++}`, linePathFromPoints(makerjs, deduped[deduped.length - 1], deduped[0]));
    }
    return count;
  }

  function sampleBulgeArc(v1, v2, bulge, tolerance) {
    if (!v1 || !v2 || Math.abs(bulge || 0) <= EPS) return [v1, v2].filter(Boolean);
    const stepDegrees = Math.max(4, Math.min(12, Math.round((Math.max(tolerance, 0.25) / Math.max(dist(v1, v2), EPS)) * 180)));
    return [
      { x: v1.x, y: v1.y },
      ...bulgeToPoints(v1, v2, bulge, stepDegrees),
    ];
  }

  function isClosedEllipse(entity) {
    const start = entity?.startParameter ?? entity?.startAngle ?? 0;
    const end = entity?.endParameter ?? entity?.endAngle ?? TWO_PI;
    return Math.abs(Math.abs(end - start) - TWO_PI) < 1e-4 || Math.abs((end - start) % TWO_PI) < 1e-4;
  }

  function sampleSpline(entity, tolerance) {
    const raw = splineToPoints(entity) || [];
    const sampled = dedupePoints(raw, Math.max(tolerance, EPS));
    if (entity?.closed && sampled.length > 2) return closePointRing(sampled);
    return sampled;
  }

  function sampleEllipse(entity, tolerance) {
    const raw = ellipseToPoints(entity, isClosedEllipse(entity)) || [];
    return dedupePoints(raw, Math.max(tolerance, EPS));
  }

  function segmentBulge(v1, closed) {
    if (!v1) return 0;
    if (!closed && !Number.isFinite(v1.bulge)) return 0;
    return Number.isFinite(v1.bulge) ? v1.bulge : 0;
  }

  function convertLineSimple(entity, model, pathId, makerjs) {
    const start = entity?.vertices?.[0] || entity?.start || null;
    const end = entity?.vertices?.[1] || entity?.end || null;
    if (!start || !end || dist(start, end) <= EPS) return 0;
    addPath(model, pathId, linePathFromPoints(makerjs, start, end));
    return 1;
  }

  function convertLine(entity, model, pathId, makerjs, options) {
    
    const start = entity?.vertices?.[0] || entity?.start || null;
    const end = entity?.vertices?.[1] || entity?.end || null;
    if (!start || !end || dist(start, end) <= EPS) return 0;

    // Determine sampling step (default: no sampling, just endpoints)
    const samplingDist = options.lineSamplingDistance || 0;
    const totalLen = dist(start, end);
    
    if (samplingDist <= 0 || totalLen <= samplingDist) {
      // Add single line
      addPath(model, pathId, linePathFromPoints(makerjs, start, end));
      return 1;
    }
    
    // Calculate number of segments (at least 1)
    const numSegments = Math.max(1, Math.ceil(totalLen / samplingDist));
    const step = 1 / numSegments;
    let pathCount = 0;
    
    let prev = start;
    for (let i = 1; i <= numSegments; i++) {
      const t = i * step;
      const curr = {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      };
      addPath(model, `${pathId}_seg${i}`, linePathFromPoints(makerjs, prev, curr));
      pathCount++;
      prev = curr;
    }
    return pathCount;
  }

  function convertArcSimple(entity, model, pathId, makerjs, options) {
    if (!entity?.center || !Number.isFinite(entity.radius) || entity.radius <= EPS) return 0;
    const startDeg = radToDeg(entity.startAngle || 0);
    const endDeg = radToDeg(entity.endAngle || 0);
    const normalized = normalizeArcDegrees(startDeg, endDeg, true);
    addPath(
      model,
      pathId,
      new makerjs.paths.Arc(
        toMakerPoint(entity.center),
        entity.radius,
        normalized.start,
        normalized.end
      )
    );
    return 1;
  }

  function convertArc(entity, model, pathId, makerjs, options) {
    if (!entity?.center || !Number.isFinite(entity.radius) || entity.radius <= EPS) return 0;

    const arcSamplingAngle = options.arcSamplingAngle; // degrees, e.g. 5
    if (arcSamplingAngle && arcSamplingAngle > 0) {
      // Sample points along the arc
      const center = entity.center;
      const radius = entity.radius;
      let startDeg = radToDeg(entity.startAngle || 0);
      let endDeg = radToDeg(entity.endAngle || 0);
      const normalized = normalizeArcDegrees(startDeg, endDeg, true);
      startDeg = normalized.start;
      endDeg = normalized.end;
      const angleRange = endDeg - startDeg; // positive, CCW
      const numSteps = Math.max(1, Math.ceil(angleRange / arcSamplingAngle));
      const points = [];
      for (let i = 0; i <= numSteps; i++) {
        const angleDeg = startDeg + (angleRange * i / numSteps);
        const angleRad = angleDeg * Math.PI / 180;
        const x = center.x + radius * Math.cos(angleRad);
        const y = center.y + radius * Math.sin(angleRad);
        points.push({ x, y });
      }
      // Create polyline from sampled points (no closing line, arc is open)
      return createPolylineFromPoints(makerjs, points, model, pathId, false, EPS);
    } else {
      // Original behavior: add native Arc path
      const startDeg = radToDeg(entity.startAngle || 0);
      const endDeg = radToDeg(entity.endAngle || 0);
      const normalized = normalizeArcDegrees(startDeg, endDeg, true);
      addPath(
        model,
        pathId,
        new makerjs.paths.Arc(
          toMakerPoint(entity.center),
          entity.radius,
          normalized.start,
          normalized.end
        )
      );
      return 1;
    }
  }

  function convertCircleSimple(entity, model, pathId, makerjs) {
    if (!entity?.center || !Number.isFinite(entity.radius) || entity.radius <= EPS) return 0;
    addPath(model, pathId, new makerjs.paths.Circle(toMakerPoint(entity.center), entity.radius));
    return 1;
  }

  function convertCircle(entity, model, pathId, makerjs, options) {
    if (!entity?.center || !Number.isFinite(entity.radius) || entity.radius <= EPS) return 0;

    const circleSamplingAngle = options.circleSamplingAngle; // degrees, e.g. 5
    if (circleSamplingAngle && circleSamplingAngle > 0) {
      // Sample points around the full circle
      const center = entity.center;
      const radius = entity.radius;
      const numSteps = Math.max(3, Math.ceil(360 / circleSamplingAngle));
      const points = [];
      for (let i = 0; i <= numSteps; i++) {
        const angleDeg = i * 360 / numSteps;
        const angleRad = angleDeg * Math.PI / 180;
        const x = center.x + radius * Math.cos(angleRad);
        const y = center.y + radius * Math.sin(angleRad);
        points.push({ x, y });
      }
      // Closed polyline (full loop)
      return createPolylineFromPoints(makerjs, points, model, pathId, true, EPS);
    } else {
      // Original behavior: add native Circle path
      addPath(model, pathId, new makerjs.paths.Circle(toMakerPoint(entity.center), entity.radius));
      return 1;
    }
  }

  function convertLWPolylineSimple(entity, model, idx, makerjs, options) {
    const vertices = Array.isArray(entity?.vertices) ? entity.vertices : [];
    const closed = entity?.closed !== false;
    if (vertices.length < 2) return 0;

    let pathCount = 0;
    const segmentCount = closed ? vertices.length : vertices.length - 1;

    for (let i = 0; i < segmentCount; i++) {
      const v1 = vertices[i];
      const v2 = vertices[(i + 1) % vertices.length];
      if (!v1 || !v2 || dist(v1, v2) <= EPS) continue;
      const bulge = segmentBulge(v1, closed);
      if (Math.abs(bulge) <= EPS) {
        addPath(model, `${idx}_line_${i}`, linePathFromPoints(makerjs, v1, v2));
        pathCount += 1;
        continue;
      }

      pathCount += createPolylineFromPoints(
        makerjs,
        sampleBulgeArc(v1, v2, bulge, options.splineTolerance),
        model,
        `${idx}_approx_${i}`,
        false,
        options.splineTolerance
      );
    }

    return pathCount;
  }

  function convertLWPolyline(entity, model, idx, makerjs, options) {
    const vertices = Array.isArray(entity?.vertices) ? entity.vertices : [];
    const closed = entity?.closed !== false;
    if (vertices.length < 2) return 0;

    let pathCount = 0;
    const segmentCount = closed ? vertices.length : vertices.length - 1;

    // Get sampling parameters (with sensible defaults)
    const lineSamplingDist = options.lineSamplingDistance || 0;
    const arcSamplingAngle = options.arcSamplingAngle; // in degrees

    for (let i = 0; i < segmentCount; i++) {
      const v1 = vertices[i];
      const v2 = vertices[(i + 1) % vertices.length];
      if (!v1 || !v2 || dist(v1, v2) <= EPS) continue;
      const bulge = segmentBulge(v1, closed);

      // ---------- Straight segment (bulge ≈ 0) ----------
      if (Math.abs(bulge) <= EPS) {
        if (lineSamplingDist > 0) {
          // Sample the line into multiple points
          const totalLen = dist(v1, v2);
          const numSegments = Math.max(1, Math.ceil(totalLen / lineSamplingDist));
          const points = [v1];
          for (let s = 1; s <= numSegments; s++) {
            const t = s / numSegments;
            points.push({
              x: v1.x + (v2.x - v1.x) * t,
              y: v1.y + (v2.y - v1.y) * t,
            });
          }
          pathCount += createPolylineFromPoints(
            makerjs,
            points,
            model,
            `${idx}_line_${i}`,
            false,
            EPS
          );
        } else {
          // Original behaviour: single line
          addPath(model, `${idx}_line_${i}`, linePathFromPoints(makerjs, v1, v2));
          pathCount += 1;
        }
        continue;
      }

      // ---------- Arc segment (bulge != 0) ----------
      let sampledPoints;
      if (arcSamplingAngle && arcSamplingAngle > 0) {
        // Use explicit angular step
        const stepDeg = arcSamplingAngle;
        sampledPoints = bulgeToPoints(v1, v2, bulge, stepDeg);
        // Ensure endpoints are included
        if (sampledPoints[0] !== v1) sampledPoints.unshift(v1);
        if (sampledPoints[sampledPoints.length - 1] !== v2) sampledPoints.push(v2);
      } else {
        // Fallback to original method (uses splineTolerance to compute step)
        sampledPoints = sampleBulgeArc(v1, v2, bulge, options.splineTolerance);
      }
      pathCount += createPolylineFromPoints(
        makerjs,
        sampledPoints,
        model,
        `${idx}_approx_${i}`,
        false,
        options.splineTolerance
      );
    }

    return pathCount;
  }

  function convertEllipse(entity, model, idx, makerjs, options) {
    const points = sampleEllipse(entity, options.splineTolerance);
    return createPolylineFromPoints(
      makerjs,
      points,
      model,
      `${idx}_ellipse`,
      isClosedEllipse(entity),
      options.splineTolerance
    );
  }

  function convertSpline(entity, model, idx, makerjs, options) {
    const points = sampleSpline(entity, options.splineTolerance);
    return createPolylineFromPoints(
      makerjs,
      points,
      model,
      `${idx}_spline`,
      !!entity?.closed,
      options.splineTolerance
    );
  }

  function convertDXFToMakerJs(dxfData, rawOptions = {}) {
    const makerjs = resolveMakerJs();
    if (!makerjs) return { available: false, model: null, pathCount: 0 };

    // Attached synchronously by renderer/vendor/concaveman.js via <script>
    // tag in index.html. May be undefined if that tag is missing — callers
    // then fall back to the closed/bridged chain logic.
    const concaveman = global.concaveman;

    const options = {
      approximateSplines: false,
      splineTolerance: 0.1,
      preserveBulgeArcs: true,
      lineSamplingDistance: 1,       // for straight lines
      arcSamplingAngle: 1,           // degrees, for arcs
      circleSamplingAngle: 1,        // degrees, for circles
      ...rawOptions,
    };
    const model = { paths: {}, models: {} };
    let pathCount = 0;

    console.log("Entities", dxfData?.entities);

    (dxfData?.entities || []).forEach((entity, idx) => {
      switch (entity?.type) {
        case 'LINE':
          pathCount += convertLine(entity, model, entity.handle || `line_${idx}`, makerjs, options);
          break;
        case 'ARC':
          pathCount += convertArc(entity, model, entity.handle || `arc_${idx}`, makerjs, options);
          break;
        case 'CIRCLE':
          pathCount += convertCircle(entity, model, entity.handle || `circle_${idx}`, makerjs, options);
          break;
        case 'LWPOLYLINE':
        case 'POLYLINE':
          pathCount += convertLWPolyline(entity, model, entity.handle || `poly_${idx}`, makerjs, options);
          break;
        case 'SPLINE':
          if (options.approximateSplines) {
            pathCount += convertSpline(entity, model, entity.handle || `spline_${idx}`, makerjs, options);
          }
          break;
        case 'ELLIPSE':
          pathCount += convertEllipse(entity, model, entity.handle || `ellipse_${idx}`, makerjs, options);
          break;
        default:
          break;
      }
    });

    return {
      available: true,
      concaveman,
      makerjs,
      model,
      pathCount,
    };
  }

  function makerPointToPoint(point) {
    return {
      x: Array.isArray(point) ? point[0] : point?.x,
      y: Array.isArray(point) ? point[1] : point?.y,
    };
  }

  function chainToPoints(chain, makerjs, maxArcFacet) {
    const points = makerjs.chain.toKeyPoints(chain, maxArcFacet) || [];
    return dedupePoints(points.map(makerPointToPoint), EPS);
  }

  function polylineLength(points) {
    let length = 0;
    for (let i = 0; i < (points?.length || 0) - 1; i++) {
      length += dist(points[i], points[i + 1]);
    }
    return length;
  }

  function maybeClosePoints(points, gapTolerance) {
    const deduped = dedupePoints(points, EPS);
    if (deduped.length < 3) return null;
    const gap = dist(deduped[0], deduped[deduped.length - 1]);
    if (gap > gapTolerance) return null;
    return {
      polygonPoints: closePointRing(deduped),
      closureGap: gap,
    };
  }

  function reversePoints(points) {
    return [...(points || [])].reverse().map(point => ({ x: point.x, y: point.y }));
  }

  function mergePointSets(leftPoints, rightPoints, leftSide, rightSide) {
    const left = leftSide === 'start' ? reversePoints(leftPoints) : [...leftPoints];
    const right = rightSide === 'end' ? reversePoints(rightPoints) : [...rightPoints];
    return dedupePoints([...left, ...right], EPS);
  }

  function connectOpenChains(openChains, gapTolerance) {
    const groups = (openChains || [])
      .map(chain => ({
        chainIndices: [chain.chainIndex],
        points: dedupePoints(chain.points, EPS),
        pathLength: chain.pathLength || polylineLength(chain.points),
        mergeCount: 0,
      }))
      .filter(group => group.points.length >= 2);

    const stitchedCandidates = [];
    let working = groups;

    while (working.length > 1) {
      let best = null;
      for (let i = 0; i < working.length; i++) {
        for (let j = i + 1; j < working.length; j++) {
          const left = working[i];
          const right = working[j];
          const pairs = [
            { leftSide: 'end', rightSide: 'start', distance: dist(left.points[left.points.length - 1], right.points[0]) },
            { leftSide: 'end', rightSide: 'end', distance: dist(left.points[left.points.length - 1], right.points[right.points.length - 1]) },
            { leftSide: 'start', rightSide: 'start', distance: dist(left.points[0], right.points[0]) },
            { leftSide: 'start', rightSide: 'end', distance: dist(left.points[0], right.points[right.points.length - 1]) },
          ];
          pairs.forEach(pair => {
            if (!Number.isFinite(pair.distance) || pair.distance > gapTolerance) return;
            if (!best || pair.distance < best.distance - EPS) {
              best = { ...pair, leftIndex: i, rightIndex: j };
            }
          });
        }
      }

      if (!best) break;

      const left = working[best.leftIndex];
      const right = working[best.rightIndex];
      const mergedPoints = mergePointSets(left.points, right.points, best.leftSide, best.rightSide);
      const merged = {
        chainIndices: [...left.chainIndices, ...right.chainIndices],
        points: mergedPoints,
        pathLength: polylineLength(mergedPoints),
        mergeCount: left.mergeCount + right.mergeCount + 1,
      };
      const closed = maybeClosePoints(merged.points, gapTolerance);
      if (closed) {
        stitchedCandidates.push({
          chainIndices: merged.chainIndices,
          pathLength: merged.pathLength,
          mergeCount: merged.mergeCount,
          closureGap: closed.closureGap,
          polygonPoints: closed.polygonPoints,
        });
      }

      working = working.filter((_, index) => index !== best.leftIndex && index !== best.rightIndex);
      working.push(merged);
    }

    return stitchedCandidates;
  }

  function buildMakerJsChains(dxfData, rawOptions = {}) {
    let options = {
      alpha: 2000,           // bridges gaps ~600 but not huge empty spaces
      maxArcFacet: 1,
      gapTolerance: 1,
      minAreaRatio: 0.01,   // NEW: ignore candidates smaller than this fraction of total bounding area
      ...rawOptions,
    };

    // Note: resolveConcaveman() is kicked off at script-attach time (see the
    // IIFE top). By the time a user triggers a DXF preview the ESM import is
    // almost always resolved. If it's still pending, concavemanLib is null
    // and we simply skip the concaveman branch — the closed/bridged chain
    // fallback below still produces valid candidates.

    const converted = convertDXFToMakerJs(dxfData, options);
    if (!converted.available || !converted.model || !converted.pathCount) {
      return {
        available: converted.available,
        makerjs: converted.makerjs || null,
        concaveman: converted.concaveman || null,
        model: converted.model || null,
        chains: [],
        candidates: [],
        pathCount: converted.pathCount || 0,
      };
    }

    const makerjs = converted.makerjs;
    const concaveman = converted.concaveman;
    let chains = [];
    try {
      chains = typeof makerjs.model.findChains === 'function'
        ? (makerjs.model.findChains(converted.model) || [])
        : [];
    } catch (error) {
      return {
        available: true,
        makerjs,
        model: converted.model,
        chains: [],
        candidates: [],
        pathCount: converted.pathCount,
        error: error?.message || String(error),
      };
    }

    const chainEntries = (Array.isArray(chains) ? chains : [])
      .map((chain, chainIndex) => {
        const points = chainToPoints(chain, makerjs, options.maxArcFacet);
        if (points.length < 2) return null;
        const closureGap = points.length >= 2 ? dist(points[0], points[points.length - 1]) : Infinity;
        return {
          chainIndex,
          endless: !!chain?.endless,
          points,
          pathLength: chain?.pathLength || polylineLength(points),
          closureGap,
          linkCount: chain?.links?.length || 0,
        };
      })
      .filter(Boolean);

    const candidates = [];

    // chainEntries.forEach(entry => {
    //   if (entry.endless) {
    //     const polygonPoints = closePointRing(entry.points);
    //     const area = Math.abs(polygonSignedArea(polygonPoints.slice(0, -1)));
    //     if (polygonPoints.length >= 4 && area > EPS) {
    //       candidates.push({
    //         source: 'makerjs-chain-closed',
    //         chainIndex: entry.chainIndex,
    //         chainIndices: [entry.chainIndex],
    //         pathLength: entry.pathLength,
    //         linkCount: entry.linkCount,
    //         mergeCount: 0,
    //         closureGap: 0,
    //         polygonPoints,
    //         area,
    //       });
    //     }
    //     return;
    //   }

    //   const bridged = maybeClosePoints(entry.points, options.gapTolerance);
    //   if (!bridged) return;
    //   const area = Math.abs(polygonSignedArea(bridged.polygonPoints.slice(0, -1)));
    //   if (area <= EPS) return;
    //   candidates.push({
    //     source: 'makerjs-chain-bridged',
    //     chainIndex: entry.chainIndex,
    //     chainIndices: [entry.chainIndex],
    //     pathLength: entry.pathLength,
    //     linkCount: entry.linkCount,
    //     mergeCount: 0,
    //     closureGap: bridged.closureGap,
    //     polygonPoints: bridged.polygonPoints,
    //     area,
    //   });
    // });

    // console.log({chainEntries:chainEntries, candidates: candidates})

    // After building chainEntries, collect ALL points from ALL chains
    const allPoints = [];
    chainEntries.forEach(entry => {
      entry.points.forEach(p => allPoints.push([p.x, p.y])); // concaveman expects [x,y] arrays
    });

    let outerCandidate = null;

    if (typeof concaveman !== 'function') { console.log("concaveman not found"); }

    // If concaveman is available, use it for a precise concave hull
    if (typeof concaveman === 'function' && allPoints.length >= 3) {

      // const integerPoints = allPoints.map(point => [
      //   Math.round(point[0]),
      //   Math.round(point[1])
      // ]);

      // console.log("integerPoints", integerPoints);
      
      // concaveman(points, concavity = 2, lengthThreshold = 0)
      // concavity: 1 = convex hull, higher = more concave (2–5 typical)
      const hullPoints = concaveman(allPoints, 1, 5);
      
      // console.log("hullPoints", hullPoints);
      if (hullPoints && hullPoints.length >= 3) {
        const polygon = hullPoints.map(p => ({ x: p[0], y: p[1] }));
        const closedPolygon = closePointRing(polygon);
        const area = Math.abs(polygonSignedArea(closedPolygon.slice(0, -1)));
        if (area > EPS) {
          outerCandidate = {
            source: 'concaveman',
            chainIndices: [],
            pathLength: polylineLength(closedPolygon),
            mergeCount: 0,
            closureGap: 0,
            polygonPoints: closedPolygon,
            area: area,
          };
        }

        console.log("concaveman", outerCandidate);
      }
    }

    // If concaveman succeeded, use it as the primary candidate
    if (outerCandidate) {
      candidates.push(outerCandidate);
    } else {
      // Fallback to your existing closed/bridged chain logic (unchanged)
      // ... (keep your existing candidate generation)
    }

    // Then sort by area descending (largest first)
    candidates.sort((a,b) => (b.area || 0) - (a.area || 0));

    // --- NEW: Compute total bounding area for minAreaRatio filter ---
    let totalBoundingArea = 0;
    if (chainEntries.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      chainEntries.forEach(entry => {
        entry.points.forEach(p => {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        });
      });
      totalBoundingArea = (maxX - minX) * (maxY - minY);
    }

    // --- FILTER candidates: remove tiny internal holes based on area ---
    const filteredCandidates = candidates.filter(candidate => {
      if (totalBoundingArea > 0 && options.minAreaRatio > 0) {
        const minAllowedArea = totalBoundingArea * options.minAreaRatio;
        if (candidate.area < minAllowedArea && candidate.area < 100) { // 100 is absolute sanity threshold
          return false;
        }
      }
      return true;
    });

    // --- SORT: largest area FIRST (outer contour for nesting) ---
    filteredCandidates.sort((left, right) => {
      const areaDiff = (right.area || 0) - (left.area || 0);
      if (Math.abs(areaDiff) > EPS) return areaDiff;
      // Tie‑breakers (only when areas are almost equal)
      const gapDiff = (left.closureGap || 0) - (right.closureGap || 0);
      if (Math.abs(gapDiff) > EPS) return gapDiff;
      const mergeDiff = (left.mergeCount || 0) - (right.mergeCount || 0);
      if (mergeDiff !== 0) return mergeDiff;
      return (right.pathLength || 0) - (left.pathLength || 0);
    });

    return {
      available: true,
      makerjs,
      model: converted.model,
      chains: chainEntries,
      candidates: filteredCandidates,
      pathCount: converted.pathCount,
    };
  }

  // --- Additional helper to directly get the outer nesting contour ---
  function getOuterNestingContour(dxfData, options = {}) {

    const result = buildMakerJsChains(dxfData, options);
    if (!result.available || !result.candidates || result.candidates.length === 0) {
      return null;
    }
    
    // The first candidate is the largest area → outer boundary
    const outer = result.candidates[0];
    return {
      polygonPoints: outer.polygonPoints,
      area: outer.area,
      source: outer.source,
      closureGap: outer.closureGap,
      chainIndices: outer.chainIndices,
    };

    
  }

  global.NestDxfMakerJsHelpers = {
    resolveConcaveman,
    resolveMakerJs,
    convertDXFToMakerJs,
    buildMakerJsChains,
    getOuterNestingContour,   // NEW: convenience function for nesting
    sampleSpline,
    sampleEllipse,
    createPolylineFromPoints,
  };
})(window);
