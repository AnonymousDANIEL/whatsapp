'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {hourAt,priceUnits,settings,registrationNumbers,inspectClient,linkedPhone}=require('../src/shared-domain');
test('Shared rates use Malaysia hour boundaries and exact positive integer units',()=>{
 assert.equal(hourAt(new Date('2026-10-14T15:59:59Z')),23);assert.equal(hourAt(new Date('2026-10-14T16:00:00Z')),0);
 assert.equal(priceUnits('0.0001'),1);assert.equal(priceUnits('10000'),100000000);assert.equal(priceUnits('1.2345'),12345);
 for(const value of ['0','-1','0.00001','1e2','10000.0001','01',1])assert.throws(()=>priceUnits(value));
});
test('Shared settings accept unset defaults, reject duplicate hours and preserve pacing bounds',()=>{
 const base={enabled:false,price:'',hours:[],interval_ms:10000,batch_size:1};assert.equal(settings(base).price_units,null);
 assert.deepEqual(settings({...base,price:'0.1',hours:[{hour:0,price:'1.5'},{hour:23,price:''}]}).hours,[{hour:0,price_units:15000}]);
 for(const hours of [[{hour:24,price:'1'}],[{hour:0,price:'1'},{hour:0,price:'2'}],[{hour:1,price:'0'}]])assert.throws(()=>settings({...base,hours}));
 assert.throws(()=>settings({...base,enabled:'true'}));assert.throws(()=>settings({...base,interval_ms:4999}));
});
test('Shared registration validates and deduplicates records without registering accounts',()=>{
 const r=registrationNumbers('+60123456789\n0123456789');assert.equal(r.recipients.length,1);assert.equal(r.duplicates,1);
 assert.throws(()=>registrationNumbers('wrong'));assert.throws(()=>registrationNumbers(Array.from({length:201},(_,i)=>'+60123456'+String(i).padStart(3,'0')).join('\n')));
});
test('Connection probes distinguish connected, waiting, offline and unknown without sending',async()=>{
 let probes=0;const entry={ready:true,client:{getState:async()=>{probes++;return 'CONNECTED';}}};
 assert.equal(await inspectClient(entry),'connected');assert.equal(probes,1);
 assert.equal(await inspectClient({...entry,ready:false}),'waiting');assert.equal(await inspectClient(null),'offline');
 assert.equal(await inspectClient({ready:true,client:{getState:async()=> 'UNPAIRED'}}),'offline');
 assert.equal(await inspectClient({ready:true,client:{getState:async()=>{throw Error('test offline');}}}),'unknown');
 assert.equal(await inspectClient({ready:true,client:{getState:()=>new Promise(()=>{})}},5),'unknown');
});

test('Only a linked phone identity can verify shared-number ownership',()=>{
 assert.equal(linkedPhone({client:{info:{wid:{user:'60123456789',server:'c.us'}}}}),'60123456789');
 assert.equal(linkedPhone({client:{info:{wid:{user:'60123456789',server:'lid'}}}}),null);
 assert.equal(linkedPhone({client:{info:{wid:{user:'not-a-phone',server:'c.us'}}}}),null);
 assert.equal(linkedPhone(null),null);
});
