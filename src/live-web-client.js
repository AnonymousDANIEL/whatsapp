'use strict';
const {Client}=require('whatsapp-web.js');
const {randomUUID}=require('node:crypto');
const {browserPrepareSend,browserCommitSend,browserDiscardSend,sendFailureCode}=require('./workspace-send');

const navigationGuard=Symbol('workspaceNavigationGuard');
function guardNavigationEvents(client,page){
 if(!page||page[navigationGuard])return page?.[navigationGuard];
 const on=page.on,off=page.off,wrappers=new WeakMap(),active=new Map();
 const report=error=>{
  if(client.workspaceClosing||page.isClosed?.()||client.pupBrowser?.isConnected?.()===false)return;
  const text=String(error?.message||'');
  const code=/execution context was destroyed|cannot find context|frame was detached/i.test(text)?'WHATSAPP_NAVIGATION_CONTEXT_CHANGED':/target closed|session closed|connection closed/i.test(text)?'WHATSAPP_NAVIGATION_CLOSED':'WHATSAPP_REINJECTION_FAILED';
  try{client.emit('workspace_navigation_error',code);}catch{console.error('WhatsApp navigation recovery handler failed');}
 };
 const guardedOn=function(type,listener){
  if(type!=='framenavigated'||typeof listener!=='function')return on.call(this,type,listener);
  let wrapped=wrappers.get(listener);
  if(!wrapped){wrapped=(...args)=>{try{Promise.resolve(listener.apply(page,args)).catch(report);}catch(error){report(error);}};wrappers.set(listener,wrapped);}
  active.set(wrapped,(active.get(wrapped)||0)+1);return on.call(this,type,wrapped);
 };
 const guardedOff=function(type,listener){
  const wrapped=type==='framenavigated'&&listener?wrappers.get(listener)||listener:listener;
  if(type==='framenavigated'){
   if(!listener)active.clear();else{const n=(active.get(wrapped)||0)-1;if(n>0)active.set(wrapped,n);else active.delete(wrapped);}
  }
  return off.call(this,type,wrapped);
 };
 const dispose=()=>{
  for(const [wrapped,n] of active)for(let i=0;i<n;i++)off.call(page,'framenavigated',wrapped);active.clear();
  off.call(page,'close',dispose);
  if(page.on===guardedOn)page.on=on;if(page.off===guardedOff)page.off=off;
  delete page[navigationGuard];
 };
 page.on=guardedOn;page.off=guardedOff;page[navigationGuard]=dispose;
 on.call(page,'close',dispose);return dispose;
}

class LiveWebClient extends Client {
 beginWorkspaceShutdown(){this.workspaceClosing=true;this.pupPage?.[navigationGuard]?.();}
 async destroy(){this.beginWorkspaceShutdown();return super.destroy();}
 async inject(){if(this.workspaceClosing)return;return super.inject();}
 async inspectSendRuntime(){
  try{
   // Builds a key against an already-loaded chat, without upload/enqueue or a
   // shared preparation slot. Do not return the generated ID or private chat.
   const prepared=await this.pupPage.evaluate(browserPrepareSend,randomUUID(),null,'',null,Date.now()+10000,true);
   return {ok:true,stage:'prepared-without-enqueue',...prepared.inspection};
  }catch(error){const code=sendFailureCode(error,'prepare');return code==='SEND_CHAT_UNAVAILABLE'?{ok:null,stage:'not-checked',code:'NO_LOADED_PRIVATE_CHAT'}:{ok:false,stage:'preparation',code};}
 }
 async prepareWorkspaceMessage(token,chatId,body,media,deadline){
  return this.pupPage.evaluate(browserPrepareSend,token,chatId,body,media,deadline);
 }
 async sendWorkspaceMessage(token){
  const result=await this.pupPage.evaluate(browserCommitSend,token);
  if(result.message)return result.message;
  const error=new Error(result.code||'SEND_EXCEPTION_REVIEW_REQUIRED');
  error.sendCode=result.code;error.notSent=result.notSent===true;throw error;
 }
 async discardWorkspaceMessage(token){return this.pupPage.evaluate(browserDiscardSend,token);}
 async initWebVersionCache(){
  // Installed before Client.initialize registers its async frame callback.
  // A logout/reload failure belongs to this account, never the entire process.
  if(!this.workspaceClosing)guardNavigationEvents(this,this.pupPage);
  // whatsapp-web.js 1.34.7 still captures response bodies for type=none.
  // Unreadable bodies can reject outside initialize() and terminate the worker.
  // No HTML is needed when caching is disabled; keep the live page unmodified.
  if(this.options.webVersionCache?.type==='none')return;
  return super.initWebVersionCache();
 }
}
module.exports={LiveWebClient,guardNavigationEvents};

