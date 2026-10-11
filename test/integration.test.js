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
  assert.equal((await request('/accounts/'+a+'/connection?mode=view','GET',null,user)).data.code,'OWNER_LINK_REQUIRED');
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
 });
 let task;
 await t.test('users have equal assigned capabilities and cannot administer IDs or cross scope',async()=>{
  assert.equal((await request('/users','GET',null,user)).status,403);
  assert.equal((await request('/users','POST',{username:'nested',role:'user'},user)).status,403);
  assert.equal((await request('/users/'+uid2,'PATCH',{active:false},user)).status,403);
  assert.equal((await request('/accounts/'+b,'PATCH',{label:'no'},user)).status,403);
  assert.equal((await request('/accounts/'+a,'PATCH',{label:'Renamed'},user)).status,200);
  assert.equal((await request('/accounts','GET',null,user)).data.length,1);
  assert.equal((await request('/accounts/'+a+'/connection','GET',null,user)).data.code,'OWNER_LINK_REQUIRED');
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
  assert.equal((await request('/campaigns/'+task,'PATCH',{window_start:'10:00',window_end:'16:00',timezone:'Asia/Kuala_Lumpur',scheduled_at:'2030-10-02T10:00',expires_at:'2030-10-03T16:00',weekdays:[2],interval_ms:25000,send_now:false},user)).status,200);
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
  // Read-only reconciliation recovers a unique existing message without sending.
  const rr=(await db.pool.query('SELECT * FROM recipients WHERE campaign_id=$1',[cid])).rows[0];
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
 await t.test('interval-only batches persist counts and expose pending/invalid per-number records',async()=>{
  const r=await request('/campaigns','POST',{title:'Batch',account_id:a,body:'batch text',recipients:'0123456789\n0123456790\nwrong',opt_in_confirmed:true,pacing:true,interval_ms:60000,batch_size:2},user);assert.equal(r.status,201);
  const c=(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[r.data.id])).rows[0];assert.equal(c.send_now,true);assert.equal(c.batch_size,2);
  assert.equal((await request('/campaigns/'+c.id,'PATCH',{pacing:true,interval_ms:60000,batch_size:0},user)).status,400);
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
  await billing.settle(rid,'unknown');assert.equal(Number((await request('/billing','GET',null,user2)).data.held_units),1000);
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
 await t.test('USER QR-only, rename and reconnect are scoped; concurrent creation cannot exceed ten slots',async()=>{
  assert.equal((await request('/me','GET',null,user2)).data.user.account_limit,10);
  assert.equal((await request('/accounts/'+b+'/connection?mode=scan','GET',null,user2)).data.code,'WORKER_UNREACHABLE');
  await db.pool.query("UPDATE accounts SET status='ready' WHERE id=$1",[b]);
  assert.equal((await request('/accounts/'+b+'/connection?mode=scan','GET',null,user2)).data.code,'ALREADY_LINKED');
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
    assert.equal((await request('/payments/orders/'+id+'/check','POST',{},user)).data.state,'paid');
  }finally{global.fetch=originalFetch;}
 });
 await t.test('Owner verification gates encrypted USER password viewing and shows self changes immediately',async()=>{
  let rows=(await request('/users?passwords=true','GET',null,owner)).data;
  assert.equal(rows.find(x=>x.id===uid2).password,undefined);assert.equal(rows.find(x=>x.id===uid2).password_cipher,undefined);
  assert.equal((await request('/users/password-access','POST',{password:'user-password-123'},user2)).status,403);
  assert.equal((await request('/users/password-access','POST',{password:'wrong'},owner)).status,403);
  assert.equal((await request('/users/password-access','POST',{password:'test-owner-password-123'},owner)).status,200);
  assert.equal((await request('/users?passwords=true','GET',null,owner)).data.find(x=>x.id===uid2).password,'user-password-123');
  assert.equal((await request('/password','POST',{current_password:'user-password-123',password:'changed-user-password-123'},user2)).status,200);
  rows=(await request('/users?passwords=true','GET',null,owner)).data;const changed=rows.find(x=>x.id===uid2);assert.equal(changed.password,'changed-user-password-123');assert.ok(changed.password_changed_at);
  assert.equal(rows.find(x=>x.role==='owner').password,undefined);
  assert.ok(!(await db.pool.query('SELECT password_cipher FROM users WHERE id=$1',[uid2])).rows[0].password_cipher.includes('changed-user-password-123'));
  Object.assign(user2,await login('user2','changed-user-password-123'));
  await db.pool.query("UPDATE sessions SET password_reveal_until=now()-interval '1 second' WHERE user_id IN(SELECT id FROM users WHERE role='owner')");
  assert.equal((await request('/users?passwords=true','GET',null,owner)).data.find(x=>x.id===uid2).password,undefined);
 });
 await t.test('deactivation revokes sessions; purge requires Owner and explicit phrase',async()=>{
  assert.equal((await request('/users/'+uid,'PATCH',{active:false},owner)).status,200);assert.equal((await request('/me','GET',null,user)).status,401);
  assert.equal((await request('/data/purge','POST',{confirm:'wrong'},owner)).status,400);
  assert.equal((await request('/data/purge','POST',{confirm:'DELETE HISTORY'},owner)).status,200);
  for(const table of ['campaigns','recipients','message_history','audit','receipts'])assert.equal((await db.pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
  assert.equal((await request('/me','GET',null,owner)).status,200);assert.equal((await request('/accounts','GET',null,owner)).data.length,2);
 });
});
