const {test}=require('node:test');const assert=require('node:assert/strict');const {browserSnapshot}=require('../src/history-sync');
test('read-only snapshot bypasses broken model serialization, supports changed IDs and keeps real ACKs',async()=>{
 const good={id:{$1:'true_123@c.us_ABC',fromMe:true,remote:{$1:'123@c.us'}},t:100,body:'hello',ack:2,serialize(){throw Error('broken serializer')}};
 const incoming={...good,id:{_serialized:'incoming',fromMe:false}},old={...good,id:{_serialized:'old',fromMe:true},t:1};
 const malformed={get id(){throw Error('bad getter')}};const saved=global.window;
 global.window={require:name=>{if(name==='WAWebCollections')return{Msg:{getModelsArray:()=>[good,incoming,old,malformed]}};throw Error('no send APIs permitted');},WWebJS:{getChat:async()=>({msgs:{getModelsArray:()=>[old,good]}})}};
 try{const r=await browserSnapshot(['123@c.us'],50);assert.equal(r.messages.length,1);assert.equal(r.messages[0].id,'true_123@c.us_ABC');assert.equal(r.messages[0].ack,2);assert.equal(r.messages[0].chatId,'123@c.us');assert.equal(r.chatErrors,0);}finally{global.window=saved;}
});
