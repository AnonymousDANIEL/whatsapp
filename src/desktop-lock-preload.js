'use strict';
// Explicit per-service opt-in preserves all other browser deployments. The
// original main entrypoint, tini subreaper, profiles and lifecycle stay intact.
if(process.env.SERVICE_ROLE!=='worker')throw Error('DESKTOP_LOCK_RECOVERY_REQUIRES_WORKER');
require('./desktop-locks').install();
setTimeout(()=>console.log('Desktop lock recovery ready:',JSON.stringify({version:1,private_uid_only:true,cleanup_before_slot_release:true})),2000).unref();
