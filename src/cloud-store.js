'use strict';
// Additive API-owned tables. Never alter QR accounts, Sessions, grants or money.
const crypto=require('node:crypto');
async function tx(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function ensure(pool){
 const ready=async c=>(await c.query("SELECT to_regclass('cloud_settings') IS NOT NULL AND to_regclass('cloud_accounts') IS NOT NULL AND to_regclass('cloud_signup_sessions') IS NOT NULL AND to_regclass('cloud_messages') IS NOT NULL AS ok")).rows[0].ok;
 if(await ready(pool))return;
 await tx(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(194812733)');await c.query("SET LOCAL lock_timeout='250ms'");if(await ready(c))return;
  await c.query(`CREATE TABLE IF NOT EXISTS cloud_settings(id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,app_id text,config_id text,app_secret_cipher text,verify_token_cipher text,graph_version text NOT NULL DEFAULT 'v26.0',account_limit integer NOT NULL DEFAULT 10 CHECK(account_limit BETWEEN 1 AND 100),revision integer NOT NULL DEFAULT 1,webhook_verified_at timestamptz,last_webhook_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now());
   INSERT INTO cloud_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
   CREATE TABLE IF NOT EXISTS cloud_accounts(id uuid PRIMARY KEY,phone text UNIQUE NOT NULL,business_name text NOT NULL,category text NOT NULL DEFAULT 'OTHER',status text NOT NULL DEFAULT 'unregistered' CHECK(status IN ('unregistered','pending','active','failed')),meta_status text,code_verified boolean NOT NULL DEFAULT false,phone_number_id text UNIQUE,waba_id text,token_cipher text,token_expires_at timestamptz,pin_cipher text,subscribed boolean NOT NULL DEFAULT false,profile jsonb NOT NULL DEFAULT '{}',business_hours text NOT NULL DEFAULT '',name_pending text,last_error text,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),checked_at timestamptz,operation_until timestamptz,otp_requested_at timestamptz);
   CREATE TABLE IF NOT EXISTS cloud_signup_sessions(id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES cloud_accounts(id),session_hash text NOT NULL,nonce_hash text NOT NULL,config_revision integer NOT NULL,status text NOT NULL DEFAULT 'pending',token_cipher text,token_expires_at timestamptz,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
   CREATE INDEX IF NOT EXISTS cloud_signup_expiry_idx ON cloud_signup_sessions(expires_at);
   CREATE TABLE IF NOT EXISTS cloud_messages(id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES cloud_accounts(id),request_id uuid,request_digest text,provider_id text UNIQUE,direction text NOT NULL CHECK(direction IN ('in','out')),peer text NOT NULL,type text NOT NULL,body text NOT NULL,status text NOT NULL,meta_error integer,created_by uuid,provider_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(account_id,request_id));
   CREATE INDEX IF NOT EXISTS cloud_messages_chat_idx ON cloud_messages(account_id,peer,created_at DESC,id DESC);
   CREATE INDEX IF NOT EXISTS cloud_messages_inbound_idx ON cloud_messages(account_id,peer,provider_at DESC) WHERE direction='in';`);
 });
}
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function publicAccount(a){return Object.fromEntries(['id','phone','business_name','category','status','meta_status','code_verified','phone_number_id','waba_id','token_expires_at','subscribed','profile','business_hours','name_pending','last_error','created_at','updated_at','checked_at'].map(k=>[k,a[k]]));}
module.exports={tx,ensure,hash,publicAccount};
