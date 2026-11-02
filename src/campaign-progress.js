'use strict';
const {assert,canDispatch}=require('./domain');

// Diagnostics only: never turn a deadline into a delivery result or release a hold.
function describe(c,now=Date.now()){
 const n=c.counts||{},result=state=>({state,next_at:null});
 if(c.cancelled||c.deleted_at)return result('cancelled');
 if(Number(n.sending))return result('sending');
 if(Number(n.awaiting_ack))return result('receipt');
 if(!Number(n.pending))return result(Number(n.unknown)?'unconfirmed':'complete');
 if(!c.enabled)return result(c.pause_reason==='credit'?'credit':c.pause_reason==='review'?'unconfirmed':'paused');
 if(c.review_blocked)return result('unconfirmed');
 if(!c.creator_allowed)return result('access');
 if(!c.account_enabled||c.account_deleted)return result('account_disabled');
 if(!c.send_now&&c.expires_at&&+new Date(c.expires_at)<=now)return result('expired');
 if(!c.send_now&&+new Date(c.scheduled_at)>now)return {state:'scheduled',next_at:new Date(Math.max(+new Date(c.scheduled_at),+new Date(c.next_send_at)||0)).toISOString()};
 if(!c.worker_heartbeat||now-+new Date(c.worker_heartbeat)>90000)return result('service_offline');
 if(c.account_status!=='ready')return result('connection');
 if(c.control_open)return result('control');
 if(c.account_busy)return result('account_busy');
 if(!canDispatch(c,new Date(now)))return result('window');
 if(+new Date(c.next_send_at)>now)return {state:'interval',next_at:new Date(c.next_send_at).toISOString()};
 return result('queued');
}

// Call only after the caller has scoped the rows. Return no worker addresses,
// unrelated task/USER identifiers, Session details or other account metadata.
async function decorate(pool,rows){
 const ids=rows.filter(c=>!c.shared_pool).map(c=>c.id);if(!ids.length)return rows;
 const {rows:states}=await pool.query(`SELECT c.id,c.enabled,c.cancelled,c.deleted_at,c.pause_reason,c.send_now,c.scheduled_at,c.expires_at,c.timezone,c.window_start,c.window_end,c.weekdays,a.enabled account_enabled,a.deleted_at account_deleted,a.status account_status,a.next_send_at,
 h.heartbeat_at worker_heartbeat,
 (u.active AND NOT u.locked AND (u.role='owner' OR (u.role='user' AND EXISTS(SELECT 1 FROM account_grants g WHERE g.account_id=a.id AND g.user_id=u.id)))) creator_allowed,
 EXISTS(SELECT 1 FROM control_leases l WHERE l.account_id=a.id AND l.expires_at>now()) control_open,
 EXISTS(SELECT 1 FROM recipients r JOIN campaigns other ON other.id=r.campaign_id WHERE COALESCE(r.send_account_id,other.account_id)=a.id AND r.status IN ('sending','awaiting_ack')) account_busy,
 EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=c.id AND r.status='unknown' AND (c.review_released_at IS NULL OR r.updated_at>c.review_released_at)) review_blocked,
 (SELECT jsonb_object_agg(t.status,t.n) FROM (SELECT status,count(*)::integer n FROM recipients WHERE campaign_id=c.id GROUP BY status)t) counts
 FROM campaigns c JOIN accounts a ON a.id=c.account_id JOIN users u ON u.id=c.created_by LEFT JOIN worker_health h ON h.worker_group=a.worker_group
 WHERE c.id=ANY($1::uuid[]) AND NOT c.shared_pool`,[ids]);
 const byId=new Map(states.map(c=>[c.id,c]));
 return rows.map(c=>{const s=byId.get(c.id);return s?{...c,counts:s.counts||{},execution:describe(s)}:c;});
}

// Same lock order as worker claim: creator, campaign, then account. Existing
// workers retain their deployed code and private /data. Edit only between batches
// (or before a future/paused task), never while an old worker snapshot is sending.
async function editPacing(db,campaign,pace,actor){
 await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[campaign.created_by]);
 const c=(await db.query('SELECT * FROM campaigns WHERE id=$1 FOR UPDATE',[campaign.id])).rows[0];
 assert(c&&!c.cancelled&&!c.deleted_at,'任务已取消或删除',409);
 const a=(await db.query('SELECT *,next_send_at>clock_timestamp()+interval \'2 seconds\' AS cooling FROM accounts WHERE id=$1 FOR UPDATE',[c.account_id])).rows[0];
 const n=(await db.query("SELECT count(*) FILTER(WHERE status='pending')::int pending,count(*) FILTER(WHERE status IN ('sending','awaiting_ack'))::int inflight FROM recipients WHERE campaign_id=$1",[c.id])).rows[0];
 assert(!n.inflight&&!(n.pending&&a.enabled&&canDispatch(c)&&!a.cooling),'当前批次正在处理，请在批次间隔或暂停后修改',409);
 await db.query('UPDATE campaigns SET interval_ms=$1,batch_size=$2,operation_at=now() WHERE id=$3',[pace.interval_ms,pace.batch_size,c.id]);
 // Another task's cooldown belongs to that task. Never shorten it here.
 if(!c.shared_pool&&a.batch_campaign_id===c.id&&a.cooling){
  await db.query("UPDATE accounts SET next_send_at=clock_timestamp()+($2::integer*interval '1 millisecond') WHERE id=$1",[a.id,pace.interval_ms]);
 }
 await db.query('INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,$2,$3,$4)',[actor,'campaign.schedule',c.id,pace]);
}
module.exports={describe,decorate,editPacing};
