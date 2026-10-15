'use strict';
const crypto = require('node:crypto');
const {rateLimit} = require('express-rate-limit');

function publicAddress(value = 'http://localhost:3000') {
  let url;
  try { url = new URL(value); } catch { /* Report configuration names without their contents. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw Object.assign(new Error('PUBLIC_URL 必须为正式 HTTPS 域名，不能包含账号、路径或查询参数；本地开发可用 HTTP localhost'), {code:'STARTUP_CONFIG_INVALID'});
  }
  return url;
}
function proxyHops(value = '1') {
  if (!/^\d$/.test(String(value)) || Number(value) > 5) throw Object.assign(new Error('TRUST_PROXY_HOPS 必须为 0–5 的整数'), {code:'STARTUP_CONFIG_INVALID'});
  return Number(value);
}
const callbackPath = /^\/api\/(?:payments\/callback|banks\/feed)\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const feedReadPath = /^\/api\/banks\/feed\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\/(?:queue|receipts\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})$/i;
function signedCallback(method, pathname, headers = {}) {
  return method === 'POST' && callbackPath.test(pathname) || method === 'GET' && feedReadPath.test(pathname) && /^[\da-f]{64}$/i.test(headers['x-bank-signature'] || '');
}
function canonicalHost(req, url) {
  return url.protocol !== 'https:' || req.headers.host?.toLowerCase() === url.host.toLowerCase();
}
function canonicalLocation(url, requestPath) {
  // Assign the path to a fixed origin. A leading // or backslash can never select another host.
  const target = new URL(url.origin), split = requestPath.indexOf('?');
  target.pathname = split < 0 ? requestPath : requestPath.slice(0, split);
  target.search = split < 0 ? '' : requestPath.slice(split);
  return target.href;
}
function requireCanonicalHost(url) {
  return (req, res, next) => {
    if (canonicalHost(req, url) || (['GET','HEAD'].includes(req.method) && req.path === '/healthz') || signedCallback(req.method, req.path, req.headers)) return next();
    res.set('Cache-Control', 'no-store');
    if (['GET','HEAD'].includes(req.method)) return res.redirect(308, canonicalLocation(url, req.originalUrl));
    return res.status(421).json({error:'请通过正式网址登录和操作：' + url.origin});
  };
}
function validLoginBody(req, res, next) {
  const {username, password} = req.body || {};
  if (typeof username !== 'string' || !/^[\w.-]{3,40}$/.test(username) || typeof password !== 'string' || password.length > 200 || !password.length) return res.status(401).json({error:'账号或密码不正确'});
  next();
}
function loginAccountLimiter(options = {}) {
  return rateLimit({windowMs:15*60000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,
    // Bound and hash keys; neither usernames nor passwords enter limiter logs/storage.
    keyGenerator:req => crypto.createHash('sha256').update(req.body.username.toLowerCase()).digest('hex'),
    skipSuccessfulRequests:true,message:{error:'登录过于频繁，请稍后重试'},...options});
}
function passwordChangeLimiter() {
  return rateLimit({windowMs:15*60000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,
    keyGenerator:req=>req.user.id,skipSuccessfulRequests:true,message:{error:'密码验证过于频繁，请稍后重试'}});
}
module.exports = {publicAddress,proxyHops,signedCallback,canonicalHost,canonicalLocation,requireCanonicalHost,validLoginBody,loginAccountLimiter,passwordChangeLimiter};
