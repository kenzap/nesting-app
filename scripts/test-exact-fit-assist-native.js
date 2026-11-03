'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const DxfParser = require('dxf-parser');
const root = path.resolve(__dirname, '..');
const platform = { darwin: 'macos', win32: 'windows' }[process.platform] || process.platform;
const binary = process.argv[2] || path.join(root, 'native', platform, 'bin', process.platform === 'win32' ? 'packing.exe' : 'packing');
const artifactRoot = process.env.EXACT_FIT_TEST_ARTIFACTS || os.tmpdir();
fs.mkdirSync(artifactRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(artifactRoot, 'exact-fit-native-'));

function loadIpc(file, electron, expose = '') {
  const filename = path.join(root, 'main/ipc', file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + expose, {
    module, __dirname: path.dirname(filename), process, console,
    require(name) {
      if (name === 'electron') return electron;
      if (name === '../utils/security-scoped-bookmarks') return { withSecurityScopedAccess: (_, fn) => fn() };
      if (name === '../utils/temp-retention' || name === '../utils/diagnostics') return {};
      return createRequire(filename)(name);
    },
  });
  return module.exports;
}
const collect = loadIpc('sparrow.js', { app: {}, ipcMain: {} }, '\nmodule.exports = { collectSparrowArtifacts, attachRunSheetMetadata };');
let exportDxf;
loadIpc('export-dxf.js', { ipcMain: { handle(_, fn) { exportDxf = fn; } } }).registerExportDxfIpc();

function checkBoxes(boxes, sheetSize, margin) {
  for (const b of boxes) {
    assert.ok(b.x0 >= margin - 1e-6 && b.y0 >= margin - 1e-6 && b.x1 <= sheetSize - margin + 1e-6 && b.y1 <= sheetSize - margin + 1e-6, JSON.stringify(b));
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]; const b = boxes[j];
    assert.ok(Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) <= 1e-6 || Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) <= 1e-6, 'actual overlapping rectangles');
  }
}

async function run(name, { count = 50, expected = 1, mode = 'fixed', margin = 0, spacing = 0, enabled = true, stop = false, align = 'top-left', shared = false, fullSheetPart = false, origin = [0, 0] } = {}) {
  const cwd = path.join(temp, name); fs.mkdirSync(cwd);
  const sheetSize = 400 + margin * 2;
  const w = fullSheetPart ? 400 : 40; const h = fullSheetPart ? 400 : 80;
  const [ox, oy] = origin;
  // Include the repeated closing vertex and offset decimal coordinates typical of DXF imports.
  const points = [[ox + w, oy], [ox, oy], [ox, oy + h], [ox + w, oy + h], [ox + w, oy]];
  const input = { name: 'exact-fit', strip_height: sheetSize,
    items: [{ id: 0, demand: count, allowed_orientations: [0, 90, 180, 270], shape: { type: 'simple_polygon', data: points } }],
    sheets: [{ width: sheetSize, height: sheetSize, width_mode: mode }],
    settings: { sheetMargin: margin, partSpacing: spacing, exactFitAssist: enabled },
  };
  const inputPath = path.join(cwd, 'exact-fit.json'); fs.writeFileSync(inputPath, JSON.stringify(input));
  const stopFile = path.join(cwd, 'stop');
  // Exact-fit construction gets min(15% of global time, 2s), split between
  // exact and slack attempts. Test geometry, not a CI runner's ability to finish
  // the first attempt in 225ms (the old 3s budget), even for multi-sheet jobs.
  const globalTime = stop ? 30 : enabled && spacing === 0 ? 15 : 3;
  const timeoutMs = (globalTime + 30) * 1000;
  const args = ['--input', inputPath, '--global-time', String(globalTime), '--workers', '1', '--rng-seed', '42',
    '--max-strip-length', '400', '--strip-margin', String(margin), '--min-item-separation', String(spacing), '--stop-file', stopFile];
  if (enabled) args.push('--exact-fit-assist');
  if (shared) args.push('--favor-shared-edges');
  if (align !== 'none') args.push(`--align-${align}`);
  const child = spawn(binary, args, { cwd });
  let log = ''; let requestedStop = false; let timedOut = false;
  const capture = chunk => {
    log += chunk;
    if (stop && !requestedStop && log.includes('[EXACT-FIT-ASSIST] retained')) {
      requestedStop = true; fs.writeFileSync(stopFile, 'stop');
    }
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
      child.once('error', reject);
    });
  } finally {
    clearTimeout(timeout);
    fs.writeFileSync(path.join(cwd, 'run.log'),
      `${JSON.stringify({ name, binary, args, timeoutMs, requestedStop, timedOut, exit }, null, 2)}\n\n${log}`);
  }
  const assistLog = log.split(/\r?\n/).filter(line => line.includes('[EXACT-FIT-ASSIST]')).join('\n');
  const diagnostics = `${name}: global budget ${globalTime}s; watchdog ${timeoutMs / 1000}s\n`
    + `Full log: ${path.join(cwd, 'run.log')}\n${assistLog || 'No exact-fit assist status was reported.'}\n${log.slice(-4000)}`;
  assert.ok(!timedOut, `Native helper timed out.\n${diagnostics}`);
  assert.equal(exit.code, 0, `Native helper exited with signal ${exit.signal}.\n${diagnostics}`);
  if (stop) assert.ok(requestedStop, `Stop was never requested.\n${diagnostics}`);
  const artifacts = collect.attachRunSheetMetadata(collect.collectSparrowArtifacts(cwd, 'exact-fit'), cwd, 'exact-fit');
  const strips = artifacts.summary.strips;
  if (expected) assert.equal(strips.length, expected, diagnostics);
  if (enabled && spacing === 0) assert.match(log, /selected validated exact-contact plan/, diagnostics);
  else assert.ok(!log.includes('[EXACT-FIT-ASSIST]'));
  if (enabled && spacing === 0 && count > 50) {
    // Repeated copies must not re-search unchanged full sheets. Check work,
    // rather than elapsed time, so this regression is portable across runners.
    const trial = log.match(new RegExp(`contact trial slack=0\\.0: placed=${count}/${count}, searches=(\\d+), cached_misses=(\\d+)`));
    assert.ok(trial, `Missing complete exact-contact trial.\n${diagnostics}`);
    assert.ok(Number(trial[1]) <= count + expected - 1, `Repeated full-sheet searches.\n${diagnostics}`);
    assert.ok(Number(trial[2]) > 0, `No full-sheet search reuse.\n${diagnostics}`);
  }
  assert.equal(strips.reduce((sum, s) => sum + s.item_count, 0), count);
  assert.ok(strips.every(s => s.svg && s.json_path && !s.is_preview));
  // Check the saved transforms before the DXF writer rounds its vertices.
  for (const strip of strips) {
    const data = JSON.parse(fs.readFileSync(strip.json_path, 'utf8'));
    const boxes = data.solution.layout.placed_items.map(placed => {
      const [tx, ty] = placed.transformation.translation;
      const angle = placed.transformation.rotation * Math.PI / 180;
      const xs = points.map(([x, y]) => x * Math.cos(angle) - y * Math.sin(angle) + tx + margin);
      const ys = points.map(([x, y]) => x * Math.sin(angle) + y * Math.cos(angle) + ty + margin);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    });
    if (enabled && spacing === 0) checkBoxes(boxes, sheetSize, margin);
  }
  const outputDir = path.join(cwd, 'dxf');
  const result = await exportDxf(null, { outputDir, inputPath, strips, jobName: 'exact-fit' });
  assert.equal(result.success, true, result.error);
  let exported = 0;
  for (const file of fs.readdirSync(outputDir).filter(f => f.endsWith('.dxf'))) {
    const dxf = new DxfParser().parseSync(fs.readFileSync(path.join(outputDir, file), 'utf8'));
    const shapes = dxf.entities.filter(e => e.type === 'LWPOLYLINE');
    exported += shapes.length;
    const boxes = shapes.map(shape => {
      assert.ok(shape.shape);
      const xs = shape.vertices.map(v => v.x); const ys = shape.vertices.map(v => v.y);
      const b = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      const dimensions = [b.x1 - b.x0, b.y1 - b.y0].sort((a, b) => a - b);
      assert.ok(Math.abs(dimensions[0] - w) < 1e-6 && Math.abs(dimensions[1] - h) < 1e-6, 'part dimensions changed');
      return b;
    });
    checkBoxes(boxes, sheetSize, margin);
  }
  assert.equal(exported, count);
  console.log(`${name}: ${strips.length} sheet(s), ${exported} unchanged parts exported, bounds/margins and non-overlap verified.`);
}

(async () => {
  await run('fixed');
  await run('maximum-length', { mode: 'max' });
  await run('alignment-none', { align: 'none' });
  await run('shared-edges', { shared: true });
  await run('sheet-margins', { margin: 10 });
  await run('two-sheets', { count: 100, expected: 2 });
  await run('remainder', { count: 101, expected: 3 });
  await run('early-stop', { count: 101, expected: 3, stop: true });
  await run('full-sheet-part', { count: 1, fullSheetPart: true });
  await run('decimal-origin', { origin: [-139.7, -29.2] });
  await run('positive-decimal-origin', { origin: [139.7, 29.2] });
  await run('decimal-origin-four-sheets', { origin: [-139.7, -29.2], count: 200, expected: 4, mode: 'max', shared: true });
  await run('decimal-origin-stop', { origin: [-139.7, -29.2], count: 200, expected: 4, stop: true });
  await run('disabled', { enabled: false, expected: 2 });
  await run('positive-spacing', { spacing: 0.1, expected: 2 });
  fs.rmSync(temp, { recursive: true, force: true });
})().catch(error => {
  fs.writeFileSync(path.join(temp, 'failure.txt'), error.stack || String(error));
  console.error(`Artifacts retained at ${temp}`, error);
  process.exitCode = 1;
});
