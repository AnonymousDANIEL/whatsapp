'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {snapshot}=require('../src/capacity');
const now=Date.parse('2026-10-16T10:30:00Z');
const row={max_accounts:5,accounts_running:2,assigned_accounts:3,can_start_more:true,heartbeat_at:new Date(now)};
test('capacity reserves assigned accounts before their browser starts and never invents slots when overbooked',()=>{
 assert.deepEqual([snapshot(row,now).slots_used,snapshot(row,now).slots_available],[3,2]);
 assert.equal(snapshot({...row,accounts_running:4},now).slots_available,1);
 const over=snapshot({...row,assigned_accounts:8},now);assert.equal(over.slots_available,0);assert.equal(over.slots_unavailable,0);assert.equal(over.capacity_state,'full');
});
test('stale, missing, future or resource-blocked capacity cannot be advertised as available',()=>{
 for(const heartbeat_at of [null,'invalid',new Date(now-90000),new Date(now+5001)]){
  const s=snapshot({...row,heartbeat_at},now);assert.equal(s.slots_available,0);assert.equal(s.slots_unavailable,2);assert.equal(s.capacity_state,'offline');
 }
 const blocked=snapshot({...row,can_start_more:false},now);assert.equal(blocked.slots_available,0);assert.equal(blocked.slots_unavailable,2);assert.equal(blocked.capacity_state,'resource_wait');
 assert.equal(snapshot({...row,heartbeat_at:new Date(now-89999)},now).slots_available,2);
 assert.equal(snapshot({...row,can_start_more:undefined},now).slots_available,0);
 const reserved=snapshot({...row,max_accounts:10,assigned_accounts:10,accounts_running:8,can_start_more:false},now);
 assert.equal(reserved.capacity_state,'resource_wait');assert.equal(reserved.slots_available,0);
 const missing=snapshot({worker_group:'new-group'},now);assert.equal(missing.slots_available,0);assert.equal(missing.slots_unavailable,0);
});
