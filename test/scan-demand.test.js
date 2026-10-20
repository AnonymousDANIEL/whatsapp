'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),demand=require('../src/scan-demand');
const now=Date.parse('2026-10-20T15:00:00Z'),live={requested_at:new Date(now-1000),expires_at:new Date(now+120000)},expired={expires_at:new Date(now-1)};
test('QR demand expires, resumes on request and does not confuse an old phone with a linked account',()=>{
 assert.equal(demand.active(live,now),true);for(const d of [undefined,expired,{expires_at:'invalid'},{expires_at:new Date(now)}])assert.equal(demand.active(d,now),false);
 assert.equal(demand.shouldStart({phone:null,status:'starting'},undefined,now),false);
 assert.equal(demand.shouldStart({phone:null,status:'scan_required',profile_bound:true},live,now),true);
 assert.equal(demand.shouldStart({phone:'synthetic',status:'starting'},undefined,now),true);
 assert.equal(demand.shouldStart({phone:'synthetic',status:'scan_required'},undefined,now),false);
 assert.equal(demand.shouldStart({phone:'synthetic',status:'error',last_error:'QR_SCAN_IDLE'},undefined,now),false);
});
test('idle QR release protects linked, authenticating, launching, syncing, viewed and busy identities',async()=>{
 const e={awaitingScan:true,ready:false,authenticated:false,launching:false,sockets:new Set()};assert.equal(demand.idle(e,expired,false,now),true);
 for(const change of [{ready:true},{authenticated:true},{launching:true},{syncing:true},{closing:true},{awaitingScan:false},{sockets:new Set([{}])}])assert.equal(demand.idle({...e,...change},expired,false,now),false);
 assert.equal(demand.idle(e,live,false,now),false);assert.equal(demand.idle(e,expired,true,now),false);
 const entries=new Map([['idle',{...e,id:'idle'}],['linked',{...e,id:'linked',ready:true}],['viewed',{...e,id:'viewed',sockets:new Set([{}])}],['busy',{...e,id:'busy'}]]),stopped=[];
 const n=await demand.releaseIdle([...entries.keys()].map(id=>({id})),entries,new Map(),new Set(['busy']),async(id,e)=>{assert.equal(entries.get(id),e);stopped.push(id);entries.delete(id);},now);
 assert.equal(n,1);assert.deepEqual(stopped,['idle']);assert.deepEqual([...entries.keys()],['linked','viewed','busy']);
});
test('linked recovery precedes FIFO QR requests and does not mutate the account list',()=>{
 const accounts=[{id:'new',created_at:now-4000},{id:'old',created_at:now-3000},{id:'linked',phone:'synthetic',status:'starting',created_at:now-1000},{id:'idle',created_at:now-5000}];
 const requests=new Map([['new',{...live,requested_at:new Date(now-100)}],['old',{...live,requested_at:new Date(now-200)}]]);
 assert.deepEqual(demand.ordered(accounts,requests,now).map(a=>a.id),['linked','old','new','idle']);assert.equal(accounts[0].id,'new');
});
