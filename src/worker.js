'use strict';
const express = require('express');
const billing=require('./billing');
const shared=require('./shared');
const {connectedSQL,linkedPhone}=require('./shared-domain');
const http = require('node:http');
const {monitorSockets}=require('./socket-health');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { describeStartupError } = require('./startup');
const { messageId,validAck,messageAck } = require('./messages');
const {readSnapshot,historyFailureCode}=require('./history-sync');
const {sendFailureCode}=require('./workspace-send');
const {purgeAccountData}=require('./account-deletion');
const {clearStaleProfileLock}=require('./profile-lock');
const lifecycle=require('./browser-lifecycle');
const runtime=require('./browser-runtime');
const { LocalAuth, MessageMedia } = require('whatsapp-web.js');
const {LiveWebClient}=require('./live-web-client');
const { WebSocket, WebSocketServer } = require('ws');
const { pool, audit, transaction } = require('./db');
const { assert, canDispatch, ackStatus } = require('./domain');
const group = process.env.WORKER_GROUP;
const maxAccounts = Number(process.env.MAX_ACCOUNTS_PER_WORKER || 5);
const dataPath = path.resolve(process.env.DATA_DIR || '/data');
const entries = new Map(), busy = new Set(), retryAt = new Map(), failures = new Map();
const accountWorkSQL="SELECT * FROM accounts WHERE worker_group=$1 AND (enabled OR purge_requested OR status<>'disabled' OR id=ANY($2::uuid[])) ORDER BY created_at";
let shuttingDown = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function authorized(req) {
  const value = req.headers.authorization || '', expected = 'Bearer ' + process.env.INTERNAL_SECRET;
  return value.length === expected.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
async function state(id,status,error=null,phone=null){
 await pool.query(`UPDATE accounts SET status=$1,last_error=$2,phone=COALESCE($3,phone),heartbeat_at=now(),
  shared_state=CASE WHEN NOT shared_pool THEN shared_state WHEN $1='ready' AND $3 IS NOT NULL AND registration_phone='+'||$3 THEN 'connected' WHEN $1='ready' THEN 'unknown'
   WHEN $1 IN ('starting','loading','scan_required','capacity_wait','disabled','stopped') THEN 'waiting' ELSE 'offline' END,
  shared_checked_at=CASE WHEN shared_pool AND (status IS DISTINCT FROM $1 OR $1='ready') THEN now() ELSE shared_checked_at END
  WHERE id=$4 AND worker_group=$5`,[status,error,phone,id,group]);
}
function processChild(entry, executable, args, env) {
  assert(lifecycle.current(entries,entry),'DESKTOP_CLOSED');
  const child = spawn('taskset', ['--cpu-list',entry.env.WA_BROWSER_CPUS,executable,...args], { stdio: ['ignore', 'ignore', 'pipe'], env: env || entry.env, uid: entry.uid, gid: entry.uid });
  entry.children.push(child);
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
  child.on('error', error => { console.error(describeStartupError(error, 'desktop-' + executable)); fail(entry.id, 'DESKTOP_START_FAILED',entry).catch(() => {}); });
  child.on('exit', (code, signal) => { if (!entry.closing && !shuttingDown) { console.error(describeStartupError(new Error(executable + ' exit=' + code + ' signal=' + signal + ' ' + stderr), 'desktop')); fail(entry.id, 'DESKTOP_EXITED',entry).catch(() => {}); } });
  return child;
}
async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.setTimeout(200, () => { s.destroy(); resolve(false); }); });
    if (ok) return;
    await pause(100);
  }
  throw new Error('DESKTOP_NOT_READY');
}
async function stopAccount(id,expected=null,options={}) {
  const entry=entries.get(id);if(!entry||(expected&&entry!==expected))return;
  return lifecycle.retire(entries,entry,options);
}
let identityWork = Promise.resolve();
async function desktopIdentity(id) {
  const work = identityWork.then(async () => {
    const file = path.join(dataPath, 'identities.json');
    let identities = {}; try { identities = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!identities[id]) { identities[id] = Math.max(19999, ...Object.values(identities)) + 1; await fs.writeFile(file, JSON.stringify(identities), { mode: 0o600 }); }
    const uid = identities[id], name = 'wa-' + id.replaceAll('-', '').slice(0, 20);
    const home = path.join(dataPath, 'homes', id), auth = path.join(dataPath, 'profiles', id), xauth = path.join(home, 'Xauthority');
    try { await execute('getent', ['group', name]); } catch { await execute('groupadd', ['--gid', String(uid), name]); }
    try { await execute('getent', ['passwd', name]); } catch { await execute('useradd', ['--uid', String(uid), '--gid', String(uid), '--no-create-home', '--home-dir', home, '--shell', '/usr/sbin/nologin', name]); }
    for (const parent of [dataPath, path.join(dataPath,'homes'), path.join(dataPath,'profiles')]) { await fs.mkdir(parent, {recursive:true,mode:0o711}); await fs.chmod(parent,0o711); }
    for (const dir of [home, auth]) { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chown(dir, uid, uid); await fs.chmod(dir, 0o700); }
    await fs.writeFile(xauth, '', { mode: 0o600 });
    return { uid, home, auth, xauth };
  });
  identityWork = work.catch(() => {}); return work;
}
class IsolatedAuth extends LocalAuth {
  constructor(options, uid, onBrowser) { super(options); this.uid = uid;this.onBrowser=onBrowser; }
  async beforeBrowserInitialized() { await super.beforeBrowserInitialized(); if(await clearStaleProfileLock(this.userDataDir))console.log('Removed stale Chromium lock from prior container'); await execute('chown', ['-R', this.uid + ':' + this.uid, this.userDataDir]); await fs.chmod(this.userDataDir, 0o700); }
  async afterBrowserInitialized(){await super.afterBrowserInitialized();this.onBrowser?.();}
}
async function fail(id, reason, expected=null) {
  const entry = entries.get(id); if (!entry || entry.closing || expected&&entry!==expected) return;
  console.error(describeStartupError(new Error(reason), 'account-browser'));
  lifecycle.resourceSummary().then(info=>console.error('Browser resources:',JSON.stringify(info))).catch(()=>{});
  const n = (failures.get(id) || 0) + 1; failures.set(id, n);
  retryAt.set(id, Date.now() + Math.min(300000, 10000 * 2 ** Math.min(n, 5)));
  await stopAccount(id,entry,{beforeRelease:()=>state(id,'error',reason)});
}
async function receiveAck(id, messageId, ack) {
  if(!messageId||!validAck(ack)) return;
  // Persist the receipt first: ACK can arrive before sendMessage's promise resolves.
  await pool.query(`INSERT INTO receipts(account_id,message_id,ack) VALUES($1,$2,$3)
    ON CONFLICT(account_id,message_id) DO UPDATE SET ack=CASE WHEN excluded.ack=-1 THEN -1 ELSE GREATEST(receipts.ack,excluded.ack) END,updated_at=now()`, [id, messageId, ack]);
  const saved = (await pool.query('SELECT ack FROM receipts WHERE account_id=$1 AND message_id=$2', [id, messageId])).rows[0].ack;
  await pool.query(`UPDATE message_history SET ack=$1,status=$2,updated_at=now() WHERE account_id=$3 AND message_id=$4 AND (ack IS NULL OR (ack<>-1 AND ($1=-1 OR $1>=ack)))`,[saved,ackStatus(saved),id,messageId]);
  await pool.query(`UPDATE recipients r SET status=$1,ack=$2,error_code=CASE WHEN $2=-1 THEN 'ACK_ERROR' ELSE NULL END,updated_at=now()
    FROM campaigns c WHERE c.id=r.campaign_id AND COALESCE(r.send_account_id,c.account_id)=$3 AND r.message_id=$4`, [ackStatus(saved), saved, id, messageId]);
}
async function startAccount(account) {
  if (entries.has(account.id)) return;
  if(lifecycle.starting(entries)){await state(account.id,'starting');return;}
  assert(entries.size < maxAccounts, 'WORKER_CAPACITY_REACHED', 409);
  const resources=await lifecycle.resourceSummary();
  // Resource reads yield: another command may have reserved a slot in the meantime.
  if(entries.has(account.id))return;
  if(lifecycle.starting(entries)){await state(account.id,'starting');return;}
  assert(entries.size<maxAccounts,'WORKER_CAPACITY_REACHED',409);
  if(!runtime.hasLaunchCapacity(resources)){await state(account.id,'capacity_wait','BROWSER_RESOURCE_WAIT');return;}
  let slot = 0; while ([...entries.values()].some(e => e.slot === slot)) slot++;
  const e = { id: account.id, slot, controlPort: 5900 + slot * 2, viewPort: 5901 + slot * 2, children: [], sockets: new Set(), ready: false, closing: false, launching:true, awaitingScan:false, launchAbort:new AbortController(), started: Date.now() };
  entries.set(account.id, e);
  e.setup=(async()=>{
  try {
    await state(account.id, 'starting');
    const display = ':' + (100 + slot);
    const identity = await desktopIdentity(account.id); e.uid = identity.uid;
    assert(lifecycle.current(entries,e),'DESKTOP_CLOSED');
    await execute('xauth', ['-f', identity.xauth, 'add', display, '.', crypto.randomBytes(16).toString('hex')]);
    await fs.chown(identity.xauth, e.uid, e.uid);
    e.env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ:'Asia/Kuala_Lumpur', HOME: identity.home, DISPLAY: display, XAUTHORITY: identity.xauth,
      WA_BROWSER_CPUS:await runtime.browserCpuSet(slot),LP_NUM_THREADS:String(runtime.CPUS_PER_BROWSER),WA_CHROMIUM_PATH:process.env.CHROMIUM_PATH&&process.env.CHROMIUM_PATH!=='/app/bin/browser'?process.env.CHROMIUM_PATH:'/usr/bin/chromium' };
    processChild(e, 'Xvfb', [display, '-screen', '0', '1366x900x24', '-nolisten', 'tcp', '-auth', identity.xauth]);
    await pause(500);
    for (const [port, viewOnly] of [[e.controlPort, false], [e.viewPort, true]]) {
      processChild(e, 'x11vnc', ['-display', display, '-auth', identity.xauth, '-rfbport', String(port), '-localhost', '-forever', '-shared', '-nopw', '-noxdamage', '-quiet', ...(viewOnly ? ['-viewonly'] : [])]);
      await waitPort(port);
    }
    assert(!e.closing, 'DESKTOP_CLOSED');
    e.desktopReady = true;
    const watchBrowser=()=>lifecycle.observeBrowser(entries,e,reason=>{fail(account.id,reason,e).catch(()=>{});});
    e.client = new LiveWebClient({
      authStrategy: new IsolatedAuth({ clientId: account.id, dataPath: identity.auth }, e.uid,watchBrowser),
      // Load the official page freshly. Do not pin or rewrite the WhatsApp Web UI.
      webVersionCache: { type: 'none' },
      takeoverOnConflict: false,
      puppeteer: { headless: false, executablePath: '/app/bin/browser', defaultViewport: null,
        env: { ...e.env, WA_BROWSER_UID: String(e.uid) }, signal:e.launchAbort.signal, timeout:90000, protocolTimeout:90000,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--kiosk', '--window-size=1366,900', '--window-position=0,0', '--disable-session-crashed-bubble', '--no-first-run'] }
    });
    const on=(event,callback)=>e.client.on(event,lifecycle.guard(entries,e,(...args)=>{watchBrowser();return callback(...args);}));
    on('qr', () => { failures.delete(account.id);retryAt.delete(account.id);e.ready=false;e.awaitingScan=true;e.launching=false;e.progressAt=Date.now();state(account.id,'scan_required').catch(()=>{}); });
    on('authenticated', () => { e.ready=false;e.awaitingScan=false;e.launching=false;e.progressAt=Date.now();state(account.id,'loading').catch(()=>{}); });
    on('auth_failure', () => { fail(account.id,'AUTH_FAILURE_RESCAN_MAY_BE_REQUIRED',e).catch(()=>{}); });
    on('disconnected', reason => { fail(account.id,'DISCONNECTED_'+String(reason).slice(0,60),e).catch(()=>{}); });
    on('ready', () => {
      e.ready=true;e.awaitingScan=false;e.launching=false;e.progressAt=Date.now();
      for(const ws of e.sockets)if(ws.scanOnly)ws.close();failures.delete(account.id);retryAt.delete(account.id);
      state(account.id,'ready',null,account.shared_pool?linkedPhone(e):(e.client.info?.wid?.user||null)).catch(()=>{});
      e.client.pupPage.bringToFront().catch(()=>{});
      syncHistory(account.id,e).catch(err=>console.error('history sync:',err.code||err.name));
    });
    // Real receipts remain valid across a reconnect; only connection-state callbacks are generation-bound.
    e.client.on('message_ack',(message,ack)=>{receiveAck(account.id,messageId(message),ack).catch(err=>console.error('receipt persistence:',err.code||err.name));});
    e.client.on('message_create',message=>{recordMessage(account.id,message).catch(err=>console.error('message history:',err.code||err.name));});
    e.client.initialize().then(async()=>{
      if(!lifecycle.current(entries,e)){
        try{await e.client.destroy();}catch{}
        return;
      }
      e.launching=false;
      e.client.pupPage?.bringToFront().catch(()=>{});
      watchBrowser();
    }).catch(error=>{
      if(!lifecycle.current(entries,e))return;
      console.error(describeStartupError(error,'chromium-initialize'));
      fail(account.id,'WHATSAPP_INITIALIZATION_FAILED',e).catch(()=>{});
    });
  } catch (err) { console.error(describeStartupError(err,'desktop-setup'));fail(account.id,err.message||'START_FAILED',e).catch(error=>console.error('browser cleanup:',error.code||error.name)); }
  })();
  await e.setup;
}
async function recordMessage(accountId,message,actorId=null,live=true) {
  const mid=messageId(message);if(!mid||!message.fromMe)return;
  const ack=messageAck(message),sentAt=Number.isFinite(message.timestamp)?new Date(message.timestamp*1000):new Date();
  if((await pool.query('SELECT 1 FROM history_exclusions WHERE account_id=$1 AND message_hash=$2',[accountId,crypto.createHash('sha256').update(mid).digest('hex')])).rowCount)return;
  if(live&&!actorId) actorId=(await pool.query(`SELECT s.user_id FROM control_leases l JOIN sessions s ON s.token_hash=l.session_hash WHERE l.account_id=$1 AND l.expires_at>now()`,[accountId])).rows[0]?.user_id||null;
  await pool.query(`INSERT INTO message_history(account_id,message_id,actor_id,recipient,body,status,ack,sent_at,message_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(account_id,message_id) DO UPDATE SET actor_id=COALESCE(message_history.actor_id,excluded.actor_id)`,[accountId,mid,actorId,String(message.to||message.id?.remote||''),String(message.body||''),ackStatus(ack),ack,sentAt,message.type||'chat']);
  await receiveAck(accountId,mid,ack);
}
async function reconcileUnknown(accountId,client,snapshot=null) {
  const rows=(await pool.query(`SELECT r.*,c.body,c.created_by,c.media FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE COALESCE(r.send_account_id,c.account_id)=$1 AND c.deleted_at IS NULL AND r.status='unknown' AND r.started_at IS NOT NULL ORDER BY r.started_at DESC LIMIT 100`,[accountId])).rows;
  const chats=new Map();
  for(const row of rows){
    try{
      // Older sends can only match if WhatsApp kept the original image bytes.
      // Re-encoded legacy images remain unknown; a caption alone proves nothing.
      const fingerprint=row.media_fingerprint||(row.media?.data?crypto.createHash('sha256').update(Buffer.from(row.media.data,'base64')).digest('base64'):null);
      if(row.media&&!fingerprint)continue;
      const chatId=row.phone?.replace(/^\+/,'')+'@c.us';
      if(!chats.has(chatId))chats.set(chatId,snapshot?snapshot.filter(m=>m.chatId===chatId||m.to===chatId):await (await client.getChatById(chatId)).fetchMessages({limit:100}));
      const matches=chats.get(chatId).filter(m=>m.fromMe&&messageId(m)&&m.body===row.body&&(row.media?(m.type==='image'&&m.filehash===fingerprint):(!m.type||m.type==='chat'))&&Math.abs(m.timestamp*1000-+new Date(row.started_at))<=90000);
      if(matches.length!==1)continue;
      const message=matches[0],mid=messageId(message);
      // Ambiguous repeated identical sends remain unknown for human review.
      if(rows.filter(other=>other.phone===row.phone&&other.body===row.body&&(!row.media||!other.media_fingerprint||other.media_fingerprint===fingerprint)&&Math.abs(message.timestamp*1000-+new Date(other.started_at))<=90000).length!==1)continue;
      if((await pool.query('SELECT 1 FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE r.message_id=$1 AND COALESCE(r.send_account_id,c.account_id)=$2',[mid,accountId])).rowCount)continue;
      await pool.query("UPDATE recipients SET status=$1,message_id=$2,ack=$3,error_code=NULL,updated_at=now() WHERE id=$4 AND status='unknown'",[ackStatus(messageAck(message)),mid,messageAck(message),row.id]);
      await recordMessage(accountId,message,row.created_by,false);
      await audit(row.created_by,'message.reconciled',row.campaign_id,{recipient_id:row.id,message_id:mid});
      console.log('History reconciliation: recovered one uncertain result');
    }catch(err){console.error('reconcile item:',err.code||err.name);}
  }
}
async function syncHistory(accountId,entry) {
  if(entry.syncing||entry.closing)return;
  entry.syncing=true;entry.nextSync=Date.now()+15000;
  try{
    const targets=(await pool.query(`SELECT DISTINCT r.phone FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE COALESCE(r.send_account_id,c.account_id)=$1 AND c.deleted_at IS NULL AND r.status IN('unknown','awaiting_ack','submitted','delivered') AND r.started_at>now()-interval '7 days' LIMIT 50`,[accountId])).rows;
    const snapshot=await readSnapshot(entry.client,targets.map(r=>r.phone.replace(/^\+/, '')+'@c.us'),Math.floor(Date.now()/1000)-7*86400);
    for(const message of snapshot.messages)await recordMessage(accountId,message,null,false);
    // Incomplete history cannot establish a unique match for an uncertain send.
    if(!snapshot.chatErrors)await reconcileUnknown(accountId,entry.client,snapshot.messages);
    await pool.query('UPDATE accounts SET history_synced_at=now(),history_sync_error=$2 WHERE id=$1',[accountId,snapshot.chatErrors?'PARTIAL_CHAT_HISTORY':null]);
    entry.syncFailures=0;
    if(!entry.syncReported){console.log('History sync ready:',JSON.stringify({messages:snapshot.messages.length,chatErrors:snapshot.chatErrors}));entry.syncReported=true;}
  }catch(err){
    entry.syncReported=false;
    const code=historyFailureCode(err);
    entry.syncFailures=(entry.syncFailures||0)+1;entry.nextSync=Date.now()+Math.min(300000,15000*2**Math.min(entry.syncFailures,5));
    await pool.query('UPDATE accounts SET history_sync_error=$2 WHERE id=$1',[accountId,code]).catch(()=>{});
    console.error('history sync:',code,JSON.stringify({account:crypto.createHash('sha256').update(accountId).digest('hex').slice(0,12),...await lifecycle.resourceSummary()}));
    if(lifecycle.current(entries,entry)&&lifecycle.browserClosed(entry))await fail(accountId,'BROWSER_EXITED',entry);
  }finally{entry.syncing=false;}
}
const eligible = `u.active AND NOT u.locked AND c.shared_pool=a.shared_pool
  AND (NOT c.shared_pool OR (EXISTS(SELECT 1 FROM shared_settings WHERE id=1 AND enabled) AND ${connectedSQL}))
  AND (u.role='owner' OR (u.role='user' AND (c.shared_pool OR EXISTS
  (SELECT 1 FROM account_grants g WHERE g.user_id=u.id AND g.account_id=c.account_id))))`;
async function dispatch(account, entry) {
  if (busy.has(account.id) || !entry.ready || shuttingDown) return;
  busy.add(account.id);
  let recipient;
  try {
    const candidates = (await pool.query(`SELECT c.* FROM campaigns c JOIN users u ON u.id=c.created_by JOIN accounts a ON a.id=c.account_id
      WHERE c.account_id=$1 AND c.enabled AND c.deleted_at IS NULL AND NOT c.cancelled AND (c.send_now OR (c.scheduled_at<=now() AND (c.expires_at IS NULL OR c.expires_at>now()))) AND a.enabled AND a.next_send_at<=now() AND ${eligible}
      AND NOT EXISTS(SELECT 1 FROM control_leases l WHERE l.account_id=a.id AND l.expires_at>now())
      AND EXISTS(SELECT 1 FROM recipients r WHERE r.campaign_id=c.id AND r.status='pending')
      ORDER BY c.send_now DESC,c.created_at`, [account.id])).rows;
    const campaign = candidates.find(c => canDispatch(c)); if (!campaign) return;
    recipient = await transaction(async db=>{
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[campaign.created_by]);
      const current=(await db.query('SELECT * FROM campaigns WHERE id=$1 FOR UPDATE',[campaign.id])).rows[0];
      if(!current||current.account_id!==account.id||current.deleted_at||!canDispatch(current))return null;
      const next=(await db.query("SELECT id FROM recipients WHERE campaign_id=$1 AND status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",[campaign.id])).rows[0];
      if(!next)return null;
      const reservation=await billing.reserveForSend(db,current.created_by,next.id);
      if(!reservation.ok){await db.query('UPDATE campaigns SET enabled=false,pause_reason=$2 WHERE id=$1',[campaign.id,reservation.pause_reason]);await db.query('UPDATE recipients SET error_code=$2,updated_at=now() WHERE id=$1',[next.id,reservation.error]);return null;}
      return (await db.query(`UPDATE recipients SET status='sending',started_at=now(),send_account_id=$2,updated_at=now()
        WHERE id=(SELECT id FROM recipients WHERE campaign_id=$1 AND status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,[campaign.id,account.id])).rows[0];
    });
    if (!recipient) return;
    // Persist 'sending' before contacting WhatsApp. Crash recovery never blindly resends it.
    const stillAllowed = (await pool.query(`SELECT c.* FROM campaigns c JOIN users u ON u.id=c.created_by JOIN accounts a ON a.id=c.account_id
      WHERE c.id=$1 AND c.enabled AND c.deleted_at IS NULL AND NOT c.cancelled AND a.enabled AND ${eligible}
      AND NOT EXISTS(SELECT 1 FROM control_leases l WHERE l.account_id=a.id AND l.expires_at>now())`, [campaign.id])).rows[0];
    if (!stillAllowed || !canDispatch(stillAllowed)) { await pool.query("UPDATE recipients SET status='pending',started_at=NULL,updated_at=now() WHERE id=$1", [recipient.id]); await billing.settle(recipient.id,'pending'); return; }
    const result = await send(entry, recipient, campaign);
    // A late completion may already have replaced sending with its real result.
    await pool.query("UPDATE recipients SET status=$1,error_code=$2,message_id=$3,ack=$4,updated_at=now() WHERE id=$5 AND status='sending'", [result.status, result.error, result.messageId || null, result.ack ?? null, recipient.id]);
    if (result.messageId) {
      const receipt = (await pool.query('SELECT ack FROM receipts WHERE account_id=$1 AND message_id=$2', [account.id, result.messageId])).rows[0];
      if (receipt) await receiveAck(account.id, result.messageId, receipt.ack);
    }
    await billing.settle(recipient.id,(await pool.query('SELECT status FROM recipients WHERE id=$1',[recipient.id])).rows[0]?.status);
    if(result.status!=='pending')await pool.query(`UPDATE accounts SET
      next_send_at=CASE WHEN (CASE WHEN batch_campaign_id=$3 THEN batch_sent ELSE 0 END)+1 >= $4 THEN now()+($1::integer*interval '1 millisecond') ELSE now() END,
      batch_sent=CASE WHEN (CASE WHEN batch_campaign_id=$3 THEN batch_sent ELSE 0 END)+1 >= $4 THEN 0 ELSE (CASE WHEN batch_campaign_id=$3 THEN batch_sent ELSE 0 END)+1 END,
      batch_campaign_id=$3 WHERE id=$2`,[campaign.interval_ms,account.id,campaign.id,campaign.batch_size||1]);
    if (result.quarantine) {
      await pool.query("UPDATE campaigns SET enabled=false,pause_reason='review' WHERE id=$1",[campaign.id]);
      await audit(campaign.created_by,'campaign.review_required',campaign.id,{recipient_id:recipient.id,reason:result.error});
    }
  } catch (err) {
    if (recipient) await pool.query("UPDATE recipients SET status='unknown',error_code='WORKER_EXCEPTION_REVIEW_REQUIRED',updated_at=now() WHERE id=$1 AND status='sending'", [recipient.id]).catch(() => {});
    console.error('dispatch:', err.code || err.name);
  } finally { busy.delete(account.id); }
}
async function send(entry, recipient, campaign, {timeoutMs=60000}={}) {
  let startedSend=false,expired=false,stage='lookup';
  const attempt=crypto.randomUUID(),deadline=Date.now()+timeoutMs;
  const tracked=typeof entry.client.prepareWorkspaceMessage==='function'&&typeof entry.client.sendWorkspaceMessage==='function';
  const stopped=()=>expired||Date.now()>=deadline||shuttingDown||entry.closing;
  const permitted=async()=>{
    const allowed=(await pool.query(`SELECT c.* FROM campaigns c JOIN users u ON u.id=c.created_by JOIN accounts a ON a.id=c.account_id
      WHERE c.id=$1 AND c.enabled AND c.deleted_at IS NULL AND NOT c.cancelled AND a.enabled AND ${eligible}
      AND NOT EXISTS(SELECT 1 FROM control_leases l WHERE l.account_id=a.id AND l.expires_at>now())`,[campaign.id])).rows[0];
    return allowed&&canDispatch(allowed);
  };
  const operation = (async () => {
    try {
      const wid = await entry.client.getNumberId(recipient.phone.replace(/^\+/, ''));
      if (!wid) return { status: 'invalid', error: 'NOT_ON_WHATSAPP' };
      if(stopped())return {status:'failed',error:'SEND_STOPPED_BEFORE_SUBMISSION',quarantine:true};
      if(!await permitted())return {status:'pending',error:null};
      if(stopped())return {status:'failed',error:'SEND_STOPPED_BEFORE_SUBMISSION',quarantine:true};
      let prepared;
      if(tracked){
        stage='prepare';
        prepared=await entry.client.prepareWorkspaceMessage(attempt,wid._serialized,campaign.body,campaign.media||null,deadline);
        // Media upload may be slow. Recheck permissions and the deadline before enqueueing.
        if(stopped())return {status:'failed',error:'SEND_STOPPED_BEFORE_SUBMISSION',quarantine:true};
        if(!await permitted())return {status:'pending',error:null};
      }
      if(stopped())return {status:'failed',error:'SEND_STOPPED_BEFORE_SUBMISSION',quarantine:true};
      await pool.query('UPDATE recipients SET media_fingerprint=$1,send_attempt_id=$2,started_at=now() WHERE id=$3',[prepared?.filehash||null,attempt,recipient.id]);
      if(stopped())return {status:'failed',error:'SEND_STOPPED_BEFORE_SUBMISSION',quarantine:true};
      stage='send';
      startedSend = true;
      const message=tracked?await entry.client.sendWorkspaceMessage(attempt):await entry.client.sendMessage(wid._serialized,campaign.media?new MessageMedia(campaign.media.mimetype,campaign.media.data,campaign.media.filename):campaign.body,{waitUntilMsgSent:false,sendSeen:false,...(campaign.media?{caption:campaign.body}:{})});
      const mid=messageId(message);
      if(!mid) return {status:'unknown',error:'SEND_ID_MISSING_REVIEW_REQUIRED',quarantine:true};
      await recordMessage(entry.id,{...message,fromMe:true,to:message.to||wid._serialized},campaign.created_by).catch(err=>console.error('message history:',err.code||err.name));
      return { status: ackStatus(messageAck(message)), error: null, messageId:mid, ack:messageAck(message) };
    } catch(error) {
      const uncertain=startedSend&&!error?.notSent;
      const code=error?.sendCode||(!startedSend&&stage==='lookup'?'NUMBER_LOOKUP_FAILED':sendFailureCode(error,stage));
      console.error('Message send:',JSON.stringify({account:crypto.createHash('sha256').update(entry.id).digest('hex').slice(0,12),stage,media:Boolean(campaign.media),code,uncertain}));
      return {status:uncertain?'unknown':'failed',error:code,quarantine:startedSend||stage==='prepare',definitelyNotSent:error?.notSent===true};
    } finally {
      if(tracked)entry.client.discardWorkspaceMessage?.(attempt).catch(()=>{});
    }
  })();
  let timer;
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>{
    expired=true;
    const code=startedSend?'SEND_TIMEOUT_REVIEW_REQUIRED':stage==='prepare'?'MEDIA_PREPARATION_TIMEOUT':'NUMBER_LOOKUP_TIMEOUT';
    console.error('Message send:',JSON.stringify({account:crypto.createHash('sha256').update(entry.id).digest('hex').slice(0,12),stage,media:Boolean(campaign.media),code,uncertain:startedSend}));
    resolve({status:startedSend?'unknown':'failed',error:code,quarantine:true});
  },timeoutMs);});
  const result = await Promise.race([operation, timeout]); clearTimeout(timer);
  // A late successful completion is still recorded. Never start a duplicate send.
  if (result.quarantine) operation.then(async late => {
    if (late.messageId) {
      await pool.query("UPDATE recipients SET status=$1,error_code=NULL,message_id=$2,ack=$3,updated_at=now() WHERE id=$4 AND status IN ('sending','unknown') AND send_attempt_id=$5", [late.status, late.messageId, late.ack, recipient.id,attempt]);
      const saved = (await pool.query('SELECT ack FROM receipts WHERE account_id=$1 AND message_id=$2', [entry.id, late.messageId])).rows[0];
      if (saved) await receiveAck(entry.id, late.messageId, saved.ack);
    }else if(late.definitelyNotSent){
      await pool.query("UPDATE recipients SET status='failed',error_code=$1,updated_at=now() WHERE id=$2 AND status IN ('sending','unknown') AND send_attempt_id=$3",[late.error,recipient.id,attempt]);
    }
  }).catch(() => {});
  return result;
}
let ticking = false,nextResourceLog=0;
async function tick() {
  if (ticking || shuttingDown) return;
  ticking = true;
  try {
    await billing.reconcile();
    await billing.recoverCreditTasks(null,group);
    await shared.rebalance();
    const accounts = (await pool.query(accountWorkSQL,[group,[...entries.keys()]])).rows;
    for (const a of accounts) {
      if(a.purge_requested){
        const current=entries.get(a.id);
        if(busy.has(a.id)||current?.syncing)continue;
        await stopAccount(a.id);
        for(const folder of ['profiles','homes'])await fs.rm(path.join(dataPath,folder,a.id),{recursive:true,force:true});
        await purgeAccountData(a.id);retryAt.delete(a.id);failures.delete(a.id);continue;
      }
      if (!a.enabled || a.deleted_at) {
        if (busy.has(a.id)) continue; // in-flight sends can finish; no further sends are dispatched
        const running=entries.has(a.id);await stopAccount(a.id);if(running||a.status!=='disabled')await state(a.id, 'disabled');continue;
      }
      if (!entries.has(a.id) && entries.size < maxAccounts && !lifecycle.starting(entries) && Date.now() >= (retryAt.get(a.id) || 0)) await startAccount(a);
      const e = entries.get(a.id);
      if(e&&!e.closing&&lifecycle.browserClosed(e)){await fail(a.id,'BROWSER_EXITED',e);continue;}
      if(e&&lifecycle.expired(e)){await fail(a.id,'LOGIN_TIMEOUT',e);continue;}
      if (e) {
        await pool.query('UPDATE accounts SET heartbeat_at=now() WHERE id=$1', [a.id]);
        if (e.client?.pupPage && !e.ready) e.client.pupPage.bringToFront().catch(() => {});
        if(e.ready && Date.now()>=(e.nextSync||0))syncHistory(a.id,e).catch(()=>{});
        if (e.ready) dispatch(a, e).catch(() => {});
      } else if (entries.size >= maxAccounts&&a.status!=='capacity_wait') await state(a.id, 'capacity_wait', 'WORKER_CAPACITY_REACHED');
    }
    await pool.query(`INSERT INTO worker_health(worker_group,heartbeat_at,accounts_running,rss_mb,max_accounts) VALUES($1,now(),$2,$3,$4)
      ON CONFLICT(worker_group) DO UPDATE SET heartbeat_at=now(),accounts_running=excluded.accounts_running,rss_mb=excluded.rss_mb,max_accounts=excluded.max_accounts`, [group, entries.size, Math.round(process.memoryUsage().rss / 1048576),maxAccounts]);
    shared.checkGroup(group,entries).catch(e=>console.error('shared connection check:',e.code||e.name));
    if(Date.now()>=nextResourceLog){nextResourceLog=Date.now()+60000;const active=[...entries.values()];console.log('Browser capacity:',JSON.stringify({...await lifecycle.resourceSummary(),running:active.length,ready:active.filter(e=>e.ready&&!e.closing).length,scan_waiting:active.filter(e=>e.awaitingScan&&!e.closing).length,cpus_per_browser:runtime.CPUS_PER_BROWSER}));}
  } finally { ticking = false; }
}
async function start() {
  assert(/^[\w-]{1,40}$/.test(group || ''), 'WORKER_GROUP is required', 500);
  assert(Number.isInteger(maxAccounts) && maxAccounts >= 1 && maxAccounts <= 10, 'MAX_ACCOUNTS_PER_WORKER must be 1–10', 500);
  await fs.mkdir(dataPath, { recursive: true });
  const lock = await pool.connect();
  const held = (await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) ok', ['wa-worker-' + group])).rows[0].ok;
  assert(held, 'Another worker owns this group. Use distinct groups, never replicas with the same profile.', 500);
  lock.on('error', () => { console.error('Worker ownership lost'); process.exit(1); });
  await pool.query(`UPDATE recipients r SET status='unknown',error_code='WORKER_RESTART_REVIEW_REQUIRED',updated_at=now()
    FROM campaigns c JOIN accounts a ON a.id=c.account_id WHERE r.campaign_id=c.id AND a.worker_group=$1 AND r.status='sending'`, [group]);
  await shared.recoverInterrupted(group);
  await pool.query("UPDATE accounts SET status='starting',shared_state=CASE WHEN shared_pool THEN 'waiting' ELSE shared_state END,shared_checked_at=CASE WHEN shared_pool THEN NULL ELSE shared_checked_at END WHERE worker_group=$1 AND enabled AND deleted_at IS NULL",[group]);
  const app = express();
  app.get('/healthz', async (_, res) => { try { await lock.query('SELECT 1'); res.json({ ok: true, role: 'worker', group }); } catch { res.sendStatus(503); } });
  app.use((req, res, next) => authorized(req) ? next() : res.sendStatus(401));
  app.get('/accounts/:id/status', async (req, res) => {
    try {
      const a = (await pool.query('SELECT status,enabled,last_error FROM accounts WHERE id=$1 AND worker_group=$2', [req.params.id, group])).rows[0];
      if (!a) return res.status(404).json({ error: 'Account unavailable' });
      const e = entries.get(req.params.id);
      const healthy=e&&!e.closing&&!lifecycle.browserClosed(e),code=a.last_error==='BROWSER_RESOURCE_WAIT'?'BROWSER_RESOURCE_WAIT':e?.rendererCrashed||!healthy&&['BROWSER_PAGE_CRASHED','BROWSER_PAGE_CLOSED','BROWSER_EXITED'].includes(a.last_error)?'BROWSER_RECOVERING':null;
      res.json({ role: 'worker', group, status: a.status, code, screen_ready: Boolean(a.enabled && e?.desktopReady && healthy), connected: Boolean(a.enabled && e?.ready && healthy) });
    } catch { res.status(500).json({ error: 'Worker status unavailable' }); }
  });
  app.post('/accounts/:id/:command', async (req, res) => {
    try {
      assert(['start', 'restart'].includes(req.params.command), 'Unknown command');
      const a = (await pool.query('SELECT * FROM accounts WHERE id=$1 AND worker_group=$2 AND enabled', [req.params.id, group])).rows[0]; assert(a, 'Account unavailable', 404);
      assert(!busy.has(a.id), '账号正在发送，请稍后重启', 409);
      assert(entries.has(a.id) || entries.size < maxAccounts, '浏览器分组已满', 409);
      if (req.params.command === 'restart') await stopAccount(a.id);
      retryAt.delete(a.id); await startAccount(a);
      const e = entries.get(a.id); assert(e?.desktopReady && !e.closing, '浏览器启动失败，请查看分组日志', 503);
      await audit(null, 'worker.start', a.id); res.json({ ok: true });
    } catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Worker command failed' }); }
  });
  const server = http.createServer(app), wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    try {
      assert(authorized(req), 'Unauthorized', 401);
      const id = req.url.match(/^\/screen\/([a-f0-9-]+)$/)?.[1], entry = entries.get(id);
      assert(entry && !entry.closing, 'Desktop unavailable', 503);
      const enabled = (await pool.query('SELECT enabled FROM accounts WHERE id=$1', [id])).rows[0]?.enabled; assert(enabled, 'Disabled', 403);
      const requireUnlinked=req.headers['x-require-unlinked']==='true';assert(!requireUnlinked||!entry.ready,'Already linked',403);
      const requireReady=req.headers['x-require-ready']==='true';assert(!requireReady||entry.ready,'Owner linking required',403);
      const port = req.headers['x-control-mode'] === 'operate' ? entry.controlPort : entry.viewPort;
      wss.handleUpgrade(req, socket, head, ws => {
        const tcp = net.connect(port, '127.0.0.1');ws.scanOnly=requireUnlinked;entry.sockets.add(ws);
        const greeting=setTimeout(()=>ws.terminate(),15000);greeting.unref();tcp.once('data',()=>clearTimeout(greeting));
        ws.on('message', data => { if (!tcp.destroyed) tcp.write(data); });
        tcp.on('data', data => { if(requireReady&&!entry.ready||requireUnlinked&&entry.ready)return ws.close();if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 16 * 1024 * 1024) return ws.close(1009); ws.send(data); } });
        tcp.on('error', () => ws.close()); tcp.on('close', () => ws.close());
        const heartbeat=monitorSockets([ws],()=>tcp.destroy());
        ws.on('close', () => { clearTimeout(greeting);heartbeat.stop();tcp.destroy(); entry.sockets.delete(ws); }); ws.on('error', () => {clearTimeout(greeting);heartbeat.stop();tcp.destroy();});
      });
    } catch (err) { socket.write('HTTP/1.1 ' + (err.status || 403) + ' Rejected\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  const interval = setInterval(() => tick().catch(e => console.error('worker tick:', e.code || e.name)), 5000);
  tick().catch(e => console.error('worker startup:', e.code || e.name));
  await new Promise(resolve => server.listen(Number(process.env.PORT || 8080), '::', resolve));
  console.log('Browser worker ready:', group);
  console.log('Browser resources:',JSON.stringify(await lifecycle.resourceSummary()));
  process.on('SIGTERM', async () => {
    shuttingDown = true; clearInterval(interval); server.close();
    const hardStop = setTimeout(() => process.exit(0), 90000); hardStop.unref();
    while (busy.size) await pause(500);
    for (const id of [...entries.keys()]) await stopAccount(id);
    await lock.query('SELECT pg_advisory_unlock(hashtext($1))', ['wa-worker-' + group]).catch(() => {}); lock.release(); await pool.end(); process.exit(0);
  });
  return server;
}
module.exports = { accountWorkSQL, start, send, receiveAck, recordMessage, reconcileUnknown, syncHistory, eligible, dispatch };


