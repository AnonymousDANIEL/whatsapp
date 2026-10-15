'use strict';
const {Client}=require('whatsapp-web.js');

class LiveWebClient extends Client {
 async initWebVersionCache(){
  // whatsapp-web.js 1.34.7 still captures response bodies for type=none.
  // Unreadable bodies can reject outside initialize() and terminate the worker.
  // No HTML is needed when caching is disabled; keep the live page unmodified.
  if(this.options.webVersionCache?.type==='none')return;
  return super.initWebVersionCache();
 }
}
module.exports={LiveWebClient};
