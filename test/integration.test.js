const {test}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
test('PostgreSQL: USER migration, isolation, schedules, receipts, retained deletes and Owner purge',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_test_'+randomUUID().replaceAll('-','');
 if(!process.env.TEST_SINGLE_DATABASE)await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);if(!process.env.TEST_SINGLE_DATABASE)url.pathname='/'+name;
 Object.assign(process.env,{APP_VAULT_KEY:'11'.repeat(32),DATABASE_URL:url.toString(),SERVICE_ROLE:'api',PORT:'0',PUBLIC_URL:'http://localhost:3000',INTERNAL_SECRET:'test-internal-secret-thirty-two-characters',BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'test-owner-password-123',WORKER_ROUTES_JSON:'{"group-a":"http://127.0.0.1:9"}'});
 const db=require('../src/db');let server; t.after(async()=>{if(server)await new Promise(r=>server.close(r));await db.pool.end();if(!process.env.TEST_SINGLE_DATABASE)await admin.query('DROP DATABASE '+name);await admin.end();});await db.migrate();server=await require('../src/api').start();const base='http://127.0.0.1:'+server.address().port;
 async function request(path,method='GET',body=null,s=null){const r=await fetch(base+'/api'+path,{method,headers:{Origin:'http://localhost:3000','Content-Type':'application/json',...(s?{Cookie:s.cookie,'X-CSRF-Token':s.csrf}:{})},...(body!==null?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 async function login(username,password='user-password-123'){const r=await request('/login','POST',{username,password});assert.equal(r.status,200);const s={cookie:r.cookie};s.csrf=(await request('/me','GET',null,s)).data.csrf;return s;}
 const owner=await login('owner','test-owner-password-123');
 const a=(await request('/accounts','POST',{label:'A',worker_group:'group-a'},owner)).data.id,b=(await request('/accounts','POST',{label:'B',worker_group:'group-a'},owner)).data.id;
 const uid=(await request('/users','POST',{username:'user1',password:'user-password-123',role:'user',grants:[{account_id:a}]},owner)).data.id;
 const uid2=(await request('/users','POST',{username:'user2',password:'user-password-123',role:'user',grants:[{account_id:b}]},owner)).data.id;
 const user=await login('user1'),user2=await login('user2');
 const template={title:'Task',account_id:a,body:'Authorized fake message',recipients:'0123456789\n+60123456789\nwrong',opt_in_confirmed:true,timezone:'Asia/Kuala_Lumpur',window_start:'09:00',window_end:'18:00',scheduled_at:'2030-10-02T09:15',expires_at:'2030-10-03T18:00',weekdays:[1,2,3,4,5,6,7],interval_ms:10000};
 await t.test('prepaid defaults deny USER sending and direct controls; Owner can configure credit',async()=>{
  assert.equal((await request('/campaigns','POST',template,user)).status,402);
  assert.equal(Number((await request('/billing','GET',null,user)).data.user.credit_units),0);
  assert.equal((await request('/billing?user_id='+uid,'GET',null,user2)).data.user.id,uid2);
  for(const [path,method,body] of [['/billing/price','PUT',{price:'0.10'}],['/billing/adjust','POST',{}],['/accounts/'+a+'/connection?mode=operate','GET',null]])assert.equal((await request(path,method,body,user)).status,403);
  assert.equal((await request('/accounts/'+a+'/connection?mode=view','GET',null,user)).status,403);
  assert.equal((await request('/accounts','GET',null,user)).data[0].operate,false);
  const {WebSocket}=require('ws');
  await new Promise((resolve,reject)=>{const ws=new WebSocket(base.replace('http:','ws:')+'/screen/'+a+'?mode=operate',{headers:{Origin:'http://localhost:3000',Cookie:user.cookie}});ws.on('unexpected-response',(_q,r)=>{try{assert.equal(r.statusCode,403);r.resume();resolve();}catch(e){reject(e);}});ws.on('open',()=>{ws.close();reject(Error('USER control opened'));});ws.on('error',reject);});
  assert.equal((await request('/billing/price','PUT',{price:'0.00001'},owner)).status,400);
  assert.equal((await request('/billing/price','PUT',{price:'0.1000'},owner)).status,200);
  const adjustment={user_id:uid,amount:'100',direction:'add',note:'Test credit only',request_id:randomUUID()};
  assert.equal((await request('/billing/adjust','POST',adjustment,owner)).status,200);
  assert.equal((await request('/billing/adjust','POST',adjustment,owner)).status,200);
  assert.equal(Number((await request('/billing','GET',null,user)).data.user.credit_units),1000000);
  assert.equal((await request('/billing/adjust','POST',{...adjustment,request_id:randomUUID(),amount:'101',direction:'subtract'},owner)).status,400);
  for(const session of [user,user2]){
   const mine=(await request('/billing?user_id='+uid,'GET',null,session)).data;
   assert.deepEqual(Object.keys(mine).sort(),['currency','ledger','scale','user']);assert.equal(mine.currency,'MYR');assert.equal(mine.scale,10000);
   assert.equal(mine.user.id,session===user?uid:uid2);assert.deepEqual(Object.keys(mine.user).sort(),['credit_units','id','role','username']);
   assert.equal(mine.ledger.length,session===user?1:0);for(const row of mine.ledger){assert.deepEqual(Object.keys(row).sort(),['balance_units','created_at','delta_units','id','kind','recipient_id']);assert.equal(row.note,undefined);assert.equal(row.actor_id,undefined);}
  }
  const ownerView=(await request('/billing?user_id='+uid,'GET',null,owner)).data;
  assert.equal(ownerView.user.id,uid);assert.equal(Number(ownerView.price_units),1000);assert.equal(Number(ownerView.held_units),0);assert.equal(ownerView.ledger.length,1);assert.deepEqual(ownerView.held,[]);
 });
 let task;
 await t.test('users have equal assigned capabilities and cannot administer IDs or cross scope',async()=>{
  assert.equal((await request('/users','GET',null,user)).status,403);
  assert.equal((await request('/users','POST',{username:'nested',role:'user'},user)).status,403);
  assert.equal((await request('/users/'+uid2,'PATCH',{active:false},user)).status,403);
  assert.equal((await request('/accounts/'+b,'PATCH',{label:'no'},user)).status,403);
  assert.equal((await request('/accounts/'+a,'PATCH',{label:'Renamed'},user)).status,200);
  assert.equal((await request('/accounts','GET',null,user)).data.length,1);
  assert.equal((await request('/accounts/'+a+'/connection','GET',null,user)).status,403);
  assert.equal((await request('/accounts/'+a+'/start','POST',{},user)).status,503);
  assert.equal((await request('/audit','GET',null,user)).status,403);
  assert.equal((await request('/data/purge','POST',{confirm:'DELETE HISTORY'},user)).status,403);
  const bad={...user,csrf:'bad'};assert.equal((await request('/accounts/'+a,'PATCH',{label:'bad'},bad)).status,403);
 });
 await t.test('Malaysia dates convert once; immediate mode and edits preserve task recipients',async()=>{
  const r=await request('/campaigns','POST',{...template,send_now:true},user);assert.equal(r.status,201);assert.equal(r.data.duplicates,1);task=r.data.id;
  let c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[task])).rows[0];assert.equal(c.scheduled_at.toISOString(),'2030-10-02T01:15:00.000Z');assert.equal(c.send_now,true);
  const orig=c.scheduled_at.toISOString();assert.equal((await request('/campaigns/'+task+'/send-now','POST',{},user)).status,200);
  c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[task])).rows[0];assert.equal(c.scheduled_at.toISOString(),orig);
  assert.equal((await request('/campaigns/'+task,'PATCH',{window_start:'10:00',window_end:'16:00',timezone:'Asia/Kuala_Lumpur',scheduled_at:'2030-10-02T10:00',expires_at:'2030-10-03T16:00',weekdays:[2],interval_ms:25000,send_now:false},owner)).status,200);
  c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[task])).rows[0];assert.equal(c.scheduled_at.toISOString(),'2030-10-02T02:00:00.000Z');assert.equal(c.send_now,false);assert.equal(c.interval_ms,25000);
  assert.equal((await request('/campaigns/'+task+'/results','GET',null,user2)).status,403);
 });
 const worker=require('../src/worker');
 await t.test('receipts accept string IDs, ignore missing fields and never downgrade delivery',async()=>{
  const rec=(await db.pool.query("SELECT * FROM recipients WHERE campaign_id=$1 AND status='pending'",[task])).rows[0];
  await worker.receiveAck(a,null,1);await worker.receiveAck(a,'missing-ack',undefined);
  assert.equal((await db.pool.query('SELECT * FROM receipts')).rowCount,0);
  await worker.receiveAck(a,'message-1',3);
  await db.pool.query("UPDATE recipients SET message_id='message-1',status='awaiting_ack' WHERE id=$1",[rec.id]);
  await worker.recordMessage(a,{id:'message-1',fromMe:true,to:'60123456789@c.us',body:'hello',timestamp:Math.floor(Date.now()/1000),ack:0},uid);
  await worker.receiveAck(a,'message-1',1);
  assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[rec.id])).rows[0].status,'read');
  const m=(await request('/messages','GET',null,user)).data[0];assert.equal(m.status,'read');assert.equal(m.body,'hello');assert.equal(m.actor,'user1');
  assert.equal((await request('/messages','GET',null,user2)).data.length,0);
 });
 await t.test('overview scopes accounts, deduplicates task history and fills seven Malaysia dates',async()=>{
  const r=await request('/overview','GET',null,user);assert.equal(r.status,200);assert.equal(r.data.counts.read,1);assert.equal(r.data.counts.invalid,1);assert.equal(r.data.days.length,7);assert.equal(r.data.timezone,'Asia/Kuala_Lumpur');
  assert.deepEqual((await request('/overview','GET',null,user2)).data.counts,{});
  const today=r.data.days.at(-1).date;
  await db.pool.query(`INSERT INTO message_history(account_id,message_id,recipient,body,status,ack,sent_at) VALUES($1,'overview-boundary','60123456789','test','submitted',1,($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'))`,[a,today]);
  const updated=(await request('/overview','GET',null,user)).data;assert.equal(updated.counts.submitted,1);assert.equal(updated.days.at(-1).counts.submitted,1);assert.equal(updated.days[0].date,require('luxon').DateTime.fromISO(today).minus({days:6}).toISODate());
  await db.pool.query(`UPDATE message_history SET deleted_at=now() WHERE message_id='overview-boundary'`);
  assert.equal((await request('/overview','GET',null,user)).data.counts.submitted,undefined);
  await db.pool.query(`DELETE FROM message_history WHERE message_id='overview-boundary'`);
 });
 await t.test('unknown send pauses task but keeps browser connected and never retries recipient',async()=>{
  const r=await request('/campaigns','POST',{...template,recipients:'0123456789',send_now:true,title:'Unknown send'},user),cid=r.data.id;
  await db.pool.query('UPDATE campaigns SET enabled=false WHERE id<>$1',[cid]);await db.pool.query('UPDATE accounts SET next_send_at=now() WHERE id=$1',[a]);
  let calls=0,destroyed=false;const e={id:a,ready:true,client:{getNumberId:async()=>({_serialized:'60123456789@c.us'}),sendMessage:async()=>{calls++;throw Error('fake transport');},destroy:async()=>{destroyed=true;}}};
  await worker.dispatch({id:a},e);await worker.dispatch({id:a},e);
  assert.equal(calls,1);assert.equal(destroyed,false);assert.equal(e.ready,true);
  assert.equal((await db.pool.query('SELECT enabled FROM campaigns WHERE id=$1',[cid])).rows[0].enabled,false);
  assert.equal((await db.pool.query('SELECT status FROM recipients WHERE campaign_id=$1',[cid])).rows[0].status,'unknown');
  const blocked=await request('/campaigns/'+cid+'/send-now','POST',{},user);assert.equal(blocked.status,400);assert.match(blocked.data.error,/待核对/);assert.equal(calls,1);
  // Read-only reconciliation recovers a unique existing message without sending.
  const rr=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1',[cid])).rows[0];
  const partial={id:'partial-history-fixture',fromMe:true,to:'60123456789@c.us',body:template.body,timestamp:Math.floor(+new Date(rr.started_at)/1000),ack:2};
  await worker.syncHistory(a,{client:{pupPage:{evaluate:async()=>({messages:[partial],chatErrors:1})}}});
  assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[rr.id])).rows[0].status,'unknown');
  assert.equal((await db.pool.query('SELECT state FROM message_charges WHERE recipient_id=$1',[rr.id])).rows[0].state,'held');assert.equal(calls,1);
  assert.equal((await db.pool.query('SELECT history_sync_error FROM accounts WHERE id=$1',[a])).rows[0].history_sync_error,'PARTIAL_CHAT_HISTORY');
  await db.pool.query("DELETE FROM message_history WHERE message_id='partial-history-fixture'");await db.pool.query("DELETE FROM receipts WHERE message_id='partial-history-fixture'");
  await worker.reconcileUnknown(a,{getChatById:async()=>({fetchMessages:async()=>[{id:'recovered-id',fromMe:true,to:'60123456789@c.us',body:template.body,timestamp:Math.floor(+new Date(rr.started_at)/1000),ack:2}]})});
  assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[rr.id])).rows[0].status,'delivered');assert.equal(calls,1);
 });
 await t.test('periodic snapshots recover missed outgoing events and ACKs without sending',async()=>{
  const entry={client:{pupPage:{evaluate:async()=>({messages:[{id:'polled',fromMe:true,to:'60123456789@c.us',body:'missed event',timestamp:Math.floor(Date.now()/1000),ack:2}],chatErrors:0})}}};
  await worker.syncHistory(a,entry);await worker.syncHistory(a,entry);
  const rows=(await db.pool.query("SELECT * FROM message_history WHERE message_id='polled'")).rows;assert.equal(rows.length,1);assert.equal(rows[0].status,'delivered');assert.equal(rows[0].actor_id,null);
  assert.ok((await db.pool.query('SELECT history_synced_at FROM accounts WHERE id=$1',[a])).rows[0].history_synced_at);
  assert.equal((await request('/messages/'+a+'/polled','DELETE',null,owner)).status,200);
  await worker.syncHistory(a,entry);assert.equal((await db.pool.query("SELECT 1 FROM message_history WHERE message_id='polled'")).rowCount,0);
 });
 await t.test('UTC conversion preserves old window instants and photos travel through the fake sender',async()=>{
  const {inWindow}=require('../src/domain');
  for(const times of [['02:00','05:00'],['22:00','02:00'],['09:00','09:00']]){
   const id=(await request('/campaigns','POST',{...template,window_start:times[0],window_end:times[1],scheduled_at:'2026-01-01T00:00',expires_at:'2030-01-01T00:00',weekdays:[1]},user)).data.id;
   const old=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[id])).rows[0];await db.migrate();
   const current=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[id])).rows[0];assert.equal(current.timezone,'UTC');assert.equal(+current.scheduled_at,+old.scheduled_at);
   // Old equal windows represented the entire local calendar day.
   const original=times[0]===times[1]?{...old,window_start:'00:00',window_end:'00:00'}:old;
   for(let hour=0;hour<168;hour++)assert.equal(inWindow(current,new Date(Date.UTC(2026,8,27,hour))),inWindow(original,new Date(Date.UTC(2026,8,27,hour))));
  }
  const photo={mimetype:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII='};
  const made=await request('/campaigns','POST',{...template,body:'',media:photo,timezone:'UTC',send_now:true,recipients:'0123456789'},user);assert.equal(made.status,201);
  const c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[made.data.id])).rows[0];assert.equal(c.scheduled_at.toISOString(),'2030-10-02T09:15:00.000Z');assert.equal(c.media.data,photo.data);
  const list=(await request('/campaigns','GET',null,user)).data.find(x=>x.id===c.id);assert.equal(list.has_image,true);assert.equal(list.media,undefined);
  assert.equal((await request('/campaigns/'+c.id+'/image','GET',null,user2)).status,403);
  let calls=0;const result=await worker.send({id:a,client:{getNumberId:async()=>({_serialized:'60123456789@c.us'}),sendMessage:async(to,media,opts)=>{calls++;assert.equal(media.mimetype,'image/png');assert.equal(media.data,photo.data);assert.equal(opts.caption,'');return{id:'photo-msg',fromMe:true,to,type:'image',body:'',ack:2};}}},{phone:'+60123456789'},c);
  assert.equal(calls,1);assert.equal(result.status,'delivered');assert.equal((await db.pool.query("SELECT message_type FROM message_history WHERE message_id='photo-msg'")).rows[0].message_type,'image');
 });
 await t.test('image captions use the pinned enqueue path and settle only from the real message ACK',async()=>{
  const {LiveWebClient}=require('../src/live-web-client'),{LoadUtils}=require('whatsapp-web.js/src/util/Injected/Utils'),{installSendFixture}=require('./send-fixture.cjs');
  const photo={data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=',mimetype:'image/png'};
  const cid=(await request('/campaigns','POST',{...template,body:'Photo caption 中文',media:photo,recipients:'0123456789\n0123456790',send_now:true},user)).data.id;
  await db.pool.query('UPDATE campaigns SET enabled=false WHERE id<>$1',[cid]);await db.pool.query('UPDATE accounts SET next_send_at=now() WHERE id=$1',[a]);
  const before=Number((await db.pool.query('SELECT credit_units FROM users WHERE id=$1',[uid])).rows[0].credit_units),previous=global.window;
  global.window={atob:global.atob};LoadUtils();const fixture=installSendFixture();
  try{
   const client=new LiveWebClient();client.pupPage={evaluate:async(fn,...args)=>fn(...args)};client.getNumberId=async phone=>({_serialized:phone+'@c.us'});
   const enqueue=client.sendWorkspaceMessage.bind(client);client.sendWorkspaceMessage=async token=>{
    const saved=(await db.pool.query("SELECT message_id,send_attempt_id FROM recipients WHERE campaign_id=$1 AND status='sending'",[cid])).rows[0];
    assert.ok(saved.message_id,'The real message ID must be durable before enqueue');assert.equal(saved.send_attempt_id,token);return enqueue(token);
   };
   await worker.dispatch({id:a},{id:a,ready:true,client});
   const row=(await db.pool.query("SELECT * FROM recipients WHERE campaign_id=$1 AND status='awaiting_ack'",[cid])).rows[0];
   assert.equal(fixture.sent.length,1);assert.equal(fixture.sent[0].caption,'Photo caption 中文');assert.equal(fixture.sent[0].type,'image');
   assert.equal(row.status,'awaiting_ack');assert.ok(row.message_id);assert.equal(row.media_fingerprint,'synthetic-processed-image-hash');assert.ok(row.send_attempt_id);
   await db.pool.query("UPDATE message_history SET body='legacy-thumbnail-body' WHERE message_id=$1",[row.message_id]);
   await worker.recordMessage(a,{id:row.message_id,fromMe:true,to:'60123456789@c.us',body:'Photo caption 中文',type:'image',ack:0},uid,false);
   assert.equal((await db.pool.query('SELECT body FROM message_history WHERE message_id=$1',[row.message_id])).rows[0].body,'Photo caption 中文');
   assert.equal((await db.pool.query('SELECT state FROM message_charges WHERE recipient_id=$1',[row.id])).rows[0].state,'held');
   await db.pool.query('UPDATE accounts SET next_send_at=now() WHERE id=$1',[a]);
   await worker.dispatch({id:a},{id:a,ready:true,client});assert.equal(fixture.sent.length,1,'Do not enqueue another message before the real server ACK');
   await worker.receiveAck(a,row.message_id,2);await require('../src/billing').reconcile();await require('../src/billing').reconcile();
   assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[row.id])).rows[0].status,'delivered');
   assert.equal((await db.pool.query("SELECT * FROM credit_ledger WHERE recipient_id=$1 AND kind='charged'",[row.id])).rowCount,1);
   assert.equal(Number((await db.pool.query('SELECT credit_units FROM users WHERE id=$1',[uid])).rows[0].credit_units),before-1000);
   assert.equal(fixture.serializations,0);assert.equal(fixture.seen,0);
  }finally{global.window=previous;}
 });
 await t.test('preallocated image IDs survive submission exceptions and early real ACKs cannot be overwritten',async()=>{
  const photo={data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=',mimetype:'image/png'};
  for(const early of [false,true]){
   const cid=(await request('/campaigns','POST',{...template,body:early?'Early image receipt':'Known image identity',media:photo,recipients:'0123456789',send_now:true},user)).data.id;
   await db.pool.query('UPDATE campaigns SET enabled=false WHERE id<>$1',[cid]);await db.pool.query('UPDATE accounts SET next_send_at=now() WHERE id=$1',[a]);
   const mid=early?'synthetic-early-image':'synthetic-known-image';let calls=0;
   const client={getNumberId:async()=>({_serialized:'60123456789@c.us'}),prepareWorkspaceMessage:async()=>({id:mid,filehash:'synthetic-known-fingerprint'}),discardWorkspaceMessage:async()=>{},sendWorkspaceMessage:async()=>{
    calls++;assert.equal((await db.pool.query('SELECT message_id FROM recipients WHERE campaign_id=$1',[cid])).rows[0].message_id,mid);
    if(early)await worker.receiveAck(a,mid,2);throw Error('Synthetic exception after enqueue boundary');
   }};
   await worker.dispatch({id:a},{id:a,ready:true,client});
   let row=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1',[cid])).rows[0];assert.equal(row.message_id,mid);assert.equal(calls,1);
   if(!early){assert.equal(row.status,'unknown');assert.equal((await db.pool.query('SELECT state FROM message_charges WHERE recipient_id=$1',[row.id])).rows[0].state,'held');await worker.receiveAck(a,mid,2);}
   else{assert.equal(row.status,'delivered');assert.equal((await db.pool.query('SELECT enabled FROM campaigns WHERE id=$1',[cid])).rows[0].enabled,true);}
   await require('../src/billing').reconcile();await require('../src/billing').reconcile();
   row=(await db.pool.query('SELECT * FROM recipients WHERE id=$1',[row.id])).rows[0];assert.equal(row.status,'delivered');
   assert.equal((await db.pool.query("SELECT * FROM credit_ledger WHERE recipient_id=$1 AND kind='charged'",[row.id])).rowCount,1);
  }
 });
 await t.test('preparation failure never sends, pauses the task and refunds exactly once',async()=>{
  const cid=(await request('/campaigns','POST',{...template,recipients:'0123456789',send_now:true,title:'Preparation failure'},user)).data.id;
  await db.pool.query('UPDATE campaigns SET enabled=false WHERE id<>$1',[cid]);await db.pool.query('UPDATE accounts SET next_send_at=now() WHERE id=$1',[a]);
  let sent=0;const before=Number((await db.pool.query('SELECT credit_units FROM users WHERE id=$1',[uid])).rows[0].credit_units);
  const client={getNumberId:async()=>({_serialized:'60123456789@c.us'}),prepareWorkspaceMessage:async()=>{throw Error('Synthetic media upload error');},sendWorkspaceMessage:async()=>{sent++;},discardWorkspaceMessage:async()=>{}};
  await worker.dispatch({id:a},{id:a,ready:true,client});await require('../src/billing').reconcile();
  const row=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1',[cid])).rows[0];assert.equal(row.status,'failed');assert.equal(sent,0);
  assert.equal((await db.pool.query('SELECT pause_reason FROM campaigns WHERE id=$1',[cid])).rows[0].pause_reason,'review');
  assert.equal((await db.pool.query("SELECT * FROM credit_ledger WHERE recipient_id=$1 AND kind='refunded'",[row.id])).rowCount,1);
  assert.equal(Number((await db.pool.query('SELECT credit_units FROM users WHERE id=$1',[uid])).rows[0].credit_units),before);
 });
 await t.test('late lookup cannot submit after its deadline and permissions are rechecked after preparation',async()=>{
  const cid=(await request('/campaigns','POST',{...template,recipients:'0123456789',send_now:true,title:'Deadline guard'},user)).data.id;
  const campaign=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[cid])).rows[0],row=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1',[cid])).rows[0];
  let release,sent=0;const lookup=new Promise(resolve=>release=resolve);
  const client={getNumberId:()=>lookup,sendMessage:async()=>{sent++;}};
  assert.equal((await worker.send({id:a,client},row,campaign,{timeoutMs:15})).status,'failed');release({_serialized:'60123456789@c.us'});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(sent,0);
  let prepared;const slowPreparation=new Promise(resolve=>prepared=resolve);
  const slow={getNumberId:async()=>({_serialized:'60123456789@c.us'}),prepareWorkspaceMessage:()=>slowPreparation,sendWorkspaceMessage:async()=>{sent++;},discardWorkspaceMessage:async()=>{}};
  const timed=await worker.send({id:a,client:slow},row,campaign,{timeoutMs:30});assert.equal(timed.status,'failed');assert.equal(timed.error,'MEDIA_PREPARATION_TIMEOUT');
  prepared({});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(sent,0);
  const tracked={getNumberId:async()=>({_serialized:'60123456789@c.us'}),prepareWorkspaceMessage:async()=>{await db.pool.query('UPDATE users SET locked=true WHERE id=$1',[uid]);return {};},sendWorkspaceMessage:async()=>{sent++;},discardWorkspaceMessage:async()=>{}};
  try{assert.equal((await worker.send({id:a,client:tracked},row,campaign)).status,'pending');assert.equal(sent,0);}finally{await db.pool.query('UPDATE users SET locked=false WHERE id=$1',[uid]);}
 });
 await t.test('late enqueue results attach only to their own attempt and settle once without resending',async()=>{
  const cid=(await request('/campaigns','POST',{...template,body:'Late completion fixture',recipients:'0123456789',send_now:true},user)).data.id;
  const campaign=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[cid])).rows[0],row=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1',[cid])).rows[0];
  await db.transaction(c=>require('../src/billing').reserve(c,uid,row.id));
  let release,calls=0;const completion=new Promise(resolve=>release=resolve);
  const client={getNumberId:async()=>({_serialized:'60123456789@c.us'}),prepareWorkspaceMessage:async()=>({}),sendWorkspaceMessage:()=>{calls++;return completion;},discardWorkspaceMessage:async()=>{}};
  assert.equal((await worker.send({id:a,client},row,campaign,{timeoutMs:50})).status,'unknown');assert.equal(calls,1);
  await db.pool.query("UPDATE recipients SET status='unknown' WHERE id=$1",[row.id]);
  release({id:'synthetic-late-send',fromMe:true,to:'60123456789@c.us',body:campaign.body,type:'chat',ack:2});
  for(let n=0;n<50;n++){if((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[row.id])).rows[0].status==='delivered')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[row.id])).rows[0].status,'delivered');
  await require('../src/billing').reconcile();await require('../src/billing').reconcile();assert.equal((await db.pool.query("SELECT * FROM credit_ledger WHERE recipient_id=$1 AND kind='charged'",[row.id])).rowCount,1);assert.equal(calls,1);
  const cid2=(await request('/campaigns','POST',{...template,body:'Stale completion fixture',recipients:'0123456789',send_now:true},user)).data.id;
  const c2=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[cid2])).rows[0],r2=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1',[cid2])).rows[0];
  let releaseOld;const old=new Promise(resolve=>releaseOld=resolve);client.sendWorkspaceMessage=()=>old;
  assert.equal((await worker.send({id:a,client},r2,c2,{timeoutMs:50})).status,'unknown');
  await db.pool.query("UPDATE recipients SET status='unknown',send_attempt_id=$2 WHERE id=$1",[r2.id,randomUUID()]);
  releaseOld({id:'synthetic-stale-send',fromMe:true,to:'60123456789@c.us',body:c2.body,type:'chat',ack:2});await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[r2.id])).rows[0].status,'unknown');
 });
 await t.test('image reconciliation needs the uploaded fingerprint and caption and retains uncertain holds',async()=>{
  const photo={data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=',mimetype:'image/png'},caption='Unique image reconciliation';
  const cid=(await request('/campaigns','POST',{...template,body:caption,media:photo,recipients:'0123456789',send_now:true},user)).data.id;
  await db.pool.query("UPDATE recipients SET status='unknown',started_at=now(),media_fingerprint='exact-processed-hash' WHERE campaign_id=$1",[cid]);
  const row=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1',[cid])).rows[0];
  await db.transaction(c=>require('../src/billing').reserve(c,uid,row.id));
  const message={id:'synthetic-reconciled-photo',fromMe:true,to:'60123456789@c.us',body:caption,type:'image',filehash:'different-image',timestamp:Math.floor(+new Date(row.started_at)/1000),ack:2};
  await worker.reconcileUnknown(a,null,[message]);assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[row.id])).rows[0].status,'unknown');
  assert.equal((await db.pool.query('SELECT state FROM message_charges WHERE recipient_id=$1',[row.id])).rows[0].state,'held');
  message.filehash='exact-processed-hash';message.body='Another caption';await worker.reconcileUnknown(a,null,[message]);
  assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[row.id])).rows[0].status,'unknown');message.body=caption;
  await worker.reconcileUnknown(a,null,[message,{...message,id:'synthetic-ambiguous-photo'}]);
  assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[row.id])).rows[0].status,'unknown');
  await worker.reconcileUnknown(a,null,[message]);await require('../src/billing').reconcile();
  assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[row.id])).rows[0].status,'delivered');
  assert.equal((await db.pool.query('SELECT state FROM message_charges WHERE recipient_id=$1',[row.id])).rows[0].state,'charged');
  await db.pool.query("UPDATE recipients SET status='unknown',message_id=NULL,media_fingerprint=NULL WHERE id=$1",[row.id]);
  message.id='synthetic-legacy-photo';message.filehash=require('node:crypto').createHash('sha256').update(Buffer.from(photo.data,'base64')).digest('base64');
  await worker.reconcileUnknown(a,null,[message]);
  assert.equal((await db.pool.query('SELECT status FROM recipients WHERE id=$1',[row.id])).rows[0].status,'delivered');
 });
 await t.test('only Owner can edit existing task pacing; USER pause/resume and recipient results remain intact',async()=>{
  const created=await request('/campaigns','POST',{title:'Pacing access',account_id:a,body:'Synthetic permission fixture',recipients:'0123456789\nwrong',opt_in_confirmed:true,pacing:true,interval_ms:60000,batch_size:2},user);
  assert.equal(created.status,201);const id=created.data.id;
  const snapshot=async()=>({
   campaign:(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[id])).rows[0],
   recipients:(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1 ORDER BY id',[id])).rows,
   audit:(await db.pool.query('SELECT action,details FROM audit WHERE entity_id=$1 ORDER BY id',[id])).rows
  });
  const before=await snapshot();
  for(const body of [
   {pacing:true,interval_ms:5000,batch_size:100},
   {interval_ms:5000,enabled:false},
   {batch_size:100,enabled:false},
   {pacing:false,interval_ms:5000,batch_size:100,enabled:false},
   {window_start:'00:00',window_end:'00:00',timezone:'Asia/Kuala_Lumpur',interval_ms:5000,scheduled_at:'2030-10-02T09:15',weekdays:[1]},
   {enabled:false,send_now:false}
  ]){
   const denied=await request('/campaigns/'+id,'PATCH',body,user);
   assert.equal(denied.status,403);assert.equal(denied.data.error,'只有 Owner 可以修改任务间隔或数量');
   assert.deepEqual(await snapshot(),before);
  }
  assert.equal((await request('/campaigns/'+id,'PATCH',{pacing:true,interval_ms:120000,batch_size:3},user2)).status,403);
  assert.equal((await request('/campaigns/'+id,'PATCH',{pacing:true,interval_ms:120000,batch_size:3},owner)).status,200);
  const edited=await snapshot();assert.equal(edited.campaign.interval_ms,120000);assert.equal(edited.campaign.batch_size,3);
  assert.deepEqual(edited.recipients,before.recipients);
  assert.equal((await request('/campaigns/'+id,'PATCH',{enabled:false},user)).status,200);
  assert.equal((await request('/campaigns/'+id,'PATCH',{enabled:true},user)).status,200);
  assert.equal((await request('/campaigns/'+id+'/send-now','POST',{},user)).status,200);
  const resumed=await snapshot();assert.equal(resumed.campaign.enabled,true);assert.equal(resumed.campaign.interval_ms,120000);assert.equal(resumed.campaign.batch_size,3);
  assert.deepEqual(resumed.recipients,before.recipients);
 });
 await t.test('interval-only batches persist counts and expose pending/invalid per-number records',async()=>{
  const r=await request('/campaigns','POST',{title:'Batch',account_id:a,body:'batch text',recipients:'0123456789\n0123456790\nwrong',opt_in_confirmed:true,pacing:true,interval_ms:60000,batch_size:2},user);assert.equal(r.status,201);
  const c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[r.data.id])).rows[0];assert.equal(c.send_now,true);assert.equal(c.batch_size,2);
  assert.equal((await request('/campaigns/'+c.id,'PATCH',{pacing:true,interval_ms:60000,batch_size:0},owner)).status,400);
  await db.pool.query('UPDATE campaigns SET enabled=false WHERE id<>$1',[c.id]);await db.pool.query('UPDATE accounts SET next_send_at=now(),batch_sent=0 WHERE id=$1',[a]);
  const before=(await request('/send-records','GET',null,user)).data.filter(x=>x.campaign_id===c.id);assert.equal(before.length,3);assert.equal(before.filter(x=>x.status==='pending').length,2);assert.equal(before.filter(x=>x.status==='invalid').length,1);assert.equal((await request('/send-records','GET',null,user2)).data.length,0);
  let calls=0;const entry={id:a,ready:true,client:{getNumberId:async phone=>({_serialized:phone+'@c.us'}),sendMessage:async(to,body)=>({id:'batch-'+(++calls),fromMe:true,to,body,ack:2})}};
  await worker.dispatch({id:a},entry);let saved=(await db.pool.query('SELECT * FROM accounts WHERE id=$1',[a])).rows[0];assert.equal(saved.batch_sent,1);
  await worker.dispatch({id:a},entry);saved=(await db.pool.query('SELECT * FROM accounts WHERE id=$1',[a])).rows[0];assert.equal(saved.batch_sent,0);assert.ok(+saved.next_send_at>Date.now()+50000);assert.equal(calls,2);
  const after=(await request('/send-records','GET',null,user)).data.filter(x=>x.campaign_id===c.id);assert.equal(after.length,3);assert.equal(after.filter(x=>x.status==='delivered').length,2);assert.ok(after.filter(x=>x.status==='delivered').every(x=>x.recipient.startsWith('+60')));
 });
 await t.test('USER deletion is retained for Owner; Owner permanent deletion removes app records',async()=>{
  assert.equal((await request('/messages/'+a+'/message-1','DELETE',null,user)).status,200);
  assert.ok(!(await request('/messages','GET',null,user)).data.some(m=>m.message_id==='message-1'));
  assert.ok((await request('/messages','GET',null,owner)).data.find(m=>m.message_id==='message-1').deleted_at);
  assert.equal((await request('/campaigns/'+task,'DELETE',null,user)).status,200);
  assert.ok(!(await request('/campaigns','GET',null,user)).data.some(c=>c.id===task));
  assert.ok((await request('/campaigns','GET',null,owner)).data.find(c=>c.id===task).deleted_at);
  assert.ok((await request('/audit','GET',null,owner)).data.some(a=>a.action==='campaign.delete'));
  assert.equal((await request('/campaigns/'+task,'DELETE',null,owner)).status,200);
  assert.equal((await db.pool.query('SELECT 1 FROM campaigns WHERE id=$1',[task])).rowCount,0);
  assert.equal((await db.pool.query('SELECT 1 FROM audit WHERE entity_id=$1',[task])).rowCount,0);
 });
 await t.test('migration keeps credentials/grants, removes hierarchy and respects inactive parents',async()=>{
  const m=randomUUID(),s=randomUUID();const hash=(await db.pool.query('SELECT password_hash FROM users WHERE id=$1',[uid])).rows[0].password_hash;
  await db.pool.query("INSERT INTO users(id,username,password_hash,role,active) VALUES($1,'legacy-m',$2,'manager',false)",[m,hash]);
  await db.pool.query("INSERT INTO users(id,username,password_hash,role,manager_id) VALUES($1,'legacy-s',$2,'staff',$3)",[s,hash,m]);
  await db.pool.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,false)',[s,a]);await db.migrate();await db.migrate();
  const old=(await db.pool.query('SELECT * FROM users WHERE id=$1',[s])).rows[0];assert.equal(old.role,'user');assert.equal(old.manager_id,null);assert.equal(old.active,false);assert.equal(old.password_hash,hash);
  assert.equal((await db.pool.query('SELECT operate FROM account_grants WHERE user_id=$1',[s])).rows[0].operate,true);
 });
 await t.test('USER creation dates remain; only Owner can add or delete WhatsApp accounts',async()=>{
  const listed=(await request('/users','GET',null,owner)).data.find(u=>u.id===uid);assert.ok(Number.isFinite(Date.parse(listed.created_at)));
  const c=(await request('/accounts','POST',{label:'Delete test',worker_group:'group-a'},owner)).data.id;
  await db.pool.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,true)',[uid,c]);
  assert.equal((await request('/accounts/'+c,'DELETE',null,user)).status,403);
  assert.equal((await request('/accounts/'+c,'DELETE',null,{...owner,csrf:'bad'})).status,403);
  const taskId=(await request('/campaigns','POST',{...template,account_id:c},user)).data.id;
  const {purgeAccountData}=require('../src/account-deletion');assert.equal(await purgeAccountData(c),false);
  assert.equal((await request('/accounts/'+c,'DELETE',null,owner)).status,202);
  assert.equal((await request('/accounts/'+c,'PATCH',{enabled:true},owner)).status,403);
  assert.equal((await db.pool.query('SELECT enabled FROM campaigns WHERE id=$1',[taskId])).rows[0].enabled,false);
  assert.equal(await purgeAccountData(c),true);
  assert.equal((await db.pool.query('SELECT 1 FROM campaigns WHERE id=$1',[taskId])).rowCount,0);
 });
 await t.test('credit reservation is atomic across concurrent tasks; settlement is exactly once',async()=>{
  const billing=require('../src/billing');await billing.reconcile();
  // Discrete fake record IDs exercise wallet locking without sending any messages.
  await db.pool.query('UPDATE users SET credit_units=1000 WHERE id=$1',[uid2]);
  const reserved=await Promise.all([900001,900002].map(id=>db.transaction(tx=>billing.reserve(tx,uid2,id))));
  assert.equal(reserved.filter(Boolean).length,1);assert.equal(Number((await request('/billing','GET',null,user2)).data.user.credit_units),0);
  const rid=reserved[0]?900001:900002;
  await billing.settle(rid,'unknown');
  const heldView=(await request('/billing?user_id='+uid2,'GET',null,owner)).data;assert.equal(Number(heldView.held_units),1000);assert.equal(Number(heldView.held[0].amount_units),1000);
  for(const key of ['price_units','held_units','held'])assert.equal((await request('/billing','GET',null,user2)).data[key],undefined);
  await request('/billing/price','PUT',{price:'0.2000'},owner);
  await Promise.all([billing.settle(rid,'failed'),billing.settle(rid,'failed')]);
  assert.equal(Number((await request('/billing','GET',null,user2)).data.user.credit_units),1000);
  await request('/billing/price','PUT',{price:'0.1000'},owner);
  assert.equal(await db.transaction(tx=>billing.reserve(tx,uid2,rid)),true);
  await billing.settle(rid,'pending',null,'',1);
  assert.equal(Number((await request('/billing','GET',null,user2)).data.user.credit_units),0);
  await billing.settle(rid,'failed');
  await request('/billing/price','PUT',{price:'0.2000'},owner);
  await db.pool.query('UPDATE users SET credit_units=2000 WHERE id=$1',[uid2]);
  assert.equal(await db.transaction(tx=>billing.reserve(tx,uid2,900003)),true);
  await Promise.all([billing.settle(900003,'submitted'),billing.settle(900003,'read')]);
  assert.equal(Number((await request('/billing','GET',null,user2)).data.user.credit_units),0);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM credit_ledger WHERE recipient_id=900003 AND kind='charged'")).rows[0].n,1);
  const ownerId=(await request('/me','GET',null,owner)).data.user.id;
  assert.equal(await db.transaction(tx=>billing.reserve(tx,ownerId,900004)),true);
  assert.equal((await db.pool.query('SELECT 1 FROM message_charges WHERE recipient_id=900004')).rowCount,0);
  const made=(await request('/campaigns','POST',{...template,title:'Owner only'},owner)).data.id;
  assert.equal((await request('/campaigns/'+made+'/send-now','POST',{},user)).status,403);
  // An empty USER wallet pauses a queued task before touching the WhatsApp client.
  await db.pool.query('UPDATE users SET credit_units=2000 WHERE id=$1',[uid2]);
  const paused=(await request('/campaigns','POST',{...template,account_id:b,send_now:true},user2)).data.id;
  await db.pool.query('UPDATE users SET credit_units=0 WHERE id=$1',[uid2]);let calls=0;
  await worker.dispatch({id:b},{id:b,ready:true,client:{getNumberId:async()=>{calls++;return null;}}});assert.equal(calls,0);
  assert.equal((await db.pool.query('SELECT enabled FROM campaigns WHERE id=$1',[paused])).rows[0].enabled,false);
  assert.equal((await request('/campaigns/'+paused+'/send-now','POST',{},user2)).status,402);
 });
 await t.test('Owner USER remarks are private, editable and do not reset credentials, grants or sessions',async()=>{
  const before=(await db.pool.query('SELECT password_hash,active FROM users WHERE id=$1',[uid2])).rows[0];
  const note='Synthetic customer note\n<img src=x onerror=alert(1)>';
  assert.equal((await request('/users/'+uid2+'/remark','PATCH',{remark:note},user)).status,403);
  assert.equal((await request('/users/'+uid2+'/remark','PATCH',{remark:note},{...owner,csrf:'wrong'})).status,403);
  assert.equal((await request('/users/'+uid2+'/remark','PATCH',{remark:'x'.repeat(2001)},owner)).status,400);
  assert.equal((await request('/users/'+uid2+'/remark','PATCH',{remark:null},owner)).status,400);
  assert.equal((await request('/users/'+uid2+'/remark','PATCH',{remark:note},owner)).data.remark,note);
  assert.equal((await request('/users','GET',null,owner)).data.find(x=>x.id===uid2).remark,note);
  assert.equal((await request('/me','GET',null,user2)).data.user.remark,undefined);
  assert.equal((await request('/users?compact=true','GET',null,owner)).data.find(x=>x.id===uid2).remark,undefined);
  assert.equal((await request('/users?compact=true','GET',null,user2)).status,403);
  assert.deepEqual((await db.pool.query('SELECT password_hash,active FROM users WHERE id=$1',[uid2])).rows[0],before);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM account_grants WHERE user_id=$1 AND account_id=$2',[uid2,b])).rows[0].n,1);
  await request('/users/'+uid2,'PATCH',{active:true},owner);assert.equal((await request('/users','GET',null,owner)).data.find(x=>x.id===uid2).remark,note);
  const made=await request('/users','POST',{username:'remark-user',password:'synthetic-user-password-123',remark:'New USER info'},owner);
  assert.equal(made.status,201);assert.equal((await request('/users','GET',null,owner)).data.find(x=>x.id===made.data.id).remark,'New USER info');
  const ownerId=(await request('/me','GET',null,owner)).data.user.id;
  assert.equal((await request('/users/'+ownerId+'/remark','PATCH',{remark:note},owner)).status,403);
  await request('/users/'+uid2+'/remark','PATCH',{remark:''},owner);assert.equal((await request('/users','GET',null,owner)).data.find(x=>x.id===uid2).remark,'');
 });
 await t.test('top-ups auto-resume only credit pauses, preserve manual/review stops and never resend finished recipients',async()=>{
  const billing=require('../src/billing'),worker=require('../src/worker');
  await db.pool.query('UPDATE campaigns SET enabled=false,pause_reason=NULL WHERE created_by=$1',[uid2]);
  await db.pool.query('UPDATE users SET credit_units=2000 WHERE id=$1',[uid2]);
  const make=async title=>(await request('/campaigns','POST',{...template,title,account_id:b,send_now:true},user2)).data.id;
  const auto=await make('Credit auto-resume'),manual=await make('Manual stop'),review=await make('Review stop'),cancelled=await make('Cancelled stop'),removed=await make('Deleted stop');
  await request('/campaigns/'+manual,'PATCH',{enabled:false},user2);
  await db.pool.query("UPDATE campaigns SET enabled=false,pause_reason='review' WHERE id=$1",[review]);
  await db.pool.query("UPDATE recipients SET status='unknown' WHERE campaign_id=$1 AND status='pending'",[review]);
  await request('/campaigns/'+cancelled+'/cancel','POST',{},user2);
  await db.pool.query("UPDATE campaigns SET enabled=false,pause_reason='credit',deleted_at=now() WHERE id=$1",[removed]);
  await db.pool.query('UPDATE users SET credit_units=0 WHERE id=$1',[uid2]);let lookups=0,sends=0;
  const entry={id:b,ready:true,client:{getNumberId:async()=>{lookups++;return{_serialized:'60123456789@c.us'};},sendMessage:async()=>{sends++;return{id:{_serialized:'credit-auto-fake'},ack:1,to:'60123456789@c.us',body:template.body,timestamp:Math.floor(Date.now()/1000)};}}};
  await worker.dispatch({id:b},entry);assert.equal(lookups,0);
  let row=(await db.pool.query('SELECT enabled,pause_reason FROM campaigns WHERE id=$1',[auto])).rows[0];assert.deepEqual(row,{enabled:false,pause_reason:'credit'});
  const adjustment=amount=>request('/billing/adjust','POST',{user_id:uid2,amount,direction:'add',note:'Synthetic top-up',request_id:randomUUID()},owner);
  await adjustment('0.10');assert.equal((await db.pool.query('SELECT enabled FROM campaigns WHERE id=$1',[auto])).rows[0].enabled,false);
  await adjustment('0.10');row=(await db.pool.query('SELECT enabled,pause_reason FROM campaigns WHERE id=$1',[auto])).rows[0];assert.deepEqual(row,{enabled:true,pause_reason:null});
  for(const id of [manual,review,cancelled,removed])assert.equal((await db.pool.query('SELECT enabled FROM campaigns WHERE id=$1',[id])).rows[0].enabled,false);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM recipients WHERE campaign_id=$1 AND error_code='CREDIT_REQUIRED'",[auto])).rows[0].n,0);
  assert.equal(await billing.resumeCreditTasks(uid2),0);
  await worker.dispatch({id:b},entry);assert.equal(sends,1);assert.equal(Number((await request('/billing','GET',null,user2)).data.user.credit_units),0);
  const adjustmentId=randomUUID(),payload={user_id:uid2,amount:'1',direction:'add',note:'Synthetic duplicate request',request_id:adjustmentId};
  await Promise.all([request('/billing/adjust','POST',payload,owner),request('/billing/adjust','POST',payload,owner)]);
  assert.equal(Number((await request('/billing','GET',null,user2)).data.user.credit_units),10000);
  await worker.dispatch({id:b},entry);assert.equal(sends,1);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM audit WHERE entity_id=$1 AND action='campaign.credit_resume'",[auto])).rows[0].n,1);
  // A five-second worker recovery also repairs a missed top-up notification.
  const recovery=await make('Recovery check');await db.pool.query("UPDATE campaigns SET enabled=false,pause_reason='credit' WHERE id=$1",[recovery]);
  await db.pool.query('UPDATE users SET active=false WHERE id=$1',[uid2]);assert.equal(await billing.resumeCreditTasks(uid2),0);await db.pool.query('UPDATE users SET active=true WHERE id=$1',[uid2]);
  await db.pool.query('UPDATE accounts SET enabled=false WHERE id=$1',[b]);assert.equal(await billing.resumeCreditTasks(uid2),0);await db.pool.query('UPDATE accounts SET enabled=true WHERE id=$1',[b]);
  await db.pool.query('DELETE FROM account_grants WHERE user_id=$1 AND account_id=$2',[uid2,b]);assert.equal(await billing.resumeCreditTasks(uid2),0);await db.pool.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,true)',[uid2,b]);
  assert.equal(await billing.resumeCreditTasks(uid2,'other-group'),0);assert.equal(await billing.resumeCreditTasks(uid2,'group-a'),1);
  // A user can explicitly stop automatic recovery while their wallet is empty.
  await db.pool.query("UPDATE campaigns SET enabled=false,pause_reason='credit' WHERE id=$1",[recovery]);await db.pool.query('UPDATE users SET credit_units=0 WHERE id=$1',[uid2]);
  assert.equal((await request('/campaigns/'+recovery,'PATCH',{enabled:false},user2)).status,200);await adjustment('1');assert.equal((await db.pool.query('SELECT enabled FROM campaigns WHERE id=$1',[recovery])).rows[0].enabled,false);
  const legacy=await make('Legacy credit pause'),legacyManual=await make('Legacy manual pause');
  await db.pool.query('UPDATE campaigns SET enabled=false,pause_reason=NULL WHERE id=ANY($1::uuid[])',[[legacy,legacyManual]]);
  await db.pool.query("UPDATE recipients SET error_code='CREDIT_REQUIRED' WHERE campaign_id=ANY($1::uuid[]) AND status='pending'",[[legacy,legacyManual]]);
  await request('/campaigns/'+legacyManual,'PATCH',{enabled:false},user2);
  await db.pool.query("DELETE FROM app_migrations WHERE name='credit_auto_resume_v1'");await db.migrate();
  assert.equal((await db.pool.query('SELECT pause_reason FROM campaigns WHERE id=$1',[legacy])).rows[0].pause_reason,'credit');
  assert.equal((await db.pool.query('SELECT pause_reason FROM campaigns WHERE id=$1',[legacyManual])).rows[0].pause_reason,null);
 });
 await t.test('USER QR-only, rename and reconnect are scoped; concurrent creation cannot exceed ten slots',async()=>{
  assert.equal((await request('/me','GET',null,user2)).data.user.account_limit,10);
  assert.equal((await request('/accounts/'+b+'/connection?mode=scan','GET',null,user2)).data.code,'WORKER_UNREACHABLE');
  await db.pool.query("UPDATE accounts SET status='ready' WHERE id=$1",[b]);
  assert.equal((await request('/accounts/'+b+'/connection?mode=scan','GET',null,user2)).data.code,'ALREADY_LINKED');
  assert.equal((await request('/accounts/'+b+'/connection?mode=view','GET',null,user2)).status,403);
  const {WebSocket}=require('ws');
  await new Promise((resolve,reject)=>{const ws=new WebSocket(base.replace('http:','ws:')+'/screen/'+b+'?mode=view',{headers:{Origin:'http://localhost:3000',Cookie:user2.cookie}});ws.on('unexpected-response',(_q,r)=>{try{assert.equal(r.statusCode,403);r.resume();resolve();}catch(e){reject(e);}});ws.on('open',()=>{ws.close();reject(Error('USER chat view opened'));});ws.on('error',reject);});
  await db.pool.query("UPDATE accounts SET status='stopped' WHERE id=$1",[b]);
  assert.equal((await request('/accounts/'+a+'/restart','POST',{},user2)).status,403);
  assert.equal((await request('/accounts/'+b,'PATCH',{enabled:false},user2)).status,403);
  const ids=[];for(let i=0;i<8;i++){const r=await request('/accounts','POST',{label:'Quota '+i,worker_group:'group-a'},user2);assert.equal(r.status,201);ids.push(r.data.id);}
  const pair=await Promise.all([8,9].map(i=>request('/accounts','POST',{label:'Quota '+i,worker_group:'group-a'},user2)));
  assert.deepEqual(pair.map(r=>r.status).sort(),[201,409]);ids.push(pair.find(r=>r.status===201).data.id);
  assert.equal((await request('/accounts','GET',null,user2)).data.length,10);
  assert.equal((await request('/users/'+uid2,'PATCH',{active:true,grants:[a,b,...ids].map(account_id=>({account_id}))},owner)).status,409);
  for(const id of ids){await request('/accounts/'+id,'DELETE',null,owner);assert.equal(await require('../src/account-deletion').purgeAccountData(id),true);}
 });
 await t.test('FPX switch, signed verified payments, configuration snapshots and duplicate callbacks',async()=>{
  const payments=require('../src/payments'),originalFetch=global.fetch,bills=new Map();let created=0;
  global.fetch=async(url,opts)=>{const u=new URL(url);if(u.host==='www.billplz.com'){
    if(opts.method==='POST'){const f=Object.fromEntries(opts.body),id='test-bill-'+(++created);const bill={id,collection_id:f.collection_id,reference_2:f.reference_2,amount:Number(f.amount),paid_amount:0,paid:false,state:'due',url:'https://www.billplz.com/bills/'+id};bills.set(id,bill);return{ok:true,json:async()=>bill};}
    return{ok:true,json:async()=>bills.get(u.pathname.split('/').at(-1))};
  }return originalFetch(url,opts);};
  try{
    assert.equal((await request('/payments/settings','PUT',{enabled:true,sandbox:false,collection_id:'fake'},user)).status,403);
    assert.equal((await request('/payments/orders','POST',{amount:'20',email:'test@example.test',request_id:randomUUID()},user)).status,503);
    const settings={enabled:true,sandbox:false,collection_id:'test-collection',api_key:'fake-api-key',x_key:'fake-signature-key'};
    assert.equal((await request('/payments/settings','PUT',settings,owner)).status,200);
    const visible=(await request('/payments/settings','GET',null,owner)).data;assert.equal(visible.api_key,undefined);assert.equal(visible.x_key,undefined);assert.equal(visible.configured,true);
    const fpxTask=(await request('/campaigns','POST',{...template,title:'FPX recovery',send_now:true},user)).data.id;
    await db.pool.query("UPDATE campaigns SET enabled=false,pause_reason='credit' WHERE id=$1",[fpxTask]);
    const payload={amount:'20.00',email:'test@example.test',request_id:randomUUID()};
    const made=await request('/payments/orders','POST',payload,user);assert.equal(made.status,201);const id=made.data.id;
    assert.equal((await request('/payments/orders','POST',payload,user)).data.id,id);assert.equal(created,1);
    assert.equal((await request('/payments/orders/'+id+'/check','POST',{},user2)).status,403);
    assert.equal((await request('/payments/orders','GET',null,user2)).data.length,0);
    const order=(await db.pool.query('SELECT * FROM topup_orders WHERE id=$1',[id])).rows[0];const bill=bills.get(order.bill_id);
    const before=Number((await request('/billing','GET',null,user)).data.user.credit_units);
    const unsigned={id:bill.id,collection_id:bill.collection_id,amount:String(bill.amount),paid_amount:'2000',paid:'true',state:'paid'};
    assert.equal((await request('/payments/callback/'+id,'POST',{...unsigned,x_signature:'0'.repeat(64)})).status,403);
    assert.equal(Number((await request('/billing','GET',null,user)).data.user.credit_units),before);
    // A maintenance shutdown does not discard payments from an already-created bill.
    assert.equal((await request('/payments/settings','PUT',{...settings,enabled:false,api_key:'new-fake-key',x_key:'new-fake-signature'},owner)).status,200);
    assert.equal((await request('/payments/orders','POST',{...payload,request_id:randomUUID()},user)).status,503);
    bill.paid=true;bill.state='paid';bill.paid_amount=1999;
    const body={...unsigned,x_signature:payments.signature(unsigned,settings.x_key)};
    assert.equal((await request('/payments/callback/'+id,'POST',body)).status,409);
    assert.equal(Number((await request('/billing','GET',null,user)).data.user.credit_units),before);
    bill.paid_amount=2000;
    const callbacks=await Promise.all([request('/payments/callback/'+id,'POST',body),request('/payments/callback/'+id,'POST',body)]);assert.ok(callbacks.every(r=>r.status===200));
    assert.equal(Number((await request('/billing','GET',null,user)).data.user.credit_units),before+200000);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM credit_ledger WHERE order_id=$1',[id])).rows[0].n,1);
    assert.deepEqual((await db.pool.query('SELECT enabled,pause_reason FROM campaigns WHERE id=$1',[fpxTask])).rows[0],{enabled:true,pause_reason:null});
    assert.equal((await request('/payments/orders/'+id+'/check','POST',{},user)).data.state,'paid');
  }finally{global.fetch=originalFetch;}
 });
 await t.test('only Owner can reset USER passwords; verified viewing reflects resets and USER sessions are revoked',async()=>{
  assert.equal((await request('/me','GET',null,owner)).data.password_access,false);
  let rows=(await request('/users?passwords=true','GET',null,owner)).data;
  assert.equal(rows.find(x=>x.id===uid2).password,undefined);assert.equal(rows.find(x=>x.id===uid2).password_cipher,undefined);
  assert.equal((await request('/users/password-access','POST',{password:'user-password-123'},user2)).status,403);
  assert.equal((await request('/users/password-access','POST',{password:'wrong'},owner)).status,403);
  assert.equal((await request('/users/password-access','POST',{password:'test-owner-password-123'},owner)).status,200);
  assert.equal((await request('/me','GET',null,owner)).data.password_access,true);
  assert.equal((await request('/users?passwords=true','GET',null,owner)).data.find(x=>x.id===uid2).password,'user-password-123');
  const before=(await db.pool.query('SELECT password_hash,password_cipher,password_changed_at FROM users WHERE id=$1',[uid2])).rows[0];
  const denied=await request('/password','POST',{current_password:'user-password-123',password:'changed-user-password-123'},user2);
  assert.equal(denied.status,403);assert.equal(denied.data.error,'只有 Owner 可以修改密码');
  assert.equal((await request('/password','POST',{},user2)).status,403);
  assert.equal((await request('/users/'+uid2,'PATCH',{active:true,password:'changed-user-password-123'},user2)).status,403);
  assert.deepEqual((await db.pool.query('SELECT password_hash,password_cipher,password_changed_at FROM users WHERE id=$1',[uid2])).rows[0],before);
  assert.equal((await request('/me','GET',null,user2)).status,200);
  assert.equal((await request('/users/'+uid2,'PATCH',{active:true,password:'owner-reset-user-password-123'},{...owner,csrf:'wrong'})).status,403);
  assert.equal((await request('/users/'+uid2,'PATCH',{active:true,password:'owner-reset-user-password-123'},owner)).status,200);
  rows=(await request('/users?passwords=true','GET',null,owner)).data;const changed=rows.find(x=>x.id===uid2);assert.equal(changed.password,'owner-reset-user-password-123');assert.ok(+new Date(changed.password_changed_at)>+new Date(before.password_changed_at));
  assert.equal(rows.find(x=>x.role==='owner').password,undefined);
  assert.ok(!(await db.pool.query('SELECT password_cipher FROM users WHERE id=$1',[uid2])).rows[0].password_cipher.includes('owner-reset-user-password-123'));
  assert.equal((await request('/me','GET',null,user2)).status,401);
  assert.equal((await request('/login','POST',{username:'user2',password:'user-password-123'})).status,401);
  Object.assign(user2,await login('user2','owner-reset-user-password-123'));
  await db.pool.query("UPDATE sessions SET password_reveal_until=now()-interval '1 second' WHERE user_id IN(SELECT id FROM users WHERE role='owner')");
  assert.equal((await request('/me','GET',null,owner)).data.password_access,false);
  assert.equal((await request('/users?passwords=true','GET',null,owner)).data.find(x=>x.id===uid2).password,undefined);
 });
 await t.test('Owner account grouping is scoped; global bilingual notices require Owner and hide disabled drafts',async()=>{
  const own=(await request('/accounts','GET',null,owner)).data;
  assert.equal(own.find(x=>x.id===a).assigned_users.find(x=>x.id===uid).username,'user1');
  assert.deepEqual(own.find(x=>x.id===b).assigned_users.map(x=>x.id),[uid2]);
  assert.equal((await request('/accounts','GET',null,user2)).data.find(x=>x.id===b).assigned_users,null);
  const draft={enabled:false,content_zh:'待发布公告',content_en:'Draft notice'};
  assert.equal((await request('/notice','GET',null,null)).status,401);
  assert.equal((await request('/notice','PUT',draft,user2)).status,403);
  assert.equal((await request('/notice','PUT',{...draft,enabled:true,content_zh:'',content_en:''},owner)).status,400);
  assert.equal((await request('/notice','PUT',{...draft,content_en:'x'.repeat(6001)},owner)).status,400);
  assert.equal((await request('/notice','PUT',draft,{...owner,csrf:'wrong'})).status,403);
  assert.equal((await request('/notice','PUT',draft,owner)).status,200);
  assert.equal((await request('/notice','GET',null,owner)).data.content_zh,draft.content_zh);
  assert.deepEqual((await request('/notice','GET',null,user2)).data,{enabled:false,content_zh:'',content_en:'',updated_at:null});
  const published={enabled:true,content_zh:'系统更新完成。\n<img src=x onerror=alert(1)>',content_en:'System updated.\nMaintenance notice.'};
  assert.equal((await request('/notice','PUT',published,owner)).status,200);
  for(const session of [user,user2]){const n=(await request('/notice','GET',null,session)).data;assert.equal(n.enabled,true);assert.equal(n.content_zh,published.content_zh);assert.equal(n.content_en,published.content_en);assert.ok(n.updated_at);}
  await request('/notice','PUT',{...published,enabled:false},owner);
  assert.equal((await request('/notice','GET',null,user)).data.content_en,'');
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM audit WHERE action='notice.update'")).rows[0].n,3);
 });
 await t.test('message and audit pagination are bounded at 100 rows without leaking other USER accounts',async()=>{
  await db.pool.query("INSERT INTO message_history(account_id,message_id,recipient,body,status,ack,sent_at) SELECT $1,'pagination-scope-'||n,'60123456789','Synthetic pagination record','submitted',1,timestamptz '2050-01-01'+n*interval '1 second' FROM generate_series(1,205) n",[a]);
  const first=(await request('/send-records?page=1','GET',null,user)).data,second=(await request('/send-records?page=2','GET',null,user)).data,third=(await request('/send-records?page=3','GET',null,user)).data;
  assert.equal(first.length,100);assert.equal(second.length,100);assert.ok(first.every(r=>r.message_id.startsWith('pagination-scope-')));assert.ok(second.every(r=>r.message_id.startsWith('pagination-scope-')));
  assert.equal(third.filter(r=>r.message_id?.startsWith('pagination-scope-')).length,5);assert.equal(new Set([...first,...second].map(r=>r.message_id)).size,200);
  assert.ok((await request('/send-records?page=1','GET',null,user2)).data.every(r=>!r.message_id?.startsWith('pagination-scope-')));
  await db.pool.query("INSERT INTO audit(action) SELECT 'test.pagination' FROM generate_series(1,205)");
  const logs=(await request('/audit?page=1','GET',null,owner)).data,logs2=(await request('/audit?page=2','GET',null,owner)).data;
  assert.equal(logs.length,100);assert.equal(logs2.length,100);assert.equal(new Set([...logs,...logs2].map(r=>r.id)).size,200);assert.equal((await request('/audit','GET',null,user2)).status,403);
  await db.pool.query("DELETE FROM message_history WHERE message_id LIKE 'pagination-scope-%'");await db.pool.query("DELETE FROM audit WHERE action='test.pagination'");
 });
 await t.test('only Owner can toggle USER status; deactivation revokes sessions and pauses tasks without altering credentials or grants',async()=>{
  const ownerId=(await request('/me','GET',null,owner)).data.user.id;
  const path='/users/'+uid2+'/status';
  assert.equal((await request(path,'PATCH',{active:false})).status,401);
  for(const id of [uid,uid2,ownerId])assert.equal((await request('/users/'+id+'/status','PATCH',{active:false},user2)).status,403);
  assert.equal((await request(path,'PATCH',{active:false},{...owner,csrf:'wrong'})).status,403);
  for(const active of ['false',null,0])assert.equal((await request(path,'PATCH',{active},owner)).status,400);
  assert.equal((await request('/users/'+ownerId+'/status','PATCH',{active:false},owner)).status,403);
  assert.equal((await request('/users/'+randomUUID()+'/status','PATCH',{active:false},owner)).status,403);
  await request('/billing/adjust','POST',{user_id:uid2,amount:'1',direction:'add',note:'Synthetic status test credit',request_id:randomUUID()},owner);
  const made=await request('/campaigns','POST',{...template,account_id:b,title:'Status test',send_now:true,recipients:'0123456789'},user2);assert.equal(made.status,201);
  const cid=made.data.id,fields='password_hash,password_cipher,password_changed_at,remark,permissions,credit_units,account_limit';
  const before=(await db.pool.query('SELECT '+fields+' FROM users WHERE id=$1',[uid2])).rows[0];
  const grants=(await db.pool.query('SELECT * FROM account_grants WHERE user_id=$1 ORDER BY account_id',[uid2])).rows;
  const recipients=(await db.pool.query('SELECT id,status FROM recipients WHERE campaign_id=$1 ORDER BY id',[cid])).rows;
  const other=await login('user2','owner-reset-user-password-123');
  const inactive=await request(path,'PATCH',{active:false,password:'must-not-change-password',remark:'must-not-change-remark',grants:[]},owner);
  assert.equal(inactive.status,200);assert.deepEqual(inactive.data,{id:uid2,active:false,locked:false});
  for(const session of [user2,other])assert.equal((await request('/me','GET',null,session)).status,401);
  assert.equal((await request('/login','POST',{username:'user2',password:'owner-reset-user-password-123'})).status,401);
  assert.deepEqual((await db.pool.query('SELECT '+fields+' FROM users WHERE id=$1',[uid2])).rows[0],before);
  assert.deepEqual((await db.pool.query('SELECT * FROM account_grants WHERE user_id=$1 ORDER BY account_id',[uid2])).rows,grants);
  assert.deepEqual((await db.pool.query('SELECT enabled,pause_reason FROM campaigns WHERE id=$1',[cid])).rows[0],{enabled:false,pause_reason:null});
  assert.deepEqual((await db.pool.query('SELECT id,status FROM recipients WHERE campaign_id=$1 ORDER BY id',[cid])).rows,recipients);
  const audit=(await db.pool.query("SELECT details FROM audit WHERE action='user.status' AND entity_id=$1 ORDER BY id DESC",[uid2])).rows;assert.equal(audit.length,1);assert.deepEqual(audit[0].details,{active:false,locked:false});
  assert.equal((await request(path,'PATCH',{active:false},owner)).status,200);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM audit WHERE action='user.status' AND entity_id=$1",[uid2])).rows[0].n,1);
  assert.equal((await request(path,'PATCH',{active:true},owner)).status,200);
  assert.equal((await request('/me','GET',null,user2)).status,401);
  Object.assign(user2,await login('user2','owner-reset-user-password-123'));
  assert.deepEqual((await db.pool.query('SELECT '+fields+' FROM users WHERE id=$1',[uid2])).rows[0],before);
  assert.deepEqual((await db.pool.query('SELECT enabled,pause_reason FROM campaigns WHERE id=$1',[cid])).rows[0],{enabled:false,pause_reason:null});
  assert.equal((await request('/me','GET',null,owner)).status,200);assert.equal((await request('/me','GET',null,user)).status,200);
 });
 await t.test('Locked is distinct from Inactive and blocks login, new sends and credit recovery until Owner unlocks',async()=>{
  const billing=require('../src/billing'),worker=require('../src/worker'),ownerId=(await request('/me','GET',null,owner)).data.user.id;
  assert.equal((await request('/users/'+uid2,'PATCH',{active:true,locked:true},user2)).status,403);
  assert.equal((await request('/users/'+ownerId,'PATCH',{active:true,locked:true},owner)).status,403);
  assert.equal((await request('/users/'+uid2,'PATCH',{active:true,locked:'true'},owner)).status,400);
  assert.equal((await request('/users/'+uid2,'PATCH',{active:false,locked:true},owner)).status,400);
  assert.equal((await request('/users/'+uid2,'PATCH',{active:true,locked:true},{...owner,csrf:'wrong'})).status,403);
  await request('/billing/adjust','POST',{user_id:uid2,amount:'1',direction:'add',note:'Synthetic lock test credit',request_id:randomUUID()},owner);
  const created=await request('/campaigns','POST',{...template,account_id:b,title:'Lock test',send_now:true,recipients:'0123456789'},user2);assert.equal(created.status,201);const cid=created.data.id;
  const before=(await db.pool.query('SELECT password_hash,password_cipher,password_changed_at,credit_units,remark FROM users WHERE id=$1',[uid2])).rows[0];
  assert.equal((await request('/users/'+uid2,'PATCH',{active:true,locked:true},owner)).status,200);
  const managed=(await request('/users','GET',null,owner)).data.find(u=>u.id===uid2);assert.equal(managed.active,true);assert.equal(managed.locked,true);
  assert.deepEqual((await db.pool.query('SELECT password_hash,password_cipher,password_changed_at,credit_units,remark FROM users WHERE id=$1',[uid2])).rows[0],before);
  assert.equal((await request('/me','GET',null,user2)).status,401);
  assert.equal((await request('/login','POST',{username:'user2',password:'owner-reset-user-password-123'})).status,401);
  await assert.rejects(billing.canPay(uid2),e=>e.status===403);
  const blocked=await db.transaction(tx=>billing.reserveForSend(tx,uid2,900005));assert.deepEqual(blocked,{ok:false,pause_reason:null,error:'USER_LOCKED'});
  assert.equal((await db.pool.query('SELECT 1 FROM message_charges WHERE recipient_id=900005')).rowCount,0);
  assert.deepEqual((await db.pool.query('SELECT enabled,pause_reason FROM campaigns WHERE id=$1',[cid])).rows[0],{enabled:false,pause_reason:null});
  await db.pool.query('UPDATE campaigns SET enabled=true WHERE id=$1',[cid]);await db.pool.query('UPDATE accounts SET next_send_at=now() WHERE id=$1',[b]);let calls=0;
  await worker.dispatch({id:b},{id:b,ready:true,client:{getNumberId:async()=>{calls++;return null;}}});assert.equal(calls,0);
  await db.pool.query("UPDATE campaigns SET enabled=false,pause_reason='credit' WHERE id=$1",[cid]);assert.equal(await billing.resumeCreditTasks(uid2),0);
  await db.migrate();assert.equal((await db.pool.query('SELECT locked FROM users WHERE id=$1',[uid2])).rows[0].locked,true);
  await db.pool.query('UPDATE campaigns SET pause_reason=NULL WHERE id=$1',[cid]);
  assert.equal((await request('/users/'+uid2,'PATCH',{active:true,locked:false},owner)).status,200);
  Object.assign(user2,await login('user2','owner-reset-user-password-123'));assert.equal((await request('/me','GET',null,user2)).status,200);
  assert.equal((await db.pool.query('SELECT enabled FROM campaigns WHERE id=$1',[cid])).rows[0].enabled,false);
  const fresh=await request('/users','POST',{username:'locked-test',password:'synthetic-locked-password-123',active:true,locked:true},owner);assert.equal(fresh.status,201);
  assert.equal((await request('/login','POST',{username:'locked-test',password:'synthetic-locked-password-123'})).status,401);
  assert.equal((await request('/users/'+fresh.data.id+'/status','PATCH',{active:false},owner)).status,200);
  const inactive=(await request('/users','GET',null,owner)).data.find(u=>u.id===fresh.data.id);assert.equal(inactive.active,false);assert.equal(inactive.locked,false);
 });
 await t.test('Owner can change their own password with current-password verification and revoke every Owner session',async()=>{
  const other=await login('owner','test-owner-password-123');
  assert.equal((await request('/password','POST',{current_password:'wrong',password:'new-owner-password-123'},owner)).status,403);
  assert.equal((await request('/me','GET',null,owner)).status,200);
  assert.equal((await request('/password','POST',{current_password:'test-owner-password-123',password:'new-owner-password-123'},owner)).status,200);
  for(const session of [owner,other])assert.equal((await request('/me','GET',null,session)).status,401);
  assert.equal((await request('/login','POST',{username:'owner',password:'test-owner-password-123'})).status,401);
  Object.assign(owner,await login('owner','new-owner-password-123'));
  assert.equal((await request('/me','GET',null,owner)).data.password_access,false);
  assert.equal((await db.pool.query("SELECT password_cipher FROM users WHERE role='owner'")).rows[0].password_cipher,null);
  assert.equal((await request('/users','GET',null,owner)).status,200);
 });
 await t.test('deactivation revokes sessions; purge requires Owner and explicit phrase',async()=>{
  assert.equal((await request('/users/'+uid,'PATCH',{active:false},owner)).status,200);assert.equal((await request('/me','GET',null,user)).status,401);
  assert.equal((await request('/data/purge','POST',{confirm:'wrong'},owner)).status,400);
  assert.equal((await request('/data/purge','POST',{confirm:'DELETE HISTORY'},owner)).status,200);
  for(const table of ['campaigns','recipients','message_history','audit','receipts'])assert.equal((await db.pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
  assert.equal((await request('/me','GET',null,owner)).status,200);assert.equal((await request('/accounts','GET',null,owner)).data.length,2);
 });
});

