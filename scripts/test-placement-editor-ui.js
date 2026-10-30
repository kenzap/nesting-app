'use strict';
// Run with Electron to exercise real SVG transforms and pointer capture.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let win;
const evaluate = script => win.webContents.executeJavaScript(script);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><style>
    #viewport {width:800px;height:500px} svg {width:800px;height:500px} [hidden]{display:none}
    #layoutEdit-rotationHandle {position:fixed;width:34px;height:34px;transform:translate(-50%,-50%);z-index:5}
    </style><button id="editLayout"></button><div id="layoutEditTools" hidden><span id="layoutEditMessage"></span>
    <span id="layoutEdit-angleLabel"></span><input id="layoutEdit-angle" type="number" step="any">
    ${['rotateLeft', 'rotateRight', 'delete', 'undo', 'redo'].map(a => `<button id="layoutEdit-${a}"></button>`).join('')}</div>
    <div id="viewport"><button id="layoutEdit-rotationHandle" hidden>R</button><div id="svgContainer"></div></div><div id="nestStats"></div>`));
  for (const file of ['node_modules/@flatten-js/core/dist/main.umd.js', 'shared/units.js', 'shared/placement-editor.js', 'renderer/views/placement-editor.js']) {
    await evaluate(fs.readFileSync(path.join(root, file), 'utf8'));
  }
  if (process.env.TEST_EDITOR_PLATFORM) {
    await evaluate(`Object.defineProperty(navigator, 'platform', {value:${JSON.stringify(process.env.TEST_EDITOR_PLATFORM)}})`);
  }
  const snapHint = JSON.parse(fs.readFileSync(path.join(root, 'shared/locales/en/translation.json'), 'utf8')).layoutEditor.snapHint;
  await evaluate(`
    window.NestI18n = { t: (key, options) => key === 'layoutEditor.snapHint'
      ? ${JSON.stringify(snapHint)}.replace('{{key}}', options.key) : key };
    window.state = { settings:{measurementSystem:'metric'}, status: 'done', nestRunId: 'test', activeStripIndex: 0, nestRunPartSpacing: 5,
      nestResult: { total_shared_edge_length_mm: 42, strips: [1,2].map(index => ({ index,
        json_path: 'sheet'+index, sheet_width_mode:'fixed', sheet_width:300, strip_width:280,
        strip_height:200, sheet_margin:10, item_count:2, density:0.1, svg:'original' })) } };
    window.fixture = { success:true, items:{0:{shape:{data:[[0,0],[40,0],[40,20],[0,20]]}}},
      strips: state.nestResult.strips.map(s => ({json_path:s.json_path, placements:[20,100].map(x => ({
        item_id:0,transformation:{rotation:0,translation:[x,20]}}))})) };
    window.resetMenuStates = [];
    window.electronAPI = {loadPlacementEditor:async () => structuredClone(fixture),
      setLayoutResetAvailable: available => resetMenuStates.push(available),
      setLayoutEditState: menuState => editMenuStates.push(menuState)};
    window.editMenuStates = [];
    window.dom = Object.fromEntries(['viewport','svgContainer','nestStats'].map(id=>[id,document.getElementById(id)]));
    window.canvasView = {renderTabs(){}, showNestResult(){
      dom.svgContainer.innerHTML = layoutEditorApi.svgForStrip(state.nestResult.strips[state.activeStripIndex],
        {colors:{background:'white',sheetStroke:'gray',partFill:'lightblue',partStroke:'blue'}}) || '';
      window.dispatchEvent(new CustomEvent('nest-canvas-rendered'));
    }};
    window.layoutEditorApi = NestPlacementEditorView.createPlacementEditorView({state,dom,canvasView});
    layoutEditorApi.bind(); document.getElementById('editLayout').click();
  `);
  await settle();
  assert.equal(await evaluate('layoutEditorApi.isActive()'), true);
  assert.deepEqual(await evaluate('editMenuStates.at(-1)'), {canEdit:true, active:true}, 'Edit menu offers Save Layout while editing');
  await evaluate('layoutEditorApi.toggle()');
  assert.equal(await evaluate('layoutEditorApi.isActive()'), false, 'Save Layout leaves edit mode');
  assert.deepEqual(await evaluate('editMenuStates.at(-1)'), {canEdit:true, active:false}, 'Edit menu offers Edit Layout again');
  await evaluate('layoutEditorApi.toggle()');
  await settle();
  assert.equal(await evaluate('layoutEditorApi.isActive()'), true, 'Edit Layout re-enters edit mode');
  assert.equal(await evaluate('document.querySelectorAll("#items use").length'), 2);
  assert.equal(await evaluate('document.getElementById("layoutEdit-rotateRight").disabled'), true);
  async function drag(dx, dy) {
    const start = await evaluate(`(() => { const r=document.querySelector('#items use').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    const scale = await evaluate(`document.querySelector('svg').getScreenCTM().a`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(start.x), y: Math.round(start.y) });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(start.x), y: Math.round(start.y) });
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: Math.round(start.x + dx * scale), y: Math.round(start.y - dy * scale) });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(start.x + dx * scale), y: Math.round(start.y - dy * scale) });
    await settle();
  }
  const key = (key, options = {}, target = 'document.body') => evaluate(`(() => {
    const event = new KeyboardEvent('keydown', {key:${JSON.stringify(key)},bubbles:true,cancelable:true,...${JSON.stringify(options)}});
    ${target}.dispatchEvent(event); return event.defaultPrevented;
  })()`);
  const resetLayout = () => evaluate('window.confirm=()=>true;layoutEditorApi.resetLayout()');
  assert.equal(await key('ArrowRight'), false, 'no selection leaves keyboard navigation alone');
  {
    const start = await evaluate(`(() => { const r=document.querySelector('#items use').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: start.x, y: start.y });
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: start.x + 2, y: start.y + 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: start.x + 2, y: start.y + 1 });
    await settle();
    assert.equal(await evaluate('state.nestResult.strips[0].manual_edits'), undefined, 'a jittery click selects without moving the part');
    assert.equal(await evaluate('document.getElementById("layoutEdit-undo").disabled'), true, 'a click adds no undo step');
    assert.equal(await evaluate('document.querySelectorAll(".manual-placement.selected").length'), 1, 'the clicked part is selected');
  }
  await drag(0, 0);
  assert.equal(await key('ArrowRight'), true, 'selected-part arrow prevents canvas scrolling');
  await key('ArrowRight', {repeat:true});
  await key('ArrowRight', {repeat:true});
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits[0].translation'), [23,20]);
  await evaluate('document.getElementById("layoutEdit-undo").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits'), undefined, 'one undo reverses a held key');
  await evaluate('document.getElementById("layoutEdit-redo").click()');
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits[0].translation'), [23,20]);
  await drag(0, 0);
  await key('ArrowUp');
  await key('ArrowLeft', {shiftKey:true});
  await key('ArrowDown', {shiftKey:true});
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits[0].translation'), [13,11], 'all directions use sheet coordinates');
  const beforeIgnoredKeys = await evaluate('state.nestResult.strips[0].manual_edits');
  assert.equal(await key('ArrowUp', {}, 'document.getElementById("layoutEdit-angle")'), false);
  assert.equal(await key('ArrowLeft', {ctrlKey:true}), false);
  await evaluate('const overlay=document.createElement("div");overlay.id="testModal";overlay.className="modal-overlay open";document.body.append(overlay)');
  assert.equal(await key('ArrowRight'), false, 'modal navigation is not intercepted');
  await evaluate('document.getElementById("testModal").remove()');
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits'), beforeIgnoredKeys);
  await key('ArrowLeft', {}, 'document.getElementById("layoutEdit-rotationHandle")');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits[0].rotation'), 0, 'focused handle arrows move rather than rotate');
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits[0].translation'), [12,11]);
  await evaluate('state.settings.measurementSystem="imperial"');
  await key('ArrowRight');
  await key('ArrowUp', {shiftKey:true});
  const imperialPosition = await evaluate('state.nestResult.strips[0].manual_edits[0].translation');
  assert.ok(Math.abs(imperialPosition[0] - 12.254) < 1e-9);
  assert.ok(Math.abs(imperialPosition[1] - 13.54) < 1e-9);
  await evaluate('state.settings.measurementSystem="metric"');
  await resetLayout();
  await drag(0, 0);
  for (let i=0;i<3;i++) await key('ArrowLeft', {shiftKey:true});
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits[0].translation'), [0,20], 'margin-crossing nudge is rejected');
  assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'), 'layoutEditor.bounds');
  await resetLayout();
  await drag(0, 0);
  for (let i=0;i<3;i++) await key('ArrowRight', {shiftKey:true});
  for (let i=0;i<6;i++) await key('ArrowRight');
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits[0].translation'), [55,20], 'required part spacing is preserved');
  assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'), 'layoutEditor.spacing');
  await key('ArrowRight', {shiftKey:true});
  assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'), 'layoutEditor.collision');
  // A step that is blocked partway still uses the room that is left.
  await resetLayout();
  await drag(0, 0);
  for (let i=0;i<3;i++) await key('ArrowRight', {shiftKey:true});
  await key('ArrowRight');
  await key('ArrowRight', {shiftKey:true});
  const partial = await evaluate('state.nestResult.strips[0].manual_edits[0].translation');
  assert.ok(Math.abs(partial[0] - 55) < 1e-6 && partial[1] === 20,
    `a 10 mm step with 4 mm of room moves the remaining 4 mm to the spacing limit: [${partial}]`);
  assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'), 'layoutEditor.edgeSnapped',
    'the part snaps flush at the end of a shortened step');
  await evaluate('document.getElementById("layoutEdit-undo").click()');
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits[0].translation'), [51,20], 'the shortened step is one undo action');
  await resetLayout();
  await drag(10, 15);
  const moved = await evaluate('state.nestResult.strips[0].manual_edits');
  assert.ok(moved, 'drag commits to placement state');
  assert.ok(Math.abs(moved[0].translation[0] - 30) < 1);
  assert.ok(Math.abs(moved[0].translation[1] - 35) < 1, 'screen up maps to positive DXF Y');
  for (const [x, y] of [[200, 50], [-40, -20]]) {
    await evaluate('window.beforeDeselectSvg = document.querySelector("svg")');
    const blank = await evaluate(`(() => {const p = new DOMPoint(${x}, ${y}).matrixTransform(document.querySelector('svg').getScreenCTM()); return {x:p.x,y:p.y};})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(blank.x), y: Math.round(blank.y) });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(blank.x), y: Math.round(blank.y) });
    await settle();
    assert.equal(await evaluate('document.querySelectorAll(".manual-placement.selected").length'), 0, 'blank clicks clear the highlight');
    for (const action of ['rotateLeft', 'rotateRight', 'delete']) {
      assert.equal(await evaluate(`document.getElementById('layoutEdit-${action}').disabled`), true);
    }
    assert.equal(await evaluate('document.querySelector("svg") === beforeDeselectSvg'), true, 'deselection does not rebuild the preview');
    assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits'), moved, 'deselection leaves placements untouched');
    await drag(0, 0);
    assert.equal(await evaluate('document.querySelectorAll(".manual-placement.selected").length'), 1, 'parts can be selected again');
  }
  await evaluate('document.getElementById("layoutEdit-rotateRight").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits[0].rotation'), 270);
  assert.match(await evaluate('document.querySelector("#items use").getAttribute("transform")'), /rotate\(270\)/);
  await evaluate('document.getElementById("layoutEdit-undo").click()');
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits'), moved);
  await evaluate('document.getElementById("layoutEdit-redo").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits[0].rotation'), 270);
  await drag(0, 0);
  await evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown", {key:"R",shiftKey:true,bubbles:true}))');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits[0].rotation'), 0, 'Shift+R turns left');
  await evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown", {key:"r",ctrlKey:true,bubbles:true}))');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits[0].rotation'), 0, 'do not intercept Ctrl+R');
  await evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown", {key:"r",bubbles:true}))');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits[0].rotation'), 270, 'R turns right');
  await evaluate('document.getElementById("layoutEdit-rotateLeft").click()');
  await drag(65, -15);
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits'), moved, 'overlapping drop reverted');
  assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'), 'layoutEditor.collision');
  await evaluate('document.getElementById("layoutEdit-delete").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].item_count'), 1);
  await evaluate('document.getElementById("layoutEdit-undo").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].item_count'), 2);
  await evaluate('document.getElementById("layoutEdit-redo").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].item_count'), 1);
  await evaluate('state.activeStripIndex=1;canvasView.showNestResult()');
  assert.equal(await evaluate('document.querySelectorAll("#items use").length'), 2, 'other sheet unchanged');
  await evaluate('document.getElementById("layoutEdit-undo").click()');
  assert.equal(await evaluate('state.activeStripIndex'), 0, 'undo returns to affected sheet');
  await evaluate('window.confirm=()=>true;layoutEditorApi.resetLayout()');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits'), undefined);
  assert.equal(await evaluate('state.nestResult.total_shared_edge_length_mm'), 42);
  assert.equal(await evaluate('layoutEditorApi.canReset()'), false, 'nothing left to reset');
  assert.equal(await evaluate('resetMenuStates.at(-1)'), false, 'Edit → Reset Layout is disabled after reset');
  assert.ok(await evaluate('resetMenuStates.includes(true)'), 'Edit → Reset Layout was enabled while edits existed');
  await drag(0, 0);
  assert.equal(await evaluate('document.getElementById("layoutEdit-rotationHandle").hidden'), false);
  await evaluate('document.querySelector("svg").style.transform="scale(0.7)"');
  await settle();
  assert.equal(await evaluate('document.getElementById("layoutEdit-rotationHandle").getBoundingClientRect().width'), 34,
    'rotation handle remains usable at reduced zoom');
  await evaluate('document.querySelector("svg").style.transform=""');
  await settle();
  await evaluate('document.getElementById("layoutEdit-angle").value="32.5";document.getElementById("layoutEdit-angle").dispatchEvent(new Event("change"))');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits[0].rotation'), 32.5, 'exact fractional angles are supported');
  await evaluate('document.getElementById("layoutEdit-undo").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits'), undefined);

  async function turn(degrees, { snap = false, cancel = false } = {}) {
    await drag(0, 0);
    const coords = await evaluate(`(() => {
      const handle=document.getElementById('layoutEdit-rotationHandle').getBoundingClientRect();
      const p=new DOMPoint(50,160).matrixTransform(document.querySelector('svg').getScreenCTM());
      return {x:handle.x+handle.width/2,y:handle.y+handle.height/2,cx:p.x,cy:p.y};
    })()`);
    const rad = -degrees * Math.PI / 180;
    const dx = coords.x - coords.cx, dy = coords.y - coords.cy;
    const x = Math.round(coords.cx + dx * Math.cos(rad) - dy * Math.sin(rad));
    const y = Math.round(coords.cy + dx * Math.sin(rad) + dy * Math.cos(rad));
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(coords.x),y:Math.round(coords.y)});
    win.webContents.sendInputEvent({type:'mouseMove',button:'left',x,y,modifiers:snap?['shift']:[]});
    await settle();
    assert.equal(await evaluate('state.nestResult.strips[0].manual_edits'), undefined, 'drag preview is not committed early');
    assert.match(await evaluate('document.querySelector(".manual-placement.selected").getAttribute("transform")'), /rotate/);
    if (cancel) await evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y});
    await settle();
  }
  await turn(37);
  assert.ok(Math.abs(await evaluate('state.nestResult.strips[0].manual_edits[0].rotation') - 37) < 1);
  await evaluate('document.getElementById("layoutEdit-undo").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits'), undefined, 'one undo reverses the entire gesture');
  await turn(37, {snap:true});
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits[0].rotation'), 30);
  await evaluate('document.getElementById("layoutEdit-undo").click()');
  await turn(37, {cancel:true});
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits'), undefined);
  assert.equal(await evaluate('layoutEditorApi.isActive()'), true, 'Escape cancels rotation without leaving edit mode');
  // Stay inside the boundary despite integer screen-coordinate rounding.
  await drag(0, -15);
  const beforeRejectedTurn = await evaluate('state.nestResult.strips[0].manual_edits');
  await evaluate('document.getElementById("layoutEdit-rotateRight").click()');
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits'), beforeRejectedTurn,
    'rotation outside the sheet is rejected without changing state');
  assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'), 'layoutEditor.bounds');
  await evaluate('document.getElementById("layoutEdit-angle").value="41.5";document.getElementById("layoutEdit-angle").dispatchEvent(new Event("change"))');
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits'), beforeRejectedTurn,
    'invalid precise rotation leaves placements intact');
  assert.equal(await evaluate('document.getElementById("layoutEdit-angle").value'), '0', 'rejected angle field resets');
  async function edgeDrag({ disable = false, cancel = false } = {}) {
    await resetLayout();
    await drag(0,0);
    await evaluate('document.getElementById("layoutEdit-angle").value="1";document.getElementById("layoutEdit-angle").dispatchEvent(new Event("change"))');
    const before = await evaluate('state.nestResult.strips[0].manual_edits');
    const p = await evaluate(`(() => {const r=document.querySelector('#items use').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,scale:document.querySelector('svg').getScreenCTM().a};})()`);
    const x=Math.round(p.x+34*p.scale), y=Math.round(p.y);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(p.x),y:Math.round(p.y)});
    win.webContents.sendInputEvent({type:'mouseMove',button:'left',x,y});
    await settle();
    assert.equal(await evaluate('document.querySelectorAll(".layout-snap-guide").length'), 1, 'nearby straight edges are highlighted during drag');
    assert.equal(await evaluate('document.getElementById("layoutEdit-angle").value'), '0', 'preview corrects the one-degree mismatch');
    assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits'), before, 'snap preview does not commit before release');
    await key('Alt');
    assert.equal(await evaluate('document.querySelectorAll(".layout-snap-guide").length'), 0, 'Alt disables snapping without moving the pointer');
    const modifier = await evaluate(`/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? 'Option' : 'Alt'`);
    assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'),
      `Hold ${modifier} to disable snapping`, 'short hint uses the platform-specific modifier name');
    assert.equal(await evaluate('document.getElementById("layoutEdit-angle").value'), '1');
    if (!disable) {
      await evaluate('document.body.dispatchEvent(new KeyboardEvent("keyup",{key:"Alt",bubbles:true}))');
      assert.equal(await evaluate('document.querySelectorAll(".layout-snap-guide").length'), 1, 'releasing Alt restores snapping');
    }
    if (cancel) await key('Escape');
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y,modifiers:disable?['alt']:[]});
    await settle();
    assert.equal(await evaluate('document.querySelectorAll(".layout-snap-guide").length'), 0, 'guide is removed after drag');
    if (cancel) assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits'), before);
    else if (disable) assert.equal(await evaluate('state.nestResult.strips[0].manual_edits[0].rotation'), 1, 'Alt release preserves the manually chosen angle');
    else {
      const snapped = await evaluate('state.nestResult.strips[0].manual_edits');
      assert.equal(snapped[0].rotation, 0);
      assert.ok(Math.abs(snapped[0].translation[0]-55)<1e-6, 'snapping maintains five mm part spacing');
      await evaluate('document.getElementById("layoutEdit-undo").click()');
      assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits'), before, 'one undo reverses translation and auto-rotation together');
      await evaluate('document.getElementById("layoutEdit-redo").click()');
      assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits'), snapped);
    }
  }
  await edgeDrag();
  await edgeDrag({disable:true});
  await edgeDrag({cancel:true});
  await evaluate(`
    layoutEditorApi.exit();
    state.nestResult = {strips:[{index:1,json_path:'corner',sheet_width_mode:'fixed',sheet_width:300,
      strip_height:200,sheet_margin:10,item_count:3,density:0.1,svg:'original'}]};
    state.activeStripIndex = 0;
    fixture.strips = [{json_path:'corner',placements:[[20,20],[100,20],[55,45]].map(translation => ({
      item_id:0,transformation:{rotation:0,translation}}))}];
    window.dispatchEvent(new CustomEvent('nest-status-changed'));
    document.getElementById('editLayout').click();
  `);
  await settle();
  const cornerPointer = await evaluate(`(() => {const r=document.querySelector('#items use').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2,scale:document.querySelector('svg').getScreenCTM().a};})()`);
  const cornerX = Math.round(cornerPointer.x + 34 * cornerPointer.scale);
  const cornerY = Math.round(cornerPointer.y + cornerPointer.scale);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(cornerPointer.x),y:Math.round(cornerPointer.y)});
  win.webContents.sendInputEvent({type:'mouseMove',button:'left',x:cornerX,y:cornerY});
  await settle();
  assert.equal(await evaluate(`document.querySelector('.layout-snap-guide')?.getAttribute('d').split('M').length - 1`), 4,
    'both target edges and both moving edges are highlighted');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits'), undefined, 'corner preview stays uncommitted');
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:cornerX,y:cornerY});
  await settle();
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits[0].translation'), [55,20],
    'release commits both contacts with five mm spacing');
  await evaluate('document.getElementById("layoutEdit-undo").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits'), undefined, 'corner snap is one undo action');
  await evaluate('document.getElementById("layoutEdit-redo").click()');
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits[0].translation'), [55,20]);
  // ── Multi-selection: Shift+click, group drag/nudge/delete, no group rotation ──
  async function partCenter(n) {
    return evaluate(`(() => { const r=document.querySelectorAll('#items use')[${n}].getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),scale:document.querySelector('svg').getScreenCTM().a}; })()`);
  }
  async function clickPart(n, modifiers = []) {
    const p = await partCenter(n);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:p.x,y:p.y,modifiers});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:p.x,y:p.y,modifiers});
    await settle();
  }
  async function dragPart(n, dx, dy) {
    const p = await partCenter(n);
    const x = Math.round(p.x + dx * p.scale), y = Math.round(p.y - dy * p.scale);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:p.x,y:p.y});
    win.webContents.sendInputEvent({type:'mouseMove',button:'left',x,y});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y});
    await settle();
  }
  const selectedCount = () => evaluate('document.querySelectorAll(".manual-placement.selected").length');
  const translations = () => evaluate('(state.nestResult.strips[0].manual_edits || []).map(e => e.translation)');
  // Pointer moves are whole pixels, so dragged positions are within a pixel.
  const near = (actual, expected, message) => {
    assert.equal(actual.length >= expected.length, true, message);
    expected.forEach((point, i) => point.forEach((value, axis) =>
      assert.ok(Math.abs(actual[i][axis] - value) < 1, `${message}: [${actual[i]}] vs [${point}]`)));
  };
  // This sheet (from the corner-snap check) has three copies; the first two
  // are grouped and the third stays put.
  await resetLayout();
  await clickPart(0);
  await clickPart(1, ['shift']);
  assert.equal(await selectedCount(), 2, 'Shift+click adds a second part');
  assert.equal(await evaluate('document.querySelectorAll(".placement-selection-overlay use").length'), 2, 'every selected part is highlighted');
  assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'), 'layoutEditor.selectedCount');
  for (const action of ['rotateLeft', 'rotateRight']) {
    assert.equal(await evaluate(`document.getElementById('layoutEdit-${action}').disabled`), true, 'rotation is disabled for a group');
  }
  assert.equal(await evaluate('document.getElementById("layoutEdit-delete").disabled'), false);
  assert.equal(await evaluate('document.getElementById("layoutEdit-angle").disabled'), true, 'angle field is disabled for a group');
  assert.equal(await evaluate('document.getElementById("layoutEdit-rotationHandle").hidden'), true, 'no rotation handle for a group');
  await key('r');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits'), undefined, 'R does not rotate a group');
  assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'), 'layoutEditor.groupRotation');

  await dragPart(0, 0, 100);
  near(await translations(), [[20,120],[100,120],[55,45]], 'dragging one selected part moves the whole group');
  assert.equal(await selectedCount(), 2, 'the group stays selected after moving');
  await evaluate('document.getElementById("layoutEdit-undo").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].manual_edits'), undefined, 'one undo reverses the group move');
  await evaluate('document.getElementById("layoutEdit-redo").click()');
  await clickPart(0); await clickPart(1, ['shift']);
  // From y=120 down by 52 leaves the dragged part 3 mm above the third copy
  // (required spacing 5 mm): only it snaps, the group follows, nothing turns.
  await dragPart(0, 0, -52);
  const groupSnapped = await translations();
  assert.ok(Math.abs(groupSnapped[0][1] - 70) < 1e-6 && Math.abs(groupSnapped[1][1] - 70) < 1e-6,
    `group snaps by the dragged part and keeps the 5 mm spacing: ${JSON.stringify(groupSnapped)}`);
  assert.ok(Math.abs((groupSnapped[1][0] - groupSnapped[0][0]) - 80) < 1e-6, 'grouped parts keep their relative offset');
  assert.deepEqual(await evaluate('state.nestResult.strips[0].manual_edits.map(e => e.rotation)'), [0, 0, 0], 'snapping never rotates a group');
  assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'), 'layoutEditor.edgeSnapped');
  const beforeNudge = await translations();
  await key('ArrowRight');
  near(await translations(), [[beforeNudge[0][0] + 1, beforeNudge[0][1]], [beforeNudge[1][0] + 1, beforeNudge[1][1]], [55,45]],
    'arrow keys nudge the whole group');
  const beforeRejected = await translations();
  await dragPart(1, 0, 120);
  assert.deepEqual(await translations(), beforeRejected, 'a group move that leaves the margins is rejected as a whole');
  assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'), 'layoutEditor.bounds');

  await clickPart(1);
  assert.equal(await selectedCount(), 1, 'a plain click on a group member selects only that part');
  assert.equal(await evaluate('document.getElementById("layoutEdit-rotateRight").disabled'), false);
  await clickPart(1, ['shift']);
  assert.equal(await selectedCount(), 0, 'Shift+click on a selected part deselects it');
  assert.equal(await evaluate('document.getElementById("layoutEdit-delete").disabled'), true);

  await clickPart(0); await clickPart(1, ['shift']);
  await evaluate('document.getElementById("layoutEdit-delete").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].item_count'), 1, 'Delete removes every selected copy');
  assert.equal(await evaluate('document.getElementById("layoutEditMessage").textContent'), 'layoutEditor.deletedSelection');
  await evaluate('document.getElementById("layoutEdit-undo").click()');
  assert.equal(await evaluate('state.nestResult.strips[0].item_count'), 3, 'one undo restores the deleted group');
  await resetLayout();

  await evaluate('state.status="running";window.dispatchEvent(new CustomEvent("nest-status-changed"))');
  assert.equal(await evaluate('layoutEditorApi.isActive()'), false);
  assert.equal(await evaluate('document.getElementById("editLayout").disabled'), true);
  assert.deepEqual(await evaluate('editMenuStates.at(-1)'), {canEdit:false, active:false}, 'Edit Layout is disabled while nesting runs');
  console.log('Editor UI: movement, multi-selection, deselection, free rotation, snapping, exact angles, cancellation, bounds, undo/redo, zoom, and running-state guard passed.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
