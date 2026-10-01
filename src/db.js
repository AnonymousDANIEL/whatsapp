'use strict';
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { assert } = require('./domain');
assert(process.env.DATABASE_URL, '缺少 DATABASE_URL', 500);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_SIZE || 15), connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
pool.on('error', e => console.error('database pool:', e.code || e.name));
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(194812733)');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    if (process.env.SERVICE_ROLE === 'api' && !(await client.query('SELECT 1 FROM users LIMIT 1')).rowCount) {
      assert(/^[\w.-]{3,40}$/.test(process.env.BOOTSTRAP_USERNAME || ''), '首次启动需要 BOOTSTRAP_USERNAME', 500);
      assert((process.env.BOOTSTRAP_PASSWORD || '').length >= 12, '首次启动需要至少 12 位 BOOTSTRAP_PASSWORD', 500);
      await client.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)', [randomUUID(), process.env.BOOTSTRAP_USERNAME, await bcrypt.hash(process.env.BOOTSTRAP_PASSWORD, 12), 'owner']);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
async function audit(userId, action, entityId, details = {}) {
  await pool.query('INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,$2,$3,$4)', [userId, action, entityId, details]);
}
async function transaction(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
module.exports = { pool, migrate, audit, transaction };
