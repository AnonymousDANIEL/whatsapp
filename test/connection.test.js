const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createWorkerConnection } = require('../src/connection');
test('browser connection diagnostics use authenticated HTTP and never expose upstream secrets', async t => {
 const secret='fake-connection-secret-not-used-in-production',account={id:'fixture',worker_group:'group-a'};
 let code=200,body={role:'worker',group:'group-a',status:'scan_required',screen_ready:true,connected:false},authorized=false;
 const server=http.createServer((req,res)=>{authorized=req.headers.authorization==='Bearer '+secret;res.writeHead(code,{'Content-Type':typeof body==='string'?'text/html':'application/json'});res.end(typeof body==='string'?body:JSON.stringify(body));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const browser=createWorkerConnection({'group-a':'http://127.0.0.1:'+server.address().port},secret);
 await t.test('ready desktop is distinct from authenticated WhatsApp',async()=>{const result=await browser.status(account);assert.equal(authorized,true);assert.equal(result.screen_ready,true);assert.equal(result.connected,false);});
 const reject=async(code,operation=()=>browser.status(account))=>assert.rejects(operation,error=>error.code===code&&error.publicMessage===true&&!error.message.includes(secret)&&!error.message.includes('127.0.0.1'));
 await t.test('missing or invalid addresses are actionable',async()=>{
  await reject('WORKER_NOT_CONFIGURED',()=>createWorkerConnection({},secret).status(account));
  await reject('WORKER_ROUTE_INVALID',()=>createWorkerConnection({'group-a':'ftp://localhost'},secret).status(account));
  await reject('WORKER_UNREACHABLE',()=>createWorkerConnection({'group-a':'http://127.0.0.1:9'},secret).status(account));
 });
 await t.test('wrong secret is distinguished from an offline service',async()=>{code=401;body='Unauthorized';await reject('WORKER_AUTH_FAILED');});
 await t.test('wrong group and management-service responses are rejected',async()=>{
  code=200;body={role:'worker',group:'group-b',screen_ready:true,connected:false};await reject('WORKER_GROUP_MISMATCH');
  body={ok:true,role:'api'};await reject('WORKER_RESPONSE_INVALID');
 });
 await t.test('a missing status endpoint identifies a mismatched deployment',async()=>{code=404;body='Not found';await reject('WORKER_UPDATE_REQUIRED');});
 await t.test('upstream HTML and exceptions do not leak into the user error',async()=>{
  code=200;body='<html>'+secret+'</html>';await reject('WORKER_RESPONSE_INVALID');
  code=500;body={error:secret};await reject('BROWSER_START_FAILED',()=>browser.request(account,'/accounts/fixture/start','POST'));
 });
 await t.test('failed startup cannot be reported as success',async()=>{
  code=200;body={ok:false};await reject('BROWSER_START_FAILED',()=>browser.request(account,'/accounts/fixture/start','POST'));
  body={ok:true};assert.deepEqual(await browser.request(account,'/accounts/fixture/start','POST'),{ok:true});
 });
});
