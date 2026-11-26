'use strict';
let draftMedia=[], undoGroup=null;
// Adjacent parts share their endpoint in the continuous track.
let partStarts=[0];
function atNewPart(){
  return partStarts.length>1 && draft?.length===partStarts.at(-1)+1;
}
const kmLabel=n=>n.toLocaleString('ru-RU',{maximumFractionDigits:2})+' км';
function fuel(){
  const km=draft ? draft.at(-1)?.km : map?.distanceKm;
  const rate=el('fuelRate').valueAsNumber, price=el('fuelPrice').valueAsNumber;
  const litres=(km||0)*rate/100;
  el('fuelTotal').textContent=km && rate>0 && price>=0 ?
    kmLabel(km)+' · '+litres.toLocaleString('ru-RU',{maximumFractionDigits:2})+' л · '+
    (litres*price).toLocaleString('ru-RU',{style:'currency',currency:'RUB'}) : '';
}
function draftFileStore(action){
  return new Promise((resolve,reject)=>{
    const open=indexedDB.open('atlas-draft-files',1);
    open.onupgradeneeded=()=>open.result.createObjectStore('files');
    open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{
      const db=open.result, tx=db.transaction('files','readwrite');
      const request=action(tx.objectStore('files'));
      tx.oncomplete=()=>{db.close();resolve(request.result);};
      tx.onabort=()=>{db.close();reject(tx.error);};
    };
  });
}
function releaseDraftMedia(){
  for(const m of draftMedia) if(m.url) URL.revokeObjectURL(m.url);
  draftMedia=[];undoGroup=null;partStarts=[0];
}
function undoDraft(){
  if(busy || !draft?.length) return;
  if(atNewPart()){
    partStarts.pop();storeDraft();refreshDrawing();return;
  }
  const start=undoGroup?.end===draft.length ? undoGroup.start : draft.length-1;
  const removed=draftMedia.filter(m=>m.vertex>=start);
  if(removed.length && !confirm('Удалить точки и прикреплённые файлы ('+removed.length+')?')) return;
  for(const m of removed) if(m.url) URL.revokeObjectURL(m.url);
  draftMedia=draftMedia.filter(m=>m.vertex<start);
  draft.length=start;undoGroup=null;storeDraft();refreshDrawing();
}
function initPlanner(){
  el('fuelRate').oninput=el('fuelPrice').oninput=fuel;
  el('undoPoint').onclick=undoDraft;
  el('newPart').onclick=()=>{
    if(busy || !draft || draft.length<=partStarts.at(-1)+1) return;
    partStarts.push(draft.length-1);
    storeDraft();refreshDrawing();
  };
  el('reverseRoute').onclick=()=>{
    if(busy || !draft || draft.length<=partStarts.at(-1)+1) return;
    const start=draft.length;
    for(let i=start-2;i>=partStarts.at(-1);i--) draft.push(new DOMPoint(draft[i].x,draft[i].y));
    undoGroup={start,end:draft.length,label:'Отменить возврат'};storeDraft();refreshDrawing();
  };
  el('draftAttach').onclick=()=>{if(!busy && draft?.length) el('draftFile').click();};
  const hint=el('hoverKm');
  canvas.addEventListener('pointermove',event=>{
    hint.hidden=true;
    if(busy || animation || !map || event.buttons || event.pointerType!=='mouse') return;
    const {x,y,radius}=canvasPoint(event);
    const hits=map.hoverDistances(x,y,radius*.55,draft??undefined);
    if(!hits.length) return;
    hint.textContent=[...new Set(hits.map(kmLabel))].join(' · ');hint.hidden=false;
    const rect=el('stage').getBoundingClientRect();
    hint.style.left=Math.max(0,Math.min(rect.width-hint.offsetWidth,event.clientX-rect.left+8))+'px';
    hint.style.top=Math.max(0,event.clientY-rect.top-hint.offsetHeight-6)+'px';
  });
  canvas.addEventListener('pointerleave',()=>hint.hidden=true);
}
