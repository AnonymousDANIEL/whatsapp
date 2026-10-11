'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
// Loading payments needs a configured pool, but these tests never connect to it.
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:9/test';
const {signature,signed}=require('../src/payments');
test('Billplz callback canonicalization uses the documented sorted key+value strings',()=>{
 const data={id:'bill-1',paid:true,paid_amount:200,amount:200,collection_id:'collection',state:'paid'};
 const source='amount200|collection_idcollection|idbill-1|paid_amount200|paidtrue|statepaid';
 const expected=crypto.createHmac('sha256','test-signature').update(source).digest('hex');
 assert.equal(signature(data,'test-signature'),expected);
 assert.equal(signed({...data,x_signature:expected},'test-signature'),true);
 assert.equal(signed({...data,amount:201,x_signature:expected},'test-signature'),false);
 assert.equal(signed({...data,x_signature:'bad'},'test-signature'),false);
});
test('encrypted secrets are bound to purpose and reject tampering',()=>{
 process.env.APP_VAULT_KEY='22'.repeat(32);const vault=require('../src/secrets'),cipher=vault.seal('synthetic password','user-password:one');
 assert.equal(vault.open(cipher,'user-password:one'),'synthetic password');
 assert.throws(()=>vault.open(cipher,'user-password:two'));
 const bytes=Buffer.from(cipher,'base64');bytes[30]^=1;assert.throws(()=>vault.open(bytes.toString('base64'),'user-password:one'));
});
