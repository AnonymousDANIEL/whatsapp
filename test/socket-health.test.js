'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter,once}=require('node:events');
const {WebSocket,WebSocketServer}=require('ws'),{monitorSockets}=require('../src/socket-health');
function peer(state=1){const p=new EventEmitter();p.readyState=state;p.pings=0;p.terminated=0;p.ping=()=>p.pings++;p.terminate=()=>{p.terminated++;};return p;}
test('Silent QR screens remain connected for days when protocol pongs arrive; stopped monitors release listeners',()=>{
 let time=0;const p=peer(),health=monitorSockets([p],()=>assert.fail('healthy QR was closed'),{now:()=>time,interval:99999999});
 for(let i=0;i<2*86400/20;i++){time+=20000;p.emit('pong');health.check();}
 assert.equal(p.terminated,0);assert.ok(p.pings>8000);health.stop();assert.equal(p.listenerCount('pong'),0);assert.equal(p.listenerCount('open'),0);health.check();
});
test('A half-open leg terminates both bridge peers once, even if the other peer still responds',()=>{
 let time=0,failed=0;const a=peer(),b=peer(),health=monitorSockets([a,b],()=>failed++,{now:()=>time,interval:99999999});
 time=20000;a.emit('pong');health.check();time=60000;a.emit('pong');health.check();health.check();
 assert.equal(failed,1);assert.equal(a.terminated,1);assert.equal(b.terminated,1);assert.equal(a.listenerCount('pong'),0);
});
test('A connecting peer starts its pong deadline on open, and ping errors clean up the bridge',()=>{
 let time=0,failed=0;const p=peer(0),health=monitorSockets([p],()=>failed++,{now:()=>time,interval:99999999});
 time=120000;health.check();assert.equal(failed,0);p.readyState=1;p.emit('open');health.check();assert.equal(failed,0);
 p.ping=()=>{throw Error('closed transport');};health.check();assert.equal(failed,1);assert.equal(p.terminated,1);
});
test('Real WebSockets keep a quiet responsive screen and retire a peer that stops answering pings',async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0}),monitors=[],clients=[];let failures=0;
 server.on('connection',socket=>{socket.on('error',()=>{});const health=monitorSockets([socket],()=>failures++,{interval:50,timeout:500});monitors.push(health);socket.on('close',()=>health.stop());socket.on('message',data=>socket.send(data));});
 try{
  await once(server,'listening');const url='ws://127.0.0.1:'+server.address().port;
  const healthy=new WebSocket(url),silent=new WebSocket(url,{autoPong:false});clients.push(healthy,silent);healthy.on('error',()=>{});silent.on('error',()=>{});
  await Promise.all([once(healthy,'open'),once(silent,'open')]);
  let timer;try{await Promise.race([once(silent,'close'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Silent peer was never retired')),5000);})]);}finally{clearTimeout(timer);}
  assert.equal(failures,1);assert.equal(healthy.readyState,WebSocket.OPEN);
  const reply=once(healthy,'message');healthy.send('local fixture');assert.equal(String((await reply)[0]),'local fixture');
 }finally{for(const health of monitors)health.stop();for(const socket of clients)socket.terminate();for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));}
});
