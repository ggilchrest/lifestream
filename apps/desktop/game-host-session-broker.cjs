'use strict';
const {isDeepStrictEqual}=require('node:util');
const {createHash}=require('node:crypto');
const {createSessionBoundGameHostFetch}=require('./game-host-session-request.cjs');
const {gameHostFailure,gameHostBlockingReason}=require('./game-host-diagnostics.cjs');
const ORIGIN='http://127.0.0.1:43182',BASE='/api/runtime/v1/game-host/';
const MAX_BYTES=131072,MAX_SESSION_MS=600000;
const FRAME_MAX_BYTES=2097152;
const routes=Object.freeze({attach:['attach','attachment'],next:['next','event'],admit:['admit','admission'],result:['completion','accepted'],detach:['detach','detached']});
const fail=(reason='session_unavailable')=>gameHostFailure(reason);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
// One predicate shared by read-only readiness, late binding and admission.
// A stored personal endpoint is not current audience evidence after a restart.
function sessionProjection(authentication,context,now){
 const endpoint=context?.endpoint;
 const authenticated=uuid(authentication?.principalId)&&uuid(authentication?.sessionId),owner=authenticated&&authentication.owner===true;
 const administrationCurrent=owner&&Number.isFinite(Date.parse(authentication.adminExpiresAt))&&Date.parse(authentication.adminExpiresAt)>now;
 const contextCurrent=context?.ended===false&&Number.isSafeInteger(context.revision)&&context.revision>0&&uuid(endpoint?.endpointId)&&endpoint.ownership==='personal'&&endpoint.privacyClass==='personal'&&endpoint.health==='healthy'&&/^[a-f0-9]{64}$/.test(context.runtimeSelfContext?.sourceRevision??'');
 const conversationCurrent=uuid(context?.conversationId),audienceCurrent=context?.runtimeSelfContext?.audienceScope==='authenticatedSession';
 const blockingReason=!authenticated?'session_unavailable':!owner?'owner_required':!administrationCurrent?'administration_expired':!contextCurrent?'context_unavailable':!conversationCurrent?'conversation_unavailable':!audienceCurrent?'audience_unavailable':null;
 return Object.freeze({authenticated,owner,administrationCurrent,contextCurrent,conversationCurrent,audienceCurrent,ready:blockingReason===null,blockingReason,...(authenticated?{principalId:authentication.principalId,sessionId:authentication.sessionId,adminExpiresAt:authentication.adminExpiresAt}:{}),...(contextCurrent?{revision:context.revision,endpointId:endpoint.endpointId,runtimeSourceRevision:context.runtimeSelfContext.sourceRevision}:{}),...(conversationCurrent?{conversationId:context.conversationId}:{})});
}
async function boundedJson(response){
 if(!response.ok||response.redirected||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw fail();
 const declared=response.headers.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BYTES))throw fail();
 const reader=response.body?.getReader();if(!reader)throw fail();let size=0,chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw fail();chunks.push(Buffer.from(value));}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();chunks=[];}
}
/** Trusted-main transport only. The renderer cannot supply a URL, body, scope,
 * token, setup or driver. Production callers supply Electron net and the existing partition for ordinary auth;
 * this module never inspects cookies or refreshes human administrative activity. */
class DesktopGameHostSessionBroker{
 #partition;#message;#framePath;#inspectPng;#now;#csrf=null;#attachmentId=null;#setup=null;#driver=null;#state='disabled';#timer=null;#pending=new Set();#generation=0;#notify;#listeners=new Set();#frameCommand=null;#frameAttempts=0;
 constructor({partition,net,gameHostMessage,parseGameHostFramePath,inspectGamePng,now=Date.now,onStatus=()=>{}}){
  if((!net&&typeof partition?.fetch!=='function')||typeof gameHostMessage!=='function')throw fail();
  this.#partition=net?{fetch:createSessionBoundGameHostFetch(net,partition)}:partition;this.#message=gameHostMessage;this.#framePath=parseGameHostFramePath;this.#inspectPng=inspectGamePng;this.#now=now;this.#notify=onStatus;
 }
 status(){if(this.#state==='active'&&this.#now()>=this.#setup.expiresAt)void this.stop('deadline');return Object.freeze({state:this.#state,enabled:this.#state==='active',authenticated:this.#csrf!==null,scopeCurrent:this.#state==='active',pauseConfirmed:false});}
 subscribeStatus(listener){if(typeof listener!=='function')throw fail();this.#listeners.add(listener);return ()=>this.#listeners.delete(listener);}
 #emit(){const status=this.status();this.#notify(status);for(const listener of this.#listeners)listener(status);}
 #current(generation){return this.#state==='active'&&generation===this.#generation&&this.#now()<this.#setup.expiresAt;}
 async #get(path,signal){
  return boundedJson(await this.#partition.fetch(ORIGIN+path,{method:'GET',credentials:'include',redirect:'error',cache:'no-store',signal}));
 }
 /** Read the actual desktop partition through its ordinary authenticated GETs.
  * Return only allowlisted nonsecret metadata; no token/cookie or game grant. */
 async readiness(){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);timer.unref?.();
  const unavailable=Object.freeze({authenticated:false,owner:false,administrationCurrent:false,contextCurrent:false,conversationCurrent:false,audienceCurrent:false,ready:false,blockingReason:'session_unavailable'});
  try{
   const authentication=await this.#get('/api/auth/v1/session',controller.signal);
   const context=await this.#get('/api/runtime/v1/session-context',controller.signal);
   return sessionProjection(authentication,context,this.#now());
  }catch{return unavailable;}finally{clearTimeout(timer);}
 }
 /** Trusted main only: capture the current authenticated session projection.
  * No credential export, mutation, administration refresh or game approval. */
 async sessionBinding(){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);timer.unref?.();
  try{
   const authentication=await this.#get('/api/auth/v1/session',controller.signal);
   const context=await this.#get('/api/runtime/v1/session-context',controller.signal),endpoint=context.endpoint;
   const projection=sessionProjection(authentication,context,this.#now());if(!projection.ready)throw fail(projection.blockingReason);
   return Object.freeze({principalId:authentication.principalId,sessionId:authentication.sessionId,conversationId:context.conversationId,binding:JSON.parse(JSON.stringify({revision:context.revision,endpoint,runtimeSourceRevision:context.runtimeSelfContext.sourceRevision}))});
  }finally{clearTimeout(timer);}
 }
 #bindingMatches(context){
  const binding=this.#setup.binding;
  return context?.ended===false&&context.conversationId===this.#setup.attach.scope.contextBinding.conversationId&&context.runtimeSelfContext?.audienceScope==='authenticatedSession'&&context.revision===binding.revision&&isDeepStrictEqual(context.endpoint,binding.endpoint)&&context.runtimeSelfContext?.sourceRevision===binding.runtimeSourceRevision;
 }
 async start({attach,binding,expiresAt,driverFactory,frameTransfer}){
  if(this.#state!=='disabled'||typeof driverFactory!=='function')throw fail();
  const checked=this.#message('attach',attach),expiry=Date.parse(expiresAt);
  if(!checked||!Number.isFinite(expiry)||expiry>this.#now()+MAX_SESSION_MS||expiry<=this.#now()||!binding||!Number.isSafeInteger(binding.revision)||!/^([a-f0-9]{64})$/.test(binding.runtimeSourceRevision)||binding.endpoint?.endpointId!==checked.scope.contextBinding.endpointId)throw fail('setup_invalid');
  if(binding.endpoint?.ownership!=='personal'||binding.endpoint?.privacyClass!=='personal'||binding.endpoint?.health!=='healthy')throw fail('context_unavailable');
  // Clone trusted nonsecret metadata; later caller mutation cannot broaden it.
  if(frameTransfer){const f=frameTransfer,keys=['purpose','maximumFrames','maximumBytes','maximumLongEdge','maximumAgeMs'];if((typeof this.#framePath!=='function'||typeof this.#inspectPng!=='function')||Object.keys(f).sort().join(',')!==keys.sort().join(',')||f.purpose!=='simulatedGame/gameFramebuffer'||!Number.isSafeInteger(f.maximumFrames)||f.maximumFrames<1||f.maximumFrames>64||!Number.isSafeInteger(f.maximumBytes)||f.maximumBytes<1||f.maximumBytes>2097152||!Number.isSafeInteger(f.maximumLongEdge)||f.maximumLongEdge<1||f.maximumLongEdge>1024||!Number.isSafeInteger(f.maximumAgeMs)||f.maximumAgeMs<1||f.maximumAgeMs>30000)throw fail();}
  this.#setup=JSON.parse(JSON.stringify({attach:checked,binding,expiresAt:expiry,...(frameTransfer?{frameTransfer}:{})}));const startingGeneration=++this.#generation;this.#state='starting';this.#emit();
  const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),5000);timeout.unref?.();
  try{
   const authentication=await this.#get('/api/auth/v1/session',abort.signal);
   const context=await this.#get('/api/runtime/v1/session-context',abort.signal),projection=sessionProjection(authentication,context,this.#now());
   if(!projection.ready)throw fail(projection.blockingReason);
   if(authentication.principalId!==checked.scope.principalId||authentication.sessionId!==checked.scope.contextBinding.sessionId||typeof authentication.csrfToken!=='string'||authentication.csrfToken.length<32||authentication.csrfToken.length>256||!this.#bindingMatches(context)||abort.signal.aborted||expiry<=this.#now()||this.#state!=='starting'||this.#generation!==startingGeneration)throw fail('session_changed');
   // Only trusted main retains this value; status and transport responses never
   // include it. Runtime polling uses ordinary auth and does not extend admin.
   this.#csrf=authentication.csrfToken;this.#state='active';const generation=++this.#generation;
   this.#timer=setTimeout(()=>void this.stop('deadline'),Math.max(1,expiry-this.#now()));this.#timer.unref?.();
   const driver=await driverFactory(Object.freeze({attach:checked,fetchAuthenticated:(input,init)=>this.#fetch(input,init,generation),isScopeCurrent:()=>this.#current(generation)}));
   if(typeof driver?.fence!=='function')throw fail();if(!this.#current(generation)){await driver.fence('scopeChanged');throw fail();}this.#driver=driver;this.#emit();return this.status();
  }catch(error){await this.stop('unavailable');throw gameHostFailure(gameHostBlockingReason(error));}finally{clearTimeout(timeout);}
 }
 async #fetch(input,init,generation){
  if(!this.#current(generation)){void this.stop('deadline');throw fail();}
  if(typeof input!=='string'||!init||init.method!=='POST')throw fail();
  const url=new URL(input);if(url.origin!==ORIGIN||url.search||url.hash||url.username||url.password||!url.pathname.startsWith(BASE))throw fail();
  const identity=typeof this.#framePath==='function'?this.#framePath(url.pathname):null,frame=identity!==null,operation=frame?'frame':url.pathname.slice(BASE.length),types=routes[operation];
  if(frame?(!this.#setup.frameTransfer||!Buffer.isBuffer(init.body)||!init.body.length||init.body.length>FRAME_MAX_BYTES||init.headers?.['content-type']!=='image/png'):(!types||typeof init.body!=='string'||Buffer.byteLength(init.body)>MAX_BYTES))throw fail();
  let message;if(!frame){try{message=this.#message(types[0],JSON.parse(init.body));}catch{throw fail();}if(!message)throw fail();}
  if(!frame&&operation==='attach'&&(this.#attachmentId!==null||!isDeepStrictEqual(message,this.#setup.attach)))throw fail();
  if(operation!=='attach'&&(!this.#attachmentId||(frame?identity:message).attachmentId!==this.#attachmentId))throw fail();
  const expected=this.#frameCommand;
  if(frame&&(!expected||!expected.admitted||expected.attempted||expected.command.commandId!==identity.commandId||expected.command.requestDigest!==identity.requestDigest||Date.parse(expected.command.expiresAt)<=this.#now()||this.#frameAttempts>=this.#setup.frameTransfer.maximumFrames||init.body.length>this.#setup.frameTransfer.maximumBytes))throw fail();
  if(operation==='result'&&this.#setup.frameTransfer&&message.result.operation==='GameActivityAdapter.observe'&&message.result.outcome.status==='succeeded'){
   const observation=message.result.outcome.payload.observation,shot=observation.screenshots[0],f=this.#setup.frameTransfer,now=this.#now(),held=expected?.frame;
   if(!expected?.uploaded||!held||observation.screenshots.length!==1||expected.command.commandId!==message.commandId||expected.command.requestDigest!==message.requestDigest||message.result.requestId!==expected.command.request.requestId||message.result.correlationId!==expected.command.request.correlationId||message.result.providerRef!==this.#setup.attach.providerRef||!isDeepStrictEqual(observation.scope,this.#setup.attach.scope)||observation.pinsDigest!==this.#setup.attach.pinsDigest||shot.mediaRef!==held.mediaRef||shot.screenshotId!==held.mediaRef||shot.sha256!==held.sha256||shot.byteLength!==held.byteLength||shot.width!==held.width||shot.height!==held.height||Date.parse(shot.capturedAt)>now||now-Date.parse(shot.capturedAt)>f.maximumAgeMs||Date.parse(shot.expiresAt)<=now)throw fail();
  }
  const controller=new AbortController();this.#pending.add(controller);const signal=init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal,timeout=setTimeout(()=>controller.abort(),5000);timeout.unref?.();
  let owned;
  try{
   if(frame){owned=Buffer.from(init.body);const size=this.#inspectPng(owned,this.#setup.frameTransfer.maximumLongEdge);expected.frame={mediaRef:identity.mediaRef,sha256:createHash('sha256').update(owned).digest('hex'),byteLength:owned.length,...size};expected.attempted=true;++this.#frameAttempts;}
   const frameCurrent=()=>!frame||this.#frameCommand===expected&&Date.parse(expected.command.expiresAt)>this.#now()&&createHash('sha256').update(owned).digest('hex')===expected.frame.sha256;
   const context=await this.#get('/api/runtime/v1/session-context',signal);if(!this.#bindingMatches(context)||!this.#current(generation)||!frameCurrent())throw fail();
   const raw=await this.#partition.fetch(url.href,{method:'POST',body:frame?owned:JSON.stringify(message),headers:{'content-type':frame?'image/png':'application/json','origin':ORIGIN,'x-lifestream-csrf':this.#csrf},credentials:'include',redirect:'error',cache:'no-store',signal});
   const parsed=await boundedJson(raw),response=frame?(parsed&&Object.keys(parsed).length===1&&parsed.accepted===true?parsed:null):this.#message(types[1],parsed);
   if(!response||!this.#current(generation)||!frameCurrent()||!frame&&operation!=='attach'&&response.attachmentId!==this.#attachmentId)throw fail();
   if(operation==='attach')this.#attachmentId=response.attachmentId;
   if(operation==='admit'&&(response.commandId!==message.commandId||response.requestDigest!==message.requestDigest)||operation==='result'&&(response.commandId!==message.commandId||response.resultDigest!==message.resultDigest))throw fail();
   if(this.#setup.frameTransfer){
    if(operation==='next'&&response.kind==='command'&&response.request.operation==='GameActivityAdapter.observe'){
     if(this.#frameCommand||!isDeepStrictEqual(response.request.scope,this.#setup.attach.scope)||response.request.payload.expectedPinsDigest!==this.#setup.attach.pinsDigest)throw fail();this.#frameCommand={command:response,admitted:false,attempted:false,uploaded:false};
    }
    if(operation==='admit'&&this.#frameCommand?.command.commandId===message.commandId){if(this.#frameCommand.command.requestDigest!==message.requestDigest)throw fail();this.#frameCommand.admitted=true;}
    if(frame)expected.uploaded=true;
    if(operation==='result'&&this.#frameCommand?.command.commandId===message.commandId)this.#frameCommand=null;
    if(operation==='next'&&response.kind==='cancel')this.#frameCommand=null;
   }
   return new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json','cache-control':'no-store'}});
  }catch{void this.stop('scopeChanged');throw fail();}finally{owned?.fill(0);clearTimeout(timeout);this.#pending.delete(controller);}
 }
 async stop(reason='stop'){
  if(this.#state==='disabled'||this.#state==='stopped')return this.status();
  this.#state='stopped';++this.#generation;clearTimeout(this.#timer);this.#timer=null;this.#csrf=null;this.#frameCommand=null;
  for(const controller of this.#pending)controller.abort();this.#pending.clear();this.#emit();
  // Fencing is not pause proof. The driver owns its captured exact-old-lease
  // shutdown and must retain unresolved reservations if evidence is lost.
  const driver=this.#driver;this.#driver=null;if(driver){let timer;try{await Promise.race([Promise.resolve().then(()=>driver.fence(reason)),new Promise(resolve=>{timer=setTimeout(resolve,5000);timer.unref?.();})]);}catch{}finally{clearTimeout(timer);}}return this.status();
 }
}
function trustedGameHostSender(event,window,origin){
 try{return !window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&new URL(event.senderFrame.url).origin===origin;}catch{return false;}
}
module.exports={DesktopGameHostSessionBroker,trustedGameHostSender};
