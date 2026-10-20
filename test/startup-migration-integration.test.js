'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('PostgreSQL: startup schema verification avoids live-reader DDL deadlocks and retains account data',{skip:!process.env.TEST_DATABASE_URL,timeout:45000},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_startup_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.toString(),SERVICE_ROLE:'worker',DB_POOL_SIZE:'8'});
 const db=require('../src/db'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-startup-'));let child,output='';
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await done;clearTimeout(timer);}
  await db.pool.end();await admin.query('DROP DATABASE '+name);await admin.end();await fs.rm(dir,{recursive:true,force:true});
 });
 assert.deepEqual(await db.migrateStartup(),{version:1,action:'applied',attempts:1});
 const user=randomUUID(),account=randomUUID();
 await db.pool.query("INSERT INTO users(id,username,password_hash,role,credit_units,remark) VALUES($1,'synthetic-startup','synthetic-retained-hash','user',1234567,'Retained remark')",[user]);
 await db.pool.query("INSERT INTO accounts(id,label,worker_group,phone,profile_bound,status) VALUES($1,'Retained synthetic link','other-group','synthetic-linked-phone',true,'ready')",[account]);
 await db.pool.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,true)',[user,account]);
 await db.pool.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES('synthetic-existing-session',$1,'synthetic-csrf',now()+interval '1 day')",[user]);
 const marker=path.join(dir,'retained-profile.marker');await fs.writeFile(marker,'preserved');
 const facts=async()=>({users:(await db.pool.query('SELECT id,password_hash,credit_units,remark,active,locked FROM users ORDER BY id')).rows,accounts:(await db.pool.query('SELECT id,worker_group,phone,profile_bound,status FROM accounts ORDER BY id')).rows,grants:(await db.pool.query('SELECT * FROM account_grants ORDER BY user_id,account_id')).rows,sessions:(await db.pool.query('SELECT * FROM sessions ORDER BY token_hash')).rows,ledger:(await db.pool.query('SELECT * FROM credit_ledger ORDER BY id')).rows});
 const before=await facts(),deadlocks=(await admin.query('SELECT deadlocks FROM pg_stat_database WHERE datname=$1',[name])).rows[0].deadlocks;
 await t.test('cached production startups finish while live billing readers hold table locks',async()=>{
  const reader=await db.pool.connect();await reader.query('BEGIN');await reader.query('LOCK TABLE users,message_charges IN ACCESS SHARE MODE');
  try{
   const started=Date.now();const results=await Promise.all(Array.from({length:12},()=>db.migrateStartup()));
   assert.ok(results.every(r=>r.action==='verified'&&r.attempts===1));assert.ok(Date.now()-started<5000);
   await reader.query('SELECT m.recipient_id,m.version,r.status FROM message_charges m JOIN recipients r ON r.id=m.recipient_id');
  }finally{await reader.query('ROLLBACK');reader.release();}
  assert.deepEqual(await facts(),before);assert.equal(await fs.readFile(marker,'utf8'),'preserved');
 });
 await t.test('a real production worker entrypoint starts through the verified schema path',async()=>{
  const reader=await db.pool.connect();await reader.query('BEGIN');await reader.query('LOCK TABLE users,message_charges IN ACCESS SHARE MODE');
  try{
   child=spawn(process.execPath,['src/main.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:'0',WORKER_GROUP:'synthetic-startup-empty',MAX_ACCOUNTS_PER_WORKER:'2',DATA_DIR:dir,INTERNAL_SECRET:'synthetic-startup-internal-secret-not-live'},stdio:['ignore','pipe','pipe']});
   for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+b).slice(-8000);});
   const until=Date.now()+10000;while(!output.includes('Browser worker ready: synthetic-startup-empty')&&Date.now()<until&&child.exitCode===null)await new Promise(r=>setTimeout(r,25));
   assert.match(output,/Database schema ready:.*"action":"verified"/);assert.match(output,/Browser worker ready: synthetic-startup-empty/);assert.doesNotMatch(output,/Startup failed:|worker tick:/);
  }finally{await reader.query('ROLLBACK');reader.release();}
  const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;child=null;
  assert.deepEqual(await facts(),before);assert.equal(await fs.readFile(marker,'utf8'),'preserved');
 });
 await t.test('a missing fingerprint applies the schema with bounded own-transaction retries, never aborting a reader',async()=>{
  await db.pool.query("DELETE FROM app_migrations WHERE name LIKE 'startup_schema_sha256_v1:%'");
  const reader=await db.pool.connect();await reader.query('BEGIN');await reader.query('LOCK TABLE users IN ACCESS SHARE MODE');
  const migration=db.migrateStartup();migration.catch(()=>{});let result;
  try{
   let blocked=false;const until=Date.now()+5000;
   while(Date.now()<until){blocked=(await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'CREATE TABLE IF NOT EXISTS users%'",[name])).rowCount>0;if(blocked)break;await new Promise(r=>setTimeout(r,10));}
   assert.ok(blocked,'Observe the actual blocked schema transaction before releasing the reader');
   await new Promise(r=>setTimeout(r,350));await reader.query('SELECT count(*) FROM users');
  }finally{await reader.query('ROLLBACK');reader.release();result=await migration;}
  assert.equal(result.action,'applied');assert.ok(result.attempts>=2);assert.ok(result.attempts<=20);
  assert.deepEqual(await facts(),before);assert.equal(await fs.readFile(marker,'utf8'),'preserved');
  assert.equal((await admin.query('SELECT deadlocks FROM pg_stat_database WHERE datname=$1',[name])).rows[0].deadlocks,deadlocks);
  assert.equal((await db.migrateStartup()).action,'verified');
 });
});
