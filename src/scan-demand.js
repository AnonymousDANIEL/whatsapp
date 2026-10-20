'use strict';
// A QR screen is temporary; its private profile is not. Keep demand in PostgreSQL
// across API/worker restarts, without changing account ownership or phone links.
const LEASE_MS=120000;
async function ensure(db){
 const c=await db.connect();
 try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(194812738)');
 await c.query(`CREATE TABLE IF NOT EXISTS scan_demand(
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
 )`);await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function request(db,id){
 const r=await db.query(`INSERT INTO scan_demand(account_id,expires_at) VALUES($1,clock_timestamp()+interval '120 seconds')
  ON CONFLICT(account_id) DO UPDATE SET
   requested_at=CASE WHEN scan_demand.expires_at<=clock_timestamp() THEN clock_timestamp() ELSE scan_demand.requested_at END,
   expires_at=clock_timestamp()+interval '120 seconds'
  RETURNING requested_at,expires_at`,[id]);
 return r.rows[0];
}
async function read(db,group){
 const rows=(await db.query(`SELECT d.* FROM scan_demand d JOIN accounts a ON a.id=d.account_id
  WHERE a.worker_group=$1 AND a.enabled AND a.deleted_at IS NULL AND d.expires_at>clock_timestamp()`,[group])).rows;
 return new Map(rows.map(r=>[r.account_id,r]));
}
function active(demand,now=Date.now()){return !!demand&&Number.isFinite(+new Date(demand.expires_at))&&+new Date(demand.expires_at)>now;}
function shouldStart(account,demand,now=Date.now()){
 return active(demand,now)||!!account.phone&&account.status!=='scan_required'&&account.last_error!=='QR_SCAN_IDLE';
}
function idle(entry,demand,busy=false,now=Date.now()){
 // Never evict a linked, authenticating, syncing, launching or viewed browser.
 return !!entry&&!entry.closing&&entry.awaitingScan===true&&!entry.ready&&!entry.authenticated&&!entry.launching&&!entry.syncing
  &&!busy&&!(entry.sockets?.size||entry.sockets?.length)&&!active(demand,now);
}
function ordered(accounts,demands,now=Date.now()){
 const rank=a=>a.phone&&a.status!=='scan_required'&&a.last_error!=='QR_SCAN_IDLE'?0:active(demands.get(a.id),now)?1:2;
 return [...accounts].sort((a,b)=>rank(a)-rank(b)||
  (rank(a)===1?(+new Date(demands.get(a.id).requested_at)-+new Date(demands.get(b.id).requested_at)):0)||
  +new Date(a.created_at)-+new Date(b.created_at)||a.id.localeCompare(b.id));
}
async function releaseIdle(accounts,entries,demands,busy,stop,now=Date.now()){
 let released=0;
 for(const a of accounts){const e=entries.get(a.id);if(!idle(e,demands.get(a.id),busy.has(a.id),now))continue;
  await stop(a.id,e);released++;
 }
 return released;
}
module.exports={LEASE_MS,ensure,request,read,active,shouldStart,idle,ordered,releaseIdle};
