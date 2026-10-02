'use strict';
const {readFileSync,lstatSync,realpathSync}=require('node:fs');
const {isAbsolute,join}=require('node:path');
const {createHash,randomBytes}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {DesktopGameHostSessionBroker}=require('./game-host-session-broker.cjs');
const fail=()=>Error('game_host_setup_unavailable');
const closed=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function gameHostSetupFromArguments(args){
 const value=flag=>{const matches=args.filter(arg=>arg===flag||arg.startsWith(flag+'='));if(matches.length>1)throw fail();if(!matches.length)return null;return matches[0].startsWith(flag+'=')?matches[0].slice(flag.length+1):args[args.indexOf(flag)+1];};
 const path=value('--game-host-setup'),sha256=value('--game-host-setup-sha256');
 if(path===null&&sha256===null)return null;
 if(typeof path!=='string'||!isAbsolute(path)||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw fail();
 return Object.freeze({path,sha256});
}

/** One trusted-main composition. The descriptor is an explicitly selected,
 * pinned operator setup, not a renderer/model message or a new authority grant.
 * Session credentials stay in the existing broker. Native pairing is ephemeral.
 * No setup means read-only readiness/status/stop; there is no automatic start. */
function createDesktopGameHostComposition({controls,net,partition,sdk,sourceRevision,nativeDirectory,setupSource=null,now=Date.now}){
 if(!controls||typeof controls.bindBroker!=='function'||typeof sdk?.gameHostMessage!=='function'||typeof sdk?.createOwnedWindowsGameHostDriver!=='function'||typeof sdk?.GameFrameCustody!=='function')throw fail();
 if(setupSource&&(!closed(setupSource,['path','sha256'])||!isAbsolute(setupSource.path)||!/^[a-f0-9]{64}$/.test(setupSource.sha256)))throw fail();
 const selected=setupSource?Object.freeze({...setupSource}):null;
 const broker=new DesktopGameHostSessionBroker({net,partition,gameHostMessage:sdk.gameHostMessage,now});
 controls.bindBroker(broker);
 let consumed=false,driver=null,custody=null,secret=null,watch=null,stopping=null;
 const status=()=>Object.freeze({...broker.status(),nativeConfigured:!!selected,nativeConnected:driver?.snapshot?.nativeConnected===true,attached:driver?.snapshot?.attached===true});
 const sourceCurrent=()=>{try{const s=lstatSync(selected.path);return s.isFile()&&!s.isSymbolicLink()&&s.size<=131072&&sha(readFileSync(selected.path))===selected.sha256;}catch{return false;}};
 const cleanup=()=>{clearInterval(watch);watch=null;secret?.fill(0);secret=null;custody?.dispose();custody=null;};
 const stop=(reason='stop')=>{consumed=true;if(stopping)return stopping;const fenced=broker.stop(reason);void driver?.fence(reason).catch(()=>{});stopping=fenced.finally(cleanup);return stopping;};
 const readiness=async()=>Object.freeze({...status(),...await broker.readiness()});
 const startApprovedSession=async()=>{
  if(consumed||stopping||!selected||!sourceCurrent())throw fail();
  const setup=JSON.parse(readFileSync(selected.path,'utf8'));
  if(!closed(setup,['schemaVersion','sourceRevision','approvalRef','attach','binding','expiresAt','paths','evidence','native'])||setup.schemaVersion!=='lifestream.desktop-game-host-setup.v1'||setup.sourceRevision!==sourceRevision||typeof setup.approvalRef!=='string'||!setup.approvalRef.trim()||setup.approvalRef.length>500||!closed(setup.paths,['emulator','configFile','romFile','frameDirectory'])||Object.values(setup.paths).some(path=>typeof path!=='string'||!isAbsolute(path))||!closed(setup.evidence,['directory','sourceFiles'])||!isAbsolute(setup.evidence.directory)||!Array.isArray(setup.evidence.sourceFiles)||!closed(setup.native,['port','connectionTimeoutMs','authenticationTimeoutMs','sessionDurationMs','bounds','romSha1']))throw fail();
  const attach=sdk.gameHostMessage('attach',setup.attach),remaining=Date.parse(setup.expiresAt)-now();
  if(!attach||!Number.isSafeInteger(remaining)||remaining<=0||remaining>600000||!Number.isSafeInteger(setup.native.sessionDurationMs)||setup.native.sessionDurationMs<1||setup.native.sessionDurationMs>600000)throw fail();
  const duration=Math.min(remaining,setup.native.sessionDurationMs),scopeCurrent=scope=>sourceCurrent()&&broker.status().enabled===true&&isDeepStrictEqual(scope,attach.scope);
  // Validate current human session before allocating custody or generating pairing.
  const session=await broker.readiness();
  if(!session.ready||session.principalId!==attach.scope.principalId||session.sessionId!==attach.scope.contextBinding.sessionId||session.endpointId!==attach.scope.contextBinding.endpointId||session.revision!==setup.binding?.revision||session.runtimeSourceRevision!==setup.binding?.runtimeSourceRevision||!sourceCurrent()||Date.parse(setup.expiresAt)<=now())throw fail();
  consumed=true;
  try{
   const bounds=setup.native.bounds;
   custody=new sdk.GameFrameCustody(realpathSync(setup.paths.frameDirectory),{maxBytes:bounds.maxScreenshotBytes,maxQueueBytes:bounds.screenshotQueueByteBudget,maxLongEdge:bounds.maxScreenshotLongEdge,maxFrames:3,maxTtlMs:Math.min(duration,30000),current:scopeCurrent});
   secret=randomBytes(32);
   await broker.start({attach,binding:setup.binding,expiresAt:setup.expiresAt,driverFactory:async transport=>{
    driver=sdk.createOwnedWindowsGameHostDriver({attach:transport.attach,fetchAuthenticated:transport.fetchAuthenticated,isScopeCurrent:scope=>scopeCurrent(scope)&&transport.isScopeCurrent(scope),evidence:{...setup.evidence,scope:attach.scope,pinsDigest:attach.pinsDigest,providerRef:attach.providerRef,romSha1:setup.native.romSha1,custody,sessionDurationMs:duration,isCurrent:scopeCurrent},native:{...setup.native,sessionDurationMs:duration,pairingSecret:secret,frameCustody:custody},emulator:setup.paths.emulator,configFile:setup.paths.configFile,entryFile:join(nativeDirectory,'entry.lua'),romFile:setup.paths.romFile});
    // The real client resolves only after native authentication AND typed backend
    // attachment. A created object or a live child is not connection readiness.
    void driver.done.then(()=>stop('driverEnded'),()=>stop('driverFailed')).catch(()=>{});
    try{await driver.ready;return driver;}catch(error){await driver.fence('startupFailed');throw error;}finally{secret?.fill(0);secret=null;}
   }});
   if(!status().attached||!sourceCurrent())throw fail();
   watch=setInterval(()=>{if(!sourceCurrent())void stop('setupChanged');},1000);watch.unref?.();
   return status();
  }catch{await stop('unavailable');throw fail();}
 };
 return Object.freeze({readiness,status,startApprovedSession,stop,configured:!!selected});
}
module.exports={createDesktopGameHostComposition,gameHostSetupFromArguments};
