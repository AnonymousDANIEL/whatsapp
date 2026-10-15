'use strict';
const fs=require('node:fs/promises'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
// Use the image's declared entrypoint beneath another parent, as Railway does.
// The orphan is disposable and has a private UID; no account/browser is involved.
const harness=String.raw`
const fs=require('node:fs/promises'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{once}=require('node:events');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 assert.notEqual(process.ppid,1,'Tini must run beneath another init for this regression');
 const middle=spawn(process.execPath,['-e',"const p=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{uid:27999,gid:27999,stdio:'ignore'});console.log(p.pid);p.unref();"],{stdio:['ignore','pipe','inherit']});
 let output='';middle.stdout.on('data',data=>output+=data);const [code]=await once(middle,'close');assert.equal(code,0);
 const orphan=Number(output.trim());assert.ok(Number.isInteger(orphan)&&orphan>1&&orphan!==process.pid);
 let adopted=false;
 for(let attempt=0;attempt<100;attempt++){
  const status=await fs.readFile('/proc/'+orphan+'/status','utf8');
  assert.match(status,/^Uid:\s+27999\s+27999\s+/m);
  if(Number(status.match(/^PPid:\s+(\d+)/m)?.[1])===process.ppid){adopted=true;break;}
  await pause(20);
 }
 assert.equal(adopted,true,'Orphan was not adopted by the non-PID-1 Tini subreaper');
 process.kill(orphan,'SIGTERM');
 let reaped=false;
 for(let attempt=0;attempt<100;attempt++){
  try{await fs.stat('/proc/'+orphan);}catch(error){if(error.code==='ENOENT'){reaped=true;break;}throw error;}
  await pause(20);
 }
 assert.equal(reaped,true,'Exited orphan remained as a zombie');
 console.log('Non-PID-1 worker init PASS: private orphan adopted and reaped');
})().catch(error=>{console.error(error);process.exitCode=1;});`;
(async()=>{
 const dockerfile=await fs.readFile('/app/Dockerfile.worker','utf8'),entry=JSON.parse(dockerfile.match(/^ENTRYPOINT (\[.+\])$/m)[1]);
 const child=spawn(entry[0],[...entry.slice(1),process.execPath,'-e',harness],{stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 assert.equal(code,0,output+errors);assert.doesNotMatch(errors,/reaping won't work|isn't registered as a child subreaper/);assert.match(output,/private orphan adopted and reaped/);
 process.stdout.write(output);
})().catch(error=>{console.error(error);process.exitCode=1;});
