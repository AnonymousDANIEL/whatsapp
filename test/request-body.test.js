'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const express=require('express');
const bodies=require('../src/request-body');
const bank=require('../src/bank-domain');

async function fixture(t,setup){
 const app=express();setup(app);
 app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.type||err.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 return (path,{body='',headers={},headerOnly=false}={})=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{'Content-Type':'application/json',Connection:'close',...headers}},res=>{
   let data='';res.setEncoding('utf8');res.on('data',c=>data+=c);res.on('end',()=>{req.destroy();resolve({status:res.statusCode,data:res.headers['content-type']?.includes('json')?JSON.parse(data):data});});
  });
  req.on('error',reject);req.setTimeout(2000,()=>req.destroy(Error('Server read an unauthorized request body before rejecting it')));
  if(headerOnly)req.flushHeaders();else req.end(body);
 });
}

test('Unauthenticated and bad-CSRF uploads are rejected without waiting for the body',async t=>{
 let parsed=0;
 const request=await fixture(t,app=>{
  bodies.protectedAPI(app,(req,res,next)=>{if(req.headers.cookie!=='synthetic-session')return res.sendStatus(401);if(req.headers['x-csrf-token']!=='synthetic-csrf')return res.sendStatus(403);next();});
  app.post('/api/upload',(req,res)=>{parsed++;res.json({ok:true});});
 });
 for(const [headers,status] of [[{},401],[{Cookie:'synthetic-session'},403]]){
  const result=await request('/api/upload',{headerOnly:true,headers:{'Content-Length':8*1024*1024,...headers}});
  assert.equal(result.status,status);
 }
 assert.equal(parsed,0);
});

test('Authenticated image uploads retain the full five-megabyte base64 allowance and small password limits',async t=>{
 const request=await fixture(t,app=>{
  bodies.protectedAPI(app,(req,res,next)=>next());
  app.post('/api/upload',(req,res)=>res.json({length:req.body.media.data.length}));
  app.post('/api/password',(req,res)=>res.json({ok:true}));
 });
 const data=Buffer.alloc(5*1024*1024).toString('base64');
 assert.deepEqual(await request('/api/upload',{body:JSON.stringify({media:{data,mimetype:'image/png'}})}),{status:200,data:{length:data.length}});
 assert.equal((await request('/api/password',{body:JSON.stringify({password:'x'.repeat(5000)})})).status,413);
});

test('Public payment JSON obeys the callback limit instead of the private upload allowance',async t=>{
 let calls=0;
 const request=await fixture(t,app=>{
  bodies.publicCallbacks(app);
  app.post('/api/payments/callback/:id',express.urlencoded({extended:false,limit:'32kb'}),(req,res)=>{calls++;res.json(req.body);});
  bodies.protectedAPI(app,(req,res)=>res.sendStatus(401));
 });
 const path='/api/payments/callback/00000000-0000-4000-8000-000000000001';
 assert.equal((await request(path,{body:JSON.stringify({padding:'x'.repeat(40000)})})).status,413);
 assert.equal((await request(path,{body:'padding='+'x'.repeat(40000),headers:{'Content-Type':'application/x-www-form-urlencoded'}})).status,413);
 assert.equal(calls,0);
 const json={id:'synthetic-bill',paid:true,amount:200};
 assert.deepEqual((await request(path,{body:JSON.stringify(json)})).data,json);
 assert.deepEqual((await request(path,{body:'id=synthetic-bill&paid=true&amount=200',headers:{'Content-Type':'application/x-www-form-urlencoded'}})).data,{id:'synthetic-bill',paid:'true',amount:'200'});
});

test('Bank feed header rejection precedes body parsing while signed raw UTF-8 bytes remain exact',async t=>{
 const id='00000000-0000-4000-8000-000000000002',key='synthetic-bank-secret-that-never-leaves-this-fixture',path='/api/banks/feed/'+id;
 const timestamp=String(Math.floor(Date.now()/1000)),body='{ "remark": "\u9a8c\u8bc1\u539f\u6587", "transactions": [] }';
 const request=await fixture(t,app=>{
  bodies.publicCallbacks(app);
  app.post('/api/banks/feed/:id',(req,res)=>{
   if(!bank.signed(req.headers['x-bank-timestamp'],req.params.id,req.rawBankBody,key,req.headers['x-bank-signature']))return res.sendStatus(403);
   res.json({raw:req.rawBankBody.toString(),parsed:req.body});
  });
  bodies.protectedAPI(app,(req,res)=>res.sendStatus(401));
 });
 assert.equal((await request(path,{headerOnly:true,headers:{'Content-Length':8*1024*1024}})).status,403);
 const headers={'x-bank-timestamp':timestamp,'x-bank-signature':bank.sign(timestamp,id,Buffer.from(body),key)};
 const result=await request(path,{body,headers});assert.equal(result.status,200);assert.equal(result.data.raw,body);assert.deepEqual(result.data.parsed,JSON.parse(body));
 assert.equal((await request(path,{body:body+' ',headers})).status,403);
});
