'use strict';
const {Client}=require('whatsapp-web.js');
const {randomUUID}=require('node:crypto');
const {browserPrepareSend,browserCommitSend,browserDiscardSend,sendFailureCode}=require('./workspace-send');

class LiveWebClient extends Client {
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
  // whatsapp-web.js 1.34.7 still captures response bodies for type=none.
  // Unreadable bodies can reject outside initialize() and terminate the worker.
  // No HTML is needed when caching is disabled; keep the live page unmodified.
  if(this.options.webVersionCache?.type==='none')return;
  return super.initWebVersionCache();
 }
}
module.exports={LiveWebClient};

