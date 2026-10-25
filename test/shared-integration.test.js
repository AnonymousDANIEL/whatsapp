'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('PostgreSQL: shared fleet isolation, hourly rates, refunds and safe recovery',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_shared_'+randomUUID().replaceAll('-','');
 if(!process.env.TEST_SINGLE_DATABASE)await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);if(!process.env.TEST_SINGLE_DATABASE)url.pathname='/'+name;
 Object.assign(process.env,{APP_VAULT_KEY:'22'.repeat(32),DATABASE_URL:url.toString(),SERVICE_ROLE:'api',PORT:'0',PUBLIC_URL:'http://localhost:3000',WORKER_GROUP:'group-a',SHARED_WORKER_GROUPS_JSON:'["group-a","group-b"]',INTERNAL_SECRET:'shared-disposable-test-secret',BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'shared-owner-test-password',WORKER_ROUTES_JSON:'{"group-a":"http://127.0.0.1:9","group-b":"http://127.0.0.1:9"}'});
 const db=require('../src/db');let server;t.after(async()=>{if(server)await new Promise(r=>server.close(r));await db.pool.end();if(!process.env.TEST_SINGLE_DATABASE)await admin.query('DROP DATABASE '+name);await admin.end();});
 await db.migrate();server=await require('../src/api').start({connectionMonitorIntervalMs:0,refundMonitorIntervalMs:0});const base='http://127.0.0.1:'+server.address().port;
 async function request(path,method='GET',body=null,s=null){const r=await fetch(base+'/api'+path,{method,headers:{Origin:'http://localhost:3000','Content-Type':'application/json',...(s?{Cookie:s.cookie,'X-CSRF-Token':s.csrf}:{})},...(body===null?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 async function login(username,password='shared-user-test-password'){const r=await request('/login','POST',{username,password});assert.equal(r.status,200,JSON.stringify(r));const s={cookie:r.cookie};s.csrf=(await request('/me','GET',null,s)).data.csrf;return s;}
 const owner=await login('owner','shared-owner-test-password');
 const created=[];for(const username of ['shared_user_1','shared_user_2']){const r=await request('/users','POST',{username,password:'shared-user-test-password'},owner);assert.equal(r.status,201,JSON.stringify(r));created.push(r.data.id);}
 const [u1,u2]=created;let user1=await login('shared_user_1'),user2=await login('shared_user_2');
 const shared=require('../src/shared'),billing=require('../src/billing'),worker=require('../src/worker'),{hourAt}=require('../src/shared-domain');
 const pricing={enabled:true,price:'0.10',hours:Array.from({length:24},(_,hour)=>({hour,price:'1.25'})),interval_ms:5000,batch_size:1};
 const template={title:'Shared test',body:'Consented fake test message',recipients:'+60123456789',opt_in_confirmed:true};
 let a1,a2,cid;const phonesById=new Map();
 async function task(session=user1,extra={}){const r=await request('/shared/send','POST',{...template,request_id:randomUUID(),...extra},session);assert.equal(r.status,201,JSON.stringify(r));return r.data.id;}
 async function quiet(){await db.pool.query('UPDATE campaigns SET enabled=false');await db.pool.query('UPDATE accounts SET next_send_at=now()');}
 async function credit(id,amount='100'){const r=await request('/billing/adjust','POST',{user_id:id,amount,direction:'add',request_id:randomUUID(),note:'Disposable test credit'},owner);assert.equal(r.status,200);}
 function fakeEntry(id,mode='success',prefix=randomUUID()){
  let sent=0;return {id,ready:true,client:{info:{wid:{user:phonesById.get(id),server:'c.us'}},getState:async()=> 'CONNECTED',getNumberId:async()=>mode==='invalid'?null:{_serialized:'60123456789@c.us'},sendMessage:async()=>{sent++;if(mode==='unknown')throw Error('fake transport uncertainty');return {id:prefix+'-'+sent,fromMe:true,to:'60123456789@c.us',body:template.body,ack:mode==='awaiting'?0:1,timestamp:Math.floor(Date.now()/1000)};}},count:()=>sent};
 }
 await t.test('120 records are lazy, paginated, deduplicated and separate from personal USER slots',async()=>{
  const defaults=(await request('/shared/status','GET',null,user1)).data;assert.equal(defaults.enabled,false);assert.equal(defaults.settings,undefined);assert.equal(defaults.groups,undefined);
  const phones=Array.from({length:120},(_,i)=>'+60123456'+String(i).padStart(3,'0')).join('\n'),body={phones,label:'Test WhatsApp',groups:['group-a','group-b']};
  const r=await request('/shared/accounts','POST',body,owner);assert.equal(r.status,201);assert.equal(r.data.created,120);assert.equal((await request('/shared/accounts','POST',body,owner)).data.created,0);
  const first=(await request('/shared/accounts','GET',null,owner)).data,last=(await request('/shared/accounts?page=3','GET',null,owner)).data;assert.equal(first.total,120);assert.equal(first.rows.length,50);assert.equal(last.rows.length,20);assert.ok(first.rows.every(a=>!a.enabled&&!a.connected));
  for(const session of [owner,user1])assert.equal((await request('/accounts','GET',null,session)).data.length,0);
  assert.equal((await db.pool.query('SELECT account_limit FROM users WHERE id=$1',[u1])).rows[0].account_limit,10);
  const rows=(await db.pool.query('SELECT * FROM accounts ORDER BY created_at,id')).rows;for(const a of rows)phonesById.set(a.id,a.registration_phone.slice(1));a1=rows[0].id;a2=rows.find(a=>a.worker_group!==rows[0].worker_group).id;
  assert.equal((await request('/shared/accounts','POST',{phones:'wrong',groups:['group-a']},owner)).status,400);
 });
 await t.test('USER HTTP and WebSocket controls remain forbidden even with an accidental grant',async()=>{
  for(const [path,method,body] of [['/shared/accounts','GET',null],['/shared/hourly','GET',null],['/shared/settings','PUT',pricing],['/shared/accounts','POST',{phones:'+60123456789',groups:['group-a']}],['/shared/accounts/'+a1+'/connect','POST',{}]])assert.equal((await request(path,method,body,user1)).status,403);
  await db.pool.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,true)',[u1,a1]);
  for(const [path,method,body] of [['/accounts/'+a1+'/connection?mode=operate','GET',null],['/accounts/'+a1+'/connection?mode=scan','GET',null],['/accounts/'+a1+'/restart','POST',{}],['/accounts/'+a1,'PATCH',{label:'Forbidden'}],['/accounts/'+a1,'DELETE',null]])assert.equal((await request(path,method,body,user1)).status,403);
  assert.equal((await request('/accounts','GET',null,user1)).data.length,0);await db.pool.query('DELETE FROM account_grants WHERE user_id=$1',[u1]);
  const {WebSocket}=require('ws');await new Promise((resolve,reject)=>{const ws=new WebSocket(base.replace('http:','ws:')+'/screen/'+a1+'?mode=scan',{headers:{Origin:'http://localhost:3000',Cookie:user1.cookie}});ws.on('unexpected-response',(_,r)=>{try{assert.equal(r.statusCode,403);r.resume();resolve();}catch(e){reject(e);}});ws.on('open',()=>{ws.close();reject(Error('USER linking opened'));});ws.on('error',reject);});
  assert.equal((await request('/users/'+u1,'PATCH',{active:true,grants:[{account_id:a1}]},owner)).status,403);assert.equal((await request('/shared/settings','PUT',pricing,{...owner,csrf:'bad'})).status,403);
 });
 await t.test('new sends require independent price, balance and fresh connection/worker samples',async()=>{
  assert.equal((await request('/shared/send','POST',{...template,request_id:randomUUID()},user1)).status,503);
  assert.equal((await request('/shared/settings','PUT',pricing,owner)).status,200);assert.equal(Number((await shared.config()).current_price_units),12500);
  assert.equal((await request('/shared/send','POST',{...template,request_id:randomUUID()},user1)).status,402);await credit(u1);await credit(u2);
  assert.equal((await request('/shared/send','POST',{...template,request_id:randomUUID()},user1)).status,503);
  await db.pool.query("UPDATE accounts SET enabled=true,phone=replace(registration_phone,'+',''),status='ready',shared_state='connected',shared_checked_at=now() WHERE id=ANY($1::uuid[])",[[a1,a2]]);
  for(const group of ['group-a','group-b'])await db.pool.query('INSERT INTO worker_health(worker_group,heartbeat_at,accounts_running,rss_mb,max_accounts) VALUES($1,now(),1,50,5)',[group]);
  assert.equal((await request('/shared/status','GET',null,user1)).data.summary.available,1);
  const visible=(await request('/shared/status','GET',null,user1)).data;assert.deepEqual(Object.keys(visible.summary),['available']);for(const key of ['groups','workers','hours','settings'])assert.equal(visible[key],undefined);
  await db.pool.query("UPDATE worker_health SET heartbeat_at=now()-interval '5 minutes'");assert.equal((await request('/shared/status','GET',null,user1)).data.summary.available,0);
  assert.equal((await request('/shared/send','POST',{...template,request_id:randomUUID()},user1)).status,503);await db.pool.query('UPDATE worker_health SET heartbeat_at=now()');
  await db.pool.query("UPDATE accounts SET shared_checked_at=now()-interval '2 hours' WHERE id=$1",[a1]);assert.equal((await request('/shared/status','GET',null,user1)).data.summary.available,1);await db.pool.query('UPDATE accounts SET shared_checked_at=now() WHERE id=$1',[a1]);
  assert.equal((await request('/shared/send','POST',{...template,request_id:randomUUID(),opt_in_confirmed:false},user1)).status,400);
 });
 await t.test('Shared availability hides USER routes without changing prices, wallets, accounts or Sessions',async()=>{
  const snapshot=async()=>(await db.pool.query(`SELECT jsonb_build_object('wallets',(SELECT jsonb_agg(jsonb_build_array(id,credit_units) ORDER BY id) FROM users),'personal',(SELECT to_jsonb(b) FROM billing_settings b),'pricing',(SELECT to_jsonb(s)-'enabled'-'updated_at' FROM shared_settings s),'hours',(SELECT jsonb_agg(h ORDER BY hour) FROM shared_hour_prices h),'accounts',(SELECT jsonb_agg(a ORDER BY id) FROM accounts a),'sessions',(SELECT count(*) FROM sessions),'ledger',(SELECT count(*) FROM credit_ledger)) value`)).rows[0].value;
  assert.equal((await request('/workspace/features')).status,401);
  assert.deepEqual((await request('/workspace/features','GET',null,user1)).data,{shared_enabled:true});
  const before=await snapshot();
  assert.equal((await request('/shared/availability','PATCH',{enabled:false},user1)).status,403);
  assert.equal((await request('/shared/availability','PATCH',{enabled:false},{...owner,csrf:'bad'})).status,403);
  assert.equal((await request('/shared/availability','PATCH',{enabled:'false'},owner)).status,400);
  try{
   assert.equal((await request('/shared/availability','PATCH',{enabled:false},owner)).status,200);
   assert.deepEqual((await request('/workspace/features','GET',null,user2)).data,{shared_enabled:false});
   for(const [path,method,body]of [['/shared/tasks','GET',null],['/shared/records','GET',null],['/shared/send','POST',{...template,request_id:randomUUID()}]]){
    const r=await request(path,method,body,user1);assert.equal(r.status,503);assert.equal(r.data.code,'SHARED_DISABLED');
   }
   assert.equal((await request('/shared/tasks','GET',null,owner)).status,200);
   assert.equal((await request('/shared/accounts','GET',null,owner)).status,200);
   assert.equal((await request('/shared/status?layout=2','GET',null,user1)).data.summary.available,0);
  }finally{assert.equal((await request('/shared/availability','PATCH',{enabled:true},owner)).status,200);}
  assert.deepEqual(await snapshot(),before);
 });
 await t.test('USER billing exposes current personal/shared per-message rates without management fields or financial writes',async()=>{
  const before=(await db.pool.query('SELECT id,credit_units FROM users ORDER BY id')).rows;
  const b=(await request('/billing','GET',null,user1)).data,price=(await db.pool.query('SELECT price_units FROM billing_settings WHERE id=1')).rows[0].price_units;
  assert.deepEqual(Object.keys(b.rates).sort(),['personal_units','shared_enabled','shared_units']);
  assert.equal(b.rates.personal_units,price);assert.equal(Number(b.rates.shared_units),12500);assert.equal(b.rates.shared_enabled,true);
  for(const name of ['price_units','held','held_units','hours','settings','users'])assert.equal(b[name],undefined);
  assert.equal(b.user.id,u1);assert.ok(b.ledger.every(row=>row.actor===undefined&&row.note===undefined));
  assert.deepEqual((await db.pool.query('SELECT id,credit_units FROM users ORDER BY id')).rows,before);
 });
 await t.test('Shared initial pacing persists per task, validates atomically and remains idempotent across legacy clients',async()=>{
  await quiet();const requestId=randomUUID(),body={...template,request_id:requestId,pacing:true,interval_ms:60000,batch_size:3};
  const before=(await db.pool.query('SELECT id,credit_units FROM users ORDER BY id')).rows;
  const first=await request('/shared/send','POST',body,owner);assert.equal(first.status,201,JSON.stringify(first));
  const row=(await db.pool.query('SELECT interval_ms,batch_size FROM campaigns WHERE id=$1',[first.data.id])).rows[0];assert.deepEqual(row,{interval_ms:60000,batch_size:3});
  const replay=await request('/shared/send','POST',body,owner);assert.equal(replay.status,201);assert.equal(replay.data.id,first.data.id);
  assert.equal((await request('/shared/send','POST',{...body,batch_size:4},owner)).status,409);
  for(const changes of [{interval_ms:4999},{batch_size:101},{pacing:false}]){
   const id=randomUUID();assert.equal((await request('/shared/send','POST',{...body,...changes,request_id:id},owner)).status,400);
   assert.equal((await db.pool.query('SELECT 1 FROM campaigns WHERE shared_request_id=$1',[id])).rowCount,0);
  }
  const legacy={...template,request_id:randomUUID()},created=await request('/shared/send','POST',legacy,owner);assert.equal(created.status,201);
  assert.deepEqual((await db.pool.query('SELECT interval_ms,batch_size FROM campaigns WHERE id=$1',[created.data.id])).rows[0],{interval_ms:5000,batch_size:1});
  assert.equal((await request('/shared/send','POST',legacy,owner)).data.id,created.data.id);
  const listed=(await request('/shared/tasks','GET',null,owner)).data.rows.find(c=>c.id===first.data.id);assert.equal(listed.interval_ms,60000);assert.equal(listed.batch_size,3);assert.equal(listed.shared_pool,true);
  assert.equal((await request('/shared/records','GET',null,owner)).status,200);
  assert.deepEqual((await db.pool.query('SELECT id,credit_units FROM users ORDER BY id')).rows,before);await quiet();
 });
 await t.test('Owner image switch blocks only new USER photos; nameless retries stay idempotent and never alter wallet or pricing',async()=>{
  assert.deepEqual((await request('/shared/options','GET',null,user2)).data,{images_enabled:true});
  const before=(await db.pool.query(`SELECT jsonb_build_object('wallets',(SELECT jsonb_agg(jsonb_build_array(id,credit_units) ORDER BY id) FROM users),'personal',(SELECT to_jsonb(s) FROM billing_settings s),'shared',(SELECT to_jsonb(s) FROM shared_settings s),'hours',(SELECT jsonb_agg(p ORDER BY hour) FROM shared_hour_prices p),'charges',(SELECT count(*) FROM message_charges),'ledger',(SELECT count(*) FROM credit_ledger)) value`)).rows[0].value;
  assert.equal((await request('/shared/options','PUT',{images_enabled:false},user2)).status,403);
  assert.equal((await request('/shared/options','PUT',{images_enabled:false},{...owner,csrf:'wrong'})).status,403);
  assert.equal((await request('/shared/options','PUT',{images_enabled:'false'},owner)).status,400);
  const ids=[];const media={mimetype:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
  const unnamed={...template,title:undefined,media};
  try{
   assert.equal((await request('/shared/options','PUT',{images_enabled:false},owner)).status,200);
   assert.equal((await request('/shared/status?layout=2','GET',null,user2)).data.images_enabled,false);
   const rejectedId=randomUUID();assert.equal((await request('/shared/send','POST',{...unnamed,request_id:rejectedId},user2)).status,403);
   assert.equal((await db.pool.query('SELECT 1 FROM campaigns WHERE shared_request_id=$1',[rejectedId])).rowCount,0);
   const owned=await request('/shared/send','POST',{...unnamed,request_id:randomUUID()},owner);assert.equal(owned.status,201);ids.push(owned.data.id);
   const text=await request('/shared/send','POST',{...unnamed,media:null,request_id:randomUUID()},user2);assert.equal(text.status,201);ids.push(text.data.id);
   assert.equal((await request('/shared/options','PUT',{images_enabled:true},owner)).status,200);
   const requestId=randomUUID(),body={...unnamed,request_id:requestId};
   const first=await request('/shared/send','POST',body,user2);assert.equal(first.status,201);ids.push(first.data.id);
   const title=(await db.pool.query('SELECT title FROM campaigns WHERE id=$1',[first.data.id])).rows[0].title;assert.equal(title,'Shared WhatsApp '+requestId);
   assert.equal((await request('/shared/options','PUT',{images_enabled:false},owner)).status,200);
   const replay=await request('/shared/send','POST',body,user2);assert.equal(replay.status,201);assert.equal(replay.data.id,first.data.id);
   assert.equal((await request('/shared/send','POST',{...body,body:'Different synthetic message'},user2)).status,409);
   assert.equal((await db.pool.query('SELECT count(*)::int n FROM campaigns WHERE shared_request_id=$1',[requestId])).rows[0].n,1);
   const after=(await db.pool.query(`SELECT jsonb_build_object('wallets',(SELECT jsonb_agg(jsonb_build_array(id,credit_units) ORDER BY id) FROM users),'personal',(SELECT to_jsonb(s) FROM billing_settings s),'shared',(SELECT to_jsonb(s) FROM shared_settings s),'hours',(SELECT jsonb_agg(p ORDER BY hour) FROM shared_hour_prices p),'charges',(SELECT count(*) FROM message_charges),'ledger',(SELECT count(*) FROM credit_ledger)) value`)).rows[0].value;assert.deepEqual(after,before);
  }finally{
   await request('/shared/options','PUT',{images_enabled:true},owner);
   if(ids.length){await db.pool.query('DELETE FROM recipients WHERE campaign_id=ANY($1::uuid[])',[ids]);await db.pool.query('DELETE FROM campaigns WHERE id=ANY($1::uuid[])',[ids]);await db.pool.query('DELETE FROM audit WHERE entity_id=ANY($1::text[])',[ids]);}
  }
 });
 await t.test('concurrent replay creates one task and never exposes another USER task or enables USER edits',async()=>{
  const body={...template,request_id:randomUUID()},before=(await request('/billing','GET',null,user1)).data.user.credit_units;
  const results=await Promise.all([request('/shared/send','POST',body,user1),request('/shared/send','POST',body,user1)]);assert.ok(results.every(r=>r.status===201));assert.equal(results[0].data.id,results[1].data.id);cid=results[0].data.id;
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM campaigns WHERE shared_request_id=$1',[body.request_id])).rows[0].n,1);assert.equal((await request('/billing','GET',null,user1)).data.user.credit_units,before);
  assert.equal((await request('/shared/send','POST',{...body,body:'different'},user1)).status,409);assert.equal((await request('/shared/send','POST',body,user2)).status,409);
  for(const path of ['/shared/tasks','/shared/records'])assert.equal((await request(path,'GET',null,user2)).data.rows.length,0);assert.equal((await request('/campaigns/'+cid+'/results','GET',null,user2)).status,403);
  for(const [path,method,body] of [['/campaigns/'+cid,'PATCH',{enabled:false}],['/campaigns/'+cid+'/send-now','POST',{}],['/campaigns/'+cid+'/cancel','POST',{}],['/campaigns/'+cid,'DELETE',null]])assert.equal((await request(path,method,body,user1)).status,403);
 });
 await t.test('successful sends charge the hourly shared rate while personal prices stay separate',async()=>{
  await quiet();cid=await task();const c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[cid])).rows[0],entry=fakeEntry(c.account_id),before=Number((await request('/billing','GET',null,user1)).data.user.credit_units),h0=hourAt();
  await worker.dispatch({id:c.account_id},entry);assert.equal(entry.count(),1);
  const r=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1',[cid])).rows[0],charge=(await db.pool.query('SELECT * FROM message_charges WHERE recipient_id=$1',[r.id])).rows[0];assert.equal(r.status,'submitted');assert.equal(r.send_account_id,c.account_id);assert.equal(charge.service,'shared');assert.equal(charge.state,'charged');assert.equal(Number(charge.amount_units),12500);assert.ok([h0,hourAt()].includes(charge.price_hour));
  assert.equal(Number((await request('/billing','GET',null,user1)).data.user.credit_units),before-12500);assert.equal((await request('/campaigns/'+cid+'/results','GET',null,user1)).data.rows[0].send_account_id,undefined);
  await request('/billing/price','PUT',{price:'0.05'},owner);assert.equal(Number((await db.pool.query('SELECT price_units FROM billing_settings')).rows[0].price_units),500);assert.equal(Number((await shared.config()).current_price_units),12500);
 });
 await t.test('invalid targets refund once and malformed numbers have no hold',async()=>{
  await quiet();cid=await task(user1,{recipients:'+60123456789\nwrong'});const c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[cid])).rows[0],entry=fakeEntry(c.account_id,'invalid'),before=Number((await request('/billing','GET',null,user1)).data.user.credit_units);
  await worker.dispatch({id:c.account_id},entry);await billing.reconcile();await billing.reconcile();assert.equal(entry.count(),0);
  const rs=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1 ORDER BY id',[cid])).rows;assert.ok(rs.every(r=>r.status==='invalid'));assert.equal((await db.pool.query('SELECT * FROM message_charges WHERE recipient_id=$1',[rs[1].id])).rowCount,0);
  assert.equal((await db.pool.query('SELECT state FROM message_charges WHERE recipient_id=$1',[rs[0].id])).rows[0].state,'refunded');assert.equal(Number((await request('/billing','GET',null,user1)).data.user.credit_units),before);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM credit_ledger WHERE recipient_id=$1 AND kind='refunded'",[rs[0].id])).rows[0].n,1);
 });
 await t.test('unknown sends remain held and paused without retries, reroutes or premature deletion',async()=>{
  await quiet();cid=await task();const c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[cid])).rows[0],entry=fakeEntry(c.account_id,'unknown');await worker.dispatch({id:c.account_id},entry);await worker.dispatch({id:c.account_id},entry);assert.equal(entry.count(),1);
  const r=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1',[cid])).rows[0];assert.equal(r.status,'unknown');assert.equal((await db.pool.query('SELECT state FROM message_charges WHERE recipient_id=$1',[r.id])).rows[0].state,'held');assert.equal((await db.pool.query('SELECT pause_reason FROM campaigns WHERE id=$1',[cid])).rows[0].pause_reason,'review');
  await shared.rebalance();assert.equal((await db.pool.query('SELECT account_id FROM campaigns WHERE id=$1',[cid])).rows[0].account_id,c.account_id);assert.equal((await request('/campaigns/'+cid,'DELETE',null,owner)).status,409);
 });
 await t.test('credit-only pauses resume after top-up even when their previous sender was disabled',async()=>{
  await quiet();cid=await task();const c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[cid])).rows[0],entry=fakeEntry(c.account_id);await db.pool.query('UPDATE users SET credit_units=1 WHERE id=$1',[u1]);await worker.dispatch({id:c.account_id},entry);assert.equal(entry.count(),0);
  assert.equal((await db.pool.query('SELECT pause_reason FROM campaigns WHERE id=$1',[cid])).rows[0].pause_reason,'credit');await db.pool.query('UPDATE accounts SET enabled=false WHERE id=$1',[c.account_id]);await credit(u1,'10');
  assert.equal((await db.pool.query('SELECT enabled FROM campaigns WHERE id=$1',[cid])).rows[0].enabled,true);await shared.rebalance();const moved=(await db.pool.query('SELECT account_id FROM campaigns WHERE id=$1',[cid])).rows[0].account_id;assert.notEqual(moved,c.account_id);const next=fakeEntry(moved);await worker.dispatch({id:moved},next);assert.equal(next.count(),1);
  await db.pool.query('UPDATE accounts SET enabled=true WHERE id=$1',[c.account_id]);await quiet();
 });
 await t.test('pending sends reroute while old ACKs and Owner purge preserve actual sender identity',async()=>{
  await db.pool.query('UPDATE accounts SET enabled=false WHERE shared_pool AND id<>$1',[a1]);await db.pool.query("UPDATE accounts SET enabled=true,status='ready',shared_state='connected',shared_checked_at=now(),next_send_at=now() WHERE id=$1",[a1]);
  cid=await task(user2,{recipients:'+60123456789\n+60123456788'});const first=fakeEntry(a1),second=fakeEntry(a2);await worker.dispatch({id:a1},first);assert.equal(first.count(),1);
  await db.pool.query("UPDATE accounts SET shared_state='offline' WHERE id=$1",[a1]);await db.pool.query("UPDATE accounts SET enabled=true,status='ready',shared_state='connected',shared_checked_at=now(),next_send_at=now() WHERE id=$1",[a2]);await shared.rebalance();assert.equal((await db.pool.query('SELECT account_id FROM campaigns WHERE id=$1',[cid])).rows[0].account_id,a2);
  await worker.dispatch({id:a2},second);assert.equal(second.count(),1);const rs=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1 ORDER BY id',[cid])).rows;assert.equal(rs[0].send_account_id,a1);assert.equal(rs[1].send_account_id,a2);
  await worker.receiveAck(a1,rs[0].message_id,2);assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[rs[0].id])).rows[0].status,'delivered');
  const balance=(await request('/billing','GET',null,user2)).data.user.credit_units;assert.equal((await request('/campaigns/'+cid,'DELETE',null,owner)).status,200);assert.equal((await db.pool.query('SELECT * FROM message_history WHERE message_id=ANY($1::text[])',[rs.map(r=>r.message_id)])).rowCount,0);assert.equal((await db.pool.query('SELECT * FROM history_exclusions WHERE account_id=ANY($1::uuid[])',[[a1,a2]])).rowCount,2);assert.equal((await request('/billing','GET',null,user2)).data.user.credit_units,balance);
 });
 await t.test('late error refunds the original held amount after hourly repricing, only once',async()=>{
  await quiet();cid=await task(user2);const c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[cid])).rows[0],entry=fakeEntry(c.account_id,'awaiting'),before=Number((await request('/billing','GET',null,user2)).data.user.credit_units);await worker.dispatch({id:c.account_id},entry);
  const r=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1',[cid])).rows[0];assert.equal(r.status,'awaiting_ack');await request('/shared/settings','PUT',{...pricing,hours:pricing.hours.map(p=>({...p,price:'2.00'}))},owner);
  await worker.receiveAck(c.account_id,r.message_id,-1);await billing.reconcile();await billing.reconcile();assert.equal(Number((await request('/billing','GET',null,user2)).data.user.credit_units),before);assert.equal(Number((await db.pool.query('SELECT amount_units FROM message_charges WHERE recipient_id=$1',[r.id])).rows[0].amount_units),12500);
 });
 await t.test('shared reservations across senders serialize the wallet and never overspend',async()=>{
  await quiet();cid=await task(user2,{recipients:'+60123456780\n+60123456781\n+60123456782'});const rs=(await db.pool.query('SELECT id FROM recipients WHERE campaign_id=$1 ORDER BY id',[cid])).rows;await db.pool.query('UPDATE users SET credit_units=40000 WHERE id=$1',[u2]);
  const results=await Promise.all(rs.map(r=>db.transaction(tx=>billing.reserveForSend(tx,u2,r.id))));assert.equal(results.filter(r=>r.ok).length,2);assert.equal(Number((await db.pool.query('SELECT credit_units FROM users WHERE id=$1',[u2])).rows[0].credit_units),0);
  for(const r of rs)await billing.settle(r.id,'pending');assert.equal(Number((await db.pool.query('SELECT credit_units FROM users WHERE id=$1',[u2])).rows[0].credit_units),40000);await quiet();
 });
 await t.test('hourly probes count real connections and stale worker heartbeat removes them from availability',async()=>{
  await db.pool.query("UPDATE accounts SET enabled=true,status='ready',shared_state='unknown',shared_checked_at=now()-interval '2 hours' WHERE id=ANY($1::uuid[])",[[a1,a2]]);
  const accounts=(await db.pool.query('SELECT id,worker_group FROM accounts WHERE id=ANY($1::uuid[])',[[a1,a2]])).rows;for(const a of accounts)await shared.checkGroup(a.worker_group,new Map([[a.id,fakeEntry(a.id)]]));
  assert.equal((await request('/shared/status','GET',null,owner)).data.summary.connected,2);
  const latest=(await db.pool.query('SELECT DISTINCT ON(worker_group) * FROM shared_health_hourly ORDER BY worker_group,hour_start DESC')).rows;assert.equal(latest.length,2);assert.equal(latest.reduce((n,r)=>n+r.connected,0),2);assert.equal(latest.reduce((n,r)=>n+r.total,0),120);
  assert.ok((await request('/shared/hourly','GET',null,owner)).data.length>0);
  await db.pool.query("UPDATE worker_health SET heartbeat_at=now()-interval '5 minutes'");assert.equal((await request('/shared/status','GET',null,user2)).data.summary.available,0);await db.pool.query('UPDATE worker_health SET heartbeat_at=now()');
 });
 await t.test('interrupted shared sends remain unknown and paused with their original hold',async()=>{
  await quiet();cid=await task(user2);const c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[cid])).rows[0],r=(await db.pool.query('SELECT id FROM recipients WHERE campaign_id=$1',[cid])).rows[0];await db.transaction(tx=>billing.reserveForSend(tx,u2,r.id));
  await db.pool.query("UPDATE recipients SET status='sending',send_account_id=$2,started_at=now() WHERE id=$1",[r.id,c.account_id]);const group=(await db.pool.query('SELECT worker_group FROM accounts WHERE id=$1',[c.account_id])).rows[0].worker_group;await shared.recoverInterrupted(group);
  assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[r.id])).rows[0].status,'unknown');assert.equal((await db.pool.query('SELECT pause_reason FROM campaigns WHERE id=$1',[cid])).rows[0].pause_reason,'review');assert.equal((await db.pool.query('SELECT state FROM message_charges WHERE recipient_id=$1',[r.id])).rows[0].state,'held');await quiet();
 });
 await t.test('locked USER and closed service stop new work, while Owner sends remain unlimited',async()=>{
  cid=await task(user2);const c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[cid])).rows[0],entry=fakeEntry(c.account_id);assert.equal((await request('/users/'+u2+'/status','PATCH',{active:true,locked:true},owner)).status,200);await worker.dispatch({id:c.account_id},entry);assert.equal(entry.count(),0);assert.equal((await request('/shared/status','GET',null,user2)).status,401);
  assert.equal((await request('/users/'+u2+'/status','PATCH',{active:true,locked:false},owner)).status,200);user2=await login('shared_user_2');
  await request('/shared/settings','PUT',{...pricing,enabled:false},owner);assert.equal((await request('/shared/send','POST',{...template,request_id:randomUUID()},user1)).status,503);await worker.dispatch({id:c.account_id},entry);assert.equal(entry.count(),0);
  await request('/shared/settings','PUT',pricing,owner);await quiet();cid=await task(owner);const owned=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[cid])).rows[0],unlimited=fakeEntry(owned.account_id);await worker.dispatch({id:owned.account_id},unlimited);assert.equal(unlimited.count(),1);
  const r=(await db.pool.query('SELECT id FROM recipients WHERE campaign_id=$1',[cid])).rows[0];assert.equal((await db.pool.query('SELECT * FROM message_charges WHERE recipient_id=$1',[r.id])).rowCount,0);
 });
 await t.test('repeated migrations preserve flags, prices, balances and settled charges',async()=>{
  const balances=(await db.pool.query('SELECT id,credit_units FROM users ORDER BY id')).rows,prices=await shared.config(),charges=(await db.pool.query('SELECT * FROM message_charges ORDER BY recipient_id')).rows;await db.migrate();
  assert.deepEqual((await db.pool.query('SELECT id,credit_units FROM users ORDER BY id')).rows,balances);assert.equal((await shared.config()).current_price_units,prices.current_price_units);assert.deepEqual((await db.pool.query('SELECT * FROM message_charges ORDER BY recipient_id')).rows,charges);assert.equal((await db.pool.query('SELECT count(*)::int n FROM accounts WHERE shared_pool')).rows[0].n,120);
 });
await t.test('Personal numbers never enter shared dispatch, and shared pages omit wallet fields',async()=>{
  await quiet();const id=randomUUID(),source=(await db.pool.query('SELECT phone FROM accounts WHERE id=$1',[a1])).rows[0].phone;
  const was=(await db.pool.query('SELECT enabled FROM accounts WHERE id=$1',[a2])).rows[0].enabled;
  try{
   await db.pool.query("INSERT INTO accounts(id,label,worker_group,phone,status) VALUES($1,'Personal isolation fixture','group-a',$2,'ready')",[id,source]);
   const regular=(await request('/accounts','GET',null,owner)).data;assert.ok(regular.some(a=>a.id===id));assert.ok(regular.every(a=>!a.shared_pool));
   const list=(await request('/shared/accounts','GET',null,owner)).data;assert.equal(list.total,120);assert.ok(list.rows.every(a=>a.id!==id));
   const rejected=await request('/shared/accounts','POST',{phones:'+'+source,label:'Do not import',groups:['group-a']},owner);assert.equal(rejected.status,409);assert.match(rejected.data.error,/普通 WhatsApp/);
   assert.equal((await request('/shared/accounts/'+a1+'/connect','POST',{},owner)).status,409);
   const candidate=await shared.chooseAccount(db.pool);assert.notEqual(candidate?.id,a1);assert.notEqual(candidate?.id,id);
   await db.pool.query('UPDATE accounts SET enabled=false WHERE id=$1',[a2]);
   assert.equal((await request('/shared/send','POST',{...template,request_id:randomUUID()},owner)).status,503);
   for(const session of [owner,user1]){
    const status=(await request('/shared/status?layout=2','GET',null,session)).data;
    assert.equal(Object.hasOwn(status,'balance_units'),false);
    const legacy=(await request('/shared/status','GET',null,session)).data;assert.ok(Object.hasOwn(legacy,'balance_units'));assert.equal(Object.hasOwn(status,'credit_units'),false);
   }
   const wallet=(await request('/billing','GET',null,user1)).data;assert.ok(Object.hasOwn(wallet.user,'credit_units'));assert.ok(Array.isArray(wallet.ledger));
  }finally{await db.pool.query('DELETE FROM accounts WHERE id=$1',[id]);await db.pool.query('UPDATE accounts SET enabled=$2 WHERE id=$1',[a2,was]);}
 });
 await t.test('More than 1000 records stay paginated and inactive records do not enter background work',async()=>{
  const seeds=Array.from({length:1001},(_,i)=>({id:randomUUID(),phone:'+6019900'+String(i).padStart(4,'0')})),phone='+60195555555';let created;
  try{
   await db.pool.query("INSERT INTO accounts(id,label,worker_group,enabled,status,shared_pool,registration_phone) SELECT r.id,'Large record fixture','group-a',false,'disabled',true,r.phone FROM jsonb_to_recordset($1::jsonb) r(id uuid,phone text)",[JSON.stringify(seeds)]);
   const response=await request('/shared/accounts','POST',{phones:phone,label:'Beyond old limit',groups:['group-a']},owner);assert.equal(response.status,201,JSON.stringify(response));assert.equal(response.data.created,1);
   created=(await db.pool.query('SELECT id FROM accounts WHERE shared_pool AND registration_phone=$1 AND deleted_at IS NULL',[phone])).rows[0].id;
   const last=(await request('/shared/accounts?page=23','GET',null,owner)).data;assert.equal(last.total,1122);assert.equal(last.rows.length,22);
   const idle=(await db.pool.query(worker.accountWorkSQL,['group-a',[]])).rows;assert.ok(idle.every(a=>!seeds.some(s=>s.id===a.id)&&a.id!==created));
   const running=(await db.pool.query(worker.accountWorkSQL,['group-a',[seeds[0].id]])).rows;assert.ok(running.some(a=>a.id===seeds[0].id));
   await db.pool.query('UPDATE accounts SET purge_requested=true WHERE id=$1',[seeds[1].id]);assert.ok((await db.pool.query(worker.accountWorkSQL,['group-a',[]])).rows.some(a=>a.id===seeds[1].id));
   await db.pool.query("DELETE FROM shared_health_hourly WHERE worker_group='group-a'");await shared.checkGroup('group-a',new Map());
   assert.equal((await db.pool.query('SELECT count(*)::int n FROM accounts WHERE id=ANY($1::uuid[]) AND shared_checked_at IS NOT NULL',[seeds.map(s=>s.id)])).rows[0].n,0);
  }finally{await db.pool.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])',[[...seeds.map(s=>s.id),...(created?[created]:[])]]);}
 });
});

