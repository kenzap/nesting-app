'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const DxfParser = require('dxf-parser');
const editor = require('../shared/placement-editor');
const rect = (x,y,w,h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const entity = (points,layer) => ({type:'LWPOLYLINE',closed:true,layer,vertices:points.map(([x,y])=>({x,y}))});
const shape = points => ({type:'simple_polygon',data:points});
const segments = rings => rings.flatMap(ring=>ring.map((p,i)=>[...p,...ring[(i+1)%ring.length]]));
const outer=rect(0,0,100,80), holes=[rect(10,10,30,50),rect(55,10,35,50)], child=rect(0,0,8,10);
const childItem={id:11,shape:shape(child),allowed_orientations:[0,90,180,270],shared_edge_segments:segments([child])};
const childExport={polygon:child,holes:[],source_name:'child.dxf',layers:[{name:'Child',color:'#00FF00'}],entities:[entity(child,'Child')]};
const items={
  0:{id:0,shape:shape(outer),allowed_orientations:[0,90,180,270],shared_edge_segments:segments([outer,...holes]),
    export:{polygon:outer,holes,material_holes:holes,cutout_holes:holes,source_name:'parent.dxf',
      layers:[{name:'Parent',color:'#FF0000'}],entities:[outer,...holes].map(r=>entity(r,'Parent')),
      cutout_children:[[15,20],[27,38]].map(translation=>({item:childItem,export:childExport,transformation:{rotation:0,translation}}))}},
  1:{id:1,shape:shape(rect(0,0,20,15)),export:{polygon:rect(0,0,20,15),holes:[],
    layers:[{name:'Outside',color:'#0000FF'}],entities:[entity(rect(0,0,20,15),'Outside')]}},
};
const placed=(id,x,y,rotation=0)=>({item_id:id,transformation:{rotation,translation:[x,y]}});
const original=[placed(0,20,20),placed(0,260,20,90),placed(1,340,30)];
const frame={width:450,height:250,margin:5};
const source=JSON.stringify({items,original});
const model=editor.editableLayout(original,items);
assert.equal(model.original.length,7);
assert.deepEqual(model.original.map(p=>p.item_id),[0,2,3,0,2,3,1]);
assert.deepEqual(model.original[1].transformation,{rotation:0,translation:[35,40]});
assert.deepEqual(model.original[4].transformation,{rotation:90,translation:[240,35]});
assert.ok(Object.values(model.items).every(item=>!item.export.cutout_children));
assert.equal(JSON.stringify({items,original}),source,'solver packages remain immutable');
assert.deepEqual(editor.editableLayout(original,{1:items[1],0:items[0]}).original,model.original,'IDs do not depend on property insertion order');
assert.deepEqual(editor.editableLayout([original[2]],items).items,model.items,'item IDs are stable across sheets');

const move = (index,translation) => {
  const edits=editor.editsFor(model.original); edits[index].translation=translation; return edits;
};
for(const [where,position] of [['same opening',[45,40]],['another opening',[80,35]],['outside the parent',[130,35]],
  ['another rotated parent',[210,35]]]) {
  const result=editor.validateEdits(model.original,move(1,position),model.items,frame,2);
  assert.deepEqual(result[1].transformation.translation,position,where);
  assert.deepEqual(result[0],model.original[0],`${where}: parent is not moved`);
  assert.deepEqual(result[4],model.original[4],`${where}: identical copy is not moved`);
}
assert.throws(()=>editor.validateEdits(model.original,move(1,[65,35]),model.items,frame,2),/collision/,'bridge between holes is solid');
assert.throws(()=>editor.validateEdits(model.original,move(1,[30.5,40]),model.items,frame,2),/spacing/,'hole-wall clearance');
assert.throws(()=>editor.validateEdits(model.original,move(1,[47,58]),model.items,frame,0),/collision/,'child-child collision');
assert.throws(()=>editor.validateEdits(model.original,move(1,[440,30]),model.items,frame,0),/bounds/);
const turn=editor.editsFor(model.original);
turn[1]=editor.rotateEdit(turn[1],model.original[1],model.items[2],37);
assert.equal(editor.validateEdits(model.original,turn,model.items,frame,1)[1].transformation.rotation,37);
assert.deepEqual(editor.validateEdits(model.original,move(0,[20,140]),model.items,frame,2)[1],model.original[1],
  'moving the parent away leaves children in place');
assert.throws(()=>editor.validateEdits(model.original,move(0,[35,20]),model.items,frame,0),/collision/,
  'moving parent material over a stationary child is blocked');

const group=editor.editsFor(model.original);
for(const index of [0,1,2]) group[index].translation[1]+=100;
const grouped=editor.validateEdits(model.original,group,model.items,frame,2);
assert.deepEqual(grouped[1].transformation.translation,[35,140]);
assert.deepEqual(grouped[4],model.original[4]);
const withoutParent=editor.validateEdits(model.original,model.edits.filter(e=>e.sourceIndex!==0),model.items,frame,2);
assert.equal(withoutParent.length,6,'deleting parent does not delete children');
const stats=editor.stats(model.original,model.items,frame);
assert.equal(stats.item_count,7);
assert.ok(Math.abs(stats.density-10120/(440*240))<1e-9,'material area is counted once');

const legacy=editor.editsFor(original); legacy[1].translation=[280,30]; legacy.splice(0,1);
const migrated=editor.editableLayout(original,items,legacy);
assert.deepEqual(migrated.edits.map(e=>e.sourceIndex),[3,4,5,6],'old package deletion maps to the right copies');
assert.deepEqual(migrated.edits[1].translation,[260,45],'old package movement is composed once');
assert.throws(()=>editor.editableLayout(original,items,[model.edits[1],model.edits[1]],2),/Invalid/);
assert.throws(()=>editor.editableLayout(original,items,[],999),/version/);
assert.equal(editor.editableLayout(original,items,[{sourceIndex:4,translation:[240,35]}],2).edits[0].rotation,90,
  'translation-only recovery preserves the composed child rotation');

const blockedItems={...model.items,0:{...model.items[0],export:{...model.items[0].export,cutout_holes:[]}}};
assert.equal(editor.validateMove(model.original,1,blockedItems,frame,0),'collision','raw drawing holes are not automatically usable');
const concaveHole=[[10,10],[90,10],[90,70],[60,70],[60,40],[40,40],[40,70],[10,70]];
const concaveItems={0:{shape:shape(outer),export:{cutout_holes:[concaveHole]}},1:{shape:shape(rect(0,0,30,5))}};
assert.equal(editor.validateMove([placed(0,0,0),placed(1,35,55)],1,concaveItems,frame,0),'collision',
  'edges crossing material are rejected even if every corner lies inside the opening');
const snapLayout=editor.applyEdits(model.original,move(1,[31,31]));
const snap=editor.findEdgeSnap(snapLayout,1,editor.editsFor(snapLayout)[1],model.items,frame,0,
  editor.prepareEdgeSnap(snapLayout,1,model.items),{distanceLimit:2});
assert.equal(snap?.contacts?.length,2,'child snaps to two walls of an approved hole');
assert.deepEqual(snap.edit.translation,[30,30]);
const curvedItems={...model.items,0:{...model.items[0],shared_edge_segments:segments([outer])}};
assert.equal(editor.findEdgeSnap(snapLayout,1,editor.editsFor(snapLayout)[1],curvedItems,frame,0,
  editor.prepareEdgeSnap(snapLayout,1,curvedItems),{distanceLimit:2}),null,'unproven curve chords are not snapping targets');

// DXF contours may independently use either winding. Material collisions must
// not depend on the direction of the parent, opening, or child contour.
for (const parentCW of [false,true]) for (const holeCW of [false,true]) for (const childCW of [false,true]) {
  const winding = (ring,clockwise) => clockwise ? ring.slice().reverse() : ring;
  const geometry = {
    0:{shape:shape(winding(rect(0,0,100,80),parentCW)),
      export:{cutout_holes:[winding(rect(10,10,80,60),holeCW)]}},
    1:{shape:shape(winding(rect(0,0,20,20),childCW))},
  };
  const before=JSON.stringify(geometry);
  for (const angle of [0,90,37]) {
    const world=placed(0,200,200,angle);
    const at=(id,x,y)=>placed(id,...editor.transform([[x,y]],world)[0],angle);
    const bounds={width:500,height:500,margin:0};
    const label=`parentCW=${parentCW}, holeCW=${holeCW}, childCW=${childCW}, angle=${angle}`;
    for (const [position,reason,spacing] of [
      [[40,40],null,0],[[125,40],null,0],[[30,40],null,0],[[31,40],'spacing',2],
      [[25,40],'collision',0],[[95,40],'collision',0],[[40,25],'collision',0],[[40,75],'collision',0],
    ]) {
      const pair=[at(0,20,20),at(1,...position)];
      for (const index of [0,1]) assert.equal(editor.validateMove(pair,index,geometry,bounds,spacing),reason,
        `${label}: ${index === 0 ? 'parent' : 'child'} at ${position}`);
    }
    const pair=[at(0,20,20),at(1,40,40)];
    for (const [index,position] of [[0,[35,20]],[1,[25,40]]]) {
      const edits=editor.editsFor(pair);
      edits[index].translation=at(index,...position).transformation.translation;
      assert.throws(()=>editor.validateEdits(pair,edits,geometry,bounds,0),/collision/,`${label}: edited copy ${index}`);
    }
  }
  assert.equal(JSON.stringify(geometry),before,'winding normalization must not change source DXF geometry');
}

async function testExport() {
  const sourcePath=path.resolve(__dirname,'../main/ipc/export-dxf.js'), mod={exports:{}};
  let exportDxf;
  vm.runInNewContext(fs.readFileSync(sourcePath,'utf8'),{
    module:mod,process,console,__dirname:path.dirname(sourcePath),require(name){
      if(name==='electron') return {ipcMain:{handle(key,fn){if(key==='export-sheets-dxf') exportDxf=fn;}}};
      if(name==='../utils/security-scoped-bookmarks') return {withSecurityScopedAccess:(_,fn)=>fn()};
      return createRequire(sourcePath)(name);
    },
  });
  mod.exports.registerExportDxfIpc();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nest-cutout-edits-'));
  try {
    const inputPath=path.join(dir,'input.json'), jsonPath=path.join(dir,'sheet.json');
    fs.writeFileSync(inputPath,JSON.stringify({items:Object.values(items).map(({export:_,...item})=>item),
      cutout_exports:Object.fromEntries(Object.entries(items).map(([id,item])=>[id,item.export])),
      settings:{sheetMargin:5,partSpacing:2,engravingLayer:'off'}}));
    fs.writeFileSync(jsonPath,JSON.stringify({solution:{layout:{placed_items:original}}}));
    const run=(edits,version=2,join=false)=>exportDxf(null,{inputPath,outputDir:dir,joinConnectedLinework:join,
      removeSharedEdges:false,includeSheetOutline:false,strips:[{index:1,json_path:jsonPath,sheet_width:450,strip_height:250,
        sheet_margin:5,manual_edits:edits,manual_edits_version:version}]});
    const read=()=>new DxfParser().parseSync(fs.readFileSync(path.join(dir,'01_sheet_250x450.dxf'),'utf8'));
    const hasChildAt=(parsed,x,y)=>parsed.entities.some(e=>e.layer==='Child'
      && e.vertices.some(p=>Math.abs(p.x-x)<1e-6 && Math.abs(p.y-y)<1e-6));
    for(const join of [false,true]) {
      const response=await run(move(1,[130,35]),2,join);
      assert.equal(response.success,true,response.error);
      const parsed=read();
      assert.equal(parsed.entities.length,11,'expanded children are not exported twice');
      assert.equal(parsed.entities.filter(e=>e.layer==='Child').length,4);
      assert.ok(hasChildAt(parsed,135,40),'child movement and sheet margin applied once');
      assert.ok(hasChildAt(parsed,245,40),'second rotated copy stays in place');
      assert.ok(parsed.tables.layer.layers.Child,'child layer is declared');
    }
    let response=await run(model.edits.filter(e=>e.sourceIndex!==1));
    assert.equal(response.success,true,response.error);
    assert.equal(read().entities.length,10,'deleting one child preserves parent and other children');
    response=await run(model.edits.filter(e=>e.sourceIndex!==0));
    assert.equal(response.success,true,response.error);
    assert.equal(read().entities.length,8,'deleting parent preserves its independent children');
    response=await run([]);
    assert.equal(response.success,true,response.error);
    assert.equal(read().entities.length,0,'delete all exports an empty sheet');
    response=await run(undefined);
    assert.equal(response.success,true,response.error);
    assert.equal(read().entities.length,11,'reset exports original nesting');
    const oldEdits=editor.editsFor(original); oldEdits[0].translation=[30,20];
    // Unversioned edits from the old editor still address solver packages.
    response=await exportDxf(null,{inputPath,outputDir:dir,includeSheetOutline:false,joinConnectedLinework:false,
      strips:[{json_path:jsonPath,sheet_width:450,strip_height:250,sheet_margin:5,manual_edits:oldEdits}]});
    assert.equal(response.success,true,response.error);
    assert.ok(hasChildAt(read(),50,45),'legacy edits still move a whole package');
    response=await run(move(1,[65,35]));
    assert.equal(response.success,false,'export independently rejects material collisions');
    response=await run(model.edits,999);
    assert.equal(response.success,false,'unknown edit schema fails closed');
    const mixed=JSON.parse(fs.readFileSync(inputPath,'utf8'));
    mixed.cutout_exports[0].polygon.reverse();
    mixed.cutout_exports[0].cutout_children.forEach(child=>child.export.polygon.reverse());
    fs.writeFileSync(inputPath,JSON.stringify(mixed));
    response=await run(move(1,[130,35]));
    assert.equal(response.success,true,response.error);
    for (const edits of [move(1,[25,40]),move(0,[30,20])]) {
      response=await run(edits);
      assert.equal(response.success,false,'export rejects mixed-winding parent/child wall crossings');
      assert.match(response.error,/collision/);
    }
    assert.equal(JSON.stringify({items,original}),source,'editing and export never rewrite nesting packages');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}

testExport().then(()=>console.log('Independent cutout editing: identity, movement between openings/parents, material collisions, spacing, snapping, rotation, deletion, legacy edits and DXF export passed.'))
  .catch(error=>{console.error(error);process.exitCode=1;});
