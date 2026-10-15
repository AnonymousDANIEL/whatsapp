'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),express=require('express');
const s=require('../src/http-security');
async function fixture(t,setup) {
  const app=express();setup(app);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return async(path='/',{method='GET',host='mywasap.com',headers={},body=null}={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path,method,headers:{Host:host,...headers}},res=>{
      let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data}));
    });req.on('error',reject);req.end(body);
  });
}
test('Production addresses require HTTPS and fixed origins; proxy trust is bounded',()=>{
  for(const value of ['ftp://mywasap.com','http://mywasap.com','https://user:pass@mywasap.com','https://mywasap.com/path','https://mywasap.com/?next=other','https://mywasap.com/#other','bad'])assert.throws(()=>s.publicAddress(value),{code:'STARTUP_CONFIG_INVALID'});
  for(const value of ['https://mywasap.com','http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000'])assert.ok(s.publicAddress(value));
  for(const value of ['true','-1','6','1.5','NaN','Infinity',''])assert.throws(()=>s.proxyHops(value),{code:'STARTUP_CONFIG_INVALID'});
  assert.equal(s.proxyHops(),1);assert.equal(s.proxyHops('0'),0);
});
test('Raw service and www aliases redirect safely; only health checks and exact signed callbacks bypass the host gate',async t=>{
  const request=await fixture(t,app=>{app.use(s.requireCanonicalHost(s.publicAddress('https://mywasap.com')));app.use((req,res)=>res.status(204).end());});
  assert.equal((await request('/api/me')).status,204);
  assert.equal((await request('/',{host:'MYWASAP.COM'})).status,204);
  for(const host of ['whatsapp-production-04f4.up.railway.app','www.mywasap.com','evil.example']){
    const r=await request('/?page=credits&lang=en',{host,headers:{'X-Forwarded-Host':'mywasap.com'}});
    assert.equal(r.status,308);assert.equal(r.headers.location,'https://mywasap.com/?page=credits&lang=en');
    assert.equal((await request('/api/login',{host,method:'POST'})).status,421);
    assert.equal((await request('/healthz',{host})).status,204);
    assert.equal((await request('/healthz',{host,method:'POST'})).status,421);
    for(const path of ['/api/payments/callback/12345678-abcd-abcd-abcd-123456789abc','/api/banks/feed/12345678-abcd-abcd-abcd-123456789abc']){
      assert.equal((await request(path,{host,method:'POST'})).status,204);
      assert.equal((await request(path+'/extra',{host,method:'POST'})).status,421);
    }
  }
  for(const path of ['//evil.example/x?next=https://evil.example','/\\evil.example/x','/%2f%2fevil.example'])assert.equal(new URL((await request(path,{host:'evil.example'})).headers.location).origin,'https://mywasap.com');
  assert.equal(s.canonicalHost({headers:{host:'evil.example','x-forwarded-host':'mywasap.com'}},s.publicAddress('https://mywasap.com')),false);
});
test('Malformed login bodies are refused before credential checks; account throttles span different IPs and ignore successful logins',async t=>{
  let attempts=0;
  const request=await fixture(t,app=>{
    app.use(express.json({limit:'4kb'}));
    app.post('/api/login',s.validLoginBody,s.loginAccountLimiter({limit:2}), (req,res)=>{attempts++;res.status(req.body.password==='correct'?200:401).json({ok:req.body.password==='correct'});});
    app.use((err,req,res,next)=>res.status(err.status||500).end());
  });
  const login=(username,password='wrong',ip='192.0.2.1')=>request('/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':ip},body:JSON.stringify({username,password})});
  assert.equal((await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'null'})).status,400);
  for(const body of ['{}',JSON.stringify({username:['user'],password:'x'}),JSON.stringify({username:'x'.repeat(41),password:'x'}),JSON.stringify({username:'user',password:'x'.repeat(201)})]){
    assert.equal((await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);
  }
  assert.equal(attempts,0);
  assert.equal((await login('large','x'.repeat(5000))).status,413);assert.equal(attempts,0);
  for(let i=0;i<4;i++)assert.equal((await login('valid','correct')).status,200);
  assert.equal((await login('test','wrong','192.0.2.1')).status,401);
  assert.equal((await login('test','wrong','192.0.2.2')).status,401);
  assert.equal((await login('TEST','wrong','192.0.2.3')).status,429);
  assert.equal((await login('other','wrong')).status,401);
});
test('Legacy domain redirects retain routes without open redirects or credential forwarding',async()=>{
  const {handleRequest}=await import('../cloudflare/legacy-domain.mjs');let calls=0;
  const upstream=async()=>{calls++;throw Error('not expected');};
  for(const path of ['/?payment=123&lang=en','/viewer.html?id=123','//evil.example/path','/%2f%2fevil.example']){
    const r=await handleRequest(new Request('https://whatsapp.facecustomer.workers.dev'+path),upstream);
    assert.equal(r.status,308);const target=new URL(r.headers.get('location'));assert.equal(target.origin,'https://mywasap.com');assert.equal(target.search,new URL('https://old.example'+path).search);
  }
  const r=await handleRequest(new Request('https://old.example/api/login',{method:'POST',body:'secret',headers:{Origin:'https://evil.example',Cookie:'wa_session=secret',Authorization:'secret'}}),upstream);
  assert.equal(r.status,421);assert.equal(calls,0);
});
test('Legacy signed callbacks preserve exact body/signatures, reject path tricks and never forward cookies or follow redirects',async()=>{
  const {handleRequest}=await import('../cloudflare/legacy-domain.mjs');
  for(const [path,contentType,body] of [['banks/feed','application/json','{"in":[1], "signed":"exact bytes"}'],['payments/callback','application/x-www-form-urlencoded','x_signature=abc&paid=true&amount=100']]){
    const r=await handleRequest(new Request('https://old.example/api/'+path+'/12345678-abcd-abcd-abcd-123456789abc',{method:'POST',headers:{'Content-Type':contentType,'X-Bank-Timestamp':'123','X-Bank-Signature':'sig',Cookie:'private',Authorization:'private',Origin:'https://evil.example','X-Forwarded-Host':'evil.example'},body}),async(url,options)=>{
      assert.equal(new URL(url).origin,'https://mywasap.com');assert.equal(options.redirect,'manual');
      for(const name of ['cookie','authorization','origin','x-forwarded-host'])assert.equal(options.headers.has(name),false);
      assert.equal(options.headers.get('content-type'),contentType);assert.equal(options.headers.get('x-bank-signature'),'sig');
      assert.equal(await new Response(options.body).text(),body);
      return new Response('verified only by API',{status:403,headers:{'Content-Type':'application/json','Set-Cookie':'private'}});
    });
    assert.equal(r.status,403);assert.equal(await r.text(),'verified only by API');assert.equal(r.headers.has('set-cookie'),false);
  }
  assert.equal((await handleRequest(new Request('https://old.example/api/banks/feed/12345678-abcd-abcd-abcd-123456789abc/extra',{method:'POST'}),()=>assert.fail('unexpected forwarding'))).status,421);
  const queue='/api/banks/feed/12345678-abcd-abcd-abcd-123456789abc/queue?page=2';
  const read=await handleRequest(new Request('https://old.example'+queue,{headers:{'X-Bank-Signature':'a'.repeat(64),'X-Bank-Timestamp':'123'}}),async(url,options)=>{
    assert.equal(url,'https://mywasap.com'+queue);assert.equal(options.method,'GET');assert.equal(options.body,null);assert.equal(options.headers.get('x-bank-signature'),'a'.repeat(64));
    return new Response('signed data',{status:200});
  });assert.equal(await read.text(),'signed data');
});
