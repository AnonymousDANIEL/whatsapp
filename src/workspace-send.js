'use strict';

// These functions run inside the existing WhatsApp page. Preparation uploads media
// but cannot enqueue a message; only the separately invoked commit can do that.
async function browserPrepareSend(token,chatId,body,media,deadline) {
 const jobs=window.__mywasapPreparedSends||(window.__mywasapPreparedSends=new Map());
 const preparing=window.__mywasapPreparingSends||(window.__mywasapPreparingSends=new Set());
 for(const [key,job] of jobs)if(job.deadline<Date.now())jobs.delete(key);
 if(jobs.size>=2||preparing.size)throw Error('SEND_PREPARATION_BUSY');
 const job={deadline,body,chatId};jobs.set(token,job);
 preparing.add(token);
 const current=()=>jobs.get(token)===job&&Date.now()<deadline;
 try{
  job.chat=await window.WWebJS.getChat(chatId,{getAsModel:false});
  if(!job.chat)throw Error('SEND_CHAT_UNAVAILABLE');
  if(!current())throw Error('SEND_PREPARATION_EXPIRED');
  if(media){
   job.media=await window.WWebJS.processMediaData(media,{forceSticker:false,forceGif:false,forceVoice:false,forceDocument:false,forceMediaHd:false,sendToChannel:false,sendToStatus:false});
   if(!current())throw Error('SEND_PREPARATION_EXPIRED');
   if(job.media.type!=='image')throw Error('SEND_IMAGE_PREPARATION_INVALID');
  }
  job.ready=true;
  return {filehash:typeof job.media?.filehash==='string'?job.media.filehash:null};
 }catch(error){if(jobs.get(token)===job)jobs.delete(token);throw error;}finally{preparing.delete(token);}
}
async function browserCommitSend(token) {
 const jobs=window.__mywasapPreparedSends,job=jobs?.get(token);
 if(!job?.ready||Date.now()>=job.deadline){jobs?.delete(token);return {notSent:true,code:'SEND_PREPARATION_EXPIRED'};}
 // Consume once, including when the upstream send throws. Never retry this token.
 jobs.delete(token);
 try{
  const extra=job.media?{...job.media,...(job.media.toJSON?job.media.toJSON():{}),caption:job.body,isViewOnce:false}:{};
  const message=await window.WWebJS.sendMessage(job.chat,job.media?job.media.preview:job.body,{
   waitUntilMsgSent:false,linkPreview:false,parseVCards:false,isCaptionByUser:Boolean(job.media&&job.body),extraOptions:extra
  });
  if(!message)return {code:'SEND_ID_MISSING_REVIEW_REQUIRED'};
  // The full upstream serializer also reads unrelated contact/link/button APIs.
  // A failure there must not lose the ID of an already-created image or text.
  const textId=value=>typeof value==='string'?value:(value?._serialized||value?.$1||null);
  const id=textId(message.id);if(!id)return {code:'SEND_ID_MISSING_REVIEW_REQUIRED'};
  return {message:{id,fromMe:true,to:textId(message.to)||textId(message.id?.remote)||job.chatId,
   body:job.media?(typeof message.caption==='string'?message.caption:job.body):(typeof message.body==='string'?message.body:job.body),
   type:message.type||(job.media?'image':'chat'),timestamp:message.t,ack:Number.isInteger(message.ack)?message.ack:0}};
 }catch(error){return {code:sendFailureCodeInBrowser(error)};}

 function sendFailureCodeInBrowser(error){
  // Do not return WhatsApp error text, which can contain contacts or message data.
  const text=String(error?.message||'');
  return /timed?\s*out|timeout/i.test(text)?'SEND_API_TIMEOUT_REVIEW_REQUIRED':'SEND_API_ERROR_REVIEW_REQUIRED';
 }
}
function browserDiscardSend(token){window.__mywasapPreparedSends?.delete(token);}
async function browserSendReadiness(){
 // Read-only production compatibility check. A lexical facade stops a COPY of
 // the injected builder before enqueue; it never patches live modules or sends.
 const names=['WAWebChatGetters','WALinkify','WAWebUserPrefsMeUser','WAWebMsgKey','WAWebGetEphemeralFieldsMsgActionsUtils','WAWebSendMsgChatAction'];
 const modules={},exports={};let stage='modules';
 const fault=error=>{
  const text=String(error?.message||'');
  const symbol=text.match(/(?:reading ['"]([A-Za-z_$][\w$]*)['"]|([A-Za-z_$][\w.$]*) is not (?:a function|a constructor)|([A-Za-z_$][\w$]*) is not defined)/);
  return {kind:['TypeError','ReferenceError','SyntaxError','EvalError'].includes(error?.name)?error.name:'Error',symbol:(symbol?.[1]||symbol?.[2]||symbol?.[3]||'unknown').slice(0,80)};
 };
 try{
  for(const name of names){try{const value=window.require(name);modules[name]=value;exports[name]={type:typeof value,keys:Object.keys(value||{}).sort().slice(0,50),arity:name==='WAWebSendMsgChatAction'?value?.addAndSendMsgToChat?.length:undefined};}catch{exports[name]={type:'unavailable'};}}
  stage='existing-private-chat';
  const chat=window.require('WAWebCollections').Chat.getModelsArray().find(c=>/@(?:c\.us|lid)$/.test(c.id?._serialized||c.id?.$1||''));
  if(!chat)return {ok:false,stage,code:'NO_LOADED_PRIVATE_CHAT',exports};
  const boundary={};let shape;
  const facade={WWebJS:Object.freeze({}),require:name=>{
   stage=name;
   if(name==='WAWebSendMsgChatAction')return {addAndSendMsgToChat:(_chat,message)=>{
    shape={type:message.type,hasId:typeof message.id?._serialized==='string',fromMe:message.id?.fromMe===true,hasRemote:Boolean(message.id?.remote)};
    throw boundary;
   }};
   if(!names.includes(name)||!modules[name])throw Error('READ_ONLY_MODULE_BLOCKED');
   return modules[name];
  }};
  stage='isolated-builder';
  const copy=Function('window','return ('+window.WWebJS.sendMessage.toString()+')')(facade);
  try{await copy(chat,'',{waitUntilMsgSent:false,linkPreview:false,parseVCards:false});}
  catch(error){if(error===boundary)return {ok:true,stage:'enqueue-boundary',shape,exports,webVersion:/^[\d.]{1,50}$/.test(window.Debug?.VERSION||'')?window.Debug.VERSION:null};throw error;}
  return {ok:false,stage,code:'ENQUEUE_BOUNDARY_NOT_REACHED',exports};
 }catch(error){return {ok:false,stage,code:'SEND_RUNTIME_INCOMPATIBLE',fault:fault(error),exports};}
}
function sendFailureCode(error,stage){
 const text=String(error?.message||'');
 if(/^SEND_(PREPARATION_BUSY|CHAT_UNAVAILABLE|PREPARATION_EXPIRED|IMAGE_PREPARATION_INVALID)$/.test(text))return text;
 if(/target closed|session closed|connection closed|target.*detached/i.test(text))return 'SEND_BROWSER_CLOSED_REVIEW_REQUIRED';
 if(/execution context was destroyed|cannot find context|frame was detached/i.test(text))return 'SEND_PAGE_RELOADING_REVIEW_REQUIRED';
 if(/timed?\s*out|timeout/i.test(text))return stage==='prepare'?'MEDIA_PREPARATION_TIMEOUT':'SEND_API_TIMEOUT_REVIEW_REQUIRED';
 return stage==='prepare'?'MEDIA_PREPARATION_FAILED':'SEND_EXCEPTION_REVIEW_REQUIRED';
}
module.exports={browserPrepareSend,browserCommitSend,browserDiscardSend,browserSendReadiness,sendFailureCode};
