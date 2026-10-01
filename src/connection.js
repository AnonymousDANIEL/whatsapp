'use strict';
const messages = {
  WORKER_NOT_CONFIGURED: '此账号的扫码服务尚未配置，请管理员配置对应浏览器分组。',
  WORKER_ROUTE_INVALID: '扫码服务地址配置无效，请管理员检查浏览器分组地址。',
  WORKER_UNREACHABLE: '无法连接扫码服务，请管理员确认浏览器服务已运行、私有地址和端口正确。',
  WORKER_AUTH_FAILED: '扫码服务验证失败，请管理员确认管理服务与浏览器服务的 INTERNAL_SECRET 相同。',
  WORKER_GROUP_MISMATCH: '连接到了其他浏览器分组，请管理员修正此账号分组的连接地址。',
  WORKER_RESPONSE_INVALID: '扫码服务返回异常，请管理员确认连接地址指向浏览器服务。',
  WORKER_UPDATE_REQUIRED: '扫码服务版本不一致或账号分组不匹配，请管理员更新浏览器服务并检查分组。',
  BROWSER_START_FAILED: '浏览器没有启动成功，请管理员查看对应浏览器服务的日志。',
  WORKER_BUSY: '浏览器分组已满或账号正在发送，请稍后重试或使用其他分组。'
};
function connectionError(code, status = 503) {
  return Object.assign(new Error(messages[code]), { code, status, publicMessage: true });
}
function createWorkerConnection(routes, secret, timeout = 10000) {
  async function request(account, path, method = 'GET') {
    const base = routes[account.worker_group];
    if (!base) throw connectionError('WORKER_NOT_CONFIGURED');
    let target;
    try {
      target = new URL(path, base);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw Error('Invalid route');
    } catch { throw connectionError('WORKER_ROUTE_INVALID'); }
    let response;
    try { response = await fetch(target, { method, headers: { Authorization: 'Bearer ' + secret }, redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
    catch { throw connectionError('WORKER_UNREACHABLE'); }
    if (response.status === 401 || response.status === 403) throw connectionError('WORKER_AUTH_FAILED');
    if (response.status === 404) throw connectionError('WORKER_UPDATE_REQUIRED');
    if (response.status === 409) throw connectionError('WORKER_BUSY', 409);
    let result;
    try { result = await response.json(); } catch { throw connectionError('WORKER_RESPONSE_INVALID'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw connectionError('WORKER_RESPONSE_INVALID');
    if (result.role === 'worker' && result.group !== account.worker_group) throw connectionError('WORKER_GROUP_MISMATCH');
    if (!response.ok) throw connectionError(method === 'POST' ? 'BROWSER_START_FAILED' : 'WORKER_RESPONSE_INVALID');
    if (method === 'POST' && result.ok !== true) throw connectionError('BROWSER_START_FAILED');
    return result;
  }
  async function status(account) {
    const result = await request(account, '/accounts/' + account.id + '/status');
    if (result.role !== 'worker' || typeof result.screen_ready !== 'boolean' || typeof result.connected !== 'boolean') throw connectionError('WORKER_RESPONSE_INVALID');
    return result;
  }
  return { request, status };
}
module.exports = { createWorkerConnection, connectionError };
