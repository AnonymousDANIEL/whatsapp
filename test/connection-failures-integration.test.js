'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('PostgreSQL: disconnected personal queues fail only unsubmitted recipients and refund once',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_connection_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.toString(),SERVICE_ROLE:'api',DB_POOL_SIZE:'8',BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'synthetic-owner-password-123'});
 const db=require('../src/db'),billing=require('../src/billing'),recovery=require('../src/connection-failures');
 t.after(async()=>{await db.pool.end();await admin.query('DROP DATABASE '+name);await admin.end();});
 await db.migrate();const user=randomUUID();
 await db.pool.query("INSERT INTO users(id,username,password_hash,role,permissions,credit_units) SELECT $1,'connection-user',password_hash,'user',ARRAY['tasks.create'],1000000 FROM users WHERE role='owner'",[user]);
 await db.pool.query('UPDATE billing_settings SET price_units=10000 WHERE id=1');
 async function fixture({status='scan_required',phone='15555550101',enabled=true,shared=false,worker='synthetic-personal'}={}){
  const a=randomUUID(),c=randomUUID();
  await db.pool.query("INSERT INTO accounts(id,label,worker_group,status,phone,shared_pool,heartbeat_at) VALUES($1,'Synthetic account',$2,$3,$4,$5,now())",[a,worker,status,phone,shared]);
  await db.pool.query(`INSERT INTO campaigns(id,account_id,created_by,title,body,enabled,shared_pool,timezone,window_start,window_end,weekdays,scheduled_at,interval_ms,opt_in_confirmed)
   VALUES($1,$2,$3,'Synthetic task','Synthetic message',$4,$5,'Asia/Kuala_Lumpur','00:00','00:00',ARRAY[1,2,3,4,5,6,7],now(),10000,true)`,[c,a,user,enabled,shared]);
  const add=async(status='pending',extras={})=>{
   const r=(await db.pool.query("INSERT INTO recipients(campaign_id,raw_phone,phone,status) VALUES($1,'15555550201','+15555550201',$2) RETURNING id",[c,status])).rows[0];
   if(extras.hold)await db.transaction(tx=>billing.reserveForSend(tx,user,r.id));
   if(extras.attempt)await db.pool.query('UPDATE recipients SET send_attempt_id=$2 WHERE id=$1',[r.id,randomUUID()]);
   if(extras.message)await db.pool.query("UPDATE recipients SET message_id='synthetic-local-key',ack=0,started_at=now() WHERE id=$1",[r.id]);
   return r.id;
  };return {a,c,add};
 }
 const recipient=async id=>(await db.pool.query('SELECT status,error_code,send_attempt_id,message_id,ack FROM recipients WHERE id=$1',[id])).rows[0];
 const balance=async()=>Number((await db.pool.query('SELECT credit_units FROM users WHERE id=$1',[user])).rows[0].credit_units);
 const charge=async id=>(await db.pool.query('SELECT state FROM message_charges WHERE recipient_id=$1',[id])).rows[0]?.state;
 async function quiet(){await db.pool.query('UPDATE campaigns SET enabled=false');}
 await t.test('overlapping recovery fails an unsubmitted queue, returns held credit once and records activity',async()=>{
  const f=await fixture(),plain=await f.add(),before=await balance(),held=await f.add('pending',{hold:true});
  assert.equal(await balance(),before-10000);
  await Promise.all(Array.from({length:6},()=>recovery.reconcile()));await recovery.reconcile();
  for(const id of [plain,held]){assert.equal((await recipient(id)).status,'failed');assert.equal((await recipient(id)).error_code,recovery.ERROR);}
  assert.equal(await balance(),before);assert.equal(await charge(held),'refunded');
  assert.equal((await db.pool.query("SELECT count(*)::integer n FROM credit_ledger WHERE recipient_id=$1 AND kind='refunded'",[held])).rows[0].n,1);
  assert.ok((await db.pool.query('SELECT operation_at FROM campaigns WHERE id=$1',[f.c])).rows[0].operation_at);await quiet();
 });
 await t.test('possible submissions and confirmed charges retain their exact outcomes and money',async()=>{
  const f=await fixture(),ids=[];
  for(const status of ['sending','awaiting_ack','unknown','submitted','delivered','read'])ids.push(await f.add(status,{hold:true,message:true}));
  ids.push(await f.add('pending',{hold:true,attempt:true}));
  const charged=await f.add('pending',{hold:true});await billing.settle(charged,'submitted');ids.push(charged);
  const before=await Promise.all(ids.map(recipient)),money=await balance();await recovery.reconcile();
  assert.deepEqual(await Promise.all(ids.map(recipient)),before);assert.equal(await balance(),money);assert.equal(await charge(charged),'charged');
  for(const id of ids.slice(0,-1))assert.equal(await charge(id),'held');await quiet();
 });
 await t.test('healthy, first-scan, reconnecting, manually paused and shared queues remain intact',async()=>{
  const ids=[];
  for(const options of [{status:'ready'},{phone:null},{status:'starting'},{status:'loading'},{status:'capacity_wait'},{enabled:false},{shared:true}]){const f=await fixture(options);ids.push(await f.add());}
  const deleted=await fixture();ids.push(await deleted.add());await db.pool.query('UPDATE campaigns SET deleted_at=now() WHERE id=$1',[deleted.c]);
  const cancelled=await fixture();ids.push(await cancelled.add());await db.pool.query('UPDATE campaigns SET cancelled=true WHERE id=$1',[cancelled.c]);
  await recovery.reconcile();for(const id of ids)assert.equal((await recipient(id)).status,'pending');await quiet();
 });
 await t.test('a stale worker fails only a never-submitted personal queue',async()=>{
  const f=await fixture({status:'ready',worker:'synthetic-stale'}),pending=await f.add(),unknown=await f.add('unknown',{hold:true,message:true});
  await db.pool.query("INSERT INTO worker_health(worker_group,heartbeat_at,accounts_running,rss_mb) VALUES('synthetic-stale',now()-interval '2 minutes',0,1)");
  const before=await balance();await recovery.reconcile();assert.equal((await recipient(pending)).status,'failed');assert.equal((await recipient(unknown)).status,'unknown');assert.equal(await charge(unknown),'held');assert.equal(await balance(),before);await quiet();
 });
 await t.test('the worker claim lock wins without deadlock or refunding an in-flight send',async()=>{
  const f=await fixture(),id=await f.add('pending',{hold:true});let entered,release;
  const enteredPromise=new Promise(r=>entered=r),releasePromise=new Promise(r=>release=r);
  const claim=db.transaction(async tx=>{await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user]);await tx.query('SELECT id FROM campaigns WHERE id=$1 FOR UPDATE',[f.c]);await tx.query("UPDATE recipients SET status='sending',started_at=now() WHERE id=$1",[id]);entered();await releasePromise;});
  await enteredPromise;try{await recovery.reconcile();}finally{release();await claim;}
  await recovery.reconcile();assert.equal((await recipient(id)).status,'sending');assert.equal(await charge(id),'held');await quiet();
 });
 await t.test('an interrupted refund is repaired after the task is paused without touching other holds',async()=>{
  const f=await fixture({enabled:false}),id=await f.add('pending',{hold:true}),before=await balance();
  await db.pool.query("UPDATE recipients SET status='failed',error_code=$2 WHERE id=$1",[id,recovery.ERROR]);
  await recovery.reconcile();await recovery.reconcile();assert.equal(await balance(),before+10000);assert.equal(await charge(id),'refunded');
 });
 await t.test('the scheduled monitor recovers failures and can stop cleanly',async()=>{
  const f=await fixture(),id=await f.add(),stop=recovery.monitor(10);
  try{for(let i=0;i<100&&(await recipient(id)).status==='pending';i++)await new Promise(r=>setTimeout(r,10));assert.equal((await recipient(id)).status,'failed');}finally{await stop();}
  await quiet();
 });
 await t.test('the capacity diagnostic reports real PostgreSQL limits without changing configuration',async()=>{
  const before=(await db.pool.query('SHOW max_connections')).rows[0].max_connections,result=await recovery.databaseCapacity();
  assert.equal(result.max_connections,Number(before));assert.equal(result.regular_connections,result.max_connections-result.superuser_reserved_connections-result.reserved_connections);assert.ok(result.current_connections>0);
  assert.equal((await db.pool.query('SHOW max_connections')).rows[0].max_connections,before);
 });
});
