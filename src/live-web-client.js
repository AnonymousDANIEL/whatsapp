'use strict';
const {Client}=require('whatsapp-web.js');
const {browserPrepareSend,browserCommitSend,browserDiscardSend}=require('./workspace-send');

class LiveWebClient extends Client {
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

