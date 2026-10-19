#!/bin/bash
set -euo pipefail
umask 077
stage=initialization
trap 'printf "MAINTENANCE_ACTION_FAILED stage=%s status=%s\n" "$stage" "$?" >&2' ERR

mode=${MAINTENANCE_MODE:-backup}
root=${BACKUP_DIR:-/backup}
case "$root" in /backup|/tmp/maintenance-*) ;; *) echo 'Invalid maintenance backup directory' >&2; exit 1;; esac
mkdir -p "$root"
chmod 0711 "$root"

diagnostics() {
  psql "$DATABASE_URL" --no-psqlrc -v ON_ERROR_STOP=1 -Atqc "SELECT json_build_object(
    'server_version',current_setting('server_version'),
    'max_connections',current_setting('max_connections')::int,
    'reserved',current_setting('superuser_reserved_connections')::int+COALESCE(NULLIF(current_setting('reserved_connections',true),''),'0')::int,
    'current_connections',(SELECT count(*) FROM pg_stat_activity),
    'data_directory',current_setting('data_directory'),
    'ssl',current_setting('ssl'),
    'wrapper_exists',COALESCE((pg_stat_file('/usr/local/bin/wrapper.sh',true)).size>0,false),
    'wrapper_accepts_args',CASE WHEN (pg_stat_file('/usr/local/bin/wrapper.sh',true)).size>0 THEN position(chr(34)||chr(36)||'@'||chr(34) in pg_read_file('/usr/local/bin/wrapper.sh'))>0 ELSE false END,
    'tini_exists',COALESCE((pg_stat_file('/usr/bin/tini',true)).size>0,false),
    'extensions',(SELECT json_agg(extname ORDER BY extname) FROM pg_extension),
    'sending',(SELECT count(*) FROM recipients WHERE status='sending'),
    'awaiting_ack',(SELECT count(*) FROM recipients WHERE status='awaiting_ack')
  )" 2>"$root/diagnostics.stderr"
}

case "$mode" in
  backup)
    : "${DATABASE_URL:?Database reference is required}"
    if [ ! -s "$root/backup-verified.json" ]; then
      stage=database-read
      diagnostics >"$root/database-before.json"
      stage=archive-dump
      pg_dump "$DATABASE_URL" --format=custom --no-owner --file="$root/pre-200.dump.tmp" 2>"$root/dump.stderr"
      stage=archive-list
      pg_restore --list "$root/pre-200.dump.tmp" >"$root/pre-200.toc" 2>"$root/archive.stderr"
      mv "$root/pre-200.dump.tmp" "$root/pre-200.dump"
      stage=globals-dump
      pg_dumpall --dbname="$DATABASE_URL" --globals-only >"$root/globals.sql" 2>"$root/globals.stderr"

      checkdata="$root/restore-check-$(date -u +%Y%m%d%H%M%S)"
      checksock="$root/check-socket"
      mkdir -p "$checkdata" "$checksock"
      chown postgres:postgres "$checkdata" "$checksock"
      cleanup() { gosu postgres pg_ctl -D "$checkdata" -m fast -w stop >>"$root/restore-server.log" 2>&1 || true; }
      trap cleanup EXIT
      stage=restore-init
      gosu postgres initdb -D "$checkdata" --encoding=UTF8 --auth-local=trust --auth-host=scram-sha-256 >"$root/restore-init.log" 2>&1
      stage=restore-start
      gosu postgres pg_ctl -D "$checkdata" -l "$checkdata/server.log" -o "-h '' -k $checksock -p 55432" -w start >"$root/restore-server.log" 2>&1
      stage=restore-load
      pg_restore --exit-on-error --no-owner --no-privileges --dbname="host=$checksock port=55432 user=postgres dbname=postgres" "$root/pre-200.dump" >"$root/restore.stdout" 2>"$root/restore.stderr"
      stage=restore-check
      tables=$(psql "host=$checksock port=55432 user=postgres dbname=postgres" --no-psqlrc -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
      valid=$(psql "host=$checksock port=55432 user=postgres dbname=postgres" --no-psqlrc -v ON_ERROR_STOP=1 -Atqc "SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.accounts') IS NOT NULL AND to_regclass('public.credit_ledger') IS NOT NULL")
      [ "$valid" = t ]
      cleanup
      trap - EXIT
      hash=$(sha256sum "$root/pre-200.dump" | cut -d ' ' -f 1)
      bytes=$(stat -c %s "$root/pre-200.dump")
      printf '{"archive":"pre-200.dump","sha256":"%s","bytes":%s,"restored_public_tables":%s,"restore_verified":true,"at":"%s"}\n' "$hash" "$bytes" "$tables" "$(date -u +%FT%TZ)" >"$root/backup-verified.json"
    fi
    echo 'BACKUP_VERIFIED_V1'
    cat "$root/backup-verified.json"
    echo 'DATABASE_BEFORE_V1'
    cat "$root/database-before.json"
    ;;
  status)
    : "${DATABASE_URL:?Database reference is required}"
    echo 'DATABASE_STATUS_V1'
    diagnostics
    ;;
  standby)
    echo 'PRIVATE_BACKUP_STANDBY_V1'
    ;;
  *) echo 'Unsupported maintenance mode' >&2; exit 1;;
esac
if [ "${MAINTENANCE_EXIT_AFTER_ACTION:-0}" = 1 ]; then exit 0; fi
exec sleep infinity
