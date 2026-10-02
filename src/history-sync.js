'use strict';
// Runs in the existing authenticated browser. Read only: no sending or UI mutation.
async function browserSnapshot(chatIds, since) {
  const collections=window.require('WAWebCollections');
  const textId=x=>typeof x==='string'?x:(x?._serialized||x?.$1||null);
  const output=new Map();
  function add(m,chatId=null){
    try {
      const id=textId(m.id),fromMe=m.id?.fromMe===true||m.fromMe===true;
      if(!id||!fromMe||!Number.isFinite(m.t)||m.t<since)return;
      const item={id,fromMe:true,to:textId(m.to)||textId(m.id?.remote)||chatId||'',body:typeof m.body==='string'?m.body:'',timestamp:m.t,ack:Number.isInteger(m.ack)?m.ack:0};
      const prior=output.get(id);if(chatId)item.chatId=chatId;else if(prior?.chatId)item.chatId=prior.chatId;
      output.set(id,item);
    }catch{/* A malformed message must not discard the rest of the snapshot. */}
  }
  for(const m of collections.Msg.getModelsArray())add(m);
  let chatErrors=0;
  for(const chatId of chatIds){
    try{
      const chat=await window.WWebJS.getChat(chatId,{getAsModel:false});
      if(!chat){chatErrors++;continue;}
      for(const m of chat.msgs.getModelsArray())add(m,chatId);
      // Request at most one earlier page per pass, avoiding expensive unbounded history loads.
      const models=chat.msgs.getModelsArray();
      if(models.length&&Math.min(...models.map(m=>m.t||Infinity))>since){
        const older=await window.require('WAWebChatLoadMessages').loadEarlierMsgs({chat});
        for(const m of older||[])add(m,chatId);
      }
    }catch{chatErrors++;}
  }
  return {messages:[...output.values()].sort((a,b)=>b.timestamp-a.timestamp).slice(0,2000),chatErrors};
}
async function readSnapshot(client,chatIds,since){return client.pupPage.evaluate(browserSnapshot,chatIds,since);}
module.exports={browserSnapshot,readSnapshot};
