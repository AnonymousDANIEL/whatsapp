'use strict';
const crypto=require('node:crypto');
const {rateLimit}=require('express-rate-limit');
const {pool,transaction,audit}=require('./db');
const {assert}=require('./domain');
const {validateImage}=require('./media');
const billing=require('./billing'),vault=require('./secrets'),v=require('./bank-domain');
const MAX_BALANCE=1000000000000;
const owner=req=>assert(req.user.role==='owner','Only Owner can manage banks',403);
function unavailable(ok,message){if(!ok)throw Object.assign(new Error(message),{status:503,publicMessage:true});}
function publicBank(b,full=false){return{id:b.id,bank_name:b.bank_name,account_name:b.account_name,account_number:b.account_number,status:b.status==='disabled'?'disabled':b.status==='maintenance'||b.feed_maintenance?'maintenance':'active',has_qr:!!(b.has_qr??b.qr),display_order:b.display_order,...(full?{configured:!!(b.configured??b.feed_key_cipher),remark:b.remark,configured_status:b.status,feed_seen_at:b.feed_seen_at,reported_balance_cents:b.reported_balance_cents,created_at:b.created_at}:{})};}
async function bank(id,db=pool){const b=(await db.query('SELECT id,bank_name,account_name,account_number,status,feed_key_cipher,feed_maintenance FROM bank_accounts WHERE id=$1',[v.id(id)])).rows[0];assert(b,'Bank does not exist',404);return b;}
async function deposit(id,user){const d=(await pool.query('SELECT * FROM bank_deposits WHERE id=$1',[v.id(id)])).rows[0];assert(d&&(user.role==='owner'||d.user_id===user.id),'Deposit access denied',403);return d;}
async function reject(db,d,reason,actor=null){await db.query("UPDATE bank_deposits SET state='rejected',reason_code=$2,checked_at=now(),reviewed_by=$3 WHERE id=$1",[d.id,reason,actor]);}
// All financial paths acquire the wallet before deposits/transactions, like send holds.
async function applyDecision(bankId,decision,coverage=null,actor=null){
 const info=(await pool.query('SELECT user_id FROM bank_deposits WHERE id=$1 AND bank_id=$2',[decision.deposit_id,bankId])).rows[0];assert(info,'Deposit does not belong to this bank',409);
 const result=await transaction(async db=>{
  const u=(await db.query('SELECT credit_units,role FROM users WHERE id=$1 FOR UPDATE',[info.user_id])).rows[0];
  const d=(await db.query('SELECT * FROM bank_deposits WHERE id=$1 FOR UPDATE',[decision.deposit_id])).rows[0];
  assert(d.receipt_sha256===decision.receipt_sha256,'Receipt changed; verify again',409);
  if(d.state==='credited'||d.state==='rejected')return{state:d.state,user_id:d.user_id};
  assert(['pending','review'].includes(d.state),'Deposit receipt is not submitted',409);
  if(decision.status==='invalid'){await reject(db,d,'receipt_invalid',actor);return{state:'rejected'};}
  if(decision.status==='no_match'){
   if(v.noMatchFinal(d,coverage)){await reject(db,d,'no_bank_match',actor);return{state:'rejected'};}
   await db.query('UPDATE bank_deposits SET checked_at=now() WHERE id=$1',[d.id]);return{state:d.state};
  }
  const t=(await db.query('SELECT * FROM bank_transactions WHERE bank_id=$1 AND transaction_id=$2 FOR UPDATE',[bankId,decision.transaction_id])).rows[0];
  assert(t&&(actor||t.source==='feed'),'Verified bank transaction is required',409);
  let reason=null;
  if(t.direction!=='in')reason='not_incoming';else if(Number(t.amount_cents)!==d.amount_cents)reason='amount_mismatch';else if(t.deposit_id&&t.deposit_id!==d.id)reason='transaction_used';
  else if(!actor&&(+new Date(t.occurred_at)<+new Date(d.created_at)-300000||+new Date(t.occurred_at)>+new Date(d.expires_at)))reason='outside_payment_window';
  if(reason){if(actor)assert(false,'Bank transaction does not match this deposit',409);await reject(db,d,reason);return{state:'rejected'};}
  assert(u.role!=='owner','Owner does not need credit',409);
  const units=d.amount_cents*100,balance=Number(u.credit_units)+units;assert(Number.isSafeInteger(balance)&&balance<=MAX_BALANCE,'Credit balance is too large',409);
  await db.query('UPDATE users SET credit_units=$1 WHERE id=$2',[balance,d.user_id]);
  await db.query("UPDATE bank_deposits SET state='credited',reason_code=NULL,checked_at=now(),credited_at=now(),reviewed_by=$2 WHERE id=$1",[d.id,actor]);
  await db.query('UPDATE bank_transactions SET deposit_id=$3 WHERE bank_id=$1 AND transaction_id=$2',[bankId,t.transaction_id,d.id]);
  await db.query("INSERT INTO credit_ledger(user_id,actor_id,kind,delta_units,balance_units,deposit_id) VALUES($1,$2,'bank_topup',$3,$4,$5)",[d.user_id,actor,units,balance,d.id]);
  if(actor)await db.query("INSERT INTO audit(actor_id,action,entity_id) VALUES($1,'bank.deposit.confirm',$2)",[actor,d.id]);
  return{state:'credited',user_id:d.user_id};
 });
 if(result.state==='credited')await billing.recoverCreditTasks(result.user_id);return result;
}
async function acceptFeed(bankId,input,bodyHash){
 const f=v.feed(input);
 const already=await transaction(async db=>{
  const b=(await db.query('SELECT account_number FROM bank_accounts WHERE id=$1 FOR UPDATE',[bankId])).rows[0];assert(b.account_number===f.account_number,'Bank feed account does not match',409);
  const old=(await db.query('SELECT * FROM bank_feed_events WHERE bank_id=$1 AND event_id=$2',[bankId,f.event_id])).rows[0];
  if(old){assert(old.body_hash===bodyHash,'Bank event content changed',409);if(old.processed)return true;}
  else await db.query('INSERT INTO bank_feed_events(bank_id,event_id,body_hash) VALUES($1,$2,$3)',[bankId,f.event_id,bodyHash]);
  for(const t of f.transactions){
   const prev=(await db.query('SELECT * FROM bank_transactions WHERE bank_id=$1 AND transaction_id=$2',[bankId,t.id])).rows[0];
   if(prev){assert(prev.direction===t.direction&&Number(prev.amount_cents)===t.amount_cents&&+new Date(prev.occurred_at)===Date.parse(t.occurred_at)&&prev.reference===t.reference,'Bank transaction content changed',409);if(prev.source==='owner')await db.query("UPDATE bank_transactions SET source='feed' WHERE bank_id=$1 AND transaction_id=$2",[bankId,t.id]);continue;}
   await db.query('INSERT INTO bank_transactions(bank_id,transaction_id,direction,amount_cents,occurred_at,description,reference) VALUES($1,$2,$3,$4,$5,$6,$7)',[bankId,t.id,t.direction,t.amount_cents,t.occurred_at,t.description,t.reference]);
  }
  await db.query('UPDATE bank_accounts SET feed_maintenance=$2,feed_seen_at=now(),reported_balance_cents=$3 WHERE id=$1',[bankId,f.maintenance,f.balance_cents]);return false;
 });
 if(already)return{ok:true,replayed:true};
 // The adapter must bind a verified bank entry to the deposit AND uploaded slip hash.
 // No amount-only or OCR-only guesses are accepted.
 for(const d of f.decisions)await applyDecision(bankId,d,f.coverage);
 await pool.query('UPDATE bank_feed_events SET processed=true WHERE bank_id=$1 AND event_id=$2',[bankId,f.event_id]);return{ok:true};
}
async function feedAuth(req,payload){
 const b=await bank(req.params.id);unavailable(b.feed_key_cipher,'Bank connection is not configured');
 assert(v.signed(req.headers['x-bank-timestamp'],b.id,payload,vault.open(b.feed_key_cipher,'bank-feed:'+b.id),req.headers['x-bank-signature']),'Bank signature is invalid',403);return b;
}
function callbackRoutes(app,route){
 const limit=rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-8',legacyHeaders:false});
 app.post('/api/banks/feed/:id',limit,route(async(req,res)=>{assert(req.rawBankBody,'Bank feed requires JSON');const b=await feedAuth(req,req.rawBankBody);res.json(await acceptFeed(b.id,req.body,crypto.createHash('sha256').update(req.rawBankBody).digest('hex')));}));
 app.get('/api/banks/feed/:id/queue',limit,route(async(req,res)=>{
  const b=await feedAuth(req,Buffer.from('GET '+req.originalUrl));
  const page=paging(req),rows=(await pool.query("SELECT id,amount_cents,receipt_sha256,receipt_mime,created_at,expires_at,submitted_at FROM bank_deposits WHERE bank_id=$1 AND state IN ('pending','review') ORDER BY submitted_at,id LIMIT 20 OFFSET $2",[b.id,(page-1)*20])).rows;
  res.json({bank_id:b.id,account_number:b.account_number,page,deposits:rows});
 }));
 app.get('/api/banks/feed/:id/receipts/:deposit',limit,route(async(req,res)=>{
  const b=await feedAuth(req,Buffer.from('GET '+req.originalUrl));
  const d=(await pool.query("SELECT receipt,receipt_mime FROM bank_deposits WHERE id=$1 AND bank_id=$2 AND state IN ('pending','review')",[v.id(req.params.deposit),b.id])).rows[0];assert(d?.receipt,'Receipt is unavailable',404);res.type(d.receipt_mime).send(d.receipt);
 }));
}
function paging(req){const page=Number(req.query.page||1);assert(Number.isSafeInteger(page)&&page>=1&&page<=100000,'Page is invalid');return page;}
function routes(app,route){
 app.get('/api/banks',route(async(req,res)=>{
  const enabled=(await pool.query('SELECT enabled FROM bank_settings WHERE id=1')).rows[0].enabled,full=req.user.role==='owner';
  const rows=full||enabled?(await pool.query("SELECT id,bank_name,account_name,account_number,status,(qr IS NOT NULL) has_qr,remark,display_order,(feed_key_cipher IS NOT NULL) configured,feed_maintenance,feed_seen_at,reported_balance_cents,created_at FROM bank_accounts WHERE $1 OR status<>'disabled' ORDER BY display_order,created_at",[full])).rows:[];
  res.json({enabled,banks:rows.map(b=>publicBank(b,full))});
 }));
 app.get('/api/banks/:id/qr',route(async(req,res)=>{const b=await bank(req.params.id),enabled=(await pool.query('SELECT enabled FROM bank_settings WHERE id=1')).rows[0].enabled;assert(req.user.role==='owner'||enabled&&b.status==='active'&&!b.feed_maintenance,'Bank QR is unavailable',403);const qr=(await pool.query('SELECT qr FROM bank_accounts WHERE id=$1',[b.id])).rows[0].qr;assert(qr,'Bank QR is unavailable',404);res.type(qr.mimetype).send(Buffer.from(qr.data,'base64'));}));
 app.put('/api/banks/settings',route(async(req,res)=>{owner(req);assert(typeof req.body.enabled==='boolean','Bank switch is invalid');await transaction(async db=>{await db.query('UPDATE bank_settings SET enabled=$1 WHERE id=1',[req.body.enabled]);await db.query("INSERT INTO audit(actor_id,action,details) VALUES($1,'bank.switch',$2)",[req.user.id,{enabled:req.body.enabled}]);});res.json({ok:true});}));
 async function save(req,res,existing){
  owner(req);const b=req.body,id=existing?v.id(req.params.id):crypto.randomUUID();
  const name=v.text(b.bank_name,100,true),accountName=v.text(b.account_name,160,true),number=v.text(b.account_number,40,true).replace(/[ -]/g,''),remark=v.text(b.remark??'',2000);
  assert(/^\d[\d -]{3,39}$/.test(number),'Bank account number is invalid');assert(['active','maintenance','disabled'].includes(b.status)&&Number.isSafeInteger(b.display_order)&&Math.abs(b.display_order)<=10000,'Bank status is invalid');
  assert(b.feed_key===undefined||typeof b.feed_key==='string'&&(!b.feed_key||b.feed_key.length>=32&&b.feed_key.length<=200),'Connection key must have 32–200 characters');
  const qr=b.qr===undefined?undefined:b.qr===null?null:validateImage(b.qr);
  await transaction(async db=>{
   const old=existing?(await db.query('SELECT * FROM bank_accounts WHERE id=$1 FOR UPDATE',[id])).rows[0]:null;assert(!existing||old,'Bank does not exist',404);
   if(old?.account_number!==number&&old){const history=await db.query('SELECT 1 FROM bank_deposits WHERE bank_id=$1 UNION ALL SELECT 1 FROM bank_transactions WHERE bank_id=$1 LIMIT 1',[id]);assert(!history.rowCount,'Create a new bank account to change its number after transactions',409);}
   const key=b.feed_key?vault.seal(b.feed_key,'bank-feed:'+id):old?.feed_key_cipher||null;
   if(old)await db.query('UPDATE bank_accounts SET bank_name=$2,account_name=$3,account_number=$4,status=$5,remark=$6,display_order=$7,qr=$8,feed_key_cipher=$9,updated_at=now() WHERE id=$1',[id,name,accountName,number,b.status,remark,b.display_order,qr===undefined?old.qr:qr,key]);
   else await db.query('INSERT INTO bank_accounts(id,bank_name,account_name,account_number,status,remark,display_order,qr,feed_key_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,name,accountName,number,b.status,remark,b.display_order,qr??null,key]);
   await db.query("INSERT INTO audit(actor_id,action,entity_id) VALUES($1,'bank.save',$2)",[req.user.id,id]);
  });res.status(existing?200:201).json({id});
 }
 app.post('/api/banks',route((req,res)=>save(req,res,false)));app.patch('/api/banks/:id',route((req,res)=>save(req,res,true)));
 const createLimit=rateLimit({windowMs:60000,limit:5,standardHeaders:'draft-8',legacyHeaders:false,keyGenerator:req=>req.user.id});
 app.post('/api/bank-deposits',createLimit,route(async(req,res)=>{
  assert(req.user.role==='user','Owner does not need credit',403);const b=req.body,bankId=v.id(b.bank_id),amount=v.cents(b.amount),requestId=v.id(b.request_id);
  const d=await transaction(async db=>{
   const user=(await db.query('SELECT active,locked FROM users WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];assert(user.active&&!user.locked,'USER is inactive or locked',403);
   const old=(await db.query('SELECT * FROM bank_deposits WHERE request_id=$1',[requestId])).rows[0];if(old){assert(old.user_id===req.user.id&&old.bank_id===bankId&&old.amount_cents===amount,'Deposit request content changed',409);return old;}
   const enabled=(await db.query('SELECT enabled FROM bank_settings WHERE id=1 FOR SHARE')).rows[0].enabled,bk=(await db.query('SELECT id,bank_name,account_name,account_number,status,feed_maintenance FROM bank_accounts WHERE id=$1 FOR SHARE',[bankId])).rows[0];assert(bk,'Bank does not exist',404);
   unavailable(enabled&&bk.status==='active'&&!bk.feed_maintenance,'Bank is closed or under maintenance');
   const n=(await db.query("SELECT count(*)::int n FROM bank_deposits WHERE user_id=$1 AND state IN ('awaiting_slip','pending','review') AND expires_at>now()",[req.user.id])).rows[0].n;assert(n<5,'Complete pending deposits first',409);
   return(await db.query('INSERT INTO bank_deposits(id,bank_id,user_id,request_id,amount_cents,bank_snapshot) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[crypto.randomUUID(),bankId,req.user.id,requestId,amount,{bank_name:bk.bank_name,account_name:bk.account_name,account_number:bk.account_number}])).rows[0];
  });res.status(201).json({id:d.id,amount_cents:d.amount_cents,state:d.state,expires_at:d.expires_at});
 }));
 app.post('/api/bank-deposits/:id/receipt',createLimit,route(async(req,res)=>{
  const info=await deposit(req.params.id,req.user);assert(req.user.role==='user'&&info.user_id===req.user.id,'Only the depositor can submit a receipt',403);
  const image=validateImage(req.body.receipt);assert(image,'Transfer receipt is required');const bytes=Buffer.from(image.data,'base64'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
  const result=await transaction(async db=>{
   const user=(await db.query('SELECT active,locked FROM users WHERE id=$1 FOR UPDATE',[info.user_id])).rows[0];assert(user.active&&!user.locked,'USER is inactive or locked',403);
   const d=(await db.query('SELECT * FROM bank_deposits WHERE id=$1 FOR UPDATE',[info.id])).rows[0];
   if(d.receipt_sha256===sha)return{state:d.state};assert(d.state==='awaiting_slip','Receipt already submitted',409);
   const late=Date.now()>=+new Date(d.expires_at);
   // Serialize hash claims across different wallets; a reused slip is visibly rejected.
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[sha]);
   const used=(await db.query("SELECT 1 FROM bank_deposits WHERE receipt_sha256=$1 AND state<>'rejected'",[sha])).rowCount;
   const state=used?'rejected':late?'review':'pending';
   await db.query('UPDATE bank_deposits SET receipt=$2,receipt_mime=$3,receipt_sha256=$4,state=$5,reason_code=$6,submitted_at=now() WHERE id=$1',[d.id,bytes,image.mimetype,sha,state,used?'duplicate_receipt':late?'late_receipt':null]);return{state};
  });res.json(result);
 }));
 app.get('/api/bank-deposits',route(async(req,res)=>{
  const page=paging(req),state=req.query.state||'',bankId=req.query.bank_id?v.id(req.query.bank_id):null;
  assert(['','awaiting_slip','pending','review','credited','rejected'].includes(state),'Deposit status is invalid');
  const args=[req.user.role,req.user.id,state,bankId];const where="WHERE ($1='owner' OR d.user_id=$2) AND ($3='' OR d.state=$3) AND ($4::uuid IS NULL OR d.bank_id=$4)";
  const total=Number((await pool.query('SELECT count(*) n FROM bank_deposits d '+where,args)).rows[0].n);
  const rows=(await pool.query(`SELECT d.id,d.bank_id,d.user_id,d.amount_cents,d.state,d.reason_code,d.receipt_sha256,d.created_at,d.expires_at,d.submitted_at,d.checked_at,d.credited_at,d.bank_snapshot->>'bank_name' bank_name,u.username FROM bank_deposits d JOIN users u ON u.id=d.user_id ${where} ORDER BY d.created_at DESC,d.id LIMIT 100 OFFSET $5`,[...args,(page-1)*100])).rows;
  if(req.user.role!=='owner')for(const d of rows){delete d.user_id;delete d.username;delete d.receipt_sha256;}
  res.json({rows,total,page});
 }));
 app.get('/api/bank-deposits/:id/receipt',route(async(req,res)=>{const d=await deposit(req.params.id,req.user);assert(d.receipt,'Receipt is unavailable',404);res.set('Content-Disposition','inline; filename="receipt.'+({"image/png":"png","image/jpeg":"jpg","image/webp":"webp"}[d.receipt_mime])+'"').type(d.receipt_mime).send(d.receipt);}));
 app.post('/api/bank-deposits/:id/review',route(async(req,res)=>{
  owner(req);const d=await deposit(req.params.id,req.user);assert(['pending','review'].includes(d.state)||d.state==='credited','Deposit cannot be reviewed',409);
  if(req.body.action==='reject'){assert(d.state!=='credited','Credited deposits cannot be rejected',409);await transaction(async db=>{const current=(await db.query('SELECT * FROM bank_deposits WHERE id=$1 FOR UPDATE',[d.id])).rows[0];assert(['pending','review'].includes(current.state),'Deposit cannot be reviewed',409);await reject(db,current,'owner_rejected',req.user.id);await db.query("INSERT INTO audit(actor_id,action,entity_id) VALUES($1,'bank.deposit.reject',$2)",[req.user.id,d.id]);});return res.json({state:'rejected'});}
  assert(req.body.action==='confirm'&&req.body.confirmed===true,'Confirm the real bank entry before crediting');
  res.json(await applyDecision(d.bank_id,{deposit_id:d.id,receipt_sha256:d.receipt_sha256,status:'matched',transaction_id:v.text(req.body.transaction_id,100,true)},null,req.user.id));
 }));
 app.post('/api/banks/:id/transactions',route(async(req,res)=>{
  owner(req);await bank(req.params.id);const b=req.body,amount=billing.units(b.amount,true);assert(amount%100===0,'Bank amount must have at most two decimals');
  const entry={id:v.text(b.transaction_id,100,true),direction:b.direction,amount_cents:amount/100,occurred_at:v.instant(b.occurred_at),description:v.text(b.description??'',2000),reference:v.text(b.reference??'',200)};assert(['in','out'].includes(entry.direction),'Bank direction is invalid');assert(b.confirmed===true,'Confirm the real bank entry first');
  await transaction(async db=>{await db.query("INSERT INTO bank_transactions(bank_id,transaction_id,direction,amount_cents,occurred_at,description,reference,source) VALUES($1,$2,$3,$4,$5,$6,$7,'owner')",[req.params.id,entry.id,entry.direction,entry.amount_cents,entry.occurred_at,entry.description,entry.reference]);await db.query("INSERT INTO audit(actor_id,action,entity_id) VALUES($1,'bank.transaction.record',$2)",[req.user.id,req.params.id]);});res.json({ok:true});
 }));
 app.get('/api/bank-transactions',route(async(req,res)=>{
  owner(req);const page=paging(req),bankId=req.query.bank_id?v.id(req.query.bank_id):null,day=req.query.day||'',direction=req.query.direction||'',search=v.text(req.query.search||'',100);
  assert(!day||/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day)),'Bank date is invalid');assert(['','in','out'].includes(direction),'Bank direction is invalid');
  const args=[bankId,day,direction,search],where="WHERE ($1::uuid IS NULL OR t.bank_id=$1) AND ($2='' OR (t.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date=to_date(NULLIF($2,''),'YYYY-MM-DD')) AND ($3='' OR t.direction=$3) AND ($4='' OR position(lower($4) in lower(t.description||' '||t.transaction_id||' '||t.reference))>0)";
  const summary=(await pool.query(`SELECT count(*)::int total,COALESCE(sum(t.amount_cents) FILTER(WHERE t.direction='in'),0) incoming_cents,COALESCE(sum(t.amount_cents) FILTER(WHERE t.direction='out'),0) outgoing_cents FROM bank_transactions t ${where}`,args)).rows[0];
  const rows=(await pool.query(`SELECT t.*,b.bank_name,d.user_id,u.username FROM bank_transactions t JOIN bank_accounts b ON b.id=t.bank_id LEFT JOIN bank_deposits d ON d.id=t.deposit_id LEFT JOIN users u ON u.id=d.user_id ${where} ORDER BY t.occurred_at DESC,t.transaction_id LIMIT 100 OFFSET $5`,[...args,(page-1)*100])).rows;
  res.json({rows,summary,page,total:summary.total});
 }));
}
module.exports={routes,callbackRoutes,publicBank,applyDecision,acceptFeed};
