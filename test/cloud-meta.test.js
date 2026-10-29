'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const meta=require('../src/cloud-meta');
const cfg={app_id:'123456789',app_secret:'synthetic-app-secret',graph_version:'v26.0'};
test('Cloud API validation preserves international identity and rejects unsafe profile fields',()=>{
 assert.equal(meta.phone('+60 12-345 6789').number,'+60123456789');for(const v of ['123','<script>',null])assert.throws(()=>meta.phone(v));
 const b={vertical:'RETAIL',description:'Synthetic shop <b>',address:'Synthetic street',email:'synthetic@example.invalid',websites:['https://example.invalid'],business_hours:'9–5'};
 assert.equal(meta.profile(b).business_hours,undefined);assert.equal(meta.profile(b).description,b.description);
 for(const v of ['javascript:alert(1)','https://user:pass@example.invalid','file:///tmp/key'])assert.throws(()=>meta.profile({...b,websites:[v]}));
 assert.throws(()=>meta.profile({...b,description:'x'.repeat(513)}));assert.throws(()=>meta.profile({...b,vertical:'invented'}));
});
test('Cloud webhook signature validates exact bytes and rejects forged, truncated or modified bodies',()=>{
 const raw=Buffer.from('{"synthetic":true}'),sig='sha256='+crypto.createHmac('sha256','secret').update(raw).digest('hex');
 assert.equal(meta.signature(raw,sig,'secret'),true);for(const [b,s,k]of [[Buffer.from('{}'),sig,'secret'],[raw,sig,'other'],[raw,'sha256=x','secret'],[{},sig,'secret']])assert.equal(meta.signature(b,s,k),false);
 assert.equal(meta.equal('one','one'),true);assert.equal(meta.equal('one','two'),false);assert.equal(meta.equal('',''),false);
});
test('Graph transport uses fixed HTTPS origin, proof, timeout and no redirects; failed writes never retry',async()=>{
 const calls=[],m=meta.client(cfg,{fetcher:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({error:{code:190,message:'never expose secret-token'}}),{status:400});}});
 await assert.rejects(m.request('123456789/messages',{method:'POST',token:'synthetic-token',body:{text:'fixture'}}),e=>e.metaCode===190&&e.definite&&e.message==='CLOUD_META_ERROR'&&!JSON.stringify(e).includes('secret-token'));
 assert.equal(calls.length,1);assert.equal(calls[0].url.origin,'https://graph.facebook.com');assert.equal(calls[0].url.pathname,'/v26.0/123456789/messages');assert.equal(calls[0].options.redirect,'error');assert.ok(calls[0].options.signal);assert.equal(calls[0].url.searchParams.get('access_token'),null);assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-token');assert.equal(calls[0].url.searchParams.get('appsecret_proof'),crypto.createHmac('sha256',cfg.app_secret).update('synthetic-token').digest('hex'));
 for(const p of ['https://evil.invalid','//evil.invalid','12345/../../secret','12345/messages?access_token=x'])await assert.rejects(m.request(p));assert.equal(calls.length,1);
});
test('timeouts and server errors stay uncertain; response bounds and identity/permission checks fail closed',async()=>{
 for(const fetcher of [async()=>{throw Error('token in network stack');},async()=>new Response('{}',{status:502}),async()=>new Response('invalid'),async()=>new Response('x'.repeat(1024*1024+1))]){await assert.rejects(meta.client(cfg,{fetcher}).request('123456789/messages',{method:'POST',token:'private',body:{}}),e=>!e.definite);}
 let calls=0;const exchange=app_id=>meta.client(cfg,{fetcher:async()=>{calls++;return new Response(JSON.stringify(calls%2?{access_token:'synthetic-access-token-1234567890'}:{data:{is_valid:true,app_id,scopes:['whatsapp_business_management','whatsapp_business_messaging']}}));}});
 await assert.rejects(exchange('999999999').exchange('synthetic-code'),/CLOUD_META_PERMISSION/);assert.equal((await exchange(cfg.app_id).exchange('synthetic-code')).token,'synthetic-access-token-1234567890');
});
test('WABA membership follows only bounded cursors, never an upstream next URL',async()=>{
 const urls=[],m=meta.client(cfg,{fetcher:async u=>{urls.push(u.href);return new Response(JSON.stringify(urls.length===1?{data:[],paging:{next:'https://evil.invalid/steal',cursors:{after:'safe-cursor'}}}:{data:[{id:'345678901',display_phone_number:'+60123456789'}]}));}});
 assert.equal((await m.member('token','234567890','345678901')).id,'345678901');assert.ok(urls.every(u=>u.startsWith('https://graph.facebook.com/')));assert.match(urls[1],/after=safe-cursor/);
});
