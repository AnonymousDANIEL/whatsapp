'use strict';
const crypto=require('node:crypto');
const {assert}=require('./domain');
function key(){assert(/^[a-f0-9]{64}$/i.test(process.env.APP_VAULT_KEY||''),'缺少 APP_VAULT_KEY，暂不能保存密码或支付配置',503);return Buffer.from(process.env.APP_VAULT_KEY,'hex');}
function seal(value,context){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key(),iv);c.setAAD(Buffer.from(context));const data=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');}
function open(value,context){const b=Buffer.from(value,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key(),b.subarray(0,12));c.setAAD(Buffer.from(context));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString('utf8');}
module.exports={seal,open};
