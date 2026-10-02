'use strict';
function messageId(message) {
  const id=message?.id;
  if(typeof id==='string' && id.length) return id;
  if(typeof id?._serialized==='string' && id._serialized.length) return id._serialized;
  if(typeof id?.$1==='string' && id.$1.length) return id.$1;
  return null;
}
function validAck(ack) { return Number.isInteger(ack)&&ack>=-1&&ack<=4; }
function messageAck(message) { return validAck(message?.ack)?message.ack:0; }
module.exports={messageId,validAck,messageAck};
