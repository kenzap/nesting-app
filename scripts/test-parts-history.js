'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-history-test-'));
const copy = value => JSON.parse(JSON.stringify(value));
const handlers = new Map();
let failWrite = false;

// Exercise the actual disk handlers, but never touch the user's saved workspace.
const ipcPath = path.join(root, 'main/ipc/files.js');
const ipcModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(ipcPath, 'utf8'), {
  module: ipcModule, process, console,
  require(name) {
    if (name === 'electron') return {
      app: { isPackaged: true, getPath: () => temp },
      ipcMain: { on() {}, handle: (key, handler) => handlers.set(key, handler) },
    };
    if (name === 'fs') return { ...fs, writeFileSync(filename, ...args) {
      if (failWrite && filename.endsWith('job-state.json.tmp')) {
        fs.writeFileSync(filename, '{');
        throw new Error('Simulated interrupted write');
      }
      return fs.writeFileSync(filename, ...args);
    } };
    if (name === '../utils/security-scoped-bookmarks' || name === '../utils/temp-retention') return {};
    if (name === '../i18n') return { t: key => key };
    return createRequire(ipcPath)(name);
  },
});
ipcModule.exports.registerFileIpc({ getMainWindow: () => null });
const loadDisk = () => handlers.get('load-job-state')();
const saveDisk = data => handlers.get('save-job-state')(null, data);

class Node {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = { toggle() {} };
  }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  fire(name) { this.listeners.get(name)?.({ stopPropagation() {}, preventDefault() {} }); }
  appendChild(node) { node.parentNode = this; this.children.push(node); }
  insertBefore(node) { node.parentNode = this; this.children.unshift(node); }
  removeChild(node) { this.children = this.children.filter(child => child !== node); node.parentNode = null; }
  getBoundingClientRect() { return { right: 200, bottom: 40 }; }
  set innerHTML(markup) {
    this.markup = markup;
    this.entries = [...markup.matchAll(/data-entry-id="([^"]*)"/g)].map(match => {
      const node = new Node();
      node.dataset.entryId = match[1];
      return node;
    });
    this.actions = new Map([...markup.matchAll(/data-history-action="([^"]*)"/g)]
      .map(match => [match[1], new Node()]));
  }
  querySelectorAll(selector) { return selector === '.parts-history-item' ? this.entries : []; }
  querySelector(selector) { return this.actions.get(selector.match(/data-history-action="([^"]*)"/)?.[1]); }
}

async function launch() {
  const timers = new Map();
  let timerId = 0;
  const setTimer = fn => { timers.set(++timerId, fn); return timerId; };
  const document = { body: new Node(), createElement: () => new Node(), addEventListener() {}, removeEventListener() {} };
  let saves = 0;
  let renders = 0;
  const errors = [];
  const window = {
    NestI18n: { t: (key, options) => `${key}${options ? ':' + options.count : ''}` },
    innerWidth: 800, addEventListener() {}, removeEventListener() {},
    setTimeout: setTimer, clearTimeout: id => timers.delete(id),
    electronAPI: { loadJobState: loadDisk, saveJobState: data => { saves++; return saveDisk(copy(data)); } },
  };
  const context = vm.createContext({
    window, document, console: { ...console, error: (...args) => errors.push(args) },
    setTimeout: setTimer, setInterval: () => 1, clearInterval() {},
  });
  for (const filename of ['renderer/helpers.js', 'renderer/state/store.js', 'renderer/views/parts-history.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, filename), 'utf8'), context);
  }
  const store = window.NestStore.createAppStore();
  const dom = { sidebarActions: new Node() };
  const history = window.NestPartsHistory.createPartsHistory({
    ...store, dom, renderFiles() { renders++; },
  });
  history.init();
  const restored = await store.hydrateJobState();
  history.captureBaseline();
  function popover() {
    dom.partsHistoryBtn.fire('click');
    return document.body.children.find(node => node.className === 'parts-history-popover');
  }
  return {
    ...store, history, dom, window, errors, restored,
    get saves() { return saves; }, get renders() { return renders; },
    get pendingTimers() { return timers.size; },
    restore(id) { popover().entries.find(node => node.dataset.entryId === id).fire('click'); },
    clear() { popover().querySelector('[data-history-action="clear"]').fire('click'); },
  };
}

function file(name, qty = 2) {
  return {
    id: name, name: `${name}.dxf`, path: `/parts/${name}.dxf`, size: 123,
    bookmark: `bookmark-${name}`, qty,
    shapes: [{ id: 'shape-1', qty, visible: true, points: [[0, 0], [40, 0], [40, 80]] },
      { id: 'shape-2', qty: 7, visible: false }],
    layers: [{ name: 'CUT', visible: true }],
    _multiSketchDetection: true, _sketchContourMethod: 'auto', _shapeCacheVersion: 4,
    transientPreview: 'must not persist',
  };
}

(async () => {
  try {
    const fresh = await launch();
    assert.equal(fresh.restored, false);
    assert.equal(fresh.dom.partsHistoryBtn.disabled, true);

    // Older versions have no history field. Preserve their loaded parts before replacement.
    await saveDisk({ files: [file('baseline')], sheets: [{ id: 'sheet', width: 400, height: 400 }] });
    const first = await launch();
    assert.equal(first.state.partsHistory.length, 0);
    first.state.files = [file('replacement', 5)];
    first.schedulePersistJobState();
    first.history.recordRunStart();
    assert.equal(first.pendingTimers, 0, 'immediate history save should cancel pending writes');
    assert.equal(first.saves, 1, 'one immediate save includes both baseline and run');
    assert.deepEqual(copy(first.state.partsHistory.map(entry => entry.source)), ['loaded', 'run']);
    const recorded = (await loadDisk()).state.partsHistory;
    assert.equal(recorded.length, 2);
    assert.ok(!('transientPreview' in recorded[0].snapshot[0]));
    assert.ok(!('summary' in recorded[0]), 'translated labels should be rebuilt, not stored');

    const second = await launch();
    assert.equal(second.dom.partsHistoryBtn.disabled, false, 'history icon should update after hydration');
    assert.equal(second.state.partsHistory.length, 2);
    assert.equal(second.state.files[0].name, 'replacement.dxf');
    assert.equal(second.state.sheets[0].width, 400);
    assert.equal(second.state.partsHistory[0].timestamp, recorded[0].timestamp);
    second.history.recordRunStart();
    assert.equal(second.state.partsHistory.length, 2, 'restart must not create duplicate history');
    assert.equal(second.saves, 0);

    second.restore(recorded[0].id);
    assert.equal(second.renders, 1);
    assert.deepEqual(copy(second.state.files), copy(recorded[0].snapshot));
    assert.equal(second.state.files[0].bookmark, 'bookmark-baseline');
    assert.equal(second.state.files[0].shapes[1].visible, false);
    second.state.files[0].shapes[0].qty = 9;
    assert.equal(second.state.partsHistory[0].snapshot[0].shapes[0].qty, 2, 'restoring must clone the snapshot');
    await second.persistJobStateNow();
    const third = await launch();
    assert.equal(third.state.files[0].shapes[0].qty, 9);
    assert.equal(third.state.partsHistory[0].snapshot[0].shapes[0].qty, 2);

    // Clearing the active parts list must not clear history on the next launch.
    third.state.files = [];
    third.state.sheets = [];
    await third.persistJobStateNow();
    const historyOnly = await launch();
    assert.equal(historyOnly.restored, true);
    assert.equal(historyOnly.state.files.length, 0);
    assert.equal(historyOnly.dom.partsHistoryBtn.disabled, false);
    historyOnly.restore(recorded[1].id);
    historyOnly.clear();
    assert.equal(historyOnly.state.files[0].name, 'replacement.dxf');
    const cleared = await launch();
    assert.equal(cleared.state.partsHistory.length, 0, 'Clear history must persist');
    assert.equal(cleared.dom.partsHistoryBtn.disabled, true);
    assert.equal(cleared.state.files[0].name, 'replacement.dxf');

    for (let i = 0; i < 14; i++) {
      cleared.state.files = [file(`part-${i}`)];
      cleared.history.recordRunStart();
    }
    const bounded = await launch();
    assert.equal(bounded.state.partsHistory.length, 10);
    assert.equal(bounded.state.partsHistory[0].snapshot[0].name, 'part-4.dxf');
    assert.equal(bounded.state.partsHistory[9].snapshot[0].name, 'part-13.dxf');

    const saved = (await loadDisk()).state;
    await saveDisk({ ...saved, partsHistory: [null, {}, { id: 'bad', timestamp: 'bad', snapshot: [] },
      { id: 'bad', timestamp: 1, snapshot: null }, ...saved.partsHistory] });
    const sanitized = await launch();
    assert.equal(sanitized.state.partsHistory.length, 10, 'invalid entries must not hide valid history');
    assert.equal(sanitized.state.files[0].name, 'part-13.dxf');

    const beforeFailure = fs.readFileSync(path.join(temp, 'job-state.json'), 'utf8');
    failWrite = true;
    const failed = await saveDisk({ files: [] });
    assert.equal(failed.success, false);
    assert.equal(fs.readFileSync(path.join(temp, 'job-state.json'), 'utf8'), beforeFailure);
    assert.equal(fs.existsSync(path.join(temp, 'job-state.json.tmp')), false);
    failWrite = false;
    sanitized.window.electronAPI.saveJobState = async () => { throw new Error('IPC disconnected'); };
    await sanitized.persistJobStateNow();
    assert.equal(sanitized.errors.length, 1, 'save errors should be reported without an unhandled rejection');
    console.log('Parts history: disk-backed restarts, legacy jobs, restore, clear, quantities, visibility, bookmarks, deduplication, retention, invalid entries and interrupted writes passed.');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
