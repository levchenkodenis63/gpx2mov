(() => {
  'use strict';
  const TILE = 256;
  const RAD = Math.PI / 180;
  const ORANGE = '#ee642c';

  function layer(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function kilometres(a, b) {
    const lat = Math.sin((b.lat - a.lat) * RAD / 2);
    const lon = Math.sin((b.lon - a.lon) * RAD / 2);
    const h = lat * lat + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * lon * lon;
    return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
  }

  // Keep the projection continuous across the antimeridian.
  function project(point, near) {
    let x = (point.lon + 180) / 360;
    if (near !== undefined) x += Math.round(near - x);
    const lat = Math.max(-85.05112878, Math.min(85.05112878, point.lat)) * RAD;
    return { x, y: (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 };
  }

  const localMap = location.protocol === "file:";
  const tileCache = new Map();

  function loadTile(z, x, y, satellite) {
    const key = satellite || localMap
      ? `https://tiles.maps.eox.at/wmts/1.0.0/${satellite ? "s2cloudless-2025_3857" : "osm_3857"}/default/g/${z}/${y}/${x}.jpg`
      : `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    if (tileCache.has(key)) return tileCache.get(key);
    const pending = (async()=>{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),12000);
      let url;
      try{
        const response=await fetch(key,{signal:controller.signal});
        if(!response.ok) return null;
        url=URL.createObjectURL(await response.blob());
        const image=new Image();image.src=url;await image.decode();
        return image;
      } catch {return null;}
      finally{clearTimeout(timer);if(url) URL.revokeObjectURL(url);}
    })();
    tileCache.set(key, pending);
    if (tileCache.size > 180) tileCache.delete(tileCache.keys().next().value);
    pending.then(img => {
      if (!img && tileCache.get(key) === pending) tileCache.delete(key);
    });
    return pending;
  }

  window.prepareMap = async function prepareMap(segments, width, height, options = {}) {
    const frameW = width, frameH = height;
    // Both formats use the landscape camera scale. Keep enough backing map
    // for the narrower portrait viewport to follow the marker horizontally.
    const landscapeW = Math.max(frameW, frameH);
    const landscapeH = Math.min(frameW, frameH);
    width = landscapeW;
    if (options.follow) width = height = Math.ceil(Math.hypot(frameW, frameH)) + 4;
    const base = layer(width, height);
    const bg = base.getContext('2d');
    const unit = Math.max(0.6, Math.min(frameW, frameH) / 675);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let near, total = 0;
    const points = [];
    for (const segment of segments) {
      let previous;
      for (const location of segment) {
        const p = project(location, near);
        near = p.x;
        if (previous) total += kilometres(previous, location);
        points.push({ ...p, time:location.time, km: total, start: !previous });
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
        previous = location;
      }
    }
    if (!points.length) {
      const center=project({lat:55.7558,lon:37.6173});
      minX=maxX=center.x;
      minY=maxY=center.y;
    }
    const spanX = maxX - minX, spanY = maxY - minY;
    const fit = options.follow
      ? Math.min(frameW, frameH) * 0.82 / Math.hypot(spanX, spanY)
      : Math.min(landscapeW * 0.76 / spanX, landscapeH * 0.69 / spanY);
    const scale = points.length ? Math.min(TILE * 2 ** 18, fit) : TILE * 2 ** 3;
    const left = (maxX + minX) / 2 - width / (2 * scale);
    const top = (maxY + minY) / 2 - height / (2 * scale);
    for (const p of points) {
      p.x = (p.x - left) * scale;
      p.y = (p.y - top) * scale;
    }

    bg.fillStyle = '#edf0e7';
    bg.fillRect(0, 0, width, height);
    // Geographic graticule remains visible wherever a tile is unavailable.
    const step = 2 ** Math.round(Math.log2(105 * unit / scale));
    bg.lineWidth = unit;
    bg.strokeStyle = '#c6d1c4';
    bg.fillStyle = '#627568';
    bg.font = Math.round(11 * unit) + 'px monospace';
    for (let x = Math.ceil(left / step) * step; x < left + width / scale; x += step) {
      const px = (x - left) * scale;
      bg.beginPath(); bg.moveTo(px, 0); bg.lineTo(px, height); bg.stroke();
      const lon = ((x * 360 % 360 + 360) % 360) - 180;
      bg.fillText(Math.abs(lon).toFixed(3) + '°' + (lon < 0 ? 'W' : 'E'), px + 4 * unit, 16 * unit);
    }
    for (let y = Math.ceil(top / step) * step; y < top + height / scale; y += step) {
      const py = (y - top) * scale;
      bg.beginPath(); bg.moveTo(0, py); bg.lineTo(width, py); bg.stroke();
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD;
      bg.fillText(Math.abs(lat).toFixed(3) + '°' + (lat < 0 ? 'S' : 'N'), 4 * unit, py - 4 * unit);
    }



    const entries = new Map();
    let visible = [], waiting = [], active = 0, disposed = false, redraw = 0;
    let settleView = null;
    const maxLevel = options.satellite || localMap ? 18 : 19;
    const baseLevel=Math.log2(scale/TILE);
    let currentLevel=baseLevel;
    // Keep a continuous overview beneath on-demand imagery during network
    // gaps, including the first pass through a route during real-time export.
    const overviewLevel=Math.max(0,Math.min(maxLevel,Math.floor(Math.log2(scale/TILE))));
    const overviewCount=2**overviewLevel, overviewSize=scale/overviewCount;
    const overviewJobs=[];
    let overviewLoaded=0;
    for(let row=Math.max(0,Math.floor(top*overviewCount));row<Math.min(overviewCount,Math.ceil((top+height/scale)*overviewCount));row++){
      for(let tx=Math.floor(left*overviewCount);tx<Math.ceil((left+width/scale)*overviewCount);tx++){
        const col=((tx%overviewCount)+overviewCount)%overviewCount;
        overviewJobs.push(loadTile(overviewLevel,col,row,options.satellite).then(image=>{
          if(disposed || !image) return;
          bg.drawImage(image,(tx/overviewCount-left)*scale,(row/overviewCount-top)*scale,overviewSize+.4,overviewSize+.4);
          overviewLoaded++;
        }));
      }
    }
    const overviewReady=Promise.all(overviewJobs);
    function pump() {
      while (!disposed && active < 8 && waiting.length) {
        const entry = waiting.shift();
        if (entry.pending || entry.image || entry.retryAfter > Date.now()) continue;
        active++;
        entry.pending = true;
        loadTile(entry.z,entry.col,entry.row,options.satellite).then(image=>{
          entry.pending = false;
          entry.image = image;
          entry.retryAfter = image ? 0 : Date.now()+20000;
          active--;
          if (disposed) return;
          if (!redraw) redraw=requestAnimationFrame(()=>{
            redraw=0;
            options.onTiles?.();
          });
          pump();
        });
      }
      if (settleView && !waiting.length && !active) {
        settleView();
        settleView=null;
      }
    }
    function waitForTiles(){
      if (!waiting.length && !active) return overviewReady;
      return new Promise(resolve=>{
        const previous=settleView;
        settleView=()=>{previous?.();resolve(overviewReady);};
      });
    }
    // Intersect tiles with the rotated viewport, using separating axes in
    // both map space and screen space. Only the current frame drives requests.
    function drawTiles(ctx,magnification){
      const level=Math.max(0,Math.min(maxLevel,Math.round(Math.log2(scale*magnification/TILE))));
      const count=2**level, size=scale/count;
      const inv=transform.inverse();
      const corners=[[0,0],[frameW,0],[0,frameH],[frameW,frameH]].map(([x,y])=>
        new DOMPoint(x,y).matrixTransform(inv));
      const xs=corners.map(p=>(left+p.x/scale)*count);
      const ys=corners.map(p=>(top+p.y/scale)*count);
      const extentX=(Math.abs(transform.a)+Math.abs(transform.c))*size/2;
      const extentY=(Math.abs(transform.b)+Math.abs(transform.d))*size/2;
      const queue=new Map(), current=[];
      let painted=0;
      for(let row=Math.max(0,Math.floor(Math.min(...ys)));row<Math.min(count,Math.ceil(Math.max(...ys)));row++){
        for(let tx=Math.floor(Math.min(...xs));tx<Math.ceil(Math.max(...xs));tx++){
          const x=(tx/count-left)*scale, y=(row/count-top)*scale;
          const center=new DOMPoint(x+size/2,y+size/2).matrixTransform(transform);
          if(center.x+extentX<0 || center.x-extentX>frameW || center.y+extentY<0 || center.y-extentY>frameH) continue;
          const col=((tx%count)+count)%count;
          const key=level+'/'+col+'/'+row;
          let entry=entries.get(key);
          if(!entry){entry={z:level,col,row};entries.set(key,entry);}
          entry.used=performance.now();
          current.push(entry);
          if(!entry.image && !entry.pending && !(entry.retryAfter>Date.now())){
            entry.priority=Math.hypot(center.x-frameW/2,center.y-frameH/2);
            queue.set(key,entry);
          }
          // Reuse the nearest available parent until this tile arrives.
          for(let dz=0;dz<=level;dz++){
            const factor=2**dz;
            const parent=dz ? entries.get((level-dz)+'/'+Math.floor(col/factor)+'/'+Math.floor(row/factor)) : entry;
            if(!parent?.image) continue;
            const part=parent.image.naturalWidth/factor;
            ctx.drawImage(parent.image,(col%factor)*part,(row%factor)*part,part,part,x,y,size+.35/magnification,size+.35/magnification);
            painted++;
            break;
          }
        }
      }
      visible=current;
      waiting=[...queue.values()].sort((a,b)=>a.priority-b.priority);
      if(entries.size>300){
        const keep=new Set(current);
        const old=[...entries].filter(([,e])=>!keep.has(e)&&!e.pending).sort((a,b)=>a[1].used-b[1].used);
        for(const [key] of old.slice(0,entries.size-260)) entries.delete(key);
      }
      pump();
      return painted;
    }
    function dispose(){disposed=true;waiting=[];cancelAnimationFrame(redraw);settleView?.();entries.clear();}

    function label(bg, text, right, lift = 0) {
      bg.font = Math.round(13 * unit) + 'px system-ui,sans-serif';
      const w = bg.measureText(text).width + 14 * unit;
      const x = right ? frameW - w : 0;
      const y = frameH - (22 + lift) * unit;
      bg.fillStyle = 'rgba(250,252,247,0.90)';
      bg.fillRect(x, y, w, 22 * unit);
      bg.fillStyle = '#33483c';
      bg.fillText(text, x + 7 * unit, y + 16 * unit);
    }
    const route = new Path2D();
    let lastVisible;
    for (const p of points) {
      if (p.start) {
        route.moveTo(p.x, p.y);
        lastVisible = p;
      } else if (Math.hypot(p.x - lastVisible.x, p.y - lastVisible.y) > 0.04 * unit) {
        route.lineTo(p.x, p.y);
        lastVisible = p;
      }
    }
    // Precompute camera motion in video time. Seeking or a dropped preview
    // frame must produce the same bearing as the corresponding export frame.
    const headingRate = 30;
    const headingCache = new Map();
    function headingsFor(duration) {
      if (headingCache.has(duration)) return headingCache.get(duration);
      const frames = Math.round(duration * headingRate);
      const raw = [];
      let cursor = 0;
      let previousAngle = 0;
      for (let i = 0; i <= frames; i++) {
        const km = total * i / frames;
        while (cursor + 1 < points.length &&
               (points[cursor + 1].km <= km || points[cursor + 1].start)) cursor++;
        const a = points[cursor], b = points[cursor + 1];
        if (b && !b.start && b.km > a.km)
          previousAngle = Math.atan2(b.x - a.x, a.y - b.y);
        raw.push({x:Math.sin(previousAngle), y:Math.cos(previousAngle)});
      }

      // Average directions on the unit circle. At a hairpin the directions
      // may cancel, so hold the last reliable bearing until the exit is clear.
      const angles = [];
      const radius = Math.round(headingRate * 0.9);
      let angle = Math.atan2(raw[0].x,raw[0].y);
      let velocity = 0;
      const maxSpeed = Math.PI / 3; // radians per second
      for (let i = 0; i <= frames; i++) {
        let x = 0, y = 0, weightSum = 0;
        for (let j = -radius; j <= radius; j++) {
          const sample = raw[Math.max(0, Math.min(frames, i+j))];
          const weight = 1 + Math.cos(Math.PI*j/radius);
          x += sample.x*weight; y += sample.y*weight; weightSum += weight;
        }
        const target = Math.hypot(x,y) > 0.18*weightSum ? Math.atan2(x,y) : angle;
        if (!i) angle = target;
        const offset = Math.atan2(Math.sin(target-angle), Math.cos(target-angle));
        const desired = Math.max(-maxSpeed, Math.min(maxSpeed, offset*3));
        velocity += (desired-velocity)*(1-Math.exp(-6/headingRate));
        angle += velocity/headingRate;
        angles.push(angle);
      }
      headingCache.set(duration, angles);
      return angles;
    }

    let trail = new Path2D();
    let until = 0;
    let transform;
    function photoPosition(photo){
      const a=points[photo.index-1], b=points[photo.index];
      return new DOMPoint(a.x+(b.x-a.x)*photo.t,a.y+(b.y-a.y)*photo.t);
    }
    const badgeRadius = 19 * unit;
    const badgeLift = 26 * unit;
    const badge = layer(Math.ceil(42*unit), Math.ceil(48*unit));
    const icon = badge.getContext('2d');
    const badgeX = badge.width/2, badgeY = 21*unit;
    icon.translate(badgeX,badgeY);
    icon.scale(unit,unit);
    icon.fillStyle = '#263f34';
    icon.strokeStyle = '#fff';
    icon.lineWidth = 2;
    icon.lineJoin = 'round';
    icon.beginPath();
    icon.arc(0,0,19,Math.PI*.59,Math.PI*2.41);
    icon.lineTo(0,26);
    icon.closePath();
    icon.fill(); icon.stroke();
    // Camera body, raised viewfinder, lens and amber flash.
    icon.fillStyle = '#fff';
    icon.beginPath(); icon.roundRect(-12,-7,24,16,3); icon.fill();
    icon.beginPath(); icon.roundRect(-6,-10,10,7,2); icon.fill();
    icon.fillStyle = '#263f34';
    icon.beginPath(); icon.arc(0,1,5.6,0,2*Math.PI); icon.fill();
    icon.fillStyle = '#e0ece4';
    icon.beginPath(); icon.arc(0,1,2.8,0,2*Math.PI); icon.fill();
    icon.fillStyle = '#ff975d'; icon.fillRect(7,-4,3,2.5);
    // The perspective of a flat map plane. These transforms are also used
    // for pointer picking and upright photo markers.
    const plane=options.flyover ? layer(frameW,frameH) : null;
    let pitch=0;
    function projectFrame(point){
      const u=point.y/frameH, v=u/(1+pitch*(1-u));
      return new DOMPoint(frameW/2+(point.x-frameW/2)*(1+pitch*v),v*frameH);
    }
    function unprojectFrame(x,y){
      const v=y/frameH, factor=1+pitch*v;
      return new DOMPoint(frameW/2+(x-frameW/2)/factor,y*(1+pitch)/factor);
    }
    function showPlane(output){
      if(!pitch){output.drawImage(plane,0,0);return;}
      // Draw horizontal strips using the inverse ground-plane projection.
      for(let y=0;y<frameH;y+=6){
        const h=Math.min(6,frameH-y);
        const top=unprojectFrame(0,y).y, bottom=unprojectFrame(0,y+h).y;
        const w=frameW*(1+pitch*(y+h/2)/frameH);
        output.drawImage(plane,0,top,frameW,bottom-top,(frameW-w)/2,y,w,h);
      }
    }
    function photoAt(photos,x,y,radius){
      let match=null, nearest=Infinity;
      for(const photo of photos){
        const point=projectFrame(photoPosition(photo).matrixTransform(transform));
        const centerDistance=Math.hypot(point.x-x,point.y-badgeLift-y);
        const tipDistance=Math.hypot(point.x-x,point.y-y);
        if(centerDistance>Math.max(radius,badgeRadius+unit) && tipDistance>radius) continue;
        const distance=Math.min(centerDistance,tipDistance);
        if(distance<=nearest){match=photo;nearest=distance;}
      }
      return match;
    }
    function nearestPhotoPoint(pixelX,pixelY) {
      const target = unprojectFrame(pixelX,pixelY).matrixTransform(transform.inverse());
      return nearestAnchor(target);
    }
    function nearestAnchor(target,time){
      let best = Infinity, anchor;
      for (let i=1;i<points.length;i++) {
        const a=points[i-1], b=points[i];
        if (b.start) continue;
        const dx=b.x-a.x, dy=b.y-a.y, len=dx*dx+dy*dy;
        const timed=Number.isFinite(time) && b.time>a.time && time>=a.time && time<=b.time;
        if(!target && !timed) continue;
        const t=!target ? (time-a.time)/(b.time-a.time) : len ? Math.max(0,Math.min(1,((target.x-a.x)*dx+(target.y-a.y)*dy)/len)) : 0;
        const distance=target ? Math.hypot(a.x+t*dx-target.x,a.y+t*dy-target.y) : 0;
        const error=distance+(target && Number.isFinite(time) && Number.isFinite(a.time) && Number.isFinite(b.time)
          ? Math.min(300,Math.abs(time-(a.time+t*(b.time-a.time)))/1000)*scale/40075000 : 0);
        if (error < best) {
          best=error;
          anchor={index:i,t,at:total ? (a.km+t*(b.km-a.km))/total : 0};
        }
      }
      return anchor;
    }
    function draw(canvas, progress, overview = 1, closeup = 3, duration = 15, photos = [], panX = 0, panY = 0, phase = progress, animateCamera = true, fixedZoom = false, focus = null, overrideLevel = null, draft = null, previewCrop = 0) {
      const km = Math.max(0, Math.min(1, progress)) * total;
      let lo = 0, hi = points.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (points[mid].km <= km) lo = mid + 1;
        else hi = mid;
      }
      const index = progress <= 0 ? 0 : Math.max(0, lo - 1);
      if (index < until) { trail = new Path2D(); until = 0; }
      if (index > until) {
        trail.moveTo(points[until].x, points[until].y);
        while (until < index) {
          const q = points[++until];
          if (q.start) trail.moveTo(q.x, q.y);
          else trail.lineTo(q.x, q.y);
        }
      }
      const p = points[index] ?? {x:width/2,y:height/2};
      const q = points[index + 1];
      const f = q && !q.start && q.km > p.km ? (km - p.km) / (q.km - p.km) : 0;
      const x = f ? p.x + (q.x - p.x) * f : p.x;
      const y = f ? p.y + (q.y - p.y) * f : p.y;
      const output=canvas.getContext('2d');
      let ctx=plane ? plane.getContext('2d') : output;
      ctx.save();
      ctx.setTransform(canvas.width / frameW, 0, 0, canvas.height / frameH, 0, 0);
      // Ease the magnification in log space so both transitions feel symmetric.
      const edge = Math.max(0, 1 - Math.min(progress, 1-progress) / 0.32);
      const eased = edge * edge * (3 - 2 * edge);
      let magnification = overview * Math.pow(closeup, eased);
      let pullback=0;
      pitch=0;
      if(options.flyover && animateCamera){
        const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
        const launch=smooth(phase/.12);
        pullback=smooth((phase-.76)/.20);
        pitch=.85*launch*(1-pullback);
        // At the finish keep the whole route inside the actual output frame.
        const finalZoom=Math.min(1,frameW*.80/Math.max(1,spanX*scale),frameH*.78/Math.max(1,spanY*scale));
        magnification=fixedZoom ? overview : Math.exp(
          (1-pullback)*Math.log(overview*closeup)+pullback*Math.log(finalZoom));
      }
      currentLevel=Math.max(0,Math.min(maxLevel,overrideLevel ?? (baseLevel+Math.log2(magnification))));
      magnification=2**(currentLevel-baseLevel);
      const viewW = (options.follow ? width : frameW) / magnification;
      const viewH = (options.follow ? height : frameH) / magnification;
      const originX = viewW>width ? (width-viewW)/2 : Math.max(0, Math.min(width - viewW, x - viewW / 2));
      const originY = viewH>height ? (height-viewH)/2 : Math.max(0, Math.min(height - viewH, y - viewH / 2));
      ctx.fillStyle="#edf0e7";ctx.fillRect(0,0,frameW,frameH);
      ctx.save();
      ctx.translate(panX,panY);
      if(options.flyover && animateCamera){
        const centerX=x+(width/2-x)*pullback, centerY=y+(height/2-y)*pullback;
        const aim=unprojectFrame(frameW/2,frameH/2);
        ctx.translate(aim.x,aim.y);
        ctx.scale(magnification,magnification);
        ctx.translate(-centerX,-centerY);
      } else if (options.follow && animateCamera) {
        const table = headingsFor(duration);
        const at = Math.min(table.length-1, Math.max(0, progress*(table.length-1)));
        const i = Math.floor(at), t = at-i;
        const heading = table[i] + ((table[i+1] ?? table[i])-table[i])*t;
        ctx.translate(frameW/2, frameH/2);
        ctx.rotate(-heading);
        ctx.scale(magnification, magnification);
        ctx.translate(-originX-viewW/2, -originY-viewH/2);
      } else {
        ctx.scale(magnification, magnification);
        ctx.translate(-originX, -originY);
      }
      transform=ctx.getTransform();
      if (focus) {
        const target=unprojectFrame(focus.x,focus.y);
        const current=focus.world.matrixTransform(transform);
        const dx=target.x-current.x, dy=target.y-current.y;
        transform.e+=dx;transform.f+=dy;
        ctx.setTransform(transform);
        focus.shift(dx,dy);
      }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(base, 0, 0);
      const painted=drawTiles(ctx,magnification);
      if(draft?.length){
        const pen=unit/magnification;
        ctx.beginPath();
        draft.forEach(({x,y},i)=>i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
        ctx.lineJoin=ctx.lineCap='round';
        ctx.lineWidth=9*pen;ctx.strokeStyle='white';ctx.stroke();
        ctx.lineWidth=5*pen;ctx.strokeStyle=ORANGE;ctx.stroke();
        for(const {x,y} of draft){
          ctx.beginPath();ctx.arc(x,y,5*pen,0,2*Math.PI);
          ctx.fillStyle=ORANGE;ctx.fill();ctx.lineWidth=2*pen;ctx.strokeStyle='white';ctx.stroke();
        }
      }else if(!draft && points.length){
        const pen = unit / magnification;
        ctx.lineJoin = ctx.lineCap = 'round';
        ctx.lineWidth = 11 * pen; ctx.strokeStyle = 'rgba(255,255,255,.94)'; ctx.stroke(route);
        ctx.lineWidth = 5.5 * pen; ctx.strokeStyle = '#8b8272'; ctx.stroke(route);
        ctx.lineWidth = 7.5 * pen; ctx.strokeStyle = ORANGE; ctx.stroke(trail);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#655a49'; ctx.lineWidth = 2 * pen;
        ctx.beginPath(); ctx.arc(points[0].x, points[0].y, 4.5 * pen, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 14 * pen, 0, Math.PI * 2); ctx.fillStyle = 'rgba(238,100,44,.22)'; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 6.7 * pen, 0, Math.PI * 2); ctx.fillStyle = ORANGE; ctx.fill();
        ctx.lineWidth = 2.6 * pen; ctx.strokeStyle = '#fff'; ctx.stroke();
      }
      ctx.restore();
      if(plane){
        ctx.restore();ctx=output;ctx.save();ctx.resetTransform();showPlane(ctx);
      }
      ctx.save();
      ctx.resetTransform();
      for(const photo of photos){
        const point=projectFrame(photoPosition(photo).matrixTransform(transform));
        ctx.drawImage(badge,point.x-badgeX,point.y-badgeLift-badgeY);
      }
      ctx.restore();
      ctx.translate(0,-previewCrop);
      if (!painted && !overviewLoaded) {
        label(ctx, active ? 'Загружается карта…' : 'Карта недоступна · координатная сетка',false);
      } else if(options.satellite){
        label(ctx,'EOxCloudless · cloudless.eox.at · EOX IT Services GmbH',true,22);
        label(ctx,'Modified Copernicus Sentinel data 2025 · CC BY-NC-SA 4.0',true);
      } else label(ctx,localMap?'© OpenStreetMap contributors · EOX / MapServer':'© OpenStreetMap contributors',true);
      ctx.restore();
    }
    return {draw, waitForTiles, dispose,baseLevel,maxLevel,get level(){return currentLevel;},
      anchorAtKm(km){
        // A segment start has no incoming edge, including after a GPX gap.
        for(let i=1;i<points.length;i++){
          const a=points[i-1], b=points[i];
          if(b.start || b.km<km) continue;
          const t=b.km>a.km ? (km-a.km)/(b.km-a.km) : 0;
          return {index:i,t,at:total ? km/total : 0};
        }
      },
      mediaAnchor(tags){
        const gps=Number.isFinite(tags.lat)&&Math.abs(tags.lat)<=90&&Number.isFinite(tags.lon)&&Math.abs(tags.lon)<=180;
        if(!gps) return nearestAnchor(null,tags.time);
        const p=project(tags,(left+width/(2*scale)));
        const target={x:(p.x-left)*scale,y:(p.y-top)*scale};
        const anchor=nearestAnchor(target,tags.time);
        if(!anchor) return;
        const place=photoPosition(anchor);
        const metres=Math.hypot(place.x-target.x,place.y-target.y)*40075000*Math.cos(tags.lat*RAD)/scale;
        return metres<=1000 ? anchor : undefined;
      },
      pointFor(location){
        const p=project(location);
        return new DOMPoint((p.x-left)*scale,(p.y-top)*scale);
      },
      routeView(draft,visibleHeight=frameH){
        let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
        for(const {x,y} of draft ?? points){
          x0=Math.min(x0,x);x1=Math.max(x1,x);
          y0=Math.min(y0,y);y1=Math.max(y1,y);
        }
        const fit=Math.min(frameW*.80/(x1-x0),visibleHeight*.78/(y1-y0));
        return {world:new DOMPoint((x0+x1)/2,(y0+y1)/2),level:Number.isFinite(fit)?baseLevel+Math.log2(fit):currentLevel};
      },
      locationOf:({x,y})=>({
        lon:((left+x/scale)*360%360+360)%360-180,
        lat:Math.atan(Math.sinh(Math.PI*(1-2*Math.max(0,Math.min(1,top+y/scale)))))/RAD
      }),
      worldAt:(x,y)=>unprojectFrame(x,y).matrixTransform(transform.inverse()), nearestPhotoPoint, photoAt, distanceKm:total,
      get loading(){return active>0 || waiting.length>0;},
      get loaded(){return visible.filter(entry=>entry.image).length || overviewLoaded;}
    };
  };
})();
