'use strict';
const assert=require('node:assert/strict'),puppeteer=require('puppeteer');
const {LoadUtils}=require('whatsapp-web.js/src/util/Injected/Utils');
const {installSendFixture}=require('./send-fixture.cjs');
const {browserPrepareSend,browserCommitSend}=require('../src/workspace-send');
const {LiveWebClient}=require('../src/live-web-client');
const image={mimetype:'image/png',filename:'photo.png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII='};
(async()=>{
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',request=>request.abort());
  await page.evaluate(LoadUtils);await page.evaluate(installSendFixture);
  const client=new LiveWebClient();client.pupPage=page;
  const readiness=await client.inspectSendRuntime();assert.equal(readiness.ok,true);assert.equal(readiness.model_initialized,true);assert.equal(readiness.private_id_collision_reproduced,true);assert.equal(await page.evaluate(()=>window.sendFixture.sent.length),0);
  for(const [token,caption,media] of [['zh','图片说明 🎉\n第二行',image],['en','Photo caption\nSecond line',image],['photo-only','',image],['text','Plain text',null]]){
   const prepared=await page.evaluate(browserPrepareSend,token,'60000000000@c.us',caption,media,Date.now()+5000);
   if(media)assert.equal(prepared.filehash,'synthetic-processed-image-hash');
   const result=await page.evaluate(browserCommitSend,token);assert.ok(result.message.id);assert.equal(result.message.body,caption);assert.equal(result.message.type,media?'image':'chat');assert.equal(result.message.ack,0);
   assert.equal((await page.evaluate(browserCommitSend,token)).notSent,true);
  }
  assert.deepEqual(await page.evaluate(()=>({messages:window.sendFixture.sent.length,uploads:window.sendFixture.uploads,serializations:window.sendFixture.serializations,seen:window.sendFixture.seen,jobs:window.__mywasapPreparedSends.size})),{messages:4,uploads:3,serializations:0,seen:0,jobs:0});
  await page.evaluate(()=>{window.sendFixture.keyFormat='$1';window.sendFixture.modernKeyOnly=true;});
  const modern=await page.evaluate(browserPrepareSend,'modern','70000000000@lid','modern caption',image,Date.now()+5000);
  assert.equal(modern.inspection.key_format,'$1');assert.equal((await page.evaluate(browserCommitSend,'modern')).message.id,modern.id);
  assert.equal(await page.evaluate(()=>window.sendFixture.sent.some(m=>Object.hasOwn(m,'__x_id'))),false);
  console.log('Image-caption browser PASS: media private-ID collision guard, prepared ID retained, modern $1/LID keys, zh/en captions, no duplicate; network blocked');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
