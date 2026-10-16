'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('PostgreSQL: independent connection capacity and profile-safe account handoff',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_allocation_'+randomUUID().replaceAll('-','');
 if(!process.env.TEST_SINGLE_DATABASE)await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.TEST_DATABASE_URL);if(!process.env.TEST_SINGLE_DATABASE)url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.toString(),SERVICE_ROLE:'worker'});
 const db=require('../src/db'),allocation=require('../src/account-allocation'),folder=await fs.mkdtemp(path.join(os.tmpdir(),'wa-allocation-'));
 t.after(async()=>{await db.pool.end();if(!process.env.TEST_SINGLE_DATABASE)await admin.query('DROP DATABASE '+name);await admin.end();await fs.rm(folder,{recursive:true,force:true});});
 await db.migrate();
 async function reset(max=2){
  await db.pool.query('DELETE FROM accounts');await db.pool.query('DELETE FROM worker_health');
  await db.pool.query(`INSERT INTO worker_health(worker_group,heartbeat_at,accounts_running,rss_mb,max_accounts,can_start_more)
   VALUES('a',now(),2,100,2,false),('b',now(),0,100,$1,true)`,[max]);
 }
 async function account(group='a',extra={}){const id=randomUUID();await db.pool.query(`INSERT INTO accounts(id,label,worker_group,status,profile_bound,phone)
  VALUES($1,'Synthetic allocation',$2,'capacity_wait',$3,$4)`,[id,group,extra.bound||false,extra.phone||null]);return id;}
 await t.test('resource pressure, stale workers, configured scopes and reserved record counts drive placement',async()=>{
  await reset();assert.equal(await allocation.chooseGroup(db.pool,['a','b'],'a'),'b');
  assert.equal(await allocation.chooseGroup(db.pool,['a'],'a'),null);
  await db.pool.query("UPDATE worker_health SET heartbeat_at=now()-interval '5 minutes' WHERE worker_group='b'");assert.equal(await allocation.chooseGroup(db.pool,['a','b'],'a'),null);
  await db.pool.query("UPDATE worker_health SET heartbeat_at=now() WHERE worker_group='b'");await account('b');await account('b');assert.equal(await allocation.chooseGroup(db.pool,['a','b'],'a'),null);
 });
 await t.test('an unstarted account can move once; its old worker cannot claim a browser afterward',async()=>{
  await reset();const id=await account();assert.equal(await allocation.moveUnstarted(id,'a','b',folder,new Map()),true);
  assert.equal((await db.pool.query("UPDATE accounts SET profile_bound=true WHERE id=$1 AND worker_group='a' RETURNING id",[id])).rowCount,0);
  assert.equal((await db.pool.query("UPDATE accounts SET profile_bound=true WHERE id=$1 AND worker_group='b' RETURNING id",[id])).rowCount,1);
  assert.equal(await allocation.moveUnstarted(id,'b','a',folder,new Map()),false);
 });
 await t.test('existing homes, profile folders, Unix identities, phone links and active entries never move',async()=>{
  await reset();const profile=await account(),home=await account(),identity=await account(),linked=await account('a',{phone:'synthetic-linked'}),bound=await account('a',{bound:true}),active=await account();
  await fs.mkdir(path.join(folder,'profiles',profile),{recursive:true});await fs.writeFile(path.join(folder,'profiles',profile,'sentinel'),'preserve');
  await fs.mkdir(path.join(folder,'homes',home),{recursive:true});await fs.writeFile(path.join(folder,'identities.json'),JSON.stringify({[identity]:20000}));
  for(const id of [profile,home,identity,linked,bound,active])assert.equal(await allocation.moveUnstarted(id,'a','b',folder,new Map(id===active?[[id,{}]]:[])),false);
  assert.equal(await fs.readFile(path.join(folder,'profiles',profile,'sentinel'),'utf8'),'preserve');
 });
 await t.test('concurrent handoffs cannot overbook the last target slot',async()=>{
  await reset(1);const ids=[await account(),await account()];
  const results=await Promise.all(ids.map(id=>allocation.moveUnstarted(id,'a','b',folder,new Map())));assert.equal(results.filter(Boolean).length,1);
  assert.equal((await db.pool.query("SELECT count(*)::integer n FROM accounts WHERE worker_group='b'")).rows[0].n,1);
 });
});
