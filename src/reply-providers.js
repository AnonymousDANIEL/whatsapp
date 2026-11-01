'use strict';
const crypto=require('node:crypto');
const {assert}=require('./domain');
function equal(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
const signature=(token,time,nonce,encrypted)=>crypto.createHash('sha1').update([token,time,nonce,...encrypted===undefined?[]:[encrypted]].sort().join('')).digest('hex');
function xmlFields(xml){
 assert(typeof xml==='string'&&xml.length<=65536&&!/<!DOCTYPE|<!ENTITY/i.test(xml),'Invalid XML');
 const root=xml.trim().match(/^<xml>([\s\S]*)<\/xml>$/);assert(root,'Invalid XML');const out={};
 const tag=/<([A-Za-z][A-Za-z0-9_]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;let m,last=0;
 while((m=tag.exec(root[1]))){assert(!root[1].slice(last,m.index).trim()&&!Object.hasOwn(out,m[1]),'Invalid XML');out[m[1]]=m[2]??m[3].replace(/&(lt|gt|quot|apos|amp);/g,(_,n)=>({lt:'<',gt:'>',quot:'"',apos:"'",amp:'&'}[n]));last=tag.lastIndex;}
 assert(!root[1].slice(last).trim(),'Invalid XML');return out;
}
function wxDecrypt(encrypted,cfg){
 assert(/^[A-Za-z0-9+/]{43}$/.test(cfg.aes_key||'')&&/^[A-Za-z0-9+/]+=*$/.test(encrypted||''),'Invalid encrypted message',403);
 const key=Buffer.from(cfg.aes_key+'=','base64'),cipher=Buffer.from(encrypted,'base64');assert(cipher.length>=32&&cipher.length%16===0,'Invalid encrypted message',403);
 let all;try{const d=crypto.createDecipheriv('aes-256-cbc',key,key.subarray(0,16));d.setAutoPadding(false);all=Buffer.concat([d.update(cipher),d.final()]);}catch{assert(false,'Invalid encrypted message',403);}
 const padding=all[all.length-1];assert(padding>=1&&padding<=32&&all.subarray(-padding).every(n=>n===padding),'Invalid padding',403);const data=all.subarray(0,-padding);assert(data.length>=20,'Invalid encrypted message',403);const length=data.readUInt32BE(16);
 assert(length<=data.length-20&&equal(data.subarray(20+length).toString(),cfg.app_id),'Invalid receiver',403);return data.subarray(20,20+length).toString('utf8');
}
function wxEncrypt(xml,cfg,time=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(12).toString('hex')){
 const key=Buffer.from(cfg.aes_key+'=','base64'),body=Buffer.from(xml),length=Buffer.alloc(4);length.writeUInt32BE(body.length);
 const raw=Buffer.concat([crypto.randomBytes(16),length,body,Buffer.from(cfg.app_id)]),padding=32-raw.length%32,c=crypto.createCipheriv('aes-256-cbc',key,key.subarray(0,16));c.setAutoPadding(false);
 const encrypted=Buffer.concat([c.update(Buffer.concat([raw,Buffer.alloc(padding,padding)])),c.final()]).toString('base64');
 return `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt><MsgSignature><![CDATA[${signature(cfg.verify_token,time,nonce,encrypted)}]]></MsgSignature><TimeStamp>${time}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`;
}
const xmlEscape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function wxReply(to,from,text){return `<xml><ToUserName>${xmlEscape(to)}</ToUserName><FromUserName>${xmlEscape(from)}</FromUserName><CreateTime>${Math.floor(Date.now()/1000)}</CreateTime><MsgType>text</MsgType><Content>${xmlEscape(text)}</Content></xml>`;}
function validateConfig(channel,c){
 const bounded=(key,max=500)=>assert(typeof c[key]==='string'&&c[key].length>0&&c[key].length<=max,'Missing or invalid '+key);
 if(channel==='telegram'){bounded('token',180);assert(/^\d{5,20}:[A-Za-z0-9_-]{25,160}$/.test(c.token),'Invalid Telegram bot token');}
 if(channel==='messenger'){for(const k of ['page_id','access_token','app_secret','verify_token'])bounded(k,k==='access_token'?2000:200);assert(/^\d{5,30}$/.test(c.page_id),'Invalid Page ID');}
 if(channel==='wechat'){for(const k of ['app_id','original_id','verify_token','aes_key'])bounded(k,128);assert(/^[A-Za-z0-9+/]{43}$/.test(c.aes_key),'Invalid EncodingAESKey');assert(/^[\w-]{3,128}$/.test(c.original_id),'Invalid Official Account ID');}
}
function create({fetcher=fetch}={}){
 async function request(url,{method='GET',body,headers={}}={}){
  assert(['api.telegram.org','graph.facebook.com'].includes(url.hostname)&&url.protocol==='https:','Invalid provider address');
  let r;try{r=await fetcher(url,{method,headers:{...body?{'Content-Type':'application/json'}:{},...headers},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw Object.assign(Error('Provider result unknown'),{status:502,code:'REPLY_UNKNOWN'});}
  let text='';try{for await(const chunk of r.body){text+=Buffer.from(chunk).toString();if(text.length>1000000){await r.body.cancel().catch(()=>{});throw Error('oversize');}}}catch{throw Object.assign(Error('Provider response unavailable'),{status:502,code:'REPLY_UNKNOWN'});}
  let data;try{data=JSON.parse(text);}catch{throw Object.assign(Error('Provider response unavailable'),{status:502,code:'REPLY_UNKNOWN'});}
  if(!r.ok||data.ok===false||data.error)throw Object.assign(Error('Provider rejected request'),{status:502,code:'REPLY_REJECTED'});return data;
 }
 const tg=(c,method,b)=>request(new URL('https://api.telegram.org/bot'+c.token+'/'+method),{method:'POST',body:b||{}});
 const fb=(c,edge,b)=>{const u=new URL('https://graph.facebook.com/v26.0/'+c.page_id+(edge?'/'+edge:''));u.searchParams.set('appsecret_proof',crypto.createHmac('sha256',c.app_secret).update(c.access_token).digest('hex'));return request(u,{method:b?'POST':'GET',body:b,headers:{Authorization:'Bearer '+c.access_token}});};
 async function connect(channel,c,webhook){
  validateConfig(channel,c);
  if(channel==='telegram'){const bot=(await tg(c,'getMe')).result;assert(bot?.is_bot&&String(bot.id)===c.token.split(':')[0],'Invalid bot identity');const info=(await tg(c,'getWebhookInfo')).result;assert(!info?.url||info.url===webhook,'This bot already uses another webhook. Disconnect that integration first.',409);await tg(c,'setWebhook',{url:webhook,secret_token:c.webhook_secret,allowed_updates:['message'],drop_pending_updates:false});return String(bot.id);}
  if(channel==='messenger'){const page=await fb(c,'');assert(page.id===c.page_id,'Invalid Page identity',403);await fb(c,'subscribed_apps',{subscribed_fields:['messages']});return page.id;}
  return c.original_id;
 }
 async function send(channel,c,peer,text){
  if(channel==='telegram'){const data=await tg(c,'sendMessage',{chat_id:peer,text,link_preview_options:{is_disabled:true}});assert(data.result?.message_id,'No message receipt',502);return String(data.result.message_id);}
  const data=await fb(c,'messages',{recipient:{id:peer},messaging_type:'RESPONSE',message:{text}});assert(data.message_id&&String(data.recipient_id)===peer,'No message receipt',502);return data.message_id;
 }
 return {connect,send};
}
module.exports={create,equal,signature,xmlFields,wxDecrypt,wxEncrypt,wxReply,validateConfig};
