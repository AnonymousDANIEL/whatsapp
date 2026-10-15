'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {LoadUtils}=require('whatsapp-web.js/src/util/Injected/Utils');
const {installSendFixture}=require('./send-fixture.cjs');
const {browserPrepareSend,browserCommitSend,browserDiscardSend,browserSendReadiness,sendFailureCode}=require('../src/workspace-send');
const image={mimetype:'image/png',filename:'photo.png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII='};
function fixture(t){const previous=global.window;global.window={atob:global.atob};LoadUtils();const f=installSendFixture();t.after(()=>{global.window=previous;});return f;}
test('Pinned sender enqueues one inline image with the exact caption, gets its ID without server wait or full serialization',async t=>{
 const f=fixture(t),caption='Taniah bossku! 中文\nTwo lines 🎉';
 const prepared=await browserPrepareSend('image','60000000000@c.us',caption,image,Date.now()+5000);
 assert.equal(prepared.filehash,'synthetic-processed-image-hash');assert.equal(f.sent.length,0);
 const result=await browserCommitSend('image');assert.ok(result.message.id);assert.equal(result.message.ack,0);assert.equal(result.message.body,caption);assert.equal(result.message.type,'image');
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].caption,caption);assert.equal(f.sent[0].type,'image');assert.equal(f.uploads,1);assert.equal(f.preparations,1);assert.equal(f.serializations,0);assert.equal(f.seen,0);
 assert.equal((await browserCommitSend('image')).notSent,true);assert.equal(f.sent.length,1);
});
test('Text and image-only sends keep their content and each create exactly one message',async t=>{
 const f=fixture(t);
 for(const [token,body,media] of [['text','hello',null],['photo','',image]]){
  await browserPrepareSend(token,'60000000000@c.us',body,media,Date.now()+5000);
  const result=await browserCommitSend(token);assert.equal(result.message.body,body);assert.equal(result.message.type,media?'image':'chat');
 }
 assert.equal(f.sent.length,2);assert.equal(f.uploads,1);
});
test('Media upload failures cannot enqueue and expose no message data',async t=>{
 const f=fixture(t);f.uploadFails=true;
 await assert.rejects(browserPrepareSend('bad','60000000000@c.us','private caption',image,Date.now()+5000));
 assert.equal(f.sent.length,0);assert.equal(window.__mywasapPreparedSends.size,0);assert.equal((await browserCommitSend('bad')).notSent,true);
 assert.equal(sendFailureCode(Error('private caption +60000000000'),'prepare'),'MEDIA_PREPARATION_FAILED');
});
test('Cancelled or expired preparations cannot send later after their upload completes',async t=>{
 const f=fixture(t);let release;f.waitPreparation=new Promise(resolve=>release=resolve);
 const work=browserPrepareSend('cancel','60000000000@c.us','caption',image,Date.now()+5000);
 await new Promise(resolve=>setImmediate(resolve));browserDiscardSend('cancel');release();await assert.rejects(work,/EXPIRED/);
 assert.equal((await browserCommitSend('cancel')).notSent,true);assert.equal(f.sent.length,0);
 await assert.rejects(browserPrepareSend('expired','60000000000@c.us','text',null,Date.now()-1),/EXPIRED/);
 assert.equal(f.sent.length,0);
});
test('An uncertain enqueue consumes its token and cannot duplicate the send',async t=>{
 const f=fixture(t);f.enqueueFails=true;
 await browserPrepareSend('once','60000000000@c.us','caption',image,Date.now()+5000);
 assert.equal((await browserCommitSend('once')).code,'SEND_API_ERROR_REVIEW_REQUIRED');
 assert.equal((await browserCommitSend('once')).notSent,true);
});
test('Read-only runtime probe reaches the real builder boundary without invoking send/upload or changing live APIs',async t=>{
 const f=fixture(t),sender=window.WWebJS.sendMessage,action=window.require('WAWebSendMsgChatAction').addAndSendMsgToChat;
 const report=await browserSendReadiness();assert.equal(report.ok,true);assert.equal(report.shape.hasId,true);assert.equal(report.stage,'enqueue-boundary');
 assert.equal(f.sent.length,0);assert.equal(f.uploads,0);assert.equal(window.WWebJS.sendMessage,sender);assert.equal(window.require('WAWebSendMsgChatAction').addAndSendMsgToChat,action);
});
test('Read-only runtime probe identifies an incompatible module without exposing error text or sending',async t=>{
 const f=fixture(t);f.overrides.WAWebGetEphemeralFieldsMsgActionsUtils={getEphemeralFields(){throw TypeError("Cannot read properties of undefined (reading 'remote') private caption +60000000000");}};
 const report=await browserSendReadiness();assert.equal(report.ok,false);assert.equal(report.stage,'WAWebGetEphemeralFieldsMsgActionsUtils');assert.equal(report.fault.symbol,'remote');
 assert.ok(!JSON.stringify(report).includes('private caption'));assert.ok(!JSON.stringify(report).includes('60000000000'));assert.equal(f.sent.length,0);
});
