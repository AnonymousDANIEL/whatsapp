'use strict';
const {transaction}=require('./db'),{hash}=require('./domain');
async function purgeAccountData(id){
 return transaction(async db=>{
  const a=(await db.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!a?.purge_requested)return false;
  await require('./billing').assertNoHolds(db,null,id);
  for(const r of (await db.query(`SELECT COALESCE(r.send_account_id,c.account_id) account_id,r.message_id FROM recipients r JOIN campaigns c ON c.id=r.campaign_id
   WHERE c.account_id=$1::uuid AND r.message_id IS NOT NULL AND COALESCE(r.send_account_id,c.account_id)<>$1::uuid`,[id])).rows)
   await db.query('INSERT INTO history_exclusions(account_id,message_hash) SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM accounts WHERE id=$1) ON CONFLICT DO NOTHING',[r.account_id,hash(r.message_id)]);
  await db.query(`DELETE FROM audit WHERE entity_id=$1 OR details->>'account_id'=$1 OR entity_id IN(SELECT id::text FROM campaigns WHERE account_id=$1::uuid) OR entity_id IN(SELECT message_id FROM message_history WHERE account_id=$1::uuid) OR entity_id IN(SELECT r.message_id FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE c.account_id=$1::uuid OR r.send_account_id=$1::uuid)`,[id]);
  await db.query(`DELETE FROM message_history m USING recipients r,campaigns c WHERE c.id=r.campaign_id AND c.account_id=$1::uuid
   AND m.account_id=COALESCE(r.send_account_id,c.account_id) AND m.message_id=r.message_id`,[id]);
  await db.query(`DELETE FROM receipts m USING recipients r,campaigns c WHERE c.id=r.campaign_id AND c.account_id=$1::uuid
   AND m.account_id=COALESCE(r.send_account_id,c.account_id) AND m.message_id=r.message_id`,[id]);
  await db.query('DELETE FROM recipients WHERE campaign_id IN(SELECT id FROM campaigns WHERE account_id=$1::uuid) OR send_account_id=$1::uuid',[id]);
  await db.query('DELETE FROM campaigns WHERE account_id=$1',[id]);
  for(const table of ['message_history','receipts','history_exclusions','control_leases','account_grants'])await db.query('DELETE FROM '+table+' WHERE account_id=$1',[id]);
  await db.query('DELETE FROM accounts WHERE id=$1',[id]);return true;
 });
}
module.exports={purgeAccountData};
