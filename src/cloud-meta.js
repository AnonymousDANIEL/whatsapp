'use strict';
// Official Graph API only. No browser workers, device links or retrying sends.
const crypto=require('node:crypto');
const {parsePhoneNumberFromString}=require('libphonenumber-js');
const CATEGORIES=['OTHER','AUTO','BEAUTY','APPAREL','EDU','ENTERTAIN','EVENT_PLAN','FINANCE','GROCERY','GOVT','HOTEL','HEALTH','NONPROFIT','PROF_SERVICES','RETAIL','TRAVEL','RESTAURANT'];
const PHONE_FIELDS='id,display_phone_number,verified_name,code_verification_status,status,platform_type';
function fail(code,status=400){return Object.assign(new Error(code),{code,status,publicMessage:true});}
function check(ok,code,status=400){if(!ok)throw fail(code,status);}
function id(value){check(typeof value==='string'&&/^\d{5,30}$/.test(value),'CLOUD_INVALID_ID');return value;}
function phone(value){const p=typeof value==='string'&&value.length<=40&&parsePhoneNumberFromString(value.startsWith('+')?value:'+'+value);check(p&&p.isValid(),'CLOUD_INVALID_PHONE');return p;}
function text(value,max,required=false){check(typeof value==='string'&&value.length<=max&&(!required||value.trim()),'CLOUD_INVALID_FIELD');check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),'CLOUD_INVALID_FIELD');return value.trim();}
function profile(body){
 const out={messaging_product:'whatsapp',description:text(body.description??'',512),address:text(body.address??'',256),email:text(body.email??'',128),vertical:body.vertical,websites:[]};
 check(CATEGORIES.includes(out.vertical),'CLOUD_INVALID_CATEGORY');check(!out.email||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email),'CLOUD_INVALID_EMAIL');
 check(Array.isArray(body.websites)&&body.websites.length<=2,'CLOUD_INVALID_WEBSITE');
 out.websites=body.websites.map(s=>{text(s,256,true);let u;try{u=new URL(s);}catch{}check(u&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password,'CLOUD_INVALID_WEBSITE');return u.href;});return out;
}
function signature(raw,header,secret){if(!Buffer.isBuffer(raw)||!/^sha256=[a-f0-9]{64}$/.test(header||'')||!secret)return false;return crypto.timingSafeEqual(Buffer.from(header.slice(7),'hex'),crypto.createHmac('sha256',secret).update(raw).digest());}
function equal(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y);}
async function jsonBody(response){const parts=[];let size=0;for await(const b of response.body||[]){size+=b.length;if(size>1024*1024){await response.body.cancel?.().catch(()=>{});throw fail('CLOUD_META_RESPONSE_INVALID',502);}parts.push(Buffer.from(b));}try{return JSON.parse(Buffer.concat(parts).toString());}catch{throw fail('CLOUD_META_RESPONSE_INVALID',502);}}
function uploadPath(value){return typeof value==='string'&&value.length<=8192&&/^upload:[A-Za-z0-9_:=+\/-]+(?:\?sig=[A-Za-z0-9_%=+:-]+)?$/.test(value);}
function client(settings,{fetcher=globalThis.fetch}={}){
 const version=settings.graph_version||'v26.0';check(/^v\d{2}\.0$/.test(version),'CLOUD_CONFIG_INVALID',503);
 async function request(path,{method='GET',token,params={},body,bytes,headers={},proof=true}={}){
  check(typeof path==='string'&&(/^(?:\d{5,30}(?:\/[a-z_]+)?|oauth\/access_token|debug_token)$/.test(path)||uploadPath(path)),'CLOUD_INVALID_PATH');
  const url=new URL('https://graph.facebook.com/'+version+'/'+path);for(const[k,v]of Object.entries(params))url.searchParams.set(k,String(v));
  if(token&&proof)url.searchParams.set('appsecret_proof',crypto.createHmac('sha256',settings.app_secret).update(token).digest('hex'));
  let r;try{r=await fetcher(url,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{...token?{Authorization:'Bearer '+token}:{},...body?{'Content-Type':'application/json'}:{},...headers},body:bytes??(body?JSON.stringify(body):undefined)});}catch{throw fail('CLOUD_META_UNCERTAIN',502);}
  const data=await jsonBody(r);if(!r.ok||data.error){const e=fail('CLOUD_META_ERROR',r.status===429?429:502);e.metaCode=Number.isSafeInteger(data.error?.code)?data.error.code:null;e.definite=r.status>=400&&r.status<500&&r.status!==408;e.httpStatus=r.status;throw e;}return data;
 }
 const success=async(path,options)=>{const r=await request(path,options);check(r.success===true,'CLOUD_META_RESPONSE_INVALID',502);return r;};
 return {request,success,async exchange(code){const r=await request('oauth/access_token',{params:{client_id:settings.app_id,client_secret:settings.app_secret,code},proof:false});check(typeof r.access_token==='string'&&r.access_token.length>20,'CLOUD_META_RESPONSE_INVALID',502);const v=await request('debug_token',{token:settings.app_id+'|'+settings.app_secret,params:{input_token:r.access_token},proof:false});check(v.data?.is_valid===true&&String(v.data.app_id)===settings.app_id&&['whatsapp_business_management','whatsapp_business_messaging'].every(p=>v.data.scopes?.includes(p)),'CLOUD_META_PERMISSION',403);return{token:r.access_token,expires_at:v.data.expires_at?new Date(v.data.expires_at*1000):null};},
  async phone(token,pid){return request(id(pid),{token,params:{fields:PHONE_FIELDS}});},
  async member(token,waba,pid){let after;for(let page=0;page<20;page++){const r=await request(id(waba)+'/phone_numbers',{token,params:{fields:PHONE_FIELDS,limit:100,...after?{after}:{}}});check(Array.isArray(r.data),'CLOUD_META_RESPONSE_INVALID',502);const match=r.data.find(p=>p.id===pid);if(match)return match;after=r.paging?.cursors?.after;if(!r.paging?.next||!after)break;}throw fail('CLOUD_META_ASSET_MISMATCH',403);}
 };
}
module.exports={CATEGORIES,PHONE_FIELDS,fail,check,id,phone,text,profile,signature,equal,uploadPath,client};
