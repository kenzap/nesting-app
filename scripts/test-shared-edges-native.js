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
const binary = process.argv[2] || path.join(root, 'native', platform, 'bin', process.platform === 'win32' ? 'sparrow.exe' : 'sparrow');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-edge-native-'));

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
const collect = loadIpc('sparrow.js', { app: {}, ipcMain: {} },
  '\nmodule.exports = { collectSparrowArtifacts, attachRunSheetMetadata };');
let exportDxf;
loadIpc('export-dxf.js', { ipcMain: { handle(_, fn) { exportDxf = fn; } } }).registerExportDxfIpc();

function rectangle(id, width, height, demand) {
  const points = [[0, 0], [width, 0], [width, height], [0, height]];
  return { id, demand, allowed_orientations: [0, 90], shape: { type: 'simple_polygon', data: points },
    shared_edge_segments: points.map((a, i) => [...a, ...points[(i + 1) % points.length]]) };
}

async function run(name, { mode = 'fixed', strategy = 'barriers', margin = 0, spacing = 0, stop = false, enabled = true } = {}) {
  const cwd = path.join(temp, name);
  fs.mkdirSync(cwd);
  const input = { name: 'contacts', strip_height: 100,
    items: [rectangle(0, 45, 30, 6), rectangle(1, 20, 50, 4)],
    sheets: [{ width: mode === 'unlimited' ? null : 100, height: 100, width_mode: mode }],
    settings: { sheetMargin: margin, partSpacing: spacing, favorSharedEdges: enabled },
  };
  const inputPath = path.join(cwd, 'contacts.json');
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const stopFile = path.join(cwd, 'stop');
  const args = ['--input', inputPath, '--global-time', stop ? '30' : '3', '--workers', '1',
    '--rng-seed', '42', '--min-item-separation', String(spacing), '--strip-margin', String(margin),
    '--align-top-left', '--stop-file', stopFile];
  if (enabled) args.push('--favor-shared-edges');
  if (mode !== 'unlimited') args.push('--max-strip-length', String(100 - margin * 2), '--multi-strip-mode', strategy);
  const child = spawn(binary, args, { cwd });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const timer = stop ? setTimeout(() => fs.writeFileSync(stopFile, 'stop'), 1200) : null;
  const timeout = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  clearTimeout(timeout); if (timer) clearTimeout(timer);
  fs.writeFileSync(path.join(cwd, 'run.log'), log);
  assert.equal(code, 0, `${name}: ${log.slice(-3000)}`);
  if (!enabled) assert.ok(!log.includes('[SHARED-EDGES]'));
  else if (spacing > 0) assert.match(log, /skipped: part spacing must be zero/);
  else if (!stop) assert.match(log, /\[SHARED-EDGES\] accepted/);
  const artifacts = collect.attachRunSheetMetadata(collect.collectSparrowArtifacts(cwd, 'contacts'), cwd, 'contacts');
  const strips = artifacts.summary.strips;
  assert.ok(Number.isFinite(artifacts.summary.total_shared_edge_length_mm), `${name}: missing job total`);
  assert.equal(artifacts.summary.total_shared_edge_length_mm,
    strips.reduce((sum, strip) => sum + strip.shared_edge_length_mm, 0));
  if (spacing > 0) assert.equal(artifacts.summary.total_shared_edge_length_mm, 0);
  assert.ok(strips.every(strip => !strip.is_preview && strip.svg && strip.json_path));
  const counts = [0, 0];
  for (const strip of strips) {
    const data = JSON.parse(fs.readFileSync(strip.json_path));
    assert.ok(Number.isFinite(strip.shared_edge_length_mm) && strip.shared_edge_length_mm >= 0);
    assert.equal(data.shared_edge_length_mm, strip.shared_edge_length_mm);
    for (const placed of data.solution.layout.placed_items) counts[placed.item_id]++;
  }
  assert.deepEqual(counts, [6, 4]);
  const outputDir = path.join(cwd, 'dxf');
  const result = await exportDxf(null, { outputDir, inputPath, strips, jobName: 'contacts' });
  assert.equal(result.success, true, result.error);
  const files = fs.readdirSync(outputDir).filter(name => name.endsWith('.dxf')).sort();
  let exportedCount = 0;
  let exportedSharedLength = 0;
  for (const filename of files) {
    const dxf = new DxfParser().parseSync(fs.readFileSync(path.join(outputDir, filename), 'utf8'));
    const shapes = dxf.entities.filter(e => e.type === 'LWPOLYLINE');
    exportedCount += shapes.length;
    const boxes = shapes.map(e => {
      assert.ok(e.shape, 'part must remain closed');
      const xs = e.vertices.map(v => v.x); const ys = e.vertices.map(v => v.y);
      const b = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      assert.ok(b.x0 >= margin - 0.03 && b.y0 >= margin - 0.03 && b.y1 <= 100 - margin + 0.03, JSON.stringify(b));
      if (mode !== 'unlimited') assert.ok(b.x1 <= 100 - margin + 0.03, JSON.stringify(b));
      return b;
    });
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      const dx = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const dy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      assert.ok(dx < 0.03 || dy < 0.03, 'exported parts overlap');
      // Export rounds coordinates; allow floating-point noise at the contact threshold.
      const contactTolerance = 0.001 + 1e-9;
      if (Math.abs(a.x1 - b.x0) <= contactTolerance || Math.abs(b.x1 - a.x0) <= contactTolerance) {
        exportedSharedLength += Math.max(0, dy);
      }
      if (Math.abs(a.y1 - b.y0) <= contactTolerance || Math.abs(b.y1 - a.y0) <= contactTolerance) {
        exportedSharedLength += Math.max(0, dx);
      }
    }
  }
  assert.equal(exportedCount, 10);
  assert.ok(Math.abs(exportedSharedLength - artifacts.summary.total_shared_edge_length_mm) < 0.1,
    `${name}: native shared length ${artifacts.summary.total_shared_edge_length_mm} does not match exported contacts ${exportedSharedLength}`);
  console.log(`${name}: total shared edges ${artifacts.summary.total_shared_edge_length_mm.toFixed(1)} mm`);
  console.log(`${name}: ${strips.length} sheets, all 10 parts exported within margins, no overlaps; ${log.match(/shared straight-edge gain [\d.]+ mm/g)?.join(', ') || 'finishing pass skipped'}`);
}

(async () => {
  await run('disabled', { enabled: false });
  await run('fixed');
  await run('optimized-margin', { mode: 'max', margin: 5 });
  await run('unlimited', { mode: 'unlimited' });
  await run('prebucket', { strategy: 'prebucket' });
  await run('spacing', { spacing: 2 });
  await run('early-stop', { stop: true });
  fs.rmSync(temp, { recursive: true, force: true });
})().catch(error => { console.error(`Artifacts retained at ${temp}`, error); process.exitCode = 1; });
