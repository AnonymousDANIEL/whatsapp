'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{constants}=require('node:fs');
const recovery=require('../src/desktop-locks');
function fixture(){
 const entry={uid:27010,slot:6},files=new Map(),removed=[],opened=[];let inode=10;
 const stat=(type,extra={})=>({uid:entry.uid,dev:1,ino:inode++,size:11,mtimeMs:1,ctimeMs:1,isFile:()=>type==='file',isSocket:()=>type==='socket',isDirectory:()=>type==='dir',isSymbolicLink:()=>type==='symlink',...extra});
 files.set('/tmp', {stat:stat('dir',{uid:0})});files.set('/tmp/.X11-unix',{stat:stat('dir',{uid:0})});
 for(const name of ['/tmp/.tX106-lock','/tmp/.X106-lock'])files.set(name,{stat:stat('file'),content:'  2147483646\n'});
 files.set('/tmp/.X11-unix/X106',{stat:stat('socket')});
 const io={lstat:async name=>{if(!files.has(name))throw Object.assign(Error('missing'),{code:'ENOENT'});return files.get(name).stat;},open:async(name,flags)=>{opened.push(flags);const value=files.get(name);return {stat:async()=>value.stat,read:async buffer=>{const data=Buffer.from(value.content);data.copy(buffer);return{bytesRead:data.length};},close:async()=>{}};},unlink:async name=>{removed.push(name);files.delete(name);}};
 return {entry,files,removed,opened,stat,options:{io,inspectUid:async()=>false,inspectPid:async()=>false,probe:async()=>false,settleMs:0}};
}
test('desktop locks: remove only retired identity files, never profiles or another slot',async()=>{
 const f=fixture();f.files.set('/tmp/.X105-lock',{stat:f.stat('file',{uid:28000}),content:'1'});
 assert.deepEqual(await recovery.clear(f.entry,f.options),{removed:3});assert.deepEqual(f.removed.sort(),['/tmp/.X106-lock','/tmp/.X11-unix/X106','/tmp/.tX106-lock'].sort());assert.ok(f.files.has('/tmp/.X105-lock'));assert.ok(f.opened.every(v=>(v&constants.O_NOFOLLOW)!==0));
});
test('desktop locks: preserve any live identity, lock PID or accepting/uncertain socket',async()=>{
 for(const override of [{inspectUid:async()=>true},{inspectPid:async()=>true},{probe:async()=>true}]){const f=fixture();const r=await recovery.clear(f.entry,{...f.options,...override});assert.equal(r.removed,0);assert.equal(f.removed.length,0);}
});
test('desktop locks: reject root/system IDs, foreign owners, symlinks, oversized files and unsafe directories',async()=>{
 for(const entry of [{uid:0,slot:6},{uid:19999,slot:6},{uid:27010,slot:-1},{uid:27010,slot:10}]){const f=fixture();assert.equal((await recovery.clear(entry,f.options)).removed,0);assert.equal(f.removed.length,0);}
 for(const [file,type,extra]of [['/tmp/.X106-lock','file',{uid:27011}],['/tmp/.X106-lock','symlink',{}],['/tmp/.X106-lock','file',{size:65}],['/tmp/.X11-unix','symlink',{}],['/tmp','symlink',{}],['/tmp/.X11-unix/X106','socket',{uid:27011}]]){const f=fixture();f.files.get(file).stat=f.stat(type,extra);assert.equal((await recovery.clear(f.entry,f.options)).removed,0);assert.equal(f.removed.length,0);}
});
test('desktop locks: changed files, a reappearing UID, permission errors and unknown PIDs fail closed',async()=>{
 const f=fixture();let checks=0;assert.equal((await recovery.clear(f.entry,{...f.options,inspectUid:async()=>++checks>1})).removed,0);assert.equal(f.removed.length,0);
 const changed=fixture(),original=changed.options.io.lstat;let count=0;changed.options.io.lstat=async name=>{const s=await original(name);if(name==='/tmp/.X106-lock'&&++count>1)return {...s,ino:999};return s;};assert.equal((await recovery.clear(changed.entry,changed.options)).removed,0);assert.equal(changed.removed.length,0);
 const unknown=fixture();unknown.files.get('/tmp/.X106-lock').content='not a PID';assert.equal((await recovery.clear(unknown.entry,unknown.options)).removed,0);assert.equal(unknown.removed.length,0);
 const denied=fixture();await assert.rejects(()=>recovery.clear(denied.entry,{...denied.options,inspectUid:async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}}));assert.equal(denied.removed.length,0);
});
test('desktop locks: lifecycle preserves the slot through cleanup and invokes the caller callback unchanged',async()=>{
 const events=[],entry={id:'synthetic',uid:27010,slot:6},entries=new Map([[entry.id,entry]]);
 const lifecycle={retire:async(map,e,options)=>{events.push('stopped');try{await options.beforeRelease();}finally{events.push('released');map.delete(e.id);}}};
 assert.equal(recovery.install(lifecycle,async e=>{assert.equal(e,entry);assert.equal(entries.has(e.id),true);events.push('cleaned');return{removed:0};}),true);assert.equal(recovery.install(lifecycle),false);
 await lifecycle.retire(entries,entry,{beforeRelease:async()=>events.push('saved')});assert.deepEqual(events,['stopped','saved','cleaned','released']);assert.equal(entries.size,0);
});
test('desktop locks: cleanup still runs when the original status callback fails',async()=>{
 let cleaned=false;const lifecycle={retire:async(map,e,options)=>options.beforeRelease()};recovery.install(lifecycle,async()=>{cleaned=true;return{removed:0};});await assert.rejects(()=>lifecycle.retire(new Map(),{},{beforeRelease:async()=>{throw Error('synthetic DB outage');}}),/DB outage/);assert.equal(cleaned,true);
});
test('desktop locks: process ownership checks include real/effective UID and never ignore unreadable state',async()=>{
 const io={readdir:async()=>['self','1','24','25'],readFile:async path=>path.includes('/24/')?'Uid:\t27010\t27010\t27010\t27010\n':'Uid:\t0\t0\t0\t0\n'};assert.equal(await recovery.uidAlive(27010,io),true);assert.equal(await recovery.uidAlive(27011,io),false);
 await assert.rejects(()=>recovery.uidAlive(27010,{...io,readFile:async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}}));
});
