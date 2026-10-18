'use strict';
const {assert}=require('./domain');
function routingConfiguration(env){
 const original=JSON.parse(env.WORKER_ROUTES_JSON||'{}'),extra=JSON.parse(env.SHARED_WORKER_ROUTES_JSON||'{}'),sharedGroups=JSON.parse(env.SHARED_WORKER_GROUPS_JSON||'[]');
 const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 assert(record(original)&&record(extra),'运行路由配置必须为对象',500);
 assert(Array.isArray(sharedGroups)&&sharedGroups.every(g=>typeof g==='string'&&/^[\w-]{1,40}$/.test(g))&&new Set(sharedGroups).size===sharedGroups.length,'共享运行分组配置无效',500);
 for(const [group,address] of Object.entries(extra)){
  assert(sharedGroups.includes(group),'新增共享路由必须属于共享专用分组',500);
  assert(!Object.hasOwn(original,group),'新增共享路由不能覆盖现有运行分组',500);
  let valid=false;
  try{const url=new URL(address);valid=typeof address==='string'&&['http:','https:'].includes(url.protocol)&&Boolean(url.hostname)&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/';}catch{}
  assert(valid,'新增共享运行路由地址无效',500);
 }
 const routes={...original,...extra};
 assert(sharedGroups.every(g=>Object.hasOwn(routes,g)),'共享运行分组配置无效',500);
 return {routes,sharedGroups};
}
module.exports={routingConfiguration};
