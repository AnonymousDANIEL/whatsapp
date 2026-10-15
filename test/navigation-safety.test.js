'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {EventEmitter}=require('node:events');
const {LiveWebClient}=require('../src/live-web-client');
function nativeFrameHandler(client){
 const {Client}=require('whatsapp-web.js');
 const match=Client.prototype.initialize.toString().match(/this\.pupPage\.on\('framenavigated', (async \(frame\) => \{[\s\S]*?\n        \})\);/);
 if(!match)throw Error('Pinned frame handler changed; review this regression');
 return Function('Events','return ('+match[1]+')').call(client,require('whatsapp-web.js/src/util/Constants').Events);
}
async function fixture(){
 const client=new LiveWebClient({webVersionCache:{type:'none'}}),page=new EventEmitter();
 page.isClosed=()=>false;client.pupPage=page;
 client.authStrategy={logout:async()=>{},beforeBrowserInitialized:async()=>{},afterBrowserInitialized:async()=>{},destroy:async()=>{}};
 await client.initWebVersionCache();return {client,page};
}
test('The actual pinned post-logout frame callback crashes an unguarded process, but stays account-scoped with the guard',()=>{
 function run(fixed){
  const script=`
   const {EventEmitter}=require('node:events');
   const C=require(${JSON.stringify(fixed?'./src/live-web-client':'whatsapp-web.js')})[${JSON.stringify(fixed?'LiveWebClient':'Client')}];
   ${nativeFrameHandler.toString()}
   (async()=>{
    const client=new C({webVersionCache:{type:'none'}}),page=new EventEmitter();page.isClosed=()=>false;client.pupPage=page;
    client.authStrategy={logout:async()=>{},beforeBrowserInitialized:async()=>{},afterBrowserInitialized:async()=>{},destroy:async()=>{}};
    client.inject=async()=>{throw Error('Execution context was destroyed');};
    let failures=0;client.on('workspace_navigation_error',code=>{if(code!=='WHATSAPP_NAVIGATION_CONTEXT_CHANGED')throw Error('Wrong category');failures++;});
    const globalHandlers=process.listenerCount('unhandledRejection');await client.initWebVersionCache();page.on('framenavigated',nativeFrameHandler(client));
    page.emit('framenavigated',{url:()=> 'https://web.whatsapp.com/?post_logout=1'});
    await new Promise(resolve=>setImmediate(resolve));
    if(failures!==1||process.listenerCount('unhandledRejection')!==globalHandlers)throw Error('Guard/global handler regression');
    console.log('worker-survived-scoped-navigation');
   })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  return spawnSync(process.execPath,['--unhandled-rejections=strict','-e',script],{cwd:require('node:path').resolve(__dirname,'..'),encoding:'utf8',timeout:5000,maxBuffer:20000});
 }
 const upstream=run(false);assert.notEqual(upstream.status,0);assert.match(upstream.stderr,/Execution context was destroyed/);
 const fixed=run(true);assert.equal(fixed.status,0,fixed.stderr);assert.match(fixed.stdout,/worker-survived-scoped-navigation/);assert.equal(fixed.stderr,'');
});
test('Retiring one account contains pending frame failures and leaves another account operational',async()=>{
 const a=await fixture(),b=await fixture();let reject,other=0,failures=0;
 const pending=new Promise((_,no)=>reject=no);a.client.inject=()=>pending;b.client.inject=async()=>{other++;};
 a.client.on('workspace_navigation_error',()=>failures++);
 a.page.on('framenavigated',nativeFrameHandler(a.client));b.page.on('framenavigated',nativeFrameHandler(b.client));
 a.page.emit('framenavigated',{url:()=> 'https://web.whatsapp.com/'});
 a.client.beginWorkspaceShutdown();reject(Error('Execution context was destroyed'));
 a.page.on('framenavigated',async()=>{throw Error('Late initialize callback must not register');});
 a.page.emit('framenavigated',{url:()=> 'https://web.whatsapp.com/?post_logout=1'});
 b.page.emit('framenavigated',{url:()=> 'https://web.whatsapp.com/'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(failures,0);assert.equal(other,1);assert.equal(a.page.listenerCount('framenavigated'),0);assert.equal(b.page.listenerCount('framenavigated'),1);
 a.page.emit('close');assert.equal(a.page.listenerCount('close'),0);
 await a.client.destroy();await b.client.destroy();
});
test('Navigation wrappers preserve off/duplicate-listener semantics and release listeners on close',async()=>{
 const {client,page}=await fixture();let calls=0;const listener=async()=>{calls++;};
 page.on('framenavigated',listener);page.on('framenavigated',listener);page.off('framenavigated',listener);
 page.emit('framenavigated',{});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 page.off('framenavigated',listener);assert.equal(page.listenerCount('framenavigated'),0);
 page.on('framenavigated',listener);page.emit('close');assert.equal(page.listenerCount('framenavigated'),0);assert.equal(page.listenerCount('close'),0);
 await client.destroy();
});
test('Startup injection errors still reject normally; a deliberately retired client performs no new injection',async()=>{
 const client=new LiveWebClient({webVersionCache:{type:'none'}});let evaluations=0;
 client.pupPage={evaluate:async()=>{evaluations++;throw Error('STARTUP_INJECTION_FAILURE');}};
 await assert.rejects(client.inject(),/STARTUP_INJECTION_FAILURE/);assert.equal(evaluations,1);
 client.beginWorkspaceShutdown();await client.inject();assert.equal(evaluations,1);
});
