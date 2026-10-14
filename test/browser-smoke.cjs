'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile),puppeteer=require('puppeteer'),{retire}=require('../src/browser-lifecycle');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const uid=27001,base=await fs.mkdtemp(path.join(os.tmpdir(),'wa-browser-smoke-')),home=path.join(base,'home'),profile=path.join(base,'profile'),xauth=path.join(home,'Xauthority'),entries=new Map();
 await execute('groupadd',['--gid',String(uid),'wa-browser-smoke']);await execute('useradd',['--uid',String(uid),'--gid',String(uid),'--no-create-home','--home-dir',home,'wa-browser-smoke']);
 await fs.chmod(base,0o711);
 for(const folder of [home,profile]){await fs.mkdir(folder,{mode:0o700});await fs.chown(folder,uid,uid);}
 await fs.writeFile(path.join(profile,'keep-session.marker'),'preserved');
 await execute('xauth',['-f',xauth,'add',':99','.',require('node:crypto').randomBytes(16).toString('hex')]);await fs.chown(xauth,uid,uid);
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'en_US.UTF-8',TZ:'Asia/Kuala_Lumpur',HOME:home,DISPLAY:':99',XAUTHORITY:xauth,WA_BROWSER_UID:String(uid)};
 async function setup(){
  const display=spawn('Xvfb',[':99','-screen','0','1366x900x24','-nolisten','tcp','-auth',xauth],{env,uid,gid:uid,stdio:'ignore'});
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
   assert.equal(await page.title(),'Isolated browser smoke');
   await retire(entries,entry);
   assert.equal(entries.size,0);
   assert.equal(await fs.readFile(path.join(profile,'keep-session.marker'),'utf8'),'preserved');
  }
  console.log('Worker browser smoke PASS: cancelled launch, isolated headful Chromium, cleanup, same profile reused; network disabled');
 }finally{for(const entry of [...entries.values()])await retire(entries,entry);await fs.rm(base,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
