'use strict';
const {randomUUID}=require('node:crypto');
const {rateLimit}=require('express-rate-limit');
const {pool,transaction}=require('./db');
const {assert,hash,parseRecipients,permission}=require('./domain');
const {validateImage}=require('./media');
const {priceSQL,personalPhoneSQL,connectedSQL,settings,registrationNumbers,inspectClient,linkedPhone}=require('./shared-domain');
const PAGE=50;
function owner(req){assert(req.user.role==='owner','只有 Owner 可以管理共享 WhatsApp',403);}
function pageNumber(value){const n=Number(value)||1;return Math.max(1,Math.min(10000,Math.trunc(n)));}
async function config(db=pool){return (await db.query(`SELECT s.*,${priceSQL} AS current_price_units,
 EXTRACT(hour FROM statement_timestamp() AT TIME ZONE 'Asia/Kuala_Lumpur')::integer AS current_hour FROM shared_settings s WHERE id=1`)).rows[0];}
async function canPay(userId,db=pool){
 const s=await config(db);assert(s.enabled,'共享 WhatsApp 服务已关闭',503);
 const u=(await db.query('SELECT role,active,locked,credit_units FROM users WHERE id=$1',[userId])).rows[0];
 assert(u?.active&&!u.locked,'账号已停用或锁定',403);if(u.role==='owner')return s;
 assert(s.current_price_units!=null,'管理员尚未设置共享消息价格',402);
 assert(Number(u.credit_units)>=Number(s.current_price_units),'余额不足，请联系管理员充值',402);return s;
}
async function chooseAccount(db,excluded=null,groups=null){
 return (await db.query(`SELECT a.id,a.worker_group FROM accounts a WHERE ${connectedSQL}
  AND ($1::uuid IS NULL OR a.id<>$1) AND ($2::text[] IS NULL OR a.worker_group=ANY($2))
  AND NOT EXISTS(SELECT 1 FROM control_leases l WHERE l.account_id=a.id AND l.expires_at>now())
  ORDER BY (SELECT count(*) FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE c.account_id=a.id AND c.enabled
   AND c.deleted_at IS NULL AND NOT c.cancelled AND r.status IN ('pending','sending')),
   a.shared_assigned_at NULLS FIRST,a.created_at,a.id LIMIT 1`,[excluded,groups])).rows[0];
}
async function createTask(user,body,groups){
 assert(permission(user,'tasks.create'),'没有创建任务权限',403);
 assert(typeof body.title==='string'&&body.title.trim().length&&body.title.length<=120,'请输入任务名称');
 const media=validateImage(body.media);
 assert(typeof body.body==='string'&&(body.body.trim().length||media)&&body.body.length<=4000,'请输入消息或上传照片');
 assert(body.opt_in_confirmed===true,'请确认这些联系人同意接收消息');
 assert(/^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(body.request_id||''),'请求 ID 无效');
 const parsed=parseRecipients(body.recipients),digest=hash(JSON.stringify({title:body.title.trim(),body:body.body,media,recipients:parsed.recipients}));
 return transaction(async db=>{
  await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
  await db.query('SELECT pg_advisory_xact_lock(194812735)');
  const old=(await db.query('SELECT id,created_by,shared_request_hash,duplicate_count FROM campaigns WHERE shared_request_id=$1',[body.request_id])).rows[0];
  if(old){assert(old.created_by===user.id&&old.shared_request_hash===digest,'请求 ID 已使用',409);return {id:old.id,count:(await db.query('SELECT count(*)::int n FROM recipients WHERE campaign_id=$1',[old.id])).rows[0].n,duplicates:old.duplicate_count,replayed:true};}
  const s=await canPay(user.id,db);
  if(user.role!=='owner'){
   const queued=(await db.query(`SELECT count(*)::int n FROM campaigns c WHERE c.shared_pool AND c.created_by=$1 AND c.deleted_at IS NULL AND NOT c.cancelled
    AND EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=c.id AND r.status='pending')`,[user.id])).rows[0].n;
   assert(queued<100,'等待任务过多，请先等待现有任务发送完成',429);
  }
  const a=await chooseAccount(db,null,groups);assert(a,'目前没有可用的共享 WhatsApp，请稍后再试',503);
  const id=randomUUID();
  await db.query(`INSERT INTO campaigns(id,account_id,created_by,title,body,timezone,window_start,window_end,weekdays,scheduled_at,interval_ms,opt_in_confirmed,duplicate_count,send_now,media,batch_size,shared_pool,shared_request_id,shared_request_hash)
   VALUES($1,$2,$3,$4,$5,'Asia/Kuala_Lumpur','00:00','00:00',ARRAY[1,2,3,4,5,6,7],now(),$6,true,$7,true,$8,$9,true,$10,$11)`,
   [id,a.id,user.id,body.title.trim(),body.body,s.interval_ms,parsed.duplicates,media,s.batch_size,body.request_id,digest]);
  await db.query(`INSERT INTO recipients(campaign_id,raw_phone,phone,status,error_code)
   SELECT $1,r.raw,r.phone,r.status,r.error FROM jsonb_to_recordset($2::jsonb) AS r(raw text,phone text,status text,error text)`,[id,JSON.stringify(parsed.recipients)]);
  await db.query('UPDATE accounts SET shared_assigned_at=now() WHERE id=$1',[a.id]);
  await db.query("INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,'shared.send',$2,$3)",[user.id,id,{recipients:parsed.recipients.length,duplicates:parsed.duplicates}]);
  return {id,count:parsed.recipients.length,duplicates:parsed.duplicates};
 });
}
async function rebalance(groups=null){
 return transaction(async db=>{
  if(!(await db.query('SELECT pg_try_advisory_xact_lock(194812735) ok')).rows[0].ok)return 0;
  const rows=(await db.query(`SELECT c.id,c.account_id FROM campaigns c JOIN accounts old ON old.id=c.account_id JOIN users u ON u.id=c.created_by
   WHERE c.shared_pool AND c.enabled AND NOT c.cancelled AND c.deleted_at IS NULL AND u.active AND NOT u.locked
   AND EXISTS(SELECT 1 FROM shared_settings WHERE id=1 AND enabled)
   AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=c.account_id AND ${connectedSQL})
   AND EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=c.id AND r.status='pending')
   AND NOT EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=c.id AND r.status IN ('sending','unknown'))
   ORDER BY c.created_at LIMIT 100 FOR UPDATE OF c SKIP LOCKED`)).rows;
  let count=0;
  for(const c of rows){const a=await chooseAccount(db,c.account_id,groups);if(!a)break;
   await db.query('UPDATE campaigns SET account_id=$1 WHERE id=$2',[a.id,c.id]);
   await db.query('UPDATE accounts SET shared_assigned_at=now() WHERE id=$1',[a.id]);count++;
  }return count;
 });
}
async function recoverInterrupted(group){
 return transaction(async db=>{
  await db.query(`UPDATE recipients r SET status='unknown',error_code='WORKER_RESTART_REVIEW_REQUIRED',updated_at=now()
   FROM campaigns c,accounts a WHERE r.campaign_id=c.id AND c.shared_pool AND a.id=COALESCE(r.send_account_id,c.account_id)
   AND a.worker_group=$1 AND r.status='sending'`,[group]);
  return (await db.query(`UPDATE campaigns c SET enabled=false,pause_reason='review' WHERE c.shared_pool
   AND EXISTS(SELECT 1 FROM recipients r JOIN accounts a ON a.id=COALESCE(r.send_account_id,c.account_id)
    WHERE r.campaign_id=c.id AND r.status='unknown' AND a.worker_group=$1) RETURNING c.id`,[group])).rowCount;
 });
}
let checking=false;
async function checkGroup(group,entries){
 if(checking)return;checking=true;
 try{
  const due=(await pool.query(`SELECT id,enabled,status,registration_phone FROM accounts WHERE shared_pool AND enabled AND deleted_at IS NULL AND worker_group=$1
   AND (shared_checked_at IS NULL OR shared_checked_at<date_trunc('hour',now()) OR (enabled AND shared_state IN ('unknown','offline') AND shared_checked_at<now()-interval '1 minute'))`,[group])).rows;
  if(!due.length&&(await pool.query("SELECT 1 FROM shared_health_hourly WHERE worker_group=$1 AND hour_start=date_trunc('hour',now())",[group])).rowCount)return;
  let index=0;
  await Promise.all([0,1].map(async()=>{while(index<due.length){const a=due[index++],entry=entries.get(a.id);
   let result=!a.enabled?'waiting':!entry?(a.status==='capacity_wait'?'waiting':'offline'):await inspectClient(entry);
   const actual=linkedPhone(entry);if(result==='connected'&&(!actual||'+'+actual!==a.registration_phone))result='unknown';
   await pool.query('UPDATE accounts SET shared_state=$1,shared_checked_at=now(),phone=COALESCE($4,phone) WHERE id=$2 AND worker_group=$3',[result,a.id,group,actual]);
  }}));
  await pool.query(`INSERT INTO shared_health_hourly(worker_group,hour_start,total,connected,waiting,offline,unknown)
   SELECT $1,date_trunc('hour',now()),count(*)::int,
    count(*) FILTER(WHERE ${connectedSQL})::int,
    count(*) FILTER(WHERE NOT enabled OR shared_state='waiting')::int,
    count(*) FILTER(WHERE enabled AND shared_state<>'waiting' AND shared_state<>'unknown' AND NOT (${connectedSQL}))::int,
    count(*) FILTER(WHERE enabled AND shared_state='unknown')::int FROM accounts a WHERE shared_pool AND deleted_at IS NULL AND worker_group=$1
   ON CONFLICT(worker_group,hour_start) DO UPDATE SET total=excluded.total,connected=excluded.connected,waiting=excluded.waiting,
    offline=excluded.offline,unknown=excluded.unknown,checked_at=now()`,[group]);
  await pool.query("DELETE FROM shared_health_hourly WHERE hour_start<now()-interval '90 days'");
 }finally{checking=false;}
}
function routes(app,route,uuid,workerRoutes,workerCommand){
 app.get('/api/shared/status',route(async(req,res)=>{
  const s=await config(),summary=(await pool.query(`SELECT count(*)::int total,count(*) FILTER(WHERE ${connectedSQL})::int connected,
   count(*) FILTER(WHERE ${connectedSQL} AND NOT EXISTS(SELECT 1 FROM control_leases l WHERE l.account_id=a.id AND l.expires_at>now()))::int available,
   count(*) FILTER(WHERE NOT enabled OR shared_state='waiting')::int waiting,
   count(*) FILTER(WHERE enabled AND shared_state='unknown')::int unknown FROM accounts a WHERE shared_pool AND deleted_at IS NULL`)).rows[0];
  summary.offline=summary.total-summary.connected-summary.waiting-summary.unknown;
  const data={enabled:s.enabled,configured:s.current_price_units!=null,summary,timezone:'Asia/Kuala_Lumpur'};
  // Keep already-open older pages accurate until refreshed; the current layout omits wallet data.
  if(req.query.layout!=='2')data.balance_units=(await pool.query('SELECT credit_units FROM users WHERE id=$1',[req.user.id])).rows[0].credit_units;
  if(req.user.role==='owner'){
   data.settings=s;data.hours=(await pool.query('SELECT hour,price_units FROM shared_hour_prices ORDER BY hour')).rows;
   data.workers=(await pool.query('SELECT worker_group,accounts_running,max_accounts,heartbeat_at FROM worker_health WHERE worker_group=ANY($1::text[]) ORDER BY worker_group',[Object.keys(workerRoutes)])).rows;
   data.groups=Object.keys(workerRoutes);
  }res.json(data);
 }));
 app.put('/api/shared/settings',route(async(req,res)=>{
  owner(req);const value=settings(req.body);
  await transaction(async db=>{
   await db.query('SELECT id FROM shared_settings WHERE id=1 FOR UPDATE');
   await db.query('UPDATE shared_settings SET enabled=$1,price_units=$2,interval_ms=$3,batch_size=$4,updated_at=now() WHERE id=1',[value.enabled,value.price_units,value.interval_ms,value.batch_size]);
   await db.query('DELETE FROM shared_hour_prices');
   for(const p of value.hours)await db.query('INSERT INTO shared_hour_prices(hour,price_units) VALUES($1,$2)',[p.hour,p.price_units]);
   await db.query("INSERT INTO audit(actor_id,action,details) VALUES($1,'shared.settings',$2)",[req.user.id,value]);
  });await require('./billing').recoverCreditTasks();res.json({ok:true});
 }));
 app.get('/api/shared/accounts',route(async(req,res)=>{
  owner(req);const page=pageNumber(req.query.page),search=String(req.query.search||'').slice(0,80);
  const where="a.shared_pool AND a.deleted_at IS NULL AND ($1='' OR a.label ILIKE '%'||$1||'%' OR a.registration_phone ILIKE '%'||$1||'%')";
  const rows=(await pool.query(`SELECT a.id,a.label,a.registration_phone,a.phone,a.worker_group,a.enabled,a.status,a.shared_state,a.shared_checked_at,a.created_at,
   (${connectedSQL}) AS connected,(${personalPhoneSQL}) AS phone_in_personal,h.heartbeat_at AS worker_heartbeat_at FROM accounts a LEFT JOIN worker_health h ON h.worker_group=a.worker_group
   WHERE ${where} ORDER BY a.created_at,a.id LIMIT $2 OFFSET $3`,[search,PAGE,(page-1)*PAGE])).rows;
  const total=(await pool.query(`SELECT count(*)::int n FROM accounts a WHERE ${where}`,[search])).rows[0].n;res.json({rows,total,page,size:PAGE});
 }));
 app.post('/api/shared/accounts',route(async(req,res)=>{
  owner(req);const parsed=registrationNumbers(req.body.phones),groups=req.body.groups;
  assert(Array.isArray(groups)&&groups.length&&groups.length<=100&&groups.every(g=>typeof g==='string'&&Object.hasOwn(workerRoutes,g)),'请选择已配置的浏览器分组');
  const selected=[...new Set(groups)],prefix=String(req.body.label||'WhatsApp').trim();assert(prefix.length&&prefix.length<=40,'账号名称最多 40 个字符');
  const result=await transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(194812736)');
   const incoming=parsed.recipients.map(r=>r.phone),digits=incoming.map(p=>p.slice(1));
   const conflict=await db.query("SELECT 1 FROM accounts WHERE NOT shared_pool AND deleted_at IS NULL AND phone IS NOT NULL AND replace(phone,'+','')=ANY($1::text[]) LIMIT 1",[digits]);
   assert(!conflict.rowCount,'号码已用于普通 WhatsApp 账号，请使用独立的新共享号码',409);
   const existing=(await db.query('SELECT registration_phone FROM accounts WHERE shared_pool AND deleted_at IS NULL AND registration_phone=ANY($1::text[])',[incoming])).rows,seen=new Set(existing.map(a=>a.registration_phone));
   const fresh=parsed.recipients.filter(r=>!seen.has(r.phone));
   const counts=(await db.query('SELECT worker_group,count(*)::int n FROM accounts WHERE deleted_at IS NULL GROUP BY worker_group')).rows;
   const load=new Map(selected.map(g=>[g,counts.find(c=>c.worker_group===g)?.n||0]));
   for(const r of fresh){const group=[...load.keys()].sort((a,b)=>load.get(a)-load.get(b))[0];
    await db.query("INSERT INTO accounts(id,label,worker_group,enabled,status,shared_pool,registration_phone) VALUES($1,$2,$3,false,'disabled',true,$4)",[randomUUID(),prefix+' '+r.phone,group,r.phone]);load.set(group,load.get(group)+1);
   }
   await db.query("INSERT INTO audit(actor_id,action,details) VALUES($1,'shared.accounts.create',$2)",[req.user.id,{created:fresh.length,groups:selected}]);
   return {created:fresh.length,duplicates:parsed.duplicates+parsed.recipients.length-fresh.length};
  });res.status(201).json(result);
 }));
 app.post('/api/shared/accounts/:id/connect',route(async(req,res)=>{
  owner(req);const id=uuid(req.params.id),a=(await pool.query('SELECT * FROM accounts WHERE id=$1 AND shared_pool AND deleted_at IS NULL',[id])).rows[0];assert(a,'共享账号不存在',404);
  const conflict=(await pool.query("SELECT 1 FROM accounts WHERE NOT shared_pool AND deleted_at IS NULL AND phone IS NOT NULL AND replace(phone,'+','')=$1 LIMIT 1",[a.registration_phone?.slice(1)])).rowCount;
  assert(!conflict,'号码已用于普通 WhatsApp 账号，请使用独立的新共享号码',409);
  assert(Object.hasOwn(workerRoutes,a.worker_group),'浏览器分组尚未配置',503);
  await pool.query('UPDATE accounts SET enabled=true WHERE id=$1',[id]);
  await pool.query("INSERT INTO audit(actor_id,action,entity_id) VALUES($1,'shared.account.connect',$2)",[req.user.id,id]);
  try{await workerCommand(a,'start');res.json({starting:true});}catch{res.status(202).json({starting:false,pending:true});}
 }));
 const limit=rateLimit({windowMs:60000,limit:30,standardHeaders:'draft-8',legacyHeaders:false,keyGenerator:req=>req.user.id,message:{error:'共享发送请求过于频繁，请稍后再试'}});
 app.post('/api/shared/send',limit,route(async(req,res)=>res.status(201).json(await createTask(req.user,req.body,Object.keys(workerRoutes)))));
 app.get('/api/shared/tasks',route(async(req,res)=>{
  const page=pageNumber(req.query.page),rows=(await pool.query(`SELECT c.id,c.title,c.body,c.created_at,c.enabled,c.pause_reason,c.cancelled,(c.media IS NOT NULL) has_image,u.username creator,
   (SELECT jsonb_object_agg(t.status,t.n) FROM (SELECT status,count(*)::int n FROM recipients WHERE campaign_id=c.id GROUP BY status) t) counts
   FROM campaigns c JOIN users u ON u.id=c.created_by WHERE c.shared_pool AND c.deleted_at IS NULL AND ($1='owner' OR c.created_by=$2)
   ORDER BY c.created_at DESC LIMIT 100 OFFSET $3`,[req.user.role,req.user.id,(page-1)*100])).rows;res.json({rows,page,size:100});
 }));
 app.get('/api/shared/records',route(async(req,res)=>{
  const page=pageNumber(req.query.page),rows=(await pool.query(`SELECT r.id,r.phone,r.raw_phone,r.status,r.error_code,r.updated_at,c.id campaign_id,c.title,c.body,c.created_at,u.username creator
   FROM recipients r JOIN campaigns c ON c.id=r.campaign_id JOIN users u ON u.id=c.created_by WHERE c.shared_pool AND c.deleted_at IS NULL AND ($1='owner' OR c.created_by=$2)
   ORDER BY r.updated_at DESC,r.id DESC LIMIT 100 OFFSET $3`,[req.user.role,req.user.id,(page-1)*100])).rows;res.json({rows,page,size:100});
 }));
 app.get('/api/shared/hourly',route(async(req,res)=>{
  owner(req);res.json((await pool.query(`SELECT hour_start,sum(total)::int total,sum(connected)::int connected,sum(waiting)::int waiting,
   sum(offline)::int offline,sum(unknown)::int unknown,count(*)::int groups,max(checked_at) checked_at FROM shared_health_hourly
   WHERE hour_start>now()-interval '24 hours' GROUP BY hour_start ORDER BY hour_start DESC LIMIT 24`)).rows);
 }));
}
module.exports={routes,config,canPay,createTask,chooseAccount,rebalance,checkGroup,recoverInterrupted};
