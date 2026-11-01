'use strict';
// A single opt-in incoming-message hook. Never starts, stops or resets a browser.
// Lazy storage import keeps the existing worker's schema/profile startup intact.
const {normalizePhone}=require('./domain');
const pending=new WeakMap();
function enqueue(pool,account,entry,message,isCurrent){
 // Bound incoming work independently of the browser and the outbound queue.
 const q=pending.get(entry)||{items:[],running:false};pending.set(entry,q);
 if(q.items.length>=100)return;
 q.items.push(message);if(q.running)return;q.running=true;
 const drain=async()=>{try{while(q.items.length&&isCurrent()){
  try{await receive(pool,account,entry,q.items.shift(),isCurrent);}catch(e){if(e.code!=='42P01')console.error('Auto reply inbox:',e.code||e.name);}
 }}finally{q.items.length=0;q.running=false;}};
 void drain();
}
async function receive(pool,account,entry,message,isCurrent){
 if(account.shared_pool||!isCurrent()||!entry.ready||message.fromMe||message.type!=='chat'||typeof message.body!=='string'||!message.body.trim())return;
 if(!/@(c\.us|lid)$/.test(String(message.from||''))||message.isStatus)return;
 const time=Number(message.timestamp)*1000;if(!Number.isFinite(time)||time<Date.now()-120000||time>Date.now()+60000)return;
 const id=message.id?._serialized;if(typeof id!=='string'||id.length>250)return;
 const rows=(await pool.query(`SELECT r.id FROM reply_connections r JOIN users u ON u.id=r.user_id JOIN reply_policy p ON p.channel=r.channel LEFT JOIN reply_user_policy up ON up.user_id=r.user_id AND up.channel=r.channel
  WHERE r.account_id=$1 AND r.channel='whatsapp' AND r.enabled AND p.enabled AND COALESCE(up.enabled,true) AND u.active AND NOT u.locked`,[account.id])).rows;
 if(!rows.length)return;
 let number=message.from.endsWith('@c.us')?message.from.split('@')[0]:null;
 if(!number&&typeof entry.client.getContactLidAndPhone==='function'){
  let timer;try{const rows=await Promise.race([entry.client.getContactLidAndPhone([message.from]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CONTACT_TIMEOUT')),3000);})]);const mapped=rows?.find(r=>r.lid===message.from&&/^\d{7,15}@c\.us$/.test(r.pn||''));if(mapped)number=mapped.pn.split('@')[0];}finally{clearTimeout(timer);}
 }
 const peer=number&&normalizePhone('+'+number);if(!peer||!isCurrent())return;
 const {ingest}=require('./auto-reply-store');
 for(const r of rows)await ingest(pool,r.id,{id,peer,text:message.body.slice(0,4000),time});
}
async function permitted(pool,campaign){
 if(!String(campaign.title||'').startsWith('Auto reply '))return true;
 const {joined,allowedSQL}=require('./auto-reply-store');
 const event=(await pool.query('SELECT connection_id,provider_at FROM reply_events WHERE campaign_id=$1',[campaign.id])).rows[0];
 if(!event)return true;
 return !!(await pool.query(`SELECT 1 FROM ${joined} WHERE r.id=$1 AND ${allowedSQL} AND $2::timestamptz>now()-interval '5 minutes'`,[event.connection_id,event.provider_at])).rowCount;
}
function heartbeat(pool,group){
 let busy=false,stopped=false;
 const tick=async()=>{if(busy||stopped)return;busy=true;try{await pool.query('INSERT INTO reply_workers(worker_group) VALUES($1) ON CONFLICT(worker_group) DO UPDATE SET version=1,heartbeat_at=now()',[group]);}catch(e){if(e.code!=='42P01')console.error('Auto reply heartbeat:',e.code||e.name);}finally{busy=false;}};
 tick();const timer=setInterval(tick,30000);timer.unref();return()=>{stopped=true;clearInterval(timer);};
}
module.exports={receive,enqueue,permitted,heartbeat};
