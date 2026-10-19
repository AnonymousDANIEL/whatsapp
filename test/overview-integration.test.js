'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('PostgreSQL: Owner separates actual senders without rewriting records or leaking other USER data',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_overview_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.toString(),APP_VAULT_KEY:'11'.repeat(32),SERVICE_ROLE:'api',PORT:'0',PUBLIC_URL:'http://localhost:3000',INTERNAL_SECRET:'synthetic-overview-secret-thirty-two-characters',BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'synthetic-owner-password-123',WORKER_ROUTES_JSON:'{"group-a":"http://127.0.0.1:9"}'});
 const db=require('../src/db');let server;
 t.after(async()=>{if(server)await new Promise(r=>server.close(r));await db.pool.end();await admin.query('DROP DATABASE '+name);await admin.end();});
 await db.migrate();server=await require('../src/api').start({connectionMonitorIntervalMs:0});const base='http://127.0.0.1:'+server.address().port;
 async function request(route,session){const r=await fetch(base+'/api'+route,{headers:{Origin:'http://localhost:3000',...(session?{Cookie:session}: {})}});return{status:r.status,data:await r.json()};}
 async function login(username,password){const r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
 const owner=(await db.pool.query("SELECT id FROM users WHERE role='owner'")).rows[0].id,u1=randomUUID(),u2=randomUUID(),u3=randomUUID(),a=randomUUID(),deleted=randomUUID(),shared=randomUUID(),c1=randomUUID(),c2=randomUUID(),c3=randomUUID();
 const password='synthetic-user-password-123',hash=await require('bcryptjs').hash(password,4);
 await db.pool.query(`INSERT INTO users(id,username,password_hash,role,active,locked) VALUES($1,'alpha',$4,'user',true,false),($2,'beta',$4,'user',false,false),($3,'gamma',$4,'user',true,true)`,[u1,u2,u3,hash]);
 await db.pool.query(`INSERT INTO accounts(id,label,worker_group,shared_pool,deleted_at) VALUES($1,'Assigned personal','group-a',false,NULL),($2,'Deleted','group-a',false,now()),($3,'Shared','group-a',true,NULL)`,[a,deleted,shared]);
 await db.pool.query('INSERT INTO account_grants(user_id,account_id) VALUES($1,$3),($2,$3)',[u1,u2,a]);
 for(const [id,actor,account,isDeleted]of [[c1,u1,a,false],[c2,owner,a,false],[c3,u2,a,true]])await db.pool.query(`INSERT INTO campaigns(id,account_id,created_by,title,body,timezone,window_start,window_end,weekdays,scheduled_at,interval_ms,opt_in_confirmed,deleted_at) VALUES($1,$2,$3,'Synthetic','Synthetic','Asia/Kuala_Lumpur','00:00','23:59',ARRAY[1,2,3,4,5,6,7],now(),10000,true,CASE WHEN $4 THEN now() ELSE NULL END)`,[id,account,actor,isDeleted]);
 await db.pool.query(`INSERT INTO recipients(campaign_id,raw_phone,status,message_id,started_at) VALUES($1,'synthetic','delivered','task-alpha',now()),($1,'synthetic','pending',NULL,NULL),($2,'synthetic','unknown','task-owner',now()),($3,'synthetic','read','deleted-task',now())`,[c1,c2,c3]);
 const today=(await db.pool.query("SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text AS day")).rows[0].day;
 for(const [account,id,actor,status,when,isDeleted]of [[a,'task-alpha',owner,'delivered','now',false],[a,'owner-manual',owner,'submitted','midnight',false],[a,'beta-manual',u2,'failed','previous',false],[a,'external',null,'read','now',false],[a,'removed-history',u1,'read','now',true],[deleted,'removed-account',u1,'read','now',false],[shared,'shared-history',u1,'read','now',false],[a,'deleted-task',owner,'read','now',false]])await db.pool.query(`INSERT INTO message_history(account_id,message_id,actor_id,recipient,body,status,sent_at,deleted_at) VALUES($1,$2,$3,'synthetic','Synthetic',$4,CASE WHEN $5='midnight' THEN $6::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur' WHEN $5='previous' THEN ($6::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')-interval '1 second' ELSE now() END,CASE WHEN $7 THEN now() ELSE NULL END)`,[account,id,actor,status,when,today,isDeleted]);
 const ownerSession=await login('owner','synthetic-owner-password-123'),userSession=await login('alpha',password);
 const snapshotSQL=`SELECT jsonb_build_object('accounts',(SELECT jsonb_agg(a ORDER BY id) FROM accounts a),'campaigns',(SELECT jsonb_agg(c ORDER BY id) FROM campaigns c),'recipients',(SELECT jsonb_agg(r ORDER BY id) FROM recipients r),'history',(SELECT jsonb_agg(m ORDER BY message_id) FROM message_history m),'credits',(SELECT jsonb_agg(jsonb_build_array(id,credit_units,account_limit,active,locked) ORDER BY id) FROM users),'ledger',(SELECT count(*) FROM credit_ledger),'audit',(SELECT count(*) FROM audit)) AS snapshot`;
 const before=await db.pool.query(snapshotSQL);
 assert.equal((await request('/overview?layout=2')).status,401);
 for(const query of ['/overview?layout=2','/overview?layout=2&user_id='+owner])assert.equal((await request(query,userSession)).status,403);
 const r=await request('/overview?layout=2',ownerSession);assert.equal(r.status,200);const data=r.data;
 assert.equal(data.timezone,'Asia/Kuala_Lumpur');assert.equal(data.owner.user.id,owner);assert.deepEqual(data.owner.counts,{unknown:1,submitted:1});
 assert.deepEqual(data.users.find(u=>u.user.id===u1).counts,{pending:1,delivered:1});
 assert.deepEqual(data.users.find(u=>u.user.id===u2).counts,{failed:1});assert.equal(data.users.find(u=>u.user.id===u2).user.active,false);
 assert.deepEqual(data.users.find(u=>u.user.id===u3).counts,{});assert.equal(data.users.find(u=>u.user.id===u3).user.locked,true);
 assert.deepEqual(data.external.counts,{read:1});assert.equal(data.owner.days.at(-1).counts.submitted,1);assert.equal(data.users.find(u=>u.user.id===u2).days.at(-2).counts.failed,1);
 const buckets=[data.owner,...data.users,data.external];for(const b of buckets){assert.equal(b.days.length,7);assert.equal(b.days.at(-1).date,today);if(b.user)assert.deepEqual(Object.keys(b.user).sort(),['active','id','locked','role','username']);}
 const legacy=(await request('/overview',ownerSession)).data,sums={};for(const b of buckets)for(const [k,v]of Object.entries(b.counts))sums[k]=(sums[k]||0)+v;assert.deepEqual(sums,legacy.counts);
 for(let i=0;i<7;i++){const daily={};for(const b of buckets)for(const [k,v]of Object.entries(b.days[i].counts))daily[k]=(daily[k]||0)+v;assert.deepEqual(daily,legacy.days[i].counts);}
 const own=(await request('/overview',userSession)).data;assert.equal(own.owner,undefined);assert.equal(own.users,undefined);assert.equal(own.counts.delivered,1);
 const after=await db.pool.query(snapshotSQL);
 assert.deepEqual(after.rows,before.rows);
});
