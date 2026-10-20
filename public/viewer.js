import RFB from '/novnc/core/rfb.js';
const query=new URLSearchParams(location.search),id=query.get('id'),mode=['operate','scan'].includes(query.get('mode'))?query.get('mode'):'view';
const status=document.getElementById('status'),screen=document.getElementById('screen'),retry=document.getElementById('retry'),start=document.getElementById('start-browser'),clipboard=document.getElementById('clipboard');
let rfb,connecting=false,leaving=false,reconnectTimer,handshakeTimer,scanTimer,attempts=0;
let requestingStart=false,lastStart=0,csrf;
const linkChecks=new WeakSet(),terminalCodes=new Set(['ALREADY_LINKED','OWNER_LINK_REQUIRED','ACCOUNT_DISABLED','ACCOUNT_IN_USE','WORKER_AUTH_FAILED','WORKER_NOT_CONFIGURED','WORKER_GROUP_MISMATCH','WORKER_ROUTE_INVALID','WORKER_UPDATE_REQUIRED']);
document.documentElement.lang=WA_LANG==='en'?'en':'zh-CN';
document.getElementById('back').textContent=T('← 返回后台','← Back');
document.getElementById('label').textContent=mode==='scan'?T('WhatsApp · 扫码关联','WhatsApp · QR linking'):mode==='operate'?T('WhatsApp Web · 可操作','WhatsApp Web · Control'):T('WhatsApp Web · 只看','WhatsApp Web · View only');
retry.textContent=T('重新连接画面','Reconnect screen');start.textContent=T('启动扫码浏览器','Start browser');clipboard.textContent=T('粘贴文字','Paste text');document.getElementById('fullscreen').textContent=T('全屏','Full screen');
document.getElementById('hint').textContent=mode==='scan'?T('用手机 WhatsApp → 已关联设备 → 关联设备扫描二维码；成功后返回后台查看聊天。','On your phone, open WhatsApp → Linked devices → Link a device and scan the QR. Return to the dashboard to view chats after linking.'):T('画面中断不代表 WhatsApp 被封。操作窗口打开时自动任务暂停，关闭后约 30 秒恢复。原版 WhatsApp 的语言由 WhatsApp 设置控制。','A screen interruption does not mean WhatsApp is banned. Automatic tasks pause in control mode and resume about 30 seconds after closing. The original WhatsApp language is controlled in WhatsApp settings.');
clipboard.hidden=mode!=='operate';clipboard.disabled=true;
async function json(path,options={}){const response=await fetch('/api'+path,{...options,signal:options.signal||AbortSignal.timeout(30000)});const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.code?connectionText(result):translateError(result.error)),{status:response.status});return result;}
function showIssue(message,canStart=false){status.textContent=message;const panel=document.createElement('section');panel.className='connection-panel';const title=document.createElement('h1');title.textContent=T('浏览器画面暂未连接','Browser screen not connected');const detail=document.createElement('p');detail.textContent=message;const guide=document.createElement('p');guide.textContent=T('网络、服务或画面中断不能判断账号被封。需要登录时，请用手机 WhatsApp → 已关联设备 → 关联设备扫码。','A network, service or screen interruption does not establish an account ban. To sign in, open WhatsApp on your phone → Linked devices → Link a device.');panel.append(title,detail,guide);screen.replaceChildren(panel);start.hidden=!canStart;clipboard.disabled=true;}
function scheduleReconnect(){if(leaving)return;clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>{attempts=Math.min(attempts+1,8);connect();},Math.min(30000,2000*2**Math.min(attempts,4)));}
function clearScreenTimers(){clearTimeout(handshakeTimer);clearTimeout(scanTimer);}
async function requestStart(force=false){
 if(leaving||requestingStart||(!force&&Date.now()-lastStart<15000))return;
 requestingStart=true;lastStart=Date.now();
 try{csrf=csrf||(await json('/me')).csrf;await json(`/accounts/${encodeURIComponent(id)}/start`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});}
 finally{requestingStart=false;}
}
function dropScreen(active=rfb){if(active&&rfb!==active)return;rfb=null;clearScreenTimers();active?.disconnect();}
async function checkLink(active){
 if(leaving||mode!=='scan'||rfb!==active||linkChecks.has(active))return;
 linkChecks.add(active);
 try{
  const info=await json(`/accounts/${encodeURIComponent(id)}/connection?mode=scan`);
  if(leaving||rfb!==active)return;
  if(!info.ok){dropScreen(active);showIssue(connectionText(info),info.can_start);if(!terminalCodes.has(info.code))scheduleReconnect();}
 }catch(error){
  if(rfb===active&&!leaving&&[401,403].includes(error.status)){dropScreen(active);showIssue(error.status===401?T('登录已过期，请返回后台登录','Session expired. Sign in from the dashboard.'):error.message);}
 }finally{
  linkChecks.delete(active);
  if(rfb===active&&!leaving)scanTimer=setTimeout(()=>checkLink(active),20000);
 }
}
async function connect(){
 if(connecting||leaving)return;
 connecting=true;retry.disabled=true;clearTimeout(reconnectTimer);clearScreenTimers();
 try{
  if(rfb)dropScreen();
  status.textContent=T('正在检查连接…','Checking connection…');
  const info=await json(`/accounts/${encodeURIComponent(id)}/connection?mode=${mode}`);if(leaving)return;
  if(!info.ok){showIssue(connectionText(info),info.can_start);if(!terminalCodes.has(info.code)){if(info.can_start&&(mode==='scan'||mode==='operate'))await requestStart();scheduleReconnect();}return;}
  screen.replaceChildren();start.hidden=true;
  const active=new RFB(screen,`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/screen/${encodeURIComponent(id)}?mode=${mode}`);
  rfb=active;active.scaleViewport=true;active.resizeSession=false;active.viewOnly=mode!=='operate';active.showDotCursor=true;
  handshakeTimer=setTimeout(()=>{
   if(rfb!==active||leaving)return;
   dropScreen(active);showIssue(T('画面连接超时，正在自动重连','The screen connection timed out. Reconnecting automatically.'));scheduleReconnect();
  },30000);
  active.addEventListener('connect',()=>{
   if(rfb!==active)return;
   clearTimeout(handshakeTimer);attempts=0;
   status.textContent=info.connected?T('画面已连接 · WhatsApp 在线','Screen connected · WhatsApp online'):T('画面已连接 · 等待手机扫码或同步','Screen connected · waiting for phone linking or sync');clipboard.disabled=false;
   if(mode==='scan')scanTimer=setTimeout(()=>checkLink(active),20000);
  });
  active.addEventListener('disconnect',()=>{
   if(rfb===active&&!leaving){rfb=null;clearScreenTimers();showIssue(T('画面暂时中断，正在重连；这不代表账号被封。','Screen interrupted. Reconnecting; this does not indicate an account ban.'));scheduleReconnect();}
  });
  active.addEventListener('securityfailure',()=>{if(rfb===active){dropScreen(active);showIssue(T('画面验证失败，请检查服务设置','Screen authentication failed. Check service settings.'));}});
 }catch(error){showIssue(error.status===401?T('登录已过期，请返回后台登录','Session expired. Sign in from the dashboard.'):error.message);if(![401,403].includes(error.status))scheduleReconnect();}
 finally{connecting=false;retry.disabled=false;}
}
retry.onclick=()=>{attempts=0;connect();};start.onclick=async()=>{start.disabled=true;try{await requestStart(true);attempts=0;await connect();}catch(e){showIssue(e.message,true);}finally{start.disabled=false;}};
clipboard.onclick=()=>{if(!rfb)return;const value=prompt(T('粘贴文字后，在远程聊天框按 Ctrl+V：','Paste text here, then press Ctrl+V in the remote chat:'));if(value!==null)rfb.clipboardPasteFrom(value);};document.getElementById('fullscreen').onclick=()=>screen.requestFullscreen();window.addEventListener('pagehide',()=>{leaving=true;clearTimeout(reconnectTimer);dropScreen();});window.addEventListener('online',()=>{if(!rfb){attempts=0;connect();}else if(mode==='scan')checkLink(rfb);});connect();

