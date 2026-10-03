'use strict';
const {readFileSync,lstatSync,realpathSync}=require('node:fs');
const {isAbsolute,join}=require('node:path');
const {createHash,randomBytes}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {DesktopGameHostSessionBroker}=require('./game-host-session-broker.cjs');
const {gameHostFailure,gameHostBlockingReason}=require('./game-host-diagnostics.cjs');
const fail=(reason='setup_invalid')=>gameHostFailure(reason,'game_host_setup_unavailable');
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
 let selected=setupSource?Object.freeze({...setupSource}):null;
 const broker=new DesktopGameHostSessionBroker({net,partition,gameHostMessage:sdk.gameHostMessage,parseGameHostFramePath:sdk.parseGameHostFramePath,inspectGamePng:sdk.inspectGamePng,now});
 controls.bindBroker(broker);
 let consumed=false,preparing=false,driver=null,custody=null,secret=null,watch=null,stopping=null,lastStartFailure=null;
 const status=()=>Object.freeze({...broker.status(),nativeConfigured:!!selected,nativeConnected:driver?.snapshot?.nativeConnected===true,attached:driver?.snapshot?.attached===true,nativeStage:driver?.snapshot?.nativeStage??null,nativeStartupFailure:driver?.snapshot?.nativeStartupFailure??null,driverFailure:driver?.snapshot?.reason??null,lastStartFailure});
 const sourceCurrent=()=>{try{const s=lstatSync(selected.path);return s.isFile()&&!s.isSymbolicLink()&&s.size<=131072&&sha(readFileSync(selected.path))===selected.sha256;}catch{return false;}};
 const cleanup=()=>{clearInterval(watch);watch=null;secret?.fill(0);secret=null;custody?.dispose();custody=null;};
 const stop=(reason='stop')=>{consumed=true;if(stopping)return stopping;const fenced=broker.stop(reason);void driver?.fence(reason).catch(()=>{});stopping=fenced.finally(cleanup);return stopping;};
 const readiness=async()=>{
  const session=await broker.readiness();let blockingReason=session.blockingReason;
  if(session.ready){
   blockingReason=consumed||stopping?'session_consumed':preparing?'session_busy':!selected?'setup_required':!sourceCurrent()?'setup_changed':null;
   if(!blockingReason)try{
    const setup=readSetup();
    if(setup.schemaVersion!=='lifestream.desktop-game-host-setup.v1'){
     setup.attach.scope.contextBinding.sessionId=session.sessionId;setup.attach.scope.contextBinding.conversationId=session.conversationId;
    }
    const attach=sdk.gameHostMessage('attach',setup.attach);validateLifetime(setup);
    if(!attach)throw fail();
    if(attach.scope.principalId!==session.principalId||attach.scope.contextBinding.sessionId!==session.sessionId||attach.scope.contextBinding.conversationId!==session.conversationId||attach.scope.contextBinding.endpointId!==session.endpointId||setup.schemaVersion==='lifestream.desktop-game-host-setup.v1'&&(setup.binding?.revision!==session.revision||setup.binding?.runtimeSourceRevision!==session.runtimeSourceRevision))throw fail('session_changed');
    if(!sourceCurrent())throw fail('setup_changed');
   }catch(error){blockingReason=gameHostBlockingReason(error,'setup_invalid');}
  }
  return Object.freeze({...status(),...session,sessionReady:session.ready,ready:blockingReason===null,blockingReason});
 };
 const selectSetupSource=value=>{
  if(consumed||preparing||stopping||broker.status().state!=='disabled'||!closed(value,['path','sha256'])||!isAbsolute(value.path)||!/^[a-f0-9]{64}$/.test(value.sha256))throw fail();
  const stat=lstatSync(value.path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>131072||sha(readFileSync(value.path))!==value.sha256)throw fail();
  selected=Object.freeze({...value});return status();
 };
 const readSetup=()=>{
  const setup=JSON.parse(readFileSync(selected.path,'utf8'));
  const pixels=setup.schemaVersion==='lifestream.desktop-game-host-setup.v3';
  if(!closed(setup,['schemaVersion','sourceRevision','approvalRef','attach','binding','expiresAt','paths','evidence','native',...(pixels?['frameTransfer']:[])])||!['lifestream.desktop-game-host-setup.v1','lifestream.desktop-game-host-setup.v2','lifestream.desktop-game-host-setup.v3'].includes(setup.schemaVersion)||setup.sourceRevision!==sourceRevision||typeof setup.approvalRef!=='string'||!setup.approvalRef.trim()||setup.approvalRef.length>500||!closed(setup.paths,['emulator','configFile','romFile','frameDirectory'])||Object.values(setup.paths).some(path=>typeof path!=='string'||!isAbsolute(path))||!closed(setup.evidence,['directory','sourceFiles'])||!isAbsolute(setup.evidence.directory)||!Array.isArray(setup.evidence.sourceFiles)||!closed(setup.native,['port','connectionTimeoutMs','authenticationTimeoutMs','sessionDurationMs','bounds','romSha1']))throw fail();
  if(pixels){const f=setup.frameTransfer;if(!closed(f,['purpose','maximumFrames','maximumBytes','maximumLongEdge','maximumAgeMs'])||f.purpose!=='simulatedGame/gameFramebuffer'||!Number.isSafeInteger(f.maximumFrames)||f.maximumFrames<1||f.maximumFrames>64||!Number.isSafeInteger(f.maximumBytes)||f.maximumBytes<1||f.maximumBytes>2097152||!Number.isSafeInteger(f.maximumLongEdge)||f.maximumLongEdge<1||f.maximumLongEdge>1024||!Number.isSafeInteger(f.maximumAgeMs)||f.maximumAgeMs<1||f.maximumAgeMs>30000||typeof sdk.parseGameHostFramePath!=='function')throw fail();}
  if(pixels||setup.schemaVersion==='lifestream.desktop-game-host-setup.v2'){
   if(!closed(setup.binding,['mode'])||setup.binding.mode!=='currentOwnerSession'||setup.attach?.scope?.contextBinding?.sessionId!==null||setup.attach.scope.contextBinding.conversationId!==null)throw fail();
  }
  return setup;
 };
 const validateLifetime=setup=>{
  const remaining=Date.parse(setup.expiresAt)-now();
  if(!Number.isSafeInteger(remaining)||remaining<=0)throw fail('setup_expired');
  if(remaining>600000||!Number.isSafeInteger(setup.native.sessionDurationMs)||setup.native.sessionDurationMs<1||setup.native.sessionDurationMs>600000)throw fail();
  return remaining;
 };
 const startApprovedSession=async()=>{
  const blocked=consumed||stopping?'session_consumed':preparing?'session_busy':!selected?'setup_required':!sourceCurrent()?'setup_changed':null;
  if(blocked){lastStartFailure=blocked;throw fail(blocked);}
  preparing=true;lastStartFailure=null;
  try{
  const setup=readSetup(),pixels=setup.schemaVersion==='lifestream.desktop-game-host-setup.v3';
  if(pixels||setup.schemaVersion==='lifestream.desktop-game-host-setup.v2'){
   // Only two transport-owned IDs are late-bound. All campaign/source/owner/
   // endpoint/relationship/permission assertions remain selected and validated
   // independently by the backend; this is never consent or a new grant.
   const current=await broker.sessionBinding();
   if(consumed||stopping||setup.attach.scope.principalId!==current.principalId||setup.attach.scope.contextBinding.endpointId!==current.binding.endpoint.endpointId)throw fail('session_changed');
   if(!sourceCurrent())throw fail('setup_changed');
   setup.attach.scope.contextBinding.sessionId=current.sessionId;setup.attach.scope.contextBinding.conversationId=current.conversationId;setup.binding=current.binding;
  }
  const attach=sdk.gameHostMessage('attach',setup.attach),remaining=validateLifetime(setup);
  if(!attach)throw fail();
  const duration=Math.min(remaining,setup.native.sessionDurationMs),scopeCurrent=scope=>sourceCurrent()&&broker.status().enabled===true&&isDeepStrictEqual(scope,attach.scope);
  // Validate current human session before allocating custody or generating pairing.
  const session=await broker.readiness();
  if(!session.ready)throw fail(session.blockingReason);
  if(consumed||stopping||session.principalId!==attach.scope.principalId||session.sessionId!==attach.scope.contextBinding.sessionId||session.conversationId!==attach.scope.contextBinding.conversationId||session.endpointId!==attach.scope.contextBinding.endpointId||session.revision!==setup.binding?.revision||session.runtimeSourceRevision!==setup.binding?.runtimeSourceRevision)throw fail('session_changed');
  if(!sourceCurrent())throw fail('setup_changed');validateLifetime(setup);
  consumed=true;
  try{
   const bounds=setup.native.bounds;
   custody=new sdk.GameFrameCustody(realpathSync(setup.paths.frameDirectory),{maxBytes:bounds.maxScreenshotBytes,maxQueueBytes:bounds.screenshotQueueByteBudget,maxLongEdge:bounds.maxScreenshotLongEdge,maxFrames:3,maxTtlMs:Math.min(duration,30000),current:scopeCurrent});
   secret=randomBytes(32);
   await broker.start({attach,binding:setup.binding,expiresAt:setup.expiresAt,...(pixels?{frameTransfer:setup.frameTransfer}:{}),driverFactory:async transport=>{
    driver=sdk.createOwnedWindowsGameHostDriver({attach:transport.attach,fetchAuthenticated:transport.fetchAuthenticated,isScopeCurrent:scope=>scopeCurrent(scope)&&transport.isScopeCurrent(scope),evidence:{...setup.evidence,scope:attach.scope,pinsDigest:attach.pinsDigest,providerRef:attach.providerRef,romSha1:setup.native.romSha1,custody,sessionDurationMs:duration,isCurrent:scopeCurrent},native:{...setup.native,sessionDurationMs:duration,pairingSecret:secret,frameCustody:custody},emulator:setup.paths.emulator,configFile:setup.paths.configFile,entryFile:join(nativeDirectory,'entry.lua'),romFile:setup.paths.romFile,...(pixels?{frameTransfer:setup.frameTransfer}:{})});
    // The real client resolves only after native authentication AND typed backend
    // attachment. A created object or a live child is not connection readiness.
    void driver.done.then(()=>stop('driverEnded'),()=>stop('driverFailed')).catch(()=>{});
    try{await driver.ready;return driver;}catch(error){await driver.fence('startupFailed');throw error;}finally{secret?.fill(0);secret=null;}
   }});
   if(!status().attached||!sourceCurrent())throw fail();
   watch=setInterval(()=>{if(!sourceCurrent())void stop('setupChanged');},1000);watch.unref?.();
   return status();
  }catch(error){await stop('unavailable');throw fail(gameHostBlockingReason(error));}
  }catch(error){lastStartFailure=gameHostBlockingReason(error,'setup_invalid');throw fail(lastStartFailure);}finally{preparing=false;}
 };
 return Object.freeze({readiness,status,selectSetupSource,startApprovedSession,stop,get configured(){return !!selected;}});
}
module.exports={createDesktopGameHostComposition,gameHostSetupFromArguments};
