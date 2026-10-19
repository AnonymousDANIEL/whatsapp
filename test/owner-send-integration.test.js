'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('PostgreSQL: lazy Owner send groups preserve actors, scope, history and per-ID pagination',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_senders_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 const sharedGroups=Array.from({length:6},(_,i)=>'shared-'+(i+1));
 Object.assign(process.env,{DATABASE_URL:url.toString(),APP_VAULT_KEY:'77'.repeat(32),SERVICE_ROLE:'api',PORT:'0',PUBLIC_URL:'http://localhost:3000',INTERNAL_SECRET:'synthetic-send-groups-secret-thirty-two-characters',BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'synthetic-owner-password-123',WORKER_ROUTES_JSON:JSON.stringify(Object.fromEntries(['personal',...sharedGroups].map(g=>[g,'http://127.0.0.1:9']))),SHARED_WORKER_GROUPS_JSON:JSON.stringify(sharedGroups)});
 const db=require('../src/db');let server;
 t.after(async()=>{if(server)await new Promise(r=>server.close(r));await db.pool.end();await admin.query('DROP DATABASE '+name);await admin.end();});
 await db.migrate();server=await require('../src/api').start({connectionMonitorIntervalMs:0});const base='http://127.0.0.1:'+server.address().port;
 async function request(path,session,method='GET',body){const r=await fetch(base+'/api'+path,{method,headers:{Origin:'http://localhost:3000','Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 async function login(username,password){const r=await request('/login',null,'POST',{username,password});assert.equal(r.status,200);const session={cookie:r.cookie};session.csrf=(await request('/me',session)).data.csrf;return session;}
 const ownerId=(await db.pool.query("SELECT id FROM users WHERE role='owner'")).rows[0].id,u1=randomUUID(),u2=randomUUID(),locked=randomUUID(),a=randomUUID(),deleted=randomUUID(),shared=randomUUID();
 const hash=await require('bcryptjs').hash('synthetic-user-password-123',4);
 await db.pool.query(`INSERT INTO users(id,username,password_hash,role,active,locked,credit_units,permissions,remark) VALUES
  ($1,'alpha',$4,'user',true,false,1000000,ARRAY['tasks.create'],'Private synthetic remark'),($2,'beta',$4,'user',false,false,2000000,ARRAY['tasks.create'],''),($3,'locked',$4,'user',true,true,0,ARRAY['tasks.create'],'')`,[u1,u2,locked,hash]);
 await db.pool.query(`INSERT INTO accounts(id,label,worker_group,shared_pool,deleted_at) VALUES($1,'Assigned personal','personal',false,NULL),($2,'Deleted personal','personal',false,now()),($3,'Dedicated shared','shared-1',true,NULL)`,[a,deleted,shared]);
 await db.pool.query('INSERT INTO account_grants(user_id,account_id) VALUES($1,$3),($2,$3)',[u1,u2,a]);
 const tasks=[];for(const [actor,account,removed,pool]of [[u1,a,false,false],[ownerId,a,false,false],[u2,a,true,false],[ownerId,shared,false,true]]){
  const id=randomUUID();tasks.push(id);await db.pool.query(`INSERT INTO campaigns(id,account_id,created_by,title,body,timezone,window_start,window_end,weekdays,scheduled_at,interval_ms,opt_in_confirmed,deleted_at,shared_pool)
   VALUES($1,$2,$3,'Synthetic task','Synthetic message','Asia/Kuala_Lumpur','00:00','00:00',ARRAY[1,2,3,4,5,6,7],now(),10000,true,CASE WHEN $4 THEN now() ELSE NULL END,$5)`,[id,account,actor,removed,pool]);
 }
 await db.pool.query(`INSERT INTO recipients(campaign_id,raw_phone,status,message_id,started_at) VALUES($1,'synthetic','delivered','deduplicated-task',now()),($2,'synthetic','unknown','owner-task',now()),($3,'synthetic','read','deleted-task',now()),($4,'synthetic','pending',NULL,NULL)`,tasks);
 for(const [account,id,actor,removed]of [[a,'deduplicated-task',ownerId,false],[a,'owner-manual',ownerId,false],[a,'external-manual',null,false],[a,'deleted-user-history',u1,true],[deleted,'retained-deleted-account',u2,false],[shared,'shared-history',u1,false]])await db.pool.query(`INSERT INTO message_history(account_id,message_id,actor_id,recipient,body,status,sent_at,deleted_at) VALUES($1,$2,$3,'synthetic','Synthetic','submitted',now(),CASE WHEN $4 THEN now() ELSE NULL END)`,[account,id,actor,removed]);
 await db.pool.query("INSERT INTO message_history(account_id,message_id,actor_id,recipient,body,status,sent_at) SELECT $1,'pagination-'||n,$2,'synthetic','Synthetic','submitted',now()-n*interval '1 second' FROM generate_series(1,205) n",[a,u1]);
 const owner=await login('owner','synthetic-owner-password-123'),user=await login('alpha','synthetic-user-password-123');
 const snapshot=async()=>(await db.pool.query(`SELECT jsonb_build_object('accounts',(SELECT jsonb_agg(a ORDER BY id) FROM accounts a),'campaigns',(SELECT jsonb_agg(c ORDER BY id) FROM campaigns c),'recipients',(SELECT jsonb_agg(r ORDER BY id) FROM recipients r),'history',(SELECT jsonb_agg(m ORDER BY account_id,message_id) FROM message_history m),'users',(SELECT jsonb_agg(u ORDER BY id) FROM users u),'ledger',(SELECT count(*) FROM credit_ledger),'audit',(SELECT count(*) FROM audit)) value`)).rows[0].value;
 await t.test('Owner-only summaries expose no credentials and keep current senders separate',async()=>{
  const before=await snapshot();
  for(const kind of ['tasks','messages']){
   for(const session of [null,user])for(const path of ['/owner/send-groups?kind='+kind,'/owner/send-items?kind='+kind+'&actor_id='+u1])assert.equal((await request(path,session)).status,session?403:401);
   const r=await request('/owner/send-groups?kind='+kind,owner);assert.equal(r.status,200);assert.equal(r.data.kind,kind);assert.equal(r.data.groups[0].user.id,ownerId);
   for(const g of r.data.groups)if(g.user)assert.deepEqual(Object.keys(g.user).sort(),['active','id','locked','role','username']);
   assert.equal(r.data.groups.find(g=>g.user?.id===locked).total,0);
   if(kind==='tasks'){assert.equal(r.data.groups.find(g=>g.user?.id===u1).total,1);assert.equal(r.data.groups.find(g=>g.user?.id===u2).total,1);assert.equal(r.data.groups[0].total,1);}
   else{assert.equal(r.data.groups.find(g=>g.user?.id===u1).total,207);assert.equal(r.data.groups[0].total,2);assert.equal(r.data.groups.find(g=>g.user===null).total,1);}
  }
  assert.deepEqual(await snapshot(),before);
 });
 await t.test('per-ID pages keep every number once, preserve retained deletes and exclude shared data',async()=>{
  const before=await snapshot(),rows=[];
  for(let page=1;page<=3;page++){const r=await request('/owner/send-items?kind=messages&actor_id='+u1+'&page='+page,owner);assert.equal(r.status,200);assert.equal(r.data.total,207);assert.equal(r.data.page,page);assert.equal(r.data.rows.length,page===3?7:100);assert.ok(r.data.rows.every(r=>r.actor_id===u1));rows.push(...r.data.rows);}
  assert.equal(new Set(rows.map(r=>r.recipient_id?'r:'+r.recipient_id:'m:'+r.account_id+':'+r.message_id)).size,207);
  assert.equal(rows.filter(r=>r.message_id==='deduplicated-task').length,1);assert.ok(rows.some(r=>r.message_id==='deleted-user-history'&&r.deleted_at));assert.ok(rows.every(r=>r.account_id!==shared));
  const own=(await request('/owner/send-items?kind=tasks&actor_id='+ownerId,owner)).data;assert.equal(own.rows.length,1);assert.equal(own.rows[0].id,tasks[1]);assert.equal(own.rows[0].account_id,a);
  const other=(await request('/owner/send-items?kind=tasks&actor_id='+u2,owner)).data;assert.equal(other.rows.length,1);assert.ok(other.rows[0].deleted_at);
  const external=(await request('/owner/send-items?kind=messages&actor_id=external',owner)).data;assert.equal(external.rows.length,1);assert.equal(external.rows[0].message_id,'external-manual');assert.equal(external.rows[0].actor_id,null);
  for(const query of ['kind=invalid','kind=messages&actor_id=invalid','kind=tasks&actor_id=external'])assert.equal((await request('/owner/send-items?'+query,owner)).status,400);
  assert.deepEqual(await snapshot(),before);
  const initial=(await request('/owner/send-groups?kind=messages',owner)).data;await db.pool.query('DELETE FROM account_grants WHERE user_id=$1',[u1]);
  assert.deepEqual((await request('/owner/send-groups?kind=messages',owner)).data,initial);
  await db.pool.query('INSERT INTO account_grants(user_id,account_id) VALUES($1,$2)',[u1,a]);
 });
 await t.test('six dedicated shared groups report 30 separate slots and cannot be used by personal account creation',async()=>{
  for(const group of ['personal',...sharedGroups])await db.pool.query('INSERT INTO worker_health(worker_group,heartbeat_at,accounts_running,rss_mb,max_accounts,can_start_more) VALUES($1,now(),0,20,$2,true)',[group,group==='personal'?10:5]);
  const data=(await request('/shared/status?layout=2',owner)).data;assert.deepEqual(data.groups,sharedGroups);assert.equal(data.workers.length,6);assert.equal(data.workers.reduce((n,w)=>n+w.max_accounts,0),30);assert.ok(data.workers.every(w=>w.worker_group!=='personal'));
  const mine=(await request('/shared/status?layout=2',user)).data;assert.equal(mine.groups,undefined);assert.equal(mine.workers,undefined);
  assert.deepEqual((await request('/me',owner)).data.worker_groups,['personal']);assert.deepEqual((await request('/accounts',owner)).data.map(a=>a.id).sort(),[a,deleted].sort());
  assert.equal((await request('/shared/accounts',owner,'POST',{phones:'+12025550101',groups:['personal']})).status,400);
  assert.equal((await request('/accounts',owner,'POST',{label:'Invalid shared placement',worker_group:'shared-1'})).status,400);
  assert.equal((await request('/shared/accounts',user,'POST',{phones:'+12025550101',groups:['shared-1']})).status,403);
  assert.equal((await request('/shared/accounts/'+shared+'/connect',user,'POST',{})).status,403);
  assert.equal((await db.pool.query('SELECT account_limit FROM users WHERE id=$1',[u1])).rows[0].account_limit,10);
 });
 await t.test('new personal tasks do not require a title for either Owner or USER and do not charge on creation',async()=>{
  assert.equal((await request('/billing/price',owner,'PUT',{price:'0.10'})).status,200);
  const before=(await db.pool.query('SELECT credit_units FROM users WHERE id=$1',[u1])).rows[0].credit_units;
  const body={account_id:a,body:'Synthetic consented message',recipients:'+12025550101',opt_in_confirmed:true,pacing:true,interval_ms:10000,batch_size:1};
  for(const session of [owner,user]){const r=await request('/campaigns',session,'POST',body);assert.equal(r.status,201);const c=(await db.pool.query('SELECT title,created_by FROM campaigns WHERE id=$1',[r.data.id])).rows[0];assert.match(c.title,/^WhatsApp [a-f\d-]{36}$/);assert.equal(c.created_by,session===owner?ownerId:u1);}
  assert.equal((await request('/campaigns',owner,'POST',{...body,title:'x'.repeat(121)})).status,400);
  assert.equal((await db.pool.query('SELECT credit_units FROM users WHERE id=$1',[u1])).rows[0].credit_units,before);assert.equal((await db.pool.query('SELECT count(*)::int n FROM credit_ledger')).rows[0].n,0);
 });
});
