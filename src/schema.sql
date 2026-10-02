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
