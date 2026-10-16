'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {pool,transaction}=require('./db');
const PLACEMENT_LOCK=194812737;
async function chooseGroup(db,groups,preferred,exclude=null){
 const rows=(await db.query(`SELECT h.*,count(a.id)::integer assigned FROM worker_health h
  LEFT JOIN accounts a ON a.worker_group=h.worker_group AND a.enabled AND a.deleted_at IS NULL
  WHERE h.worker_group=ANY($1::text[]) AND h.heartbeat_at>now()-interval '90 seconds'
  AND h.can_start_more AND h.worker_group IS DISTINCT FROM $2
  GROUP BY h.worker_group HAVING count(a.id)<h.max_accounts
  ORDER BY (h.worker_group=$3) DESC,count(a.id)::float/h.max_accounts,h.worker_group`,[groups,exclude,preferred])).rows;
 return rows[0]?.worker_group||null;
}
async function moveUnstarted(id,from,to,dataPath,entries){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||from===to||entries.has(id))return false;
 for(const folder of ['profiles','homes']){try{await fs.access(path.join(dataPath,folder,id));return false;}catch(e){if(e.code!=='ENOENT')throw e;}}
 try{const identities=JSON.parse(await fs.readFile(path.join(dataPath,'identities.json'),'utf8'));if(Object.hasOwn(identities,id))return false;}catch(e){if(e.code!=='ENOENT')throw e;}
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock($1)',[PLACEMENT_LOCK]);
  const a=(await db.query('SELECT * FROM accounts WHERE id=$1 AND worker_group=$2 FOR UPDATE',[id,from])).rows[0];
  if(!a||a.profile_bound||a.phone||a.shared_pool||!a.enabled||a.deleted_at||a.status!=='capacity_wait'||entries.has(id))return false;
  if((await db.query(`SELECT 1 FROM recipients r JOIN campaigns c ON c.id=r.campaign_id
    WHERE c.account_id=$1 AND r.started_at IS NOT NULL LIMIT 1`,[id])).rowCount)return false;
  if(!await chooseGroup(db,[to],to)||entries.has(id))return false;
  return (await db.query(`UPDATE accounts SET worker_group=$1,status='starting',last_error=NULL,heartbeat_at=NULL
    WHERE id=$2 AND worker_group=$3 AND NOT profile_bound RETURNING id`,[to,id,from])).rowCount===1;
 });
}
function createRebalancer(routes,browser,groups){
 let active=false;
 return async()=>{
  if(active||groups.length<2)return;active=true;
  try{
   const rows=(await pool.query(`SELECT id,worker_group FROM accounts WHERE enabled AND deleted_at IS NULL AND NOT shared_pool
    AND NOT profile_bound AND phone IS NULL AND status='capacity_wait' AND worker_group=ANY($1::text[]) ORDER BY created_at LIMIT 10`,[groups])).rows;
   for(const a of rows){const to=await chooseGroup(pool,groups,null,a.worker_group);if(!to)continue;
    try{const r=await browser.request(a,'/accounts/'+a.id+'/handoff/'+encodeURIComponent(to),'POST');if(r.moved)break;}catch(e){console.error('account allocation:',e.code||'HANDOFF_UNAVAILABLE');}
   }
  }finally{active=false;}
 };
}
module.exports={PLACEMENT_LOCK,chooseGroup,moveUnstarted,createRebalancer};
