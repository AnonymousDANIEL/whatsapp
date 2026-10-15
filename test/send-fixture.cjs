'use strict';
// Synthetic chat/upload boundary around pinned upstream media preparation.
// Model identity semantics reproduce the documented September __x_id collision;
// this does not simulate real WhatsApp delivery.
function installSendFixture(){
 const fixture=window.sendFixture={sent:[],uploads:0,preparations:0,serializations:0,seen:0,uploadFails:false,enqueueFails:false};
 const models=new Map();let counter=0;
 const wid=id=>({_serialized:id,isLid:()=>false,isGroup:()=>false,isStatus:()=>false});
 class MsgKey{constructor(data){
  if(fixture.modernKeyOnly&&!data.remote)throw TypeError('Modern key requires remote');
  if(fixture.legacyKeyOnly&&!data.to)throw TypeError('Legacy key requires to');
  Object.assign(this,data);this.remote=data.remote||data.to;this.fromMe=data.fromMe===true||data.selfDir==='out';
  const key='true_'+this.remote._serialized+'_'+data.id;this[fixture.keyFormat||'_serialized']=key;
 }static async newId(){return 'synthetic-'+(++counter);}}
 class OpaqueData{
  constructor(file){this.file=file;this.type=file.type;}
  static async createFromData(file){return new OpaqueData(file);}
  url(){return 'blob:synthetic';}autorelease(){}formData(){return this.file;}
 }
 let mediaObject;
 class OutgoingModel{
  constructor(message){
   const initializedId=Object.hasOwn(message,'__x_id')?message.__x_id:message.id;
   if(!initializedId?.id||!initializedId.remote||!initializedId.fromMe)throw Error("Data passed to getter must include an id property but got undefined");
   Object.assign(this,message);
  }
  serialize(){fixture.serializations++;throw Error('Synthetic broken unrelated serializer');}
 }
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
   return {__x_id:undefined,type:'image',filehash:'synthetic-processed-image-hash',mimetype:opaque.type,mediaBlob:opaque,preview:'synthetic-thumbnail',
    toJSON(){return {type:this.type,filehash:this.filehash,mimetype:this.mimetype,directPath:this.directPath,...(fixture.mediaJsonId?{id:'private-media-id',__x_id:undefined}:{})};},set(fields){Object.assign(this,fields);}};
  }})},
  WAWebMediaStorage:{getOrCreateMediaObject:filehash=>(mediaObject={filehash,type:'image',size:123,consolidate(){}})},
  WAWebMmsMediaTypes:{msgToMediaType:()=> 'image',castToV4:()=> 'image'},
  WAWebMediaDataUtils:{shouldUseMediaCache:()=>false},
  WAWebMediaMmsV4Upload:{uploadMedia:async()=>{fixture.uploads++;if(fixture.uploadFails)throw Error('Synthetic upload failed');return {mediaEntry:{mmsUrl:'https://invalid.example/synthetic',directPath:'/synthetic',mediaKey:'not-a-key',encFilehash:'synthetic-encrypted'}};}},
  WAWebSendMsgChatAction:{addAndSendMsgToChat:(_chat,message)=>{
   if(fixture.enqueueFails)throw Error('Synthetic uncertain enqueue');
   const model=new OutgoingModel(message);
   fixture.sent.push(message);
   if(!fixture.cacheMissing)models.set(message.id._serialized||message.id.$1,model);
   if(fixture.throwAfterCreate)throw Error('Synthetic exception after local creation');
   // Waiting for a server response used to hide the already-created message ID.
   return [Promise.resolve(fixture.localMissing?undefined:model),fixture.serverReject?Promise.reject(Error('Synthetic uncertain server failure')):new Promise(()=>{})];
  }},
  WAWebCollections:{Msg:{get:id=>models.get(id),modelClass:OutgoingModel},Chat:{getModelsArray:()=>[{id:wid('60000000000@c.us')}]}}
 };
 fixture.overrides={};window.require=name=>{if(name in fixture.overrides)return fixture.overrides[name];if(!(name in modules))throw Error('Unexpected fixture module '+name);return modules[name];};
 window.WWebJS.getChat=async chatId=>({id:wid(chatId)});
 window.WWebJS.sendSeen=async()=>{fixture.seen++;throw Error('Synthetic broken unread-state API');};
 return fixture;
}
module.exports={installSendFixture};
