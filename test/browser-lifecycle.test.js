'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {current,guard,starting,expired,retire,killIdentity}=require('../src/browser-lifecycle');
test('Late browser events cannot change or fail a replacement connection',()=>{
 const client=new EventEmitter(),old={id:'same',started:0,launching:true},entries=new Map([['same',old]]),seen=[];
 client.on('ready',guard(entries,old,()=>seen.push('ready')));
 client.on('error',guard(entries,old,()=>seen.push('failed')));
 client.emit('ready');assert.deepEqual(seen,['ready']);assert.equal(starting(entries),true);
 const next={id:'same',started:1,launching:true};entries.set('same',next);
 client.emit('ready');client.emit('error');assert.deepEqual(seen,['ready']);assert.equal(current(entries,old),false);assert.equal(current(entries,next),true);
 next.launching=false;assert.equal(starting(entries),false);next.closing=true;assert.equal(current(entries,next),false);
});
test('Waiting for a phone scan is stable; a stuck launch or authentication still expires',()=>{
 const entry={started:0,ready:false,launching:true};
 assert.equal(expired(entry,600001),true);
 entry.awaitingScan=true;entry.launching=false;assert.equal(expired(entry,24*3600000),false);
 entry.awaitingScan=false;entry.progressAt=24*3600000;assert.equal(expired(entry,24*3600000+1000),false);assert.equal(expired(entry,24*3600000+600001),true);
 entry.ready=true;assert.equal(expired(entry,48*3600000),false);
});
test('Stopping a pending launch aborts it and cleans only its Unix identity before releasing its slot',async()=>{
 const events=[],abort=new AbortController(),entry={id:'one',uid:23001,launchAbort:abort,sockets:[{close:()=>events.push('socket')}],children:[{kill:s=>events.push(s)}]},entries=new Map([['one',entry]]);
 abort.signal.addEventListener('abort',()=>events.push('abort'));
 let release;const wait=new Promise(r=>release=r);
 const run=async(file,args)=>{assert.equal(entries.get('one'),entry);assert.equal(file,'pkill');assert.equal(args[2],'23001');events.push(args[0]);if(args[0]==='-TERM')await wait;};
 const first=retire(entries,entry,{run,settle:0}),again=retire(entries,entry,{run,settle:0});
 assert.equal(first,again);assert.equal(entry.closing,true);assert.equal(entries.has('one'),true);
 release();await first;assert.equal(entries.has('one'),false);assert.deepEqual(events,['socket','abort','SIGTERM','-TERM','-KILL']);
});
test('A hung browser close is bounded and cannot retire a different attempt',async()=>{
 const entry={id:'one',uid:23002,launchAbort:new AbortController(),client:{pupBrowser:{process:()=>({kill:()=>{}})},destroy:()=>new Promise(()=>{})}},entries=new Map([['one',entry]]),signals=[];
 await retire(entries,entry,{run:async(_,args)=>signals.push(args[0]),timeout:5,settle:0});
 assert.deepEqual(signals,['-TERM','-KILL']);assert.equal(entry.launchAbort.signal.aborted,true);
 const next={id:'one',uid:23003};entries.set('one',next);await retire(entries,entry,{run:()=>assert.fail('old attempt killed a replacement')});assert.equal(entries.get('one'),next);
});
test('Process cleanup refuses root and accepts no matching private processes',async()=>{
 for(const uid of [0,19999,'23001',NaN])await assert.rejects(killIdentity(uid,'TERM',()=>assert.fail('unsafe process command')),/UNSAFE_BROWSER_IDENTITY/);
 await killIdentity(23001,'TERM',async()=>{throw Object.assign(Error('none'),{code:1});});
 await assert.rejects(killIdentity(23001,'TERM',async()=>{throw Object.assign(Error('denied'),{code:2});}),/denied/);
});
test('Retiring desktop setup keeps its slot until pending setup has stopped',async()=>{
 let finish;const setup=new Promise(resolve=>finish=resolve),entry={id:'setup',uid:23004,setup,sockets:[],children:[]},entries=new Map([['setup',entry]]),seen=[];
 const stopping=retire(entries,entry,{run:async(_,args)=>seen.push(args[0]),settle:0});
 await Promise.resolve();assert.equal(entries.get('setup'),entry);assert.deepEqual(seen,[]);
 finish();await stopping;assert.equal(entries.has('setup'),false);assert.deepEqual(seen,['-TERM','-KILL']);
});
