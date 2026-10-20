'use strict';
// API-owned policy. Existing browser workers keep their sessions and use the
// same immutable held -> charged/refunded state machine without a redeploy.
const {pool,transaction}=require('./db');
const {assert}=require('./domain');
const UNCONFIRMED='AUTO_REFUND_UNCONFIRMED',REMOVED='AUTO_REFUND_REMOVED_RECIPIENT';
const overdue="r.status IN ('sending','awaiting_ack') AND r.started_at<now()-interval '90 seconds'";
async function expireUnconfirmed(){
 const candidates=(await pool.query(`SELECT c.id FROM campaigns c WHERE EXISTS(
  SELECT 1 FROM recipients r JOIN message_charges m ON m.recipient_id=r.id
  WHERE r.campaign_id=c.id AND m.state='held' AND ${overdue}) ORDER BY c.id LIMIT 20`)).rows;
 let expired=0;
 for(const candidate of candidates){
  if(expired>=500)break;
  expired+=await transaction(async db=>{
   // Match dispatch's campaign-before-recipient order. A busy campaign can be
   // retried next tick; financial locks are taken only after this commits.
   if(!(await db.query('SELECT id FROM campaigns WHERE id=$1 FOR UPDATE SKIP LOCKED',[candidate.id])).rowCount)return 0;
   const rows=(await db.query(`UPDATE recipients r SET status='unknown',
    error_code=CASE WHEN r.status='sending' THEN 'SEND_INTERRUPTED_REVIEW_REQUIRED' ELSE 'ACK_TIMEOUT_REVIEW_REQUIRED' END,updated_at=now()
    WHERE r.id IN(SELECT r.id FROM recipients r JOIN message_charges m ON m.recipient_id=r.id
     WHERE r.campaign_id=$1 AND m.state='held' AND ${overdue} ORDER BY r.id LIMIT $2 FOR UPDATE OF r SKIP LOCKED) RETURNING r.id`,[candidate.id,500-expired])).rows;
   if(rows.length)await db.query("UPDATE campaigns SET enabled=false,pause_reason='review',operation_at=now() WHERE id=$1",[candidate.id]);
   return rows.length;
  });
 }
 return expired;
}
async function settleCurrent(candidate,onlyUnconfirmed=false){
 return transaction(async db=>{
  // Existing send/settlement/top-up paths also lock wallet before charge.
  await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[candidate.user_id]);
  const m=(await db.query('SELECT * FROM message_charges WHERE recipient_id=$1 FOR UPDATE',[candidate.recipient_id])).rows[0];
  if(!m||!['held','charged'].includes(m.state)||m.user_id!==candidate.user_id||m.version!==candidate.version)return null;
  const r=(await db.query('SELECT status FROM recipients WHERE id=$1 FOR UPDATE SKIP LOCKED',[m.recipient_id])).rows[0];
  // A locked recipient is not a deleted recipient. In particular let a real
  // concurrent ACK commit before rechecking, rather than guessing its outcome.
  if(!r&&(await db.query('SELECT 1 FROM recipients WHERE id=$1',[m.recipient_id])).rowCount)return null;
  const unconfirmed=!r||r.status==='unknown';
  if(onlyUnconfirmed&&!unconfirmed)return null;
  const target=unconfirmed||['failed','invalid','pending','cancelled'].includes(r?.status)?'refunded':['submitted','delivered','read'].includes(r?.status)?'charged':null;
  if(!target||(m.state==='charged'&&r?.status!=='failed'))return null;
  const reason=unconfirmed?(r?UNCONFIRMED:REMOVED):'';
  if(target==='refunded')await db.query('UPDATE users SET credit_units=credit_units+$1 WHERE id=$2',[m.amount_units,m.user_id]);
  await db.query('UPDATE message_charges SET state=$2,updated_at=now() WHERE recipient_id=$1',[m.recipient_id,target]);
  await db.query(`INSERT INTO credit_ledger(user_id,kind,delta_units,balance_units,recipient_id,note)
   SELECT id,$2,$3,credit_units,$4,$5 FROM users WHERE id=$1`,[m.user_id,target,target==='refunded'?m.amount_units:0,m.recipient_id,reason]);
  if(target==='refunded')await db.query("INSERT INTO audit(action,entity_id,details) VALUES('billing.auto_refund',$1,$2)",[String(m.recipient_id),{recipient_id:m.recipient_id,user_id:m.user_id,amount_units:m.amount_units,service:m.service,reason:reason||'AUTO_REFUND_NOT_SENT'}]);
  // Message outcome and attempt IDs are intentionally unchanged. A late ACK
  // remains visible but a refunded charge cannot be charged again.
  return {target,amount_units:m.amount_units};
 });
}
async function refund(candidate){const result=await settleCurrent(candidate,true);return result?.target==='refunded'?result.amount_units:null;}
async function snapshot(){
 return (await pool.query(`SELECT
  (SELECT count(*)::integer FROM message_charges m JOIN recipients r ON r.id=m.recipient_id WHERE m.state='held' AND r.status='unknown') AS held_unknown,
  (SELECT count(*)::integer FROM message_charges m WHERE m.state='held' AND NOT EXISTS(SELECT 1 FROM recipients r WHERE r.id=m.recipient_id)) AS held_removed,
  (SELECT count(*)::integer FROM credit_ledger WHERE kind='refunded' AND actor_id IS NULL) AS automatic_refund_records`)).rows[0];
}
async function reconcile(){
 const expired=await expireUnconfirmed();
 // Recover known outcomes too, but re-read them under the recipient lock:
 // a stale scan must never refund a pending hold that has begun sending.
 const rows=(await pool.query(`SELECT m.recipient_id,m.user_id,m.version FROM message_charges m LEFT JOIN recipients r ON r.id=m.recipient_id
  WHERE (m.state='held' AND (r.status IN('unknown','submitted','delivered','read','failed','invalid','pending','cancelled') OR r.id IS NULL))
   OR (m.state='charged' AND r.status='failed') ORDER BY m.updated_at,m.recipient_id LIMIT 500`)).rows;
 let refunded=0,charged=0,amount=0n;
 for(const row of rows){const result=await settleCurrent(row);if(result?.target==='refunded'){refunded++;amount+=BigInt(result.amount_units);}else if(result?.target==='charged')charged++;}
 return {expired,refunded,charged,refunded_units:amount.toString()};
}
function monitor(intervalMs=5000){
 let busy=false,stopped=false,pending=Promise.resolve(),lastReport=0;
 const tick=async()=>{
  if(busy||stopped)return;busy=true;
  try{const result=await reconcile();if(result.expired||result.refunded||result.charged||Date.now()-lastReport>=60000){
   console.log('Automatic refund recovery:',JSON.stringify({...result,...await snapshot(),ack_timeout_seconds:90,manual_review:false}));lastReport=Date.now();
  }}catch(e){console.error('Automatic refund recovery pending:',e.code||e.name);}finally{busy=false;}
 };
 pending=tick();const timer=setInterval(()=>{if(!busy&&!stopped)pending=tick();},intervalMs);timer.unref();
 return ()=>{stopped=true;clearInterval(timer);return pending;};
}
function routes(app,route,uuid){
 app.get('/api/billing/automatic-refunds',route(async(req,res)=>{
  assert(req.user.role==='owner','只有 Owner 可以查看自动退款记录',403);
  const userId=req.query.user_id?uuid(req.query.user_id):req.user.id,before=req.query.before||null;
  assert(before===null||(typeof before==='string'&&/^[1-9]\d{0,17}$/.test(before)),'分页编号无效');
  const rows=(await pool.query(`SELECT l.id,l.user_id,u.username,l.recipient_id,l.delta_units AS amount_units,COALESCE(NULLIF(l.note,''),'AUTO_REFUND_NOT_SENT') AS reason,l.created_at,
   m.service,COALESCE(r.status,'removed') AS message_status FROM credit_ledger l JOIN users u ON u.id=l.user_id
   LEFT JOIN message_charges m ON m.recipient_id=l.recipient_id LEFT JOIN recipients r ON r.id=l.recipient_id
   WHERE l.user_id=$1 AND l.kind='refunded' AND l.actor_id IS NULL AND ($2::bigint IS NULL OR l.id<$2)
   ORDER BY l.id DESC LIMIT 101`,[userId,before])).rows;
  res.json({rows:rows.slice(0,100),next_cursor:rows.length>100?String(rows[99].id):null,timezone:'Asia/Kuala_Lumpur'});
 }));
 app.post('/api/billing/resolve',route(async(req,res)=>{
  assert(req.user.role==='owner','只有 Owner 可以管理余额和定价',403);
  assert(false,'待核对消息会自动退款，无需人工核对',409);
 }));
}
module.exports={reconcile,refund,expireUnconfirmed,snapshot,monitor,routes,UNCONFIRMED,REMOVED};
