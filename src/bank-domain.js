'use strict';
const crypto=require('node:crypto');
const {assert}=require('./domain');
const ID=/^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i;
function id(value){assert(typeof value==='string'&&ID.test(value),'Bank ID is invalid');return value;}
function cents(value){assert(typeof value==='string'&&/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(value),'Deposit amount must have at most two decimals');const [a,b='']=value.split('.'),n=Number(a)*100+Number(b.padEnd(2,'0'));assert(n>=100&&n<=1000000,'Deposit amount must be RM 1–10000');return n;}
function text(value,max,required=false){assert(typeof value==='string'&&value.length<=max&&(!required||value.trim()),'Bank details are invalid');return value.trim();}
function instant(value){assert(typeof value==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=Date.now()+300000,'Bank timestamp requires a timezone');return new Date(value).toISOString();}
function sign(timestamp,bankId,body,key){return crypto.createHmac('sha256',key).update(String(timestamp)+'.'+bankId+'.').update(body).digest('hex');}
function signed(timestamp,bankId,body,key,digest,now=Date.now()){
 if(!/^\d{10}$/.test(String(timestamp))||Math.abs(now/1000-Number(timestamp))>300||!/^[a-f0-9]{64}$/i.test(digest||''))return false;
 return crypto.timingSafeEqual(Buffer.from(sign(timestamp,bankId,body,key),'hex'),Buffer.from(digest,'hex'));
}
function feed(body){
 assert(body?.version===1&&body.live===true,'A live bank feed is required');id(body.event_id);
 const account=text(body.account_number,40,true);assert(/^\d[\d -]{3,39}$/.test(account),'Bank account number is invalid');
 assert(Array.isArray(body.transactions)&&body.transactions.length<=500&&Array.isArray(body.decisions)&&body.decisions.length<=100,'Bank feed is too large');
 assert(typeof body.maintenance==='boolean','Bank maintenance status is required');
 const transactions=body.transactions.map(t=>{assert(t&&['in','out'].includes(t.direction)&&Number.isSafeInteger(t.amount_cents)&&t.amount_cents>0&&t.amount_cents<=100000000000&&t.status==='posted','Only posted bank transactions are accepted');return{id:text(t.id,100,true),direction:t.direction,amount_cents:t.amount_cents,occurred_at:instant(t.occurred_at),description:text(t.description??'',2000),reference:text(t.reference??'',200)};});
 assert(new Set(transactions.map(t=>t.id)).size===transactions.length,'Duplicate bank transaction IDs');
 let coverage=null;if(body.coverage){const c=body.coverage;assert(c.complete===true,'Incomplete feed cannot reject deposits');coverage={from:instant(c.from),to:instant(c.to),complete:true};assert(Date.parse(coverage.from)<=Date.parse(coverage.to),'Bank coverage is invalid');}
 const decisions=body.decisions.map(d=>{assert(['matched','invalid','no_match'].includes(d?.status)&&/^[a-f0-9]{64}$/.test(d.receipt_sha256||''),'Bank receipt decision is invalid');return{deposit_id:id(d.deposit_id),receipt_sha256:d.receipt_sha256,status:d.status,transaction_id:d.status==='matched'?text(d.transaction_id,100,true):null};});
 assert(new Set(decisions.map(d=>d.deposit_id)).size===decisions.length,'Duplicate deposit decisions');
 const balance=body.balance_cents??null;assert(balance===null||Number.isSafeInteger(balance)&&Math.abs(balance)<=100000000000,'Bank balance is invalid');
 return{event_id:body.event_id,account_number:account.replace(/[ -]/g,''),maintenance:body.maintenance,transactions,decisions,coverage,balance_cents:balance};
}
function noMatchFinal(order,coverage,now=Date.now()){return !!coverage?.complete&&now>=+new Date(order.expires_at)&&Date.parse(coverage.from)<=+new Date(order.created_at)-300000&&Date.parse(coverage.to)>=+new Date(order.expires_at);}
module.exports={id,cents,text,instant,sign,signed,feed,noMatchFinal};
