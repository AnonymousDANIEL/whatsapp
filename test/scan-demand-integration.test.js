'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('PostgreSQL: real worker queues QR starts quickly, coalesces demand, retains profiles and enforces its private boundary',{skip:!process.env.TEST_DATABASE_URL,timeout:45000},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_qr_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.toString(),SERVICE_ROLE:'worker'});const db=require('../src/db');await db.migrate();
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'wa-qr-demand-')),id=randomUUID(),other=randomUUID(),deleted=randomUUID(),group='synthetic-qr',secret='synthetic-qr-internal-secret-not-live';let child,output='';
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(timer);}
  await db.pool.end();await admin.query('DROP DATABASE '+name);await admin.end();await fs.rm(data,{recursive:true,force:true});
 });
 await db.pool.query(`INSERT INTO accounts(id,label,worker_group,profile_bound,deleted_at) VALUES
  ($1,'Synthetic bound QR',$4,true,NULL),($2,'Other group','other',false,NULL),($3,'Deleted',$4,false,now())`,[id,other,deleted,group]);
 const folder=path.join(data,'profiles',id);await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'keep-session.marker'),'preserved');
 const script=`(async()=>{require('./src/browser-lifecycle').resourceSummary=async()=>({pids:990,pids_limit:1000});await require('./src/db').migrate();const server=await require('./src/worker').start();process.send({port:server.address().port});})().catch(e=>{console.error(e.code||e.name);process.exit(1);});`;
 child=spawn(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:'0',WORKER_GROUP:group,MAX_ACCOUNTS_PER_WORKER:'5',DB_POOL_SIZE:'2',DATA_DIR:data,INTERNAL_SECRET:secret},stdio:['ignore','pipe','pipe','ipc']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+b).slice(-3000);});
 const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic QR worker startup timed out: '+output)),15000);child.once('message',v=>{clearTimeout(timer);resolve(v);});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(Error('Synthetic QR worker exited: '+code+' '+output));});});
 const base='http://127.0.0.1:'+ready.port,headers={Authorization:'Bearer '+secret};
 assert.equal((await fetch(base+'/accounts/'+id+'/start',{method:'POST'})).status,401);
 for(const target of [other,deleted])assert.equal((await fetch(base+'/accounts/'+target+'/start',{method:'POST',headers})).status,404);
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM scan_demand')).rows[0].n,0);
 const began=Date.now(),r=await fetch(base+'/accounts/'+id+'/start',{method:'POST',headers});
 assert.equal(r.status,202);assert.deepEqual(await r.json(),{ok:true,queued:true,role:'worker',group});assert.ok(Date.now()-began<2000,'Admission must not wait for desktop initialization');
 const first=(await db.pool.query('SELECT requested_at,expires_at FROM scan_demand WHERE account_id=$1',[id])).rows[0];
 const concurrent=await Promise.all(Array.from({length:6},()=>fetch(base+'/accounts/'+id+'/start',{method:'POST',headers})));assert.ok(concurrent.every(r=>r.status===202));await Promise.all(concurrent.map(r=>r.arrayBuffer()));
 const next=(await db.pool.query('SELECT requested_at,expires_at FROM scan_demand WHERE account_id=$1',[id])).rows[0];assert.equal(+next.requested_at,+first.requested_at);assert.ok(+next.expires_at>=+first.expires_at);
 let status;for(let i=0;i<80;i++){const r=await fetch(base+'/accounts/'+id+'/status',{headers});status=await r.json();if(status.code==='BROWSER_RESOURCE_WAIT')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(status.code,'BROWSER_RESOURCE_WAIT');assert.equal(status.screen_ready,false);assert.equal(status.connected,false);
 assert.equal((await db.pool.query('SELECT profile_bound,worker_group FROM accounts WHERE id=$1',[id])).rows[0].profile_bound,true);
 assert.equal(await fs.readFile(path.join(folder,'keep-session.marker'),'utf8'),'preserved');assert.equal((await db.pool.query('SELECT count(*)::int n FROM credit_ledger')).rows[0].n,0);
 await db.pool.query("UPDATE scan_demand SET expires_at=now()-interval '1 second' WHERE account_id=$1",[id]);assert.equal((await require('../src/scan-demand').read(db.pool,group)).size,0);
 const restart=await fetch(base+'/accounts/'+id+'/start',{method:'POST',headers});assert.equal(restart.status,202);await restart.arrayBuffer();
 assert.ok(+(await db.pool.query('SELECT requested_at FROM scan_demand WHERE account_id=$1',[id])).rows[0].requested_at>+first.requested_at);
 await db.pool.query('DELETE FROM accounts WHERE id=$1',[id]);assert.equal((await db.pool.query('SELECT count(*)::int n FROM scan_demand')).rows[0].n,0);assert.equal(await fs.readFile(path.join(folder,'keep-session.marker'),'utf8'),'preserved');
});
