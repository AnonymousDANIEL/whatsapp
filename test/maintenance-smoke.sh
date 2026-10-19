#!/bin/bash
set -euo pipefail
umask 077
root=/tmp/maintenance-source
mkdir -p "$root/data" "$root/socket"
chown -R postgres:postgres "$root"
gosu postgres initdb -D "$root/data" --encoding=UTF8 --auth-local=trust --auth-host=scram-sha-256 >"$root/init.log" 2>&1
gosu postgres pg_ctl -D "$root/data" -l "$root/data/server.log" -o "-h '' -k $root/socket -p 55431" -w start
trap 'gosu postgres pg_ctl -D "$root/data" -m fast -w stop' EXIT
export DATABASE_URL="postgresql:///postgres?host=$root/socket&port=55431&user=postgres"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE users(id integer PRIMARY KEY, value text);
CREATE TABLE accounts(id integer PRIMARY KEY, value text);
CREATE TABLE credit_ledger(id integer PRIMARY KEY, value text);
INSERT INTO users VALUES(1,'synthetic backup sentinel');
INSERT INTO accounts VALUES(1,'synthetic account');
INSERT INTO credit_ledger VALUES(1,'synthetic ledger');
CREATE TABLE recipients(id integer PRIMARY KEY,status text);
SQL
export BACKUP_DIR=/tmp/maintenance-artifact
MAINTENANCE_MODE=backup MAINTENANCE_EXIT_AFTER_ACTION=1 /app/ops/database-maintenance-200.sh
test -s "$BACKUP_DIR/pre-200.dump"
test -s "$BACKUP_DIR/backup-verified.json"
grep -q '"restore_verified":true' "$BACKUP_DIR/backup-verified.json"
before=$(sha256sum "$BACKUP_DIR/pre-200.dump")
MAINTENANCE_MODE=backup MAINTENANCE_EXIT_AFTER_ACTION=1 /app/ops/database-maintenance-200.sh
test "$before" = "$(sha256sum "$BACKUP_DIR/pre-200.dump")"
test "$(psql "$DATABASE_URL" -Atqc 'SELECT value FROM users WHERE id=1')" = 'synthetic backup sentinel'
test "$(psql "$DATABASE_URL" -Atqc 'SHOW max_connections')" = 100
MAINTENANCE_MODE=status MAINTENANCE_EXIT_AFTER_ACTION=1 /app/ops/database-maintenance-200.sh
DATABASE_URL='' MAINTENANCE_MODE=standby MAINTENANCE_EXIT_AFTER_ACTION=1 /app/ops/database-maintenance-200.sh
echo 'Maintenance backup smoke PASS: actual private dump and full restore, repeat does not overwrite, source data/settings unchanged; network disabled'
