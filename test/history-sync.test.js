const {test}=require('node:test');const assert=require('node:assert/strict');const {browserSnapshot}=require('../src/history-sync');
test('History failure categories distinguish closed browsers, reloads and timeouts without logging messages or contacts',()=>{
 const {historyFailureCode}=require('../src/history-sync');
 for(const [message,code] of [['Protocol error (Runtime.callFunctionOn): Target closed.','HISTORY_BROWSER_CLOSED'],['Session closed.','HISTORY_BROWSER_CLOSED'],['Execution context was destroyed, most likely because of a navigation.','HISTORY_PAGE_RELOADING'],['Runtime.callFunctionOn timed out.','HISTORY_CDP_TIMEOUT'],['window.require is not a function','HISTORY_API_UNAVAILABLE'],['private contact +60123456789 secret message','HISTORY_SYNC_FAILED']])assert.equal(historyFailureCode(new Error(message)),code);
});
test('read-only snapshot bypasses broken model serialization, supports changed IDs and keeps real ACKs',async()=>{
 const good={id:{$1:'true_123@c.us_ABC',fromMe:true,remote:{$1:'123@c.us'}},t:100,body:'hello',ack:2,serialize(){throw Error('broken serializer')}};
 const incoming={...good,id:{_serialized:'incoming',fromMe:false}},old={...good,id:{_serialized:'old',fromMe:true},t:1};
 const malformed={get id(){throw Error('bad getter')}};const saved=global.window;
 global.window={require:name=>{if(name==='WAWebCollections')return{Msg:{getModelsArray:()=>[good,incoming,old,malformed]}};throw Error('no send APIs permitted');},WWebJS:{getChat:async()=>({msgs:{getModelsArray:()=>[old,good]}})}};
 try{const r=await browserSnapshot(['123@c.us'],50);assert.equal(r.messages.length,1);assert.equal(r.messages[0].id,'true_123@c.us_ABC');assert.equal(r.messages[0].ack,2);assert.equal(r.messages[0].chatId,'123@c.us');assert.equal(r.chatErrors,0);}finally{global.window=saved;}
});
test('A stalled chat read preserves the loaded snapshot and is reused across retries without duplicate requests',async()=>{
 const saved=global.window,good={id:{_serialized:'already-loaded',fromMe:true},t:100,body:'local test',ack:2};let calls=0,release;
 const stalled=new Promise(resolve=>release=resolve);
 global.window={require:name=>{assert.equal(name,'WAWebCollections');return{Msg:{getModelsArray:()=>[good]}};},WWebJS:{getChat:()=>{calls++;return stalled;}}};
 try{
  for(let round=0;round<2;round++){
   const r=await browserSnapshot(['synthetic@c.us'],50,{budgetMs:20,perChatMs:5});
   assert.equal(r.messages[0].id,'already-loaded');assert.equal(r.messages[0].ack,2);assert.equal(r.chatErrors,1);
  }
  assert.equal(calls,1);assert.equal(window.__mywasapReadOnlyHistory.pending.size,1);
  release({msgs:{getModelsArray:()=>[]}});await stalled;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(window.__mywasapReadOnlyHistory.pending.size,0);
 }finally{release({msgs:{getModelsArray:()=>[]}});global.window=saved;}
});
test('Image snapshots retain the caption and uploaded fingerprint rather than the thumbnail body',async()=>{
 const saved=global.window;
 const image={id:{_serialized:'synthetic-image',fromMe:true},t:100,type:'image',body:'private-thumbnail-base64',caption:'图片说明 Photo caption',filehash:'uploaded-filehash',ack:2};
 global.window={require:()=>({Msg:{getModelsArray:()=>[image]}})};
 try{const r=await browserSnapshot([],50);assert.equal(r.messages[0].body,image.caption);assert.equal(r.messages[0].filehash,image.filehash);assert.ok(!JSON.stringify(r).includes(image.body));}finally{global.window=saved;}
});
