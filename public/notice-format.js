'use strict';
/* Bounded text + ranges only. No HTML is accepted or interpreted. */
((root,factory)=>{const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NoticeFormat=api;})(globalThis,()=>{
 const LIMIT=6000,MAX_MARKS=128,PREFIX='MYWASAP_NOTICE_V1:';
 const boundary=(text,n)=>n===0||n===text.length||!(text.charCodeAt(n-1)>=0xd800&&text.charCodeAt(n-1)<=0xdbff&&text.charCodeAt(n)>=0xdc00&&text.charCodeAt(n)<=0xdfff);
 function merge(ranges){
  const out=[];for(const pair of ranges.sort((a,b)=>a[0]-b[0]||a[1]-b[1])){const last=out.at(-1);if(last&&pair[0]<=last[1])last[1]=Math.max(last[1],pair[1]);else out.push([...pair]);}return out;
 }
 function normalize(text,ranges=[]){
  if(typeof text!=='string'||text.length>LIMIT||!Array.isArray(ranges)||ranges.length>MAX_MARKS)throw RangeError('Invalid notice text or highlights');
  for(const pair of ranges)if(!Array.isArray(pair)||pair.length!==2||!pair.every(Number.isSafeInteger)||pair[0]<0||pair[0]>=pair[1]||pair[1]>text.length||!boundary(text,pair[0])||!boundary(text,pair[1]))throw RangeError('Invalid notice highlight range');
  return merge(ranges.map(pair=>[...pair]));
 }
 function encode(source,ranges=[]){
  let valid=normalize(source,ranges);
  if(valid.length&&source.includes('\r')){const lines=s=>s.replace(/\r\n?/g,'\n');valid=valid.map(([s,e])=>[lines(source.slice(0,s)).length,lines(source.slice(0,e)).length]).filter(([s,e])=>e>s);source=lines(source);}
  const left=source.length-source.trimStart().length,text=source.trim();
  const highlights=normalize(text,valid.map(([s,e])=>[Math.max(0,s-left),Math.min(text.length,e-left)]).filter(([s,e])=>e>s));
  const stored=highlights.length||text.startsWith(PREFIX)?PREFIX+JSON.stringify({v:1,text,highlights}):text;
  if(stored.length>LIMIT)throw RangeError('Notice text and highlights exceed the storage limit');return stored;
 }
 function decode(stored){
  if(typeof stored!=='string')return {text:'',highlights:[]};
  if(stored.startsWith(PREFIX)&&stored.length<=LIMIT)try{const value=JSON.parse(stored.slice(PREFIX.length));if(value?.v===1&&typeof value.text==='string'&&Array.isArray(value.highlights))return {text:value.text,highlights:normalize(value.text,value.highlights)};}catch{}
  return {text:stored,highlights:[]};
 }
 function parts(text,ranges=[]){
  const out=[];let at=0;for(const [start,end] of normalize(text,ranges)){if(start>at)out.push({text:text.slice(at,start),highlight:false});out.push({text:text.slice(start,end),highlight:true});at=end;}if(at<text.length)out.push({text:text.slice(at),highlight:false});return out;
 }
 function highlighted(text,ranges,start,end){return end>start&&normalize(text,ranges).some(([s,e])=>s<=start&&e>=end);}
 function highlight(text,ranges,start,end,enabled=true){
  const valid=normalize(text,ranges);normalize(text,[[start,end]]);
  const out=enabled?merge([...valid,[start,end]]):valid.flatMap(([s,e])=>e<=start||s>=end?[[s,e]]:[...(s<start?[[s,start]]:[]),...(e>end?[[end,e]]:[])]);
  if(out.length>MAX_MARKS)throw RangeError('Too many notice highlights');return out;
 }
 function rebase(before,after,ranges=[]){
  const valid=normalize(before,ranges);if(before===after)return valid;normalize(after);
  let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
  while(start>0&&(!boundary(before,start)||!boundary(after,start)))start--;
  let suffix=0;while(suffix<before.length-start&&suffix<after.length-start&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  while(suffix>0&&(!boundary(before,before.length-suffix)||!boundary(after,after.length-suffix)))suffix--;
  const end=before.length-suffix,delta=after.length-before.length,out=[];
  for(const [s,e] of valid){
   if(e<=start)out.push([s,e]);else if(s>=end)out.push([s+delta,e+delta]);
   else if(s<start&&e>end)out.push([s,e+delta]);
   else{if(s<start)out.push([s,start]);if(e>end)out.push([end+delta,e+delta]);}
  }
  return normalize(after,out);
 }
 return Object.freeze({normalize,encode,decode,parts,highlighted,highlight,rebase});
});
