'use strict';
// API-owned shared QR slots. Existing workers, profiles and registered numbers
// retain their current code and identities throughout this additive migration.
const {pool,transaction}=require('./db');
const {assert}=require('./domain');
const capacity=require('./capacity');
const {PLACEMENT_LOCK}=require('./account-allocation');
const {rateLimit}=require('express-rate-limit');
const validId=value=>typeof value==='string'&&/^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
async function ensureLinking(){
 const ready=async db=>(await db.query(`SELECT
  EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='accounts'::regclass AND attname='shared_scan_unbound' AND NOT attisdropped) AND
  EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='accounts'::regclass AND tgname='wa_bind_shared_qr_v1' AND NOT tgisinternal AND tgenabled='O') AS ok`)).rows[0].ok;
 if(await ready(pool))return;
 await transaction(async db=>{
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query("SET LOCAL statement_timeout='60s'");
  await db.query('SELECT pg_advisory_xact_lock(194812733)');
  if(await ready(db))return;
  await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS shared_scan_unbound boolean NOT NULL DEFAULT false');
  await db.query(`CREATE OR REPLACE FUNCTION wa_bind_shared_qr_v1() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
    IF NEW.shared_pool AND OLD.shared_scan_unbound AND OLD.registration_phone IS NULL
      AND NEW.enabled AND NEW.deleted_at IS NULL AND NEW.status='ready'
      AND NEW.phone ~ '^[1-9][0-9]{6,14}$' THEN
     PERFORM pg_advisory_xact_lock(194812736);
     IF EXISTS(SELECT 1 FROM accounts other WHERE other.id<>NEW.id AND other.deleted_at IS NULL
       AND ((NOT other.shared_pool AND replace(other.phone,'+','')=NEW.phone)
         OR (other.shared_pool AND other.registration_phone='+'||NEW.phone))) THEN
      NEW.shared_state:='unknown';
      NEW.last_error:='SHARED_PHONE_CONFLICT';
     ELSE
      NEW.registration_phone:='+'||NEW.phone;
      NEW.shared_scan_unbound:=false;
      NEW.shared_state:='connected';
      NEW.shared_checked_at:=now();
     END IF;
    END IF;
    RETURN NEW;
   END;
  $$`);
  await db.query(`CREATE OR REPLACE TRIGGER wa_bind_shared_qr_v1 BEFORE UPDATE OF phone,status ON accounts
   FOR EACH ROW WHEN (OLD.shared_pool AND OLD.shared_scan_unbound AND OLD.registration_phone IS NULL
     AND NEW.status='ready' AND NEW.phone IS NOT NULL) EXECUTE FUNCTION wa_bind_shared_qr_v1()`);
 });
}
function routes(app,route,workerRoutes,workerCommand){
 const limit=rateLimit({windowMs:60000,limit:20,standardHeaders:false,legacyHeaders:false,keyGenerator:req=>req.user.id,message:{error:'添加账号过于频繁，请稍后再试'}});
 app.post('/api/shared/accounts/scan',limit,route(async(req,res)=>{
  assert(req.user.role==='owner','只有 Owner 可以管理共享 WhatsApp',403);
  const b=req.body,groups=Object.keys(workerRoutes);
  assert(validId(b.request_id),'请求 ID 无效');
  assert(typeof b.label==='string'&&b.label.trim().length>0&&b.label.length<=80,'请输入账号名称');
  assert(b.worker_group===undefined||b.worker_group===''||typeof b.worker_group==='string'&&groups.includes(b.worker_group),'请选择已配置的共享浏览器分组');
  const id=b.request_id,label=b.label.trim(),preferred=b.worker_group||null;
  const result=await transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock($1)',[PLACEMENT_LOCK]);
   const old=(await db.query('SELECT id,label,worker_group,shared_pool,deleted_at FROM accounts WHERE id=$1',[id])).rows[0];
   if(old){
    const proof=(await db.query("SELECT 1 FROM audit WHERE entity_id=$1 AND actor_id=$2 AND action='shared.account.scan.create' LIMIT 1",[id,req.user.id])).rowCount;
    assert(proof&&old.shared_pool&&!old.deleted_at&&old.label===label&&(!preferred||preferred===old.worker_group),'请求 ID 已使用',409);
    return {id,worker_group:old.worker_group,replayed:true};
   }
   assert(groups.length,'尚未配置共享专用扫码容量',503);
   const available=(await capacity.read(db,groups)).filter(w=>w.slots_available>0);
   available.sort((a,b)=>Number(b.worker_group===preferred)-Number(a.worker_group===preferred)||a.slots_used/a.max_accounts-b.slots_used/b.max_accounts||groups.indexOf(a.worker_group)-groups.indexOf(b.worker_group));
   const group=available[0]?.worker_group;
   assert(group,'共享扫码容量暂不可用，请查看共享运行容量',503);
   await db.query(`INSERT INTO accounts(id,label,worker_group,enabled,status,shared_pool,shared_scan_unbound)
    VALUES($1,$2,$3,true,'starting',true,true)`,[id,label,group]);
   await db.query("INSERT INTO audit(actor_id,action,entity_id,details) VALUES($1,'shared.account.scan.create',$2,$3)",[req.user.id,id,{worker_group:group}]);
   return {id,worker_group:group,replayed:false};
  });
  // An identical retry retrieves the row without starting a second browser or
  // restarting a phone that may already have linked since the first response.
  if(result.replayed)return res.status(200).json(result);
  try{await workerCommand(result,'start');res.status(201).json({...result,started:true});}
  catch(error){
   res.status(201).json({...result,started:false,connection:{code:error.publicMessage?error.code:'BROWSER_NOT_READY',message:'账号已添加，浏览器暂未准备好，请在账号列表重试连接。'}});
  }
 }));
}
module.exports={ensureLinking,routes};
