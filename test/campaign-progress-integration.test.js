'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
test('PostgreSQL: batch timing, live results and safe interval edits',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_pacing_'+crypto.randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.href,SERVICE_ROLE:'api',WORKER_GROUP:'group-a',DB_POOL_SIZE:'8',PORT:'0',PUBLIC_URL:'http://localhost:3000',INTERNAL_SECRET:'synthetic-pacing-secret',APP_VAULT_KEY:'b2'.repeat(32),BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'synthetic-owner-password-123',WORKER_ROUTES_JSON:'{"group-a":"http://127.0.0.1:9"}'});
 const db=require('../src/db'),{hash}=require('../src/domain');let server;
 t.after(async()=>{if(server)await new Promise(r=>server.close(r));await db.pool.end();await admin.query('DROP DATABASE '+name);await admin.end();});await db.migrate();
 const ownerId=(await db.pool.query("SELECT id FROM users WHERE role='owner'")).rows[0].id,userId=crypto.randomUUID(),strangerId=crypto.randomUUID(),account=crypto.randomUUID();
 for(const [id,label] of [[userId,'pacing-user'],[strangerId,'unassigned']])await db.pool.query("INSERT INTO users(id,username,password_hash,role) SELECT $1,$2,password_hash,'user' FROM users WHERE id=$3",[id,label,ownerId]);
 await db.pool.query("INSERT INTO accounts(id,label,worker_group,status,profile_bound,heartbeat_at) VALUES($1,'Synthetic linked account','group-a','ready',true,now())",[account]);await db.pool.query('INSERT INTO account_grants(user_id,account_id) VALUES($1,$2)',[userId,account]);await db.pool.query("INSERT INTO worker_health(worker_group,heartbeat_at,accounts_running,rss_mb) VALUES('group-a',now(),1,30)");
 const session=async id=>{const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomUUID();await db.pool.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[hash(token),id,csrf]);return {cookie:'wa_session='+token,csrf,hash:hash(token)};};const owner=await session(ownerId),user=await session(userId),stranger=await session(strangerId);
 server=await require('../src/api').start({connectionMonitorIntervalMs:0,refundMonitorIntervalMs:0,loginMonitorIntervalMs:0,autoReplyOptions:{monitorIntervalMs:0}});const worker=require('../src/worker'),base='http://127.0.0.1:'+server.address().port;
 async function request(p,method='GET',body,auth=owner){const r=await fetch(base+'/api'+p,{method,headers:{origin:'http://localhost:3000','content-type':'application/json',cookie:auth.cookie,'x-csrf-token':auth.csrf},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
 const create=async extra=>{const r=await request('/campaigns','POST',{account_id:account,body:'Synthetic timing fixture',recipients:'+60123456789',opt_in_confirmed:true,pacing:true,interval_ms:5000,batch_size:1,send_mode:'now',...extra});assert.equal(r.status,201);return r.data.id;};
 const get=async id=>(await request('/campaigns/'+id+'/results')).data;
 const campaign=async id=>(await db.pool.query('SELECT * FROM campaigns WHERE id=$1',[id])).rows[0];
 let sent=0;const client={getNumberId:async phone=>({_serialized:phone+'@c.us'}),sendMessage:async(to,body)=>({id:'timing-'+(++sent),fromMe:true,to,body,ack:2})},entry={id:account,ready:true,client};
 let future,task;
 await t.test('editing pace preserves a future GMT+8 start and never triggers early delivery',async()=>{
  const scheduled=new Date(Date.now()+8*3600000+3600000).toISOString().slice(0,16)+':00+08:00';future=await create({send_mode:'later',scheduled_at:scheduled});const before=await campaign(future);
  assert.equal((await get(future)).summary.execution.state,'scheduled');
  assert.equal((await request('/campaigns/'+future,'PATCH',{pacing:true,interval_ms:50000,batch_size:2})).status,200);
  const after=await campaign(future);assert.equal(after.send_now,false);assert.equal(+after.scheduled_at,+before.scheduled_at);await worker.dispatch({id:account},entry);assert.equal(sent,0);
 });
 await t.test('a real interval gates dispatch and an edited 50-second interval rebases the same task cooldown',async()=>{
  task=await create({recipients:'+60123456789\n+60123456790\n+60123456791'});await worker.dispatch({id:account},entry);assert.equal(sent,1);
  let r=await get(task);assert.deepEqual(r.summary.counts,{pending:2,delivered:1});assert.equal(r.summary.execution.state,'interval');await worker.dispatch({id:account},entry);assert.equal(sent,1);
  await new Promise(r=>setTimeout(r,5200));await worker.dispatch({id:account},entry);assert.equal(sent,2);
  const before=await get(task),start=Date.now();assert.equal((await request('/campaigns/'+task,'PATCH',{pacing:true,interval_ms:50000,batch_size:1})).status,200);
  r=await get(task);const next=Date.parse(r.summary.execution.next_at);assert.ok(next>=start+49000&&next<=Date.now()+51000);assert.deepEqual(r.rows,before.rows);await worker.dispatch({id:account},entry);assert.equal(sent,2);
  const owned=(await request('/owner/send-items?kind=tasks&actor_id='+ownerId)).data.rows.find(c=>c.id===task);assert.equal(owned.execution.next_at,r.summary.execution.next_at);
 });
 await t.test('an in-flight send rejects pacing edits without altering the active batch or results',async()=>{
  await db.pool.query("UPDATE accounts SET next_send_at=now()-interval '1 second' WHERE id=$1",[account]);
  let enter,release;const entered=new Promise(r=>enter=r),blocked=new Promise(r=>release=r),original=client.sendMessage;
  client.sendMessage=async(to,body)=>{enter();await blocked;return original(to,body);};const running=worker.dispatch({id:account},entry);
  try{await entered;const before=await campaign(task);assert.equal((await get(task)).summary.execution.state,'sending');assert.equal((await request('/campaigns/'+task,'PATCH',{pacing:true,interval_ms:5000,batch_size:2})).status,409);assert.deepEqual(await campaign(task),before);}finally{release();await running;client.sendMessage=original;}
  assert.equal(sent,3);assert.equal((await get(task)).summary.execution.state,'complete');assert.equal((await get(task)).summary.counts.delivered,3);
 });
 await t.test('Owner edits cannot skip another task cooldown, unpause a review or reset recipients',async()=>{
  const before=(await db.pool.query('SELECT next_send_at FROM accounts WHERE id=$1',[account])).rows[0].next_send_at;
  assert.equal((await request('/campaigns/'+future,'PATCH',{pacing:true,interval_ms:60000,batch_size:3})).status,200);assert.equal(+(await db.pool.query('SELECT next_send_at FROM accounts WHERE id=$1',[account])).rows[0].next_send_at,+before);
  const id=await create({recipients:'+60123456789\n+60123456790'});await db.pool.query("UPDATE campaigns SET enabled=false,pause_reason='review' WHERE id=$1",[id]);await db.pool.query("UPDATE recipients SET status='unknown',started_at=now() WHERE id=(SELECT min(id) FROM recipients WHERE campaign_id=$1)",[id]);const rows=(await get(id)).rows;
  assert.equal((await request('/campaigns/'+id,'PATCH',{pacing:true,interval_ms:50000,batch_size:1})).status,200);assert.equal((await campaign(id)).enabled,false);assert.equal((await get(id)).summary.execution.state,'unconfirmed');assert.deepEqual((await get(id)).rows,rows);await worker.dispatch({id:account},entry);assert.equal(sent,3);
 });
 await t.test('scoped diagnostics explain control/connection gates and do not leak or mutate Sessions and credit',async()=>{
  const id=await create();await db.pool.query('UPDATE accounts SET next_send_at=now() WHERE id=$1',[account]);
  await db.pool.query("INSERT INTO control_leases(account_id,session_hash,expires_at) VALUES($1,$2,now()+interval '1 minute')",[account,owner.hash]);assert.equal((await get(id)).summary.execution.state,'control');await worker.dispatch({id:account},entry);assert.equal(sent,3);await db.pool.query('DELETE FROM control_leases WHERE account_id=$1',[account]);
  const snapshot=async()=>({accounts:(await db.pool.query('SELECT * FROM accounts')).rows,sessions:(await db.pool.query('SELECT * FROM sessions ORDER BY token_hash')).rows,users:(await db.pool.query('SELECT id,credit_units,password_hash FROM users ORDER BY id')).rows,ledger:(await db.pool.query('SELECT * FROM credit_ledger')).rows});
  await db.pool.query("UPDATE accounts SET status='scan_required' WHERE id=$1",[account]);const before=await snapshot();assert.equal((await get(id)).summary.execution.state,'connection');
  assert.equal((await request('/campaigns/'+id+'/results','GET',undefined,stranger)).status,403);assert.equal((await request('/campaigns/'+id,'PATCH',{pacing:true,interval_ms:60000,batch_size:1},user)).status,403);
  const own=(await request('/campaigns','GET',undefined,user)).data.find(c=>c.id===id);assert.deepEqual(Object.keys(own.execution).sort(),['next_at','state']);assert.equal(own.worker_heartbeat,undefined);assert.equal(own.creator_allowed,undefined);assert.deepEqual(await snapshot(),before);
 });
});
