'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
function current(entries,entry){return entries.get(entry.id)===entry&&!entry.closing;}
function guard(entries,entry,callback){return (...args)=>current(entries,entry)?callback(...args):undefined;}
function starting(entries){return [...entries.values()].some(e=>!e.closing&&e.launching);}
function expired(entry,now=Date.now(),timeout=600000){
 return !entry.ready&&!entry.awaitingScan&&now-(entry.progressAt??entry.started)>timeout;
}
async function bounded(callback,timeout){
 let timer;
 try{await Promise.race([Promise.resolve().then(callback),new Promise(resolve=>{timer=setTimeout(resolve,timeout);})]);}catch{}finally{clearTimeout(timer);}
}
async function killIdentity(uid,signal,run=execute){
 if(!Number.isInteger(uid)||uid<20000||uid>2147483647)throw Error('UNSAFE_BROWSER_IDENTITY');
 try{await run('pkill',['-'+signal,'-u',String(uid)]);}catch(error){if(error.code!==1)throw error;}
}
function retire(entries,entry,{run=execute,timeout=5000,settle=150}={}){
 if(entries.get(entry.id)!==entry)return Promise.resolve();
 if(entry.stopping)return entry.stopping;
 entry.closing=true;entry.ready=false;
 entry.stopping=(async()=>{
  if(entry.setup)await entry.setup.catch(()=>{});
  for(const socket of entry.sockets||[])try{socket.close();}catch{}
  // Close known browsers gracefully, then cancel launch paths that have not assigned pupBrowser yet.
  if(entry.client?.pupBrowser)await bounded(()=>entry.client.destroy(),timeout);
  entry.launchAbort?.abort();
  try{entry.client?.pupBrowser?.process()?.kill('SIGKILL');}catch{}
  for(const child of entry.children||[])try{child.kill('SIGTERM');}catch{}
  // A browser may launch before whatsapp-web.js assigns its handle. The account's
  // private Unix identity covers those children without touching another account.
  if(entry.uid!==undefined){
   await killIdentity(entry.uid,'TERM',run);
   if(settle)await new Promise(resolve=>setTimeout(resolve,settle));
   await killIdentity(entry.uid,'KILL',run);
  }
  if(entries.get(entry.id)===entry)entries.delete(entry.id);
 })();
 return entry.stopping;
}
module.exports={current,guard,starting,expired,retire,killIdentity};
