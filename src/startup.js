'use strict';

function validateStartupEnvironment(env) {
  const issues = [];
  if (!env.DATABASE_URL?.trim()) issues.push('缺少 DATABASE_URL：请引用同一 Railway 项目和环境中的 PostgreSQL 服务变量');
  else {
    try {
      const url = new URL(env.DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid database URL');
    } catch {
      issues.push('DATABASE_URL 格式无效：需要 PostgreSQL 连接字符串；检查变量引用是否已解析');
    }
  }
  if (!['api', 'worker'].includes(env.SERVICE_ROLE)) issues.push('SERVICE_ROLE 必须为 api 或 worker');
  if ((env.INTERNAL_SECRET || '').length < 32) issues.push('INTERNAL_SECRET 至少需要 32 位；API 与 worker 使用同一个随机密钥');
  if (issues.length) throw Object.assign(new Error(issues.join('；')), { code: 'STARTUP_CONFIG_INVALID' });
}

function redactMessage(message, env) {
  const secrets = Object.entries(env)
    .filter(([key, value]) => value && (key === 'DATABASE_URL' || /password|secret|token|(?:private|api)[_-]?key/i.test(key)))
    .map(([, value]) => String(value));
  try {
    const password = new URL(env.DATABASE_URL).password;
    if (password) secrets.push(password, decodeURIComponent(password));
  } catch { /* Configuration validation reports invalid URLs without printing their values. */ }
  let value = String(message || '');
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) value = value.split(secret).join('[redacted]');
  return value.replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s'"<>]+/gi, '[redacted URL]').replace(/[\r\n\t]/g, ' ').slice(0, 500);
}

function describeStartupError(error, stage, env = process.env) {
  // Node's multi-address connection failure can have an empty message and nested errors.
  const pending = [error], visited = new Set(), codes = [], messages = [];
  while (pending.length && visited.size < 16) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (typeof current.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(current.code)) codes.push(current.code);
    if (current.message) messages.push(redactMessage(current.message, env));
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 8));
    if (current.cause) pending.push(current.cause);
  }
  const uniqueCodes = [...new Set(codes)];
  const has = (...values) => uniqueCodes.some(code => values.includes(code));
  let reason = [...new Set(messages)].slice(0, 5).join(' | ') || '启动失败，错误没有提供文字说明';
  let hint = stage === 'database'
    ? '检查 PostgreSQL 服务是否运行，以及 DATABASE_URL 是否引用同一项目和环境的数据库。'
    : '检查当前服务的环境变量和部署日志。';
  if (has('STARTUP_CONFIG_INVALID')) hint = '在 whatsapp 服务的 Variables 补齐配置，保存后部署；不要把密码或密钥提交到 GitHub。';
  else if (has('ECONNREFUSED')) {
    reason = 'PostgreSQL 连接被拒绝';
    hint = '确认 PostgreSQL 已启动，并引用它的 DATABASE_URL；应用容器的 localhost 不是独立的数据库服务。';
  } else if (has('ENOTFOUND', 'EAI_AGAIN')) {
    reason = '数据库主机名无法解析';
    hint = '检查 DATABASE_URL 引用、数据库所在项目和环境；Railway 私有域名必须在对应私有网络内使用。';
  } else if (has('ETIMEDOUT', 'ECONNRESET', 'EPIPE')) {
    reason = '数据库连接超时或中断';
    hint = '检查数据库运行状态、私有网络、连接地址和端口。';
  } else if (has('28P01', '28000')) {
    reason = 'PostgreSQL 登录验证失败';
    hint = '重新引用数据库服务的 DATABASE_URL，检查凭据是否已更换；不要手工使用示例密码。';
  } else if (has('3D000')) {
    reason = 'DATABASE_URL 指定的数据库不存在';
    hint = '使用 PostgreSQL 服务实际提供的 DATABASE_URL，检查数据库名称。';
  } else if (has('42501')) {
    reason = '数据库账号没有初始化表结构的权限';
    hint = '使用具备本应用数据库建表权限的账号；不要通过删除数据库解决。';
  } else if (has('57P03')) {
    reason = 'PostgreSQL 尚未准备好接受连接';
    hint = '等待数据库启动完成后，再重新部署应用。';
  } else if (messages.some(message => /BOOTSTRAP_USERNAME|BOOTSTRAP_PASSWORD/.test(message))) {
    hint = '首次初始化需要 Owner 登录 ID 和至少 12 位密码；在 API 服务的 Variables 配置 BOOTSTRAP_USERNAME、BOOTSTRAP_PASSWORD。';
  }
  return 'Startup failed: ' + JSON.stringify({ stage, codes: uniqueCodes.length ? uniqueCodes : ['UNKNOWN'], reason, hint });
}

module.exports = { validateStartupEnvironment, describeStartupError };
