'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {describe}=require('../src/campaign-progress');
const now=Date.parse('2026-11-02T09:00:00Z');
const base={enabled:true,send_now:true,counts:{pending:2,delivered:1},creator_allowed:true,account_enabled:true,account_status:'ready',worker_heartbeat:new Date(now),next_send_at:new Date(now-1000)};
test('a deadline is a queue gate, never an invented delivery result',()=>{
 const c={...base,next_send_at:new Date(now+50000)},saved=structuredClone(c);
 assert.deepEqual(describe(c,now),{state:'interval',next_at:new Date(now+50000).toISOString()});
 assert.deepEqual(describe(c,now+50000),{state:'queued',next_at:null});assert.deepEqual(c,saved);
});
test('future starts and legacy windows retain their actual scheduling gates',()=>{
 const c={...base,send_now:false,scheduled_at:new Date(now+3600000),timezone:'Asia/Kuala_Lumpur',window_start:'00:00',window_end:'00:00',weekdays:[1,2,3,4,5,6,7]};
 assert.equal(describe(c,now).state,'scheduled');assert.equal(describe({...c,scheduled_at:new Date(now-1000),window_start:'18:00',window_end:'19:00'},now).state,'window');
 assert.equal(describe({...c,scheduled_at:new Date(now-2000),expires_at:new Date(now-1)},now).state,'expired');
});
test('waiting explains concrete gates without treating them as failed sends',()=>{
 for(const [change,state] of [[{enabled:false},'paused'],[{enabled:false,pause_reason:'credit'},'credit'],[{review_blocked:true},'unconfirmed'],[{creator_allowed:false},'access'],[{account_enabled:false},'account_disabled'],[{worker_heartbeat:new Date(now-90001)},'service_offline'],[{account_status:'scan_required'},'connection'],[{control_open:true},'control'],[{account_busy:true},'account_busy']])assert.deepEqual(describe({...base,...change},now),{state,next_at:null});
 for(const [counts,state] of [[{sending:1,pending:1},'sending'],[{awaiting_ack:1},'receipt'],[{unknown:1},'unconfirmed'],[{delivered:1,failed:1,invalid:1},'complete']])assert.deepEqual(describe({...base,counts},now),{state,next_at:null});
});
