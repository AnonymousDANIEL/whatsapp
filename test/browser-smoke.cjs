'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile),puppeteer=require('puppeteer'),{retire,observeBrowser,browserClosed}=require('../src/browser-lifecycle');
const {browserCpuSet}=require('../src/browser-runtime');
const {browserSnapshot}=require('../src/history-sync');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const uid=27001,base=await fs.mkdtemp(path.join(os.tmpdir(),'wa-browser-smoke-')),home=path.join(base,'home'),profile=path.join(base,'profile'),xauth=path.join(home,'Xauthority'),entries=new Map();
 await execute('groupadd',['--gid',String(uid),'wa-browser-smoke']);await execute('useradd',['--uid',String(uid),'--gid',String(uid),'--no-create-home','--home-dir',home,'wa-browser-smoke']);
 await fs.chmod(base,0o711);
 for(const folder of [home,profile]){await fs.mkdir(folder,{mode:0o700});await fs.chown(folder,uid,uid);}
 await fs.writeFile(path.join(profile,'keep-session.marker'),'preserved');
 await execute('xauth',['-f',xauth,'add',':99','.',require('node:crypto').randomBytes(16).toString('hex')]);await fs.chown(xauth,uid,uid);
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'en_US.UTF-8',TZ:'Asia/Kuala_Lumpur',HOME:home,DISPLAY:':99',XAUTHORITY:xauth,WA_BROWSER_UID:String(uid),WA_BROWSER_CPUS:await browserCpuSet(0),LP_NUM_THREADS:'2'};
 async function setup(){
  const display=spawn('taskset',['--cpu-list',env.WA_BROWSER_CPUS,'Xvfb',':99','-screen','0','1366x900x24','-nolisten','tcp','-auth',xauth],{env,uid,gid:uid,stdio:'ignore'});
  for(let i=0;i<50;i++){try{await fs.stat('/tmp/.X11-unix/X99');break;}catch{await pause(100);}}
  const entry={id:'smoke',uid,launchAbort:new AbortController(),sockets:[],children:[display]};entries.set(entry.id,entry);return entry;
 }
 const options=entry=>({executablePath:'/app/bin/browser',headless:false,defaultViewport:null,userDataDir:profile,env,signal:entry.launchAbort.signal,timeout:90000,protocolTimeout:90000,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--kiosk','--window-size=1366,900','--no-first-run']});
 try{
  const cancelled=await setup(),launch=puppeteer.launch(options(cancelled));
  // Observe rejection immediately; retirement cancels launches with no assigned browser handle.
  const rejected=assert.rejects(launch);
  await retire(entries,cancelled);await rejected;
  assert.equal(entries.size,0);
  for(let round=0;round<2;round++){
   const entry=await setup(),browser=await puppeteer.launch(options(entry));
   entry.client={pupBrowser:browser,destroy:()=>browser.close()};
   const page=(await browser.pages())[0];await page.setContent('<title>Isolated browser smoke</title><h1>Local test only</h1>');
   entry.client.pupPage=page;
   assert.ok(await page.evaluate(()=>navigator.hardwareConcurrency)<=2);
   assert.equal(await page.title(),'Isolated browser smoke');
   if(round===1){
    await page.evaluate(()=>{
     window.__historyTestCalls=0;
     window.require=()=>({Msg:{getModelsArray:()=>[{id:{_serialized:'offline-smoke-message',fromMe:true},t:100,body:'Local fixture',ack:2}]}});
     window.WWebJS={getChat:()=>{window.__historyTestCalls++;return new Promise(resolve=>{window.__historyTestRelease=resolve;});}};
    });
    for(let pass=0;pass<2;pass++){
     const snapshot=await page.evaluate(browserSnapshot,['smoke@c.us'],50,{budgetMs:50,perChatMs:10});
     assert.equal(snapshot.messages[0].id,'offline-smoke-message');assert.equal(snapshot.messages[0].ack,2);assert.equal(snapshot.chatErrors,1);
    }
    assert.equal(await page.evaluate(()=>window.__historyTestCalls),1);
    await page.evaluate(()=>window.__historyTestRelease({msgs:{getModelsArray:()=>[]}}));
    let crashed;
    const observed=new Promise(resolve=>{crashed=resolve;});observeBrowser(entries,entry,crashed);
    const cdp=await page.createCDPSession();cdp.send('Page.crash').catch(()=>{});
    let timer;try{assert.equal(await Promise.race([observed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Renderer crash was not observed')),10000);})]),'BROWSER_PAGE_CRASHED');}finally{clearTimeout(timer);}
    assert.equal(browserClosed(entry),true);assert.equal(browser.connected,true);
   }
   // Simulate a process-limit failure: cleanup must also work when pkill cannot fork.
   if(round===0){entry.client.destroy=()=>new Promise(()=>{});await retire(entries,entry,{timeout:30,run:async()=>{throw Object.assign(Error('simulated fork limit'),{code:'EAGAIN'});}});}
   else await retire(entries,entry);
   assert.equal(entries.size,0);
   assert.equal(await fs.readFile(path.join(profile,'keep-session.marker'),'utf8'),'preserved');
  }
  console.log('Worker browser smoke PASS: CPU affinity, real renderer crash observed, cancelled launch, bounded history, fork-free cleanup, profile reused; network disabled');
 }finally{for(const entry of [...entries.values()])await retire(entries,entry);await fs.rm(base,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});

