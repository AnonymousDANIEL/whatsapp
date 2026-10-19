'use strict';
// API-owned queue maintenance; never restart a linked worker or infer the
// outcome of an in-flight WhatsApp request from connection health.
const {pool,transaction}=require('./db');
const billing=require('./billing');
const ERROR='ACCOUNT_DISCONNECTED_BEFORE_SUBMISSION';
const disconnected=`a.enabled AND a.deleted_at IS NULL AND NOT a.shared_pool
 AND a.phone IS NOT NULL AND (
  a.status IN ('scan_required','error','stopped') OR
  (a.status='ready' AND EXISTS(SELECT 1 FROM worker_health h
   WHERE h.worker_group=a.worker_group AND h.heartbeat_at<now()-interval '90 seconds'))
 )`;
async function reconcile(){
 const candidates=(await pool.query(`SELECT c.id FROM campaigns c JOIN accounts a ON a.id=c.account_id
  WHERE c.enabled AND NOT c.cancelled AND c.deleted_at IS NULL AND NOT c.shared_pool
  AND ${disconnected} AND EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=c.id
   AND r.status='pending' AND r.started_at IS NULL AND r.send_attempt_id IS NULL AND r.message_id IS NULL AND r.ack IS NULL
   AND NOT EXISTS(SELECT 1 FROM message_charges m WHERE m.recipient_id=r.id AND m.state='charged'))
  ORDER BY c.created_at,c.id LIMIT 20`)).rows;
 let failed=0;
 for(const candidate of candidates){
  failed+=await transaction(async db=>{
   // Dispatch takes this same campaign lock before claiming a recipient. Do not
   // take wallet locks until this transaction has committed.
   const c=(await db.query(`SELECT c.id FROM campaigns c JOIN accounts a ON a.id=c.account_id
    WHERE c.id=$1 AND c.enabled AND NOT c.cancelled AND c.deleted_at IS NULL AND NOT c.shared_pool
    AND ${disconnected} FOR UPDATE OF c SKIP LOCKED`,[candidate.id])).rows[0];
   if(!c)return 0;
   const rows=(await db.query(`UPDATE recipients SET status='failed',error_code=$2,updated_at=now()
    WHERE id IN (SELECT r.id FROM recipients r WHERE r.campaign_id=$1 AND r.status='pending'
     AND r.started_at IS NULL AND r.send_attempt_id IS NULL AND r.message_id IS NULL AND r.ack IS NULL
     AND NOT EXISTS(SELECT 1 FROM message_charges m WHERE m.recipient_id=r.id AND m.state='charged')
     ORDER BY r.id LIMIT 500 FOR UPDATE OF r SKIP LOCKED) RETURNING id`,[c.id,ERROR])).rows;
   if(rows.length)await db.query('UPDATE campaigns SET operation_at=now() WHERE id=$1',[c.id]);
   return rows.length;
  });
 }
 // Repair a crash between the saved failure and its refund. Version checks and
 // the existing wallet/charge lock order make retries and other reconcilers safe.
 const held=(await pool.query(`SELECT m.recipient_id,m.version FROM message_charges m
  JOIN recipients r ON r.id=m.recipient_id WHERE m.state='held' AND r.status='failed'
  AND r.error_code=$1 ORDER BY m.recipient_id LIMIT 500`,[ERROR])).rows;
 for(const row of held)await billing.settle(row.recipient_id,'failed',null,'',row.version);
 return {failed,refunds_checked:held.length};
}
function monitor(intervalMs=5000){
 let busy=false,pending=Promise.resolve();
 const tick=async()=>{if(busy)return;busy=true;try{const result=await reconcile();if(result.failed||result.refunds_checked)console.log('Connection queue recovery:',JSON.stringify(result));}catch(e){console.error('Connection queue recovery pending:',e.code||e.name);}finally{busy=false;}};
 const timer=setInterval(()=>{if(!busy)pending=tick();},intervalMs);timer.unref();
 return ()=>{clearInterval(timer);return pending;};
}
async function databaseCapacity(){
 const r=(await pool.query(`SELECT current_setting('max_connections')::integer AS max_connections,
  current_setting('superuser_reserved_connections')::integer AS superuser_reserved_connections,
  COALESCE(NULLIF(current_setting('reserved_connections',true),''),'0')::integer AS reserved_connections,
  (SELECT count(*)::integer FROM pg_stat_activity) AS current_connections`)).rows[0];
 return {...r,regular_connections:r.max_connections-r.superuser_reserved_connections-r.reserved_connections};
}
module.exports={reconcile,monitor,databaseCapacity,ERROR};
