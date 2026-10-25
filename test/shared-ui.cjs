'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'../public');
const accountId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222';
let current;
const ledgerNote='Synthetic transfer remark <img src=x onerror=alert(1)>\nSecond line';
function capacityRows(s){return s.capacityRows||[{worker_group:'fixture-group',accounts_running:2,max_accounts:10,assigned_accounts:3,slots_used:3,slots_available:7,slots_unavailable:0,can_start_more:true,capacity_state:'available',heartbeat_at:new Date().toISOString()}];}
const managedUsers=[{id:'active-user',username:'Active fixture',role:'user',active:true,locked:false},{id:'inactive-user',username:'Inactive fixture',role:'user',active:false,locked:false},{id:'locked-user',username:'Locked fixture',role:'user',active:true,locked:true}];
function accessUsers(s){return managedUsers.map(u=>({...u,...s.userAccess?.[u.id]}));}
function personalTask(s){return {id:taskId,title:'Review fixture',body:'Synthetic caption',account_label:'fixture personal',creator:'fixture-'+s.role,created_by:'ui-'+s.role,enabled:false,pause_reason:'review',interval_ms:10000,created_at:'2026-10-16T03:00:00Z',operation_at:'2026-10-16T03:10:00Z',counts:{unknown:1}};}
function personalRecords(s){return ['submitted','delivered','failed','pending','unknown'].map((status,i)=>({recipient_id:i+1,campaign_id:taskId,account_label:'fixture personal',actor:'fixture-'+s.role,raw_phone:'+15555550101',body:'fixture '+status,status,sent_at:'2026-10-15T06:00:00Z'}));}
function senderGroups(s,kind){return {kind,groups:[{user:{id:'ui-owner',username:'fixture-owner',role:'owner',active:true,locked:false},total:kind==='tasks'?(s.taskReview?1:0):5},...accessUsers(s).map(u=>({user:u,total:u.id==='active-user'?2:0})),...(kind==='messages'?[{user:null,total:1}]:[])]};}
function senderItems(s,kind,actor,page){
 if(actor==='ui-owner')return{kind,actor_id:actor,rows:kind==='tasks'?(s.taskReview?[personalTask(s)]:[]):personalRecords(s),total:kind==='tasks'?(s.taskReview?1:0):5,page,size:100};
 const text='Synthetic USER '+(kind==='tasks'?'task':'message')+' page '+page;
 const row=kind==='tasks'?{...personalTask(s),id:page===1?'33333333-3333-4333-8333-333333333333':'44444444-4444-4444-8444-444444444444',created_by:actor,creator:'Active fixture',body:text}:{...personalRecords(s)[0],actor:'Active fixture',body:text};
 return{kind,actor_id:actor,rows:actor==='active-user'?[row]:[],total:actor==='active-user'?2:0,page,size:1};
}
function groupedOverview(s){
 const bucket=(user,counts)=>({user,counts,days:Array.from({length:7},(_,i)=>({date:'2026-10-'+String(i+11).padStart(2,'0'),counts:i===6?counts:{}}))});
 return{owner:bucket({id:'ui-owner',username:'fixture-owner',role:'owner'},{submitted:2,unknown:1}),users:accessUsers(s).map((u,i)=>bucket(u,i===0?{submitted:8+(s.overviewRevision||0),failed:2}:i===1?{}:{read:1})),external:bucket(null,{delivered:1}),timezone:'Asia/Kuala_Lumpur'};
}

const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
   let raw='';for await(const chunk of req)raw+=chunk;
   const body=raw?JSON.parse(raw):null,p=url.pathname.slice(4),s=current;
   s.requests.push({path:p,query:url.search,method:req.method,body,csrf:req.headers['x-csrf-token']});
   let result;
   if(p==='/me'){
    if(s.meDelayMs)await new Promise(resolve=>setTimeout(resolve,s.meDelayMs));
    if(s.meStatus||s.signedOut){res.statusCode=s.meStatus||401;result={error:'Synthetic session unavailable'};}
    else result={user:{id:'ui-'+s.role,username:'fixture-'+s.role,role:s.role},csrf:'fake-ui-csrf',worker_groups:['fixture-group'],server_time:new Date().toISOString(),password_access:false};
   }
   else if(p==='/login'){
    if(s.loginRejectedNext){s.loginRejectedNext=false;res.statusCode=401;result={error:'Synthetic incorrect credentials'};}
    else{s.signedOut=false;result={ok:true};}
   }
   else if(p==='/workspace/features'){if(s.featuresFail){res.statusCode=503;result={error:'Synthetic policy read unavailable'};}else result={shared_enabled:s.enabled};}
   else if(p==='/shared/availability'&&req.method==='PATCH'){s.enabled=body.enabled;result={enabled:s.enabled};}
   else if(p==='/payments/settings')result={enabled:!!s.fpxEnabled,configured:!!s.fpxEnabled,sandbox:false};
   else if(p==='/payments/orders')result=s.paymentPending?[{id:'fixture-order',username:'fixture-'+s.role,amount_cents:5000,state:'pending',sandbox:false,payment_url:'https://example.invalid/fixture-payment',created_at:'2026-10-15T06:00:00Z'}]:[];
   else if(p==='/payments/orders/fixture-order/check')result={ok:true};
   else if(p==='/accounts'){
    const personal={id:accountId,label:'fixture personal'+(s.accountSuffix||''),enabled:true,status:s.accountStatus||'ready',phone:s.accountPhone||'15555550101',history_synced_at:null};
    result=s.role==='owner'?[...managedUsers.map((u,i)=>({...personal,id:i?'account-'+i:accountId,assigned_users:[{id:u.id,username:u.username,active:u.active}]})),{...personal,id:'owner-account',assigned_users:[]}]:[personal];
   }
   else if(p==='/users')result=[{id:'ui-owner',username:'fixture-owner',role:'owner',active:true,locked:false},...managedUsers].map(u=>({...u,last_login_at:s.loginDates[u.id]??null,latest_login_ip:u.id==='active-user'?'8.8.8.8':null}));
   else if(/^\/users\/[^/]+\/logins$/.test(p)){
    if(s.role!=='owner'){res.statusCode=403;result={error:'Owner only'};}
    else if(p.includes('active-user'))result={rows:url.searchParams.has('before')?[{id:'1',logged_at:'2026-01-02T03:04:05.123Z',ip:null,user_agent:null,geo_status:'legacy'}]:[{id:'2',logged_at:s.loginDates['active-user'],ip:'8.8.8.8',isp:'Synthetic <img src=x onerror=alert(1)>',city:'Kuala Lumpur',country:'Malaysia',user_agent:'Synthetic browser <script>alert(1)</script>',geo_status:'ready',geo_provider:'ipapi.is'}],next_cursor:url.searchParams.has('before')?null:'fixture-next'};
    else result={rows:[],next_cursor:null};
   }
   else if(p==='/owner/send-groups')result=senderGroups(s,url.searchParams.get('kind'));
   else if(p==='/owner/send-items'){
    const actor=url.searchParams.get('actor_id');if(s.failSendGroup===actor){res.statusCode=503;result={error:'Synthetic group unavailable'};}else result=senderItems(s,url.searchParams.get('kind'),actor,Number(url.searchParams.get('page')||1));
   }
   else if(p==='/shared/options'){
    if(req.method==='PUT')s.imagesEnabled=body.images_enabled;result={images_enabled:s.imagesEnabled!==false};
   }
   else if(p==='/campaigns'&&req.method==='POST')result={id:taskId,count:1,duplicates:0};
   else if(p==='/campaigns')result=s.taskReview?[personalTask(s)]:[];
   else if(p==='/overview')result=s.role==='owner'&&url.searchParams.get('layout')==='2'?groupedOverview(s):{counts:{submitted:1,failed:1,unknown:1},days:Array.from({length:7},(_,i)=>({date:'2026-10-'+String(i+9).padStart(2,'0'),counts:{submitted:i===6?1:0}}))};
   else if(p==='/send-records')result=personalRecords(s);
   else if(p==='/banks')result={enabled:!s.banksOff,banks:s.banksOff?[]:[{id:'fixture-bank',bank_name:'Fixture bank',account_name:'Fixture account',status:s.bankMaintenance?'maintenance':'active'}]};
   else if(p==='/bank-deposits')result={rows:[],page:1,total:0};
   else if(p==='/notice'){
    if(req.method==='PUT'){
     if(s.role!=='owner'){res.statusCode=403;result={error:'Owner only'};}
     else if(s.noticeSaveFailure){s.noticeSaveFailure=false;res.statusCode=503;result={error:'Synthetic notice unavailable'};}
     else{s.notice={...body,updated_at:new Date().toISOString()};result=s.notice;if(s.noticeSaveGate)await s.noticeSaveGate;}
    }else result=s.notice||{enabled:false};
   }
   else if(p==='/health'){if(s.capacityFailure)res.statusCode=503;result=s.capacityFailure?{error:'Fixture capacity temporarily unavailable'}:capacityRows(s);}
   else if(p==='/billing/automatic-refunds')result={rows:[{id:'900',user_id:'ui-owner',username:'Synthetic <img src=x onerror=alert(1)>',recipient_id:'11',amount_units:'1061',reason:'AUTO_REFUND_UNCONFIRMED',service:'personal',message_status:'unknown',created_at:'2026-10-20T02:54:43Z'}],next_cursor:url.searchParams.has('before')?null:'800'};
   else if(p==='/billing')result={user:{id:'ui-'+s.role,username:'fixture-'+s.role,role:s.role,credit_units:'10000000'},rates:{personal_units:6818,shared_units:s.rateUnconfigured?null:(s.sharedRate??12500),shared_enabled:s.enabled},held:[],held_units:0,price_units:1000,ledger:[{kind:'adjustment',delta_units:'10000000',balance_units:'10000000',note:ledgerNote,created_at:'2026-10-15T06:00:00Z'}]};
   else if(p==='/shared/status'){
    result={enabled:s.enabled,images_enabled:s.imagesEnabled!==false,configured:true,balance_units:'10000000',pacing:{interval_ms:10000,batch_size:1},summary:{total:120,connected:2,available:s.available,waiting:118,offline:0,unknown:0},timezone:'Asia/Kuala_Lumpur'};
    if(s.role==='owner')Object.assign(result,{settings:{enabled:s.enabled,price_units:1000,current_price_units:12500,interval_ms:10000,batch_size:1},hours:[{hour:0,price_units:12500}],groups:(s.sharedCapacityRows||capacityRows(s)).map(w=>w.worker_group),workers:s.sharedCapacityRows||capacityRows(s)});
   }else if(p==='/shared/accounts'&&req.method==='GET')result={rows:[{id:accountId,label:'<img src=x onerror=alert(1)>',registration_phone:'+60123456789',phone:'60123456789',worker_group:'fixture-group',enabled:true,status:'ready',shared_state:'connected',shared_checked_at:new Date().toISOString(),connected:true}],total:120,page:Number(url.searchParams.get('page')||1),size:50};
   else if(p==='/shared/hourly')result=[{hour_start:'2026-10-14T14:00:00Z',total:120,connected:2,waiting:118,offline:0,unknown:0,groups:1,checked_at:'2026-10-14T14:10:00Z'}];
   else if(p==='/shared/settings')result={ok:true};
   else if(p==='/shared/accounts/scan'&&req.method==='POST'){if(s.scanFailNext){s.scanFailNext=false;res.statusCode=503;result={error:'Synthetic add retry'};}else result={id:body.request_id,started:true};}
   else if(p==='/shared/accounts'&&req.method==='POST')result={created:2,duplicates:0};
   else if(p==='/shared/send'){
    s.sends.push(body);
    if(s.failNext){s.failNext=false;res.statusCode=503;result={error:'Fixture retry'};}else result={id:taskId,count:2,duplicates:1};
   }else if(p==='/shared/tasks')result={rows:[{id:taskId,title:'<script>fixture</script>',body:'fake UI message',created_at:'2026-10-14T14:00:00Z',interval_ms:60000,batch_size:3,shared_pool:true,created_by:'ui-'+s.role,enabled:true,creator:'fixture-'+s.role,counts:{pending:1,submitted:1}}],page:1,size:100};
   else if(p==='/shared/records')result={rows:[{id:1,title:'fixture task',body:'fake UI message',creator:'fixture-'+s.role,phone:'+60123456789',status:'submitted',updated_at:'2026-10-14T14:00:00Z'}],page:1,size:100};
   else if(p==='/campaigns/'+taskId+'/results')result={rows:[{phone:'+60123456789',status:s.taskReview?'unknown':'submitted',updated_at:'2026-10-14T14:00:00Z'}],total:1};
   else if(p==='/logout'){s.signedOut=true;result={ok:true};}
   else {res.statusCode=404;result={error:'Unexpected fixture request: '+p};}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
  }
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1),file=path.resolve(root,name);
  if(!file.startsWith(root+path.sep)){res.statusCode=403;res.end();return;}
  const type={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';
  res.setHeader('Content-Type',type);res.end(await fs.readFile(file));
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
});
async function waitReady(page,kind='shared'){
 await page.waitForFunction(kind=>!loading&&document.querySelector('#shell')?.hidden===false&&document.querySelector('#content')?.querySelector(kind==='shared'?'#shared-send-form':'[data-results]'),{},kind);
}

async function verifySidebar(page,fixture,role,language){
 const expanded=id=>page.$eval('#nav [data-nav-toggle='+id+']',n=>n.getAttribute('aria-expanded')==='true');
 const arrow=async id=>{
  const unchanged=await page.evaluate(id=>{const before=pageRequestVersion,current=page;document.querySelector('#nav [data-nav-toggle='+id+']').click();return pageRequestVersion===before&&page===current;},id);
  assert.equal(unchanged,true,'The arrow changes disclosure without navigating or loading a page');
 };
 const navigate=async(id,part)=>{await page.click('#nav [data-page='+id+'] '+part);await page.waitForFunction(id=>page===id&&!loading&&lastRenderedPage===id,{},id);};
 const writes=fixture.requests.filter(r=>r.method!=='GET').length;
 for(const id of role==='owner'?['billing','banks','accounts','shared','users']:['accounts','shared']){
  if(id==='banks'&&!await expanded('billing'))await arrow('billing');
  if(await expanded(id))await arrow(id);
  await navigate(id,'.nav-label');assert.equal(await expanded(id),false,'A menu label does not open its list');
  await arrow(id);assert.equal(await expanded(id),true);
  await navigate(id,'.nav-icon');assert.equal(await expanded(id),true,'A menu icon does not close its list');
  await navigate('overview','.nav-label');await navigate(id,'.nav-label');assert.equal(await expanded(id),true,'Navigation back to a parent preserves its open list');
  await page.evaluate(()=>navigation());assert.equal(await expanded(id),true);
  await arrow(id);assert.equal(await expanded(id),false);
  assert.equal(await page.$eval('#nav [data-page='+id+']',n=>n.hasAttribute('aria-expanded')),false);
 }
 await page.setViewport({width:390,height:844});
 await page.focus('#nav [data-nav-toggle=shared]');await page.keyboard.press('Enter');assert.equal(await expanded('shared'),true);
 await navigate('shared','.nav-label');await waitReady(page);assert.equal(await expanded('shared'),true);
 await page.reload({waitUntil:'networkidle0'});await waitReady(page);assert.equal(await expanded('shared'),true);
 await page.focus('#nav [data-nav-toggle=shared]');await page.keyboard.press('Space');assert.equal(await expanded('shared'),false);
 await page.evaluate(()=>loadPage(true));assert.equal(await expanded('shared'),false,'Polling must not reopen the list');
 await page.reload({waitUntil:'networkidle0'});await waitReady(page);assert.equal(await expanded('shared'),false);
 await page.click('#nav [data-nav-toggle=shared]');assert.equal(await expanded('shared'),true);
 await page.focus('#nav [data-page=shared-tasks]');await page.keyboard.press('Escape');assert.equal(await expanded('shared'),false);
 await page.click('#nav [data-nav-toggle=shared]');assert.equal(await expanded('shared'),true);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 assert.equal(fixture.requests.filter(r=>r.method!=='GET').length,writes);
 await page.setViewport({width:1440,height:1000});
 console.log('Sidebar PASS: '+role+' / '+language+' / arrow-only disclosure, parent labels/icons, nested banks, keyboard, polling, reload and mobile');
}

async function verifyLanguageSelector(page,language,theme){
 const view=await page.$eval('#language',select=>{
  const css=getComputedStyle(select);
  return {scheme:css.colorScheme,value:select.value,selected:select.selectedOptions[0].textContent,
   options:[...select.options].map(option=>{const s=getComputedStyle(option);return {value:option.value,label:option.textContent,color:s.color,background:s.backgroundColor};})};
 });
 assert.equal(view.scheme,theme,'Native language controls follow the chosen app theme');
 assert.equal(view.value,language);
 assert.equal(view.selected,language==='en'?'EN English':'CN 中文简体');
 assert.deepEqual(view.options.map(({value,label})=>({value,label})),[{value:'zh',label:'CN 中文简体'},{value:'en',label:'EN English'}]);
 const rgb=value=>value.match(/[\d.]+/g).map(Number);
 const luminance=channels=>channels.slice(0,3).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
 for(const option of view.options){
  const background=rgb(option.background),foreground=rgb(option.color);
  assert.ok(background.length===3||background[3]===1,'Dropdown choices have an opaque background');
  const a=luminance(foreground),b=luminance(background);
  assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,'Both language choices remain readable in '+theme+' mode');
  assert.ok(theme==='dark'?b<.1:b>.8,'The expanded options use the app theme surface');
 }
}

async function verifyThemeSurfaces(page,theme){
 const colors=await page.evaluate(()=>{
  const css=selector=>{const n=document.querySelector(selector),s=getComputedStyle(n);return{foreground:s.color,background:s.backgroundColor};};
  return{idle:css('#nav [data-page=overview]'),active:css('#nav [aria-current=page]'),primary:css('#content button.primary'),panel:css('#content .panel')};
 });
 assert.equal(colors.idle.background,'rgba(0, 0, 0, 0)','Idle sidebar rows have no filled blocks in '+theme);
 assert.notEqual(colors.active.background,colors.idle.background,'The selected page retains a clear accent');
 const luminance=value=>value.match(/[\d.]+/g).slice(0,3).map(Number).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
 for(const [kind,item]of Object.entries(colors).filter(([kind])=>kind==='primary'||kind==='panel')){const a=luminance(item.foreground),b=luminance(item.background);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,kind+' text meets 4.5:1 contrast in '+theme);}
}

async function uiScreenshot(page,name,role,language){
 if(!process.env.UI_SCREENSHOT_DIR||language!=='zh')return;
 await fs.mkdir(process.env.UI_SCREENSHOT_DIR,{recursive:true});
 await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,name+'-'+role+'.png')});
}
async function verifySessionRefresh(page,fixture,role,language){
 const writes=fixture.requests.filter(r=>r.method!=='GET').length;
 fixture.meDelayMs=1200;
 await page.reload({waitUntil:'domcontentloaded'});
 assert.equal(await page.$eval('#session-loading',n=>n.hidden),false);
 assert.equal(await page.$eval('#login',n=>n.hidden),true,'An unverified session must not flash the login form');
 assert.equal(await page.$eval('#shell',n=>n.hidden),true,'Private content waits for session verification');
 assert.equal(await page.$eval('#login-tools',n=>n.hidden),true);
 assert.equal(await page.$('#session-loading .brand,#session-loading .login-card'),null,'No centered logo/card during refresh');
 assert.equal(await page.$$eval('dialog[open]',n=>n.length),0);
 await uiScreenshot(page,'refresh-pending',role,language);
 await waitReady(page);fixture.meDelayMs=0;
 const frames=await page.evaluate(()=>window.fixtureBootFrames);
 assert.ok(frames.some(f=>f.loading),'Sample an actual pending session paint');
 assert.ok(frames.every(f=>!f.login&&!f.card&&!f.dialog&&!f.toast),'A restored session never paints a login card, popup, dialog or toast');
 fixture.meStatus=503;
 await page.reload({waitUntil:'networkidle0'});
 await page.waitForSelector('#session-retry',{visible:true});
 assert.equal(await page.$eval('#login',n=>n.hidden),true,'Temporary server failure is not a logout');
 assert.equal(await page.$eval('#shell',n=>n.hidden),true);
 assert.match(await page.$eval('#session-message',n=>n.textContent),language==='en'?/Cannot reach the server/:/暂时无法连接服务器/);
 assert.equal(await page.$eval('#session-message',n=>n.getBoundingClientRect().height>0&&!n.classList.contains('sr-only')),true,'Connection errors remain readable');
 fixture.meStatus=0;await page.click('#session-retry');await waitReady(page);
 assert.equal(await page.$eval('#session-loading',n=>n.hidden),true);
 assert.equal(fixture.requests.filter(r=>r.method!=='GET').length,writes,'Refresh and retry are read-only');
 console.log('Session refresh PASS: '+role+' / '+language+' / delayed restoration without login/logo/popups, private content hidden, recoverable 503 retry');
}
async function verifyWorkspaceHeader(page,fixture,role,language){
 const writes=fixture.requests.filter(r=>r.method!=='GET').length;
 const greeting=name=>(language==='en'?'Hi, ':'你好，')+name;
 assert.equal(await page.$eval('#account-greeting',n=>n.textContent),greeting('fixture-'+role));
 assert.equal(await page.$eval('#account-greeting',n=>n.tagName),'SPAN');
 assert.equal(await page.$('#account-toggle,#account-name,#account-menu,#header-logout,#header-password,#refresh,#help-menu'),null,'Removed controls are absent, not a hidden menu');
 assert.equal(await page.$eval('#clock',n=>n.getAttribute('title')),language==='en'?'Malaysia time UTC+8':'马来西亚时间 UTC+8');
 assert.equal(await page.$eval('#password-btn',n=>n.hidden),role!=='owner','Owner password control stays in the sidebar');
 await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:'light'}]);
 await verifyLanguageSelector(page,language,'dark');
 await verifyThemeSurfaces(page,'dark');
 await uiScreenshot(page,'header-dark',role,language);
 const originalOffset=await page.evaluate(()=>clockOffset);
 await page.evaluate(()=>{clockOffset=Date.UTC(2026,9,21,16,0,5)-Date.now();WorkspaceHeader.update(me,clockOffset);});
 assert.match(await page.$eval('#clock-time',n=>n.textContent),/^00:00:0[5-9]$/);
 assert.match(await page.$eval('#clock-date',n=>n.textContent),language==='en'?/22 October 2026/:/2026年10月22日/);
 await page.evaluate(originalOffset=>{clockOffset=originalOffset;WorkspaceHeader.update({...me,username:'<img src=x onerror=alert(1)>'},clockOffset);},originalOffset);
 assert.equal(await page.$eval('#account-greeting',n=>n.textContent),greeting('<img src=x onerror=alert(1)>'),'The current username is rendered as literal text');
 assert.equal(await page.$eval('.header-right',n=>n.querySelectorAll('img,script').length),0);
 await page.evaluate(()=>WorkspaceHeader.update(me,clockOffset));
 await page.focus('#help-toggle');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('#guide-dialog').open);
 assert.equal(await page.$eval('#help-toggle',n=>n.getAttribute('aria-haspopup')),'dialog');
 assert.equal(await page.$eval('#guide-content h3',n=>n.textContent),language==='en'?'How to use WhatsApp accounts':'WhatsApp 账号怎么使用');
 assert.equal(await page.$$eval('#guide-content li',nodes=>nodes.length),8);
 const guide=await page.$eval('#guide-content',n=>n.textContent);
 assert.doesNotMatch(guide,/共享 WhatsApp|Shared WhatsApp|共享运行容量|Pricing \/ settings/);
 assert.match(guide,language==='en'?/Each USER can add up to 10 accounts/:/每个 USER 最多添加 10 个账号/);
 assert.match(guide,language==='en'?/5 seconds to 1 hour/:/5 秒至 1 小时/);
 assert.match(guide,language==='en'?/without manual administrator approval/:/不需要管理员人工批准/);
 assert.match(guide,language==='en'?/Ask the administrator to resume, delete or change the pacing/:/恢复、删除或修改间隔，请联系管理员/);
 assert.match(guide,language==='en'?/refunded automatically/:/系统自动退回/);
 assert.equal(await page.$$eval('#guide-content input,#guide-content form',nodes=>nodes.length),0);
 await uiScreenshot(page,'guide-user',role,language);
 const preserved=await page.evaluate(async()=>{const node=document.querySelector('#guide-content');const before=node.innerHTML;await loadPage(true);return node.innerHTML===before;});
 assert.equal(preserved,true,'Background polling leaves the reading guide intact');
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#guide-dialog').open&&document.activeElement===document.querySelector('#help-toggle'));
 await page.click('#theme-toggle');
 assert.equal(await page.$eval('html',n=>n.dataset.theme),'light');
 await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:'dark'}]);
 await verifyLanguageSelector(page,language,'light');
 await verifyThemeSurfaces(page,'light');
 await uiScreenshot(page,'header-light',role,language);
 assert.equal(await page.evaluate(()=>localStorage.getItem('wa_theme')),'light');
 await page.reload({waitUntil:'networkidle0'});await waitReady(page);
 assert.equal(await page.$eval('html',n=>n.dataset.theme),'light','Theme persists after refresh');
 for(const nextLanguage of [language==='en'?'zh':'en',language]){
  await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.select('#language',nextLanguage)]);await waitReady(page);
  assert.equal(await page.evaluate(()=>localStorage.getItem('wa_language')),nextLanguage);
  assert.equal(await page.$eval('html',n=>n.lang),nextLanguage==='en'?'en':'zh-CN');
  assert.equal(await page.$eval('#account-greeting',n=>n.textContent),(nextLanguage==='en'?'Hi, ':'你好，')+'fixture-'+role,'The restored current username follows the selected language');
  await verifyLanguageSelector(page,nextLanguage,'light');
 }
 await page.click('#theme-toggle');assert.equal(await page.$eval('html',n=>n.dataset.theme),'dark');
 await verifyLanguageSelector(page,language,'dark');
 for(const width of [1440,390,320]){
  await page.setViewport({width,height:900});
  assert.ok(await page.$eval('#clock-time',n=>n.getBoundingClientRect().width>0),'The time is visible on desktop and mobile');
  assert.ok(await page.$eval('#account-greeting',n=>n.getBoundingClientRect().width>0),'Greeting stays visible despite the legacy mobile span rule');
  await page.evaluate(()=>WorkspaceHeader.update({...me,username:'W'.repeat(40)},clockOffset));
  assert.equal(await page.$eval('#account-greeting',n=>n.textContent),greeting('W'.repeat(40)),'The complete maximum-length username remains visible');
  assert.ok(await page.$eval('#account-greeting',n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth+1&&n.scrollWidth<=n.clientWidth+1;}),'Long usernames wrap inside the desktop/mobile header');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Long usernames do not add horizontal page scrolling');
  if(width===390)await uiScreenshot(page,'header-long-name-mobile',role,language);
  await page.evaluate(()=>WorkspaceHeader.update(me,clockOffset));
  assert.ok(await page.$eval('#language',n=>{const s=getComputedStyle(n),canvas=document.createElement('canvas'),c=canvas.getContext('2d');c.font=s.font;return c.measureText(n.selectedOptions[0].textContent).width+parseFloat(s.paddingLeft)+parseFloat(s.paddingRight)<=n.clientWidth;}),'The full language label fits');
  await page.click('#help-toggle');await page.waitForFunction(()=>document.querySelector('#guide-dialog').open);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.equal(await page.$eval('#guide-dialog',n=>n.scrollTop),0,'Reopening the tutorial starts at step 1');
  const rect=await page.$eval('#guide-dialog',n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,fits:n.scrollWidth<=n.clientWidth+1};});
  assert.ok(rect.left>=0&&rect.right<=width&&rect.fits,'The direct guide fits desktop and narrow screens');
  if(width===390)await uiScreenshot(page,'guide-mobile',role,language);
  await page.click('#guide-open-page');await page.waitForFunction(()=>page==='accounts'&&!loading);
  await page.evaluate(()=>{page='shared';sessionStorage.setItem('wa_page',page);navigation();return loadPage();});await waitReady(page);
 }
 await page.setViewport({width:1440,height:1000});
 assert.equal(fixture.requests.filter(r=>r.method!=='GET').length,writes,'Header, themes and guides never start a QR browser or mutate data');
 console.log('Workspace header PASS: '+role+' / '+language+' / current username as safe text, 40-character mobile wrapping, no refresh/account dropdown, direct keyboard USER guide, Malaysia midnight, themes/languages and 320px layout; no writes');
}
async function verifyLoginPage(page,fixture,role,language){
 await page.reload({waitUntil:'networkidle0'});
 await page.waitForSelector('#login-form',{visible:true});
 assert.equal(await page.$eval('#shell',n=>n.hidden),true);
 assert.equal(await page.$eval('#session-loading',n=>n.hidden),true,'A real 401 reveals login after verification');
 assert.equal(await page.$eval('#login-tools',n=>n.hidden),false);
 assert.equal(await page.$('.login-access'),null);
 assert.match(await page.$eval('#login-notice',n=>n.textContent),language==='en'?/Welcome to mywasap/:/欢迎使用 mywasap/);
 assert.doesNotMatch(await page.$eval('#login',n=>n.textContent),/Private sign-out notice|Ask your administrator|Don.t have an account/);
 await verifyNoticeSequence(page,'#login-notice');
 assert.equal(await page.$eval('#login-form input[name=password]',n=>n.type),'password');
 assert.equal(await page.$eval('#login-form input[name=password]',n=>n.autocomplete),'current-password');
 for(const theme of ['dark','light']){
  if(await page.$eval('html',n=>n.dataset.theme)!==theme)await page.click('#theme-toggle');
  await verifyLanguageSelector(page,language,theme);
  for(const width of [1440,390,320]){
   await page.setViewport({width,height:1000});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   const layout=await page.evaluate(()=>{const a=document.querySelector('.login-brand').getBoundingClientRect(),b=document.querySelector('#login-form').getBoundingClientRect();return{brandRight:a.right,brandBottom:a.bottom,formLeft:b.left,formTop:b.top};});
   assert.ok(width===1440?layout.brandRight<layout.formLeft:layout.brandBottom<=layout.formTop,'Brand/credentials follow reference columns, stacked on mobile');
   assert.ok(await page.$eval('#login-form button[type=submit]',n=>n.getBoundingClientRect().width>0&&!n.disabled));
   if(width!==320)await uiScreenshot(page,'login-'+theme+'-'+width,role,language);
  }
 }
 const loginCount=()=>fixture.requests.filter(r=>r.path==='/login').length;
 const before=loginCount();await page.click('#login-form button[type=submit]');assert.equal(loginCount(),before,'Required empty inputs cannot submit');
 await page.type('#login-form input[name=username]','synthetic-user');await page.type('#login-form input[name=password]','synthetic-ui-password');
 fixture.loginRejectedNext=true;await page.click('#login-form button[type=submit]');
 await page.waitForFunction(()=>document.querySelector('#login-error').textContent.includes('Synthetic incorrect')&&!document.querySelector('#login-form button').disabled);
 assert.equal(await page.$eval('#shell',n=>n.hidden),true);
 await page.click('#login-form button[type=submit]');await waitReady(page);
 assert.equal(await page.$eval('#account-greeting',n=>n.textContent),(language==='en'?'Hi, ':'你好，')+'fixture-'+role,'Successful synthetic sign-in restores only the current account name');
 assert.equal(await page.$eval('#login-form input[name=password]',n=>n.value),'','Successful synthetic sign-in clears the password field');
 assert.deepEqual(fixture.requests.filter(r=>r.path==='/login').map(r=>({method:r.method,body:r.body})),[1,2].map(()=>({method:'POST',body:{username:'synthetic-user',password:'synthetic-ui-password'}})));
 console.log('Reference login PASS: '+role+' / '+language+' / actual 401, dark/light, desktop/390/320, validation, synthetic failed/successful sign-in; no production account');
}

async function verifyAccountIdentity(page,fixture,role,language){
 const cell=role==='owner'?'[data-account-user=owner] tbody tr td:first-child':'#content tbody tr td:first-child';
 const oldPhone='+15555550101',newPhone='+15555550102',writes=fixture.requests.filter(r=>r.method!=='GET').length;
 assert.match(await page.$eval(cell,n=>n.textContent),/\+15555550101/);
 // The fixture deliberately retains the old phone in disconnected responses.
 // Wait for the real five-second page poll; do not call loadPage or reload here.
 fixture.accountStatus='scan_required';
 await page.waitForFunction((selector,old)=>{const n=document.querySelector(selector);return n&&!n.textContent.includes(old);},{timeout:12000},cell,oldPhone);
 assert.match(await page.$eval(cell,n=>n.textContent),language==='en'?/Not linked/:/尚未关联/);
 assert.ok((await page.$eval(cell,n=>n.textContent)).includes('fixture personal'));
 fixture.accountStatus='loading';await page.evaluate(()=>loadPage(true));
 assert.ok(!(await page.$eval(cell,n=>n.textContent)).includes(oldPhone));
 fixture.accountStatus='ready';fixture.accountPhone=newPhone.slice(1);
 await page.waitForFunction((selector,phone)=>document.querySelector(selector)?.textContent.includes(phone),{timeout:12000},cell,newPhone);
 assert.ok(!(await page.$eval(cell,n=>n.textContent)).includes(oldPhone));
 await page.setViewport({width:390,height:844});assert.match(await page.$eval(cell,n=>n.textContent),/\+15555550102/);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.setViewport({width:1440,height:1000});
 assert.equal(fixture.requests.filter(r=>r.method!=='GET').length,writes);
 console.log('Account identity PASS: '+role+' / '+language+' / old number hidden while awaiting scan and syncing; new number appears through automatic polling');
}

async function verifySenderGroups(page,fixture,kind,language){
 const start=fixture.requests.length,writes=fixture.requests.filter(r=>r.method!=='GET').length,own='[data-owner-send-actor="ui-owner"]',other='[data-owner-send-actor="active-user"]';
 assert.equal(await page.$$eval('[data-owner-send-actor]',nodes=>nodes.length),kind==='tasks'?2:3);
 const expected=['ui-owner','active-user',...(kind==='messages'?['external']:[])];
 assert.deepEqual(await page.$$eval('[data-owner-send-actor]',nodes=>nodes.map(n=>n.dataset.ownerSendActor)),expected);
 assert.equal(await page.$$eval('[data-owner-send-actor]',nodes=>nodes.every(n=>!n.open)),true);
 assert.equal(await page.$$eval('#content tbody tr',nodes=>nodes.length),0);
 assert.equal(fixture.requests.slice(start).some(r=>r.path==='/owner/send-items'),false);
 await page.click(other+' > summary');
 await page.waitForFunction(({selector,text})=>!loading&&document.querySelector(selector)?.textContent.includes(text),{}, {selector:other,text:'Synthetic USER '+(kind==='tasks'?'task':'message')+' page 1'});
 assert.equal(await page.$eval(own,n=>n.open),false);
 await page.click(other+' [data-send-page="1"]');
 await page.waitForFunction(({selector,text})=>!loading&&document.querySelector(selector)?.textContent.includes(text),{}, {selector:other,text:'Synthetic USER '+(kind==='tasks'?'task':'message')+' page 2'});
 for(const state of [{active:false,locked:false},{active:true,locked:true}]){
  const hiddenAt=fixture.requests.length;fixture.userAccess={'active-user':state};await page.evaluate(()=>loadPage(true));
  assert.deepEqual(await page.$$eval('[data-owner-send-actor]',nodes=>nodes.map(n=>n.dataset.ownerSendActor)),['ui-owner',...(kind==='messages'?['external']:[])]);
  assert.equal(await page.$(other),null);assert.doesNotMatch(await page.$eval('#content',n=>n.textContent),/Synthetic USER (task|message) page/);
  assert.equal(fixture.requests.slice(hiddenAt).some(r=>r.path==='/owner/send-items'&&r.query.includes('actor_id=active-user')),false);
  fixture.userAccess={};await page.evaluate(()=>loadPage(true));
  assert.deepEqual(await page.$$eval('[data-owner-send-actor]',nodes=>nodes.map(n=>n.dataset.ownerSendActor)),expected);
  assert.equal(await page.$eval(other,n=>n.open),true);assert.match(await page.$eval(other,n=>n.textContent),/page 2/);
 }
 // One failed group never hides the other groups or invents an empty result.
 fixture.failSendGroup='active-user';await page.evaluate(()=>loadPage(true));
 assert.match(await page.$eval(other,n=>n.textContent),language==='en'?/Cannot load this group/:/暂时无法加载这组记录/);
 assert.ok(await page.$(own));fixture.failSendGroup=null;await page.evaluate(()=>loadPage(true));
 await page.click(other+' > summary');await page.waitForFunction(selector=>!document.querySelector(selector).open,{},other);
 const closedAt=fixture.requests.length;
 await page.click(own+' > summary');await page.waitForFunction(selector=>!loading&&document.querySelector(selector)?.querySelector('tbody tr'),{},own);
 assert.doesNotMatch(await page.$eval('#content',n=>n.textContent),/Synthetic USER (task|message) page/);
 await page.evaluate(()=>loadPage(true));assert.equal(await page.$eval(other,n=>n.open),false);
 assert.equal(fixture.requests.slice(closedAt).some(r=>r.path==='/owner/send-items'&&r.query.includes('actor_id=active-user')),false);
 await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(selector=>!loading&&document.querySelector(selector)?.querySelector('tbody tr'),{},own);
 assert.equal(await page.$eval(other,n=>n.open),false);assert.equal(await page.$eval(own,n=>n.open),true);
 for(const width of [390,1440]){await page.setViewport({width,height:width===390?844:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
 assert.equal(fixture.requests.filter(r=>r.method!=='GET').length,writes);
 console.log('Owner per-ID '+kind+' PASS: '+language+' / collapsed lazy groups, independent pages, partial failure, saved state, read-only and mobile');
}
async function verifySharedPhotos(page,fixture,role,language){
 assert.equal(await page.$('#shared-send-form input[name=title]'),null);
 if(role==='owner'){
  assert.equal(await page.$eval('[data-owner-shared-send]',n=>!!n.querySelector('form')&&!n.closest('details')),true);
  assert.ok(await page.$('#shared-send-form input[name=photo]'));
  const original={enabled:fixture.enabled,available:fixture.available};
  await page.click('#shared-photo-toggle');await page.waitForFunction(()=>document.querySelector('#shared-photo-toggle').getAttribute('aria-pressed')==='false');
  assert.equal(fixture.imagesEnabled,false);assert.ok(await page.$('#shared-send-form input[name=photo]'));
  await page.click('#shared-photo-toggle');await page.waitForFunction(()=>document.querySelector('#shared-photo-toggle').getAttribute('aria-pressed')==='true');
  assert.deepEqual({enabled:fixture.enabled,available:fixture.available},original);
  fixture.sharedCapacityRows=Array.from({length:6},(_,i)=>({worker_group:'fixture-shared-'+i,max_accounts:5,slots_used:0,slots_available:5,can_start_more:true,heartbeat_at:new Date().toISOString()}));
  await page.evaluate(()=>loadPage());assert.deepEqual(await page.$$eval('.shared-cards .value',nodes=>nodes.slice(-3).map(n=>n.textContent)),['30','0','30']);
  fixture.sharedCapacityRows=null;await page.evaluate(()=>loadPage());
 }else{
  assert.equal(await page.$('#shared-photo-toggle'),null);assert.ok(await page.$('#shared-send-form input[name=photo]'));
  await page.$eval('#shared-send-form',f=>{const body=f.elements.namedItem('body');body.value='Retained synthetic draft';body.dispatchEvent(new Event('input',{bubbles:true}));f.dataset.requestId='55555555-5555-4555-8555-555555555555';body.focus();});
  fixture.imagesEnabled=false;await page.evaluate(()=>loadPage(true));
  assert.equal(await page.$('#shared-send-form input[name=photo]'),null);assert.equal(await page.$eval('#shared-send-form textarea[name=body]',n=>n.value),'Retained synthetic draft');
  assert.equal(await page.$eval('#shared-send-form',n=>n.dataset.requestId),'55555555-5555-4555-8555-555555555555');
  fixture.imagesEnabled=true;await page.evaluate(()=>loadPage(true));assert.ok(await page.$('#shared-send-form input[name=photo]'));
  await page.$eval('#shared-send-form',f=>{f.reset();delete f.dataset.dirty;delete f.dataset.requestId;document.activeElement?.blur();});
  assert.equal(fixture.requests.some(r=>r.path==='/shared/options'&&r.method==='PUT'),false);
 }
 console.log('Shared photos PASS: '+role+' / '+language+' / Owner toggle, USER visibility, draft and request ID retained; task title omitted');
}

async function verifySharedAvailability(page,fixture,role,language){
 const writes=fixture.requests.filter(r=>r.method!=='GET').length;
 if(role==='owner'){
  assert.equal(await page.$('#shared-register'),null);
  for(const enabled of [false,true]){
   await page.click('#shared-availability');
   await page.waitForFunction(enabled=>document.querySelector('#shared-availability')?.getAttribute('aria-pressed')===String(enabled),{},enabled);
   assert.equal(fixture.enabled,enabled);assert.ok(await page.$('#shared-add'));
   assert.ok(await page.$('#nav [data-page=shared]'),'Owner keeps account/QR management when closed');
   assert.deepEqual(fixture.requests.findLast(r=>r.path==='/shared/availability').body,{enabled});
  }
 }else{
  assert.equal(await page.$('#shared-availability'),null);
  fixture.featuresFail=true;await page.evaluate(()=>loadPage(true));
  assert.ok(await page.$('#nav [data-page=shared]'),'A temporary policy read failure preserves the last confirmed state');fixture.featuresFail=false;
  await page.focus('#shared-send-form textarea[name=body]');fixture.enabled=false;
  await page.waitForFunction(()=>page==='overview'&&!loading&&!document.querySelector('#nav [data-page=shared]'),{timeout:9000});
  assert.equal(await page.$('#shared-send-form'),null,'Closing removes a focused stale sending form');
  assert.equal(await page.$('#nav [data-page=shared-tasks],#nav [data-page=shared-records]'),null);
  await page.evaluate(()=>sessionStorage.setItem('wa_page','shared-tasks'));
  const start=fixture.requests.length;await page.reload({waitUntil:'networkidle0'});
  await page.waitForFunction(()=>page==='overview'&&!loading&&lastRenderedPage==='overview');
  assert.equal(fixture.requests.slice(start).some(r=>['/shared/tasks','/shared/records','/shared/accounts'].includes(r.path)),false,'Closed saved routes never request shared data');
  fixture.enabled=true;await page.evaluate(()=>loadPage(true));
  await page.click('#nav [data-nav-toggle=shared]');await page.click('#nav [data-page=shared-tasks]');await waitReady(page,'shared-tasks');
  await page.click('[data-results]');await page.waitForFunction(()=>document.querySelector('#modal').open);fixture.enabled=false;
  await page.waitForFunction(()=>page==='overview'&&!loading&&!document.querySelector('#modal').open&&!document.querySelector('#nav [data-page=shared]'),{timeout:9000});
  fixture.enabled=true;await page.evaluate(()=>loadPage(true));
  await page.click('#nav [data-page=shared]');await waitReady(page);
  assert.equal(fixture.requests.filter(r=>r.method!=='GET').length,writes,'USER observes the switch without writing');
 }
 console.log('Shared availability PASS: '+role+' / '+language+' / Owner-only isolated toggle; closed USER navigation, focused drafts and stored routes removed; transient read retains last policy');
}

async function verifyPersonalPages(page,fixture,role,language){
 const pages=[
  ['accounts','#add-account',/画面断开不代表|A disconnected screen does not mean/],
  ['tasks','#add-task',/USER 发送前须充值|USERs need credit before sending/],
  ['messages',role==='owner'?'[data-owner-send-actor]':'#history-prev',/按号码显示任务|Shows per-number waiting/],
  ['overview','.overview-chart',/真实消息数据|Live message data/]
 ];
 for(const [target,ready,explanation]of pages){
  const requestStart=fixture.requests.length;
  if(target==='tasks')fixture.taskReview=true;
  await page.evaluate(target=>{page=target;sessionStorage.setItem('wa_page',target);navigation();return loadPage();},target);
  await page.waitForSelector(ready);
  if(role==='owner'&&['tasks','messages'].includes(target))await verifySenderGroups(page,fixture,target,language);
  const text=await page.$eval('#content',n=>n.textContent);
  if(role==='owner')assert.match(text,explanation);else assert.doesNotMatch(text,explanation);
  if(target==='accounts'){await verifyAccountIdentity(page,fixture,role,language);if(role==='owner')await verifyAccountGroups(page,fixture);}
  if(target==='tasks'&&role==='user')assert.doesNotMatch(text,/按间隔和每批数量发送|Send by interval and batch size/);
  if(target==='tasks'){
   for(const width of [1440,390]){
    await page.setViewport({width,height:width===390?844:1000});
    assert.equal(await page.$$eval('[data-schedule]',nodes=>nodes.length),role==='owner'?1:0);
   }
   await page.setViewport({width:1440,height:1000});
   assert.equal(await page.$$eval('[data-pause]',nodes=>nodes.length),role==='owner'?1:0);
   if(role==='owner'){
    await page.click('[data-schedule]');await page.waitForFunction(()=>document.querySelector('#modal').open);
    assert.ok(await page.$('#modal input[name=interval_value]'));assert.ok(await page.$('#modal input[name=batch_size]'));await page.click('#close-modal');
   }else assert.doesNotMatch(text,/修改间隔\s*\/\s*数量|Edit interval\s*\/\s*quantity/);
   assert.equal(await page.$$eval('[data-now]',nodes=>nodes.length),0);
   if(role==='owner')assert.match(text,language==='en'?/View results/:/查看结果/);
   else{assert.equal(await page.$$eval('[data-delete-task]',nodes=>nodes.length),0);assert.equal(await page.$('[data-pause]'),null);assert.equal(await page.$$eval('.actions button',nodes=>nodes.length),1);}
   assert.match(text,language==='en'?/Last action/:/最近操作/);assert.match(text,/11:10:00/);
   const posts=fixture.requests.filter(r=>r.path.endsWith('/send-now')).length;
   await page.click('[data-results]');await page.waitForFunction(()=>document.querySelector('#modal').open);
   assert.match(await page.$eval('#modal-content',n=>n.textContent),language==='en'?/Unconfirmed/:/结果未确认/);
   assert.equal(fixture.requests.filter(r=>r.path.endsWith('/send-now')).length,posts);await page.click('#close-modal');
   await page.click('#add-task');await page.waitForFunction(()=>document.querySelector('#modal').open);
   assert.equal(await page.$('#modal input[name=title]'),null);
   await page.$eval('#modal form',f=>{f.elements.namedItem('body').value='Synthetic message';f.elements.namedItem('recipients').value='0123456789';f.elements.namedItem('opt_in').checked=true;});
   const created=page.waitForResponse(r=>r.url().endsWith('/api/campaigns')&&r.request().method()==='POST');
   await page.click('#modal button[value=now]');await created;await page.waitForFunction(()=>!document.querySelector('#modal').open);
   const newTask=fixture.requests.findLast(r=>r.path==='/campaigns'&&r.method==='POST');assert.equal(newTask.body.send_now,true);assert.equal(newTask.body.require_connected,true);assert.equal(newTask.body.title,undefined);
   assert.equal(fixture.requests.filter(r=>r.path.endsWith('/send-now')).length,posts);fixture.taskReview=false;
  }
  if(target==='messages'){
   assert.equal(!!await page.$('#history-sync-note'),role==='owner');
   if(role==='user')assert.doesNotMatch(text,/等待连接后核对|Waiting for connection to check/);
   assert.equal(await page.$$eval('#content tbody .badge',nodes=>nodes.length),5);
   assert.match(text,language==='en'?/Unconfirmed/:/结果未确认/);
  }
  if(target==='overview'){
   if(role==='user')assert.doesNotMatch(text,/按首次发送日期统计|Grouped by first send date|发送成功包含|Successful includes submitted/);
   const scope=role==='owner'?'[data-overview-owner] ':'';
   assert.equal(await page.$$eval(scope+'.overview-cards .card',nodes=>nodes.length),4);
   assert.equal(await page.$$eval(scope+'.overview-week>div',nodes=>nodes.length),7);
   assert.equal(await page.$$eval('#content [data-view],#content [data-start],#content [data-account-user]',nodes=>nodes.length),0);
   assert.equal(await page.$('[data-capacity]'),null);
   assert.equal(await page.$('[data-hourly-checks]'),null);
   assert.equal(fixture.requests.slice(requestStart).some(r=>['/health','/shared/hourly'].includes(r.path)),false);
   if(role==='user')assert.equal(fixture.requests.some(r=>['/health','/shared/hourly','/users'].includes(r.path)),false);
   if(role==='owner')await verifyGroupedOverview(page,fixture);
   else assert.equal(await page.$('[data-overview-user]'),null);
  }
 }
 await page.click('#nav [data-page=shared]');await waitReady(page);
}
async function verifyUserBilling(page,fixture,language){
 async function sections(){
  assert.equal(await page.$('#nav [data-page=fpx]'),null);
  assert.equal(await page.$('#nav [data-page=bank-deposits]'),null);
  assert.equal(await page.$('#nav [data-nav-toggle=billing]'),null);
  assert.equal(await page.$('[data-billing-view]'),null);
  assert.equal(await page.$('.credit-ledger'),null);
  assert.equal(await page.$('.automatic-refunds'),null);assert.equal(current.requests.some(r=>r.path==='/billing/automatic-refunds'),false);
  assert.doesNotMatch(await page.$eval('#content',n=>n.textContent),/余额流水|Credit ledger/);
  assert.equal(await page.$eval('#bank-topup',n=>!!(n.compareDocumentPosition(document.querySelector('#online-fpx'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
  assert.match(await page.$eval('#content > section:last-of-type h2',n=>n.textContent),language==='en'?/My deposits/:/我的充值记录/);
  assert.match(await page.$eval('.balance-only',n=>n.textContent),/10000000/);
 }
 await sections();
 assert.equal(await page.$eval('[data-service-rate=personal] .value',n=>n.textContent),'RM 0.68');
 assert.equal(await page.$eval('[data-service-rate=shared] .value',n=>n.textContent),'RM 1.25');
 fixture.sharedRate=100;await page.evaluate(()=>loadPage());
 assert.equal(await page.$eval('[data-service-rate=shared] .value',n=>n.textContent),'RM 0.01');
 fixture.rateUnconfigured=true;await page.evaluate(()=>loadPage());
 assert.equal(await page.$eval('[data-service-rate=shared] .value',n=>n.textContent),language==='en'?'Not configured':'未设置');
 fixture.rateUnconfigured=false;fixture.sharedRate=12500;await page.evaluate(()=>loadPage());
 for(const theme of ['light','dark']){if(await page.$eval('html',n=>n.dataset.theme)!==theme)await page.click('#theme-toggle');await uiScreenshot(page,'billing-'+theme,'user',language);}
 assert.equal(await page.$eval('#online-fpx .service-coming-soon',n=>n.textContent),'Coming soon');
 assert.equal(await page.$('#online-topup'),null);assert.ok(await page.$('#deposit-create'));
 fixture.fpxEnabled=true;await page.evaluate(()=>loadPage());
 await page.waitForSelector('#online-topup');await sections();
 assert.equal(await page.$eval('#page-title',n=>n.textContent),language==='en'?'Credit / top-up':'余额 / 充值');
 assert.equal(await page.$eval('#nav [data-page=billing]',n=>n.getAttribute('aria-current')),'page');
 await page.click('#online-topup');await page.waitForFunction(()=>document.querySelector('#modal').open);
 assert.ok(await page.$('#modal input[name=amount]'));await page.click('#close-modal');
 await page.$eval('#deposit-create',f=>{f.elements.namedItem('amount').value='123.45';f.dataset.requestId='fixture-deposit-retry';});
 fixture.paymentPending=true;await page.evaluate(()=>loadPage(true));
 assert.equal(await page.$eval('#deposit-create input[name=amount]',n=>n.value),'123.45');
 assert.equal(await page.$eval('#deposit-create',n=>n.dataset.requestId),'fixture-deposit-retry');
 fixture.fpxEnabled=false;await page.evaluate(()=>loadPage());
 assert.equal(await page.$eval('#online-fpx .service-coming-soon',n=>n.textContent),'Coming soon');
 assert.equal(await page.$('#online-topup'),null);
 assert.equal(await page.$('#online-fpx a'),null);
 const check=page.waitForResponse(r=>r.url().endsWith('/api/payments/orders/fixture-order/check')&&r.request().method()==='POST');
 await page.click('[data-payment-check="fixture-order"]');await check;await page.waitForFunction(()=>!loading);
 assert.equal(fixture.requests.filter(r=>r.path==='/payments/orders/fixture-order/check'&&r.method==='POST'&&r.csrf==='fake-ui-csrf').length,1);
 await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('#deposit-create');await sections();
 fixture.bankMaintenance=true;await page.evaluate(()=>loadPage());
 assert.equal(await page.$('#deposit-create'),null);
 assert.match(await page.$eval('#content',n=>n.textContent),language==='en'?/Bank maintenance/:/银行维护中/);
 fixture.banksOff=true;await page.evaluate(()=>loadPage());
 assert.equal(await page.$eval('#bank-topup .service-coming-soon',n=>n.textContent),'Coming soon');
 assert.doesNotMatch(await page.$eval('#bank-topup',n=>n.textContent),/Fixture bank/);
 await sections();
 await page.setViewport({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Expanded USER billing fits a mobile viewport');
 await page.setViewport({width:1440,height:1000});
 await page.evaluate(()=>sessionStorage.setItem('wa_page','bank-deposits'));
 await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('#bank-topup');await sections();
 fixture.fpxEnabled=true;await page.goto(new URL('/?topup=fixture-order',page.url()).href,{waitUntil:'networkidle0'});
 await page.waitForSelector('#online-topup');await page.waitForFunction(()=>!location.search);await sections();
 assert.equal(fixture.requests.filter(r=>r.path==='/payments/orders/fixture-order/check'&&r.method==='POST'&&r.csrf==='fake-ui-csrf').length,2);
 fixture.fpxEnabled=false;await page.evaluate(()=>loadPage());await sections();
}

async function verifyAccountGroups(page,fixture){
 assert.equal(await page.$$eval('[data-account-user]',nodes=>nodes.length),4);
 assert.equal(await page.$$eval('[data-account-user][open]',nodes=>nodes.length),0);
 assert.equal(await page.$eval('[data-account-user="owner"] .table-wrap',n=>n.checkVisibility()),true);
 assert.equal(await page.$eval('[data-account-user="owner"]',n=>n.tagName),'SECTION');
 const writes=fixture.requests.filter(r=>r.method!=='GET').length;
 const colors={active:'rgb(103, 216, 177)',inactive:'rgb(255, 142, 150)',locked:'rgb(181, 188, 199)'};
 for(const [status,color]of Object.entries(colors)){
  const selector='[data-account-user="'+status+'-user"]';
  assert.equal(await page.$eval(selector+' [data-user-status]',n=>n.dataset.userStatus),status);
  assert.equal(await page.$eval(selector+' .status-dot',n=>getComputedStyle(n).backgroundColor),color);
  assert.equal(await page.$eval(selector+' summary',n=>n.getAttribute('aria-expanded')),'false');
  assert.equal(await page.$eval(selector+' .table-wrap',n=>n.checkVisibility()),false);
 }
 const active='[data-account-user="active-user"]';
 await page.click(active+' summary');
 await page.waitForFunction(()=>document.querySelector('[data-account-user="active-user"] summary').getAttribute('aria-expanded')==='true');
 assert.equal(await page.$eval(active+' .table-wrap',n=>n.checkVisibility()),true);
 assert.equal(await page.$$eval('[data-account-user][open]',nodes=>nodes.length),1);
 fixture.accountSuffix=' refreshed';await page.evaluate(()=>loadPage(true));
 assert.equal(await page.$eval(active,n=>n.open),true);
 assert.equal(await page.$$eval('[data-account-user][open]',nodes=>nodes.length),1);
 await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('#add-account');
 assert.equal(await page.$eval(active,n=>n.open),true);
 assert.equal(await page.$eval('[data-account-user="owner"] .table-wrap',n=>n.checkVisibility()),true);
 await page.focus(active+' summary');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('[data-account-user="active-user"] summary').getAttribute('aria-expanded')==='false');
 await page.keyboard.press('Space');
 await page.waitForFunction(()=>document.querySelector('[data-account-user="active-user"]').open);
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.querySelector('[data-account-user="active-user"]').open);
 await page.setViewport({width:390,height:844});
 await page.click('[data-account-user="locked-user"] summary');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Collapsible account groups fit a mobile viewport');
 assert.equal(await page.$eval('[data-account-user="locked-user"]',n=>n.open),true);
 assert.equal(fixture.requests.filter(r=>r.method!=='GET').length,writes,'Expanding groups must be read-only');
 assert.equal(fixture.requests.some(r=>r.path==='/users'&&r.query.includes('passwords=true')),false);
 await page.setViewport({width:1440,height:1000});
}

async function verifyGroupedOverview(page,fixture){
 const active='[data-overview-user="active-user"]';
 assert.equal(await page.$$eval('[data-overview-user]',nodes=>nodes.length),2);
 assert.deepEqual(await page.$$eval('[data-overview-user]',nodes=>nodes.map(n=>n.dataset.overviewUser)),['active-user','external']);
 assert.equal(await page.$$eval('[data-overview-user][open]',nodes=>nodes.length),0);
 assert.match(await page.$eval('[data-overview-owner] .overview-heading',n=>n.textContent),/fixture-owner/);
 assert.equal(await page.$eval('[data-overview-owner] .overview-cards .value',n=>n.textContent),'3');
 assert.equal(await page.$eval(active+' .overview-cards .value',n=>n.textContent),'10');
 assert.equal(await page.$eval('[data-overview-user="external"] .overview-cards .value',n=>n.textContent),'1');
 assert.equal(await page.$eval(active+' .overview-actor-body',n=>n.checkVisibility()),false);
 await page.click(active+' summary');await page.waitForFunction(()=>document.querySelector('[data-overview-user="active-user"] summary').getAttribute('aria-expanded')==='true');
 fixture.overviewRevision=1;await page.evaluate(()=>loadPage(true));
 assert.equal(await page.$eval(active,n=>n.open),true);
 assert.equal(await page.$eval(active+' .overview-cards .value',n=>n.textContent),'11');
 assert.equal(await page.$eval('[data-overview-owner] .overview-cards .value',n=>n.textContent),'3');
 await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('[data-overview-owner]');
 for(const state of [{active:false,locked:false},{active:true,locked:true}]){
  fixture.userAccess={'active-user':state};await page.evaluate(()=>loadPage(true));
  assert.deepEqual(await page.$$eval('[data-overview-user]',nodes=>nodes.map(n=>n.dataset.overviewUser)),['external']);
  assert.equal(await page.$(active),null);assert.equal(await page.$eval('[data-overview-owner] .overview-cards .value',n=>n.textContent),'3');
  assert.equal(await page.$eval('[data-overview-user="external"] .overview-cards .value',n=>n.textContent),'1');
  fixture.userAccess={};await page.evaluate(()=>loadPage(true));
  assert.deepEqual(await page.$$eval('[data-overview-user]',nodes=>nodes.map(n=>n.dataset.overviewUser)),['active-user','external']);
  assert.equal(await page.$eval(active,n=>n.open),true);assert.equal(await page.$eval(active+' .overview-cards .value',n=>n.textContent),'11');
 }
 assert.equal(await page.$eval(active,n=>n.open),true);
 assert.equal(await page.$$eval('[data-overview-user][open]',nodes=>nodes.length),1);
 for(const width of [390,1440]){
  await page.setViewport({width,height:width===390?844:1000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Per-ID overview fits mobile and desktop');
 }
 await page.focus(active+' summary');await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-overview-user="active-user"]').open);
 assert.equal(fixture.requests.some(r=>r.path==='/overview'&&r.query==='?layout=2'),true);
}
async function verifyOwnerLoginActivity(page,fixture,language){
 const writes=fixture.requests.filter(r=>r.method!=='GET').length;
 await page.evaluate(()=>{page='users';sessionStorage.setItem('wa_page',page);navigation();return loadPage();});
 assert.match(await page.$eval('#content thead',n=>n.textContent),language==='en'?/Last sign-in UTC\+8/:/最新登入时间 UTC\+8/);
 assert.doesNotMatch(await page.$eval('#content thead',n=>n.textContent),/Password updated|密码更新时间/);
 assert.equal(await page.$('#show-passwords'),null);assert.equal(await page.$('[data-reveal-password]'),null);
 assert.equal(await page.$eval('tr:has([data-remark="active-user"]) .code',n=>n.textContent),'8.8.8.8');
 await page.click('[data-login-history="active-user"]');await page.waitForSelector('#login-history-refresh');
 assert.deepEqual(await page.$$eval('#modal th',nodes=>nodes.map(n=>n.textContent)),['TIME (UTC+8)','IP','ISP','CITY','COUNTRY','USER AGENT']);
 assert.match(await page.$eval('#modal tbody',n=>n.textContent),/Synthetic <img/);assert.match(await page.$eval('#modal tbody',n=>n.textContent),/<script>/);assert.equal(await page.$('#modal tbody img,#modal tbody script'),null);
 const signInTime=await page.evaluate(v=>new Date(v).toLocaleString(document.documentElement.lang==='en'?'en-GB':'zh-CN',{timeZone:'Asia/Kuala_Lumpur',hourCycle:'h23'}),fixture.loginDates['active-user']);
 assert.equal(await page.$eval('#modal tbody tr td',n=>n.textContent),signInTime);
 for(const width of [390,1440]){await page.setViewport({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Login history fits desktop and mobile');}
 await page.click('#login-history-next');await page.waitForFunction(()=>document.querySelector('#login-history-next')?.disabled);
 assert.equal(await page.$$eval('#modal tbody tr td',nodes=>nodes.slice(1).map(n=>n.textContent).join('')),'—————');
 await page.click('#login-history-prev');await page.waitForFunction(()=>document.querySelector('#login-history-prev')?.disabled);await page.click('#login-history-refresh');await page.waitForSelector('#login-history-refresh');await page.click('#close-modal');
 await page.click('[data-login-history="ui-owner"]');await page.waitForSelector('#login-history-refresh');assert.equal(await page.$('#modal tbody tr'),null);await page.keyboard.press('Escape');
 const active='tr:has([data-remark="active-user"]) .last-login';
 assert.equal(await page.$$eval('.last-login',nodes=>nodes.map(n=>n.dataset.loginRecency).sort().join(',')),'green,orange');
 assert.equal(await page.$eval('.last-login.green',n=>getComputedStyle(n).color),'rgb(103, 216, 177)');
 assert.equal(await page.$eval(active,n=>getComputedStyle(n).color),'rgb(255, 184, 103)');
 const expected=await page.evaluate(value=>new Date(value).toLocaleString(document.documentElement.lang==='en'?'en-GB':'zh-CN',{timeZone:'Asia/Kuala_Lumpur',hourCycle:'h23'}),fixture.loginDates['active-user']);
 assert.equal(await page.$eval(active,n=>n.textContent),expected);
 assert.match(await page.$eval(active,n=>n.getAttribute('aria-label')),language==='en'?/at least 1 day/:/满 1 天/);
 await page.select('#user-status-filter','locked');
 assert.equal(await page.$eval('.last-login',n=>n.dataset.loginRecency),'red');assert.equal(await page.$eval('.last-login',n=>getComputedStyle(n).color),'rgb(255, 142, 150)');
 await page.select('#user-status-filter','inactive');
 assert.equal(await page.$eval('.last-login',n=>n.dataset.loginRecency),'neutral');
 assert.equal(await page.$eval('.last-login',n=>n.textContent),language==='en'?'No sign-in record':'暂无登入记录');
 assert.equal(await page.$eval('.last-login',n=>getComputedStyle(n).color),'rgb(181, 188, 199)');
 await page.select('#user-status-filter','active');
 const boundaries=await page.evaluate(()=>{const now=Date.parse('2030-01-08T00:00:00Z');return [0,86400000-1,86400000,7*86400000-1,7*86400000].map(age=>loginRecency(new Date(now-age).toISOString(),now)).concat([loginRecency(null,now),loginRecency('invalid',now)]);});
 assert.deepEqual(boundaries,['green','green','orange','orange','red','neutral','neutral']);
 // An unchanged response still ages across 24 hours through the real quiet poll.
 const original=fixture.loginDates['active-user'];fixture.loginDates['active-user']=new Date(Date.now()-86400000+3000).toISOString();
 await page.evaluate(()=>{document.activeElement?.blur();return loadPage();});assert.equal(await page.$eval(active,n=>n.dataset.loginRecency),'green');
 await page.waitForFunction(selector=>document.querySelector(selector)?.dataset.loginRecency==='orange',{timeout:15000},active);
 fixture.loginDates['active-user']=original;await page.evaluate(()=>loadPage());
 await page.setViewport({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(await page.$eval(active,n=>n.dataset.loginRecency),'orange');
 await page.setViewport({width:1440,height:1000});
 assert.equal(fixture.requests.filter(r=>r.method!=='GET').length,writes);assert.equal(fixture.requests.some(r=>r.path==='/users/password-access'||r.query.includes('passwords=true')),false);
 await page.click('#nav [data-page=shared]');await waitReady(page);
 console.log('Owner login history and recency PASS: '+language+' / real timestamps, green/orange/red/no-history, exact 24h/7d boundaries, automatic aging and mobile');
}

async function verifyOwnerBilling(page,language){
 await page.evaluate(()=>{page='billing';sessionStorage.setItem('wa_page',page);navigation();return loadPage();});
 assert.match(await page.$eval('.credit-ledger h3',n=>n.textContent),language==='en'?/Credit ledger \(latest 100\)/:/余额流水（最近 100 条）/);
 assert.equal(await page.$$eval('.credit-ledger tbody tr',nodes=>nodes.length),1);
 assert.match(await page.$eval('.credit-ledger',n=>n.textContent),/RM 1000\.0000/);
 assert.equal(await page.$eval('.credit-ledger th:last-child',n=>n.textContent),language==='en'?'Remark':'备注');
 assert.equal(await page.$eval('.credit-ledger .ledger-note',n=>n.textContent),ledgerNote);
 assert.equal(await page.$eval('.credit-ledger .ledger-note',n=>getComputedStyle(n).whiteSpace),'pre-wrap');
 assert.equal(await page.$('.credit-ledger img'),null);
 assert.equal(await page.$('[data-resolve]'),null);assert.equal(await page.$('.automatic-refunds img'),null);
 assert.match(await page.$eval('.automatic-refunds',n=>n.textContent),language==='en'?/Automatically refunded/:/已自动退款/);
 assert.match(await page.$eval('.automatic-refunds',n=>n.textContent),/RM 0\.1061/);
 assert.match(await page.$eval('.automatic-refunds',n=>n.textContent),/10:54:43/);
 assert.equal(await page.$eval('.automatic-refunds',n=>!!(n.compareDocumentPosition(document.querySelector('.credit-ledger'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
 await page.click('#refund-next');await page.waitForFunction(()=>!loading&&billingRefundBefore==='800');assert.equal(await page.$eval('#refund-prev',n=>n.disabled),false);
 await page.click('#refund-prev');await page.waitForFunction(()=>!loading&&billingRefundBefore===null);assert.equal(await page.$eval('#refund-prev',n=>n.disabled),true);
 await page.setViewport({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 assert.equal(await page.$eval('.credit-ledger .ledger-note',n=>n.textContent),ledgerNote);await page.setViewport({width:1440,height:1000});
 console.log('Owner ledger remark PASS: '+language+' / escaped multiline note, unchanged balance and mobile layout');
 await page.click('#nav [data-page=shared]');await waitReady(page);
}

async function verifyCapacity(page,fixture,language){
 assert.equal(await page.$('[data-capacity-scope=personal]'),null);assert.ok(await page.$('[data-capacity-scope=shared]'));
 assert.equal(await page.$('[data-hourly-checks]'),null);
 assert.equal(fixture.requests.some(r=>r.path==='/shared/hourly'),false);
 const overviewStart=fixture.requests.length;
 await page.evaluate(()=>{page='overview';sessionStorage.setItem('wa_page',page);navigation();return loadPage();});
 assert.ok(await page.$('.overview-chart'));
 assert.equal(await page.$('[data-capacity]'),null);assert.equal(await page.$('[data-hourly-checks]'),null);
 assert.equal(fixture.requests.slice(overviewStart).some(r=>['/health','/shared/hourly'].includes(r.path)),false);
 if(await page.$eval('#nav [data-nav-toggle=users]',n=>n.getAttribute('aria-expanded'))==='false')await page.click('#nav [data-nav-toggle=users]');
 const systemStart=fixture.requests.length;
 await page.click('#nav [data-page=system]');await page.waitForSelector('[data-hourly-checks]');
 assert.ok(await page.$('[data-hourly-checks]'));assert.equal(await page.$('.overview-chart'),null);
 assert.equal(await page.$('[data-capacity]'),null);
 assert.equal(fixture.requests.slice(systemStart).some(r=>r.path==='/health'),false);
 assert.equal(await page.$eval('#page-title',n=>n.textContent),language==='en'?'Service status':'服务状态');
 assert.equal(await page.$$eval('[data-account-user],[data-view]',nodes=>nodes.length),0);
 const accountsStart=fixture.requests.length;
 await page.click('#nav [data-page=accounts]');await page.waitForSelector('[data-capacity-scope=personal]');
 assert.equal(await page.$('[data-hourly-checks]'),null);
 assert.equal(await page.$eval('#content',n=>n.firstElementChild.matches('[data-capacity-scope=personal]')),true);
 assert.ok(await page.$('[data-account-user=owner]'));assert.ok(await page.$('#add-account'));
 assert.equal(fixture.requests.slice(accountsStart).some(r=>r.path==='/shared/hourly'),false);
 async function summary(available,used,total,unavailable,rows){
  for(const [key,value] of Object.entries({available,used,total,unavailable}))assert.equal(await page.$eval('[data-capacity-'+key+']',n=>Number(n.textContent.replaceAll(',',''))),value);
  assert.equal(await page.$$eval('[data-capacity] tbody tr',n=>n.length),rows);
  assert.match(await page.$eval('[data-capacity] h2',n=>n.textContent),language==='en'?/Available QR slots/:/剩余可扫码/);
 }
 await summary(7,3,10,0,1);
 assert.equal(await page.$eval('[data-capacity]',n=>n.open),false);
 assert.equal(await page.$eval('[data-capacity] .table-wrap',n=>n.checkVisibility()),false);
 await page.click('[data-capacity]>summary');await page.waitForFunction(()=>document.querySelector('[data-capacity] summary').getAttribute('aria-expanded')==='true');
 const now=Date.now();fixture.capacityRows=Array.from({length:20},(_,i)=>{const max=i===0?10:i>=6&&i<=15?7:5;return{worker_group:i?'fixture-group-'+(i+1):'fixture-group',max_accounts:max,accounts_running:0,assigned_accounts:0,slots_used:0,slots_available:max,slots_unavailable:0,can_start_more:true,heartbeat_at:new Date(now).toISOString()};});
 Object.assign(fixture.capacityRows[0],{accounts_running:8,assigned_accounts:8,slots_used:8,slots_available:0,slots_unavailable:2,can_start_more:false});
 Object.assign(fixture.capacityRows[1],{accounts_running:5,assigned_accounts:5,slots_used:5,slots_available:0});
 Object.assign(fixture.capacityRows[2],{accounts_running:1,assigned_accounts:2,slots_used:2,slots_available:3});
 fixture.capacityRows[3].heartbeat_at=new Date(now-120000).toISOString();
 await page.evaluate(()=>loadPage());await summary(103,15,125,7,20);
 assert.equal(await page.$eval('[data-capacity]',n=>n.open),true);
 for(const width of [390,1440]){
  await page.setViewport({width,height:width===390?844:1000});
  assert.equal(await page.$eval('[data-capacity-available]',n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }
 Object.assign(fixture.capacityRows[2],{assigned_accounts:4,slots_used:4,slots_available:1});
 await page.evaluate(()=>loadPage(true));await summary(101,17,125,7,20);
 await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('[data-capacity]');assert.equal(await page.$eval('[data-capacity]',n=>n.open),true);
 await page.click('[data-capacity]>summary');await page.waitForFunction(()=>document.querySelector('[data-capacity] summary').getAttribute('aria-expanded')==='false');
 await page.evaluate(()=>loadPage(true));assert.equal(await page.$eval('[data-capacity]',n=>n.open),false);
 fixture.capacityFailure=true;await page.evaluate(()=>loadPage());
 assert.equal(await page.$('.overview-chart'),null);assert.equal(await page.$('[data-hourly-checks]'),null);assert.equal(await page.$('[data-capacity-total]'),null);
 assert.ok(await page.$('#add-account'));assert.ok(await page.$('[data-account-user=owner] [data-view]'));
 assert.match(await page.$eval('#content',n=>n.textContent),language==='en'?/Cannot load this section/:/暂时无法加载/);
 fixture.capacityFailure=false;await page.evaluate(()=>loadPage());await summary(101,17,125,7,20);
 fixture.capacityRows=null;await page.evaluate(()=>loadPage());await summary(7,3,10,0,1);
 // Preserve an Owner's expansion saved before the panel moved from Service status.
 await page.evaluate(()=>{sessionStorage.setItem('wa_dashboard_open',JSON.stringify({user_id:me.id,role:me.role,open:['capacity:system']}));});
 await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('[data-capacity-scope=personal]');
 assert.equal(await page.$eval('[data-capacity]',n=>n.open),true);
 await page.click('[data-capacity]>summary');await page.waitForFunction(()=>!document.querySelector('[data-capacity]').open);
 await page.click('#nav [data-page=system]');await page.waitForSelector('[data-hourly-checks]');assert.equal(await page.$('[data-capacity]'),null);
 await page.click('#nav [data-page=accounts]');await page.waitForSelector('[data-capacity-scope=personal]');assert.equal(await page.$eval('[data-capacity]',n=>n.open),false);
 const returnStart=fixture.requests.length;
 await page.click('#nav [data-page=overview]');await page.waitForSelector('[data-overview-owner]');
 assert.equal(await page.$('[data-capacity]'),null);assert.equal(await page.$('[data-hourly-checks]'),null);
 assert.equal(fixture.requests.slice(returnStart).some(r=>['/health','/shared/hourly'].includes(r.path)),false);
 await page.click('#nav [data-page=shared]');await waitReady(page);
 console.log('Capacity placement PASS: '+language+' / Owner accounts first, hourly-only Service status, independent saved state, live arithmetic and isolated errors');
}

async function verifySharedQr(page,fixture,language){
 const start=fixture.requests.length;
 fixture.sharedCapacityRows=Array.from({length:6},(_,i)=>({worker_group:'fixture-shared-'+i,accounts_running:0,max_accounts:5,assigned_accounts:0,slots_used:0,slots_available:5,can_start_more:true,heartbeat_at:new Date().toISOString()}));
 await page.evaluate(()=>loadPage());await page.waitForSelector('[data-capacity-scope=shared]');
 assert.equal(await page.$eval('[data-capacity-total]',n=>n.textContent),'30');
 assert.equal(await page.$eval('[data-capacity-available]',n=>n.textContent),'30');
 assert.equal(await page.$eval('[data-capacity-scope=shared]',n=>n.open),false);
 await page.click('[data-capacity-scope=shared]>summary');await page.waitForFunction(()=>document.querySelector('[data-capacity-scope=shared] summary').getAttribute('aria-expanded')==='true');
 assert.deepEqual(await page.$$eval('[data-capacity-scope=shared] tbody tr td:first-child',nodes=>nodes.map(n=>n.textContent)),Array.from({length:6},(_,i)=>'Share WhatsApp '+(i+1)));
 await page.click('#shared-add');await page.waitForSelector('#shared-account-form');
 assert.equal(await page.$('#shared-account-form [name=phones]'),null);assert.equal(await page.$('#shared-account-form [name=phone]'),null);
 assert.match(await page.$eval('#shared-account-form',n=>n.textContent),language==='en'?/Linked devices/:/关联设备/);
 assert.equal(await page.$$eval('#shared-account-form select option',nodes=>nodes.length),7);
 fixture.scanFailNext=true;
 await page.$eval('#shared-account-form',f=>{f.elements.namedItem('label').value='Synthetic shared QR';f.requestSubmit();});
 await page.waitForFunction(()=>!document.querySelector('#shared-account-form').dataset.busy);
 assert.equal(await page.$eval('#modal',n=>n.open),true);assert.equal(await page.$eval('#shared-account-form [name=label]',n=>n.value),'Synthetic shared QR');
 await page.$eval('#shared-account-form',f=>f.requestSubmit());await page.waitForFunction(()=>!document.querySelector('#modal').open);await waitReady(page);
 const requests=fixture.requests.filter(r=>r.path==='/shared/accounts/scan');assert.equal(requests.length,2);assert.deepEqual(requests[0].body,requests[1].body);assert.match(requests[0].body.request_id,/^[a-f\d-]{36}$/);assert.equal(requests[0].body.label,'Synthetic shared QR');assert.equal(requests[0].csrf,'fake-ui-csrf');
 await page.evaluate(()=>loadPage(true));assert.equal(await page.$eval('[data-capacity-scope=shared]',n=>n.open),true);
 await page.reload({waitUntil:'networkidle0'});await waitReady(page);assert.equal(await page.$eval('[data-capacity-scope=shared]',n=>n.open),true);
 fixture.sharedCapacityRows=[];await page.evaluate(()=>loadPage());
 assert.equal(await page.$eval('[data-capacity-total]',n=>n.textContent),'0');assert.equal(await page.$eval('#shared-add',n=>n.disabled),false);
 await page.click('#shared-add');await page.waitForSelector('#shared-account-form');
 assert.equal(await page.$eval('#shared-account-form button[type=submit]',n=>n.disabled),true);
 assert.match(await page.$eval('[data-shared-add-capacity]',n=>n.textContent),language==='en'?/not configured/:/尚未配置/);
 for(const width of [390,1440]){await page.setViewport({width,height:width===390?844:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.click('#close-modal');
 fixture.sharedCapacityRows=[{worker_group:'fixture-shared-0',max_accounts:5,slots_used:0,slots_available:5,can_start_more:false,heartbeat_at:new Date().toISOString()}];await page.evaluate(()=>loadPage());
 assert.equal(await page.$eval('[data-capacity-available]',n=>n.textContent),'0');await page.click('#shared-add');await page.waitForSelector('#shared-account-form');assert.equal(await page.$eval('#shared-account-form button[type=submit]',n=>n.disabled),true);await page.click('#close-modal');
 assert.equal(fixture.requests.slice(start).some(r=>r.path==='/health'),false);
 fixture.sharedCapacityRows=null;await page.evaluate(()=>loadPage());
}
async function verifyNoticeEditor(page,fixture,language){
 const key=language==='en'?'en':'zh',field='#notice-form [name=content_'+key+']',mark='[data-notice-highlight="content_'+key+'"]',clear='[data-notice-clear="content_'+key+'"]',marks='#notice-preview .notice-copy:first-child .notice-highlight';
 const select=async text=>{await page.$eval(field,(n,text)=>{const at=n.value.indexOf(text);if(at<0)throw Error('Fixture selection missing');n.focus();n.setSelectionRange(at,at+text.length);},text);};
 const original=await page.$eval(field,n=>n.value);
 await select('0.57');await page.click(mark);assert.equal(await page.$$(marks).then(v=>v.length),0,'Selecting marked text toggles it off');
 await select('0.57');await page.click(mark);assert.equal(await page.$eval(marks,n=>n.textContent),'0.57');
 const literal=language==='en'?'<script>alert(1)</script>':'<img src=x onerror=alert(1)>';
 await select(literal);await page.click(mark);
 assert.deepEqual(await page.$$eval(marks,nodes=>nodes.map(n=>n.textContent)),[literal,'0.57']);
 assert.equal(await page.$eval(field,n=>n.value),original,'Formatting does not insert markup into the editor text');
 assert.equal(await page.$$eval('#notice-preview img,#notice-preview script',nodes=>nodes.length),0);
 await page.click(clear);assert.equal(await page.$$(marks).then(v=>v.length),0);
 await select('0.57');await page.click(mark);
 await page.$eval(field,n=>{n.focus();n.setSelectionRange(0,0);});await page.type(field,'Draft ');
 const draft=await page.$eval(field,n=>n.value);assert.ok(draft.startsWith('Draft '));assert.equal(await page.$eval(marks,n=>n.textContent),'0.57','Typing before emphasis keeps the same selected words');
 await page.evaluate(()=>loadPage(true));assert.equal(await page.$eval(field,n=>n.value),draft);assert.equal(await page.$eval(marks,n=>n.textContent),'0.57');
 fixture.noticeSaveFailure=true;await page.click('#notice-form button[type=submit]');
 await page.waitForFunction(()=>!document.querySelector('#notice-form').dataset.busy&&document.querySelector('#toast').textContent.includes('Synthetic notice unavailable'));
 assert.equal(await page.$eval('#notice-form',n=>n.dataset.dirty),'1');assert.equal(await page.$eval(field,n=>n.value),draft);assert.equal(await page.$eval(marks,n=>n.textContent),'0.57');
 await page.evaluate(()=>loadPage(true));assert.equal(await page.$eval(marks,n=>n.textContent),'0.57');
 await page.click('#notice-form button[type=submit]');await page.waitForFunction(()=>!document.querySelector('#notice-form').dataset.dirty&&!document.querySelector('#notice-form').dataset.busy);
 const saved=fixture.requests.findLast(r=>r.path==='/notice'&&r.method==='PUT');assert.equal(saved.csrf,'fake-ui-csrf');assert.equal(saved.body['content_'+key],draft);assert.deepEqual(saved.body['highlights_'+key],[[draft.indexOf('0.57'),draft.indexOf('0.57')+4]]);
 await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('#notice-form');
 assert.equal(await page.$eval(field,n=>n.value),draft);assert.equal(await page.$eval(marks,n=>n.textContent),'0.57','Saved emphasis survives an actual page reload');
 await uiScreenshot(page,'notice-editor-saved','owner',language);
 let release;fixture.noticeSaveGate=new Promise(resolve=>{release=resolve;});
 const received=page.waitForResponse(r=>r.url().endsWith('/api/notice')&&r.request().method()==='PUT');
 try{
  await page.click('#notice-form button[type=submit]');await page.waitForFunction(()=>document.querySelector('#notice-form').dataset.busy==='1');
  await page.$eval(field,n=>n.setSelectionRange(0,1));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.$$eval('#notice-form input,#notice-form textarea,#notice-form button',nodes=>nodes.every(n=>n.disabled)),true);
  await page.click('#nav [data-page=shared]');await waitReady(page);
 }finally{release();fixture.noticeSaveGate=null;}
 await (await received).text();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.$('#notice-form'),null,'A late save response cannot replace the newly selected page');
 await page.click('#nav [data-page=notices]');await page.waitForSelector('#notice-form');
 console.log('Notice editor PASS: owner / '+language+' / native selection, toggle/clear, literal HTML, edited offsets, polling, failed save/retry, real reload and late-response navigation guard');
}
async function verifyNoticeSequence(page,host){
 await page.waitForFunction(selector=>{const v=document.querySelector(selector+' .notice-viewport');return Math.abs(parseFloat(v.style.getPropertyValue('--notice-width'))-v.clientWidth)<1;},{},host);
 await page.hover(host+' .notice-viewport');
 const cycle=await page.$eval(host,async host=>{
  const viewport=host.querySelector('.notice-viewport'),track=host.querySelector('.notice-track'),copy=track.firstElementChild,animation=track.getAnimations()[0];
  await animation.ready;
  const originalTime=animation.currentTime,range=document.createRange();range.selectNodeContents(copy);
  const duration=Number(animation.effect.getTiming().duration),bounds=viewport.getBoundingClientRect(),contentWidth=range.getBoundingClientRect().width,travel=viewport.clientWidth+copy.getBoundingClientRect().width,gap=parseFloat(getComputedStyle(copy).paddingInlineEnd);
  const at=time=>{animation.currentTime=time;const r=range.getBoundingClientRect();return {left:r.left,right:r.right};};
  try{return {copies:track.children.length,state:animation.playState,left:bounds.left,right:bounds.right,gap,duration,start:at(0),tail:at(duration*(viewport.clientWidth+contentWidth-8)/travel),blank:at(duration*(travel-gap/2)/travel),next:at(duration+duration*8/travel)};}
  finally{animation.currentTime=originalTime;range.detach();}
 });
 await page.mouse.move(0,0);
 assert.equal(cycle.copies,1,'Render the notice once, without a following visual duplicate');
 assert.equal(cycle.state,'paused','Sample the real animation while pointer hover holds it in place');
 assert.ok(cycle.gap>=48&&cycle.duration>0,'Each complete pass retains a readable blank interval');
 assert.ok(cycle.start.left>=cycle.right-1,'A pass starts outside the right edge');
 assert.ok(cycle.tail.right>cycle.left+4&&cycle.tail.right<cycle.left+12,'The final words remain visible until the pass actually leaves');
 assert.ok(cycle.blank.right<cycle.left-1,'The entire notice is outside the viewport before the next pass');
 assert.ok(cycle.next.left>cycle.right-12&&cycle.next.left<cycle.right-4,'Only after the blank interval does the next pass enter from the right');
}
async function verifyNoticeMarquee(page,fixture,role,language){
 const start=fixture.requests.length,zh='系统更新通知 📢 <img src=x onerror=alert(1)>\n请查看使用教学。 0.57',en='Workspace update 📢 <script>alert(1)</script>\nPlease read the usage guide. 0.57';
 fixture.notice={enabled:true,content_zh:zh,content_en:en,highlights_zh:[[zh.indexOf('0.57'),zh.indexOf('0.57')+4]],highlights_en:[[en.indexOf('0.57'),en.indexOf('0.57')+4]],updated_at:new Date().toISOString()};
 let host='#workspace-notice';
 if(role==='owner'){
  await page.click('#nav [data-page=notices]');await page.waitForSelector('#notice-preview .notice-track');host='#notice-preview';
  assert.equal(await page.$eval('#workspace-notice',n=>n.hidden),true,'Owner retains the management preview without a duplicate USER banner');
  await page.$eval('#notice-form',f=>{f.elements.namedItem('content_zh').value+=' Saved';f.elements.namedItem('content_en').value+=' Saved';f.requestSubmit();});
  await page.waitForFunction(()=>!document.querySelector('#notice-form').dataset.busy&&document.querySelector('#notice-preview .notice-copy')?.textContent.endsWith(' Saved'));
  const saved=fixture.requests.findLast(r=>r.path==='/notice'&&r.method==='PUT');assert.equal(saved.csrf,'fake-ui-csrf');assert.equal(saved.body.enabled,true);
 }else{
  await page.waitForFunction(()=>document.querySelector('#workspace-notice .notice-track')&&!document.querySelector('#workspace-notice').hidden);
  assert.equal(await page.$('#notice-form'),null);
 }
 const expected=(language==='en'?en:zh)+(role==='owner'?' Saved':'');
 assert.equal(await page.$eval(host+' .notice-copy',n=>n.textContent),expected);
 assert.equal(await page.$eval(host+' [role=status]',n=>n.textContent),expected,'Assistive text contains the original notice once');
 assert.equal(await page.$$eval(host+' img,'+host+' script',n=>n.length),0,'Notice text is never interpreted as HTML');
 assert.equal(await page.$eval(host+' .notice-track',n=>n.getAttribute('aria-hidden')),'true');
 assert.equal(await page.$eval(host+' .notice-copy:first-child .notice-highlight',n=>n.textContent),'0.57','Locale-specific saved ranges emphasize only the selected words');
 await page.mouse.move(0,0);
 const moving=await page.$eval(host+' .notice-track',n=>getComputedStyle(n).transform);
 await page.waitForFunction((selector,before)=>{const n=document.querySelector(selector);return getComputedStyle(n).animationName==='notice-scroll'&&getComputedStyle(n).transform!==before;},{},host+' .notice-track',moving);
 await page.evaluate(selector=>{window.fixtureNoticeTrack=document.querySelector(selector);},host+' .notice-track');
 await page.evaluate(()=>loadPage(true));
 assert.equal(await page.evaluate(selector=>window.fixtureNoticeTrack===document.querySelector(selector),host+' .notice-track'),true,'Unchanged background polling preserves the scrolling element and reading state');
 assert.equal(await page.$(host+' button'),null,'The pause/resume control is removed from USER notices and Owner previews');
 await verifyNoticeSequence(page,host);
 const track=host+' .notice-track',viewport=host+' .notice-viewport';
 const snapshot=()=>page.$eval(track,async n=>{
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const style=getComputedStyle(n);return {time:n.getAnimations()[0]?.currentTime,transform:style.transform,state:style.animationPlayState,name:style.animationName,whiteSpace:getComputedStyle(n.firstElementChild).whiteSpace};
 });
 await page.$eval(track,n=>{window.fixtureNoticeAnimation=n.getAnimations()[0];window.fixtureNoticeAnimation.currentTime=4000;});
 await page.hover(host+' .notice-viewport');
 const held=await snapshot();assert.equal(held.state,'paused');assert.ok(held.time>=4000,'Exercise a scrolled position away from the start');
 await page.click(viewport);
 const clicked=await snapshot();
 assert.equal(clicked.name,'notice-scroll','Clicking keeps the existing scrolling animation');
 assert.equal(clicked.whiteSpace,'nowrap','Clicking never switches to full-text layout');
 assert.equal(clicked.transform,held.transform,'A real mouse click does not jump back to the start');
 assert.ok(Math.abs(clicked.time-held.time)<1,'Hover/click freezes the same animation time');
 assert.equal(await page.$eval(track,n=>n.getAnimations()[0]===window.fixtureNoticeAnimation),true,'Clicking must not replace the animation');
 await page.evaluate(()=>loadPage(true));
 assert.equal(await page.$eval(track,n=>n.getAnimations()[0]===window.fixtureNoticeAnimation),true,'Quiet polling also preserves the paused animation');
 await page.mouse.move(0,0);
 await page.waitForFunction((selector,time)=>document.querySelector(selector).getAnimations()[0]?.currentTime>time+20,{},track,held.time);
 await page.$eval(viewport,n=>{const nodes=[...document.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(e=>e.tabIndex>=0&&!e.disabled&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[inert]'));const at=nodes.indexOf(n);if(at<1)throw Error('No preceding keyboard control');nodes[at-1].focus({preventScroll:true});});
 await page.keyboard.press('Tab');
 await page.waitForFunction(selector=>document.activeElement===document.querySelector(selector)&&document.activeElement.matches(':focus-visible'),{},viewport);
 const keyboardHeld=await snapshot();assert.equal(keyboardHeld.state,'paused');assert.equal(keyboardHeld.name,'notice-scroll');assert.equal(keyboardHeld.whiteSpace,'nowrap');
 assert.equal(await page.$eval(track,n=>n.getAnimations()[0]===window.fixtureNoticeAnimation),true,'Keyboard focus pauses in place without restarting');
 assert.ok(Math.abs((await snapshot()).time-keyboardHeld.time)<1);
 await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');
 await page.waitForFunction((selector,time)=>document.querySelector(selector).getAnimations()[0]?.currentTime>time+20,{},track,keyboardHeld.time);
 const touch=await page.createCDPSession();
 try{
  await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  await page.$eval(viewport,n=>n.scrollIntoView({block:'center'}));
  const box=await (await page.$(viewport)).boundingBox();
  for(const type of ['touchEnd','touchCancel']){
   const before=await snapshot();
   await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2,id:1,radiusX:2,radiusY:2,force:1}]});
   const touched=await snapshot();assert.equal(touched.state,'paused','Real touch contact pauses in place');assert.equal(touched.name,'notice-scroll');assert.ok(touched.time>=before.time,'Touch never resets elapsed animation time');
   assert.ok(Math.abs((await snapshot()).time-touched.time)<1,'Holding a finger freezes motion');
   assert.equal(await page.$eval(track,n=>n.getAnimations()[0]===window.fixtureNoticeAnimation),true);
   await touch.send('Input.dispatchTouchEvent',{type,touchPoints:[]});
   await page.waitForFunction((selector,time)=>{const n=document.querySelector(selector);return getComputedStyle(n).animationPlayState==='running'&&n.getAnimations()[0]?.currentTime>time+20;},{},track,touched.time);
   assert.equal(await page.$eval(track,n=>n.getAnimations()[0]===window.fixtureNoticeAnimation),true,'Touch release/cancel resumes the same animation without sticky hover');
  }
 }finally{await touch.send('Emulation.setTouchEmulationEnabled',{enabled:false});await touch.detach();}
 for(const theme of ['dark','light']){
  if(await page.$eval('html',n=>n.dataset.theme)!==theme)await page.click('#theme-toggle');
  const colors=await page.$eval(host,n=>({background:getComputedStyle(n).backgroundColor,text:getComputedStyle(n.querySelector('.notice-copy')).color,label:getComputedStyle(n.querySelector('.notice-label')).color,highlight:getComputedStyle(n.querySelector('.notice-highlight')).color}));
  const lum=value=>value.match(/[\d.]+/g).slice(0,3).map(Number).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
  for(const color of [colors.text,colors.label,colors.highlight]){const a=lum(color),b=lum(colors.background);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,'Notice and emphasis stay readable in '+theme+' mode');}
  await uiScreenshot(page,'notice-'+theme,role,language);
 }
 if(await page.$eval('html',n=>n.dataset.theme)!=='dark')await page.click('#theme-toggle');
 for(const width of [320,390,1440]){
  await page.setViewport({width,height:1000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Scrolling text stays inside the mobile/desktop page');
  assert.ok(await page.$eval(host+' .notice-viewport',n=>n.clientWidth>30));
  await verifyNoticeSequence(page,host);
  await uiScreenshot(page,'notice-'+width,role,language);
 }
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
 assert.equal(await page.$eval(host+' .notice-track',n=>getComputedStyle(n).animationName),'none');
 assert.equal(await page.$(host+' button'),null);
 assert.equal(await page.$eval(host+' .notice-copy',n=>getComputedStyle(n).whiteSpace),'pre-wrap');
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
 if(role==='user'){
  fixture.notice={enabled:true,content_zh:'备用中文 0.57',content_en:'',highlights_zh:[[5,9]],highlights_en:[],updated_at:new Date().toISOString()};
  await page.waitForFunction(()=>document.querySelector('#workspace-notice .notice-copy')?.textContent==='备用中文 0.57');
  assert.equal(await page.$eval(host+' .notice-highlight',n=>n.textContent),'0.57','Empty English falls back to both Chinese text and Chinese emphasis');
  await verifyNoticeSequence(page,host);
  fixture.notice={enabled:true,content_zh:'长公告 '+('通知😀 '.repeat(1100)),content_en:'',updated_at:new Date().toISOString()};
  await page.waitForFunction(text=>document.querySelector('#workspace-notice .notice-copy')?.textContent===text,{},fixture.notice.content_zh);
  assert.equal(await page.$eval(host+' .notice-copy',n=>n.textContent),fixture.notice.content_zh,'English falls back to the existing Chinese notice');
  await page.setViewport({width:320,height:900});await verifyNoticeSequence(page,host);await page.focus(host+' .notice-viewport');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Long notices stay clipped to the viewport without page overflow');
  await page.click('#nav [data-page=overview]');await page.waitForFunction(()=>!loading&&document.querySelector('#page-title').textContent!=='Shared WhatsApp');
  assert.equal(await page.$eval(host+' .notice-copy',n=>n.textContent),fixture.notice.content_zh,'Notice remains above other USER pages');
  fixture.notice={...fixture.notice,enabled:false};
  await page.waitForFunction(()=>document.querySelector('#workspace-notice').hidden&&document.querySelector('#workspace-notice').childElementCount===0);
  assert.equal(fixture.requests.slice(start).some(r=>r.method!=='GET'),false,'Viewing, hovering, focusing and resizing notices never write to the server');
 }else{
  await verifyNoticeEditor(page,fixture,language);
  await page.$eval('#notice-form',f=>{const n=f.elements.namedItem('content_zh');n.value='Unsaved Owner draft';n.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.evaluate(()=>loadPage(true));assert.equal(await page.$eval('#notice-form [name=content_zh]',n=>n.value),'Unsaved Owner draft','Quiet polling preserves unsaved Owner edits');
 }
 console.log('Notice motion PASS: '+role+' / '+language+' / one complete pass then a blank interval, no duplicate; actual click keeps position; hover, keyboard and real touch hold/end/cancel resume the same animation; both themes and mobile');
 fixture.notice={enabled:false};await page.setViewport({width:1440,height:1000});await page.click('#nav [data-page=shared]');await waitReady(page);
}
async function runCase(browser,base,role,language){
 current={role,language,enabled:true,available:2,requests:[],sends:[],failNext:false};
 current.loginDates={'ui-owner':new Date(Date.now()-600000).toISOString(),'active-user':new Date(Date.now()-2*86400000).toISOString(),'locked-user':new Date(Date.now()-8*86400000).toISOString()};
 const fixture=current,context=await browser.createBrowserContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:1440,height:1000});
 await page.evaluateOnNewDocument(lang=>{
  if(!localStorage.getItem('wa_language'))localStorage.setItem('wa_language',lang);if(!sessionStorage.getItem('wa_page'))sessionStorage.setItem('wa_page','shared');
  window.fixtureBootFrames=[];
  requestAnimationFrame(function sample(){
   const visible=selector=>{const n=document.querySelector(selector);return !!n&&!n.hidden&&n.getClientRects().length>0&&getComputedStyle(n).display!=='none';};
   window.fixtureBootFrames.push({loading:visible('#session-loading'),login:visible('#login'),card:visible('#session-loading .login-card'),dialog:!!document.querySelector('dialog[open]'),toast:visible('#toast')});
   if(window.fixtureBootFrames.length<240)requestAnimationFrame(sample);
  });
  window.open=(...args)=>{window.fixturePopup=args;return null;};
 },language);
 await page.goto(base,{waitUntil:'networkidle0'});await waitReady(page);
 assert.equal(await page.$eval('#login',n=>n.hidden),true);
 assert.equal(await page.$eval('html',n=>n.lang),language==='en'?'en':'zh-CN');
 assert.equal(await page.$eval('#page-title',n=>n.textContent),language==='en'?'Shared WhatsApp':'共享 WhatsApp');
 assert.equal(await page.$$eval('#nav .nav-entry',nodes=>nodes.every(n=>n.querySelectorAll('svg.nav-icon[aria-hidden=true][focusable=false]').length===1)),true);
 assert.equal(await page.$eval('#nav [data-page=overview] .nav-icon',n=>getComputedStyle(n).width),'18px');
 assert.equal(await page.$eval('#content',n=>n.querySelectorAll('script,img[onerror]').length),0);
 await verifySessionRefresh(page,fixture,role,language);
 await verifyWorkspaceHeader(page,fixture,role,language);
 await verifySidebar(page,fixture,role,language);
 await verifyNoticeMarquee(page,fixture,role,language);
 if(role==='user'){
  assert.equal(await page.$('#shared-add'),null);assert.equal(await page.$('#shared-settings'),null);
  assert.equal(await page.$('[data-shared-login]'),null);
  assert.equal(await page.$('[data-capacity]'),null);
  assert.equal(await page.$('#nav [data-page=users]'),null);
  assert.equal(await page.$('.last-login'),null);assert.equal(fixture.requests.some(r=>r.path==='/users'),false);
  assert.equal(fixture.requests.some(r=>['/shared/accounts','/shared/hourly'].includes(r.path)),false);
  assert.doesNotMatch(await page.$eval('#content',n=>n.textContent),/10000000|可用余额|Available credit|Available balance/);
  assert.equal(await page.$$eval('.shared-cards .card',n=>n.length),0);
  await page.click('#nav [data-page=billing]');
  await page.waitForFunction(()=>document.querySelector('#content').textContent.includes('10000000'));
  assert.doesNotMatch(await page.$eval('#content',n=>n.textContent),/Credit ledger|余额流水/);
  await verifyUserBilling(page,fixture,language);
  await page.click('#nav [data-page=shared]');await waitReady(page);
  assert.doesNotMatch(await page.$eval('#content',n=>n.textContent),/Current rate per message|当前每条价格/);
 }else{
  await verifyCapacity(page,fixture,language);
  await verifyOwnerBilling(page,language);
  await verifyOwnerLoginActivity(page,fixture,language);
  await verifySharedQr(page,fixture,language);
  assert.equal(await page.$eval('[data-shared-login]',n=>n.closest('tr').querySelector('strong').textContent),'<img src=x onerror=alert(1)>');
  await page.click('[data-shared-login]');
  assert.deepEqual(await page.evaluate(()=>window.fixturePopup),['/viewer.html?id='+accountId+'&mode=operate','_blank','noopener']);
  await page.click('#shared-settings');
  await page.waitForFunction(()=>document.querySelector('#modal').open);
  assert.equal(await page.$$eval('#modal input[name^="hour_"]',n=>n.length),24);
  assert.match(await page.$eval('#modal',n=>n.textContent),language==='en'?/Malaysia-time hour/:/马来西亚时间/);
  await page.evaluate(()=>{
   document.querySelector('#modal input[name=price]').value='0.2';
   document.querySelector('#modal input[name=hour_8]').value='0.3';
   document.querySelector('#modal form').requestSubmit();
  });
  await page.waitForFunction(()=>!document.querySelector('#modal').open);await waitReady(page);
  const update=fixture.requests.findLast(r=>r.path==='/shared/settings'&&r.method==='PUT');
  assert.equal(update.body.hours.length,24);assert.equal(update.body.price,'0.2');assert.equal(update.body.hours[8].price,'0.3');assert.equal(update.csrf,'fake-ui-csrf');
  assert.equal(await page.$('#shared-register'),null,'Bulk shared-number registration is removed');
  assert.equal(fixture.requests.some(r=>r.path==='/shared/accounts'&&r.method==='POST'),false);
 }
 await verifyPersonalPages(page,fixture,role,language);
 await verifySharedPhotos(page,fixture,role,language);
 await verifySharedAvailability(page,fixture,role,language);
 await page.evaluate(()=>{
  const f=document.querySelector('#shared-send-form');
  for(const [name,value]of Object.entries({body:'fake UI message',recipients:'+60123456789\n+60123456788\n+60123456789'})){
   f.elements.namedItem(name).value=value;f.elements.namedItem(name).dispatchEvent(new Event('input',{bubbles:true}));
  }
  f.elements.namedItem('interval_value').value='1';f.elements.namedItem('interval_unit').value='60000';f.elements.namedItem('batch_size').value='3';
  f.elements.namedItem('opt_in').checked=true;
  const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
  const dt=new DataTransfer();dt.items.add(new File([bytes],'fixture.png',{type:'image/png'}));f.elements.namedItem('photo').files=dt.files;
  f.elements.namedItem('photo').dispatchEvent(new Event('change',{bubbles:true}));document.activeElement?.blur();
 });
 fixture.available=1;await page.evaluate(()=>loadPage(true));
 assert.equal(await page.$('#shared-send-form input[name=title]'),null);assert.equal(await page.$eval('#shared-send-form textarea[name=body]',n=>n.value),'fake UI message');
 fixture.failNext=true;await page.click('#shared-send-form button[type=submit]');
 await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Fixture retry'&&!document.querySelector('#shared-send-form').dataset.busy);
 assert.equal(fixture.sends.length,1);
 await page.click('#shared-send-form button[type=submit]');await waitReady(page,'shared-tasks');
 assert.equal(fixture.sends.length,2);assert.equal(fixture.sends[1].title,undefined);assert.equal(fixture.sends[0].request_id,fixture.sends[1].request_id);
 assert.equal(fixture.sends[1].pacing,true);assert.equal(fixture.sends[1].interval_ms,60000);assert.equal(fixture.sends[1].batch_size,3);
 assert.equal(fixture.sends[1].opt_in_confirmed,true);assert.equal(fixture.sends[1].media.mimetype,'image/png');assert.ok(fixture.sends[1].media.data);
 assert.equal(await page.$eval('#content',n=>n.querySelectorAll('script').length),0);
 if(role==='user')assert.equal(await page.$('[data-pause],[data-schedule],[data-delete-task]'),null);
 await page.click('[data-results]');
 await page.waitForFunction(()=>document.querySelector('#modal').open);
 assert.match(await page.$eval('#modal',n=>n.textContent),/\+60123456789/);
 await page.click('#close-modal');
 await page.click('#nav [data-page=shared-records]');
 await page.waitForFunction(()=>document.querySelector('#content .badge.submitted, #content .badge.green'));
 assert.match(await page.$eval('#content',n=>n.textContent),language==='en'?/Sent successfully/:/发送成功/);
 await page.click('#nav [data-page=shared]');
 await waitReady(page);fixture.available=0;await page.evaluate(()=>loadPage());
 await page.waitForFunction(()=>document.querySelector('#shared-send-form button[type=submit]').disabled);
 const unavailableText=await page.$eval('#content',n=>n.textContent);
 if(role==='owner')assert.match(unavailableText,language==='en'?/No shared accounts are available yet/:/暂时没有可用的共享账号/);
 else assert.doesNotMatch(unavailableText,/暂时没有可用的共享账号|No shared accounts are available yet|系统只选择 Owner|The system selects only separate shared accounts/);
 assert.equal(await page.$eval('#shared-send-form button[type=submit]',n=>n.disabled),true);
 await page.setViewport({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Shared page fits a mobile viewport');
 if(role==='owner'){
  await page.click('#shared-settings');await page.waitForFunction(()=>document.querySelector('#modal').open);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Hourly settings fit a mobile viewport');
  await page.click('#close-modal');
 }
 fixture.notice={enabled:true,content_zh:'Private sign-out notice',content_en:'Private sign-out notice',updated_at:new Date().toISOString()};await page.evaluate(()=>loadPage(true));
 await page.click('#logout');await page.waitForFunction(()=>document.querySelector('#login').hidden===false);
 assert.equal(await page.$eval('#workspace-notice',n=>n.textContent),'','Sign-out clears the previous notice from the DOM');
 assert.equal(await page.$eval('#account-greeting',n=>n.textContent),'','Signing out clears the previous username');
 await verifyLanguageSelector(page,language,'dark');
 assert.equal(await page.$$eval('#nav button',n=>n.length),0);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('wa_nav_expanded')),null);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('wa_account_groups')),null);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('wa_dashboard_open')),null);
 assert.equal(await page.$eval('#content',n=>n.textContent),'');
 await verifyLoginPage(page,fixture,role,language);
 assert.deepEqual(errors,[]);
 await context.close();console.log('Browser PASS: '+role+' / '+language+' / desktop + mobile');
}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const base='http://127.0.0.1:'+server.address().port;
  for(const role of ['owner','user'])for(const language of ['zh','en'])await runCase(browser,base,role,language);
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});



