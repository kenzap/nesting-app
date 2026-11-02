'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const DxfParser = require('dxf-parser');
const cutouts = require('../shared/cutout-packages');
const editor = require('../shared/placement-editor');
const settings = require('../shared/settings');
const rect = (x, y, w, h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const outer = rect(0,0,100,100), hole = rect(10,10,80,80), small = rect(0,0,20,20);
const orientations = [0,90,180,270];
const items = [outer, small].map((data, id) => ({ id, demand: id ? 9 : 2,
  allowed_orientations: orientations, shape: { type:'simple_polygon', data } }));
const entity = (points, layer) => ({ type:'LWPOLYLINE', closed:true, layer, vertices:points.map(([x,y]) => ({x,y})) });
const exportsById = {
  0:{ polygon:outer, holes:[hole], cutout_holes:[hole], source_name:'parent.dxf', layers:[{name:'Parent',color:'#FF0000'}], entities:[entity(outer,'Parent'),entity(hole,'Parent')] },
  1:{ polygon:small, holes:[], source_name:'child.dxf', layers:[{name:'Child',color:'#00FF00'}], entities:[entity(small,'Child')] },
};
const pattern = [ [11,11], [40,11], [11,40], [40,40] ].map(translation => ({ item_id:1, transformation:{rotation:0,translation} }));
const jobs = cutouts.candidateJobs(items, exportsById, 1);
const ready = new Map([[jobs[0].key, {placements:pattern}]]);
const packaged = cutouts.packageItems(items, exportsById, jobs, ready);
assert.equal(settings.SETTINGS_DEFAULTS.allowCutoutNesting, false);
assert.equal(jobs.length, 1);
assert.equal(cutouts.candidateJobs(items, {...exportsById, 0:{...exportsById[0],cutout_holes:[]}},1).length,0,
  'ineligible holes remain drawing data, not nesting regions');
assert.equal(cutouts.candidateJobs(items, {...exportsById, 0:{...exportsById[0],cutout_holes:undefined}},1).length,0,
  'legacy metadata cannot bypass eligibility checks');
assert.equal(jobs[0].request.other_holes.length,0,'selected hole is excluded from obstacles');
const frameRing=rect(5,5,90,90);
const framedExports={...exportsById,0:{...exportsById[0],holes:[hole,frameRing],material_holes:[hole],
  entities:[...exportsById[0].entities,entity(frameRing,'BEND')]}};
const framedJobs=cutouts.candidateJobs(items,framedExports,1);
assert.equal(framedJobs[0].request.other_holes.length,0,'non-cut frame must not be sent as an overlapping hole');
assert.equal(cutouts.materialArea(items[0],framedExports[0]),3600,'frame area is not subtracted from material');
assert.equal(cutouts.rings(items[0],framedExports[0]).length,2,'frame does not cancel the opening in even-odd preview');
assert.deepEqual(packaged.items.map(i => [i.id,i.demand]), [[0,2],[1,1]], 'contiguous IDs and residual quantities');
assert.equal(packaged.exports[0].cutout_children.length, 4);
assert.equal(items[0].demand, 2, 'source inventory is immutable');
assert.equal(exportsById[0].cutout_children, undefined);
assert.equal(cutouts.rings(packaged.items[0], packaged.exports[0]).length, 6, 'outer, hole, four children');
assert.equal(cutouts.materialArea(packaged.items[0], packaged.exports[0]), 5200);
assert.equal(cutouts.candidateJobs(items, exportsById, 31).length, 0, 'spacing rejection');
assert.equal(cutouts.packageItems(items, exportsById, jobs, new Map()).exports[0].cutout_children, undefined, 'unfinished work is not used');
const changed = cutouts.candidateJobs(items, exportsById, 2);
assert.equal(cutouts.packageItems(items, exportsById, changed, ready).exports[0].cutout_children, undefined, 'stale spacing results are ignored');
const restrictive = [{...items[0],allowed_orientations:orientations}, {...items[1],allowed_orientations:[0]}];
const rotated = new Map([[jobs[0].key, { placements:[{item_id:1,transformation:{rotation:90,translation:[40,20]}}] }]]);
assert.deepEqual(cutouts.packageItems(restrictive, exportsById, jobs, rotated).items[0].allowed_orientations, [270], 'package rotations preserve child orientation constraints');
const p = { item_id:0, transformation:{ rotation:90,translation:[150,0] } };
const expanded = cutouts.expandPlacements([p], packaged.items, packaged.exports);
assert.equal(expanded.length, 5);
assert.deepEqual(expanded[1].placement.transformation.translation, [139,11]);
assert.equal(expanded[1].item.export.source_name, 'child.dxf');
const modelItems = Object.fromEntries(packaged.items.map(i => [i.id,{...i,export:packaged.exports[i.id]}]));
assert.equal(editor.stats([p],modelItems,{width:200,height:200,margin:0}).item_count,5);
assert.equal(editor.validateMove([p],0,modelItems,{width:200,height:200,margin:0},1),null);
const summary = cutouts.decorateSummary({total_shared_edge_length_mm:100,strips:[{
  svg:'<use href="#item_0"/><use href="#item_0"/><use href="#item_1"/>',item_count:3,density:0.5,
}]},packaged.exports);
assert.equal(summary.strips[0].item_count,11);
assert.equal(summary.total_shared_edge_length_mm,null,'do not report incomplete shared-edge totals');
const splitExports={...exportsById,0:{...exportsById[0],holes:[rect(10,10,35,80),rect(55,10,35,80)]}};
splitExports[0].cutout_holes=JSON.parse(JSON.stringify(splitExports[0].holes));
const splitJobs=cutouts.candidateJobs(items,splitExports,1);
const splitReady=new Map(splitJobs.map((job,i)=>[job.key,{placements:[11,40,69].map(y=>({item_id:1,
  transformation:{rotation:0,translation:[i?56:11,y]}}))}]));
const split=cutouts.packageItems(items,splitExports,splitJobs,splitReady);
assert.deepEqual(split.items.map(i=>i.demand),[1,1],'second host uses a partial pattern rather than losing leftover children');
assert.deepEqual(Object.values(split.exports).map(e=>e.cutout_children.length),[6,3],'multiple holes share one quantity ledger');
const inventoryReady=new Map();
const sequence=cutouts.preparationJobs(items,splitExports,1,inventoryReady);
const firstOpening=sequence.next().value;
inventoryReady.set(firstOpening.key,splitReady.get(splitJobs[0].key));
const secondOpening=sequence.next().value;
assert.equal(secondOpening.request.items[0].demand,3,'second opening sees stock remaining after both host copies');
inventoryReady.set(secondOpening.key,splitReady.get(splitJobs[1].key));
assert.equal(sequence.next().done,true);
const resolvedJobs=[...cutouts.preparationJobs(items,splitExports,1,inventoryReady)];
assert.deepEqual(resolvedJobs.map(j=>j.key),[firstOpening.key,secondOpening.key],'Run resolves the same quantity-aware cache keys');
const inventoryPacked=cutouts.packageItems(items,splitExports,resolvedJobs,inventoryReady);
assert.deepEqual(Object.values(inventoryPacked.exports).map(e=>e.cutout_children.length),[6,3]);
inventoryReady.set(firstOpening.key,{placements:splitReady.get(splitJobs[0].key).placements.slice(0,1)});
const changedInventory=[...cutouts.preparationJobs(items,splitExports,1,inventoryReady)];
assert.equal(changedInventory[1].request.items[0].demand,7);
assert.notEqual(changedInventory[1].key,secondOpening.key,'changed reservations cannot reuse a stale subset');
const nestedItems=[100,60,20].map((size,id)=>({id,demand:1,allowed_orientations:orientations,shape:{type:'simple_polygon',data:rect(0,0,size,size)}}));
const nestedExports=Object.fromEntries(nestedItems.map(item=>[item.id,{polygon:item.shape.data,holes:item.id<2?[rect(5,5,90-40*item.id,90-40*item.id)]:[]} ]));
Object.values(nestedExports).forEach(metadata=>{metadata.cutout_holes=metadata.holes;});
const nestedJobs=cutouts.candidateJobs(nestedItems,nestedExports,0);
const nestedReady=new Map(nestedJobs.map(job=>[job.key,{placements:[{item_id:job.hostId+1,transformation:{rotation:0,translation:[6,6]}}]}]));
const nested=cutouts.packageItems(nestedItems,nestedExports,nestedJobs,nestedReady);
assert.equal(nested.items.length,2,'one-level nesting leaves the grandchild independent');
assert.equal(nested.exports[0].cutout_children.length,1);
assert.equal(nested.exports[0].cutout_children[0].export.cutout_children,undefined,'a contained part cannot itself be a package');

async function testNative() {
  const executable = process.argv[2] || path.resolve(__dirname, '../native', process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux', 'bin', process.platform === 'win32' ? 'packing.exe' : 'packing');
  const prepare = request => new Promise((resolve,reject) => {
    const worker = new Worker(path.resolve(__dirname,'../main/workers/cutout-worker.js'), {workerData:{executable, request}});
    worker.once('message',resolve); worker.once('error',reject);
  });
  const result = await prepare(jobs[0].request);
  assert.equal(result.success,true,result.error);
  assert.ok(result.placements.length > 0,'native constructor returns validated contained parts');
  assert.ok(result.placements.length <= 9);
  const reversed = await prepare({...jobs[0].request,hole:[...hole].reverse(),parent:[...outer].reverse()});
  assert.equal(reversed.success,true,reversed.error);
  assert.ok(reversed.placements.length > 0,'clockwise boundaries are supported');
  const invalid = await prepare({...jobs[0].request,other_holes:[hole]});
  assert.equal(invalid.success,false,'overlapping hole metadata cannot yield a package');
  const framed=await prepare(framedJobs[0].request);
  assert.equal(framed.success,true,framed.error);
  assert.ok(framed.placements.length>0,'native validation accepts a hole surrounded by non-cut frame geometry');
  const narrowRequest={hole:rect(115,-1917,524,923.5),parent:rect(105,-1927,544,943.5),other_holes:[],
    spacing:0,budget_ms:500,items:[[3,821,360,2],[9,782,280,2],[7,612,280,2],[4,443.24,170,4],[10,434.95,170,4]]
      .map(([id,w,h,demand])=>({id,demand,allowed_orientations:orientations,shape:{type:'simple_polygon',data:rect(0,0,w,h)}}))};
  const narrow=await prepare(narrowRequest);
  assert.equal(narrow.success,true,narrow.error);
  assert.ok(narrow.placements.length>=6,'six narrow parts fit without requiring the larger candidates');
  assert.ok(narrow.placements.filter(p=>p.item_id===4).length<=4);
  assert.ok(narrow.placements.filter(p=>p.item_id===10).length<=4);
  console.log(`Native cutout: ${result.placements.length} validated placements with spacing.`);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nest-cutout-modes-'));
  try {
    for(const mode of ['fixed','max','unlimited']) {
      const cwd=path.join(temp,mode);fs.mkdirSync(cwd);
      const inputPath=path.join(cwd,'packages.json');
      fs.writeFileSync(inputPath,JSON.stringify({name:'packages',items:packaged.items,strip_height:110,
        sheets:[{width:mode==='unlimited'?null:150,height:110,width_mode:mode}],settings:{partSpacing:1,sheetMargin:2},cutout_exports:packaged.exports}));
      const args=['-i',inputPath,'--global-time','1','--workers','1','--rng-seed','42','--min-item-separation','1','--strip-margin','2','--align-bottom-left'];
      if(mode!=='unlimited') args.push('--max-strip-length','146','--multi-strip-mode','barriers');
      await new Promise((resolve,reject)=>execFile(executable,args,{cwd,timeout:30000,maxBuffer:8*1024*1024},error=>error?reject(error):resolve()));
      const sourcePath=path.resolve(__dirname,'../main/ipc/sparrow.js');
      const mod={exports:{}};
      vm.runInNewContext(fs.readFileSync(sourcePath,'utf8')+'\nmodule.exports={collectSparrowArtifacts};',{
        module:mod,process,console,__dirname:path.dirname(sourcePath),require(name){
          if(name==='electron') return {app:{},ipcMain:{}};
          return createRequire(sourcePath)(name);
        },
      });
      const artifacts=mod.exports.collectSparrowArtifacts(cwd,'packages');
      assert.ok(artifacts.summary.strips.length>0,`${mode}: complete sheet output`);
      let total=0;
      for(const strip of artifacts.summary.strips) {
        const placements=editor.readPlacements(JSON.parse(fs.readFileSync(strip.json_path,'utf8')));
        total+=cutouts.expandPlacements(placements,packaged.items,packaged.exports).length;
      }
      assert.equal(total,11,`${mode}: all source copies survive sheet nesting`);
      const decorated=cutouts.decorateSummary(artifacts.summary,packaged.exports);
      assert.equal(decorated.strips.reduce((sum,s)=>sum+s.item_count,0),11,`${mode}: SVG counts agree with placements`);
    }
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}

async function testExport() {
  const sourcePath = path.resolve(__dirname,'../main/ipc/export-dxf.js');
  const mod = {exports:{}};
  let exportDxf;
  vm.runInNewContext(fs.readFileSync(sourcePath,'utf8'), {
    module:mod,process,console,__dirname:path.dirname(sourcePath),
    require(name) {
      if(name === 'electron') return {ipcMain:{handle(key,handler){if(key === 'export-sheets-dxf') exportDxf=handler;}}};
      if(name === '../utils/security-scoped-bookmarks') return {withSecurityScopedAccess:(_,fn)=>fn()};
      return createRequire(sourcePath)(name);
    },
  });
  mod.exports.registerExportDxfIpc();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nest-cutout-test-'));
  try {
    const inputPath=path.join(dir,'input.json'), jsonPath=path.join(dir,'sheet.json');
    fs.writeFileSync(inputPath,JSON.stringify({items:packaged.items,cutout_exports:packaged.exports,settings:{engravingLayer:'off',sheetMargin:2,partSpacing:1}}));
    fs.writeFileSync(jsonPath,JSON.stringify({solution:{layout:{placed_items:[p]}}}));
    for(const join of [false,true]) {
      const result=await exportDxf(null,{outputDir:dir,inputPath,exportItems:join?{}:packaged.exports,joinConnectedLinework:join,removeSharedEdges:true,
        strips:[{index:1,json_path:jsonPath,sheet_width:200,strip_height:200,sheet_margin:2}]});
      assert.equal(result.success,true,result.error);
      const parsed=new DxfParser().parseSync(fs.readFileSync(path.join(dir,'01_sheet_200x200.dxf'),'utf8'));
      assert.equal(parsed.entities.length,6,'parent outline, cutout and four child outlines survive export');
      const child=parsed.entities.find(e=>e.layer==='Child');
      assert.ok(child,'child DXF layer survives');
      assert.ok(parsed.tables.layer.layers.Child,'child layer is declared');
      const point=child.vertices[0];
      assert.ok(Math.abs(point.x-141)<1e-6 && Math.abs(point.y-13)<1e-6,'composed rotation and sheet margin are applied exactly once');
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}

async function testBackground() {
  const handlers={}, pending=[], timers=new Map(); let n=0, calls=0;
  const state={settings:{allowCutoutNesting:true,partSpacing:1,rotationStep:'90',multiSketchDetection:false,sketchContourMethod:'auto',engravingLayer:'off'},
    files:items.map(i=>({id:`file${i.id}`,path:`file${i.id}.dxf`,name:`file${i.id}.dxf`,layers:[{name:'0'}],_shapeCacheVersion:1,
      _multiSketchDetection:false,_sketchContourMethod:'auto',shapes:[{id:`shape${i.id}`,qty:i.demand,polygonPoints:i.shape.data.map(([x,y])=>({x,y})),
        exportEntities:exportsById[i.id].entities,holes:exportsById[i.id].holes.map(h=>({points:h.map(([x,y])=>({x,y})),
          nestingEligible:true,sourceLayers:['Parent']}))}]})),sheets:[]};
  const win={NestCutoutPackages:cutouts,NestConstants:{DXF_SHAPE_CACHE_VERSION:1},NestHelpers:{buildAllowedOrientations:()=>orientations,
    sanitizePolygonPoints:p=>p,clonePlain:v=>JSON.parse(JSON.stringify(v)),effectiveFileQty:()=>1,partLabelFromName:n=>n,buildJobName:()=> 'test'},
    NestDxfExportMetadataService:{recoverStraightContour:p=>p,sharedStraightSegments:()=>[]},
    electronAPI:{cancelCutoutPreparation(){},prepareCutout(){calls++;return new Promise(resolve=>pending.push(resolve));}},
    addEventListener(name,fn){handlers[name]=fn;}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../renderer/services/dxf-service.js'),'utf8'),{
    window:win,console,setTimeout(fn){timers.set(++n,fn);return n;},clearTimeout(id){timers.delete(id);}
  });
  const service=win.NestDxfService.createDxfService({state,getCurrentNestingSettings:()=>state.settings});
  handlers['nest-cutout-input-changed']();
  const prepare=[...timers.values()][0]();
  await Promise.resolve();
  assert.equal(calls,1);
  const early=await service.buildPlacementPayload();
  assert.equal(early.items.length,2,'Run does not wait for pending preparation');
  pending.shift()({success:true,placements:pattern}); await prepare;
  assert.equal(state.lastPlacementExportItems[0].cutout_children,undefined,'late results cannot mutate a run');
  handlers['nest-cutout-input-changed']();
  const next=[...timers.values()].at(-1)(); await Promise.resolve();
  pending.shift()({success:true,placements:pattern}); await next;
  await service.buildPlacementPayload();
  assert.equal(state.lastPlacementExportItems[0].cutout_children.length,4,'completed exact-key preparation is used');
  state.files[0].shapes[0].holes.push({points:frameRing.map(([x,y])=>({x,y})),sourceLayers:['BEND'],nestingEligible:false});
  const framedPayload=await service.buildPlacementPayload({prepareOnly:true});
  assert.equal(framedPayload.exportItems[0].holes.length,2,'raw frame contours remain available');
  assert.equal(framedPayload.exportItems[0].material_holes.length,1,'material mask only uses the proven cut layer');
  assert.equal(framedPayload.exportItems[0].cutout_holes.length,1);
  state.files[0].shapes[0].holes.pop();
  state.files[0].shapes[0].holes[0].nestingEligible=false;
  const rejected=await service.buildPlacementPayload();
  assert.equal(rejected.items[1].demand,9,'newly rejected holes cannot reuse an old successful preparation');
  assert.equal(state.lastPlacementExportItems[0].cutout_children,undefined);
  state.files[0].shapes[0].holes[0].nestingEligible=true;
  state.settings.allowCutoutNesting=false;
  handlers['nest-cutout-input-changed']();
  const off=await service.buildPlacementPayload();
  assert.equal(off.items[1].demand,9,'Off restores uncoupled demand');
  assert.equal(off.cutout_exports,undefined);
  assert.equal(state.lastPlacementExportItems[0].cutout_children,undefined);
  state.files[0].shapes[0].holes[0].nestingEligible=false;
  const excluded=await service.buildPlacementPayload({prepareOnly:true});
  assert.equal(excluded.exportItems[0].cutout_holes.length,0);
  assert.equal(excluded.exportItems[0].holes.length,1,'eligibility must not remove drawing holes');
  state.files[0].shapes[0].holes[0].nestingEligible=true;
  state.settings.engravingLayer='1';
  state.files[0].layers=[{name:'Parent'}];
  const engraved=await service.buildPlacementPayload({prepareOnly:true});
  assert.equal(engraved.exportItems[0].cutout_holes.length,0,'explicit engraving layer overrides eligibility');
  state.settings.engravingLayer='off';
  state.settings.allowCutoutNesting=true;
  state.files[0]._shapeCacheVersion=0;
  state.files[0].shapes[0].holes[0].nestingEligible=false;
  win.electronAPI.parseDXF=async()=>({success:true,data:{}});
  win.parseDXFToShapes=()=>({layers:[{name:'Parent'}],shapes:[{
    ...state.files[0].shapes[0],holes:[{...state.files[0].shapes[0].holes[0],nestingEligible:true}],
  }]});
  handlers['nest-cutout-input-changed']();
  const refreshed=[...timers.values()].at(-1)();
  for(let i=0;i<20 && !pending.length;i++) await Promise.resolve();
  assert.equal(state.files[0]._shapeCacheVersion,1,'background preparation refreshes stale eligibility before Run');
  assert.equal(pending.length,1,'refreshed opening is prepared rather than waiting for a second run');
  pending.shift()({success:true,placements:pattern}); await refreshed;
  await service.buildPlacementPayload();
  assert.equal(state.lastPlacementExportItems[0].cutout_children.length,4);
}

(async()=>{
  await testBackground();
  await testNative();
  await testExport();
  console.log('Cutout nesting: quantities, cache invalidation, nonblocking Run, rotations, preview rings, stats, editing and DXF export passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
