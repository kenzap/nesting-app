'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const DxfParser = require('dxf-parser');

const sourcePath = path.resolve(__dirname, '../main/ipc/export-dxf.js');
let exportDxf;
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
  module: mod, process, console, __dirname: path.dirname(sourcePath),
  require(name) {
    if (name === 'electron') return { ipcMain: { handle(key, handler) {
      if (key === 'export-sheets-dxf') exportDxf = handler;
    } } };
    if (name === '../utils/security-scoped-bookmarks') return { withSecurityScopedAccess: (_, fn) => fn() };
    return createRequire(sourcePath)(name);
  },
});
mod.exports.registerExportDxfIpc();

function inspect(text) {
  const lines = text.split(/\r?\n/), records = [];
  let record, section;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]), value = lines[i + 1];
    if (code === 0) {
      record = { type: value, tags: [], section };
      records.push(record);
    }
    record.tags.push([code, value]);
    if (record.type === 'SECTION' && code === 2) record.section = section = value;
  }
  const value = (r, code) => r.tags.find(t => t[0] === code)?.[1];
  const handles = records.filter(r => r.type !== 'SECTION').map(r => value(r, 5)).filter(Boolean);
  assert.equal(new Set(handles).size, handles.length, 'object handles remain unique');
  const max = handles.reduce((n, h) => Math.max(n, parseInt(h, 16)), 0);
  const seed = parseInt(lines[lines.indexOf('$HANDSEED') + 2], 16);
  assert.equal(seed, max + 1, 'HANDSEED follows every entity, vertex, SEQEND, and dictionary');
  assert.equal(lines[lines.indexOf('$ACADVER') + 2], 'AC1014', 'export still targets R14');
  const objects = records.filter(r => r.type !== 'SECTION' && value(r, 5));
  const byHandle = new Map(objects.map(r => [value(r, 5), r]));
  const blocks = new Map(records.filter(r => r.type === 'BLOCK_RECORD').map(r => [value(r, 2), value(r, 5)]));
  let table, blockOwner, polyline;
  for (const r of records) {
    if (r.type === 'SECTION') continue;
    if (value(r, 5)) {
      const owner = value(r, 330);
      assert.ok(owner, `${r.type} has an explicit owner`);
      assert.ok(owner === '0' || byHandle.has(owner), `${r.type} owner resolves to an exported object`);
      assert.equal(r.tags.filter(t => t[0] === 330).length, 1, 'exactly one ownership link');
    }
    if (r.section === 'TABLES') {
      if (r.type === 'TABLE') {
        table = r;
        assert.equal(value(r, 330), '0', 'symbol tables have a null owner');
      } else if (r.type === 'ENDTAB') table = null;
      else if (value(r, 5)) {
        assert.equal(value(r, 330), value(table, 5), 'table entries belong to their containing table');
      }
    }
    if (r.type === 'LTYPE') {
      assert.notEqual(value(r, 3), undefined, 'linetype description is present');
      assert.equal(value(r, 72), '65');
      assert.equal(value(r, 73), '0');
      assert.equal(Number(value(r, 40)), 0);
    }
    if (r.type === 'BLOCK') blockOwner = blocks.get(value(r, 2));
    if (r.type === 'BLOCK' || r.type === 'ENDBLK') {
      assert.equal(value(r, 330), blockOwner, 'block delimiters belong to the corresponding block record');
    }
    if (r.section === 'ENTITIES' && value(r, 5)) {
      assert.equal(value(r, 330), r.type === 'SEQEND' ? polyline : blocks.get('*MODEL_SPACE'),
        'drawing entities belong to model space; SEQEND belongs to its polyline');
      if (r.type === 'POLYLINE') polyline = value(r, 5);
      if (r.type === 'SEQEND') polyline = null;
    }
  }
  const dictionaries = records.filter(r => r.type === 'DICTIONARY');
  assert.equal(value(dictionaries[0], 330), '0', 'root dictionary has explicit null ownership');
  assert.equal(value(dictionaries[1], 330), value(dictionaries[0], 5));
  assert.equal(value(dictionaries[0], 350), value(dictionaries[1], 5), 'dictionary child link resolves');
  let parent;
  for (const r of records) {
    if (r.type === 'POLYLINE') {
      parent = r;
      const threeD = !!(Number(value(r, 70)) & 8);
      assert.ok(r.tags.some(([code, v]) => code === 100 && v === (threeD ? 'AcDb3dPolyline' : 'AcDb2dPolyline')),
        'polyline subclass must agree with its dimension flag');
    } else if (r.type === 'VERTEX') {
      assert.ok(parent, 'vertices belong to a polyline');
      const threeD = !!(Number(value(parent, 70)) & 8);
      assert.ok(r.tags.some(([code, v]) => code === 100 && v === (threeD ? 'AcDb3dPolylineVertex' : 'AcDb2dVertex')));
      assert.equal(!!(Number(value(r, 70)) & 32), threeD, 'vertex dimensionality matches its parent');
    } else if (r.type === 'SEQEND') parent = null;
  }
  return { max, records };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-dxf-structure-'));
  try {
    const inputPath = path.join(dir, 'input.json'), jsonPath = path.join(dir, 'sheet.json');
    const polygon = [[0, 0], [100, 0], [100, 100], [0, 100]];
    fs.writeFileSync(inputPath, JSON.stringify({ items: [{ id: 0, shape: { data: polygon } }],
      settings: { engravingLayer: 'off', sheetMargin: 0 } }));
    async function write(entities, rotation = 0, translation = [0, 0], includeSheetOutline = false) {
      fs.writeFileSync(jsonPath, JSON.stringify({ solution: { layout: { placed_items: [{ item_id: 0,
        transformation: { rotation, translation } }] } } }));
      const result = await exportDxf(null, { outputDir: dir, inputPath, includeSheetOutline,
        exportItems: { 0: { polygon, entities } }, joinConnectedLinework: false, removeSharedEdges: false,
        strips: [{ index: 1, json_path: jsonPath, sheet_width: 1000, strip_height: 1000 }] });
      assert.equal(result.success, true, result.error);
      return fs.readFileSync(path.join(dir, '01_sheet_1000x1000.dxf'), 'utf8');
    }
    const twoD = { type: 'POLYLINE', layer: '0', shape: true,
      vertices: [{ x: 0, y: 0, bulge: 0.5 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
    const threeD = { type: 'POLYLINE', layer: '0', is3dPolyline: true,
      vertices: [{ x: 1, y: 2, z: 3, threeDPolylineVertex: true },
        { x: 4, y: 5, z: 6, threeDPolylineVertex: true }] };
    const flatThreeD = { ...threeD, vertices: threeD.vertices.map(v => ({ ...v, z: 0 })) };
    const small = await write([twoD, threeD, flatThreeD], 90, [20, 30]);
    const smallInfo = inspect(small);
    const parsed = new DxfParser().parseSync(small).entities;
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].shape, true, 'closed contour is preserved');
    assert.equal(parsed[0].vertices[0].bulge, 0.5, 'curved segments are preserved');
    assert.equal(parsed[1].is3dPolyline, true);
    assert.deepEqual(parsed[1].vertices.map(v => [v.x, v.y, v.z]), [[18, 31, 3], [15, 34, 6]],
      '3D coordinates retain their original placement transform');
    assert.equal(parsed[2].is3dPolyline, true, 'planar 3D polylines are not silently converted');

    const big = await write([{ ...threeD, vertices: Array.from({ length: 66000 }, (_, i) =>
      ({ x: i % 1000, y: Math.floor(i / 1000), z: 0, threeDPolylineVertex: true })) }]);
    const bigInfo = inspect(big);
    assert.ok(bigInfo.max > 0xFFFF, 'fixture exceeds the old hardcoded handle seed');
    assert.equal(bigInfo.records.filter(r => r.type === 'VERTEX').length, 66000, 'no vertex simplification');
    assert.equal(inspect(await write([twoD, threeD, flatThreeD], 90, [20, 30])).max, smallInfo.max,
      'handle allocation resets for each exported file');
    inspect(await write([], 0, [0, 0], true));

    if (process.argv[2]) {
      const original = new DxfParser().parseSync(fs.readFileSync(process.argv[2], 'utf8')).entities;
      const rewritten = await write(original);
      inspect(rewritten);
      const roundTrip = new DxfParser().parseSync(rewritten).entities;
      const geometry = entities => entities.map(e => ({ type: e.type, vertices: e.vertices?.map(v =>
        [v.x, v.y, v.z || 0, v.bulge || 0]), start: e.start, end: e.end, center: e.center, radius: e.radius,
        startAngle: e.startAngle, endAngle: e.endAngle, shape: e.shape, is3dPolyline: e.is3dPolyline }));
      assert.deepEqual(geometry(roundTrip), geometry(original), 'supplied file geometry remains unchanged');
      if (process.argv[3]) fs.writeFileSync(process.argv[3], rewritten, { flag: 'wx' });
      console.log(`Supplied DXF: ${original.length} entities re-exported with consistent polyline types and unchanged geometry.`);
    }
    console.log('DXF structure: polyline types, geometry, small/large handle counters, ownership links, and linetype records passed.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
