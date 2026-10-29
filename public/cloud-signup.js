'use strict';
(()=>{
 const params=new URLSearchParams(location.search),en=params.get('lang')==='en',T=(zh,english)=>en?english:zh,$=s=>document.querySelector(s),account=params.get('account_id');
 document.documentElement.lang=en?'en':'zh-CN';document.documentElement.dataset.theme=localStorage.getItem('wa_theme')==='light'?'light':'dark';
 $('#signup-intro').textContent=T('在 Meta 官方窗口输入新号码，选择 SMS 或语音并填写验证码。不使用手机 App、扫码或 Linked Devices。','Enter your new number in Meta’s official window, choose SMS or voice, and enter the code. No mobile app, QR scan or Linked Devices.');
 for(const line of [T('登录 Meta，选择或创建您的商家资产。','Sign in to Meta and select or create your business assets.'),T('验证您拥有的电话号码，并完成授权。','Verify the phone number you own and complete authorization.'),T('回到本系统，设置六位安全 PIN 并完成 Cloud API 开通。','Return here, set a six-digit security PIN and complete Cloud API registration.')]){const li=document.createElement('li');li.textContent=line;$('#signup-steps').append(li);}
 $('#signup-launch').textContent=T('使用 Meta 注册新号码','Register with Meta');$('#signup-back').textContent=T('返回号码管理','Return to number management');
 let cfg,csrf,active=false,assets=null,exchanged=false,completing=false;
 const status=s=>$('#signup-status').textContent=s;
 async function api(p,b){const r=await fetch('/api'+p,{method:b?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf||''},body:b?JSON.stringify(b):undefined,signal:AbortSignal.timeout(35000)});const d=await r.json();if(!r.ok)throw Error(d.code||d.error||'Request failed');return d;}
 const auth=()=>({session_id:cfg.session_id,nonce:cfg.nonce});
 function error(e){active=false;$('#signup-launch').disabled=true;status(T('暂未完成：','Not completed: ')+e.message+T('。请关闭此页后重新打开授权。',' — close this page and open authorization again.'));}
 async function finish(){if(!active||!exchanged||!assets||completing)return;completing=true;try{await api('/cloud/signup/complete',{...auth(),...assets,event:'FINISH'});active=false;status(T('号码授权及验证已保存。请返回号码管理，点击“完成开通”，设置安全 PIN。','Authorization and verification saved. Return to number management and choose Complete registration to set your security PIN.'));}catch(e){error(e);}}
 window.addEventListener('message',event=>{
  if(!active||!['https://www.facebook.com','https://web.facebook.com','https://business.facebook.com'].includes(event.origin))return;
  let m;try{m=typeof event.data==='string'?JSON.parse(event.data):event.data;}catch{return;}
  if(m?.type!=='WA_EMBEDDED_SIGNUP')return;
  if(m.event==='FINISH'&&/^\d{5,30}$/.test(m.data?.phone_number_id||'')&&/^\d{5,30}$/.test(m.data?.waba_id||'')){assets={phone_number_id:m.data.phone_number_id,waba_id:m.data.waba_id};finish();}
  else if(m.event==='CANCEL')error(Error(T('您已取消 Meta 开户','Meta signup cancelled')));
  else if(m.event==='ERROR'||String(m.event).startsWith('FINISH_'))error(Error(T('请选择新号码的 Cloud API 开户流程','Choose the Cloud API flow for a new number')));
 });
 async function boot(){
  const me=await api('/me');if(me.user.role!=='owner')throw Error('Owner only');csrf=me.csrf;
  cfg=await api('/cloud/accounts/'+encodeURIComponent(account)+'/signup',{reauthorize:params.get('reauthorize')==='1'});
  window.fbAsyncInit=()=>{FB.init({appId:cfg.app_id,autoLogAppEvents:false,xfbml:false,version:cfg.graph_version});$('#signup-launch').disabled=false;status(T('准备好了。点击按钮打开 Meta 官方注册窗口。','Ready. Click the button to open Meta’s official signup window.'));};
  const sdk=document.createElement('script');sdk.async=true;sdk.defer=true;sdk.crossOrigin='anonymous';sdk.src='https://connect.facebook.net/en_US/sdk.js';sdk.onerror=()=>error(Error(T('Meta SDK 暂时无法加载','Meta SDK could not load')));document.head.append(sdk);
  $('#signup-launch').onclick=()=>{if(active)return;active=true;$('#signup-launch').disabled=true;status(T('请在 Meta 窗口完成电话号码和验证码步骤。','Complete the number and verification steps in the Meta window.'));FB.login(response=>{
   if(!active)return;const code=response.authResponse?.code;if(!code)return error(Error(T('Meta 未返回授权','Meta did not return authorization')));
   // Exchange immediately: Meta's single-use code expires after 30 seconds.
   api('/cloud/signup/exchange',{...auth(),code}).then(()=>{exchanged=true;finish();}).catch(error);
  },{config_id:cfg.config_id,response_type:'code',override_default_response_type:true,extras:{setup:cfg.setup}});};
 }
 boot().catch(error);
})();
