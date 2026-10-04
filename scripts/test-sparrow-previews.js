const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const ipcPath = path.join(root, 'main/ipc/sparrow.js');
const ipcModule = { exports: {} };
vm.runInNewContext(`${fs.readFileSync(ipcPath, 'utf8')}
module.exports = { collectContinuousFinalArtifacts, collectRunningSparrowArtifacts, collectSparrowArtifacts, attachRunSheetMetadata };`, {
  module: ipcModule,
  __dirname: path.dirname(ipcPath),
  require(name) {
    if (name === 'electron') return { app: {}, ipcMain: {} };
    if (name === '../utils/temp-retention' || name === '../utils/diagnostics') return {};
    return require(name);
  },
});
const { collectRunningSparrowArtifacts, collectSparrowArtifacts, attachRunSheetMetadata } = ipcModule.exports;

// Expose internal preview helpers in this isolated test without expanding
// the renderer's public API or requiring an Electron window.
const canvasSource = fs.readFileSync(path.join(root, 'renderer/views/canvas-view.js'), 'utf8');
assert.ok(canvasSource.includes('      renderTabs,\n'));
const window = {
  NestHelpers: {},
  NestUnits: {
    resolveMeasurementSystem: () => 'metric',
    formatDimensions: require('../shared/units').formatDimensions,
    formatLongLength: value => String(value),
    formatLength: require('../shared/units').formatLength,
  },
  NestConstants: {},
  NestI18n: { t(key, values = {}) {
    if (key === 'canvas.sheetNumber') return `Sheet ${values.number}`;
    if (key === 'canvas.sheetOf') return `Sheet ${values.number} of ${values.total}`;
    if (key === 'canvas.testingSheetCount') return `Testing sheet count: ${values.count}`;
    if (key === 'canvas.lastCompleteLayout') return 'Last complete layout';
    if (key === 'canvas.sharedEdgesTotal') return `Shared edges (total): ${values.value}`;
    return key;
  } },
};
const buttons = [];
const document = { documentElement: { getAttribute: () => 'dark' }, createElement() {
  const classes = new Set();
  const handlers = {};
  return {
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
    addEventListener: (name, handler) => { handlers[name] = handler; },
    click: () => handlers.click(),
    scrollIntoView() {},
    remove() { buttons.splice(buttons.indexOf(this), 1); },
  };
} };
vm.runInNewContext(canvasSource.replace('      renderTabs,\n', '      sheetDimensionLabel,\n      displayStripWidth,\n      stripPlacementLabel,\n      styleStripSVG,\n      quickSvgHash,\n      renderTabs,\n'), {
  window, document, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  DOMParser: class { parseFromString() { return { querySelector: () => null }; } },
});
const state = { zoom: 1, sheets: [{ width: 2500, height: 1250, widthMode: 'fixed' }] };
const dom = {
  canvasTabs: { querySelectorAll: () => buttons, appendChild: button => buttons.push(button) },
  svgContainer: { innerHTML: '', style: {}, dataset: {}, querySelector: () => null },
  emptyState: { style: {} },
  nestStats: {},
  zoomLabel: {},
};
const view = window.NestCanvasView.createCanvasView({
  state, dom, setNestStatsTone() {}, syncViewportEmptyState() {},
  getCurrentNestingSettings: () => ({ sheetMargin: 10 }),
});

const badge = view.sheetDimensionLabel({ getAttribute: name => ({
  'data-sheet-width': '3000', 'data-sheet-height': '1250',
})[name] });
assert.equal(badge.text, '1250 × 3000 mm');
assert.equal(badge.width, 3000, 'label order must not change positioning geometry');
assert.equal(badge.height, 1250);

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nesting-preview-test-'));
const liveDir = path.join(runDir, 'data/live');
const svg = '<svg viewBox="0 0 3300 1230"><use href="#item_0"/><use href="#item_0"/></svg>';
const read = collect => attachRunSheetMetadata(collect(runDir, 'job'), runDir, 'job').summary;
const manifest = data => fs.writeFileSync(path.join(liveDir, '.live_manifest.js'),
  `window.__SPARROW_LIVE_MANIFEST = ${JSON.stringify(data)};\n`);

try {
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'job.json'), JSON.stringify({
    sheets: [{ width: 2500, height: 1250, width_mode: 'fixed' }],
    settings: { sheetMargin: 10 },
  }));
  fs.writeFileSync(path.join(liveDir, '.live_probe_solution.svg'), svg);
  manifest({ mode: 'single_sheet_probe', name: 'job', strip_count: 1, strips: [{
    index: 1, svg_path: '.live_probe_solution.svg', strip_width: 3300, density: 0.65, state: 'active',
  }] });

  const trial = read(collectRunningSparrowArtifacts);
  assert.equal(trial.preview_stage, 'single_sheet_probe');
  assert.equal(trial.is_preview, true, 'trial must not enable export');
  assert.equal(trial.strips.length, 1);
  assert.equal(trial.strips[0].item_count, 2);
  assert.equal(trial.strips[0].json_path, null);
  assert.equal(trial.strips[0].preview_stage, 'single_sheet_probe');
  assert.equal(trial.strips[0].sheet_width_mode, 'unlimited');
  assert.equal(trial.strips[0].sheet_margin, 10);
  assert.equal(view.displayStripWidth(trial.strips[0]), 3320, 'trial must not be cropped to 2500 mm');

  manifest({ mode: 'sheet_count_probe', name: 'job', strip_count: 2, current_strip: 2, strips: [{
    index: 2, svg_path: '.live_probe_solution.svg', strip_width: 3300, density: 0.65, state: 'active',
  }] });
  const multiTrial = read(collectRunningSparrowArtifacts);
  assert.equal(multiTrial.preview_stage, 'sheet_count_probe');
  assert.equal(multiTrial.preview_target_sheet_count, 2);
  assert.equal(multiTrial.current_strip, 2);
  assert.equal(multiTrial.strips.length, 2, 'sparse trials must preserve every tab');
  assert.equal(multiTrial.strips[0].index, 1);
  assert.equal(multiTrial.strips[0].svg, '');
  assert.equal(multiTrial.strips[0].state, 'queued');
  assert.equal(multiTrial.strips[1].preview_target_sheet_count, 2);
  assert.equal(multiTrial.strips[1].index, 2);
  assert.equal(multiTrial.strips[1].json_path, null);
  assert.equal(multiTrial.is_preview, true);
  assert.equal(view.displayStripWidth(multiTrial.strips[1]), 3320);

  const sharedPath = '.live_probe_strip_01.svg';
  fs.writeFileSync(path.join(liveDir, sharedPath), svg);
  manifest({ mode: 'sheet_count_probe', strip_count: 2, current_strip: 1, strips: [1, 2].map(index => ({
    index, svg_path: sharedPath, strip_width: 3300, state: 'active',
  })) });
  const sharedTrial = read(collectRunningSparrowArtifacts);
  assert.equal(sharedTrial.strips.length, 2);
  assert.equal(sharedTrial.strips[0].svg, sharedTrial.strips[1].svg);
  assert.ok(sharedTrial.strips.every(strip => strip.is_preview && strip.json_path === null));
  state.nestResult = sharedTrial;
  view.renderTabs();
  assert.equal(buttons.length, 2, 'both tabs must exist before completion');
  assert.equal(buttons[1].textContent, 'Sheet 2');
  const secondTab = buttons[1];
  state.activeStripIndex = 1;
  const updatedSvg = svg.replace(/3300/g, '3200');
  fs.writeFileSync(path.join(liveDir, sharedPath), updatedSvg);
  state.nestResult = read(collectRunningSparrowArtifacts);
  view.renderTabs();
  assert.equal(state.nestResult.strips[1].svg, updatedSvg, 'shared sheet 2 must update during nesting');
  assert.equal(buttons[1], secondTab, 'polls must not recreate tabs');
  assert.equal(state.activeStripIndex, 1, 'polls must preserve manual sheet selection');

  const tailPath = '.live_probe_strip_03.svg';
  const tailSvg = '<svg viewBox="0 0 177 1230"><use href="#item_0"/></svg>';
  fs.writeFileSync(path.join(liveDir, tailPath), tailSvg);
  manifest({ mode: 'sheet_count_probe', strip_count: 3, current_strip: 1, strips: [
    ...[1, 2].map(index => ({ index, svg_path: sharedPath, strip_width: 2450, state: 'active' })),
    { index: 3, svg_path: tailPath, strip_width: 177, state: 'ready' },
  ] });
  const templateAndTail = read(collectRunningSparrowArtifacts);
  assert.equal(templateAndTail.strips.length, 3);
  assert.equal(templateAndTail.strips[0].svg, templateAndTail.strips[1].svg);
  assert.equal(templateAndTail.strips[2].svg, tailSvg, 'remainder must not inherit the full batch geometry');
  assert.equal(templateAndTail.strips[2].item_count, 1);
  assert.equal(templateAndTail.strips[0].state, 'active');
  assert.equal(templateAndTail.strips[2].state, 'ready', 'remainder must be available while the common batch runs');
  assert.ok(templateAndTail.strips.every(strip => strip.is_preview && strip.json_path === null),
    'a complete reusable candidate is still preview-only until finalization');
  state.nestResult = templateAndTail;
  view.renderTabs();
  assert.equal(buttons.length, 3);
  assert.equal(buttons[2].textContent, 'Sheet 3');
  assert.equal(state.activeStripIndex, 1);

  const thirdTab = buttons[2];
  state.activeStripIndex = 2;
  const retainedPath = '.live_retained_strip_03.svg';
  fs.writeFileSync(path.join(liveDir, retainedPath), tailSvg);
  manifest({ mode: 'sheet_count_probe', strip_count: 3, probe_sheet_count: 2, current_strip: 1, strips: [
    ...[1, 2].map(index => ({ index, svg_path: sharedPath, strip_width: 3300, state: 'active' })),
    { index: 3, svg_path: retainedPath, strip_width: 177, state: 'retained' },
  ] });
  const lowerSheetCountTrial = read(collectRunningSparrowArtifacts);
  assert.equal(lowerSheetCountTrial.strips.length, 3, 'a two-sheet trial must not hide the saved third sheet');
  assert.equal(lowerSheetCountTrial.preview_target_sheet_count, 2, 'visible tabs must not change the trial target');
  assert.equal(lowerSheetCountTrial.strips[0].preview_target_sheet_count, 2);
  assert.equal(view.stripPlacementLabel(lowerSheetCountTrial.strips[0], 0), 'Testing sheet count: 2');
  const retained = lowerSheetCountTrial.strips[2];
  assert.equal(retained.svg, tailSvg);
  assert.equal(retained.is_retained_preview, true);
  assert.equal(retained.preview_stage, undefined, 'saved sheet geometry is not an unbounded trial');
  assert.equal(retained.sheet_width_mode, 'fixed');
  assert.equal(view.displayStripWidth(retained), 2500, 'saved sheet keeps the physical frame and margins');
  assert.ok(lowerSheetCountTrial.strips.every(strip => strip.is_preview && strip.json_path === null));
  state.nestResult = lowerSheetCountTrial;
  view.renderTabs();
  assert.equal(buttons[2], thirdTab);
  assert.equal(state.activeStripIndex, 2, 'starting a smaller trial must preserve third-sheet selection');
  assert.equal(view.stripPlacementLabel(retained, 2), 'Last complete layout · Sheet 3 of 3');
  fs.writeFileSync(path.join(liveDir, sharedPath), updatedSvg);
  state.nestResult = read(collectRunningSparrowArtifacts);
  view.renderTabs();
  assert.equal(state.nestResult.strips[2].svg, tailSvg, 'trial updates must not overwrite the saved tail');
  assert.equal(buttons[2], thirdTab, 'polls must keep the saved third tab intact');
  assert.equal(state.activeStripIndex, 2);

  const improvedTailSvg = '<svg viewBox="0 0 123 1230"><use href="#item_0"/></svg>';
  fs.writeFileSync(path.join(liveDir, retainedPath), improvedTailSvg);
  manifest({ mode: 'sheet_count_probe', strip_count: 3, probe_sheet_count: 2, current_strip: 1, strips: [
    ...[1, 2].map(index => ({ index, svg_path: sharedPath, strip_width: 3200, state: 'active' })),
    { index: 3, svg_path: retainedPath, strip_width: 123, state: 'retained' },
  ] });
  state.nestResult = read(collectRunningSparrowArtifacts);
  view.renderTabs();
  assert.equal(state.nestResult.strips[2].svg, improvedTailSvg, 'polls must reread improved saved-tail geometry at the same path');
  assert.equal(state.nestResult.strips[2].item_count, 1);
  assert.equal(state.nestResult.strips[2].strip_width, 123);
  assert.equal(state.nestResult.strips[0].svg, updatedSvg, 'a saved-tail update must not replace the ongoing trial');
  assert.equal(view.displayStripWidth(state.nestResult.strips[2]), 2500);
  assert.ok(state.nestResult.strips.every(strip => strip.is_preview && strip.json_path === null));
  assert.equal(buttons[2], thirdTab);
  assert.equal(state.activeStripIndex, 2, 'refreshing saved geometry must keep the selected sheet');

  const activeTailPath = '.live_probe_strip_03.svg';
  const activeTailSvg = '<svg viewBox="0 0 177 1230"><use href="#item_0" x="0"/><use href="#item_0" x="80"/></svg>';
  fs.writeFileSync(path.join(liveDir, activeTailPath), activeTailSvg);
  manifest({ mode: 'sheet_count_probe', strip_count: 3, probe_sheet_count: 3, current_strip: 3, strips: [
    ...[1, 2].map(index => ({ index, svg_path: sharedPath, strip_width: 3200, state: 'active' })),
    { index: 3, svg_path: activeTailPath, strip_width: 177, state: 'remainder_active' },
  ] });
  state.nestResult = read(collectRunningSparrowArtifacts);
  view.renderTabs();
  assert.equal(state.nestResult.strips[2].item_count, 2);
  assert.equal(state.nestResult.strips[2].is_remainder_preview, true);
  assert.equal(state.nestResult.strips[2].is_retained_preview, undefined);
  assert.equal(state.nestResult.strips[2].preview_stage, undefined);
  assert.equal(state.nestResult.strips[2].sheet_width_mode, 'fixed');
  assert.equal(view.displayStripWidth(state.nestResult.strips[2]), 2500, 'a running remainder must keep the selected physical sheet mode and margins');
  assert.equal(view.stripPlacementLabel(state.nestResult.strips[2], 2), 'Sheet 3 of 3');
  const nextActiveTailSvg = activeTailSvg.replace('x="80"', 'x="60"').replace('177', '157');
  fs.writeFileSync(path.join(liveDir, activeTailPath), nextActiveTailSvg);
  state.nestResult = read(collectRunningSparrowArtifacts);
  view.renderTabs();
  assert.equal(state.nestResult.strips[2].svg, nextActiveTailSvg, 'a remainder must refresh even when its demand and path are unchanged');
  assert.equal(state.nestResult.strips[2].item_count, 2);
  assert.equal(state.nestResult.strips[0].svg, updatedSvg, 'remainder iterations must not replace shared full-sheet geometry');
  assert.ok(state.nestResult.strips.every(strip => strip.is_preview && strip.json_path === null));
  assert.equal(buttons[2], thirdTab);
  assert.equal(state.activeStripIndex, 2);

  const cachedPath = '.live_probe_strip_02.svg';
  fs.writeFileSync(path.join(liveDir, cachedPath), updatedSvg);
  manifest({ mode: 'sheet_count_probe', strip_count: 2, current_strip: 1, strips: [
    { index: 1, svg_path: sharedPath, strip_width: 3300, state: 'active' },
    { index: 2, svg_path: cachedPath, strip_width: 2450, state: 'ready' },
  ] });
  const expandedTrial = read(collectRunningSparrowArtifacts);
  assert.equal(expandedTrial.strips[0].state, 'active');
  assert.equal(expandedTrial.strips[1].svg, updatedSvg, 'cached later sheet must stay visible during a new batch trial');
  assert.equal(expandedTrial.strips[1].state, 'ready');
  assert.ok(expandedTrial.strips.every(strip => strip.is_preview && strip.json_path === null));
  state.nestResult = expandedTrial;
  view.renderTabs();
  assert.equal(buttons.length, 2, 'a genuinely smaller plan without retained sheets may remove the extra tab');
  assert.equal(state.activeStripIndex, 1);
  fs.unlinkSync(path.join(liveDir, cachedPath));

  const queuedPath = '.live_probe_strip_02.svg';
  manifest({ mode: 'sheet_count_probe', strip_count: 2, current_strip: 1, strips: [{
    index: 1, svg_path: sharedPath, strip_width: 3200, state: 'ready',
  }, { index: 2, svg_path: queuedPath, state: 'queued' }] });
  state.nestResult = read(collectRunningSparrowArtifacts);
  assert.equal(state.nestResult.strips.length, 2, 'missing SVG must not remove a queued tab');
  dom.svgContainer.innerHTML = '<svg>previous sheet geometry</svg>';
  buttons[1].click();
  assert.equal(dom.svgContainer.innerHTML, '', 'queued sheet must not show another sheet geometry');
  assert.equal(dom.svgContainer.style.display, 'none');
  assert.ok(dom.nestStats.textContent.includes('canvas.waitingGeometry'));
  fs.writeFileSync(path.join(liveDir, queuedPath), svg);
  const distinctTrial = read(collectRunningSparrowArtifacts);
  assert.equal(distinctTrial.strips[0].svg, updatedSvg, 'completed batch must retain its own preview');
  assert.equal(distinctTrial.strips[1].svg, svg);

  fs.writeFileSync(path.join(liveDir, '.live_strip_01.svg'), svg);
  fs.writeFileSync(path.join(liveDir, '.live_strip_02.svg'), svg);
  manifest({ mode: 'multi_strip', name: 'job', strip_count: 2, strips: [1, 2].map(index => ({
    index, svg_path: `.live_strip_0${index}.svg`, strip_width: 1200, state: 'active',
  })) });
  const fallback = read(collectRunningSparrowArtifacts);
  assert.equal(fallback.strips.length, 2, 'fallback must replace the one-sheet trial');
  assert.equal(fallback.preview_stage, undefined);
  assert.equal(fallback.preview_target_sheet_count, undefined);
  assert.equal(fallback.strips[0].preview_stage, undefined);
  assert.equal(fallback.is_preview, true);
  assert.equal(fallback.strips[0].sheet_width_mode, 'fixed');
  assert.equal(view.displayStripWidth(fallback.strips[0]), 2500);

  const finalDir = path.join(runDir, 'output/final_job');
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, 'strip_01.svg'), svg);
  fs.writeFileSync(path.join(finalDir, 'strip_01.json'), '{}');
  fs.writeFileSync(path.join(finalDir, 'summary.json'), JSON.stringify({
    name: 'job', strip_count: 1, total_shared_edge_length_mm: 1234.5, strips: [{
      index: 1, svg_path: 'output/final_job/strip_01.svg',
      json_path: 'output/final_job/strip_01.json', strip_width: 2450, item_count: 2,
    }],
  }));
  const final = read(collectSparrowArtifacts);
  assert.equal(final.strips.length, 1);
  assert.equal(final.preview_stage, undefined);
  assert.equal(final.strips[0].is_preview, false);
  assert.equal(final.strips[0].sheet_width_mode, 'fixed');
  assert.equal(view.displayStripWidth(final.strips[0]), 2500, 'final must restore fixed sheet dimensions');
  assert.ok(final.strips[0].json_path.endsWith('strip_01.json'));
  state.nestResult = final;
  view.showNestResult(0);
  assert.match(dom.nestStats.textContent, /Shared edges \(total\): 1234.5 mm/);
  final.total_shared_edge_length_mm = 0;
  view.showNestResult(0);
  assert.match(dom.nestStats.textContent, /Shared edges \(total\): 0 mm/);
  final.total_shared_edge_length_mm = null;
  view.showNestResult(0);
  assert.match(dom.nestStats.textContent, /canvas.sharedEdgesUnavailable/);
  final.total_shared_edge_length_mm = 254;
  window.NestUnits.resolveMeasurementSystem = () => 'imperial';
  // The view captures the resolver, so instantiate another view for imperial units.
  const imperialView = window.NestCanvasView.createCanvasView({
    state, dom, setNestStatsTone() {}, syncViewportEmptyState() {},
    getCurrentNestingSettings: () => ({ sheetMargin: 10 }),
  });
  imperialView.showNestResult(0);
  assert.match(dom.nestStats.textContent, /Shared edges \(total\): 10 in/);

  const outputDir = path.join(runDir, 'output');
  fs.writeFileSync(path.join(outputDir, 'final_continuous.svg'), svg);
  for (const length of [0, 1234.5, null, undefined]) {
    fs.writeFileSync(path.join(outputDir, 'final_continuous.json'), JSON.stringify({
      name: 'continuous', solution: { strip_width: 1000 }, shared_edge_length_mm: length,
    }));
    const collected = ipcModule.exports.collectContinuousFinalArtifacts(outputDir, 'continuous');
    assert.equal(collected.summary.total_shared_edge_length_mm, length ?? null);
    assert.equal(collected.summary.strips[0].shared_edge_length_mm, length ?? null);
  }

  let firstSvg;
  let nextSvg;
  let nextStyled;
  for (let padding = 4000; padding < 4064; padding += 1) {
    firstSvg = `<svg viewBox="0 0 300 1250"><desc>${'x'.repeat(padding)}</desc><use href="#item_0" transform="translate(100 0)"/></svg>`;
    nextSvg = firstSvg.replace('translate(100 0)', 'translate(200 0)');
    const firstStyled = view.styleStripSVG(firstSvg);
    nextStyled = view.styleStripSVG(nextSvg);
    if (view.quickSvgHash(firstStyled) === view.quickSvgHash(nextStyled)) break;
  }
  assert.equal(view.quickSvgHash(view.styleStripSVG(firstSvg)), view.quickSvgHash(nextStyled),
    'fixture must reproduce a movement outside the sampled hash positions');
  const sparseRemainder = {
    index: 1, svg: firstSvg, svg_path: activeTailPath, item_count: 1,
    strip_width: 300, is_preview: true, is_remainder_preview: true,
  };
  state.nestResult = { is_preview: true, strips: [sparseRemainder] };
  view.showNestResult(0);
  const displayed = dom.svgContainer.innerHTML;
  assert.ok(!dom.nestStats.textContent.includes('Shared edges'), 'do not show a final total on live previews');
  sparseRemainder.svg = nextSvg;
  view.showNestResult(0);
  assert.notEqual(dom.svgContainer.innerHTML, displayed, 'small remainder movements must reach the canvas even when their sampled hashes collide');
  assert.equal(dom.svgContainer.innerHTML, nextStyled);
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}

console.log('Trial tabs update shared layouts; saved extra sheets remain selectable; queued sheets stay blank; final dimensions and preview-only safety are preserved.');
