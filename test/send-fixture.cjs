'use strict';
// Synthetic private chat and upload boundary. Pinned upstream preparation and
// enqueue implementations still run, without a WhatsApp login or network access.
function installSendFixture(){
 const fixture=window.sendFixture={sent:[],uploads:0,preparations:0,serializations:0,seen:0,uploadFails:false,enqueueFails:false};
 const models=new Map();let counter=0;
 const wid=id=>({_serialized:id,isLid:()=>false,isGroup:()=>false,isStatus:()=>false});
 class MsgKey{constructor(data){Object.assign(this,data);this.remote=data.to;this.fromMe=true;this._serialized='true_'+data.to._serialized+'_'+data.id;}static async newId(){return 'synthetic-'+(++counter);}}
 class OpaqueData{
  constructor(file){this.file=file;this.type=file.type;}
  static async createFromData(file){return new OpaqueData(file);}
  url(){return 'blob:synthetic';}autorelease(){}formData(){return this.file;}
 }
 let mediaObject;
 const modules={
  WAWebChatGetters:{getIsNewsletter:()=>false,getIsBroadcast:()=>false},
  WALinkify:{findLink:()=>null,findLinks:()=>[]},
  WAWebUserPrefsMeUser:{getMaybeMeLidUser:()=>wid('owner@lid'),getMaybeMePnUser:()=>wid('owner@c.us')},
  WAWebMsgKey:MsgKey,
  WAWebGetEphemeralFieldsMsgActionsUtils:{getEphemeralFields:()=>({})},
  WAWebMediaOpaqueData:OpaqueData,
  WAWebPrepRawMedia:{prepRawMedia:(opaque,options)=>({waitForPrep:async()=>{
   fixture.preparations++;if(options.asDocument)throw Error('Must remain an inline image');
   if(fixture.waitPreparation)await fixture.waitPreparation;
   return {type:'image',filehash:'synthetic-processed-image-hash',mimetype:opaque.type,mediaBlob:opaque,preview:'synthetic-thumbnail',
    toJSON(){return {type:this.type,filehash:this.filehash,mimetype:this.mimetype,directPath:this.directPath};},set(fields){Object.assign(this,fields);}};
  }})},
  WAWebMediaStorage:{getOrCreateMediaObject:filehash=>(mediaObject={filehash,type:'image',size:123,consolidate(){}})},
  WAWebMmsMediaTypes:{msgToMediaType:()=> 'image',castToV4:()=> 'image'},
  WAWebMediaDataUtils:{shouldUseMediaCache:()=>false},
  WAWebMediaMmsV4Upload:{uploadMedia:async()=>{fixture.uploads++;if(fixture.uploadFails)throw Error('Synthetic upload failed');return {mediaEntry:{mmsUrl:'https://invalid.example/synthetic',directPath:'/synthetic',mediaKey:'not-a-key',encFilehash:'synthetic-encrypted'}};}},
  WAWebSendMsgChatAction:{addAndSendMsgToChat:(_chat,message)=>{
   if(fixture.enqueueFails)throw Error('Synthetic uncertain enqueue');
   fixture.sent.push(message);
   const model={...message,serialize(){fixture.serializations++;throw Error('Synthetic broken unrelated serializer');}};
   models.set(message.id._serialized,model);
   // Waiting for a server response used to hide the already-created message ID.
   return [Promise.resolve(model),new Promise(()=>{})];
  }},
  WAWebCollections:{Msg:{get:id=>models.get(id)},Chat:{getModelsArray:()=>[{id:wid('60000000000@c.us')}]}}
 };
 fixture.overrides={};window.require=name=>{if(name in fixture.overrides)return fixture.overrides[name];if(!(name in modules))throw Error('Unexpected fixture module '+name);return modules[name];};
 window.WWebJS.getChat=async chatId=>({id:wid(chatId)});
 window.WWebJS.sendSeen=async()=>{fixture.seen++;throw Error('Synthetic broken unread-state API');};
 return fixture;
}
module.exports={installSendFixture};
