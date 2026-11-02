'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { createI18n, SUPPORTED_LANGUAGES } = require('../shared/i18n');

const root = path.resolve(__dirname, '..');
const operationsPath = 'main/utils/safe-file-operations.js';
const diskFs = { ...fs, rmSync() { throw new Error('Unsafe native removal must not be used'); } };

function load(relativePath, overrides = {}) {
  const filename = path.join(root, relativePath);
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, process, console, __dirname: path.dirname(filename),
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name === 'fs') return diskFs;
      return createRequire(filename)(name);
    },
  }, { filename });
  return mod.exports;
}

function ioError(code) {
  return Object.assign(new Error(`Simulated ${code}`), { code });
}

function loadExporter(operations) {
  let handler;
  load('main/ipc/export-dxf.js', {
    electron: { ipcMain: { handle(name, fn) { if (name === 'export-sheets-dxf') handler = fn; } } },
    '../utils/security-scoped-bookmarks': { withSecurityScopedAccess: (_, fn) => fn() },
    '../utils/safe-file-operations': operations,
  }).registerExportDxfIpc();
  return handler;
}

async function testErrorDisplay() {
  for (const language of SUPPORTED_LANGUAGES) {
    const i18n = createI18n(language);
    let result, click;
    const classes = new Set();
    const classList = { add: c => classes.add(c), remove: (...cs) => cs.forEach(c => classes.delete(c)) };
    const button = { classList, addEventListener: (_, fn) => { click = fn; } };
    const label = { classList };
    const logged = [];
    const window = {
      NestI18n: { t: i18n.t.bind(i18n) },
      NestUnits: { resolveMeasurementSystem: () => 'metric' },
      electronAPI: {
        loadAppSettings: async () => ({ settings: { __lastExportFolder: '/export' } }),
        exportSheetsDXF: async () => result,
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'renderer/services/export-service.js'), 'utf8'), {
      window, console: { error: (...args) => logged.push(args) },
    });
    const service = window.NestExportService.createExportService({
      state: { sheets: [{ width: 100, height: 100 }], nestResult: { strips: [{ strip_width: 100 }] } },
      dom: { exportSheetsBtn: button, exportFolderLabel: label },
    });
    service.bind();
    await service.loadLastExportFolder();
    for (const code of ['EPERM', 'EACCES', 'EBUSY', 'EROFS', 'ENOSPC', 'EDQUOT', 'EIO']) {
      result = { success: false, errorCode: code, error: 'Original diagnostic detail' };
      await click();
      const key = ['ENOSPC', 'EDQUOT'].includes(code) ? 'export.diskFull' : 'export.writeBlocked';
      const message = code === 'EIO' ? result.error : i18n.t(key);
      assert.equal(label.textContent, i18n.t('export.error', { message }), `${language}: ${code}`);
      assert.equal(button.disabled, false, 'export can be retried');
      assert.ok(classes.has('export-folder-error'));
      assert.equal(logged.at(-1)[1].message, result.error, 'console retains diagnostic details');
      assert.equal(logged.at(-1)[1].code, code);
    }
  }
}

async function withWindowsLock(filename, fn) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $file=[System.IO.File]::Open($env:NEST_TEST_LOCK_PATH, 'Open', 'Read', 'Read'); "
    + "try { [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $file.Dispose() }"],
  { windowsHide: true, env: { ...process.env, NEST_TEST_LOCK_PATH: filename }, stdio: 'pipe' });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  try {
    await new Promise((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(new Error('Timed out acquiring Windows file lock')), 10000);
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once('error', finish);
      child.once('exit', code => finish(new Error(`Lock helper exited (${code}): ${stderr}`)));
      child.stdout.on('data', data => {
        stdout += data;
        if (stdout.includes('READY')) finish();
      });
    });
    await fn();
  } finally {
    child.kill();
    await exited;
  }
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-file-operations-'));
  const unicodeDir = path.join(directory, '\u0e42\u0e23\u0e07\u0e07\u0e32\u0e19', '\u5207\u5272-\u00e9');
  fs.mkdirSync(unicodeDir, { recursive: true });
  const target = path.join(unicodeDir, '01_sheet_1220x2440.dxf');
  const operations = load(operationsPath);
  try {
    operations.overwriteTextFile(target, 'first export');
    operations.overwriteTextFile(target, 'replacement export');
    assert.equal(fs.readFileSync(target, 'utf8'), 'replacement export');
    assert.deepEqual(fs.readdirSync(unicodeDir), [path.basename(target)], 'no temporary files remain');

    const original = Buffer.from('original DXF must survive failures\r\n');
    fs.writeFileSync(target, original);
    fs.utimesSync(target, new Date('2000-01-01'), new Date('2000-01-01'));
    const originalMtime = fs.statSync(target).mtimeMs;
    for (const method of ['openSync', 'writeFileSync', 'utimesSync', 'renameSync']) {
      for (const code of ['EPERM', 'EACCES', 'EBUSY', 'EROFS', 'ENOSPC']) {
        const failure = ioError(code);
        const broken = load(operationsPath, { fs: {
          ...diskFs,
          [method](...args) {
            if (method === 'writeFileSync') fs.writeFileSync(args[0], 'partial new file');
            throw failure;
          },
          unlinkSync(filename) {
            assert.notEqual(filename, target, 'destination must never be deleted first');
            fs.unlinkSync(filename);
          },
        } });
        assert.throws(() => broken.overwriteTextFile(target, 'replacement'), error => error === failure);
        assert.deepEqual(fs.readFileSync(target), original, `${method}/${code} preserves the original`);
        assert.equal(fs.statSync(target).mtimeMs, originalMtime);
        assert.deepEqual(fs.readdirSync(unicodeDir), [path.basename(target)]);
      }
    }

    const renameFailure = ioError('EBUSY');
    const cleanupFailure = ioError('EACCES');
    const failedCleanup = load(operationsPath, { fs: {
      ...diskFs, renameSync() { throw renameFailure; }, unlinkSync() { throw cleanupFailure; },
    } });
    assert.throws(() => failedCleanup.overwriteTextFile(target, 'new'), error => error === renameFailure,
      'a cleanup failure does not mask the replacement error');
    assert.deepEqual(fs.readFileSync(target), original);
    for (const name of fs.readdirSync(unicodeDir).filter(name => name.endsWith('.tmp'))) {
      fs.unlinkSync(path.join(unicodeDir, name));
    }
    const successfulRename = load(operationsPath, { fs: {
      ...diskFs, unlinkSync() { throw cleanupFailure; },
    } });
    successfulRename.overwriteTextFile(target, 'saved despite cleanup failure');
    assert.equal(fs.readFileSync(target, 'utf8'), 'saved despite cleanup failure');
    assert.ok(fs.statSync(target).mtimeMs > originalMtime, 'replacement gets a fresh modification time');

    const staleDebug = path.join(unicodeDir, 'stale.debug.json');
    fs.writeFileSync(staleDebug, '{}');
    operations.removeFileIfExists(staleDebug);
    operations.removeFileIfExists(staleDebug);
    assert.throws(() => failedCleanup.removeFileIfExists(staleDebug), error => error === cleanupFailure,
      'file deletion errors other than ENOENT are not silently discarded');

    const inputPath = path.join(directory, 'input.json');
    const sheetPath = path.join(directory, 'sheet.json');
    const polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    fs.writeFileSync(inputPath, JSON.stringify({ items: [{ id: 0, shape: { data: polygon } }],
      settings: { engravingLayer: 'off' } }));
    fs.writeFileSync(sheetPath, JSON.stringify({ solution: { layout: { placed_items: [
      { item_id: 0, transformation: { rotation: 0, translation: [0, 0] } },
    ] } } }));
    const request = { outputDir: unicodeDir, inputPath,
      strips: [{ index: 1, json_path: sheetPath, sheet_width: 2440, strip_height: 1220 }] };
    const exportDxf = loadExporter(operations);
    assert.equal((await exportDxf(null, request)).success, true);
    const savedDxf = fs.readFileSync(target);
    const blockedExporter = loadExporter(failedCleanup);
    const response = await blockedExporter(null, request);
    assert.equal(response.success, false, 'export failure is returned over IPC, not thrown');
    assert.equal(response.errorCode, 'EBUSY');
    assert.equal(response.error, renameFailure.message);
    assert.deepEqual(fs.readFileSync(target), savedDxf);
    assert.equal((await exportDxf(null, request)).success, true, 'export can be retried');

    // Use the real OS failure paths when this test runs on Windows, not just mocks.
    if (process.platform === 'win32') {
      await withWindowsLock(target, async () => {
        const result = await exportDxf(null, request);
        assert.equal(result.success, false, 'an open file blocks replacement without crashing');
        assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(result.errorCode));
        assert.deepEqual(fs.readFileSync(target), savedDxf);
      });
      fs.chmodSync(target, 0o444);
      try {
        const result = await exportDxf(null, request);
        assert.equal(result.success, false, 'a read-only file remains untouched');
        assert.deepEqual(fs.readFileSync(target), savedDxf);
      } finally {
        fs.chmodSync(target, 0o666);
      }
      assert.equal((await exportDxf(null, request)).success, true);
      console.log('Windows: real locked/read-only exports in Unicode folders passed.');
    } else {
      console.log('Windows-only real file-lock/read-only checks skipped on this platform.');
    }

    const tempRoot = path.join(directory, 'retention');
    const oldFile = path.join(tempRoot, 'old.json');
    const oldDir = path.join(tempRoot, '\u5207\u5272');
    const recent = path.join(tempRoot, 'recent.json');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'result.json'), '{}');
    fs.writeFileSync(oldFile, '{}');
    fs.writeFileSync(recent, '{}');
    for (const filename of [oldFile, oldDir]) fs.utimesSync(filename, 1, 1);
    const retention = load('main/utils/temp-retention.js');
    await retention.cleanupTempArtifacts(tempRoot);
    assert.deepEqual(fs.readdirSync(tempRoot), ['recent.json'], 'only expired artifacts are removed');
    await retention.cleanupTempArtifacts(path.join(directory, 'missing'));
    const unreadable = load('main/utils/temp-retention.js', { fs: { ...diskFs,
      promises: { ...fs.promises, readdir: async () => { throw cleanupFailure; } },
    } });
    await unreadable.cleanupTempArtifacts(tempRoot);
    const lockedCleanup = load(operationsPath, { fs: { ...diskFs,
      promises: { ...fs.promises, rm: async () => { throw cleanupFailure; } },
    } });
    await lockedCleanup.removeTempPath(tempRoot);
    assert.ok(fs.existsSync(recent), 'locked temporary artifacts are left for later');
    const cutouts = load('main/ipc/cutouts.js', {
      fs: { ...diskFs, mkdtempSync: () => fs.mkdtempSync(path.join(directory, 'capability-')) },
      child_process: { execFile: (_, __, ___, callback) => callback(null, '--cutout') },
      '../utils/safe-file-operations': lockedCleanup,
    });
    assert.equal(await cutouts.supportsCutouts(inputPath), true,
      'a cleanup failure must not turn successful engine detection into an unsupported result');

    await testErrorDisplay();
    function checkRuntime(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) checkRuntime(filename);
        else if (filename.endsWith('.js')) assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /\.rmSync\s*\(/,
          `Unsafe native synchronous removal must not return to ${path.relative(root, filename)}`);
      }
    }
    checkRuntime(path.join(root, 'main'));
    console.log('File operations: Unicode replacement, failure preservation, IPC, cleanup, and all localized error messages passed.');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
