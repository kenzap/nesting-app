'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/services/nesting-service.js'), 'utf8');
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function setup(overrides = {}) {
  const button = () => ({ disabled: false, classList: { add() {}, remove() {} },
    addEventListener(_, fn) { this.click = fn; } });
  const state = { status: 'idle', files: [{}], sheets: [{ width: 400, height: 400, widthMode: 'fixed' }] };
  const dom = { startBtn: button(), stopBtn: button(), nestStats: {} };
  const calls = { run: 0, stop: [], intervals: new Set() };
  const window = {
    NestI18n: { t: key => key },
    setInterval: fn => { calls.intervals.add(fn); return fn; },
    setTimeout: fn => setTimeout(fn, 0),
    electronAPI: {
      async runSparrow() { calls.run++; return { success: true, runId: `run-${calls.run}` }; },
      async stopSparrow(id) { calls.stop.push(id); return { success: true }; },
      async pollSparrow() { return { success: true, status: calls.stop.length ? 'stopped' : 'running' }; },
      ...overrides.api,
    },
  };
  vm.runInNewContext(source, { window, clearInterval: id => calls.intervals.delete(id),
    console: { error() {}, debug() {}, groupCollapsed() {}, groupEnd() {} } });
  window.NestNestingService.createNestingService({ state, dom,
    getCurrentNestingSettings: () => ({}),
    exportPlacementJSON: overrides.export || (async () => ({ payload: { items: [] } })),
    setStatus: status => { state.status = status; },
    setNestStatsTone() {}, showNestResult() {}, renderTabs() {}, syncExportButton() {},
  }).bind();
  return { state, dom, calls };
}

async function tests() {
  {
    const exported = deferred();
    const { state, dom, calls } = setup({ export: () => exported.promise });
    const running = dom.startBtn.click();
    assert.equal(dom.startBtn.disabled, true);
    await dom.startBtn.click();
    await dom.stopBtn.click();
    exported.resolve({ payload: {} });
    await running;
    assert.equal(calls.run, 0, 'Stop during preparation must prevent launch');
    assert.equal(state.status, 'idle');
    assert.equal(dom.startBtn.disabled, false);
  }
  for (const failedLaunch of [false, true]) {
    const launch = deferred();
    const { state, dom, calls } = setup({ api: { runSparrow: () => launch.promise } });
    const running = dom.startBtn.click();
    await flush();
    await dom.stopBtn.click();
    assert.equal(dom.nestStats.textContent, 'nesting.stopping');
    if (failedLaunch) launch.reject(new Error('spawn failed'));
    else launch.resolve({ success: true, runId: 'delayed-run' });
    await running;
    assert.deepEqual(calls.stop, failedLaunch ? [] : ['delayed-run']);
    assert.equal(state.status, 'idle');
    assert.equal(dom.startBtn.disabled, false);
    assert.equal(calls.intervals.size, 0);
  }
  {
    let attempts = 0;
    const { state, dom } = setup({ api: {
      async stopSparrow() { return { success: ++attempts > 1, error: 'temporary failure' }; },
      async pollSparrow() { return { success: true, status: attempts > 1 ? 'stopped' : 'running' }; },
    } });
    await dom.startBtn.click();
    await dom.stopBtn.click();
    assert.equal(state.status, 'running');
    assert.equal(dom.stopBtn.disabled, false, 'failed Stop must be retryable');
    assert.equal(dom.startBtn.disabled, true, 'do not orphan the active helper');
    await dom.stopBtn.click();
    assert.equal(attempts, 2);
    assert.equal(state.status, 'idle');
  }
  {
    let stopped = false;
    const summary = { strips: [{ svg_path: 'strip_01.svg', json_path: 'strip_01.json' }] };
    const { state, dom, calls } = setup({ api: {
      async stopSparrow() { stopped = true; return { success: true }; },
      async pollSparrow() { return { success: true, status: stopped ? 'stopped' : 'running', ...(stopped ? { summary } : {}) }; },
    } });
    await dom.startBtn.click();
    await dom.stopBtn.click();
    assert.equal(state.status, 'done');
    assert.equal(state.nestResult, summary, 'Stop after a valid layout must retain exportable geometry');
    assert.equal(calls.intervals.size, 0);
  }
  {
    const oldPoll = deferred(); let polls = 0;
    const { state, dom } = setup({ api: { async pollSparrow() {
      if (++polls === 1) return oldPoll.promise;
      return { success: true, status: polls === 2 ? 'stopped' : 'running' };
    } } });
    const running = dom.startBtn.click();
    await flush();
    await dom.stopBtn.click();
    await dom.startBtn.click();
    oldPoll.resolve({ success: true, status: 'stopped' });
    await running;
    assert.equal(state.status, 'running', 'stale poll must not stop a later run');
  }
  console.log('Stop: preparation, pending launch, failed launch, retry, duplicate Run, and stale polls passed.');
}
tests().catch(error => { console.error(error); process.exitCode = 1; });
