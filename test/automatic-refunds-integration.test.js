'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('PostgreSQL: automatic uncertain-send refunds are atomic, idempotent and Owner-visible',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_refunds_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.toString(),SERVICE_ROLE:'api',DB_POOL_SIZE:'8',PORT:'0',PUBLIC_URL:'http://localhost:3000',INTERNAL_SECRET:'synthetic-internal-secret-automatic-refunds',BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'synthetic-owner-password-123',WORKER_ROUTES_JSON:'{"fixture":"http://127.0.0.1:9"}'});
 const db=require('../src/db'),billing=require('../src/billing'),refunds=require('../src/automatic-refunds'),worker=require('../src/worker');let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await db.pool.end();await admin.query('DROP DATABASE '+name);await admin.end();});
 await db.migrate();server=await require('../src/api').start({connectionMonitorIntervalMs:0,refundMonitorIntervalMs:0});
 const base='http://127.0.0.1:'+server.address().port,ownerId=(await db.pool.query("SELECT id FROM users WHERE role='owner'")).rows[0].id,userId=randomUUID(),otherId=randomUUID();
 for(const [id,label]of [[userId,'refund-user'],[otherId,'other-refund-user']])await db.pool.query("INSERT INTO users(id,username,password_hash,role,permissions,credit_units) SELECT $1,$2,password_hash,'user',ARRAY['tasks.create'],100000000 FROM users WHERE id=$3",[id,label,ownerId]);
 const {hash}=require('../src/domain');
 async function session(id){const token=randomUUID().replaceAll('-','').repeat(2),csrf=randomUUID();await db.pool.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[hash(token),id,csrf]);return {cookie:'wa_session='+token,csrf};}
 const owner=await session(ownerId),user=await session(userId);
 async function request(path,auth=owner,method='GET',body){const r=await fetch(base+'/api'+path,{method,headers:{cookie:auth.cookie,origin:'http://localhost:3000','x-csrf-token':auth.csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
 const balance=async(id=userId)=>BigInt((await db.pool.query('SELECT credit_units FROM users WHERE id=$1',[id])).rows[0].credit_units);
 const charge=async id=>(await db.pool.query('SELECT * FROM message_charges WHERE recipient_id=$1',[id])).rows[0];
 const candidate=async id=>{const m=await charge(id);return {recipient_id:m.recipient_id,user_id:m.user_id,version:m.version};};
 const recipient=async id=>(await db.pool.query('SELECT * FROM recipients WHERE id=$1',[id])).rows[0];
 async function fixture(status='unknown',{shared=false,age=0,amount=1061,user=userId}={}){
  const a=randomUUID(),c=randomUUID();
  await db.pool.query("UPDATE billing_settings SET price_units=$1 WHERE id=1",[amount]);
  await db.pool.query('UPDATE shared_settings SET enabled=true,price_units=$1 WHERE id=1',[amount]);
  await db.pool.query("INSERT INTO accounts(id,label,worker_group,status,shared_pool) VALUES($1,'Synthetic account','fixture','ready',$2)",[a,shared]);
  await db.pool.query(`INSERT INTO campaigns(id,account_id,created_by,title,body,enabled,shared_pool,timezone,window_start,window_end,weekdays,scheduled_at,interval_ms,opt_in_confirmed)
   VALUES($1,$2,$3,'Synthetic refund task','Synthetic message',true,$4,'Asia/Kuala_Lumpur','00:00','00:00',ARRAY[1,2,3,4,5,6,7],now(),10000,true)`,[c,a,user,shared]);
  const r=(await db.pool.query("INSERT INTO recipients(campaign_id,raw_phone,phone,status) VALUES($1,'15555550101','+15555550101','pending') RETURNING id",[c])).rows[0];
  assert.equal((await db.transaction(tx=>billing.reserveForSend(tx,user,r.id))).ok,true);
  await db.pool.query("UPDATE recipients SET status=$2,send_account_id=$3,send_attempt_id=$4,message_id=$5,ack=0,started_at=now()-($6::integer*interval '1 second') WHERE id=$1",[r.id,status,a,randomUUID(),'synthetic-refund-'+r.id,age]);
  return {id:r.id,a,c};
 }
 await t.test('three uncertain personal sends return the original reservations once under concurrent scans',async()=>{
  const before=await balance(),items=await Promise.all(Array.from({length:3},()=>fixture())),original=await Promise.all(items.map(f=>recipient(f.id)));
  assert.equal(await balance(),before-3183n);
  await Promise.all(Array.from({length:6},()=>refunds.reconcile()));await refunds.reconcile();assert.equal(await balance(),before);
  for(let i=0;i<items.length;i++){
   const f=items[i];assert.equal((await charge(f.id)).state,'refunded');assert.deepEqual(await recipient(f.id),original[i]);
   const rows=(await db.pool.query("SELECT * FROM credit_ledger WHERE recipient_id=$1 AND kind='refunded'",[f.id])).rows;
   assert.equal(rows.length,1);assert.equal(rows[0].delta_units,'1061');assert.equal(rows[0].note,refunds.UNCONFIRMED);assert.equal(rows[0].actor_id,null);
   assert.equal((await db.pool.query("SELECT count(*)::integer n FROM audit WHERE action='billing.auto_refund' AND entity_id=$1",[String(f.id)])).rows[0].n,1);
  }
 });
 await t.test('fresh receipt waits remain held, real success is charged and known failures still refund',async()=>{
  const before=await balance(),fresh=await fixture('awaiting_ack',{age:10}),sending=await fixture('sending',{age:10}),success=await fixture('submitted'),failed=await fixture('failed'),invalid=await fixture('invalid');
  await refunds.reconcile();assert.equal((await charge(fresh.id)).state,'held');assert.equal((await charge(sending.id)).state,'held');
  assert.equal((await charge(success.id)).state,'charged');assert.equal((await charge(failed.id)).state,'refunded');assert.equal((await charge(invalid.id)).state,'refunded');assert.equal(await balance(),before-3183n);
  // Finish the two synthetic in-flight messages before later cases age them.
  for(const f of [fresh,sending]){await db.pool.query("UPDATE recipients SET status='failed' WHERE id=$1",[f.id]);}await billing.reconcile();
 });
 await t.test('both stale in-flight stages expire after 90 seconds, pause only their tasks and retain send identities',async()=>{
  const items=[await fixture('sending',{age:91}),await fixture('awaiting_ack',{age:91})],before=await balance();
  for(const f of items)await db.pool.query("INSERT INTO recipients(campaign_id,raw_phone,status) VALUES($1,'synthetic-pending','pending')",[f.c]);
  const originals=await Promise.all(items.map(f=>recipient(f.id)));const result=await refunds.reconcile();assert.equal(result.expired,2);assert.equal(await balance(),before+2122n);
  for(let i=0;i<items.length;i++){const f=items[i],r=await recipient(f.id);assert.equal(r.status,'unknown');assert.equal(r.message_id,originals[i].message_id);assert.equal(r.send_attempt_id,originals[i].send_attempt_id);assert.equal((await charge(f.id)).state,'refunded');
   const c=(await db.pool.query('SELECT enabled,pause_reason FROM campaigns WHERE id=$1',[f.c])).rows[0];assert.deepEqual(c,{enabled:false,pause_reason:'review'});
   assert.equal((await db.pool.query("SELECT count(*)::integer n FROM recipients WHERE campaign_id=$1 AND status='pending'",[f.c])).rows[0].n,1);
  }
 });
 await t.test('shared repricing and delayed delivery/read/error receipts never change or repeat a completed refund',async()=>{
  const before=await balance(),f=await fixture('unknown',{shared:true,amount:12500}),original=await charge(f.id);
  await db.pool.query('UPDATE shared_settings SET price_units=25000 WHERE id=1');await refunds.reconcile();assert.equal(await balance(),before);
  for(const ack of [2,3,-1]){await worker.receiveAck(f.a,'synthetic-refund-'+f.id,ack);await billing.reconcile();await refunds.reconcile();}
  const m=await charge(f.id);assert.equal(m.state,'refunded');assert.equal(m.amount_units,original.amount_units);assert.equal(m.price_hour,original.price_hour);assert.equal(await balance(),before);
  assert.equal((await db.pool.query("SELECT count(*)::integer n FROM credit_ledger WHERE recipient_id=$1 AND kind='refunded'",[f.id])).rows[0].n,1);
  assert.equal((await db.pool.query("SELECT count(*)::integer n FROM credit_ledger WHERE recipient_id=$1 AND kind='charged'",[f.id])).rows[0].n,0);
 });
 await t.test('a concurrently locked real confirmation wins without a premature refund or deadlock',async()=>{
  const f=await fixture(),c=await candidate(f.id),before=await balance();let entered,release;
  const enteredPromise=new Promise(resolve=>entered=resolve),releasePromise=new Promise(resolve=>release=resolve);
  const ack=db.transaction(async tx=>{await tx.query("UPDATE recipients SET status='delivered',ack=2 WHERE id=$1",[f.id]);entered();await releasePromise;});
  await enteredPromise;try{assert.equal(await refunds.refund(c),null);assert.equal(await balance(),before);}finally{release();await ack;}
  await refunds.reconcile();assert.equal((await charge(f.id)).state,'charged');assert.equal(await balance(),before);
 });
 await t.test('a confirmation committed after the candidate read is rechecked before any wallet credit',async()=>{
  const f=await fixture(),c=await candidate(f.id),before=await balance();await db.pool.query("UPDATE recipients SET status='submitted',ack=1 WHERE id=$1",[f.id]);
  assert.equal(await refunds.refund(c),null);await refunds.reconcile();assert.equal((await charge(f.id)).state,'charged');assert.equal(await balance(),before);
 });
 await t.test('stale candidates cannot release a new charge version or a known settled charge',async()=>{
  const f=await fixture(),old=await candidate(f.id);await refunds.refund(old);await db.pool.query("UPDATE recipients SET status='pending' WHERE id=$1",[f.id]);
  await db.transaction(tx=>billing.reserveForSend(tx,userId,f.id));await db.pool.query("UPDATE recipients SET status='unknown' WHERE id=$1",[f.id]);
  const before=await balance();assert.equal(await refunds.refund(old),null);assert.equal(await balance(),before);assert.equal((await charge(f.id)).state,'held');
  await refunds.reconcile();const settled=await fixture();await billing.settle(settled.id,'submitted');assert.equal(await refunds.refund(await candidate(settled.id)),null);assert.equal((await charge(settled.id)).state,'charged');
 });
 await t.test('a ledger failure rolls the wallet and charge back, and retry returns credit once',async()=>{
  const f=await fixture(),before=await balance();
  await db.pool.query(`CREATE FUNCTION synthetic_fail_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.note='AUTO_REFUND_UNCONFIRMED' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER synthetic_fail_refund BEFORE INSERT ON credit_ledger FOR EACH ROW EXECUTE FUNCTION synthetic_fail_refund()`);
  try{await assert.rejects(refunds.refund(await candidate(f.id)),/synthetic rollback/);assert.equal(await balance(),before);assert.equal((await charge(f.id)).state,'held');}finally{await db.pool.query('DROP TRIGGER synthetic_fail_refund ON credit_ledger; DROP FUNCTION synthetic_fail_refund()');}
  await refunds.reconcile();await refunds.reconcile();assert.equal(await balance(),before+1061n);assert.equal((await charge(f.id)).state,'refunded');
 });
 await t.test('removed recipient holds refund once and their immutable records survive application deletion',async()=>{
  const f=await fixture(),before=await balance();await db.pool.query('DELETE FROM recipients WHERE id=$1',[f.id]);await db.pool.query('DELETE FROM campaigns WHERE id=$1',[f.c]);
  await refunds.reconcile();await refunds.reconcile();assert.equal(await balance(),before+1061n);assert.equal((await charge(f.id)).state,'refunded');
  const rows=(await request('/billing/automatic-refunds?user_id='+userId)).data.rows,record=rows.find(r=>r.recipient_id===f.id);
  assert.equal(record.reason,refunds.REMOVED);assert.equal(record.message_status,'removed');assert.equal(record.amount_units,'1061');
 });
 await t.test('only Owner reads refunds; reads do not settle money, and the retired manual route cannot charge',async()=>{
  const f=await fixture(),before=await balance();assert.equal((await request('/billing/automatic-refunds?user_id='+userId,user)).status,403);
  const result=await request('/billing/automatic-refunds?user_id='+userId);assert.equal(result.status,200);assert.ok(result.data.rows.length>0);
  assert.ok(result.data.rows.every(r=>r.user_id===userId));assert.ok(result.data.rows.every(r=>!('body'in r)&&!('password_hash'in r)&&!('phone'in r)));
  assert.equal((await charge(f.id)).state,'held');assert.equal(await balance(),before);
  assert.equal((await request('/billing/resolve',owner,'POST',{recipient_id:f.id,action:'charge',note:'Synthetic stale client'})).status,409);
  assert.equal((await request('/billing/resolve',user,'POST',{})).status,403);assert.equal(await balance(),before);await refunds.reconcile();
 });
 await t.test('Owner refund lists paginate stably, validate cursors and exclude another USER',async()=>{
  await db.pool.query(`INSERT INTO credit_ledger(user_id,kind,delta_units,balance_units,recipient_id,note)
   SELECT $1,'refunded',1,100,-1000-n,$2 FROM generate_series(1,105) n`,[otherId,refunds.UNCONFIRMED]);
  const first=await request('/billing/automatic-refunds?user_id='+otherId);assert.equal(first.data.rows.length,100);assert.ok(first.data.next_cursor);
  const second=await request('/billing/automatic-refunds?user_id='+otherId+'&before='+first.data.next_cursor);assert.equal(second.data.rows.length,5);assert.equal(second.data.next_cursor,null);
  assert.equal(new Set([...first.data.rows,...second.data.rows].map(r=>r.id)).size,105);
  assert.equal((await request('/billing/automatic-refunds?before=bad')).status,400);assert.equal((await request('/billing/automatic-refunds?before=999999999999999999999')).status,400);
 });
 await t.test('the background monitor runs without a page visit and stops cleanly',async()=>{
  const f=await fixture(),stop=refunds.monitor(10);
  try{for(let i=0;i<200&&(await charge(f.id)).state==='held';i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal((await charge(f.id)).state,'refunded');}finally{await stop();}
  const later=await fixture();await new Promise(resolve=>setTimeout(resolve,35));assert.equal((await charge(later.id)).state,'held');
  await refunds.reconcile();assert.equal((await refunds.snapshot()).held_unknown,0);
 });
});
