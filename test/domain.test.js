const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRecipients, validateSchedule, inWindow, canDispatch, ackStatus, manageUser, csvCell } = require('../src/domain');
const base = { enabled: true, timezone: 'Asia/Kuala_Lumpur', weekdays: [1,2,3,4,5,6,7], scheduled_at:'2026-01-01T00:00:00Z', window_start:'09:00', window_end:'18:00' };
test('Malaysia and international phones are validated and normalized before deduplication', () => {
 const r=parseRecipients('0123456789\n+60123456789\ninvalid\n+1 202-555-0123');
 assert.equal(r.duplicates,1); assert.deepEqual(r.recipients.map(r=>r.status),['pending','invalid','pending']); assert.equal(r.recipients[0].phone,'+60123456789');
});
test('dates follow the configured timezone, including exact open/close boundaries', () => {
 assert.equal(inWindow(base,new Date('2026-10-01T00:59:59Z')),false);
 assert.equal(inWindow(base,new Date('2026-10-01T01:00:00Z')),true);
 assert.equal(inWindow(base,new Date('2026-10-01T10:00:00Z')),false);
});
test('overnight Monday window also includes Tuesday before close', () => {
 const s={...base,weekdays:[1],window_start:'22:00',window_end:'02:00'};
 assert.equal(inWindow(s,new Date('2026-09-28T15:00:00Z')),true);
 assert.equal(inWindow(s,new Date('2026-09-28T17:00:00Z')),true);
 assert.equal(inWindow(s,new Date('2026-09-28T18:00:00Z')),false);
 assert.equal(inWindow(s,new Date('2026-09-29T17:00:00Z')),false);
});
test('pause and expiration stop future dispatch, not an already issued network request', () => {
 const now=new Date('2026-10-01T02:00:00Z');
 assert.equal(inWindow({...base,enabled:false},now),false);
 assert.equal(inWindow({...base,expires_at:now.toISOString()},now),false);
 assert.equal(inWindow({...base,scheduled_at:'2026-11-01T00:00:00Z'},now),false);
});
test('equal opening and closing times mean a full selected day', () => {
 assert.equal(inWindow({...base,window_start:'00:00',window_end:'00:00'},new Date('2026-10-01T20:00:00Z')),true);
});
test('immediate runs bypass future dates, deadlines, weekdays and windows without changing the saved schedule', () => {
 const now=new Date('2026-10-01T12:00:00Z');
 for(const dates of [{scheduled_at:'2026-11-01T00:00:00Z'},{scheduled_at:base.scheduled_at,expires_at:'2026-09-01T00:00:00Z'}]) {
  const job={...base,...dates,weekdays:[1],send_now:true};
  const saved=structuredClone(job);
  assert.equal(inWindow(job,now),false);
  assert.equal(canDispatch(job,now),true);
  assert.deepEqual(job,saved);
 }
 assert.equal(canDispatch({...base,send_now:false},now),false);
 assert.equal(canDispatch(base,new Date('2026-10-01T02:00:00Z')),true);
});
test('pause and cancellation also stop immediate dispatch', () => {
 const now=new Date('2026-10-01T02:00:00Z');
 assert.equal(canDispatch({...base,send_now:true,enabled:false},now),false);
 assert.equal(canDispatch({...base,send_now:true,cancelled:true},now),false);
 assert.equal(canDispatch({...base,cancelled:true},now),false);
});
test('invalid times, timezone, weekdays and deadline are rejected', () => {
 const b={window_start:'09:00',window_end:'18:00'};
 assert.throws(()=>validateSchedule({...b,timezone:'Not/AZone'}));
 assert.throws(()=>validateSchedule({...b,window_end:'29:00'}));
 assert.throws(()=>validateSchedule({...b,weekdays:[]}));
 assert.throws(()=>validateSchedule({...b,interval_ms:1}));
 assert.throws(()=>validateSchedule({...b,scheduled_at:'2026-10-02',expires_at:'2026-10-01'}));
 assert.equal(validateSchedule({...b,scheduled_at:'2026-10-01T09:00'}).scheduled_at,'2026-10-01T09:00:00.000Z');
});
test('server receipt is distinct from device delivery and read receipt', () => {
 assert.deepEqual([-1,0,1,2,3,4].map(ackStatus),['failed','awaiting_ack','submitted','delivered','read','read']);
});
test('only Owner can administer USER IDs', () => {
 const manager={id:'m1',role:'manager'};
 assert.equal(manageUser(manager,{role:'staff',manager_id:'m1'}),false);
 assert.equal(manageUser({role:'user'},{role:'user'}),false);
 assert.equal(manageUser({role:'owner'},{role:'user'}),true);
 assert.equal(manageUser(manager,{role:'staff',manager_id:'m2'}),false);
 assert.equal(manageUser(manager,{role:'manager',manager_id:'m1'}),false);
 assert.equal(manageUser({role:'owner'},{role:'owner'}),false);
});
test('CSV output prevents spreadsheet formula execution and escapes quotes', () => {
 assert.equal(csvCell('=HYPERLINK("x")'),'"\'=HYPERLINK(""x"")"');
 assert.equal(csvCell('+60123456789'),'"\'+60123456789"');
});
