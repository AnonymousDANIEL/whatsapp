'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{routingConfiguration}=require('../src/shared-routing');
test('legacy runtime routes remain exact and missing shared configuration borrows nothing',()=>{
 const original={'group-a':'http://legacy-a:8080','group-b':'https://legacy-b:8443/'};
 assert.deepEqual(routingConfiguration({WORKER_ROUTES_JSON:JSON.stringify(original)}),{routes:original,sharedGroups:[]});
 assert.deepEqual(routingConfiguration({}),{routes:{},sharedGroups:[]});
 assert.deepEqual(routingConfiguration({WORKER_ROUTES_JSON:JSON.stringify(original),SHARED_WORKER_GROUPS_JSON:'["group-b"]'}),{routes:original,sharedGroups:['group-b']});
});
test('six additive shared routes preserve twenty existing routes and remain explicitly dedicated',()=>{
 const original=Object.fromEntries(Array.from({length:20},(_,i)=>['personal-'+i,'http://personal-'+i+':8080']));
 const extra=Object.fromEntries(Array.from({length:6},(_,i)=>['shared-0'+(i+1),'http://shared-0'+(i+1)+':8080'])),groups=Object.keys(extra);
 const env={WORKER_ROUTES_JSON:JSON.stringify(original),SHARED_WORKER_ROUTES_JSON:JSON.stringify(extra),SHARED_WORKER_GROUPS_JSON:JSON.stringify(groups)},before={...env};
 const result=routingConfiguration(env);assert.deepEqual(result.sharedGroups,groups);assert.equal(Object.keys(result.routes).length,26);
 for(const [group,address] of Object.entries(original))assert.equal(result.routes[group],address);
 assert.deepEqual(result.routes,{...original,...extra});assert.deepEqual(env,before);
});
test('additive routes cannot replace any existing group, including with the identical address',()=>{
 for(const address of ['http://original:8080','http://replacement:8080'])assert.throws(()=>routingConfiguration({WORKER_ROUTES_JSON:'{"same":"http://original:8080"}',SHARED_WORKER_ROUTES_JSON:JSON.stringify({same:address}),SHARED_WORKER_GROUPS_JSON:'["same"]'}),/不能覆盖/);
});
test('undeclared, missing and duplicate dedicated groups fail closed',()=>{
 assert.throws(()=>routingConfiguration({SHARED_WORKER_ROUTES_JSON:'{"shared":"http://shared:8080"}'}),/共享专用/);
 assert.throws(()=>routingConfiguration({SHARED_WORKER_GROUPS_JSON:'["missing"]'}),/配置无效/);
 assert.throws(()=>routingConfiguration({WORKER_ROUTES_JSON:'{"same":"http://same:8080"}',SHARED_WORKER_GROUPS_JSON:'["same","same"]'}),/配置无效/);
 for(const groups of ['null','{}','[1]','["../bad"]'])assert.throws(()=>routingConfiguration({SHARED_WORKER_GROUPS_JSON:groups}),/配置无效/);
});
test('malformed maps and credentialed or non-origin shared endpoints fail closed',()=>{
 for(const field of ['WORKER_ROUTES_JSON','SHARED_WORKER_ROUTES_JSON'])for(const value of ['null','[]','1','"text"'])assert.throws(()=>routingConfiguration({[field]:value}),/必须为对象/);
 for(const address of [null,1,{},'not-a-url','file:///data','ftp://worker','http://user:password@worker','http://worker/?token=x','http://worker/#fragment','http://worker/prefix'])assert.throws(()=>routingConfiguration({SHARED_WORKER_ROUTES_JSON:JSON.stringify({shared:address}),SHARED_WORKER_GROUPS_JSON:'["shared"]'}),/地址无效/);
});
test('a second dedicated expansion preserves original personal and fifteen shared route strings exactly',()=>{
 const original=Object.fromEntries(Array.from({length:20},(_,i)=>['personal-'+i,'http://original-'+i+':8080/']));
 const shared=Object.fromEntries(Array.from({length:15},(_,i)=>['shared-'+(i+1),'http://existing-shared-'+i+':8080']));
 const additional=Object.fromEntries(Array.from({length:15},(_,i)=>['shared-'+(i+16),'http://new-shared-'+i+':8080']));
 const env={WORKER_ROUTES_JSON:JSON.stringify(original),SHARED_WORKER_ROUTES_JSON:JSON.stringify(shared),SHARED_ADDITIONAL_ROUTES_JSON:JSON.stringify(additional),SHARED_WORKER_GROUPS_JSON:JSON.stringify([...Object.keys(shared),...Object.keys(additional)])},before={...env};
 const result=routingConfiguration(env);assert.deepEqual(result.routes,{...original,...shared,...additional});assert.equal(result.sharedGroups.length,30);assert.equal(Object.keys(result.routes).length,50);assert.deepEqual(env,before);
});
test('second-stage routes cannot collide, borrow personal groups, or accept malformed endpoints',()=>{
 for(const value of ['null','[]','1'])assert.throws(()=>routingConfiguration({SHARED_ADDITIONAL_ROUTES_JSON:value}),/必须为对象/);
 for(const address of ['http://same:8080','http://different:8080'])assert.throws(()=>routingConfiguration({SHARED_WORKER_ROUTES_JSON:'{"shared":"http://same:8080"}',SHARED_ADDITIONAL_ROUTES_JSON:JSON.stringify({shared:address}),SHARED_WORKER_GROUPS_JSON:'["shared"]'}),/不能覆盖/);
 assert.throws(()=>routingConfiguration({WORKER_ROUTES_JSON:'{"personal":"http://personal:8080"}',SHARED_ADDITIONAL_ROUTES_JSON:'{"personal":"http://personal:8080"}',SHARED_WORKER_GROUPS_JSON:'["personal"]'}),/不能覆盖/);
 assert.throws(()=>routingConfiguration({SHARED_ADDITIONAL_ROUTES_JSON:'{"shared":"http://shared:8080"}'}),/共享专用/);
 for(const address of ['file:///data','http://user:password@worker','http://worker/prefix'])assert.throws(()=>routingConfiguration({SHARED_ADDITIONAL_ROUTES_JSON:JSON.stringify({shared:address}),SHARED_WORKER_GROUPS_JSON:'["shared"]'}),/地址无效/);
});
