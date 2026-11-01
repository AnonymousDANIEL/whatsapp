'use strict';
const {DateTime}=require('luxon');
const {assert}=require('./domain');
function parse(body,now=Date.now()){
 if(body.send_mode===undefined)return null;
 assert(['now','later'].includes(body.send_mode),'请选择立即发送或预约发送');
 if(body.send_mode==='now')return {send_now:true,scheduled_at:null};
 assert(typeof body.scheduled_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(body.scheduled_at),'预约时间必须为马来西亚时间');
 const at=DateTime.fromISO(body.scheduled_at,{setZone:true});
 assert(at.isValid&&at.toMillis()>now&&at.toMillis()<=now+5*86400000,'请选择未来 5 天内的预约时间');
 return {send_now:false,scheduled_at:at.toUTC().toISO()};
}
module.exports={parse};
