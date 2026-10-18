'use strict';
// Owner-only, lazy personal send lists. Attribute by the recorded sender, never
// by today's account grants, and retain the legacy Owner view of USER deletes.
const {pool}=require('./db');
const {assert}=require('./domain');
const taskSQL=`SELECT c.id,c.account_id,c.created_by AS actor_id,c.created_by,c.title,c.body,c.enabled,c.pause_reason,c.cancelled,c.send_now,
 c.timezone,c.window_start,c.window_end,c.weekdays,c.scheduled_at,c.expires_at,c.interval_ms,c.batch_size,c.deleted_at,c.created_at,
 COALESCE(c.operation_at,c.created_at) AS operation_at,(c.media IS NOT NULL) AS has_image,a.label AS account_label,u.username AS creator,
 (SELECT jsonb_object_agg(t.status,t.n) FROM (SELECT status,count(*)::integer n FROM recipients WHERE campaign_id=c.id GROUP BY status) t) AS counts
 FROM campaigns c JOIN accounts a ON a.id=c.account_id JOIN users u ON u.id=c.created_by WHERE NOT a.shared_pool AND NOT c.shared_pool`;
const recordSQL=`SELECT c.created_by AS actor_id,c.account_id,a.label account_label,u.username actor,r.phone recipient,r.raw_phone,
 r.id::text recipient_id,c.id campaign_id,r.message_id,c.body,CASE WHEN c.media IS NULL THEN 'chat' ELSE 'image' END message_type,
 r.status,r.error_code,COALESCE(r.started_at,r.updated_at) sent_at,c.deleted_at
 FROM recipients r JOIN campaigns c ON c.id=r.campaign_id JOIN accounts a ON a.id=c.account_id JOIN users u ON u.id=c.created_by
 WHERE NOT a.shared_pool AND NOT c.shared_pool
 UNION ALL
 SELECT m.actor_id,m.account_id,a.label,u.username,m.recipient,NULL,NULL,NULL,m.message_id,m.body,m.message_type,m.status,NULL,m.sent_at,m.deleted_at
 FROM message_history m JOIN accounts a ON a.id=m.account_id LEFT JOIN users u ON u.id=m.actor_id WHERE NOT a.shared_pool
 AND NOT EXISTS(SELECT 1 FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE c.account_id=m.account_id AND r.message_id=m.message_id)`;
function kind(req){assert(['tasks','messages'].includes(req.query.kind),'发送列表类型无效');return req.query.kind;}
function owner(req){assert(req.user.role==='owner','只有 Owner 可以查看按 USER ID 分组的发送记录',403);}
function records(type){return type==='tasks'?taskSQL:recordSQL;}
function routes(app,route){
 app.get('/api/owner/send-groups',route(async(req,res)=>{
  owner(req);const type=kind(req);
  const sql=type==='tasks'?`SELECT c.created_by actor_id FROM campaigns c JOIN accounts a ON a.id=c.account_id WHERE NOT a.shared_pool AND NOT c.shared_pool`:recordSQL;
  const {rows}=await pool.query(`WITH records AS (${sql}),totals AS (SELECT actor_id,count(*)::integer total FROM records GROUP BY actor_id)
   SELECT u.id,u.username,u.role,u.active,u.locked,COALESCE(t.total,0) total FROM users u LEFT JOIN totals t ON t.actor_id=u.id
   UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,total FROM totals WHERE actor_id IS NULL`);
  const groups=rows.filter(r=>r.id).map(({total,...user})=>({user,total})).sort((a,b)=>a.user.id===req.user.id?-1:b.user.id===req.user.id?1:a.user.username.localeCompare(b.user.username));
  if(type==='messages')groups.push({user:null,total:rows.find(r=>r.id===null)?.total||0});
  res.json({kind:type,groups});
 }));
 app.get('/api/owner/send-items',route(async(req,res)=>{
  owner(req);const type=kind(req),actor=req.query.actor_id;
  assert(typeof actor==='string'&&(actor==='external'&&type==='messages'||/^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(actor)),'USER ID 无效');
  const page=Math.max(1,Math.min(1000000,Math.floor(Number(req.query.page)||1))),id=actor==='external'?null:actor;
  const sql=records(type),where='actor_id IS NOT DISTINCT FROM $1::uuid',order=type==='tasks'?'created_at DESC,id DESC':'sent_at DESC,recipient_id DESC NULLS LAST,message_id DESC,account_id DESC';
  const rows=(await pool.query(`WITH records AS (${sql}) SELECT * FROM records WHERE ${where} ORDER BY ${order} LIMIT 100 OFFSET $2`,[id,(page-1)*100])).rows;
  // Separate counts allow an empty page after deletions without losing navigation.
  const total=(await pool.query(`WITH records AS (${sql}) SELECT count(*)::integer total FROM records WHERE ${where}`,[id])).rows[0].total;
  res.json({kind:type,actor_id:actor,rows,total,page,size:100});
 }));
}
module.exports={routes};
