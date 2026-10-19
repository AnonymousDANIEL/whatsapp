const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
test('PostgreSQL: private bank receipts, signed feeds, one-time credit and maintenance',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_bank_'+crypto.randomUUID().replaceAll('-','');
 if(!process.env.TEST_SINGLE_DATABASE)await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);if(!process.env.TEST_SINGLE_DATABASE)url.pathname='/'+name;
 Object.assign(process.env,{APP_VAULT_KEY:'22'.repeat(32),DATABASE_URL:url.toString(),SERVICE_ROLE:'api',PORT:'0',PUBLIC_URL:'http://localhost:3000',INTERNAL_SECRET:'test-internal-secret-thirty-two-characters',BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'test-bank-owner-password-123',WORKER_ROUTES_JSON:'{"group-a":"http://127.0.0.1:9"}'});
 const db=require('../src/db'),v=require('../src/bank-domain');let server;t.after(async()=>{if(server)await new Promise(r=>server.close(r));await db.pool.end();if(!process.env.TEST_SINGLE_DATABASE)await admin.query('DROP DATABASE '+name);await admin.end();});
 await db.migrate();server=await require('../src/api').start({connectionMonitorIntervalMs:0});const base='http://127.0.0.1:'+server.address().port;
 async function req(path,method='GET',body=null,s=null,extra={}){const r=await fetch(base+'/api'+path,{method,headers:{Origin:'http://localhost:3000','Content-Type':'application/json',...(s?{Cookie:s.cookie,'X-CSRF-Token':s.csrf}:{}),...extra},...(body!==null?{body:JSON.stringify(body)}:{})});const type=r.headers.get('content-type');return{status:r.status,data:type?.includes('json')?await r.json():Buffer.from(await r.arrayBuffer()),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 async function login(name,password){const r=await req('/login','POST',{username:name,password});assert.equal(r.status,200);const s={cookie:r.cookie};s.csrf=(await req('/me','GET',null,s)).data.csrf;return s;}
 const owner=await login('owner','test-bank-owner-password-123'),people=[];
 for(let i=0;i<6;i++){const username='bankuser'+i,password='test-bank-user-password-123',id=(await req('/users','POST',{username,password,active:true},owner)).data.id;people.push({id,s:await login(username,password)});}
 const key='test-only-bank-feed-key-1234567890',config={bank_name:'Test bank',account_name:'Test merchant',account_number:'1234567890',remark:'Owner private',display_order:1,status:'active',feed_key:key};
 const bankId=(await req('/banks','POST',config,owner)).data.id;assert.ok(bankId);
 async function create(who=0,amount='10'){const r=await req('/bank-deposits','POST',{bank_id:bankId,amount,request_id:crypto.randomUUID()},people[who].s);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZL1sAAAAASUVORK5CYII=','base64');
 function receipt(n){const bytes=Buffer.concat([png,Buffer.from('test-fixture-'+n)]);return{image:{mimetype:'image/png',data:bytes.toString('base64')},sha:crypto.createHash('sha256').update(bytes).digest('hex')};}
 async function submit(d,n,who=0){const r=receipt(n),out=await req('/bank-deposits/'+d.id+'/receipt','POST',{receipt:r.image},people[who].s);assert.equal(out.status,200,JSON.stringify(out.data));return{...d,sha:r.sha,state:out.data.state};}
 function entry(id,amount=1000,direction='in'){return{id,direction,amount_cents:amount,status:'posted',occurred_at:new Date().toISOString(),description:'Synthetic bank fixture',reference:'fixture-'+id};}
 function decision(d,status='matched',transaction_id='first'){return{deposit_id:d.id,receipt_sha256:d.sha,status,transaction_id};}
 function payload(transactions=[],decisions=[],maintenance=false){return{version:1,live:true,event_id:crypto.randomUUID(),account_number:config.account_number,maintenance,transactions,decisions};}
 async function feed(body,override={}){const bytes=Buffer.from(JSON.stringify(body)),ts=String(Math.floor(Date.now()/1000));return req('/banks/feed/'+bankId,'POST',body,null,{'x-bank-timestamp':ts,'x-bank-signature':v.sign(ts,bankId,bytes,key),...override});}
 const balance=async who=>Number((await req('/billing','GET',null,people[who].s)).data.user.credit_units);
 await t.test('bank off hides details; USER cannot manage banks, feeds or other users',async()=>{
  assert.equal((await req('/banks/'+bankId,'PATCH',{...config,qr:receipt(0).image},owner)).status,200);assert.equal((await req('/banks/'+bankId+'/qr','GET',null,people[0].s)).status,403);assert.equal((await req('/banks/'+bankId+'/qr','GET',null,owner)).status,200);
  const duplicate=await req('/banks','POST',{...config,account_number:'123 456 7890'},owner);assert.equal(duplicate.status,409);assert.equal(duplicate.data.error,'Bank account already exists');
  assert.deepEqual((await req('/banks','GET',null,people[0].s)).data,{enabled:false,banks:[]});assert.equal((await req('/bank-deposits','POST',{bank_id:bankId,amount:'10',request_id:crypto.randomUUID()},people[0].s)).status,503);
  for(const [path,method,body] of [['/banks','POST',config],['/banks/'+bankId,'PATCH',config],['/banks/settings','PUT',{enabled:true}],['/bank-transactions','GET',null],['/banks/'+bankId+'/transactions','POST',{}]])assert.equal((await req(path,method,body,people[0].s)).status,403);
  assert.equal((await req('/banks/settings','PUT',{enabled:true},{...owner,csrf:'wrong'})).status,403);assert.equal((await req('/banks/settings','PUT',{enabled:true},owner)).status,200);
  const b=(await req('/banks','GET',null,people[0].s)).data.banks[0];assert.equal(b.remark,undefined);assert.equal(b.feed_key_cipher,undefined);assert.equal(b.configured,undefined);assert.equal(b.has_qr,true);assert.equal(b.qr,undefined);assert.equal((await req('/banks/'+bankId+'/qr','GET',null,people[0].s)).status,200);const o=(await req('/banks','GET',null,owner)).data.banks[0];assert.equal(o.configured,true);assert.equal(o.feed_key_cipher,undefined);
 });
 let first,second;
 await t.test('receipt submits without credit; private access and duplicate slips',async()=>{
  first=await submit(await create(),1);assert.equal(first.state,'pending');assert.equal(await balance(0),0);
  const img=await req('/bank-deposits/'+first.id+'/receipt','GET',null,people[0].s);assert.equal(img.status,200);assert.equal(img.data.equals(Buffer.from(receipt(1).image.data,'base64')),true);assert.equal((await req('/bank-deposits/'+first.id+'/receipt','GET',null,people[1].s)).status,403);assert.equal((await req('/bank-deposits','GET',null,people[1].s)).data.total,0);
  second=await submit(await create(1),1,1);assert.equal(second.state,'rejected');assert.equal((await req('/bank-deposits','GET',null,people[1].s)).data.rows[0].reason_code,'duplicate_receipt');
  const own=(await req('/bank-deposits','GET',null,people[0].s)).data.rows[0];for(const key of ['username','user_id','receipt_sha256'])assert.equal(own[key],undefined);
  assert.equal((await req('/banks/feed/'+bankId,'POST',payload())).status,403);
  const queuePath='/banks/feed/'+bankId+'/queue',ts=String(Math.floor(Date.now()/1000));const queue=await req(queuePath,'GET',null,null,{'x-bank-timestamp':ts,'x-bank-signature':v.sign(ts,bankId,Buffer.from('GET /api'+queuePath),key)});assert.equal(queue.status,200);assert.equal(queue.data.deposits[0].receipt_sha256,first.sha);
 });
 await t.test('verified matching entry credits once across concurrent event replays',async()=>{
  const body=payload([entry('first')],[decision(first)]);const result=await Promise.all([feed(body),feed(body)]);for(const r of result)assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(await balance(0),100000);
  assert.equal((await feed(body)).status,200);assert.equal(await balance(0),100000);assert.equal((await db.pool.query('SELECT count(*)::int n FROM credit_ledger WHERE deposit_id=$1',[first.id])).rows[0].n,1);
  const ledger=(await req('/billing','GET',null,people[0].s)).data.ledger;assert.equal(ledger[0].kind,'bank_topup');assert.equal(Number(ledger[0].delta_units),100000);
  assert.equal((await feed({...body,maintenance:true})).status,409);assert.equal((await feed({...payload(),live:false})).status,400);
 });
 await t.test('same transaction, wrong amount and outgoing entries never credit again',async()=>{
  for(const [who,tx,expected] of [[1,entry('first'),'transaction_used'],[2,entry('wrong',999),'amount_mismatch'],[3,entry('out',1000,'out'),'not_incoming']]){const d=await submit(await create(who),10+who,who);const txs=tx.id==='first'?[]:[tx];assert.equal((await feed(payload(txs,[decision(d,'matched',tx.id)]))).status,200);assert.equal(await balance(who),0);assert.equal((await req('/bank-deposits','GET',null,people[who].s)).data.rows[0].reason_code,expected);}
 });
 await t.test('missing entries wait; only a complete closed window permits automatic rejection',async()=>{
  const d=await submit(await create(4),24,4);assert.equal((await feed(payload([],[decision(d,'no_match')]))).status,200);assert.equal((await req('/bank-deposits','GET',null,people[4].s)).data.rows[0].state,'pending');
  await db.pool.query("UPDATE bank_deposits SET created_at=now()-interval '25 hours',expires_at=now()-interval '1 hour' WHERE id=$1",[d.id]);const dates=(await db.pool.query('SELECT created_at,expires_at FROM bank_deposits WHERE id=$1',[d.id])).rows[0];
  const body=payload([],[decision(d,'no_match')]);body.coverage={complete:true,from:new Date(+new Date(dates.created_at)-300000).toISOString(),to:new Date(dates.expires_at).toISOString()};assert.equal((await feed(body)).status,200);assert.equal((await req('/bank-deposits','GET',null,people[4].s)).data.rows[0].state,'rejected');assert.equal(await balance(4),0);
 });
 await t.test('late receipts remain reviewable; a verified invalid slip is visibly rejected',async()=>{
  const d=await create();await db.pool.query("UPDATE bank_deposits SET created_at=now()-interval '25 hours',expires_at=now()-interval '1 hour' WHERE id=$1",[d.id]);const late=await submit(d,90);assert.equal(late.state,'review');assert.equal((await feed(payload([],[decision(late,'invalid')]))).status,200);const row=(await req('/bank-deposits','GET',null,people[0].s)).data.rows.find(r=>r.id===d.id);assert.equal(row.state,'rejected');assert.equal(row.reason_code,'receipt_invalid');assert.equal(await balance(0),100000);
 });
 await t.test('Owner manual review requires a real recorded entry and remains idempotent',async()=>{
  const d=await submit(await create(3),33,3),tx=entry('manual-verified');
  assert.equal((await req('/bank-deposits/'+d.id+'/review','POST',{action:'confirm',confirmed:false,transaction_id:tx.id},owner)).status,400);
  assert.equal((await req('/banks/'+bankId+'/transactions','POST',{transaction_id:tx.id,direction:'in',amount:'10',occurred_at:tx.occurred_at,description:tx.description,reference:tx.reference,confirmed:true},owner)).status,200);
  assert.equal((await feed(payload([],[decision(d,'matched',tx.id)]))).status,409);assert.equal(await balance(3),0);
  const confirm={action:'confirm',confirmed:true,transaction_id:tx.id};for(let i=0;i<2;i++)assert.equal((await req('/bank-deposits/'+d.id+'/review','POST',confirm,owner)).status,200);assert.equal(await balance(3),100000);
  assert.equal((await feed(payload([tx],[decision(d,'matched',tx.id)]))).status,200);assert.equal(await balance(3),100000);
 });
 await t.test('maintenance blocks new deposits; closure keeps previous transfers settleable',async()=>{
  const d=await submit(await create(5),25,5);assert.equal((await feed(payload([],[],true))).status,200);assert.equal((await req('/banks','GET',null,people[0].s)).data.banks[0].status,'maintenance');assert.equal((await req('/bank-deposits','POST',{bank_id:bankId,amount:'10',request_id:crypto.randomUUID()},people[2].s)).status,503);
  await req('/banks/settings','PUT',{enabled:false},owner);assert.deepEqual((await req('/banks','GET',null,people[5].s)).data.banks,[]);
  assert.equal((await feed(payload([entry('closed')],[decision(d,'matched','closed')],true))).status,200);assert.equal(await balance(5),100000);
  await req('/banks/'+bankId,'PATCH',{...config,status:'disabled',feed_key:''},owner);assert.equal((await req('/banks','GET',null,owner)).data.banks[0].status,'disabled');
 });
 await t.test('Owner sees complete IN/OUT, filters and linkage; repeat migration preserves funds',async()=>{
  const r=await req('/bank-transactions?bank_id='+bankId,'GET',null,owner);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.total,5);assert.equal(r.data.rows.filter(t=>t.deposit_id).length,3);assert.equal(Number(r.data.summary.incoming_cents),3999);assert.equal(Number(r.data.summary.outgoing_cents),1000);
  assert.equal((await req('/bank-transactions?direction=out','GET',null,owner)).data.total,1);assert.equal((await req('/bank-transactions?search=wrong','GET',null,owner)).data.total,1);
  await db.pool.query("INSERT INTO bank_transactions(bank_id,transaction_id,direction,amount_cents,occurred_at,description,source) SELECT $1,'paging-'||n,'out',100,now()-interval '3 days','Pagination fixture','owner' FROM generate_series(1,101) n",[bankId]);
  const one=(await req('/bank-transactions?page=1','GET',null,owner)).data,two=(await req('/bank-transactions?page=2','GET',null,owner)).data;assert.equal(one.rows.length,100);assert.equal(two.rows.length,6);assert.equal(one.total,106);assert.equal(new Set([...one.rows,...two.rows].map(t=>t.transaction_id)).size,106);
  const malaysia=s=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(s)).map(p=>[p.type,p.value]));return p.year+'-'+p.month+'-'+p.day;},day=malaysia(r.data.rows[0].occurred_at);assert.equal((await req('/bank-transactions?day='+day,'GET',null,owner)).data.total,r.data.rows.filter(t=>malaysia(t.occurred_at)===day).length);
  const prior=(await db.pool.query("SELECT count(*)::int n,sum(delta_units)::bigint total FROM credit_ledger WHERE kind='bank_topup'")).rows[0];await db.migrate();const after=(await db.pool.query("SELECT count(*)::int n,sum(delta_units)::bigint total FROM credit_ledger WHERE kind='bank_topup'")).rows[0];assert.deepEqual(after,prior);assert.equal(await balance(0),100000);
 });
});
