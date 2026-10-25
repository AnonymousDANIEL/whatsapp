'use strict';
// API-only options and request preparation: no linked worker restart is needed.
const {pool,transaction}=require('./db');
const {assert}=require('./domain');
const shared=require('./shared'),capacity=require('./capacity'),{connectedSQL}=require('./shared-domain');
const {rateLimit}=require('express-rate-limit');
async function ensureOptions(){
 await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(194812733)');
  await db.query(`CREATE TABLE IF NOT EXISTS shared_console_options(
   id smallint PRIMARY KEY CHECK(id=1),images_enabled boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT now())`);
  await db.query('INSERT INTO shared_console_options(id) VALUES(1) ON CONFLICT DO NOTHING');
 });
}
function taskTitle(value,id,shared=false){
 assert(value===undefined||typeof value==='string','任务名称无效');
 assert(value===undefined||value.length<=120,'任务名称最多 120 个字符');
 return value?.trim()||(shared?'Shared WhatsApp ':'WhatsApp ')+id;
}
function routes(app,route,workerRoutes){
 app.get('/api/workspace/features',route(async(req,res)=>{
  const row=(await pool.query('SELECT enabled FROM shared_settings WHERE id=1')).rows[0];
  res.json({shared_enabled:row?.enabled===true});
 }));
 app.patch('/api/shared/availability',route(async(req,res)=>{
  assert(req.user.role==='owner','只有 Owner 可以管理共享 WhatsApp',403);
  assert(typeof req.body.enabled==='boolean','共享服务开关无效');
  const value=await transaction(async db=>{
   const row=(await db.query('UPDATE shared_settings SET enabled=$1,updated_at=now() WHERE id=1 RETURNING enabled',[req.body.enabled])).rows[0];
   await db.query("INSERT INTO audit(actor_id,action,details) VALUES($1,'shared.availability',$2)",[req.user.id,{enabled:row.enabled}]);
   return row;
  });
  if(value.enabled)await require('./billing').recoverCreditTasks();
  res.json(value);
 }));
 // Closing shared access hides USER pages and also rejects stale direct requests.
 // Owner account/QR management remains available without restarting any worker.
 app.use(['/api/shared/send','/api/shared/tasks','/api/shared/records'],(req,res,next)=>{
  if(req.user.role==='owner')return next();
  pool.query('SELECT enabled FROM shared_settings WHERE id=1').then(({rows})=>{
   if(rows[0]?.enabled!==true)throw Object.assign(new Error('共享 WhatsApp 服务已关闭'),{status:503,code:'SHARED_DISABLED',publicMessage:true});
   next();
  }).catch(next);
 });
 app.get('/api/shared/status',route(async(req,res)=>{
  const groups=Object.keys(workerRoutes),s=await shared.config();
  const summary=(await pool.query(`SELECT count(*)::integer total,
   count(*) FILTER(WHERE ${connectedSQL} AND a.worker_group=ANY($1::text[]))::integer connected,
   count(*) FILTER(WHERE ${connectedSQL} AND a.worker_group=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM control_leases l WHERE l.account_id=a.id AND l.expires_at>now()))::integer available,
   count(*) FILTER(WHERE NOT enabled OR shared_state='waiting')::integer waiting,
   count(*) FILTER(WHERE enabled AND shared_state='unknown')::integer unknown
   FROM accounts a WHERE shared_pool AND deleted_at IS NULL`,[groups])).rows[0];
  summary.offline=summary.total-summary.connected-summary.waiting-summary.unknown;
  const options=(await pool.query('SELECT images_enabled FROM shared_console_options WHERE id=1')).rows[0];
  const visibleSummary=req.user.role==='owner'?summary:{available:s.enabled&&summary.available>0?1:0};
  const data={enabled:s.enabled,configured:s.current_price_units!=null,summary:visibleSummary,images_enabled:options.images_enabled,pacing:{interval_ms:s.interval_ms,batch_size:s.batch_size},timezone:'Asia/Kuala_Lumpur'};
  if(req.query.layout!=='2')data.balance_units=(await pool.query('SELECT credit_units FROM users WHERE id=$1',[req.user.id])).rows[0].credit_units;
  if(req.user.role==='owner'){
   data.settings=s;data.hours=(await pool.query('SELECT hour,price_units FROM shared_hour_prices ORDER BY hour')).rows;
   data.workers=await capacity.read(pool,groups);data.groups=groups;
  }
  res.json(data);
 }));
 app.get('/api/shared/options',route(async(req,res)=>res.json((await pool.query('SELECT images_enabled FROM shared_console_options WHERE id=1')).rows[0])));
 app.put('/api/shared/options',route(async(req,res)=>{
  assert(req.user.role==='owner','只有 Owner 可以设置共享图片发送',403);
  assert(typeof req.body.images_enabled==='boolean','请选择图片发送开关');
  const value=await transaction(async db=>{
   const r=await db.query('UPDATE shared_console_options SET images_enabled=$1,updated_at=now() WHERE id=1 RETURNING images_enabled',[req.body.images_enabled]);
   await db.query("INSERT INTO audit(actor_id,action,details) VALUES($1,'shared.images',$2)",[req.user.id,{images_enabled:req.body.images_enabled}]);return r.rows[0];
  });res.json(value);
 }));
 // Keep the original rate limiter, validation, idempotency and credit handling.
 // A request-derived label remains identical when a nameless submission retries.
 const guardLimit=rateLimit({windowMs:60000,limit:30,standardHeaders:false,legacyHeaders:false,keyGenerator:req=>req.user.id,message:{error:'共享发送请求过于频繁，请稍后再试'}});
 app.post('/api/shared/send',guardLimit,async(req,res,next)=>{
  try{
   req.body.title=taskTitle(req.body.title,String(req.body.request_id||''),true);
   if(req.user.role!=='owner'&&req.body.media){
    const row=(await pool.query('SELECT images_enabled FROM shared_console_options WHERE id=1')).rows[0];
    if(!row?.images_enabled){
     assert(/^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(req.body.request_id||''),'请求 ID 无效');
     // An identical retry may still retrieve its existing result. The original
     // handler checks the full digest and owner before returning that result.
     const prior=await pool.query('SELECT 1 FROM campaigns WHERE shared_request_id=$1 AND created_by=$2',[req.body.request_id,req.user.id]);
     assert(prior.rowCount,'共享图片发送已关闭',403);
    }
   }
   next();
  }catch(error){next(error);}
 });
}
module.exports={ensureOptions,taskTitle,routes};
