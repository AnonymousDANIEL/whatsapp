'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');

test('PostgreSQL: password resets cannot leave a concurrent old-password login authenticated',{skip:!process.env.TEST_DATABASE_URL,timeout:30000},async t=>{
 const {Pool}=require('pg'),bcrypt=require('bcryptjs'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const name='wa_login_reset_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.toString(),SERVICE_ROLE:'api',DB_POOL_SIZE:'8',PORT:'0',PUBLIC_URL:'http://localhost:3000',
  INTERNAL_SECRET:'synthetic-login-reset-internal-secret',APP_VAULT_KEY:'ab'.repeat(32),BOOTSTRAP_USERNAME:'owner',
  BOOTSTRAP_PASSWORD:'synthetic-owner-password-123',WORKER_ROUTES_JSON:'{}',SHARED_WORKER_GROUPS_JSON:'[]',SHARED_WORKER_ROUTES_JSON:'{}',SHARED_ADDITIONAL_ROUTES_JSON:'{}'});
 const db=require('../src/db'),{hash,PERMISSIONS}=require('../src/domain'),folder=await fs.mkdtemp(path.join(os.tmpdir(),'wa-login-reset-'));
 let server;const originalCompare=bcrypt.compare;
 t.after(async()=>{bcrypt.compare=originalCompare;if(server)await new Promise(resolve=>server.close(resolve));await db.pool.end();await admin.query('DROP DATABASE '+name);await admin.end();await fs.rm(folder,{recursive:true,force:true});});
 await db.migrate();const ownerId=(await db.pool.query("SELECT id FROM users WHERE role='owner'")).rows[0].id,userId=randomUUID(),accountId=randomUUID();
 const oldPassword='synthetic-user-old-password',newPassword='synthetic-user-new-password',thirdPassword='synthetic-user-third-password';
 await db.pool.query("INSERT INTO users(id,username,password_hash,role,credit_units,permissions,remark) VALUES($1,'reset-user',$2,'user',1234567,$3,'Preserved remark')",[userId,await bcrypt.hash(oldPassword,12),PERMISSIONS]);
 await db.pool.query("INSERT INTO accounts(id,label,worker_group,phone,profile_bound,status) VALUES($1,'Preserved synthetic account','synthetic-retained','12025550101',true,'ready')",[accountId]);
 await db.pool.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,true)',[userId,accountId]);
 const marker=path.join(folder,'profile.marker');await fs.writeFile(marker,'preserved');
 server=await require('../src/api').start({connectionMonitorIntervalMs:0,refundMonitorIntervalMs:0,loginMonitorIntervalMs:0});
 const base='http://127.0.0.1:'+server.address().port;
 async function session(id){const token=randomUUID().replaceAll('-','').repeat(2),csrf=randomUUID();await db.pool.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[hash(token),id,csrf]);return {cookie:'wa_session='+token,csrf};}
 const owner=await session(ownerId),oldSession=await session(userId);
 async function request(endpoint,auth,method='GET',body){const r=await fetch(base+'/api'+endpoint,{method,headers:{origin:'http://localhost:3000','content-type':'application/json',...(auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||null};}
 const userSessions=async()=>(await db.pool.query('SELECT count(*)::integer n FROM sessions WHERE user_id=$1',[userId])).rows[0].n;
 const protectedFacts=async()=>({accounts:(await db.pool.query('SELECT * FROM accounts ORDER BY id')).rows,grants:(await db.pool.query('SELECT * FROM account_grants ORDER BY user_id,account_id')).rows,
  money:(await db.pool.query('SELECT id,credit_units,remark,permissions,active,locked FROM users ORDER BY id')).rows,ledger:(await db.pool.query('SELECT * FROM credit_ledger ORDER BY id')).rows,
  owner:(await db.pool.query('SELECT password_hash,password_cipher FROM users WHERE id=$1',[ownerId])).rows,profile:await fs.readFile(marker,'utf8')});
 const before=await protectedFacts();
 let freshSession;
 await t.test('Owner reset committed after successful bcrypt verification rejects the stale login without a session or audit',async()=>{
  const oldHash=(await db.pool.query('SELECT password_hash FROM users WHERE id=$1',[userId])).rows[0].password_hash;
  let entered,release;const checked=new Promise(resolve=>{entered=resolve}),resume=new Promise(resolve=>{release=resolve});
  bcrypt.compare=async function(...args){const valid=await originalCompare.apply(this,args);if(args[1]===oldHash&&valid){entered();await resume;}return valid;};
  const login=request('/login',null,'POST',{username:'reset-user',password:oldPassword});let timer;
  try{
   await Promise.race([checked,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Login did not reach successful password verification')),5000);})]);clearTimeout(timer);
   const reset=await request('/users/'+userId,owner,'PATCH',{active:true,password:newPassword});assert.equal(reset.status,200);
   assert.equal(await userSessions(),0);assert.equal((await request('/me',oldSession)).status,401);
   release();const stale=await login;assert.equal(stale.status,401);assert.equal(stale.cookie,null);assert.equal(await userSessions(),0);
   assert.equal((await db.pool.query("SELECT count(*)::integer n FROM audit WHERE actor_id=$1 AND action='login'",[userId])).rows[0].n,0);
   assert.equal((await db.pool.query('SELECT count(*)::integer n FROM login_history WHERE user_id=$1',[userId])).rows[0].n,0);
   assert.equal((await db.pool.query('SELECT last_login_at FROM users WHERE id=$1',[userId])).rows[0].last_login_at,null);
  }finally{clearTimeout(timer);release();await login.catch(()=>{});bcrypt.compare=originalCompare;}
 });
 await t.test('new password and normal concurrent logins remain usable; USER cannot change credentials',async()=>{
  assert.equal((await request('/login',null,'POST',{username:'reset-user',password:oldPassword})).status,401);
  const good=await Promise.all([1,2].map(()=>request('/login',null,'POST',{username:'reset-user',password:newPassword})));
  assert.ok(good.every(r=>r.status===200&&r.cookie));assert.equal(await userSessions(),2);
  freshSession={cookie:good[0].cookie};const me=await request('/me',freshSession);assert.equal(me.status,200);freshSession.csrf=me.data.csrf;
  assert.equal((await request('/password',freshSession,'POST',{current_password:newPassword,password:thirdPassword})).status,403);
  assert.equal((await request('/me',owner)).status,200);
 });
 await t.test('a later reset revokes completed USER logins and retains unrelated Owner sessions and all account/fund data',async()=>{
  assert.equal((await request('/users/'+userId,owner,'PATCH',{active:true,password:thirdPassword})).status,200);
  assert.equal(await userSessions(),0);assert.equal((await request('/me',freshSession)).status,401);assert.equal((await request('/me',owner)).status,200);
  assert.equal((await request('/login',null,'POST',{username:'reset-user',password:newPassword})).status,401);
  assert.equal((await request('/login',null,'POST',{username:'reset-user',password:thirdPassword})).status,200);
  assert.deepEqual(await protectedFacts(),before);
 });
});
