'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('worker watches cover its actual local dependencies while API-only releases can preserve sessions',()=>{
 const root=path.resolve(__dirname,'..'),patterns=require('../config/worker-watch-paths.json'),seen=new Set();
 function visit(relative){
  if(seen.has(relative))return;seen.add(relative);
  assert.ok(patterns.includes('/'+relative),'Worker dependency missing from watch paths: '+relative);
  const source=fs.readFileSync(path.join(root,relative),'utf8');
  for(const match of source.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)){
   let target=path.posix.join(path.posix.dirname(relative),match[1]);if(!path.posix.extname(target))target+='.js';
   visit(target);
  }
 }
 visit('src/main.js');visit('src/worker.js');
 assert.ok(patterns.includes('/src/schema.sql'));assert.ok(patterns.includes('/bin/**'));
 assert.ok(!seen.has('src/api.js'));assert.ok(!seen.has('src/overview.js'));
 assert.ok(!patterns.includes('/src/**'));assert.ok(!patterns.includes('/src/api.js'));assert.ok(!patterns.includes('/src/overview.js'));
});
