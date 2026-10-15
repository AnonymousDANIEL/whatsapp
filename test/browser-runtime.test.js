'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {cpuSetForSlot,browserCpuSet,hasLaunchCapacity}=require('../src/browser-runtime');
test('Browser CPU affinity stays inside sparse/nonzero allowed cores and spreads slots without assuming CPU zero',()=>{
 const status='Name:\tworker\nCpus_allowed_list:\t24-27,40,44-45\n';
 assert.equal(cpuSetForSlot(status,0),'24');assert.equal(cpuSetForSlot(status,1),'25');assert.equal(cpuSetForSlot(status,4),'40');assert.equal(cpuSetForSlot(status,6),'45');assert.equal(cpuSetForSlot(status,7),'24');
 assert.equal(cpuSetForSlot('Cpus_allowed_list:\t31\n',9),'31');
 for(const value of ['','Cpus_allowed_list:\t3-1\n','Cpus_allowed_list:\t0;echo bad\n','Cpus_allowed_list:\t0-999999\n'])assert.throws(()=>cpuSetForSlot(value),/BROWSER_CPU_AFFINITY_UNAVAILABLE/);
});
test('Launch admission reserves process capacity and safely handles unbounded/unavailable counters',()=>{
 assert.equal(hasLaunchCapacity({pids:880,pids_limit:1000}),true);assert.equal(hasLaunchCapacity({pids:881,pids_limit:1000}),false);assert.equal(hasLaunchCapacity({pids:1000,pids_limit:1000}),false);
 assert.equal(hasLaunchCapacity({pids:20,pids_limit:'max'}),true);assert.equal(hasLaunchCapacity({pids:null,pids_limit:null}),true);
});
test('Real taskset child sees one allowed CPU',{skip:process.platform!=='linux'},async()=>{
 const cpus=await browserCpuSet(1),child=spawnSync('taskset',['--cpu-list',cpus,process.execPath,'-e',"console.log(require('node:os').availableParallelism())"],{encoding:'utf8'});
 assert.ifError(child.error);assert.equal(child.status,0,child.stderr);assert.equal(Number(child.stdout),1);
});
