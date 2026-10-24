'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{once}=require('node:events'),http=require('node:http'),zlib=require('node:zlib');
const childCode=`
 const app=require('express')();
 app.use(require('express').json());
 app.post('/',(req,res)=>res.json(req.body));
 app.use((error,req,res,next)=>res.status(400).json({error:'bad body'}));
 app.listen(0,'127.0.0.1',function(){process.send({port:this.address().port});});
`;
function request(port,body,encoding){
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:'/',method:'POST',headers:{'content-type':'application/json','content-length':body.length,...(encoding?{'content-encoding':encoding}:{})}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
  });
  req.setTimeout(3000,()=>req.destroy(Error('Fixture request timeout')));req.on('error',reject);req.end(body);
 });
}
for(const [encoding,compress] of [['gzip',zlib.gzipSync],['deflate',zlib.deflateSync],['br',zlib.brotliCompressSync]]){
 test('Compressed '+encoding+' trailing bytes cannot terminate the request process',{timeout:10000},async t=>{
  const child=spawn(process.execPath,['-e',childCode],{cwd:process.cwd(),stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}});
  const ready=await Promise.race([once(child,'message').then(([message])=>message),once(child,'exit').then(([code])=>{throw Error('Fixture exited before ready: '+code+' '+stderr);})]);
  const json=Buffer.from('{"healthy":true}'),poison=Buffer.concat([compress(json),Buffer.from('trailing-invalid-frame')]);
  await request(ready.port,poison,encoding).catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(child.exitCode,null,'Malformed compressed input must not crash the process: '+stderr);
  const next=await request(ready.port,json);
  assert.equal(next.status,200);assert.deepEqual(JSON.parse(next.body),{healthy:true});
 });
}
