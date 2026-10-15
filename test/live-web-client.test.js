'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {EventEmitter}=require('node:events');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {LiveWebClient}=require('../src/live-web-client');

test('Disabled Web cache survives an unavailable response body without a process-wide rejection',()=>{
 function run(moduleName,className){
  const script=`
   const {EventEmitter}=require('node:events');
   const Client=require(${JSON.stringify(moduleName)})[${JSON.stringify(className)}];
   (async()=>{
    const client=new Client({webVersionCache:{type:'none'}});
    client.pupPage=new EventEmitter();
    await client.initWebVersionCache();
    client.pupPage.emit('response',{ok:()=>true,url:()=> 'https://web.whatsapp.com/',text:async()=>{throw Error('UNAVAILABLE_RESPONSE_BODY');}});
    await new Promise(resolve=>setImmediate(resolve));
    console.log('worker-survived');
   })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  return spawnSync(process.execPath,['--unhandled-rejections=strict','-e',script],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:5000,maxBuffer:20000});
 }
 const upstream=run('whatsapp-web.js','Client');
 assert.notEqual(upstream.status,0,'Pinned upstream must reproduce the observed fatal response-capture failure');
 assert.match(upstream.stderr,/UNAVAILABLE_RESPONSE_BODY/);
 const fixed=run('./src/live-web-client','LiveWebClient');
 assert.equal(fixed.status,0,fixed.stderr);
 assert.match(fixed.stdout,/worker-survived/);
 assert.equal(fixed.stderr,'');
});

test('An explicitly configured local Web cache retains upstream cached-page and pass-through behavior',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'wa-web-cache-'));
 try{
  const html='<html><title>Disposable cached fixture</title></html>';
  await fs.writeFile(path.join(folder,'fixture-version.html'),html);
  const client=new LiveWebClient({webVersion:'fixture-version',webVersionCache:{type:'local',path:folder,strict:true}});
  const page=new EventEmitter();let interception=false;page.setRequestInterception=async value=>{interception=value;};client.pupPage=page;
  await client.initWebVersionCache();assert.equal(interception,true);
  const [handler]=page.listeners('request');assert.equal(typeof handler,'function');
  let response,continued=0;
  await handler({url:()=> 'https://web.whatsapp.com/',respond:body=>{response=body;}});
  assert.deepEqual(response,{status:200,contentType:'text/html',body:html});
  await handler({url:()=> 'https://example.invalid/fixture.js',continue:()=>{continued++;}});
  assert.equal(continued,1);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});
