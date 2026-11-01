'use strict';
const crypto=require('node:crypto'),path=require('node:path'),express=require('express');
const {rateLimit}=require('express-rate-limit');
const {assert}=require('./domain'),vault=require('./secrets'),store=require('./auto-reply-store'),providers=require('./reply-providers');
const {tx,CHANNELS,authorized,joined,allowedSQL,digest}=store;
const uuid=s=>{assert(typeof s==='string'&&/^[a-f\d]{8}-([a-f\d]{4}-){3}[a-f\d]{12}$/i.test(s),'Invalid ID');return s;};
const text=(s,n,blank=true)=>{assert(typeof s==='string'&&s.length<=n&&(blank||s.trim()),'Invalid text');return s.trim();};
function create(pool,{fetcher=fetch,monitorIntervalMs=2000}={}){
 const provider=providers.create({fetcher}),origin=new URL(process.env.PUBLIC_URL).origin;
 const credentials=r=>r.credentials_cipher?JSON.parse(vault.open(r.credentials_cipher,'reply:'+r.id)):{};
 const webhook=r=>origin+'/api/auto-reply/hooks/'+r.id;
 async function own(user,id,c=pool){const r=(await c.query('SELECT * FROM reply_connections WHERE id=$1',[uuid(id)])).rows[0];assert(r&&(r.user_id===user.id||user.role==='owner'),'Connection unavailable',404);return r;}
 async function policy(user,channel,c=pool){assert(CHANNELS.includes(channel),'Invalid channel');if(user.role==='owner')return;const r=(await c.query('SELECT p.enabled AND COALESCE(up.enabled,true) AS allowed FROM reply_policy p LEFT JOIN reply_user_policy up ON up.channel=p.channel AND up.user_id=$1 WHERE p.channel=$2',[user.id,channel])).rows[0];assert(r?.allowed,'Auto reply access is paused',403);}
 function visible(r){return {id:r.id,user_id:r.user_id,channel:r.channel,label:r.label,account_id:r.account_id,remote_id:r.remote_id,enabled:r.enabled,mode:r.mode,keywords:r.keywords,reply_text:r.reply_text,cooldown_seconds:r.cooldown_seconds,verified_at:r.verified_at,last_webhook_at:r.last_webhook_at,configured:!!r.credentials_cipher||['webchat','whatsapp'].includes(r.channel),webhook:!['webchat','whatsapp'].includes(r.channel)?webhook(r):undefined,chat_url:r.channel==='webchat'?origin+'/live-chat.html?channel='+r.id:undefined};}
 async function pauseCampaigns(c,where,args){
   const ids=(await c.query(`UPDATE campaigns SET enabled=false,pause_reason=NULL,operation_at=now() WHERE id IN(SELECT e.campaign_id FROM reply_events e JOIN reply_connections r ON r.id=e.connection_id WHERE e.campaign_id IS NOT NULL AND ${where}) RETURNING id`,args)).rows.map(r=>r.id);
   if(ids.length)await c.query("UPDATE recipients SET status='cancelled',error_code='AUTO_REPLY_PAUSED',updated_at=now() WHERE campaign_id=ANY($1::uuid[]) AND status='pending'",[ids]);
   await c.query(`UPDATE reply_events e SET status='paused',updated_at=now() FROM reply_connections r WHERE r.id=e.connection_id AND ${where} AND (e.status='received' OR (e.status='queued' AND EXISTS(SELECT 1 FROM recipients rec WHERE rec.campaign_id=e.campaign_id AND rec.status='cancelled')))`,args);
  }
 function routes(app,route){
  app.get('/api/auto-reply',route(async(req,res)=>{
   const owner=req.user.role==='owner',rows=(await pool.query('SELECT r.*,u.username,u.active AS user_active,u.locked AS user_locked FROM reply_connections r JOIN users u ON u.id=r.user_id WHERE $1 OR r.user_id=$2 ORDER BY r.created_at DESC LIMIT 200',[owner,req.user.id])).rows;
   const data={connections:rows.map(r=>({...visible(r),...owner?{username:r.username,user_active:r.user_active,user_locked:r.user_locked}:{}})),channels:(await pool.query('SELECT p.channel,p.enabled,p.reason,COALESCE(up.enabled,true) AS user_enabled,COALESCE(up.reason,\'\') AS user_reason FROM reply_policy p LEFT JOIN reply_user_policy up ON up.channel=p.channel AND up.user_id=$1 ORDER BY p.channel',[req.user.id])).rows,
    workers:(await pool.query('SELECT DISTINCT a.id AS account_id FROM accounts a JOIN reply_workers w ON w.worker_group=a.worker_group WHERE w.version=1 AND w.heartbeat_at>now()-interval \'90 seconds\' AND ($1 OR EXISTS(SELECT 1 FROM account_grants g WHERE g.account_id=a.id AND g.user_id=$2)) AND NOT a.shared_pool AND a.enabled AND a.status=\'ready\' AND a.deleted_at IS NULL',[owner,req.user.id])).rows.map(r=>r.account_id)};
   if(owner){data.users=(await pool.query("SELECT id,username,active,locked FROM users WHERE role='user' ORDER BY username LIMIT 500")).rows;data.user_policy=(await pool.query('SELECT * FROM reply_user_policy ORDER BY user_id,channel LIMIT 2500')).rows;}
   res.json(data);
  }));
  app.put('/api/auto-reply/policy',route(async(req,res)=>{
   assert(req.user.role==='owner','Owner only',403);const b=req.body;assert(CHANNELS.includes(b.channel)&&typeof b.enabled==='boolean','Invalid policy');const reason=text(b.reason||'',1000);
   await tx(pool,async c=>{if(b.user_id){uuid(b.user_id);assert((await c.query("SELECT 1 FROM users WHERE id=$1 AND role='user'",[b.user_id])).rowCount,'USER unavailable');await c.query('INSERT INTO reply_user_policy(user_id,channel,enabled,reason) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,channel) DO UPDATE SET enabled=excluded.enabled,reason=excluded.reason',[b.user_id,b.channel,b.enabled,reason]);}
    else await c.query('UPDATE reply_policy SET enabled=$1,reason=$2 WHERE channel=$3',[b.enabled,reason,b.channel]);
    if(!b.enabled)await pauseCampaigns(c,'r.channel=$1'+(b.user_id?' AND r.user_id=$2':''),b.user_id?[b.channel,b.user_id]:[b.channel]);
    else await c.query('UPDATE reply_connections SET activated_at=now() WHERE channel=$1'+(b.user_id?' AND user_id=$2':''),b.user_id?[b.channel,b.user_id]:[b.channel]);
    await c.query("INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,'autoreply.policy',$2,$3)",[req.user.id,b.user_id||null,{channel:b.channel,enabled:b.enabled,reason}]);
   });res.json({ok:true});
  }));
  app.post('/api/auto-reply/connections',route(async(req,res)=>{
   const b=req.body;await policy(req.user,b.channel);const id=crypto.randomUUID(),label=text(b.label,80,false);let account=null;
   await tx(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reply-create:'+req.user.id]);
    assert((await c.query('SELECT count(*)::int n FROM reply_connections WHERE user_id=$1',[req.user.id])).rows[0].n<30,'Maximum 30 connections');
    if(b.channel==='whatsapp'){uuid(b.account_id);account=(await c.query(`SELECT a.id FROM accounts a WHERE a.id=$1 AND NOT shared_pool AND deleted_at IS NULL AND enabled AND ($2='owner' OR EXISTS(SELECT 1 FROM account_grants g WHERE g.account_id=a.id AND g.user_id=$3))`,[b.account_id,req.user.role,req.user.id])).rows[0];assert(account,'WhatsApp account unavailable',403);assert(!(await c.query('SELECT 1 FROM reply_connections WHERE account_id=$1',[account.id])).rowCount,'This WhatsApp account already has an auto reply connection',409);}
    await c.query('INSERT INTO reply_connections(id,user_id,channel,label,account_id,verified_at) VALUES($1,$2,$3,$4,$5,$6)',[id,req.user.id,b.channel,label,account?.id||null,b.channel==='webchat'?new Date():null]);
    await c.query("INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,'autoreply.create',$2,$3)",[req.user.id,id,{channel:b.channel}]);
   });res.status(201).json(visible(await own(req.user,id)));
  }));
  app.put('/api/auto-reply/connections/:id/rule',route(async(req,res)=>{
   const r=await own(req.user,req.params.id),b=req.body;if(b.enabled)await policy(req.user,r.channel);
   assert(typeof b.enabled==='boolean'&&['all','keywords'].includes(b.mode),'Invalid rule');const reply=text(b.reply_text,1000,b.enabled!==true),keywords=b.keywords||[];
   assert(Array.isArray(keywords)&&keywords.length<=30&&keywords.every(k=>typeof k==='string'&&k.trim()&&k.length<=80),'Invalid keywords');assert(b.mode!=='keywords'||keywords.length,'Add a keyword');const cooldown=Number(b.cooldown_seconds);assert(Number.isInteger(cooldown)&&cooldown>=30&&cooldown<=86400,'Reply interval must be 30–86400 seconds');
   if(b.enabled){assert(r.channel==='whatsapp'||r.verified_at,'Connect and verify this channel first',409);if(r.channel==='whatsapp')assert((await pool.query("SELECT 1 FROM accounts a JOIN reply_workers w ON w.worker_group=a.worker_group WHERE a.id=$1 AND w.heartbeat_at>now()-interval '90 seconds' AND a.status='ready' AND a.enabled AND a.deleted_at IS NULL",[r.account_id])).rowCount,'Link WhatsApp and wait for auto reply service readiness',409);}
   await tx(pool,async c=>{await c.query('UPDATE reply_connections SET enabled=$1,mode=$2,keywords=$3,reply_text=$4,cooldown_seconds=$5,activated_at=CASE WHEN NOT enabled AND $1 THEN now() ELSE activated_at END WHERE id=$6',[b.enabled,b.mode,JSON.stringify(keywords.map(k=>k.trim())),reply,cooldown,r.id]);if(!b.enabled)await pauseCampaigns(c,'r.id=$1',[r.id]);await c.query("INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,'autoreply.rule',$2,$3)",[req.user.id,r.id,{enabled:b.enabled,mode:b.mode}]);});res.json({ok:true});
  }));
  app.put('/api/auto-reply/connections/:id/credentials',route(async(req,res)=>{
   const r=await own(req.user,req.params.id);await policy(req.user,r.channel);assert(!['whatsapp','webchat'].includes(r.channel),'No credentials required');
   const c=credentials(r),keys=r.channel==='telegram'?['token']:r.channel==='messenger'?['page_id','access_token','app_secret','verify_token']:['app_id','original_id','verify_token','aes_key'];
   for(const key of keys)if(req.body[key])c[key]=text(req.body[key],2000,false);if(r.channel==='telegram')c.webhook_secret||=crypto.randomBytes(32).toString('hex');providers.validateConfig(r.channel,c);
   const remote=r.channel==='telegram'?c.token.split(':')[0]:r.channel==='messenger'?c.page_id:c.original_id;
   assert(!r.remote_id||r.remote_id===remote,'Create a separate connection for a different channel account',409);
   assert(!(await pool.query('SELECT 1 FROM reply_connections WHERE channel=$1 AND remote_id=$2 AND id<>$3',[r.channel,remote,r.id])).rowCount,'This channel account is already connected',409);
   await pool.query('UPDATE reply_connections SET credentials_cipher=$1,remote_id=$2,verified_at=NULL,enabled=false WHERE id=$3',[vault.seal(JSON.stringify(c),'reply:'+r.id),remote,r.id]);res.json({ok:true,webhook:webhook(r)});
  }));
  app.post('/api/auto-reply/connections/:id/connect',route(async(req,res)=>{
   const r=await own(req.user,req.params.id);await policy(req.user,r.channel);assert(['telegram','messenger','wechat'].includes(r.channel),'No provider connection required');const cfg=credentials(r);
   if(r.channel==='wechat'){providers.validateConfig(r.channel,cfg);return res.json({ok:true,pending_verification:true,webhook:webhook(r)});}
   const remote=await provider.connect(r.channel,cfg,webhook(r));await pool.query('UPDATE reply_connections SET remote_id=$1,verified_at=CASE WHEN channel=\'telegram\' THEN now() ELSE verified_at END WHERE id=$2 AND credentials_cipher=$3',[remote,r.id,r.credentials_cipher]);res.json({ok:true,pending_verification:r.channel==='messenger'});
  }));
  app.get('/api/auto-reply/connections/:id/events',route(async(req,res)=>{const r=await own(req.user,req.params.id);res.json((await pool.query(`SELECT e.id,e.peer,e.body,e.reply_text,e.status,e.error_code,e.created_at,e.updated_at,e.campaign_id,rec.status AS whatsapp_status FROM reply_events e LEFT JOIN LATERAL(SELECT status FROM recipients WHERE campaign_id=e.campaign_id LIMIT 1) rec ON true WHERE e.connection_id=$1 ORDER BY e.created_at DESC LIMIT 100`,[r.id])).rows);}));
  app.get('/api/auto-reply/connections/:id/chats',route(async(req,res)=>{const r=await own(req.user,req.params.id);assert(r.channel==='webchat','Web chat only');res.json((await pool.query('SELECT id,visitor_id,direction,body,created_at FROM reply_web_messages WHERE connection_id=$1 ORDER BY created_at DESC LIMIT 200',[r.id])).rows);}));
  app.post('/api/auto-reply/connections/:id/reply',route(async(req,res)=>{
   const r=await own(req.user,req.params.id);await policy(req.user,r.channel);assert(r.channel==='webchat','Use auto reply for this channel');const b=req.body,body=text(b.body,1000,false);uuid(b.visitor_id);uuid(b.request_id);
   await tx(pool,async c=>{assert(await authorized(c,r.id,true),'Channel paused',403);assert((await c.query('SELECT 1 FROM reply_visitors WHERE id=$1 AND connection_id=$2 AND expires_at>now()',[b.visitor_id,r.id])).rowCount,'Visitor session expired',404);const prior=(await c.query("SELECT body FROM reply_web_messages WHERE visitor_id=$1 AND request_id=$2 AND direction='out'",[b.visitor_id,b.request_id])).rows[0];assert(!prior||prior.body===body,'Request changed',409);await c.query("INSERT INTO reply_web_messages(id,connection_id,visitor_id,request_id,direction,body,actor_id) VALUES($1,$2,$3,$4,'out',$5,$6) ON CONFLICT DO NOTHING",[crypto.randomUUID(),r.id,b.visitor_id,b.request_id,body,req.user.id]);});res.json({ok:true});
  }));
 }
 async function channel(req){const r=(await pool.query('SELECT * FROM reply_connections WHERE id=$1',[uuid(req.params.id)])).rows[0];assert(r?.credentials_cipher,'Channel unavailable',404);return r;}
 async function verified(r){await pool.query('UPDATE reply_connections SET verified_at=now() WHERE id=$1 AND credentials_cipher=$2',[r.id,r.credentials_cipher]);}
 function publicRoutes(app,route){
  const publicLimit=rateLimit({windowMs:60000,limit:120,standardHeaders:false,legacyHeaders:false});
  const sessionLimit=rateLimit({windowMs:3600000,limit:30,standardHeaders:false,legacyHeaders:false});
  app.get('/live-chat.html',(req,res)=>{res.removeHeader('X-Frame-Options');res.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors *; object-src 'none'; base-uri 'none'");res.set('Cache-Control','no-store');res.sendFile(path.join(__dirname,'../public/live-chat.html'));});
  app.get('/api/auto-reply/hooks/:id',publicLimit,route(async(req,res)=>{
   const r=await channel(req),c=credentials(r),q=req.query;
   if(r.channel==='messenger'){assert(q['hub.mode']==='subscribe'&&providers.equal(q['hub.verify_token'],c.verify_token),'Invalid verification',403);assert(typeof q['hub.challenge']==='string'&&q['hub.challenge'].length<=300,'Invalid challenge');await verified(r);return res.type('text').send(q['hub.challenge']);}
   assert(r.channel==='wechat','Invalid channel');assert(typeof q.timestamp==='string'&&typeof q.nonce==='string'&&q.nonce.length<=128&&Math.abs(Date.now()/1000-Number(q.timestamp))<300,'Expired verification',403);
   if(q.encrypt_type==='aes'){assert(providers.equal(q.msg_signature,providers.signature(c.verify_token,q.timestamp,q.nonce,q.echostr)),'Invalid signature',403);const challenge=providers.wxDecrypt(q.echostr,c);await verified(r);return res.type('text').send(challenge);}
   assert(providers.equal(q.signature,providers.signature(c.verify_token,q.timestamp,q.nonce)),'Invalid signature',403);assert(typeof q.echostr==='string'&&q.echostr.length<=300,'Invalid challenge');await verified(r);res.type('text').send(q.echostr);
  }));
  app.post('/api/auto-reply/hooks/:id',publicLimit,express.raw({type:()=>true,limit:'64kb'}),route(async(req,res)=>{
   const r=await channel(req),c=credentials(r),raw=req.body;assert(Buffer.isBuffer(raw),'Invalid body');
   if(r.channel==='telegram'){
    assert(providers.equal(req.headers['x-telegram-bot-api-secret-token'],c.webhook_secret),'Invalid webhook',403);let b;try{b=JSON.parse(raw);}catch{assert(false,'Invalid JSON');}
    const m=b.message;if(m?.chat?.type==='private'&&!m.from?.is_bot&&Number.isSafeInteger(b.update_id)&&Number.isSafeInteger(m.chat.id)&&typeof m.text==='string')await store.ingest(pool,r.id,{id:String(b.update_id),peer:String(m.chat.id),text:m.text,time:Number(m.date)*1000});return res.json({ok:true});
   }
   if(r.channel==='messenger'){
    assert(providers.equal(req.headers['x-hub-signature-256'],'sha256='+crypto.createHmac('sha256',c.app_secret).update(raw).digest('hex')),'Invalid signature',403);let b;try{b=JSON.parse(raw);}catch{assert(false,'Invalid JSON');}
    if(b.object==='page'&&Array.isArray(b.entry)&&b.entry.length<=30)for(const entry of b.entry){if(entry.id!==r.remote_id||!Array.isArray(entry.messaging))continue;for(const m of entry.messaging.slice(0,50))if(!m.message?.is_echo&&m.recipient?.id===r.remote_id&&/^\d{1,30}$/.test(m.sender?.id||'')&&typeof m.message?.text==='string')await store.ingest(pool,r.id,{id:m.message.mid,peer:m.sender.id,text:m.message.text,time:Number(m.timestamp)});}
    return res.type('text').send('EVENT_RECEIVED');
   }
   assert(r.channel==='wechat','Invalid channel');const q=req.query;assert(q.encrypt_type==='aes'&&typeof q.timestamp==='string'&&typeof q.nonce==='string'&&q.nonce.length<=128&&Math.abs(Date.now()/1000-Number(q.timestamp))<300,'Use secure encrypted mode',403);
   const outer=providers.xmlFields(raw.toString('utf8'));assert(providers.equal(q.msg_signature,providers.signature(c.verify_token,q.timestamp,q.nonce,outer.Encrypt)),'Invalid signature',403);
   const m=providers.xmlFields(providers.wxDecrypt(outer.Encrypt,c));assert(m.ToUserName===r.remote_id,'Invalid recipient',403);
   if(m.MsgType!=='text')return res.type('text').send('success');const event=await store.ingest(pool,r.id,{id:m.MsgId,peer:m.FromUserName,text:m.Content,time:Number(m.CreateTime)*1000},{passive:true});
   if(!event?.reply_text)return res.type('text').send('success');res.type('application/xml').send(providers.wxEncrypt(providers.wxReply(m.FromUserName,m.ToUserName,event.reply_text),c));
  }));
  const chatAuth=route(async(req,res)=>{const token=String(req.headers.authorization||'').replace(/^Bearer /,'');assert(/^[a-f0-9]{64}$/.test(token),'Visitor token required',401);const v=(await pool.query('SELECT * FROM reply_visitors WHERE token_hash=$1 AND connection_id=$2 AND expires_at>now()',[digest(token),uuid(req.params.id)])).rows[0];assert(v,'Visitor session expired',401);req.visitor=v;});
  // Express middleware needs next after the promise-based authentication check.
  const authenticate=(req,res,next)=>Promise.resolve(chatAuth(req,res,next)).then(()=>{if(req.visitor)next();}).catch(next);
  app.post('/api/auto-reply/chat/:id/session',sessionLimit,express.json({limit:'4kb'}),route(async(req,res)=>{
   const id=uuid(req.params.id),r=await authorized(pool,id);assert(r?.channel==='webchat','Chat temporarily unavailable',503);
   const token=crypto.randomBytes(32).toString('hex'),visitor=crypto.randomUUID();await pool.query("INSERT INTO reply_visitors(id,connection_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')",[visitor,id,digest(token)]);res.json({token,visitor_id:visitor,label:r.label});
  }));
  app.get('/api/auto-reply/chat/:id/messages',publicLimit,authenticate,route(async(req,res)=>{
   const available=!!await authorized(pool,req.params.id);res.json({available,messages:(await pool.query('SELECT id,direction,body,created_at FROM reply_web_messages WHERE visitor_id=$1 ORDER BY created_at DESC LIMIT 100',[req.visitor.id])).rows.reverse()});
  }));
  app.post('/api/auto-reply/chat/:id/messages',publicLimit,authenticate,express.json({limit:'8kb'}),route(async(req,res)=>{
   const body=text(req.body.body,2000,false),request=uuid(req.body.request_id),v=req.visitor,r=await authorized(pool,v.connection_id);assert(r,'Chat temporarily unavailable',503);
   const prior=(await pool.query("SELECT body FROM reply_web_messages WHERE visitor_id=$1 AND request_id=$2 AND direction='in'",[v.id,request])).rows[0];assert(!prior||prior.body===body,'Request changed',409);
   await pool.query("INSERT INTO reply_web_messages(id,connection_id,visitor_id,request_id,direction,body) VALUES($1,$2,$3,$4,'in',$5) ON CONFLICT DO NOTHING",[crypto.randomUUID(),r.id,v.id,request,body]);
   const existing=(await pool.query('SELECT provider_at FROM reply_events WHERE connection_id=$1 AND provider_id=$2',[r.id,request])).rows[0];
   const event=await store.ingest(pool,r.id,{id:request,peer:v.id,text:body,time:existing?+new Date(existing.provider_at):Date.now()},{passive:true});
   if(event?.reply_text)await pool.query("INSERT INTO reply_web_messages(id,connection_id,visitor_id,request_id,direction,body) VALUES($1,$2,$3,$4,'out',$5) ON CONFLICT DO NOTHING",[crypto.randomUUID(),r.id,v.id,request,event.reply_text]);res.json({ok:true});
  }));
 }
 async function processOne(){
  const item=await tx(pool,async c=>{
   const event=(await c.query("SELECT * FROM reply_events WHERE status='received' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];if(!event)return;
   const r=await authorized(c,event.connection_id);if(!r||+new Date(event.provider_at)<Date.now()-5*60000){await c.query("UPDATE reply_events SET status='paused',updated_at=now() WHERE id=$1",[event.id]);return;}
   if(r.channel==='whatsapp'){
    const a=(await c.query("SELECT a.id FROM accounts a JOIN worker_health h ON h.worker_group=a.worker_group WHERE a.id=$1 AND a.status='ready' AND h.heartbeat_at>now()-interval '90 seconds'",[r.account_id])).rows[0];
    if(!a){await c.query("UPDATE reply_events SET status='failed',error_code='WHATSAPP_NOT_CONNECTED',updated_at=now() WHERE id=$1",[event.id]);return;}
    const id=crypto.randomUUID();await c.query(`INSERT INTO campaigns(id,account_id,created_by,title,body,timezone,window_start,window_end,weekdays,scheduled_at,expires_at,interval_ms,opt_in_confirmed,send_now,batch_size) VALUES($1,$2,$3,$4,$5,'Asia/Kuala_Lumpur','00:00','00:00',ARRAY[1,2,3,4,5,6,7],now(),$6,10000,true,false,1)`,[id,a.id,r.user_id,'Auto reply '+event.id,event.reply_text,new Date(+new Date(event.provider_at)+5*60000)]);
    await c.query("INSERT INTO recipients(campaign_id,raw_phone,phone,status) VALUES($1,$2,$2,'pending')",[id,event.peer]);await c.query("UPDATE reply_events SET status='queued',campaign_id=$1,updated_at=now() WHERE id=$2",[id,event.id]);return;
   }
   if(!['telegram','messenger'].includes(r.channel))return;
   await c.query("UPDATE reply_events SET status='sending',updated_at=now() WHERE id=$1",[event.id]);return {event,r};
  });
  if(!item)return;const {event,r}=item;
  try{if(!await authorized(pool,r.id)){await pool.query("UPDATE reply_events SET status='paused',updated_at=now() WHERE id=$1",[event.id]);return;}
   const id=await provider.send(r.channel,credentials(r),event.peer,event.reply_text);await pool.query("UPDATE reply_events SET status='submitted',provider_reply_id=$1,updated_at=now() WHERE id=$2 AND status='sending'",[id,event.id]);
  }catch(e){await pool.query("UPDATE reply_events SET status=$1,error_code=$2,updated_at=now() WHERE id=$3 AND status='sending'",[e.code==='REPLY_REJECTED'?'failed':'unknown',e.code==='REPLY_REJECTED'?'REPLY_REJECTED':'REPLY_UNKNOWN',event.id]);}
 }
 async function expireQueued(){
  await tx(pool,async c=>{
   const ids=(await c.query("UPDATE campaigns c SET enabled=false,pause_reason=NULL,operation_at=now() FROM reply_events e WHERE e.campaign_id=c.id AND e.status='queued' AND c.expires_at<now() AND EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=c.id AND r.status='pending') RETURNING c.id")).rows.map(r=>r.id);
   if(!ids.length)return;
   await c.query("UPDATE recipients SET status='cancelled',error_code='AUTO_REPLY_EXPIRED',updated_at=now() WHERE campaign_id=ANY($1::uuid[]) AND status='pending'",[ids]);
   await c.query("UPDATE reply_events SET status='paused',error_code='AUTO_REPLY_EXPIRED',updated_at=now() WHERE campaign_id=ANY($1::uuid[]) AND status='queued' AND EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=reply_events.campaign_id AND r.status='cancelled')",[ids]);
  });
 }
 function monitor(){if(monitorIntervalMs<=0)return()=>{};let busy=false;const tick=async()=>{if(busy)return;busy=true;try{await expireQueued();await pool.query("UPDATE reply_events SET status='unknown',error_code='REPLY_INTERRUPTED',updated_at=now() WHERE status='sending' AND updated_at<now()-interval '1 minute'");for(let i=0;i<8;i++)await processOne();}catch(e){console.error('Auto reply queue:',e.code||e.name);}finally{busy=false;}};const timer=setInterval(tick,monitorIntervalMs);timer.unref();return()=>clearInterval(timer);}
 return {routes,publicRoutes,monitor,processOne,expireQueued};
}
module.exports={create,ensure:store.ensure};
