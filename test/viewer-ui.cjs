'use strict';
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'../public'),id='11111111-1111-4111-8111-111111111111';let fixture;
const fakeRFB=`export default class RFB extends EventTarget{constructor(screen){super();window.fixtureRfb=this;window.fixtureRfbCount=(window.fixtureRfbCount||0)+1;screen.textContent='Local RFB test fixture';setTimeout(()=>this.dispatchEvent(new Event('connect')),0);}disconnect(){this.dispatchEvent(new Event('disconnect'));}}`;
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/novnc/core/rfb.js'){res.setHeader('Content-Type','application/javascript');return res.end(fakeRFB);}
  if(url.pathname==='/api/accounts/'+id+'/connection'){
   fixture.checks++;assert.equal(url.searchParams.get('mode'),'scan');res.setHeader('Content-Type','application/json');
   const code=fixture.phase==='ready'?'SCREEN_READY':fixture.phase==='resource'?'BROWSER_RESOURCE_WAIT':fixture.phase==='recovering'?'BROWSER_RECOVERING':'ALREADY_LINKED';
   return res.end(JSON.stringify({ok:fixture.phase==='ready',connected:fixture.phase==='linked',code,can_start:fixture.phase==='recovering'}));
  }
  const file=path.resolve(root,url.pathname.slice(1));if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'text/plain');res.end(await fs.readFile(file));
 }catch(error){res.statusCode=500;res.end('Fixture failed');}
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const lang of ['zh','en']){
   fixture={phase:'resource',checks:0};const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.evaluateOnNewDocument(language=>{
    localStorage.setItem('wa_language',language);const schedule=window.setTimeout.bind(window);window.fixtureReconnectDelays=[];
    window.setTimeout=(callback,delay,...args)=>{if(delay>=2000&&delay<=30000){window.fixtureReconnectDelays.push(delay);return schedule(callback,100,...args);}return schedule(callback,delay,...args);};
   },lang);
   await page.goto('http://127.0.0.1:'+server.address().port+'/viewer.html?id='+id+'&mode=scan',{waitUntil:'networkidle0'});
   assert.match(await page.$eval('#status',n=>n.textContent),lang==='zh'?/等待可用资源/:/waiting for capacity/);assert.equal(await page.$eval('#start-browser',n=>n.hidden),true);
   for(let wait=0;wait<150&&fixture.checks<10;wait++)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(fixture.checks>=10,'Capacity polling stopped after eight attempts');
   fixture.phase='ready';await page.waitForFunction(()=>window.fixtureRfbCount===1);
   fixture.phase='recovering';await page.evaluate(()=>window.fixtureRfb.disconnect());
   await page.waitForFunction(language=>document.querySelector('#status').textContent.includes(language==='zh'?'正在恢复':'is recovering'),{},lang);
   fixture.phase='ready';await page.waitForFunction(()=>window.fixtureRfbCount===2);
   fixture.phase='linked';await page.evaluate(()=>window.fixtureRfb.disconnect());
   await page.waitForFunction(language=>document.querySelector('#status').textContent.includes(language==='zh'?'无需再次扫码':'No further QR scan'),{},lang);
   const checks=fixture.checks;await new Promise(resolve=>setTimeout(resolve,2200));assert.equal(fixture.checks,checks);assert.equal(await page.evaluate(()=>window.fixtureRfbCount),2);assert.deepEqual(errors,[]);
   assert.ok(await page.evaluate(()=>window.fixtureReconnectDelays.every(ms=>ms<=30000)));
   console.log('QR viewer PASS: '+lang+' resource wait, automatic reconnect after crash, stop polling after successful link');await page.close();
  }
 }finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
