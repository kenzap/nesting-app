'use strict';

const { parentPort, workerData } = require('worker_threads');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Flatten = require('@flatten-js/core');
const packages = require('../../shared/cutout-packages');
const { removeTempPath } = require('../utils/safe-file-operations');

function polygon(points) {
  const ring = points.map(([x, y]) => new Flatten.Point(x, y));
  if (ring[0].equalTo(ring[ring.length - 1])) ring.pop();
  const poly = new Flatten.Polygon(ring);
  if (!poly.isValid() || poly.area() <= 0.001) throw new Error('Invalid cutout geometry');
  return poly;
}

function validate(request, result) {
  const hole = polygon(request.hole), parent = polygon(request.parent);
  if (Flatten.BooleanOperations.subtract(hole, parent).area() > 1e-7 || hole.area() >= parent.area()) {
    throw new Error('Cutout is not contained in its parent');
  }
  for (const other of request.other_holes || []) {
    if (Flatten.BooleanOperations.intersect(hole, polygon(other)).area() > 1e-7) {
      throw new Error('Overlapping cutouts are not supported');
    }
  }
  if (!Array.isArray(result.placements) || result.placements.length > 64) throw new Error('Invalid cutout result');
  const counts = new Map(), shapes = [];
  for (const placement of result.placements) {
    const item = request.items.find(item => item.id === placement.item_id);
    const t = placement.transformation;
    if (!item || !t || !Number.isFinite(t.rotation) || !Array.isArray(t.translation)
        || t.translation.length !== 2 || !t.translation.every(Number.isFinite)
        || !packages.allows(item.allowed_orientations, t.rotation)) throw new Error('Invalid cutout placement');
    counts.set(item.id, (counts.get(item.id) || 0) + 1);
    if (counts.get(item.id) > item.demand) throw new Error('Cutout quantity exceeded');
    const shape = polygon(packages.transform(item.shape.data, t));
    if (Flatten.BooleanOperations.subtract(shape, hole).area() > 1e-7) throw new Error('Part outside cutout');
    // Native search uses a small safety allowance; validate original double-precision rings too.
    if (shape.distanceTo(hole)[0] + 0.001 < request.spacing) throw new Error('Cutout clearance too small');
    for (const previous of shapes) {
      if (Flatten.BooleanOperations.intersect(shape, previous).area() > 1e-7
          || shape.distanceTo(previous)[0] + 0.001 < request.spacing) throw new Error('Cutout parts collide');
    }
    shapes.push(shape);
  }
  return result;
}

async function run() {
  let directory;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parentPort.on('message', cancel);
  try {
    const { request, executable } = workerData;
    if (!request || !Array.isArray(request.items) || request.items.length > 32
        || request.hole?.length > 1024 || request.parent?.length > 1024
        || !Number.isFinite(request.spacing) || request.spacing < 0
        || JSON.stringify(request).length > 1024 * 1024) throw new Error('Invalid cutout request');
    directory = workerData.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'nest-cutout-'));
    const input = path.join(directory, 'input.json');
    fs.writeFileSync(input, JSON.stringify({ ...request, spacing: request.spacing + 0.02 }));
    const stdout = await new Promise((resolve, reject) => execFile(executable, ['--cutout', '-i', input], {
      cwd: directory, timeout: 2500, killSignal: 'SIGKILL', signal: controller.signal,
      windowsHide: true, maxBuffer: 1024 * 1024,
    }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const result = validate(request, JSON.parse(stdout));
    parentPort.postMessage({ success: true, ...result });
  } catch (error) {
    parentPort.postMessage({ success: false, error: String(error.message).slice(0, 500) });
  } finally {
    parentPort.off('message', cancel);
    if (directory) await removeTempPath(directory);
  }
}
run();
