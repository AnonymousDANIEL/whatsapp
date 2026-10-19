'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('PostgreSQL: a dedicated shared worker can serve and heartbeat while retaining its ownership connection',{skip:!process.env.TEST_DATABASE_URL,timeout:45000},async t=>{
 const plan=require('../config/shared-capacity-100-plan.json');assert.ok(plan.db_pool_size_per_worker>=2,'The ownership lock occupies one connection; queries need another');
 assert.equal(plan.application_pool_ceiling_after,plan.personal_worker_pool_ceiling+plan.api_db_pool_size+plan.worker_count*plan.db_pool_size_per_worker);assert.ok(plan.application_pool_ceiling_after<=95);
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_shared_runtime_'+randomUUID().replaceAll('-',''),group='synthetic-'+randomUUID().slice(0,8),secret='synthetic-runtime-secret-thirty-two-chars';
 await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'wa-shared-runtime-')),db=new Pool({connectionString:url.toString(),max:1});let child,output='';
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(timer);}
  await db.end();await admin.query('DROP DATABASE '+name);await admin.end();await fs.rm(data,{recursive:true,force:true});
 });
 const script="(async()=>{require('./src/startup').validateStartupEnvironment(process.env);await require('./src/db').migrate();const server=await require('./src/worker').start();process.send({port:server.address().port});})().catch(e=>{console.error(e.code||e.name);process.exit(1);});";
 child=spawn(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATABASE_URL:url.toString(),SERVICE_ROLE:'worker',PORT:'0',WORKER_GROUP:group,MAX_ACCOUNTS_PER_WORKER:String(plan.slots_per_worker),DB_POOL_SIZE:String(plan.db_pool_size_per_worker),DATA_DIR:data,INTERNAL_SECRET:secret},stdio:['ignore','pipe','pipe','ipc']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+b.toString()).slice(-2000);});
 const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker failed to start with its configured connection budget: '+output)),15000);child.once('message',value=>{clearTimeout(timer);resolve(value);});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(Error('Worker exited before ready: '+code+' '+output));});});
 const base='http://127.0.0.1:'+ready.port,health=await fetch(base+'/healthz');assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true,role:'worker',group});
 assert.equal((await fetch(base+'/capacity')).status,401);
 const capacity=await fetch(base+'/capacity',{headers:{Authorization:'Bearer '+secret}});assert.equal(capacity.status,200);assert.deepEqual(await capacity.json(),{role:'worker',group,running:0,max_accounts:plan.slots_per_worker});
 let heartbeat;for(let i=0;i<40;i++){heartbeat=(await db.query('SELECT * FROM worker_health WHERE worker_group=$1',[group])).rows[0];if(heartbeat)break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(heartbeat,'Worker must run database work after acquiring its ownership lock');assert.equal(heartbeat.accounts_running,0);assert.equal(heartbeat.max_accounts,plan.slots_per_worker);assert.ok(Date.now()-+heartbeat.heartbeat_at<15000);
 assert.equal((await db.query('SELECT count(*)::int n FROM accounts')).rows[0].n,0);
});
