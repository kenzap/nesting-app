'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'main/ipc/sparrow.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'packing-name-test-'));
const metadata = require('../package.json');

async function checkLaunch(platform, packaged, available = true) {
  const directory = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform];
  const filename = platform === 'win32' ? 'packing.exe' : 'packing';
  const resourcesPath = path.join(temp, directory, 'Resources');
  const baseDir = packaged
    ? platform === 'darwin' ? path.join(resourcesPath, '..', 'Helpers')
      : path.join(resourcesPath, 'native', directory, 'bin')
    : path.join(root, 'native', directory, 'bin');
  const expected = path.join(baseDir, filename);
  const handlers = new Map();
  const messages = [];
  let spawned;
  let cutoutResolver;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 123;
  const module = { exports: {} };
  const realRequire = createRequire(sourcePath);
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    module, __dirname: path.dirname(sourcePath),
    console: { info: (...args) => messages.push(args.join(' ')) },
    process: { platform, resourcesPath, argv: [], env: {
      PACKING_CARGO_MANIFEST_PATH: path.join(root, 'package.json'),
    } },
    require(name) {
      if (name === 'electron') return {
        app: { isPackaged: packaged, on() {}, getPath: () => temp },
        ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
      };
      if (name === 'fs') return { ...fs, statSync(file) {
        return file === expected ? { mtimeMs: 1 } : fs.statSync(file);
      }, existsSync(file) {
        if (file === expected) return available;
        if (file === baseDir) return true;
        return fs.existsSync(file);
      } };
      if (name === 'child_process') return { execFile(file, args, options, callback) {
        assert.equal(file, expected);
        assert.equal(args[0], '--help');
        callback(null, '--exact-fit-assist');
      }, spawn(file, args, options) {
        spawned = { file, args, options };
        return child;
      } };
      if (name === '../utils/temp-retention') return { cleanupTempArtifacts() {} };
      if (name === '../utils/diagnostics') return { logDiagnostic() {}, stderrTail: text => text };
      if (name === './cutouts') return {
        registerCutoutIpc: (_, resolve) => { cutoutResolver = resolve; },
        supportsCutouts: async file => { assert.equal(file, expected); return available; },
      };
      return realRequire(name);
    },
  });
  module.exports.registerSparrowIpc();
  const info = await handlers.get('get-native-engine-info')();
  assert.equal(info.success, true, info.error);
  assert.equal(info.supportsExactFitAssist, available);
  assert.equal(info.packingPath, expected);
  assert.equal(info.sparrowPath, expected, 'legacy API field remains compatible');
  assert.equal(info.exists.packing, available);
  assert.equal(info.exists.sparrow, available);
  assert.equal(cutoutResolver('packing'), expected);
  const result = await handlers.get('run-sparrow')(null, { name: 'rename-test', items: [] });
  if (!available) {
    assert.equal(result.success, false);
    assert.match(result.error, /Packing executable not found/);
    assert.equal(spawned, undefined);
    return;
  }
  assert.equal(result.success, true);
  assert.equal(spawned.file, expected);
  assert.equal(spawned.args.includes('--stop-file'), platform === 'win32');
  if (!packaged) {
    const log = messages.find(line => line.includes('Cargo command:'));
    assert.match(log, /["']--bin["'] ["']packing["']/);
    assert.ok(!log.includes("'sparrow'"));
  }
  child.emit('close', 0, null);
  const final = await handlers.get('poll-sparrow')(null, result.runId);
  assert.equal(final.status, 'completed');
}

(async () => {
  try {
    for (const platform of ['darwin', 'win32', 'linux']) {
      for (const packaged of [false, true]) await checkLaunch(platform, packaged);
      await checkLaunch(platform, false, false);
      const folder = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform];
      assert.ok(fs.existsSync(path.join(root, 'native', folder, 'bin', platform === 'win32' ? 'packing.exe' : 'packing')));
      assert.ok(!fs.existsSync(path.join(root, 'native', folder, 'bin', platform === 'win32' ? 'sparrow.exe' : 'sparrow')));
    }
    assert.ok(metadata.build.mac.extraFiles.some(entry => entry.to === 'Helpers' && entry.filter.includes('packing')));
    assert.ok(metadata.build.mac.binaries.includes('Contents/Helpers/packing'));
    assert.match(fs.readFileSync(path.join(root, 'main/ipc/cutouts.js'), 'utf8'), /resolveExecutable\('packing'\)/);
    for (const [workflow, helper] of [['ubuntu-snap.yml', 'native/linux/bin/packing'], ['windows-store.yml', 'native/windows/bin/packing.exe']]) {
      const source = fs.readFileSync(path.join(root, '.github/workflows', workflow), 'utf8');
      assert.ok(source.includes(helper));
      assert.ok(!source.includes('/bin/sparrow'));
    }
    console.log('Packing helper: development and packaged paths on all platforms, launch, polling, cutout resolution, missing-helper errors, and packaging names passed.');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
