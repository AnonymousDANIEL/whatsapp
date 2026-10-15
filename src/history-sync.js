'use strict';
// Runs in the existing authenticated browser. Read only: no sending or UI mutation.
async function browserSnapshot(chatIds, since, {budgetMs=8000,perChatMs=500}={}) {
  const collections=window.require('WAWebCollections');
  const textId=x=>typeof x==='string'?x:(x?._serialized||x?.$1||null);
  const output=new Map();
  function add(m,chatId=null){
    try {
      const id=textId(m.id),fromMe=m.id?.fromMe===true||m.fromMe===true;
      if(!id||!fromMe||!Number.isFinite(m.t)||m.t<since)return;
      const item={id,fromMe:true,to:textId(m.to)||textId(m.id?.remote)||chatId||'',body:typeof m.body==='string'?m.body:'',type:typeof m.type==='string'?m.type:'chat',timestamp:m.t,ack:Number.isInteger(m.ack)?m.ack:0};
      const prior=output.get(id);if(chatId)item.chatId=chatId;else if(prior?.chatId)item.chatId=prior.chatId;
      output.set(id,item);
    }catch{/* A malformed message must not discard the rest of the snapshot. */}
  }
  for(const m of collections.Msg.getModelsArray())add(m);
  const state=window.__mywasapReadOnlyHistory||(window.__mywasapReadOnlyHistory={pending:new Map(),cursor:0});
  let chatErrors=0,processed=0;const started=Date.now(),offset=state.cursor%Math.max(1,chatIds.length);
  for(let index=0;index<chatIds.length;index++){
    if(Date.now()-started>=budgetMs){chatErrors+=chatIds.length-index;break;}
    const chatId=chatIds[(offset+index)%chatIds.length];processed++;
    try{
      let work=state.pending.get(chatId);
      if(!work){
        // Keep at most one outstanding read per chat, even across timed-out passes.
        if(state.pending.size>=100){chatErrors++;continue;}
        work=(async()=>{
          const chat=await window.WWebJS.getChat(chatId,{getAsModel:false});
          if(!chat)throw Error('CHAT_UNAVAILABLE');
          const models=chat.msgs.getModelsArray();
          for(const m of models)add(m,chatId);
          // At most one older page; never let one network-backed read lose the whole snapshot.
          if(models.length&&Math.min(...models.map(m=>m.t||Infinity))>since){
            const older=await window.require('WAWebChatLoadMessages').loadEarlierMsgs({chat});
            for(const m of older||[])add(m,chatId);
          }
        })();
        state.pending.set(chatId,work);
        work.then(()=>{if(state.pending.get(chatId)===work)state.pending.delete(chatId);},()=>{if(state.pending.get(chatId)===work)state.pending.delete(chatId);});
      }
      let timer;try{await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('HISTORY_READ_PENDING')),Math.min(perChatMs,Math.max(1,budgetMs-(Date.now()-started))));})]);}finally{clearTimeout(timer);}
    }catch{chatErrors++;}
  }
  state.cursor=chatIds.length?(offset+Math.max(1,processed))%chatIds.length:0;
  return {messages:[...output.values()].sort((a,b)=>b.timestamp-a.timestamp).slice(0,2000),chatErrors};
}
async function readSnapshot(client,chatIds,since){return client.pupPage.evaluate(browserSnapshot,chatIds,since);}
function historyFailureCode(error){
 const message=String(error?.message||'');
 if(/target closed|session closed|connection closed|target.*detached/i.test(message))return 'HISTORY_BROWSER_CLOSED';
 if(/execution context was destroyed|cannot find context|frame was detached/i.test(message))return 'HISTORY_PAGE_RELOADING';
 if(/timed?\s*out|timeout/i.test(message))return 'HISTORY_CDP_TIMEOUT';
 if(/window\.require|WAWebCollections|WWebJS.*(?:undefined|not)/i.test(message))return 'HISTORY_API_UNAVAILABLE';
 return 'HISTORY_SYNC_FAILED';
}
module.exports={browserSnapshot,readSnapshot,historyFailureCode};
