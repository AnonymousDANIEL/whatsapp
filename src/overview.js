'use strict';

// Personal WhatsApp records, partitioned by the recorded sender rather than
// today's account grants. One statement gives actors and dates one snapshot.
const groupedSQL=`WITH records AS (
 SELECT c.created_by AS actor_id,r.status,r.started_at AS sent_at
 FROM recipients r JOIN campaigns c ON c.id=r.campaign_id JOIN accounts a ON a.id=c.account_id
 WHERE NOT a.shared_pool AND a.deleted_at IS NULL AND c.deleted_at IS NULL
 UNION ALL
 SELECT m.actor_id,m.status,m.sent_at FROM message_history m JOIN accounts a ON a.id=m.account_id
 WHERE NOT a.shared_pool AND a.deleted_at IS NULL AND m.deleted_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE c.account_id=m.account_id AND r.message_id=m.message_id)
), today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day)
 SELECT 'actor' AS kind,id AS actor_id,username,role,active,locked,NULL::text AS status,NULL::text AS day,NULL::integer AS count FROM users
 UNION ALL
 SELECT 'total',actor_id,NULL,NULL,NULL,NULL,status,NULL,count(*)::integer FROM records GROUP BY actor_id,status
 UNION ALL
 SELECT 'daily',r.actor_id,NULL,NULL,NULL,NULL,r.status,to_char((r.sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date,'YYYY-MM-DD'),count(*)::integer
 FROM records r CROSS JOIN today t WHERE (r.sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN t.day-6 AND t.day
 GROUP BY r.actor_id,r.status,(r.sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 UNION ALL
 SELECT 'calendar',NULL,NULL,NULL,NULL,NULL,NULL,to_char(t.day-6+d.n,'YYYY-MM-DD'),NULL FROM today t CROSS JOIN generate_series(0,6) AS d(n)`;

async function readGrouped(db,ownerId){
 const {rows}=await db.query(groupedSQL);
 const dates=rows.filter(r=>r.kind==='calendar').map(r=>r.day).sort();
 const bucket=user=>({user,counts:{},days:dates.map(date=>({date,counts:{}}))});
 const actors=new Map(rows.filter(r=>r.kind==='actor').map(({actor_id:id,username,role,active,locked})=>[id,bucket({id,username,role,active,locked})]));
 const external=bucket(null);
 for(const row of rows){
  if(!['total','daily'].includes(row.kind))continue;
  const target=actors.get(row.actor_id)||external;
  if(row.kind==='total')target.counts[row.status]=Number(row.count);
  else target.days.find(d=>d.date===row.day).counts[row.status]=Number(row.count);
 }
 return{owner:actors.get(ownerId),users:[...actors.values()].filter(a=>a.user.id!==ownerId).sort((a,b)=>a.user.username.localeCompare(b.user.username)),external,timezone:'Asia/Kuala_Lumpur'};
}
module.exports={readGrouped};
