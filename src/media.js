'use strict';
const {assert}=require('./domain');
function validateImage(value){
 if(value==null)return null;
 assert(value&&typeof value.data==='string'&&value.data.length<=6990510,'Image must be JPEG, PNG or WebP, up to 5 MB');
 assert(/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)&&value.data.length%4===0,'Invalid image data');
 const bytes=Buffer.from(value.data,'base64');assert(bytes.length>12&&bytes.length<=5*1024*1024,'Image must be JPEG, PNG or WebP, up to 5 MB');
 const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
 assert(mime&&mime===value.mimetype,'Image must be JPEG, PNG or WebP, up to 5 MB');
 return {data:bytes.toString('base64'),mimetype:mime,filename:'photo.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime])};
}
module.exports={validateImage};
