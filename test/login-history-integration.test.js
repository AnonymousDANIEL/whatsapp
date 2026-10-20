'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('PostgreSQL: precise Owner-only login history survives audit purge and enriches independently',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_logins_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.toString(),SERVICE_ROLE:'api',DB_POOL_SIZE:'8',PORT:'0',PUBLIC_URL:'http://localhost:3000',INTERNAL_SECRET:'synthetic-login-history-internal-key',BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'synthetic-owner-password-123',WORKER_ROUTES_JSON:'{"fixture":"http://127.0.0.1:9"}'});
 delete process.env.RAILWAY_ENVIRONMENT_ID;delete process.env.RAILWAY_SERVICE_ID;
 const db=require('../src/db'),history=require('../src/login-history'),{hash}=require('../src/domain');let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await db.pool.end();await admin.query('DROP DATABASE '+name);await admin.end();});
 await db.migrate();const ownerId=(await db.pool.query("SELECT id FROM users WHERE role='owner'")).rows[0].id,userId=randomUUID(),lockedId=randomUUID(),inactiveId=randomUUID();
 for(const[id,label,active,locked]of [[userId,'login-user',true,false],[lockedId,'locked-user',true,true],[inactiveId,'inactive-user',false,false]])await db.pool.query("INSERT INTO users(id,username,password_hash,role,active,locked,credit_units,remark) SELECT $1,$2,password_hash,'user',$3,$4,1234567,'Synthetic remark' FROM users WHERE id=$5",[id,label,active,locked,ownerId]);
 const oldTime='2026-01-02T03:04:05.123Z';await db.pool.query("INSERT INTO audit(actor_id,action,entity_id,created_at) VALUES($1::uuid,'login',$1::text,$2)",[userId,oldTime]);
 await Promise.all([history.ensure(db.pool),history.ensure(db.pool),history.ensure(db.pool)]);
 server=await require('../src/api').start({connectionMonitorIntervalMs:0,refundMonitorIntervalMs:0,loginMonitorIntervalMs:0});const base='http://127.0.0.1:'+server.address().port;
 async function session(id){const token=randomUUID().replaceAll('-','').repeat(2),csrf=randomUUID();await db.pool.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[hash(token),id,csrf]);return {cookie:'wa_session='+token,csrf};}
 const owner=await session(ownerId),user=await session(userId);
 async function request(path,auth=owner,method='GET',body,extra={}){const r=await fetch(base+'/api'+path,{method,headers:{...(auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{}),origin:'http://localhost:3000','content-type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')};}
 const facts=async()=>(await db.pool.query('SELECT id,password_hash,password_cipher,credit_units,remark,active,locked FROM users ORDER BY id')).rows;
 const beforeFacts=await facts();
 await t.test('migration backfills only actual login timestamps with absent legacy IP and no duplicates',async()=>{
  await history.ensure(db.pool);const r=await history.read(db.pool,userId);assert.equal(r.rows.length,1);assert.equal(r.rows[0].logged_at.toISOString(),oldTime);assert.equal(r.rows[0].ip,null);assert.equal(r.rows[0].user_agent,null);assert.equal(r.rows[0].geo_status,'legacy');
 });
 await t.test('only successful login records exact server time and direct socket IP; refresh/failures do not',async()=>{
  const start=Date.now(),result=await request('/login',null,'POST',{username:'login-user',password:'synthetic-owner-password-123'},{'user-agent':'Synthetic browser <img src=x onerror=alert(1)>','x-forwarded-for':'8.8.8.8','x-real-ip':'1.1.1.1','cf-connecting-ip':'9.9.9.9'});assert.equal(result.status,200);assert.ok(result.cookie);
  const r=await history.read(db.pool,userId),v=r.rows[0];assert.equal(r.rows.length,2);assert.equal(v.ip,'127.0.0.1');assert.equal(v.ip_source,'direct_socket');assert.equal(v.geo_status,'unavailable');assert.match(v.user_agent,/<img/);assert.ok(+v.logged_at>=start&&+v.logged_at<=Date.now());
  // read() intentionally excludes audit linkage and credentials.
  assert.equal(v.audit_id,undefined);assert.equal(JSON.stringify(r).includes('synthetic-owner-password'),false);
  assert.equal((await db.pool.query('SELECT last_login_at FROM users WHERE id=$1',[userId])).rows[0].last_login_at.toISOString(),v.logged_at.toISOString());
  for(const label of ['login-user','locked-user','inactive-user','missing-user'])assert.equal((await request('/login',null,'POST',{username:label,password:label==='login-user'?'incorrect-password':'synthetic-owner-password-123'})).status,401);
  for(let i=0;i<2;i++)assert.equal((await request('/me',user)).status,200);
  assert.equal((await history.read(db.pool,userId)).rows.length,2);assert.equal((await history.read(db.pool,lockedId)).rows.length,0);assert.equal((await history.read(db.pool,inactiveId)).rows.length,0);
  assert.equal((await request('/users')).data.find(u=>u.id===userId).latest_login_ip,'127.0.0.1');
 });
 await t.test('concurrent successful logins serialize safely and failed audit insertion rolls back the session',async()=>{
  const count=async(table)=>(await db.pool.query('SELECT count(*)::integer n FROM '+table+' WHERE '+'user_id'+'=$1',[userId])).rows[0].n;
  const historyBefore=await count('login_history');const results=await Promise.all([1,2].map(()=>request('/login',null,'POST',{username:'login-user',password:'synthetic-owner-password-123'})));assert.ok(results.every(r=>r.status===200));assert.equal(await count('login_history'),historyBefore+2);
  const sessionsBefore=await count('sessions'),eventsBefore=await count('login_history');
  await db.pool.query(`CREATE FUNCTION synthetic_login_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic login transaction failure'; END;$$;
   CREATE TRIGGER synthetic_login_failure BEFORE INSERT ON audit FOR EACH ROW WHEN(NEW.action='login') EXECUTE FUNCTION synthetic_login_failure()`);
  try{const failed=await request('/login',null,'POST',{username:'login-user',password:'synthetic-owner-password-123'});assert.equal(failed.status,500);assert.equal(failed.cookie,null);assert.equal(await count('sessions'),sessionsBefore);assert.equal(await count('login_history'),eventsBefore);}
  finally{await db.pool.query('DROP TRIGGER synthetic_login_failure ON audit; DROP FUNCTION synthetic_login_failure()');}
  await db.audit(userId,'password.change',userId);assert.equal(await count('login_history'),eventsBefore);
 });
 await t.test('Railway edge mode records its header exactly and ignores forwarded client claims',async()=>{
  Object.assign(process.env,{RAILWAY_ENVIRONMENT_ID:'synthetic-env',RAILWAY_SERVICE_ID:'synthetic-api'});
  try{const r=await request('/login',null,'POST',{username:'login-user',password:'synthetic-owner-password-123'},{'x-real-ip':'2001:4860:4860::8888','x-forwarded-for':'1.1.1.1','cf-connecting-ip':'9.9.9.9'});assert.equal(r.status,200);const last=(await history.read(db.pool,userId)).rows[0];assert.equal(last.ip,'2001:4860:4860::8888');assert.equal(last.ip_source,'railway_edge');}
  finally{delete process.env.RAILWAY_ENVIRONMENT_ID;delete process.env.RAILWAY_SERVICE_ID;}
  // Isolate the next fake-provider case without ever contacting a real service.
  await db.pool.query("UPDATE login_history SET geo_status='unavailable' WHERE ip='2001:4860:4860::8888'");
 });
 await t.test('history is authenticated and Owner-only, including hidden-status IDs; compact/USER responses omit network data',async()=>{
  assert.equal((await request('/users/'+userId+'/logins',null)).status,401);assert.equal((await request('/users/'+userId+'/logins',user)).status,403);
  for(const id of [ownerId,userId,lockedId,inactiveId])assert.equal((await request('/users/'+id+'/logins')).status,200);
  assert.equal((await request('/users/not-valid/logins')).status,400);assert.equal((await request('/users/'+randomUUID()+'/logins')).status,404);assert.equal((await request('/users/'+userId+'/logins?before=*')).status,400);
  assert.equal((await request('/users?compact=true')).data.some(u=>'latest_login_ip'in u),false);assert.equal('latest_login_ip'in(await request('/me',user)).data.user,false);
 });
 async function capture(ip='8.8.8.8',id=userId,time){return(await db.pool.query("INSERT INTO audit(actor_id,action,entity_id,details,created_at) VALUES($1::uuid,'login',$1::text,$2,COALESCE($3::timestamptz,clock_timestamp())) RETURNING id",[id,{login_network:{version:1,ip,ip_source:'synthetic_edge',user_agent:'Synthetic network fixture',geo_status:'pending'}},time||null])).rows[0].id;}
 await t.test('cached geodata is reused across IDs without a network call and stored snapshots never change',async()=>{
  await capture();await capture('8.8.8.8',ownerId);let calls=0;const fetcher=async()=>{calls++;return new Response(JSON.stringify({ip:'8.8.8.8',asn:'AS15169 Synthetic network',city:'Synthetic City',country:'Synthetic Country'}));};
  await Promise.all([history.enrich(db.pool,{fetcher,key:''}),history.enrich(db.pool,{fetcher,key:''})]);assert.equal(calls,1);
  const first=(await db.pool.query("SELECT * FROM login_history WHERE ip='8.8.8.8' ORDER BY id LIMIT 1")).rows[0];assert.equal(first.isp,'Synthetic network');assert.equal(first.geo_provider,'ipapi.is');
  await capture();await history.enrich(db.pool,{fetcher,key:''});assert.equal(calls,1);
  await db.pool.query("UPDATE login_ip_cache SET expires_at=now()-interval '1 second',retry_at=now()-interval '1 second' WHERE ip='8.8.8.8'");await capture();await history.enrich(db.pool,{fetcher:async()=>new Response(JSON.stringify({ip:'8.8.8.8',city:'Updated city'})),key:''});
  assert.equal((await db.pool.query('SELECT city FROM login_history WHERE id=$1',[first.id])).rows[0].city,'Synthetic City');assert.equal((await history.read(db.pool,userId)).rows[0].city,'Updated city');
 });
 await t.test('provider errors, quota exhaustion and concurrent scans back off while login remains usable',async()=>{
  await capture('1.1.1.1');let calls=0;const denied=async()=>{calls++;return new Response('',{status:429});};await history.enrich(db.pool,{fetcher:denied,key:''});await history.enrich(db.pool,{fetcher:denied,key:''});assert.equal(calls,1);
  assert.equal((await request('/login',null,'POST',{username:'login-user',password:'synthetic-owner-password-123'})).status,200);
  await db.pool.query("UPDATE login_lookup_budget SET blocked_until=NULL,used=25,day=(now() AT TIME ZONE 'UTC')::date");await db.pool.query("UPDATE login_ip_cache SET retry_at=now()-interval '1 second'");await history.enrich(db.pool,{fetcher:denied,key:''});assert.equal(calls,1);
  await db.pool.query("UPDATE login_lookup_budget SET used=0");await history.enrich(db.pool,{fetcher:async()=>{calls++;throw Error('Synthetic outage');},key:''});const after=calls;await history.enrich(db.pool,{fetcher:denied,key:''});assert.equal(calls,after);
 });
 await t.test('stable descending pagination retains ties and microseconds and history survives application audit purge',async()=>{
  for(let i=0;i<107;i++)await capture('127.0.0.1',userId,'2026-10-20T12:00:00.123456Z');
  const expected=(await db.pool.query('SELECT id FROM login_history WHERE user_id=$1 ORDER BY logged_at DESC,id DESC',[userId])).rows.map(r=>r.id);const ids=[];let cursor;
  do{const r=await history.read(db.pool,userId,cursor);assert.ok(r.rows.length<=50);ids.push(...r.rows.map(r=>r.id));cursor=r.next_cursor;}while(cursor);assert.deepEqual(ids,expected);assert.equal(new Set(ids).size,ids.length);
  await db.pool.query("DELETE FROM audit WHERE action='login'");await history.ensure(db.pool);assert.deepEqual((await db.pool.query('SELECT id FROM login_history WHERE user_id=$1 ORDER BY logged_at DESC,id DESC',[userId])).rows.map(r=>r.id),expected);
 });
 assert.deepEqual(await facts(),beforeFacts);assert.equal((await db.pool.query('SELECT count(*)::integer n FROM credit_ledger')).rows[0].n,0);
});
