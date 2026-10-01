import RFB from '/novnc/core/rfb.js';
const query = new URLSearchParams(location.search), id = query.get('id'), mode = query.get('mode') === 'operate' ? 'operate' : 'view';
const status = document.getElementById('status'), screen = document.getElementById('screen');
const retry = document.getElementById('retry'), start = document.getElementById('start-browser'), clipboard = document.getElementById('clipboard');
let rfb, connecting = false, leaving = false;
document.getElementById('label').textContent = mode === 'operate' ? '原版 WhatsApp Web · 可操作' : '原版 WhatsApp Web · 只看';
clipboard.hidden = mode !== 'operate'; clipboard.disabled = true;
async function json(path, options = {}) {
  const response = await fetch('/api' + path, options);
  let result;
  try { result = await response.json(); } catch { throw Error('无法读取连接状态，请返回后台重新登录或稍后重试。'); }
  if (!response.ok) throw Error(result.error || '连接检查失败');
  return result;
}
function showIssue(message, canStart = false) {
  status.textContent = message;
  const panel = document.createElement('section'); panel.className = 'connection-panel';
  const title = document.createElement('h1'); title.textContent = '扫码连接尚未建立';
  const detail = document.createElement('p'); detail.textContent = message;
  const guide = document.createElement('p'); guide.textContent = '添加号码只是保存账号备注。浏览器启动后，用手机 WhatsApp → 已关联设备 → 关联设备扫描二维码，后台显示“已连接”后才能发送。';
  panel.append(title, detail, guide); screen.replaceChildren(panel);
  start.hidden = !canStart; clipboard.disabled = true;
}
async function diagnose() {
  try {
    const info = await json(`/accounts/${encodeURIComponent(id)}/connection?mode=${mode}`);
    if (!leaving) showIssue(info.ok ? '浏览器画面连接中断，请点击“重新连接”；若仍失败，请管理员检查浏览器服务日志。' : info.message, !info.ok && info.can_start);
  } catch (error) { if (!leaving) showIssue(error.message); }
}
async function connect() {
  if (connecting || leaving) return;
  connecting = true; retry.disabled = true; start.disabled = true;
  status.textContent = '正在检查扫码服务…';
  try {
    if (rfb) { const old = rfb; rfb = null; old.disconnect(); }
    const info = await json(`/accounts/${encodeURIComponent(id)}/connection?mode=${mode}`);
    if (leaving) return;
    if (!info.ok) return showIssue(info.message, info.can_start);
    start.hidden = true; screen.replaceChildren(); status.textContent = '正在连接浏览器画面…';
    const active = new RFB(screen, `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/screen/${encodeURIComponent(id)}?mode=${mode}`);
    rfb = active; active.scaleViewport = true; active.resizeSession = false; active.viewOnly = mode !== 'operate'; active.showDotCursor = true;
    active.addEventListener('connect', () => { if (rfb === active) { status.textContent = info.connected ? '已连接浏览器' : '已连接浏览器 · 请用手机扫码登录 WhatsApp'; clipboard.disabled = false; } });
    active.addEventListener('disconnect', () => { if (rfb === active && !leaving) { rfb = null; diagnose(); } });
    active.addEventListener('securityfailure', () => { if (rfb === active) showIssue('浏览器画面验证失败，请联系管理员检查服务配置。'); });
  } catch (error) { if (!leaving) showIssue(error.message); }
  finally { connecting = false; retry.disabled = false; start.disabled = false; }
}
retry.onclick = connect;
start.onclick = async () => {
  start.disabled = true; retry.disabled = true;
  try {
    const session = await json('/me');
    await json(`/accounts/${encodeURIComponent(id)}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: '{}' });
    await connect();
  } catch (error) { showIssue(error.message, true); }
  finally { start.disabled = false; retry.disabled = false; }
};
clipboard.onclick = () => { if (!rfb) return; const value = prompt('粘贴文字到远程剪贴板，再在聊天框按 Ctrl+V：'); if (value !== null) rfb.clipboardPasteFrom(value); };
document.getElementById('fullscreen').onclick = () => screen.requestFullscreen();
window.addEventListener('pagehide', () => { leaving = true; rfb?.disconnect(); });
connect();
