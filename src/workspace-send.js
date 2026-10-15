"use strict";

// Only private individual chats are supported here. Prepare constructs a real
// message key and uploads media, but never invokes the enqueue action.
async function browserPrepareSend(token,chatId,body,media,deadline,probe=false) {
 const jobs=probe?new Map():(window.__mywasapPreparedSends||(window.__mywasapPreparedSends=new Map()));
 const preparing=probe?new Set():(window.__mywasapPreparingSends||(window.__mywasapPreparingSends=new Set()));
 for(const [key,job] of jobs)if(job.deadline<Date.now())jobs.delete(key);
 if(jobs.size>=2||preparing.size)throw Error('SEND_PREPARATION_BUSY');
 const job={deadline,body,chatId};jobs.set(token,job);preparing.add(token);
 const current=()=>jobs.get(token)===job&&Date.now()<deadline;
 const textId=value=>typeof value==='string'?value:(value?._serialized||value?.$1||null);
 const keyId=key=>textId(key)||(key?.fromMe===true&&textId(key.remote)&&typeof key.id==='string'?'true_'+textId(key.remote)+'_'+key.id:null);
 let stage='CHAT';
 try{
  if(probe){
   if(media||body!=='')throw Error('SEND_PROBE_CONTENT_FORBIDDEN');
   job.chat=window.require('WAWebCollections').Chat.getModelsArray().find(chat=>/@(?:c\.us|lid)$/.test(textId(chat.id)||''));
  }else{
   if(typeof chatId!=='string'||!/@(?:c\.us|lid)$/.test(chatId))throw Error('SEND_CHAT_ID_INVALID');
   job.chat=await window.WWebJS.getChat(chatId,{getAsModel:false});
  }
  if(!job.chat)throw Error('SEND_CHAT_UNAVAILABLE');
  job.chatId=textId(job.chat.id);
  if(!/@(?:c\.us|lid)$/.test(job.chatId||''))throw Error('SEND_CHAT_ID_INVALID');
  if(!current())throw Error('SEND_PREPARATION_EXPIRED');
  stage='IDENTITY';
  const me=window.require('WAWebUserPrefsMeUser'),lid=job.chatId.endsWith('@lid');
  const from=lid?me.getMaybeMeLidUser():me.getMaybeMePnUser();
  if(!from)throw Error('SEND_SENDER_ID_UNAVAILABLE');
  stage='KEY';
  const root=window.require('WAWebMsgKey'),MsgKey=typeof root==='function'?root:root.default;
  if(typeof MsgKey!=='function')throw Error('SEND_MESSAGE_KEY_UNAVAILABLE');
  const newId=await (typeof MsgKey.newId==='function'?MsgKey.newId():root.newId());
  let key,constructor='modern';
  try{key=new MsgKey({fromMe:true,remote:job.chat.id,id:newId});if(!keyId(key)||key.fromMe!==true||!textId(key.remote))throw Error('INVALID_MODERN_KEY');}
  catch{constructor='legacy';key=new MsgKey({from,to:job.chat.id,id:newId,selfDir:'out'});}
  const id=keyId(key);
  if(!id||key.fromMe!==true||!textId(key.remote))throw Error('SEND_MESSAGE_KEY_UNAVAILABLE');
  stage='EPHEMERAL';
  const ephemeral=window.require('WAWebGetEphemeralFieldsMsgActionsUtils').getEphemeralFields(job.chat);
  stage='MEDIA';
  if(media){
   job.media=await window.WWebJS.processMediaData(media,{forceSticker:false,forceGif:false,forceVoice:false,forceDocument:false,forceMediaHd:false,sendToChannel:false,sendToStatus:false});
   if(!current())throw Error('SEND_PREPARATION_EXPIRED');
   if(job.media.type!=='image')throw Error('SEND_IMAGE_PREPARATION_INVALID');
   job.media.caption=body;job.media.isViewOnce=false;
  }
  stage='MODEL';
  const extra=job.media?{...job.media,...(job.media.toJSON?job.media.toJSON():{})}:{};
  const privateMediaId=Object.hasOwn(extra,'__x_id');
  // September 2026 MediaData exposes __x_id. Passing it to Msg replaces the
  // genuine MsgKey during initialization, even when the public id is correct.
  delete extra.__x_id;delete extra.id;
  job.message={...ephemeral,...extra,id:key,ack:0,from,to:job.chat.id,local:true,self:'out',t:Math.floor(Date.now()/1000),isNewMsg:true,
   type:media?'image':'chat',body:media?job.media.preview:body,...(media?{caption:body,isViewOnce:false,isCaptionByUser:Boolean(body)}:{})};
  delete job.message.__x_id;
  stage='ENQUEUE_API';
  if(typeof window.require('WAWebSendMsgChatAction').addAndSendMsgToChat!=='function')throw Error('SEND_ENQUEUE_API_UNAVAILABLE');
  const inspection={key_format:typeof key._serialized==='string'?'_serialized':typeof key.$1==='string'?'$1':'components',key_constructor:constructor,private_media_id_removed:privateMediaId,has_message_id:true,web_version:/^[\d.]{1,50}$/.test(window.Debug?.VERSION||'')?window.Debug.VERSION:null};
  if(probe){
   stage='INSPECTION';
   // Unregistered models only: never add them to a chat/collection or invoke
   // enqueue. This exercises the LIVE Msg initializer without a test message.
   const Model=window.require('WAWebCollections').Msg.modelClass;
   inspection.model_initialized=false;inspection.private_id_collision_reproduced=false;
   if(typeof Model==='function'){
    const diagnostic={...job.message,local:false,isNewMsg:false};
    try{const poisoned=new Model({...diagnostic,__x_id:undefined});inspection.private_id_collision_reproduced=keyId(poisoned.id)!==id;}
    catch{inspection.private_id_collision_reproduced=true;}
    const clean=new Model(diagnostic);
    if(keyId(clean.id)!==id)throw Error('SEND_MESSAGE_KEY_UNAVAILABLE');
    inspection.model_initialized=true;
   }
  }
  if(!current())throw Error('SEND_PREPARATION_EXPIRED');
  job.id=id;job.ready=true;
  return {id,filehash:typeof job.media?.filehash==='string'?job.media.filehash:null,inspection};
 }catch(error){
  if(jobs.get(token)===job)jobs.delete(token);
  const text=String(error?.message||'');
  throw Error(/^SEND_[A-Z_]+$/.test(text)?text:'SEND_PREPARE_'+stage+'_FAILED');
 }finally{preparing.delete(token);}
}
async function browserCommitSend(token) {
 const jobs=window.__mywasapPreparedSends,job=jobs?.get(token);
 if(!job?.ready||Date.now()>=job.deadline){jobs?.delete(token);return {notSent:true,code:'SEND_PREPARATION_EXPIRED'};}
 jobs.delete(token);
 const textId=value=>typeof value==='string'?value:(value?._serialized||value?.$1||null);
 const compact=message=>({id:job.id,fromMe:true,to:textId(message.to)||textId(message.id?.remote)||job.chatId,
  body:job.media?(typeof message.caption==='string'?message.caption:job.body):(typeof message.body==='string'?message.body:job.body),
  type:message.type||(job.media?'image':'chat'),timestamp:message.t,ack:Number.isInteger(message.ack)?message.ack:0});
 try{
  // Persisted before this call by the worker. Avoid the pinned sender's final
  // Msg.get(key._serialized), which loses keys exposed only as $1.
  const result=await window.require('WAWebSendMsgChatAction').addAndSendMsgToChat(job.chat,job.message);
  if(!Array.isArray(result))return {code:'SEND_RESULT_SHAPE_REVIEW_REQUIRED',knownId:job.id};
  const [local,server]=result;
  // Server-result rejection is not proof of failure. Real message ACKs remain
  // authoritative; attaching this handler only prevents an unhandled rejection.
  if(server&&typeof server.then==='function')Promise.resolve(server).catch(()=>{});
  const created=await local;
  const message=window.require('WAWebCollections').Msg.get(job.id)||(created&&textId(created.id)===job.id?created:null);
  if(!message)return {code:'SEND_LOCAL_MODEL_MISSING_REVIEW_REQUIRED',knownId:job.id};
  return {message:compact(message)};
 }catch(error){
  // The action may throw after creating a real model. Read only this exact key.
  try{const message=window.require('WAWebCollections').Msg.get(job.id);if(message)return {message:compact(message)};}catch{}
  const text=String(error?.message||'');
  return {code:/timed?\s*out|timeout/i.test(text)?'SEND_API_TIMEOUT_REVIEW_REQUIRED':'SEND_API_ERROR_REVIEW_REQUIRED',knownId:job.id};
 }
}
function browserDiscardSend(token){window.__mywasapPreparedSends?.delete(token);}
function sendFailureCode(error,stage){
 const text=String(error?.message||'');
 const known=text.match(/\b(SEND_(?:PREPARE_(?:CHAT|IDENTITY|KEY|EPHEMERAL|MEDIA|MODEL|ENQUEUE_API|INSPECTION)_FAILED|PREPARATION_BUSY|CHAT_UNAVAILABLE|CHAT_ID_INVALID|SENDER_ID_UNAVAILABLE|MESSAGE_KEY_UNAVAILABLE|ENQUEUE_API_UNAVAILABLE|PREPARATION_EXPIRED|IMAGE_PREPARATION_INVALID))\b/);if(known)return known[1];
 if(/target closed|session closed|connection closed|target.*detached/i.test(text))return 'SEND_BROWSER_CLOSED_REVIEW_REQUIRED';
 if(/execution context was destroyed|cannot find context|frame was detached/i.test(text))return 'SEND_PAGE_RELOADING_REVIEW_REQUIRED';
 if(/timed?\s*out|timeout/i.test(text))return stage==='prepare'?'MEDIA_PREPARATION_TIMEOUT':'SEND_API_TIMEOUT_REVIEW_REQUIRED';
 return stage==='prepare'?'MEDIA_PREPARATION_FAILED':'SEND_EXCEPTION_REVIEW_REQUIRED';
}
module.exports={browserPrepareSend,browserCommitSend,browserDiscardSend,sendFailureCode};
