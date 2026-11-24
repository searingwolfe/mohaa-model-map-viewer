// MOHAA Map Viewer's Edit map: page code every map page carries. mohaa_map_view.py inlines
// this file at the end of the page script, just before main() runs. It is dormant until
// the page's editor mode is on (window.__EDITON__: #edit=1 in the URL the launcher opens,
// or setEditorMode(true) when View > Edit map is turned on); turning it on or off shows
// or hides its section and its picking in place, never rebuilding the page. Changes already
// made (brush entity rows, brush / patch / terrain edits) stay, save and undo with the
// mode off. It reads the page's globals and adds:
//   - the EDITOR section at the top of the side panel, with MODIFY moved up under it;
//   - New map..., which asks the launcher (mohaa-edit-new) to write a starter .map and open it;
//   - brush entities (doors, triggers, ladders...) in Modify, as whole units;
//   - the level script, edited in the page and saved beside the map by the launcher.
// The page's functions it changes are reassigned here (function declarations are plain
// global bindings), each wrapping the page's own.
(function(){
'use strict';
window.MOHAA_EDITOR=true;
const EON=()=>!!window.__EDITON__;          // the editor mode (setEditorMode in the page head)
const inHost=()=>{try{return !!(window.chrome&&window.chrome.webview);}catch(_e){return false;}};
const post=m=>{try{if(inHost()){window.chrome.webview.postMessage(m);return true;}}catch(_e){}return false;};
const fmt=v=>{const r=Math.round(v*1000)/1000;return String(Object.is(r,-0)?0:r);};

function edNew(){
  if(!post('mohaa-edit-new'))flash('New map needs the Map Viewer window (Edit map): it writes the file and opens it');
}

// ==== brush entities in Modify ==========================================================
// A brush entity's place is its "origin" key, as in the game: SV_SetBrushModel gives the
// entity its brush model's bounds, and the model is drawn and collides at origin + bounds.
// The compiler writes an origin only for an entity with an origin brush (a door's hinge);
// the others have none, which is 0 0 0. In Modify such an entity's row gets an origin at the
// middle of its brushes (its anchor), so moving, trimming and Edit parameters work as for
// any entity. Saving turns that back into what the file holds:
//   .bsp  origin = the offset from where the compiler put it (left out when there is none),
//         or, with an origin brush, the origin moved by that offset;
//   .map  the brushes and patches themselves moved (texture shifts kept with them, as
//         MOHRadiant's texture lock does), and the origin key only if it had one.
// The map's own geometry is drawn where the row says (moved like an open door, entPose), so
// a moved door or trigger is picked and selected where it is now.
const BR=new Map();          // ei -> {base: the origin key or null, anchor, d: entPose's door-like record}
function brOk(ei){
  if(!(ei>0)||!MAP||ei>=MAP.ents.length)return false;
  // (the .bsp's static models come after its entities, with no brushes of their own; a brush
  // entity Copy adds goes at the end, after them, and is one all the same)
  const e=MAP.ents[ei],X=ENTS[ei],fs=(D.bsp&&D.bsp.firstStatic!=null)?D.bsp.firstStatic:(MAP.nMap||MAP.ents.length);
  return !!X&&X.hasGeo&&!!X.box&&!WORLDLIKE[e.cls]&&!e.scr&&(ei<fs||e.prims.some(Boolean));
}
function brInfo(ei){
  let I=BR.get(ei);if(I)return I;
  const X=ENTS[ei],b=X.box,base=parseVec(MAP.ents[ei].kvl.origin,3);
  const mid=[0,1,2].map(k=>b.origin[k]+(b.mins[k]+b.maxs[k])/2);
  I={base:base,anchor:base?base.slice():mid.map(v=>+fmt(v)),d:null};BR.set(ei,I);return I;
}
function brRow(m){return !!m&&m.ei!=null&&brOk(m.ei);}
// how far the row has moved the entity from where the map has it
function brDelta(m){const I=brInfo(m.ei),o=modOrigin(m);return[o[0]-I.anchor[0],o[1]-I.anchor[1],o[2]-I.anchor[2]];}
// the origin key the .bsp gets: base + delta, or delta alone; null for none
function brBspOrigin(m){const I=brInfo(m.ei),d=brDelta(m);
  if(I.base)return[I.base[0]+d[0],I.base[1]+d[1],I.base[2]+d[2]];
  return(d[0]||d[1]||d[2])?d:null;}
// the row's keys as the file holds them (the anchor taken back out)
function brKv(m){
  const o=brBspOrigin(m),out=[];let put=false;
  for(const[k,v]of m.kv){if(k.toLowerCase()==='origin'){if(o&&!put){out.push([k,o.map(fmt).join(' ')]);put=true;}continue;}out.push([k,v]);}
  if(o&&!put)out.push(['origin',o.map(fmt).join(' ')]);
  return out;
}

// a door works as its Modify row's keys say (doortype, angle, openangle... typed in Class
// specs) before they are saved
const _doorNew=doorNew;
doorNew=function(ei){
  const e=MAP.ents[ei],m=(MOD&&MOD.ents)?MOD.ents.find(x=>x.ei===ei&&!x.del):null;if(!e||!m)return _doorNew(ei);
  const kv=e.kv,kvl=e.kvl,hadO=kv.some(x=>x[0].toLowerCase()==='origin');
  e.kv=m.kv.filter(x=>hadO||x[0].toLowerCase()!=='origin');e.kvl={};for(const[k,v]of e.kv){const l=k.toLowerCase();if(!(l in e.kvl))e.kvl[l]=v;}
  try{return _doorNew(ei);}finally{e.kv=kv;e.kvl=kvl;}};
// a .bsp's static props (its static model lump, not its entity lump): Modify takes them with
// Edit map on. Save as .bsp writes their place, turn and scale into that lump
// (write_bsp_entities); Save as .map and Compile... write them as the .map's entities.
function edStaticOk(ei){
  if(!(ei>0)||!MAP||ei>=MAP.nMap||!(D.bsp&&D.bsp.firstStatic>0)||ei<D.bsp.firstStatic)return false;
  const e=MAP.ents[ei],X=ENTS[ei];return !!e&&!e.scr&&e.ts>=0&&!!X&&!!X.origin&&!X.hasGeo&&isStaticProp(ei);}
const _modTakes=modTakes;
modTakes=function(ei){return _modTakes(ei)||(EON()&&(brOk(ei)||edStaticOk(ei)));};

// the row a selected brush entity gets carries its anchor as its origin, in kv and orig alike
const _modSyncSel=modSyncSel;
modSyncSel=function(){
  _modSyncSel();
  let ch=false;
  for(const m of MOD.ents)if(brRow(m)&&!m.brA){m.brA=true;
    if(modKv(m,'origin')==null){const a=brInfo(m.ei).anchor.map(fmt).join(' ');m.kv.push(['origin',a]);if(m.orig)m.orig.push(['origin',a]);ch=true;}}
  if(ch)modRender();
};
const _modRestore=modRestore;
modRestore=function(s){_modRestore(s);for(const m of MOD.ents)if(brRow(m))m.brA=true;};

// Modify draws no box of its own for them: their brushes are drawn (moved), with the map's
// own label and selection
const _modDrawn=modDrawn;
modDrawn=function(i){const m=MOD.ents[i];return brRow(m)?false:_modDrawn(i);};
const _modBox=modBox;
modBox=function(m){
  if(!brRow(m))return _modBox(m);
  const X=ENTS[m.ei],b=X.box,a=brInfo(m.ei).anchor;
  return{mins:[0,1,2].map(k=>b.origin[k]+b.mins[k]-a[k]),maxs:[0,1,2].map(k=>b.origin[k]+b.maxs[k]-a[k])};
};
// Move puts its middle under the cursor, its bottom on the spot
const _modPlaceAt=modPlaceAt;
modPlaceAt=function(h,cls){
  const src=MOD.placing&&MOD.placing.move!=null?MOD.ents[MOD.placing.move]:null;
  if(!brRow(src))return _modPlaceAt(h,cls);
  if(!h||!h.point)return null;
  const b=modBox(src),p=h.point,up=-b.mins[2];
  if(!GRID.on)return[Math.round(p[0]),Math.round(p[1]),Math.round(p[2]+up)];
  const o=[gridSnap(p[0]),gridSnap(p[1]),gridSnap(p[2]+up)];if(o[2]<p[2]+up-0.01)o[2]+=gridSize();
  return o;
};
// Copy (Alt+C) with brushes selected: the editor's copy (edCarryStart), which follows the
// mouse until a click puts it down; with entities selected, Modify's; never both at once
const _modCopySel=modCopySel;
modCopySel=function(){
  if(ED.carry){edCarryEnd();flash('Copy: taken away');return;}
  let c=null;try{c=edCopySet();}catch(err){console.error(err);}
  if(c&&(c.prims.length||c.ents.length)){
    if(c.pts){flash('Copy takes brushes or entities, not both: Shift+click to leave one kind out of the selection');return;}
    if(!EON()){flash('Brushes are copied with Edit map on');return;}
    try{edCarryStart(c);}catch(err){flash(err.message);}
    return;}
  _modCopySel();
};

// drawn where the rows put them: the door's own transform with the row's offset added
function brOffset(ei){
  if(!brOk(ei))return null;
  const m=MOD.ents.find(x=>x.ei===ei);if(!m||m.del||!brRow(m))return null;
  const d=brDelta(m);return(d[0]||d[1]||d[2])?d:null;
}
const _doorXf=doorXf;
doorXf=function(ei){
  const X=_doorXf(ei),t=brOffset(ei);if(!t)return X;
  if(!X)return{R:[1,0,0,0,1,0,0,0,1],o:[0,0,0],t:t,yaw:0};
  return{R:X.R,o:X.o,t:[X.t[0]+t[0],X.t[1]+t[1],X.t[2]+t[2]],yaw:X.yaw};
};
// what moves a brush entity the row has moved (not a door): its box, as a door's, for what
// draws a moved door's box (the selection's outline, Fly to's bounds)
const _movObj=movObj;
movObj=function(ei){const d=_movObj(ei);if(d||!brOffset(ei))return d;
  const I=brInfo(ei);if(!I.d){const b=ENTS[ei].box;I.d={ei:ei,o:b.origin.slice(),mins:b.mins.slice(),maxs:b.maxs.slice(),gm:null};}return I.d;};
const brPosed=new Map();      // ei -> the offset its geometry was last put at
function brPose(ei){
  const door=DOORS&&DOORS.get(ei);
  if(door){doorPose(door);return;}
  const I=brInfo(ei);
  if(!I.d){const b=ENTS[ei].box;I.d={ei:ei,o:b.origin.slice(),mins:b.mins.slice(),maxs:b.maxs.slice(),gm:null};}
  entPose(I.d,doorXf(ei));
}
function brSync(){
  if(!gl||!MAP)return;
  const want=new Map();
  for(const m of MOD.ents)if(brRow(m)){const t=brOffset(m.ei);if(t)want.set(m.ei,t.join(','));}
  let moved=false;
  for(const[ei,k]of want)if(brPosed.get(ei)!==k){brPose(ei);brPosed.set(ei,k);moved=true;}
  for(const ei of[...brPosed.keys()])if(!want.has(ei)){brPose(ei);brPosed.delete(ei);moved=true;}
  if(moved){rebuildSelection();lineDirty=true;requestDraw();}
}
const _modRender=modRender;
modRender=function(){_modRender();try{brSync();}catch(err){console.error(err);}try{edSaveButtons();}catch(_e){}try{edCopyBtn();}catch(_e){}
  try{if(EON()&&!!ED._entOnly!==edEntOnly())edPanel();}catch(_e){}};   // the tools on or off as Modify's selection changes
// Modify's own render enables its saves by its entities only: brush, patch and terrain
// changes (ED.n) count too, for Save as .map; Save as .bsp stays off and says why
function edSaveButtons(){
  const sm=$('bModSaveMap'),sb=$('bModSaveBsp');if(!sm||!sb)return;
  if(sb.dataset.title==null)sb.dataset.title=sb.title;
  if(ED.n>0){sm.disabled=false;sb.disabled=true;
    sb.title='Brushes, patches or terrain changed, and a .bsp holds them compiled: use Save as .map (then Compile map makes the .bsp)';}
  else sb.title=sb.dataset.title;
}
// a deleted (DEL) or hidden one: its faces go with it (the map's markers already do, MOD_HID)
let BRHID=new Set();
const _faceShown=faceShown;
faceShown=function(f){
  if(BRHID.size&&BRHID.has(SC.faceEnt[f]))return false;
  // a brush, patch or terrain block added or changed here and not saved yet is drawn (and so
  // can be clicked) whatever the Show buttons hide (Caulk, Clips, Nodraw...), as Modify's
  // new entities are; only Hide on it, or on its entity, hides it
  if(EDNEW.size&&EDNEW.has(SC.facePrim[f]))return !(hidPrim.size&&hidPrim.has(SC.facePrim[f]))&&!(hidEnt.size&&hidEnt.has(SC.faceEnt[f]));
  return _faceShown(f);};
const _modHideSync=modHideSync;
modHideSync=function(){
  _modHideSync();
  const s=new Set();for(const m of MOD.ents)if(brRow(m)&&(m.hid||m.del))s.add(m.ei);
  if(s.size===BRHID.size&&[...s].every(x=>BRHID.has(x)))return;
  BRHID=s;if(gl)rebuildWorld();
};

// ---- saving: the keys and brushes as the file holds them --------------------------------
const _modSets=modSets;
modSets=function(){
  return _modSets().map(s=>{const m=MOD.ents.find(x=>x.ei===s.ei&&modIsMap(x));
    if(!brRow(m))return s;
    const I=brInfo(m.ei);
    return Object.assign({},s,{origin:I.base?I.base.slice():null,kv:m.del?MAP.ents[m.ei].kv.map(x=>[x[0],x[1]]):brKv(m)});});
};
// a brush face line: ( x y z ) ( x y z ) ( x y z ) texture sx sy rot scx scy ...
const FACE_RE=/^(\s*)\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)\s*\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)\s*\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)(\s*)(.*)$/;
function brMoveFace(ln,d){
  const r=FACE_RE.exec(ln);if(!r)return null;
  const v=r.slice(2,11).map(Number);if(v.some(x=>!isFinite(x)))return null;
  const P=[v.slice(0,3),v.slice(3,6),v.slice(6,9)].map(p=>[p[0]+d[0],p[1]+d[1],p[2]+d[2]]);
  let rest=r[12];
  // the texture shift that keeps the picture where it was (QuakeTextureVecs: s = p . sv + shift)
  const t=/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(.*)$/.exec(rest);
  if(t&&!/^\(/.test(rest)){
    const a=v.slice(0,3),b=v.slice(3,6),c=v.slice(6,9);
    const u=[a[0]-b[0],a[1]-b[1],a[2]-b[2]],w=[c[0]-b[0],c[1]-b[1],c[2]-b[2]];
    let n=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];const l=Math.hypot(n[0],n[1],n[2]);
    const sh=[+t[2],+t[3]],rot=+t[4],sc=[+t[5],+t[6]];
    if(l>0&&[sh[0],sh[1],rot,sc[0],sc[1]].every(isFinite)){n=n.map(x=>x/l);
      const V=texVecs(n,sh,rot,sc);
      const ns=sh[0]-(V[0]*d[0]+V[1]*d[1]+V[2]*d[2]),nt=sh[1]-(V[4]*d[0]+V[5]*d[1]+V[6]*d[2]);
      rest=t[1]+' '+fmt(ns)+' '+fmt(nt)+' '+t[4]+' '+t[5]+' '+t[6]+t[7];}}
  return r[1]+P.map(p=>'( '+p.map(fmt).join(' ')+' )').join(' ')+r[11]+rest;
}
// a patch's control point rows: ( ( x y z s t ) ( x y z s t ) ... )
function brMovePatchRow(ln,d){
  return ln.replace(/\(\s*(-?[\d.e+-]+)\s+(-?[\d.e+-]+)\s+(-?[\d.e+-]+)\s+(-?[\d.e+-]+)\s+(-?[\d.e+-]+)\s*\)/gi,
    (all,x,y,z,s,t)=>'( '+fmt(+x+d[0])+' '+fmt(+y+d[1])+' '+fmt(+z+d[2])+' '+s+' '+t+' )');
}
// the entity's block with its keys and its brushes moved by d; throws when it holds
// something that can't be moved here (a terrain block)
// the keys a .map block gets: the brushes carry the move, so an origin only where the map
// had one (an origin brush's pivot), moved with them
function brMapKv(m){
  const I=brInfo(m.ei),d=brDelta(m),out=[];
  for(const[k,v]of m.kv){if(k.toLowerCase()!=='origin'){out.push([k,v]);continue;}
    if(I.base)out.push([k,[I.base[0]+d[0],I.base[1]+d[1],I.base[2]+d[2]].map(fmt).join(' ')]);}
  return out;
}
function brBlock(m,src){
  const lines=src.split('\n'),d=brDelta(m),out=['{',modText({kv:brMapKv(m)}).split('\n').slice(1,-1).join('\n')];
  let depth=0,kind='',started=false;
  for(let i=0;i<lines.length;i++){const ln=lines[i],s=ln.trim();
    if(!started){if(s==='{'){depth++;if(depth===2){started=true;out.push(ln);}}
      else if(depth===1&&s.startsWith('//'))out.push(ln);
      continue;}
    if(s==='{'){depth++;out.push(ln);continue;}
    if(s==='}'){depth--;if(depth===1)kind='';out.push(ln);if(depth===0)break;continue;}
    if(/^(patchdef2|patchdef3)$/i.test(s)){kind='patch';out.push(ln);continue;}
    if(/^terraindef$/i.test(s))throw new Error('it has a terrain block');
    if(/^brushdef$/i.test(s)){kind='bp';out.push(ln);continue;}
    if(d[0]||d[1]||d[2]){
      if(kind==='patch'&&/^\(\s*\(/.test(s)){out.push(brMovePatchRow(ln,d));continue;}
      if(s[0]==='('&&kind!=='patch'){const f=brMoveFace(ln,d);if(f==null)throw new Error('a brush line it can\'t read: '+s.slice(0,50));out.push(f);continue;}}
    out.push(ln);}
  return out.join('\n');
}
// the .map with the changes, as the page's own modMapText writes it (each changed entity's
// block written again, last first so the earlier offsets hold, the new ones added), with a
// brush entity's block keeping its brushes, moved
modMapText=function(){
  let t=D.srcText;const ch=MOD.ents.filter(m=>modIsMap(m)&&modEdited(m)).sort((a,b)=>MAP.ents[b.ei].ts-MAP.ents[a.ei].ts);
  for(const m of ch){const e=MAP.ents[m.ei];if(!(e.ts>=0&&e.te>e.ts))continue;
    let blk='';
    if(!m.del){if(brRow(m)){try{blk=brBlock(m,t.slice(e.ts,e.te));}catch(err){throw new Error(entName(m.ei)+': '+err.message);}}
      else blk=edKeysKeepBrushes(m,t.slice(e.ts,e.te));}
    t=t.slice(0,e.ts)+blk+t.slice(e.te);}
  t=worldMapText(t);            // the world's key lines, as its card changed them
  const add=MOD.ents.filter(m=>!modIsMap(m));
  if(add.length)t=t.replace(/\s*$/,'\n')+'// added in MOHAA Map Viewer\'s MODIFY\n'+add.map(modText).join('\n')+'\n';
  return t;
};
// a row's keys over an entity's block that keeps whatever brushes, patches or terrain the block
// has, as they are (a point entity's block is just its keys): the brushes are never left out
function edKeysKeepBrushes(m,blk){
  const kt=modText(m);let depth=0,q=false,k=-1;
  for(let i=0;i<blk.length;i++){const c=blk[i];
    if(c==='"'){q=!q;continue;}if(q)continue;
    if(c==='/'&&blk[i+1]==='/'){const j=blk.indexOf('\n',i);if(j<0)break;i=j;continue;}
    if(c==='{'){depth++;if(depth===2){k=i;break;}}else if(c==='}')depth--;}
  if(k<0)return kt;
  const ls=blk.lastIndexOf('\n',k)+1,pre=blk.slice(ls,k).trim()?k:ls;       // a "// brush 0" line before it goes along
  let st=pre;{const p0=blk.lastIndexOf('\n',ls-2)+1;if(/^\s*\/\/\s*brush/i.test(blk.slice(p0,ls)))st=p0;}
  return kt.replace(/\}\s*$/,'')+blk.slice(st,blk.lastIndexOf('}'))+'}';
}
// a .map that can't be written (a brush line it can't read) says why instead of saving
const _modSave=modSave;
modSave=function(kind){
  if(kind==='map'){try{modMapText();}catch(err){const s='Not saved: '+err.message;flash(s);$('modStat').textContent=s;MOD.closeAfter=false;return;}}
  _modSave(kind);
};
const _modCopyText=modCopyText;
modCopyText=function(){
  const sv=MOD.ents.map(m=>m.kv);
  try{MOD.ents.forEach(m=>{if(brRow(m))m.kv=brKv(m);});return _modCopyText();}
  finally{MOD.ents.forEach((m,i)=>{m.kv=sv[i];});}
};

// ==== the level script ===================================================================
// The map's .scr, beside the map file, edited in a box over the view. The launcher reads it
// (mohaa-edit-scr-load: the file beside the map, else a starting script) and saves it
// (mohaa-edit-scr-save), then builds the page again so what it spawns is redrawn; Modify's
// unsaved work and the camera come back with it.
const SCR={open:false,path:'',dirty:false,base:''};
function scrBox(){
  if($('edScr'))return $('edScr');
  const ov=document.createElement('div');ov.className='ov';ov.id='edScr';ov.style.display='none';
  ov.innerHTML='<div class="card" style="width:min(1000px,94vw);height:min(760px,90vh);display:flex;flex-direction:column">'+
    '<h3 id="edScrT" style="margin:0 0 4px">Level script</h3><div class="co" id="edScrP" style="margin-bottom:6px"></div>'+
    '<textarea id="edScrTxt" spellcheck="false" wrap="off" style="flex:1;width:100%;box-sizing:border-box;font:12px ui-monospace,Menlo,Consolas,monospace;tab-size:4;white-space:pre;resize:none"></textarea>'+
    '<div class="row" style="margin-top:8px;gap:6px"><span class="co" id="edScrSt" style="flex:1"></span>'+
    '<button id="edScrSave" title="Write it beside the map (the old file kept as .bak), then build the page again (Ctrl+S)">Save</button>'+
    '<button id="edScrClose" title="Close (Esc). Unsaved text asks first">Close</button></div></div>';
  $('stage').appendChild(ov);
  const ta=$('edScrTxt');
  ta.addEventListener('input',()=>{SCR.dirty=ta.value!==SCR.base;$('edScrSt').textContent=SCR.dirty?'changed, not saved':'';});
  ta.addEventListener('keydown',e=>{
    if(e.key==='Tab'){e.preventDefault();const a=ta.selectionStart,b=ta.selectionEnd;ta.setRangeText('\t',a,b,'end');ta.dispatchEvent(new Event('input'));}
    else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();scrSave();}
    else if(e.key==='Escape'){e.preventDefault();scrClose();}
    e.stopPropagation();});
  ov.addEventListener('keyup',e=>e.stopPropagation());
  $('edScrSave').onclick=scrSave;$('edScrClose').onclick=scrClose;
  return ov;
}
function scrOpen(){
  if(!D)return;
  if(!post('mohaa-edit-scr-load\n'+JSON.stringify({src:D.srcFile||'',name:D.name||''}))){
    flash('The level script is edited from the Map Viewer window (Edit map), which reads and writes the file');return;}
  flash('Reading the level script...');
}
window.MOHAA_EDIT_SCR=function(r){
  if(!r||!r.ok){flash((r&&r.msg)||'The level script can\'t be edited here');if(r&&r.msg)$('edNote2').textContent=r.msg;return;}
  const ov=scrBox();SCR.open=true;SCR.path=String(r.path||'');SCR.base=String(r.text||'');SCR.dirty=false;
  $('edScrT').textContent='Level script: '+SCR.path.split(/[\\/]/).pop();
  $('edScrP').textContent=r.note||SCR.path;$('edScrTxt').value=SCR.base;$('edScrSt').textContent='';
  ov.style.display='';stopCamera();setTimeout(()=>$('edScrTxt').focus(),0);
};
function scrClose(){
  if(SCR.dirty&&!window.confirm('The level script has changes that are not saved. Close it anyway?'))return;
  SCR.open=false;const ov=$('edScr');if(ov)ov.style.display='none';
}
function scrSave(){
  const txt=$('edScrTxt').value;
  if(!D||!post('mohaa-edit-scr-save\n'+JSON.stringify({src:D.srcFile||'',name:D.name||'',text:txt}))){flash('Saving needs the launcher');return;}
  $('edScrSt').textContent='saving...';
}
// the launcher's answer; on success it builds the page again: keep the camera and Modify's work
window.MOHAA_EDIT_SCR_SAVED=function(ok,msg){
  $('edScrSt').textContent=msg;flash(msg);
  if(!ok)return;
  SCR.base=$('edScrTxt').value;SCR.dirty=false;
  try{modBackupNow();MOD.leaving=true;}catch(_e){}
  post('mohaa-edit-scr-reload\n'+JSON.stringify({map:D.name||'',pos:cam.pos,yaw:cam.yaw,pitch:cam.pitch,roll:cam.roll}));
};
// the camera a script save kept, handed back by the launcher once the new page is ready
window.MOHAA_EDIT_CAM=function(c){
  if(!c||c.map!==(D.name||'')||!Array.isArray(c.pos)||c.pos.length!==3||!c.pos.every(isFinite))return;
  cam.pos=c.pos.map(Number);cam.yaw=+c.yaw||0;cam.pitch=+c.pitch||0;cam.roll=+c.roll||0;requestDraw();
};

// ==== brushes ==========================================================================
// Brushes are edited in the .map text the page reads (D.srcText): each change replaces one
// brush's block (or adds or removes one), then the page reads the text again and builds its
// scene from it (edRebuild: what main() does after loading, on the same GL buffers), so a
// changed brush is drawn, picked, selected and textured as the page draws any brush. Every
// value can be typed: corners, the three points of each face's plane, move offsets, clip
// planes, texture shift / rotation / scale. Changes are steps in Modify's Undo (its
// snapshots carry how many brush changes are applied: ED.n), and they go into Modify's
// recovery file. A .bsp's brushes are compiled: once they change, the map saves as .map.
const ED={all:[],n:0,saved:0,sel:null,face:-1,lit:false,busy:false};
const WMAX=65536;                          // q3map's MAX_WORLD_COORD
const num=(v,lo=-WMAX,hi=WMAX)=>{const x=Number(String(v).trim());if(String(v).trim()===''||!isFinite(x)||x<lo||x>hi)throw new Error('"'+v+'" is not a number from '+lo+' to '+hi);return x;};
const vadd=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const vscale=(a,s)=>[a[0]*s,a[1]*s,a[2]*s];

// ---- the brush's faces as written in the .map -------------------------------------------
function edFaces(pr){return pr.d.faces.map(f=>({p:f.p.slice(),tex:f.tex,sh:f.sh.slice(),rot:f.rot,sc:f.sc.slice(),
  cont:f.cont|0,flags:f.flags|0,val:f.val||0,extra:f.extra||'',tm:f.tm?[f.tm[0].slice(),f.tm[1].slice()]:null}));}
function edFaceLine(f){
  const P=[f.p.slice(0,3),f.p.slice(3,6),f.p.slice(6,9)].map(q=>'( '+q.map(fmt).join(' ')+' )').join(' ');
  // the texture's numbers to 6 places (a scale such as 0.109375 kept as it is: 3 places would move the texture)
  const t6=x=>{const r=Math.round(x*1e6)/1e6;return String(Object.is(r,-0)?0:r);};
  if(f.tm)return P+' ( ( '+f.tm[0].map(t6).join(' ')+' ) ( '+f.tm[1].map(t6).join(' ')+' ) ) '+f.tex+' '+f.cont+' '+f.flags+' '+fmt(f.val)+(f.extra?' '+f.extra:'');
  return P+' '+f.tex+' '+t6(f.sh[0])+' '+t6(f.sh[1])+' '+t6(f.rot)+' '+t6(f.sc[0])+' '+t6(f.sc[1])+' '+f.cont+' '+f.flags+' '+fmt(f.val)+(f.extra?' '+f.extra:'');
}
function edBrushText(faces){
  const bp=faces.some(f=>f.tm);
  return bp?'{\nbrushDef\n{\n'+faces.map(edFaceLine).join('\n')+'\n}\n}':'{\n'+faces.map(edFaceLine).join('\n')+'\n}';
}
// the brush closes into a solid inside the world, with a face on every plane
function edCheck(faces){
  if(faces.length<4)throw new Error('a brush needs at least 4 faces');
  const planes=faces.map(planeOf);if(planes.some(x=>!x))throw new Error('a face\'s three points are in a line');
  const ws=brushWindings(planes);
  const live=ws.map((w,k)=>w?k:-1).filter(k=>k>=0);
  if(live.length<4)throw new Error('the faces don\'t close into a solid');
  let tot=[0,0,0],area=0;
  for(const k of live){const w=ws[k],a=windingArea(w);area+=a;tot=vadd(tot,vscale(planes[k],a));
    for(let i=0;i<w.length;i++)if(Math.abs(w[i])>WMAX)throw new Error('the brush is open or reaches past the edge of the world');}
  if(Math.max(Math.abs(tot[0]),Math.abs(tot[1]),Math.abs(tot[2]))>1e-4*Math.max(area,1))throw new Error('the faces don\'t close into a solid');
  return {planes:planes,ws:ws,live:live};
}
// the faces that carry a part of the surface (a clip leaves others with none)
function edPrune(faces){const c=edCheck(faces);return c.live.map(k=>faces[k]);}
// a face's texture kept where it is on the wall when its points move by d (as Modify's
// brush-entity move: the shift changed along the face's texture axes)
function edLockFace(f,d){
  const pl=planeOf(f);if(!pl)return;
  if(f.tm){const ax=bpAxes(pl),du=d[0]*ax[0][0]+d[1]*ax[0][1]+d[2]*ax[0][2],dv=d[0]*ax[1][0]+d[1]*ax[1][1]+d[2]*ax[1][2];
    f.tm[0][2]-=f.tm[0][0]*du+f.tm[0][1]*dv;f.tm[1][2]-=f.tm[1][0]*du+f.tm[1][1]*dv;return;}
  const V=texVecs(pl,f.sh,f.rot,f.sc);
  f.sh=[f.sh[0]-(V[0]*d[0]+V[1]*d[1]+V[2]*d[2]),f.sh[1]-(V[4]*d[0]+V[5]*d[1]+V[6]*d[2])];
}
function edMoveFaces(faces,d,lock){for(const f of faces){if(lock)edLockFace(f,d);for(let i=0;i<9;i++)f.p[i]+=d[i%3];}return faces;}
// a box's six faces, each with three of its corners in the order q3map reads as outward
function edBoxFaces(mn,mx,tex){
  const out=[];
  for(let ax=0;ax<3;ax++)for(const s of[-1,1]){
    const u=(ax+1)%3,w=(ax+2)%3,v=s>0?mx[ax]:mn[ax];
    const pt=(cu,cw)=>{const q=[0,0,0];q[ax]=v;q[u]=cu;q[w]=cw;return q;};
    let P=[pt(mn[u],mn[w]),pt(mx[u],mn[w]),pt(mn[u],mx[w])];
    const n=vcross(vsub(P[0],P[1]),vsub(P[2],P[1]));if(n[ax]*s<0)P=[P[2],P[1],P[0]];
    out.push({p:[].concat(P[0],P[1],P[2]),tex:tex,sh:[0,0],rot:0,sc:[0.5,0.5],cont:0,flags:0,val:0,extra:'',tm:null});}
  return out;
}
// a brush that is an axis-aligned box: its bounds per face axis, else null
function edBoxOf(faces){
  if(faces.length!==6)return null;const pls=faces.map(planeOf);const b={};
  for(const pl of pls){if(!pl)return null;const ax=[0,1,2].find(k=>Math.abs(Math.abs(pl[k])-1)<1e-9);if(ax==null)return null;
    const key=(pl[ax]>0?'+':'-')+ax;if(b[key]!=null)return null;b[key]=pl[ax]>0?pl[3]:-pl[3];}
  if(Object.keys(b).length!==6)return null;
  return{mn:[b['-0'],b['-1'],b['-2']],mx:[b['+0'],b['+1'],b['+2']]};
}
function edBounds(faces){const c=edCheck(faces),mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];
  for(const k of c.live){const w=c.ws[k];for(let i=0;i<w.length;i++){const a=i%3;if(w[i]<mn[a])mn[a]=w[i];if(w[i]>mx[a])mx[a]=w[i];}}
  return{mn:mn,mx:mx};}

// ---- the text: changes, undo, rebuild ---------------------------------------------------
// one change: at offset `at`, `del` was replaced by `ins`; sel is the brush to select after
function edTextApply(op,back){
  const t=D.srcText,a=op.at,from=back?op.ins:op.del,to=back?op.del:op.ins;
  if(t.slice(a,a+from.length)!==from)throw new Error('the map text isn\'t what this change was made on');
  if(ED.text0==null)ED.text0=t;   // the text the .bsp was made from, before the first change of any kind
  D.srcText=t.slice(0,a)+to+t.slice(a+from.length);
}
function edGoto(n,sel){
  if(n===ED.n)return;
  while(ED.n>n){edTextApply(ED.all[ED.n-1],true);ED.n--;}
  while(ED.n<n){edTextApply(ED.all[ED.n],false);ED.n++;}
  edRebuild(sel!==undefined?sel:(ED.all[Math.max(0,ED.n-1)]||{}).sel);
}
function edDo(at,del,ins,sel,what){
  if(ED.crlf==null)ED.crlf=/\r\n/.test(D.srcText.slice(0,20000));
  if(ED.crlf)ins=ins.replace(/\r?\n/g,'\r\n');               // the file's own line endings
  try{if(MOD.edit>=0)modEditClose(true);}catch(_e){}
  modHist();
  ED.all.length=ED.n;ED.all.push({at:at,del:del,ins:ins,sel:sel});
  try{edTextApply(ED.all[ED.n],false);}catch(err){ED.all.pop();MOD.undo.pop();throw err;}
  ED.n++;
  edRebuild(sel);
  modChanged(true);
  flash(what);
}
// ---- what the editor added or changed and hasn't saved: drawn always, outlined, marked ----
// A primitive is new when its whole text is part of what an edit since the last save wrote
// (a new brush, a moved or resized one, a new patch or terrain block). These are drawn and
// clickable even when a Show button hides their kind (a caulk brush with Caulk off),
// outlined in amber, and their More info card says they are new; once saved as a .map they
// are the map's own again.
let EDNEW=new Set();
function edNewCalc(){
  const s=new Set(),lo=Math.min(ED.saved,ED.n),ins=[];
  for(let i=lo;i<ED.n;i++){const t=ED.all[i]&&ED.all[i].ins;if(t)ins.push(t);}
  if(ins.length)SC.prims.forEach((p,pi)=>{const pr=MAP.ents[p.ent]&&MAP.ents[p.ent].prims[p.bn];
    if(!pr||!(pr.te>pr.ts))return;const t=D.srcText.slice(pr.ts,pr.te);
    if(t.length>2&&ins.some(x=>x.length>=t.length&&x.includes(t)))s.add(pi);});
  EDNEW=s;
}
// after a save (or Undo past one) the set changes without a rebuild: draw again
function edNewSync(){const old=EDNEW;edNewCalc();
  if(old.size===EDNEW.size&&[...old].every(x=>EDNEW.has(x)))return;
  if(gl){rebuildWorld();lineDirty=true;requestDraw();}}
function edNewLines(L){
  if(!EDNEW.size)return;
  const c=[1,0.72,0.2,0.95],P=SC.pos;
  for(const pi of EDNEW){const p=SC.prims[pi];if(!p||hidPrim.has(pi))continue;
    for(let f=p.f0;f<p.f1;f++){const ea=SC.faceE0[f],ec=SC.faceEN[f];
      for(let k=ea;k+1<ea+ec;k+=2){const a=SC.edge[k]*3,b=SC.edge[k+1]*3;
        L.push(P[a],P[a+1],P[a+2],c[0],c[1],c[2],c[3],P[b],P[b+1],P[b+2],c[0],c[1],c[2],c[3]);}}}
}
const _infoPrim=infoPrim;
infoPrim=function(pi){
  _infoPrim.apply(this,arguments);
  if(!EDNEW.has(pi))return;
  const b=$('infoBody');if(!b)return;
  const d=document.createElement('div');d.className='note warn';
  d.textContent='New: added or changed in the Map Editor and not saved yet, so it isn\'t in the map\'s file (nor in a .bsp) until Save as .map or Compile writes it. '+
    'It is drawn, outlined in amber, and can be clicked even when a Show button hides its kind (Caulk, Clips, Nodraw...). Undo takes it back.';
  b.insertBefore(d,b.firstChild);
};

// The page's scene from the text again: main()'s steps after loading, the GL buffers
// written again in place, the lazily built tables thrown away so they are built anew.
function edRebuild(sel){
  if(ED.carry)edCarryEnd();
  // The .bsp's baked light belongs to the text it was compiled from: once the text differs,
  // the view draws the .map's own faces at full brightness. It is kept, and comes back as
  // soon as Undo (or an edit that undoes another) brings the text back to that very text.
  const back=ED.lit&&ED.litSave&&ED.text0!=null&&D.srcText===ED.text0;
  if(LIT&&!ED.lit){ED.lit=true;ED.litSave=LIT;LIT=null;
    flash('The map changed: the view draws the .map now, without the .bsp\'s baked light (Undo back to the .bsp brings it back; Compile... bakes it again)');}
  MAP=readMap(D.srcText);
  // (an Undo can take away an entity Copy added: nothing may point past the map's end)
  SEL.clear();lastHit=null;try{setHover.h=null;}catch(_e){}
  scriptEnts();spawnKeys();
  try{for(const ei of[...hidEnt])if(ei>=MAP.ents.length)hidEnt.delete(ei);}catch(_e){}
  SC=buildScene(MAP,texFor,null);NF=SC.nf;
  // the same text as the .bsp's: the same faces in the same order, so its polygons, tied
  // to them by number, fit again (LIT.rep, each polygon's face)
  if(back){LIT=ED.litSave;ED.lit=false;try{CULL.uk=CULL.ub=null;}catch(_e){}
    try{if(!fullBright)flash('Back to the .bsp as compiled: the game\'s own lighting again');}catch(_e){}}
  // the culling boxes are per face: a change that keeps the face count (a brush moved into a
  // new entity, a brush reshaped) still reorders or moves faces
  try{CULL.fk=CULL.fb=null;}catch(_e){}
  try{PG=null;PGP=null;GRID.fk='';GRID.key='';}catch(_e){}     // the player collision (traces, the grid's focus) from the new geometry
  edNewCalc();
  buildEntities();prepMaterials();prepSeeThrough();doorsInit();expInit();
  ENTPRIMS=null;LINE_STARTS=null;TRACEBR=null;_texCounts=null;TEXUSE=null;SEARCH=null;TARGETED_BY=null;LBLOCC=null;
  GAME_TN=null;PNIDX=null;ENTVIS=null;
  BR.clear();brPosed.clear();hidPrim.clear();
  // a brush entity's Modify row holds its anchor as its origin: where its brushes' middle
  // was when the row was made. Brushes moved here move the middle; a row Modify itself hasn't
  // moved takes the new anchor, so the entity isn't drawn shifted back to where it was
  try{const ko=kv=>{for(const[k,v]of kv||[])if(k.toLowerCase()==='origin')return v;return null;};
    for(const m of MOD.ents){if(m.ei==null||!m.brA||m.del||!brOk(m.ei))continue;
      const o=ko(m.kv);if(o==null||o!==ko(m.orig))continue;
      const a=brInfo(m.ei).anchor.map(fmt).join(' ');if(a===o)continue;
      for(const L of[m.kv,m.orig])for(const kv of L)if(kv[0].toLowerCase()==='origin')kv[1]=a;}}catch(err){console.error(err);}
  try{paDirty();}catch(_e){}
  if(gl){
    gl.bindBuffer(gl.ARRAY_BUFFER,B.pos);gl.bufferData(gl.ARRAY_BUFFER,SC.pos,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,B.uv);gl.bufferData(gl.ARRAY_BUFFER,SC.uv,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,B.pick);gl.bufferData(gl.ARRAY_BUFFER,SC.pick,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,null);
    rebuildWorld();entDrawRebuild();      // the markers and models for the new ENTS
  }
  SEL.clear();lastHit=null;
  if(sel){const pi=SC.prims.findIndex(p=>p.ent===sel.ei&&p.bn===sel.bn);
    if(pi>=0){SEL.add(edKeyOfPrim(pi));ED.sel={ei:sel.ei,bn:sel.bn};}else ED.sel=null;}
  else ED.sel=null;
  selectionChanged();
  try{brSync();}catch(_e){}
  try{syncButtons();}catch(_e){}              // Full Brightness shows whether the baked light is there
  lineDirty=true;requestDraw();
  edPanel();
}
// the brush to edit: the selected one (a brush, or the brush clicked of a brush entity)
function edPickSync(){
  if(!EON()){if(ED.sel){ED.sel=null;ED.face=-1;ED.pp=null;ED.tv=null;lineDirty=true;}return;}
  let s=null;
  if(SEL.size===1){const k=[...SEL][0];
    if(k[0]==='p'){const r=SC.prims[+k.slice(1)];if(r)s={ei:r.ent,bn:r.bn};}
    else if(k[0]==='e'){const ei=+k.slice(1);
      const keep=ED.sel&&ED.sel.ei===ei&&!(lastHit&&lastHit.prim>=0)?SC.prims.findIndex(p=>p.ent===ei&&p.bn===ED.sel.bn):-1;
      let pi=keep>=0?keep:lastHit&&lastHit.prim>=0&&SC.prims[lastHit.prim]&&SC.prims[lastHit.prim].ent===ei?lastHit.prim:-1;
      if(pi<0)pi=primsOfEnt(ei).find(i=>SC.prims[i].kind===0);if(pi!=null&&pi>=0&&SC.prims[pi])s={ei:ei,bn:SC.prims[pi].bn};}}
  const same=s&&ED.sel&&s.ei===ED.sel.ei&&s.bn===ED.sel.bn;
  ED.sel=s;
  if(!same){ED.face=-1;ED.pp=null;ED.tv=null;}
  if(s)edNearPoint();
  const face0=same?ED.face:-2;
  if(s&&lastHit&&lastHit.face>=0&&SC.facePrim[lastHit.face]===SC.prims.findIndex(p=>p.ent===s.ei&&p.bn===s.bn))ED.face=SC.faceSide[lastHit.face];
  // a newly selected brush, patch or terrain block (or another face of the brush) puts its
  // texture in the Texture box - except while the box is what the Texture tool or terrain
  // paint lays down
  if(s&&(!same||ED.face!==face0)&&!edTexPainting()){const tx=edSelTex(),el=$('edTex');if(tx&&el)el.value=tx;}
  if(!same||ED.face!==face0)ED.tileV=null;           // the Tiling row shows the new selection's
  lineDirty=true;edPanel();
}
// the Texture tool and terrain paint lay the box's texture down: there it stays as chosen
function edTexPainting(){return ED.tool==='texture'||(ED.tool==='terrain'&&ED.terr==='paint');}
// the most used texture of a list, a real one before a tool texture (caulk, clip ...)
function edMostTex(L){
  const n=new Map();for(const t of L)if(t)n.set(t,(n.get(t)||0)+1);
  let best=null,bs=-1;for(const[t,c]of n){const sc=c+(/^common\//i.test(t)?0:1e6);if(sc>bs){bs=sc;best=t;}}
  return best;}
// the selection's texture: the face, patch or terrain patch clicked; else the picked face,
// else the brush's (or terrain block's) most used texture
function edSelTex(){
  if(!ED.sel)return null;
  try{const q=lastHit&&edPrimOfHit(lastHit);if(q&&q.ei===ED.sel.ei&&q.bn===ED.sel.bn){const t=edTexAt(lastHit);if(t)return t;}}catch(_e){}
  const pr=edPrim(),pp=edPatch(),tp=edTerr();
  if(pr){const fs=pr.d.faces,f=fs[ED.face];return f&&f.tex?f.tex:edMostTex(fs.map(x=>x.tex));}
  if(pp)return pp.d.tex||null;
  if(tp)return edMostTex((tp.d.corners||[]).map(c=>c&&c.tex));
  return null;}
// a texture chosen for the box (Browse..., tool textures, the eyedropper) also goes on what
// is selected: every face of a brush, a patch, every patch of a terrain block. One Undo.
function edTexApplySel(tx,tile){
  if(!ED.sel||edTexPainting())return false;
  edTexOk(tx);
  const pr=edPrim(),pp=edPatch(),tp=edTerr();
  if(pr&&tile&&tile.kind==='face'){const fs=edFaces(pr);for(const f of fs){f.tex=tx;if(!f.tm){f.sc=tile.sc.slice();f.rot=tile.rot;f.sh=tile.sh.slice();}}
    edSetFaces(fs,'Every face of the brush: '+tx+', its tiling too');return true;}
  if(tp&&tile&&tile.kind==='terrain'){const T=edTerrData(tp);for(const c of T.cl){while(c.length<7)c.push('0');c[0]=tx;c[1]=edN6(tile.sh[0]);c[2]=edN6(tile.sh[1]);c[3]=edN6(tile.rot);c[5]=edN6(tile.sc[0]);c[6]=edN6(tile.sc[1]);}
    edSetTerr(T,'Every patch of the terrain block: '+tx+', its tiling too');return true;}
  if(pr){const fs=edFaces(pr);if(fs.every(f=>f.tex===tx))return false;for(const f of fs)f.tex=tx;edSetFaces(fs,'Every face of the brush: '+tx);return true;}
  if(pp){if(pp.d.tex===tx)return false;const P=edPatchData(pp);P.tex=tx;edSetPatch(P,'Patch: '+tx);return true;}
  if(tp){const T=edTerrData(tp);if(T.cl.every(c=>c[0]===tx))return false;for(const c of T.cl)c[0]=tx;edSetTerr(T,'Every patch of the terrain block: '+tx);return true;}
  return false;}
// ---- Tiling: how the texture lies (scale, rotate, shift) on the selected brush or terrain ----
// On a brush: the face clicked (or picked in Exact values), else every face; on a terrain
// block: every patch. The eyedropper takes a face's or terrain patch's tiling with its
// texture and gives both to the selection.
function edTileAt(h){
  const q=edPrimOfHit(h);if(!q)return null;
  if(q.kind===0){const f=q.pr.d.faces[q.side];if(!f||f.tm)return null;return{kind:'face',sc:f.sc.slice(),rot:f.rot,sh:f.sh.slice()};}
  if(q.kind===2&&h.point){const t=q.pr.d,nx=(t.W-1)/8,ny=(t.H-1)/8;
    const pi=Math.max(0,Math.min(nx-1,Math.floor((h.point[0]-t.org[0])/512))),pj=Math.max(0,Math.min(ny-1,Math.floor((h.point[1]-t.org[1])/512)));
    const c=t.corners[pj*(nx+1)+pi]||t.corners[0];if(!c)return null;return{kind:'terrain',sc:c.sc.slice(),rot:c.rot,sh:c.sh.slice()};}
  return null;}
function edSelTile(){
  const pr=edPrim(),tp=edTerr();
  if(pr){const f=pr.d.faces[ED.face>=0?ED.face:0];if(!f||f.tm)return null;return{kind:'face',sc:f.sc.slice(),rot:f.rot,sh:f.sh.slice()};}
  if(tp){const c=tp.d.corners[0];if(!c)return null;return{kind:'terrain',sc:c.sc.slice(),rot:c.rot,sh:c.sh.slice()};}
  return null;}
function edTileHtml(){
  if(!ED.sel)return'';const pr=edPrim(),tp=edTerr();if(!pr&&!tp)return'';
  const kind=pr?'face':'terrain',t=(ED.tileV&&ED.tileV.kind===kind)?ED.tileV:edSelTile();if(!t)return'';
  const who=pr?(ED.face>=0?'face '+(ED.face+1)+' (the one clicked)':'every face'):'every patch of the block';
  return edLine('Tiling',edCap('scale')+edField('edTlK0',fmt(t.sc[0]),38)+edField('edTlK1',fmt(t.sc[1]),38)+edCap('rotate')+edField('edTlR',fmt(t.rot),34)+
    edCap('shift')+edField('edTlS0',fmt(t.sh[0]),38)+edField('edTlS1',fmt(t.sh[1]),38)+edBtn('bEdTile','Set','This scale, rotate and shift on '+who+'. The eyedropper takes them with a texture'),
    'How the texture lies on '+who+': scale x y (on a brush 0.5 is the editor\'s default, 1 twice as big; below 0 flips), rotate in degrees, shift x y in texels. The eyedropper copies them from the surface it takes a texture from.');}
function edTileRead(){
  const v=id=>num($(id).value,-1e6,1e6),kind=edPrim()?'face':'terrain';
  const t={kind:kind,sc:[v('edTlK0'),v('edTlK1')],rot:v('edTlR'),sh:[v('edTlS0'),v('edTlS1')]};
  if(!t.sc[0]||!t.sc[1])throw new Error('a scale can\'t be 0');return t;}
function edTileSet(){
  const t=edTileRead();ED.tileV=t;const pr=edPrim(),tp=edTerr();
  if(pr){const fs=edFaces(pr),ks=ED.face>=0?[ED.face]:fs.map((_f,i)=>i);let n=0;
    for(const k of ks){const f=fs[k];if(!f||f.tm)continue;f.sc=t.sc.slice();f.rot=t.rot;f.sh=t.sh.slice();n++;}
    if(!n)throw new Error('that face uses brush-primitive texturing: its matrix is kept');
    edSetFaces(fs,'Tiling on '+(ks.length===1?'face '+(ks[0]+1):'every face')+': scale '+t.sc.map(fmt).join(' ')+', rotate '+fmt(t.rot)+', shift '+t.sh.map(fmt).join(' '));return;}
  if(tp){const T=edTerrData(tp);for(const c of T.cl){while(c.length<7)c.push('0');c[1]=edN6(t.sh[0]);c[2]=edN6(t.sh[1]);c[3]=edN6(t.rot);c[5]=edN6(t.sc[0]);c[6]=edN6(t.sc[1]);}
    edSetTerr(T,'Tiling on every patch: scale '+t.sc.map(fmt).join(' ')+', rotate '+fmt(t.rot)+', shift '+t.sh.map(fmt).join(' '));return;}
  throw new Error('select a brush or a terrain block');}

// ---- Delete (the Delete key, or the Delete beside the selection): the selected brushes ----
// Brushes, patches and terrain blocks go from the text; a brush entity whose every brush is
// selected is deleted as Modify deletes it (its row flagged DEL), so no entity is left
// without brushes. One Undo puts it all back.
function edDeleteSel(){
  let c;try{c=edCopySet();}catch(_e){return false;}
  if(!c.prims.length&&!c.ents.length)return false;
  if(c.pts)throw new Error('Delete takes brushes or entities, not both: Shift+click to leave one kind out of the selection');
  const items=c.prims.map(pi=>{const r=SC.prims[pi];return MAP.ents[r.ent].prims[r.bn];}).filter(Boolean),ents=c.ents.slice();
  const what=(items.length?items.length+(items.length===1?' brush':' brushes'):'')+(items.length&&ents.length?' and ':'')+(ents.length?ents.map(entName).join(', '):'');
  if(items.length)edDoMany(items.map(pr=>({at:pr.ts,del:D.srcText.slice(pr.ts,pr.te),ins:'',sel:null})),'Deleted '+what+' (Undo, Alt+Z, puts it back)');
  else modHist();
  if(ents.length){for(const ei of ents)modRowFor(ei).del=true;modChanged(true);flash('Deleted '+what+' (Undo, Alt+Z, puts it back)');}
  SEL.clear();lastHit=null;selectionChanged();lineDirty=true;requestDraw();return true;}
window.addEventListener('keydown',e=>{
  if(e.key!=='Delete'||!EON()||typeof MAP==='undefined'||!MAP||e.altKey||e.metaKey)return;
  const tg=e.target&&e.target.tagName;if(tg==='INPUT'||tg==='TEXTAREA'||tg==='SELECT')return;
  if(MOD.edit>=0||MOD.placing||ED.carry||EDDRAG)return;
  let done=false;try{done=edDeleteSel();}catch(err){flash(err.message);done=true;}
  if(done){e.preventDefault();e.stopPropagation();}},true);

// ---- Trim (with Move or Resize): the selection nudged from the keyboard -----------------------
// As Modify's Trim origin: W A S D / arrows along the world axis nearest the way the camera
// looks, Space / C up and down, by Modify's trim step. Move moves the selected brushes; Resize
// pushes out the face of each selected brush that faces that way (Shift+key pulls it in), so a
// brush too thin to grab a side of (a wire) can be stretched. The whole trim is one Undo.
// ---- a patch stretched by Trim (Resize): a pipe or wire made longer or shorter -----------
// Its two spans (along the control net's rows and along its columns), each from the middle of
// its first line of points to the middle of its last; the longer of the spans pointing the
// way of the key (by more than a third) has the end that way moved out along the span by v (in, with v
// below 0), the lines between it and the other end by their share, so a straight pipe stays
// straight and evenly spaced and a sagging wire keeps its sag. The texture keeps its size
// (it repeats on along the new length). null: no span points that way.
function edPatchAxes(P){
  const w=P.w,h=P.h,pt=(j,i)=>{const o=(j*h+i)*5;return[P.pts[o],P.pts[o+1],P.pts[o+2]];};
  const mid=L=>{const c=[0,0,0];for(const p of L)for(let a=0;a<3;a++)c[a]+=p[a]/L.length;return c;};
  const lineJ=j=>{const L=[];for(let i=0;i<h;i++)L.push(pt(j,i));return L;},lineI=i=>{const L=[];for(let j=0;j<w;j++)L.push(pt(j,i));return L;};
  const out=[];
  for(const[n,line]of[[w,lineJ],[h,lineI]]){if(n<2){out.push(null);continue;}
    const c=[];for(let k=0;k<n;k++)c.push(mid(line(k)));
    const a=vsub(c[n-1],c[0]),len=Math.hypot(a[0],a[1],a[2]);out.push(len>0.01?{n:n,c:c,u:vscale(a,1/len),len:len}:null);}
  return out;}
function edPatchTrimText(pr,d,v){
  const P=edPatchData(pr),A=edPatchAxes(P);let best=0,k=-1,sg=1;
  // of the spans pointing that way, the longer (along a wire that runs slantwise, not across it)
  A.forEach((ax,i)=>{if(!ax)return;const q=vdot(ax.u,d);if(Math.abs(q)>0.33&&ax.len>best){best=ax.len;k=i;sg=q>0?1:-1;}});
  if(k<0)return null;
  const ax=A[k],L2=ax.len+v;if(L2<1)throw new Error('the patch can\'t get shorter than that');
  const w=P.w,h=P.h,idx=(a,b)=>((k===0?a*h+b:b*h+a))*5;   // a: along the span, b: across it
  const nb=k===0?h:w,opp=sg>0?0:ax.n-1,ratio=L2/ax.len;
  for(let a=0;a<ax.n;a++){
    const f=Math.max(0,Math.min(1,vdot(vsub(ax.c[a],ax.c[opp]),ax.u)*sg/ax.len)),m=vscale(ax.u,sg*v*f);
    for(let b=0;b<nb;b++){const o=idx(a,b),oo=idx(opp,b);
      for(let c=0;c<3;c++)P.pts[o+c]=Math.round((P.pts[o+c]+m[c])*1000)/1000;
      for(const c of[3,4])P.pts[o+c]=Math.round((P.pts[oo+c]+(P.pts[o+c]-P.pts[oo+c])*ratio)*1e4)/1e4;}}
  edPatchCheck(P);
  const t=D.srcText.slice(pr.ts,pr.te),q=edPatchParts(t),mx=t.slice(q.m0,q.m1);
  return t.slice(0,q.m0)+(edPatchSplice(mx,P)||edPatchMatrix(P))+t.slice(q.m1);}
function edTrim(on){
  if(on==null)on=!ED.trim;
  if(on&&!(ED.tool==='move'||ED.tool==='resize'))return;
  if(on){if(MOD.trim)modTrim(false);if(!edJoinPrims().length){flash('Select a brush first');return;}stopCamera();ED.trimN=0;}
  ED.trim=!!on;edPanel();
  flash(on?(ED.tool==='move'?'Trim: W A S D / arrows move the selection, Space / C up and down':'Trim: W A S D / arrows / Space / C push the brush\'s face that way out, Shift+key pulls it in')+
    ', '+MOD_STEPS[MOD.stepI]+' at a time (Modify\'s trim step). Esc or T stops':'Trim off');}
// m: how many steps at once (a held key's repeats, gathered by edTrimHeld)
function edTrimKey(e,m){
  const kl=e.key.toLowerCase(),A=modAxes();let d=null;
  if(kl==='w'||kl==='arrowup')d=A.f;else if(kl==='s'||kl==='arrowdown')d=A.f.map(v=>-v);
  else if(kl==='d'||kl==='arrowright')d=A.r;else if(kl==='a'||kl==='arrowleft')d=A.r.map(v=>-v);
  else if(kl===' ')d=[0,0,1];else if(kl==='c')d=[0,0,-1];
  else if(kl==='escape'||kl==='t'){edTrim(false);return true;}
  if(!d)return CAM_KEYS_FREE.has(kl)||CAM_KEYS_RAD.has(kl);   // the camera stays put
  const st=MOD_STEPS[MOD.stepI]*Math.max(1,m||1),keep=[...SEL],n0=MOD.undo.length;
  if(ED.tool==='move'){const c=edCopySet();if(c.pts)throw new Error('Trim moves brushes; Modify\'s Trim origin moves entities');
    if(!c.prims.length&&!c.ents.length)throw new Error('Select a brush first');
    const C=edCarryBuild(c),o=d.map(v=>v*st);edDoMany(edMoveOps(C,o),'Trim: moved '+o.map(fmt).join(' '));}
  else{const ops=[];let n=0;
    for(const pi of edJoinPrims()){const r=SC.prims[pi],pr=MAP.ents[r.ent].prims[r.bn];if(!pr)continue;
      if(pr.kind===1){const t=edPatchTrimText(pr,d,e.shiftKey?-st:st);if(t!=null){ops.push({at:pr.ts,del:D.srcText.slice(pr.ts,pr.te),ins:t,sel:null});n++;}continue;}
      if(pr.kind!==0)continue;
      const fs=edFaces(pr);let k=-1,best=0.5;
      fs.forEach((f,i)=>{const pl=planeOf(f);if(!pl)return;const dd=pl[0]*d[0]+pl[1]*d[1]+pl[2]*d[2];if(dd>best){best=dd;k=i;}});
      if(k<0)continue;const pl=planeOf(fs[k]),v=e.shiftKey?-st:st;for(let i=0;i<9;i++)fs[k].p[i]+=pl[i%3]*v;
      try{edCheck(fs);}catch(_e){throw new Error('that would turn the brush inside out');}
      ops.push({at:pr.ts,del:D.srcText.slice(pr.ts,pr.te),ins:edBrushText(fs),sel:null});n++;}
    if(!ops.length)throw new Error('Trim resizes brushes and patches (a pipe or wire: press the key that points along it); a terrain block has its own tools');
    edDoMany(ops,'Trim: '+(n===1?'its end':n+' ends')+' '+(e.shiftKey?'pulled in ':'pushed out ')+st);}
  if(ED.trimN++>0&&MOD.undo.length>n0)MOD.undo.splice(n0,MOD.undo.length-n0);   // one Undo for the trim
  ED.tflash={k:edAxKey(d),t:performance.now(),pull:ED.tool==='resize'&&e.shiftKey};setTimeout(requestDraw,240);
  SEL.clear();for(const k of keep)SEL.add(k);selectionChanged();lineDirty=true;requestDraw();return true;}
// A held key: each repeat would rebuild the map's text and view on its own, and the page
// doesn't draw until every repeat waiting is done, so it looked stuck and then jumped. The
// repeats are counted instead (edTrimHeld) and done together once a frame, as one step of
// that many trim steps: what can be done shows each frame, however slow a rebuild is. When
// the whole count can't be done (a face pulled through the brush), as many as can are.
const ED_TRIM_DIRS=new Set(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright',' ','c']);
let edTrimQ=null;
function edTrimFlush(){
  const q=edTrimQ;edTrimQ=null;if(!q||!ED.trim)return;
  for(let m=q.n;m>=1;m--){
    try{edTrimKey({key:q.key,shiftKey:q.sh},m);return;}
    catch(err){if(m===1)flash(err.message);}}
}
function edTrimHeld(e){
  const kl=e.key.toLowerCase();
  if(edTrimQ&&(edTrimQ.kl!==kl||edTrimQ.sh!==e.shiftKey))edTrimFlush();     // another key: the last one's steps first
  if(edTrimQ)edTrimQ.n++;
  else{edTrimQ={kl:kl,key:e.key,sh:e.shiftKey,n:1};requestAnimationFrame(edTrimFlush);}
}
window.addEventListener('keydown',e=>{
  if(!ED.trim)return;
  if(!EON()||!(ED.tool==='move'||ED.tool==='resize')){ED.trim=false;return;}
  if(e.ctrlKey||e.altKey||e.metaKey)return;
  const tg=e.target&&e.target.tagName;if(tg==='INPUT'||tg==='TEXTAREA'||tg==='SELECT')return;
  // nothing selected any more (a click on nothing, an Undo): Trim goes off and the key
  // goes to the camera, so it never holds the camera's keys with nothing to trim
  if(!edJoinPrims().length&&!(ED.tool==='move'&&SEL.size)){edTrimQ=null;edTrim(false);return;}
  if(e.repeat&&ED_TRIM_DIRS.has(e.key.toLowerCase())){edTrimHeld(e);e.preventDefault();e.stopPropagation();return;}
  if(edTrimQ)edTrimFlush();
  let took=false;try{took=edTrimKey(e);}catch(err){flash(err.message);took=true;}
  if(took){e.preventDefault();e.stopPropagation();}},true);
// while trimming, the camera's keys are let go of too where the page would hear them
window.addEventListener('keyup',e=>{
  if(!ED.trim||e.ctrlKey||e.altKey||e.metaKey)return;
  const tg=e.target&&e.target.tagName;if(tg==='INPUT'||tg==='TEXTAREA'||tg==='SELECT')return;
  const kl=e.key.toLowerCase();if(kl===' '||CAM_KEYS_FREE.has(kl)||CAM_KEYS_RAD.has(kl)){e.preventDefault();e.stopPropagation();}},true);
// ---- the trim arrows: as Modify's Trim origin draws them on an entity, on the selected brushes
// White arrows out of each side of the selection's box (Move: the box round it all; Resize:
// each brush, only the sides with a face that a key pushes), red for a moment as a key moves
// or pushes that way (cyan as Shift pulls a face in). A big side gets a few of them, tiled
// from its middle, and each arrow is drawn bigger the farther it is from the camera, so a
// giant brush (a vis box) still shows them from far away.
const edAxKey=d=>(d[0]>0.5?'+x':d[0]<-0.5?'-x':d[1]>0.5?'+y':d[1]<-0.5?'-y':d[2]>0?'+z':'-z');
const ED_AX=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
let edTrimCache=null;
// a brush's, patch's or terrain block's box, from what the view draws of it
function edPrimBox(pi){const p=SC.prims[pi],mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];if(!p)return null;
  for(let f=p.f0;f<p.f1;f++){const ea=SC.faceE0[f],ec=SC.faceEN[f];for(let k=ea;k<ea+ec;k++){const v=SC.edge[k]*3;
    for(let a=0;a<3;a++){const x=SC.pos[v+a];if(x<mn[a])mn[a]=x;if(x>mx[a])mx[a]=x;}}}
  return mn[0]<=mx[0]?{mn:mn,mx:mx}:null;}
function edTrimBoxes(){
  const P=edJoinPrims(),key=ED.tool+'|'+ED.n+'|'+P.join(',');
  if(edTrimCache&&edTrimCache.key===key)return edTrimCache.boxes;
  const boxOf=edPrimBox;
  let boxes=[];
  if(ED.tool==='resize'&&P.length<=24){
    for(const pi of P){const r=SC.prims[pi],pr=r&&MAP.ents[r.ent].prims[r.bn];if(!pr||pr.kind>1)continue;const b=boxOf(pi);if(!b)continue;
      if(pr.kind===1){let A=[];try{A=edPatchAxes(edPatchData(pr)).filter(Boolean);}catch(_e){}   // a patch: the ends of its spans
        b.dirs=ED_AX.filter(d=>A.some(ax=>Math.abs(vdot(ax.u,d))>0.33));if(b.dirs.length)boxes.push(b);continue;}
      let pls=[];try{pls=edFaces(pr).map(planeOf).filter(Boolean);}catch(_e){}
      b.dirs=ED_AX.filter(d=>pls.some(pl=>pl[0]*d[0]+pl[1]*d[1]+pl[2]*d[2]>0.5));boxes.push(b);}}
  else{const U={mn:[Infinity,Infinity,Infinity],mx:[-Infinity,-Infinity,-Infinity],dirs:ED_AX};
    for(const pi of P){if(ED.tool==='resize'){const r=SC.prims[pi],pr=r&&MAP.ents[r.ent].prims[r.bn];if(!pr||pr.kind>1)continue;}
      const b=boxOf(pi);if(!b)continue;for(let a=0;a<3;a++){U.mn[a]=Math.min(U.mn[a],b.mn[a]);U.mx[a]=Math.max(U.mx[a],b.mx[a]);}}
    if(U.mn[0]<=U.mx[0])boxes=[U];}
  edTrimCache={key:key,boxes:boxes};return boxes;}
// where on a side, across one of its spans: its middle, then every step out from it (at most 3 a way)
function edTrimSpots(lo,hi){const c=(lo+hi)/2,h=(hi-lo)/2,st=Math.max(512,(hi-lo)/7),n=Math.min(3,Math.floor((h-st*0.25)/st));
  const out=[c];for(let i=1;i<=n;i++)out.push(c-i*st,c+i*st);return out;}
function edDrawTrim(vp){
  if(!ED.trim||!gl||typeof MAP==='undefined'||!MAP||!EON())return;
  let boxes;try{boxes=edTrimBoxes();}catch(_e){return;}if(!boxes.length)return;
  const L=[],now=performance.now(),F=ED.tflash,hot=F&&now-F.t<220,cp=cam.pos;
  const lin=(p,q,c)=>{L.push(p[0],p[1],p[2],q[0],q[1],q[2],c[0],c[1],c[2],c[3],q[0],q[1],q[2],p[0],p[1],p[2],c[0],c[1],c[2],c[3]);};
  for(const b of boxes)for(const d of b.dirs){
    const ax=d[0]?0:d[1]?1:2,u=(ax+1)%3,v=(ax+2)%3,side=d[ax]>0?b.mx[ax]:b.mn[ax],k=edAxKey(d);
    const col=hot&&F.k===k?(F.pull?[0.2,0.9,1,1]:[1,0.15,0.1,1]):[1,1,1,1];
    for(const su of edTrimSpots(b.mn[u],b.mx[u]))for(const sv of edTrimSpots(b.mn[v],b.mx[v])){
      const p=[0,0,0];p[ax]=side;p[u]=su;p[v]=sv;
      const dist=Math.hypot(p[0]-cp[0],p[1]-cp[1],p[2]-cp[2]),Ln=Math.max(18,dist*0.06),g=Math.max(6,Ln*0.3);
      const s=[p[0]+d[0]*g,p[1]+d[1]*g,p[2]+d[2]*g],e=[s[0]+d[0]*Ln,s[1]+d[1]*Ln,s[2]+d[2]*Ln];
      lin(s,e,col);
      for(const w of[u,v]){const o=[0,0,0];o[w]=Ln*0.28;   // the head, seen from any side
        lin(e,[e[0]-d[0]*Ln*0.4+o[0],e[1]-d[1]*Ln*0.4+o[1],e[2]-d[2]*Ln*0.4+o[2]],col);
        lin(e,[e[0]-d[0]*Ln*0.4-o[0],e[1]-d[1]*Ln*0.4-o[1],e[2]-d[2]*Ln*0.4-o[2]],col);}}}
  if(L.length){drawTrimArrows(vp,L);gl.disable(gl.BLEND);gl.depthMask(true);}}
// Edit map's copies of the trim step and grid controls follow the originals
ctlCopiesHook=()=>{
  const sc=$('edStepC');if(sc){sc.value=MOD.stepI;$('edStepCV').textContent=MOD_STEPS[MOD.stepI];}
  const gp=$('edGridPC');if(gp)gp.textContent=$('bGrid').textContent;
  const gs=$('edGridSzC');if(gs){gs.value=GRID.i;$('edGridVC').textContent=gridSize();}
  const go=$('edGridOnC');if(go)go.classList.toggle('on',GRID.on);
  if(ED.tool==='draw'||ED.tool==='resize'||ED.tool==='move'){const th=$('edToolHelp');if(th)th.textContent=edHelp();}};
const _drawModifyEd=drawModify;
drawModify=function(vp){_drawModifyEd(vp);try{edDrawTrim(vp);}catch(_e){}try{edDrawRot(vp);}catch(_e){}};

// ---- Classname: what the selected brushes are --------------------------------------------
// Brushes of the world (or a func_group) become one new entity of that class, with the
// brushes moved into it; a brush entity gets the new class through Modify (a key change, so
// Save as .bsp keeps it without compiling). Point entities have theirs in Edit parameters.
function edClsTargets(){
  if(typeof MAP==='undefined'||!MAP)return null;
  let c;try{c=edCopySet();}catch(_e){return null;}
  // a brush entity's brush selected: the class is the entity's
  c.prims=c.prims.filter(pi=>{const ei=SC.prims[pi].ent;if(ei>0&&edBrushEnt(ei)){if(!c.ents.includes(ei))c.ents.push(ei);return false;}return true;});
  if(ED.sel&&ED.sel.ei>0&&edBrushEnt(ED.sel.ei)&&!c.ents.includes(ED.sel.ei))c.ents.push(ED.sel.ei);
  return(c.prims.length||c.ents.length)?c:null;}
function edClsOf(ei){const m=MOD.ents.find(x=>x.ei===ei);const v=m?modKv(m,'classname'):null;return v||MAP.ents[ei].kvl.classname||MAP.ents[ei].cls;}
function edClsHtml(){
  const c=edClsTargets();if(!c)return'';
  const S=new Set();for(const pi of c.prims){const r=SC.prims[pi];S.add(MAP.ents[r.ent].kvl.classname||MAP.ents[r.ent].cls);}for(const ei of c.ents)S.add(edClsOf(ei));
  const v=S.size===1?[...S][0]:'';
  return'<div class="row" style="gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px">Classname '+edField('edCls',v,148).replace('<input ','<input placeholder="'+(S.size>1?'(several)':'')+'" ')+
    '<button class="sm" id="bEdCls" title="The brush entity classes: the world\'s brushes selected become one new entity of the class chosen (the brushes moved into it); a brush entity selected gets the class (a key change, kept by Save as .bsp). Typing a class and Enter does the same.">Browse...</button></div>';}
// what a class still needs once a brush has it (its keys are in Class specs)
function edClsHint(cl){
  if(cl==='func_rotatingdoor')return' (it turns on its origin brush: Move into one, or Draw one with common/origin and \'in entity\' ticked; its "angle" and "doortype" are in Class specs)';
  if(cl==='func_door')return' (it slides the way its "angle" says, all but its "lip": both in Class specs)';
  if(cl==='script_door')return' (its map script moves it: initthread, openthread, closethread)';
  if(cl==='func_ladder')return' (set its "angle" in Class specs: the way a climber looks at it; the facing arrow shows it)';
  if(/^trigger_/.test(cl))return' (its "setthread", "wait", "delay" and "message" are in Class specs)';
  if(cl==='func_crate'||cl==='func_barrel')return' ('+(cl==='func_crate'?'"debristype"':'"barreltype"')+' is in Class specs)';
  return'';}
function edClsApply(cls){
  cls=String(cls||'').trim();
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cls))throw new Error('a classname is letters, digits and _');
  const c=edClsTargets();if(!c)throw new Error('select a brush, patch or brush entity first');
  if(c.pts)throw new Error('point entities are selected too: theirs is in Modify\'s Edit parameters (Alt+E)');
  const cl=cls.toLowerCase(),world=cl==='worldspawn';
  const ents=c.ents.filter(ei=>edClsOf(ei)!==cls),prims=world?[]:c.prims;
  if(world&&ents.length)throw new Error('a brush entity\'s brushes don\'t go back into the world here: give it another class');
  if(!ents.length&&!prims.length){flash('Classname: no change');return;}
  if(ents.length){modHist();for(const ei of ents)modSetKv(modRowFor(ei),'classname',cls);modChanged(true);
    flash('Classname '+cls+': '+(ents.length===1?entName(ents[0]):ents.length+' brush entities')+' (Save as .bsp keeps it without compiling)'+edClsHint(cl));}
  if(prims.length){
    const items=prims.map(pi=>{const r=SC.prims[pi];return MAP.ents[r.ent].prims[r.bn];});
    if(items.some(pr=>pr.kind===2))throw new Error('terrain stays in the world: leave the terrain block out of the selection');
    const ops=items.map(pr=>({at:pr.ts,del:D.srcText.slice(pr.ts,pr.te),ins:'',sel:null}));
    const ne=MAP.nMap;
    let ins=(/\n$/.test(D.srcText)?'':'\n')+'// entity '+ne+' (Map Editor: '+cls+')\n{\n"classname" "'+cls+'"\n';
    items.forEach((pr,k)=>{ins+='// '+(pr.kind?'patch':'brush')+' '+k+'\n'+D.srcText.slice(pr.ts,pr.te)+'\n';});
    ins+='}\n';
    ops.push({at:D.srcText.length,del:'',ins:ins,sel:null,ents:1});
    if(ED.nText0==null)ED.nText0=MAP.nMap;
    edDoMany(ops,'Classname '+cls+': '+(items.length===1?'the brush is':items.length+' brushes are')+' now entity '+ne+edClsHint(cl));
    SEL.clear();lastHit=null;if(MAP.ents[ne])for(const pi of primsOfEnt(ne))SEL.add(edKeyOfPrim(pi));selectionChanged();lineDirty=true;requestDraw();}
  else edPanel();}
// ---- Entity: the selected brushes moved into one entity -----------------------------------
// MOHRadiant's "move into entity": the brushes (and patches) selected go into the entity
// picked in the list (one of theirs, or the world), out of the ones they are in now. A
// door's origin brush made apart (a copy of another door's) joins its door so; one taken
// out of a door goes back to the world. No entity is left without brushes (delete that one
// in Modify instead), and terrain stays in the world.
function edJoinPrims(){
  const out=[];for(const pi of selectedPrims())if(SC.prims[pi])out.push(pi);
  for(const ei of selectedEnts())for(const pi of primsOfEnt(ei))if(!out.includes(pi))out.push(pi);
  return out;}
function edJoinHtml(){
  if(typeof MAP==='undefined'||!MAP)return'';
  const P=edJoinPrims();if(!P.length)return'';
  const ents=[];for(const pi of P){const ei=SC.prims[pi].ent;if(!ents.includes(ei))ents.push(ei);}
  if(ents.length<2&&ents[0]===0)return'';                       // the world's brushes alone: Classname makes an entity
  if(!ents.includes(0))ents.push(0);
  // the first of them that is an entity (the one selected first), as a door built from a brush then its origin
  const def=ents.find(ei=>ei>0)||0;
  const opts=ents.map(ei=>[String(ei),ei===0?'the world':ei+' '+(MAP.ents[ei].kvl.classname||MAP.ents[ei].cls)]);
  return'<div class="row" style="gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px">Entity '+edSel('edJoinT',opts,String(def))+
    '<button class="sm" id="bEdJoin" title="Move the selected brushes and patches into this entity (out of the ones they are in now), as MOHRadiant\'s move into entity: a door\'s origin brush joins its door so, and the world takes brushes back out of an entity. One Undo.&#10;&#10;Select the brushes of both entities (a door and an origin brush, say) to have both in the list.">Move into</button></div>';}
function edJoin(ti){
  if(!(ti>=0)||!MAP.ents[ti])throw new Error('pick the entity to move them into');
  const P=edJoinPrims().filter(pi=>SC.prims[pi].ent!==ti);
  if(!P.length){flash('They are all in that entity already');return;}
  const items=P.map(pi=>{const r=SC.prims[pi];return{ei:r.ent,pr:MAP.ents[r.ent].prims[r.bn]};}).filter(x=>x.pr);
  if(ti>0&&items.some(x=>x.pr.kind===2))throw new Error('terrain stays in the world: leave the terrain block out of the selection');
  const took=new Map();for(const x of items)took.set(x.ei,(took.get(x.ei)||0)+1);
  for(const[ei,n]of took)if(ei>0&&n>=MAP.ents[ei].prims.filter(Boolean).length)
    throw new Error('entity '+ei+' ('+MAP.ents[ei].cls+') would have no brushes left: delete it in Modify, or leave one of its brushes out');
  const e=MAP.ents[ti],end=D.srcText.lastIndexOf('}',e.te-1);
  if(end<e.ts)throw new Error('the entity\'s block can\'t be found in the text');
  const ops=items.map(x=>({at:x.pr.ts,del:D.srcText.slice(x.pr.ts,x.pr.te),ins:'',sel:null}));
  let ins='';items.forEach((x,k)=>{ins+='// '+(x.pr.kind===1?'patch':x.pr.kind===2?'terrain':'brush')+' '+(e.prims.length+k)+' (Map Editor: from '+(x.ei?'entity '+x.ei:'the world')+')\n'+D.srcText.slice(x.pr.ts,x.pr.te)+'\n';});
  ops.push({at:end,del:'',ins:ins,sel:null});
  const nb0=e.prims.length,origin=items.some(x=>x.pr.kind===0&&x.pr.d&&x.pr.d.faces&&x.pr.d.faces.some(f=>/(^|\/)origin$/i.test(f.tex)));
  // (entities aren't added or taken away, so the target keeps its number)
  edDoMany(ops,(items.length===1?'1 brush':items.length+' brushes')+' moved into '+(ti?'entity '+ti+' ('+(e.kvl.classname||e.cls)+')':'the world')+
    (ti&&origin?': it now turns or moves about that origin brush':''));
  // selected after: the whole entity, or in the world the brushes moved
  SEL.clear();lastHit=null;
  if(ti>0)for(const pi of primsOfEnt(ti))SEL.add(edKeyOfPrim(pi));
  else for(let k=0;k<items.length;k++){const pi=SC.prims.findIndex(p=>p.ent===0&&p.bn===nb0+k);if(pi>=0)SEL.add('p'+pi);}
  selectionChanged();lineDirty=true;requestDraw();}
// ---- Class specs: the selected brush entity's keys by what its class takes -----------------
// cspecGroups (the page's, from bin/data/class_specs.json): the class's own keys open, the
// ones its general parents take (ScriptSlave, Trigger, Entity...) under "more". A key typed
// here is set in the entity's Modify row (a key change: Save as .bsp keeps it); emptied, it
// goes. SH / BT mark keys Allied Assault itself doesn't have.
function edSpecEnt(){
  const c=edClsTargets();if(!c||c.prims.length||c.ents.length!==1)return -1;
  const ei=c.ents[0];return MAP.ents[ei]&&!MAP.ents[ei].scr?ei:-1;}
// its targetname, first: the name scripts and other entities call it by ($name), whatever the class
function edTnRow(ei){
  const v=cspecValues(ei).get('targetname');
  return'<div class="row" style="gap:4px;align-items:center;margin-top:4px"><span style="width:118px" title="targetname: the name the level script and other entities call it by ($name; their target key names it)">'+
    (v!=null?'<b>targetname</b>':'targetname')+'</span><input type="text" data-spec="targetname" value="'+esc(v!=null?v:'')+'" placeholder="its $name" '+
    'title="The name the level script and other entities call it by: $name in the script, and a trigger\'s or path\'s target key names it. Letters, digits and _ (no spaces).\n\nEnter sets it; empty takes it away" style="flex:1;min-width:60px;padding:1px 3px;font:inherit;font-size:11px"></div>';}
// last, under Class specs (or Exact values when there are none): Edit parameters for a brush
// entity (all its keys as text, Modify's editor) and Delete for whatever is selected
function edEntBtns(){
  const ei=edSpecEnt();if(ei<0&&!ED.sel)return'';
  return'<div class="row" style="gap:4px;margin-top:6px">'+(ei>=0?edBtn('bEdParm','Edit parameters','Every key of '+esc(entName(ei)).replace(/"/g,'&quot;')+' as text, in Modify\'s editor (Modify\'s Undo, Alt+Z, puts it back)'):'')+
    edBtn('bEdDelE','Delete',ei>=0?'Delete it, every brush (Undo brings it back)':'Delete the selection (Undo brings it back)')+'</div>';}
function edSpecHtml(){
  if(typeof cspecGroups!=='function')return'';
  const ei=edSpecEnt();if(ei<0)return'';
  const cls=edClsOf(ei),G=cspecGroups(cls);
  if(!G)return'<div class="co" style="margin-top:6px">Class specs: '+esc(cls)+' isn\'t a class the game code lists.</div>'+edTnRow(ei);
  const val=cspecValues(ei);
  const row=k=>{const v=val.get(k.n.toLowerCase());
    return'<div class="row" style="gap:4px;align-items:center;margin-top:2px"><span style="width:118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(k.n+': '+cspecArgs(k)+(k.d?'\n\n'+k.d:''))+'">'+
      (v!=null?'<b>'+esc(k.n)+'</b>':esc(k.n))+'</span>'+cspecBadge(k.v)+
      '<input type="text" data-spec="'+esc(k.n)+'" value="'+esc(v!=null?v:'')+'" placeholder="'+esc(cspecArgs(k))+'" title="'+esc(cspecArgs(k)+(k.d?'\n\n'+k.d:'')+'\n\nEnter sets it; empty takes the key away')+'" style="flex:1;min-width:60px;padding:1px 3px;font:inherit;font-size:11px"></div>';};
  const own=G.filter(g=>g.own),more=G.filter(g=>!g.own&&g.keys.length);
  let h='<details id="edSpecs"'+(ED.specs!==false?' open':'')+' style="margin-top:6px"><summary style="cursor:pointer" title="The keys '+esc(cls)+' takes from the map, from OpenMoHAA\'s game code (its events: a key is sent to the entity as the event of that name). SH / BT: Spearhead / Breakthrough only.">Class specs: '+esc(cls)+'</summary>'+edTnRow(ei);
  for(const g of own){if(!g.keys.length)continue;h+='<div class="co" style="margin-top:4px">'+esc(g.c)+'</div>';for(const k of g.keys)h+=row(k);}
  if(more.length){h+='<details id="edSpecMore"'+(ED.specMore?' open':'')+' style="margin-top:4px"><summary style="cursor:pointer">more, from '+esc(more.map(g=>g.c).join(', '))+'</summary>';
    if(ED.specMore)for(const g of more){h+='<div class="co" style="margin-top:4px">'+esc(g.c)+'</div>';for(const k of g.keys)h+=row(k);}
    h+='</details>';}
  h+='<div class="co" style="margin-top:4px">Bold: set on this entity. Enter sets a key, empty takes it away (Modify\'s Undo, Alt+Z, puts it back).</div></details>';
  return h;}
function edSpecSet(ei,k,v){
  v=String(v==null?'':v).trim();
  if(/["\r\n]/.test(v))throw new Error('a key\'s value can\'t hold quotes or line breaks');
  if(k.toLowerCase()==='targetname'){v=v.replace(/^\$/,'');if(/\s/.test(v))throw new Error('a targetname can\'t hold spaces (the script names it $'+v.split(/\s/)[0]+'...)');}
  const m=modRowFor(ei),l=k.toLowerCase(),i=m.kv.findIndex(x=>x[0].toLowerCase()===l),cur=i>=0?m.kv[i][1]:null;
  if((cur==null&&v==='')||cur===v)return;
  modHist();
  if(v==='')m.kv.splice(i,1);else if(i>=0)m.kv[i][1]=v;else m.kv.push([k,v]);
  modChanged(true);lineDirty=true;
  try{if(DOOR_CLASSES[MAP.ents[ei].cls])doorsInit();}catch(_e){}
  flash((v===''?'"'+k+'" taken away':'"'+k+'" "'+v+'"')+' on '+entName(ei)+' (Save as .bsp keeps it without compiling)');
  edPanel();}
// Modify's Edit parameters closed (opened here or there): Class specs shows the keys as they are now
const _edModEditClose=modEditClose;
modEditClose=function(){const r=_edModEditClose.apply(this,arguments);try{if(EON())edPanel();}catch(_e){}return r;};
function edSpecBind(el){
  const sd=$('edSpecs');if(sd)sd.ontoggle=()=>{ED.specs=sd.open;};
  const sm=$('edSpecMore');if(sm)sm.ontoggle=()=>{const was=!!ED.specMore;ED.specMore=sm.open;if(sm.open&&!was)edPanel();};
  const ei=edSpecEnt();if(ei<0)return;
  el.querySelectorAll('input[data-spec]').forEach(inp=>{
    inp.addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();e.stopImmediatePropagation();edRun(()=>edSpecSet(ei,inp.dataset.spec,inp.value))();});
    inp.addEventListener('change',()=>edRun(()=>edSpecSet(ei,inp.dataset.spec,inp.value))());});}
// the list: the definitions' brush classes and the map's own brush entities' classes
const ECL={el:null,back:null,hot:0,hits:[]};
function edClsAll(){
  const n=new Map(),d=new Map();
  for(const x of(D.bcls||[]))d.set(x[0].toLowerCase(),{c:x[0],t:x[1]||'',n:0});
  for(let ei=1;ei<MAP.nMap;ei++){const e=MAP.ents[ei];if(!e.prims.length||WORLDLIKE[e.cls])continue;const k=e.cls;
    const r=d.get(k)||{c:e.kvl.classname||k,t:'',n:0};r.n++;d.set(k,r);}
  return[...d.values()].sort((a,b)=>a.c.toLowerCase()<b.c.toLowerCase()?-1:1);}
function edClsClose(){if(ECL.back)ECL.back.remove();ECL.el=ECL.back=null;document.removeEventListener('keydown',edClsKey,true);}
function edClsPick(cl){edClsClose();edRun(()=>edClsApply(cl))();}
function edClsOpen(){
  edClsClose();ECL.hot=0;ECL.all=edClsAll();
  ECL.back=document.createElement('div');ECL.back.style.cssText='position:fixed;left:0;top:0;width:100%;height:100%;z-index:70';
  ECL.back.onclick=ev=>{if(!ECL.el||!ECL.el.contains(ev.target))edClsClose();};
  document.body.appendChild(ECL.back);
  const el=ECL.el=document.createElement('div');el.className='amPanel';
  el.innerHTML='<div class="amHead"><span class="amPathTxt">brush entity classes</span><span id="eclCnt"></span></div>'+
    '<input class="amSearch" type="text" id="eclSearch" placeholder="filter classes\u2026" spellcheck="false"><div class="amBody" id="eclBody"></div>';
  ECL.back.appendChild(el);
  const se=$('eclSearch');se.oninput=()=>{ECL.hot=0;edClsRender();};
  el.addEventListener('mousedown',ev=>{if(ev.target===se)return;ev.preventDefault();});
  document.addEventListener('keydown',edClsKey,true);
  edClsRender();se.focus();}
function edClsRender(){
  const bd=$('eclBody');if(!bd)return;
  const w=($('eclSearch').value||'').toLowerCase().split(/\s+/).filter(Boolean),cur=(($('edCls')&&$('edCls').value)||'').toLowerCase();
  const H=ECL.hits=ECL.all.filter(x=>w.every(t=>x.c.toLowerCase().includes(t)));
  ECL.hot=Math.max(0,Math.min(ECL.hot,H.length-1));
  bd.innerHTML=H.map((x,i)=>'<div class="amItem'+(i===ECL.hot?' hot':'')+(x.c.toLowerCase()===cur?' sel':'')+'" data-c="'+esc(x.c)+'" title="'+esc(x.c+(x.t?': '+x.t:'')+(x.n?' ('+x.n+' in this map)':''))+'">'+
    '<span class="lbl">'+esc(x.c)+'</span><span class="cnt">'+(x.n||'')+'</span></div>').join('')+(H.length?'':'<div class="amNote">no class matches that (Enter in the box takes any name typed there)</div>');
  bd.onclick=ev=>{const r=ev.target.closest('[data-c]');if(r){ev.stopPropagation();edClsPick(r.dataset.c);}};
  $('eclCnt').textContent=H.length+' / '+ECL.all.length;
  const b=$('bEdCls');if(!b)return;
  const r=b.getBoundingClientRect(),vw=window.innerWidth,vh=window.innerHeight,wd=ECL.el.offsetWidth||340;
  let left=r.left-6-wd;if(left<4)left=Math.min(r.right+6,Math.max(4,vw-4-wd));
  ECL.el.style.left=left+'px';ECL.el.style.maxHeight=(vh-8)+'px';
  const h=Math.min(ECL.el.getBoundingClientRect().height,vh-8);ECL.el.style.top=Math.max(4,Math.min(r.top,vh-4-h))+'px';}
function edClsKey(ev){
  if(!ECL.el)return;
  if(ev.key==='Escape'){edClsClose();ev.preventDefault();ev.stopPropagation();return;}
  if(ev.key==='Enter'){const x=ECL.hits[ECL.hot];if(x)edClsPick(x.c);ev.preventDefault();ev.stopPropagation();return;}
  if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){ECL.hot+=ev.key==='ArrowDown'?1:-1;edClsRender();
    const h=ECL.el.querySelector('.amItem.hot');if(h)h.scrollIntoView({block:'nearest'});ev.preventDefault();ev.stopPropagation();return;}
  ev.stopPropagation();}
function edTexApplyRun(tx,tile){try{return edTexApplySel(tx,tile);}catch(err){flash(err.message);const st=$('edBrSt');if(st)st.textContent=err.message;return false;}}
const _selectionChanged=selectionChanged;
selectionChanged=function(){_selectionChanged.apply(this,arguments);try{edPickSync();}catch(err){console.error(err);}try{edCopyBtn();}catch(_e){}};
function edPrim(){if(!ED.sel)return null;const e=MAP.ents[ED.sel.ei];const pr=e&&e.prims[ED.sel.bn];return pr&&pr.kind===0?pr:null;}
// replace the selected brush with these faces (checked first)
function edSetFaces(faces,what){
  const pr=edPrim();if(!pr)throw new Error('select a brush first');
  edCheck(faces);
  const ins=edBrushText(faces),del=D.srcText.slice(pr.ts,pr.te);
  if(ins===del){flash('No change');return;}
  edDo(pr.ts,del,ins,{ei:ED.sel.ei,bn:ED.sel.bn},what);
}
// a new brush at the end of an entity's block (worldspawn unless a brush entity is selected)
function edAddBrush(ei,faces,what){
  edCheck(faces);
  const e=MAP.ents[ei],end=D.srcText.lastIndexOf('}',e.te-1);
  if(end<e.ts)throw new Error('the entity\'s block can\'t be found in the text');
  const ins='// brush '+e.prims.length+' (Map Editor)\n'+edBrushText(faces)+'\n';
  edDo(end,'',ins,{ei:ei,bn:e.prims.length},what);
}

// ---- Undo: brush changes are steps in Modify's own Undo -------------------------------
const _modSnap=modSnap;
modSnap=function(){const s=_modSnap();s.edN=ED.n;return s;};
const _modRestore2=modRestore;
modRestore=function(s){if(typeof s==='string')s=JSON.parse(s);_modRestore2(s);
  if(s&&s.edN!=null&&s.edN!==ED.n){try{edGoto(s.edN);}catch(err){flash('Brushes not undone: '+err.message);}}};
// unsaved: Modify's work or brush changes since the last .map save
const _modUnsaved=modUnsaved;
modUnsaved=function(){const u=_modUnsaved();if(ED.n===ED.saved)return u;return Object.assign({nw:0,ch:0},u||{},{br:ED.n});};
const _modSave2=modSave;
modSave=function(kind){
  if(kind==='bsp'&&ED.n>0){const s='Brushes, patches or terrain changed, and a .bsp holds them compiled: Save as .map (a compiler turns it into a .bsp)';flash(s);$('modStat').textContent=s;MOD.closeAfter=false;return;}
  ED.saving=kind;
  // only brushes changed: Modify's own Save has nothing to send, so the .map goes as its does
  if(kind==='map'&&ED.n!==ED.saved&&!modSets().length&&!MOD.ents.some(m=>!modIsMap(m))){
    if(MOD.edit>=0)modEditClose(true);
    MOD.pendKey=modSaveKey();
    const req={kind:'map',ents:'',set:[],brushes:ED.n,mapText:modMapText(),src:D.srcFile||'',vpath:D.path||'',mapFile:(D.bsp&&D.bsp.mapFile)||'',isBsp:D.kind==='bsp',name:D.name||''};
    if(post('mohaa-modify-save\n'+JSON.stringify(req))){flash('Saving: choose where in the launcher');return;}
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([req.mapText],{type:'text/plain'}));
    a.download=(D.name||'map')+'_modified.map';document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);
    ED.saved=ED.n;ED.saving=null;edNewSync();return;}
  _modSave2(kind);
};
// Discard on closing lets the brush changes go too (and their kept copy)
const _modDiscardClose=modDiscardClose;
modDiscardClose=function(){ED.saved=ED.n;edNewSync();_modDiscardClose();};
// closing with brush changes unsaved: the launcher's question names them, and offers no
// Save as .bsp (a .bsp can't take them)
const _closeViewer=closeViewer;
closeViewer=function(force){
  const un=!force?modUnsaved():null;
  if(un&&un.br&&inHost()){post('mohaa-close-ask\n'+JSON.stringify({new:un.nw,changed:un.ch,brushes:un.br,isBsp:false,name:D.name||''}));return;}
  if(un&&un.br&&!inHost()&&!window.confirm('There are '+un.br+' geometry changes (brushes, patches, terrain; and '+un.nw+' new, '+un.ch+' changed entities) not saved. Close anyway and lose them?'))return;
  _closeViewer(force||(un&&un.br&&!inHost()));
};
const _modSaved=modSaved;
modSaved=function(ok,msg){if(ok&&ED.saving==='map'){ED.saved=ED.n;edNewSync();}ED.saving=null;return _modSaved(ok,msg);};
// Modify's recovery file carries the brush changes (and a copy with only those is kept too)
modBackupNow=function(){
  _modBkT=0;if(!MAP||!MOD)return;
  const un=modUnsaved(),id=modBackupId();
  const snap=un?modSnap():null,br=un&&ED.n>ED.saved?ED.all.slice(0,ED.n):null;
  const key=snap?JSON.stringify(snap.ents)+'|'+(br?br.length+':'+ED.saved:''):'';
  if(key===_modBkKey)return;_modBkKey=key;
  const o=snap?Object.assign(id,{t:Date.now(),nw:un.nw,ch:un.ch,ents:snap.ents},br?{brush:{ops:br}}:{}):id;
  const txt=JSON.stringify(o);if(txt.length>8e6)return;
  try{if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage('mohaa-modify-backup\n'+txt);return;}}catch(_e){}
  const k='mohaaMapViewerModify|'+id.map+'|'+id.mt;
  if(snap)LS.set(k,txt);else{try{localStorage.removeItem(k);}catch(_e){}}
};
const _REC=window.MOHAA_MODIFY_RECOVERY;
window.MOHAA_MODIFY_RECOVERY=function(b){
  const ops=b&&b.brush&&Array.isArray(b.brush.ops)?b.brush.ops.filter(o=>o&&typeof o.at==='number'&&typeof o.del==='string'&&typeof o.ins==='string'):[];
  if(!ops.length||ED.n){_REC(b);return;}
  const id=modBackupId();if(b.map!==id.map||String(b.mt||'')!==id.mt)return;
  const when=b.t?new Date(b.t).toLocaleString():'earlier';
  const ov=document.createElement('div');ov.className='ov';ov.id='edRecOv';
  ov.innerHTML='<div class="card" style="max-width:520px"><h3>Unsaved geometry work</h3><div class="co" style="margin-bottom:10px">'+
    'This map was closed or reloaded with '+ops.length+' geometry change'+(ops.length===1?'':'s')+' (brushes, patches, terrain) not saved ('+esc(when)+'). Restore '+(ops.length===1?'it':'them')+
    (b.ents&&b.ents.length?' (Modify\'s entities are asked about next)':'')+'?</div><div class="row">'+
    '<button id="bEdRecYes">Restore</button><span style="flex:1"></span><button id="bEdRecNo">Discard</button></div></div>';
  $('stage').appendChild(ov);
  const next=()=>{ov.remove();if(b.ents&&b.ents.length)_REC(b);};
  $('bEdRecYes').onclick=()=>{
    const keep=D.srcText;
    try{for(const o of ops)edTextApply(o,false);ED.all=ops.map(o=>({at:o.at,del:o.del,ins:o.ins,sel:o.sel||null}));ED.n=ops.length;edRebuild(ED.all[ED.n-1].sel);flash('Geometry changes restored: '+ops.length);}
    catch(err){D.srcText=keep;flash('The geometry changes don\'t fit this map any more: '+err.message);}
    next();};
  $('bEdRecNo').onclick=next;
};

// ---- the operations (each from the panel's typed values) ------------------------------
function edVec(prefix){return[0,1,2].map(k=>num($(prefix+k).value));}
function edOpBox(){
  const mn=edVec('edBmn'),mx=edVec('edBmx');
  if(!(mx[0]>mn[0]&&mx[1]>mn[1]&&mx[2]>mn[2]))throw new Error('each max must be greater than its min');
  const pr=edPrim(),faces=edFaces(pr),box=edBoxOf(faces);if(!box)throw new Error('this brush isn\'t a box: change its faces one by one');
  // each face slides along its axis; its points keep their place on the plane
  for(const f of faces){const pl=planeOf(f),ax=[0,1,2].find(k=>Math.abs(Math.abs(pl[k])-1)<1e-9),v=pl[ax]>0?mx[ax]:mn[ax];
    for(let q=0;q<3;q++)f.p[q*3+ax]=v;}
  edSetFaces(faces,'Brush resized');
}
function edOpMove(sign){
  const d=vscale(edVec('edMv'),sign||1);if(!d[0]&&!d[1]&&!d[2])throw new Error('type how far to move it');
  edSetFaces(edMoveFaces(edFaces(edPrim()),d,$('edLock').checked),'Brush moved '+d.map(fmt).join(' '));
}
function edOpCopy(){
  const d=edVec('edMv');const pr=edPrim();
  edAddBrush(ED.sel.ei,edMoveFaces(edFaces(pr),d,$('edLock').checked),'Brush copied, moved '+d.map(fmt).join(' '));
}
function edOpDelete(){
  const pr=edPrim();if(!pr)throw new Error('select a brush first');
  const e=MAP.ents[ED.sel.ei];
  if(ED.sel.ei>0&&e.prims.filter(x=>x&&x.kind===0).length<2)throw new Error('it is its entity\'s last brush: delete the entity in Modify instead');
  edDo(pr.ts,D.srcText.slice(pr.ts,pr.te),'',null,'Brush deleted');
}
function edOpNew(){
  const sz=edVec('edNs');if(sz.some(v=>v<=0))throw new Error('the size must be more than 0 each way');
  const a=camAxes(),L=4096,e=vadd(cam.pos,vscale(a.f,L));let p=vadd(cam.pos,vscale(a.f,Math.max(128,sz[0])));
  try{const t=pgTrace(cam.pos,e,[0,0,0],[0,0,0],false);if(t&&!t.startsolid&&t.f<1)p=vadd(cam.pos,vscale(a.f,t.f*L));}catch(_e){}
  const g=GRID.on?gridSize():8,snap=v=>Math.round(v/g)*g;
  const mn=[snap(p[0]-sz[0]/2),snap(p[1]-sz[1]/2),snap(p[2])],mx=[mn[0]+sz[0],mn[1]+sz[1],mn[2]+sz[2]];
  const tex=($('edTex').value||'').trim()||'common/caulk';
  const ent=ED.sel&&ED.sel.ei>0&&!isWorldlike(ED.sel.ei)&&ED.into?ED.sel.ei:0;
  edAddBrush(ent,edBoxFaces(mn,mx,tex),'New brush '+sz.map(fmt).join(' x ')+' at '+mn.map(fmt).join(' '));
}
// clip: keep the part behind the plane through three points (their order picks the side,
// as in the .map), or behind an axis plane
function edOpClip(){
  const faces=edFaces(edPrim());let P;
  if($('edClAx').value!=='pts'){
    const ax=+$('edClAx').value,v=num($('edClV').value),keepBelow=$('edClKeep').value==='below';
    const box=edBounds(faces);const u=(ax+1)%3,w=(ax+2)%3,lo=[box.mn[u]-64,box.mn[w]-64],hi=[box.mx[u]+64,box.mx[w]+64];
    const pt=(cu,cw)=>{const q=[0,0,0];q[ax]=v;q[u]=cu;q[w]=cw;return q;};
    P=[pt(lo[0],lo[1]),pt(hi[0],lo[1]),pt(lo[0],hi[1])];
    const n=vcross(vsub(P[0],P[1]),vsub(P[2],P[1]));const s=keepBelow?1:-1;if(n[ax]*s<0)P=[P[2],P[1],P[0]];
  }else P=[edVec('edCa'),edVec('edCb'),edVec('edCc')];
  const nf={p:[].concat(P[0],P[1],P[2]),tex:($('edTex').value||'').trim()||'common/caulk',sh:[0,0],rot:0,sc:[0.5,0.5],cont:0,flags:0,val:0,extra:'',tm:null};
  if(!planeOf(nf))throw new Error('the three points are in a line');
  let out;try{out=edPrune(faces.concat([nf]));}catch(err){throw new Error('nothing of the brush is left on that side ('+err.message+')');}
  if(!out.includes(nf))throw new Error('the plane doesn\'t cut the brush: all of it is kept');
  edSetFaces(out,'Brush clipped ('+out.length+' faces)');
}
// one face: its three points, its texture and how it lies
function edOpFace(){
  const faces=edFaces(edPrim()),k=ED.face;if(k<0||!faces[k])throw new Error('pick a face (click it in the view, or in the list)');
  const f=faces[k];
  f.p=[].concat(edVec('edFa'),edVec('edFb'),edVec('edFc'));
  if(!f.tm){f.sh=[num($('edFs0').value,-1e6,1e6),num($('edFs1').value,-1e6,1e6)];f.rot=num($('edFr').value,-3600,3600);
    f.sc=[num($('edFk0').value,-1e3,1e3),num($('edFk1').value,-1e3,1e3)];if(!f.sc[0]||!f.sc[1])throw new Error('a scale can\'t be 0');}
  edSetFaces(faces,'Face '+(k+1)+' set');
}
function edOpPush(){
  const faces=edFaces(edPrim()),k=ED.face;if(k<0||!faces[k])throw new Error('pick a face first');
  const a=num($('edPush').value);if(!a)throw new Error('type how far to push it out (or in, below 0)');
  const pl=planeOf(faces[k]),d=vscale(pl,a);for(let i=0;i<9;i++)faces[k].p[i]+=d[i%3];
  edSetFaces(faces,'Face '+(k+1)+' pushed '+fmt(a));
}
function edOpTexAll(){
  const tx=($('edTex').value||'').trim();if(!/^[^\s"(){}]+$/.test(tx))throw new Error('choose a texture first');
  const faces=edFaces(edPrim());for(const f of faces)f.tex=tx;edSetFaces(faces,'Every face: '+tx);
}
function edRun(fn){return()=>{try{fn();}catch(err){flash(err.message);const s=$('edBrSt');if(s)s.textContent=err.message;}};}

// ---- textures: the map's, and any in the paks (the launcher sends its picture) --------
const TXL={list:null,asked:false,want:new Set()};
function edTexName(n){return String(n||'').replace(/^textures\//i,'');}
function edTexOpen(target){
  TXL.target=target;
  let ov=$('edTxOv');
  if(!ov){ov=document.createElement('div');ov.className='ov';ov.id='edTxOv';
    ov.innerHTML='<div class="card" style="width:min(900px,94vw);height:min(720px,90vh);display:flex;flex-direction:column">'+
      '<h3 style="margin:0 0 6px">Textures</h3><div class="row" style="gap:6px"><input id="edTxQ" placeholder="search: words in the name" style="flex:1">'+
      '<button id="edTxX">Close</button></div><div class="co" id="edTxN" style="margin:4px 0"></div>'+
      '<div id="edTxL" style="flex:1;overflow:auto;display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start"></div></div>';
    $('stage').appendChild(ov);
    $('edTxQ').addEventListener('input',edTexRender);$('edTxX').onclick=()=>{ov.style.display='none';};
    $('edTxQ').addEventListener('keydown',e=>{if(e.key==='Escape'){ov.style.display='none';}e.stopPropagation();});
    $('edTxL').addEventListener('click',e=>{const it=e.target.closest('[data-t]');if(!it)return;edTexChoose(it.getAttribute('data-t'));ov.style.display='none';});}
  ov.style.display='flex';stopCamera();
  if(!TXL.list&&!TXL.asked&&post('mohaa-edit-texlist'))TXL.asked=true;
  $('edTxQ').value='';edTexRender();setTimeout(()=>$('edTxQ').focus(),0);
}
function edTexRender(){
  const q=$('edTxQ').value.trim().toLowerCase().split(/\s+/).filter(Boolean),ok=n=>q.every(w=>n.includes(w));
  const own=TEX.filter(t=>!t.standin&&!t.sim&&/^textures\//.test(t.n)).map(t=>t.n);const ownS=new Set(own);
  const pak=(TXL.list||[]).filter(n=>!ownS.has(n));
  let h='',c=0;const MAXR=600;
  const card=(n,i)=>{c++;const url=i!=null?TEXURL[i]:null;
    return '<div data-t="'+esc(n)+'" title="'+esc(n)+'" style="width:96px;cursor:pointer;font-size:11px;overflow:hidden">'+
      (url?'<img src="'+url+'" style="width:96px;height:96px;object-fit:cover;display:block">':'<div style="width:96px;height:96px;background:var(--panel2,#333);display:flex;align-items:center;justify-content:center;opacity:.7">in the paks</div>')+
      '<div style="white-space:nowrap;text-overflow:ellipsis;overflow:hidden">'+esc(edTexName(n))+'</div></div>';};
  const om=own.filter(ok).sort();for(const n of om){if(c>=MAXR)break;h+=card(n,TEXI.get(n).i);}
  const pm=pak.filter(ok);for(const n of pm){if(c>=MAXR)break;h+=card(n,null);}
  $('edTxL').innerHTML=h;
  $('edTxN').textContent=om.length+' in this map'+(TXL.list?', '+pm.length+' more in the paks':(TXL.asked?', the paks\' list is coming...':' (the paks\' list comes from the launcher)'))+(om.length+pm.length>MAXR?' - the first '+MAXR+' shown: type to narrow':'');
}
window.MOHAA_EDIT_TEXLIST=function(list,why){TXL.list=Array.isArray(list)?list.map(x=>String(x).toLowerCase()):null;TXL.asked=false;
  if(why)flash(why);if($('edTxOv')&&$('edTxOv').style.display!=='none')edTexRender();};
function edTexChoose(n){
  const name=edTexName(n),el=$(TXL.target||'edTex');if(el)el.value=name;
  const e=TEXI.get(n);if((!e||e.standin)&&!TXL.want.has(n)&&post('mohaa-edit-tex\n'+n)){TXL.want.add(n);flash('Fetching '+name+' from the paks...');}
  if((TXL.target||'edTex')==='edTex')edTexApplyRun(name);
}
// the launcher's picture for a texture: filled into its entry (the map's stand-in if a face
// already names it), then the scene built again so the faces use its size
window.MOHAA_EDIT_TEX=async function(name,b64){
  const n=String(name||'').toLowerCase();TXL.want.delete(n);
  try{const P=await decodePacket(String(b64||''));
    for(const t of P.tex||[]){let te=TEXI.get(t.n);
      if(te&&!te.standin)continue;
      if(!te){te={i:TEX.length};TEX.push(te);MAT.push(null);matFaces.push([]);}
      const i=te.i;Object.keys(te).forEach(k=>{if(k!=='i')delete te[k];});Object.assign(te,t,{i:i});delete te.b;delete te.gb;
      TEXI.set(t.n,te);MAT[i]=matOf(te);GLT[i]=colourTex(te.c||[0.5,0.5,0.5]);
      if(t.b!=null)TEXURL[i]=blobTexture(t.b,t.m,x=>{GLT[i]=x;},P);}
    edRebuild(ED.sel);flash(edTexName(n)+' loaded');
  }catch(err){flash(edTexName(n)+' can\'t be shown: '+(err&&err.message||err));}
};
window.MOHAA_EDIT_TEX_FAIL=function(name,why){TXL.want.delete(String(name||'').toLowerCase());flash(edTexName(name)+': '+why);};

// ==== patches and terrain ===================================================================
// The same way as brushes: each change is a checked edit of the block's text, then the scene
// is built again from it. Only what changes is rewritten (a patch's texture and control
// points, a terrain block's origin, texture lines and heights); the rest stays as it was,
// such as a patch's header and a terrain vertex's other flags (maxdetail ...).
const edN6=x=>{const r=Math.round(x*1e6)/1e6;return String(Object.is(r,-0)?0:r);};
const edTexOk=tx=>{if(!/^[^\s"(){}]+$/.test(tx||''))throw new Error('a texture name without spaces, quotes or brackets');return tx;};
function edPrimOf(kind){if(!ED.sel)return null;const e=MAP.ents[ED.sel.ei];const pr=e&&e.prims[ED.sel.bn];return pr&&pr.kind===kind?pr:null;}
function edPatch(){return edPrimOf(1);}
function edTerr(){return edPrimOf(2);}
function edSkipWs(s,i){while(i<s.length){if(/\s/.test(s[i])){i++;continue;}if(s[i]==='/'&&s[i+1]==='/'){const n=s.indexOf('\n',i);i=n<0?s.length:n+1;continue;}break;}return i;}
// a ( ) or { } group starting at s[i]: the index just past its closer
function edGroup(s,i){const o=s[i],c=o==='('?')':o==='{'?'}':'';if(!c)throw new Error('the block isn\'t laid out as expected');
  let d=0;for(let k=i;k<s.length;k++){if(s[k]===o)d++;else if(s[k]===c&&!--d)return k+1;}throw new Error('the block\'s brackets don\'t close');}
function edWord(s,i){const a=edSkipWs(s,i);let b=a;while(b<s.length&&!/[\s(){}]/.test(s[b]))b++;if(b===a)throw new Error('the block isn\'t laid out as expected');return[a,b];}
// a new block at the end of an entity (the world unless a brush entity is given)
function edAddBlock(ei,text,label,what){
  const e=MAP.ents[ei],end=D.srcText.lastIndexOf('}',e.te-1);
  if(end<e.ts)throw new Error('the entity\'s block can\'t be found in the text');
  edDo(end,'','// '+label+' '+e.prims.length+' (Map Editor)\n'+text+'\n',{ei:ei,bn:e.prims.length},what);
}
function edReplace(pr,ins,what){
  const del=D.srcText.slice(pr.ts,pr.te);
  if(ins===del){flash('No change');return;}
  edDo(pr.ts,del,ins,{ei:ED.sel.ei,bn:ED.sel.bn},what);
}
function edDeletePrim(pr,what){edDo(pr.ts,D.srcText.slice(pr.ts,pr.te),'',null,what);}
function edNewSpot(){
  const a=camAxes(),L=4096,e=vadd(cam.pos,vscale(a.f,L));let p=vadd(cam.pos,vscale(a.f,256));
  try{const t=pgTrace(cam.pos,e,[0,0,0],[0,0,0],false);if(t&&!t.startsolid&&t.f<1)p=vadd(cam.pos,vscale(a.f,t.f*L));}catch(_e){}
  return p;
}
function edTexSize(tx){const te=TEXI.get('textures/'+String(tx).toLowerCase());return[(te&&!te.standin&&te.w)||256,(te&&!te.standin&&te.h)||256];}

// ---- patches -----------------------------------------------------------------------------
// The control points as the .map holds them: w rows of h points, each x y z s t.
function edPatchData(pr){const d=pr.d;return{w:d.w,h:d.h,tex:d.tex,pts:Array.from(d.pts)};}
function edPatchParts(txt){
  const m=/patchdef[23]/i.exec(txt);if(!m)throw new Error('not a patch');
  let i=edSkipWs(txt,m.index+m[0].length);if(txt[i]!=='{')throw new Error('the patch isn\'t laid out as expected');
  const[t0,t1]=edWord(txt,i+1);
  const h0=edSkipWs(txt,t1),h1=edGroup(txt,h0);
  const m0=edSkipWs(txt,h1),m1=edGroup(txt,m0);
  return{t0:t0,t1:t1,m0:m0,m1:m1};
}
function edPatchMatrix(P){
  const rows=[];
  for(let j=0;j<P.w;j++){const r=[];for(let i=0;i<P.h;i++){const o=(j*P.h+i)*5;r.push('( '+[0,1,2,3,4].map(k=>edN6(P.pts[o+k])).join(' ')+' )');}rows.push('( '+r.join(' ')+' )');}
  return '(\n'+rows.join('\n')+'\n)';
}
function edPatchCheck(P){
  edTexOk(P.tex);
  if(P.w<3||P.h<3||!(P.w&1)||!(P.h&1)||P.w>129||P.h>129)throw new Error('a patch has 3 to 129 control points each way, an odd number');
  for(let k=0;k<P.pts.length;k++){const v=P.pts[k];if(!isFinite(v))throw new Error('a control point isn\'t a number');
    if(k%5<3&&Math.abs(v)>WMAX)throw new Error('a control point outside -65536 to 65536');}
}
function edPatchText(P){return '{\npatchDef2\n{\n'+P.tex+'\n( '+P.w+' '+P.h+' 0 0 0 )\n'+edPatchMatrix(P)+'\n}\n}';}
// the matrix with only the points that changed written again, so the rest keeps its text
function edPatchSplice(m,P){
  const re=/\(([^()]*)\)/g;let k=0,out='',last=0,x;
  while((x=re.exec(m))){const o=k*5,was=x[1].trim().split(/\s+/).map(Number),cur=P.pts.slice(o,o+5);
    if(cur.length===5&&cur.some((v,i)=>v!==was[i])){out+=m.slice(last,x.index)+'( '+cur.map(edN6).join(' ')+' )';last=x.index+x[0].length;}
    k++;}
  if(k!==P.w*P.h)return null;
  return out+m.slice(last);
}
function edSetPatch(P,what){
  const pr=edPatch();if(!pr)throw new Error('select a patch first');
  edPatchCheck(P);
  const t=D.srcText.slice(pr.ts,pr.te),q=edPatchParts(t),m=t.slice(q.m0,q.m1);
  const mm=(P.w===pr.d.w&&P.h===pr.d.h&&edPatchSplice(m,P))||edPatchMatrix(P);
  edReplace(pr,t.slice(0,q.t0)+(P.tex===pr.d.tex?t.slice(q.t0,q.t1):P.tex)+t.slice(q.t1,q.m0)+mm+t.slice(q.m1),what);
}
// texture coordinates: "natural" (texels the size of the scale given, along the control
// net, as a brush face at that scale) or "fit" (the texture once across each way)
function edPatchTex(P,mode,scale){
  const [tw,th]=edTexSize(P.tex),pt=(j,i)=>{const o=(j*P.h+i)*5;return[P.pts[o],P.pts[o+1],P.pts[o+2]];};
  const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
  for(let j=0;j<P.w;j++)for(let i=0;i<P.h;i++){
    const o=(j*P.h+i)*5;
    if(mode==='fit'){P.pts[o+3]=j/(P.w-1);P.pts[o+4]=i/(P.h-1);continue;}
    let s=0,t=0;for(let k=1;k<=j;k++)s+=dist(pt(k-1,i),pt(k,i));for(let k=1;k<=i;k++)t+=dist(pt(j,k-1),pt(j,k));
    P.pts[o+3]=s/(tw*scale);P.pts[o+4]=t/(th*scale);}
  return P;
}
// which way a patch faces: its control net's rows (the .map's outer lists) crossed with its
// columns, as q3map's normals come out in the game's .bsp files (checked on m4l0 and mohdm6:
// 1,114 of 1,116 patch squares). The middle of the net, or its first square if that is flat.
function edPatchFacing(P){
  const pt=(j,i)=>{const o=(j*P.h+i)*5;return[P.pts[o],P.pts[o+1],P.pts[o+2]];};
  const at=(j,i)=>{const a=vsub(pt(Math.min(P.w-1,j+1),i),pt(Math.max(0,j-1),i)),b=vsub(pt(j,Math.min(P.h-1,i+1)),pt(j,Math.max(0,i-1)));return vcross(a,b);};
  for(const[j,i]of[[(P.w-1)/2,(P.h-1)/2],[0,0],[P.w-1,P.h-1]]){const n=at(j,i),l=Math.hypot(n[0],n[1],n[2]);if(l>1e-6)return n.map(x=>x/l);}
  return null;
}
// a new patch's control points: a shape in the box mn + size (each faces out: up, or away
// from its middle; Flip turns it round)
function edPatchShape(shape,mn,sz,tex){
  const r2=Math.SQRT2,P={tex:tex,w:3,h:3,pts:[]};
  const put=(x,y,z)=>P.pts.push(x,y,z,0,0);
  const arc=(n,a0,a1)=>{const out=[];for(let j=0;j<n;j++){const a=(a0+(a1-a0)*j/(n-1))*Math.PI/180,k=(j&1)?r2:1;out.push([Math.cos(a)*k,Math.sin(a)*k]);}return out;};
  const c=[mn[0]+sz[0]/2,mn[1]+sz[1]/2];
  if(shape==='flat'){for(let j=0;j<3;j++)for(let i=0;i<3;i++)put(mn[0]+sz[0]*j/2,mn[1]+sz[1]*i/2,mn[2]);}
  else if(shape==='wallx'){for(let j=0;j<3;j++)for(let i=0;i<3;i++)put(mn[0]+sz[0]*j/2,mn[1],mn[2]+sz[2]*(2-i)/2);}
  else if(shape==='wally'){for(let j=0;j<3;j++)for(let i=0;i<3;i++)put(mn[0],mn[1]+sz[1]*(2-j)/2,mn[2]+sz[2]*(2-i)/2);}
  else if(shape==='cyl'){P.w=9;for(const[ca,sa] of arc(9,0,360))for(let i=0;i<3;i++)put(c[0]+ca*sz[0]/2,c[1]+sa*sz[1]/2,mn[2]+sz[2]*i/2);}
  else if(shape==='archx'){P.w=5;for(const[ca,sa] of arc(5,180,0))for(let i=0;i<3;i++)put(c[0]+ca*sz[0]/2,mn[1]+sz[1]*i/2,mn[2]+sa*sz[2]);}
  else if(shape==='archy'){P.w=5;for(const[ca,sa] of arc(5,0,180))for(let i=0;i<3;i++)put(mn[0]+sz[0]*i/2,c[1]+ca*sz[1]/2,mn[2]+sa*sz[2]);}
  else throw new Error('pick a shape');
  return edPatchTex(P,'natural',0.5);
}
function edPatchOpNew(){
  const sz=edVec('edPNs');const shape=$('edPShape').value;
  if(sz.some((v,k)=>v<0||(v===0&&!(shape==='flat'&&k===2)&&!(shape==='wallx'&&k===1)&&!(shape==='wally'&&k===0))))throw new Error('the size must be more than 0 each way the shape uses');
  const p=edNewSpot(),g=GRID.on?gridSize():8,snap=v=>Math.round(v/g)*g;
  const mn=[snap(p[0]-sz[0]/2),snap(p[1]-sz[1]/2),snap(p[2])];
  const P=edPatchShape(shape,mn,sz,edTexOk(($('edTex').value||'').trim()||'common/caulk'));edPatchCheck(P);
  const ent=ED.sel&&ED.sel.ei>0&&!isWorldlike(ED.sel.ei)&&ED.into?ED.sel.ei:0;
  edAddBlock(ent,edPatchText(P),'patch','New patch ('+P.w+' x '+P.h+' points) at '+mn.map(fmt).join(' '));
}
function edPatchPoint(P){const j=ED.pp?ED.pp[0]:0,i=ED.pp?ED.pp[1]:0;return(j<P.w&&i<P.h)?[j,i]:[0,0];}
function edPatchOpPoint(){
  const P=edPatchData(edPatch());const j=num($('edPj').value,0,P.w-1)|0,i=num($('edPi').value,0,P.h-1)|0;
  const v=edVec('edPv'),o=(j*P.h+i)*5;P.pts[o]=v[0];P.pts[o+1]=v[1];P.pts[o+2]=v[2];
  P.pts[o+3]=num($('edPs').value,-1e6,1e6);P.pts[o+4]=num($('edPt').value,-1e6,1e6);
  ED.pp=[j,i];edSetPatch(P,'Point '+j+' '+i+' set');
}
function edPatchOpMove(copy){
  const pr=edPatch(),P=edPatchData(pr),d=edVec('edPMv');if(!d[0]&&!d[1]&&!d[2])throw new Error('type how far to move it');
  const what=copy?'all':$('edPApply').value,[pj,pi]=edPatchPoint(P);
  for(let j=0;j<P.w;j++)for(let i=0;i<P.h;i++){
    if(what==='point'&&(j!==pj||i!==pi))continue;if(what==='row'&&j!==pj)continue;if(what==='col'&&i!==pi)continue;
    const o=(j*P.h+i)*5;for(let k=0;k<3;k++)P.pts[o+k]+=d[k];}
  if(copy){edPatchCheck(P);edAddBlock(ED.sel.ei,edPatchText(P),'patch','Patch copied, moved '+d.map(fmt).join(' '));return;}
  edSetPatch(P,(what==='all'?'Patch':what==='point'?'Point':what==='row'?'Row '+pj:'Column '+pi)+' moved '+d.map(fmt).join(' '));
}
function edPatchOpTurn(){
  const P=edPatchData(edPatch());let mn=[Infinity,Infinity],mx=[-Infinity,-Infinity];
  for(let o=0;o<P.pts.length;o+=5)for(let k=0;k<2;k++){mn[k]=Math.min(mn[k],P.pts[o+k]);mx[k]=Math.max(mx[k],P.pts[o+k]);}
  const cx=(mn[0]+mx[0])/2,cy=(mn[1]+mx[1])/2;
  for(let o=0;o<P.pts.length;o+=5){const x=P.pts[o]-cx,y=P.pts[o+1]-cy;P.pts[o]=cx-y;P.pts[o+1]=cy+x;}
  edSetPatch(P,'Patch turned 90 degrees round its middle');
}
function edPatchOpFlip(){
  const P=edPatchData(edPatch()),q=P.pts.slice();
  for(let j=0;j<P.w;j++)for(let i=0;i<P.h;i++)for(let k=0;k<5;k++)P.pts[(j*P.h+i)*5+k]=q[(j*P.h+(P.h-1-i))*5+k];
  edSetPatch(P,'Patch flipped (it faces the other way)');
}
function edPatchOpTex(){
  const P=edPatchData(edPatch());P.tex=edTexOk(($('edTex').value||'').trim());
  const m=$('edPTm').value;if(m!=='keep')edPatchTex(P,m,num($('edPTs').value,0.001,1000));
  edSetPatch(P,'Patch texture '+P.tex+(m==='keep'?'':' ('+m+')'));
}
function edPatchOpDelete(){edDeletePrim(edPatch(),'Patch deleted');}

// ---- terrain -----------------------------------------------------------------------------
// A terrainDef: W x H vertices 64 units apart (8 per 512-unit patch, so 8k+1 each way), an
// origin, one texture line per patch corner and a height with two ( ) flag groups per vertex
// (the first and second triangle of the square it starts: nodraw cuts a hole).
const TER_STEP=64;
function edTerrParts(txt){
  const m=/terraindef/i.exec(txt);if(!m)throw new Error('not a terrain block');
  let i=edSkipWs(txt,m.index+m[0].length);if(txt[i]!=='{')throw new Error('the terrain block isn\'t laid out as expected');
  const w=[];let at=i+1;for(let k=0;k<6;k++){const r=edWord(txt,at);w.push(r);at=r[1];}
  const c0=edSkipWs(txt,at),c1=edGroup(txt,c0),e0=edSkipWs(txt,c1),e1=edGroup(txt,e0);
  return{W:parseInt(txt.slice(w[0][0],w[0][1]),10),H:parseInt(txt.slice(w[1][0],w[1][1]),10),o0:w[3][0],o1:w[5][1],c0:c0,c1:c1,e0:e0,e1:e1};
}
function edTerrData(pr){
  const t=D.srcText.slice(pr.ts,pr.te),q=edTerrParts(t),V=[];
  const s0=q.e0+1,s=t.slice(s0,q.e1-1);let i=0;
  while((i=edSkipWs(s,i))<s.length){
    const[a,b]=edWord(s,i);const h=parseFloat(s.slice(a,b));if(!isFinite(h))throw new Error('a terrain height isn\'t a number');
    i=b;let end=b;const g=[];while((i=edSkipWs(s,i))<s.length&&s[i]==='('){const e=edGroup(s,i);g.push(s.slice(i+1,e-1).trim().split(/\s+/).filter(Boolean));i=end=e;}
    while(g.length<2)g.push([]);V.push({h:h,g:g,h0:h,g0:JSON.stringify(g),a:s0+a,b:s0+end});}
  if(V.length!==q.W*q.H)throw new Error('the terrain block has '+V.length+' heights for '+q.W+' x '+q.H+' vertices');
  const cl=[],cl0=[],cs=t.slice(q.c0+1,q.c1-1),re=/\(([^()]*)\)/g;let x;
  while((x=re.exec(cs))){const c=x[1].trim().split(/\s+/);cl.push(c);cl0.push({s:c.join(' '),a:q.c0+1+x.index,b:q.c0+1+x.index+x[0].length});}
  return{txt:t,q:q,W:q.W,H:q.H,org:pr.d.org.slice(),org0:pr.d.org.slice(),V:V,cl:cl,cl0:cl0};
}
const edHole=(v,s)=>v.g[s].some(x=>/^(nodraw|invisible)$/i.test(x));   // EA's two kinds of hole
function edTerrCheck(T){
  if((T.W-1)%8||(T.H-1)%8||T.W<9||T.H<9||T.W>257||T.H>257)throw new Error('a terrain block is 9, 17, 25 ... 257 vertices each way');
  for(let k=0;k<2;k++){
    if(T.org[k]%TER_STEP)throw new Error('a terrain block\'s x and y are on the 64-unit grid (the .bsp stores them so)');
    const a=T.org[k]/TER_STEP,b=a+((k?T.H:T.W)-1)-8;
    if(a<-128||b>127)throw new Error('a terrain block stays inside -8192 to 8192 on x and y (the .bsp stores where each patch is in one signed byte of 64-unit steps)');}
  for(const v of T.V){if(!isFinite(v.h))throw new Error('a terrain height isn\'t a number');if(Math.abs(T.org[2]+v.h)>32000)throw new Error('a terrain height past 32000 (the .bsp stores the patch\'s base in 16 bits)');}
}
// patches whose heights span more than the .bsp can hold (each patch's heights are bytes
// times 2 above its lowest point: 510 at most)
function edTerrSpan(T){let n=0,worst=0;
  for(let pj=0;pj<T.H-1;pj+=8)for(let pi=0;pi<T.W-1;pi+=8){let lo=Infinity,hi=-Infinity;
    for(let b=0;b<9;b++)for(let a=0;a<9;a++){const h=T.V[(pj+b)*T.W+pi+a].h;lo=Math.min(lo,h);hi=Math.max(hi,h);}
    if(hi-lo>510){n++;worst=Math.max(worst,hi-lo);}}
  return{n:n,worst:worst};}
function edTerrHeights(T){
  return '{\n'+T.V.map(v=>'\t\t\t'+v.h.toFixed(6)+' '+edGroups(v)).join('\n')+'\n\t\t}';
}
function edTerrCorners(T){return '{\n'+T.cl.map(c=>'\t\t\t0 0 ( '+c.join(' ')+' )').join('\n')+'\n\t\t}';}
const edGroups=v=>v.g.map(x=>'( '+x.join(' ')+(x.length?' ':'')+')').join(' ');
// the block's text with only what changed written again (its origin, a texture line, a
// vertex's height and flags), so everything else keeps its own text
function edTerrText(T){
  const t=T.txt,q=T.q,rep=[];
  if(T.org.some((v,k)=>v!==T.org0[k]))rep.push([q.o0,q.o1,T.org.map(v=>v.toFixed(6)).join(' ')]);
  T.cl.forEach((c,k)=>{const o=T.cl0[k];if(o&&c.join(' ')!==o.s)rep.push([o.a,o.b,'( '+c.join(' ')+' )']);});
  for(const v of T.V)if(v.h!==v.h0||JSON.stringify(v.g)!==v.g0)rep.push([v.a,v.b,v.h.toFixed(6)+' '+edGroups(v)]);
  rep.sort((a,b)=>a[0]-b[0]);
  let out='',at=0;for(const[a,b,s]of rep){out+=t.slice(at,a)+s;at=b;}
  return out+t.slice(at);
}
function edTerrNewText(W,H,org,tex,hs){
  const nc=((W-1)/8+1)*((H-1)/8+1),cl=[];for(let k=0;k<nc;k++)cl.push([tex,'0','0','0.00','256','1','1','0','0','0']);
  const V=[];for(let k=0;k<W*H;k++)V.push({h:hs?hs[k]:0,g:[[],[]]});
  const T={W:W,H:H,org:org,V:V,cl:cl};edTerrCheck(T);
  return '{\nterrainDef\n{\n'+W+' '+H+' 0\n'+org.map(v=>v.toFixed(6)).join(' ')+'\n\t\t'+edTerrCorners(T)+'\n\t\t'+edTerrHeights(T)+'\n}\n}';
}
function edSetTerr(T,what){
  const pr=edTerr();if(!pr)throw new Error('select a terrain block first');
  edTerrCheck(T);const sp=edTerrSpan(T);
  edReplace(pr,edTerrText(T),what+(sp.n?' - '+sp.n+(sp.n===1?' patch spans':' patches span')+' more than 510 in height (up to '+fmt(sp.worst)+'): a .bsp holds 510 above each patch\'s lowest point':''));
}
function edTerrVert(T){const v=ED.tv||[0,0];return[Math.min(T.W-1,Math.max(0,v[0])),Math.min(T.H-1,Math.max(0,v[1]))];}
function edTerrRect(T,pfx,maxI,maxJ){
  const a=[num($(pfx+'0').value,0,maxI)|0,num($(pfx+'1').value,0,maxJ)|0],b=[num($(pfx+'2').value,0,maxI)|0,num($(pfx+'3').value,0,maxJ)|0];
  return[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];
}
function edTerrOpHeights(){
  const T=edTerrData(edTerr()),[i0,j0,i1,j1]=edTerrRect(T,'edTr',T.W-1,T.H-1),v=num($('edThV').value,-32000,32000),add=$('edThM').value==='add';
  for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){const x=T.V[j*T.W+i];x.h=add?x.h+v:v;}
  edSetTerr(T,'Heights '+(add?'raised by ':'set to ')+fmt(v)+' on '+(i1-i0+1)*(j1-j0+1)+' vertices');
}
function edTerrOpHill(){
  const T=edTerrData(edTerr()),[ci,cj]=edTerrVert(T),r=num($('edThR').value,1,1e5),a=num($('edThA').value,-32000,32000),shape=$('edThS').value;
  let n=0;
  for(let j=0;j<T.H;j++)for(let i=0;i<T.W;i++){const d=Math.hypot(i-ci,j-cj)*TER_STEP;if(d>r)continue;
    const f=shape==='flat'?1:shape==='cone'?1-d/r:(1+Math.cos(Math.PI*d/r))/2;
    const x=T.V[j*T.W+i];x.h=Math.round((x.h+a*f)*100)/100;n++;}
  edSetTerr(T,'Raised by '+fmt(a)+' ('+shape+') within '+fmt(r)+' of vertex '+ci+' '+cj+' ('+n+' vertices)');
}
function edTerrOpSmooth(){
  const T=edTerrData(edTerr()),[i0,j0,i1,j1]=edTerrRect(T,'edTr',T.W-1,T.H-1),old=T.V.map(v=>v.h);
  for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){let s=0,c=0;
    for(const[di,dj]of[[0,0],[1,0],[-1,0],[0,1],[0,-1]]){const a=i+di,b=j+dj;if(a<0||b<0||a>=T.W||b>=T.H)continue;s+=old[b*T.W+a];c++;}
    T.V[j*T.W+i].h=Math.round(s/c*100)/100;}
  edSetTerr(T,'Smoothed '+(i1-i0+1)*(j1-j0+1)+' vertices');
}
function edTerrOpHoles(on){
  const T=edTerrData(edTerr()),[i0,j0,i1,j1]=edTerrRect(T,'edTq',T.W-2,T.H-2);
  for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){const v=T.V[j*T.W+i];
    for(let s=0;s<2;s++){v.g[s]=v.g[s].filter(x=>!/^(nodraw|invisible)$/i.test(x));if(on)v.g[s].push('nodraw');}}
  edSetTerr(T,(on?'Hole cut in ':'Filled ')+(i1-i0+1)*(j1-j0+1)+' squares');
}
function edTerrOpTex(){
  const T=edTerrData(edTerr()),tx=edTexOk(($('edTex').value||'').trim());
  const sh=[num($('edTs0').value,-1e6,1e6),num($('edTs1').value,-1e6,1e6)],rot=num($('edTrot').value,-3600,3600),sc=[num($('edTk0').value,-1e3,1e3),num($('edTk1').value,-1e3,1e3)];
  if(!sc[0]||!sc[1])throw new Error('a scale can\'t be 0');
  for(const c of T.cl){while(c.length<7)c.push('0');c[0]=tx;c[1]=edN6(sh[0]);c[2]=edN6(sh[1]);c[3]=edN6(rot);c[5]=edN6(sc[0]);c[6]=edN6(sc[1]);}
  edSetTerr(T,'Terrain texture '+tx);
}
function edTerrOpMove(copy){
  const pr=edTerr(),T=edTerrData(pr),d=edVec('edTMv');if(!d[0]&&!d[1]&&!d[2])throw new Error('type how far to move it');
  if(d[0]%TER_STEP||d[1]%TER_STEP)throw new Error('a terrain block moves in 64-unit steps on x and y');
  T.org=vadd(T.org,d);
  if(copy){edTerrCheck(T);edAddBlock(ED.sel.ei,edTerrText(T),'terrain','Terrain copied, moved '+d.map(fmt).join(' '));return;}
  edSetTerr(T,'Terrain moved '+d.map(fmt).join(' '));
}
function edTerrOpNew(){
  const nx=num($('edTNx').value,1,32)|0,ny=num($('edTNy').value,1,32)|0,p=edNewSpot(),W=nx*8+1,H=ny*8+1;
  const org=[Math.round((p[0]-nx*256)/TER_STEP)*TER_STEP,Math.round((p[1]-ny*256)/TER_STEP)*TER_STEP,Math.round(p[2])];
  edAddBlock(0,edTerrNewText(W,H,org,edTexOk(($('edTex').value||'').trim()||'common/caulk')),'terrain','New terrain '+W+' x '+H+' at '+org.map(fmt).join(' '));
}
function edTerrOpDelete(){edDeletePrim(edTerr(),'Terrain deleted');}

// ---- picking a control point or vertex from the click ------------------------------------------
function edNearPoint(){
  const h=lastHit;if(!h||!h.point||h.prim<0||!ED.sel)return;
  const r=SC.prims[h.prim];if(!r||r.ent!==ED.sel.ei||r.bn!==ED.sel.bn)return;
  const pr=MAP.ents[r.ent].prims[r.bn];if(!pr)return;const p=h.point;
  if(pr.kind===1){const d=pr.d;let best=Infinity;
    for(let j=0;j<d.w;j++)for(let i=0;i<d.h;i++){const o=(j*d.h+i)*5,q=Math.hypot(d.pts[o]-p[0],d.pts[o+1]-p[1],d.pts[o+2]-p[2]);if(q<best){best=q;ED.pp=[j,i];}}}
  else if(pr.kind===2){const d=pr.d;ED.tv=[Math.min(d.W-1,Math.max(0,Math.round((p[0]-d.org[0])/TER_STEP))),Math.min(d.H-1,Math.max(0,Math.round((p[1]-d.org[1])/TER_STEP)))];}
}
// the selected patch's control net and point, or the terrain vertex, drawn over the view
// the compiler's leak trail (from the void to the entity it reached), in red
function edLeakLines(H){
  const p=ED.leak;if(!p||p.length<2)return;
  for(let k=1;k<p.length;k++)H.push(p[k-1][0],p[k-1][1],p[k-1][2],1,0.15,0.15,1,p[k][0],p[k][1],p[k][2],1,0.15,0.15,1);
}
window.MOHAA_EDIT_LEAK=function(pts){
  ED.leak=Array.isArray(pts)?pts.filter(v=>Array.isArray(v)&&v.length===3&&v.every(isFinite)).slice(0,2000):null;
  lineDirty=true;requestDraw();
  if(ED.leak&&ED.leak.length){const a=ED.leak[0];
    flash('The map leaks: the red line runs from the void ('+a.map(fmt).join(' ')+') to the entity it reached; the gap is where it crosses the outer walls');}
};
function edMarks(){
  const H=[],L=[];if(typeof MAP==='undefined'||!MAP)return{H:H,L:L};
  try{edNewLines(L);}catch(_e){}
  if(!EON()){edLeakLines(H);return{H:H,L:L};}
  if(ED.prev){for(let k=0;k<ED.prev.H.length;k++)H.push(ED.prev.H[k]);for(let k=0;k<ED.prev.L.length;k++)L.push(ED.prev.L[k]);}
  if(!EDDRAG)try{edCornerMarks(L);}catch(_e){}
  if(!ED.sel){edLeakLines(H);return{H:H,L:L};}
  const pr=MAP.ents[ED.sel.ei]&&MAP.ents[ED.sel.ei].prims[ED.sel.bn];if(!pr){edLeakLines(H);return{H:H,L:L};}
  const sc=hexRGB(TH.sel),line=(A,a,b,c)=>A.push(a[0],a[1],a[2],c[0],c[1],c[2],c[3],b[0],b[1],b[2],c[0],c[1],c[2],c[3]);
  const cross=(A,p,r,c)=>{for(let k=0;k<3;k++){const a=p.slice(),b=p.slice();a[k]-=r;b[k]+=r;line(A,a,b,c);}};
  const hot=[sc[0],sc[1],sc[2],1],dim=[1,1,1,0.55];
  edLeakLines(H);
  if(pr.kind===1){const d=pr.d,pt=(j,i)=>{const o=(j*d.h+i)*5;return[d.pts[o],d.pts[o+1],d.pts[o+2]];};
    for(let j=0;j<d.w;j++)for(let i=0;i<d.h;i++){if(j+1<d.w)line(L,pt(j,i),pt(j+1,i),dim);if(i+1<d.h)line(L,pt(j,i),pt(j,i+1),dim);cross(L,pt(j,i),3,dim);}
    const[j,i]=ED.pp&&ED.pp[0]<d.w&&ED.pp[1]<d.h?ED.pp:[0,0];cross(H,pt(j,i),10,hot);}
  else if(pr.kind===2){const d=pr.d,[i,j]=ED.tv?[Math.min(d.W-1,ED.tv[0]),Math.min(d.H-1,ED.tv[1])]:[0,0];
    const p=[d.org[0]+i*TER_STEP,d.org[1]+j*TER_STEP,d.org[2]+d.heights[j*d.W+i]];cross(H,p,16,hot);line(H,p,[p[0],p[1],p[2]+48],hot);}
  return{H:H,L:L};
}
const _rebuildLines=rebuildLines;
rebuildLines=function(){
  let M=null;try{M=edMarks();}catch(err){console.error(err);}
  if(!gl||!M||(!M.H.length&&!M.L.length))return _rebuildLines.apply(this,arguments);
  // the page's lines as it uploads them (its selection's first), then again with these added
  const bd=gl.bufferData;let got=null;
  gl.bufferData=function(t,data,u){if(t===gl.ARRAY_BUFFER&&data instanceof Float32Array&&!got)got=data;return bd.call(gl,t,data,u);};
  try{_rebuildLines.apply(this,arguments);}finally{gl.bufferData=bd;}
  const a=got?Array.from(got.subarray(0,lineVerts*7)):[],h=hotVerts*7;
  const out=M.H.concat(a.slice(0,h),a.slice(h),M.L);
  gl.bindBuffer(gl.ARRAY_BUFFER,B.line);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(out),gl.DYNAMIC_DRAW);
  lineVerts=out.length/7;hotVerts+=M.H.length/7;
};

// ==== editing in the view: draw, resize, move, clip, terrain ================================
// The Editor section's tools, used with the mouse in the 3D view as MOHRadiant's are in its
// 2D views: drag out a brush, pull its faces, slide it, cut it on a line, and paint or shape
// terrain. Every drag is shown as outlines while the mouse moves and written to the map's
// text once, on release (one Undo step). Coordinates snap to the view's grid size (the Grid
// slider, 8 at first, whether the grid is drawn or not).
ED.tool='select';ED.drop=false;ED.shape='box';ED.sides=8;ED.terr='holes';ED.trad=192;ED.clip=null;ED.prev=null;ED.exact=false;
let EDDRAG=null,EDHOV=null,_edHovT=0,edClipCtrl=false;
// Move and Resize go in single units unless Grid is on; drawing keeps the grid size
const snapG=()=>((ED.tool==='move'||ED.tool==='resize')&&!GRID.on)?1:gridSize();
const snapV=v=>Math.round(v/snapG())*snapG();
const EDTOOLS=[['select','Select','↖','Click to select; the view and Modify work as usual.'],
  ['draw','Draw brush','▭','Drag on a floor, wall or ceiling to draw the brush\'s outline on it; let go, move the mouse to set its height, click to make it (Esc cancels).'],
  ['resize','Resize','⇕','Drag a face of a brush to pull it out or push it in; drag a corner or an edge (the white crosses) to reshape it; drag a patch\'s control point. Shift+drag: up and down.'],
  ['move','Move','✥','Drag a brush, patch or terrain block to slide it across the floor (a brush in a selection of more: all of them); Shift+click: add to the selection; Shift+drag: up and down; Alt: drag a copy.'],
  ['clip','Clip','✂','Click the brush to cut, then click two points: it is cut along the line between them as you see it (a third click tilts the cut). Enter cuts, Shift+Enter splits it in two, Tab swaps the side kept. Ctrl+click picks another brush.'],
  ['texture','Texture','▦','Click a face to give it the texture in the Texture box (Shift+click: the whole brush); Alt+click takes a texture from the view; Ctrl+click picks a face to fit, turn, flip, shift or scale its texture.'],
  ['terrain','Terrain','▲','Click or drag on terrain: cut or fill single triangles, raise or lower ground, flatten or smooth it.']];
// The selection is only what Modify changes (point entities, path nodes, a .bsp's static
// props, Modify's new entities): the tools that work on brushes, patches and terrain are off,
// as Modify's buttons are while brushes are selected
function edEntOnly(){
  if(typeof MAP==='undefined'||!MAP||!EON())return false;
  if([...selectedPrims()].length)return false;
  const E=[...selectedEnts()].filter(ei=>ei>0&&MAP.ents[ei]),R=(MOD&&MOD.ents)?modSelEnts(false):[];
  if(!E.length&&!R.length)return false;
  return E.every(ei=>!brOk(ei)&&!(ENTS[ei]&&ENTS[ei].hasGeo))&&R.every(m=>!brRow(m));}
const ED_ENT_TOOLS=new Set(['select','draw']);   // the tools still on then
const ED_ENT_OFF='\n\nOff while an entity, path node or static prop is selected: Modify (below) moves, trims and turns it. Select a brush, patch or terrain block (or click an empty spot) to use this.';
function edToolHtml(){
  const off=ED._entOnly=edEntOnly();
  let h='<div class="row" style="gap:3px;flex-wrap:wrap">';
  for(const[k,l,ic,tip]of EDTOOLS){const d=off&&!ED_ENT_TOOLS.has(k);
    h+='<button class="sm'+(ED.tool===k?' on':'')+'" data-edtool="'+k+'"'+(d?' disabled':'')+' title="'+esc(tip+(d?ED_ENT_OFF:''))+'" style="flex:1 1 30%">'+ic+' '+l+'</button>';}
  h+='</div>';
  if(ED.tool==='draw')h+=edRow('shape '+edSel('edShape',[['box','box'],['prism','n-sided prism'],['cyl','cylinder / pipe (curved patch)'],['cone','cone (curved patch)'],['elbow','pipe bend (curved patch)']],ED.shape)+
    (ED.shape==='prism'?' sides '+edSel('edSides',[3,4,5,6,7,8,9,10,12,16].map(n=>[String(n),String(n)]),String(ED.sides)):'')+
    '<label title="Put new brushes and patches in the selected brush entity instead of the world"><input type="checkbox" id="edIntoEnt"'+(ED.into?' checked':'')+'>in entity</label>'+
    '<button class="sm" id="bEdDPlane" title="'+esc('Which plane a new brush\'s outline is drawn on (click for the next):\nDraw any axis: the surface under the mouse, a slope too (the brush stands square on it)\nDraw XY: flat, as a floor\nDraw XZ: upright, facing y, through the point clicked\nDraw YZ: upright, facing x, through the point clicked\nThen the mouse sets its depth.')+'">▭ '+({any:'Draw any axis',xy:'Draw XY',xz:'Draw XZ',yz:'Draw YZ'}[ED.dplane||'any'])+'</button>');
  if(ED.tool==='terrain'){h+=edRow(edSel('edTerrMode',[['holes','cut / fill triangles'],['raise','raise / lower'],['flatten','flatten'],['smooth','smooth'],['paint','paint texture'],['new','draw a new block']],ED.terr)+
    (['raise','flatten','smooth'].indexOf(ED.terr)>=0?' radius '+edSel('edTrad',[64,128,192,256,384,512,768,1024].map(n=>[String(n),String(n)]),String(ED.trad)):'')+
    (ED.terr==='new'?'<label title="Give the new block\'s edges the heights of the terrain round it, and blend its inside between them"><input type="checkbox" id="edTFit" checked>meet the terrain round it</label>':''));}
  if(edTerr())h+=edRow('terrain block '+edBtn('bEdTJoin','Join edges','Give the selected block\'s edges the heights of the neighbouring blocks\' edges, so no gaps or steps show between them')+
      edBtn('bEdTFit','Fit to neighbours','Join the edges, then blend the inside between them (fills a gap smoothly)'));
  if(ED.tool==='texture')h+=edRow('face '+edBtn('bTxFit','Fit','Stretch the texture once across the face')+edBtn('bTxRl','⟲','Turn it 90 degrees')+edBtn('bTxRr','⟳','Turn it -90 degrees')+
    edBtn('bTxFh','↔','Flip it left-right')+edBtn('bTxFv','↕','Flip it up-down')+edBtn('bTxUp','×2','Twice as big')+edBtn('bTxDn','÷2','Half as big'))+
    edRow('shift '+edBtn('bTxSl','←')+edBtn('bTxSr','→')+edBtn('bTxSu','↑')+edBtn('bTxSd','↓')+edBtn('bTxNat','Natural','No shift or turn, scale 0.5 (the editor\'s default)'));
  if(edPatch()&&(ED.tool==='resize'||ED.tool==='select'))h+=edRow('patch '+edBtn('bPRa','+rows','Two more rows of control points (the shape stays the same)')+edBtn('bPRr','−rows')+
    edBtn('bPCa','+cols','Two more columns of control points')+edBtn('bPCr','−cols'))+
    edRow(edBtn('bPCap','Cap ends','Close the open ends of a pipe, cylinder or cone with disc patches')+edBtn('bPThk','Thicken','A copy pushed back this far (facing the other way), with strips joining the open edges')+
      edField('edThick',ED.thick||16,36));
  h+=edRow(edBtn('bEdReg',ED.region?'Region off':'Region: selection',ED.region?'Draw the whole map again':'Draw only what is near the selection (plus the margin), as MOHRadiant\'s Region: easier to work in a crowded spot')+
    (ED.region?'':' margin '+edSel('edRegM',[0,64,128,256,512,1024].map(n=>[String(n),String(n)]),String(ED.regm||256)))+
    (ED.tool==='move'||ED.tool==='resize'?'<button class="sm'+(ED.trim?' on':'')+'" id="bEdTrim"'+(off?' disabled':'')+' title="'+esc((off?'Trim (brushes): Modify\'s Trim origin moves the selected entity.\n\n':'')+(ED.tool==='move'?
      'Trim: W A S D / arrows move the selected brushes along the world axis nearest the way you look, Space / C up and down, one trim step (the slider below, as Modify\'s Trim origin) per key press. Esc or T stops. One Undo for the whole trim.':
      'Trim: W A S D / arrows / Space / C push the face of each selected brush that faces that way out by one trim step (the slider below) per key press (Shift+key pulls it in): a way to stretch a brush too thin to grab a side of (a wire). Esc or T stops. One Undo for the whole trim.'))+'">'+(ED.tool==='move'?'✥':'⇕')+' Trim</button>':''));
  // copies of Modify's trim step and Display's grid, by the tools that use them (they stay
  // one setting: moving either moves both)
  if(ED.tool==='move'||ED.tool==='resize')h+='<div class="row co" style="align-items:center;margin-top:3px">trim step <input type="range" id="edStepC" min="0" max="13" step="1" value="'+MOD.stepI+'" style="flex:1;min-width:0" title="Trim step, 1 to 50 units: each key press while Trim is on moves the selected brushes (✥ Trim) or pushes their faces out (⇕ Trim) by this many units, step by step, as Modify\'s Trim origin moves the selected entity or node. The same setting as Modify\'s trim step"><span id="edStepCV" style="min-width:22px;text-align:right">'+MOD_STEPS[MOD.stepI]+'</span></div>';
  if(['move','resize','draw','clip'].includes(ED.tool))h+='<div class="row co" style="align-items:center;margin-top:3px"><button class="sm" id="edGridPC" style="min-width:66px" title="Which planes the grid draws (click for the next):\nGrid XY: flat, like the floor\nGrid XZ: upright, facing y\nGrid YZ: upright, facing x\nGrid all: the whole 3D lattice\nWhile Grid is on, the selected brushes snap to the grid shown (Modify: the selected entity or node). The same as Display\'s">'+$('bGrid').textContent+'</button>'+
    '<input type="range" id="edGridSzC" min="0" max="9" step="1" value="'+GRID.i+'" style="flex:1;min-width:0" title="Grid size, 1 to 512 units ({ and }): while Grid is on, Move and Resize snap the selected brushes to the grid shown, in steps of this size (Draw brush and Clip always use it), and Modify\'s Add and Move snap the entity or node to it. The same as Display\'s"><span id="edGridVC" style="min-width:30px;text-align:right">'+gridSize()+'</span>'+
    '<button class="sm'+(GRID.on?' on':'')+'" id="edGridOnC" title="The grid on or off (+). On: the selected brushes snap to the grid shown as you Move or Resize them, and Modify\'s selected entity or node as you Add or Move it. Off: they go in single units (Draw brush and Clip still use the grid\'s size). The same as Display\'s Grid">Grid +</button></div>';
  if(ED.tool==='clip'&&ED.clip&&ED.clip.pts.length>=2)
    h+=edRow(edBtn('bEdCut','Clip','Cut the brush and keep the bright side (Enter)')+edBtn('bEdSplit','Split in two','Cut it and keep both halves as two brushes (Shift+Enter)')+
      edBtn('bEdFlipC','Other side','Keep the other side (Tab)')+edBtn('bEdClrC','Start over','Clear the points (Esc)'));
  if(ED.trim&&(ED.tool==='move'||ED.tool==='resize'))h+='<div class="co" id="edTrimHelp" style="margin-top:4px;line-height:1.35;white-space:pre-line">'+esc(edTrimHelp())+'</div>';
  h+='<div class="co" id="edToolHelp" style="margin-top:4px;line-height:1.35">'+esc(edHelp())+'</div>';
  return h;}
// what the keys do while Trim is on (W A S D go along the world axes nearest the way you look),
// a line each
function edTrimHelp(){
  const L=['Trim on:','W / S: forward and back','A / D: left and right (or the arrow keys)','Space / C: up and down'];
  if(ED.tool==='move')L.push('Each key moves the selection that way by Modify\'s trim step.');
  else L.push('Each key pushes the side facing that way out by Modify\'s trim step.',
    'Hold Shift to pull it in instead (Shift+A shortens the left end, Shift+D the right).',
    'A pipe or wire: the keys that point along it make that end longer or shorter.');
  L.push('The camera stays still; Esc or T stops (one Undo for it all).');
  return L.join('\n');}
function edHelp(){
  const t=ED.tool,g=snapG();
  if(ED._entOnly)return'An entity, path node or static prop is selected: Modify (below) moves it (Move, Trim origin), turns it (Yaw, angles) and edits its keys. The tools here work on brushes, patches and terrain: select one (or click an empty spot) to use them.';
  if(t==='select')return'Pick a tool above to build in the view. Grid '+g+'.';
  if(t==='draw')return EDDRAG&&EDDRAG.phase==='height'?'Move the mouse to set the height, then click to make it. Esc cancels.':
    'Drag on '+({any:'a floor, wall, ceiling or slope',xy:'any surface (the outline lies flat, XY)',xz:'any surface (the outline stands upright facing y, XZ)',yz:'any surface (the outline stands upright facing x, YZ)'}[ED.dplane||'any'])+' to draw the '+(ED.shape==='box'?'box':ED.shape==='prism'?ED.sides+'-sided prism':ED.shape==='cyl'?'cylinder':'pipe')+'\'s outline (grid '+g+'), then set its height. It gets the texture below.';
  if(t==='resize')return'Drag a brush\'s face along its own direction, or a corner or edge (white crosses) to reshape it; with a patch selected, drag its control points. Shift: up and down. Grid '+g+'.';
  if(t==='texture')return'Click: the Texture box\'s texture on that face (Shift+click: the whole brush; patches and terrain too). Alt+click: take the texture under the mouse. Ctrl+click: pick a face, then fit, turn, flip, shift or scale its texture below.';
  if(t==='move')return'Drag a brush, patch or terrain block across the floor (grid '+g+'; terrain moves in 64s); press on one that is in a selection of more and they all move. Shift+click: add a brush to the selection or take it out; Shift+drag: up and down. Alt+drag: a copy.';
  if(t==='clip'){const n=ED.clip?ED.clip.pts.length:0;
    if(!edPrim())return'Click the brush to cut (it is selected), then click two points for the cut.';
    return n===0?'Click the first point of the cut (Ctrl+click: another brush).':n===1?'Click the second point: the cut runs along the line between them, as you see it.':
      'Enter: cut (keep the bright part). Shift+Enter: split in two. Tab: keep the other side. Or click a third point to tilt the cut.';}
  if(t==='terrain'){const m=ED.terr;
    if(m==='paint')return'Click a terrain patch (512 x 512) to give it the Texture box\'s texture; Alt+click takes the texture under the mouse.';
    if(m==='new')return'Drag out the area for a new terrain block (whole 512-unit patches, on the 64 grid, at the height clicked). Its edges meet the terrain round it.';
    return m==='holes'?'Click a terrain triangle to cut it away (or fill it back); drag across to do many. The game draws and collides with what is left.':
      m==='raise'?'Press on the terrain and drag up or down to raise or lower it round that spot ('+ED.trad+' units across, smooth at the edges).':
      m==='flatten'?'Click on the terrain: the ground within '+ED.trad+' units takes that spot\'s height.':'Click or drag on the terrain to smooth bumps within '+ED.trad+' units.';}
  return'';}
function edSetTool(t){
  if(ED.drop)edDrop(false);
  if(ED.trim){ED.trim=false;flash('Trim off');}
  if(ED.carry){edCarryEnd();flash('Copy: taken away');}
  EDDRAG=null;ED.prev=null;if(t!=='clip')ED.clip=null;else ED.clip={pts:[],flip:false};
  ED.tool=t;glcv.style.cursor=t==='select'?'':'crosshair';lineDirty=true;requestDraw();edPanel();}
function edToolBind(el){
  el.querySelectorAll('[data-edtool]').forEach(b=>b.onclick=()=>edSetTool(b.getAttribute('data-edtool')));
  const s=$('edShape');if(s)s.onchange=()=>{ED.shape=s.value;edPanel();};
  const n=$('edSides');if(n)n.onchange=()=>{ED.sides=+n.value;edPanel();};
  const ie=$('edIntoEnt');if(ie)ie.onchange=()=>{ED.into=ie.checked;};
  const sc=$('edStepC');if(sc)sc.oninput=()=>{MOD.stepI=+sc.value;$('modStep').value=MOD.stepI;$('modStepV').textContent=MOD_STEPS[MOD.stepI];$('edStepCV').textContent=MOD_STEPS[MOD.stepI];slidersPost();};
  const gp=$('edGridPC');if(gp)gp.onclick=()=>$('bGrid').click();
  const gs=$('edGridSzC');if(gs)gs.oninput=()=>setGridSize(+gs.value);
  const go=$('edGridOnC');if(go)go.onclick=()=>setGrid(!GRID.on);
  const dpl=$('bEdDPlane');if(dpl)dpl.onclick=()=>{const L=['any','xy','xz','yz'];ED.dplane=L[(L.indexOf(ED.dplane||'any')+1)%4];edPanel();};
  const tm=$('edTerrMode');if(tm)tm.onchange=()=>{ED.terr=tm.value;edPanel();};
  const tr=$('edTrad');if(tr)tr.onchange=()=>{ED.trad=+tr.value;edPanel();};
  const on=(id,fn)=>{const b=$(id);if(b)b.onclick=edRun(fn);};
  on('bEdCut',()=>edClipDo(false));on('bEdSplit',()=>edClipDo(true));
  on('bEdTJoin',()=>edTerrFitSel(false));on('bEdTFit',()=>edTerrFitSel(true));
  for(const[id,op]of[['bTxFit','fit'],['bTxRl','rl'],['bTxRr','rr'],['bTxFh','fh'],['bTxFv','fv'],['bTxUp','up2'],['bTxDn','dn2'],['bTxSl','sl'],['bTxSr','sr'],['bTxSu','su'],['bTxSd','sd'],['bTxNat','nat']])on(id,()=>edFaceTex(op));
  on('bPCap',edPatchCap);on('bPThk',()=>{ED.thick=+$('edThick').value||16;edPatchThicken();});
  on('bPRa',()=>edPatchRows('w',true));on('bPRr',()=>edPatchRows('w',false));on('bPCa',()=>edPatchRows('h',true));on('bPCr',()=>edPatchRows('h',false));
  on('bEdReg',()=>{const m=$('edRegM');if(m)ED.regm=+m.value;edRegionSet(!ED.region);});
  on('bEdFlipC',()=>{ED.clip.flip=!ED.clip.flip;edClipPrev();});on('bEdClrC',()=>{ED.clip={pts:[],flip:false};edClipPrev();edPanel();});}

// ---- outlines --------------------------------------------------------------------------------
const C_HOT=()=>{const c=hexRGB(TH.sel);return[c[0],c[1],c[2],1];},C_DIM=[1,1,1,0.5],C_BAD=[1,0.3,0.3,1],C_GOOD=[0.4,1,0.5,1];
function segPush(A,a,b,c){A.push(a[0],a[1],a[2],c[0],c[1],c[2],c[3],b[0],b[1],b[2],c[0],c[1],c[2],c[3]);}
function wEdges(A,w,c){const m=w.length/3;for(let i=0;i<m;i++){const j=(i+1)%m;segPush(A,[w[i*3],w[i*3+1],w[i*3+2]],[w[j*3],w[j*3+1],w[j*3+2]],c);}}
function facesEdges(A,faces,c){const ws=brushWindings(faces.map(planeOf));for(const w of ws)if(w)wEdges(A,w,c);}
function edShow(H,L){ED.prev=(H||L)?{H:H||[],L:L||[]}:null;lineDirty=true;requestDraw();}

// ---- the mouse in the view -------------------------------------------------------------------
function edXY(e){const r=glcv.getBoundingClientRect();return[e.clientX-r.left,e.clientY-r.top];}
function edHit(x,y){return hitInfo(pickAt(x,y),x,y);}
// a terrain pixel whose exact point the pick missed (along its outline): the ray on the terrain,
// or through the pixel's corners
function edHitT(x,y){const h=edHit(x,y),q=edPrimOfHit(h);if(q&&q.kind===2&&!h.point){const g=edTerrHit(x,y);if(g&&g.point)return g;
  for(const[dx,dy]of[[0.5,0.5],[-0.5,-0.5],[0.5,-0.5],[-0.5,0.5]]){const pt=rayTris(cam.pos,screenRay(x+dx,y+dy),SC.faceI0[h.face],SC.faceIN[h.face]);if(pt){h.point=pt;break;}}}return h;}
function edSelectHit(h){SEL.clear();const k=h?keyOfHit(h):null;if(k)SEL.add(k);lastHit=h;selectionChanged();}
function edPrimOfHit(h){
  if(!h||h.face<0)return null;const pi=SC.facePrim[h.face],r=SC.prims[pi];if(!r)return null;
  const pr=MAP.ents[r.ent]&&MAP.ents[r.ent].prims[r.bn];return pr?{pi:pi,ei:r.ent,bn:r.bn,pr:pr,kind:pr.kind,side:SC.faceSide[h.face]}:null;}
// where the mouse ray meets a plane (normal n, n.x = d), or null
function rayPlane(x,y,n,d){const o=cam.pos,r=screenRay(x,y),dn=vdot(n,r);if(Math.abs(dn)<1e-6)return null;const t=(d-vdot(n,o))/dn;if(t<=0)return null;return vadd(o,vscale(r,t));}
// how far along the line P + dir*t the mouse ray passes closest
function rayLineT(x,y,P,dir){const o=cam.pos,r=screenRay(x,y),w=vsub(P,o),a=vdot(dir,dir),b=vdot(dir,r),c=vdot(r,r),d=vdot(dir,w),e=vdot(r,w),den=a*c-b*b;
  if(Math.abs(den)<1e-9)return 0;return(b*e-c*d)/den;}
const AXV=k=>{const v=[0,0,0];v[k]=1;return v;};
// ---- the eyedropper: the next click on a surface puts its texture in the Texture box ---------
const DROPICON='<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10.2 3.3l1.3-1.3a1.8 1.8 0 0 1 2.5 2.5l-1.3 1.3 .8.8-1.2 1.2-4.6-4.6 1.2-1.2z"/><path d="M8.5 5.5 2.8 11.2 2.2 13.8 4.8 13.2 10.5 7.5"/></svg>';
const DROPCUR='url("data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 16 16" fill="white" stroke="black" stroke-width="1.2" stroke-linejoin="round"><path d="M10.2 3.3l1.3-1.3a1.8 1.8 0 0 1 2.5 2.5l-1.3 1.3 .8.8-1.2 1.2-4.6-4.6 1.2-1.2z"/><path d="M8.5 5.5 2.8 11.2 2.2 13.8 4.8 13.2 10.5 7.5z"/></svg>')+'") 2 18, crosshair';
let edDropAt=null;
function edDrop(on){
  ED.drop=!!on;edDropAt=null;
  glcv.style.cursor=ED.drop?DROPCUR:(ED.tool==='select'?'':'crosshair');
  const b=$('bEdDrop');if(b)b.classList.toggle('on',ED.drop);
  if(ED.drop)flash('Eyedropper: click a surface to take its texture (Esc cancels)');}
// the texture of what a click hit: a brush face, a patch, a terrain patch, or any other
// surface the page draws (a .bsp's own draw surfaces); null for a model or an entity
function edTexAt(h){
  if(!h||h.face<0)return null;
  const q=edPrimOfHit(h);
  if(q&&q.kind===0){const f=q.pr.d.faces[q.side];if(f&&f.tex)return f.tex;}
  else if(q&&q.kind===1){if(q.pr.d.tex)return q.pr.d.tex;}
  else if(q&&q.kind===2&&h.point){const t=q.pr.d,nx=(t.W-1)/8,ny=(t.H-1)/8;
    const pi=Math.max(0,Math.min(nx-1,Math.floor((h.point[0]-t.org[0])/512))),pj=Math.max(0,Math.min(ny-1,Math.floor((h.point[1]-t.org[1])/512)));
    const c=t.corners[pj*(nx+1)+pi]||t.corners[0];if(c&&c.tex)return c.tex;}
  const te=TEX[SC.faceTex[h.face]];
  return te&&te.n?te.n.replace(/^textures\//,''):null;}
function edDropTake(h){
  const tx=edTexAt(h);
  if(!tx){flash(h&&h.face<0?'That is a model or an entity: click a brush, patch or terrain surface':'Nothing there: click a surface');return false;}
  const el=$('edTex');if(el)el.value=tx;
  let tile=null;try{tile=edTileAt(h);}catch(_e){}
  if(tile)ED.tileV=tile;
  ED.dropTile=tile?{tx:tx,t:tile}:null;   // the Texture tool and terrain paint lay this tiling with the texture
  edDrop(false);flash('Texture: '+tx+(tile?' (scale '+tile.sc.map(fmt).join(' ')+', rotate '+fmt(tile.rot)+', shift '+tile.sh.map(fmt).join(' ')+')':'')+(edTexPainting()?': click a surface to lay it'+(tile?' with this tiling':''):''));
  // what it took goes on the selection, then the Texture tool is on (terrain paint stays) to lay it
  const put=edTexApplyRun(tx,tile);
  if(!edTexPainting()){edSetTool('texture');
    flash((put?'On the selection, and the ':'The ')+'Texture tool: click a surface to lay '+tx+(tile?' with its tiling':'')+' (Shift+click: every face of a brush)');}
  edPanel();return true;}
// a press on the view while it's on: the camera still turns on a drag; a click (no drag) takes
window.addEventListener('mousedown',e=>{if(ED.drop&&e.button===0&&e.target===glcv)edDropAt=[e.clientX,e.clientY];},true);
window.addEventListener('mouseup',e=>{
  if(!ED.drop||e.button!==0||!edDropAt||!MAP)return;
  const a=edDropAt;edDropAt=null;
  if(Math.abs(e.clientX-a[0])+Math.abs(e.clientY-a[1])>4)return;
  e.stopPropagation();try{drag=null;}catch(_e){}
  const[x,y]=edXY(e);
  try{edDropTake(edHitT(x,y));}catch(err){flash(err.message);}},true);
// ---- selecting a brush entity's brushes one by one (editor on) -----------------------------
// With the editor on, a click picks the brush under the mouse, a door's origin brush apart
// from its door; Shift+click adds or takes away one brush. Every brush of an entity selected
// is that entity for Copy (a new entity). Modify still has the entity's row (its keys, Move
// as a whole), for the entity whose brushes are selected.
function edKeyOfPrim(pi){const r=SC.prims[pi];if(!r)return null;return(r.ent>0&&!isWorldlike(r.ent)&&!EON())?'e'+r.ent:'p'+pi;}
const _keyOfHit=keyOfHit;
keyOfHit=function(h){if(EON()&&h&&h.prim>=0&&SC.prims[h.prim]&&h.ent>0&&MAP.ents[h.ent]&&MAP.ents[h.ent].prims.length)return'p'+h.prim;return _keyOfHit(h);};
const _selFocusEnt=selFocusEnt;
selFocusEnt=function(){const ei=_selFocusEnt();if(ei>=0||!EON()||selectedEnts().size)return ei;
  const S=new Set();for(const pi of selectedPrims()){const r=SC.prims[pi];if(r)S.add(r.ent);}
  if(S.size===1){const e=[...S][0];if(e>0&&!isWorldlike(e))return e;}
  return ei;};
// the changes that move what a carry holds by o (an entity whose every brush moves takes its
// origin key along)
function edMoveOps(C,o){
  const ops=[];
  const put=it=>{const pr=it.pr;ops.push({at:pr.ts,del:D.srcText.slice(pr.ts,pr.te),ins:it.text(o),sel:null});};
  for(const g of C.groups.values())g.forEach(put);
  for(const E of C.ents){E.items.forEach(put);
    const e=MAP.ents[E.ei],first=Math.min(...E.items.map(it=>it.pr.ts)),head=D.srcText.slice(e.ts,first),m=/"origin"\s+"([^"]*)"/i.exec(head);
    if(m){const v=m[1].trim().split(/\s+/).map(Number);if(v.length===3&&v.every(isFinite))
      ops.push({at:e.ts+m.index,del:m[0],ins:'"origin" "'+v.map((x,i)=>fmt(x+o[i])).join(' ')+'"',sel:null});}}
  return ops;}
// Move with the brush pressed already in a selection of more: the whole selection moves
// (Alt+drag: copies of it), an entity whose every brush is in it with its origin key
function edMoveSelDown(h,q,e){
  const inSel=SEL.has('p'+q.pi)||SEL.has('e'+q.ei);if(!inSel)return false;
  let c;try{c=edCopySet();}catch(_e){return false;}
  if(c.pts)return false;
  const C=edCarryBuild(c);if(C.n<2)return false;
  const P0=h.point,vert=e.shiftKey,copy=e.altKey,keep=[...SEL];
  const d={kind:'move',off:[0,0,0]};
  d.move=(mx,my)=>{let o;
    if(vert){o=[0,0,C.terr?0:snapV(rayLineT(mx,my,P0,[0,0,1]))];}
    else{const p=rayPlane(mx,my,[0,0,1],P0[2]);if(!p)return;const sn=C.terr?(v=>Math.round(v/64)*64):snapV;o=[sn(p[0]-P0[0]),sn(p[1]-P0[1]),0];}
    d.off=o;edCarryShow(o,C);flash((copy?'copy ':'move ')+C.n+' by '+o.map(fmt).join(' '));};
  d.up=()=>{EDDRAG=null;edShow();const o=d.off;if(!o[0]&&!o[1]&&!o[2])return;
    if(copy){edCopyDo(C,o);return;}
    edDoMany(edMoveOps(C,o),C.n+' moved '+o.map(fmt).join(' '));
    SEL.clear();for(const k of keep)SEL.add(k);selectionChanged();lineDirty=true;requestDraw();};
  EDDRAG=d;return true;}
// Resize: the face the mouse is over (or the corner / edge it would take) outlined in green
let _edRzT=0,_edRzOn=false,_edRzKey='';
// The green lines take the place of the selection's red (and the mouse-over's) outline on
// that face or edge: those outlines are drawn after every other line, so the edges under
// the green are left out of them while it shows (edRzOutlines), and put back after.
function edRzOutlines(pi,skip){
  if(!gl)return;
  const of=(pis,cut)=>{const edg=[];for(const q of pis){const p=SC.prims[q];if(!p)continue;
    for(let f=p.f0;f<p.f1;f++){if(faceVis&&!faceVis[f])continue;const ea=SC.faceE0[f],ec=SC.faceEN[f];
      for(let k=ea;k+1<ea+ec;k+=2){const a=SC.edge[k],b=SC.edge[k+1];if(cut&&q===pi&&skip(a,b))continue;edg.push(a,b);}}}return edg;};
  const sel=[...selectedPrims()];for(const ei of selectedEnts())sel.push(...primsOfEnt(ei));
  const se=of(sel,true);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,B.selE);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(se.length?se:[0,0]),gl.DYNAMIC_DRAW);selEdgeCount=se.length;
  const hk=setHover.key;
  if(hk&&!SEL.has(hk)&&hovEdgeCount){const hp=hk[0]==='p'?[+hk.slice(1)]:primsOfEnt(+hk.slice(1)),he=of(hp,true);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,B.hovE);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(he.length?he:[0,0]),gl.DYNAMIC_DRAW);hovEdgeCount=he.length;}
  requestDraw();}
function edRzRestore(){try{rebuildSelection();refreshHover();}catch(_e){}}
function edResizeHover(x,y){
  const H=[],G=C_GOOD;let key='',pi=-1,skip=null;
  const P=SC.pos,near=(v,q)=>Math.abs(P[v*3]-q[0])<0.05&&Math.abs(P[v*3+1]-q[1])<0.05&&Math.abs(P[v*3+2]-q[2])<0.05;
  try{const g=edGrabAt(x,y);
    if(g&&(g.kind==='vert'||g.kind==='edge')){
      for(const i of g.ids){const p=g.G.V[i];for(let k=0;k<3;k++){const a=p.slice(),b=p.slice();a[k]-=6;b[k]+=6;segPush(H,a,b,G);}}
      if(g.kind==='edge'){const A=g.G.V[g.ids[0]],B2=g.G.V[g.ids[1]];segPush(H,A,B2,G);
        pi=SC.prims.findIndex(p=>p.ent===ED.sel.ei&&p.bn===ED.sel.bn);
        skip=(a,b)=>(near(a,A)&&near(b,B2))||(near(a,B2)&&near(b,A));}
      key=g.kind+':'+g.ids.join(',');}
    else if(!g){const h=edHit(x,y),q=edPrimOfHit(h);
      if(q&&q.kind===0){const fs=edFaces(q.pr),w=edCheck(fs).ws[q.side],pl=planeOf(fs[q.side]);
        if(w){wEdges(H,w,G);pi=q.pi;key='f:'+q.pi+':'+q.side;
          if(pl)skip=(a,b)=>{const on=v=>Math.abs(P[v*3]*pl[0]+P[v*3+1]*pl[1]+P[v*3+2]*pl[2]-pl[3])<0.05;return on(a)&&on(b);};}}}}catch(_e){}
  key+='|'+setHover.key+'|'+[...SEL].slice(0,32).join(',');
  if(H.length){_edRzOn=true;edShow(H,null);if(key!==_edRzKey){_edRzKey=key;if(skip)edRzOutlines(pi,skip);else edRzRestore();}}
  else if(_edRzOn){_edRzOn=false;_edRzKey='';edShow();edRzRestore();}}
window.addEventListener('mousemove',e=>{
  if(ED.tool!=='resize'||!EON()||!MAP||EDDRAG||ED.carry||ED.drop){if(_edRzOn&&!EDDRAG){_edRzOn=false;_edRzKey='';edRzRestore();}return;}
  if(e.target!==glcv){if(_edRzOn){_edRzOn=false;_edRzKey='';edShow();edRzRestore();}return;}
  const now=performance.now();if(now-_edRzT<50)return;_edRzT=now;
  const[x,y]=edXY(e);edResizeHover(x,y);},true);
// ---- the Dropper and the Texture tool: what the next click takes or paints, in yellow ------
// a brush face (every face of the brush with Shift on the Texture tool), a whole patch, the
// terrain patch (512 units) under the mouse, or a .bsp surface; where the selection's red
// outline runs along it, the yellow takes its place
const C_TXH=[1,0.9,0.15,1];
let _edTxT=0,_edTxOn=false,_edTxKey='',_edTxXY=null,_edTxSC=null,_edTxShift=false,_edTxTo=0;
function edTxActive(){return EON()&&!!MAP&&!!SC&&!EDDRAG&&!ED.carry&&(ED.drop||edTexPainting());}
function edTxOff(){if(_edTxOn){_edTxOn=false;_edTxKey='';edShow();edRzRestore();}}
function edTexHover(x,y,shift){
  const H=[],Y=C_TXH,P=SC.pos;let key='',pi=-1,skip=null;
  const pt=v=>[P[v*3],P[v*3+1],P[v*3+2]];
  try{const terr=!ED.drop&&ED.tool==='terrain',h=terr?edTerrHit(x,y):edHitT(x,y);
    if(h&&h.face>=0){const q=edPrimOfHit(h);
      if(q&&q.kind===0&&!terr){const fs=edFaces(q.pr),c=edCheck(fs);pi=q.pi;
        if(shift&&!ED.drop&&ED.tool==='texture'){for(const w of c.ws)if(w)wEdges(H,w,Y);key='b:'+pi;skip=()=>true;}
        else{const w=c.ws[q.side],pl=planeOf(fs[q.side]);
          if(w){wEdges(H,w,Y);key='f:'+pi+':'+q.side;
            if(pl){const on=v=>Math.abs(P[v*3]*pl[0]+P[v*3+1]*pl[1]+P[v*3+2]*pl[2]-pl[3])<0.05;skip=(a,b)=>on(a)&&on(b);}}}}
      else if(q&&q.kind===1&&!terr){const p=SC.prims[q.pi];pi=q.pi;key='p:'+pi;skip=()=>true;
        for(let f=p.f0;f<p.f1;f++){if(faceVis&&!faceVis[f])continue;const ea=SC.faceE0[f],ec=SC.faceEN[f];
          for(let k=ea;k+1<ea+ec;k+=2)segPush(H,pt(SC.edge[k]),pt(SC.edge[k+1]),Y);}}
      else if(q&&q.kind===2&&h.point){   // the 8 x 8 squares one texture line covers, along the ground
        const t=q.pr.d,W=t.W,Hh=t.H,nbx=Math.max(1,(W-1)>>3),nby=Math.max(1,(Hh-1)>>3),ht=t.heights;
        const bx=Math.max(0,Math.min(nbx-1,Math.floor((h.point[0]-t.org[0])/512))),by=Math.max(0,Math.min(nby-1,Math.floor((h.point[1]-t.org[1])/512)));
        const i0=bx*8,i1=bx===nbx-1?W-1:i0+8,j0=by*8,j1=by===nby-1?Hh-1:j0+8;
        const V=(i,j)=>[t.org[0]+i*64,t.org[1]+j*64,t.org[2]+(ht?ht[j*W+i]||0:0)];
        for(let i=i0;i<i1;i++){segPush(H,V(i,j0),V(i+1,j0),Y);segPush(H,V(i,j1),V(i+1,j1),Y);}
        for(let j=j0;j<j1;j++){segPush(H,V(i0,j),V(i0,j+1),Y);segPush(H,V(i1,j),V(i1,j+1),Y);}
        pi=q.pi;key='t:'+pi+':'+bx+':'+by;
        const x0=t.org[0]+i0*64-0.05,x1=t.org[0]+i1*64+0.05,y0=t.org[1]+j0*64-0.05,y1=t.org[1]+j1*64+0.05;
        const inn=v=>P[v*3]>=x0&&P[v*3]<=x1&&P[v*3+1]>=y0&&P[v*3+1]<=y1;skip=(a,b)=>inn(a)&&inn(b);}
      else if(!q&&ED.drop){const f=h.face,ea=SC.faceE0[f],ec=SC.faceEN[f],vs=new Set();   // a surface of the page's own (a .bsp's)
        for(let k=ea;k+1<ea+ec;k+=2){const a=SC.edge[k],b=SC.edge[k+1];segPush(H,pt(a),pt(b),Y);vs.add(a);vs.add(b);}
        pi=SC.facePrim?SC.facePrim[f]:-1;key='s:'+f;if(pi!=null&&pi>=0)skip=(a,b)=>vs.has(a)&&vs.has(b);}}}catch(_e){H.length=0;}
  if(SC!==_edTxSC){_edTxSC=SC;_edTxKey='';}
  key+='|'+setHover.key+'|'+[...SEL].slice(0,32).join(',');
  if(H.length){_edTxOn=true;edShow(H,null);if(key!==_edTxKey){_edTxKey=key;if(skip&&pi>=0)edRzOutlines(pi,skip);else edRzRestore();}}
  else if(_edTxOn){_edTxOn=false;_edTxKey='';edShow();edRzRestore();}}
// once more where the mouse is: after a click (the map is built again), Shift, or a tool change
function edTxKick(){clearTimeout(_edTxTo);_edTxTo=setTimeout(()=>{
  if(!edTxActive()||!_edTxXY){if(!EDDRAG)edTxOff();return;}_edTxKey='';edTexHover(_edTxXY[0],_edTxXY[1],_edTxShift);},0);}
window.addEventListener('mousemove',e=>{
  if(!edTxActive()){if(!EDDRAG)edTxOff();return;}
  if(e.target!==glcv){_edTxXY=null;edTxOff();return;}
  const[x,y]=edXY(e);_edTxXY=[x,y];_edTxShift=e.shiftKey;
  const now=performance.now();clearTimeout(_edTxTo);
  if(now-_edTxT<50){_edTxTo=setTimeout(()=>{if(edTxActive()&&_edTxXY){_edTxT=performance.now();edTexHover(_edTxXY[0],_edTxXY[1],_edTxShift);}},50);return;}
  _edTxT=now;edTexHover(x,y,e.shiftKey);},true);
window.addEventListener('mouseup',()=>{if(_edTxOn||edTxActive())edTxKick();},true);
for(const ev of['keydown','keyup'])window.addEventListener(ev,e=>{if(e.key==='Shift')_edTxShift=ev==='keydown';if(_edTxOn||edTxActive())edTxKick();},true);
// ---- Copy (Alt+C): the selected brushes, patches, terrain blocks and brush entities again ----
// They follow the mouse (their middle under it, their bottom on the surface it is over, on
// the grid; terrain on its 64-unit steps) until a click puts them down: brushes, patches and
// terrain into the entity each came from, a brush entity as a new entity at the end of the
// map (without targetname or target, as Modify's Copy). One Undo takes them all away.
function edBrushEnt(ei){const e=MAP.ents[ei];return !!e&&ei>0&&ei<MAP.nMap&&!e.scr&&!isWorldlike(ei)&&e.ts>=0&&e.prims.some(Boolean);}
function edCopySet(){
  const byEnt=new Map(),prims=[],ents=[],pts=[];
  for(const pi of selectedPrims()){const r=SC.prims[pi];if(!r||!MAP.ents[r.ent]||!MAP.ents[r.ent].prims[r.bn])continue;
    let L=byEnt.get(r.ent);if(!L){L=[];byEnt.set(r.ent,L);}L.push(pi);}
  // every brush of a brush entity selected: the entity itself (a copy is a new entity)
  for(const[ei,L]of byEnt){if(edBrushEnt(ei)&&L.length>=primsOfEnt(ei).length)ents.push(ei);else prims.push(...L);}
  for(const ei of selectedEnts()){if(edBrushEnt(ei)){if(!ents.includes(ei))ents.push(ei);}else if(ei>0)pts.push(ei);}
  // Modify's row for the entity whose brushes are selected is only its focus
  for(const m of modSelEnts(false)){if(m.ei!=null&&byEnt.has(m.ei))continue;
    if(m.ei!=null&&edBrushEnt(m.ei)){if(!ents.includes(m.ei))ents.push(m.ei);}else if(m.ei==null||!pts.includes(m.ei))pts.push(m);}
  return{prims:prims,ents:ents,pts:pts.length};}
// Modify's Copy button stands for this copy too when brushes are selected
function edCopyBtn(){const b=$('bModDup');if(!b||typeof MAP==='undefined'||!MAP)return;
  if(ED.carry){b.disabled=false;b.classList.add('on');return;}
  const c=edCopySet(),n=c.prims.length+c.ents.length;if(!n)return;
  b.disabled=false;b.classList.remove('on');const t=n+c.pts;b.textContent=t>1?'Copy ('+t+')':'Copy';}
// one primitive as data that can be moved: its bounds, its outline at an offset, its text there
function edCarryItem(pr){const it=edCarryItem0(pr);it.pr=pr;return it;}
function edCarryItem0(pr){
  if(pr.kind===0){const fs=edFaces(pr),b=edBounds(fs);
    return{mn:b.mn,mx:b.mx,
      lines:(H,o,c)=>facesEdges(H,edMoveFaces(fs.map(f=>Object.assign({},f,{p:f.p.slice()})),o,false),c),
      text:o=>edBrushText(edMoveFaces(edFaces(pr),o,ED.lock!==false)),label:'brush'};}
  if(pr.kind===1){const P0=edPatchData(pr),mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<P0.pts.length;i+=5)for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],P0.pts[i+k]);mx[k]=Math.max(mx[k],P0.pts[i+k]);}
    const at=o=>{const P=edPatchData(pr);for(let i=0;i<P.pts.length;i+=5){P.pts[i]+=o[0];P.pts[i+1]+=o[1];P.pts[i+2]+=o[2];}return P;};
    return{mn:mn,mx:mx,lines:(H,o,c)=>edNetEdges(H,at(o),c),text:o=>edPatchText(at(o)),label:'patch'};}
  const T0=edTerrData(pr),X=(T0.W-1)*64,Y=(T0.H-1)*64;let lo=Infinity,hi=-Infinity;for(const v of T0.V){lo=Math.min(lo,v.h);hi=Math.max(hi,v.h);}
  return{mn:[T0.org[0],T0.org[1],T0.org[2]+lo],mx:[T0.org[0]+X,T0.org[1]+Y,T0.org[2]+hi],terr:true,
    lines:(H,o,c)=>{const x0=T0.org[0]+o[0],y0=T0.org[1]+o[1],z=T0.org[2]+o[2]+lo;const A=[x0,y0,z],B=[x0+X,y0,z],C=[x0+X,y0+Y,z],D2=[x0,y0+Y,z];
      segPush(H,A,B,c);segPush(H,B,C,c);segPush(H,C,D2,c);segPush(H,D2,A,c);},
    text:o=>{const T=edTerrData(pr);T.org=[T.org[0]+o[0],T.org[1]+o[1],T.org[2]+o[2]];edTerrCheck(T);return edTerrText(T);},label:'terrain'};}
function edCarryStart(c){
  if(MOD.edit>=0)modEditClose(true);
  if(MOD.trim)modTrim(false);
  if(MOD.placing)modPlaceCancel();
  if(MOD.linking)modLinkCancel();
  if(ED.drop)edDrop(false);
  EDDRAG=null;
  ED.carry=edCarryBuild(c);
  edCopyBtn();
  const n=ED.carry.n,what=n===1?'it':'them',nm=(c.prims.length===1&&!c.ents.length)?'the '+edCarryItem(MAP.ents[SC.prims[c.prims[0]].ent].prims[SC.prims[c.prims[0]].bn]).label:
    (c.ents.length===1&&!c.prims.length)?entName(c.ents[0]):(c.prims.length+c.ents.length)+' (as they are spaced)';
  flash('Copied '+nm+': click on the map to put '+what+' down (Esc or Alt+C takes '+what+' away)'+(c.ents.some(ei=>MAP.ents[ei].kv.some(kv=>/^(targetname|target)$/i.test(kv[0])))?'. Their targetname and target are left out':''));
}
// what a copy or a move takes: brushes by the entity they are in, whole entities, the bounds
function edCarryBuild(c){
  const groups=new Map(),ents=[],mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];let terr=false,n=0;
  const grow=it=>{for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],it.mn[k]);mx[k]=Math.max(mx[k],it.mx[k]);}if(it.terr)terr=true;n++;};
  for(const pi of c.prims){const r=SC.prims[pi],pr=MAP.ents[r.ent].prims[r.bn],it=edCarryItem(pr);grow(it);
    let g=groups.get(r.ent);if(!g){g=[];groups.set(r.ent,g);}g.push(it);}
  for(const ei of c.ents){const e=MAP.ents[ei],its=e.prims.filter(Boolean).map(edCarryItem);its.forEach(grow);ents.push({ei:ei,items:its});}
  if(!n)throw new Error('Nothing to copy: select a brush, patch or terrain block');
  if(!isFinite(mn[0]))throw new Error('the selection has no size to place');
  return{groups:groups,ents:ents,base:[(mn[0]+mx[0])/2,(mn[1]+mx[1])/2,mn[2]],terr:terr,off:null,n:n,ed:ED.n};
}
function edCarryEnd(){if(!ED.carry)return;ED.carry=null;ED.cx=null;edCarryAt=null;edShow();try{edCopyBtn();modRender();}catch(_e){}}
// the offset that puts the copies' middle under the mouse and their bottom on what it is over
function edCarryOff(x,y){
  const C=ED.carry;let p=null;
  if(ED.cx)p=extPoint(ED.cx,x,y);                 // Shift: out from the face along its normal
  else try{const h=edHit(x,y);if(h&&h.face>=0&&h.point)p=h.point;}catch(_e){}
  if(!p)p=rayPlane(x,y,[0,0,1],C.base[2]);if(!p)return null;
  const xy=C.terr?(v=>Math.round(v/64)*64):snapV;
  return[xy(p[0]-C.base[0]),xy(p[1]-C.base[1]),snapV(p[2]-C.base[2])];}
function edCarryShow(o,C0){
  const C=C0||ED.carry,H=[],c=C_HOT();
  for(const g of C.groups.values())for(const it of g)it.lines(H,o,c);
  for(const E of C.ents)for(const it of E.items)it.lines(H,o,c);
  if(ED.cx&&ED.cx.q){const Y=[1,0.9,0.35,1],p=ED.cx.p;segPush(H,p,ED.cx.q,Y);
    for(let k=0;k<3;k++){const a=p.slice(),b=p.slice();a[k]-=6;b[k]+=6;segPush(H,a,b,Y);}}
  edShow(H,null);}
// a list of changes made as one (one Undo, one rebuild): applied from the end of the text back
function edDoMany(ops,what){
  if(ED.crlf==null)ED.crlf=/\r\n/.test(D.srcText.slice(0,20000));
  if(ED.crlf)for(const op of ops)op.ins=op.ins.replace(/\r?\n/g,'\r\n');
  ops.sort((a,b)=>b.at-a.at);
  try{if(MOD.edit>=0)modEditClose(true);}catch(_e){}
  modHist();
  ED.all.length=ED.n;const n0=ED.n;
  try{for(const op of ops){ED.all.push(op);edTextApply(op,false);ED.n++;}}
  catch(err){while(ED.n>n0){ED.n--;edTextApply(ED.all[ED.n],true);}ED.all.length=n0;MOD.undo.pop();throw err;}
  edRebuild(null);
  modChanged(true);
  flash(what);}
function edCarryPlace(o){
  const C=ED.carry;if(!C)return;
  if(C.ed!==ED.n){edCarryEnd();throw new Error('The map changed while copying: copy again');}
  ED.carry=null;ED.cx=null;edCarryAt=null;edShow();
  edCopyDo(C,o);}
// the copies written (one change) and made the selection
function edCopyDo(C,o){
  const ops=[],want=[];
  for(const[ei,g]of C.groups){const e=MAP.ents[ei],end=D.srcText.lastIndexOf('}',e.te-1);
    if(end<e.ts)throw new Error('the entity\'s block can\'t be found in the text');
    let ins='';g.forEach((it,k)=>{ins+='// '+it.label+' '+(e.prims.length+k)+' (Map Editor)\n'+it.text(o)+'\n';want.push({ei:ei,bn:e.prims.length+k});});
    ops.push({at:end,del:'',ins:ins,sel:null});}
  if(C.ents.length){
    let ins=/\n$/.test(D.srcText)?'':'\n';const n0=MAP.nMap;
    C.ents.forEach((E,j)=>{const e=MAP.ents[E.ei];
      ins+='// entity '+(n0+j)+' (Map Editor: a copy of entity '+E.ei+')\n{\n';
      for(const[k,v]of e.kv){if(/^(targetname|target)$/i.test(k))continue;
        let val=String(v);if(/^origin$/i.test(k)){const q=val.trim().split(/\s+/).map(Number);if(q.length===3&&q.every(isFinite))val=q.map((x,i)=>fmt(x+o[i])).join(' ');}
        ins+='"'+k+'" "'+val+'"\n';}
      E.items.forEach((it,k)=>{ins+='// '+it.label+' '+k+'\n'+it.text(o)+'\n';});
      ins+='}\n';want.push({ent:n0+j});});
    ops.push({at:D.srcText.length,del:'',ins:ins,sel:null,ents:C.ents.length});
    if(ED.nText0==null)ED.nText0=MAP.nMap;}
  const n=C.n;
  edDoMany(ops,'Copied '+(n===1?'':n+' ')+'(moved '+o.map(fmt).join(' ')+'): Undo (Alt+Z) takes '+(n===1?'it':'them')+' away');
  // the copies are the selection now
  SEL.clear();lastHit=null;
  for(const w of want){if(w.ent!=null){if(MAP.ents[w.ent])for(const pi of primsOfEnt(w.ent))SEL.add(edKeyOfPrim(pi));continue;}
    const pi=SC.prims.findIndex(p=>p.ent===w.ei&&p.bn===w.bn);if(pi>=0)SEL.add(edKeyOfPrim(pi));}
  selectionChanged();lineDirty=true;requestDraw();}
// entities Copy adds go after the map's last (the static props' too, on a .bsp's page): they
// are not static props, and the level script's entities after them keep their models
const _isStaticProp=isStaticProp;
isStaticProp=function(ei){if(ED.nText0!=null&&ei>=ED.nText0&&ei<MAP.nMap)return false;return _isStaticProp(ei);};
const _scriptEnts=scriptEnts;
scriptEnts=function(){
  const S=D.scr,n=MAP.ents.length;
  if(ED.nText0!=null&&S&&S.ents&&S.base!=null&&S.base!==n&&S.base>=ED.nText0){
    const d=n-S.base,shift=o=>{if(!o||typeof o!=='object')return o;const r={};for(const k of Object.keys(o)){const i=+k;r[(isFinite(i)&&i>=S.base)?i+d:k]=o[k];}return r;};
    if(D.modelOf)D.modelOf=shift(D.modelOf);
    if(D.lit&&D.lit.el&&!Array.isArray(D.lit.el))D.lit.el=shift(D.lit.el);
    S.base=n;}
  return _scriptEnts.apply(this,arguments);};
let edCarryAt=null,edCarryRaf=0,edCarryXY=null;
window.addEventListener('mousedown',e=>{if(ED.carry&&e.button===0&&e.target===glcv)edCarryAt=[e.clientX,e.clientY];},true);
window.addEventListener('mousemove',e=>{
  if(!ED.carry||!MAP)return;edCarryXY=edXY(e);
  if(edCarryRaf)return;
  edCarryRaf=requestAnimationFrame(()=>{edCarryRaf=0;const C=ED.carry;if(!C||!edCarryXY)return;
    try{const o=edCarryOff(edCarryXY[0],edCarryXY[1]);if(o){C.off=o;edCarryShow(o);}}catch(err){console.error(err);}});},true);
window.addEventListener('mouseup',e=>{
  if(!ED.carry||e.button!==0||!edCarryAt||!MAP)return;
  const a=edCarryAt;edCarryAt=null;
  if(Math.abs(e.clientX-a[0])+Math.abs(e.clientY-a[1])>4)return;
  e.stopPropagation();try{drag=null;}catch(_e){}
  const[x,y]=edXY(e);
  try{const o=edCarryOff(x,y);if(!o){flash('Point at the map to put the copy down');return;}edCarryPlace(o);}catch(err){flash(err.message);}},true);
// Shift while carrying a copy: out from the face under the cursor along its normal (as
// Modify's placing: MODX), a yellow line back to the spot; let go: back on the surfaces
function edCarryRedo(){const C=ED.carry;if(!C||!edCarryXY)return;try{const o=edCarryOff(edCarryXY[0],edCarryXY[1]);if(o){C.off=o;edCarryShow(o);}}catch(err){console.error(err);}}
window.addEventListener('keydown',e=>{
  if(e.key!=='Shift'||e.repeat||!ED.carry||ED.cx||!edCarryXY||!MAP)return;
  let h=null;try{h=edHit(edCarryXY[0],edCarryXY[1]);}catch(_e){}
  if(!h||h.face<0||!h.point)return;
  ED.cx={p:h.point.slice(),n:hitNormal(h),t:0,x0:edCarryXY[0],y0:edCarryXY[1]};ED.cx.q=ED.cx.p.slice();
  flash('Shift: the mouse moves the copy out from the face, along its normal (let go of Shift: back on the surfaces)');edCarryRedo();},true);
window.addEventListener('keyup',e=>{if(e.key!=='Shift'||!ED.cx)return;ED.cx=null;edCarryRedo();},true);
window.addEventListener('keydown',e=>{
  if(!ED.carry||e.key!=='Escape')return;
  e.stopPropagation();e.preventDefault();edCarryEnd();flash('Copy: taken away');},true);
window.addEventListener('keydown',e=>{
  if(!ED.drop||e.key!=='Escape')return;
  const tg=e.target&&e.target.tagName;if(tg==='INPUT'||tg==='TEXTAREA'||tg==='SELECT')return;
  e.stopPropagation();e.preventDefault();edDrop(false);flash('Eyedropper: cancelled');},true);
// ---- Angles: turn the selected brushes and patches about their middle -------------------------
// A turn typed in (pitch yaw roll, as an entity's angles) and Turn; or with the mouse:
// Rotate - a circle round the selection, facing the camera: drag inside it to turn it about the
// line you look along (Shift: tumble it, left / right about the screen's up line, up / down
// about its side line); Axes - three rings, the world's X (red), Y (green) and Z (blue): drag
// one to turn about that axis. Whole degrees (Ctrl: 15s). The fields show the turn as it is
// dragged; letting go makes it (one Undo). Points land on 1/1000 of a unit; textures are laid
// anew on the turned faces. An entity turned with all its brushes turns its origin key too.
// Terrain blocks stay as they are (MOHAA's terrain lies square on the grid).
ED.rmode=null;let EDROT=null,edRotHov=-1;
// (the turn maths and the gizmo itself are the page's: m3*, gz*, shared with Modify's Angles)
function edRotPrims(){return edJoinPrims().filter(pi=>{const r=SC.prims[pi],pr=r&&MAP.ents[r.ent].prims[r.bn];return !!pr&&pr.kind<2;});}
let edRotCache=null;
function edRotCenter(){
  const P=edRotPrims();if(!P.length)return null;const key=ED.n+'|'+P.join(',');
  if(edRotCache&&edRotCache.key===key)return edRotCache.C;
  const mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];
  for(const pi of P){const b=edPrimBox(pi);if(!b)continue;for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],b.mn[k]);mx[k]=Math.max(mx[k],b.mx[k]);}}
  const C=mn[0]<=mx[0]?[0,1,2].map(k=>(mn[k]+mx[k])/2):null;edRotCache={key:key,C:C};return C;}
// a brush's or patch's text turned by G about C
function edRotText(pr,G,C){
  const rp=(A,o)=>{const v=m3v(G,[A[o]-C[0],A[o+1]-C[1],A[o+2]-C[2]]);for(let k=0;k<3;k++)A[o+k]=Math.round((C[k]+v[k])*1000)/1000;};
  if(pr.kind===0){const fs=edFaces(pr);for(const f of fs)for(let i=0;i<9;i+=3)rp(f.p,i);
    try{edCheck(fs);}catch(_e){throw new Error('a brush turned that way comes apart: try a rounder angle');}return{faces:fs,text:edBrushText(fs)};}
  const P=edPatchData(pr);for(let o=0;o<P.pts.length;o+=5)rp(P.pts,o);
  edPatchCheck(P);const t=D.srcText.slice(pr.ts,pr.te),q=edPatchParts(t),mx=t.slice(q.m0,q.m1);
  return{patch:P,text:t.slice(0,q.m0)+(edPatchSplice(mx,P)||edPatchMatrix(P))+t.slice(q.m1)};}
function edRotApply(G,what,C0){
  const P=edRotPrims();if(!P.length)throw new Error('Select a brush or a patch to turn (terrain blocks don\'t turn)');
  const C=C0||edRotCenter(),keep=[...SEL],ops=[];
  for(const pi of P){const r=SC.prims[pi],pr=MAP.ents[r.ent].prims[r.bn];ops.push({at:pr.ts,del:D.srcText.slice(pr.ts,pr.te),ins:edRotText(pr,G,C).text,sel:null});}
  // an entity turned with all its brushes: its origin key turns with them
  let c=null;try{c=edCopySet();}catch(_e){}
  if(c)for(const ei of c.ents){const e=MAP.ents[ei],its=primsOfEnt(ei).map(pi=>e.prims[SC.prims[pi].bn]).filter(Boolean);if(!its.length)continue;
    const first=Math.min(...its.map(pr=>pr.ts)),head=D.srcText.slice(e.ts,first),m=/"origin"\s+"([^"]*)"/i.exec(head);
    if(m){const v=m[1].trim().split(/\s+/).map(Number);if(v.length===3&&v.every(isFinite)){const w=m3v(G,vsub(v,C));
      ops.push({at:e.ts+m.index,del:m[0],ins:'"origin" "'+[0,1,2].map(k=>fmt(Math.round((C[k]+w[k])*1000)/1000)).join(' ')+'"',sel:null});}}}
  edDoMany(ops,what);
  SEL.clear();for(const k of keep)SEL.add(k);selectionChanged();lineDirty=true;requestDraw();}
function edAngRead(){const a=['edAngP','edAngY','edAngR'].map(id=>num($(id).value,-1e5,1e5));if(a.some(v=>!isFinite(v)))throw new Error('angles: three numbers, pitch yaw roll');return a;}
function edAngShow(G){const a=m3toAng(G);['edAngP','edAngY','edAngR'].forEach((id,k)=>{const el=$(id);if(el)el.value=fmt(a[k]);});}
function edAngTurn(){const a=edAngRead();if(!a[0]&&!a[1]&&!a[2])throw new Error('type a turn first: pitch yaw roll in degrees');
  edRotApply(m3ang(a),'Turned by pitch '+fmt(a[0])+', yaw '+fmt(a[1])+', roll '+fmt(a[2]));}
function edAngHtml(){
  if(typeof MAP==='undefined'||!MAP||!edRotPrims().length)return'';
  return edLine('Angles',edCap('pitch')+edField('edAngP','0',40)+edCap('yaw')+edField('edAngY','0',40)+edCap('roll')+edField('edAngR','0',40)+
    edBtn('bEdAng','Turn','Turn the selection by these angles about its middle (pitch, yaw, roll in degrees, as an entity\'s angles). One Undo.')+
    '<button class="sm'+(ED.rmode==='rotate'?' on':'')+'" id="bEdRotT" title="'+esc('A circle round the selection, facing you: drag inside it to turn the selection about the line you look along; whole degrees. The angles above show the turn as you drag; letting go makes it.\nShift: tumble it\nCtrl: 15 degrees at a time')+'">⟳ Rotate</button>'+
    '<button class="sm'+(ED.rmode==='axes'?' on':'')+'" id="bEdAxesT" title="'+esc('Three rings round the selection: the world\'s X (red), Y (green) and Z (blue). Drag a ring to turn the selection about that axis. Whole degrees, Ctrl: 15 at a time.')+'">⊕ Axes</button>',
    'A turn for the selected brushes and patches about their middle; Rotate and Axes turn them with the mouse');}
function edRotMode(m){ED.rmode=ED.rmode===m?null:m;edRotHov=-1;if(ED.rmode&&MROT.mode){MROT.mode=null;try{modAngSync();}catch(_e){}}edPanel();requestDraw();
  if(ED.rmode)flash(ED.rmode==='rotate'?'Rotate: drag inside the circle round the selection (Shift: tumble)':'Axes: drag a ring to turn the selection about X, Y or Z');}
function edRotG(){return gzG(edRotCenter());}
function edRingHit(x,y){return gzRingHit(edRotG(),GZ_XYZ,x,y);}
function edRotStart(x,y,e){
  if(!edRotPrims().length)return null;
  return gzStart(edRotG(),ED.rmode==='axes'?'rings':'circle',GZ_XYZ,x,y,e.shiftKey);}
function edRotPreview(st){
  const H=[],col=C_HOT();
  for(const pi of edRotPrims()){const r=SC.prims[pi],pr=MAP.ents[r.ent].prims[r.bn];
    try{const R=edRotText(pr,st.G,st.C);if(R.faces)facesEdges(H,R.faces,col);else edNetEdges(H,R.patch,col);}catch(_e){}}
  edShow(H,null);edAngShow(st.G);const a=m3toAng(st.G);flash('Turn '+st.what+': pitch '+fmt(a[0])+', yaw '+fmt(a[1])+', roll '+fmt(a[2])+' (let go to make it, Esc cancels)');}
// the gizmo, drawn after Modify's lines
function edDrawRot(vp){
  if(!ED.rmode||!gl||typeof MAP==='undefined'||!MAP||!EON())return;
  gzDraw(vp,edRotG(),ED.rmode==='axes'?'rings':'circle',GZ_XYZ,EDROT?EDROT.k:edRotHov,!!EDROT);}
window.addEventListener('mousedown',e=>{
  if(!ED.rmode||e.button!==0||e.target!==glcv||typeof MAP==='undefined'||!MAP||!EON()||ED.drop||ED.carry||EDDRAG)return;
  if(typeof MOD!=='undefined'&&(MOD.placing||MOD.trim))return;
  const[x,y]=edXY(e);let st=null;try{st=edRotStart(x,y,e);}catch(err){flash(err.message);}
  if(!st)return;EDROT=st;e.stopImmediatePropagation();e.preventDefault();requestDraw();},true);
window.addEventListener('mousemove',e=>{
  if(typeof MAP==='undefined'||!MAP||!ED.rmode)return;
  const[x,y]=edXY(e);
  if(EDROT){e.stopImmediatePropagation();const st=EDROT;if(st.raf)return;
    st.raf=requestAnimationFrame(()=>{st.raf=0;if(EDROT!==st)return;try{st.G=st.turn(x,y,e);edRotPreview(st);}catch(err){flash(err.message);}});return;}
  if(ED.rmode==='axes'&&e.target===glcv&&!e.buttons){const k=edRingHit(x,y);if(k!==edRotHov){edRotHov=k;requestDraw();}}},true);
window.addEventListener('mouseup',e=>{
  if(!EDROT||e.button!==0)return;e.stopImmediatePropagation();
  const st=EDROT;EDROT=null;if(st.raf){cancelAnimationFrame(st.raf);st.raf=0;}
  edShow();const a=m3toAng(st.G);
  if(!a[0]&&!a[1]&&!a[2]){edAngShow(M3I);requestDraw();return;}
  try{edRotApply(st.G,'Turned '+st.what+': pitch '+fmt(a[0])+', yaw '+fmt(a[1])+', roll '+fmt(a[2]),st.C);}catch(err){flash(err.message);}
  requestDraw();},true);
window.addEventListener('keydown',e=>{
  if(!EDROT||e.key!=='Escape')return;e.stopImmediatePropagation();e.preventDefault();
  const st=EDROT;EDROT=null;if(st.raf)cancelAnimationFrame(st.raf);edShow();edAngShow(M3I);flash('Turn cancelled');requestDraw();},true);
window.addEventListener('mousedown',e=>{
  if(ED.drop||ED.carry||!EON()||ED.tool==='select'||e.target!==glcv||!MAP)return;
  if(typeof MOD!=='undefined'&&(MOD.placing||MOD.trim))return;     // Modify is placing or trimming: the click is its
  if(e.button===2&&EDDRAG){e.stopPropagation();e.preventDefault();EDDRAG=null;edShow();edPanel();return;}
  if(e.button!==0)return;
  const[x,y]=edXY(e);
  let took=false;
  try{
    if(ED.tool==='draw')took=edDrawDown(x,y);
    else if(ED.tool==='resize')took=edGrabDown(x,y,e)||edResizeDown(x,y);
    else if(ED.tool==='texture')took=edPaintDown(x,y,e);
    else if(ED.tool==='move')took=edMoveDown(x,y,e);
    else if(ED.tool==='clip'){edClipCtrl=e.ctrlKey||e.metaKey;took=edClipDown(x,y);}
    else if(ED.tool==='terrain')took=ED.terr==='new'?edTerrNewDown(x,y):ED.terr==='paint'?edPaintDown(x,y,e,true):edTerrDown(x,y,e);
  }catch(err){flash(err.message);EDDRAG=null;edShow();took=true;}
  if(took){e.stopPropagation();e.preventDefault();}},true);
window.addEventListener('mousemove',e=>{
  if(ED.carry||!EON()||ED.tool==='select'||!MAP)return;
  const[x,y]=edXY(e);
  if(EDDRAG){e.stopPropagation();
    if(!EDDRAG.raf)EDDRAG.raf=requestAnimationFrame(()=>{const d=EDDRAG;if(!d)return;d.raf=0;try{d.move(x,y,e);}catch(err){flash(err.message);}});return;}
  // terrain: the brush's circle where the mouse is
  if(ED.tool==='terrain'&&ED.terr!=='holes'&&e.target===glcv){const now=performance.now();if(now-_edHovT<60)return;_edHovT=now;
    const h=edTerrHit(x,y),q=edPrimOfHit(h);
    if(q&&q.kind===2&&h.point){const L=[];edCircle(L,h.point,ED.trad,C_HOT());edShow(null,L);}else if(ED.prev)edShow();}},true);
window.addEventListener('mouseup',e=>{
  if(!EDDRAG||e.button!==0)return;e.stopPropagation();
  const d=EDDRAG;if(d.raf){cancelAnimationFrame(d.raf);d.raf=0;}
  const[x,y]=edXY(e);
  try{if(d.up)d.up(x,y,e);}catch(err){flash(err.message);EDDRAG=null;edShow();}},true);
window.addEventListener('keydown',e=>{
  if(!EON()||ED.tool==='select'||!MAP)return;
  const tg=e.target&&e.target.tagName;if(tg==='INPUT'||tg==='TEXTAREA'||tg==='SELECT')return;
  if(e.key==='Escape'&&(EDDRAG||(ED.clip&&ED.clip.pts.length))){e.stopPropagation();e.preventDefault();EDDRAG=null;if(ED.clip)ED.clip={pts:[],flip:false};edShow();edPanel();return;}
  if(ED.tool==='clip'&&ED.clip&&ED.clip.pts.length>=2){
    if(e.key==='Enter'){e.stopPropagation();e.preventDefault();edRun(()=>edClipDo(e.shiftKey))();return;}
    if(e.key==='Tab'){e.stopPropagation();e.preventDefault();ED.clip.flip=!ED.clip.flip;edClipPrev();return;}}},true);

// ---- Draw: an outline on a surface, then a height --------------------------------------------
function edDrawDown(x,y){
  if(EDDRAG&&EDDRAG.phase==='height'){edDrawMake();return true;}
  const h=edHit(x,y),fixed={xy:2,xz:1,yz:0}[ED.dplane||'any'];let ax=2,n=[0,0,1],c,P=null,pl=null;
  if(h&&h.point){P=h.point;const q=edPrimOfHit(h);if(q&&q.kind===0)pl=SC.facePlane[h.face]||null;}
  // Draw any axis on a slope: the outline lies on the slope, the brush stands square on it
  if(fixed==null&&P&&pl&&Math.max(Math.abs(pl[0]),Math.abs(pl[1]),Math.abs(pl[2]))<0.999)return edDrawSlope(x,y,P,pl);
  if(fixed!=null){ax=fixed;
    if(P)c=Math.round(P[ax]);
    else if(ax===2)c=ED.lastZ!=null?ED.lastZ:snapV(cam.pos[2]-128);
    else c=snapV(cam.pos[ax]+camAxes().f[ax]*256);
    // the depth goes out of the surface clicked, else toward the camera
    const sg=pl&&Math.abs(pl[ax])>0.1?Math.sign(pl[ax]):(Math.sign(cam.pos[ax]-c)||1);n=vscale(AXV(ax),sg);}
  else if(P){if(pl){ax=[0,1,2].reduce((a,k)=>Math.abs(pl[k])>Math.abs(pl[a])?k:a,0);n=AXV(ax);if(pl[ax]<0)n=vscale(n,-1);}
    c=Math.round(P[ax]);}
  else c=ED.lastZ!=null?ED.lastZ:snapV(cam.pos[2]-128);
  const s=n[ax]<0?-1:1,pn=AXV(ax);
  const at=(px,py)=>{const q=rayPlane(px,py,pn,c);if(!q)return null;const o=q.slice();for(let k=0;k<3;k++)if(k!==ax)o[k]=snapV(o[k]);o[ax]=c;return o;};
  const a=at(x,y);if(!a)return false;
  const d={kind:'draw',phase:'rect',ax:ax,c:c,s:s,a:a,b:a.slice(),depth:0};
  d.move=(mx,my)=>{
    if(d.phase==='rect'){const b=at(mx,my);if(b)d.b=b;}
    else{const t=rayLineT(mx,my,d.mid,AXV(ax));let v=snapV(t);if(!v)v=snapG()*s;d.depth=v;}
    edDrawPrev();};
  d.up=()=>{
    if(d.phase!=='rect')return;
    const u=(ax+1)%3,w=(ax+2)%3;
    if(Math.abs(d.b[u]-d.a[u])<snapG()||Math.abs(d.b[w]-d.a[w])<snapG()){EDDRAG=null;edShow();flash('Drag out an outline at least one grid square ('+snapG()+') each way');return;}
    d.phase='height';d.depth=Math.max(8,snapG())*s;d.mid=[0,1,2].map(k=>(d.a[k]+d.b[k])/2);
    $('edToolHelp')&&($('edToolHelp').textContent=edHelp());edDrawPrev();};
  EDDRAG=d;ED.lastZ=ax===2?c:ED.lastZ;edDrawPrev();return true;}
// a sloped face: the outline in the face's own frame (u along the slope's level line, w up it,
// n out of it), from the point clicked, on the grid in that frame; the depth along n
const edSlopeW=(S,l)=>[0,1,2].map(k=>Math.round((S.O[k]+S.u[k]*l[0]+S.w[k]*l[1]+S.n[k]*l[2])*1000)/1000);
function edDrawSlope(x,y,P,pl){
  const n=vnorm(pl.slice(0,3)),u=vnorm(vcross([0,0,1],n))||[1,0,0],w=vcross(n,u),O=P.map(v=>Math.round(v*1000)/1000),dn=vdot(n,O);
  const S={O:O,u:u,w:w,n:n};
  const loc=(px,py)=>{const q=rayPlane(px,py,n,dn);if(!q)return null;const r=vsub(q,O);return[snapV(vdot(r,u)),snapV(vdot(r,w))];};
  const d={kind:'draw',phase:'rect',slope:S,a:[0,0],b:[0,0],depth:0};
  d.move=(mx,my)=>{
    if(d.phase==='rect'){const b=loc(mx,my);if(b)d.b=b;}
    else{const t=rayLineT(mx,my,d.mid,n);let v=snapV(t);if(!v)v=snapG();d.depth=v;}
    edDrawPrev();};
  d.up=()=>{
    if(d.phase!=='rect')return;
    if(Math.abs(d.b[0]-d.a[0])<snapG()||Math.abs(d.b[1]-d.a[1])<snapG()){EDDRAG=null;edShow();flash('Drag out an outline at least one grid square ('+snapG()+') each way');return;}
    d.phase='height';d.depth=Math.max(8,snapG());d.mid=edSlopeW(S,[(d.a[0]+d.b[0])/2,(d.a[1]+d.b[1])/2,0]);
    $('edToolHelp')&&($('edToolHelp').textContent=edHelp());edDrawPrev();};
  EDDRAG=d;edDrawPrev();return true;}
function edDrawBox(){
  const d=EDDRAG,mn=[0,0,0],mx=[0,0,0];
  if(d.slope)return{mn:[Math.min(d.a[0],d.b[0]),Math.min(d.a[1],d.b[1]),Math.min(0,d.depth)],mx:[Math.max(d.a[0],d.b[0]),Math.max(d.a[1],d.b[1]),Math.max(0,d.depth)]};
  for(let k=0;k<3;k++){if(k===d.ax){const o=d.c+d.depth;mn[k]=Math.min(d.c,o);mx[k]=Math.max(d.c,o);}else{mn[k]=Math.min(d.a[k],d.b[k]);mx[k]=Math.max(d.a[k],d.b[k]);}}
  return{mn:mn,mx:mx};}
// the shape being drawn: brush faces or a patch, turned into the slope's frame on a slope
function edDrawShape(){
  const d=EDDRAG,b=edDrawBox();
  if(!d.slope)return{f:edShapeFaces(b.mn,b.mx,d.ax),b:b};
  const f=edShapeFaces(b.mn,b.mx,2),S=d.slope;
  if(f.faces)for(const F of f.faces)for(let i=0;i<9;i+=3){const q=edSlopeW(S,F.p.slice(i,i+3));F.p[i]=q[0];F.p[i+1]=q[1];F.p[i+2]=q[2];}
  else for(let o=0;o<f.patch.pts.length;o+=5){const q=edSlopeW(S,f.patch.pts.slice(o,o+3));f.patch.pts[o]=q[0];f.patch.pts[o+1]=q[1];f.patch.pts[o+2]=q[2];}
  return{f:f,b:b};}
function edDrawPrev(){
  const d=EDDRAG;if(!d)return;const H=[],col=C_HOT();
  if(d.slope){
    if(d.phase==='rect'){const S=d.slope,p=(a,b)=>edSlopeW(S,[a,b,0]),A=p(d.a[0],d.a[1]),B=p(d.b[0],d.a[1]),C2=p(d.b[0],d.b[1]),D2=p(d.a[0],d.b[1]);
      segPush(H,A,B,col);segPush(H,B,C2,col);segPush(H,C2,D2,col);segPush(H,D2,A,col);flash(Math.abs(d.b[0]-d.a[0])+' x '+Math.abs(d.b[1]-d.a[1])+' on the slope');}
    else{const R=edDrawShape(),b=R.b;try{if(R.f.faces)facesEdges(H,R.f.faces,col);else edNetEdges(H,R.f.patch,col);}catch(_e){}
      flash((b.mx[0]-b.mn[0])+' x '+(b.mx[1]-b.mn[1])+' x '+(b.mx[2]-b.mn[2])+' on the slope  (click to make it)');}
    edShow(H,null);return;}
  if(d.phase==='rect'){const u=(d.ax+1)%3,w=(d.ax+2)%3,p=(cu,cw)=>{const q=d.a.slice();q[u]=cu;q[w]=cw;return q;};
    const A=p(d.a[u],d.a[w]),B=p(d.b[u],d.a[w]),C=p(d.b[u],d.b[w]),D2=p(d.a[u],d.b[w]);segPush(H,A,B,col);segPush(H,B,C,col);segPush(H,C,D2,col);segPush(H,D2,A,col);
    flash(Math.abs(d.b[u]-d.a[u])+' x '+Math.abs(d.b[w]-d.a[w]));}
  else{const b=edDrawBox();
    try{const f=edShapeFaces(b.mn,b.mx,d.ax);if(f.faces)facesEdges(H,f.faces,col);else edNetEdges(H,f.patch,col);}catch(_e){}
    flash((b.mx[0]-b.mn[0])+' x '+(b.mx[1]-b.mn[1])+' x '+(b.mx[2]-b.mn[2])+'  (click to make it)');}
  edShow(H,null);}
// the shape in the box: brush faces, or a patch for the curved ones
function edShapeFaces(mn,mx,ax){
  const tex=edTexOk(($('edTex')&&$('edTex').value||'').trim()||'common/caulk');
  if(ED.shape==='box')return{faces:edBoxFaces(mn,mx,tex)};
  if(ED.shape==='prism')return{faces:edPrismFaces(mn,mx,ax,ED.sides,tex)};
  // the curved shapes are built standing on z, then turned so they stand on the face they were
  // drawn on (a cyclic swap of the axes keeps the patch facing outward)
  const u=(ax+1)%3,w=(ax+2)%3,lmn=[mn[u],mn[w],mn[ax]],sz=[mx[u]-mn[u],mx[w]-mn[w],mx[ax]-mn[ax]];
  const P=ED.shape==='cone'?edPatchCone(lmn,sz,tex):ED.shape==='elbow'?edPatchElbow(lmn,sz,tex):edPatchShape('cyl',lmn,sz,tex);
  if(ax!==2)for(let o=0;o<P.pts.length;o+=5){const x=P.pts[o],y=P.pts[o+1],z=P.pts[o+2];P.pts[o+u]=x;P.pts[o+w]=y;P.pts[o+ax]=z;}
  return{patch:P};}
function edNetEdges(A,P,c){const at=(j,i)=>{const o=(j*P.h+i)*5;return[P.pts[o],P.pts[o+1],P.pts[o+2]];};
  for(let j=0;j<P.w;j++)for(let i=0;i<P.h;i++){if(j+1<P.w)segPush(A,at(j,i),at(j+1,i),c);if(i+1<P.h)segPush(A,at(j,i),at(j,i+1),c);}}
// an n-sided prism standing on axis ax, its sides round the ellipse in the box (corners on
// whole units), its ends the box's two faces on that axis
function edPrismFaces(mn,mx,ax,n,tex){
  const u=(ax+1)%3,w=(ax+2)%3,cu=(mn[u]+mx[u])/2,cw=(mn[w]+mx[w])/2,ru=(mx[u]-mn[u])/2,rw=(mx[w]-mn[w])/2;
  const off=n===4?Math.PI/4:Math.PI/2+Math.PI/n;
  const V=[];for(let k=0;k<n;k++){const a=off+2*Math.PI*k/n;V.push([Math.round(cu+ru*Math.cos(a)),Math.round(cw+rw*Math.sin(a))]);}
  const box=edBoxFaces(mn,mx,tex),out=[box[ax*2],box[ax*2+1]];
  const pt=(uv,h)=>{const q=[0,0,0];q[ax]=h;q[u]=uv[0];q[w]=uv[1];return q;};
  for(let k=0;k<n;k++){const A=V[k],B=V[(k+1)%n];if(A[0]===B[0]&&A[1]===B[1])continue;
    let P=[pt(B,mn[ax]),pt(A,mn[ax]),pt(A,mx[ax])];
    const nn=vcross(vsub(P[0],P[1]),vsub(P[2],P[1])),mid=[(A[0]+B[0])/2-cu,(A[1]+B[1])/2-cw];
    if(nn[u]*mid[0]+nn[w]*mid[1]<0)P=[P[2],P[1],P[0]];
    out.push({p:[].concat(P[0],P[1],P[2]),tex:tex,sh:[0,0],rot:0,sc:[0.5,0.5],cont:0,flags:0,val:0,extra:'',tm:null});}
  return out;}
function edDrawMake(){
  const d=EDDRAG,R=edDrawShape(),b=R.b,f=R.f;EDDRAG=null;edShow();
  const sz=[0,1,2].map(k=>b.mx[k]-b.mn[k]),at=d.slope?edSlopeW(d.slope,b.mn):b.mn;
  const ent=ED.sel&&ED.sel.ei>0&&!isWorldlike(ED.sel.ei)&&ED.into?ED.sel.ei:0;
  if(f.faces)edAddBrush(ent,f.faces,'New '+(ED.shape==='box'?'brush':ED.sides+'-sided brush')+' '+sz.map(fmt).join(' x ')+(d.slope?' on the slope':'')+' at '+at.map(fmt).join(' '));
  else{edPatchCheck(f.patch);edAddBlock(ent,edPatchText(f.patch),'patch','New '+({cyl:'cylinder',cone:'cone',elbow:'pipe bend'}[ED.shape]||'patch')+' '+sz.map(fmt).join(' x '));}}

// ---- Resize: pull one face of a brush ---------------------------------------------------------
function edResizeDown(x,y){
  const h=edHit(x,y),q=edPrimOfHit(h);if(!q)return false;
  edSelectHit(h);
  if(q.kind!==0){flash('Resize pulls brush faces. A patch: drag its control points, or ⇕ Trim makes a pipe or wire longer or shorter; a terrain block: Terrain or Exact values');return true;}
  const faces=edFaces(q.pr),k=q.side,pl=planeOf(faces[k]);if(!pl)return true;
  const n=pl.slice(0,3),P0=h.point||[0,0,0];
  const d={kind:'face',k:k,n:n,P0:P0,faces:faces,dist:0,ok:true};
  const make=v=>{const fs=edFaces(q.pr);for(let i=0;i<9;i++)fs[k].p[i]+=n[i%3]*v;return fs;};
  d.move=(mx,my)=>{const t=rayLineT(mx,my,P0,n);d.dist=snapV(t);d.out=make(d.dist);let ok=true;try{edCheck(d.out);}catch(_e){ok=false;}d.ok=ok;
    const H=[];facesEdges(H,ok?d.out:faces,ok?C_HOT():C_BAD);edShow(H,null);flash(ok?'face '+(d.dist>=0?'out ':'in ')+Math.abs(d.dist):'that would turn the brush inside out');};
  d.up=()=>{EDDRAG=null;edShow();if(!d.dist||!d.ok)return;edSetFaces(d.out,'Face '+(k+1)+(d.dist>0?' pulled out ':' pushed in ')+fmt(Math.abs(d.dist)));};
  EDDRAG=d;return true;}

// ---- Move: slide a brush, patch or terrain block ----------------------------------------------
// Move with Shift: a click (no drag) adds the brush to the selection or takes it out, as
// with Select; a Shift+drag still moves up and down
function edMoveDown(x,y,e){
  if(!e.shiftKey)return edMoveDown0(x,y,e);
  const h=edHit(x,y),q=edPrimOfHit(h);if(!q||!h.point)return false;
  const k=keyOfHit(h),d={kind:'shiftpick',inner:null};
  d.move=(mx,my,ev)=>{
    if(!d.inner){if(Math.abs(mx-x)+Math.abs(my-y)<5)return;
      EDDRAG=null;edMoveDown0(x,y,{shiftKey:true,altKey:e.altKey,ctrlKey:false,metaKey:false});d.inner=EDDRAG;EDDRAG=d;if(!d.inner)return;}
    d.inner.move(mx,my,ev);};
  d.up=(mx,my,ev)=>{
    if(d.inner){EDDRAG=d.inner;return d.inner.up(mx,my,ev);}
    EDDRAG=null;if(!k)return;
    if(SEL.has(k))SEL.delete(k);else SEL.add(k);
    lastHit=h;selectionChanged();};
  EDDRAG=d;return true;}
function edMoveDown0(x,y,e){
  const h=edHit(x,y),q=edPrimOfHit(h);if(!q||!h.point)return false;
  if(edMoveSelDown(h,q,e))return true;
  edSelectHit(h);
  const P0=h.point,vert=e.shiftKey,copy=e.altKey,step=q.kind===2?64:0;
  const d={kind:'move',q:q,off:[0,0,0]};
  const base=q.kind===0?edFaces(q.pr):q.kind===1?edPatchData(q.pr):null;
  d.move=(mx,my)=>{
    let o;
    if(vert){o=[0,0,snapV(rayLineT(mx,my,P0,[0,0,1]))];if(step)o[2]=0;}
    else{const p=rayPlane(mx,my,[0,0,1],P0[2]);if(!p)return;const sn=step?(v=>Math.round(v/64)*64):snapV;o=[sn(p[0]-P0[0]),sn(p[1]-P0[1]),0];}
    d.off=o;const H=[],c=C_HOT();
    if(q.kind===0)facesEdges(H,edMoveFaces(edFaces(q.pr),o,false),c);
    else if(q.kind===1){const P=edPatchData(q.pr);for(let i=0;i<P.pts.length;i+=5){P.pts[i]+=o[0];P.pts[i+1]+=o[1];P.pts[i+2]+=o[2];}edNetEdges(H,P,c);}
    else{const t=q.pr.d,x0=t.org[0]+o[0],y0=t.org[1]+o[1],z=t.org[2],X=(t.W-1)*64,Y=(t.H-1)*64;
      const A=[x0,y0,z],B=[x0+X,y0,z],C=[x0+X,y0+Y,z],D2=[x0,y0+Y,z];segPush(H,A,B,c);segPush(H,B,C,c);segPush(H,C,D2,c);segPush(H,D2,A,c);}
    edShow(H,null);flash((copy?'copy ':'move ')+o.map(fmt).join(' '));};
  d.up=()=>{EDDRAG=null;edShow();const o=d.off;if(!o[0]&&!o[1]&&!o[2])return;
    if(q.kind===0){const fs=edMoveFaces(edFaces(q.pr),o,ED.lock!==false);
      if(copy)edAddBrush(q.ei,fs,'Brush copied, moved '+o.map(fmt).join(' '));else edSetFaces(fs,'Brush moved '+o.map(fmt).join(' '));}
    else if(q.kind===1){const P=edPatchData(q.pr);for(let i=0;i<P.pts.length;i+=5){P.pts[i]+=o[0];P.pts[i+1]+=o[1];P.pts[i+2]+=o[2];}
      if(copy)edAddBlock(q.ei,edPatchText(P),'patch','Patch copied, moved '+o.map(fmt).join(' '));else edSetPatch(P,'Patch moved '+o.map(fmt).join(' '));}
    else{const T=edTerrData(q.pr);T.org=[T.org[0]+o[0],T.org[1]+o[1],T.org[2]];
      if(copy){edTerrCheck(T);const t=edTerrText(T);edAddBlock(q.ei,t,'terrain','Terrain copied, moved '+o.map(fmt).join(' '));}
      else edSetTerr(T,'Terrain moved '+o.map(fmt).join(' '));}};
  EDDRAG=d;return true;}

// ---- Clip: two (or three) points, then cut ----------------------------------------------------
function edClipDown(x,y){
  const h=edHit(x,y);
  const pr=edPrim(),q=edPrimOfHit(h);
  // no brush yet (or Ctrl+click): the click picks the brush to cut; after that every click
  // is a point of the cut, wherever it lands
  if(!pr||(edClipCtrl&&q)){if(!q)return false;edSelectHit(h);ED.clip={pts:[],flip:false};edClipPrev();edPanel();return true;}
  if(!h||!h.point)return true;
  const p=h.point.map(snapV);
  if(ED.clip.pts.length>=3)ED.clip.pts=[];
  ED.clip.pts.push(p);ED.clip.eye=cam.pos.map(v=>Math.round(v));
  edClipPrev();edPanel();return true;}
// the cutting face: through the points, keeping the side the flip says
function edClipFace(){
  const c=ED.clip,P=c.pts;if(!P||P.length<2)return null;
  // two points: the cut runs through them and the eye, so it follows the line drawn on the
  // screen however far away each point landed; a third point sets its tilt instead
  const a=P[0],b=P[1],k=P.length>2?P[2]:c.eye;
  let pts=[a,b,k];
  const n=vcross(vsub(pts[0],pts[1]),vsub(pts[2],pts[1]));if(Math.hypot(n[0],n[1],n[2])<1e-6)return null;
  if(c.flip)pts=[k,b,a];
  return{p:[].concat(pts[0],pts[1],pts[2]),tex:edTexOk(($('edTex')&&$('edTex').value||'').trim()||'common/caulk'),sh:[0,0],rot:0,sc:[0.5,0.5],cont:0,flags:0,val:0,extra:'',tm:null};}
function edFlipFace(f){const g=Object.assign({},f);g.p=f.p.slice(6,9).concat(f.p.slice(3,6),f.p.slice(0,3));return g;}
function edClipHalves(){
  const pr=edPrim(),nf=edClipFace();if(!pr||!nf)return null;const faces=edFaces(pr);
  let keep=null,other=null;try{keep=edPrune(faces.concat([nf]));}catch(_e){}try{other=edPrune(edFaces(pr).concat([edFlipFace(nf)]));}catch(_e){}
  return{keep:keep,other:other,nf:nf};}
function edClipPrev(){
  const H=[],L=[],c=C_HOT();
  for(const p of(ED.clip&&ED.clip.pts)||[]){for(let k=0;k<3;k++){const a=p.slice(),b=p.slice();a[k]-=8;b[k]+=8;segPush(H,a,b,C_GOOD);}}
  const hv=edClipHalves();
  if(hv){if(hv.keep)facesEdges(H,hv.keep,c);if(hv.other)facesEdges(L,hv.other,C_DIM);
    if(ED.clip.pts.length>=2)flash(hv.keep&&hv.other?'Enter: cut (keep the bright part) - Shift+Enter: split - Tab: other side':'the cut misses the brush: move a point');}
  edShow(H,L);}
function edClipDo(split){
  const hv=edClipHalves();if(!hv)throw new Error('click two points on the brush first');
  if(!hv.keep||!hv.other)throw new Error('the cut doesn\'t cross the brush: one side would be all of it');
  const pr=edPrim(),del=D.srcText.slice(pr.ts,pr.te);
  ED.clip={pts:[],flip:false};edShow();
  if(!split){edSetFaces(hv.keep,'Brush clipped ('+hv.keep.length+' faces)');return;}
  edDo(pr.ts,del,edBrushText(hv.keep)+'\n'+edBrushText(hv.other),{ei:ED.sel.ei,bn:ED.sel.bn},'Brush split in two');}

// ---- Terrain: triangles, heights -------------------------------------------------------------
function edCircle(A,c,r,col){let prev=null;for(let k=0;k<=40;k++){const a=k/40*Math.PI*2,p=[c[0]+Math.cos(a)*r,c[1]+Math.sin(a)*r,c[2]+2];if(prev)segPush(A,prev,p,col);prev=p;}}
function tVert(t,i,j){return[t.org[0]+i*TER_STEP,t.org[1]+j*TER_STEP,t.org[2]+t.heights[j*t.W+i]];}
// the triangle under a point: square (i, j) and which of its two (0 = the +x one)
function tTriAt(t,p){
  const fx=(p[0]-t.org[0])/TER_STEP,fy=(p[1]-t.org[1])/TER_STEP;
  const i=Math.max(0,Math.min(t.W-2,Math.floor(fx))),j=Math.max(0,Math.min(t.H-2,Math.floor(fy)));
  const tr=terrainTris(i,j),inT=(a,b,c)=>{const s=(p1,p2,p3)=>(p1[0]-p3[0])*(p2[1]-p3[1])-(p2[0]-p3[0])*(p1[1]-p3[1]),q=[fx,fy];
    const d1=s(q,a,b),d2=s(q,b,c),d3=s(q,c,a);return!((d1<0||d2<0||d3<0)&&(d1>0||d2>0||d3>0));};
  return{i:i,j:j,g:inT(tr[0],tr[1],tr[2])?0:1};}
function tTriEdges(A,t,tt,col){const tr=terrainTris(tt.i,tt.j).slice(tt.g*3,tt.g*3+3).map(v=>tVert(t,v[0],v[1]).map((x,k)=>k===2?x+1:x));
  segPush(A,tr[0],tr[1],col);segPush(A,tr[1],tr[2],col);segPush(A,tr[2],tr[0],col);}
function tIsHole(t,tt){const k=tt.j*t.W+tt.i;return!!(tt.g?t.hole2[k]:t.hole1[k]);}
// the terrain under the mouse, even behind clip or other editor brushes drawn in front
function edTerrHit(x,y){
  let h=edHit(x,y),q=edPrimOfHit(h);if(q&&q.kind===2&&h.point)return h;
  const o=cam.pos,r=screenRay(x,y);let best=null,bd=Infinity;
  for(let f=0;f<SC.nf;f++){const pi=SC.facePrim[f],pr=SC.prims[pi];if(!pr||pr.kind!==2)continue;
    const pt=rayTris(o,r,SC.faceI0[f],SC.faceIN[f]);if(!pt)continue;const dv=vsub(pt,o),d=Math.hypot(dv[0],dv[1],dv[2]);
    if(d<bd){bd=d;best={id:f+1,face:f,ent:SC.faceEnt[f],prim:pi,point:pt};}}
  return best||h;}
function edTerrDown(x,y,e){
  const h=edTerrHit(x,y),q=edPrimOfHit(h);if(!q||q.kind!==2||!h.point){if(q){edSelectHit(h);flash('The Terrain tool works on terrain blocks');return true;}return false;}
  edSelectHit(h);
  const t=q.pr.d,mode=ED.terr;
  if(mode==='holes'){
    const first=tTriAt(t,h.point),paint=!tIsHole(t,first),set=new Map();
    const add=tt=>set.set(tt.i+','+tt.j+','+tt.g,tt);add(first);
    const d={kind:'thole'};
    const prev=()=>{const H=[];for(const tt of set.values())tTriEdges(H,t,tt,paint?C_BAD:C_GOOD);edShow(H,null);
      flash((paint?'cut ':'fill ')+set.size+' triangle'+(set.size===1?'':'s'));};
    d.move=(mx,my)=>{const h2=edTerrHit(mx,my),q2=edPrimOfHit(h2);if(q2&&q2.pi===q.pi&&h2.point){add(tTriAt(t,h2.point));prev();}};
    d.up=()=>{EDDRAG=null;edShow();const T=edTerrData(q.pr);
      for(const tt of set.values()){const v=T.V[tt.j*T.W+tt.i];v.g[tt.g]=v.g[tt.g].filter(s=>!/^(nodraw|invisible)$/i.test(s));if(paint)v.g[tt.g].push('nodraw');}
      edSetTerr(T,(paint?'Cut ':'Filled ')+set.size+' terrain triangle'+(set.size===1?'':'s'));};
    EDDRAG=d;prev();return true;}
  const C=h.point,R=ED.trad;
  const near=[];for(let j=0;j<t.H;j++)for(let i=0;i<t.W;i++){const dd=Math.hypot(t.org[0]+i*TER_STEP-C[0],t.org[1]+j*TER_STEP-C[1]);if(dd<=R)near.push([i,j,(1+Math.cos(Math.PI*dd/R))/2]);}
  if(!near.length){flash('no terrain vertex within '+R+' units of that spot');return true;}
  const apply=fn=>{const T=edTerrData(q.pr);for(const[i,j,f]of near){const v=T.V[j*T.W+i];v.h=Math.round(fn(v.h,f,i,j)*100)/100;}return T;};
  if(mode==='flatten'){const z=C[2]-t.org[2];edSetTerr(apply((hh,f)=>hh+(z-hh)*Math.min(1,f*1.5)),'Flattened '+near.length+' vertices to '+fmt(Math.round(C[2])));return true;}
  if(mode==='smooth'){const T0=edTerrData(q.pr),H0=T0.V.map(v=>v.h);
    edSetTerr(apply((hh,f,i,j)=>{let s=0,c=0;for(const[di,dj]of[[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]){const a=i+di,b=j+dj;if(a<0||b<0||a>=t.W||b>=t.H)continue;s+=H0[b*t.W+a];c++;}return hh+(s/c-hh)*f;}),'Smoothed '+near.length+' vertices');return true;}
  // raise / lower: drag up or down
  const sp=project(C),up=project(vadd(C,[0,0,64]));const ppu=sp&&up?Math.max(0.05,Math.hypot(up[0]-sp[0],up[1]-sp[1])/64):1;
  const d={kind:'traise',amt:0,y0:y};
  d.move=(mx,my)=>{d.amt=Math.round((d.y0-my)/ppu/2)*2;const H=[],L=[],c=C_HOT();edCircle(L,C,R,c);
    for(const[i,j,f]of near){const p=tVert(t,i,j);segPush(H,p,[p[0],p[1],p[2]+d.amt*f],c);}
    edShow(H,L);flash((d.amt>=0?'raise ':'lower ')+Math.abs(d.amt));};
  d.up=()=>{EDDRAG=null;edShow();if(!d.amt)return;edSetTerr(apply((hh,f)=>hh+d.amt*f),(d.amt>0?'Raised ':'Lowered ')+near.length+' vertices by up to '+Math.abs(d.amt));};
  EDDRAG=d;d.move(x,y);return true;}

// what is selected, in one line, with Delete
function edSelSummary(){
  if(!ED.sel&&ED._entOnly)return'';    // an entity: the help above says Modify has it
  if(!ED.sel)return'<div class="co" style="margin-top:4px">Nothing selected: click a brush, patch or terrain block (any tool selects what it is used on).</div>';
  const pr=MAP.ents[ED.sel.ei]&&MAP.ents[ED.sel.ei].prims[ED.sel.bn];if(!pr)return'';
  const who=ED.sel.ei===0?'the world':entName(ED.sel.ei);let s='';
  if(pr.kind===0){let bb=null;try{bb=edBounds(edFaces(pr));}catch(_e){}s='Brush '+ED.sel.bn+' of '+esc(who)+' - '+pr.d.faces.length+' faces'+(bb?', '+[0,1,2].map(k=>fmt(bb.mx[k]-bb.mn[k])).join(' x '):'');}
  else if(pr.kind===1)s='Patch '+ED.sel.bn+' of '+esc(who)+' - '+pr.d.w+' x '+pr.d.h+' points, '+esc(pr.d.tex);
  else s='Terrain '+ED.sel.bn+' - '+(pr.d.W-1)*64+' x '+(pr.d.H-1)*64+' units';
  // Delete is last in the panel (edEntBtns), beside Edit parameters for a brush entity
  return'<div class="row" style="gap:4px;align-items:center;margin-top:6px"><span style="flex:1"><b>'+s+'</b></span></div>';}
// ==== part 2: corners and edges, patch points, textures, region, terrain blocks ===============
const TEXPRESETS=[['','- tool textures -'],['common/caulk','caulk (unseen faces)'],['common/hint','hint (vis split)'],['common/vis','vis (MOHAA vis brush)'],
  ['common/skip','skip (hint brush sides)'],['common/clip','clip (blocks all)'],['common/playerclip','player clip'],['common/monster','AI clip'],
  ['common/nodraw','nodraw'],['common/trigger','trigger'],['common/origin','origin'],['common/areaportal','area portal'],['common/ladder','ladder'],
  ['common/caulksky','caulk sky'],['common/weapon','weapon clip']];
// ---- a convex hull (incremental): the brush made from its corners again ----------------------
function hull3(P){
  const n=P.length;if(n<4)return null;
  let sz=0;for(const p of P)for(const q of P)sz=Math.max(sz,Math.abs(p[0]-q[0]),Math.abs(p[1]-q[1]),Math.abs(p[2]-q[2]));
  const eps=Math.max(1e-6,sz*1e-7);
  const mk=(a,b,c)=>{const nn=vnorm(vcross(vsub(P[b],P[a]),vsub(P[c],P[a])));return nn?{v:[a,b,c],n:nn,d:vdot(nn,P[a])}:null;};
  // a first tetrahedron: four corners not on one plane
  let i1=-1,best=0;for(let i=1;i<n;i++){const d=vlen3(vsub(P[i],P[0]));if(d>best){best=d;i1=i;}}if(i1<0)return null;
  let i2=-1;best=0;for(let i=1;i<n;i++){const d=vlen3(vcross(vsub(P[i1],P[0]),vsub(P[i],P[0])));if(d>best){best=d;i2=i;}}if(i2<0||best<eps)return null;
  const f0=mk(0,i1,i2);let i3=-1;best=0;for(let i=1;i<n;i++){const d=Math.abs(vdot(f0.n,P[i])-f0.d);if(d>best){best=d;i3=i;}}if(i3<0||best<eps)return null;
  const cen=[0,1,2].map(k=>(P[0][k]+P[i1][k]+P[i2][k]+P[i3][k])/4);
  let F=[];const add=(a,b,c)=>{let f=mk(a,b,c);if(!f)return;if(vdot(f.n,cen)-f.d>0)f=mk(a,c,b);if(f)F.push(f);};
  add(0,i1,i2);add(0,i1,i3);add(0,i2,i3);add(i1,i2,i3);
  const used=new Set([0,i1,i2,i3]);
  for(let i=0;i<n;i++){if(used.has(i))continue;
    const vis=F.filter(f=>vdot(f.n,P[i])-f.d>eps);if(!vis.length)continue;
    const ed=new Set();for(const f of vis)for(let k=0;k<3;k++)ed.add(f.v[k]+','+f.v[(k+1)%3]);
    F=F.filter(f=>vis.indexOf(f)<0);
    for(const e of ed){const[a,b]=e.split(',').map(Number);if(ed.has(b+','+a))continue;const f=mk(a,b,i);if(f)F.push(f);}}
  return F;}
function vlen3(v){return Math.hypot(v[0],v[1],v[2]);}
// a brush's corners and edges, from its face polygons
function brushGeom(faces){
  const c=edCheck(faces),V=[],key=new Map(),E=new Map();
  const vi=(x,y,z)=>{const k=Math.round(x*1000)+','+Math.round(y*1000)+','+Math.round(z*1000);let i=key.get(k);if(i==null){i=V.length;V.push([x,y,z]);key.set(k,i);}return i;};
  for(const k of c.live){const w=c.ws[k],m=w.length/3,ids=[];for(let q=0;q<m;q++)ids.push(vi(w[q*3],w[q*3+1],w[q*3+2]));
    for(let q=0;q<m;q++){const a=ids[q],b=ids[(q+1)%m],kk=Math.min(a,b)+','+Math.max(a,b);if(a!==b)E.set(kk,[Math.min(a,b),Math.max(a,b)]);}}
  return{V:V,E:[...E.values()]};}
// the brush through these corners: a face for each plane of their hull, each with the
// texture of the old face that faced most the same way
function facesFromCorners(V,old){
  const F=hull3(V);if(!F||F.length<4)throw new Error('the corners don\'t make a solid');
  const groups=[];
  for(const f of F){let g=groups.find(g=>vdot(g.n,f.n)>1-1e-6&&Math.abs(g.d-f.d)<0.01);if(!g)groups.push({n:f.n,d:f.d,v:f.v});}
  const opl=old.map(planeOf);
  const out=groups.map(g=>{
    let bi=0,bd=-2;opl.forEach((pl,k)=>{if(!pl)return;const d=vdot(pl,g.n)-(Math.abs(pl[3]-g.d)<0.01?0:1e-3);if(d>bd){bd=d;bi=k;}});
    const src=old[bi];let P=[V[g.v[0]],V[g.v[1]],V[g.v[2]]];
    const nn=vcross(vsub(P[0],P[1]),vsub(P[2],P[1]));if(vdot(nn,g.n)<0)P=[P[2],P[1],P[0]];
    return Object.assign({},src,{p:[].concat(P[0],P[1],P[2]),sh:src.sh.slice(),sc:src.sc.slice(),tm:src.tm?[src.tm[0].slice(),src.tm[1].slice()]:null});});
  edCheck(out);return out;}
// the axis plane a dragged point slides on: the one most square to the view (Shift: up / down)
function dragPlaneAxis(){const f=camAxes().f;return[0,1,2].reduce((a,k)=>Math.abs(f[k])>Math.abs(f[a])?k:a,0);}
function pointDrag(P0,mx,my,vert){
  if(vert){const t=rayLineT(mx,my,P0,[0,0,1]);return[P0[0],P0[1],snapV(P0[2]+t)];}
  const ax=dragPlaneAxis(),q=rayPlane(mx,my,AXV(ax),P0[ax]);if(!q)return null;
  return[0,1,2].map(k=>k===ax?P0[k]:snapV(q[k]));}
// the corner, edge or patch point of the selected brush or patch near the mouse
function edGrabAt(x,y){
  const pr=ED.sel&&MAP.ents[ED.sel.ei]&&MAP.ents[ED.sel.ei].prims[ED.sel.bn];if(!pr)return null;
  if(pr.kind===0){let G;try{G=brushGeom(edFaces(pr));}catch(_e){return null;}
    let bv=-1,bd=10;G.V.forEach((v,i)=>{const s=project(v);if(!s)return;const d=Math.hypot(s[0]-x,s[1]-y);if(d<bd){bd=d;bv=i;}});
    if(bv>=0)return{kind:'vert',pr:pr,G:G,ids:[bv]};
    let be=null;bd=6;for(const e of G.E){const a=project(G.V[e[0]]),b=project(G.V[e[1]]);if(!a||!b)continue;const d=segDist2(x,y,a,b);if(d<bd){bd=d;be=e;}}
    if(be)return{kind:'edge',pr:pr,G:G,ids:be.slice()};
    return null;}
  if(pr.kind===1){const P=edPatchData(pr);let bi=-1,bd=12;
    for(let k=0;k<P.pts.length/5;k++){const s=project([P.pts[k*5],P.pts[k*5+1],P.pts[k*5+2]]);if(!s)continue;const d=Math.hypot(s[0]-x,s[1]-y);if(d<bd){bd=d;bi=k;}}
    if(bi>=0)return{kind:'ppt',pr:pr,P:P,k:bi};}
  return null;}
function segDist2(px,py,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],l2=dx*dx+dy*dy;let t=l2?((px-a[0])*dx+(py-a[1])*dy)/l2:0;t=Math.max(0,Math.min(1,t));return Math.hypot(px-a[0]-t*dx,py-a[1]-t*dy);}
function edGrabDown(x,y,e){
  const g=edGrabAt(x,y);if(!g)return false;
  const vert=e.shiftKey;
  if(g.kind==='ppt'){const P0=[g.P.pts[g.k*5],g.P.pts[g.k*5+1],g.P.pts[g.k*5+2]];
    const d={kind:'ppt',to:P0};
    d.move=(mx,my)=>{const q=pointDrag(P0,mx,my,vert);if(!q)return;d.to=q;const P=edPatchData(g.pr);P.pts[g.k*5]=q[0];P.pts[g.k*5+1]=q[1];P.pts[g.k*5+2]=q[2];
      const H=[];edNetEdges(H,P,C_HOT());edShow(H,null);flash('point ( '+q.map(fmt).join(' ')+' )');};
    d.up=()=>{EDDRAG=null;edShow();if(d.to.every((v,k)=>v===P0[k]))return;const P=edPatchData(g.pr);P.pts[g.k*5]=d.to[0];P.pts[g.k*5+1]=d.to[1];P.pts[g.k*5+2]=d.to[2];
      edSetPatch(P,'Patch point moved to '+d.to.map(fmt).join(' '));};
    EDDRAG=d;return true;}
  const old=edFaces(g.pr),A=g.G.V[g.ids[0]];
  const d={kind:g.kind,off:[0,0,0],out:null};
  d.move=(mx,my)=>{const q=pointDrag(A,mx,my,vert);if(!q)return;d.off=vsub(q,A);
    const V=g.G.V.map((v,i)=>g.ids.indexOf(i)>=0?vadd(v,d.off):v.slice());
    let ok=true;try{d.out=facesFromCorners(V,old);}catch(_e){ok=false;d.out=null;}
    const H=[];if(ok)facesEdges(H,d.out,C_HOT());else facesEdges(H,old,C_BAD);
    for(const i of g.ids){const p=V[i];for(let k=0;k<3;k++){const a=p.slice(),b=p.slice();a[k]-=6;b[k]+=6;segPush(H,a,b,C_GOOD);}}
    edShow(H,null);flash((g.kind==='vert'?'corner':'edge')+' by '+d.off.map(fmt).join(' ')+(ok?'':' - that doesn\'t make a solid'));};
  d.up=()=>{EDDRAG=null;edShow();if(!d.out||(!d.off[0]&&!d.off[1]&&!d.off[2]))return;
    edSetFaces(d.out,(g.kind==='vert'?'Corner':'Edge')+' moved '+d.off.map(fmt).join(' ')+' ('+d.out.length+' faces)');};
  EDDRAG=d;return true;}
// the selected brush's corners, shown while Resize is on
function edCornerMarks(L){
  if(ED.tool!=='resize'||!ED.sel)return;const pr=MAP.ents[ED.sel.ei]&&MAP.ents[ED.sel.ei].prims[ED.sel.bn];if(!pr||pr.kind!==0)return;
  let G;try{G=brushGeom(edFaces(pr));}catch(_e){return;}
  for(const p of G.V)for(let k=0;k<3;k++){const a=p.slice(),b=p.slice();a[k]-=4;b[k]+=4;segPush(L,a,b,[1,1,1,0.9]);}}

// ---- textures on faces -------------------------------------------------------------------
function edTexBox(){return edTexOk(($('edTex')&&$('edTex').value||'').trim()||'common/caulk');}
function edPaintDown(x,y,e,terr){
  const h=terr?edTerrHit(x,y):edHitT(x,y),q=edPrimOfHit(h);if(!q)return false;
  if(terr&&(q.kind!==2||!h.point)){edSelectHit(h);flash('Terrain paint works on terrain blocks (the Texture tool paints brushes and patches)');return true;}
  if(e.altKey){   // pick: the texture under the mouse (and its tiling) goes into the Texture box
    const tx=edTexAt(h);if(tx){$('edTex').value=tx;let t=null;try{t=edTileAt(h);}catch(_e){}ED.dropTile=t?{tx:tx,t:t}:null;flash('Texture: '+tx+(t?' (and its tiling)':''));}return true;}
  edSelectHit(h);
  if(e.ctrlKey||e.metaKey){if(q.kind===0){ED.face=q.side;edPanel();flash('Face '+(q.side+1)+' selected: the buttons below change how its texture lies');}return true;}
  const tx=edTexBox(),dt=ED.dropTile&&ED.dropTile.tx===tx?ED.dropTile.t:null,tl=dt?', its tiling too':'';
  const tileF=f=>{if(dt&&dt.kind==='face'&&!f.tm){f.sc=dt.sc.slice();f.rot=dt.rot;f.sh=dt.sh.slice();}};
  if(q.kind===0){const fs=edFaces(q.pr);if(e.shiftKey){for(const f of fs){f.tex=tx;tileF(f);}edSetFaces(fs,'Every face of the brush: '+tx+tl);}
    else{const f=fs[q.side];f.tex=tx;tileF(f);ED.face=q.side;
      if(edBrushText(fs)===D.srcText.slice(q.pr.ts,q.pr.te)){edPanel();return true;}   // already so: just picked
      edSetFaces(fs,'Face '+(q.side+1)+': '+tx+tl);ED.face=q.side;}}
  else if(q.kind===1){const P=edPatchData(q.pr);P.tex=tx;edSetPatch(P,'Patch: '+tx);}
  else{const T=edTerrData(q.pr),pi=Math.max(0,Math.min((T.W-1)/8-1,Math.floor((h.point[0]-T.org[0])/512))),pj=Math.max(0,Math.min((T.H-1)/8-1,Math.floor((h.point[1]-T.org[1])/512))),nx=(T.W-1)/8;
    const c=T.cl[pj*(nx+1)+pi];if(!c)throw new Error('that terrain patch has no texture line');c[0]=tx;
    const tt=dt&&dt.kind==='terrain';if(tt){while(c.length<7)c.push('0');c[1]=edN6(dt.sh[0]);c[2]=edN6(dt.sh[1]);c[3]=edN6(dt.rot);c[5]=edN6(dt.sc[0]);c[6]=edN6(dt.sc[1]);}
    edSetTerr(T,'Terrain patch '+pi+' '+pj+': '+tx+(tt?tl:''));}
  return true;}
// how the selected face's texture lies: fit once across, turn, flip, shift, scale, reset
function edFaceTex(op){
  const pr=edPrim();if(!pr)throw new Error('select a brush face first (Ctrl+click it with the Texture tool)');
  const fs=edFaces(pr),k=ED.face,f=fs[k];if(!f)throw new Error('pick a face: Ctrl+click it with the Texture tool');
  if(f.tm)throw new Error('this face uses brush-primitive texturing: its matrix is kept as it is');
  const pl=planeOf(f),[tw,th]=edTexSize(f.tex);
  if(op==='fit'){const c=edCheck(fs),w=c.ws[k];if(!w)throw new Error('the face has no surface');
    const V=texVecs(pl,[0,0],f.rot,[1,1]);let a=Infinity,b=-Infinity,cc=Infinity,dd=-Infinity;
    for(let i=0;i<w.length;i+=3){const s=V[0]*w[i]+V[1]*w[i+1]+V[2]*w[i+2],t=V[4]*w[i]+V[5]*w[i+1]+V[6]*w[i+2];a=Math.min(a,s);b=Math.max(b,s);cc=Math.min(cc,t);dd=Math.max(dd,t);}
    f.sc=[(b-a)/tw,(dd-cc)/th].map(v=>Math.round(v*10000)/10000);f.sh=[-a/f.sc[0],-cc/f.sc[1]].map((v,i)=>Math.round((((v%[tw,th][i])+[tw,th][i])%[tw,th][i])*100)/100);}
  else if(op==='rl')f.rot=(f.rot+90)%360;else if(op==='rr')f.rot=(f.rot+270)%360;
  else if(op==='fh')f.sc[0]=-f.sc[0];else if(op==='fv')f.sc[1]=-f.sc[1];
  else if(op==='up2')f.sc=f.sc.map(v=>v*2);else if(op==='dn2')f.sc=f.sc.map(v=>v/2);
  else if(op==='sl')f.sh[0]-=8;else if(op==='sr')f.sh[0]+=8;else if(op==='su')f.sh[1]-=8;else if(op==='sd')f.sh[1]+=8;
  else if(op==='nat'){f.sh=[0,0];f.rot=0;f.sc=[0.5,0.5];}
  const keep=k;edSetFaces(fs,'Face '+(k+1)+' texture: '+{fit:'fitted',rl:'turned 90',rr:'turned -90',fh:'flipped',fv:'flipped',up2:'scale x2',dn2:'scale /2',sl:'shift',sr:'shift',su:'shift',sd:'shift',nat:'natural'}[op]);
  ED.face=keep;edPanel();}

// ---- patches: rows and columns, more shapes ------------------------------------------------
// one quadratic segment (A B C) into two (A, AB, M) (M, BC, C): the same surface, more points
function edPatchGrow(P,dir,add){
  const w=P.w,h=P.h,at=(j,i)=>{const o=(j*h+i)*5;return P.pts.slice(o,o+5);};
  const nj=dir==='w'?w:h,ni=dir==='w'?h:w,get=(a,b)=>dir==='w'?at(a,b):at(b,a);
  let lines=[];for(let a=0;a<nj;a++){const L=[];for(let b=0;b<ni;b++)L.push(get(a,b));lines.push(L);}
  const mix=(x,y,s)=>x.map((v,k)=>v+(y[k]-v)*s);
  const seg=Math.max(0,Math.min((nj-3)/2,Math.floor(((dir==='w'?(ED.pp?ED.pp[0]:0):(ED.pp?ED.pp[1]:0)))/2)));
  const s0=seg*2;
  if(add){if(nj+2>129)throw new Error('a patch has 129 points a side at most');
    const A=lines[s0],B=lines[s0+1],C=lines[s0+2];
    const AB=A.map((p,k)=>mix(p,B[k],0.5)),BC=B.map((p,k)=>mix(p,C[k],0.5)),M=AB.map((p,k)=>mix(p,BC[k],0.5));
    lines.splice(s0+1,1,AB,M,BC);}
  else{if(nj<5)throw new Error('it has the fewest '+(dir==='w'?'rows':'columns')+' a patch can have (3)');
    const s=Math.min(s0,nj-5),A=lines[s],M=lines[s+2],C=lines[s+4];
    const B=M.map((p,k)=>p.map((v,c)=>(4*v-A[k][c]-C[k][c])/2));
    lines.splice(s+1,3,B);}
  const nn=lines.length,out={w:dir==='w'?nn:w,h:dir==='w'?h:nn,tex:P.tex,pts:[]};
  for(let j=0;j<out.w;j++)for(let i=0;i<out.h;i++){const p=dir==='w'?lines[j][i]:lines[i][j];out.pts.push(...p);}
  return out;}
function edPatchRows(dir,add){const P=edPatchGrow(edPatchData(edPatch()),dir,add);edSetPatch(P,'Patch '+(add?'+2 ':'-2 ')+(dir==='w'?'rows':'columns')+' ('+P.w+' x '+P.h+' points)');}
// caps and thickness for the selected patch. A cap closes an open ring (a pipe or cone's end)
// with a disc patch whose middle row meets at the ring's centre; Thicken adds a copy pushed
// out along the surface (facing the other way) and strips joining their open edges, so a
// thin sheet becomes a solid-looking slab, wall or tube.
const ptOf=(P,j,i)=>{const o=(j*P.h+i)*5;return[P.pts[o],P.pts[o+1],P.pts[o+2]];};
const vnear=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])<0.01;
function edPatchEdges(P){
  const E=[];
  E.push(Array.from({length:P.w},(_,j)=>[j,0]),Array.from({length:P.w},(_,j)=>[j,P.h-1]),
         Array.from({length:P.h},(_,i)=>[0,i]),Array.from({length:P.h},(_,i)=>[P.w-1,i]));
  return E;}
function edPatchMid(P){const c=[0,0,0];for(let k=0;k<P.pts.length;k+=5){c[0]+=P.pts[k];c[1]+=P.pts[k+1];c[2]+=P.pts[k+2];}const n=P.pts.length/5;return c.map(v=>v/n);}
// a strip patch n x 3 from one row of points to another (its middle row halfway), turned to
// face away from the point "away"
function edStrip(A,B,tex,away){
  const n=A.length,P={tex:tex,w:n,h:3,pts:[]};
  for(let j=0;j<n;j++){const a=A[j],b=B[j];P.pts.push(...a,0,0,...[0,1,2].map(k=>(a[k]+b[k])/2),0,0,...b,0,0);}
  const f=edPatchFacing(P);
  if(f){let m=[0,0,0];for(let j=0;j<n;j++)for(let k=0;k<3;k++)m[k]+=(A[j][k]+B[j][k])/(2*n);
    if((m[0]-away[0])*f[0]+(m[1]-away[1])*f[1]+(m[2]-away[2])*f[2]<0){const R={tex:tex,w:n,h:3,pts:[]};for(let j=n-1;j>=0;j--)R.pts.push(...P.pts.slice(j*15,j*15+15));return edPatchTex(R,'natural',0.5);}}
  return edPatchTex(P,'natural',0.5);}
function edPatchCap(){
  const P=edPatchData(edPatch()),mid=edPatchMid(P),out=[];
  for(const e of edPatchEdges(P)){const R=e.map(([j,i])=>ptOf(P,j,i));if(R.length<3||!vnear(R[0],R[R.length-1]))continue;
    const c=[0,0,0];for(let k=0;k<R.length-1;k++)for(let q=0;q<3;q++)c[q]+=R[k][q]/(R.length-1);
    out.push(edStrip(R,R.map(()=>c),P.tex,mid));}
  if(!out.length)throw new Error('this patch has no open ring to cap: caps close the ends of a pipe, cylinder or cone (an edge that comes back to where it starts)');
  edAddPatches(out,'Capped: '+out.length+(out.length===1?' end':' ends'));}
function edPatchThicken(){
  const P=edPatchData(edPatch()),t=+($('edThick')&&$('edThick').value)||16;
  const wrapJ=vnear(ptOf(P,0,0),ptOf(P,P.w-1,0))&&vnear(ptOf(P,0,P.h-1),ptOf(P,P.w-1,P.h-1)),wrapI=vnear(ptOf(P,0,0),ptOf(P,0,P.h-1))&&vnear(ptOf(P,P.w-1,0),ptOf(P,P.w-1,P.h-1));
  const nb=(k,n,w)=>k<0?(w?n-2:0):k>=n?(w?1:n-1):k;
  const Q={tex:P.tex,w:P.w,h:P.h,pts:P.pts.slice()};
  for(let j=0;j<P.w;j++)for(let i=0;i<P.h;i++){
    const a=vsub(ptOf(P,nb(j+1,P.w,wrapJ),i),ptOf(P,nb(j-1,P.w,wrapJ),i)),b=vsub(ptOf(P,j,nb(i+1,P.h,wrapI)),ptOf(P,j,nb(i-1,P.h,wrapI)));
    let n=vcross(a,b),l=Math.hypot(n[0],n[1],n[2]);if(l<1e-6){n=edPatchFacing(P)||[0,0,1];l=1;}
    const o=(j*P.h+i)*5;for(let k=0;k<3;k++)Q.pts[o+k]=Math.round((P.pts[o+k]-n[k]/l*t)*1000)/1000;}
  // the copy faces the other way: its rows in reverse order
  const B={tex:P.tex,w:P.w,h:P.h,pts:[]};for(let j=P.w-1;j>=0;j--)B.pts.push(...Q.pts.slice(j*P.h*5,(j+1)*P.h*5));
  const out=[edPatchTex(B,'natural',0.5)],mid=edPatchMid({pts:P.pts.concat(Q.pts)});
  for(const e of edPatchEdges(P)){const A=e.map(([j,i])=>ptOf(P,j,i));if(A.every(v=>vnear(v,A[0])))continue;
    const sameAs=e.map(([j,i])=>ptOf(Q,j,i));if(A.every((v,k)=>vnear(v,sameAs[k])))continue;
    if((e[0][0]===0&&e[1][0]===0&&wrapJ)||(e[0][0]===P.w-1&&e[1][0]===P.w-1&&wrapJ)||(e[0][1]===0&&e[1][1]===0&&wrapI)||(e[0][1]===P.h-1&&e[1][1]===P.h-1&&wrapI))continue;
    out.push(edStrip(A,sameAs,P.tex,mid));}
  edAddPatches(out,'Thickened by '+fmt(t)+': '+out.length+' patches added');}
// several new patches in one undo step, after the selected one in its entity
function edAddPatches(list,what){
  for(const P of list)edPatchCheck(P);
  const ei=ED.sel?ED.sel.ei:0,e=MAP.ents[ei],end=D.srcText.lastIndexOf('}',e.te-1);
  if(end<e.ts)throw new Error('the entity\'s block can\'t be found in the text');
  const txt=list.map((P,k)=>'// patch '+(e.prims.length+k)+' (Map Editor)\n'+edPatchText(P)+'\n').join('');
  edDo(end,'',txt,{ei:ei,bn:e.prims.length},what);}
// a cone: a cylinder whose top ring is drawn in to its middle; an elbow: a quarter bend of pipe
function edPatchCone(mn,sz,tex){
  const P=edPatchShape('cyl',mn,sz,tex),c=[mn[0]+sz[0]/2,mn[1]+sz[1]/2];
  for(let j=0;j<P.w;j++){const o=(j*P.h+2)*5,m=(j*P.h+1)*5;P.pts[o]=c[0];P.pts[o+1]=c[1];P.pts[m]=(P.pts[m]+c[0])/2;P.pts[m+1]=(P.pts[m+1]+c[1])/2;}
  return edPatchTex(P,'natural',0.5);}
function edPatchElbow(mn,sz,tex){
  const r=sz[2]/2,zc=mn[2]+r,Rb=Math.max(r*1.25,Math.min(sz[0],sz[1])-r),r2=Math.SQRT2;
  const ring=[];for(let j=0;j<9;j++){const a=j*45*Math.PI/180,k=(j&1)?r2:1;ring.push([Math.cos(a)*k,Math.sin(a)*k]);}
  const path=[[1,0],[r2*Math.cos(Math.PI/4),r2*Math.sin(Math.PI/4)],[0,1]];
  const P={tex:tex,w:9,h:3,pts:[]};
  for(let j=0;j<9;j++)for(let i=0;i<3;i++){const rad=Rb+r*ring[j][0];P.pts.push(mn[0]+path[i][0]*rad,mn[1]+path[i][1]*rad,zc+r*ring[j][1],0,0);}
  return edPatchTex(P,'natural',0.5);}

// ---- region: only what is round the selection is drawn (MOHRadiant's Region) ----------------
ED.region=null;
function edRegionSet(on){
  if(!on){ED.region=null;}
  else{const mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity],grow=(a,b)=>{for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],a[k]);mx[k]=Math.max(mx[k],b[k]);}};
    for(const k of SEL){const n=+k.slice(1);if(k[0]==='p'){const p=SC.prims[n];if(p&&p.mins)grow(p.mins,p.maxs);}
      else{const X=ENTS[n];if(X&&X.box){const o=X.box.origin;grow([0,1,2].map(i=>o[i]+X.box.mins[i]),[0,1,2].map(i=>o[i]+X.box.maxs[i]));}else if(X&&X.origin)grow(X.origin,X.origin);}}
    if(!isFinite(mn[0]))throw new Error('select what to work round first');
    const m=+($('edRegM')&&$('edRegM').value)||256;ED.region={mn:mn.map(v=>v-m),mx:mx.map(v=>v+m)};}
  rebuildWorld();try{rebuildMarkers();}catch(_e){}lineDirty=true;requestDraw();edPanel();
  flash(ED.region?'Region: only what is within the box round the selection is drawn':'Region off: the whole map is drawn');}
function edInRegion(mn,mx){const R=ED.region;if(!R)return true;for(let k=0;k<3;k++)if(mx[k]<R.mn[k]||mn[k]>R.mx[k])return false;return true;}
{const _fs=faceShown;faceShown=function(f){if(!_fs(f))return false;if(!ED.region)return true;const p=SC.prims[SC.facePrim[f]];return!p||!p.mins||edInRegion(p.mins,p.maxs);};}
{const _es=entShown;entShown=function(ei){if(!_es(ei))return false;if(!ED.region)return true;const X=ENTS[ei];if(!X||!X.origin)return true;return edInRegion(X.origin,X.origin);};}

// ---- terrain blocks: drawn, fitted to their neighbours ----------------------------------------
// every other terrain block's vertex heights by x y (the shared edges of neighbouring blocks)
function terrHeightsMap(skipPi){
  const M=new Map();
  for(let pi=0;pi<SC.prims.length;pi++){if(pi===skipPi)continue;const r=SC.prims[pi];if(!r||r.kind!==2)continue;const t=MAP.ents[r.ent].prims[r.bn].d;
    for(let j=0;j<t.H;j++)for(let i=0;i<t.W;i++){const k=(t.org[0]+i*TER_STEP)+','+(t.org[1]+j*TER_STEP);if(!M.has(k))M.set(k,t.org[2]+t.heights[j*t.W+i]);}}
  return M;}
// edge heights from the neighbouring blocks, the inside blended between the edges (a Coons
// patch), so a block dropped into a gap meets the ground round it
function terrFit(T,skipPi,inside){
  const M=terrHeightsMap(skipPi),W=T.W,H=T.H,z0=T.org[2],hv=(i,j)=>T.V[j*W+i];
  let n=0;
  const edge=(i,j)=>{const z=M.get((T.org[0]+i*TER_STEP)+','+(T.org[1]+j*TER_STEP));if(z!=null){hv(i,j).h=Math.round((z-z0)*100)/100;n++;}};
  for(let i=0;i<W;i++){edge(i,0);edge(i,H-1);}for(let j=1;j<H-1;j++){edge(0,j);edge(W-1,j);}
  if(inside){const h=(i,j)=>hv(i,j).h,c00=h(0,0),c10=h(W-1,0),c01=h(0,H-1),c11=h(W-1,H-1);
    for(let j=1;j<H-1;j++)for(let i=1;i<W-1;i++){const u=i/(W-1),v=j/(H-1);
      hv(i,j).h=Math.round(((1-v)*h(i,0)+v*h(i,H-1)+(1-u)*h(0,j)+u*h(W-1,j)-((1-u)*(1-v)*c00+u*(1-v)*c10+(1-u)*v*c01+u*v*c11))*100)/100;}}
  return n;}
function edTerrFitSel(inside){
  const pr=edTerr();if(!pr)throw new Error('select a terrain block first');
  const pi=SC.prims.findIndex(p=>p.ent===ED.sel.ei&&p.bn===ED.sel.bn),T=edTerrData(pr),n=terrFit(T,pi,inside);
  if(!n)throw new Error('no other terrain block shares an edge with this one');
  edSetTerr(T,(inside?'Fitted to its neighbours: ':'Edges joined: ')+n+' edge vertices'+(inside?', the inside blended':''));}
function edTerrNewDown(x,y){
  const h=edHit(x,y);let z=h&&h.point?Math.round(h.point[2]):(ED.lastZ!=null?ED.lastZ:0);
  const at=(px,py)=>{const q=rayPlane(px,py,[0,0,1],z);return q?[Math.round(q[0]/TER_STEP)*TER_STEP,Math.round(q[1]/TER_STEP)*TER_STEP,z]:null;};
  const a=at(x,y);if(!a)return false;
  const d={kind:'tnew',a:a,b:a.slice()};
  const box=()=>{const nx=Math.max(1,Math.ceil(Math.abs(d.b[0]-d.a[0])/512)),ny=Math.max(1,Math.ceil(Math.abs(d.b[1]-d.a[1])/512));
    return{nx:nx,ny:ny,org:[Math.min(d.a[0],d.b[0]),Math.min(d.a[1],d.b[1]),z]};};
  d.move=(mx,my)=>{const b=at(mx,my);if(b)d.b=b;const B=box(),H=[],c=C_HOT(),X=B.nx*512,Y=B.ny*512,o=B.org;
    for(let i=0;i<=B.nx;i++)segPush(H,[o[0]+i*512,o[1],z],[o[0]+i*512,o[1]+Y,z],c);for(let j=0;j<=B.ny;j++)segPush(H,[o[0],o[1]+j*512,z],[o[0]+X,o[1]+j*512,z],c);
    edShow(H,null);flash('new terrain '+B.nx+' x '+B.ny+' patches ('+X+' x '+Y+')');};
  d.up=()=>{EDDRAG=null;edShow();const B=box(),W=B.nx*8+1,Hh=B.ny*8+1;
    const T={W:W,H:Hh,org:B.org,V:[]};for(let k=0;k<W*Hh;k++)T.V.push({h:0,g:[[],[]]});
    if($('edTFit')?$('edTFit').checked:true)terrFit(T,-1,true);
    edAddBlock(0,edTerrNewText(W,Hh,B.org,edTexBox(),T.V.map(v=>v.h)),'terrain','New terrain '+B.nx+' x '+B.ny+' patches at '+B.org.map(fmt).join(' '));};
  EDDRAG=d;d.move(x,y);return true;}

// ---- the panel's patch and terrain parts ---------------------------------------------------
const edRow=s=>'<div class="row" style="gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px">'+s+'</div>';
const edSel=(id,opts,v)=>'<select id="'+id+'" style="padding:2px 4px;font-size:11px">'+opts.map(o=>'<option value="'+o[0]+'"'+(o[0]===v?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>';
const edBtn=(id,label,tip)=>'<button class="sm" id="'+id+'"'+(tip?' title="'+tip+'"':'')+'>'+label+'</button>';
function edNewHtml(){
  return edLine('Patch',edSel('edPShape',[['flat','flat (floor)'],['wallx','wall along x'],['wally','wall along y'],['cyl','cylinder'],['archx','arch along x'],['archy','arch along y']],ED.pshape||'flat')+
      edXYZ('edPNs',ED.pns||[128,128,128],36)+edBtn('bEdPNew','Add','A patch of this shape and size (x y z) on the surface straight ahead, on the grid, with the texture above'),'A curved patch: its shape and its size along x, y and z')+
    edLine('Terrain',edCap('x')+edField('edTNx',ED.tn?ED.tn[0]:1,28)+edCap('y')+edField('edTNy',ED.tn?ED.tn[1]:1,28)+edCap('patches of 512')+
      edBtn('bEdTNew','Add','A flat terrain block this many 512-unit patches each way, on the 64-unit grid where you look, with the texture above'),'A terrain block: how many 512-unit patches along x and y');
}
function edPatchHtml(pr){
  const d=pr.d,[j,i]=edPatchPoint(edPatchData(pr)),o=(j*d.h+i)*5,P=d.pts;
  let h=edHead('<b>Patch '+ED.sel.bn+'</b> of '+esc(ED.sel.ei===0?'the world':entName(ED.sel.ei))+' - '+d.w+' x '+d.h+' control points, '+esc(d.tex));
  const fc=edPatchFacing(edPatchData(pr));h+='<div class="co">It faces '+(fc?'( '+fc.map(x=>fmt(Math.round(x*100)/100)).join(' ')+' ) at its middle (the game draws one side unless its shader has cull none)':'no way: its points are in a line')+'</div>';
  h+=edLine('Point',edCap('row')+edField('edPj',j,30)+edCap('column')+edField('edPi',i,30),'Which control point (or click near one in the view)');
  h+=edLine('Position',[0,1,2].map(k=>edCap('xyz'[k])+edField('edPv'+k,edN6(P[o+k]),56)).join(''),'The point\'s place');
  h+=edLine('Tex pos',edCap('s')+edField('edPs',edN6(P[o+3]),56)+edCap('t')+edField('edPt',edN6(P[o+4]),56)+edBtn('bEdPSet','Set point','Set the point\'s place and texture position to these'),'Where the texture is at this point (s across, t down; 1 = once across)');
  h+=edLine('Move by',edXYZ('edPMv',ED.mv||[GRID.on?gridSize():16,0,0])+edSel('edPApply',[['all','the patch'],['point','the point'],['row','its row'],['col','its column']],ED.papply||'all')+
    edBtn('bEdPMv','Move')+edBtn('bEdPCp','Copy','A copy of the whole patch, moved by x y z'),'How far to move the patch (or its point, row or column) along x, y and z');
  h+=edLine('',edBtn('bEdPTurn','Turn 90','Turn it 90 degrees round the middle of its points (anticlockwise seen from above)')+edBtn('bEdPFlip','Flip','Make it face the other way')+edBtn('bEdPDel','Delete'));
  h+=edLine('Texture',edSel('edPTm',[['keep','keep s t'],['natural','natural, scale'],['fit','fit once across']],ED.ptm||'natural')+edCap('scale')+edField('edPTs',ED.pts||0.5,36)+edBtn('bEdPTex','Set texture'),'The Texture box\'s texture on the patch, laid as chosen');
  return h;
}
function edTerrHtml(pr){
  const d=pr.d,T={W:d.W,H:d.H},[i,j]=edTerrVert(T),k=j*d.W+i,c=d.corners[0]||{sh:[0,0],rot:0,sc:[1,1]};
  const sq=[Math.min(i,d.W-2),Math.min(j,d.H-2)],ij=(pfx,a,b)=>edCap('i')+edField(pfx+a[0],a[1],30)+edCap('j')+edField(pfx+b[0],b[1],30);
  let h=edHead('<b>Terrain '+ED.sel.bn+'</b> - '+d.W+' x '+d.H+' vertices ('+(d.W-1)*64+' x '+(d.H-1)*64+' units) at '+esc(d.org.map(fmt).join(' ')));
  h+=edLine('Vertex',ij('edTv',['i',i],['j',j])+'<span class="co">( '+[d.org[0]+i*64,d.org[1]+j*64,d.org[2]+d.heights[k]].map(fmt).join(' ')+' ), height '+fmt(d.heights[k])+'</span>',
    'Which vertex: i along x, j along y, from the block\'s corner (or click the terrain)');
  h+=edLine('Heights',edCap('from')+ij('edTr',['0',i],['1',j])+edCap('to')+ij('edTr',['2',i],['3',j]),'The vertices from one corner to the other');
  h+=edLine('',edSel('edThM',[['set','set to'],['add','raise by']],ED.thm||'set')+edField('edThV',fmt(d.heights[k]),48)+edBtn('bEdTH','Apply')+edBtn('bEdTSm','Smooth','Each vertex the average of it and its four neighbours, once'));
  h+=edLine('Hill',edCap('raise')+edField('edThA',ED.tha!=null?ED.tha:32,44)+edCap('radius')+edField('edThR',ED.thr||256,44)+
    edSel('edThS',[['smooth','smooth'],['cone','cone'],['flat','flat']],ED.ths||'smooth')+edBtn('bEdTHill','Raise','Below 0 lowers'),'Raise (below 0: lower) the ground round the vertex, within the radius');
  h+=edLine('Squares',edCap('from')+ij('edTq',['0',sq[0]],['1',sq[1]])+edCap('to')+ij('edTq',['2',sq[0]],['3',sq[1]])+
    edBtn('bEdTHole','Cut hole','nodraw on both triangles of each square')+edBtn('bEdTFill','Fill'),'The 64-unit squares from one corner to the other');
  h+=edLine('Texture',edCap('scale')+edField('edTk0',fmt(c.sc[0]),36)+edField('edTk1',fmt(c.sc[1]),36)+edCap('rotate')+edField('edTrot',fmt(c.rot),34)+
    edCap('shift')+edField('edTs0',fmt(c.sh[0]),36)+edField('edTs1',fmt(c.sh[1]),36)+edBtn('bEdTTex','Set'),'The Texture box\'s texture on every patch of the block, with this scale, rotate and shift (the same order as Tiling above)');
  h+=edLine('Move by',edXYZ('edTMv',ED.tmv||[64,0,0])+edBtn('bEdTMv','Move','x and y in 64-unit steps')+edBtn('bEdTCp','Copy'),'How far to move the block (or a copy): x and y in 64-unit steps');
  h+=edLine('',edBtn('bEdTDel','Delete'));
  const sp=edTerrSpan({W:d.W,H:d.H,V:Array.from(d.heights,x=>({h:x}))});
  if(sp.n)h+='<div class="co" style="color:var(--warn)">'+sp.n+' of its patches span more than 510 in height (up to '+fmt(sp.worst)+'): a .bsp holds each patch\'s heights in 2-unit steps, 510 above its lowest point at most.</div>';
  return h;
}
function edPTBind(on){
  const keep=()=>{const g=id=>$(id)&&$(id).value;ED.pshape=g('edPShape')||ED.pshape;try{ED.pns=edVec('edPNs');}catch(_e){}
    if($('edTNx'))ED.tn=[g('edTNx'),g('edTNy')];if($('edPApply'))ED.papply=g('edPApply');if($('edPTm')){ED.ptm=g('edPTm');ED.pts=g('edPTs');}
    if($('edThM')){ED.thm=g('edThM');ED.tha=g('edThA');ED.thr=g('edThR');ED.ths=g('edThS');}
    try{if($('edPMv'))ED.mv=edVec('edPMv');}catch(_e){}try{if($('edTMv'))ED.tmv=edVec('edTMv');}catch(_e){}};
  const op=fn=>()=>{keep();fn();};
  on('bEdPNew',op(edPatchOpNew));on('bEdTNew',op(edTerrOpNew));
  on('bEdPSet',op(edPatchOpPoint));on('bEdPMv',op(()=>edPatchOpMove(false)));on('bEdPCp',op(()=>edPatchOpMove(true)));
  on('bEdPTurn',op(edPatchOpTurn));on('bEdPFlip',op(edPatchOpFlip));on('bEdPDel',op(edPatchOpDelete));on('bEdPTex',op(edPatchOpTex));
  on('bEdTH',op(edTerrOpHeights));on('bEdTSm',op(edTerrOpSmooth));on('bEdTHill',op(edTerrOpHill));
  on('bEdTHole',op(()=>edTerrOpHoles(true)));on('bEdTFill',op(()=>edTerrOpHoles(false)));on('bEdTTex',op(edTerrOpTex));
  on('bEdTMv',op(()=>edTerrOpMove(false)));on('bEdTCp',op(()=>edTerrOpMove(true)));on('bEdTDel',op(edTerrOpDelete));
  // typing a point's or vertex's number shows that one
  const pick=(a,b,set)=>{for(const id of[a,b]){const el=$(id);if(el)el.addEventListener('change',()=>{const x=parseInt($(a).value,10),y=parseInt($(b).value,10);if(isFinite(x)&&isFinite(y)){set(x,y);lineDirty=true;requestDraw();edPanel();}});}};
  pick('edPj','edPi',(x,y)=>{ED.pp=[x,y];});pick('edTvi','edTvj',(x,y)=>{ED.tv=[x,y];});
}

// ---- the panel's brush part --------------------------------------------------------------
function edField(id,v,w){return '<input type="text" id="'+id+'" value="'+esc(String(v))+'" style="width:'+(w||52)+'px;padding:1px 3px;font:inherit;font-size:11px">';}
function edVecFields(pfx,v,w){return [0,1,2].map(k=>edField(pfx+k,fmt(v[k]),w)).join('');}
// Exact values' rows: a label column, then each box with its own small name (x y z, i j...),
// then the row's buttons (Enter in a box presses the row's first button)
const edCap=t=>'<span class="co" style="font-size:10px;margin-left:2px">'+t+'</span>';
const edLab=(t,tip)=>'<span style="flex:none;width:62px;padding-top:3px"'+(tip?' title="'+esc(tip)+'"':'')+'>'+t+'</span>';
function edLine(label,inner,tip){return'<div class="row" style="gap:3px;align-items:flex-start;margin-top:3px">'+edLab(label,tip)+
  '<span style="display:flex;flex-wrap:wrap;gap:3px;align-items:center;flex:1;min-width:0">'+inner+'</span></div>';}
function edXYZ(pfx,v,w){return [0,1,2].map(k=>edCap('xyz'[k])+edField(pfx+k,fmt(v[k]),w||44)).join('');}
function edHead(t){return'<div style="margin-top:8px;padding-top:4px;border-top:1px solid var(--line,#333)">'+t+'</div>';}
function edPanel(){
  const el=$('edBr');if(!el||typeof MAP==='undefined'||!MAP)return;
  const pr=edPrim();let h=edToolHtml();
  const tex=($('edTex')&&$('edTex').value)||'common/caulk';
  h+='<div class="row" style="gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px">Texture '+edField('edTex',tex,170)+'<button class="sm" id="bEdTex" title="Choose from the map\'s textures and the paks\': new brushes and cut faces get it, and so does what is selected (every face of a brush, a patch, a terrain block; one Undo). Selecting something puts its texture here.">Browse...</button>'+
     edSel('edTexP',TEXPRESETS,'')+'<button class="sm'+(ED.drop?' on':'')+'" id="bEdDrop" title="Eyedropper: click this, then click any surface in the view; its texture and tiling go into the Texture box and onto what is selected, and the Texture tool comes on to lay them with each click. Esc or a second click here cancels.">'+DROPICON+'</button></div>';
  h+=edClsHtml();
  h+=edJoinHtml();
  h+=edTileHtml();
  h+=edSelSummary();
  h+=edAngHtml();
  h+='<details id="edExact"'+(ED.exact?' open':'')+' style="margin-top:6px"><summary style="cursor:pointer" title="Every value typed in: sizes, corners, planes, control points, heights, texture shifts">Exact values</summary>';
  h+=edHead('<b>New</b> <span class="co">(on the surface straight ahead, with the Texture above)</span>');
  h+=edLine('Box',edXYZ('edNs',ED.ns||[64,64,64],40)+edBtn('bEdNewB','Add','A box this size (x y z) on the surface straight ahead, on the grid, with the texture above'),'A box: its size along x, y and z');
  h+=edNewHtml();
  const pp=pr?null:edPatch(),tp=pr?null:edTerr();
  if(pp)h+=edPatchHtml(pp);
  else if(tp)h+=edTerrHtml(tp);
  else if(pr){
    const faces=edFaces(pr),box=edBoxOf(faces);let bb=null;try{bb=edBounds(faces);}catch(_e){}
    h+=edHead('<b>Brush '+ED.sel.bn+'</b> of '+esc(ED.sel.ei===0?'the world':entName(ED.sel.ei))+' - '+faces.length+' faces'+(box?', a box':''));
    if(bb){h+=edLine('Min',edXYZ('edBmn',bb.mn),'The corner with the smallest x, y and z');
      h+=edLine('Max',edXYZ('edBmx',bb.mx)+'<button class="sm" id="bEdBox"'+(box?'':' disabled')+' title="'+(box?'Set the box\'s two corners to Min and Max':'Only a box can be sized by its corners: move its faces instead')+'">Set</button>','The corner with the largest x, y and z');}
    h+=edLine('Move by',edXYZ('edMv',ED.mv||[GRID.on?gridSize():16,0,0])+
       '<button class="sm" id="bEdMv" title="Move it by x y z">Move</button><button class="sm" id="bEdMvB" title="Move it back the other way">Back</button>'+
       '<button class="sm" id="bEdCp" title="A copy, moved by x y z">Copy</button>','How far to move it (or a copy) along x, y and z');
    h+=edLine('',
       '<label title="Keep each face\'s texture where it is on the wall as the brush moves"><input type="checkbox" id="edLock" '+(ED.lock===false?'':'checked')+'>texture lock</label>'+
       '<button class="sm" id="bEdDel" title="Delete this brush (Undo brings it back)">Delete</button>');
    h+=edLine('Clip at','<select id="edClAx" style="padding:2px 4px;font-size:11px"><option value="0">x =</option><option value="1">y =</option><option value="2" selected>z =</option><option value="pts">3 points</option></select>'+
       edField('edClV',bb?fmt((bb.mn[2]+bb.mx[2])/2):'0')+'<select id="edClKeep" style="padding:2px 4px;font-size:11px"><option value="below">keep below</option><option value="above">keep above</option></select>'+
       '<button class="sm" id="bEdCl" title="Cut the brush on this plane and keep one side; the new face gets the texture above">Clip</button>','Cut the brush on a flat plane (x, y or z at a value) or through three points')+
       '<div id="edClP" style="display:none">'+['a','b','c'].map((x,k)=>edLine('Point '+(k+1),edXYZ('edC'+x,[0,0,0]))).join('')+
       '<div class="co">the part behind the plane is kept (the points go clockwise seen from the side cut away, as in a .map)</div></div>';
    h+=edHead('Faces <span class="co">(click one in the view or here)</span>')+'<div style="max-height:150px;overflow:auto">';
    faces.forEach((f,k)=>{const pl=planeOf(f);h+='<div data-edf="'+k+'" class="'+(k===ED.face?'on ':'')+'it" style="cursor:pointer;padding:1px 4px'+(k===ED.face?';background:var(--onbg);color:var(--accent)':'')+'">'+(k+1)+'. ('+pl.slice(0,3).map(x=>fmt(x)).join(' ')+') at '+fmt(pl[3])+' - '+esc(f.tex)+'</div>';});
    h+='</div>';
    const f=faces[ED.face];
    if(f){h+=edHead('<b>Face '+(ED.face+1)+'</b> <span class="co">'+esc(f.tex)+'</span>')+
      edLine('Point 1',edXYZ('edFa',f.p.slice(0,3),52),'Three points on the face\'s plane, clockwise seen from outside the brush (as in a .map)')+
      edLine('Point 2',edXYZ('edFb',f.p.slice(3,6),52))+edLine('Point 3',edXYZ('edFc',f.p.slice(6,9),52))+
      (f.tm?'<div class="co">brush primitives texturing: its matrix is kept</div>':
      edLine('Shift',edCap('x')+edField('edFs0',fmt(f.sh[0]),48)+edCap('y')+edField('edFs1',fmt(f.sh[1]),48),'Where the texture starts, in texels across and up the face')+
      edLine('Rotate',edField('edFr',fmt(f.rot),48)+edCap('degrees'))+
      edLine('Scale',edCap('x')+edField('edFk0',fmt(f.sc[0]),48)+edCap('y')+edField('edFk1',fmt(f.sc[1]),48),'0.5 is the editor\'s default; 1 is twice as big; below 0 flips it'))+
      edLine('','<button class="sm" id="bEdF" title="Set the face\'s points and its texture\'s shift, rotate and scale to these">Set face</button>')+
      edLine('Push out',edField('edPush',GRID.on?gridSize():8,44)+'<button class="sm" id="bEdPush" title="Move the face along its normal (below 0: in)">Push</button>','Move the face this far out along its normal (below 0: in)')+
      edLine('','<button class="sm" id="bEdTall" title="The Texture box\'s texture on every face">Texture on all faces</button>');}
  }else h+='<div class="co" style="margin-top:4px">Select a brush, patch or terrain block to type its values here.</div>';
  h+='</details>';
  h+=edSpecHtml();
  h+=edEntBtns();
  h+='<div class="co" id="edBrSt" style="margin-top:4px"></div>';
  el.innerHTML=h;
  edToolBind(el);
  const txp=$('edTexP');if(txp)txp.onchange=()=>{if(txp.value){const tv=txp.value;$('edTex').value=tv;flash('Texture: '+tv+(tv==='common/hint'?' - a hint brush: hint on the faces that should split the map, skip on the rest':''));txp.value='';edTexApplyRun(tv);}txp.value='';};
  const dx=$('edExact');if(dx)dx.ontoggle=()=>{ED.exact=dx.open;};
  edSpecBind(el);
  const on=(id,fn)=>{const b=$(id);if(b)b.onclick=edRun(fn);};
  on('bEdNewB',()=>{ED.ns=edVec('edNs');edOpNew();});on('bEdBox',edOpBox);
  on('bEdMv',()=>{ED.mv=edVec('edMv');edOpMove(1);});on('bEdMvB',()=>{ED.mv=edVec('edMv');edOpMove(-1);});
  on('bEdCp',()=>{ED.mv=edVec('edMv');edOpCopy();});on('bEdDel',edOpDelete);on('bEdCl',edOpClip);
  on('bEdF',edOpFace);on('bEdPush',edOpPush);on('bEdTall',edOpTexAll);
  edPTBind(on);
  on('bEdTex',()=>edTexOpen('edTex'));on('bEdCls',edClsOpen);on('bEdJoin',()=>edJoin(+$('edJoinT').value));
  const ce=$('edCls');if(ce)ce.addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();e.stopImmediatePropagation();edRun(()=>edClsApply(ce.value))();});
  const dp=$('bEdDrop');if(dp)dp.onclick=()=>edDrop(!ED.drop);
  const lk=$('edLock');if(lk)lk.onchange=()=>{ED.lock=lk.checked;};
  on('bEdDelQ',()=>{if(!edDeleteSel())flash('Select a brush, patch or terrain block first');});
  on('bEdDelE',()=>{if(!edDeleteSel())flash('Select a brush, patch or terrain block first');});
  on('bEdParm',()=>{const ei=edSpecEnt();if(ei<0)throw new Error('select a brush entity first');
    const i=MOD.ents.indexOf(modRowFor(ei));if(i<0)throw new Error('it has no Modify row');
    if(MOD.edit>=0)modEditClose(true);modEditOpen(i);});
  on('bEdTrim',()=>edTrim());on('bEdTile',edTileSet);
  on('bEdAng',edAngTurn);on('bEdRotT',()=>edRotMode('rotate'));on('bEdAxesT',()=>edRotMode('axes'));
  el.querySelectorAll('input[id^="edTl"]').forEach(i=>i.addEventListener('change',()=>{try{ED.tileV=edTileRead();}catch(_e){}}));
  const cx=$('edClAx');if(cx)cx.onchange=()=>{$('edClP').style.display=cx.value==='pts'?'':'none';$('edClV').disabled=cx.value==='pts';};
  el.querySelectorAll('[data-edf]').forEach(d=>d.onclick=()=>{ED.face=+d.getAttribute('data-edf');edPanel();});
  // typing in the panel never moves the camera
  el.querySelectorAll('input,select').forEach(i=>i.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){const b=i.closest('.row')&&i.closest('.row').querySelector('button');if(b&&!b.disabled)b.click();}}));
}

// ==== the panel ==========================================================================
// What the page edits and where Save writes it, once the map has loaded (D is set by main).
function edNote(){
  const el=$('edNote');if(!el)return true;
  if(typeof D==='undefined'||!D||!MAP){el.textContent='Loading the map...';return false;}
  const kind=D.kind==='bsp'?'.bsp':'.map';
  try{edPanel();}catch(err){console.error(err);}
  const li=t=>'<li style="margin:2px 0">'+t+'</li>';
  el.innerHTML='<div>Editing <b>'+esc((D.name||'map')+kind)+'</b></div>'+
    '<ul style="margin:4px 0 0;padding-left:16px;line-height:1.35">'+
    li('<b>Compile...</b>: a .bsp of what you see, changes included; the .map it is built from is kept beside it')+
    li('Baked light comes back once it is compiled')+
    li('<b>Save as .map</b>: keeps your work to carry on later'+(D.kind==='bsp'?' (<b>Save as .bsp</b>: entity changes only)':''))+
    li('Nothing is written over this map without asking')+
    li('Doors, triggers and other brush entities change, move and delete as a whole (their origin: the middle of their brushes, or their origin brush)')+
    '</ul>';
  return true;
}
// Compile...: the launcher builds a .bsp from what the page shows. A .bsp's map, or any map
// with changes, goes as its text (the decompiled .map with every edit in it); the launcher
// asks where the .bsp goes and writes that text beside it as the .map it compiles.
function edCompileAsk(){
  if(MOD.edit>=0)modEditClose(true);
  if(MOD.trim)modTrim(false);
  const u=modUnsaved(),n=u?(u.nw||0)+(u.ch||0)+(u.br||0):0,changed=!!u||ED.n!==ED.saved;
  const req={unsaved:n,changed:changed,edN:ED.n,modKey:modSaveKey(),isBsp:D.kind==='bsp',name:D.name||'',src:D.srcFile||'',
    // always the text: "saved" can mean saved into a .map Compile wrote elsewhere, and the
    // launcher compares it with the file it would compile from
    mapText:modMapText()};
  if(post('mohaa-edit-compile\n'+JSON.stringify(req)))flash('Compile: choose how and where in the launcher');
  else flash('Compiling is done by the Map Viewer window (Edit map)');
}
// a compile wrote the page's text as the .map beside the .bsp: the changes it held are saved
function edCompiledSaved(n,key,path){
  if(n===ED.n){ED.saved=ED.n;try{edNewSync();}catch(_e){}}
  if(key===modSaveKey())MOD.savedKey=key;
  try{modBackupNow();}catch(_e){}
  const m='Compiled: the changes are in '+String(path||'the .map beside the .bsp');flash(m);
  try{$('modStat').textContent=m;}catch(_e){}
}
window.edCompileAsk=edCompileAsk;window.edCompiledSaved=edCompiledSaved;
// Shift+Esc: stop a compile that is running (the launcher asks first, and says when none is)
window.addEventListener('keydown',e=>{
  if(e.key!=='Escape'||!e.shiftKey||e.ctrlKey||e.altKey||e.metaKey)return;
  if(post('mohaa-edit-compile-stop')){e.preventDefault();e.stopPropagation();}},true);
function edSection(){
  const side=$('side');if(!side||$('edSect'))return;
  const s=document.createElement('div');s.className='sect';s.id='edSect';
  const host=inHost();
  s.innerHTML='<h2>Editor</h2>'+
    '<div class="row" style="gap:4px;flex-wrap:wrap">'+
    '<button class="sm" id="bEdNew"'+(host?'':' disabled')+' title="'+
    (host?'Start a new map: a sealed 512 x 512 x 256 room with a player start and a light, saved as a .map where you choose, then opened here (Ctrl+N in the launcher)'
         :'New map needs the Map Viewer window (Edit map), which writes the file and opens it')+'">New map...</button>'+
    '<button class="sm" id="bEdScr"'+(host?'':' disabled')+' title="'+
    (host?'Edit the map\'s level script (.scr) beside the map file: Save writes it (the old one kept as .bak) and builds the page again, so what it spawns is redrawn'
         :'The level script is edited from the Map Viewer window (Edit map), which reads and writes the file')+'">Level script...</button>'+
    '<button class="sm" id="bEdCmp"'+(host?'':' disabled')+' title="'+
    (host?'Build a .bsp from the map as you see it, changes included: bsp + vis + light, saved where you choose (F9 in the launcher). Shift+Esc stops a compile that is running, putting back the .map it wrote'
         :'Compiling is done by the Map Viewer window (Edit map), which runs the compiler')+'">Compile...</button>'+
    '</div><div class="co" id="edNote" style="margin-top:6px"></div><div class="co" id="edNote2" style="margin-top:4px;color:var(--warn)"></div>'+
    '<h2 style="margin-top:8px">Brushes, patches and terrain</h2><div id="edBr" style="font-size:11px"></div>';
  const mod=$('modSect');if(mod)MODHOME={p:mod.parentNode,n:mod.nextSibling};   // where it goes back to
  const first=side.querySelector('.sect');
  side.insertBefore(s,first?first.nextSibling:side.firstChild);
  $('bEdNew').onclick=edNew;$('bEdScr').onclick=scrOpen;
  $('bEdCmp').onclick=edCompileAsk;
  if(!edNote()){const t=setInterval(()=>{if(edNote())clearInterval(t);},250);}
  edMode(EON());
  // once main() has put the camera at its start, tell the launcher the page is ready
  const r=setInterval(()=>{const L=$('loading');
    if(typeof D!=='undefined'&&D&&MAP&&L&&L.style.display==='none'){clearInterval(r);post('mohaa-edit-ready\n'+JSON.stringify({map:D.name||''}));}},250);
}

// the mode, on or off in place: the Editor section shown with Modify moved up under it, or
// hidden with Modify back where the Map Viewer has it; off clears the editor's own selection
// and its marks (the leak trail stays)
let MODHOME=null,TITLE0=null;
// Edit map turned off: a brush entity's brushes picked one by one become the entity again,
// as a click selects it with the editor off (its SELECTION card, Open door...)
function edSelWhole(){
  if(typeof MAP==='undefined'||!MAP||!SEL.size)return;
  const out=new Set();let ch=false;
  for(const k of SEL){
    if(k[0]==='p'){const r=SC.prims[+k.slice(1)];if(r&&r.ent>0&&!isWorldlike(r.ent)){out.add('e'+r.ent);ch=true;continue;}}
    out.add(k);}
  if(!ch)return;
  SEL.clear();for(const k of out)SEL.add(k);
  if(lastHit&&lastHit.prim>=0&&SC.prims[lastHit.prim]&&!out.has('p'+lastHit.prim)&&!out.has('e'+lastHit.ent))lastHit=null;
  selectionChanged();}
function edMode(on){
  const s=$('edSect'),mod=$('modSect');
  if(s)s.style.display=on?'':'none';
  if(mod&&s){if(on)s.parentNode.insertBefore(mod,s.nextSibling);
    else if(MODHOME&&MODHOME.p)MODHOME.p.insertBefore(mod,MODHOME.n&&MODHOME.n.parentNode===MODHOME.p?MODHOME.n:null);}
  if(TITLE0==null)TITLE0=document.title.replace(/^Map Editor - /,'');
  document.title=on?'Map Editor - '+TITLE0:TITLE0;
  if(on){try{edPickSync();}catch(err){console.error(err);}}
  else{ED.sel=null;ED.face=-1;ED.pp=null;ED.tv=null;try{edSelWhole();}catch(err){console.error(err);}}
  try{if(typeof MAP!=='undefined'&&MAP){edPanel();lineDirty=true;requestDraw();}}catch(err){console.error(err);}
  // Modify takes more with the editor on (brush entities, a .bsp's static props): the
  // selection's rows and the note on what can't be taken, made again for the new mode
  try{if(typeof MAP!=='undefined'&&MAP)modSyncSel();}catch(err){console.error(err);}
  try{const sd=$('side');if(sd)sd.scrollTop=0;}catch(_e){}      // the panel from its top: the Editor section comes and goes
}
window.__EDITHOOKS__&&window.__EDITHOOKS__.push(edMode);

// what the editor holds, for the test harness and the console (read it; change it through the panel)
window.MOHAA_EDITOR_API={edTexHover:edTexHover,get txKey(){return _edTxKey;},edRotApply:edRotApply,edRotCenter:edRotCenter,edRotMode:edRotMode,edRingHit:edRingHit,edRotG:edRotG,edDrawShape:edDrawShape,get rot(){return EDROT;},edPatchTrimText:edPatchTrimText,edPatchAxes:edPatchAxes,edTrimBoxes:edTrimBoxes,edDrawTrim:edDrawTrim,edTrim:edTrim,edTrimKey:edTrimKey,edDeleteSel:edDeleteSel,edTileSet:edTileSet,edTileAt:edTileAt,edSelTile:edSelTile,edSetFaces:edSetFaces,edSelWhole:edSelWhole,edJoin:edJoin,edJoinHtml:edJoinHtml,edRzOutlines:edRzOutlines,get rzKey(){return _edRzKey;},get drag(){return EDDRAG;},ED:ED,edMoveDown:edMoveDown,edMoveSelDown:edMoveSelDown,edPrimOfHit:edPrimOfHit,edResizeHover:edResizeHover,edKeyOfPrim:edKeyOfPrim,edClsApply:edClsApply,edClsTargets:edClsTargets,edClsAll:edClsAll,edCopySet:edCopySet,edCarryStart:edCarryStart,edCarryPlace:edCarryPlace,edCarryEnd:edCarryEnd,edSelTex:edSelTex,edTexApplySel:edTexApplySel,edTexChoose:edTexChoose,edDrop:edDrop,edTexAt:edTexAt,edDropTake:edDropTake,edPaintDown:edPaintDown,edFaces:edFaces,edFaceLine:edFaceLine,edBounds:edBounds,edCheck:edCheck,edPanel:edPanel,brRow:brRow,edPatchData:edPatchData,edTerrData:edTerrData,edTerrSpan:edTerrSpan,edMarks:edMarks,edPatchFacing:edPatchFacing,edTerrFitSel:edTerrFitSel,edRegionSet:edRegionSet,edSetTerr:edSetTerr,terrHeightsMap:terrHeightsMap,
  edAddBrush:edAddBrush,edBoxFaces:edBoxFaces,edNew:()=>EDNEW,edNewLines:edNewLines,edNewSync:edNewSync};

try{edSection();}catch(err){console.error(err);}
})();
