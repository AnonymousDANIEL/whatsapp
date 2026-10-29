'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
test('PostgreSQL: official Cloud onboarding, signed chat receipts and protected QR data',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {Pool}=require('pg'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}),name='wa_cloud_'+crypto.randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 Object.assign(process.env,{DATABASE_URL:url.href,SERVICE_ROLE:'api',DB_POOL_SIZE:'8',PORT:'0',PUBLIC_URL:'http://localhost:3000',INTERNAL_SECRET:'synthetic-internal-only',APP_VAULT_KEY:'ce'.repeat(32),BOOTSTRAP_USERNAME:'owner',BOOTSTRAP_PASSWORD:'synthetic-owner-password-123',WORKER_ROUTES_JSON:'{"fixture":"http://127.0.0.1:9"}'});
 const db=require('../src/db'),cloud=require('../src/cloud-business'),vault=require('../src/secrets'),{hash}=require('../src/domain');let server;
 t.after(async()=>{if(server)await new Promise(r=>server.close(r));await db.pool.end();await admin.query('DROP DATABASE '+name);await admin.end();});await db.migrate();await Promise.all([cloud.ensure(db.pool),cloud.ensure(db.pool)]);
 const ownerId=(await db.pool.query("SELECT id FROM users WHERE role='owner'")).rows[0].id,userId=crypto.randomUUID(),qr=crypto.randomUUID();
 await db.pool.query("INSERT INTO users(id,username,password_hash,role,permissions,credit_units) SELECT $1,'cloud-user',password_hash,'user','{}',1234567 FROM users WHERE id=$2",[userId,ownerId]);
 await db.pool.query("INSERT INTO accounts(id,label,worker_group,phone,status) VALUES($1,'retained QR','fixture','60123456788','ready')",[qr]);
 await db.pool.query("INSERT INTO accounts(id,label,worker_group,registration_phone,shared_pool) VALUES($1,'retained shared QR','fixture','+60123456787',true)",[crypto.randomUUID()]);
 const session=async id=>{const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomUUID();await db.pool.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[hash(token),id,csrf]);return{cookie:'wa_session='+token,csrf};};const owner=await session(ownerId),user=await session(userId);
 const cfg={app_id:'123456789',config_id:'234567890',app_secret:'synthetic-secret-never-return',verify_token:'synthetic-webhook-verify-token-123',enabled:true};
 const pid='345678901',waba='456789012',apiToken='synthetic-access-token-1234567890',calls=[];let registered=false,verified=true,failSend=null,nameApproved=false,providerName='Synthetic Shop',statusOverride=null,sequence=0;
 const graph=async(u,o)=>{const p=u.pathname.replace('/v26.0/',''),b=o.body&&!Buffer.isBuffer(o.body)?JSON.parse(o.body):null;calls.push({p,b,method:o.method,params:Object.fromEntries(u.searchParams),headers:o.headers});let d={success:true};
  assert.equal(u.origin,'https://graph.facebook.com');
  const phone=()=>({id:pid,display_phone_number:'+60123456789',verified_name:providerName,code_verification_status:verified?'VERIFIED':'NOT_VERIFIED',status:statusOverride||(registered?'CONNECTED':'PENDING'),platform_type:'CLOUD_API'});
  if(p==='oauth/access_token')d={access_token:apiToken};else if(p==='debug_token')d={data:{is_valid:true,app_id:cfg.app_id,scopes:['whatsapp_business_management','whatsapp_business_messaging']}};
  else if(p===waba+'/phone_numbers')d={data:[phone()]};else if(p===pid&&u.searchParams.get('fields')==='new_display_name,new_name_status')d={new_display_name:'Updated Shop',new_name_status:nameApproved?'APPROVED':'PENDING_REVIEW'};
  else if(p===pid&&o.method==='GET')d=phone();else if(p===pid+'/register'){registered=true;if(nameApproved)providerName='Updated Shop';}
  else if(p===pid+'/verify_code'){if(b.code!=='123456')return new Response(JSON.stringify({error:{code:133005,message:'synthetic-code-secret'}}),{status:400});verified=true;}
  else if(p===pid+'/whatsapp_business_profile'&&o.method==='GET')d={data:[{vertical:'RETAIL',description:'Fixture',websites:[]}]};
  else if(p===cfg.app_id+'/uploads')d={id:'upload:synthetic-session'};else if(p==='upload:synthetic-session'){assert.equal(o.headers.Authorization,'OAuth '+apiToken);d={h:'synthetic-photo-handle'};}
  else if(p===waba+'/message_templates')d={data:[{id:'567890123',name:'welcome',language:'en_US',status:'APPROVED',components:[{type:'BODY',text:'Hello {{1}}'}]},{id:'999999999',name:'not_approved',language:'en_US',status:'PENDING',components:[{type:'BODY',text:'no'}]}]};
  else if(p===pid+'/messages'){if(failSend==='timeout')throw Error('synthetic-network-secret');if(failSend==='reject')return new Response(JSON.stringify({error:{code:131026,message:'synthetic-reject'}}),{status:400});d={messages:[{id:'wamid.synthetic.'+(++sequence)}]};}
  return new Response(JSON.stringify(d));
 };
 server=await require('../src/api').start({connectionMonitorIntervalMs:0,refundMonitorIntervalMs:0,loginMonitorIntervalMs:0,cloudOptions:{fetcher:graph,writeLimitPerMinute:300}});const base='http://127.0.0.1:'+server.address().port;
 async function request(p,method='GET',b,auth=owner,headers={}){const r=await fetch(base+p,{method,redirect:'manual',headers:{...(auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{}),origin:'http://localhost:3000','content-type':'application/json',...headers},body:b===undefined?undefined:typeof b==='string'?b:JSON.stringify(b)});const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:r.status,data,headers:r.headers};}
 const api=(p,method,b,auth,headers)=>request('/api/cloud'+p,method,b,auth,headers);
 let a,sid;
 const retained=async()=>({accounts:(await db.pool.query('SELECT * FROM accounts ORDER BY id')).rows,users:(await db.pool.query('SELECT id,credit_units,password_hash FROM users ORDER BY id')).rows,sessions:(await db.pool.query('SELECT token_hash FROM sessions ORDER BY token_hash')).rows,ledger:(await db.pool.query('SELECT * FROM credit_ledger')).rows});const before=await retained();
 await t.test('Owner boundary, private config, canonical host and CSRF protect every new route',async()=>{
  assert.equal((await api('',undefined,undefined,null)).status,401);assert.equal((await api('',undefined,undefined,user)).status,403);assert.equal((await api('/settings','PUT',cfg,owner,{'x-csrf-token':'wrong'})).status,403);
  const initial=await api('');assert.equal(initial.data.settings.configured,false);assert.equal(initial.data.settings.account_limit,10);
  assert.equal((await request('/cloud-signup.html','GET',undefined,null)).status,401);assert.equal((await request('/cloud-signup.html','GET',undefined,user)).status,403);
  const p=await request('/cloud-signup.html');assert.equal(p.status,200);assert.match(p.headers.get('content-security-policy'),/connect.facebook.net/);assert.equal(p.headers.get('cache-control'),'no-store');const main=await request('/');assert.doesNotMatch(main.headers.get('content-security-policy'),/facebook/);
  assert.equal((await api('/settings','PUT',cfg)).status,200);const saved=await api('');assert.equal(saved.data.settings.secret_set,true);assert.equal(JSON.stringify(saved).includes(cfg.app_secret),false);assert.equal(JSON.stringify(saved).includes(cfg.verify_token),false);
  const stored=(await db.pool.query('SELECT * FROM cloud_settings')).rows[0];assert.notEqual(stored.app_secret_cipher,cfg.app_secret);assert.equal(vault.open(stored.app_secret_cipher,'cloud:app-secret'),cfg.app_secret);
 });
 await t.test('New number drafts protect the QR identity; OTP is never fabricated',async()=>{
  assert.equal((await api('/accounts','POST',{phone:'+60123456788',business_name:'Conflict',category:'OTHER'})).status,409);
  assert.equal((await api('/accounts','POST',{phone:'+60123456787',business_name:'Reserved shared conflict',category:'OTHER'})).status,409);
  const r=await api('/accounts','POST',{phone:'+60123456789',business_name:'Synthetic Shop',category:'RETAIL'});assert.equal(r.status,201);a=r.data;assert.equal(a.status,'unregistered');assert.equal(a.phone_number_id,null);assert.equal(calls.length,0);
  assert.equal((await api('/accounts/'+a.id+'/signup','POST',{},user)).status,403);
  const r2=await api('/accounts/'+a.id+'/signup','POST',{});assert.equal(r2.status,200);sid=r2.data;
  const expired=await api('/signup/exchange','POST',{session_id:sid.session_id,nonce:'forged',code:'synthetic'});assert.equal(expired.status,409);assert.equal(calls.length,0);
 });
 await t.test('Meta code exchange is one-use, encrypted and binds session, app, WABA and exact phone',async()=>{
  assert.equal((await api('/signup/exchange','POST',{...sid,code:'synthetic-code'})).status,200);assert.equal((await api('/signup/exchange','POST',{...sid,code:'synthetic-code'})).status,409);
  assert.equal((await api('/signup/complete','POST',{...sid,event:'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',phone_number_id:pid,waba_id:waba})).status,409);
  assert.equal((await api('/signup/complete','POST',{...sid,event:'FINISH',phone_number_id:'999999999',waba_id:waba})).status,403);
  const good=await api('/signup/complete','POST',{...sid,event:'FINISH',phone_number_id:pid,waba_id:waba});assert.equal(good.status,200);assert.equal(good.data.status,'pending');assert.equal(good.data.code_verified,true);assert.equal(good.data.token_cipher,undefined);
  const row=(await db.pool.query('SELECT * FROM cloud_accounts WHERE id=$1',[a.id])).rows[0];assert.equal(vault.open(row.token_cipher,'cloud:account:'+a.id),apiToken);assert.ok(!(await db.pool.query('SELECT token_cipher FROM cloud_signup_sessions WHERE id=$1',[sid.session_id])).rows[0].token_cipher);
 });
 await t.test('Official SMS/voice, verify and registration APIs are required before active messaging',async()=>{
  verified=false;await api('/accounts/'+a.id+'/sync','POST',{});
  assert.equal((await api('/accounts/'+a.id+'/request-code','POST',{method:'SMS'})).status,200);assert.equal((await api('/accounts/'+a.id+'/request-code','POST',{method:'VOICE'})).status,429);await db.pool.query("UPDATE cloud_accounts SET otp_requested_at=now()-interval '2 minutes' WHERE id=$1",[a.id]);assert.equal((await api('/accounts/'+a.id+'/request-code','POST',{method:'VOICE'})).status,200);
  assert.equal((await api('/accounts/'+a.id+'/verify-code','POST',{code:'654321'})).status,502);assert.equal((await api('/accounts/'+a.id+'/verify-code','POST',{code:'123456'})).status,200);
  const registered=await api('/accounts/'+a.id+'/register','POST',{pin:'654321'});assert.equal(registered.status,200);assert.equal(registered.data.status,'active');assert.equal(registered.data.subscribed,true);assert.ok(calls.some(c=>c.p===waba+'/subscribed_apps'));assert.ok(calls.some(c=>c.p===pid+'/register'&&c.b.pin==='654321'));
  assert.ok(calls.some(c=>c.p.endsWith('request_code')&&c.b.code_method==='VOICE'));
 });
 const hook=(value,field='messages',w=waba)=>({object:'whatsapp_business_account',entry:[{id:w,changes:[{field,value:{metadata:{phone_number_id:pid},...value}}]}]});
 async function webhook(b,valid=true){const raw=JSON.stringify(b),sig='sha256='+crypto.createHmac('sha256',cfg.app_secret).update(valid?raw:'forged').digest('hex');return api('/webhook','POST',raw,null,{'x-hub-signature-256':sig});}
 await t.test('Webhook verification and exact signature, scoped incoming chat and duplicate delivery handling',async()=>{
  assert.equal((await api('/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123',undefined,undefined,null)).status,403);
  assert.equal((await api('/webhook?'+new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':cfg.verify_token,'hub.challenge':'123'}),undefined,undefined,null)).status,200);
  const b=hook({messages:[{id:'wamid.incoming',from:'14155552671',type:'text',text:{body:'<script>synthetic</script>'},timestamp:String(Math.floor(Date.now()/1000))}]});
  assert.equal((await webhook(b,false)).status,403);assert.equal((await webhook(b)).status,200);assert.equal((await webhook(b)).status,200);assert.equal((await db.pool.query("SELECT count(*) FROM cloud_messages WHERE direction='in'")).rows[0].count,'1');
  await webhook(hook({messages:[{id:'wamid.foreign',from:'14155552671',type:'text',text:{body:'foreign'},timestamp:String(Math.floor(Date.now()/1000))}]},'messages','999999999'));
  assert.equal((await db.pool.query("SELECT count(*) FROM cloud_messages WHERE direction='in'")).rows[0].count,'1');const chat=await api('/accounts/'+a.id+'/messages?peer=%2B14155552671');assert.equal(chat.data.rows.length,1);assert.ok(chat.data.window_until);
 });
 let outgoing;
 await t.test('24-hour rule, approved templates and idempotent submission never use QR workers or wallets',async()=>{
  const fresh={request_id:crypto.randomUUID(),to:'+60123456780',type:'text',text:'hello',consent:true};assert.equal((await api('/accounts/'+a.id+'/messages','POST',fresh)).status,409);
  const b={...fresh,request_id:crypto.randomUUID(),to:'+14155552671'};const sendsBefore=calls.filter(c=>c.p.endsWith('/messages')).length;const pair=await Promise.all([api('/accounts/'+a.id+'/messages','POST',b),api('/accounts/'+a.id+'/messages','POST',b)]);assert.ok(pair.every(r=>r.status===200||r.status===201));assert.equal(pair[0].data.id,pair[1].data.id);outgoing=pair[0].data.id;assert.equal(calls.filter(c=>c.p.endsWith('/messages')).length,sendsBefore+1);
  assert.equal((await api('/accounts/'+a.id+'/messages','POST',{...b,text:'changed'})).status,409);
  const template={...fresh,request_id:crypto.randomUUID(),type:'template',template:{name:'welcome',language:'en_US',parameters:['Synthetic']}};assert.equal((await api('/accounts/'+a.id+'/messages','POST',template)).status,201);assert.equal((await api('/accounts/'+a.id+'/templates')).data.length,1);
 });
 await t.test('Out-of-order receipts cannot downgrade read or cross phone/recipient boundaries',async()=>{
  const row=(await db.pool.query('SELECT * FROM cloud_messages WHERE id=$1',[outgoing])).rows[0];const st=status=>hook({statuses:[{id:row.provider_id,status,recipient_id:row.peer,biz_opaque_callback_data:row.id}]});
  await webhook(st('read'));await webhook(st('sent'));await webhook(st('failed'));assert.equal((await db.pool.query('SELECT status FROM cloud_messages WHERE id=$1',[row.id])).rows[0].status,'read');
  const forged=st('delivered');forged.entry[0].changes[0].value.statuses[0].recipient_id='60123456780';await webhook(forged);assert.equal((await db.pool.query('SELECT status FROM cloud_messages WHERE id=$1',[row.id])).rows[0].status,'read');
 });
 await t.test('Timeout and explicit rejection remain honest, and identical retry never sends again',async()=>{
  for(const mode of ['timeout','reject']){failSend=mode;const b={request_id:crypto.randomUUID(),to:'+14155552671',type:'text',text:'synthetic '+mode,consent:true};const r=await api('/accounts/'+a.id+'/messages','POST',b);assert.equal(r.data.status,mode==='timeout'?'unknown':'failed');const n=calls.length;assert.equal((await api('/accounts/'+a.id+'/messages','POST',b)).data.id,r.data.id);assert.equal(calls.length,n);}failSend=null;
 });
 await t.test('Profile/category/photo use official APIs; hours stay local; display names require approval',async()=>{
  const b={vertical:'RETAIL',description:'Description',address:'Synthetic address',email:'test@example.invalid',websites:['https://example.invalid'],business_hours:'Mon–Fri 09:00–17:00'};
  assert.equal((await api('/accounts/'+a.id+'/profile','PUT',b)).status,200);assert.equal(calls.at(-1).b.business_hours,undefined);assert.equal((await api('/accounts/'+a.id+'/profile')).data.business_hours,b.business_hours);
  const photo={mimetype:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]).toString('base64')};assert.equal((await api('/accounts/'+a.id+'/photo','POST',{photo})).status,200);assert.equal(calls.at(-1).b.profile_picture_handle,'synthetic-photo-handle');
  assert.equal((await api('/accounts/'+a.id+'/name','POST',{business_name:'Updated Shop'})).status,200);assert.equal((await api('/accounts/'+a.id+'/name/apply','POST',{pin:'654321'})).status,409);nameApproved=true;assert.equal((await api('/accounts/'+a.id+'/name/apply','POST',{pin:'654321'})).data.business_name,'Updated Shop');
 });
 await t.test('Capacity is serialized at ten and feature-off preserves signed receipts and history',async()=>{
  const results=await Promise.all(Array.from({length:12},(_,i)=>api('/accounts','POST',{phone:'+60123456'+String(700+i),business_name:'Synthetic '+i,category:'OTHER'})));assert.equal(results.filter(r=>r.status===201).length,9);assert.equal(results.filter(r=>r.status===409).length,3);assert.equal((await api('')).data.remaining,0);
  assert.equal((await api('/settings','PUT',{...cfg,enabled:false,app_secret:'',verify_token:''})).status,200);assert.equal((await api('/accounts/'+a.id+'/sync','POST',{})).status,503);assert.equal((await webhook(hook({statuses:[]}))).status,200);assert.equal((await api('/accounts/'+a.id+'/chats')).status,200);
  const view=JSON.stringify((await api('')).data);for(const secret of [cfg.app_secret,cfg.verify_token,apiToken,'654321'])assert.equal(view.includes(secret),false);
 });
 assert.deepEqual(await retained(),before);assert.equal((await db.pool.query("SELECT count(*) FROM audit WHERE details::text LIKE '%synthetic-secret%' OR details::text LIKE '%synthetic-access%' ")).rows[0].count,'0');
});
