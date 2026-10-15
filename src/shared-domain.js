'use strict';
const {assert,parseRecipients,validatePacing}=require('./domain');
const priceSQL="COALESCE((SELECT hp.price_units FROM shared_hour_prices hp WHERE hp.hour=EXTRACT(hour FROM statement_timestamp() AT TIME ZONE 'Asia/Kuala_Lumpur')::integer),s.price_units)";
const personalPhoneSQL="EXISTS(SELECT 1 FROM accounts personal WHERE NOT personal.shared_pool AND personal.deleted_at IS NULL AND personal.phone IS NOT NULL AND replace(personal.phone,'+','')=replace(a.registration_phone,'+',''))";
const connectedSQL=`a.shared_pool AND a.enabled AND a.deleted_at IS NULL AND a.status='ready'
 AND a.phone IS NOT NULL AND a.registration_phone='+'||a.phone
 AND NOT (${personalPhoneSQL})
 AND a.shared_state='connected' AND a.shared_checked_at>now()-interval '65 minutes'
 AND EXISTS(SELECT 1 FROM worker_health wh WHERE wh.worker_group=a.worker_group AND wh.heartbeat_at>now()-interval '90 seconds')`;
function hourAt(date=new Date()){return (date.getUTCHours()+8)%24;}
function priceUnits(value){
 assert(typeof value==='string'&&/^(0|[1-9]\d{0,4})(\.\d{1,4})?$/.test(value),'共享价格最多四位小数');
 const [whole,fraction='']=value.split('.'),amount=Number(whole)*10000+Number(fraction.padEnd(4,'0'));
 assert(amount>0&&amount<=100000000,'每条共享消息价格需要 RM 0.0001–10000');return amount;
}
function settings(body){
 assert(typeof body.enabled==='boolean','共享服务开关无效');
 const price=body.price===''||body.price===null?null:priceUnits(body.price);
 assert(Array.isArray(body.hours)&&body.hours.length<=24,'小时价格无效');
 const seen=new Set(),hours=[];
 for(const item of body.hours){
  assert(item&&typeof item==='object'&&Number.isInteger(item.hour)&&item.hour>=0&&item.hour<24&&!seen.has(item.hour),'小时价格无效');seen.add(item.hour);
  if(item.price===''||item.price===null)continue;
  hours.push({hour:item.hour,price_units:priceUnits(item.price)});
 }
 return {enabled:body.enabled,price_units:price,hours,...validatePacing(body)};
}
function registrationNumbers(text){
 const parsed=parseRecipients(text);assert(parsed.recipients.length<=200,'每次最多录入 200 个号码');
 assert(parsed.recipients.every(r=>r.phone),'请使用有效的手机号码，包含国家代码');return parsed;
}
function linkedPhone(entry){const wid=entry?.client?.info?.wid;return wid&&wid.server!=='lid'&&/^\d{6,15}$/.test(String(wid.user||''))?String(wid.user):null;}
async function inspectClient(entry,timeoutMs=8000){
 if(!entry||entry.closing)return 'offline';if(!entry.ready)return 'waiting';let timer;
 try{
  const state=await Promise.race([entry.client.getState(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('STATE_TIMEOUT')),timeoutMs);})]);
  if(state==='CONNECTED')return 'connected';return state==null?'unknown':'offline';
 }catch{return 'unknown';}finally{clearTimeout(timer);}
}
module.exports={priceSQL,personalPhoneSQL,connectedSQL,hourAt,priceUnits,settings,registrationNumbers,inspectClient,linkedPhone};
