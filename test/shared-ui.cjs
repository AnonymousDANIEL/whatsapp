'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'../public');
const accountId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222';
let current;
function capacityRows(s){return s.capacityRows||[{worker_group:'fixture-group',accounts_running:2,max_accounts:10,assigned_accounts:3,slots_used:3,slots_available:7,slots_unavailable:0,can_start_more:true,capacity_state:'available',heartbeat_at:new Date().toISOString()}];}

const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
   let raw='';for await(const chunk of req)raw+=chunk;
   const body=raw?JSON.parse(raw):null,p=url.pathname.slice(4),s=current;
   s.requests.push({path:p,method:req.method,body,csrf:req.headers['x-csrf-token']});
   let result;
   if(p==='/me')result={user:{id:'ui-'+s.role,username:'fixture-'+s.role,role:s.role},csrf:'fake-ui-csrf',worker_groups:['fixture-group'],server_time:new Date().toISOString(),password_access:false};
   else if(p==='/payments/settings')result={enabled:!!s.fpxEnabled,configured:!!s.fpxEnabled,sandbox:false};
   else if(p==='/payments/orders')result=s.paymentPending?[{id:'fixture-order',username:'fixture-'+s.role,amount_cents:5000,state:'pending',sandbox:false,payment_url:'https://example.invalid/fixture-payment',created_at:'2026-10-15T06:00:00Z'}]:[];
   else if(p==='/payments/orders/fixture-order/check')result={ok:true};
   else if(p==='/accounts')result=[{id:accountId,label:'fixture personal',enabled:true,status:'ready',history_synced_at:null}];
   else if(p==='/campaigns'&&req.method==='POST')result={id:taskId,count:1,duplicates:0};
   else if(p==='/campaigns')result=s.taskReview?[{id:taskId,title:'Review fixture',body:'Synthetic caption',account_label:'fixture personal',creator:'fixture-'+s.role,created_by:'ui-'+s.role,enabled:false,pause_reason:'review',interval_ms:10000,created_at:'2026-10-16T03:00:00Z',operation_at:'2026-10-16T03:10:00Z',counts:{unknown:1}}]:[];
   else if(p==='/overview')result={counts:{submitted:1,failed:1,unknown:1},days:Array.from({length:7},(_,i)=>({date:'2026-10-'+String(i+9).padStart(2,'0'),counts:{submitted:i===6?1:0}}))};
   else if(p==='/send-records')result=['submitted','delivered','failed','pending','unknown'].map((status,i)=>({recipient_id:i+1,campaign_id:taskId,account_label:'fixture personal',actor:'fixture-'+s.role,raw_phone:'+60123456789',body:'fixture '+status,status,sent_at:'2026-10-15T06:00:00Z'}));
   else if(p==='/banks')result={enabled:!s.banksOff,banks:s.banksOff?[]:[{id:'fixture-bank',bank_name:'Fixture bank',account_name:'Fixture account',status:s.bankMaintenance?'maintenance':'active'}]};
   else if(p==='/bank-deposits')result={rows:[],page:1,total:0};
   else if(p==='/notice')result={enabled:false};
   else if(p==='/health')result=capacityRows(s);
   else if(p==='/billing')result={user:{id:'ui-'+s.role,username:'fixture-'+s.role,role:s.role,credit_units:'10000000'},ledger:[{kind:'adjustment',delta_units:'10000000',balance_units:'10000000',created_at:'2026-10-15T06:00:00Z'}]};
   else if(p==='/shared/status'){
    result={enabled:s.enabled,configured:true,balance_units:'10000000',summary:{total:120,connected:2,available:s.available,waiting:118,offline:0,unknown:0},timezone:'Asia/Kuala_Lumpur'};
    if(s.role==='owner')Object.assign(result,{settings:{enabled:s.enabled,price_units:1000,current_price_units:12500,interval_ms:10000,batch_size:1},hours:[{hour:0,price_units:12500}],groups:capacityRows(s).map(w=>w.worker_group),workers:capacityRows(s)});
   }else if(p==='/shared/accounts'&&req.method==='GET')result={rows:[{id:accountId,label:'<img src=x onerror=alert(1)>',registration_phone:'+60123456789',phone:'60123456789',worker_group:'fixture-group',enabled:true,status:'ready',shared_state:'connected',shared_checked_at:new Date().toISOString(),connected:true}],total:120,page:Number(url.searchParams.get('page')||1),size:50};
   else if(p==='/shared/hourly')result=[{hour_start:'2026-10-14T14:00:00Z',total:120,connected:2,waiting:118,offline:0,unknown:0,groups:1,checked_at:'2026-10-14T14:10:00Z'}];
   else if(p==='/shared/settings')result={ok:true};
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

async function verifyPersonalPages(page,fixture,role,language){
 const pages=[
  ['accounts','#add-account',/画面断开不代表|A disconnected screen does not mean/],
  ['tasks','#add-task',/USER 发送前须充值|USERs need credit before sending/],
  ['messages','#history-prev',/按号码显示任务|Shows per-number waiting/],
  ['overview','.overview-chart',/真实消息数据|Live message data/]
 ];
 for(const [target,ready,explanation]of pages){
  if(target==='tasks')fixture.taskReview=true;
  await page.evaluate(target=>{page=target;sessionStorage.setItem('wa_page',target);navigation();return loadPage();},target);
  await page.waitForSelector(ready);
  const text=await page.$eval('#content',n=>n.textContent);
  if(role==='owner')assert.match(text,explanation);else assert.doesNotMatch(text,explanation);
  if(target==='tasks'&&role==='user')assert.doesNotMatch(text,/按间隔和每批数量发送|Send by interval and batch size/);
  if(target==='tasks'){
   for(const width of [1440,390]){
    await page.setViewport({width,height:width===390?844:1000});
    assert.equal(await page.$$eval('[data-schedule]',nodes=>nodes.length),role==='owner'?1:0);
   }
   await page.setViewport({width:1440,height:1000});
   assert.equal(await page.$$eval('[data-pause]',nodes=>nodes.length),1);
   if(role==='owner'){
    await page.click('[data-schedule]');await page.waitForFunction(()=>document.querySelector('#modal').open);
    assert.ok(await page.$('#modal input[name=interval_value]'));assert.ok(await page.$('#modal input[name=batch_size]'));await page.click('#close-modal');
   }else assert.doesNotMatch(text,/修改间隔\s*\/\s*数量|Edit interval\s*\/\s*quantity/);
   assert.equal(await page.$$eval('[data-now]',nodes=>nodes.length),0);
   if(role==='owner')assert.match(text,language==='en'?/Review uncertain results/:/查看待核对/);
   else{assert.equal(await page.$$eval('[data-delete-task]',nodes=>nodes.length),0);assert.equal(await page.$eval('[data-pause]',n=>n.disabled),true);assert.match(await page.$eval('[data-pause]',n=>n.textContent),language==='en'?/Paused/:/已暂停/);}
   assert.match(text,language==='en'?/Last action/:/最近操作/);assert.match(text,/11:10:00/);
   const posts=fixture.requests.filter(r=>r.path.endsWith('/send-now')).length;
   await page.click('[data-results]');await page.waitForFunction(()=>document.querySelector('#modal').open);
   assert.match(await page.$eval('#modal-content',n=>n.textContent),language==='en'?/Needs review/:/结果待核对/);
   assert.equal(fixture.requests.filter(r=>r.path.endsWith('/send-now')).length,posts);await page.click('#close-modal');
   await page.click('#add-task');await page.waitForFunction(()=>document.querySelector('#modal').open);
   await page.$eval('#modal form',f=>{f.elements.namedItem('title').value='New independent task';f.elements.namedItem('body').value='Synthetic message';f.elements.namedItem('recipients').value='0123456789';f.elements.namedItem('opt_in').checked=true;});
   const created=page.waitForResponse(r=>r.url().endsWith('/api/campaigns')&&r.request().method()==='POST');
   await page.click('#modal button[value=now]');await created;await page.waitForFunction(()=>!document.querySelector('#modal').open);
   const newTask=fixture.requests.findLast(r=>r.path==='/campaigns'&&r.method==='POST');assert.equal(newTask.body.send_now,true);assert.equal(newTask.body.require_connected,true);
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
   assert.equal(await page.$$eval('.overview-cards .card',nodes=>nodes.length),4);
   assert.equal(await page.$$eval('.overview-week>div',nodes=>nodes.length),7);
  }
 }
 await page.click('#nav [data-page=shared]');await waitReady(page);
}
async function verifyUserBilling(page,fixture,language){
 const heading=language==='en'?'Credit ledger':'余额流水';
 async function sections(){
  assert.equal(await page.$('#nav [data-page=fpx]'),null);
  assert.equal(await page.$('#nav [data-page=bank-deposits]'),null);
  assert.equal(await page.$('#nav [data-nav-toggle=billing]'),null);
  assert.equal(await page.$('[data-billing-view]'),null);
  assert.equal(await page.$eval('.credit-ledger h3',n=>n.textContent),heading);
  assert.equal(await page.$eval('#content',n=>n.lastElementChild.matches('.credit-ledger')),true);
  assert.equal(await page.$eval('#bank-topup',n=>!!(n.compareDocumentPosition(document.querySelector('#online-fpx'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
  assert.equal(await page.$eval('#online-fpx',n=>!!(n.compareDocumentPosition(document.querySelector('.credit-ledger'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
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
 await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('.credit-ledger');await sections();
 fixture.fpxEnabled=true;await page.goto(new URL('/?topup=fixture-order',page.url()).href,{waitUntil:'networkidle0'});
 await page.waitForSelector('#online-topup');await page.waitForFunction(()=>!location.search);await sections();
 assert.equal(fixture.requests.filter(r=>r.path==='/payments/orders/fixture-order/check'&&r.method==='POST'&&r.csrf==='fake-ui-csrf').length,2);
 fixture.fpxEnabled=false;await page.evaluate(()=>loadPage());await sections();
}

async function verifyCapacity(page,fixture,language){
 async function summary(available,used,total,unavailable,rows){
  for(const [key,value] of Object.entries({available,used,total,unavailable}))assert.equal(await page.$eval('[data-capacity-'+key+']',n=>Number(n.textContent.replaceAll(',',''))),value);
  assert.equal(await page.$$eval('[data-capacity] tbody tr',n=>n.length),rows);
  assert.match(await page.$eval('[data-capacity] h2',n=>n.textContent),language==='en'?/Available QR slots/:/剩余可扫码/);
 }
 await summary(7,3,10,0,1);
 const now=Date.now();fixture.capacityRows=Array.from({length:22},(_,i)=>({worker_group:i?'fixture-group-'+(i+1):'fixture-group',max_accounts:i?5:10,accounts_running:0,assigned_accounts:0,slots_used:0,slots_available:i?5:10,slots_unavailable:0,can_start_more:true,heartbeat_at:new Date(now).toISOString()}));
 Object.assign(fixture.capacityRows[0],{accounts_running:8,assigned_accounts:8,slots_used:8,slots_available:0,slots_unavailable:2,can_start_more:false});
 Object.assign(fixture.capacityRows[1],{accounts_running:5,assigned_accounts:5,slots_used:5,slots_available:0});
 Object.assign(fixture.capacityRows[2],{accounts_running:1,assigned_accounts:2,slots_used:2,slots_available:3});
 fixture.capacityRows[3].heartbeat_at=new Date(now-120000).toISOString();
 await page.evaluate(()=>loadPage());await summary(93,15,115,7,22);
 for(const width of [390,1440]){
  await page.setViewport({width,height:width===390?844:1000});
  assert.equal(await page.$eval('[data-capacity-available]',n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }
 Object.assign(fixture.capacityRows[2],{assigned_accounts:4,slots_used:4,slots_available:1});
 await page.evaluate(()=>loadPage(true));await summary(91,17,115,7,22);
 fixture.capacityRows=null;await page.evaluate(()=>{page='system';sessionStorage.setItem('wa_page',page);navigation();return loadPage();});await summary(7,3,10,0,1);
 await page.click('#nav [data-page=shared]');await waitReady(page);
}

async function runCase(browser,base,role,language){
 current={role,language,enabled:true,available:2,requests:[],sends:[],failNext:false};
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
 assert.equal(await page.$$eval('.nav-icon',n=>n.length),0);
 assert.equal(await page.$eval('#content',n=>n.querySelectorAll('script,img[onerror]').length),0);
 if(role==='user'){
  assert.equal(await page.$('#shared-add'),null);assert.equal(await page.$('#shared-settings'),null);
  assert.equal(await page.$('[data-shared-login]'),null);
  assert.equal(await page.$('[data-capacity]'),null);
  assert.equal(await page.$('#nav [data-page=users]'),null);
  assert.equal(fixture.requests.some(r=>['/shared/accounts','/shared/hourly'].includes(r.path)),false);
  assert.doesNotMatch(await page.$eval('#content',n=>n.textContent),/10000000|可用余额|Available credit|Available balance/);
  assert.equal(await page.$$eval('.shared-cards .card',n=>n.length),1);
  await page.click('#nav [data-page=billing]');
  await page.waitForFunction(()=>document.querySelector('#content').textContent.includes('10000000'));
  assert.match(await page.$eval('#content',n=>n.textContent),language==='en'?/Credit ledger/:/余额流水/);
  await verifyUserBilling(page,fixture,language);
  await page.click('#nav [data-page=shared]');await waitReady(page);
  assert.doesNotMatch(await page.$eval('#content',n=>n.textContent),/Current rate per message|当前每条价格/);
 }else{
  await verifyCapacity(page,fixture,language);
  assert.equal(await page.$eval('#content strong',n=>n.textContent),'<img src=x onerror=alert(1)>');
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
  await page.click('#shared-add');
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
 if(role==='owner')await page.click('details.panel > summary');
 await page.evaluate(()=>{
  const f=document.querySelector('#shared-send-form');
  for(const [name,value]of Object.entries({title:'fixture shared task',body:'fake UI message',recipients:'+60123456789\n+60123456788\n+60123456789'})){
   f.elements.namedItem(name).value=value;f.elements.namedItem(name).dispatchEvent(new Event('input',{bubbles:true}));
  }
  f.elements.namedItem('opt_in').checked=true;
  const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
  const dt=new DataTransfer();dt.items.add(new File([bytes],'fixture.png',{type:'image/png'}));f.elements.namedItem('photo').files=dt.files;
  f.elements.namedItem('photo').dispatchEvent(new Event('change',{bubbles:true}));document.activeElement?.blur();
 });
 fixture.available=1;await page.evaluate(()=>loadPage(true));
 assert.equal(await page.$eval('#shared-send-form input[name=title]',n=>n.value),'fixture shared task');
 fixture.failNext=true;await page.click('#shared-send-form button[type=submit]');
 await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Fixture retry'&&!document.querySelector('#shared-send-form').dataset.busy);
 assert.equal(fixture.sends.length,1);
 await page.click('#shared-send-form button[type=submit]');await waitReady(page,'shared-tasks');
 assert.equal(fixture.sends.length,2);assert.equal(fixture.sends[0].request_id,fixture.sends[1].request_id);
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



