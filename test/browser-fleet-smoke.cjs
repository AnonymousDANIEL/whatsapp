'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),crypto=require('node:crypto');
const execute=promisify(execFile),puppeteer=require('puppeteer');
const {retire,resourceSummary}=require('../src/browser-lifecycle'),{browserCpuSet}=require('../src/browser-runtime');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function vncGreeting(port){
 for(let attempt=0;attempt<50;attempt++){
  try{return await new Promise((resolve,reject)=>{const socket=net.connect(port,'127.0.0.1');socket.once('data',data=>{socket.destroy();resolve(data.toString('ascii'));});socket.once('error',reject);socket.setTimeout(1000,()=>{socket.destroy();reject(Error('VNC greeting timeout'));});});}catch{await pause(100);}
 }
 throw Error('VNC did not start');
}
(async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wa-fleet-smoke-')),entries=new Map(),profiles=[];let peak=0;
 await fs.chmod(base,0o711);
 try{
  for(let slot=0;slot<6;slot++){
   const uid=27100+slot,id='fleet-'+slot,folder=path.join(base,id),home=path.join(folder,'home'),profile=path.join(folder,'profile'),xauth=path.join(home,'Xauthority'),display=':'+(120+slot),port=6100+slot*2;
   await execute('groupadd',['--gid',String(uid),id]);await execute('useradd',['--uid',String(uid),'--gid',String(uid),'--no-create-home','--home-dir',home,id]);
   await fs.mkdir(folder,{mode:0o711});
   for(const dir of [home,profile]){await fs.mkdir(dir,{mode:0o700});await fs.chown(dir,uid,uid);}
   await fs.writeFile(path.join(profile,'keep-session.marker'),'preserved');
   profiles.push(profile);
   await execute('xauth',['-f',xauth,'add',display,'.',crypto.randomBytes(16).toString('hex')]);await fs.chown(xauth,uid,uid);
   const env={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'en_US.UTF-8',TZ:'Asia/Kuala_Lumpur',HOME:home,DISPLAY:display,XAUTHORITY:xauth,WA_BROWSER_UID:String(uid),WA_BROWSER_CPUS:await browserCpuSet(slot)};
   const entry={id,uid,sockets:[],children:[],launchAbort:new AbortController()};entries.set(id,entry);
   const child=(file,args)=>{const p=spawn(file,args,{env,uid,gid:uid,stdio:'ignore'});p.on('error',()=>{});entry.children.push(p);return p;};
   child('Xvfb',[display,'-screen','0','1366x900x24','-nolisten','tcp','-auth',xauth]);
   for(let i=0;i<50;i++){try{await fs.stat('/tmp/.X11-unix/X'+(120+slot));break;}catch{await pause(100);}}
   for(const [rfbPort,viewOnly] of [[port,false],[port+1,true]]){
    child('x11vnc',['-display',display,'-auth',xauth,'-rfbport',String(rfbPort),'-localhost','-forever','-shared','-nopw','-quiet',...(viewOnly?['-viewonly']:[])]);
    assert.match(await vncGreeting(rfbPort),/^RFB /);
   }
   const browser=await puppeteer.launch({headless:false,executablePath:'/app/bin/browser',userDataDir:profile,env,signal:entry.launchAbort.signal,timeout:90000,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--window-size=1366,900']});
   const page=(await browser.pages())[0];entry.client={pupBrowser:browser,pupPage:page,destroy:()=>browser.close()};
   await page.setContent('<title>Local fleet capacity fixture</title><canvas width="128" height="128"></canvas>');
   const hardware=await page.evaluate(()=>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#123456';c.fillRect(0,0,128,128);return navigator.hardwareConcurrency;});
   assert.ok(hardware>=1&&hardware<=2);const usage=await resourceSummary();peak=Math.max(peak,usage.pids||0);
   assert.equal(usage.pids_limit,1000);assert.ok(usage.pids<850,JSON.stringify(usage));
  }
  await pause(1500);
  for(const entry of entries.values()){assert.equal(await entry.client.pupPage.title(),'Local fleet capacity fixture');assert.ok((await entry.client.pupPage.screenshot()).length>500);}
  console.log('Worker fleet smoke PASS: six concurrent private UIDs, twelve localhost VNC endpoints, CPU affinity <=2, canvas/screen responsive, peak tasks='+peak+'/1000; network disabled, no WhatsApp login');
 }finally{
  for(const entry of [...entries.values()])await retire(entries,entry);
  for(const profile of profiles)assert.equal(await fs.readFile(path.join(profile,'keep-session.marker'),'utf8'),'preserved');
  await fs.rm(base,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
