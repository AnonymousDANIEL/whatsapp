'use strict';
const {pool,transaction}=require('./db');
const {assert}=require('./domain');
const {priceSQL}=require('./shared-domain');
// MYR uses four decimal places; all arithmetic is in integer units.
const SCALE=10000,MAX_BALANCE=1000000000000;
function units(value,positive=false){
  assert(typeof value==='string'&&/^(0|[1-9]\d{0,7})(\.\d{1,4})?$/.test(value),'金额须为正数，最多四位小数');
  const [whole,fraction='']=value.split('.'),n=Number(whole)*SCALE+Number(fraction.padEnd(4,'0'));
  assert(Number.isSafeInteger(n)&&n<=MAX_BALANCE&&(!positive||n>0),'金额超出允许范围');return n;
}
async function canPay(userId,db=pool){
  const u=(await db.query('SELECT role,active,locked,credit_units FROM users WHERE id=$1',[userId])).rows[0];
  if(u?.role==='owner')return;
  assert(u?.active&&!u.locked,'账号已停用或锁定',403);
  const price=(await db.query('SELECT price_units FROM billing_settings WHERE id=1')).rows[0]?.price_units;
  assert(price!==null&&price!==undefined,'管理员尚未设置每条消息价格',402);
  assert(Number(u?.credit_units)>=Number(price),'余额不足，请联系管理员充值',402);
}
async function reserveForSend(db,userId,recipientId){
  const u=(await db.query('SELECT role,active,locked,credit_units FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
  if(!u?.active)return {ok:false,pause_reason:null,error:'USER_INACTIVE'};if(u.locked)return {ok:false,pause_reason:null,error:'USER_LOCKED'};if(u.role==='owner')return {ok:true};
  const existing=(await db.query('SELECT * FROM message_charges WHERE recipient_id=$1 FOR UPDATE',[recipientId])).rows[0];
  if(existing&&existing.state!=='refunded')return {ok:false,pause_reason:'review',error:'BILLING_REVIEW_REQUIRED'};
  if(existing&&existing.user_id!==userId)return {ok:false,pause_reason:'review',error:'BILLING_REVIEW_REQUIRED'};
  const shared=(await db.query('SELECT c.shared_pool FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE r.id=$1',[recipientId])).rows[0]?.shared_pool===true;
  const rate=shared?(await db.query(`SELECT CASE WHEN s.enabled THEN ${priceSQL} END AS price_units,
    EXTRACT(hour FROM statement_timestamp() AT TIME ZONE 'Asia/Kuala_Lumpur')::integer AS hour FROM shared_settings s WHERE id=1`)).rows[0]:
    (await db.query('SELECT price_units FROM billing_settings WHERE id=1')).rows[0];
  const p=rate?.price_units;
  if(p==null||Number(u.credit_units)<Number(p))return {ok:false,pause_reason:'credit',error:'CREDIT_REQUIRED'};
  await db.query('UPDATE users SET credit_units=credit_units-$1 WHERE id=$2',[p,userId]);
  await db.query(`INSERT INTO message_charges(recipient_id,user_id,amount_units,state,service,price_hour) VALUES($1,$2,$3,'held',$4,$5)
    ON CONFLICT(recipient_id) DO UPDATE SET amount_units=excluded.amount_units,state='held',service=excluded.service,price_hour=excluded.price_hour,
    version=message_charges.version+1,updated_at=now()`,[recipientId,userId,p,shared?'shared':'personal',shared?rate.hour:null]);
  await db.query(`INSERT INTO credit_ledger(user_id,kind,delta_units,balance_units,recipient_id) SELECT id,'hold',-$1::bigint,credit_units,$3 FROM users WHERE id=$2`,[p,userId,recipientId]);
  return {ok:true};
}
async function reserve(db,userId,recipientId){return (await reserveForSend(db,userId,recipientId)).ok;}
async function resumeCreditTasks(userId=null,workerGroup=null){
 return transaction(async db=>{
  const rows=(await db.query(`UPDATE campaigns c SET enabled=true,pause_reason=NULL,operation_at=now() FROM users u,accounts a,billing_settings b,shared_settings s
   WHERE c.created_by=u.id AND c.account_id=a.id AND b.id=1 AND s.id=1 AND c.pause_reason='credit' AND NOT c.enabled
   AND NOT c.cancelled AND c.deleted_at IS NULL AND u.active AND NOT u.locked AND (a.enabled OR c.shared_pool) AND a.deleted_at IS NULL
   AND ($1::uuid IS NULL OR u.id=$1) AND ($2::text IS NULL OR a.worker_group=$2)
   AND c.shared_pool=a.shared_pool AND (NOT c.shared_pool OR s.enabled)
   AND (CASE WHEN c.shared_pool THEN ${priceSQL} ELSE b.price_units END) IS NOT NULL
   AND (u.role='owner' OR (u.role='user' AND u.credit_units>=(CASE WHEN c.shared_pool THEN ${priceSQL} ELSE b.price_units END)
    AND 'tasks.create'=ANY(u.permissions) AND (c.shared_pool OR EXISTS(SELECT 1 FROM account_grants g WHERE g.user_id=u.id AND g.account_id=a.id))))
   AND EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=c.id AND r.status='pending')
   AND NOT EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=c.id AND r.status IN ('unknown','sending'))
   RETURNING c.id`,[userId,workerGroup])).rows;
  if(rows.length){const ids=rows.map(r=>r.id);
   await db.query("UPDATE recipients SET error_code=NULL,updated_at=now() WHERE campaign_id=ANY($1::uuid[]) AND status='pending' AND error_code='CREDIT_REQUIRED'",[ids]);
   await db.query("INSERT INTO audit(action,entity_id) SELECT 'campaign.credit_resume',id::text FROM unnest($1::uuid[]) id",[ids]);
  }return rows.length;
 });
}
async function recoverCreditTasks(userId=null,workerGroup=null){try{return await resumeCreditTasks(userId,workerGroup);}catch(e){console.error('credit resume:',e.code||e.name);return 0;}}
async function settle(recipientId,status,actorId=null,note='',expectedVersion=null){
  const target=['submitted','delivered','read'].includes(status)?'charged':['failed','invalid','pending','cancelled'].includes(status)?'refunded':null;
  if(!target)return;
  await transaction(async db=>{
    const info=(await db.query('SELECT user_id FROM message_charges WHERE recipient_id=$1',[recipientId])).rows[0];if(!info)return;
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[info.user_id]);
    const charge=(await db.query('SELECT * FROM message_charges WHERE recipient_id=$1 FOR UPDATE',[recipientId])).rows[0];
    if(expectedVersion!==null&&charge?.version!==expectedVersion)return;
    if(!charge||!(charge.state==='held'||(charge.state==='charged'&&status==='failed')))return;
    if(target==='refunded')await db.query('UPDATE users SET credit_units=credit_units+$1 WHERE id=$2',[charge.amount_units,charge.user_id]);
    await db.query('UPDATE message_charges SET state=$1,updated_at=now() WHERE recipient_id=$2',[target,recipientId]);
    await db.query(`INSERT INTO credit_ledger(user_id,actor_id,kind,delta_units,balance_units,recipient_id,note)
      SELECT id,$2,$3,$4,credit_units,$5,$6 FROM users WHERE id=$1`,[charge.user_id,actorId,target,target==='refunded'?charge.amount_units:0,recipientId,note]);
  });
}
async function reconcile(){
  // Also repairs an interruption between saving a send result and finalizing its charge.
  const rows=(await pool.query(`SELECT m.recipient_id,m.version,r.status FROM message_charges m JOIN recipients r ON r.id=m.recipient_id
    WHERE (m.state='held' OR (m.state='charged' AND r.status='failed')) AND r.status IN ('submitted','delivered','read','failed','invalid','pending','cancelled') LIMIT 500`)).rows;
  for(const r of rows)await settle(r.recipient_id,r.status,null,'',r.version);
}
async function assertNoHolds(db,campaignId=null,accountId=null){
 const r=await db.query(`SELECT 1 FROM message_charges m JOIN recipients r ON r.id=m.recipient_id JOIN campaigns c ON c.id=r.campaign_id
 WHERE m.state='held' AND ($1::uuid IS NULL OR c.id=$1) AND ($2::uuid IS NULL OR c.account_id=$2 OR r.send_account_id=$2) LIMIT 1`,[campaignId,accountId]);
 assert(!r.rowCount,'存在待结算消息，请先在余额管理中核对',409);
}
function routes(app,route,uuid){
 app.get('/api/billing',route(async(req,res)=>{
  const id=req.user.role==='owner'&&req.query.user_id?uuid(req.query.user_id):req.user.id;
  const u=(await pool.query('SELECT id,username,role,credit_units FROM users WHERE id=$1',[id])).rows[0];assert(u,'账号不存在',404);
  if(req.user.role!=='owner'){
   const ledger=(await pool.query('SELECT id,kind,delta_units,balance_units,recipient_id,created_at FROM credit_ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 100',[id])).rows;
   const row=(await pool.query(`SELECT b.price_units AS personal_units,${priceSQL} AS shared_units,s.enabled AS shared_enabled FROM billing_settings b CROSS JOIN shared_settings s WHERE b.id=1 AND s.id=1`)).rows[0];
   const rates={personal_units:row?.personal_units??null,shared_units:row?.shared_units??null,shared_enabled:row?.shared_enabled===true};
   return res.json({currency:'MYR',scale:SCALE,user:u,ledger,rates});
  }
  const settings=(await pool.query('SELECT price_units FROM billing_settings WHERE id=1')).rows[0];
  const ledger=(await pool.query('SELECT l.*,u.username actor FROM credit_ledger l LEFT JOIN users u ON u.id=l.actor_id WHERE l.user_id=$1 ORDER BY l.id DESC LIMIT 100',[id])).rows;
  const held=(await pool.query("SELECT m.*,COALESCE(r.status,'unknown') AS status FROM message_charges m LEFT JOIN recipients r ON r.id=m.recipient_id WHERE m.user_id=$1 AND m.state='held' ORDER BY m.created_at DESC LIMIT 100",[id])).rows;
  const heldTotal=(await pool.query("SELECT COALESCE(sum(amount_units),0) total FROM message_charges WHERE user_id=$1 AND state='held'",[id])).rows[0].total;
  res.json({currency:'MYR',scale:SCALE,price_units:settings.price_units,user:u,held_units:heldTotal,ledger,held});
 }));
 app.put('/api/billing/price',route(async(req,res)=>{
  assert(req.user.role==='owner','只有 Owner 可以管理余额和定价',403);const amount=units(req.body.price,true);assert(amount<=100000000,'每条价格不能超过 RM 10000');
  await transaction(async db=>{await db.query('UPDATE billing_settings SET price_units=$1 WHERE id=1',[amount]);await db.query("INSERT INTO audit(actor_id,action,details) VALUES($1,'billing.price',$2)",[req.user.id,{price_units:amount,currency:'MYR'}]);});await recoverCreditTasks();res.json({ok:true});
 }));
 app.post('/api/billing/adjust',route(async(req,res)=>{
  assert(req.user.role==='owner','只有 Owner 可以管理余额和定价',403);const b=req.body,id=uuid(b.user_id),amount=units(b.amount,true);
  assert(['add','subtract'].includes(b.direction),'请选择增加或扣减');assert(typeof b.note==='string'&&b.note.trim().length>0&&b.note.length<=200,'请填写调整原因');uuid(b.request_id);
  await transaction(async db=>{
   const u=(await db.query('SELECT role,active,locked,credit_units FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];assert(u&&u.role!=='owner','Owner 余额无限，无需调整');
   const previous=(await db.query('SELECT * FROM credit_ledger WHERE request_id=$1',[b.request_id])).rows[0];
   if(previous){assert(previous.user_id===id&&Number(previous.delta_units)===(b.direction==='add'?amount:-amount)&&previous.note===b.note.trim(),'重复请求内容不一致',409);return;}
   const delta=b.direction==='add'?amount:-amount,balance=Number(u.credit_units)+delta;assert(balance>=0&&balance<=MAX_BALANCE,'调整后余额超出允许范围');
   await db.query('UPDATE users SET credit_units=$1 WHERE id=$2',[balance,id]);
   await db.query(`INSERT INTO credit_ledger(user_id,actor_id,kind,delta_units,balance_units,note,request_id) VALUES($1,$2,'adjustment',$3,$4,$5,$6)`,[id,req.user.id,delta,balance,b.note.trim(),b.request_id]);
  });if(b.direction==='add')await recoverCreditTasks(id);res.json({ok:true});
 }));
 app.post('/api/billing/resolve',route(async(req,res)=>{
  assert(req.user.role==='owner','只有 Owner 可以管理余额和定价',403);const b=req.body;
  assert(/^\d+$/.test(String(b.recipient_id))&&['charge','refund'].includes(b.action),'结算操作无效');assert(typeof b.note==='string'&&b.note.trim().length>0&&b.note.length<=200,'请填写调整原因');
  const r=(await pool.query('SELECT status FROM recipients WHERE id=$1',[b.recipient_id])).rows[0];
  const held=!r&&(await pool.query("SELECT 1 FROM message_charges WHERE recipient_id=$1 AND state='held'",[b.recipient_id])).rowCount;
  assert(r?.status==='unknown'||held,'仅可手动核对结果不确定的消息',409);
  await settle(b.recipient_id,b.action==='charge'?'submitted':'failed',req.user.id,b.note.trim());res.json({ok:true});
 }));
}
module.exports={units,canPay,reserve,reserveForSend,resumeCreditTasks,recoverCreditTasks,settle,reconcile,assertNoHolds,routes};

