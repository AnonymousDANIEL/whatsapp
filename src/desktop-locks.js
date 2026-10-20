'use strict';
// Remove only a retired private desktop's files while its slot is still held.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),net=require('node:net'),path=require('node:path');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const signature=s=>[s.dev,s.ino,s.uid,s.size,s.mtimeMs,s.ctimeMs].join(':');
async function uidAlive(uid,io=fs){
 for(const name of await io.readdir('/proc')){
  if(!/^[1-9]\d*$/.test(name))continue;
  try{const data=await io.readFile('/proc/'+name+'/status','utf8'),owner=data.match(/^Uid:\s+(\d+)\s+(\d+)\s+/m);if(owner&&(Number(owner[1])===uid||Number(owner[2])===uid))return true;}
  catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e;}
 }
 return false;
}
function pidAlive(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;return true;}}
function socketAlive(file){return new Promise(resolve=>{const socket=net.connect({path:file});let done=false;const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};socket.once('connect',()=>finish(true));socket.once('error',e=>finish(!['ECONNREFUSED','ENOENT'].includes(e.code)));socket.setTimeout(200,()=>finish(true));});}
async function clear(entry,{io=fs,root='/tmp',inspectUid=uid=>uidAlive(uid,io),inspectPid=pidAlive,probe=socketAlive,settleMs=1000}={}){
 const {uid,slot}=entry;
 if(!Number.isInteger(uid)||uid<20000||uid>2147483647||!Number.isInteger(slot)||slot<0||slot>9)return {removed:0,skipped:'unsafe_identity'};
 const until=Date.now()+settleMs;
 while(await inspectUid(uid)){if(Date.now()>=until)return {removed:0,skipped:'identity_alive'};await pause(25);}
 const base=await io.lstat(root);if(!base.isDirectory()||base.isSymbolicLink())return {removed:0,skipped:'unsafe_directory'};
 const display=100+slot,files=[path.join(root,'.tX'+display+'-lock'),path.join(root,'.X'+display+'-lock')],snapshots=[];
 for(const file of files){
  let stat;try{stat=await io.lstat(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==uid||stat.size>64)return {removed:0,skipped:'foreign_lock'};
  const handle=await io.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   if(signature(await handle.stat())!==signature(stat))return {removed:0,skipped:'changed_lock'};
   const buffer=Buffer.alloc(65),{bytesRead}=await handle.read(buffer,0,65,0),value=buffer.subarray(0,bytesRead).toString('ascii').trim();
   if(value){if(!/^[1-9]\d{0,9}$/.test(value)||Number(value)>2147483647||await inspectPid(Number(value)))return {removed:0,skipped:'lock_pid_alive_or_unknown'};}
  }finally{await handle.close();}
  snapshots.push({file,stat});
 }
 const dir=path.join(root,'.X11-unix'),socket=path.join(dir,'X'+display);let socketStat;
 try{const d=await io.lstat(dir);if(!d.isDirectory()||d.isSymbolicLink())return {removed:0,skipped:'unsafe_socket_directory'};socketStat=await io.lstat(socket);}
 catch(e){if(e.code!=='ENOENT')throw e;}
 if(socketStat){if(!socketStat.isSocket()||socketStat.isSymbolicLink()||socketStat.uid!==uid||await probe(socket))return {removed:0,skipped:'socket_alive_or_foreign'};snapshots.push({file:socket,stat:socketStat});}
 // The lifecycle hook keeps the slot reserved. Recheck both the private UID
 // and every inode before removing anything; do not touch replacements.
 if(await inspectUid(uid))return {removed:0,skipped:'identity_reappeared'};
 for(const {file,stat}of snapshots){try{if(signature(await io.lstat(file))!==signature(stat))return {removed:0,skipped:'changed_lock'};}catch(e){if(e.code==='ENOENT')return {removed:0,skipped:'changed_lock'};throw e;}}
 let removed=0;for(const {file}of snapshots){try{await io.unlink(file);removed++;}catch(e){if(e.code!=='ENOENT')throw e;}}
 return {removed};
}
const installed=Symbol.for('mywasap.desktop-lock-retirement.v1');
function install(lifecycle=require('./browser-lifecycle'),cleanup=clear){
 if(lifecycle[installed])return false;
 const original=lifecycle.retire;
 lifecycle.retire=function(entries,entry,options={}){return original(entries,entry,{...options,beforeRelease:async()=>{
  try{await options.beforeRelease?.();}finally{
   const result=await cleanup(entry);
   if(result.removed)console.log('Desktop orphan locks removed:',JSON.stringify({removed:result.removed,slot_held:true}));
  }
 }});};
 lifecycle[installed]=true;return true;
}
module.exports={clear,install,uidAlive,pidAlive,socketAlive};
