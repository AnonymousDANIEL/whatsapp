'use strict';
/* Presentation only: notices keep the existing Owner-managed API and permissions. */
(() => {
 const make=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;};
 const speaker='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m14 4-7 4H3v8h4l7 4V4ZM7 16l2 5m9-14a8 8 0 0 1 0 10m-1-7a4 4 0 0 1 0 4"/></svg>';
 const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
 function measure(host){
  const viewport=host.querySelector('.notice-viewport'),track=host.querySelector('.notice-track');
  if(!viewport?.clientWidth||!track)return;
  viewport.style.setProperty('--notice-width',viewport.clientWidth+'px');
  if(!motion.matches){
   const distance=viewport.clientWidth+track.firstElementChild.getBoundingClientRect().width;
   track.style.setProperty('--notice-duration',Math.max(16,distance/45)+'s');
  }
 }
 function clear(host){
  host.replaceChildren();host.classList.remove('notice-marquee');host.removeAttribute('aria-label');
 }
 function render(host,content,labels,highlights=[]){
  clear(host);host.classList.add('notice-marquee');host.setAttribute('aria-label',labels.title);
  const label=make('strong','notice-label');label.innerHTML=speaker;label.append(make('span','',labels.title));label.title=labels.updated||labels.title;
  const viewport=make('div','notice-viewport'),track=make('div','notice-track');track.setAttribute('aria-hidden','true');
  let parts;try{parts=window.NoticeFormat.parts(content,highlights);}catch{parts=[{text:content,highlight:false}];}
  const copy=()=>{const node=make('span','notice-copy');for(const part of parts)node.append(make(part.highlight?'mark':'span',part.highlight?'notice-highlight':'',part.text));return node;};
  track.append(copy());viewport.append(track);
  const accessible=make('span','sr-only',content);accessible.id=host.id+'-text';accessible.setAttribute('role','status');accessible.setAttribute('aria-atomic','true');
  viewport.tabIndex=0;viewport.setAttribute('role','group');viewport.setAttribute('aria-label',labels.content);viewport.setAttribute('aria-describedby',accessible.id);
  const hover=e=>{if(e.pointerType==='mouse'||e.pointerType==='pen')viewport.dataset.hover='';};
  const release=e=>{delete viewport.dataset.pressed;if(e.pointerType!=='mouse')delete viewport.dataset.hover;};
  viewport.onpointerenter=hover;viewport.onpointermove=hover;
  viewport.onpointerleave=()=>{delete viewport.dataset.hover;};
  viewport.onpointerdown=e=>{
   if(e.pointerType==='mouse'||!e.isPrimary||e.button!==0)return;
   delete viewport.dataset.hover;viewport.dataset.pressed='';viewport.setPointerCapture(e.pointerId);
  };
  viewport.onpointerup=release;viewport.onpointercancel=release;viewport.onlostpointercapture=release;
  host.append(label,viewport,accessible);measure(host);
 }
 let frame;
 const resize=()=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=null;document.querySelectorAll('.notice-marquee').forEach(measure);});};
 window.addEventListener('resize',resize,{passive:true});motion.addEventListener('change',resize);document.fonts?.ready.then(resize);
 window.NoticeMarquee=Object.freeze({render,clear});
})();
