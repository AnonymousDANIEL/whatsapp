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
function personalTask(s){return {id:taskId,title:'Review fixture',body:'Synthetic caption',account_label:'fixture personal',creator:'fixture-'+s.role,created_by:'ui-'+s.role,enabled:false,pause_reason:'review',interval_ms:10000,created_at:'2026-10-16T03:00:00Z',operation_at:'2026-10-16T03:10:00Z',counts:{unknown:1}};}
function personalRecords(s){return ['submitted','delivered','failed','pending','unknown'].map((status,i)=>({recipient_id:i+1,campaign_id:taskId,account_label:'fixture personal',actor:'fixture-'+s.role,raw_phone:'+15555550101',body:'fixture '+status,status,sent_at:'2026-10-15T06:00:00Z'}));}
function senderGroups(s,kind){return {kind,groups:[{user:{id:'ui-owner',username:'fixture-owner',role:'owner',active:true,locked:false},total:kind==='tasks'?(s.taskReview?1:0):5},...managedUsers.map(u=>({user:u,total:u.id==='active-user'?2:0})),...(kind==='messages'?[{user:null,total:1}]:[])]};}
function senderItems(s,kind,actor,page){
 if(actor==='ui-owner')return{kind,actor_id:actor,rows:kind==='tasks'?(s.taskReview?[personalTask(s)]:[]):personalRecords(s),total:kind==='tasks'?(s.taskReview?1:0):5,page,size:100};
 const text='Synthetic USER '+(kind==='tasks'?'task':'message')+' page '+page;
 const row=kind==='tasks'?{...personalTask(s),id:page===1?'33333333-3333-4333-8333-333333333333':'44444444-4444-4444-8444-444444444444',created_by:actor,creator:'Active fixture',body:text}:{...personalRecords(s)[0],actor:'Active fixture',body:text};
 return{kind,actor_id:actor,rows:actor==='active-user'?[row]:[],total:actor==='active-user'?2:0,page,size:1};
}
function groupedOverview(s){
 const bucket=(user,counts)=>({user,counts,days:Array.from({length:7},(_,i)=>({date:'2026-10-'+String(i+11).padStart(2,'0'),counts:i===6?counts:{}}))});
 return{owner:bucket({id:'ui-owner',username:'fixture-owner',role:'owner'},{submitted:2,unknown:1}),users:managedUsers.map((u,i)=>bucket(u,i===0?{submitted:8+(s.overviewRevision||0),failed:2}:i===1?{}:{read:1})),external:bucket(null,{delivered:1}),timezone:'Asia/Kuala_Lumpur'};
}

const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
   let raw='';for await(const chunk of req)raw+=chunk;
   const body=raw?JSON.parse(raw):null,p=url.pathname.slice(4),s=current;
   s.requests.push({path:p,query:url.search,method:req.method,body,csrf:req.headers['x-csrf-token']});
   let result;
   if(p==='/me')result={user:{id:'ui-'+s.role,username:'fixture-'+s.role,role:s.role},csrf:'fake-ui-csrf',worker_groups:['fixture-group'],server_time:new Date().toISOString(),password_access:false};
   else if(p==='/payments/settings')result={enabled:!!s.fpxEnabled,configured:!!s.fpxEnabled,sandbox:false};
   else if(p==='/payments/orders')result=s.paymentPending?[{id:'fixture-order',username:'fixture-'+s.role,amount_cents:5000,state:'pending',sandbox:false,payment_url:'https://example.invalid/fixture-payment',created_at:'2026-10-15T06:00:00Z'}]:[];
   else if(p==='/payments/orders/fixture-order/check')result={ok:true};
   else if(p==='/accounts'){
    const personal={id:accountId,label:'fixture personal'+(s.accountSuffix||''),enabled:true,status:s.accountStatus||'ready',phone:s.accountPhone||'15555550101',history_synced_at:null};
    result=s.role==='owner'?[...managedUsers.map((u,i)=>({...personal,id:i?'account-'+i:accountId,assigned_users:[{id:u.id,username:u.username,active:u.active}]})),{...personal,id:'owner-account',assigned_users:[]}]:[personal];
   }
   else if(p==='/users')result=[{id:'ui-owner',username:'fixture-owner',role:'owner',active:true,locked:false},...managedUsers].map(u=>({...u,last_login_at:s.loginDates[u.id]??null}));
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
   else if(p==='/notice')result={enabled:false};
   else if(p==='/health'){if(s.capacityFailure)res.statusCode=503;result=s.capacityFailure?{error:'Fixture capacity temporarily unavailable'}:capacityRows(s);}
   else if(p==='/billing')result={user:{id:'ui-'+s.role,username:'fixture-'+s.role,role:s.role,credit_units:'10000000'},held:[],held_units:0,price_units:1000,ledger:[{kind:'adjustment',delta_units:'10000000',balance_units:'10000000',note:ledgerNote,created_at:'2026-10-15T06:00:00Z'}]};
   else if(p==='/shared/status'){
    result={enabled:s.enabled,images_enabled:s.imagesEnabled!==false,configured:true,balance_units:'10000000',summary:{total:120,connected:2,available:s.available,waiting:118,offline:0,unknown:0},timezone:'Asia/Kuala_Lumpur'};
    if(s.role==='owner')Object.assign(result,{settings:{enabled:s.enabled,price_units:1000,current_price_units:12500,interval_ms:10000,batch_size:1},hours:[{hour:0,price_units:12500}],groups:(s.sharedCapacityRows||capacityRows(s)).map(w=>w.worker_group),workers:s.sharedCapacityRows||capacityRows(s)});
   }else if(p==='/shared/accounts'&&req.method==='GET')result={rows:[{id:accountId,label:'<img src=x onerror=alert(1)>',registration_phone:'+60123456789',phone:'60123456789',worker_group:'fixture-group',enabled:true,status:'ready',shared_state:'connected',shared_checked_at:new Date().toISOString(),connected:true}],total:120,page:Number(url.searchParams.get('page')||1),size:50};
   else if(p==='/shared/hourly')result=[{hour_start:'2026-10-14T14:00:00Z',total:120,connected:2,waiting:118,offline:0,unknown:0,groups:1,checked_at:'2026-10-14T14:10:00Z'}];
   else if(p==='/shared/settings')result={ok:true};
   else if(p==='/shared/accounts/scan'&&req.method==='POST'){if(s.scanFailNext){s.scanFailNext=false;res.statusCode=503;result={error:'Synthetic add retry'};}else result={id:body.request_id,started:true};}
   else if(p==='/shared/accounts'&&req.method==='POST')result={created:2,duplicates:0};
   else if(p==='/shared/send'){
    s.sends.push(body);
    if(s.failNext){s.failNext=false;res.statusCode=503;result={error:'Fixture retry'};}else result={id:taskId,count:2,duplicates:1};
   }else if(p==='/shared/tasks')result={rows:[{id:taskId,title:'<script>fixture</script>',body:'fake UI message',created_at:'2026-10-14T14:00:00Z',enabled:true,creator:'fixture-'+s.role,counts:{pending:1,submitted:1}}],page:1,size:100};
   else if(p==='/shared/records')result={rows:[{id:1,title:'fixture task',body:'fake UI message',creator:'fixture-'+s.role,phone:'+60123456789',status:'submitted',updated_at:'2026-10-14T14:00:00Z'}],page:1,size:100};
   else if(p==='/campaigns/'+taskId+'/results')result={rows:[{phone:'+60123456789',status:s.taskReview?'unknown':'submitted',updated_at:'2026-10-14T14:00:00Z'}],total:1};
   else if(p==='/logout')result={ok:true};
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
 assert.equal(await page.$$eval('[data-owner-send-actor]',nodes=>nodes.length),kind==='tasks'?4:5);
 assert.equal(await page.$$eval('[data-owner-send-actor]',nodes=>nodes.every(n=>!n.open)),true);
 assert.equal(await page.$$eval('#content tbody tr',nodes=>nodes.length),0);
 assert.equal(fixture.requests.slice(start).some(r=>r.path==='/owner/send-items'),false);
 await page.click(other+' > summary');
 await page.waitForFunction(({selector,text})=>!loading&&document.querySelector(selector)?.textContent.includes(text),{}, {selector:other,text:'Synthetic USER '+(kind==='tasks'?'task':'message')+' page 1'});
 assert.equal(await page.$eval(own,n=>n.open),false);
 await page.click(other+' [data-send-page="1"]');
 await page.waitForFunction(({selector,text})=>!loading&&document.querySelector(selector)?.textContent.includes(text),{}, {selector:other,text:'Synthetic USER '+(kind==='tasks'?'task':'message')+' page 2'});
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
   if(role==='owner')assert.match(text,language==='en'?/Review uncertain results/:/查看待核对/);
   else{assert.equal(await page.$$eval('[data-delete-task]',nodes=>nodes.length),0);assert.equal(await page.$('[data-pause]'),null);assert.equal(await page.$$eval('.actions button',nodes=>nodes.length),1);}
   assert.match(text,language==='en'?/Last action/:/最近操作/);assert.match(text,/11:10:00/);
   const posts=fixture.requests.filter(r=>r.path.endsWith('/send-now')).length;
   await page.click('[data-results]');await page.waitForFunction(()=>document.querySelector('#modal').open);
   assert.match(await page.$eval('#modal-content',n=>n.textContent),language==='en'?/Needs review/:/结果待核对/);
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
   assert.match(text,language==='en'?/Needs review/:/结果待核对/);
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
  assert.doesNotMatch(await page.$eval('#content',n=>n.textContent),/余额流水|Credit ledger/);
  assert.equal(await page.$eval('#bank-topup',n=>!!(n.compareDocumentPosition(document.querySelector('#online-fpx'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
  assert.match(await page.$eval('#content > section:last-of-type h2',n=>n.textContent),language==='en'?/My deposits/:/我的充值记录/);
  assert.match(await page.$eval('.balance-only',n=>n.textContent),/10000000/);
 }
 await sections();
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
 assert.equal(await page.$$eval('[data-overview-user]',nodes=>nodes.length),4);
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
 console.log('Owner login recency PASS: '+language+' / real timestamps, green/orange/red/no-history, exact 24h/7d boundaries, automatic aging and mobile');
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
async function runCase(browser,base,role,language){
 current={role,language,enabled:true,available:2,requests:[],sends:[],failNext:false};
 current.loginDates={'ui-owner':new Date(Date.now()-600000).toISOString(),'active-user':new Date(Date.now()-2*86400000).toISOString(),'locked-user':new Date(Date.now()-8*86400000).toISOString()};
 const fixture=current,context=await browser.createBrowserContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:1440,height:1000});
 await page.evaluateOnNewDocument(lang=>{
  localStorage.setItem('wa_language',lang);if(!sessionStorage.getItem('wa_page'))sessionStorage.setItem('wa_page','shared');
  window.open=(...args)=>{window.fixturePopup=args;return null;};
 },language);
 await page.goto(base,{waitUntil:'networkidle0'});await waitReady(page);
 assert.equal(await page.$eval('#login',n=>n.hidden),true);
 assert.equal(await page.$eval('html',n=>n.lang),language==='en'?'en':'zh-CN');
 assert.equal(await page.$eval('#page-title',n=>n.textContent),language==='en'?'Shared WhatsApp':'共享 WhatsApp');
 assert.equal(await page.$$eval('#nav .nav-entry',nodes=>nodes.every(n=>n.querySelectorAll('svg.nav-icon[aria-hidden=true][focusable=false]').length===1)),true);
 assert.equal(await page.$eval('#nav [data-page=overview] .nav-icon',n=>getComputedStyle(n).width),'18px');
 assert.equal(await page.$eval('#content',n=>n.querySelectorAll('script,img[onerror]').length),0);
 await verifySidebar(page,fixture,role,language);
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
  await page.click('#shared-register');
  await page.waitForFunction(()=>document.querySelector('#modal').open);
  assert.match(await page.$eval('#modal',n=>n.textContent),language==='en'?/does not create a phone number or register WhatsApp/:/不会自动产生手机号或完成 WhatsApp 注册/);
  await page.evaluate(()=>{
   document.querySelector('#modal textarea[name=phones]').value='+60123456789\n+60123456788';
   document.querySelector('#modal form').requestSubmit();
  });
  await page.waitForFunction(()=>!document.querySelector('#modal').open);await waitReady(page);
  assert.equal(fixture.requests.findLast(r=>r.path==='/shared/accounts'&&r.method==='POST').body.groups[0],'fixture-group');
 }
 await verifyPersonalPages(page,fixture,role,language);
 await verifySharedPhotos(page,fixture,role,language);
 await page.evaluate(()=>{
  const f=document.querySelector('#shared-send-form');
  for(const [name,value]of Object.entries({body:'fake UI message',recipients:'+60123456789\n+60123456788\n+60123456789'})){
   f.elements.namedItem(name).value=value;f.elements.namedItem(name).dispatchEvent(new Event('input',{bubbles:true}));
  }
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
 assert.equal(fixture.sends[1].opt_in_confirmed,true);assert.equal(fixture.sends[1].media.mimetype,'image/png');assert.ok(fixture.sends[1].media.data);
 assert.equal(await page.$eval('#content',n=>n.querySelectorAll('script').length),0);
 if(role==='user')assert.equal(await page.$('[data-shared-pause]'),null);
 await page.click('[data-results]');
 await page.waitForFunction(()=>document.querySelector('#modal').open);
 assert.match(await page.$eval('#modal',n=>n.textContent),/\+60123456789/);
 await page.click('#close-modal');
 await page.click('#nav [data-page=shared-records]');
 await page.waitForFunction(()=>document.querySelector('#content .badge.submitted, #content .badge.green'));
 assert.match(await page.$eval('#content',n=>n.textContent),language==='en'?/Sent successfully/:/发送成功/);
 await page.click('#nav [data-page=shared]');
 await waitReady(page);fixture.enabled=false;await page.click('#refresh');
 await page.waitForFunction(()=>document.querySelector('#shared-send-form button[type=submit]').disabled);
 if(role==='user')assert.match(await page.$eval('#content',n=>n.textContent),/Coming soon/);
 else assert.match(await page.$eval('#content',n=>n.textContent),language==='en'?/Shared service is currently closed/:/共享服务暂未开启/);
 fixture.enabled=true;fixture.available=0;await page.evaluate(()=>loadPage());
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
 await page.click('#logout');await page.waitForFunction(()=>document.querySelector('#login').hidden===false);
 assert.equal(await page.$$eval('#nav button',n=>n.length),0);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('wa_nav_expanded')),null);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('wa_account_groups')),null);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('wa_dashboard_open')),null);
 assert.equal(await page.$eval('#content',n=>n.textContent),'');
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



