'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),http=require('node:http');
test('PostgreSQL: Owner shared QR creation uses independent capacity and binds only the first valid linked identity',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_shared_scan_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 const starts=[],worker=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer synthetic-shared-scan-secret-32-chars');if(/^\/accounts\/[a-f\d-]+\/start$/.test(req.url))starts.push(req.url);res.setHeader('Content-Type','application/json');res.end('{"ok":true}');});
 await new Promise(r=>worker.listen(0,'127.0.0.1',r));const address='http://127.0.0.1:'+worker.address().port;
 const groups=Array.from({length:6},(_,i)=>'shared-'+(i+1));
 Object.assign(process.env,{DATABASE_URL:url.toString(),SERVICE_ROLE:'api',PORT:'0',PUBLIC_URL:'http://localhost:3000',INTERNAL_SECRET:'synthetic-shared-scan-secret-32-chars',BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'synthetic-owner-password-123',APP_VAULT_KEY:'88'.repeat(32),WORKER_ROUTES_JSON:JSON.stringify(Object.fromEntries(['personal',...groups].map(g=>[g,address]))),SHARED_WORKER_GROUPS_JSON:JSON.stringify(groups)});
 const db=require('../src/db'),links=require('../src/shared-accounts');let server;
 t.after(async()=>{if(server)await new Promise(r=>server.close(r));await new Promise(r=>worker.close(r));await db.pool.end();await admin.query('DROP DATABASE '+name);await admin.end();});
 await db.migrate();server=await require('../src/api').start();const base='http://127.0.0.1:'+server.address().port;
 async function request(path,session,method='GET',body,csrf=true){const r=await fetch(base+'/api'+path,{method,headers:{Origin:'http://localhost:3000','Content-Type':'application/json',...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrf}:{})}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 async function login(username,password){const r=await request('/login',null,'POST',{username,password});assert.equal(r.status,200);const session={cookie:r.cookie};session.csrf=(await request('/me',session)).data.csrf;return session;}
 const owner=await login('owner','synthetic-owner-password-123'),userId=randomUUID();
 await db.pool.query("INSERT INTO users(id,username,password_hash,role,permissions,credit_units) VALUES($1,'scan-user',$2,'user',ARRAY['tasks.create'],1000000)",[userId,await require('bcryptjs').hash('synthetic-user-password-123',4)]);
 const user=await login('scan-user','synthetic-user-password-123'),personal=randomUUID(),legacy=randomUUID();
 await db.pool.query("INSERT INTO accounts(id,label,worker_group,phone,status) VALUES($1,'Preserved personal','personal','12025550101','ready')",[personal]);
 await db.pool.query("INSERT INTO accounts(id,label,worker_group,enabled,status,shared_pool,registration_phone) VALUES($1,'Legacy registration','shared-1',false,'disabled',true,'+12025550102')",[legacy]);
 const protectedRows=async()=>({accounts:(await db.pool.query('SELECT * FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id',[[personal,legacy]])).rows,wallets:(await db.pool.query('SELECT id,credit_units FROM users ORDER BY id')).rows,charges:(await db.pool.query('SELECT * FROM message_charges')).rows,ledger:(await db.pool.query('SELECT * FROM credit_ledger')).rows,campaigns:(await db.pool.query('SELECT * FROM campaigns')).rows});
 const before=await protectedRows();const body=(label='Synthetic QR')=>({request_id:randomUUID(),label});let first;
 await t.test('migration and denials leave historical accounts, money and browser commands unchanged',async()=>{
  await Promise.all([links.ensureLinking(),links.ensureLinking()]);assert.deepEqual(await protectedRows(),before);
  assert.equal((await request('/shared/accounts/scan',null,'POST',body())).status,401);
  assert.equal((await request('/shared/accounts/scan',user,'POST',body())).status,403);
  assert.equal((await request('/shared/accounts/scan',owner,'POST',body(),false)).status,403);
  assert.equal((await request('/shared/accounts/scan',owner,'POST',{...body(),worker_group:'personal'})).status,400);
  assert.equal((await request('/shared/accounts/scan',owner,'POST',{...body(),request_id:'invalid'})).status,400);
  assert.equal((await request('/shared/accounts/scan',owner,'POST',body(''))).status,400);
  assert.equal((await request('/shared/accounts/scan',owner,'POST',body())).status,503);assert.equal(starts.length,0);
  assert.deepEqual(await protectedRows(),before);
 });
 await t.test('dedicated fresh capacity creates a QR slot without a number and identical retries never restart it',async()=>{
  for(const group of ['personal',...groups])await db.pool.query('INSERT INTO worker_health(worker_group,heartbeat_at,accounts_running,rss_mb,max_accounts,can_start_more) VALUES($1,now(),0,20,$2,true)',[group,group==='personal'?10:5]);
  const b=body();first=(await request('/shared/accounts/scan',owner,'POST',b));assert.equal(first.status,201);assert.equal(first.data.started,true);assert.equal(first.data.id,b.request_id);
  let row=(await db.pool.query('SELECT * FROM accounts WHERE id=$1',[b.request_id])).rows[0];assert.equal(row.shared_pool,true);assert.equal(row.shared_scan_unbound,true);assert.equal(row.registration_phone,null);assert.equal(row.phone,null);assert.ok(groups.includes(row.worker_group));assert.equal(row.enabled,true);
  assert.deepEqual(starts,['/accounts/'+row.id+'/start']);
  assert.equal((await request('/shared/accounts/scan',owner,'POST',b)).data.replayed,true);assert.equal(starts.length,1);
  assert.equal((await request('/shared/accounts/scan',owner,'POST',{...b,label:'Changed request'})).status,409);
  assert.equal((await request('/accounts/'+row.id+'/connection?mode=scan',user)).status,403);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM account_grants WHERE account_id=$1',[row.id])).rows[0].n,0);
  // This is the trusted worker's first real ready event, represented in the disposable DB.
  await db.pool.query("UPDATE accounts SET status='ready',phone='12025550103',shared_state='unknown',shared_checked_at=now() WHERE id=$1",[row.id]);
  row=(await db.pool.query('SELECT * FROM accounts WHERE id=$1',[row.id])).rows[0];assert.equal(row.registration_phone,'+12025550103');assert.equal(row.shared_scan_unbound,false);assert.equal(row.shared_state,'connected');
  assert.equal((await request('/shared/accounts/scan',owner,'POST',b)).data.replayed,true);assert.equal(starts.length,1);
  const {connectedSQL}=require('../src/shared-domain');assert.equal((await db.pool.query('SELECT ('+connectedSQL+') AS ok FROM accounts a WHERE id=$1',[row.id])).rows[0].ok,true);
  // A later different scan cannot silently replace the first registered identity.
  await db.pool.query("UPDATE accounts SET phone='12025550104',shared_state='unknown' WHERE id=$1",[row.id]);
  assert.equal((await db.pool.query('SELECT registration_phone FROM accounts WHERE id=$1',[row.id])).rows[0].registration_phone,'+12025550103');
  assert.equal((await db.pool.query('SELECT ('+connectedSQL+') AS ok FROM accounts a WHERE id=$1',[row.id])).rows[0].ok,false);
  assert.deepEqual(await protectedRows(),before);
 });
 await t.test('phone conflicts, opaque IDs and disabled entries cannot become eligible shared senders',async()=>{
  const ids=Array.from({length:5},()=>randomUUID());
  for(const id of ids)await db.pool.query("INSERT INTO accounts(id,label,worker_group,shared_pool,shared_scan_unbound,status) VALUES($1,'Synthetic guarded scan','shared-2',true,true,'scan_required')",[id]);
  for(const [id,phone] of [[ids[0],'12025550101'],[ids[1],'12025550102'],[ids[2],'99999999999999999999']]){
   await db.pool.query("UPDATE accounts SET status='ready',phone=$2,shared_state='unknown' WHERE id=$1",[id,phone]);
   const row=(await db.pool.query('SELECT * FROM accounts WHERE id=$1',[id])).rows[0];assert.equal(row.registration_phone,null);assert.equal(row.shared_scan_unbound,true);assert.equal(row.shared_state,'unknown');
  }
  await db.pool.query("UPDATE accounts SET enabled=false,status='ready',phone='12025550105',shared_state='unknown' WHERE id=$1",[ids[3]]);
  await db.pool.query("UPDATE accounts SET deleted_at=now(),status='ready',phone='12025550106',shared_state='unknown' WHERE id=$1",[ids[4]]);
  assert.ok((await db.pool.query('SELECT registration_phone FROM accounts WHERE id=ANY($1::uuid[])',[ids])).rows.every(r=>r.registration_phone===null));
  const pair=[randomUUID(),randomUUID()];for(const id of pair)await db.pool.query("INSERT INTO accounts(id,label,worker_group,shared_pool,shared_scan_unbound,status) VALUES($1,'Concurrent phone fixture','shared-3',true,true,'scan_required')",[id]);
  await Promise.all(pair.map(id=>db.pool.query("UPDATE accounts SET status='ready',phone='12025550107',shared_state='unknown' WHERE id=$1",[id])));
  const rows=(await db.pool.query('SELECT registration_phone,shared_state FROM accounts WHERE id=ANY($1::uuid[])',[pair])).rows;assert.equal(rows.filter(r=>r.registration_phone!==null).length,1);assert.equal(rows.filter(r=>r.shared_state==='connected').length,1);
  await db.pool.query('UPDATE accounts SET enabled=false WHERE id=ANY($1::uuid[])',[[...ids,...pair,first.data.id]]);
  assert.deepEqual(await protectedRows(),before);
 });
 await t.test('concurrent allocation respects independent limits and rejects stale, future and resource-blocked groups',async()=>{
  await db.pool.query('UPDATE worker_health SET max_accounts=1,accounts_running=0,can_start_more=true,heartbeat_at=now() WHERE worker_group=ANY($1::text[])',[groups]);
  const results=await Promise.all(Array.from({length:7},()=>request('/shared/accounts/scan',owner,'POST',body('Concurrent capacity'))));
  assert.equal(results.filter(r=>r.status===201).length,6);assert.equal(results.filter(r=>r.status===503).length,1);
  const rows=(await db.pool.query('SELECT worker_group,count(*)::int n FROM accounts WHERE shared_pool AND enabled AND deleted_at IS NULL GROUP BY worker_group')).rows;assert.equal(rows.length,6);assert.ok(rows.every(r=>r.n===1&&groups.includes(r.worker_group)));
  const personalCapacity=(await request('/health',owner)).data;assert.deepEqual(personalCapacity.map(w=>w.worker_group),['personal']);assert.equal(personalCapacity[0].max_accounts,10);
  let status=(await request('/shared/status?layout=2',owner)).data;assert.equal(status.workers.reduce((n,w)=>n+w.max_accounts,0),6);assert.equal(status.workers.reduce((n,w)=>n+w.slots_available,0),0);assert.ok(status.groups.every(g=>g!=='personal'));
  await db.pool.query("UPDATE worker_health SET max_accounts=5,heartbeat_at=CASE WHEN worker_group='shared-1' THEN now()+interval '1 hour' ELSE now()-interval '2 minutes' END WHERE worker_group=ANY($1::text[])",[groups]);
  assert.equal((await request('/shared/accounts/scan',owner,'POST',body())).status,503);
  await db.pool.query('UPDATE worker_health SET heartbeat_at=now(),can_start_more=false WHERE worker_group=ANY($1::text[])',[groups]);
  assert.equal((await request('/shared/accounts/scan',owner,'POST',body())).status,503);
  status=(await request('/shared/status?layout=2',user)).data;assert.equal(status.workers,undefined);assert.equal(status.groups,undefined);assert.equal((await request('/accounts',user)).data.length,0);
  assert.deepEqual(await protectedRows(),before);assert.equal(starts.length,7);
 });
});
