'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeStartupError } = require('../src/startup');
const main = path.resolve(__dirname, '../src/main.js');

function run(env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-startup-test-'));
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (/^(DATABASE_URL|TEST_DATABASE_URL|SERVICE_ROLE|INTERNAL_SECRET|BOOTSTRAP_|PG|DOTENV)/.test(key)) delete clean[key];
  try {
    const result = spawnSync(process.execPath, [main], { cwd, env: { ...clean, ...env }, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const lines = result.stderr.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('Startup failed: '));
    return { output: result.stderr, report: JSON.parse(lines[0].slice('Startup failed: '.length)) };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

test('missing Railway configuration reports all required settings before connecting', () => {
  const { report } = run({});
  assert.equal(report.stage, 'configuration');
  for (const key of ['DATABASE_URL', 'SERVICE_ROLE', 'INTERNAL_SECRET']) assert.ok(report.reason.includes(key));
});

test('a real refused PostgreSQL connection reports a code and remedy without exposing credentials', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const password = 'diagnostic-password-only';
  const secret = 'diagnostic-internal-secret-with-thirty-two-characters';
  const url = `postgresql://diagnostic:${password}@localhost:${port}/test`;
  const { output, report } = run({ SERVICE_ROLE: 'api', DATABASE_URL: url, INTERNAL_SECRET: secret });
  assert.equal(report.stage, 'database');
  assert.ok(report.codes.includes('ECONNREFUSED'));
  assert.ok(report.reason.length > 0);
  assert.ok(report.hint.includes('DATABASE_URL'));
  for (const value of [url, password, secret]) assert.ok(!output.includes(value));
});

test('an invalid connection URL fails before loading PostgreSQL and never prints its value', () => {
  const url = 'https://diagnostic:do-not-print-this-password@example.invalid';
  const { output, report } = run({ SERVICE_ROLE: 'api', DATABASE_URL: url, INTERNAL_SECRET: 'diagnostic-key-at-least-32-characters' });
  assert.equal(report.stage, 'configuration');
  assert.ok(report.reason.includes('DATABASE_URL'));
  assert.ok(!output.includes(url));
  assert.ok(!output.includes('do-not-print-this-password'));
});

test('nested startup exceptions redact URL passwords, tokens and multiline secrets', () => {
  const password = 'private password';
  const url = 'postgresql://owner:private%20password@example.invalid/test';
  const secret = 'an-internal-secret-with-thirty-two-characters';
  const token = 'private-api-token';
  const child = new Error(`Parser rejected ${url}\n${password} ${secret} ${token}`);
  const error = new AggregateError([child]);
  error.cause = error;
  const output = describeStartupError(error, 'database', { DATABASE_URL: url, INTERNAL_SECRET: secret, API_TOKEN: token });
  for (const value of [url, password, 'private%20password', secret, token]) assert.ok(!output.includes(value));
  assert.ok(!output.includes('\n'));
  assert.ok(output.includes('[redacted]'));
});
