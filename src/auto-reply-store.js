'use strict';
const {tx}=require('./cloud-store');
const crypto=require('node:crypto');
const CHANNELS=['whatsapp','telegram','webchat','wechat','messenger'];
async function ensure(pool){
 await tx(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(194812733)');await c.query("SET LOCAL lock_timeout='250ms'");
  await c.query(`CREATE TABLE IF NOT EXISTS reply_policy(channel text PRIMARY KEY,enabled boolean NOT NULL DEFAULT false,reason text NOT NULL DEFAULT '');
   CREATE TABLE IF NOT EXISTS reply_user_policy(user_id uuid NOT NULL,channel text NOT NULL,enabled boolean NOT NULL DEFAULT true,reason text NOT NULL DEFAULT '',PRIMARY KEY(user_id,channel));
   CREATE TABLE IF NOT EXISTS reply_connections(id uuid PRIMARY KEY,user_id uuid NOT NULL,channel text NOT NULL,label text NOT NULL,account_id uuid UNIQUE,remote_id text,credentials_cipher text,verified_at timestamptz,enabled boolean NOT NULL DEFAULT false,mode text NOT NULL DEFAULT 'all',keywords jsonb NOT NULL DEFAULT '[]',reply_text text NOT NULL DEFAULT '',cooldown_seconds integer NOT NULL DEFAULT 60,activated_at timestamptz NOT NULL DEFAULT now(),last_webhook_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(channel,remote_id));
   CREATE INDEX IF NOT EXISTS reply_connections_user_idx ON reply_connections(user_id,created_at);
   CREATE TABLE IF NOT EXISTS reply_events(id uuid PRIMARY KEY,connection_id uuid NOT NULL REFERENCES reply_connections(id),provider_id text NOT NULL,peer text NOT NULL,body text NOT NULL,digest text NOT NULL,provider_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'received',reply_text text NOT NULL DEFAULT '',provider_reply_id text,campaign_id uuid,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(connection_id,provider_id));
   CREATE INDEX IF NOT EXISTS reply_events_queue_idx ON reply_events(created_at) WHERE status='received';
   CREATE INDEX IF NOT EXISTS reply_events_peer_idx ON reply_events(connection_id,peer,created_at DESC);
   CREATE INDEX IF NOT EXISTS reply_events_connection_time_idx ON reply_events(connection_id,created_at DESC);
   CREATE INDEX IF NOT EXISTS reply_events_campaign_idx ON reply_events(campaign_id) WHERE campaign_id IS NOT NULL;
   CREATE TABLE IF NOT EXISTS reply_visitors(id uuid PRIMARY KEY,connection_id uuid NOT NULL REFERENCES reply_connections(id),token_hash text NOT NULL,expires_at timestamptz NOT NULL);
   CREATE TABLE IF NOT EXISTS reply_web_messages(id uuid PRIMARY KEY,connection_id uuid NOT NULL REFERENCES reply_connections(id),visitor_id uuid NOT NULL REFERENCES reply_visitors(id),request_id uuid NOT NULL,direction text NOT NULL,body text NOT NULL,actor_id uuid,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(visitor_id,request_id,direction));
   CREATE INDEX IF NOT EXISTS reply_web_messages_chat_idx ON reply_web_messages(visitor_id,created_at);
   CREATE TABLE IF NOT EXISTS reply_workers(worker_group text PRIMARY KEY,version integer NOT NULL DEFAULT 1,heartbeat_at timestamptz NOT NULL DEFAULT now());`);
  for(const channel of CHANNELS)await c.query('INSERT INTO reply_policy(channel) VALUES($1) ON CONFLICT DO NOTHING',[channel]);
  // This table is also used by older API builds and is additive only.
  await c.query(`CREATE TABLE IF NOT EXISTS shared_console_options(id smallint PRIMARY KEY CHECK(id=1),images_enabled boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT now());
   INSERT INTO shared_console_options(id) VALUES(1) ON CONFLICT DO NOTHING;
   ALTER TABLE shared_console_options ADD COLUMN IF NOT EXISTS maintenance_reason text NOT NULL DEFAULT '';`);
 });
}
const allowedSQL=`u.active AND NOT u.locked AND p.enabled AND COALESCE(up.enabled,true) AND r.enabled
 AND (r.channel<>'whatsapp' OR EXISTS(SELECT 1 FROM accounts a WHERE a.id=r.account_id AND NOT a.shared_pool AND a.enabled AND a.deleted_at IS NULL AND (u.role='owner' OR EXISTS(SELECT 1 FROM account_grants g WHERE g.account_id=a.id AND g.user_id=u.id))))`;
const joined=`reply_connections r JOIN users u ON u.id=r.user_id JOIN reply_policy p ON p.channel=r.channel LEFT JOIN reply_user_policy up ON up.user_id=r.user_id AND up.channel=r.channel`;
async function authorized(c,id,lock=false){return (await c.query(`SELECT r.* FROM ${joined} WHERE r.id=$1 AND ${allowedSQL}${lock?' FOR UPDATE OF r':''}`,[id])).rows[0];}
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
async function ingest(pool,connectionId,event,{passive=false}={}){
 if(!event||typeof event.id!=='string'||event.id.length>250||!event.id||typeof event.peer!=='string'||event.peer.length>180||!event.peer||typeof event.text!=='string'||event.text.length>4000||!event.text.trim())return null;
 const time=Number(event.time);if(!Number.isFinite(time)||time>Date.now()+60000||time<Date.now()-5*60000)return null;
 return tx(pool,async c=>{
  const r=await authorized(c,connectionId,true);if(!r||time<+new Date(r.activated_at)-1000)return null;
  const fingerprint=digest(JSON.stringify([event.peer,event.text,time]));
  const prior=(await c.query('SELECT * FROM reply_events WHERE connection_id=$1 AND provider_id=$2',[r.id,event.id])).rows[0];
  if(prior)return prior.digest===fingerprint?prior:null;
  if((await c.query("SELECT 1 FROM reply_events WHERE connection_id=$1 AND created_at>now()-interval '1 minute' OFFSET 119 LIMIT 1",[r.id])).rowCount)return null;
  const matches=r.mode==='all'||r.keywords.some(k=>event.text.toLocaleLowerCase().includes(k.toLocaleLowerCase()));
  const recent=(await c.query("SELECT 1 FROM reply_events WHERE connection_id=$1 AND peer=$2 AND reply_text<>'' AND created_at>now()-($3::int*interval '1 second') LIMIT 1",[r.id,event.peer,r.cooldown_seconds])).rowCount;
  const reply=matches&&!recent?r.reply_text:'',id=crypto.randomUUID(),status=reply?(passive?'replied':'received'):'skipped';
  const row=(await c.query(`INSERT INTO reply_events(id,connection_id,provider_id,peer,body,digest,provider_at,status,reply_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[id,r.id,event.id,event.peer,event.text,fingerprint,new Date(time),status,reply])).rows[0];
  await c.query('UPDATE reply_connections SET last_webhook_at=now() WHERE id=$1',[r.id]);return row;
 });
}
module.exports={CHANNELS,ensure,tx,allowedSQL,joined,authorized,digest,ingest};
