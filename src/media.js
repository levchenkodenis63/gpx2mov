'use strict';
function isClip(file){
  return file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
}
async function clipTags(file){
  // Skip the media payload, including when moov follows mdat.
  for(let offset=0;offset+8<=file.size;){
    const header=new DataView(await file.slice(offset,offset+16).arrayBuffer());
    const type=i=>String.fromCharCode(...new Uint8Array(header.buffer,i,4));
    let length=header.getUint32(0),head=8;
    if(length===1){length=Number(header.getBigUint64(8));head=16;}
    if(!length) length=file.size-offset;
    if(length<head || offset+length>file.size) break;
    if(type(4)==='moov' && length<32*1024*1024){
      const bytes=await file.slice(offset+head,offset+length).arrayBuffer();
      const data=new DataView(bytes), text=new TextDecoder('latin1').decode(bytes);
      const gps=text.match(/([+-]\d{2}\.\d+)([+-]\d{3}\.\d+)(?:[+-][\d.]+)?\//);
      let time;
      for(let i=0;i+20<=data.byteLength;){
        const n=data.getUint32(i);
        if(n<8 || i+n>data.byteLength) break;
        if(text.slice(i+4,i+8)==='mvhd'){
          const stamp=data.getUint8(i+8)===1?Number(data.getBigUint64(i+12)):data.getUint32(i+12);
          if(stamp>0) time=(stamp-2082844800)*1000;
          break;
        }
        i+=n;
      }
      const capture=text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/);
      if(capture && Number.isFinite(Date.parse(capture[1]))) time=Date.parse(capture[1]);
      return {lat:gps?Number(gps[1]):undefined,lon:gps?Number(gps[2]):undefined,time};
    }
    offset+=length;
  }
  return {};
}
async function mediaTags(file){
  if(isClip(file)){
    let timer;
    try{
      return await Promise.race([clipTags(file),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('Истекло время чтения метаданных видео')),30000);
      })]);
    }finally{clearTimeout(timer);}
  }
  const tags=await exifr.parse(file,{reviveValues:false}) || {};
  const date=String(tags.DateTimeOriginal || '').match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/);
  const offset=/^[+-]\d{2}:\d{2}$/.test(tags.OffsetTimeOriginal)?tags.OffsetTimeOriginal:'';
  const time=date ? Date.parse(date[1]+'-'+date[2]+'-'+date[3]+'T'+date[4]+offset) : undefined;
  return {lat:tags.latitude,lon:tags.longitude,time};
}
async function loadMedia(file){
  const url=URL.createObjectURL(file);
  try{
    if(isClip(file)){
      const video=document.createElement('video');
      video.muted=true;video.playsInline=true;video.preload='auto';
      try{
        // Import only needs the video track and duration. Mobile browsers can
        // defer the first decoded frame until playback starts.
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('Браузер не прочитал видео за 30 секунд')),30000);
          video.onloadedmetadata=()=>{
            clearTimeout(timer);
            if(video.videoWidth && Number.isFinite(video.duration) && video.duration>0) resolve();
            else reject(Error('Не удалось определить параметры видео'));
          };
          video.onerror=()=>{clearTimeout(timer);reject(Error('Браузер не смог открыть видео'));};
          video.src=url;
          video.load();
        });
      }catch(error){
        video.removeAttribute('src');video.load();
        throw error;
      }finally{video.onloadedmetadata=video.onerror=null;}
      return {bitmap:video,duration:video.duration,url};
    }
    let image=new Image();image.src=url;
    try{await image.decode();}
    catch(error){
      if(!/\.hei[cf]$/i.test(file.name) && !/^image\/hei[cf]/i.test(file.type) && !await HeicTo.isHeic(file)) throw error;
      image=await HeicTo({blob:file,type:'bitmap'});
    }
    const width=image.naturalWidth || image.width, height=image.naturalHeight || image.height;
    const ratio=Math.min(1,1920/Math.max(width,height));
    const bitmap=document.createElement('canvas');
    bitmap.width=Math.max(1,Math.round(width*ratio));bitmap.height=Math.max(1,Math.round(height*ratio));
    bitmap.getContext('2d').drawImage(image,0,0,bitmap.width,bitmap.height);
    image.close?.();URL.revokeObjectURL(url);return {bitmap};
  }catch(error){URL.revokeObjectURL(url);throw error;}
}
async function seekClip(video,time){
  if(!video.seeking && video.readyState>=2 && Math.abs(video.currentTime-time)<.001) return;
  await new Promise((resolve,reject)=>{
    const done=()=>{clearTimeout(timer);video.removeEventListener('seeked',done);resolve();};
    const timer=setTimeout(()=>{video.removeEventListener('seeked',done);reject(Error('Не удалось прочитать кадр видео.'));},8000);
    video.addEventListener('seeked',done);video.currentTime=time;
  });
}
