'use strict';
const el = id => document.getElementById(id);
const canvas = el('canvas');
const demoPoints = [[45.813,9.083],[45.819,9.078],[45.834,9.076],[45.842,9.083],[45.847,9.097],[45.851,9.113],[45.859,9.119],[45.872,9.138],[45.884,9.145],[45.899,9.151],[45.914,9.145],[45.934,9.135],[45.943,9.127],[45.947,9.132],[45.953,9.151],[45.961,9.17],[45.965,9.186],[45.972,9.2],[45.979,9.212],[45.988,9.229],[45.992,9.244],[45.987,9.259]];
let trip = {name:'По озеру Комо',source:'Демонстрационный трек',demo:true,segments:[demoPoints.map(([lat,lon])=>({lat,lon}))]};
let map, portrait=false, progress=.48, animation=0, busy=false, recording=null, lastUrl='';
const controls=['file','wide','tall','duration','photoDuration','basemap','direction','zoomMode','mapZoom','endZoom','save','play','seek','recenter'];
const photos=[];
let fitTrack=false;
const photoSeconds=()=>Number(el('photoDuration').value);
const travelSeconds=()=>Number(el('duration').value);
const seconds=()=>travelSeconds()+photos.length*photoSeconds();
const flyover=()=>el('direction').value==='flyover';
const depart=.12, arrive=.76;
function cameraTime(at){return flyover()?depart+(arrive-depart)*at:at;}
function timeline(p){
  let elapsed=p*seconds();
  for(const photo of photos){
    const arrival=cameraTime(photo.at)*travelSeconds();
    if(elapsed<arrival) break;
    if(elapsed<arrival+photoSeconds()) return {at:photo.at,phase:cameraTime(photo.at),photo};
    elapsed-=photoSeconds();
  }
  const phase=Math.min(1,Math.max(0,elapsed/travelSeconds()));
  const at=flyover()?Math.min(1,Math.max(0,(phase-depart)/(arrive-depart))):phase;
  return {at,phase};
}
function locatePhoto(photo){
  const index=photos.indexOf(photo);
  const middle=cameraTime(photo.at)*travelSeconds()+(index+.5)*photoSeconds();
  stop();display(middle/seconds());
}
function updatePhotoList(){
  const list=el('photoList');
  list.replaceChildren();
  for(const photo of photos){
    const row=document.createElement('div');row.className='photoRow';
    const show=document.createElement('button'), remove=document.createElement('button');
    show.textContent=(photo.at*map.distanceKm).toLocaleString('ru-RU',{maximumFractionDigits:2})+' км · '+photo.name;
    show.onclick=()=>{if(!busy) locatePhoto(photo);};
    remove.textContent='Удалить';remove.setAttribute('aria-label','Удалить '+photo.name);
    remove.onclick=()=>{
      if(busy) return;
      stop();photos.splice(photos.indexOf(photo),1);updatePhotoList();clearDownload();display(progress);
    };
    row.append(show,remove);list.append(row);
  }
}
let photoAnchor;
function canvasPoint(event){
  const rect=canvas.getBoundingClientRect();
  const scale=Math.min(rect.width/canvas.width,rect.height/canvas.height);
  const x=(event.clientX-rect.left-(rect.width-canvas.width*scale)/2)/scale;
  const y=(event.clientY-rect.top-(rect.height-canvas.height*scale)/2)/scale;
  return {x,y,radius:12/scale};
}
let panX=0, panY=0, drag=null, suppressClick=false;
function resetPan(){
  panX=0;panY=0;
  el('recenter').hidden=true;
}
el('recenter').onclick=()=>{resetPan();display(progress);};
canvas.onpointerdown=event=>{
  if(event.pointerType!=='mouse' || event.button!==0 || busy || !map) return;
  suppressClick=false;
  drag={id:event.pointerId,x:event.clientX,y:event.clientY,panX,panY,moved:false};
  canvas.setPointerCapture(event.pointerId);
};
function movePan(event){
  const dx=event.clientX-drag.x, dy=event.clientY-drag.y;
  if(!drag.moved && Math.hypot(dx,dy)<5) return;
  if(!drag.moved){
    stop();drag.moved=true;suppressClick=true;canvas.classList.add('dragging');
  }
  const rect=canvas.getBoundingClientRect();
  const scale=Math.min(rect.width/canvas.width,rect.height/canvas.height);
  panX=drag.panX+dx/scale;panY=drag.panY+dy/scale;
  el('recenter').hidden=!(panX || panY);
  display(progress);
}
canvas.onpointermove=event=>{
  if(!busy && drag?.id===event.pointerId && (event.buttons & 1)) movePan(event);
};
function endDrag(event){
  if(drag?.id!==event.pointerId) return;
  if(!busy && event.type==='pointerup') movePan(event);
  drag=null;canvas.classList.remove('dragging');
  if(canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}
canvas.onpointerup=canvas.onpointercancel=canvas.onlostpointercapture=endDrag;
canvas.onclick=event=>{
  if(suppressClick || busy || !map) return;
  const {x,y,radius}=canvasPoint(event);
  if(map.photoAt(photos,x,y,radius)) return;
  stop();display(progress);
  photoAnchor=map.nearestPhotoPoint(x,y);
  if(photoAnchor) el('photoFile').click();
};
canvas.ondblclick=event=>{
  if(suppressClick || busy || !map) return;
  const {x,y,radius}=canvasPoint(event);
  const photo=map.photoAt(photos,x,y,radius);
  if(!photo) return;
  stop();display(progress);
  el('photoImage').replaceChildren(photo.bitmap);
  el('photoDialog').showModal();
};
el('photoFile').onchange=async event=>{
  const file=event.target.files[0];
  event.target.value='';
  if(!file||!photoAnchor||busy) return;
  lock(true);
  const url=URL.createObjectURL(file);
  try{
    const image=new Image();image.src=url;await image.decode();
    const ratio=Math.min(1,1920/Math.max(image.naturalWidth,image.naturalHeight));
    const bitmap=document.createElement('canvas');
    bitmap.width=Math.max(1,Math.round(image.naturalWidth*ratio));
    bitmap.height=Math.max(1,Math.round(image.naturalHeight*ratio));
    bitmap.getContext('2d').drawImage(image,0,0,bitmap.width,bitmap.height);
    const photo={...photoAnchor,bitmap,name:file.name};
    const {at:routeAt,phase}=timeline(progress);
    photos.push(photo);photos.sort((a,b)=>a.at-b.at);
    clearDownload();updatePhotoList();
    const holdsBefore=photos.filter(item=>item.at<routeAt).length;
    display((phase*travelSeconds()+holdsBefore*photoSeconds())/seconds());
    el('photoStatus').textContent='';
  }catch{el('photoStatus').textContent='Не удалось прочитать снимок. Попробуйте JPEG, PNG или WebP.';}
  finally{URL.revokeObjectURL(url);lock(false);photoAnchor=null;}
};
function lock(value) { busy=value; controls.forEach(id=>{el(id).disabled=value;}); }
function display(p) {
  progress=p;
  const frame=timeline(p);
  map.draw(canvas,frame.at,fitTrack ? 1 : Number(el('mapZoom').value),fitTrack || el('zoomMode').value==='fixed' ? 1 : Number(el('endZoom').value),travelSeconds(),photos,recording ? 0 : panX,recording ? 0 : panY,frame.phase,!fitTrack,el('zoomMode').value==='fixed');
  if(frame.photo && (animation || recording)){
    const ctx=canvas.getContext('2d'), img=frame.photo.bitmap;
    const scale=Math.min(canvas.width*.83/img.width,canvas.height*.75/img.height);
    const w=img.width*scale,h=img.height*scale,x=(canvas.width-w)/2,y=(canvas.height-h)/2;
    ctx.save();ctx.shadowColor='#0008';ctx.shadowBlur=18;ctx.fillStyle='white';
    ctx.fillRect(x-5,y-5,w+10,h+10);ctx.shadowBlur=0;
    ctx.drawImage(img,x,y,w,h);ctx.restore();
  }
  el('seek').value=Math.round(p*1000);
  const time=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
  el('clock').textContent=time(p*seconds())+' / '+time(seconds())+(seconds()%1?',5':'');
}
function stop() {
  cancelAnimationFrame(animation); animation=0;
  el('play').textContent='▶'; el('play').ariaLabel='Воспроизвести';
}
function clearDownload(){
  el('download').hidden=true;
  if(lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl='';
}
async function prepare(nextTrip, vertical, initial, autoplay=false) {
  stop(); lock(true); el('status').textContent='';
  try {
    const w=vertical?1080:1920, h=vertical?1920:1080;
    const satellite=el('basemap').value==='satellite';
    const next=await prepareMap(nextTrip.segments,w,h,{comoDemo:!!nextTrip.demo && !satellite, satellite, flyover:flyover(), follow:el('direction').value==='course',
      onTiles:()=>{if(map===next && !animation && !recording) display(progress);}});
    el('imageryCredit').hidden=!satellite;
    if(trip!==nextTrip){
      resetPan();fitTrack=true;photos.length=0;photoAnchor=null;updatePhotoList();el('photoStatus').textContent='';
    }
    map?.dispose();trip=nextTrip; map=next; portrait=vertical;
    canvas.width=w; canvas.height=h;
    el('stage').classList.toggle('portrait',vertical);
    el('wide').setAttribute('aria-pressed',String(!vertical));
    el('tall').setAttribute('aria-pressed',String(vertical));
    el('size').textContent=w+' × '+h;
    el('name').textContent=trip.name; el('source').textContent=trip.source;
    el('distance').textContent=map.distanceKm.toLocaleString('ru-RU',{maximumFractionDigits:1})+' км';
    clearDownload(); display(initial);
    el('importStatus').textContent=satellite?'Загружаются спутниковые снимки…':trip.demo?'':'Трек загружен. Загружается карта…';
    if(autoplay) togglePlay();
    next.waitForTiles().then(()=>{
      const count=next.loaded;
      if(map!==next) return;
      if(!recording) display(progress);
      if(satellite) el('importStatus').textContent=count?'Спутниковая подложка готова.':'Снимки недоступны. Выберите обычную карту или повторите загрузку.';
      else if(!trip.demo) el('importStatus').textContent=count?'Трек загружен.':'Трек загружен. Карта недоступна, показана координатная сетка.';
    });
  } catch(e){el('status').textContent=e.message;} finally{lock(false);}
}
function parseGPX(xml, filename){
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.documentElement.localName!=='gpx'||doc.getElementsByTagName('parsererror').length) throw Error('Файл не распознан. Выберите корректный GPX.');
  const segments=[];
  for(const [group,point] of [['trkseg','trkpt'],['rte','rtept']]){
    for(const parent of doc.getElementsByTagNameNS('*',group)){
      let path=[];
      function flush(){if(path.length>1) segments.push(path);path=[];}
      for(let child=parent.firstElementChild;child;child=child.nextElementSibling){
        if(child.localName!==point) continue;
        const coords=['lat','lon'].map(k=>child.getAttribute(k)?.trim());
        const [lat,lon]=coords.map(Number);
        if(coords.every(Boolean)&&Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180) path.push({lat,lon});
        else flush();
      }
      flush();
    }
    if(segments.length) break;
  }
  if(!segments.length) throw Error('В файле нужен трек или маршрут хотя бы с двумя точками.');
  const parent=doc.getElementsByTagNameNS('*','trk')[0]||doc.getElementsByTagNameNS('*','rte')[0];
  const name=Array.from(parent?.children||[]).find(e=>e.localName==='name')?.textContent?.trim()||filename.replace(/\.gpx$/i,'');
  return {segments,name,source:filename};
}
async function importFile(file){
  if(!file||busy) return;
  stop(); lock(true);
  el('importStatus').textContent='Читаю «'+file.name+'»…';
  try{
    const reader=new FileReader();
    const xml=await new Promise((resolve,reject)=>{
      reader.onload=()=>resolve(reader.result);
      reader.onerror=()=>reject(Error('Не удалось прочитать файл. Попробуйте выбрать его ещё раз.'));
      reader.readAsText(file);
    });
    const next=parseGPX(xml,file.name);
    await prepare(next,portrait,0);
  }
  catch(e){el('importStatus').textContent=file.name+' — '+e.message;}finally{lock(false);el('file').value='';}
}
el('file').onchange=e=>importFile(e.target.files[0]);
const stage=el('stage');
stage.ondragover=e=>{e.preventDefault();stage.classList.add('drag');};
stage.ondragleave=()=>stage.classList.remove('drag');
stage.ondrop=e=>{e.preventDefault();stage.classList.remove('drag');importFile(e.dataTransfer.files[0]);};
function updateCameraLabels(){
  el('zoomMode').options[0].textContent=flyover()?'Общий план на финише':'Приближение на старте и финише';
  el('endZoomGroup').querySelector('label').firstChild.textContent=flyover()?'Приближение во время поездки ':'Приближение у старта и финиша ';
}
updateCameraLabels();
el('basemap').onchange=el('direction').onchange=()=>{
  updateCameraLabels();prepare(trip,portrait,progress,Boolean(animation));
};
el('wide').onclick=()=>{if(portrait) prepare(trip,false,progress);};
el('tall').onclick=()=>{if(!portrait) prepare(trip,true,progress);};
el('seek').oninput=e=>{fitTrack=false;stop();display(e.target.value/1000);};
el('photoDuration').onchange=el('duration').onchange=()=>{stop();clearDownload();display(progress);};
el('zoomMode').onchange=()=>{
  el('endZoomGroup').hidden=el('zoomMode').value==='fixed';
  clearDownload();
  display(progress);
};
for(const id of ['mapZoom','endZoom']){
  el(id).oninput=()=>{
    fitTrack=false;
    el(id+'Value').value=Number(el(id).value).toLocaleString('ru-RU')+'×';
    clearDownload();
    display(progress);
  };
}
function togglePlay(){
  if(animation){stop();display(progress);return;}
  resetPan();fitTrack=false;
  const start=performance.now()-(progress>=1?0:progress)*seconds()*1000;
  el('play').textContent='Ⅱ'; el('play').ariaLabel='Пауза';
  function tick(t){const p=Math.min(1,Math.max(0,(t-start)/(seconds()*1000)));display(p);if(p<1) animation=requestAnimationFrame(tick);else stop();}
  animation=requestAnimationFrame(tick);
}
el('play').onclick=togglePlay;
el('cancel').onclick=()=>recording?.abort();
el('save').onclick=async()=>{
  if(!map||busy) return;
  const restoreFit=fitTrack;fitTrack=false;
  stop();lock(true);el('cancel').hidden=false;
  const restore=progress;recording=new AbortController();
  try{
    el('status').textContent='Подготовка видео…';
    display(0);
    await map.waitForTiles();
    if(recording.signal.aborted) throw new DOMException("Отменено","AbortError");
    const loaded=map.loaded;
    if(el('basemap').value==='satellite' && !loaded) throw Error('Снимки недоступны. Переключите тип карты и повторите экспорт.');
    const {blob,extension}=await recordTrip(canvas,seconds(),display,p=>{
      const status='Экспорт '+Math.round(100*p)+' %. Оставьте вкладку открытой.';
      if(el('status').textContent!==status) el('status').textContent=status;
    },recording.signal,()=>map.loading ? map.waitForTiles() : null);
    clearDownload();lastUrl=URL.createObjectURL(blob);
    const link=el('download');link.href=lastUrl;link.download=trip.name.replace(/[^\p{L}\d _.-]/gu,'_')+'.'+extension;
    link.hidden=false;link.click();el('status').textContent='Видео готово · '+extension.toUpperCase();
  }catch(e){el('status').textContent=e.name==='AbortError'?'Запись отменена.':e.message;}
  finally{fitTrack=restoreFit;recording=null;el('cancel').hidden=true;lock(false);display(restore);}
};
prepare(trip,false,progress);
