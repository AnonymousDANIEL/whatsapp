'use strict';

// Protocol pongs prove the peer is reachable even while an unchanged QR screen
// sends no frames. Ordinary application traffic is not used as a timeout.
function monitorSockets(peers,onStale,{interval=20000,timeout=60000,now=Date.now}={}){
 let stopped=false;
 const states=peers.map(socket=>({socket,lastPong:now()}));
 for(const state of states){
  state.pong=()=>{state.lastPong=now();};
  state.socket.on('open',state.pong);state.socket.on('pong',state.pong);
 }
 const timer=setInterval(check,interval);timer.unref?.();
 function stop(){
  if(stopped)return;stopped=true;clearInterval(timer);
  for(const {socket,pong} of states){socket.off('open',pong);socket.off('pong',pong);}
 }
 function stale(){
  stop();
  for(const {socket} of states)try{socket.terminate();}catch{}
  onStale();
 }
 function check(){
  if(stopped)return;
  for(const {socket,lastPong} of states){
   if(socket.readyState!==1)continue;
   if(now()-lastPong>=timeout)return stale();
   try{socket.ping();}catch{return stale();}
  }
 }
 return {stop,check};
}
module.exports={monitorSockets};
