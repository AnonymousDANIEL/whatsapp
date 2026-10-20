'use strict';
const {validateImage}=require('./media');
const express = require('express');
const billing=require('./billing');
const payments=require('./payments'),vault=require('./secrets'),banks=require('./banks');
const shared=require('./shared');
const allocation=require('./account-allocation');
const capacity=require('./capacity');
const overview=require('./overview');
const ownerHistory=require('./owner-history'),sharedConsole=require('./shared-console');
const sharedAccounts=require('./shared-accounts');
const connectionFailures=require('./connection-failures');
const automaticRefunds=require('./automatic-refunds');
const http = require('node:http');
const {monitorSockets}=require('./socket-health');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { WebSocket, WebSocketServer } = require('ws');
const { pool, audit, transaction } = require('./db');
const { assert, hash, PERMISSIONS, parseRecipients, validateSchedule, validatePacing, permission, manageUser, csvCell } = require('./domain');
const { createWorkerConnection } = require('./connection');
const security = require('./http-security');
const requestBody = require('./request-body');
const loginHistory = require('./login-history');

const SESSION_HOURS = 168;
const {routes,sharedGroups}=require('./shared-routing').routingConfiguration(process.env);
const sharedOnly=new Set(sharedGroups),poolRoutes=Object.fromEntries(sharedGroups.map(g=>[g,routes[g]]));
const browser = createWorkerConnection(routes, process.env.INTERNAL_SECRET);
const personalGroups=Object.keys(routes).filter(g=>!sharedOnly.has(g));
const rebalanceAccounts=allocation.createRebalancer(routes,browser,personalGroups);
const COOKIE = 'wa_session';
const publicURL = security.publicAddress(process.env.PUBLIC_URL);
const secure = publicURL.protocol === 'https:';
const uuid = value => { assert(/^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(value), 'ID 无效'); return value; };
function cookieToken(req) {
  const match = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='));
  return match?.slice(COOKIE.length + 1);
}
async function getSession(req) {
  const token = cookieToken(req);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await pool.query(`SELECT u.id,u.username,u.role,u.permissions,u.active,u.locked,u.account_limit,s.csrf,s.token_hash,s.password_reveal_until
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active AND NOT u.locked`, [hash(token)]);
  const user = rows[0];
  return user;
}
function route(fn) { return (req, res, next) => Promise.resolve(fn(req, res)).catch(next); }
function sessionCookie(res, token) { res.cookie(COOKIE, token, { httpOnly: true, secure, sameSite: 'strict', maxAge: SESSION_HOURS * 3600000, path: '/' }); }
function publicUser(u) { return { id: u.id, username: u.username, role: u.role, manager_id: u.manager_id, permissions: u.permissions, active: u.active, account_limit:u.account_limit }; }
function userRemark(value){assert(typeof value==='string'&&value.length<=2000,'资料备注最多 2000 个字符');return value.trim();}
function userAccess(body,current={active:true,locked:false}){const active=body.active===undefined?current.active:body.active,locked=active?(body.locked===undefined?current.locked:body.locked):false;assert(typeof active==='boolean','请选择 Active/Inactive');assert(body.locked===undefined||typeof body.locked==='boolean','锁定状态无效');assert(!(body.active===false&&body.locked===true),'锁定和停用状态不能同时设置');return {active,locked};}
async function access(user, id, operate = false) {
  uuid(id);
  const a = (await pool.query(`SELECT a.*,($2='owner') AS operate FROM accounts a
    WHERE a.id=$1 AND ($2='owner' OR (NOT a.shared_pool AND EXISTS(SELECT 1 FROM account_grants WHERE account_id=a.id AND user_id=$3)))`, [id,user.role,user.id])).rows[0];
  assert(a && (!a.deleted_at || (user.role==='owner'&&!operate)), '无权操作此 WhatsApp 账号',403); return a;
}
async function visibleAccounts(user) {
  const {rows}=await pool.query(`SELECT a.*,($1='owner') AS operate,h.heartbeat_at AS worker_heartbeat_at,
    CASE WHEN $1='owner' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'username',u.username,'active',u.active) ORDER BY u.username)
      FROM account_grants g JOIN users u ON u.id=g.user_id WHERE g.account_id=a.id AND u.role='user'),'[]'::jsonb) ELSE NULL END AS assigned_users
    FROM accounts a LEFT JOIN worker_health h ON h.worker_group=a.worker_group
    WHERE NOT a.shared_pool AND ($1='owner' OR (a.deleted_at IS NULL AND EXISTS(SELECT 1 FROM account_grants WHERE account_id=a.id AND user_id=$2)))
    ORDER BY a.created_at`,[user.role,user.id]);
  return rows.map(a=>{
    const status=a.enabled&&(!a.worker_heartbeat_at||Date.now()-+new Date(a.worker_heartbeat_at)>90000)?'worker_offline':a.status;
    return {...a,status,phone:a.enabled&&!a.deleted_at&&status==='ready'?a.phone:null};
  });
}
async function visibleAccountIds(user,includeDeleted=true){
 return (await pool.query(`SELECT a.id FROM accounts a WHERE NOT a.shared_pool AND (a.deleted_at IS NULL OR ($1='owner' AND $3))
  AND ($1='owner' OR EXISTS(SELECT 1 FROM account_grants g WHERE g.account_id=a.id AND g.user_id=$2))`,[user.role,user.id,includeDeleted])).rows.map(a=>a.id);
}
async function campaignAccess(user, id, modify = false) {
  uuid(id);
  const c = (await pool.query('SELECT * FROM campaigns WHERE id=$1', [id])).rows[0];
  assert(c && (!c.deleted_at || user.role==='owner'), '任务不存在', 404);
  if(c.shared_pool&&user.role!=='owner'){
    assert(c.created_by===user.id,'无权查看此共享任务',403);assert(!modify,'只有 Owner 可以管理共享发送任务',403);return c;
  }
  assert(!modify||user.role==='owner'||c.created_by===user.id,'只能修改自己创建的发送任务',403);
  await access(user, c.account_id, modify);
  assert(!modify || !c.deleted_at, '任务已删除', 409);
  return c;
}
async function grantsFor(actor, grants) {
  assert(Array.isArray(grants) && grants.length <= 200, '账号权限列表无效');
  for (const g of grants) { assert(typeof g.operate === 'boolean', '账号操作权限无效'); const a=await access(actor, g.account_id, g.operate);assert(!a.shared_pool,'共享账号不能分配登录权限',403); }
  return [...new Map(grants.map(g => [g.account_id, g])).values()];
}
function permissionsFor(actor, values) {
  assert(Array.isArray(values) && values.every(p => PERMISSIONS.includes(p) && permission(actor, p)), '不能授予自己没有的权限', 403);
  return [...new Set(values)];
}
async function workerCommand(account, command) {
  return browser.request(account, '/accounts/' + account.id + '/' + command, 'POST');
}
// API-owned metadata migration: shared worker schema files stay unchanged so
// linked browser workers do not redeploy for this Owner-only display feature.
async function ensureLoginActivity() {
  const ready=async c=>{
    const {rows}=await c.query(`SELECT
      EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='users'::regclass AND attname='last_login_at' AND NOT attisdropped) AS field,
      EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='audit'::regclass AND tgname='wa_capture_login_at_v1' AND NOT tgisinternal AND tgenabled='O') AS capture`);
    return rows[0].field&&rows[0].capture;
  };
  if(await ready(pool))return;
  await transaction(async c=>{
    await c.query("SET LOCAL lock_timeout='10s'");
    await c.query("SET LOCAL statement_timeout='60s'");
    await c.query('SELECT pg_advisory_xact_lock(194812733)');
    if(await ready(c))return;
    await c.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz');
    // Capture the existing successful-login audit event, including requests
    // served by an older API replica during a rolling release or rollback.
    await c.query(`CREATE OR REPLACE FUNCTION wa_capture_login_at_v1() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE users SET last_login_at=NEW.created_at
          WHERE id=NEW.actor_id AND (last_login_at IS NULL OR last_login_at<NEW.created_at);
        RETURN NEW;
      END;
    $$`);
    await c.query(`CREATE OR REPLACE TRIGGER wa_capture_login_at_v1 AFTER INSERT ON audit FOR EACH ROW
      WHEN (NEW.action='login' AND NEW.actor_id IS NOT NULL) EXECUTE FUNCTION wa_capture_login_at_v1()`);
    await c.query(`UPDATE users u SET last_login_at=l.last_login_at FROM
      (SELECT actor_id,max(created_at) AS last_login_at FROM audit WHERE action='login' AND actor_id IS NOT NULL GROUP BY actor_id) l
      WHERE u.id=l.actor_id AND (u.last_login_at IS NULL OR u.last_login_at<l.last_login_at)`);
  });
}
async function start({connectionMonitorIntervalMs=5000,refundMonitorIntervalMs=5000,loginMonitorIntervalMs=15000}={}) {
  await ensureLoginActivity();
  await loginHistory.ensure(pool);
  console.log('Login history ready: '+JSON.stringify({version:1,owner_only:true,source:process.env.RAILWAY_ENVIRONMENT_ID&&process.env.RAILWAY_SERVICE_ID?'railway_edge':'direct_socket',lookup_key_configured:!!process.env.LOGIN_IP_LOOKUP_KEY}));
  await sharedConsole.ensureOptions();
  await sharedAccounts.ensureLinking();
  console.log('Login activity metadata ready: v1');
  console.log('Shared console ready: '+JSON.stringify({dedicated_groups:sharedGroups.length}));
  const app = express();
  app.set('trust proxy', security.proxyHops(process.env.TRUST_PROXY_HOPS));
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], frameSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'self'"] } }, crossOriginEmbedderPolicy: false }));
  app.use((req,res,next)=>{res.set('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()');next();});
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(security.requireCanonicalHost(publicURL));
  app.get('/healthz', route(async (_, res) => { await pool.query('SELECT 1'); res.json({ ok: true, role: 'api' }); }));
  const limiter = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '登录过于频繁，请稍后重试' } });
  const dummyHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  app.post('/api/login', limiter, (req,res,next)=>req.headers.origin===publicURL.origin?next():res.status(403).json({error:'来源不正确'}), requestBody.loginJSON, security.validLoginBody, security.loginAccountLimiter(), route(async (req, res) => {
    assert(req.headers.origin === publicURL.origin, '来源不正确', 403);
    const { username, password } = req.body;
    assert(typeof username === 'string' && typeof password === 'string' && password.length <= 200, '账号或密码不正确', 401);
    const u = (await pool.query('SELECT * FROM users WHERE username=$1', [username])).rows[0];
    const valid = await bcrypt.compare(password, u?.password_hash || dummyHash);
    const parentOK = true;
    assert(u && u.active && !u.locked && parentOK && valid, '账号或密码不正确，或账号已停用或锁定', 401);
    const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
    const network=loginHistory.requestContext(req);
    await transaction(async c=>{
      const current=(await c.query('SELECT active,locked FROM users WHERE id=$1 FOR UPDATE',[u.id])).rows[0];
      assert(current?.active&&!current.locked,'账号或密码不正确，或账号已停用或锁定',401);
      await c.query(`INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '168 hours')`,[hash(token),u.id,csrf]);
      await c.query("INSERT INTO audit(actor_id,action,entity_id,details,created_at) VALUES($1::uuid,'login',$1::text,$2,clock_timestamp())",[u.id,{login_network:network}]);
    });
    sessionCookie(res, token); res.json({ ok: true });
  }));
  requestBody.publicCallbacks(app);
  payments.callbackRoutes(app,route,uuid);
  banks.callbackRoutes(app,route);
  requestBody.protectedAPI(app, (req, res, next) => {
    getSession(req).then(user => {
      assert(user, '登录已过期，或账号已停用', 401); req.user = user;
      if (!['GET', 'HEAD'].includes(req.method)) assert(req.headers.origin === publicURL.origin && req.headers['x-csrf-token'] === user.csrf, '安全验证失败，请重新登录', 403);
      next();
    }).catch(next);
  });
  app.get('/api/me', route(async (req, res) => res.json({ user: publicUser(req.user), csrf: req.user.csrf, permissions: PERMISSIONS, worker_groups: Object.keys(routes).filter(g=>!sharedOnly.has(g)), server_time: new Date().toISOString(), timezone:'Asia/Kuala_Lumpur',password_access:!!(req.user.role==='owner'&&req.user.password_reveal_until&&new Date(req.user.password_reveal_until)>new Date()) })));
  app.post('/api/logout', route(async (req, res) => { await pool.query('DELETE FROM sessions WHERE token_hash=$1', [req.user.token_hash]); res.clearCookie(COOKIE, { path: '/', secure, sameSite: 'strict' }); res.json({ ok: true }); }));
  app.post('/api/password', security.passwordChangeLimiter(), route(async (req, res) => {
    assert(req.user.role === 'owner', '只有 Owner 可以修改密码', 403);
    assert(typeof req.body.password === 'string' && req.body.password.length >= 12 && req.body.password.length <= 200, '新密码需要 12–200 个字符');
    const row = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
    assert(typeof req.body.current_password==='string'&&req.body.current_password.length<=200&&await bcrypt.compare(req.body.current_password, row.password_hash), '原密码不正确', 403);
    await transaction(async c => { await c.query('UPDATE users SET password_hash=$1,password_cipher=NULL,password_changed_at=now() WHERE id=$2', [await bcrypt.hash(req.body.password, 12), req.user.id]); await c.query('DELETE FROM sessions WHERE user_id=$1', [req.user.id]); });
    await audit(req.user.id, 'password.change', req.user.id); res.json({ ok: true });
  }));
  automaticRefunds.routes(app,route,uuid);
  billing.routes(app,route,uuid);
  payments.routes(app,route,uuid);
  banks.routes(app,route);
  sharedConsole.routes(app,route,poolRoutes);
  sharedAccounts.routes(app,route,poolRoutes,workerCommand);
  ownerHistory.routes(app,route);
  shared.routes(app,route,uuid,poolRoutes,workerCommand);
  app.get('/api/notice',route(async(req,res)=>{
    const notice=(await pool.query('SELECT enabled,content_zh,content_en,updated_at FROM workspace_notice WHERE id=1')).rows[0];
    res.json(req.user.role==='owner'||notice.enabled?notice:{enabled:false,content_zh:'',content_en:'',updated_at:null});
  }));
  app.put('/api/notice',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以管理公告',403);
    const b=req.body;
    assert(typeof b.enabled==='boolean'&&typeof b.content_zh==='string'&&typeof b.content_en==='string'&&b.content_zh.length<=6000&&b.content_en.length<=6000,'公告内容无效');
    const zh=b.content_zh.trim(),en=b.content_en.trim();assert(!b.enabled||zh||en,'请填写公告内容');
    const notice=await transaction(async db=>{
      const row=(await db.query('UPDATE workspace_notice SET enabled=$1,content_zh=$2,content_en=$3,updated_at=now() WHERE id=1 RETURNING enabled,content_zh,content_en,updated_at',[b.enabled,zh,en])).rows[0];
      await db.query("INSERT INTO audit(actor_id,action,details) VALUES($1,'notice.update',$2)",[req.user.id,{enabled:b.enabled}]);return row;
    });res.json(notice);
  }));
  app.get('/api/accounts', route(async (req, res) => res.json(await visibleAccounts(req.user))));
  app.post('/api/accounts', route(async (req, res) => {
    assert(typeof req.body.label === 'string' && req.body.label.trim().length > 0 && req.body.label.length <= 80, '请输入账号名称');
    assert(Object.hasOwn(routes, req.body.worker_group)&&!sharedOnly.has(req.body.worker_group), '请选择已配置的浏览器分组');
    const id=crypto.randomUUID();let assignedGroup=req.body.worker_group;
    await transaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock($1)',[allocation.PLACEMENT_LOCK]);
      assignedGroup=await allocation.chooseGroup(db,personalGroups,req.user.role==='owner'?assignedGroup:null)||assignedGroup;
      if(req.user.role!=='owner'){
        const u=(await db.query('SELECT account_limit FROM users WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];
        const n=(await db.query('SELECT count(*)::int n FROM account_grants g JOIN accounts a ON a.id=g.account_id WHERE g.user_id=$1 AND a.deleted_at IS NULL',[req.user.id])).rows[0].n;
        assert(n<u.account_limit,'每个 USER 最多连接 10 个 WhatsApp 账号',409);
      }
      await db.query('INSERT INTO accounts(id,label,worker_group) VALUES($1,$2,$3)',[id,req.body.label.trim(),assignedGroup]);
      if(req.user.role!=='owner')await db.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,true)',[req.user.id,id]);
    });
    await audit(req.user.id,'account.create',id,{label:req.body.label.trim()});
    try {await workerCommand({id,worker_group:assignedGroup},'start');res.status(201).json({id,started:true});}
    catch(error){if(!error.publicMessage)throw error;res.status(201).json({id,started:false,connection:{code:error.code,message:error.message}});}
  }));
  app.get('/api/accounts/:id/connection', route(async (req, res) => {
    const operate = req.query.mode === 'operate',scan=req.query.mode==='scan', a = await access(req.user, req.params.id, operate);
    assert(req.user.role==='owner'||scan&&!operate,'USER 仅可扫码关联，不能查看聊天或操作 WhatsApp',403);
    const canStart = operate||scan;
    if(scan&&a.status==='ready')return res.json({ok:false,code:'ALREADY_LINKED',message:'WhatsApp 已连接，无需再次扫码',can_start:false});
    if (!a.enabled) return res.json({ ok: false, code: 'ACCOUNT_DISABLED', message: '此账号已停用，请管理员启用后再连接。', can_start: false });
    if (operate && (await pool.query('SELECT 1 FROM control_leases WHERE account_id=$1 AND expires_at>now() AND session_hash<>$2', [a.id, req.user.token_hash])).rowCount) {
      return res.json({ ok: false, code: 'ACCOUNT_IN_USE', message: '此账号正被其他操作窗口使用，请关闭该窗口后再连接。', can_start: false });
    }
    try {
      const connection = await browser.status(a);
      const issue=['BROWSER_RESOURCE_WAIT','BROWSER_RECOVERING'].includes(connection.code)?connection.code:'BROWSER_NOT_READY';
      res.json({ ok: connection.screen_ready&&(req.user.role==='owner'||scan&&!connection.connected||!scan&&connection.connected), code: scan&&connection.connected?'ALREADY_LINKED':connection.screen_ready ? 'SCREEN_READY' : issue, message: connection.screen_ready ? '请用手机 WhatsApp → 已关联设备 → 关联设备扫码；显示已连接后才能发送。' : '浏览器尚未准备好，请启动后重试；若仍无法打开，请管理员检查浏览器服务日志。', connected: connection.connected, status: connection.status, can_start: canStart&&issue!=='BROWSER_RESOURCE_WAIT' });
    } catch (error) {
      if (!error.publicMessage) throw error;
      res.json({ ok: false, code: error.code, message: error.message, can_start: false });
    }
  }));
  app.patch('/api/accounts/:id', route(async(req,res)=>{
    assert(req.body.enabled===undefined||req.user.role==='owner','只有 Owner 可以启用或停用 WhatsApp 账号',403);
    const a=await access(req.user,req.params.id,true);
    if(req.body.label!==undefined){
      assert(typeof req.body.label==='string'&&req.body.label.trim().length>0&&req.body.label.length<=80,'请输入账号名称');
      await pool.query('UPDATE accounts SET label=$1 WHERE id=$2',[req.body.label.trim(),a.id]);
      await audit(req.user.id,'account.rename',a.id,{before:a.label,after:req.body.label.trim()});
    }
    if(req.body.enabled!==undefined){
      assert(req.user.role==='owner','只有 Owner 可以启用或停用 WhatsApp 账号',403);
      assert(typeof req.body.enabled==='boolean','enabled 无效');
      await pool.query('UPDATE accounts SET enabled=$1 WHERE id=$2',[req.body.enabled,a.id]);
      await audit(req.user.id,'account.enabled',a.id,{enabled:req.body.enabled});
    }
    res.json({ok:true});
  }));
  app.delete('/api/accounts/:id',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以删除 WhatsApp 账号',403);
    await billing.assertNoHolds(pool,null,uuid(req.params.id));
    const a=await access(req.user,req.params.id);
    await transaction(async db=>{
      await db.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[a.id]);
      await db.query('UPDATE accounts SET enabled=false,deleted_at=COALESCE(deleted_at,now()),deleted_by=COALESCE(deleted_by,$2),purge_requested=purge_requested OR $3 WHERE id=$1',[a.id,req.user.id,req.user.role==='owner']);
      await db.query('UPDATE campaigns SET enabled=false,pause_reason=NULL WHERE account_id=$1',[a.id]);
      await db.query('DELETE FROM control_leases WHERE account_id=$1',[a.id]);
      if(req.user.role!=='owner')await db.query('INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,$2,$3,$4)',[req.user.id,'account.delete',a.id,{label:a.label}]);
    });
    res.status(202).json({ok:true,pending:req.user.role==='owner'});
  }));
  app.post('/api/accounts/:id/:command', route(async (req, res) => {

    assert(['start', 'restart'].includes(req.params.command), '指令无效');
    const a = await access(req.user, req.params.id, true); assert(a.enabled, '账号已停用');
    const result = await workerCommand(a, req.params.command); await audit(req.user.id, 'account.' + req.params.command, a.id); res.json(result);
  }));
  app.post('/api/users/password-access',rateLimit({windowMs:15*60000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,keyGenerator:req=>req.user.id}),route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以管理 USER ID',403);
    const row=(await pool.query('SELECT password_hash FROM users WHERE id=$1',[req.user.id])).rows[0];
    assert(typeof req.body.password==='string'&&req.body.password.length<=200&&await bcrypt.compare(req.body.password,row.password_hash),'Owner 密码不正确',403);
    await pool.query("UPDATE sessions SET password_reveal_until=now()+interval '5 minutes' WHERE token_hash=$1",[req.user.token_hash]);
    await audit(req.user.id,'passwords.view',null);res.json({ok:true});
  }));
  app.get('/api/users',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以管理 USER ID',403);
    if(req.query.compact==='true')return res.json((await pool.query('SELECT id,username,role FROM users ORDER BY created_at')).rows);
    const reveal=req.query.passwords==='true'&&req.user.password_reveal_until&&new Date(req.user.password_reveal_until)>new Date();
    const rows=(await pool.query(`SELECT u.id,u.username,u.role,u.active,u.locked,u.created_at,u.permissions,u.credit_units,u.account_limit,u.password_changed_at,u.password_cipher,u.remark,u.last_login_at,
      (SELECT h.ip FROM login_history h WHERE h.user_id=u.id ORDER BY h.logged_at DESC,h.id DESC LIMIT 1) AS latest_login_ip,
      (SELECT count(*)::int FROM account_grants g JOIN accounts a ON a.id=g.account_id WHERE g.user_id=u.id AND a.deleted_at IS NULL) AS account_count,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('account_id',g.account_id,'operate',true)) FROM account_grants g JOIN accounts a ON a.id=g.account_id WHERE g.user_id=u.id AND a.deleted_at IS NULL),'[]'::jsonb) grants FROM users u ORDER BY u.created_at`)).rows;
    res.json(rows.map(u=>{const cipher=u.password_cipher;delete u.password_cipher;return{...u,password_available:!!cipher,password:reveal&&u.role!=='owner'&&cipher?vault.open(cipher,'user-password:'+u.id):undefined,password_access:!!reveal};}));
  }));
  app.get('/api/users/:id/logins',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以查看登录记录',403);
    const id=uuid(req.params.id);assert((await pool.query('SELECT id FROM users WHERE id=$1',[id])).rowCount,'USER ID 不存在',404);
    res.json(await loginHistory.read(pool,id,req.query.before));
  }));
  app.post('/api/users',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以管理 USER ID',403);
    const b=req.body;assert(!b.role||b.role==='user','只能创建 USER ID');
    const remark=userRemark(b.remark===undefined?'':b.remark),status=userAccess(b);
    assert(/^[\w.-]{3,40}$/.test(b.username||''),'ID 需要 3–40 位字母、数字、点、横线或下划线');
    assert(typeof b.password==='string'&&b.password.length>=12&&b.password.length<=200,'密码需要 12–200 个字符');
    const grants=await grantsFor(req.user,(b.grants||[]).map(g=>({...g,operate:true}))),id=crypto.randomUUID();assert(grants.length<=10,'每个 USER 最多连接 10 个 WhatsApp 账号',409);
    await transaction(async db=>{
      await db.query("INSERT INTO users(id,username,password_hash,role,permissions,active,password_cipher,password_changed_at,remark,locked) VALUES($1,$2,$3,'user',$4,$5,$6,now(),$7,$8)",[id,b.username,await bcrypt.hash(b.password,12),PERMISSIONS,status.active,vault.seal(b.password,'user-password:'+id),remark,status.locked]);
      for(const g of grants)await db.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,true)',[id,g.account_id]);
    });
    await audit(req.user.id,'user.create',id,{username:b.username});res.status(201).json({id});
  }));
  app.patch('/api/users/:id/remark',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以管理 USER ID',403);
    const id=uuid(req.params.id),remark=userRemark(req.body.remark);
    const changed=await transaction(async db=>{
      const row=(await db.query("UPDATE users SET remark=$2 WHERE id=$1 AND role='user' RETURNING id,remark",[id,remark])).rows[0];
      assert(row,'无权修改此 USER ID',403);await db.query("INSERT INTO audit(actor_id,action,entity_id) VALUES($1,'user.remark',$2)",[req.user.id,id]);return row;
    });res.json(changed);
  }));
  app.patch('/api/users/:id/status',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以管理 USER ID',403);
    const id=uuid(req.params.id);assert(typeof req.body.active==='boolean','请选择 Active/Inactive');
    const changed=await transaction(async db=>{
      const previous=(await db.query("SELECT id,active,locked FROM users WHERE id=$1 AND role='user' FOR UPDATE",[id])).rows[0];
      assert(previous,'无权修改此 USER ID',403);
      const {active,locked}=userAccess(req.body,previous);
      if(previous.active===active&&previous.locked===locked)return {id,active,locked};
      await db.query('UPDATE users SET active=$2,locked=$3 WHERE id=$1',[id,active,locked]);
      if(!active||locked){
        await db.query('DELETE FROM sessions WHERE user_id=$1',[id]);
        await db.query('UPDATE campaigns SET enabled=false,pause_reason=NULL WHERE created_by=$1',[id]);
      }
      await db.query("INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,'user.status',$2,$3)",[req.user.id,id,{active,locked}]);
      return {id,active,locked};
    });res.json(changed);
  }));
  app.patch('/api/users/:id',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以管理 USER ID',403);
    const target=(await pool.query('SELECT * FROM users WHERE id=$1',[uuid(req.params.id)])).rows[0];
    assert(target&&manageUser(req.user,target),'无权修改此 USER ID',403);
    const b=req.body;assert(typeof b.active==='boolean','请选择 Active/Inactive');
    const remark=b.remark===undefined?undefined:userRemark(b.remark);
    assert(!b.password||(typeof b.password==='string'&&b.password.length>=12&&b.password.length<=200),'密码需要 12–200 个字符');
    const grants=b.grants===undefined?null:await grantsFor(req.user,b.grants.map(g=>({...g,operate:true})));
    assert(!grants||grants.length<=10,'每个 USER 最多连接 10 个 WhatsApp 账号',409);
    const status=await transaction(async db=>{
      const current=(await db.query('SELECT id,active,locked FROM users WHERE id=$1 FOR UPDATE',[target.id])).rows[0],status=userAccess(b,current);
      await db.query('UPDATE users SET active=$1,permissions=$2,locked=$4 WHERE id=$3',[status.active,PERMISSIONS,target.id,status.locked]);
      if(remark!==undefined)await db.query('UPDATE users SET remark=$1 WHERE id=$2',[remark,target.id]);
      if(b.password)await db.query('UPDATE users SET password_hash=$1,password_cipher=$3,password_changed_at=now() WHERE id=$2',[await bcrypt.hash(b.password,12),target.id,vault.seal(b.password,'user-password:'+target.id)]);
      if(grants){await db.query('DELETE FROM account_grants WHERE user_id=$1',[target.id]);for(const g of grants)await db.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,true)',[target.id,g.account_id]);}
      if(!status.active||status.locked||b.password)await db.query('DELETE FROM sessions WHERE user_id=$1',[target.id]);
      if(!status.active||status.locked)await db.query('UPDATE campaigns SET enabled=false,pause_reason=NULL WHERE created_by=$1',[target.id]);
      return status;
    });
    await audit(req.user.id,'user.update',target.id,{...status,password_changed:!!b.password,grants:grants?.map(g=>g.account_id)});res.json({ok:true});
  }));
  app.get('/api/campaigns', route(async (req, res) => {
    const ids = await visibleAccountIds(req.user);
    const { rows } = await pool.query(`SELECT c.id,c.account_id,c.created_by,c.title,c.body,c.enabled,c.pause_reason,c.cancelled,c.send_now,c.timezone,c.window_start,c.window_end,c.weekdays,c.scheduled_at,c.expires_at,c.interval_ms,c.batch_size,c.deleted_at,c.created_at,COALESCE(c.operation_at,c.created_at) AS operation_at,(c.media IS NOT NULL) AS has_image,a.label AS account_label,u.username AS creator,
      (SELECT jsonb_object_agg(t.status,t.n) FROM (SELECT status,count(*)::integer n FROM recipients WHERE campaign_id=c.id GROUP BY status) t) AS counts
      FROM campaigns c JOIN accounts a ON a.id=c.account_id JOIN users u ON u.id=c.created_by
      WHERE c.account_id=ANY($1::uuid[]) AND (c.deleted_at IS NULL OR $2='owner') ORDER BY c.created_at DESC LIMIT 200`, [ids,req.user.role]);
    res.json(rows);
  }));
  app.get('/api/campaigns/:id/image',route(async(req,res)=>{
    const c=await campaignAccess(req.user,req.params.id);assert(c.media,'Image not found',404);
    res.type(c.media.mimetype).send(Buffer.from(c.media.data,'base64'));
  }));
  app.post('/api/campaigns', route(async (req, res) => {
    await billing.canPay(req.user.id);
    const b = req.body; assert(permission(req.user, 'tasks.create'), '没有创建任务权限', 403);
    const a = await access(req.user, b.account_id, true); assert(a.enabled, '账号已停用');
    assert(!a.shared_pool,'请使用共享 WhatsApp 发送入口');
    if(b.require_connected===true){const connection=await browser.status(a);assert(connection.connected,'请先扫码连接 WhatsApp 账号，再立刻发送',409);}
    b.title=sharedConsole.taskTitle(b.title,crypto.randomUUID());
    const media=validateImage(b.media);
    assert(typeof b.body === 'string' && (b.body.trim().length||media) && b.body.length <= 4000, '请输入消息或上传照片');
    assert(b.opt_in_confirmed === true, '请确认这些联系人同意接收消息');
    assert(b.send_now === undefined || typeof b.send_now === 'boolean', 'send_now 无效');
    const pacing=b.pacing===true?validatePacing(b):null;
    const schedule = validateSchedule(pacing?{...b,timezone:'Asia/Kuala_Lumpur',window_start:'00:00',window_end:'00:00',weekdays:[1,2,3,4,5,6,7],scheduled_at:null,expires_at:null}:b), parsed = parseRecipients(b.recipients);
    const id = crypto.randomUUID();
    await transaction(async c => {
      await c.query(`INSERT INTO campaigns(id,account_id,created_by,title,body,timezone,window_start,window_end,weekdays,scheduled_at,expires_at,interval_ms,opt_in_confirmed,duplicate_count,send_now,media,batch_size)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16)`, [id, a.id, req.user.id, b.title.trim(), b.body, schedule.timezone, schedule.window_start, schedule.window_end, schedule.weekdays, schedule.scheduled_at, schedule.expires_at, schedule.interval_ms, parsed.duplicates, pacing?true:b.send_now === true,media,pacing?.batch_size||1]);
      await c.query(`INSERT INTO recipients(campaign_id,raw_phone,phone,status,error_code)
        SELECT $1,r.raw,r.phone,r.status,r.error FROM jsonb_to_recordset($2::jsonb) AS r(raw text,phone text,status text,error text)`, [id, JSON.stringify(parsed.recipients)]);
    });
    await audit(req.user.id, 'campaign.create', id, { title:b.title,body:b.body, schedule,recipients:parsed.recipients.length,duplicates:parsed.duplicates,send_now:b.send_now===true });
    res.status(201).json({ id, count: parsed.recipients.length, duplicates: parsed.duplicates });
  }));
  app.post('/api/campaigns/:id/send-now', route(async (req, res) => {
    assert(permission(req.user, 'tasks.create'), '没有任务权限', 403);
    assert(req.user.role==='owner','只有 Owner 可以继续或重新启动已有任务',403);
    const c = await campaignAccess(req.user, req.params.id, true);
    const a = await access(req.user, c.account_id, true); assert(a.enabled, '账号已停用');
    await (c.shared_pool?shared:billing).canPay(c.created_by);
    const pending = await transaction(async db => {
      const current = (await db.query('SELECT cancelled FROM campaigns WHERE id=$1 FOR UPDATE', [c.id])).rows[0];
      assert(!current.cancelled, '任务已取消');
      const counts=(await db.query("SELECT count(*) FILTER(WHERE status='pending')::integer n,count(*) FILTER(WHERE status='unknown')::integer review FROM recipients WHERE campaign_id=$1",[c.id])).rows[0];
      const count=counts.n;
      assert(count>0||!counts.review,'任务存在待核对号码，请先查看明细核对，系统不会自动重发。');
      assert(count > 0, '任务没有待发送的号码');
      // Never reset recipients: submitted, unknown and other finished results stay intact.
      await db.query('UPDATE campaigns SET enabled=true,send_now=true,pause_reason=NULL,operation_at=now(),review_released_at=now() WHERE id=$1', [c.id]);
      await db.query('INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,$2,$3,$4)', [req.user.id, 'campaign.send_now', c.id, { pending: count }]);
      return count;
    });
    res.json({ ok: true, pending });
  }));
  app.patch('/api/campaigns/:id', route(async (req, res) => {
    assert(permission(req.user, 'tasks.create'), '没有任务权限', 403);
    const c = await campaignAccess(req.user, req.params.id, true); assert(!c.cancelled, '任务已取消');
    const scheduleEdit=['pacing','interval_ms','batch_size','timezone','window_start','window_end','weekdays','scheduled_at','expires_at','send_now'].some(key=>Object.hasOwn(req.body,key));
    assert(!scheduleEdit||req.user.role==='owner','只有 Owner 可以修改任务间隔或数量',403);
    assert(req.user.role==='owner','只有 Owner 可以暂停或继续已有任务',403);
    if(req.body.enabled===true)await (c.shared_pool?shared:billing).canPay(c.created_by);
    if(req.body.pacing===true){
      const pace=validatePacing(req.body);
      await pool.query('UPDATE campaigns SET interval_ms=$1,batch_size=$2,send_now=true,operation_at=now() WHERE id=$3',[pace.interval_ms,pace.batch_size,c.id]);
      await audit(req.user.id,'campaign.schedule',c.id,pace);
    }else if(req.body.window_start!==undefined){
      const schedule=validateSchedule({...c,scheduled_at:c.scheduled_at.toISOString(),expires_at:c.expires_at?.toISOString(),...req.body});
      assert(req.body.send_now===undefined||typeof req.body.send_now==='boolean','send_now 无效');
      await pool.query(`UPDATE campaigns SET timezone=$1,window_start=$2,window_end=$3,weekdays=$4,scheduled_at=$5,expires_at=$6,interval_ms=$7,send_now=$8,operation_at=now() WHERE id=$9`,[schedule.timezone,schedule.window_start,schedule.window_end,schedule.weekdays,schedule.scheduled_at,schedule.expires_at,schedule.interval_ms,req.body.send_now??c.send_now,c.id]);
      await audit(req.user.id,'campaign.schedule',c.id,schedule);
    }else{
      assert(typeof req.body.enabled==='boolean','enabled 无效');
      await pool.query(`UPDATE campaigns SET enabled=$1,pause_reason=CASE WHEN NOT $1 AND pause_reason='review' THEN 'review' ELSE NULL END,operation_at=now(),review_released_at=CASE WHEN $1 THEN now() ELSE review_released_at END WHERE id=$2`,[req.body.enabled,c.id]);
      await audit(req.user.id,'campaign.enabled',c.id,{enabled:req.body.enabled});
    }
    res.json({ok:true});
  }));
  app.post('/api/campaigns/:id/cancel', route(async (req, res) => {
    assert(permission(req.user, 'tasks.create'), '没有任务权限', 403);
    assert(req.user.role==='owner','只有 Owner 可以取消或删除任务',403);
    const c = await campaignAccess(req.user, req.params.id, true);
    await transaction(async db => { await db.query('UPDATE campaigns SET enabled=false,cancelled=true,pause_reason=NULL,operation_at=now() WHERE id=$1', [c.id]); await db.query("UPDATE recipients SET status='cancelled',updated_at=now() WHERE campaign_id=$1 AND status='pending'", [c.id]); });
    await audit(req.user.id, 'campaign.cancel', c.id); res.json({ ok: true });
  }));
  app.get('/api/campaigns/:id/results', route(async (req, res) => {
    const c = await campaignAccess(req.user, req.params.id);
    const page = Math.max(1, Math.min(10000, Number(req.query.page) || 1));
    const status = req.query.status || null;
    const rows = (await pool.query('SELECT r.*,c.created_at FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE campaign_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY r.id LIMIT 100 OFFSET $3', [c.id, status, (page - 1) * 100])).rows;
    const total = (await pool.query('SELECT count(*)::integer total FROM recipients WHERE campaign_id=$1 AND ($2::text IS NULL OR status=$2)', [c.id, status])).rows[0].total;
    res.json({ rows:c.shared_pool&&req.user.role!=='owner'?rows.map(({send_account_id,...r})=>r):rows, total, page });
  }));
  app.get('/api/campaigns/:id/export', route(async (req, res) => {
    assert(permission(req.user, 'reports.export'), '没有导出权限', 403);
    const c = await campaignAccess(req.user, req.params.id);
    const rows = (await pool.query('SELECT raw_phone,phone,status,error_code,message_id,updated_at FROM recipients WHERE campaign_id=$1 ORDER BY id', [c.id])).rows;
    const keys = ['raw_phone', 'phone', 'status', 'error_code', 'message_id', 'updated_at'];
    res.type('text/csv').attachment('results-' + c.id + '.csv').send('\uFEFF' + [keys, ...rows.map(r => keys.map(k => r[k]))].map(r => r.map(csvCell).join(',')).join('\r\n'));
    await audit(req.user.id, 'report.export', c.id);
  }));
  app.get('/api/audit',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以查看全部操作记录',403);
    res.json((await pool.query(`SELECT a.*,u.username FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100 OFFSET $1`,[(Math.max(1,Math.min(1000000,Number(req.query.page)||1))-1)*100])).rows);
  }));
  app.get('/api/overview',route(async(req,res)=>{
    if(req.query.layout==='2'){
      assert(req.user.role==='owner','只有 Owner 可以查看按 USER ID 分开的总览',403);
      return res.json(await overview.readGrouped(pool,req.user.id));
    }
    const ids=await visibleAccountIds(req.user,false);
    const {rows}=await pool.query(`WITH records AS (
      SELECT r.status, r.started_at AS sent_at FROM recipients r JOIN campaigns c ON c.id=r.campaign_id
      WHERE c.account_id=ANY($1::uuid[]) AND c.deleted_at IS NULL
      UNION ALL
      SELECT m.status,m.sent_at FROM message_history m WHERE m.account_id=ANY($1::uuid[]) AND m.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE c.account_id=m.account_id AND r.message_id=m.message_id)
    ), days AS (SELECT generate_series(0,6) AS n), today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day)
    SELECT 'total' AS kind,status,NULL::text AS day,count(*)::int AS count FROM records GROUP BY status
    UNION ALL
    SELECT 'daily',r.status,to_char(t.day-6+d.n,'YYYY-MM-DD'),count(r.status)::int
    FROM days d CROSS JOIN today t LEFT JOIN records r ON (r.sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date=t.day-6+d.n
    GROUP BY d.n,t.day,r.status ORDER BY day`,[ids]);
    const counts={},days=new Map();
    for(const row of rows){if(row.kind==='total')counts[row.status]=row.count;else{if(!days.has(row.day))days.set(row.day,{date:row.day,counts:{}});if(row.status)days.get(row.day).counts[row.status]=row.count;}}
    res.json({counts,days:[...days.values()],timezone:'Asia/Kuala_Lumpur'});
  }));
  app.get('/api/send-records',route(async(req,res)=>{
    const ids=await visibleAccountIds(req.user),offset=(Math.max(1,Math.floor(Number(req.query.page)||1))-1)*100;
    res.json((await pool.query(`SELECT * FROM (
      SELECT c.account_id,a.label account_label,u.username actor,r.phone recipient,r.raw_phone,r.id::text recipient_id,c.id campaign_id,r.message_id,c.body,CASE WHEN c.media IS NULL THEN 'chat' ELSE 'image' END message_type,r.status,r.error_code,COALESCE(r.started_at,r.updated_at) sent_at,c.deleted_at
      FROM recipients r JOIN campaigns c ON c.id=r.campaign_id JOIN accounts a ON a.id=c.account_id JOIN users u ON u.id=c.created_by
      WHERE c.account_id=ANY($1::uuid[]) AND (c.deleted_at IS NULL OR $2='owner')
      UNION ALL
      SELECT m.account_id,a.label,u.username,m.recipient,NULL,NULL,NULL,m.message_id,m.body,m.message_type,m.status,NULL,m.sent_at,m.deleted_at
      FROM message_history m JOIN accounts a ON a.id=m.account_id LEFT JOIN users u ON u.id=m.actor_id
      WHERE m.account_id=ANY($1::uuid[]) AND (m.deleted_at IS NULL OR $2='owner') AND NOT EXISTS(SELECT 1 FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE c.account_id=m.account_id AND r.message_id=m.message_id)
    ) records ORDER BY sent_at DESC,recipient_id DESC NULLS LAST,message_id DESC LIMIT 100 OFFSET $3`,[ids,req.user.role,offset])).rows);
  }));
  app.get('/api/messages',route(async(req,res)=>{
    const ids=await visibleAccountIds(req.user);
    res.json((await pool.query(`SELECT m.*,a.label AS account_label,u.username AS actor FROM message_history m JOIN accounts a ON a.id=m.account_id LEFT JOIN users u ON u.id=m.actor_id WHERE m.account_id=ANY($1::uuid[]) AND (m.deleted_at IS NULL OR $2='owner') ORDER BY m.sent_at DESC,m.message_id DESC LIMIT 500 OFFSET $3`,[ids,req.user.role,(Math.max(1,Math.min(1000000,Number(req.query.page)||1))-1)*500])).rows);
  }));
  app.delete('/api/messages/:accountId/:messageId',route(async(req,res)=>{
    await access(req.user,req.params.accountId,true);
    if(req.user.role==='owner'){
      await transaction(async db=>{await db.query('INSERT INTO history_exclusions(account_id,message_hash) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.params.accountId,hash(req.params.messageId)]);await db.query('DELETE FROM message_history WHERE account_id=$1 AND message_id=$2',[req.params.accountId,req.params.messageId]);await db.query('DELETE FROM audit WHERE entity_id=$1',[req.params.messageId]);});
    }else{
      await transaction(async db=>{await db.query('UPDATE message_history SET deleted_at=now() WHERE account_id=$1 AND message_id=$2',[req.params.accountId,req.params.messageId]);await db.query('INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,$2,$3,$4)',[req.user.id,'message.delete',req.params.messageId,{account_id:req.params.accountId}]);});
    }res.json({ok:true});
  }));
  app.delete('/api/campaigns/:id',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以取消或删除任务',403);
    const c=await campaignAccess(req.user,req.params.id);
    assert(!c.shared_pool||req.user.role==='owner','只有 Owner 可以管理共享发送任务',403);
    assert(req.user.role==='owner'||c.created_by===req.user.id,'只能修改自己创建的发送任务',403);
    await transaction(async db=>{
      await db.query('SELECT id FROM campaigns WHERE id=$1 FOR UPDATE',[c.id]);
      assert(!(await db.query("SELECT 1 FROM recipients WHERE campaign_id=$1 AND status='sending'",[c.id])).rowCount,'任务正在发送，请暂停后再删除',409);
      if(req.user.role==='owner'){
        for(const r of (await db.query('SELECT message_id,send_account_id FROM recipients WHERE campaign_id=$1 AND message_id IS NOT NULL',[c.id])).rows)await db.query('INSERT INTO history_exclusions VALUES($1,$2) ON CONFLICT DO NOTHING',[r.send_account_id||c.account_id,hash(r.message_id)]);
        await db.query('DELETE FROM message_history m USING recipients r WHERE r.campaign_id=$1 AND m.account_id=COALESCE(r.send_account_id,$2::uuid) AND m.message_id=r.message_id',[c.id,c.account_id]);
        await db.query('DELETE FROM receipts m USING recipients r WHERE r.campaign_id=$1 AND m.account_id=COALESCE(r.send_account_id,$2::uuid) AND m.message_id=r.message_id',[c.id,c.account_id]);
        await db.query('DELETE FROM audit WHERE entity_id IN(SELECT message_id FROM recipients WHERE campaign_id=$1)',[c.id]);
        if(req.body?.preserve_holds!==true)await billing.assertNoHolds(db,c.id);await db.query('DELETE FROM recipients WHERE campaign_id=$1',[c.id]);await db.query('DELETE FROM campaigns WHERE id=$1',[c.id]);await db.query('DELETE FROM audit WHERE entity_id=$1',[c.id]);
      }else{
        await db.query('UPDATE campaigns SET enabled=false,cancelled=true,pause_reason=NULL,deleted_at=now(),deleted_by=$1 WHERE id=$2',[req.user.id,c.id]);
        await db.query("UPDATE recipients SET status='cancelled' WHERE campaign_id=$1 AND status='pending'",[c.id]);
        await db.query('INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,$2,$3,$4)',[req.user.id,'campaign.delete',c.id,{title:c.title,body:c.body}]);
      }
    });res.json({ok:true});
  }));
  app.post('/api/data/purge',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以永久清除资料',403);
    assert(req.body.confirm==='DELETE HISTORY','请输入 DELETE HISTORY 确认');
    await transaction(async db=>{
      await db.query('LOCK TABLE campaigns IN ACCESS EXCLUSIVE MODE');
      assert(!(await db.query("SELECT 1 FROM recipients WHERE status='sending'")).rowCount,'任务正在发送，请暂停后再删除',409);
      for(const r of (await db.query('SELECT account_id,message_id FROM message_history')).rows)await db.query('INSERT INTO history_exclusions VALUES($1,$2) ON CONFLICT DO NOTHING',[r.account_id,hash(r.message_id)]);
      await billing.assertNoHolds(db);await db.query('DELETE FROM recipients');await db.query('DELETE FROM campaigns');await db.query('DELETE FROM message_history');await db.query('DELETE FROM receipts');await db.query('DELETE FROM audit');
    });res.json({ok:true});
  }));
  app.get('/api/health', route(async (req, res) => {
    assert(req.user.role === 'owner', '只有 Owner 可以查看服务信息', 403);
    res.json(await capacity.read(pool,personalGroups));
  }));
  app.use('/novnc', express.static(path.resolve('node_modules/@novnc/novnc'), { maxAge: '1d' }));
  app.use(express.static(path.join(__dirname, '../public'), { etag: true }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if(err.type==='entity.too.large')return res.status(413).json({error:'提交内容过大'});
    if(err.type==='entity.parse.failed')return res.status(400).json({error:'提交格式无效'});
    const status = err.status || (err.code === '23505' ? 409 : 500);
    if (status >= 500) console.error('request failed:', err.code || err.name);
    const conflict={bank_accounts_account_number_key:'Bank account already exists',bank_transactions_pkey:'Bank transaction ID already exists',bank_receipt_once:'Receipt already used'};
    res.status(status).json({ error: err.code === '23505' ? conflict[err.constraint]||'账号 ID 已存在' : status >= 500 && !err.publicMessage ? '服务暂时不可用，请查看服务状态' : err.message, ...(err.publicMessage ? { code: err.code } : {}) });
  });
  const server = http.createServer(app), wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    let lease = false, accountId, user;
    try {
      assert(security.canonicalHost(req,publicURL), 'Wrong host', 421);
      assert(req.headers.origin === publicURL.origin, 'Wrong origin', 403);
      const url = new URL(req.url, publicURL); const match = url.pathname.match(/^\/screen\/([a-f0-9-]+)$/);
      assert(match, 'Wrong endpoint', 404); accountId = uuid(match[1]);
      user = await getSession(req); assert(user, 'Unauthorized', 401);
      const operate = url.searchParams.get('mode') === 'operate',scan=url.searchParams.get('mode')==='scan', a = await access(user, accountId, operate);
      assert(user.role==='owner'||(!operate&&scan&&a.status!=='ready'),'USER 仅可扫码关联，不能查看聊天或操作 WhatsApp',403);
      assert(a.enabled && routes[a.worker_group], 'Unavailable', 503);
      if (operate) {
        const result = await pool.query(`INSERT INTO control_leases(account_id,session_hash,expires_at) VALUES($1,$2,now()+interval '30 seconds')
          ON CONFLICT(account_id) DO UPDATE SET session_hash=excluded.session_hash,expires_at=excluded.expires_at
          WHERE control_leases.expires_at<now() OR control_leases.session_hash=excluded.session_hash RETURNING account_id`, [accountId, user.token_hash]);
        assert(result.rowCount, 'Account in use', 409); lease = true;
      }
      const target = new URL('/screen/' + accountId, routes[a.worker_group]); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      wss.handleUpgrade(req, socket, head, ws => {
        const upstream = new WebSocket(target, { headers: { Authorization: 'Bearer ' + process.env.INTERNAL_SECRET, 'X-Control-Mode': operate ? 'operate' : 'view', 'X-Require-Ready':user.role==='owner'||scan?'false':'true','X-Require-Unlinked':scan?'true':'false' }, handshakeTimeout: 10000 });
        const pending = []; let pendingSize = 0, stopped = false,checking=false,heartbeat,verifiedAt=Date.now();
        ws.on('message', data => { if(stopped)return;if (upstream.readyState === WebSocket.OPEN) upstream.send(data); else { pendingSize += data.length; if (pendingSize > 1024 * 1024) return ws.close(1009); pending.push(data); } });
        upstream.on('open', () => { for (const data of pending) upstream.send(data); pending.length = 0; });
        upstream.on('message', data => { if(stopped)return;if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 16 * 1024 * 1024) return ws.close(1009); ws.send(data); } });
        const close = hard => { if (stopped) return; stopped = true; clearInterval(timer);heartbeat?.stop();if(hard===true){ws.terminate();upstream.terminate();}else{ws.close();upstream.close();} /* lease expires in at most 30 seconds */ };
        ws.on('close', close); ws.on('error', close); upstream.on('close', close); upstream.on('error', close);
        heartbeat=monitorSockets([ws,upstream],close);
        const timer = setInterval(async () => {
          if(stopped)return;if(Date.now()-verifiedAt>=30000)return close(true);if(checking)return;checking=true;
          try {
            const current = await getSession(req); assert(current, 'Expired'); const currentAccount = await access(current, accountId, operate); assert(currentAccount.enabled, 'Disabled');assert(current.role==='owner'||(!operate&&scan&&currentAccount.status!=='ready'),'View unavailable');
            if(stopped)return;
            if (lease) {
              const changed = await pool.query("UPDATE control_leases SET expires_at=now()+interval '30 seconds' WHERE account_id=$1 AND session_hash=$2 RETURNING account_id", [accountId, current.token_hash]); assert(changed.rowCount, 'Lease lost');
            }
            if(!stopped)verifiedAt=Date.now();
          } catch { close(); }finally{checking=false;}
        }, 10000);
        audit(user.id, operate ? 'chat.operate' : 'chat.view', accountId).catch(() => {});
      });
    } catch (e) { socket.write('HTTP/1.1 ' + (e.status || 403) + ' Rejected\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  Promise.allSettled(Object.keys(routes).map(async worker_group=>{try{const sample=await browser.request({worker_group},'/capacity');console.log('Worker route verified:',JSON.stringify({group:worker_group,authenticated:true,running:Number.isSafeInteger(sample.running)?sample.running:null,max_accounts:Number.isSafeInteger(sample.max_accounts)?sample.max_accounts:null}));}catch(e){console.log('Worker route pending:',JSON.stringify({group:worker_group,code:e.code||'UNAVAILABLE'}));}}));
  const logCapacity=()=>{
    if(sharedGroups.length)capacity.read(pool,sharedGroups).then(rows=>console.log('Shared capacity snapshot:',JSON.stringify({groups:rows.length,total:rows.reduce((n,w)=>n+Number(w.max_accounts||0),0),used:rows.reduce((n,w)=>n+w.slots_used,0),available:rows.reduce((n,w)=>n+w.slots_available,0),unavailable:rows.reduce((n,w)=>n+w.slots_unavailable,0),all_fresh:rows.every(w=>w.capacity_state!=='offline')}))).catch(e=>console.error('Shared capacity snapshot pending:',e.code||e.name));
    capacity.read(pool,personalGroups).then(rows=>console.log('Personal capacity snapshot:',JSON.stringify(rows.map(w=>({group:w.worker_group,running:w.accounts_running,assigned:w.assigned_accounts,heartbeat_at:w.heartbeat_at,state:w.capacity_state}))))).catch(e=>console.error('Personal capacity snapshot pending:',e.code||e.name));
  };
  logCapacity();const capacityTimer=setInterval(logCapacity,60000);capacityTimer.unref();server.on('close',()=>clearInterval(capacityTimer));
  connectionFailures.databaseCapacity().then(data=>console.log('Database connection capacity:',JSON.stringify(data))).catch(e=>console.error('Database connection capacity pending:',e.code||e.name));
  const stopConnectionMonitor=connectionMonitorIntervalMs>0?connectionFailures.monitor(connectionMonitorIntervalMs):()=>{};
  server.on('close',stopConnectionMonitor);
  const allocationTimer=setInterval(()=>rebalanceAccounts().catch(e=>console.error('allocation tick:',e.code||e.name)),15000);allocationTimer.unref();
  server.on('close',()=>clearInterval(allocationTimer));
  const cleanup = setInterval(() => pool.query('DELETE FROM sessions WHERE expires_at<now()').catch(() => {}), 3600000); cleanup.unref();
  await new Promise(resolve => server.listen(Number(process.env.PORT || 3000), '::', resolve));
  console.log('Management service ready');
  const stopRefundMonitor=refundMonitorIntervalMs>0?automaticRefunds.monitor(refundMonitorIntervalMs):()=>{};
  server.on('close',stopRefundMonitor);
  const stopLoginMonitor=loginMonitorIntervalMs>0?loginHistory.monitor(pool,loginMonitorIntervalMs):()=>{};
  server.on('close',stopLoginMonitor);
  pool.query("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").then(async({rows})=>{
    if(!rows.length)return;
    const data=await overview.readGrouped(pool,rows[0].id);
    console.log('Overview attribution ready:',JSON.stringify({owner_partition:!!data.owner,user_groups:data.users.length,calendar_days:data.owner?.days.length,timezone:data.timezone}));
  }).catch(e=>console.error('Overview attribution check:',e.code||e.name));
  process.on('SIGTERM', () => { for (const ws of wss.clients) ws.close(); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 10000).unref(); });
  return server;
}
module.exports = { start, getSession, access, ensureLoginActivity };




