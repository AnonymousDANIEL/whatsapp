'use strict';
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { WebSocket, WebSocketServer } = require('ws');
const { pool, audit, transaction } = require('./db');
const { assert, hash, PERMISSIONS, parseRecipients, validateSchedule, permission, manageUser, csvCell } = require('./domain');
const { createWorkerConnection } = require('./connection');

const SESSION_HOURS = 168;
const routes = JSON.parse(process.env.WORKER_ROUTES_JSON || '{}');
const browser = createWorkerConnection(routes, process.env.INTERNAL_SECRET);
const COOKIE = 'wa_session';
const publicURL = new URL(process.env.PUBLIC_URL || 'http://localhost:3000');
const secure = publicURL.protocol === 'https:';
const uuid = value => { assert(/^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(value), 'ID 无效'); return value; };
function cookieToken(req) {
  const match = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='));
  return match?.slice(COOKIE.length + 1);
}
async function getSession(req) {
  const token = cookieToken(req);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await pool.query(`SELECT u.id,u.username,u.role,u.permissions,u.active,s.csrf,s.token_hash
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`, [hash(token)]);
  const user = rows[0];
  return user;
}
function route(fn) { return (req, res, next) => Promise.resolve(fn(req, res)).catch(next); }
function sessionCookie(res, token) { res.cookie(COOKIE, token, { httpOnly: true, secure, sameSite: 'strict', maxAge: SESSION_HOURS * 3600000, path: '/' }); }
function publicUser(u) { return { id: u.id, username: u.username, role: u.role, manager_id: u.manager_id, permissions: u.permissions, active: u.active }; }
async function access(user, id, operate = false) {
  uuid(id);
  const a = (await pool.query(`SELECT a.*,true AS operate FROM accounts a
    WHERE a.id=$1 AND ($2='owner' OR EXISTS(SELECT 1 FROM account_grants WHERE account_id=a.id AND user_id=$3))`, [id,user.role,user.id])).rows[0];
  assert(a, '无权操作此 WhatsApp 账号',403); return a;
}
async function visibleAccounts(user) {
  const {rows}=await pool.query(`SELECT a.*,true AS operate,h.heartbeat_at AS worker_heartbeat_at
    FROM accounts a LEFT JOIN worker_health h ON h.worker_group=a.worker_group
    WHERE $1='owner' OR EXISTS(SELECT 1 FROM account_grants WHERE account_id=a.id AND user_id=$2)
    ORDER BY a.created_at`,[user.role,user.id]);
  return rows.map(a=>({...a,status:a.enabled&&(!a.worker_heartbeat_at||Date.now()-+new Date(a.worker_heartbeat_at)>90000)?'worker_offline':a.status}));
}
async function campaignAccess(user, id, modify = false) {
  uuid(id);
  const c = (await pool.query('SELECT * FROM campaigns WHERE id=$1', [id])).rows[0];
  assert(c && (!c.deleted_at || user.role==='owner'), '任务不存在', 404);
  await access(user, c.account_id, modify);
  assert(!modify || !c.deleted_at, '任务已删除', 409);
  return c;
}
async function grantsFor(actor, grants) {
  assert(Array.isArray(grants) && grants.length <= 200, '账号权限列表无效');
  for (const g of grants) { assert(typeof g.operate === 'boolean', '账号操作权限无效'); await access(actor, g.account_id, g.operate); }
  return [...new Map(grants.map(g => [g.account_id, g])).values()];
}
function permissionsFor(actor, values) {
  assert(Array.isArray(values) && values.every(p => PERMISSIONS.includes(p) && permission(actor, p)), '不能授予自己没有的权限', 403);
  return [...new Set(values)];
}
async function workerCommand(account, command) {
  return browser.request(account, '/accounts/' + account.id + '/' + command, 'POST');
}
async function start() {
  const app = express();
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], frameSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'self'"] } }, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/healthz', route(async (_, res) => { await pool.query('SELECT 1'); res.json({ ok: true, role: 'api' }); }));
  const limiter = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '登录过于频繁，请稍后重试' } });
  const dummyHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  app.post('/api/login', limiter, route(async (req, res) => {
    assert(req.headers.origin === publicURL.origin, '来源不正确', 403);
    const { username, password } = req.body;
    assert(typeof username === 'string' && typeof password === 'string' && password.length <= 200, '账号或密码不正确', 401);
    const u = (await pool.query('SELECT * FROM users WHERE username=$1', [username])).rows[0];
    const valid = await bcrypt.compare(password, u?.password_hash || dummyHash);
    const parentOK = true;
    assert(u && u.active && parentOK && valid, '账号或密码不正确，或账号已停用', 401);
    const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
    await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '168 hours')`, [hash(token), u.id, csrf]);
    sessionCookie(res, token); await audit(u.id, 'login', u.id); res.json({ ok: true });
  }));
  app.use('/api', (req, res, next) => {
    getSession(req).then(user => {
      assert(user, '登录已过期，或账号已停用', 401); req.user = user;
      if (!['GET', 'HEAD'].includes(req.method)) assert(req.headers.origin === publicURL.origin && req.headers['x-csrf-token'] === user.csrf, '安全验证失败，请重新登录', 403);
      next();
    }).catch(next);
  });
  app.get('/api/me', route(async (req, res) => res.json({ user: publicUser(req.user), csrf: req.user.csrf, permissions: PERMISSIONS, worker_groups: Object.keys(routes), server_time: new Date().toISOString(), timezone:'Asia/Kuala_Lumpur' })));
  app.post('/api/logout', route(async (req, res) => { await pool.query('DELETE FROM sessions WHERE token_hash=$1', [req.user.token_hash]); res.clearCookie(COOKIE, { path: '/', secure, sameSite: 'strict' }); res.json({ ok: true }); }));
  app.post('/api/password', route(async (req, res) => {
    assert(typeof req.body.password === 'string' && req.body.password.length >= 12 && req.body.password.length <= 200, '新密码需要 12–200 个字符');
    const row = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
    assert(await bcrypt.compare(req.body.current_password || '', row.password_hash), '原密码不正确', 403);
    await transaction(async c => { await c.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(req.body.password, 12), req.user.id]); await c.query('DELETE FROM sessions WHERE user_id=$1', [req.user.id]); });
    await audit(req.user.id, 'password.change', req.user.id); res.json({ ok: true });
  }));
  app.get('/api/accounts', route(async (req, res) => res.json(await visibleAccounts(req.user))));
  app.post('/api/accounts', route(async (req, res) => {

    assert(typeof req.body.label === 'string' && req.body.label.trim().length > 0 && req.body.label.length <= 80, '请输入账号名称');
    assert(Object.hasOwn(routes, req.body.worker_group), '请选择已配置的浏览器分组');
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO accounts(id,label,worker_group) VALUES($1,$2,$3)', [id, req.body.label.trim(), req.body.worker_group]);
    if(req.user.role!=='owner') await pool.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,true)',[req.user.id,id]);
    await audit(req.user.id, 'account.create', id, {label:req.body.label.trim()});
    try {
      await workerCommand({ id, worker_group: req.body.worker_group }, 'start');
      res.status(201).json({ id, started: true });
    } catch (error) {
      if (!error.publicMessage) throw error;
      res.status(201).json({ id, started: false, connection: { code: error.code, message: error.message } });
    }
  }));
  app.get('/api/accounts/:id/connection', route(async (req, res) => {
    const operate = req.query.mode === 'operate', a = await access(req.user, req.params.id, operate);
    const canStart = operate;
    if (!a.enabled) return res.json({ ok: false, code: 'ACCOUNT_DISABLED', message: '此账号已停用，请管理员启用后再连接。', can_start: false });
    if (operate && (await pool.query('SELECT 1 FROM control_leases WHERE account_id=$1 AND expires_at>now() AND session_hash<>$2', [a.id, req.user.token_hash])).rowCount) {
      return res.json({ ok: false, code: 'ACCOUNT_IN_USE', message: '此账号正被其他操作窗口使用，请关闭该窗口后再连接。', can_start: false });
    }
    try {
      const connection = await browser.status(a);
      res.json({ ok: connection.screen_ready, code: connection.screen_ready ? 'SCREEN_READY' : 'BROWSER_NOT_READY', message: connection.screen_ready ? '请用手机 WhatsApp → 已关联设备 → 关联设备扫码；显示已连接后才能发送。' : '浏览器尚未准备好，请启动后重试；若仍无法打开，请管理员检查浏览器服务日志。', connected: connection.connected, status: connection.status, can_start: canStart });
    } catch (error) {
      if (!error.publicMessage) throw error;
      res.json({ ok: false, code: error.code, message: error.message, can_start: false });
    }
  }));
  app.patch('/api/accounts/:id', route(async(req,res)=>{
    const a=await access(req.user,req.params.id,true);
    if(req.body.label!==undefined){
      assert(typeof req.body.label==='string'&&req.body.label.trim().length>0&&req.body.label.length<=80,'请输入账号名称');
      await pool.query('UPDATE accounts SET label=$1 WHERE id=$2',[req.body.label.trim(),a.id]);
      await audit(req.user.id,'account.rename',a.id,{before:a.label,after:req.body.label.trim()});
    }
    if(req.body.enabled!==undefined){
      assert(typeof req.body.enabled==='boolean','enabled 无效');
      await pool.query('UPDATE accounts SET enabled=$1 WHERE id=$2',[req.body.enabled,a.id]);
      await audit(req.user.id,'account.enabled',a.id,{enabled:req.body.enabled});
    }
    res.json({ok:true});
  }));
  app.post('/api/accounts/:id/:command', route(async (req, res) => {

    assert(['start', 'restart'].includes(req.params.command), '指令无效');
    const a = await access(req.user, req.params.id, true); assert(a.enabled, '账号已停用');
    const result = await workerCommand(a, req.params.command); await audit(req.user.id, 'account.' + req.params.command, a.id); res.json(result);
  }));
  app.get('/api/users',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以管理 USER ID',403);
    res.json((await pool.query(`SELECT u.id,u.username,u.role,u.active,u.created_at,u.permissions,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('account_id',g.account_id,'operate',true)) FROM account_grants g WHERE g.user_id=u.id),'[]'::jsonb) grants FROM users u ORDER BY u.created_at`)).rows);
  }));
  app.post('/api/users',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以管理 USER ID',403);
    const b=req.body;assert(!b.role||b.role==='user','只能创建 USER ID');
    assert(/^[\w.-]{3,40}$/.test(b.username||''),'ID 需要 3–40 位字母、数字、点、横线或下划线');
    assert(typeof b.password==='string'&&b.password.length>=12&&b.password.length<=200,'密码需要 12–200 个字符');
    const grants=await grantsFor(req.user,(b.grants||[]).map(g=>({...g,operate:true}))),id=crypto.randomUUID();
    await transaction(async db=>{
      await db.query("INSERT INTO users(id,username,password_hash,role,permissions,active) VALUES($1,$2,$3,'user',$4,$5)",[id,b.username,await bcrypt.hash(b.password,12),PERMISSIONS,b.active!==false]);
      for(const g of grants)await db.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,true)',[id,g.account_id]);
    });
    await audit(req.user.id,'user.create',id,{username:b.username});res.status(201).json({id});
  }));
  app.patch('/api/users/:id',route(async(req,res)=>{
    assert(req.user.role==='owner','只有 Owner 可以管理 USER ID',403);
    const target=(await pool.query('SELECT * FROM users WHERE id=$1',[uuid(req.params.id)])).rows[0];
    assert(target&&manageUser(req.user,target),'无权修改此 USER ID',403);
    const b=req.body;assert(typeof b.active==='boolean','请选择 Active/Inactive');
    assert(!b.password||(typeof b.password==='string'&&b.password.length>=12&&b.password.length<=200),'密码需要 12–200 个字符');
    const grants=b.grants===undefined?null:await grantsFor(req.user,b.grants.map(g=>({...g,operate:true})));
    await transaction(async db=>{
      await db.query('UPDATE users SET active=$1,permissions=$2 WHERE id=$3',[b.active,PERMISSIONS,target.id]);
      if(b.password)await db.query('UPDATE users SET password_hash=$1 WHERE id=$2',[await bcrypt.hash(b.password,12),target.id]);
      if(grants){await db.query('DELETE FROM account_grants WHERE user_id=$1',[target.id]);for(const g of grants)await db.query('INSERT INTO account_grants(user_id,account_id,operate) VALUES($1,$2,true)',[target.id,g.account_id]);}
      if(!b.active||b.password)await db.query('DELETE FROM sessions WHERE user_id=$1',[target.id]);
      if(!b.active)await db.query('UPDATE campaigns SET enabled=false WHERE created_by=$1',[target.id]);
    });
    await audit(req.user.id,'user.update',target.id,{active:b.active,grants:grants?.map(g=>g.account_id)});res.json({ok:true});
  }));
  app.get('/api/campaigns', route(async (req, res) => {
    const ids = (await visibleAccounts(req.user)).map(a => a.id);
    const { rows } = await pool.query(`SELECT c.*,a.label AS account_label,u.username AS creator,
      (SELECT jsonb_object_agg(t.status,t.n) FROM (SELECT status,count(*)::integer n FROM recipients WHERE campaign_id=c.id GROUP BY status) t) AS counts
      FROM campaigns c JOIN accounts a ON a.id=c.account_id JOIN users u ON u.id=c.created_by
      WHERE c.account_id=ANY($1::uuid[]) AND (c.deleted_at IS NULL OR $2='owner') ORDER BY c.created_at DESC LIMIT 200`, [ids,req.user.role]);
    res.json(rows);
  }));
  app.post('/api/campaigns', route(async (req, res) => {
    const b = req.body; assert(permission(req.user, 'tasks.create'), '没有创建任务权限', 403);
    const a = await access(req.user, b.account_id, true); assert(a.enabled, '账号已停用');
    assert(typeof b.title === 'string' && b.title.trim().length && b.title.length <= 120, '请输入任务名称');
    assert(typeof b.body === 'string' && b.body.trim().length && b.body.length <= 4000, '消息需要 1–4000 个字符');
    assert(b.opt_in_confirmed === true, '请确认这些联系人同意接收消息');
    assert(b.send_now === undefined || typeof b.send_now === 'boolean', 'send_now 无效');
    const schedule = validateSchedule(b), parsed = parseRecipients(b.recipients);
    const id = crypto.randomUUID();
    await transaction(async c => {
      await c.query(`INSERT INTO campaigns(id,account_id,created_by,title,body,timezone,window_start,window_end,weekdays,scheduled_at,expires_at,interval_ms,opt_in_confirmed,duplicate_count,send_now)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14)`, [id, a.id, req.user.id, b.title.trim(), b.body, schedule.timezone, schedule.window_start, schedule.window_end, schedule.weekdays, schedule.scheduled_at, schedule.expires_at, schedule.interval_ms, parsed.duplicates, b.send_now === true]);
      await c.query(`INSERT INTO recipients(campaign_id,raw_phone,phone,status,error_code)
        SELECT $1,r.raw,r.phone,r.status,r.error FROM jsonb_to_recordset($2::jsonb) AS r(raw text,phone text,status text,error text)`, [id, JSON.stringify(parsed.recipients)]);
    });
    await audit(req.user.id, 'campaign.create', id, { title:b.title,body:b.body, schedule,recipients:parsed.recipients.length,duplicates:parsed.duplicates,send_now:b.send_now===true });
    res.status(201).json({ id, count: parsed.recipients.length, duplicates: parsed.duplicates });
  }));
  app.post('/api/campaigns/:id/send-now', route(async (req, res) => {
    assert(permission(req.user, 'tasks.create'), '没有任务权限', 403);
    const c = await campaignAccess(req.user, req.params.id, true);
    const a = await access(req.user, c.account_id, true); assert(a.enabled, '账号已停用');
    const pending = await transaction(async db => {
      const current = (await db.query('SELECT cancelled FROM campaigns WHERE id=$1 FOR UPDATE', [c.id])).rows[0];
      assert(!current.cancelled, '任务已取消');
      const count = (await db.query("SELECT count(*)::integer n FROM recipients WHERE campaign_id=$1 AND status='pending'", [c.id])).rows[0].n;
      assert(count > 0, '任务没有待发送的号码');
      // Never reset recipients: submitted, unknown and other finished results stay intact.
      await db.query('UPDATE campaigns SET enabled=true,send_now=true WHERE id=$1', [c.id]);
      await db.query('INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,$2,$3,$4)', [req.user.id, 'campaign.send_now', c.id, { pending: count }]);
      return count;
    });
    res.json({ ok: true, pending });
  }));
  app.patch('/api/campaigns/:id', route(async (req, res) => {
    assert(permission(req.user, 'tasks.create'), '没有任务权限', 403);
    const c = await campaignAccess(req.user, req.params.id, true); assert(!c.cancelled, '任务已取消');
    if(req.body.window_start!==undefined){
      const schedule=validateSchedule({...c,scheduled_at:c.scheduled_at.toISOString(),expires_at:c.expires_at?.toISOString(),...req.body});
      assert(req.body.send_now===undefined||typeof req.body.send_now==='boolean','send_now 无效');
      await pool.query(`UPDATE campaigns SET timezone=$1,window_start=$2,window_end=$3,weekdays=$4,scheduled_at=$5,expires_at=$6,interval_ms=$7,send_now=$8 WHERE id=$9`,[schedule.timezone,schedule.window_start,schedule.window_end,schedule.weekdays,schedule.scheduled_at,schedule.expires_at,schedule.interval_ms,req.body.send_now??c.send_now,c.id]);
      await audit(req.user.id,'campaign.schedule',c.id,schedule);
    }else{
      assert(typeof req.body.enabled==='boolean','enabled 无效');
      await pool.query('UPDATE campaigns SET enabled=$1 WHERE id=$2',[req.body.enabled,c.id]);
      await audit(req.user.id,'campaign.enabled',c.id,{enabled:req.body.enabled});
    }
    res.json({ok:true});
  }));
  app.post('/api/campaigns/:id/cancel', route(async (req, res) => {
    assert(permission(req.user, 'tasks.create'), '没有任务权限', 403);
    const c = await campaignAccess(req.user, req.params.id, true);
    await transaction(async db => { await db.query('UPDATE campaigns SET enabled=false,cancelled=true WHERE id=$1', [c.id]); await db.query("UPDATE recipients SET status='cancelled',updated_at=now() WHERE campaign_id=$1 AND status='pending'", [c.id]); });
    await audit(req.user.id, 'campaign.cancel', c.id); res.json({ ok: true });
  }));
  app.get('/api/campaigns/:id/results', route(async (req, res) => {
    const c = await campaignAccess(req.user, req.params.id);
    const page = Math.max(1, Math.min(10000, Number(req.query.page) || 1));
    const status = req.query.status || null;
    const rows = (await pool.query('SELECT * FROM recipients WHERE campaign_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY id LIMIT 100 OFFSET $3', [c.id, status, (page - 1) * 100])).rows;
    const total = (await pool.query('SELECT count(*)::integer total FROM recipients WHERE campaign_id=$1 AND ($2::text IS NULL OR status=$2)', [c.id, status])).rows[0].total;
    res.json({ rows, total, page });
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
    res.json((await pool.query(`SELECT a.*,u.username FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 1000 OFFSET $1`,[(Math.max(1,Math.min(1000000,Number(req.query.page)||1))-1)*1000])).rows);
  }));
  app.get('/api/messages',route(async(req,res)=>{
    const ids=(await visibleAccounts(req.user)).map(a=>a.id);
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
    const c=await campaignAccess(req.user,req.params.id);
    await transaction(async db=>{
      await db.query('SELECT id FROM campaigns WHERE id=$1 FOR UPDATE',[c.id]);
      assert(!(await db.query("SELECT 1 FROM recipients WHERE campaign_id=$1 AND status='sending'",[c.id])).rowCount,'任务正在发送，请暂停后再删除',409);
      if(req.user.role==='owner'){
        for(const r of (await db.query('SELECT message_id FROM recipients WHERE campaign_id=$1 AND message_id IS NOT NULL',[c.id])).rows)await db.query('INSERT INTO history_exclusions VALUES($1,$2) ON CONFLICT DO NOTHING',[c.account_id,hash(r.message_id)]);
        await db.query('DELETE FROM message_history WHERE account_id=$1 AND message_id IN(SELECT message_id FROM recipients WHERE campaign_id=$2)',[c.account_id,c.id]);
        await db.query('DELETE FROM receipts WHERE account_id=$1 AND message_id IN(SELECT message_id FROM recipients WHERE campaign_id=$2)',[c.account_id,c.id]);
        await db.query('DELETE FROM audit WHERE entity_id IN(SELECT message_id FROM recipients WHERE campaign_id=$1)',[c.id]);
        await db.query('DELETE FROM recipients WHERE campaign_id=$1',[c.id]);await db.query('DELETE FROM campaigns WHERE id=$1',[c.id]);await db.query('DELETE FROM audit WHERE entity_id=$1',[c.id]);
      }else{
        await db.query('UPDATE campaigns SET enabled=false,cancelled=true,deleted_at=now(),deleted_by=$1 WHERE id=$2',[req.user.id,c.id]);
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
      await db.query('DELETE FROM recipients');await db.query('DELETE FROM campaigns');await db.query('DELETE FROM message_history');await db.query('DELETE FROM receipts');await db.query('DELETE FROM audit');
    });res.json({ok:true});
  }));
  app.get('/api/health', route(async (req, res) => {
    assert(req.user.role === 'owner', '只有 Owner 可以查看服务信息', 403);
    res.json((await pool.query('SELECT * FROM worker_health ORDER BY worker_group')).rows);
  }));
  app.use('/novnc', express.static(path.resolve('node_modules/@novnc/novnc'), { maxAge: '1d' }));
  app.use(express.static(path.join(__dirname, '../public'), { etag: true }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.code === '23505' ? 409 : 500);
    if (status >= 500) console.error('request failed:', err.code || err.name);
    res.status(status).json({ error: err.code === '23505' ? '账号 ID 已存在' : status >= 500 && !err.publicMessage ? '服务暂时不可用，请查看服务状态' : err.message, ...(err.publicMessage ? { code: err.code } : {}) });
  });
  const server = http.createServer(app), wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    let lease = false, accountId, user;
    try {
      assert(req.headers.origin === publicURL.origin, 'Wrong origin', 403);
      const url = new URL(req.url, publicURL); const match = url.pathname.match(/^\/screen\/([a-f0-9-]+)$/);
      assert(match, 'Wrong endpoint', 404); accountId = uuid(match[1]);
      user = await getSession(req); assert(user, 'Unauthorized', 401);
      const operate = url.searchParams.get('mode') === 'operate', a = await access(user, accountId, operate);
      assert(a.enabled && routes[a.worker_group], 'Unavailable', 503);
      if (operate) {
        const result = await pool.query(`INSERT INTO control_leases(account_id,session_hash,expires_at) VALUES($1,$2,now()+interval '30 seconds')
          ON CONFLICT(account_id) DO UPDATE SET session_hash=excluded.session_hash,expires_at=excluded.expires_at
          WHERE control_leases.expires_at<now() OR control_leases.session_hash=excluded.session_hash RETURNING account_id`, [accountId, user.token_hash]);
        assert(result.rowCount, 'Account in use', 409); lease = true;
      }
      const target = new URL('/screen/' + accountId, routes[a.worker_group]); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      wss.handleUpgrade(req, socket, head, ws => {
        const upstream = new WebSocket(target, { headers: { Authorization: 'Bearer ' + process.env.INTERNAL_SECRET, 'X-Control-Mode': operate ? 'operate' : 'view' }, handshakeTimeout: 10000 });
        const pending = []; let pendingSize = 0, stopped = false;
        ws.on('message', data => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data); else { pendingSize += data.length; if (pendingSize > 1024 * 1024) return ws.close(1009); pending.push(data); } });
        upstream.on('open', () => { for (const data of pending) upstream.send(data); pending.length = 0; });
        upstream.on('message', data => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 16 * 1024 * 1024) return ws.close(1009); ws.send(data); } });
        const close = () => { if (stopped) return; stopped = true; clearInterval(timer); ws.close(); upstream.close(); /* lease expires in at most 30 seconds */ };
        ws.on('close', close); ws.on('error', close); upstream.on('close', close); upstream.on('error', close);
        const timer = setInterval(async () => {
          try {
            const current = await getSession(req); assert(current, 'Expired'); const currentAccount = await access(current, accountId, operate); assert(currentAccount.enabled, 'Disabled');
            if (lease) {
              const changed = await pool.query("UPDATE control_leases SET expires_at=now()+interval '30 seconds' WHERE account_id=$1 AND session_hash=$2 RETURNING account_id", [accountId, current.token_hash]); assert(changed.rowCount, 'Lease lost');
            }
            ws.ping(); upstream.ping();
          } catch { close(); }
        }, 10000);
        audit(user.id, operate ? 'chat.operate' : 'chat.view', accountId).catch(() => {});
      });
    } catch (e) { socket.write('HTTP/1.1 ' + (e.status || 403) + ' Rejected\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  const cleanup = setInterval(() => pool.query('DELETE FROM sessions WHERE expires_at<now()').catch(() => {}), 3600000); cleanup.unref();
  await new Promise(resolve => server.listen(Number(process.env.PORT || 3000), '::', resolve));
  console.log('Management service ready');
  process.on('SIGTERM', () => { for (const ws of wss.clients) ws.close(); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 10000).unref(); });
  return server;
}
module.exports = { start, getSession, access };
