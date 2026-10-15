'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {LoadUtils}=require('whatsapp-web.js/src/util/Injected/Utils');
const {installSendFixture}=require('./send-fixture.cjs');
const {browserPrepareSend,browserCommitSend,browserDiscardSend,sendFailureCode}=require('../src/workspace-send');
const {LiveWebClient}=require('../src/live-web-client');
const image={mimetype:'image/png',filename:'photo.png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII='};
function fixture(t){const previous=global.window;global.window={atob:global.atob};LoadUtils();const f=installSendFixture();t.after(()=>{global.window=previous;});return f;}
test('Individual sender strips MediaData private IDs and enqueues one inline caption with its genuine key',async t=>{
 const f=fixture(t),caption='Taniah bossku! 中文\nTwo lines 🎉';
 const prepared=await browserPrepareSend('image','60000000000@c.us',caption,image,Date.now()+5000);
 assert.equal(prepared.filehash,'synthetic-processed-image-hash');assert.equal(f.sent.length,0);
 assert.ok(prepared.id);assert.equal(prepared.inspection.private_media_id_removed,true);
 const result=await browserCommitSend('image');assert.ok(result.message.id);assert.equal(result.message.ack,0);assert.equal(result.message.body,caption);assert.equal(result.message.type,'image');
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].caption,caption);assert.equal(f.sent[0].type,'image');assert.equal(f.uploads,1);assert.equal(f.preparations,1);assert.equal(f.serializations,0);assert.equal(f.seen,0);
 assert.equal(Object.hasOwn(f.sent[0],'__x_id'),false);assert.equal(result.message.id,prepared.id);
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
 const client=new LiveWebClient();client.pupPage={evaluate:async(fn,...args)=>fn(...args)};
 const report=await client.inspectSendRuntime();assert.equal(report.ok,true);assert.equal(report.has_message_id,true);assert.equal(report.stage,'prepared-without-enqueue');
 assert.equal(report.model_initialized,true);assert.equal(report.private_id_collision_reproduced,true);
 assert.ok(!JSON.stringify(report).includes('60000000000'));assert.equal(window.__mywasapPreparedSends,undefined);
 assert.equal(f.sent.length,0);assert.equal(f.uploads,0);assert.equal(window.WWebJS.sendMessage,sender);assert.equal(window.require('WAWebSendMsgChatAction').addAndSendMsgToChat,action);
});
test('Read-only runtime probe identifies an incompatible module without exposing error text or sending',async t=>{
 const f=fixture(t);f.overrides.WAWebGetEphemeralFieldsMsgActionsUtils={getEphemeralFields(){throw TypeError("Cannot read properties of undefined (reading 'remote') private caption +60000000000");}};
 const client=new LiveWebClient();client.pupPage={evaluate:async(fn,...args)=>fn(...args)};
 const report=await client.inspectSendRuntime();assert.equal(report.ok,false);assert.equal(report.code,'SEND_PREPARE_EPHEMERAL_FAILED');
 assert.ok(!JSON.stringify(report).includes('private caption'));assert.ok(!JSON.stringify(report).includes('60000000000'));assert.equal(f.sent.length,0);
});
test('Pinned upstream control reproduces the September MediaData __x_id failure without any send',async t=>{
 const f=fixture(t),chat=await window.WWebJS.getChat('60000000000@c.us',{getAsModel:false});
 await assert.rejects(window.WWebJS.sendMessage(chat,'',{media:image,caption:'caption',waitUntilMsgSent:false,parseVCards:false,linkPreview:false}),/Data passed to getter must include an id property/);
 assert.equal(f.sent.length,0);
});
test('Modern $1-only keys and legacy constructor fallback both retain the exact key through enqueue',async t=>{
 const f=fixture(t);f.modernKeyOnly=true;f.keyFormat='$1';
 for(const [token,to] of [['modern-pn','60000000000@c.us'],['modern-lid','70000000000@lid']]){
  const prepared=await browserPrepareSend(token,to,'caption',image,Date.now()+5000);
  assert.equal(prepared.inspection.key_format,'$1');assert.equal(prepared.inspection.key_constructor,'modern');
  assert.equal((await browserCommitSend(token)).message.id,prepared.id);
 }
 f.modernKeyOnly=false;f.legacyKeyOnly=true;f.keyFormat='_serialized';
 const prepared=await browserPrepareSend('legacy','60000000000@c.us','caption',image,Date.now()+5000);
 assert.equal(prepared.inspection.key_constructor,'legacy');assert.equal((await browserCommitSend('legacy')).message.id,prepared.id);
 assert.equal(f.sent.length,3);
});
test('A constructor error or missing recipient is a definite pre-submit failure',async t=>{
 const f=fixture(t);await assert.rejects(browserPrepareSend('no-target',undefined,'caption',image,Date.now()+5000),/SEND_CHAT_ID_INVALID/);
 assert.equal(f.sent.length,0);assert.equal(f.uploads,0);
});
test('Private IDs from media JSON cannot replace the outgoing key, and uncached real local models retain it',async t=>{
 const f=fixture(t);f.mediaJsonId=true;f.cacheMissing=true;
 const prepared=await browserPrepareSend('json','60000000000@c.us','caption',image,Date.now()+5000);
 const result=await browserCommitSend('json');assert.equal(result.message.id,prepared.id);assert.equal(f.sent.length,1);assert.equal(Object.hasOwn(f.sent[0],'__x_id'),false);assert.equal(typeof f.sent[0].id,'object');
});
test('A missing local model retains a known ID for review rather than fabricating success',async t=>{
 const f=fixture(t);f.cacheMissing=true;f.localMissing=true;
 const prepared=await browserPrepareSend('missing','60000000000@c.us','caption',image,Date.now()+5000);
 const result=await browserCommitSend('missing');assert.equal(result.message,undefined);assert.equal(result.code,'SEND_LOCAL_MODEL_MISSING_REVIEW_REQUIRED');assert.equal(result.knownId,prepared.id);assert.equal(f.sent.length,1);
});
test('An exception after local creation recovers only its exact model and never retries',async t=>{
 const f=fixture(t);f.throwAfterCreate=true;
 const prepared=await browserPrepareSend('created','60000000000@c.us','caption',image,Date.now()+5000);
 assert.equal((await browserCommitSend('created')).message.id,prepared.id);assert.equal((await browserCommitSend('created')).notSent,true);assert.equal(f.sent.length,1);
});
test('A rejected server promise cannot turn a local ACK zero into a success or a refund',async t=>{
 const f=fixture(t);f.serverReject=true;
 await browserPrepareSend('server','60000000000@c.us','caption',image,Date.now()+5000);
 const result=await browserCommitSend('server');assert.equal(result.message.ack,0);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.sent.length,1);
});
