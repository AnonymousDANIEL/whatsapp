'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
// Called only while this worker holds the exclusive PostgreSQL group lock.
// A volume can carry Chromium's lock from the previous container hostname.
async function clearStaleProfileLock(directory,hostname=os.hostname(),alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}){
 let target;try{target=await fs.readlink(path.join(directory,'SingletonLock'));}catch(e){if(e.code==='ENOENT'||e.code==='EINVAL')return false;throw e;}
 const match=/^(.*)-(\d+)$/.exec(target);if(!match)return false;
 if(match[1]===hostname&&alive(Number(match[2])))throw Object.assign(new Error('PROFILE_BROWSER_STILL_RUNNING'),{code:'PROFILE_BROWSER_STILL_RUNNING'});
 for(const name of ['SingletonLock','SingletonSocket','SingletonCookie'])await fs.unlink(path.join(directory,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});
 return true;
}
module.exports={clearStaleProfileLock};
