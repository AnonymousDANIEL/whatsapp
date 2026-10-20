'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const history=require('../src/login-history');
test('login network: only the configured ingress supplies IP, never client forwarding claims',()=>{
 const req={headers:{'x-real-ip':'8.8.8.8','x-forwarded-for':'1.1.1.1','cf-connecting-ip':'9.9.9.9','user-agent':'Synthetic browser'},socket:{remoteAddress:'::ffff:127.0.0.1'}};
 assert.deepEqual(history.requestContext(req,{}),{version:1,ip:'127.0.0.1',ip_source:'direct_socket',user_agent:'Synthetic browser',geo_status:'unavailable'});
 const env={RAILWAY_ENVIRONMENT_ID:'synthetic-env',RAILWAY_SERVICE_ID:'synthetic-api'};
 assert.equal(history.requestContext(req,env).ip,'8.8.8.8');assert.equal(history.requestContext(req,env).ip_source,'railway_edge');
 for(const value of [undefined,'8.8.8.8, 1.1.1.1','not-an-ip','[2001:4860:4860::8888]','fe80::1%eth0']){req.headers['x-real-ip']=value;assert.equal(history.requestContext(req,env).ip,null);}
 req.headers['user-agent']='bad\u0000\r\n'+ 'a'.repeat(3000);const ua=history.requestContext(req,env).user_agent;assert.equal(ua.length,2048);assert.doesNotMatch(ua,/[\u0000-\u001f]/);
});
test('login network: canonical IPs and public-only lookup deny private, mapped, special and documentation addresses',()=>{
 assert.equal(history.normalizeIP('::ffff:8.8.8.8'),'8.8.8.8');assert.equal(history.normalizeIP('2001:4860:4860:0:0:0:0:8888'),'2001:4860:4860::8888');
 for(const ip of ['8.8.8.8','1.1.1.1','2001:4860:4860::8888'])assert.equal(history.publicIP(ip),true,ip);
 for(const ip of ['127.0.0.1','::1','::ffff:10.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.1.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','2001:db8::1','fe80::1','fc00::1','3fff::1','bad'])assert.equal(history.publicIP(ip),false,ip);
});
test('login network: anonymous/full provider data is bounded, exact-IP matched and leaves unknown fields empty',()=>{
 assert.deepEqual(history.parseLookup({ip:'8.8.8.8',asn:'AS15169 Google LLC',city:'Synthetic City',country:'Synthetic Country'},'8.8.8.8'),{isp:'Google LLC',city:'Synthetic City',country:'Synthetic Country'});
 assert.deepEqual(history.parseLookup({ip:'8.8.8.8',company:{type:'isp',name:'Synthetic ISP'},asn:{org:'Network'},location:{city:'City',country:'Country'}},'8.8.8.8'),{isp:'Synthetic ISP',city:'City',country:'Country'});
 assert.deepEqual(history.parseLookup({ip:'8.8.8.8',company:'Customer company'},'8.8.8.8'),{isp:null,city:null,country:null});
 for(const data of [{ip:'1.1.1.1'}, {ip:'8.8.8.8',error:'bad'}, {ip:'8.8.8.8',is_bogon:true},null])assert.throws(()=>history.parseLookup(data,'8.8.8.8'));
 assert.equal(history.parseLookup({ip:'8.8.8.8',city:'x'.repeat(500)},'8.8.8.8').city.length,256);
});
test('login network: lookup uses fixed HTTPS, no redirects or identity data, bounded body, timeout and quota backoff',async()=>{
 let called=0;const fetcher=async(url,options)=>{called++;assert.equal(url,'https://api.ipapi.is/');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{q:'8.8.8.8',key:'synthetic-test-key'});return new Response(JSON.stringify({ip:'8.8.8.8',city:'Kuala Lumpur',country:'Malaysia'}));};
 assert.equal((await history.lookup('8.8.8.8',{fetcher,key:'synthetic-test-key'})).city,'Kuala Lumpur');assert.equal(called,1);
 await assert.rejects(()=>history.lookup('127.0.0.1',{fetcher}));assert.equal(called,1);
 await assert.rejects(()=>history.lookup('8.8.8.8',{fetcher:async()=>new Response('x'.repeat(65537))}),/TOO_LARGE/);
 for(const status of [403,429])await assert.rejects(()=>history.lookup('8.8.8.8',{fetcher:async()=>new Response('',{status})}),e=>e.blocked===true);
 await assert.rejects(()=>history.lookup('8.8.8.8',{fetcher:async()=>new Response(JSON.stringify({ip:'1.1.1.1'}))}),/INVALID_IP_LOOKUP/);
 // The fake transport retains its own small timer, as a real socket does.
 await assert.rejects(()=>history.lookup('8.8.8.8',{timeoutMs:10,fetcher:async(url,{signal})=>new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1000);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('Synthetic timeout'));});})}),/timeout/);
});
test('login network: cursors retain PostgreSQL microsecond precision and reject invalid or unbounded input',()=>{
 const c={time:'2026-10-20 12:31:06.123456+00',id:'9223372036854775807'};assert.deepEqual(history.decodeCursor(Buffer.from(JSON.stringify(c)).toString('base64url')),c);assert.equal(history.decodeCursor(),null);
 for(const c of ['*','a'.repeat(301),Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({time:'invalid',id:'1'})).toString('base64url'),Buffer.from(JSON.stringify({time:'2026-10-20T12:31:06Z',id:'-1'})).toString('base64url')])assert.throws(()=>history.decodeCursor(c));
});
