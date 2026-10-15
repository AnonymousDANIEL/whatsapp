'use strict';
const fs=require('node:fs/promises');
const CPUS_PER_BROWSER=1,PROCESS_RESERVE=120;
function cpuSetForSlot(status,slot=0){
 const list=status.match(/^Cpus_allowed_list:\s*([^\n]+)$/m)?.[1]?.trim();
 if(!list||!Number.isInteger(slot)||slot<0)throw Error('BROWSER_CPU_AFFINITY_UNAVAILABLE');
 const cpus=[];
 for(const part of list.split(',')){
  const match=part.match(/^(\d+)(?:-(\d+))?$/);if(!match)throw Error('BROWSER_CPU_AFFINITY_UNAVAILABLE');
  const first=Number(match[1]),last=Number(match[2]??match[1]);
  if(!Number.isSafeInteger(first)||last<first||last>16383)throw Error('BROWSER_CPU_AFFINITY_UNAVAILABLE');
  for(let cpu=first;cpu<=last;cpu++)cpus.push(cpu);
 }
 const allowed=[...new Set(cpus)],count=Math.min(CPUS_PER_BROWSER,allowed.length);
 if(!count)throw Error('BROWSER_CPU_AFFINITY_UNAVAILABLE');
 return Array.from({length:count},(_,i)=>allowed[(slot*CPUS_PER_BROWSER+i)%allowed.length]).join(',');
}
async function browserCpuSet(slot){return cpuSetForSlot(await fs.readFile('/proc/self/status','utf8'),slot);}
function hasLaunchCapacity({pids,pids_limit:limit}){
 return !Number.isFinite(pids)||!Number.isFinite(limit)||limit-pids>=PROCESS_RESERVE;
}
module.exports={CPUS_PER_BROWSER,PROCESS_RESERVE,cpuSetForSlot,browserCpuSet,hasLaunchCapacity};
