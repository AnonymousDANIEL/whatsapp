'use strict';
const FRESH_MS=90000;
const count=n=>Number.isSafeInteger(Number(n))&&Number(n)>0?Number(n):0;
function snapshot(row,now=Date.now()){
 const max=count(row.max_accounts),running=count(row.accounts_running),assigned=count(row.assigned_accounts),used=Math.max(running,assigned);
 const time=row.heartbeat_at==null?NaN:+new Date(row.heartbeat_at),fresh=Number.isFinite(time)&&time<=now+5000&&now-time<FRESH_MS;
 const remaining=Math.max(0,max-used),available=fresh&&row.can_start_more===true?remaining:0;
 return {...row,assigned_accounts:assigned,slots_used:used,slots_available:available,slots_unavailable:remaining-available,
  capacity_state:!fresh?'offline':row.can_start_more!==true&&(remaining>0||assigned>running)?'resource_wait':!remaining?'full':'available'};
}
async function read(db,groups){
 const rows=(await db.query(`SELECT h.*,g.worker_group,
  (SELECT count(*)::integer FROM accounts a WHERE a.worker_group=g.worker_group AND a.enabled AND a.deleted_at IS NULL) AS assigned_accounts
  FROM unnest($1::text[]) WITH ORDINALITY AS g(worker_group,slot_order)
  LEFT JOIN worker_health h ON h.worker_group=g.worker_group ORDER BY g.slot_order`,[[...new Set(groups)]])).rows;
 const now=Date.now();return rows.map(row=>snapshot(row,now));
}
module.exports={snapshot,read};
