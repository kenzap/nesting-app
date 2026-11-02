'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createI18n, SUPPORTED_LANGUAGES } = require('../shared/i18n');
const units = require('../shared/units');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const i18n = createI18n('en');
const events = new Map();
let systemThemeChanged;
let theme = 'dark';
let emptyGrid = false;
let tone = '';
let measurementResets = 0;
const browser = {
  NestI18n: { t: i18n.t.bind(i18n) },
  NestUnits: { ...units, resolveMeasurementSystem: () => 'metric' },
  measureToolApi: { resetMeasurement() { measurementResets += 1; } },
  addEventListener(name, listener) { events.set(name, listener); },
  dispatchEvent(event) { events.get(event.type)?.(event); },
  electronAPI: {
    getSystemTheme: async () => ({ theme: 'dark' }),
    onSystemThemeChanged(listener) { systemThemeChanged = listener; },
  },
};
const emptyTitle = { dataset: {} }, emptyHint = { dataset: {} };
const dom = {
  canvasTabs: { innerHTML: '' },
  svgContainer: { innerHTML: '', style: {}, dataset: {}, querySelector: () => null },
  sheetDimensionBadge: { hidden: true },
  emptyState: { style: {}, querySelector: selector => selector === '.empty-title' ? emptyTitle : emptyHint },
  nestStats: {}, zoomLabel: {},
};
const state = { status: 'idle', zoom: 1, nestResult: null, activeStripIndex: 0,
  files: [{ name: 'rect.dxf', qty: 200 }], sheets: [{ width: 400, height: 400, widthMode: 'fixed' }] };
const context = vm.createContext({
  window: browser, state, CustomEvent,
  document: { documentElement: {
    getAttribute: () => theme,
    setAttribute: (_, value) => { theme = value; },
    removeAttribute: () => { theme = 'dark'; },
  } },
  requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  DOMParser: class { parseFromString() { return { querySelector: () => null }; } },
});
const canvasSource = source('renderer/views/canvas-view.js');
assert.doesNotMatch(canvasSource, /generateMockNestSVG|mock-preview|Math\.random\(/,
  'nesting canvas must never invent geometry or statistics');
vm.runInContext(canvasSource, context);
const view = browser.NestCanvasView.createCanvasView({ state, dom,
  setNestStatsTone: next => { tone = next; }, syncViewportEmptyState: next => { emptyGrid = next; },
  getCurrentNestingSettings: () => ({ measurementSystem: 'metric' }),
});
context.canvasViewApi = view;

function assertEmpty(hintKey) {
  assert.equal(dom.svgContainer.innerHTML, '');
  assert.equal(dom.svgContainer.style.display, 'none');
  assert.deepEqual(Object.keys(dom.svgContainer.dataset), []);
  assert.equal(dom.sheetDimensionBadge.hidden, true);
  assert.notEqual(dom.emptyState.style.display, 'none');
  assert.equal(emptyGrid, true);
  assert.equal(emptyHint.textContent, i18n.t(hintKey));
  assert.equal(emptyHint.dataset.i18n, hintKey, 'language changes retain the appropriate prompt');
}

(async () => {
  vm.runInContext(source('renderer/views/theme-manager.js'), context);
  await new Promise(resolve => setImmediate(resolve));
  // Use the actual app event listener, including its configured-sheet guard.
  const listener = source('renderer/renderer.js').match(
    /window\.addEventListener\('nest-theme-changed', \(\) => \{[\s\S]*?\n\}\);/,
  );
  assert.ok(listener);
  vm.runInContext(listener[0], context);

  dom.svgContainer.innerHTML = '<svg>stale geometry</svg>';
  Object.assign(dom.svgContainer.dataset, { activeIndex: '0', svgSource: 'stale.svg',
    svgPreview: 'false', svgHash: 'old', svgLen: '30' });
  dom.sheetDimensionBadge.hidden = false;
  dom.canvasTabs.innerHTML = 'old tabs';
  dom.nestStats.textContent = '200 parts placed; 76% utilization';
  dom.nestStats.title = 'stale statistics';
  systemThemeChanged({ theme: 'light' });
  assertEmpty('canvas.runToView');
  assert.equal(emptyTitle.textContent, i18n.t('canvas.emptyTitle'));
  assert.equal(dom.nestStats.textContent, i18n.t('canvas.runToView'));
  assert.equal(dom.nestStats.title, '');
  assert.equal(dom.canvasTabs.innerHTML, '');
  assert.equal(measurementResets, 1, 'stale rulers are cleared with missing geometry');
  assert.equal(state.nestResult, null, 'the fallback must not invent a result');

  for (const language of SUPPORTED_LANGUAGES) {
    await i18n.changeLanguage(language);
    view.showNestResult(0);
    assertEmpty('canvas.runToView');
    assert.equal(dom.nestStats.textContent, i18n.t('canvas.runToView'));
    assert.notEqual(emptyHint.textContent, 'canvas.runToView', `${language} has a translated run prompt`);
  }
  await i18n.changeLanguage('en');

  state.status = 'running';
  systemThemeChanged({ theme: 'dark' });
  assertEmpty('nesting.waitingPreview');
  assert.equal(emptyTitle.textContent, i18n.t('canvas.waitingGeometry'));
  assert.equal(dom.nestStats.textContent, i18n.t('nesting.waitingPreview'));

  state.status = 'error';
  tone = 'error';
  dom.nestStats.textContent = 'A part does not fit';
  dom.nestStats.title = 'Detailed solver error';
  systemThemeChanged({ theme: 'light' });
  assertEmpty('canvas.runToView');
  assert.equal(dom.nestStats.textContent, 'A part does not fit');
  assert.equal(dom.nestStats.title, 'Detailed solver error');
  assert.equal(tone, 'error');

  state.status = 'idle';
  state.files = [];
  view.showNestResult(0);
  assertEmpty('canvas.emptyBeforeRun');
  state.files = [{ name: 'rect.dxf', qty: 200 }];

  state.status = 'done';
  const result = { strips: [{ svg: '<svg viewBox="0 0 400 400"><path d="M0,0 L40,0 L40,80 Z"/></svg>',
    svg_path: 'real.svg', strip_width: 400, strip_height: 400, item_count: 1, density: 0.02 }] };
  state.nestResult = result;
  systemThemeChanged({ theme: 'dark' });
  assert.equal(state.nestResult, result, 'theme changes preserve real results');
  assert.equal(dom.svgContainer.dataset.svgSource, 'real.svg');
  assert.equal(dom.svgContainer.style.display, 'grid');
  assert.equal(dom.emptyState.style.display, 'none');
  assert.equal(emptyGrid, false);
  assert.match(dom.nestStats.textContent, /1 part placed/);
  assert.doesNotMatch(dom.nestStats.textContent, /200 parts placed/);
  view.showNestResult(99);
  assert.equal(dom.svgContainer.dataset.svgSource, 'real.svg', 'an invalid sheet index recovers a real sheet');
  assert.equal(state.activeStripIndex, 0);

  state.status = 'running';
  state.nestResult = { is_preview: true, strips: [{ is_preview: true, state: 'queued' }] };
  view.showNestResult(0);
  assert.equal(dom.svgContainer.innerHTML, '', 'a queued sheet never borrows previous geometry');
  assert.equal(dom.emptyState.style.display, 'none');
  assert.match(dom.nestStats.textContent, /Waiting for geometry/);
  assert.doesNotMatch(dom.nestStats.textContent, /Press Run|parts placed|Utilization/);

  state.status = 'idle';
  state.nestResult = null;
  view.showNestResult(0);
  assertEmpty('canvas.runToView');
  console.log('Canvas empty state: theme changes, missing results, waiting previews, preserved errors/layouts, and all 14 languages passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
