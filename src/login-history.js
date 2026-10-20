'use strict';
// API-only: do not add this migration to the shared browser-worker schema.
const net=require('node:net');
const {assert}=require('./domain');
const PROVIDER='ipapi.is',PAGE_SIZE=50;
function clean(value,max=256){return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):null;}
function normalizeIP(value){
 if(typeof value!=='string'||value.length>64||value.includes('%'))return null;
 value=value.trim();if(!net.isIP(value))return null;
 if(net.isIP(value)===4)return value;
 const normalized=new URL('http://['+value+']/').hostname.slice(1,-1);
 if(normalized.startsWith('::ffff:')){const parts=normalized.slice(7).split(':');if(parts.length===2){const n=parseInt(parts[0],16)*65536+parseInt(parts[1],16);return [n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.');}}
 return normalized;
}
const nonPublic=new net.BlockList();
for(const [ip,bits]of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])nonPublic.addSubnet(ip,bits,'ipv4');
for(const [ip,bits]of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]])nonPublic.addSubnet(ip,bits,'ipv6');
const global6=new net.BlockList();global6.addSubnet('2000::',3,'ipv6');
function publicIP(value){const ip=normalizeIP(value);return !!ip&&(net.isIP(ip)===4?!nonPublic.check(ip,'ipv4'):global6.check(ip,'ipv6')&&!nonPublic.check(ip,'ipv6'));}
function requestContext(req,env=process.env){
 // Railway documents X-Real-IP as its edge's remote-client address. Never
 // accept arbitrary X-Forwarded-For/CF-Connecting-IP supplied by the browser.
 const railway=!!(env.RAILWAY_ENVIRONMENT_ID&&env.RAILWAY_SERVICE_ID);
 const ip=normalizeIP(railway?req.headers['x-real-ip']:req.socket?.remoteAddress);
 return {version:1,ip,ip_source:ip?(railway?'railway_edge':'direct_socket'):'unavailable',user_agent:clean(req.headers['user-agent'],2048),geo_status:ip&&publicIP(ip)?'pending':'unavailable'};
}
async function inTransaction(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function ensure(pool){
 const ready=async c=>(await c.query("SELECT to_regclass('login_history') IS NOT NULL AND to_regclass('login_ip_cache') IS NOT NULL AND to_regclass('login_lookup_budget') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='audit'::regclass AND tgname='wa_capture_login_history_v1' AND NOT tgisinternal AND tgenabled='O') AS ready")).rows[0].ready;
 if(await ready(pool))return;
 await inTransaction(pool,async c=>{
  await c.query("SET LOCAL lock_timeout='10s'");await c.query("SET LOCAL statement_timeout='60s'");await c.query('SELECT pg_advisory_xact_lock(194812733)');if(await ready(c))return;
  await c.query(`CREATE TABLE IF NOT EXISTS login_history(
   id bigserial PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,audit_id bigint UNIQUE NOT NULL,
   logged_at timestamptz NOT NULL,ip text,ip_source text NOT NULL,user_agent text,isp text,city text,country text,
   geo_status text NOT NULL DEFAULT 'legacy',geo_provider text,geo_checked_at timestamptz);
   CREATE INDEX IF NOT EXISTS login_history_user_time_idx ON login_history(user_id,logged_at DESC,id DESC);
   CREATE INDEX IF NOT EXISTS login_history_pending_ip_idx ON login_history(ip) WHERE geo_status='pending';
   CREATE TABLE IF NOT EXISTS login_ip_cache(ip text PRIMARY KEY,isp text,city text,country text,status text NOT NULL,
    checked_at timestamptz,expires_at timestamptz,retry_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz);
   CREATE TABLE IF NOT EXISTS login_lookup_budget(provider text PRIMARY KEY,day date NOT NULL,used integer NOT NULL DEFAULT 0,blocked_until timestamptz);
   CREATE OR REPLACE FUNCTION wa_capture_login_history_v1() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE n jsonb;v boolean;
    BEGIN
     n=NEW.details->'login_network';v=COALESCE(n->>'version'='1',false);
     INSERT INTO login_history(user_id,audit_id,logged_at,ip,ip_source,user_agent,geo_status)
     VALUES(NEW.actor_id,NEW.id,NEW.created_at,CASE WHEN v THEN left(n->>'ip',45) END,
      CASE WHEN v THEN COALESCE(n->>'ip_source','unavailable') ELSE 'legacy' END,
      CASE WHEN v THEN left(n->>'user_agent',2048) END,
      CASE WHEN v AND n->>'geo_status'='pending' AND n->>'ip' IS NOT NULL THEN 'pending' WHEN v THEN 'unavailable' ELSE 'legacy' END)
     ON CONFLICT(audit_id) DO NOTHING;RETURN NEW;
    END;$$;
   CREATE OR REPLACE TRIGGER wa_capture_login_history_v1 AFTER INSERT ON audit FOR EACH ROW
    WHEN (NEW.action='login' AND NEW.actor_id IS NOT NULL) EXECUTE FUNCTION wa_capture_login_history_v1();
   INSERT INTO login_history(user_id,audit_id,logged_at,ip_source,geo_status)
    SELECT actor_id,id,created_at,'legacy','legacy' FROM audit WHERE action='login' AND actor_id IS NOT NULL
    ON CONFLICT(audit_id) DO NOTHING`);
 });
}
function decodeCursor(value){
 if(value==null)return null;assert(typeof value==='string'&&value.length<=300&&/^[A-Za-z0-9_-]+$/.test(value),'登录记录页码无效');
 let c;try{c=JSON.parse(Buffer.from(value,'base64url').toString());}catch{assert(false,'登录记录页码无效');}
 assert(c&&typeof c.time==='string'&&/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(c.time)&&Number.isFinite(Date.parse(c.time))&&typeof c.id==='string'&&/^\d{1,19}$/.test(c.id)&&BigInt(c.id)>0n&&BigInt(c.id)<=9223372036854775807n,'登录记录页码无效');return c;
}
async function read(pool,userId,before){
 const cursor=decodeCursor(before);
 const {rows}=await pool.query(`SELECT id,logged_at,logged_at::text AS cursor_time,ip,ip_source,user_agent,isp,city,country,geo_status,geo_provider,geo_checked_at
  FROM login_history WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (logged_at,id)<($2::timestamptz,$3::bigint))
  ORDER BY logged_at DESC,id DESC LIMIT $4`,[userId,cursor?.time||null,cursor?.id||null,PAGE_SIZE+1]);
 const more=rows.length>PAGE_SIZE,visible=rows.slice(0,PAGE_SIZE),last=visible.at(-1);
 return {rows:visible.map(({cursor_time,...row})=>row),next_cursor:more?Buffer.from(JSON.stringify({time:last.cursor_time,id:last.id})).toString('base64url'):null,size:PAGE_SIZE,timezone:'Asia/Kuala_Lumpur',provider:PROVIDER};
}
function parseLookup(data,ip){
 if(!data||data.error||normalizeIP(data.ip)!==ip||data.is_bogon===true)throw Error('INVALID_IP_LOOKUP');
 const asn=typeof data.asn==='string'?data.asn.replace(/^AS\d+\s*/, ''):data.asn?.org;
 const company=typeof data.company==='object'&&data.company?.type==='isp'?data.company.name:null;
 return {isp:clean(company||asn)||null,city:clean(data.location?.city??data.city)||null,country:clean(data.location?.country??data.country)||null};
}
async function lookup(ip,{fetcher=fetch,key='',timeoutMs=4000}={}){
 assert(publicIP(ip),'INVALID_PUBLIC_IP');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref();
 try{
  const response=await fetcher(key?'https://api.ipapi.is/':'https://api.ipapi.is/?q='+encodeURIComponent(ip),{
   method:key?'POST':'GET',headers:{accept:'application/json',...(key?{'content-type':'application/json'}:{})},
   ...(key?{body:JSON.stringify({q:ip,key})}:{}),redirect:'error',signal:controller.signal});
  if(!response.ok){const e=Error('IP_LOOKUP_UNAVAILABLE');e.blocked=response.status===429||response.status===403;throw e;}
  let length=0;const chunks=[];for await(const part of response.body){length+=part.length;if(length>65536){controller.abort();throw Error('IP_LOOKUP_TOO_LARGE');}chunks.push(Buffer.from(part));}
  return parseLookup(JSON.parse(Buffer.concat(chunks).toString('utf8')),ip);
 }finally{clearTimeout(timer);}
}
async function enrich(pool,{fetcher=fetch,key=process.env.LOGIN_IP_LOOKUP_KEY||''}={}){
 // Shared DB budget + a persisted per-IP lease prevent double lookups during
 // rolling releases. A failed provider can never block password verification.
 const job=await inTransaction(pool,async c=>{
  if(!(await c.query('SELECT pg_try_advisory_xact_lock(194812738) AS ok')).rows[0].ok)return null;
  await c.query("DELETE FROM login_ip_cache WHERE checked_at<now()-interval '30 days' AND (lease_until IS NULL OR lease_until<now())");
  await c.query(`UPDATE login_history h SET isp=c.isp,city=c.city,country=c.country,geo_status=c.status,geo_provider=$1,geo_checked_at=c.checked_at
   FROM login_ip_cache c WHERE h.ip=c.ip AND h.geo_status='pending' AND c.status IN ('ready','unavailable') AND c.expires_at>now()`,[PROVIDER]);
  const candidate=(await c.query(`SELECT h.ip FROM login_history h LEFT JOIN login_ip_cache c ON c.ip=h.ip
   WHERE h.geo_status='pending' AND (c.ip IS NULL OR (c.retry_at<=now() AND (c.lease_until IS NULL OR c.lease_until<now())))
   GROUP BY h.ip ORDER BY max(h.logged_at) DESC LIMIT 1`)).rows[0];
  if(!candidate)return null;
  if(!publicIP(candidate.ip)){await c.query("UPDATE login_history SET geo_status='unavailable' WHERE ip=$1 AND geo_status='pending'",[candidate.ip]);return null;}
  await c.query(`INSERT INTO login_lookup_budget(provider,day) VALUES($1,(now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING`,[PROVIDER]);
  const budget=await c.query(`UPDATE login_lookup_budget SET
   used=CASE WHEN day=(now() AT TIME ZONE 'UTC')::date THEN used+1 ELSE 1 END,day=(now() AT TIME ZONE 'UTC')::date
   WHERE provider=$1 AND (blocked_until IS NULL OR blocked_until<=now())
   AND (day<(now() AT TIME ZONE 'UTC')::date OR used<$2) RETURNING used`,[PROVIDER,key?900:25]);
  if(!budget.rowCount)return null;
  await c.query(`INSERT INTO login_ip_cache(ip,status,lease_until) VALUES($1,'retry',now()+interval '30 seconds')
   ON CONFLICT(ip) DO UPDATE SET lease_until=excluded.lease_until`,[candidate.ip]);return candidate;
 });
 if(!job)return {looked_up:0};
 let data,error;try{data=await lookup(job.ip,{fetcher,key});}catch(e){error=e;}
 await inTransaction(pool,async c=>{
  if(error){
   await c.query("UPDATE login_ip_cache SET status='retry',lease_until=NULL,retry_at=now()+interval '15 minutes' WHERE ip=$1",[job.ip]);
   if(error.blocked)await c.query(`UPDATE login_lookup_budget SET blocked_until=(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+interval '1 day' WHERE provider=$1`,[PROVIDER]);
  }else{
   const status=data.isp||data.city||data.country?'ready':'unavailable';
   await c.query(`UPDATE login_ip_cache SET isp=$2,city=$3,country=$4,status=$5,checked_at=now(),expires_at=now()+interval '7 days',retry_at=now()+interval '7 days',lease_until=NULL WHERE ip=$1`,[job.ip,data.isp,data.city,data.country,status]);
   await c.query(`UPDATE login_history SET isp=$2,city=$3,country=$4,geo_status=$5,geo_provider=$6,geo_checked_at=now() WHERE ip=$1 AND geo_status='pending'`,[job.ip,data.isp,data.city,data.country,status,PROVIDER]);
  }
 });return {looked_up:1,ready:!error};
}
function monitor(pool,intervalMs=15000){let busy=false,stopped=false;const tick=async()=>{if(busy||stopped)return;busy=true;try{await enrich(pool);}catch(e){console.error('Login network lookup pending:',e.code||e.name);}finally{busy=false;}};const timer=setInterval(tick,intervalMs);timer.unref();void tick();return()=>{stopped=true;clearInterval(timer);};}
module.exports={ensure,requestContext,normalizeIP,publicIP,read,decodeCursor,parseLookup,lookup,enrich,monitor,PAGE_SIZE};
