'use strict';
const crypto=require('node:crypto');
const express=require('express');
const {rateLimit}=require('express-rate-limit');
const {pool,transaction}=require('./db');
const billing=require('./billing');
const {assert}=require('./domain');
const vault=require('./secrets');
function signature(data,key){
 const pairs=Object.entries(data).filter(([k])=>k!=='x_signature').map(([k,v])=>{assert(v==null||['string','boolean','number'].includes(typeof v),'支付签名格式无效',400);return k+String(v??'');});
 pairs.sort((a,b)=>a.toLowerCase()<b.toLowerCase()?-1:a.toLowerCase()>b.toLowerCase()?1:0);
 return crypto.createHmac('sha256',key).update(pairs.join('|')).digest('hex');
}
function signed(data,key){if(!/^[a-f0-9]{64}$/i.test(data?.x_signature||''))return false;return crypto.timingSafeEqual(Buffer.from(signature(data,key),'hex'),Buffer.from(data.x_signature,'hex'));}
function origin(c){return c.sandbox?'https://www.billplz-sandbox.com':'https://www.billplz.com';}
async function gateway(c,path,body){
 try{const r=await fetch(origin(c)+'/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(c.api_key+':').toString('base64'),...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},body:body?new URLSearchParams(body):undefined,signal:AbortSignal.timeout(10000),redirect:'error'});assert(r.ok,'支付服务暂时无法连接，请稍后重试',502);return await r.json();}
 catch(e){if(e.status)throw e;assert(false,'支付服务暂时无法连接，请稍后重试',502);}
}
function config(s){return{sandbox:s.sandbox,collection_id:s.collection_id,api_key:s.api_key_cipher?vault.open(s.api_key_cipher,'payment-api'):'',x_key:s.x_key_cipher?vault.open(s.x_key_cipher,'payment-signature'):''};}
function publicSettings(s,owner=false){return{enabled:s.enabled,sandbox:s.sandbox,configured:!!(s.collection_id&&s.api_key_cipher&&s.x_key_cipher),...(owner?{collection_id:s.collection_id,api_key_saved:!!s.api_key_cipher,x_key_saved:!!s.x_key_cipher}:{})};}
async function finish(order,bill){
 const c=JSON.parse(vault.open(order.config_cipher,'order:'+order.id));
 assert(bill.id&&(order.bill_id==null||bill.id===order.bill_id)&&bill.collection_id===c.collection_id&&Number(bill.amount)===order.amount_cents&&bill.reference_2===order.id,'支付订单或金额不一致',409);
 assert(!order.sandbox,'测试支付不能充值真实余额',409);
 if(bill.paid!==true||bill.state!=='paid')return false;
 assert(Number(bill.paid_amount)===order.amount_cents,'支付订单或金额不一致',409);
 await transaction(async db=>{
  // Wallet first, matching manual adjustments and send reservations.
  const u=(await db.query('SELECT credit_units FROM users WHERE id=$1 FOR UPDATE',[order.user_id])).rows[0];
  const current=(await db.query('SELECT state FROM topup_orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];if(current.state==='paid')return;
  const amount=order.amount_cents*100,balance=Number(u.credit_units)+amount;
  assert(Number.isSafeInteger(balance),'余额超出允许范围',409);
  await db.query('UPDATE users SET credit_units=$1 WHERE id=$2',[balance,order.user_id]);
  await db.query("UPDATE topup_orders SET state='paid',bill_id=$2,paid_at=now(),last_checked_at=now() WHERE id=$1",[order.id,bill.id]);
  await db.query("INSERT INTO credit_ledger(user_id,kind,delta_units,balance_units,order_id) VALUES($1,'online_topup',$2,$3,$4)",[order.user_id,amount,balance,order.id]);
 });await billing.recoverCreditTasks(order.user_id);return true;
}
async function verify(order,billId=order.bill_id){assert(billId&&/^[\w-]{1,80}$/.test(billId),'付款订单尚未准备好',409);const c=JSON.parse(vault.open(order.config_cipher,'order:'+order.id));const b=await gateway(c,'v3/bills/'+encodeURIComponent(billId));await finish(order,b);await pool.query('UPDATE topup_orders SET last_checked_at=now() WHERE id=$1',[order.id]);}
function callbackRoutes(app,route,uuid){
 app.post('/api/payments/callback/:id',rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false}),express.urlencoded({extended:false,limit:'32kb'}),route(async(req,res)=>{
  const o=(await pool.query('SELECT * FROM topup_orders WHERE id=$1',[uuid(req.params.id)])).rows[0];assert(o,'付款订单不存在',404);
  const c=JSON.parse(vault.open(o.config_cipher,'order:'+o.id));assert(signed(req.body,c.x_key),'支付签名无效',403);
  assert(req.body.collection_id===c.collection_id&&Number(req.body.amount)===o.amount_cents&&(o.bill_id==null||req.body.id===o.bill_id),'支付订单或金额不一致',409);
  if(String(req.body.paid)==='true'&&o.state!=='paid')await verify(o,req.body.id);
  res.json({ok:true});
 }));
}
function routes(app,route,uuid){
 app.get('/api/payments/settings',route(async(req,res)=>res.json(publicSettings((await pool.query('SELECT * FROM payment_settings WHERE id=1')).rows[0],req.user.role==='owner'))));
 app.put('/api/payments/settings',route(async(req,res)=>{
  assert(req.user.role==='owner','只有 Owner 可以管理在线充值',403);const b=req.body;
  assert(typeof b.enabled==='boolean'&&typeof b.sandbox==='boolean','支付配置无效');assert(typeof b.collection_id==='string'&&/^[\w-]{0,80}$/.test(b.collection_id),'Collection ID 无效');
  for(const k of ['api_key','x_key'])assert(b[k]===undefined||typeof b[k]==='string'&&b[k].length<=200,'支付密钥无效');
  await transaction(async db=>{
   const s=(await db.query('SELECT * FROM payment_settings WHERE id=1 FOR UPDATE')).rows[0];const modeChanged=s.sandbox!==b.sandbox;
   const api=b.api_key?vault.seal(b.api_key.trim(),'payment-api'):modeChanged?null:s.api_key_cipher;
   const x=b.x_key?vault.seal(b.x_key.trim(),'payment-signature'):modeChanged?null:s.x_key_cipher;
   assert(!b.enabled||api&&x&&b.collection_id,'请先填写完整支付商户配置');
   await db.query('UPDATE payment_settings SET enabled=$1,sandbox=$2,collection_id=$3,api_key_cipher=$4,x_key_cipher=$5,updated_at=now() WHERE id=1',[b.enabled,b.sandbox,b.collection_id,api,x]);
   await db.query("INSERT INTO audit(actor_id,action,details) VALUES($1,'payment.settings',$2)",[req.user.id,{enabled:b.enabled,sandbox:b.sandbox,collection_id:b.collection_id}]);
  });res.json({ok:true});
 }));
 const createLimiter=rateLimit({windowMs:60000,limit:5,standardHeaders:'draft-8',legacyHeaders:false,keyGenerator:req=>req.user.id,message:{error:'充值请求过于频繁，请稍后重试'}});
 app.post('/api/payments/orders',createLimiter,route(async(req,res)=>{
  assert(req.user.role!=='owner','Owner 余额无限，无需在线充值');const b=req.body;uuid(b.request_id);
  assert(typeof b.amount==='string'&&/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(b.amount),'在线充值金额最多两位小数');
  const amount=Math.round(Number(b.amount)*100);assert(amount>=200&&amount<=1000000,'在线充值范围 RM 2–10000');
  assert(typeof b.email==='string'&&b.email.length<=200&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email),'请输入有效付款邮箱');
  const result=await transaction(async db=>{
   await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
   const old=(await db.query('SELECT * FROM topup_orders WHERE request_id=$1',[b.request_id])).rows[0];
   if(old){assert(old.user_id===req.user.id&&old.amount_cents===amount,'重复请求内容不一致',409);return{order:old,existing:true};}
   const s=(await db.query('SELECT * FROM payment_settings WHERE id=1 FOR SHARE')).rows[0];assert(s.enabled&&!s.sandbox&&publicSettings(s).configured,'在线充值暂时关闭，请稍后再试',503);
   const n=(await db.query("SELECT count(*)::int n FROM topup_orders WHERE user_id=$1 AND state IN ('creating','pending') AND created_at>now()-interval '1 hour'",[req.user.id])).rows[0].n;assert(n<5,'请先完成或核对已有充值订单',409);
   const id=crypto.randomUUID(),c=config(s);const o=(await db.query('INSERT INTO topup_orders(id,user_id,request_id,amount_cents,config_cipher,sandbox) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,req.user.id,b.request_id,amount,vault.seal(JSON.stringify(c),'order:'+id),s.sandbox])).rows[0];return{order:o,c,existing:false};
  });
  const o=result.order;if(result.existing){assert(o.payment_url&&o.state!=='create_failed','订单正在创建或结果待核对，请勿重复付款',409);return res.json({id:o.id,url:o.payment_url,sandbox:o.sandbox});}
  const publicUrl=new URL(process.env.PUBLIC_URL||'http://localhost:3000');
  try{
   const bill=await gateway(result.c,'v3/bills',{collection_id:result.c.collection_id,email:b.email,name:req.user.username,amount:String(amount),callback_url:new URL('/api/payments/callback/'+o.id,publicUrl).href,redirect_url:new URL('/?topup='+o.id,publicUrl).href,description:'WhatsApp credit top-up',reference_2_label:'Order',reference_2:o.id,deliver:'false'});
   assert(/^[\w-]{1,80}$/.test(bill.id||''),'支付服务返回异常',502);const url=new URL(bill.url);assert(url.origin===origin(result.c)&&url.pathname.startsWith('/bills/'),'支付服务返回异常',502);
   await pool.query("UPDATE topup_orders SET state=CASE WHEN state='paid' THEN state ELSE 'pending' END,bill_id=$2,payment_url=$3 WHERE id=$1",[o.id,bill.id,url.href]);
   res.status(201).json({id:o.id,url:url.href,sandbox:o.sandbox});
  }catch(e){await pool.query("UPDATE topup_orders SET state='create_failed' WHERE id=$1 AND state='creating'",[o.id]);throw e;}
 }));
 app.get('/api/payments/orders',route(async(req,res)=>{
  res.json((await pool.query(`SELECT o.id,o.user_id,u.username,o.amount_cents,o.state,o.bill_id,o.payment_url,o.sandbox,o.created_at,o.paid_at
    FROM topup_orders o JOIN users u ON u.id=o.user_id WHERE $1='owner' OR o.user_id=$2 ORDER BY o.created_at DESC LIMIT 100`,[req.user.role,req.user.id])).rows);
 }));
 app.post('/api/payments/orders/:id/check',rateLimit({windowMs:60000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,keyGenerator:req=>req.user.id}),route(async(req,res)=>{
  const o=(await pool.query('SELECT * FROM topup_orders WHERE id=$1',[uuid(req.params.id)])).rows[0];assert(o&&(req.user.role==='owner'||o.user_id===req.user.id),'无权查看充值订单',403);
  if(o.state!=='paid')await verify(o);res.json({ok:true,state:(await pool.query('SELECT state FROM topup_orders WHERE id=$1',[o.id])).rows[0].state});
 }));
}
module.exports={signature,signed,finish,gateway,callbackRoutes,routes};
