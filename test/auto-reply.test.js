'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const timing=require('../src/campaign-timing'),p=require('../src/reply-providers');
test('Malaysia scheduling rejects malformed, past, wrong-zone and over-five-day values',()=>{
 const now=Date.parse('2026-11-01T04:00:00Z');assert.equal(timing.parse({send_mode:'now'},now).send_now,true);assert.equal(timing.parse({}),null);
 assert.deepEqual(timing.parse({send_mode:'later',scheduled_at:'2026-11-02T09:00:00+08:00'},now),{send_now:false,scheduled_at:'2026-11-02T01:00:00.000Z'});
 for(const s of ['2026-11-01T11:59:00+08:00','2026-11-06T12:01:00+08:00','2026-11-02T09:00:00Z','2026-11-31T09:00:00+08:00','invalid'])assert.throws(()=>timing.parse({send_mode:'later',scheduled_at:s},now));
 assert.throws(()=>timing.parse({send_mode:'wrong'},now));
});
test('WeChat secure callback round trips UTF-8, binds receiver and rejects signature/padding/XML tampering',()=>{
 const cfg={app_id:'wxsynthetic',aes_key:crypto.randomBytes(32).toString('base64').slice(0,-1),verify_token:'synthetic-verify'};
 const xml=p.wxReply('visitor','gh_synthetic','你好 & <hello>'),wrapped=p.xmlFields(p.wxEncrypt(xml,cfg,'1700000000','nonce'));
 assert.equal(p.xmlFields(p.wxDecrypt(wrapped.Encrypt,cfg)).Content,'你好 & <hello>');assert.equal(wrapped.MsgSignature,p.signature(cfg.verify_token,wrapped.TimeStamp,wrapped.Nonce,wrapped.Encrypt));
 assert.throws(()=>p.wxDecrypt(wrapped.Encrypt,{...cfg,app_id:'another-app'}));assert.equal(p.equal(wrapped.MsgSignature,'forged'),false);
 assert.throws(()=>p.wxDecrypt('abc',cfg));assert.throws(()=>p.xmlFields('<!DOCTYPE xml [<!ENTITY secret SYSTEM "file:///etc/passwd">]><xml><Content>&secret;</Content></xml>'));
 assert.throws(()=>p.xmlFields('<xml><Content>a</Content><Content>b</Content></xml>'));
});
test('Telegram setup does not replace another webhook; provider rejection differs from ambiguous transport',async()=>{
 const cfg={token:'123456789:abcdefghijklmnopqrstuvwxyz1234567890',webhook_secret:'fixture'},calls=[];
 let other=true,fail=null;const provider=p.create({fetcher:async(u,o)=>{calls.push({u,body:JSON.parse(o.body||'{}')});if(fail==='network')throw Error('private-secret');if(fail==='reject')return new Response('{"ok":false}',{status:400});return new Response(JSON.stringify({ok:true,result:u.pathname.endsWith('getMe')?{id:123456789,is_bot:true}:u.pathname.endsWith('getWebhookInfo')?{url:other?'https://elsewhere.invalid/hook':''}:u.pathname.endsWith('sendMessage')?{message_id:42}:true}));}});
 await assert.rejects(provider.connect('telegram',cfg,'https://mywasap.example/hook'),/another webhook/);assert.equal(calls.some(c=>c.u.pathname.endsWith('setWebhook')),false);
 other=false;assert.equal(await provider.connect('telegram',cfg,'https://mywasap.example/hook'),'123456789');assert.equal(calls.find(c=>c.u.pathname.endsWith('setWebhook')).body.drop_pending_updates,false);
 assert.equal(await provider.send('telegram',cfg,'77','Reply'),'42');fail='reject';await assert.rejects(provider.send('telegram',cfg,'77','Reply'),e=>e.code==='REPLY_REJECTED');fail='network';await assert.rejects(provider.send('telegram',cfg,'77','Reply'),e=>e.code==='REPLY_UNKNOWN'&&!e.message.includes('private-secret'));
});
test('Messenger binds page, bearer auth and app proof, and sends only a response',async()=>{
 const cfg={page_id:'123456',access_token:'synthetic-token',app_secret:'synthetic-secret',verify_token:'synthetic-verify'},calls=[];
 const provider=p.create({fetcher:async(u,o)=>{calls.push({u,o});return new Response(JSON.stringify(o.method==='GET'?{id:'123456'}:u.pathname.endsWith('/messages')?{recipient_id:'789012',message_id:'mid.fixture'}:{success:true}));}});
 assert.equal(await provider.connect('messenger',cfg,'https://example.invalid/hook'),'123456');assert.equal(await provider.send('messenger',cfg,'789012','Reply'),'mid.fixture');
 const last=calls.at(-1);assert.equal(last.u.hostname,'graph.facebook.com');assert.equal(last.o.headers.Authorization,'Bearer synthetic-token');assert.equal(last.u.searchParams.has('appsecret_proof'),true);assert.equal(JSON.parse(last.o.body).messaging_type,'RESPONSE');
});
