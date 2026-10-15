CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','manager','staff')), manager_id uuid REFERENCES users(id),
 permissions text[] NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS accounts (
 id uuid PRIMARY KEY, label text NOT NULL, worker_group text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'stopped', phone text, last_error text, heartbeat_at timestamptz,
 next_send_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_grants (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, operate boolean NOT NULL DEFAULT false,
 PRIMARY KEY(user_id,account_id)
);
CREATE TABLE IF NOT EXISTS campaigns (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), created_by uuid NOT NULL REFERENCES users(id),
 title text NOT NULL, body text NOT NULL, enabled boolean NOT NULL DEFAULT true, cancelled boolean NOT NULL DEFAULT false,
 send_now boolean NOT NULL DEFAULT false,
 timezone text NOT NULL, window_start text NOT NULL, window_end text NOT NULL, weekdays integer[] NOT NULL,
 scheduled_at timestamptz NOT NULL, expires_at timestamptz, interval_ms integer NOT NULL CHECK(interval_ms>=5000),
 opt_in_confirmed boolean NOT NULL, duplicate_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS send_now boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS recipients (
 id bigserial PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES campaigns(id), raw_phone text NOT NULL, phone text,
 status text NOT NULL CHECK(status IN ('pending','sending','awaiting_ack','submitted','delivered','read','failed','invalid','unknown','cancelled')),
 error_code text, message_id text, ack integer, started_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recipients_queue ON recipients(campaign_id,id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS recipients_results ON recipients(campaign_id,status,id);
CREATE INDEX IF NOT EXISTS recipients_messages ON recipients(message_id) WHERE message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS receipts (
 account_id uuid NOT NULL REFERENCES accounts(id), message_id text NOT NULL, ack integer NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,message_id)
);
CREATE TABLE IF NOT EXISTS audit (
 id bigserial PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL, entity_id text, details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS worker_health (
 worker_group text PRIMARY KEY, heartbeat_at timestamptz NOT NULL, accounts_running integer NOT NULL, rss_mb integer NOT NULL
);
CREATE TABLE IF NOT EXISTS control_leases (
 account_id uuid PRIMARY KEY REFERENCES accounts(id), session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);

-- Idempotent role migration requested by the Owner; preserve IDs and grants.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('owner','manager','staff','user'));
UPDATE users SET active=false WHERE role='staff' AND manager_id IN(SELECT id FROM users WHERE NOT active);
UPDATE users SET role='user',manager_id=NULL,permissions=ARRAY['tasks.create','reports.export']::text[] WHERE role IN ('manager','staff');
UPDATE account_grants SET operate=true WHERE user_id IN (SELECT id FROM users WHERE role='user');
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id);
CREATE TABLE IF NOT EXISTS message_history (
 account_id uuid NOT NULL REFERENCES accounts(id), message_id text NOT NULL,
 actor_id uuid REFERENCES users(id), recipient text NOT NULL, body text NOT NULL DEFAULT '',
 status text NOT NULL, ack integer, sent_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 PRIMARY KEY(account_id,message_id)
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS history_synced_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS history_sync_error text;
-- Non-content suppression keys prevent polling from recreating Owner-deleted records.
CREATE TABLE IF NOT EXISTS history_exclusions (
 account_id uuid NOT NULL REFERENCES accounts(id),message_hash text NOT NULL,
 PRIMARY KEY(account_id,message_hash)
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS purge_requested boolean NOT NULL DEFAULT false;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS media jsonb;
ALTER TABLE message_history ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'chat';
-- Convert Malaysia recurring windows once, preserving real instants and start-day semantics.
UPDATE campaigns SET
 weekdays=CASE WHEN window_start=window_end OR window_start<'08:00' THEN ARRAY(SELECT CASE WHEN d=1 THEN 7 ELSE d-1 END FROM unnest(weekdays) d) ELSE weekdays END,
 window_start=CASE WHEN window_start=window_end THEN '16:00' ELSE to_char((date '2000-01-01'+window_start::time-interval '8 hours'),'HH24:MI') END,
 window_end=CASE WHEN window_start=window_end THEN '16:00' ELSE to_char((date '2000-01-01'+window_end::time-interval '8 hours'),'HH24:MI') END,timezone='UTC'
 WHERE timezone='Asia/Kuala_Lumpur';

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS batch_size integer NOT NULL DEFAULT 1 CHECK(batch_size BETWEEN 1 AND 100);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS batch_campaign_id text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS batch_sent integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS app_migrations(name text PRIMARY KEY);
UPDATE campaigns SET send_now=true WHERE NOT EXISTS(SELECT 1 FROM app_migrations WHERE name='interval_only_v1');
INSERT INTO app_migrations VALUES('interval_only_v1') ON CONFLICT DO NOTHING;

-- Prepaid MYR credit: existing USERs start at zero; never charge historical sends.
ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_units bigint NOT NULL DEFAULT 0 CHECK(credit_units>=0);
CREATE TABLE IF NOT EXISTS billing_settings(id integer PRIMARY KEY CHECK(id=1),price_units bigint CHECK(price_units>0));
INSERT INTO billing_settings(id,price_units) VALUES(1,NULL) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS message_charges(
 recipient_id bigint PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),amount_units bigint NOT NULL CHECK(amount_units>0),
 state text NOT NULL CHECK(state IN ('held','charged','refunded')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS charges_user ON message_charges(user_id,state);
CREATE TABLE IF NOT EXISTS credit_ledger(
 id bigserial PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),actor_id uuid REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('hold','charged','refunded','adjustment')),delta_units bigint NOT NULL,balance_units bigint NOT NULL,
 recipient_id bigint,note text NOT NULL DEFAULT '',request_id uuid UNIQUE,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user ON credit_ledger(user_id,id DESC);
DELETE FROM control_leases WHERE session_hash IN(SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.role<>'owner');

ALTER TABLE message_charges ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_limit integer NOT NULL DEFAULT 10 CHECK(account_limit BETWEEN 1 AND 10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_cipher text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS password_reveal_until timestamptz;
CREATE TABLE IF NOT EXISTS payment_settings(
 id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,sandbox boolean NOT NULL DEFAULT true,
 collection_id text NOT NULL DEFAULT '',api_key_cipher text,x_key_cipher text,updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO payment_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS topup_orders(
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),request_id uuid UNIQUE NOT NULL,
 amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 200 AND 1000000),
 state text NOT NULL DEFAULT 'creating' CHECK(state IN ('creating','pending','paid','create_failed')),
 bill_id text UNIQUE,payment_url text,config_cipher text NOT NULL,sandbox boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),paid_at timestamptz,last_checked_at timestamptz
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='credit_ledger'::regclass AND conname='credit_ledger_kind_check' AND pg_get_constraintdef(oid) LIKE '%bank_topup%') THEN
  ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
  ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check CHECK(kind IN ('hold','charged','refunded','adjustment','online_topup','bank_topup'));
 END IF;
END $$;
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS order_id uuid UNIQUE REFERENCES topup_orders(id);
CREATE INDEX IF NOT EXISTS orders_user ON topup_orders(user_id,created_at DESC);

-- One Owner-managed announcement shared across all signed-in USER pages.
CREATE TABLE IF NOT EXISTS workspace_notice(
 id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,
 content_zh text NOT NULL DEFAULT '' CHECK(length(content_zh)<=6000),
 content_en text NOT NULL DEFAULT '' CHECK(length(content_en)<=6000),updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspace_notice(id) VALUES(1) ON CONFLICT DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS remark text NOT NULL DEFAULT '' CHECK(length(remark)<=2000);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS pause_reason text CHECK(pause_reason IN ('credit','review'));
CREATE INDEX IF NOT EXISTS grants_account_user ON account_grants(account_id,user_id);
CREATE INDEX IF NOT EXISTS campaigns_account_created ON campaigns(account_id,created_at DESC);
CREATE INDEX IF NOT EXISTS history_account_time ON message_history(account_id,sent_at DESC);
CREATE INDEX IF NOT EXISTS campaigns_credit_wait ON campaigns(created_by,account_id) WHERE pause_reason='credit' AND NOT enabled AND NOT cancelled AND deleted_at IS NULL;
-- Recover identifiable old credit pauses once, excluding manual stops and uncertain sends.
UPDATE campaigns c SET pause_reason='credit' WHERE NOT EXISTS(SELECT 1 FROM app_migrations WHERE name='credit_auto_resume_v1')
 AND NOT c.enabled AND NOT c.cancelled AND c.deleted_at IS NULL AND c.pause_reason IS NULL
 AND EXISTS(SELECT 1 FROM users u WHERE u.id=c.created_by AND u.active)
 AND EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=c.id AND r.status='pending' AND r.error_code='CREDIT_REQUIRED')
 AND NOT EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=c.id AND r.status IN ('unknown','sending'))
 AND NOT EXISTS(SELECT 1 FROM audit a WHERE a.entity_id=c.id::text AND a.action='campaign.enabled' AND a.details->>'enabled'='false'
  AND a.id=(SELECT max(b.id) FROM audit b WHERE b.entity_id=c.id::text AND b.action IN ('campaign.enabled','campaign.send_now')));
INSERT INTO app_migrations(name) VALUES('credit_auto_resume_v1') ON CONFLICT DO NOTHING;

-- Owner-controlled bank deposits. Receipts alone never authorize credit.
CREATE TABLE IF NOT EXISTS bank_settings(id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false);
INSERT INTO bank_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS bank_accounts(
 id uuid PRIMARY KEY,bank_name text NOT NULL,account_name text NOT NULL,account_number text UNIQUE NOT NULL,
 status text NOT NULL DEFAULT 'disabled' CHECK(status IN ('active','maintenance','disabled')),
 qr jsonb,remark text NOT NULL DEFAULT '',display_order integer NOT NULL DEFAULT 0,
 feed_key_cipher text,feed_maintenance boolean NOT NULL DEFAULT false,feed_seen_at timestamptz,
 reported_balance_cents bigint,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bank_deposits(
 id uuid PRIMARY KEY,bank_id uuid NOT NULL REFERENCES bank_accounts(id),user_id uuid NOT NULL REFERENCES users(id),
 request_id uuid UNIQUE NOT NULL,amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 100 AND 1000000),
 state text NOT NULL DEFAULT 'awaiting_slip' CHECK(state IN ('awaiting_slip','pending','review','credited','rejected')),
 bank_snapshot jsonb NOT NULL,receipt bytea,receipt_mime text,receipt_sha256 text,
 reason_code text,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 submitted_at timestamptz,checked_at timestamptz,credited_at timestamptz,reviewed_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_receipt_once ON bank_deposits(receipt_sha256) WHERE receipt_sha256 IS NOT NULL AND state<>'rejected';
CREATE INDEX IF NOT EXISTS deposits_user ON bank_deposits(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS deposits_bank_pending ON bank_deposits(bank_id,created_at) WHERE state IN ('pending','review');
CREATE TABLE IF NOT EXISTS bank_transactions(
 bank_id uuid NOT NULL REFERENCES bank_accounts(id),transaction_id text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('in','out')),amount_cents bigint NOT NULL CHECK(amount_cents>0),
 occurred_at timestamptz NOT NULL,description text NOT NULL DEFAULT '',reference text NOT NULL DEFAULT '',
 source text NOT NULL DEFAULT 'feed' CHECK(source IN ('feed','owner')),
 deposit_id uuid UNIQUE REFERENCES bank_deposits(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(bank_id,transaction_id)
);
CREATE INDEX IF NOT EXISTS bank_transactions_time ON bank_transactions(bank_id,occurred_at DESC);
CREATE TABLE IF NOT EXISTS bank_feed_events(
 bank_id uuid NOT NULL REFERENCES bank_accounts(id),event_id uuid NOT NULL,body_hash text NOT NULL,
 processed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(bank_id,event_id)
);
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS deposit_id uuid UNIQUE REFERENCES bank_deposits(id);

-- Owner-linked shared accounts: number records do not register mobile accounts.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS shared_pool boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS registration_phone text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS shared_state text NOT NULL DEFAULT 'waiting' CHECK(shared_state IN ('connected','waiting','offline','unknown'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS shared_checked_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS shared_assigned_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS shared_registration_once ON accounts(registration_phone) WHERE shared_pool AND deleted_at IS NULL AND registration_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS shared_accounts ON accounts(worker_group,created_at) WHERE shared_pool AND deleted_at IS NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS shared_pool boolean NOT NULL DEFAULT false;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS shared_request_id uuid UNIQUE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS shared_request_hash text;
CREATE INDEX IF NOT EXISTS shared_campaigns_user ON campaigns(created_by,created_at DESC) WHERE shared_pool;
-- Actual sender IDs may outlive Owner-purged app records, like immutable charge recipient IDs.
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS send_account_id uuid;
CREATE INDEX IF NOT EXISTS recipients_sender ON recipients(send_account_id,message_id) WHERE send_account_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS shared_settings(
 id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,price_units bigint CHECK(price_units>0),
 interval_ms integer NOT NULL DEFAULT 10000 CHECK(interval_ms BETWEEN 5000 AND 3600000),
 batch_size integer NOT NULL DEFAULT 1 CHECK(batch_size BETWEEN 1 AND 100),updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO shared_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS shared_hour_prices(hour integer PRIMARY KEY CHECK(hour BETWEEN 0 AND 23),price_units bigint NOT NULL CHECK(price_units>0));
ALTER TABLE message_charges ADD COLUMN IF NOT EXISTS service text NOT NULL DEFAULT 'personal' CHECK(service IN ('personal','shared'));
ALTER TABLE message_charges ADD COLUMN IF NOT EXISTS price_hour integer CHECK(price_hour BETWEEN 0 AND 23);
ALTER TABLE worker_health ADD COLUMN IF NOT EXISTS max_accounts integer NOT NULL DEFAULT 5 CHECK(max_accounts BETWEEN 1 AND 10);
CREATE TABLE IF NOT EXISTS shared_health_hourly(
 worker_group text NOT NULL,hour_start timestamptz NOT NULL,total integer NOT NULL,connected integer NOT NULL,
 waiting integer NOT NULL,offline integer NOT NULL,unknown integer NOT NULL,checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(worker_group,hour_start)
);

CREATE INDEX IF NOT EXISTS accounts_personal_phone_live ON accounts ((replace(phone,'+',''))) WHERE NOT shared_pool AND deleted_at IS NULL AND phone IS NOT NULL;
