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
  if(!motion.matches&&document.activeElement!==viewport){
   const distance=track.firstElementChild.getBoundingClientRect().width;
   track.style.setProperty('--notice-duration',Math.max(16,distance/45)+'s');
  }
 }
 function clear(host){
  host.replaceChildren();host.classList.remove('notice-marquee');host.removeAttribute('aria-label');
 }
 function render(host,content,labels){
  clear(host);host.classList.add('notice-marquee');host.setAttribute('aria-label',labels.title);
  const label=make('strong','notice-label');label.innerHTML=speaker;label.append(make('span','',labels.title));label.title=labels.updated||labels.title;
  const viewport=make('div','notice-viewport'),track=make('div','notice-track');track.setAttribute('aria-hidden','true');
  track.append(make('span','notice-copy',content),make('span','notice-copy',content));viewport.append(track);
  const accessible=make('span','sr-only',content);accessible.id=host.id+'-text';accessible.setAttribute('role','status');accessible.setAttribute('aria-atomic','true');
  viewport.tabIndex=0;viewport.setAttribute('role','group');viewport.setAttribute('aria-label',labels.content);viewport.setAttribute('aria-describedby',accessible.id);
  viewport.onblur=()=>measure(host);
  host.append(label,viewport,accessible);measure(host);
 }
 let frame;
 const resize=()=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=null;document.querySelectorAll('.notice-marquee').forEach(measure);});};
 window.addEventListener('resize',resize,{passive:true});motion.addEventListener('change',resize);document.fonts?.ready.then(resize);
 window.NoticeMarquee=Object.freeze({render,clear});
})();
