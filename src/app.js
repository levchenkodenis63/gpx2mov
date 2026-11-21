'use strict';
const el = id => document.getElementById(id);
const canvas = el('canvas');
let trip=null;
let map, portrait=false, progress=0, animation=0, busy=false, recording=null, lastUrl='';
const controls=['autoMedia','drawRoute','file','wide','tall','duration','photoDuration','basemap','direction','zoomMode','endZoom','save','play','seek','recenter'];
let draft=null;
const photos=[];
let fitTrack=false;
const photoSeconds=()=>Number(el('photoDuration').value);
const travelSeconds=()=>Number(el('duration').value);
const hold=item=>item.duration || photoSeconds();
const seconds=()=>photos.reduce((sum,item)=>sum+hold(item),travelSeconds());
let playingClip=null;
function pauseClip(){playingClip?.pause();playingClip=null;}
const flyover=()=>el('direction').value==='flyover';
const depart=.12, arrive=.76;
function cameraTime(at){return flyover()?depart+(arrive-depart)*at:at;}
function timeline(p){
  let elapsed=p*seconds();
  for(const photo of photos){
    const arrival=cameraTime(photo.at)*travelSeconds();
    if(elapsed<arrival) break;
    if(elapsed<arrival+hold(photo)) return {at:photo.at,phase:cameraTime(photo.at),photo,offset:elapsed-arrival};
    elapsed-=hold(photo);
  }
  const phase=Math.min(1,Math.max(0,elapsed/travelSeconds()));
  const at=flyover()?Math.min(1,Math.max(0,(phase-depart)/(arrive-depart))):phase;
  return {at,phase};
}
const mobileMenu=el('mobileMenu');
const narrowScreen=matchMedia('(max-width:700px)');
const menuItems=[
  document.querySelector('.settings'),
  el('installApp'), el('routeInputs')
].map(item=>{
  const home=document.createComment('menu item');
  item.before(home);
  return {item,home};
});
function closeMobileMenu(){
  if(mobileMenu.open) mobileMenu.close();
}
function placeMenuItems(){
  closeMobileMenu();
  for(const {item,home} of menuItems){
    if(narrowScreen.matches){
      el(item.id==='routeInputs'?'mobileDrawControls':'menuControls').append(item);
    }
    else home.after(item);
  }
}
el('openMenu').onclick=()=>{
  mobileMenu.showModal();
  mobileMenu.scrollTop=0;
};
narrowScreen.addEventListener('change',()=>{placeMenuItems();if(map && !recording) display(progress);});
placeMenuItems();

function locatePhoto(photo){
  closeMobileMenu();
  const index=photos.indexOf(photo);
  const middle=cameraTime(photo.at)*travelSeconds()+photos.slice(0,index).reduce((sum,item)=>sum+hold(item),hold(photo)/2);
  stop();display(middle/seconds());
}
function updatePhotoList(){
  const list=el('photoList');
  list.replaceChildren();
  el('mediaTable').hidden=!photos.length;
  for(const photo of photos){
    const row=list.insertRow();
    const show=document.createElement('button'), remove=document.createElement('button');
    show.textContent=photo.name;
    const km=document.createElement('input');
    km.inputMode='decimal';
    km.setAttribute('aria-label','Километр от старта для '+photo.name);
    const format=value=>value.toLocaleString('ru-RU',{maximumFractionDigits:3,useGrouping:false});
    km.value=format(photo.at*map.distanceKm);
    km.onkeydown=event=>{
      if(event.key==='Escape') km.value=format(photo.at*map.distanceKm);
      if(event.key==='Enter' || event.key==='Escape') km.blur();
    };
    km.onchange=()=>{
      const value=km.value.trim().replace(',','.');
      const distance=Number(value);
      if(busy){km.value=format(photo.at*map.distanceKm);return;}
      if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || distance>Math.ceil(map.distanceKm*1000)/1000){
        el('photoStatus').textContent='Введите расстояние от 0 до '+format(map.distanceKm)+' км.';
        km.value=format(photo.at*map.distanceKm);
        return;
      }
      Object.assign(photo,map.anchorAtKm(Math.min(distance,map.distanceKm)));
      photos.sort((a,b)=>a.at-b.at);
      clearDownload();updatePhotoList();locatePhoto(photo);
      el('photoStatus').textContent=photo.name+' — '+format(photo.at*map.distanceKm)+' км';
    };
    show.onclick=()=>{if(!busy) locatePhoto(photo);};
    remove.textContent='Удалить';remove.setAttribute('aria-label','Удалить '+photo.name);
    remove.onclick=()=>{
      if(busy) return;
      stop();photos.splice(photos.indexOf(photo),1);if(photo.url) URL.revokeObjectURL(photo.url);updatePhotoList();clearDownload();display(progress);
    };
    for(const control of [show,km,remove]) row.insertCell().append(control);
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
}
const locationStatus=el('locationStatus');
let centerRequest=0;
function updateCenterButton(){
  const label=(draft ? draft.length : trip) ? 'Показать маршрут целиком' : 'Показать моё местоположение';
  el('recenter').title=label;
  el('recenter').setAttribute('aria-label',label);
}
function centerView(world,level){
  resetPan();fitTrack=true;
  previewLevel=Math.max(0,Math.min(map.maxLevel,level));
  display(progress,{x:canvas.width/2,y:canvas.height/2,world,shift(dx,dy){panX+=dx;panY+=dy;}});
}
el('recenter').onclick=()=>{
  if(!map || busy) return;
  const request=++centerRequest, currentMap=map, currentDraft=draft;
  stop();
  locationStatus.hidden=true;
  if(draft ? draft.length : trip){
    const {world,level}=map.routeView(draft,visibleFrameHeight());
    centerView(world,level);
    return;
  }
  const finish=(position)=>{
    if(request!==centerRequest || busy || map!==currentMap || draft!==currentDraft || draft?.length) return;
    const location=position ? {lat:position.coords.latitude,lon:position.coords.longitude} : {lat:55.7558,lon:37.6173};
    centerView(map.pointFor(location),position ? map.level : 3);
    locationStatus.textContent=position ? '' : 'Геопозиция недоступна. Карта центрирована по Москве.';
    locationStatus.hidden=!!position;
  };
  if(!navigator.geolocation){finish(null);return;}
  locationStatus.textContent='Определяем местоположение…';
  locationStatus.hidden=false;
  navigator.geolocation.getCurrentPosition(finish,()=>finish(null),{timeout:10000,maximumAge:60000});
};
let selectedLevel=null, previewLevel=null;
function zoomLimits(){
  el('zoomIn').disabled=busy || !map || map.level>=map.maxLevel-1e-6;
  el('zoomOut').disabled=busy || !map || map.level<=1e-6;
  if(map) el('levelReadout').value='z'+Math.round(map.level);
}
function setMapZoom(value,point,world){
  if(busy || !map) return;
  const level=Math.max(0,Math.min(map.maxLevel,value));
  const base=fitTrack ? map.level : (selectedLevel ?? map.baseLevel);
  selectedLevel=Math.max(0,Math.min(map.maxLevel,base+level-map.level));
  previewLevel=level;
  stop();fitTrack=false;
  clearDownload();
  display(progress,{...point,world,shift(dx,dy){
    panX+=dx;panY+=dy;
  }});
  zoomLimits();
}
function zoomFrom(value,point){
  if(!busy && map) setMapZoom(value,point,map.worldAt(point.x,point.y));
}
for(const [id,step] of [['zoomIn',1],['zoomOut',-1]]){
  el(id).onclick=()=>zoomFrom(step>0 ? Math.floor(map.level+1e-6)+1 : Math.ceil(map.level-1e-6)-1,{x:canvas.width/2,y:canvas.height/2});
}
let wheelFrame=0,wheelDelta=0,wheelPoint;
canvas.addEventListener('wheel',event=>{
  if(busy || !map) return;
  event.preventDefault();
  const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?canvas.clientHeight:1);
  wheelDelta+=pixels;wheelPoint=canvasPoint(event);
  if(!wheelFrame) wheelFrame=requestAnimationFrame(()=>{
    wheelFrame=0;
    const change=wheelDelta*.004;wheelDelta=0;
    if(!busy && map) zoomFrom(map.level-change,wheelPoint);
  });
},{passive:false});

const touches=new Map();
let pinch=null;
function touchPair(){
  const [a,b]=touches.values();
  const center=canvasPoint({clientX:(a.x+b.x)/2,clientY:(a.y+b.y)/2});
  return {center,distance:Math.hypot(a.x-b.x,a.y-b.y)};
}
function startPinch(){
  const {center,distance}=touchPair();
  pinch={distance:Math.max(1,distance),zoom:map.level,world:map.worldAt(center.x,center.y)};
  suppressClick=true;stop();
}
function beginPan(id,x,y){
  drag={id,x,y,panX,panY,moved:false};
}
let lastTap=null, lastPointerType='';
function handlePhotoTap(event,touch){
  if(!trip || draft || busy || suppressClick || event.type!=='pointerup'){
    lastTap=null;
    return;
  }
  const {clientX:x,clientY:y,timeStamp:time}=event;
  const held=time-touch.downAt>=550;
  const doubleTap=lastTap && lastTap.map===map && time-lastTap.time<=450 &&
    Math.hypot(x-lastTap.x,y-lastTap.y)<=28;
  if(held || doubleTap){
    lastTap=null;
    activatePhoto(event);
  }else{
    lastTap={map,x,y,time};
  }
}
canvas.oncontextmenu=event=>{
  if(lastPointerType==='touch') event.preventDefault();
};
canvas.onpointerdown=event=>{
  lastPointerType=event.pointerType;
  if(lastPointerType!=='touch') lastTap=null;
  if(event.pointerType==='touch' && !busy && map){
    if(!touches.size) suppressClick=false;
    touches.set(event.pointerId,{x:event.clientX,y:event.clientY,downAt:event.timeStamp});
    canvas.setPointerCapture(event.pointerId);
    if(touches.size===1) beginPan(event.pointerId,event.clientX,event.clientY);
    if(touches.size===2){
      drag=null;canvas.classList.remove('dragging');startPinch();
    }
    return;
  }
  if(event.pointerType!=='mouse' || event.button!==0 || busy || !map) return;
  suppressClick=false;
  beginPan(event.pointerId,event.clientX,event.clientY);
  canvas.setPointerCapture(event.pointerId);
};
function movePan(event){
  const dx=event.clientX-drag.x, dy=event.clientY-drag.y;
  if(!drag.moved && Math.hypot(dx,dy)<(event.pointerType==='touch'?10:5)) return;
  if(!drag.moved){
    stop();drag.moved=true;suppressClick=true;canvas.classList.add('dragging');
  }
  const rect=canvas.getBoundingClientRect();
  const scale=Math.min(rect.width/canvas.width,rect.height/canvas.height);
  panX=drag.panX+dx/scale;panY=drag.panY+dy/scale;
  display(progress);
}
canvas.onpointermove=event=>{
  const touch=touches.get(event.pointerId);
  if(touch){
    touch.x=event.clientX;touch.y=event.clientY;
    if(!busy && drag?.id===event.pointerId) movePan(event);
    if(pinch && !busy){
      const {center,distance}=touchPair();
      setMapZoom(pinch.zoom+Math.log2(Math.max(1,distance)/pinch.distance),center,pinch.world);
    }
    return;
  }
  if(!busy && drag?.id===event.pointerId && (event.buttons & 1)) movePan(event);
};
function endDrag(event){
  const touch=touches.get(event.pointerId);
  if(touch){
    touches.delete(event.pointerId);
    if(!busy && drag?.id===event.pointerId && event.type==='pointerup') movePan(event);
    handlePhotoTap(event,touch);
    pinch=null;drag=null;canvas.classList.remove('dragging');
    if(touches.size===1){
      const [[id,point]]=touches;
      beginPan(id,point.x,point.y);
    }else if(touches.size>=2 && map && !busy) startPinch();
    return;
  }
  if(drag?.id!==event.pointerId) return;
  if(!busy && event.type==='pointerup') movePan(event);
  drag=null;canvas.classList.remove('dragging');
  if(canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}
canvas.onpointerup=canvas.onpointercancel=canvas.onlostpointercapture=endDrag;
function refreshDrawing(){
  centerRequest++;locationStatus.hidden=true;updateCenterButton();
  const drawing=draft!==null;
  el('drawRoute').hidden=drawing;
  el('drawTools').hidden=!drawing;
  el('photoPanel').hidden=drawing || !trip;
  canvas.classList.toggle('drawing',drawing);
  el('finishRoute').disabled=(draft?.length ?? 0)<2;
  el('undoPoint').disabled=!draft?.length;
  lock(false);
  display(progress);
}
el('drawRoute').onclick=()=>{closeMobileMenu();stop();draft=[];refreshDrawing();};
el('undoPoint').onclick=()=>{draft.pop();refreshDrawing();};
el('cancelRoute').onclick=()=>{draft=null;refreshDrawing();};
el('finishRoute').onclick=()=>{
  closeMobileMenu();
  const segments=[draft.map(map.locationOf)];
  draft=null;
  refreshDrawing();
  prepare({segments,name:'Ручной маршрут',source:'Нарисован на карте'},portrait,0);
};
canvas.onclick=event=>{
  if(!draft || busy || suppressClick || event.detail>1) return;
  const {x,y}=canvasPoint(event);
  const point=map.worldAt(x,y);
  const last=draft.at(-1);
  if(last && Math.hypot(last.x-point.x,last.y-point.y)<1e-8) return;
  draft.push(point);
  refreshDrawing();
};
function activatePhoto(event){
  if(draft || suppressClick || busy || !trip || !map) return;
  const {x,y,radius}=canvasPoint(event);
  const photo=map.photoAt(photos,x,y,radius);
  stop();
  if(photo){
    photoAnchor={at:photo.at,index:photo.index,t:photo.t};
    const group=photos.filter(item=>item.at===photo.at);
    el('photoImage').replaceChildren(...group.map(item=>{
      if(!item.duration) return item.bitmap;
      const player=document.createElement('video');player.src=item.url;player.controls=true;player.playsInline=true;
      return player;
    }));
    el('photoDialog').showModal();
  }else{
    photoAnchor=map.nearestPhotoPoint(x,y);
    if(photoAnchor) el('photoFile').click();
  }
}
canvas.ondblclick=event=>{
  if(lastPointerType!=='touch') activatePhoto(event);
};
el('photoDialog').onclose=()=>el('photoImage').replaceChildren();
el('appendMedia').onclick=()=>{el('photoDialog').close();el('photoFile').click();};
el('mediaLoading').oncancel=event=>event.preventDefault();
el('autoMedia').onchange=el('photoFile').onchange=async event=>{
  const files=Array.from(event.target.files), auto=event.target.id==='autoMedia';
  event.target.value='';
  if(!files.length || !trip || busy || (!auto && !photoAnchor)) return;
  stop();lock(true);
  const skipped=[];
  const loader=el('mediaLoading'), progressBar=el('mediaProgress');
  progressBar.max=files.length;
  progressBar.value=0;
  try{
    loader.showModal();
    for(const [index,file] of files.entries()){
      el('mediaLoadingFile').textContent='Файл '+(index+1)+' из '+files.length+' · '+file.name;
      try{
        const anchor=auto ? map.mediaAnchor(await mediaTags(file)) : photoAnchor;
        if(!anchor) throw Error('Нет привязки к маршруту');
        photos.push({...anchor,...await loadMedia(file),name:file.name});
      }catch(error){skipped.push(file.name+' — '+(error?.message || 'Не удалось прочитать файл'));}
      progressBar.value=index+1;
    }
    photos.sort((a,b)=>a.at-b.at);
    clearDownload();updatePhotoList();display(0);
    el('photoStatus').textContent='Добавлено: '+(files.length-skipped.length)+'. '+(skipped.length?'Пропущены: '+skipped.join(', '):'');
  }finally{loader.close();lock(false);photoAnchor=null;}
};
function lock(value) { busy=value; controls.forEach(id=>{el(id).disabled=value || (draft!==null && id!=='recenter') || (!trip && ['save','play','seek'].includes(id));}); zoomLimits(); }
function visibleFrameHeight(){
  return portrait && narrowScreen.matches && !recording ? canvas.width*5/4 : canvas.height;
}
function display(p,focus=null,exact=false) {
  progress=p;
  const frame=timeline(p);
  const previewHeight=visibleFrameHeight();
  const crop=(canvas.height-previewHeight)/2;
  map.draw(canvas,frame.at,fitTrack || selectedLevel===null ? 1 : 2**(selectedLevel-map.baseLevel),!trip || fitTrack || el('zoomMode').value==='fixed' ? 1 : Number(el('endZoom').value),travelSeconds(),draft ? [] : photos,recording ? 0 : panX,recording ? 0 : panY,frame.phase,!fitTrack,el('zoomMode').value==='fixed',focus,recording ? null : previewLevel,draft,crop);
  zoomLimits();
  const clip=frame.photo?.duration && (animation || recording) ? frame.photo.bitmap : null;
  if(playingClip && playingClip!==clip) pauseClip();
  if(clip && !exact && playingClip!==clip){
    playingClip=clip;clip.currentTime=frame.offset;clip.play().catch(()=>{});
  }
  if(frame.photo && (animation || recording)){
    const ctx=canvas.getContext('2d'), img=frame.photo.bitmap;
    const scale=Math.min(canvas.width*.83/(img.videoWidth||img.width),previewHeight*.75/(img.videoHeight||img.height));
    const w=(img.videoWidth||img.width)*scale,h=(img.videoHeight||img.height)*scale,x=(canvas.width-w)/2,y=(canvas.height-h)/2;
    ctx.save();ctx.shadowColor='#0008';ctx.shadowBlur=18;ctx.fillStyle='white';
    ctx.fillRect(x-5,y-5,w+10,h+10);ctx.shadowBlur=0;
    ctx.drawImage(img,x,y,w,h);ctx.restore();
  }
  el('seek').value=Math.round(p*1000);
  const time=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
  el('clock').textContent=!trip ? '0:00' : time(p*seconds())+' / '+time(seconds())+(seconds()%1?',5':'');
}
function stop() {
  pauseClip();
  cancelAnimationFrame(animation); animation=0;
  el('play').textContent='▶'; el('play').ariaLabel='Воспроизвести';
}
function clearDownload(){
  el('download').hidden=true;
  if(lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl='';
}
async function prepare(nextTrip, vertical, initial, autoplay=false) {
  centerRequest++;locationStatus.hidden=true;
  stop(); lock(true); el('status').textContent='';
  try {
    const w=vertical?1080:1920, h=vertical?1920:1080;
    const satellite=el('basemap').value==='satellite';
    const next=await prepareMap(nextTrip?.segments ?? [],w,h,{satellite, flyover:!!nextTrip && flyover(), follow:!!nextTrip && el('direction').value==='course',
      onTiles:()=>{if(map===next && !animation && !recording) display(progress);}});
    el('imageryCredit').hidden=!satellite;
    el('localCredit').hidden=satellite || location.protocol!=='file:';
    if(trip!==nextTrip){
      resetPan();selectedLevel=previewLevel=null;fitTrack=true;for(const item of photos) if(item.url) URL.revokeObjectURL(item.url);photos.length=0;photoAnchor=null;updatePhotoList();el('photoStatus').textContent='';
    }
    if(selectedLevel!==null) selectedLevel=Math.min(next.maxLevel,selectedLevel);
    if(previewLevel!==null) previewLevel=Math.min(next.maxLevel,previewLevel);
    map?.dispose();trip=nextTrip; map=next; portrait=vertical;
    canvas.width=w; canvas.height=h;
    el('stage').classList.toggle('portrait',vertical);
    el('wide').setAttribute('aria-pressed',String(!vertical));
    el('tall').setAttribute('aria-pressed',String(vertical));
    el('size').textContent=w+' × '+h;
    el('name').textContent=trip?.name ?? 'Обзорная карта';
    el('source').textContent=trip?.source ?? 'Загрузите GPX или нарисуйте маршрут на карте.';
    updateCenterButton();
    el('photoPanel').hidden=!trip;
    el('distance').textContent=trip ? map.distanceKm.toLocaleString('ru-RU',{maximumFractionDigits:1})+' км' : '';
    clearDownload(); display(initial);
    el('importStatus').textContent=satellite?'Загружаются спутниковые снимки…':!trip?'':'Трек загружен. Загружается карта…';
    if(autoplay) togglePlay();
    next.waitForTiles().then(()=>{
      const count=next.loaded;
      if(map!==next) return;
      if(!recording) display(progress);
      if(satellite) el('importStatus').textContent=count?'Спутниковая подложка готова.':'Снимки недоступны. Выберите обычную карту или повторите загрузку.';
      else if(trip) el('importStatus').textContent=count?'Трек загружен.':'Трек загружен. Карта недоступна, показана координатная сетка.';
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
        if(coords.every(Boolean)&&Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180) path.push({lat,lon,time:Date.parse(child.getElementsByTagNameNS('*','time')[0]?.textContent)});
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
  if(!file||busy||draft) return;
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
    if(trip===next) closeMobileMenu();
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
el('seek').oninput=e=>{previewLevel=null;fitTrack=false;stop();display(e.target.value/1000);};
el('photoDuration').onchange=el('duration').onchange=()=>{stop();clearDownload();display(progress);};
el('zoomMode').onchange=()=>{
  previewLevel=null;
  el('endZoomGroup').hidden=el('zoomMode').value==='fixed';
  clearDownload();
  display(progress);
};
el('endZoom').oninput=()=>{
    previewLevel=null;
    fitTrack=false;
    zoomLimits();
    el('endZoomValue').value=Number(el('endZoom').value).toLocaleString('ru-RU')+'×';
    clearDownload();
    display(progress);
};
function togglePlay(){
  if(animation){stop();display(progress);return;}
  resetPan();previewLevel=null;fitTrack=false;
  const start=performance.now()-(progress>=1?0:progress)*seconds()*1000;
  el('play').textContent='Ⅱ'; el('play').ariaLabel='Пауза';
  function tick(t){const p=Math.min(1,Math.max(0,(t-start)/(seconds()*1000)));display(p);if(p<1) animation=requestAnimationFrame(tick);else stop();}
  animation=requestAnimationFrame(tick);
}
el('play').onclick=()=>{closeMobileMenu();togglePlay();};
el('cancel').onclick=()=>recording?.abort();
el('save').onclick=async()=>{
  if(!trip||!map||busy) return;
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
    const {blob,extension}=await recordTrip(canvas,seconds(),(p,exact)=>{
      const frame=timeline(p);
      if(exact && frame.photo?.duration){
        pauseClip();
        return seekClip(frame.photo.bitmap,frame.offset).then(()=>display(p,null,true));
      }
      display(p,null,exact);
    },p=>{
      const status='Экспорт '+Math.round(100*p)+' %. Оставьте вкладку открытой.';
      if(el('status').textContent!==status) el('status').textContent=status;
    },recording.signal,()=>map.loading ? map.waitForTiles() : null);
    clearDownload();lastUrl=URL.createObjectURL(blob);
    const link=el('download');link.href=lastUrl;link.download=trip.name.replace(/[^\p{L}\d _.-]/gu,'_')+'.'+extension;
    link.hidden=false;link.click();el('status').textContent='Видео готово · '+extension.toUpperCase();
  }catch(e){el('status').textContent=e.name==='AbortError'?'Запись отменена.':e.message;}
  finally{pauseClip();fitTrack=restoreFit;recording=null;el('cancel').hidden=true;lock(false);display(restore);}
};
prepare(trip,narrowScreen.matches,progress);

// The browser releases the screen lock automatically when the app is hidden.
if ('wakeLock' in navigator) {
  let screenLock;
  let requesting=false;
  async function keepScreenOn(){
    if(document.visibilityState!=='visible' || requesting || (screenLock && !screenLock.released)) return;
    requesting=true;
    try{
      screenLock=await navigator.wakeLock.request('screen');
    }catch(error){
      console.debug('Удержание экрана недоступно:',error.name);
    }finally{requesting=false;}
  }
  document.addEventListener('visibilitychange',keepScreenOn);
  window.addEventListener('pageshow',keepScreenOn);
  document.addEventListener('pointerup',keepScreenOn);
  keepScreenOn();
}
