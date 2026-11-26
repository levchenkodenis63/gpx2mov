'use strict';
{
  let roadController=null, roadResult=null;
async function roadQuery(path,options={}){
  const response=await fetch('https://api.heigit.org/'+path,{
    ...options,signal:roadController.signal,headers:{Authorization:el('orsKey').value.trim(),...options.headers}
  });
  if(!response.ok) throw Error(response.status===403||response.status===401?'Проверьте ключ HeiGIT.':response.status===429?'Исчерпан лимит запросов.':'Сервис маршрутизации вернул ошибку '+response.status);
  return response.json();
}
async function city(text){
  const query=new URLSearchParams({text:text.trim(),size:'1',lang:'ru'});
  const data=await roadQuery('pelias/v1/search?'+query);
  const first=data.features?.[0];
  if(!first) throw Error('Место не найдено: '+text);
  return {coords:first.geometry.coordinates,label:first.properties.label};
}
function roadOutline(coords){
  const c=el('roadPreview'),ctx=c.getContext('2d');
  const xy=coords.map(([lon,lat])=>[lon,-Math.asinh(Math.tan(Math.min(85,Math.max(-85,lat))*Math.PI/180))*180/Math.PI]);
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const [x,y] of xy){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
  const scale=Math.min((c.width-24)/(x1-x0||1e-9),(c.height-24)/(y1-y0||1e-9));
  ctx.clearRect(0,0,c.width,c.height);ctx.beginPath();
  xy.forEach(([x,y],i)=>ctx[i?'lineTo':'moveTo']((x-(x1+x0)/2)*scale+c.width/2,(y-(y1+y0)/2)*scale+c.height/2));
  ctx.lineWidth=3;ctx.strokeStyle='#53714e';ctx.stroke();c.hidden=false;
}
  const clearRoad=()=>{roadResult=null;el('roadAdd').hidden=el('roadPreview').hidden=true;el('roadInfo').textContent='';};
  el('road').onclick=()=>{
    if(busy || !map) return;
    clearRoad();el('roadFrom').disabled=!!draft?.length;el('roadFrom').required=!draft?.length;
    el('fromLabel').hidden=!!draft?.length;el('roadTo').value='';
    el('roadDialog').showModal();
  };
  el('roadForm').oninput=()=>{roadController?.abort();clearRoad();};
  el('roadForm').onsubmit=async e=>{
    e.preventDefault();clearRoad();
    const controller=new AbortController();roadController=controller;
    const timer=setTimeout(()=>controller.abort(),30000);
    el('roadBuild').disabled=true;el('roadInfo').textContent='Строим маршрут…';
    try{
      const last=draft?.length && map.locationOf(draft.at(-1));
      const from=last?{coords:[last.lon,last.lat],label:'Последняя точка'}:await city(el('roadFrom').value);
      const to=await city(el('roadTo').value);
      const data=await roadQuery('openrouteservice/v2/directions/driving-car/geojson',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({coordinates:[from.coords,to.coords],instructions:false})
      });
      const feature=data.features?.[0], coords=feature?.geometry?.coordinates;
      if(!Array.isArray(coords)||coords.length<2 || !coords.every(p=>Number.isFinite(p[0])&&Number.isFinite(p[1]))) throw Error('Сервис не нашёл дорогу.');
      controller.signal.throwIfAborted();
      roadOutline(coords);roadResult=coords;el('roadAdd').hidden=false;
      el('roadInfo').textContent=from.label+' → '+to.label+' · '+kmLabel(feature.properties.summary.distance/1000);
    }catch(error){el('roadInfo').textContent=controller.signal.aborted?'Запрос прерван. Можно повторить.':error.message;}
    finally{clearTimeout(timer);el('roadBuild').disabled=false;roadController=null;}
  };
  el('roadClose').onclick=()=>el('roadDialog').close();
  el('roadDialog').onclose=()=>roadController?.abort();
  el('roadAdd').onclick=()=>{
    if(!roadResult || busy) return;
    if(!draft){stop();releaseDraftMedia();draft=[];}
    const start=draft.length;
    for(const [lon,lat] of roadResult){
      const last=draft.at(-1),p=map.pointFor({lat,lon},last);
      if(!last || Math.hypot(p.x-last.x,p.y-last.y)>1e-8) draft.push(p);
    }
    undoGroup={start,end:draft.length,label:'Отменить участок'};
    storeDraft();refreshDrawing();el('roadDialog').close();el('recenter').click();
  };
}
