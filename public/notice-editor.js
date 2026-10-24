'use strict';
/* Native plain-text inputs preserve IME, paste, undo and existing form behavior. */
(() => {
 function attach(form,{notice,language,labels,preview}){
  const state={};let active=language==='en'?'en':'zh',signature='';
  for(const key of ['zh','en']){const field=form.elements.namedItem('content_'+key);state[key]={field,text:field.value,highlights:window.NoticeFormat.normalize(field.value,notice['highlights_'+key]||[])};}
  function sync(key){const s=state[key];if(s.text!==s.field.value){s.highlights=window.NoticeFormat.rebase(s.text,s.field.value,s.highlights);s.text=s.field.value;}return s;}
  function controls(key,message){
   const s=state[key],button=form.querySelector('[data-notice-highlight="content_'+key+'"]'),count=form.querySelector('[data-notice-highlight-status="content_'+key+'"]');
   button.setAttribute('aria-pressed',String(window.NoticeFormat.highlighted(s.text,s.highlights,s.field.selectionStart,s.field.selectionEnd)));
   form.querySelector('[data-notice-clear="content_'+key+'"]').disabled=!!form.dataset.busy||!s.highlights.length;
   count.textContent=message||labels.count(s.highlights.length);
  }
  function paint(){
   const s=sync(active),fallback=sync(active==='en'?'zh':'en'),value=s.text?s:fallback;
   const next=JSON.stringify([active,value.text,value.highlights]);if(next!==signature){signature=next;preview(value.text,value.highlights,active);}for(const key of ['zh','en'])controls(key);
  }
  for(const key of ['zh','en']){
   const s=state[key],mark=form.querySelector('[data-notice-highlight="content_'+key+'"]'),clear=form.querySelector('[data-notice-clear="content_'+key+'"]');
   s.field.addEventListener('input',()=>{sync(key);active=key;paint();});
   s.field.addEventListener('focus',()=>{active=key;paint();});
   s.field.addEventListener('select',()=>controls(key));
   mark.onclick=()=>{
    if(form.dataset.busy)return;
    const s=sync(key),start=s.field.selectionStart,end=s.field.selectionEnd;active=key;
    if(start===end){s.field.focus({preventScroll:true});controls(key,labels.select);return;}
    let error='';try{const next=window.NoticeFormat.highlight(s.text,s.highlights,start,end,!window.NoticeFormat.highlighted(s.text,s.highlights,start,end));window.NoticeFormat.encode(s.text,next);s.highlights=next;form.dataset.dirty='1';paint();}
    catch{error=labels.invalid;}
    s.field.focus({preventScroll:true});s.field.setSelectionRange(start,end);
    if(error)controls(key,error);
   };
   clear.onclick=()=>{if(form.dataset.busy)return;sync(key).highlights=[];active=key;form.dataset.dirty='1';paint();s.field.focus({preventScroll:true});};
  }
  paint();
  return Object.freeze({language:()=>active,ranges(){try{for(const key of ['zh','en']){const s=sync(key);window.NoticeFormat.encode(s.text,s.highlights);}return {highlights_zh:state.zh.highlights,highlights_en:state.en.highlights};}catch{throw Error(labels.invalid);}}});
 }
 window.NoticeEditor=Object.freeze({attach});
})();
