'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('PostgreSQL: Owner QR slots reserve pending accounts, honor live resources and remain private',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_capacity_'+randomUUID().replaceAll('-','');
 if(!process.env.TEST_SINGLE_DATABASE)await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);if(!process.env.TEST_SINGLE_DATABASE)url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.toString(),APP_VAULT_KEY:'66'.repeat(32),SERVICE_ROLE:'api',PORT:'0',PUBLIC_URL:'http://localhost:3000',INTERNAL_SECRET:'disposable-capacity-fixture-secret',BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'capacity-owner-fixture-password',WORKER_ROUTES_JSON:JSON.stringify(Object.fromEntries(['group-a','group-b','group-c','group-d'].map(g=>[g,'http://127.0.0.1:9']))),SHARED_WORKER_GROUPS_JSON:'["group-b"]'});
 const db=require('../src/db');let server;
 t.after(async()=>{if(server)await new Promise(r=>server.close(r));await db.pool.end();if(!process.env.TEST_SINGLE_DATABASE)await admin.query('DROP DATABASE '+name);await admin.end();});
 await db.migrate();server=await require('../src/api').start({connectionMonitorIntervalMs:0,refundMonitorIntervalMs:0});const base='http://127.0.0.1:'+server.address().port;
 async function request(path,method='GET',body=null,s=null){const r=await fetch(base+'/api'+path,{method,headers:{Origin:'http://localhost:3000','Content-Type':'application/json',...(s?{Cookie:s.cookie,'X-CSRF-Token':s.csrf}:{})},...(body===null?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 async function login(username,password){const r=await request('/login','POST',{username,password});assert.equal(r.status,200);const s={cookie:r.cookie};s.csrf=(await request('/me','GET',null,s)).data.csrf;return s;}
 const owner=await login('owner','capacity-owner-fixture-password');
 assert.equal((await request('/users','POST',{username:'capacity_user',password:'capacity-user-fixture-password'},owner)).status,201);
 const user=await login('capacity_user','capacity-user-fixture-password');
 for(const [group,max,running,canStart,age] of [['group-a',10,8,false,0],['group-b',5,2,true,0],['group-c',5,2,true,120],['removed-group',10,0,true,0]])await db.pool.query(`INSERT INTO worker_health(worker_group,heartbeat_at,accounts_running,rss_mb,max_accounts,can_start_more) VALUES($1,now()-make_interval(secs=>$5),$3,50,$2,$4)`,[group,max,running,canStart,age]);
 for(const [group,n] of [['group-a',8],['group-b',3],['group-c',2]])for(let i=0;i<n;i++)await db.pool.query('INSERT INTO accounts(id,label,worker_group,shared_pool) VALUES($1,$2,$3,$4)',[randomUUID(),'Synthetic capacity account',group,group==='group-b'&&i===0]);
 await db.pool.query("INSERT INTO accounts(id,label,worker_group,enabled) VALUES($1,'Disabled fixture','group-b',false)",[randomUUID()]);
 await db.pool.query("INSERT INTO accounts(id,label,worker_group,deleted_at) VALUES($1,'Deleted fixture','group-b',now())",[randomUUID()]);
 async function state(){return {accounts:(await db.pool.query('SELECT id,enabled,status,profile_bound FROM accounts ORDER BY id')).rows,wallets:(await db.pool.query('SELECT id,credit_units,account_limit FROM users ORDER BY id')).rows,ledger:(await db.pool.query('SELECT count(*)::int n FROM credit_ledger')).rows};}
 const before=await state();
 await t.test('Owner personal health excludes dedicated shared groups while preserving resource accounting',async()=>{
  const r=await request('/health','GET',null,owner);assert.equal(r.status,200);assert.deepEqual(r.data.map(w=>w.worker_group),['group-a','group-c','group-d']);
  const [a,c,d]=r.data;assert.equal(a.slots_available,0);assert.equal(a.slots_unavailable,2);assert.equal(a.capacity_state,'resource_wait');
  assert.equal(c.slots_available,0);assert.equal(c.slots_unavailable,3);assert.equal(c.capacity_state,'offline');assert.equal(d.slots_available,0);assert.equal(d.capacity_state,'offline');
  assert.equal(r.data.reduce((n,w)=>n+w.slots_available,0),0);
 });
 await t.test('shared capacity uses only its configured groups and is never returned to USER',async()=>{
  const r=await request('/shared/status?layout=2','GET',null,owner);assert.equal(r.status,200);assert.deepEqual(r.data.groups,['group-b']);assert.equal(r.data.workers.length,1);assert.equal(r.data.workers[0].slots_available,2);
  const b=r.data.workers[0];assert.equal(b.accounts_running,2);assert.equal(b.assigned_accounts,3);assert.equal(b.slots_used,3);
  const personal=(await request('/health','GET',null,owner)).data;assert.ok(personal.every(w=>!r.data.groups.includes(w.worker_group)));assert.equal([...personal,...r.data.workers].reduce((n,w)=>n+Number(w.max_accounts||0),0),20);
  assert.equal((await request('/health','GET',null,user)).status,403);
  const mine=(await request('/shared/status?layout=2','GET',null,user)).data;for(const key of ['workers','groups','slots_available','slots_used','slots_unavailable'])assert.equal(mine[key],undefined);
 });
 await t.test('capacity reads never change accounts, funds or the ten-account USER quota',async()=>{
  assert.deepEqual(await state(),before);assert.equal((await db.pool.query("SELECT account_limit FROM users WHERE username='capacity_user'")).rows[0].account_limit,10);
 });
});
