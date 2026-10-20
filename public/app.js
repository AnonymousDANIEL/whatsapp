'use strict';
let me,csrf,accounts=[],users=[],campaigns=[],overviewData={counts:{},days:[]},page=sessionStorage.getItem('wa_page')||'overview',clockOffset=0,loading=false;
if(page==='reports')page='tasks';
const historyPages={audit:1,messages:1};
let pageRequest=null,pageRequestVersion=0,lastRenderedPage='',lastRenderSignature='',noticeSignature='';
let navOpen=new Set(),navStateUser='';
let accountGroupsOpen=new Set(),accountGroupSession='',accountAccessUsers=[];
let dashboardOpen=new Set(),dashboardSession='';
let ownerSendData=null,sendPages={tasks:{},messages:{}};
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let userStatusFilter=sessionStorage.getItem('wa_user_status_filter')||'active';if(!['active','locked','inactive'].includes(userStatusFilter))userStatusFilter='active';
const userState=u=>!u.active?'inactive':u.locked?'locked':'active';
let billingData=null,billingUser='',paymentSettings={},paymentOrders=[],noticeData={enabled:false};
let billingRefundBefore=null,billingRefundTrail=[];
const returnOrder=new URLSearchParams(location.search).get('topup');if(returnOrder)page='fpx';
const money=n=>'RM '+(Number(n||0)/10000).toFixed(4);
const credits=n=>BigInt(n??0).toString();
const labels={fpx:['Online FPX','Online FPX'],billing:['余额 / 充值','Credit / top-up'],overview:['总览','Overview'],accounts:['WhatsApp 账号','WhatsApp accounts'],tasks:['发送任务','Send tasks'],messages:['发送记录','Message history'],users:['USER ID 管理','USER IDs'],audit:['操作记录','Activity log'],system:['服务状态','Service status'],notices:['公告管理','Notices'],banks:['银行管理','Banks'],'bank-deposits':['银行充值','Bank deposits'],'bank-transactions':['银行流水','Bank transactions']};
Object.assign(labels,{shared:['共享 WhatsApp','Shared WhatsApp'],'shared-tasks':['共享发送任务','Shared send tasks'],'shared-records':['共享发送记录','Shared message history']});
const states={ready:['已连接','Connected'],scan_required:['待手机扫码','Scan to link'],starting:['启动中','Starting'],loading:['同步中','Syncing'],stopped:['待启动','Not started'],disabled:['停用','Inactive'],error:['连接需恢复','Reconnecting needed'],worker_offline:['服务暂时离线','Service offline'],capacity_wait:['等待连接资源','Waiting for connection capacity'],pending:['等待','Waiting'],sending:['发送中','Sending'],awaiting_ack:['已创建，等待回执','Created · awaiting receipt'],submitted:['发送成功（已提交）','Sent successfully (submitted)'],delivered:['已送达','Delivered'],read:['已读','Read'],failed:['失败','Failed'],invalid:['失败：号码无效','Failed: invalid number'],unknown:['结果未确认','Unconfirmed'],cancelled:['已取消','Cancelled']};
const state=s=>states[s]?T(...states[s]):s;
const ownerHint=(zh,en,classes='note',tag='div')=>me.role==='owner'?`<${tag} class="${classes}">${T(zh,en)}</${tag}>`:'';
const date=s=>s?new Date(s).toLocaleString(WA_LANG==='en'?'en-GB':'zh-CN',{timeZone:'Asia/Kuala_Lumpur',hourCycle:'h23'}):'—';
function loginRecency(value,now=Date.now()+clockOffset){
 const time=value?Date.parse(value):NaN;
 if(!Number.isFinite(time))return 'neutral';
 const age=now-time;return age<86400000?'green':age<7*86400000?'orange':'red';
}
function lastLoginBadge(value){
 const color=loginRecency(value),description={green:T('24 小时内有登入','Signed in within 24 hours'),orange:T('已满 1 天未登入','No sign-in for at least 1 day'),red:T('已满 7 天未登入','No sign-in for at least 7 days'),neutral:T('暂无登入记录','No sign-in record')}[color];
 return `<span class="badge last-login ${color}" data-login-recency="${color}" title="${esc(description)}" aria-label="${esc(description+(color==='neutral'?'':': '+date(value)))}">${color==='neutral'?description:esc(date(value))}</span>`;
}
const num=n=>Number(n||0).toLocaleString('en-US');
const badge=s=>`<span class="badge ${['ready','delivered','read','submitted'].includes(s)?'green':['failed','invalid','error','worker_offline'].includes(s)?'red':'blue'}">${esc(state(s))}</span>`;
const table=(headers,rows)=>`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>${rows.length?'':`<div class="empty">${T('暂无记录','No records')}</div>`}</div>`;
function toast(text,bad=false){$('#toast').textContent=text;$('#toast').className=bad?'bad':'';$('#toast').style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').style.display='none',6500);}
async function api(path,options={}){const r=await fetch('/api'+path,{...options,signal:options.signal||AbortSignal.timeout(30000),headers:{'Content-Type':'application/json','X-CSRF-Token':csrf||'',...options.headers}});const data=await r.json().catch(()=>({error:T('服务返回异常','Invalid server response')}));if(!r.ok){if(r.status===401)showLogin();throw Object.assign(new Error(data.code?connectionText(data):translateError(data.error||'Request failed')),{status:r.status});}return data;}
function staticText(){document.documentElement.lang=WA_LANG==='en'?'en':'zh-CN';document.querySelectorAll('[data-zh]').forEach(n=>n.textContent=T(n.dataset.zh,n.dataset.en));$('#language').value=WA_LANG;$('#session-message').textContent=T('正在恢复登录状态…','Restoring your session…');}
function showLogin(){loginHistoryGeneration++;pageRequest?.abort();pageRequestVersion++;loading=false;lastRenderedPage='';lastRenderSignature='';noticeSignature='';me=null;ownerSendData=null;sendPages={tasks:{},messages:{}};resetBankUI();resetSharedUI();navOpen=new Set();navStateUser='';sessionStorage.removeItem('wa_nav_expanded');accountGroupsOpen=new Set();accountGroupSession='';accountAccessUsers=[];sessionStorage.removeItem('wa_account_groups');dashboardOpen=new Set();dashboardSession='';sessionStorage.removeItem('wa_dashboard_open');$('#nav').replaceChildren();delete $('#nav').dataset.signature;userStatusFilter='active';sessionStorage.removeItem('wa_user_status_filter');users=[];accounts=[];campaigns=[];billingData=null;billingRefundBefore=null;billingRefundTrail=[];sessionStorage.removeItem('wa_billing_view');paymentSettings={};paymentOrders=[];noticeData={enabled:false};$('#content').replaceChildren();$('#modal-content').replaceChildren();$('#workspace-notice').hidden=true;$('#shell').hidden=true;$('#password-btn').hidden=true;$('#session-loading').hidden=true;$('#login').hidden=false;$('#modal').close();}
function modal(title,html,callback){loginHistoryGeneration++;$('#modal-title').textContent=title;$('#modal-content').innerHTML=html;if(!$('#modal').open)$('#modal').showModal();const f=$('#modal form');if(f)f.onsubmit=async e=>{e.preventDefault();if(f.dataset.busy)return;f.dataset.busy='1';const bs=[...f.querySelectorAll('button[type=submit]')];bs.forEach(b=>b.disabled=true);try{await callback(f,e.submitter);$('#modal').close();await loadPage();}catch(err){toast(err.message,true);}finally{delete f.dataset.busy;bs.forEach(b=>b.disabled=false);}};}
const submit=()=>`<div class="form-actions"><button type="submit" class="primary">${T('保存','Save')}</button></div>`;
function fpxAvailable(){return paymentSettings.enabled&&paymentSettings.configured&&!paymentSettings.sandbox;}
function navIcon(target){
 const shapes={
  overview:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  billing:'<path d="M20 7H6a3 3 0 0 1 0-6h12v6M3 4v14a3 3 0 0 0 3 3h14V7"/><path d="M20 11h-5v6h5m-3-3h.01"/>',
  fpx:'<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 9h20M6 15h5m4-1 2 2 3-3"/>',
  banks:'<path d="m3 8 9-5 9 5H3m0 13h18M5 11v7m7-7v7m7-7v7"/>',
  'bank-deposits':'<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3m3 5h6m-6 4h6m-6 4h3"/>',
  'bank-transactions':'<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
  accounts:'<path d="M21 11.5a8.5 8.5 0 0 1-12.7 7.4L3 21l1.7-5.4A8.5 8.5 0 1 1 21 11.5Z"/><path d="m8 7 2 3-1.2 1.2a7 7 0 0 0 4 4L14 14l3 2c-1 3-3.8 2.1-6.6-.1S6.3 9.6 8 7Z"/>',
  shared:'<path d="M8 5V3h13v12h-3M3 8h13v10H8l-5 3V8Z"/><path d="M7 12h5m-5 3h3"/>',
  tasks:'<path d="m22 2-7 20-4-9L2 9 22 2ZM11 13 22 2"/>',
  messages:'<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7m2-4v5l3 2"/>',
  notices:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-9 12a3 3 0 0 0 6 0"/>',
  users:'<circle cx="9" cy="7" r="4"/><path d="M2 21v-3a7 7 0 0 1 14 0v3m1-18a4 4 0 0 1 0 8m3 10v-3a7 7 0 0 0-2-5"/>',
  audit:'<path d="M9 3H5v18h14V3h-4m-6-1h6v4H9V2m-1 9 1 1 2-2m2 1h3m-8 5 1 1 2-2m2 1h3"/>',
  system:'<path d="M2 12h5l3-8 4 16 3-8h5"/>'
 };
 const kind=target==='shared-tasks'?'tasks':target==='shared-records'?'messages':target;
 return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shapes[kind]||shapes.overview}</svg>`;
}
function menuTree(){
 const node=(page,children=[])=>({page,children});
 const payments=me.role==='owner'?[node('fpx'),node('banks',[node('bank-deposits'),node('bank-transactions')])]:[];
 return [node('overview'),node('billing',payments),node('accounts',[node('tasks'),node('messages')]),node('shared',[node('shared-tasks'),node('shared-records')]),...(me.role==='owner'?[node('notices'),node('users',[node('audit'),node('system')])]:[])];
}
function menuPath(nodes,target,parents=[]){for(const n of nodes){if(n.page===target)return parents;const path=menuPath(n.children,target,[...parents,n.page]);if(path)return path;}return null;}
function saveMenuState(){try{sessionStorage.setItem('wa_nav_expanded',JSON.stringify({user_id:me.id,role:me.role,open:[...navOpen]}));}catch{}}
function restoreMenuState(tree){
 const scope=me.id+':'+me.role;if(navStateUser===scope)return;navStateUser=scope;navOpen=new Set();let saved;
 try{saved=JSON.parse(sessionStorage.getItem('wa_nav_expanded'));}catch{}
 if(saved?.user_id===me.id&&saved.role===me.role&&Array.isArray(saved.open)&&saved.open.length<=20)navOpen=new Set(saved.open.filter(id=>typeof id==='string'));
 else navOpen=new Set(menuPath(tree,page)||[]);
}
function syncMenuState(){
 document.querySelectorAll('#nav [data-nav-toggle]').forEach(toggle=>{
  const id=toggle.dataset.navToggle,open=navOpen.has(id),list=document.getElementById('nav-sub-'+id),entry=toggle.previousElementSibling;
  list.hidden=!open;toggle.setAttribute('aria-expanded',String(open));
  const label=entry.querySelector('.nav-label').textContent;toggle.setAttribute('aria-label',T(open?'收起':'展开',open?'Collapse':'Expand')+' '+label);
 });
}
function toggleMenu(id){
 const open=!navOpen.has(id);if(open)navOpen.add(id);else navOpen.delete(id);saveMenuState();syncMenuState();
}
function navigation(){
 if(me.role!=='owner'){
  if(['fpx','banks','bank-deposits'].includes(page)){page='billing';sessionStorage.setItem('wa_page',page);}
  sessionStorage.removeItem('wa_billing_view');
 }
 const tree=menuTree(),available=[],branches=[];
 const collect=nodes=>nodes.forEach(n=>{available.push(n.page);if(n.children.length)branches.push(n.page);collect(n.children);});collect(tree);
 if(!available.includes(page)){page=page==='fpx'?'billing':'overview';sessionStorage.setItem('wa_page',page);}
 restoreMenuState(tree);navOpen=new Set([...navOpen].filter(id=>branches.includes(id)));saveMenuState();
 const render=(nodes,depth=0)=>`<ul class="${depth?'nav-children':'nav-tree'}">${nodes.map(n=>{const title=n.page==='bank-deposits'&&me.role==='owner'?T('充值单据','Deposit receipts'):T(...labels[n.page]),branch=n.children.length>0,open=navOpen.has(n.page),control='nav-sub-'+n.page;return `<li><div class="nav-row"><button type="button" data-page="${n.page}" class="nav-entry nav-level-${depth}">${navIcon(n.page)}<span class="nav-label">${esc(title)}</span></button>${branch?`<button type="button" class="nav-toggle" data-nav-toggle="${n.page}" aria-expanded="${open}" aria-controls="${control}" aria-label="${esc(T(open?'收起':'展开',open?'Collapse':'Expand')+' '+title)}"><span class="nav-chevron" aria-hidden="true">›</span></button>`:''}</div>${branch?render(n.children,depth+1).replace('<ul class="nav-children">',`<ul class="nav-children" id="${control}" ${open?'':'hidden'}>`):''}</li>`;}).join('')}</ul>`;
 const html=render(tree),signature=JSON.stringify([tree,WA_LANG]);
 $('#identity').textContent=me.username;$('#role').textContent=me.role==='owner'?T('Owner · 总管理员','Owner · Administrator'):'USER ID';$('#password-btn').hidden=me.role!=='owner';
 const nav=$('#nav');nav.setAttribute('aria-label',T('主菜单','Main menu'));
 if(nav.dataset.signature!==signature){const scroll=nav.scrollTop;nav.innerHTML=html;nav.dataset.signature=signature;nav.scrollTop=scroll;}syncMenuState();
 nav.onclick=e=>{
  const toggle=e.target.closest('[data-nav-toggle]');if(toggle){toggleMenu(toggle.dataset.navToggle);return;}
  const b=e.target.closest('[data-page]');if(!b)return;const target=b.dataset.page;
  if(page===target)return;page=target;sessionStorage.setItem('wa_page',page);loadPage().catch(e=>toast(e.message,true));
 };
 nav.onkeydown=e=>{if(e.key!=='Escape')return;const list=e.target.closest('.nav-children');if(!list)return;const toggle=list.previousElementSibling.querySelector('[data-nav-toggle]');if(toggle&&navOpen.has(toggle.dataset.navToggle)){e.preventDefault();navOpen.delete(toggle.dataset.navToggle);saveMenuState();syncMenuState();toggle.focus();}};
 pageHeader();
}
async function boot(){try{const before=Date.now(),r=await api('/me');me=r.user;csrf=r.csrf;boot.groups=r.worker_groups;clockOffset=Date.parse(r.server_time)-(before+Date.now())/2;if(me.role!=='owner'){paymentSettings=await api('/payments/settings',{signal:AbortSignal.timeout(5000)}).catch(e=>{if(e.status===401)throw e;return{enabled:false,unavailable:true};});if(!me)return;}$('#session-loading').hidden=true;$('#login').hidden=true;$('#shell').hidden=false;navigation();await loadPage();if(returnOrder&&!boot.checkedPayment){boot.checkedPayment=true;try{await api('/payments/orders/'+encodeURIComponent(returnOrder)+'/check',{method:'POST',body:'{}'});await loadPage();}catch(e){toast(e.message,true);}history.replaceState(null,'',location.pathname);}}catch(e){if(e.status===401)return;if(me)toast(e.message,true);else{$('#session-message').textContent=T('暂时无法连接服务器，登录状态尚未确认。','Cannot reach the server. Your session has not been checked yet.');$('#session-retry').hidden=false;}}}
function pageHeader(){
 const title=page==='bank-deposits'&&me.role==='owner'?T('充值单据','Deposit receipts'):T(...labels[page]);if($('#page-title').textContent!==title)$('#page-title').textContent=title;const current=$('#nav [data-page="'+page+'"]');document.querySelectorAll('#nav [data-page]').forEach(b=>{const active=b===current;b.classList.toggle('active',active);b.classList.toggle('ancestor',!active&&!!current&&b.closest('li').contains(current));if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
}
function visiblePageSignature(data){
 const content={...data};delete content.notice;
 if(content.accounts)content.accounts=content.accounts.map(({heartbeat_at,worker_heartbeat_at,history_synced_at,next_send_at,batch_sent,batch_campaign_id,...a})=>a);
 return JSON.stringify([content,page==='users'?userStatusFilter:null,page==='users'?data.users?.map(u=>loginRecency(u.last_login_at)):null]);
}
async function loadPage(quiet=false){
 if(!me||quiet&&(loading||$('#modal').open||$('#content form[data-busy="1"]')||document.activeElement?.matches('#content input,#content textarea,#content select')&&page!=='shared'))return;
 pageRequest?.abort();const controller=new AbortController(),version=++pageRequestVersion;pageRequest=controller;loading=true;
 const requested=page;pageHeader();
 if(!quiet&&lastRenderedPage!==requested)$('#content').innerHTML=`<div class="loading">${T('正在加载…','Loading…')}</div>`;
 const timeout=setTimeout(()=>controller.abort('timeout'),15000),get=path=>api(path,{signal:controller.signal});
 const optional=promise=>promise.then(rows=>({rows})).catch(e=>{if(e.status===401||controller.signal.aborted)throw e;return{unavailable:true};});
 try{
  const jobs={};
  if(me.role!=='owner'||requested==='fpx')jobs.paymentSettings=get('/payments/settings').catch(e=>{if(e.status===401||controller.signal.aborted||me?.role==='owner')throw e;return{enabled:false,unavailable:true};});
  if(requested==='fpx')jobs.paymentOrders=get('/payments/orders');
  if(requested==='banks')jobs.banks=get('/banks');
  if(requested==='bank-deposits'){jobs.banks=get('/banks');jobs.deposits=get('/bank-deposits?'+bankDepositQuery());}
  if(requested==='bank-transactions'){jobs.banks=get('/banks');jobs.transactions=get('/bank-transactions?'+bankTransactionQuery());}
  if(requested==='shared'){jobs.sharedStatus=get('/shared/status?layout=2');if(me.role==='owner')jobs.sharedAccounts=get('/shared/accounts'+sharedQuery());}
  if(requested==='shared-tasks')jobs.sharedTasks=get('/shared/tasks?page='+sharedUI.tasksPage);
  if(requested==='shared-records')jobs.sharedRecords=get('/shared/records?page='+sharedUI.recordsPage);
  if(['overview','accounts','tasks','messages'].includes(requested))jobs.accounts=get('/accounts');
  if(requested==='accounts'&&me.role==='owner'){jobs.accountUsers=get('/users');jobs.accountCapacity=optional(get('/health'));}
  if(me.role!=='owner'||requested==='notices')jobs.notice=get('/notice');
  if(requested==='overview')jobs.overview=get(me.role==='owner'?'/overview?layout=2':'/overview');
  if(requested==='tasks'&&me.role!=='owner')jobs.campaigns=get('/campaigns');
  if(requested==='users')jobs.users=get('/users');
  if(requested==='audit')jobs.audit=get('/audit?page='+historyPages.audit);
  if(requested==='messages'&&me.role!=='owner')jobs.messages=get('/send-records?page='+historyPages.messages);
  if(me.role==='owner'&&['tasks','messages'].includes(requested)){
   restoreDashboardDisclosures();const kind=requested,prefix='send-'+kind+':';
   jobs.sendGroups=get('/owner/send-groups?kind='+kind);
   jobs.sendItems=jobs.sendGroups.then(data=>Promise.all(visibleActorGroups(data.groups).map(g=>g.user?.id||'external').filter(actor=>dashboardOpen.has(prefix+actor)).map(async actor=>{try{return[actor,await get('/owner/send-items?kind='+kind+'&actor_id='+encodeURIComponent(actor)+'&page='+(sendPages[kind][actor]||1))];}catch(e){if(e.status===401||controller.signal.aborted)throw e;return[actor,{unavailable:true}];}}))).then(Object.fromEntries);
  }
  if(requested==='system'&&me.role==='owner')jobs.systemHourly=optional(get('/shared/hourly'));
  if(requested==='billing'){
   if(me.role==='owner')jobs.users=get('/users?compact=true');
   jobs.billing=get('/billing'+(billingUser?'?user_id='+encodeURIComponent(billingUser):''));
   if(me.role==='owner')jobs.billingRefunds=get('/billing/automatic-refunds?'+new URLSearchParams({...billingUser?{user_id:billingUser}:{},...billingRefundBefore?{before:billingRefundBefore}:{}}));
   if(me.role!=='owner'){jobs.paymentOrders=get('/payments/orders');jobs.banks=get('/banks');jobs.deposits=get('/bank-deposits?'+bankDepositQuery());}
  }
  const entries=Object.entries(jobs),values=await Promise.all(entries.map(([,promise])=>promise));
  if(version!==pageRequestVersion||requested!==page||!me)return;
  const data=Object.fromEntries(entries.map(([key],i)=>[key,values[i]]));
  if(data.paymentSettings){paymentSettings=data.paymentSettings;navigation();if(page!==requested)return await loadPage();}
  if(data.paymentOrders)paymentOrders=data.paymentOrders;
  if(data.accounts)accounts=data.accounts;if(data.notice)noticeData=data.notice;renderNotice();
  if(data.accountUsers)accountAccessUsers=data.accountUsers.map(({id,active,locked})=>({id,active,locked}));
  if(data.overview)overviewData=data.overview;if(data.campaigns)campaigns=data.campaigns;if(data.users)users=data.users;
  if(data.sendGroups){ownerSendData={...data.sendGroups,items:data.sendItems};if(requested==='tasks')campaigns=Object.values(data.sendItems).flatMap(r=>r.rows||[]);}
  if(data.billing)billingData=data.billing;
  if(requested==='messages')updateHistorySync();
  if(quiet&&requested==='notices'&&$('#notice-form')?.dataset.dirty)return;
  if(quiet&&requested==='shared'&&($('#shared-send-form')?.dataset.dirty||document.activeElement?.matches('#content input,#content textarea,#content select'))){syncSharedPhotoPolicy(data.sharedStatus);return;}
  const signature=visiblePageSignature(data);if(quiet&&lastRenderedPage===requested&&signature===lastRenderSignature)return;
  const scrollX=window.scrollX,scrollY=window.scrollY,tableScroll=[...document.querySelectorAll('#content .table-wrap')].map(n=>n.scrollLeft);
  if(['banks','bank-deposits','bank-transactions'].includes(requested))renderBankPage(requested,data);
  if(['shared','shared-tasks','shared-records'].includes(requested))renderSharedPage(requested,data);
  if(requested==='overview')overview(data);if(requested==='accounts')accountPage(data);if(requested==='tasks')taskPage();if(requested==='users')userPage();
  if(requested==='fpx')fpxPage();if(requested==='audit')auditPage(data.audit);if(requested==='messages')messagesPage(data.messages);if(requested==='billing')billingPage(data);if(requested==='system')systemPage(data);if(requested==='notices')noticePage();
  lastRenderedPage=requested;lastRenderSignature=signature;
  if(quiet){document.querySelectorAll('#content .table-wrap').forEach((n,i)=>{n.scrollLeft=tableScroll[i]||0;});window.scrollTo(scrollX,scrollY);}
 }catch(error){
  if(version!==pageRequestVersion||requested!==page)return;
  if(controller.signal.aborted&&controller.signal.reason==='timeout')throw new Error(T('连接超时，请刷新重试','Connection timed out. Refresh to retry.'));
  if(error.name!=='AbortError')throw error;
 }finally{clearTimeout(timeout);if(version===pageRequestVersion){loading=false;pageRequest=null;}}
}
function noticeText(){return WA_LANG==='en'?(noticeData.content_en||noticeData.content_zh||''):(noticeData.content_zh||noticeData.content_en||'');}
function renderNotice(){
 const signature=JSON.stringify([noticeData,WA_LANG,me?.role]);if(signature===noticeSignature)return;noticeSignature=signature;
 const banner=$('#workspace-notice'),content=noticeText();banner.hidden=me?.role==='owner'||!noticeData.enabled||!content;
 if(banner.hidden){banner.replaceChildren();return;}
 banner.innerHTML=`<div class="notice-heading"><strong>${T('系统公告','System notice')}</strong><small>${T('更新于','Updated')} ${date(noticeData.updated_at)} · UTC+8</small></div><div class="notice-body"></div>`;
 banner.querySelector('.notice-body').textContent=content;
}
function noticePage(){
 $('#content').innerHTML=`<section class="panel"><h2>${T('公告管理','Notices')}</h2><p class="muted">${T('开启后，公告显示在所有 USER 页面顶部，约 5 秒内更新。填写英文内容后，English 页面会显示对应英文；留空则显示中文内容。','When enabled, the notice appears at the top of every USER page and updates within about 5 seconds. English pages use the English text when provided, otherwise the Chinese text.')}</p><form id="notice-form"><label class="check-row"><input name="enabled" type="checkbox" ${noticeData.enabled?'checked':''}>${T('向全部 USER 显示公告','Show notice to all USERs')}</label><label>${T('中文公告','Chinese notice')}<textarea name="content_zh" rows="7" maxlength="6000">${esc(noticeData.content_zh)}</textarea></label><label>${T('英文公告（选填）','English notice (optional)')}<textarea name="content_en" rows="7" maxlength="6000">${esc(noticeData.content_en)}</textarea></label><p class="muted">${T('最近保存','Last saved')}: ${date(noticeData.updated_at)} · UTC+8</p>${submit()}</form></section><section class="panel"><h3>${T('当前公告预览','Current notice preview')} · ${noticeData.enabled?T('已开启','On'):T('已关闭','Off')}</h3><div class="notice-body">${esc(noticeText()||T('暂无公告','No notice'))}</div></section>`;
 const form=$('#notice-form');form.oninput=()=>{form.dataset.dirty='1';};form.onchange=form.oninput;
 form.onsubmit=async e=>{e.preventDefault();if(form.dataset.busy)return;form.dataset.busy='1';const button=form.querySelector('button[type=submit]');button.disabled=true;
  try{noticeData=await api('/notice',{method:'PUT',body:JSON.stringify({enabled:form.elements.namedItem('enabled').checked,content_zh:form.elements.namedItem('content_zh').value,content_en:form.elements.namedItem('content_en').value})});delete form.dataset.dirty;noticePage();toast(T('公告已保存','Notice saved'));}
  catch(err){toast(err.message,true);}finally{delete form.dataset.busy;button.disabled=false;}
 };
}
function overviewIcon(kind){const paths={mail:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/>',check:'<path d="m5 12 4 4L19 6"/>',double:'<path d="m2 12 4 4L16 6m-5 10 3 3L23 9"/>',cross:'<path d="m7 7 10 10M17 7 7 17"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'};return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]||paths.mail}</svg>`;}
function overviewMarkup(stats,title,online){
 const counts=stats.counts,days=stats.days,success=c=>['submitted','delivered','read'].reduce((n,k)=>n+Number(c[k]||0),0),failed=c=>Number(c.failed||0)+Number(c.invalid||0),total=Object.values(counts).reduce((n,v)=>n+Number(v),0);
 const cards=[['mail',T('全部消息','All messages'),total,'purple'],['check',T('发送成功','Sent successfully'),success(counts),'green'],['cross',T('发送失败','Failed to send'),failed(counts),'orange'],['clock',T('等待发送','Waiting to send'),counts.pending||0,'blue']];
 const stages=['submitted','delivered','read','failed','invalid','unknown','pending','sending','awaiting_ack','cancelled'];
 const max=Math.max(1,...days.map(d=>success(d.counts)+failed(d.counts)+Number(d.counts.unknown||0)+Number(d.counts.sending||0)+Number(d.counts.awaiting_ack||0)));
 const series=[{label:T('成功','Successful'),color:'#67d8b1',value:success},{label:T('失败','Failed'),color:'#ff9d78',value:failed}];
 const chart=`<svg class="overview-chart" viewBox="0 0 660 220" role="img" aria-label="${T('最近七天发送趋势，详细数字见下方','Last seven days sending trend; exact values below')}">${[0,1,2,3].map(i=>`<line x1="42" y1="${175-i*50}" x2="630" y2="${175-i*50}" stroke="#253349"/><text x="32" y="${179-i*50}" text-anchor="end">${Math.round(max*i/3)}</text>`).join('')}${series.map(item=>`<polyline points="${days.map((d,i)=>`${48+i*96},${175-item.value(d.counts)/max*150}`).join(' ')}" fill="none" stroke="${item.color}" stroke-width="3"/>${days.map((d,i)=>`<circle cx="${48+i*96}" cy="${175-item.value(d.counts)/max*150}" r="4" fill="${item.color}"><title>${d.date}: ${item.label} ${item.value(d.counts)}</title></circle>`).join('')}`).join('')}${days.map((d,i)=>`<text x="${48+i*96}" y="205" text-anchor="middle">${d.date.slice(5).replace('-','/')}</text>`).join('')}</svg>`;
 return `<div class="overview-heading"><div><h2>${esc(title||T('消息总览','Message overview'))}</h2>${ownerHint('真实消息数据 · 马来西亚时间 UTC+8','Live message data · Malaysia time UTC+8','muted','p')}</div>${online==null?'':`<span class="badge">${online} ${T('账号在线','accounts online')}</span>`}</div><div class="cards overview-cards">${cards.map(([icon,label,value,color])=>`<div class="card overview-card"><span class="overview-icon ${color}">${overviewIcon(icon)}</span><div><div class="label">${label}</div><div class="value">${num(value)}</div></div></div>`).join('')}</div><div class="overview-panels"><section class="panel"><h3>${T('最近 7 天 · 发送走势','Last 7 days · Sending trend')}</h3><div class="overview-legend">${series.map(x=>`<span style="color:${x.color}">● ${x.label}</span>`).join('')}</div>${chart}<div class="overview-week">${days.map(d=>`<div><span>${d.date.slice(5).replace('-','/')}</span><strong>${num(success(d.counts))}</strong><small>${T('失败','Failed')} ${num(failed(d.counts))}</small></div>`).join('')}</div>${ownerHint('按首次发送日期统计，包含今天；状态随回执更新。未开始发送的号码不计入周走势。','Grouped by first send date, including today; statuses update with receipts. Unsent numbers are excluded from the weekly trend.','muted','p')}</section><section class="panel"><h3>${T('消息状态','Message status')}</h3><p class="muted">${T('全部现有记录的最新状态','Latest status of all current records')}</p><div class="overview-status">${stages.map((k,i)=>{const n=Number(counts[k]||0);return `<div><div class="overview-status-label"><span>${state(k)}</span><strong>${num(n)}</strong></div><div class="overview-track"><span style="width:${total?n/total*100:0}%;background:${['#8e83ff','#67d8b1','#5796ff','#ff9d78','#ff8e96','#e9c46a'][i%6]}"></span></div></div>`;}).join('')}</div>${!total?`<p class="muted">${T('暂无消息记录，发送后自动更新。','No messages yet. Data updates automatically after sending.')}</p>`:''}</section></div>${ownerHint('发送成功包含已提交、已送达、已读；不代表全部已送达。失败包含无效号码。已删除资料不计入总览，结果未确认不会自动重发。','Successful includes submitted, delivered and read; it does not mean all were delivered. Failed includes invalid numbers. Deleted records are excluded; uncertain results are never resent automatically.')}`;
}
function restoreDashboardDisclosures(){
 const scope=me.id+':'+me.role;if(dashboardSession===scope)return;
 dashboardSession=scope;dashboardOpen=new Set();let saved;
 try{saved=JSON.parse(sessionStorage.getItem('wa_dashboard_open'));}catch{}
 if(saved?.user_id===me.id&&saved.role===me.role&&Array.isArray(saved.open)&&saved.open.length<=5000)dashboardOpen=new Set(saved.open.filter(k=>typeof k==='string'&&k.length<=100));
 if(dashboardOpen.delete('capacity:system'))dashboardOpen.add('capacity:personal');
}
function bindDashboardDisclosures(){
 document.querySelectorAll('details[data-dashboard-key]').forEach(group=>{
  group.ontoggle=()=>{
   if(!group.isConnected)return;
   if(group.open)dashboardOpen.add(group.dataset.dashboardKey);else dashboardOpen.delete(group.dataset.dashboardKey);
   group.querySelector('summary').setAttribute('aria-expanded',String(group.open));
   try{sessionStorage.setItem('wa_dashboard_open',JSON.stringify({user_id:me.id,role:me.role,open:[...dashboardOpen]}));}catch{}
  };
  group.onkeydown=e=>{if(e.key==='Escape'&&group.open){e.preventDefault();group.open=false;group.querySelector('summary').focus();}};
 });
}
function visibleActorGroups(groups){return groups.filter(g=>!g.user||g.user.role==='owner'||g.user.active===true&&g.user.locked!==true);}
function overview(data){
 if(me.role!=='owner'){
  $('#content').innerHTML=overviewMarkup(overviewData,null,accounts.filter(a=>!a.deleted_at&&a.status==='ready').length);return;
 }
 if(!overviewData.owner||!Array.isArray(overviewData.users)||!overviewData.external){$('#content').innerHTML=`<section class="panel"><p>${T('总览正在更新，请刷新重试。','Overview is updating. Refresh to retry.')}</p></section>`;return;}
 restoreDashboardDisclosures();
 const actorGroup=(item,external=false)=>{
  const id=external?'external':item.user.id,key='actor:'+id,open=dashboardOpen.has(key),status=external?null:userState(item.user),name=external?T('外部 / 未归属','External / unattributed'):item.user.username,total=Object.values(item.counts).reduce((n,v)=>n+Number(v),0);
  return `<details class="panel overview-actor" data-overview-user="${esc(id)}" data-dashboard-key="${esc(key)}" ${open?'open':''}><summary aria-expanded="${open}" aria-controls="overview-user-${esc(id)}"><span class="account-group-heading"><span class="account-group-name">${esc(name)}</span>${external?'':`<span class="badge account-user-state ${status}"><span class="status-dot" aria-hidden="true"></span>${status.toUpperCase()}</span><span class="muted">${item.user.role==='owner'?'Owner':'USER ID'}</span>`}</span><span class="muted">${T('全部消息','All messages')} <strong>${num(total)}</strong></span></summary><div class="overview-actor-body" id="overview-user-${esc(id)}">${overviewMarkup(item,name)}</div></details>`;
 };
 const groups=visibleActorGroups([...overviewData.users,...(Object.keys(overviewData.external.counts).length?[overviewData.external]:[])]);
 $('#content').innerHTML=`<section data-overview-owner>${overviewMarkup(overviewData.owner,me.username+' · '+T('我的消息','My messages'))}</section><section class="overview-users"><h2>${T('USER ID 消息总览','Messages by USER ID')}</h2><p class="muted">${T('按任务创建人和手动发送操作人分开统计，点击 USER ID 查看。统计普通 WhatsApp 消息。','Personal WhatsApp messages are grouped by task creator or manual sender. Select a USER ID to view its data.')}</p>${groups.map(u=>actorGroup(u,!u.user)).join('')}</section>`;
 bindDashboardDisclosures();
}
function accountTable(items=accounts){
 const owner=me.role==='owner';
 return table([T('备注 / 号码','Name / number'),T('连接状态','Connection'),T('操作','Actions')],items.map(a=>`<tr><td><strong>${esc(a.label)}</strong><br>${esc(a.enabled&&!a.deleted_at&&a.status==='ready'&&a.phone?'+'+a.phone:T('尚未关联','Not linked'))}</td><td>${badge(a.status)}${a.last_error?`<br><small>${T('诊断代码','Diagnostic code')}: ${esc(a.last_error)}</small>`:''}</td><td><div class="actions">${a.deleted_at?`<span>${a.purge_requested?T('正在删除…','Deleting…'):T('已删除（记录保留）','Deleted (retained)')}</span>`:`${owner?`<button data-view="${a.id}" data-mode="view">${T('查看聊天','View chats')}</button>`:''}<button data-view="${a.id}" data-mode="${owner?'operate':'scan'}" ${!owner&&a.status==='ready'?'disabled':''}>${owner?T('打开操作 / 扫码','Open / scan QR'):T('扫码','Scan QR')}</button><button data-start="${a.id}">${T('启动 / 重连','Start / reconnect')}</button><button data-rename="${a.id}">${T('修改名称','Rename')}</button>${owner?`<button data-check="${a.id}">${T('检查连接','Check connection')}</button><button data-enabled="${a.id}">${a.enabled?T('停用','Deactivate'):T('启用','Activate')}</button>`:''}`}${owner&&!a.purge_requested?`<button class="danger" data-delete-account="${a.id}">${T('删除账号','Delete account')}</button>`:''}</div></td></tr>`));
}
function restoreAccountGroups(){
 const scope=me.id+':'+me.role;if(accountGroupSession===scope)return;
 accountGroupSession=scope;accountGroupsOpen=new Set();let saved;
 try{saved=JSON.parse(sessionStorage.getItem('wa_account_groups'));}catch{}
 if(saved?.user_id===me.id&&saved.role===me.role&&Array.isArray(saved.open)&&saved.open.length<=5000)accountGroupsOpen=new Set(saved.open.filter(id=>typeof id==='string'&&id.length<=80));
}
function bindAccountGroups(){
 document.querySelectorAll('details[data-account-user]').forEach(group=>{
  group.ontoggle=()=>{
   if(!group.isConnected)return;
   const id=group.dataset.accountUser;
   if(group.open)accountGroupsOpen.add(id);else accountGroupsOpen.delete(id);
   group.querySelector('summary').setAttribute('aria-expanded',String(group.open));
   try{sessionStorage.setItem('wa_account_groups',JSON.stringify({user_id:me.id,role:me.role,open:[...accountGroupsOpen]}));}catch{}
  };
  group.onkeydown=e=>{if(e.key==='Escape'&&group.open){e.preventDefault();group.open=false;group.querySelector('summary').focus();}};
 });
}
function accountSections(){
 if(me.role!=='owner')return accountTable();
 restoreAccountGroups();
 const groups=new Map(),unassigned=accounts.filter(a=>!a.assigned_users?.length);
 for(const account of accounts)for(const user of account.assigned_users||[]){if(!groups.has(user.id))groups.set(user.id,{...user,accounts:[]});groups.get(user.id).accounts.push(account);}
 const entries=[{id:'owner',username:me.username+' · Owner',active:true,accounts:unassigned},...Array.from(groups.values()).sort((a,b)=>a.username.localeCompare(b.username))];
 return entries.map(g=>{
  const access=accountAccessUsers.find(u=>u.id===g.id)||g,status=userState(access),owner=g.id==='owner',open=accountGroupsOpen.has(g.id),listId='account-group-list-'+g.id;
  if(owner)return `<section class="panel account-group owner-accounts" data-account-user="owner"><div class="toolbar toolbar-wrap"><h2>${esc(g.username)}</h2><span class="muted">${T('Owner / 未分配','Owner / unassigned')} · ${g.accounts.length} ${T('个账号','accounts')}</span></div>${accountTable(g.accounts)}</section>`;
  return `<details class="panel account-group" data-account-user="${esc(g.id)}" ${open?'open':''}><summary aria-expanded="${open}" aria-controls="${esc(listId)}"><span class="account-group-heading"><span class="account-group-name">${esc(g.username)}</span>${owner?'':`<span class="badge account-user-state ${status}" data-user-status="${status}"><span class="status-dot" aria-hidden="true"></span>${status.toUpperCase()}</span>`}</span><span class="muted">${owner?T('Owner / 未分配','Owner / unassigned'):'USER ID'} · ${g.accounts.length} ${T('个账号','accounts')}</span></summary><div id="${esc(listId)}" class="account-group-content">${accountTable(g.accounts)}</div></details>`;
 }).join('');
}
function accountPage(data){
 const owner=me.role==='owner';
 const capacity=data.accountCapacity;
 const capacityMarkup=owner?(capacity?.rows?capacityPanel(capacity.rows,capacity.rows.map(w=>w.worker_group),T('各分组配置名额可不同；新账号自动分配到有资源的分组。未使用的扫码画面按需启动，登录资料保留。剩余名额已扣除已分配账号，离线或资源不足的分组暂不可用。','Configured slots can differ by group. New accounts use groups with available resources. QR screens start on demand and retain their profiles. Available slots exclude assigned accounts and offline or resource-blocked groups.')):unavailablePanel(T('运行容量','Running capacity'))):'';
 const toolbar=`<div class="toolbar toolbar-wrap"><h2>${T('WhatsApp 账号','WhatsApp accounts')}</h2><button id="add-account" ${!owner&&accounts.filter(a=>!a.deleted_at).length>=(me.account_limit||10)?'disabled':''}>${T('添加账号','Add account')}</button></div>`;
 $('#content').innerHTML=`${capacityMarkup}${ownerHint('画面断开不代表 WhatsApp 被封。连接检查会区分浏览器画面、服务状态和 WhatsApp 登录状态。','A disconnected screen does not mean WhatsApp is banned. Connection checks distinguish screen, service and WhatsApp login status.')}${owner?toolbar+accountSections():`<section class="panel">${toolbar}${accountTable()}</section>`}`;
 if(owner)bindDashboardDisclosures();
 bindAccountGroups();bindAccounts();$('#add-account').onclick=()=>modal(T('添加账号','Add account'),`<form><label>${T('备注 / 名称','Name / note')}<input name="label" required maxlength="80"></label><input type="hidden" name="worker_group" value="${esc(boot.groups[0]||'')}"><p>${T('保存后用手机 WhatsApp 关联设备扫码。','After saving, scan the QR code using Linked devices on your phone.')}</p>${submit()}</form>`,async f=>{const r=await api('/accounts',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(f)))});toast(r.queued?T('已排队，请打开扫码窗口，系统会自动连接','Queued. Open the QR window to connect automatically.'):r.started?T('已启动，请打开扫码窗口','Started. Open the QR window.'):connectionText(r.connection));});
}
function bindAccounts(){document.querySelectorAll('[data-delete-account]').forEach(b=>b.onclick=()=>{const a=accounts.find(a=>a.id===b.dataset.deleteAccount);if(confirm(me.role==='owner'?T(`删除“${a.label}”及其后台任务、发送记录和服务器登录资料？手机 WhatsApp 账号不会注销。`,`Delete “${a.label}”, its dashboard tasks, message history and server login data? This does not delete the WhatsApp account on your phone.`):T(`删除“${a.label}”并停止其任务？Owner 仍可查看保留的资料与删除记录。`,`Delete “${a.label}” and stop its tasks? The Owner can still see retained data and the deletion record.`)))action(b,()=>api('/accounts/'+a.id,{method:'DELETE'}));});document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>window.open(`/viewer.html?id=${b.dataset.view}&mode=${b.dataset.mode}`,'_blank','noopener'));document.querySelectorAll('[data-rename]').forEach(b=>b.onclick=()=>{const a=accounts.find(a=>a.id===b.dataset.rename);modal(T('修改账号名称','Rename account'),`<form><label>${T('备注 / 名称','Name / note')}<input name="label" required maxlength="80" value="${esc(a.label)}"></label>${submit()}</form>`,f=>api('/accounts/'+a.id,{method:'PATCH',body:JSON.stringify({label:f.elements.namedItem('label').value})}));});document.querySelectorAll('[data-check]').forEach(b=>b.onclick=async()=>{try{const r=await api('/accounts/'+b.dataset.check+'/connection?mode=operate');modal(T('连接检查','Connection check'),`<p>${esc(connectionText(r))}</p><p>${T('画面或网络中断不能用来判断账号被封。','Screen or network interruptions do not establish that an account is banned.')}</p>`);}catch(e){toast(e.message,true);}});document.querySelectorAll('[data-start]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api('/accounts/'+b.dataset.start+'/restart',{method:'POST',body:'{}'});await loadPage();}catch(e){toast(e.message,true);}finally{b.disabled=false;}});document.querySelectorAll('[data-enabled]').forEach(b=>b.onclick=async()=>{const a=accounts.find(a=>a.id===b.dataset.enabled);try{await api('/accounts/'+a.id,{method:'PATCH',body:JSON.stringify({enabled:!a.enabled})});await loadPage();}catch(e){toast(e.message,true);}});}
function taskSendControl(c){
 if(me.role!=='owner')return '';
 if(Number(c.counts?.pending||0)>0)return `<button data-now="${c.id}">${T('立刻发送','Send now')}</button>`;
 if(Number(c.counts?.unknown||0)>0)return `<button data-results="${c.id}">${T('查看结果','View results')}</button>`;
 if(Number(c.counts?.sending||0)+Number(c.counts?.awaiting_ack||0)>0)return `<button data-results="${c.id}">${T('查看发送状态','View sending status')}</button>`;
 return `<button disabled>${T('没有待发送号码','No pending recipients')}</button>`;
}
function taskPauseControl(c){
 if(me.role!=='owner')return '';
 const owner=me.role==='owner',canPause=c.enabled||c.pause_reason==='credit';
 return `<button data-pause="${c.id}" ${!owner&&!canPause?'disabled':''}>${owner?(c.pause_reason==='credit'?T('保持暂停','Keep paused'):c.enabled?T('暂停','Pause'):T('继续','Resume')):canPause?T('暂停','Pause'):T('已暂停','Paused')}</button>`;
}
function ownerSendLists(kind){
 const data=ownerSendData;if(!data||data.kind!==kind)return `<p class="muted">${T('正在加载…','Loading…')}</p>`;
 restoreDashboardDisclosures();
 return visibleActorGroups(data.groups).map(group=>{
  const u=group.user,id=u?.id||'external',key='send-'+kind+':'+id,open=dashboardOpen.has(key),name=u?u.username:T('外部 / 未归属','External / unattributed'),result=data.items[id],listId='send-'+kind+'-'+id;
  const rows=result?.rows||[],status=u?userState(u):null;
  const pager=result&&!result.unavailable?`<div class="pager"><button data-send-page="-1" data-send-actor="${esc(id)}" ${result.page<=1?'disabled':''}>${T('上一页','Previous')}</button><span>${result.page} / ${Math.max(1,Math.ceil(result.total/result.size))}</span><button data-send-page="1" data-send-actor="${esc(id)}" ${result.page*result.size>=result.total?'disabled':''}>${T('下一页','Next')}</button></div>`:'';
  return `<details class="panel account-group owner-send-group" data-owner-send-actor="${esc(id)}" data-send-key="${esc(key)}" ${open?'open':''}><summary aria-expanded="${open}" aria-controls="${esc(listId)}"><span class="account-group-heading"><span class="account-group-name">${esc(name)}</span>${u?`<span class="muted">${u.role==='owner'?'Owner':'USER ID'}</span><span class="badge account-user-state ${status}"><span class="status-dot" aria-hidden="true"></span>${status.toUpperCase()}</span>`:''}</span><span class="muted">${num(group.total)} ${T(kind==='tasks'?'项任务':'条记录',kind==='tasks'?'tasks':'records')}</span></summary><div id="${esc(listId)}" data-owner-send-content="${esc(id)}" class="account-group-content">${open?(result?.unavailable?`<p class="muted">${T('暂时无法加载这组记录，请刷新重试。','Cannot load this group. Refresh to retry.')}</p>`:result?(kind==='tasks'?taskTable(rows):messageTable(rows))+pager:`<p>${T('正在加载…','Loading…')}</p>`):''}</div></details>`;
 }).join('');
}
function bindOwnerSendLists(){
 const kind=page;
 document.querySelectorAll('[data-owner-send-actor]').forEach(group=>{
  group.ontoggle=()=>{
   if(!group.isConnected)return;const key=group.dataset.sendKey,changed=dashboardOpen.has(key)!==group.open;
   if(group.open)dashboardOpen.add(key);else dashboardOpen.delete(key);
   group.querySelector('summary').setAttribute('aria-expanded',String(group.open));
   try{sessionStorage.setItem('wa_dashboard_open',JSON.stringify({user_id:me.id,role:me.role,open:[...dashboardOpen]}));}catch{}
   if(changed&&group.open)loadPage().catch(e=>toast(e.message,true));
  };
  group.onkeydown=e=>{if(e.key==='Escape'&&group.open){e.preventDefault();group.open=false;group.querySelector('summary').focus();}};
 });
 document.querySelectorAll('[data-send-page]').forEach(button=>button.onclick=()=>{const id=button.dataset.sendActor;sendPages[kind][id]=Math.max(1,(sendPages[kind][id]||1)+Number(button.dataset.sendPage));loadPage().catch(e=>toast(e.message,true));});
}
function taskTable(rows=campaigns){return table([T('任务 / 创建者','Task / creator'),T('时间安排','Schedule'),T('消息 / 结果','Message / results'),T('操作时间 UTC+8','Activity UTC+8'),T('操作','Actions')],rows.map(c=>`<tr><td><strong>${esc(c.title)}</strong><br>${esc(c.account_label)} · ${esc(c.creator)}${c.pause_reason==='credit'?`<br><span class="badge blue">${T('余额不足 · 充值足够后自动继续','Low credit · resumes with enough credit')}</span>`:c.pause_reason==='review'?`<br><span class="badge red">${T('已暂停 · 未确认费用自动退款','Paused · unconfirmed credit is refunded automatically')}</span>`:''}${c.deleted_at?`<br>${T('USER 已删除（保留记录）','Deleted by USER (retained)')}`:''}</td><td>${T('每批','Per batch')} ${c.batch_size||1} ${T('条，间隔','messages; interval')} ${c.interval_ms/1000} ${T('秒','seconds')}</td><td><div class="message-body">${esc(c.body)}</div>${c.has_image?`<img src="/api/campaigns/${c.id}/image" alt="${T('照片','Photo')}" loading="lazy" style="max-width:120px;max-height:100px">`:''}${Object.entries(c.counts||{}).map(([k,n])=>`${badge(k)} ${num(n)}`).join(' ')}</td><td>${T('创建','Created')}: ${date(c.created_at)}<br>${T('最近操作','Last action')}: ${date(c.operation_at||c.created_at)}</td><td><div class="actions"><button data-results="${c.id}">${T('明细','Details')}</button>${!c.deleted_at&&!c.cancelled&&(me.role==='owner'||c.created_by===me.id)?`${me.role==='owner'?`<button data-schedule="${c.id}">${T('修改间隔 / 数量','Edit interval / quantity')}</button>`:''}${taskSendControl(c)}${taskPauseControl(c)}`:''}${me.role==='owner'?`<button data-delete-task="${c.id}" class="danger">${T('永久删除','Permanently delete')}</button>`:''}</div></td></tr>`));}

function taskPage(){$('#content').innerHTML=`${ownerHint('USER 发送前须充值。每条按发送时的价格预扣，确认成功后结算；失败或结果未确认自动退回。余额不足的任务充值足够后自动继续；手动暂停或因未确认发送而暂停的任务仍由 Owner 恢复，不会重发未确认消息。','USERs need credit before sending. Each message reserves the current rate; confirmed sends are charged, while failures and unconfirmed results are refunded automatically. Low-credit tasks resume with enough credit. The Owner resumes manually stopped tasks and tasks paused for unconfirmed sends; unconfirmed messages are never resent.')}${ownerHint('按间隔和每批数量发送，不设日期或每日时段限制。时间显示为马来西亚 UTC+8；操作窗口打开时自动任务暂停。','Send by interval and batch size, without date or daily windows. Times use Malaysia UTC+8. Automatic tasks pause while a control window is open.')}<div class="panel"><div class="toolbar"><h2>${T('任务与结果','Tasks and results')}</h2><button id="add-task">${T('新建任务','New task')}</button></div>${me.role==='owner'?ownerSendLists('tasks'):taskTable()}</div>`;$('#add-task').onclick=()=>taskForm();bindTasks();if(me.role==='owner')bindOwnerSendLists();}
const localDate=s=>s?new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(s)).replace(' ','T'):'';
function scheduleFields(c={}){const ms=c.interval_ms||10000,unit=ms%3600000===0?3600000:ms%60000===0?60000:1000;return `<label>${T('发送间隔','Send interval')}<input name="interval_value" type="number" min="1" max="3600" required value="${ms/unit}"></label><label>${T('单位','Unit')}<select name="interval_unit">${[[1000,T('秒','Seconds')],[60000,T('分钟','Minutes')],[3600000,T('小时','Hours')]].map(([v,t])=>`<option value="${v}" ${unit===v?'selected':''}>${t}</option>`).join('')}</select></label><label>${T('每批发送多少条','Messages per batch')}<input name="batch_size" type="number" min="1" max="100" value="${c.batch_size||1}" required></label><p>${T('每批按号码顺序逐条发送，完成后等待设定间隔，再发送下一批。间隔范围：5 秒至 1 小时。','Each batch sends sequentially, then waits for the interval before the next batch. Interval: 5 seconds to 1 hour.')}</p>`;}
function scheduleBody(f){const b=Object.fromEntries(new FormData(f));b.interval_ms=Number(b.interval_value)*Number(b.interval_unit);b.batch_size=Number(b.batch_size);b.pacing=true;delete b.interval_value;delete b.interval_unit;return b;}
function readPhoto(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error(T('无法读取照片','Unable to read photo')));reader.readAsDataURL(file);});}
function taskForm(){const eligible=accounts.filter(a=>a.enabled&&a.status==='ready');if(!eligible.length)return toast(T('请先扫码连接 WhatsApp 账号，再立刻发送','Link a WhatsApp account by QR before sending now.'),true);modal(T('新建发送任务','New send task'),`<form><div class="form-grid"><label class="full">${T('WhatsApp 账号','WhatsApp account')}<select name="account_id">${eligible.map(a=>`<option value="${a.id}">${esc(a.label)} · ${esc(state(a.status))}</option>`).join('')}</select></label><label class="full">${T('消息内容','Message')}<textarea name="body" maxlength="4000" rows="4"></textarea></label><label class="full">${T('联系人号码（每行一个）','Phone numbers (one per line)')}<textarea name="recipients" required rows="5"></textarea><small>${T('导入号码文件（TXT / CSV，不是照片）','Import phone numbers (TXT / CSV, not photos)')}</small><input type="file" id="contact-file" accept=".txt,.csv"></label><label class="full">${T('上传照片（选填，JPEG / PNG / WebP，最大 5 MB）','Upload photo (optional, JPEG / PNG / WebP, max 5 MB)')}<input type="file" id="photo-file" accept="image/jpeg,image/png,image/webp"><img id="photo-preview" hidden style="max-width:240px;max-height:180px"><span id="photo-name"></span><button type="button" id="photo-remove" hidden>${T('移除照片','Remove photo')}</button></label>${scheduleFields()}<label class="full"><input type="checkbox" name="opt_in" required>${T('联系人同意接收此消息','These contacts agreed to receive this message.')}</label></div><div class="form-actions"><button type="submit" value="now" class="primary">${T('立刻发送','Send now')}</button></div></form>`,async(f,button)=>{const b=scheduleBody(f);const photo=$('#photo-file').files[0];if(photo){if(photo.size>5*1024*1024)throw Error(T('照片最大 5 MB','Photo must be at most 5 MB'));const data=await readPhoto(photo);b.media={data:data.split(',')[1],mimetype:photo.type};}b.opt_in_confirmed=f.elements.namedItem('opt_in').checked;b.send_now=button?.value==='now';b.require_connected=true;const r=await api('/campaigns',{method:'POST',body:JSON.stringify(b)});toast(T(`已创建：${r.count} 个号码，去重 ${r.duplicates} 个`,`Created: ${r.count} recipients, ${r.duplicates} duplicates removed.`));});$('#photo-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>5*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error(T('请上传 JPEG / PNG / WebP 照片，最大 5 MB','Choose a JPEG / PNG / WebP photo up to 5 MB'));$('#photo-preview').src=await readPhoto(file);$('#photo-preview').hidden=false;$('#photo-remove').hidden=false;$('#photo-name').textContent=file.name;}catch(err){e.target.value='';$('#photo-preview').hidden=true;toast(err.message,true);}};$('#photo-remove').onclick=()=>{$('#photo-file').value='';$('#photo-preview').removeAttribute('src');$('#photo-preview').hidden=true;$('#photo-remove').hidden=true;$('#photo-name').textContent='';};$('#contact-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;if(file.size>500000)return toast(T('文件需小于 500KB','File must be under 500KB.'),true);$('#modal textarea[name=recipients]').value=(await file.text()).split(/\r?\n/).map(l=>l.trim().replace(/^"|"$/g,'')).filter(l=>l&&!/^(phone|number|号码|电话)$/i.test(l)).join('\n');};}
function bindTasks(){document.querySelectorAll('[data-results]').forEach(b=>b.onclick=()=>showResults(b.dataset.results));document.querySelectorAll('[data-schedule]').forEach(b=>b.onclick=()=>{const c=campaigns.find(c=>c.id===b.dataset.schedule);modal(T('修改间隔 / 数量','Edit interval / quantity'),`<form><div class="form-grid">${scheduleFields(c)}</div>${submit()}</form>`,f=>api('/campaigns/'+c.id,{method:'PATCH',body:JSON.stringify(scheduleBody(f))}));});document.querySelectorAll('[data-now]').forEach(b=>b.onclick=()=>action(b,()=>api('/campaigns/'+b.dataset.now+'/send-now',{method:'POST',body:'{}'})));document.querySelectorAll('[data-pause]').forEach(b=>b.onclick=()=>action(b,()=>api('/campaigns/'+b.dataset.pause,{method:'PATCH',body:JSON.stringify({enabled:me.role!=='owner'?false:campaigns.find(c=>c.id===b.dataset.pause).pause_reason==='credit'?false:!campaigns.find(c=>c.id===b.dataset.pause).enabled})})));document.querySelectorAll('[data-delete-task]').forEach(b=>b.onclick=()=>{if(confirm(me.role==='owner'?T('永久删除此任务及结果？未确认的预扣会自动退回，退款流水会保留。','Permanently delete this task and its results? Unconfirmed holds are refunded automatically and refund entries are retained.'):T('删除后 Owner 仍可查看任务和删除记录。继续？','The Owner can still view the task and deletion record. Continue?')))action(b,()=>api('/campaigns/'+b.dataset.deleteTask,{method:'DELETE',body:JSON.stringify({preserve_holds:true})}));});}
async function action(button,fn){button.disabled=true;try{await fn();await loadPage();}catch(e){toast(e.message,true);}finally{button.disabled=false;}}
function recipientError(code){return code==='ACCOUNT_DISCONNECTED_BEFORE_SUBMISSION'?T('账号连接中断，未提交；预扣自动退回','Account disconnected before submission; reserved credit is refunded automatically.'):code||'—';}
async function showResults(id,p=1){try{const r=await api(`/campaigns/${id}/results?page=${p}`);modal(T('发送明细','Send results'),`${table([T('号码','Number'),T('状态','Status'),T('诊断代码','Diagnostic code'),T('创建时间 UTC+8','Created UTC+8'),T('开始发送 UTC+8','Send started UTC+8'),T('更新时间 UTC+8','Updated UTC+8')],r.rows.map(v=>`<tr><td>${esc(v.phone||v.raw_phone)}</td><td>${badge(v.status)}</td><td>${esc(recipientError(v.error_code))}</td><td>${date(v.created_at)}</td><td>${date(v.started_at)}</td><td>${date(v.updated_at)}</td></tr>`))}<div class="pager"><button id="prev" ${p<=1?'disabled':''}>${T('上一页','Previous')}</button><span>${p} / ${Math.max(1,Math.ceil(r.total/100))}</span><button id="next" ${p*100>=r.total?'disabled':''}>${T('下一页','Next')}</button><button id="results-refresh">${T('刷新状态','Refresh status')}</button><button id="export">${T('导出 CSV','Export CSV')}</button></div>`);$('#prev').onclick=()=>showResults(id,p-1);$('#next').onclick=()=>showResults(id,p+1);$('#results-refresh').onclick=()=>showResults(id,p);$('#export').onclick=()=>window.open('/api/campaigns/'+id+'/export','_blank','noopener');}catch(e){toast(e.message,true);}}
function userPage(){
 const filteredUsers=users.filter(u=>userState(u)===userStatusFilter);
 $('#content').innerHTML=`<section class="panel"><div class="toolbar toolbar-wrap"><h2>USER ID</h2><div class="actions"><button id="add-user">${T('创建 USER ID','Create USER ID')}</button></div></div><div class="filters"><label class="user-status-filter">${T('状态','Status')}<select id="user-status-filter">${['active','locked','inactive'].map(status=>`<option value="${status}" ${status===userStatusFilter?'selected':''}>${status.toUpperCase()}</option>`).join('')}</select></label><span class="muted">${num(filteredUsers.length)} USER ID</span></div>${table(['USER ID',T('资料备注','Remark'),'IP',T('最新登入时间 UTC+8','Last sign-in UTC+8'),T('状态','Status'),T('可用余额','Available credit'),T('创建时间 UTC+8','Created UTC+8'),T('操作','Actions')],filteredUsers.map(u=>`<tr><td>${esc(u.username)}${u.role==='owner'?' · Owner':''}</td><td><div class="user-remark" title="${esc(u.remark)}">${esc(u.remark||'—')}</div>${u.role!=='owner'?`<button data-remark="${u.id}">${T('修改备注','Edit remark')}</button>`:''}</td><td><span class="code">${esc(u.latest_login_ip||'—')}</span><br><button data-login-history="${u.id}">${T('登录记录','Sign-in history')}</button></td><td>${lastLoginBadge(u.last_login_at)}</td><td>${userState(u).toUpperCase()}</td><td>${u.role==='owner'?T('无限','Unlimited'):credits(u.credit_units)}</td><td>${date(u.created_at)}</td><td>${u.role!=='owner'?`<button data-user="${u.id}">${T('账号 / 状态 / 密码','Access / status / password')}</button><button data-credit="${u.id}">${T('充值 / 扣减','Top up / deduct')}</button>`:T('受保护','Protected')}</td></tr>`))}</section>`;
 document.querySelectorAll('[data-login-history]').forEach(b=>b.onclick=()=>showLoginHistory(b.dataset.loginHistory));
 $('#user-status-filter').onchange=e=>{userStatusFilter=e.target.value;sessionStorage.setItem('wa_user_status_filter',userStatusFilter);lastRenderSignature='';userPage();};
 document.querySelectorAll('[data-credit]').forEach(b=>b.onclick=()=>{billingUser=b.dataset.credit;page='billing';loadPage().catch(e=>toast(e.message,true));});document.querySelectorAll('[data-remark]').forEach(b=>b.onclick=()=>{const u=users.find(u=>u.id===b.dataset.remark);modal(T('USER 资料备注','USER remark'),`<form><p>${esc(u.username)}</p><label>${T('资料备注（仅 Owner 可见）','Remark (Owner only)')}<textarea name="remark" rows="5" maxlength="2000">${esc(u.remark)}</textarea></label>${submit()}</form>`,f=>api('/users/'+u.id+'/remark',{method:'PATCH',body:JSON.stringify({remark:f.elements.namedItem('remark').value})}));});$('#add-user').onclick=()=>userForm();document.querySelectorAll('[data-user]').forEach(b=>b.onclick=()=>userForm(users.find(u=>u.id===b.dataset.user)));
}

let loginHistoryGeneration=0;
async function showLoginHistory(id,before=null,trail=[]){
 const identity=me?.id,u=users.find(u=>u.id===id);if(me?.role!=='owner'||!u)return;
 modal(T('登录记录','Sign-in history')+' · '+u.username,`<p role="status">${T('正在读取…','Loading…')}</p>`);
 const generation=loginHistoryGeneration;
 try{
  const r=await api('/users/'+encodeURIComponent(id)+'/logins'+(before?'?before='+encodeURIComponent(before):''));
  if(generation!==loginHistoryGeneration||me?.id!==identity||!$('#modal').open)return;
  const unavailable=row=>row.geo_status==='pending'?T('查询中','Lookup pending'):'—';
  const cell=(row,key)=>esc(row[key]||unavailable(row));
  modal(T('登录记录','Sign-in history')+' · '+u.username,`<p class="muted">${T('成功登录时间按马来西亚 UTC+8 显示。旧记录未保存的 IP 或浏览器资料显示 —。','Successful sign-ins use Malaysia UTC+8. IP or browser details not retained in old records show —.')}</p>${table(['TIME (UTC+8)','IP','ISP','CITY','COUNTRY','USER AGENT'],r.rows.map(row=>`<tr><td class="nowrap">${date(row.logged_at)}</td><td class="code">${esc(row.ip||'—')}</td><td>${cell(row,'isp')}</td><td>${cell(row,'city')}</td><td>${cell(row,'country')}</td><td style="min-width:180px;max-width:360px;white-space:normal;overflow-wrap:anywhere">${esc(row.user_agent||'—')}</td></tr>`))}<p class="muted">${T('网络资料来源：ipapi.is。城市、国家及 ISP 是 IP 网络查询结果，可能受 VPN、代理或运营商影响，不代表实际所在地。查询失败或额度用尽会稍后重试，不影响登录；刷新可查看更新。','Network source: ipapi.is. City, country and ISP are IP lookup results affected by VPNs, proxies or carriers, and may differ from physical location. Failed or limited lookups retry later without affecting sign-in. Refresh to check updates.')}</p><div class="pager" style="flex-wrap:wrap"><button id="login-history-prev" ${trail.length?'':'disabled'}>${T('上一页','Previous')}</button><span>${trail.length+1}</span><button id="login-history-next" ${r.next_cursor?'':'disabled'}>${T('下一页','Next')}</button><button id="login-history-refresh">${T('刷新','Refresh')}</button></div>`);
  $('#login-history-prev').onclick=()=>showLoginHistory(id,trail.at(-1),trail.slice(0,-1));
  $('#login-history-next').onclick=()=>showLoginHistory(id,r.next_cursor,[...trail,before]);
  $('#login-history-refresh').onclick=()=>showLoginHistory(id,before,trail);
 }catch(e){if(generation===loginHistoryGeneration&&me?.id===identity&&$('#modal').open){$('#modal-content').innerHTML=`<p role="alert">${esc(e.message)}</p><button id="login-history-retry">${T('重试','Retry')}</button>`;$('#login-history-retry').onclick=()=>showLoginHistory(id,before,trail);}}
}
function userForm(u){modal(u?T('修改 USER ID','Edit USER ID'):T('创建 USER ID','Create USER ID'),`<form>${u?`<p>${esc(u.username)}</p>`:`<label>USER ID<input name="username" required pattern="[a-zA-Z0-9_.\\-]{3,40}"></label>`}<label>${u?T('重设密码（留空不改）','Reset password (blank = unchanged)'):T('初始密码','Initial password')}<input type="password" name="password" minlength="12" maxlength="200" ${u?'':'required'} autocomplete="new-password"></label><label>${T('状态','Status')}<select name="status">${['active','locked','inactive'].map(status=>`<option value="${status}" ${status===(u?userState(u):'active')?'selected':''}>${status.toUpperCase()}</option>`).join('')}</select></label><p class="muted">${T('LOCKED：暂时锁定登录与发送。INACTIVE：停用账号。','LOCKED temporarily blocks sign-in and sending. INACTIVE deactivates the account.')}</p><label>${T('资料备注（仅 Owner 可见）','Remark (Owner only)')}<textarea name="remark" rows="4" maxlength="2000">${esc(u?.remark)}</textarea></label>${submit()}</form>`,async f=>{const d=new FormData(f),b=Object.fromEntries(d);b.role='user';b.active=b.status!=='inactive';b.locked=b.status==='locked';delete b.status;await api('/users'+(u?'/'+u.id:''),{method:u?'PATCH':'POST',body:JSON.stringify(b)});});}
function historyPager(kind,count,size){$('#content').insertAdjacentHTML('beforeend',`<div class="pager"><button id="history-prev" ${historyPages[kind]<=1?'disabled':''}>${T('上一页','Previous')}</button><span>${historyPages[kind]}</span><button id="history-next" ${count<size?'disabled':''}>${T('下一页','Next')}</button></div>`);for(const [id,delta] of [['history-prev',-1],['history-next',1]])$('#'+id).onclick=()=>{historyPages[kind]+=delta;loadPage().catch(e=>toast(e.message,true));};}
function auditPage(rows){$('#content').innerHTML=`<div class="note">${T('记录后台任务、权限、账号和删除操作；原版 WhatsApp 画面可通过“查看聊天”查看，发送内容在“发送记录”。不记录每一次键盘按键。','Records task, access, account and deletion actions. Use View chats for the original WhatsApp screen and Message history for outgoing content. Individual keystrokes are not recorded.')}</div>${table([T('时间 UTC+8','Time UTC+8'),'USER ID',T('动作','Action'),T('内容','Details')],rows.map(r=>`<tr><td>${date(r.created_at)}</td><td>${esc(r.username||T('系统','System'))}</td><td>${esc(actionName(r.action))}</td><td><pre>${esc(JSON.stringify(r.details,null,2))}</pre></td></tr>`))}<button id="purge" class="danger">${T('永久清空全部任务、发送记录和操作记录','Permanently clear all tasks, message history and activity logs')}</button>`;historyPager('audit',rows.length,100);$('#purge').onclick=()=>modal(T('永久清空应用记录','Permanently clear application records'),`<form><p>${T('清空任务、联系人结果、发送记录及操作记录。保留登录 ID 和 WhatsApp 连接。不会删除 WhatsApp 内的聊天，也不清除 Railway 日志或备份。此操作无法撤销。','Clears tasks, recipient results, message history and activity logs. Keeps user IDs and WhatsApp connections. Does not delete WhatsApp chats, Railway logs or backups. This cannot be undone.')}</p><label>${T('输入 DELETE HISTORY','Type DELETE HISTORY')}<input name="confirm" required pattern="DELETE HISTORY"></label>${submit()}</form>`,f=>api('/data/purge',{method:'POST',body:JSON.stringify({confirm:f.elements.namedItem('confirm').value})}));}
function actionName(a){const names={'shared.account.scan.create':['添加共享 WhatsApp','Add shared WhatsApp account'],'shared.images':['共享图片开关','Shared photo switch'],'bank.switch':['银行系统开关','Bank system switch'],'bank.save':['保存银行资料','Save bank details'],'bank.transaction.record':['登记银行流水','Record bank entry'],'bank.deposit.confirm':['核对充值入账','Confirm bank credit'],'bank.deposit.reject':['拒绝充值单据','Reject deposit receipt'],login:['登录','Sign in'],'user.create':['创建 USER ID','Create USER ID'],'user.update':['修改 USER ID','Update USER ID'],'user.status':['修改 USER 状态','Change USER status'],'notice.update':['更新公告','Update notice'],'user.remark':['修改 USER 备注','Edit USER remark'],'campaign.credit_resume':['余额恢复后自动继续','Auto-resume after credit recovery'],'account.create':['添加 WhatsApp','Add WhatsApp account'],'account.delete':['USER 删除 WhatsApp 账号','USER deleted WhatsApp account'],'account.rename':['修改备注','Rename account'],'account.enabled':['启用 / 停用账号','Activate / deactivate account'],'account.start':['启动浏览器','Start browser'],'account.restart':['重连浏览器','Reconnect browser'],'chat.view':['查看聊天','View chats'],'chat.operate':['打开操作窗口','Open control window'],'campaign.create':['创建任务','Create task'],'campaign.enabled':['暂停 / 恢复任务','Pause / resume task'],'campaign.send_now':['立刻发送','Send now'],'campaign.schedule':['修改时间','Edit schedule'],'campaign.delete':['USER 删除任务','USER deleted task'],'message.delete':['USER 删除记录','USER deleted record'],'campaign.review_required':['发送结果未确认，已暂停','Unconfirmed send result; task paused'],'billing.auto_refund':['系统自动退款','Automatic credit refund'],'report.export':['导出结果','Export results'],'password.change':['修改密码','Change password'],'message.reconciled':['核对已发送消息','Reconciled sent message'],'worker.start':['启动浏览器','Start browser'],'campaign.cancel':['取消任务','Cancel task']};return names[a]?T(...names[a]):a;}
function historySyncMarkup(){return accounts.map(a=>`<span>${esc(a.label)}: ${a.history_sync_error?T('核对未完成，请稍后刷新','Check incomplete; refresh shortly'):a.history_synced_at?T('最近核对','Last checked')+' '+date(a.history_synced_at):T('等待连接后核对','Waiting for connection to check')}</span>`).join('<br>');}
function updateHistorySync(){const n=$('#history-sync-note');if(n){const html=historySyncMarkup();if(n.innerHTML!==html)n.innerHTML=html;}}
function messageTable(rows){return table([T('时间 UTC+8','Time UTC+8'),T('账号 / 操作者','Account / actor'),T('收件人','Recipient'),T('消息','Message'),T('状态','Status'),T('操作','Actions')],rows.map((r,i)=>`<tr><td>${date(r.sent_at)}</td><td>${esc(r.account_label)}<br>${esc(r.actor||T('外部 / 未归属','External / unattributed'))}</td><td>${esc(r.recipient_id?(r.recipient||r.raw_phone):r.recipient?.endsWith('@c.us')?'+'+r.recipient.split('@')[0]:r.recipient)}</td><td class="message-body">${r.message_type==='image'?T('[照片] ','[Photo] '):''}${esc(r.body)}${r.deleted_at?`<br>${T('USER 已删除（保留记录）','Deleted by USER (retained)')}`:''}</td><td>${badge(r.status)}${r.error_code?`<br><small>${esc(recipientError(r.error_code))}</small>`:""}</td><td>${r.recipient_id?`<button data-results="${r.campaign_id}">${T('任务明细','Task details')}</button>`:`<button data-message="${i}">${me.role==='owner'?T('永久删除记录','Permanently delete record'):T('删除并留记录','Delete & retain record')}</button>`}</td></tr>`));}
function bindMessageRows(rows,root=document){root.querySelectorAll('[data-results]').forEach(b=>b.onclick=()=>showResults(b.dataset.results));root.querySelectorAll('[data-message]').forEach(b=>b.onclick=()=>{const r=rows[+b.dataset.message];if(confirm(T('删除后台这条记录？WhatsApp 聊天不受影响。','Delete this dashboard record? WhatsApp chats are unaffected.')))action(b,()=>api('/messages/'+r.account_id+'/'+encodeURIComponent(r.message_id),{method:'DELETE'}));});}
function messagesPage(rows){
 const owner=me.role==='owner',syncInfo=owner?`<div class="note" id="history-sync-note">${historySyncMarkup()}</div>`:'';
 $('#content').innerHTML=syncInfo+`${ownerHint('按号码显示任务的等待、成功提交、已送达及失败状态；同时保留手动发送记录。成功提交不代表对方已收到。手动发送仅在本系统操作窗口有活动会话时关联 USER ID；手机端或无法归属的发送显示“外部 / 未归属”。','Shows per-number waiting, submitted, delivered and failed task results plus manual messages. Submitted does not mean delivered. Manual sends are attributed to a USER ID only while its control session is active; phone or unattributed sends show External / unattributed.')}${owner?ownerSendLists('messages'):messageTable(rows)}`;
 if(owner){bindOwnerSendLists();document.querySelectorAll('[data-owner-send-content]').forEach(root=>{const result=ownerSendData.items[root.dataset.ownerSendContent];if(result?.rows)bindMessageRows(result.rows,root);});}
 else{historyPager('messages',rows.length,100);bindMessageRows(rows);}
}

function capacityPanel(rows,groups,note='',options={}){
 restoreDashboardDisclosures();const scope=options.scope||'personal',key='capacity:'+scope,open=dashboardOpen.has(key);
 const integer=n=>Number.isSafeInteger(Number(n))&&Number(n)>0?Number(n):0;
 const now=Date.now()+clockOffset;
 const items=groups.map((g,i)=>{
  const r=rows.find(w=>w.worker_group===g)||{},time=r.heartbeat_at==null?NaN:Date.parse(r.heartbeat_at);
  const fresh=Number.isFinite(time)&&time<=now+5000&&now-time<90000,max=integer(r.max_accounts);
  const used=Math.max(integer(r.slots_used),integer(r.accounts_running),integer(r.assigned_accounts)),remaining=Math.max(0,max-used);
  const available=fresh&&r.can_start_more===true?Math.min(remaining,integer(r.slots_available)):0;
  return {r,label:(options.labelPrefix||'WhatsApp ')+(i+1),max,used,available,unavailable:remaining-available,state:!fresh?'offline':r.can_start_more!==true&&(remaining>0||integer(r.assigned_accounts)>integer(r.accounts_running))?'resource_wait':!remaining?'full':available?'available':'resource_wait'};
 });
 const total=items.reduce((s,w)=>({max:s.max+w.max,used:s.used+w.used,available:s.available+w.available,unavailable:s.unavailable+w.unavailable}),{max:0,used:0,available:0,unavailable:0});
 const status={offline:T('离线','Offline'),full:T('已满','Full'),available:T('可用','Available'),resource_wait:T('等待资源','Waiting for capacity')};
 return `<details class="panel capacity-panel" data-capacity data-capacity-scope="${options.scope||'personal'}" data-dashboard-key="${key}" ${open?'open':''}><summary aria-expanded="${open}" aria-controls="capacity-list-${page}"><div class="toolbar toolbar-wrap capacity-heading"><h2>${options.title||T('运行容量','Running capacity')}<span class="badge ${total.available?'green':'blue'}">${T('剩余可扫码','Available QR slots')} <strong data-capacity-available aria-live="polite">${num(total.available)}</strong></span></h2><div class="summary-line"><span>${T('已占用','Occupied')} <strong data-capacity-used>${num(total.used)}</strong></span><span>${T('总名额','Total slots')} <strong data-capacity-total>${num(total.max)}</strong></span><span>${T('暂不可用','Temporarily unavailable')} <strong data-capacity-unavailable>${num(total.unavailable)}</strong></span></div></div></summary><div class="capacity-body" id="capacity-list-${page}">${table([T('分组','Group'),T('运行中 / 配置名额','Running / configured slots'),T('已占用','Occupied'),T('剩余可扫码','Available QR slots'),T('状态','Status'),T('最近在线 UTC+8','Last heartbeat UTC+8')],items.map(w=>`<tr><td>${esc(w.label)}</td><td>${num(w.r.accounts_running||0)} / ${w.r.max_accounts==null?'—':num(w.max)}</td><td>${num(w.used)}</td><td><strong class="${w.available?'success':''}" data-slots-available>${num(w.available)}</strong></td><td>${esc(status[w.state])}${w.r.pids_current!=null?`<br><small>${num(w.r.pids_current)} / ${w.r.pids_limit==null?'—':num(w.r.pids_limit)}</small>`:''}</td><td>${date(w.r.heartbeat_at)}</td></tr>`))}${note?`<p class="muted">${esc(note)}</p>`:''}</div></details>`;
}
function hourlyChecksPanel(rows){
 return `<section class="panel" data-hourly-checks><h2>${T('每小时连接检查','Hourly connection checks')}</h2>${table([T('小时 UTC+8','Hour UTC+8'),T('已连接','Connected'),T('待连接','Waiting'),T('离线','Offline'),T('待确认','Unconfirmed'),T('已检查分组','Groups checked'),T('检查时间 UTC+8','Checked UTC+8')],rows.map(h=>`<tr><td>${date(h.hour_start)}</td><td>${num(h.connected)}</td><td>${num(h.waiting)}</td><td>${num(h.offline)}</td><td>${num(h.unknown)}</td><td>${num(h.groups)}</td><td>${date(h.checked_at)}</td></tr>`))}</section>`;
}
function systemPage(data){
 if(me.role!=='owner')return;
 const hourly=data.systemHourly;
 $('#content').innerHTML=hourly?.rows?hourlyChecksPanel(hourly.rows):unavailablePanel(T('每小时连接检查','Hourly connection checks'));
}
function unavailablePanel(title){return `<section class="panel"><h2>${esc(title)}</h2><p class="muted">${T('暂时无法加载，请刷新重试。','Cannot load this section. Refresh to retry.')}</p></section>`;}
$('#language').onchange=e=>{localStorage.setItem('wa_language',e.target.value);location.reload();};$('#close-modal').onclick=()=>{loginHistoryGeneration++;$('#modal').close();};$('#session-retry').onclick=boot;
$('#login-form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{await api('/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});e.target.reset();await boot();}catch(err){$('#login-error').textContent=err.message;}finally{b.disabled=false;}};
$('#logout').onclick=async()=>{try{await api('/logout',{method:'POST',body:'{}'});showLogin();}catch(e){toast(e.message,true);}};$('#refresh').onclick=()=>loadPage().catch(e=>toast(e.message,true));
$('#password-btn').onclick=()=>{if(me?.role!=='owner')return;modal(T('修改密码','Change password'),`<form><label>${T('当前密码','Current password')}<input name="current_password" type="password" required autocomplete="current-password"></label><label>${T('新密码','New password')}<input name="password" type="password" minlength="12" required autocomplete="new-password"></label>${submit()}</form>`,async f=>{await api('/password',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(f)))});showLogin();});};
setInterval(()=>{if(me&&!$('#modal').open&&!document.hidden)loadPage(true).catch(()=>{});},5000);
setInterval(()=>$('#clock').textContent=date(new Date(Date.now()+clockOffset))+' · UTC+8',1000);staticText();boot();

function creditLedger(rows,format=money){
 if(me.role!=='owner')return '';
 const kinds={hold:T('发送预扣','Send hold'),charged:T('确认扣费','Charge confirmed'),refunded:T('退回余额','Refund'),adjustment:T('手动调整','Manual adjustment'),online_topup:T('FPX 充值','FPX top-up'),bank_topup:T('银行充值','Bank top-up')};
 return `<section class="panel credit-ledger"><h3>${me.role==='owner'?T('余额流水（最近 100 条）','Credit ledger (latest 100)'):T('余额流水','Credit ledger')}</h3>${table([T('时间 UTC+8','Time UTC+8'),T('类型','Type'),T('余额变动','Change'),T('可用余额','Available balance'),T('备注','Remark')],rows.map(r=>`<tr><td>${date(r.created_at)}</td><td>${kinds[r.kind]||esc(r.kind)}${r.recipient_id?' #'+esc(r.recipient_id):''}</td><td>${Number(r.delta_units)>0?'+':''}${format(r.delta_units)}</td><td>${format(r.balance_units)}</td><td class="ledger-note">${esc(refundReason(r.note)||'—')}</td></tr>`))}</section>`;
}

function refundReason(reason){return reason==='AUTO_REFUND_NOT_SENT'?T('发送未完成，自动退回预扣','Send not completed: reserved credit returned automatically'):reason==='AUTO_REFUND_UNCONFIRMED'?T('发送结果未确认，自动退回预扣','Unconfirmed send: reserved credit returned automatically'):reason==='AUTO_REFUND_REMOVED_RECIPIENT'?T('原消息已删除，自动退回未结算预扣','Original record removed: unsettled credit returned automatically'):reason;}
function automaticRefundPanel(result){
 const rows=result.rows||[];
 return `<section class="panel automatic-refunds"><h3>${T('自动退款记录','Automatic refunds')}</h3><p class="muted">${T('系统自动退回预扣，无需人工核对。退款后收到延迟回执不会再次扣费，也不会重发。','Reserved credit is returned automatically without manual review. Late receipts after a refund do not charge again or resend the message.')}</p>${table([T('退款时间 UTC+8','Refunded UTC+8'),'USER ID',T('消息编号','Message ID'),T('服务类型','Service'),T('退回金额','Refund amount'),T('退款状态','Refund status'),T('消息状态','Message status'),T('原因','Reason')],rows.map(r=>`<tr><td>${date(r.created_at)}</td><td>${esc(r.username)}</td><td>#${esc(r.recipient_id)}</td><td>${r.service==='shared'?T('共享发送','Shared sending'):T('普通发送','Standard sending')}</td><td>+${money(r.amount_units)}</td><td><span class="badge green">${T('已自动退款','Automatically refunded')}</span></td><td>${r.message_status==='removed'?T('原记录已删除','Original record removed'):badge(r.message_status)}</td><td class="ledger-note">${esc(refundReason(r.reason))}</td></tr>`))}<div class="pager"><button id="refund-prev" ${billingRefundTrail.length?'':'disabled'}>${T('上一页','Previous')}</button><span>${billingRefundTrail.length+1}</span><button id="refund-next" ${result.next_cursor?'':'disabled'}>${T('下一页','Next')}</button></div></section>`;
}
function billingPage(data){
 const b=billingData,owner=me.role==='owner',u=b.user;
 const balanceCard=`<div class="card"><div class="label">${T('可用余额','Available credit')} · ${esc(u.username)}</div><div class="value">${u.role==='owner'?T('无限','Unlimited'):credits(u.credit_units)}</div></div>`;
 if(!owner){
  bankData=data.banks;depositData=data.deposits;depositPage();
  $('#content').insertAdjacentHTML('afterbegin',`<div class="cards balance-only">${balanceCard}</div>`);
  $('#bank-topup').insertAdjacentHTML('afterend',paymentPanel());
  bindPayments();return;
 }
 const refunds=data.billingRefunds||{rows:[],next_cursor:null};
 $('#content').innerHTML=`<div class="panel"><label>USER ID<select id="billing-user">${users.map(x=>`<option value="${x.id}" ${x.id===u.id?'selected':''}>${esc(x.username)}${x.role==='owner'?' · Owner':''}</option>`).join('')}</select></label></div><div class="cards">${balanceCard}<div class="card"><div class="label">${T('待结算预扣','On hold')}</div><div class="value">${money(b.held_units)}</div></div><div class="card"><div class="label">${T('普通发送单价','Standard sending rate')}</div><div class="value">${b.price_units==null?T('尚未定价','Not configured'):money(b.price_units)}</div></div></div><div class="toolbar"><button id="billing-price">${T('修改普通发送单价','Set standard rate')}</button>${u.role!=='owner'?`<button id="billing-adjust">${T('充值 / 扣减','Top up / deduct')}</button>`:''}</div><p class="muted">${T('发送前预扣，确认提交服务器后结算一次。失败、无效号码或结果未确认会自动退回预扣；等待回执超过 90 秒也会自动处理。改价不修改旧账。','Credit is reserved before sending and charged once after confirmed server submission. Failed, invalid or unconfirmed sends are refunded automatically; receipt waits over 90 seconds are also handled automatically. Rate changes never alter past entries.')}</p>${b.held.length?`<section class="panel"><h3>${T('待结算消息（最近 100 条）','Messages on hold (latest 100)')}</h3>${table([T('消息编号','Message ID'),T('服务类型','Service'),T('状态','Status'),T('预扣金额','Reserved'),T('自动处理','Automatic processing')],b.held.map(r=>`<tr><td>#${esc(r.recipient_id)}</td><td>${r.service==='shared'?T('共享发送','Shared sending'):T('普通发送','Standard sending')}</td><td>${badge(r.status)}</td><td>${money(r.amount_units)}</td><td>${r.status==='unknown'?T('自动退款处理中','Automatic refund pending'):T('等待回执，超时自动退款','Awaiting receipt; automatic refund on timeout')}</td></tr>`))}</section>`:''}${automaticRefundPanel(refunds)}${creditLedger(b.ledger)}<p class="muted">${T('删除聊天或任务不会删除余额流水或退款记录。','Deleting chats or tasks does not erase the credit ledger or refund records.')}</p>`;
 if(owner){$('#billing-user').onchange=e=>{billingUser=e.target.value;billingRefundBefore=null;billingRefundTrail=[];loadPage().catch(e=>toast(e.message,true));};$('#billing-price').onclick=()=>modal(T('普通发送每条价格','Standard price per message'),`<form><p>${T('所有 USER 生效；之后开始发送的消息按新价格计算。','Applies to all USERs. Messages that start sending afterward use the new rate.')}</p><label>MYR / ${T('条','message')}<input name="price" type="number" min="0.0001" max="10000" step="0.0001" required value="${b.price_units==null?'':(Number(b.price_units)/10000).toFixed(4)}"></label>${submit()}</form>`,f=>api('/billing/price',{method:'PUT',body:JSON.stringify({price:f.elements.namedItem('price').value})}));
 if($('#billing-adjust'))$('#billing-adjust').onclick=()=>{const request_id=crypto.randomUUID();modal(T('手动充值 / 扣减','Manual top-up / deduction'),`<form><p>USER ID: ${esc(u.username)}</p><label>${T('操作','Action')}<select name="direction"><option value="add">${T('增加余额','Add credit')}</option><option value="subtract">${T('扣减余额','Deduct credit')}</option></select></label><label>RM<input name="amount" type="number" min="0.0001" step="0.0001" max="99999999" required></label><label>${T('原因 / 付款备注','Reason / payment note')}<input name="note" maxlength="200" required></label>${submit()}</form>`,f=>api('/billing/adjust',{method:'POST',body:JSON.stringify({...Object.fromEntries(new FormData(f)),user_id:u.id,request_id})}));};
 $('#refund-prev').onclick=()=>{billingRefundBefore=billingRefundTrail.pop()??null;loadPage().catch(e=>toast(e.message,true));};
 $('#refund-next').onclick=()=>{if(!refunds.next_cursor)return;billingRefundTrail.push(billingRefundBefore);billingRefundBefore=refunds.next_cursor;loadPage().catch(e=>toast(e.message,true));};
 }
}

function fpxPage(){$('#content').innerHTML=paymentPanel();bindPayments();}
function paymentPanel(){
 const owner=me.role==='owner',ready=fpxAvailable();
 const orders=table([T('时间 UTC+8','Time UTC+8'),'USER ID',T('金额','Amount'),T('状态','Status'),T('操作','Actions')],paymentOrders.map(o=>`<tr><td>${date(o.created_at)}</td><td>${esc(o.username)}</td><td>RM ${(o.amount_cents/100).toFixed(2)}${o.sandbox?' · Sandbox':''}</td><td>${esc(({paid:T('已入账','Credited'),pending:T('待付款 / 核对','Awaiting payment / verification'),creating:T('创建中','Creating'),create_failed:T('创建结果待核对','Creation needs review')})[o.state])}</td><td>${o.state!=='paid'?`${o.payment_url&&!owner&&ready?`<a href="${esc(o.payment_url)}" target="_blank" rel="noopener">${T('继续付款','Continue payment')}</a>`:''}<button data-payment-check="${o.id}">${T('核对付款','Check payment')}</button>`:'—'}</td></tr>`));
 if(!owner&&!ready)return `<section class="panel" id="online-fpx"><h2>Online FPX</h2><p class="muted ${paymentSettings.unavailable?'':'service-coming-soon'}">${paymentSettings.unavailable?T('暂时无法加载在线充值，请刷新重试。','Cannot load online top-up. Refresh to retry.'):'Coming soon'}</p>${paymentOrders.length?orders:''}</section>`;
 const status=!paymentSettings.enabled?T('关闭','Off'):ready?T('可使用','Available'):paymentSettings.sandbox&&paymentSettings.configured?T('测试模式','Test mode'):T('配置未完成','Setup incomplete');
 return `<section class="panel" id="online-fpx"><div class="toolbar"><h3>Online FPX · ${status}</h3>${owner?`<button id="payment-config">${T('在线充值设置 / 开关','Online payment settings / switch')}</button>`:`<button id="online-topup" class="primary" ${ready?'':'disabled'}>${T('Online FPX 充值','Top up with Online FPX')}</button>`}</div>${!ready?`<p class="muted">${T('在线充值暂时不可用，请稍后再试。','Online top-up is currently unavailable. Please try later.')}</p>`:''}${orders}</section>`;
}
function bindPayments(){
 document.querySelectorAll('[data-payment-check]').forEach(b=>b.onclick=()=>action(b,()=>api('/payments/orders/'+b.dataset.paymentCheck+'/check',{method:'POST',body:'{}'})));
 if($('#online-topup'))$('#online-topup').onclick=()=>{const request_id=crypto.randomUUID();modal(T('Online FPX 充值','Online FPX top-up'),`<form><label>${T('充值金额 MYR','Top-up amount MYR')}<input name="amount" type="number" step="0.01" min="2" max="10000" required value="50"></label><label>${T('付款邮箱','Payer email')}<input name="email" type="email" maxlength="200" required autocomplete="email"></label><p>${T('付款确认后自动加入余额。','Credit is added automatically after payment is confirmed.')}</p><button type="submit" class="primary">${T('前往 FPX 付款','Proceed to FPX payment')}</button></form>`,async f=>{const r=await api('/payments/orders',{method:'POST',body:JSON.stringify({...Object.fromEntries(new FormData(f)),request_id})});location.assign(r.url);});};
 if($('#payment-config'))$('#payment-config').onclick=()=>modal(T('FPX 商户设置','FPX merchant settings'),`<form><label>${T('在线充值开关','Online top-up switch')}<select name="enabled"><option value="false" ${paymentSettings.enabled?'':'selected'}>${T('关闭','Off')}</option><option value="true" ${paymentSettings.enabled?'selected':''}>${T('开启','On')}</option></select></label><label>${T('支付环境','Payment environment')}<select name="sandbox"><option value="false" ${paymentSettings.sandbox?'':'selected'}>${T('正式收款','Live payments')}</option><option value="true" ${paymentSettings.sandbox?'selected':''}>Sandbox</option></select></label><label>Collection ID<input name="collection_id" maxlength="80" value="${esc(paymentSettings.collection_id)}"></label><label>API Secret Key<input name="api_key" type="password" maxlength="200" autocomplete="off" placeholder="${paymentSettings.api_key_saved?T('已保存；留空不改','Saved; leave blank to keep'):''}"></label><label>X Signature Key<input name="x_key" type="password" maxlength="200" autocomplete="off" placeholder="${paymentSettings.x_key_saved?T('已保存；留空不改','Saved; leave blank to keep'):''}"></label><p>${T('收款银行账号请在 Billplz 商户后台添加；Collection 请仅启用 FPX。切换环境时需重新填写对应密钥。Sandbox 不能充值真实余额。关闭后停止新建付款订单，已付款订单仍会核对入账。','Add your settlement bank account in the Billplz merchant dashboard and enable only FPX for this Collection. Re-enter the correct keys when changing environment. Sandbox does not add real credit. Turning off stops new orders; completed payments are still verified and credited.')}</p><a href="https://www.billplz.com" target="_blank" rel="noopener">${T('打开 Billplz 商户后台','Open Billplz merchant dashboard')}</a>${submit()}</form>`,async f=>{const d=Object.fromEntries(new FormData(f));d.enabled=d.enabled==='true';d.sandbox=d.sandbox==='true';await api('/payments/settings',{method:'PUT',body:JSON.stringify(d)});});
}



