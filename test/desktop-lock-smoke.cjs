'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),{once}=require('node:events');
const execute=promisify(execFile),puppeteer=require('puppeteer'),lifecycle=require('../src/browser-lifecycle'),{browserCpuSet}=require('../src/browser-runtime');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function socketReady(display){for(let n=0;n<100;n++){try{await fs.stat('/tmp/.X11-unix/X'+display);return;}catch{await pause(50);}}throw Error('Synthetic X display unavailable');}
async function exited(child){if(child.exitCode!==null||child.signalCode!==null)return;await once(child,'exit');}
async function greeting(port){for(let n=0;n<100;n++){try{return await new Promise((resolve,reject)=>{const s=net.connect(port,'127.0.0.1');s.once('data',data=>{s.destroy();resolve(data.toString('ascii'));});s.once('error',reject);s.setTimeout(500,()=>{s.destroy();reject(Error('Synthetic VNC timeout'));});});}catch{await pause(50);}}throw Error('Synthetic VNC unavailable');}
(async()=>{
 assert.match(process.env.NODE_OPTIONS||'',/desktop-lock-preload\.js/,'Exercise the actual production preload');
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wa-display-reuse-')),entries=new Map(),allChildren=[],profiles=[];await fs.chmod(base,0o711);
 async function identity(uid){const home=path.join(base,'home-'+uid),profile=path.join(base,'profile-'+uid),xauth=path.join(home,'Xauthority'),name='lock-smoke-'+uid;
  await execute('groupadd',['--gid',String(uid),name]);await execute('useradd',['--uid',String(uid),'--gid',String(uid),'--no-create-home','--home-dir',home,name]);
  for(const dir of [home,profile]){await fs.mkdir(dir,{mode:0o700});await fs.chown(dir,uid,uid);}await fs.writeFile(path.join(profile,'keep-session.marker'),'preserved');profiles.push(profile);return{uid,home,profile,xauth};
 }
 async function desktop(person,slot,{fail=false}={}){
  const display=100+slot;await execute('xauth',['-f',person.xauth,'add',':'+display,'.',crypto.randomBytes(16).toString('hex')]);await fs.chown(person.xauth,person.uid,person.uid);
  const env={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'en_US.UTF-8',TZ:'Asia/Kuala_Lumpur',HOME:person.home,DISPLAY:':'+display,XAUTHORITY:person.xauth,WA_BROWSER_UID:String(person.uid),WA_BROWSER_CPUS:await browserCpuSet(slot),LP_NUM_THREADS:'1'};
  const child=spawn('taskset',['--cpu-list',env.WA_BROWSER_CPUS,'Xvfb',':'+display,'-screen','0','1366x900x24','-nolisten','tcp','-auth',person.xauth],{env,uid:person.uid,gid:person.uid,stdio:['ignore','ignore','pipe']});allChildren.push(child);let stderr='';child.stderr.on('data',data=>stderr=(stderr+data).slice(-4096));
  const e={id:'uid-'+person.uid,uid:person.uid,slot,env,person,children:[child],sockets:[],launchAbort:new AbortController()};
  if(fail){let timer;try{await Promise.race([exited(child),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Expected lock conflict did not fail')),10000);})]);}finally{clearTimeout(timer);}assert.notEqual(child.exitCode,0);assert.match(stderr,/Could not create server lock file/);return e;}
  entries.set(e.id,e);await socketReady(display);await pause(150);assert.equal(child.exitCode,null);return e;
 }
 async function browser(e,title){const b=await puppeteer.launch({headless:false,executablePath:'/app/bin/browser',userDataDir:e.person.profile,env:e.env,signal:e.launchAbort.signal,timeout:60000,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run']});const page=(await b.pages())[0];e.client={pupBrowser:b,pupPage:page,destroy:()=>b.close()};await page.setContent('<title>'+title+'</title><canvas width="128" height="128"></canvas>');await page.evaluate(()=>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#128c7e';c.fillRect(0,0,128,128);});return page;}
 try{
  const healthy=await desktop(await identity(28011),5),healthyPage=await browser(healthy,'Healthy unrelated desktop');
  const old=await desktop(await identity(28012),6);old.children[0].kill('SIGKILL');await exited(old.children[0]);assert.equal((await fs.lstat('/tmp/.X106-lock')).uid,old.uid);
  const next=await identity(28013);await desktop(next,6,{fail:true});assert.equal((await fs.lstat('/tmp/.X106-lock')).uid,old.uid);
  assert.equal(await healthyPage.title(),'Healthy unrelated desktop');
  await lifecycle.retire(entries,old);await assert.rejects(()=>fs.lstat('/tmp/.X106-lock'),{code:'ENOENT'});await assert.rejects(()=>fs.lstat('/tmp/.X11-unix/X106'),{code:'ENOENT'});
  const replacement=await desktop(next,6),replacementPage=await browser(replacement,'Replacement independent desktop');
  for(const [port,viewOnly]of [[6196,false],[6197,true]]){const c=spawn('taskset',['--cpu-list',replacement.env.WA_BROWSER_CPUS,'x11vnc','-display',':106','-auth',next.xauth,'-rfbport',String(port),'-localhost','-forever','-shared','-nopw','-quiet',...(viewOnly?['-viewonly']:[])],{env:replacement.env,uid:next.uid,gid:next.uid,stdio:'ignore'});replacement.children.push(c);allChildren.push(c);assert.match(await greeting(port),/^RFB /);}
  assert.equal(await replacementPage.title(),'Replacement independent desktop');assert.ok((await replacementPage.screenshot()).length>500);assert.equal(await healthyPage.title(),'Healthy unrelated desktop');assert.ok((await healthyPage.screenshot()).length>500);
  // A sweeper must refuse the live identity and preserve its real X server.
  assert.equal((await require('../src/desktop-locks').clear(replacement,{settleMs:0})).removed,0);assert.equal(await replacementPage.title(),'Replacement independent desktop');
  await lifecycle.retire(entries,replacement);await assert.rejects(()=>fs.lstat('/tmp/.X106-lock'),{code:'ENOENT'});
  const third=await desktop(await identity(28014),6);assert.equal(third.children[0].exitCode,null);assert.equal(await healthyPage.title(),'Healthy unrelated desktop');
  console.log('Desktop lock reuse PASS: reproduced foreign-UID X106 lock failure; SIGKILL orphan cleared before slot release; two new identities reuse the slot; real Chromium screenshots and control/view VNC work; unrelated desktop and all profile markers preserved; network disabled');
 }finally{for(const e of [...entries.values()])await lifecycle.retire(entries,e);for(const c of allChildren)try{c.kill('SIGKILL');}catch{}for(const profile of profiles)assert.equal(await fs.readFile(path.join(profile,'keep-session.marker'),'utf8'),'preserved');await fs.rm(base,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
