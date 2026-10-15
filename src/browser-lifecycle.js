'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
const fs=require('node:fs/promises');
function current(entries,entry){return entries.get(entry.id)===entry&&!entry.closing;}
function guard(entries,entry,callback){return (...args)=>current(entries,entry)?callback(...args):undefined;}
function browserClosed(entry){
 const browser=entry.client?.pupBrowser,page=entry.client?.pupPage;
 return browser?.connected===false||typeof browser?.isConnected==='function'&&!browser.isConnected()||typeof page?.isClosed==='function'&&page.isClosed();
}
function observeBrowser(entries,entry,onClose){
 const browser=entry.client?.pupBrowser;
 if(!browser||entry.observedBrowser===browser)return;
 entry.observedBrowser=browser;
 browser.once('disconnected',guard(entries,entry,onClose));
}
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
 try{await run('pkill',['-'+signal,'-u',String(uid)]);}catch(error){
  if(error.code===1)return;
  // At the process limit even pkill cannot fork. Use Node's existing process and
  // the same verified private UID so failed launches cannot strand their children.
  if(['EAGAIN','ENOMEM'].includes(error.code))return killProcIdentity(uid,signal);
  throw error;
 }
}
async function killProcIdentity(uid,signal,io=fs,kill=process.kill){
 if(!Number.isInteger(uid)||uid<20000||uid>2147483647)throw Error('UNSAFE_BROWSER_IDENTITY');
 for(const name of await io.readdir('/proc')){
  if(!/^[1-9]\d*$/.test(name)||Number(name)===1||Number(name)===process.pid)continue;
  try{
   const status=await io.readFile('/proc/'+name+'/status','utf8'),owner=status.match(/^Uid:\s+(\d+)\s+(\d+)\s+/m);
   if(owner&&Number(owner[1])===uid&&Number(owner[2])===uid)kill(Number(name),'SIG'+signal);
  }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
 }
}
async function resourceSummary(){
 const read=async file=>{try{const value=(await fs.readFile(file,'utf8')).trim();return /^\d+$/.test(value)?Number(value):value==='max'?'max':null;}catch{return null;}};
 const [current,max,legacyCurrent,legacyMax]=await Promise.all(['/sys/fs/cgroup/pids.current','/sys/fs/cgroup/pids.max','/sys/fs/cgroup/pids/pids.current','/sys/fs/cgroup/pids/pids.max'].map(read));
 return {pids:current??legacyCurrent,pids_limit:max??legacyMax};
}
function retire(entries,entry,{run=execute,timeout=5000,settle=150,beforeRelease=null}={}){
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
  try{if(beforeRelease)await beforeRelease();}
  finally{if(entries.get(entry.id)===entry)entries.delete(entry.id);}
 })();
 return entry.stopping;
}
module.exports={current,guard,browserClosed,observeBrowser,starting,expired,retire,killIdentity,killProcIdentity,resourceSummary};
