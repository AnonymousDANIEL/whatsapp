'use strict';
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { assert } = require('./domain');
assert(process.env.DATABASE_URL, '缺少 DATABASE_URL', 500);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_SIZE || (process.env.SERVICE_ROLE==='worker'?5:15)), connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
pool.on('error', e => console.error('database pool:', e.code || e.name));
async function migrateAttempt(schema, marker, reuseSchema, attempt) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(194812733)');
    // Yield this transaction before the deadlock detector can choose a live
    // reader as its victim. Never retry a message send or wallet transaction.
    await client.query("SET LOCAL lock_timeout = '250ms'");
    let applied = true;
    if (reuseSchema && (await client.query("SELECT to_regclass('app_migrations') AS name")).rows[0].name) {
      applied = !(await client.query('SELECT 1 FROM app_migrations WHERE name=$1', [marker])).rowCount;
    }
    if (applied) {
      await client.query(schema);
      await client.query('INSERT INTO app_migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [marker]);
    }
    if (process.env.SERVICE_ROLE === 'api' && !(await client.query('SELECT 1 FROM users LIMIT 1')).rowCount) {
      assert(/^[\w.-]{3,40}$/.test(process.env.BOOTSTRAP_USERNAME || ''), '首次启动需要 BOOTSTRAP_USERNAME', 500);
      assert((process.env.BOOTSTRAP_PASSWORD || '').length >= 12, '首次启动需要至少 12 位 BOOTSTRAP_PASSWORD', 500);
      await client.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)', [randomUUID(), process.env.BOOTSTRAP_USERNAME, await bcrypt.hash(process.env.BOOTSTRAP_PASSWORD, 12), 'owner']);
    }
    await client.query('COMMIT');
    return { version: 1, action: applied ? 'applied' : 'verified', attempts: attempt };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}
async function migrate({ reuseSchema = false } = {}) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const marker = 'startup_schema_sha256_v1:' + createHash('sha256').update(schema).digest('hex');
  for (let attempt = 1; attempt <= 20; attempt++) {
    try { return await migrateAttempt(schema, marker, reuseSchema, attempt); }
    catch (e) {
      if (!['55P03', '40P01'].includes(e.code) || attempt === 20) throw e;
      await new Promise(resolve => setTimeout(resolve, 100 + Math.floor(Math.random() * 150)));
    }
  }
}
// Production restarts verify the exact installed schema instead of acquiring
// ALTER TABLE locks on all application tables on every worker boot. Explicit
// migrate() retains the existing full migration behavior for upgrades/imports.
async function migrateStartup() { return migrate({ reuseSchema: true }); }
async function audit(userId, action, entityId, details = {}) {
  await pool.query('INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,$2,$3,$4)', [userId, action, entityId, details]);
}
async function transaction(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
module.exports = { pool, migrate, migrateStartup, audit, transaction };
