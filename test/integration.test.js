const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
test('PostgreSQL integration: sessions, scoped grants, staff isolation, queue persistence and revocation', {skip:!process.env.TEST_DATABASE_URL}, async t=>{
 const {Pool}=require('pg'), admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const name='wa_test_'+randomUUID().replaceAll('-','');
 if(!process.env.TEST_SINGLE_DATABASE)await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.TEST_DATABASE_URL);if(!process.env.TEST_SINGLE_DATABASE)url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.toString(),SERVICE_ROLE:'api',PORT:'0',PUBLIC_URL:'http://localhost:3000',INTERNAL_SECRET:'test-secret-at-least-thirty-two-characters',BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'test-owner-password-123',WORKER_ROUTES_JSON:'{"group-a":"http://127.0.0.1:9"}'});
 let pool,server;
 t.after(async()=>{if(server)await new Promise(r=>server.close(r));if(pool)await pool.end();if(!process.env.TEST_SINGLE_DATABASE)await admin.query('DROP DATABASE '+name);await admin.end();});
 const db=require('../src/db');pool=db.pool;await db.migrate();const {start}=require('../src/api');server=await start();
 const base='http://127.0.0.1:'+server.address().port;
 async function request(path,method='GET',body=null,s=null){const r=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',Origin:'http://localhost:3000',...(s?{Cookie:s.cookie,'X-CSRF-Token':s.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 async function login(username,password){const r=await request('/login','POST',{username,password});assert.equal(r.status,200);const s={cookie:r.cookie};s.csrf=(await request('/me','GET',null,s)).data.csrf;return s;}
 const owner=await login('owner','test-owner-password-123');
 assert.equal((await request('/accounts')).status,401);
 assert.equal((await request('/accounts','POST',{label:'X',worker_group:'group-a'},{cookie:owner.cookie,csrf:'bad'})).status,403);
 const a1=(await request('/accounts','POST',{label:'Team A',worker_group:'group-a'},owner)).data.id;
 const a2=(await request('/accounts','POST',{label:'Team B',worker_group:'group-a'},owner)).data.id;
 const perms=['tasks.create','reports.export'];
 const m1=(await request('/users','POST',{username:'manager1',password:'manager-password-123',role:'manager',permissions:perms,grants:[{account_id:a1,operate:true}]},owner)).data.id;
 const m2=(await request('/users','POST',{username:'manager2',password:'manager-password-456',role:'manager',permissions:perms,grants:[{account_id:a2,operate:true}]},owner)).data.id;
 const mgr=await login('manager1','manager-password-123');
 assert.equal((await request('/users','POST',{username:'escalate',password:'staff-password-123',role:'manager',grants:[],permissions:[]},mgr)).status,403);
 assert.equal((await request('/users','POST',{username:'wrongteam',password:'staff-password-123',role:'staff',grants:[{account_id:a2,operate:true}],permissions:perms},mgr)).status,403);
 const staffId=(await request('/users','POST',{username:'staff1',password:'staff-password-123',role:'staff',grants:[{account_id:a1,operate:true}],permissions:perms},mgr)).data.id;
 let staff=await login('staff1','staff-password-123');
 async function screenStatus(id,s,origin='http://localhost:3000'){
   const {WebSocket}=require('ws');
   return new Promise((resolve,reject)=>{
     const ws=new WebSocket(base.replace('http:','ws:')+'/screen/'+id,{headers:{Origin:origin,...(s?{Cookie:s.cookie}:{})}});
     const timer=setTimeout(()=>{ws.terminate();reject(new Error('Screen auth timeout'));},3000);
     ws.on('unexpected-response',(request,response)=>{clearTimeout(timer);response.resume();request.destroy();resolve(response.statusCode);});
     ws.on('error',()=>{});ws.on('open',()=>{clearTimeout(timer);ws.close();resolve(101);});
   });
 }
 assert.equal(await screenStatus(a1,null),401);
 assert.equal(await screenStatus(a1,owner,'https://untrusted.example'),403);
 assert.equal(await screenStatus(a2,staff),403);
 assert.equal((await request('/accounts','GET',null,staff)).data.length,1);
 assert.equal((await request('/users','GET',null,staff)).status,403);
 assert.equal((await request('/users/'+m2,'PATCH',{active:false,grants:[],permissions:[]},mgr)).status,403);
 const job={title:'Test',account_id:a1,body:'Consent-based test message',window_start:'00:00',window_end:'00:00',recipients:'0123456789\n+60123456789\nwrong',opt_in_confirmed:true};
 assert.equal((await request('/campaigns','POST',{...job,account_id:a2},staff)).status,403);
 assert.equal((await request('/campaigns','POST',{...job,opt_in_confirmed:false},staff)).status,400);
 const created=await request('/campaigns','POST',job,staff);assert.equal(created.status,201);assert.equal(created.data.count,2);assert.equal(created.data.duplicates,1);
 const id=created.data.id;
 const report=await request('/campaigns/'+id+'/results','GET',null,staff);assert.equal(report.data.rows[1].error_code,'INVALID_FORMAT');
 await pool.query("UPDATE recipients SET status='unknown',error_code='WORKER_RESTART_REVIEW_REQUIRED' WHERE campaign_id=$1 AND status='pending'",[id]);
 assert.equal((await request('/campaigns','GET',null,staff)).data[0].counts.unknown,1);
 const {inWindow,canDispatch}=require('../src/domain');
 const scheduleKeys=['timezone','window_start','window_end','weekdays','scheduled_at','expires_at','interval_ms'];
 const savedSchedule=c=>Object.fromEntries(scheduleKeys.map(k=>[k,c[k]]));
 const campaignRow=async taskId=>(await pool.query('SELECT * FROM campaigns WHERE id=$1',[taskId])).rows[0];
 const futureSchedule={timezone:'Asia/Kuala_Lumpur',window_start:'09:15',window_end:'17:45',weekdays:[1],scheduled_at:new Date(Date.now()+30*86400000).toISOString(),expires_at:new Date(Date.now()+31*86400000).toISOString(),interval_ms:25000};
 await t.test('existing databases gain immediate mode without changing stored tasks or schedules',async()=>{
  const old=await campaignRow(id);
  await pool.query('ALTER TABLE campaigns DROP COLUMN send_now');
  await db.migrate();
  const migrated=await campaignRow(id);
  assert.equal(migrated.send_now,false);assert.deepEqual(savedSchedule(migrated),savedSchedule(old));
  assert.equal((await request('/campaigns/'+id+'/send-now','POST',{},staff)).status,400); // Unknown outcomes are not retried.
 });
 await t.test('immediate API preserves all times and terminal recipients, stays idempotent and enforces scopes',async()=>{
  assert.equal((await request('/campaigns','POST',{...job,send_now:'true'},staff)).status,400);
  const made=await request('/campaigns','POST',{...job,...futureSchedule,send_now:true,title:'Immediate creation'},staff);
  assert.equal(made.status,201);
  const immediate=await campaignRow(made.data.id);
  assert.equal(immediate.send_now,true);assert.equal(inWindow(immediate),false);assert.equal(canDispatch(immediate),true);
  assert.deepEqual(immediate.weekdays,[1]);assert.equal(immediate.interval_ms,25000);
  assert.equal(immediate.scheduled_at.toISOString(),futureSchedule.scheduled_at);assert.equal(immediate.expires_at.toISOString(),futureSchedule.expires_at);
  const own=(await request('/campaigns','POST',{...job,...futureSchedule,title:'Existing saved schedule',recipients:['+12025550101','+12025550102','+12025550103','+12025550104','+12025550105','wrong'].join('\n')},staff)).data.id;
  const before=await campaignRow(own);assert.equal(before.send_now,false);assert.equal(canDispatch(before),false);
  const ids=(await pool.query('SELECT id FROM recipients WHERE campaign_id=$1 ORDER BY id',[own])).rows.map(r=>r.id);
  for(const [index,status] of ['submitted','unknown','failed','delivered'].entries())await pool.query('UPDATE recipients SET status=$1 WHERE id=$2',[status,ids[index]]);
  const rows=async()=> (await pool.query('SELECT id,status,message_id FROM recipients WHERE campaign_id=$1 ORDER BY id',[own])).rows;
  const beforeRecipients=await rows();
  assert.equal((await request('/campaigns/'+own+'/send-now','POST',{},{cookie:staff.cookie,csrf:'bad'})).status,403);
  for(let click=0;click<2;click++) {
   const activated=await request('/campaigns/'+own+'/send-now','POST',{},staff);
   assert.equal(activated.status,200);assert.equal(activated.data.pending,1);
   assert.deepEqual(savedSchedule(await campaignRow(own)),savedSchedule(before));assert.deepEqual(await rows(),beforeRecipients);
  }
  assert.equal(canDispatch(await campaignRow(own)),true);
  const someoneElse=(await request('/campaigns','POST',job,owner)).data.id;
  assert.equal((await request('/campaigns/'+someoneElse+'/send-now','POST',{},staff)).status,403);
  const anotherTeam=(await request('/campaigns','POST',{...job,account_id:a2},owner)).data.id;
  assert.equal((await request('/campaigns/'+anotherTeam+'/send-now','POST',{},mgr)).status,403);
  await request('/users/'+staffId,'PATCH',{active:true,permissions:[],grants:[{account_id:a1,operate:true}]},mgr);
  staff=await login('staff1','staff-password-123');
  assert.equal((await request('/campaigns/'+own+'/send-now','POST',{},staff)).status,403);
  await request('/users/'+staffId,'PATCH',{active:true,permissions:perms,grants:[{account_id:a1,operate:false}]},mgr);
  staff=await login('staff1','staff-password-123');
  assert.equal((await request('/campaigns/'+own+'/send-now','POST',{},staff)).status,403);
  await request('/users/'+staffId,'PATCH',{active:true,permissions:perms,grants:[{account_id:a1,operate:true}]},mgr);
  staff=await login('staff1','staff-password-123');
  await request('/campaigns/'+own,'PATCH',{enabled:false},staff);assert.equal(canDispatch(await campaignRow(own)),false);
  assert.equal((await request('/campaigns/'+own+'/send-now','POST',{},staff)).status,200);
  await request('/campaigns/'+own+'/cancel','POST',{},staff);
  assert.equal((await request('/campaigns/'+own+'/send-now','POST',{},staff)).status,400);
  assert.deepEqual((await rows()).map(r=>r.status),['submitted','unknown','failed','delivered','cancelled','invalid']);
  assert.ok((await request('/audit','GET',null,owner)).data.some(r=>r.action==='campaign.send_now'&&r.entity_id===own));
 });
 const foreignStaff=(await request('/users','POST',{username:'staff2',password:'staff-password-456',role:'staff',manager_id:m2,permissions:perms,grants:[{account_id:a2,operate:true}]},owner)).data.id;
 assert.equal((await request('/users/'+foreignStaff,'PATCH',{active:false,permissions:[],grants:[]},mgr)).status,403);
 await request('/users/'+staffId,'PATCH',{active:false,permissions:perms,grants:[{account_id:a1,operate:true}]},mgr);
 assert.equal((await request('/me','GET',null,staff)).status,401);
 assert.equal((await pool.query('SELECT enabled FROM campaigns WHERE id=$1',[id])).rows[0].enabled,false);
 await request('/users/'+m1,'PATCH',{active:false,permissions:perms,grants:[{account_id:a1,operate:true}]},owner);
 assert.equal((await request('/me','GET',null,mgr)).status,401);
 assert.equal((await request('/login','POST',{username:'staff1',password:'staff-password-123'})).status,401);
 const logs=(await request('/audit','GET',null,owner)).data;assert.ok(logs.some(r=>r.action==='user.update'));
 // Exercise actual sender branches with a fake client; no live WhatsApp connection or messages.
 const sender=require('../src/worker');
 await t.test('worker prioritizes immediate jobs outside schedule, retains cooldown and rechecks pause before sending',async()=>{
  const accountId=(await request('/accounts','POST',{label:'Fake sender only',worker_group:'group-a'},owner)).data.id;
  const account=(await pool.query('SELECT * FROM accounts WHERE id=$1',[accountId])).rows[0];
  const older=(await request('/campaigns','POST',{...job,account_id:accountId,title:'Scheduled queue',body:'Scheduled queue',recipients:'+12025550106'},owner)).data.id;
  const task=(await request('/campaigns','POST',{...job,...futureSchedule,account_id:accountId,title:'Immediate queue',body:'Immediate queue',recipients:'+12025550107\n+12025550108',send_now:true},owner)).data.id;
  const schedule=savedSchedule(await campaignRow(task)),sent=[];
  const entry={id:accountId,ready:true,client:{getNumberId:async()=>({_serialized:'fake@c.us'}),sendMessage:async(wid,body)=>{sent.push(body);return {ack:1,id:{_serialized:'fake-immediate-'+sent.length}};}}};
  await sender.dispatch(account,entry);
  assert.deepEqual(sent,['Immediate queue']);
  assert.equal((await pool.query('SELECT status FROM recipients WHERE campaign_id=$1',[older])).rows[0].status,'pending');
  const next=(await pool.query('SELECT next_send_at FROM accounts WHERE id=$1',[accountId])).rows[0].next_send_at;
  assert.ok(+next-Date.now()>20000);
  await sender.dispatch(account,entry);assert.equal(sent.length,1); // Immediate still observes the account's interval.
  const remaining=(await pool.query("SELECT * FROM recipients WHERE campaign_id=$1 AND status='pending'",[task])).rows[0];
  const paused=await sender.send({...entry,client:{...entry.client,getNumberId:async()=>{await request('/campaigns/'+task,'PATCH',{enabled:false},owner);return {_serialized:'fake@c.us'};}}},remaining,await campaignRow(task));
  assert.equal(paused.status,'pending');assert.equal(sent.length,1);
  await sender.dispatch(account,entry);assert.equal(sent.length,1);
  await request('/accounts/'+accountId,'PATCH',{enabled:false},owner);
  assert.equal((await request('/campaigns/'+task+'/send-now','POST',{},owner)).status,400);
  await request('/accounts/'+accountId,'PATCH',{enabled:true},owner);
  await request('/campaigns/'+task+'/send-now','POST',{},owner);
  await pool.query('UPDATE accounts SET next_send_at=now() WHERE id=$1',[accountId]);
  await sender.dispatch(account,entry);assert.deepEqual(sent,['Immediate queue','Immediate queue']);
  assert.deepEqual(savedSchedule(await campaignRow(task)),schedule);
  assert.equal((await request('/campaigns/'+task+'/send-now','POST',{},owner)).status,400);
  await sender.dispatch(account,entry);assert.equal(sent.length,2);
 });
 const ownerJob=(await request('/campaigns','POST',{...job,title:'Sender verification'},owner)).data.id;
 const campaign=(await pool.query('SELECT * FROM campaigns WHERE id=$1',[ownerJob])).rows[0];
 const recipient=(await pool.query("SELECT * FROM recipients WHERE campaign_id=$1 AND status='pending'",[ownerJob])).rows[0];
 const missing=await sender.send({client:{getNumberId:async()=>null}},recipient,campaign);assert.equal(missing.status,'invalid');assert.equal(missing.error,'NOT_ON_WHATSAPP');
 const fake={client:{getNumberId:async()=>({_serialized:'test@c.us'}),sendMessage:async()=>({ack:1,id:{_serialized:'test-message-id'}})}};
 const submitted=await sender.send(fake,recipient,campaign);assert.equal(submitted.status,'submitted');
 const uncertain=await sender.send({client:{getNumberId:fake.client.getNumberId,sendMessage:async()=>{throw new Error('simulated network loss')}}},recipient,campaign);assert.equal(uncertain.status,'unknown');assert.equal(uncertain.quarantine,true);
 await sender.receiveAck(a1,'early-receipt',2);
 assert.equal((await pool.query('SELECT ack FROM receipts WHERE message_id=$1',['early-receipt'])).rows[0].ack,2);
 await pool.query('UPDATE recipients SET message_id=$1 WHERE id=$2',['early-receipt',recipient.id]);
 await sender.receiveAck(a1,'early-receipt',1); // Old ACK must not downgrade confirmed delivery.
 assert.equal((await pool.query('SELECT status FROM recipients WHERE id=$1',[recipient.id])).rows[0].status,'delivered');
});
