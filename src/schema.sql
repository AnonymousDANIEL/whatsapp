CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','manager','staff')), manager_id uuid REFERENCES users(id),
 permissions text[] NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
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
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check CHECK(kind IN ('hold','charged','refunded','adjustment','online_topup'));
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS order_id uuid UNIQUE REFERENCES topup_orders(id);
CREATE INDEX IF NOT EXISTS orders_user ON topup_orders(user_id,created_at DESC);
