'use strict';
const {transaction}=require('./db');
// Called by the owning worker only after the browser and sync work have stopped.
async function purgeAccountData(id){
 return transaction(async db=>{
  const a=(await db.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!a?.purge_requested)return false;
  await db.query(`DELETE FROM audit WHERE entity_id=$1 OR details->>'account_id'=$1 OR entity_id IN(SELECT id::text FROM campaigns WHERE account_id=$1::uuid) OR entity_id IN(SELECT message_id FROM message_history WHERE account_id=$1::uuid) OR entity_id IN(SELECT r.message_id FROM recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE c.account_id=$1::uuid)`,[id]);
  await db.query('DELETE FROM recipients WHERE campaign_id IN(SELECT id FROM campaigns WHERE account_id=$1::uuid)',[id]);
  await db.query('DELETE FROM campaigns WHERE account_id=$1',[id]);
  for(const table of ['message_history','receipts','history_exclusions','control_leases','account_grants'])await db.query('DELETE FROM '+table+' WHERE account_id=$1',[id]);
  await db.query('DELETE FROM accounts WHERE id=$1',[id]);return true;
 });
}
module.exports={purgeAccountData};
