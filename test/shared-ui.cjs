'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'../public');
const accountId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222';
let current;
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
   let raw='';for await(const chunk of req)raw+=chunk;
   const body=raw?JSON.parse(raw):null,p=url.pathname.slice(4),s=current;
   s.requests.push({path:p,method:req.method,body,csrf:req.headers['x-csrf-token']});
   let result;
   if(p==='/me')result={user:{id:'ui-'+s.role,username:'fixture-'+s.role,role:s.role},csrf:'fake-ui-csrf',worker_groups:['fixture-group'],server_time:new Date().toISOString(),password_access:false};
   else if(p==='/payments/settings')result={enabled:false,configured:false,sandbox:false};
   else if(p==='/notice')result={enabled:false};
   else if(p==='/billing')result={user:{id:'ui-'+s.role,username:'fixture-'+s.role,role:s.role,credit_units:'10000000'},ledger:[{kind:'adjustment',delta_units:'10000000',balance_units:'10000000',created_at:'2026-10-15T06:00:00Z'}]};
   else if(p==='/shared/status'){
    result={enabled:s.enabled,configured:true,summary:{total:120,connected:2,available:s.available,waiting:118,offline:0,unknown:0},timezone:'Asia/Kuala_Lumpur'};
    if(s.role==='owner')Object.assign(result,{settings:{enabled:s.enabled,price_units:1000,current_price_units:12500,interval_ms:10000,batch_size:1},hours:[{hour:0,price_units:12500}],groups:['fixture-group'],workers:[{worker_group:'fixture-group',accounts_running:2,max_accounts:10,heartbeat_at:new Date().toISOString()}]});
   }else if(p==='/shared/accounts'&&req.method==='GET')result={rows:[{id:accountId,label:'<img src=x onerror=alert(1)>',registration_phone:'+60123456789',phone:'60123456789',worker_group:'fixture-group',enabled:true,status:'ready',shared_state:'connected',shared_checked_at:new Date().toISOString(),connected:true}],total:120,page:Number(url.searchParams.get('page')||1),size:50};
   else if(p==='/shared/hourly')result=[{hour_start:'2026-10-14T14:00:00Z',total:120,connected:2,waiting:118,offline:0,unknown:0,groups:1,checked_at:'2026-10-14T14:10:00Z'}];
   else if(p==='/shared/settings')result={ok:true};
   else if(p==='/shared/accounts'&&req.method==='POST')result={created:2,duplicates:0};
   else if(p==='/shared/send'){
    s.sends.push(body);
    if(s.failNext){s.failNext=false;res.statusCode=503;result={error:'Fixture retry'};}else result={id:taskId,count:2,duplicates:1};
   }else if(p==='/shared/tasks')result={rows:[{id:taskId,title:'<script>fixture</script>',body:'fake UI message',created_at:'2026-10-14T14:00:00Z',enabled:true,creator:'fixture-'+s.role,counts:{pending:1,submitted:1}}],page:1,size:100};
   else if(p==='/shared/records')result={rows:[{id:1,title:'fixture task',body:'fake UI message',creator:'fixture-'+s.role,phone:'+60123456789',status:'submitted',updated_at:'2026-10-14T14:00:00Z'}],page:1,size:100};
   else if(p==='/campaigns/'+taskId+'/results')result={rows:[{phone:'+60123456789',status:'submitted',updated_at:'2026-10-14T14:00:00Z'}],total:1};
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
 await page.waitForFunction(kind=>document.querySelector('#shell')?.hidden===false&&document.querySelector('#content')?.querySelector(kind==='shared'?'#shared-send-form':'[data-results]'),{},kind);
}
async function runCase(browser,base,role,language){
 current={role,language,enabled:true,available:2,requests:[],sends:[],failNext:false};
 const fixture=current,context=await browser.createBrowserContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:1440,height:1000});
 await page.evaluateOnNewDocument(lang=>{
  localStorage.setItem('wa_language',lang);sessionStorage.setItem('wa_page','shared');
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
  assert.equal(await page.$('#nav [data-page=users]'),null);
  assert.equal(fixture.requests.some(r=>['/shared/accounts','/shared/hourly'].includes(r.path)),false);
  assert.doesNotMatch(await page.$eval('#content',n=>n.textContent),/10000000|可用余额|Available credit|Available balance/);
  assert.equal(await page.$eval('.shared-cards .card',n=>n.length),1);
  await page.click('#nav [data-page=billing]');
  await page.waitForFunction(()=>document.querySelector('#content').textContent.includes('10000000'));
  assert.match(await page.$eval('#content',n=>n.textContent),language==='en'?/Credit ledger/:/余额流水/);
  await page.click('#nav [data-page=shared]');await waitReady(page);
  assert.doesNotMatch(await page.$eval('#content',n=>n.textContent),/Current rate per message|当前每条价格/);
 }else{
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
  await page.waitForFunction(()=>!document.querySelector('#modal').open);
  const update=fixture.requests.findLast(r=>r.path==='/shared/settings'&&r.method==='PUT');
  assert.equal(update.body.hours.length,24);assert.equal(update.body.price,'0.2');assert.equal(update.body.hours[8].price,'0.3');assert.equal(update.csrf,'fake-ui-csrf');
  await page.click('#shared-add');
  await page.waitForFunction(()=>document.querySelector('#modal').open);
  assert.match(await page.$eval('#modal',n=>n.textContent),language==='en'?/does not create a phone number or register WhatsApp/:/不会自动产生手机号或完成 WhatsApp 注册/);
  await page.evaluate(()=>{
   document.querySelector('#modal textarea[name=phones]').value='+60123456789\n+60123456788';
   document.querySelector('#modal form').requestSubmit();
  });
  await page.waitForFunction(()=>!document.querySelector('#modal').open);
  assert.equal(fixture.requests.findLast(r=>r.path==='/shared/accounts'&&r.method==='POST').body.groups[0],'fixture-group');
  await page.click('details.panel > summary');
 }
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
 fixture.enabled=true;fixture.available=0;await page.click('#refresh');
 await page.waitForFunction(()=>document.querySelector('#content').textContent.includes(window.T('暂时没有可用的共享账号','No shared accounts are available yet')));
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
