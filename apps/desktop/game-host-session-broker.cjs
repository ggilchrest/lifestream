'use strict';
const {isDeepStrictEqual}=require('node:util');
const {createSessionBoundGameHostFetch}=require('./game-host-session-request.cjs');
const ORIGIN='http://127.0.0.1:43182',BASE='/api/runtime/v1/game-host/';
const MAX_BYTES=131072,MAX_SESSION_MS=600000;
const routes=Object.freeze({attach:['attach','attachment'],next:['next','event'],admit:['admit','admission'],result:['completion','accepted'],detach:['detach','detached']});
const fail=()=>Error('game_host_session_unavailable');
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
 #partition;#message;#now;#csrf=null;#attachmentId=null;#setup=null;#driver=null;#state='disabled';#timer=null;#pending=new Set();#generation=0;#notify;#listeners=new Set();
 constructor({partition,net,gameHostMessage,now=Date.now,onStatus=()=>{}}){
  if((!net&&typeof partition?.fetch!=='function')||typeof gameHostMessage!=='function')throw fail();
  this.#partition=net?{fetch:createSessionBoundGameHostFetch(net,partition)}:partition;this.#message=gameHostMessage;this.#now=now;this.#notify=onStatus;
 }
 status(){if(this.#state==='active'&&this.#now()>=this.#setup.expiresAt)void this.stop('deadline');return Object.freeze({state:this.#state,enabled:this.#state==='active',authenticated:this.#csrf!==null,scopeCurrent:this.#state==='active',pauseConfirmed:false});}
 subscribeStatus(listener){if(typeof listener!=='function')throw fail();this.#listeners.add(listener);return ()=>this.#listeners.delete(listener);}
 #emit(){const status=this.status();this.#notify(status);for(const listener of this.#listeners)listener(status);}
 #current(generation){return this.#state==='active'&&generation===this.#generation&&this.#now()<this.#setup.expiresAt;}
 async #get(path,signal){
  return boundedJson(await this.#partition.fetch(ORIGIN+path,{method:'GET',credentials:'include',redirect:'error',cache:'no-store',signal}));
 }
 #bindingMatches(context){
  const binding=this.#setup.binding;
  return context?.ended===false&&context.revision===binding.revision&&isDeepStrictEqual(context.endpoint,binding.endpoint)&&context.runtimeSelfContext?.sourceRevision===binding.runtimeSourceRevision;
 }
 async start({attach,binding,expiresAt,driverFactory}){
  if(this.#state!=='disabled'||typeof driverFactory!=='function')throw fail();
  const checked=this.#message('attach',attach),expiry=Date.parse(expiresAt);
  if(!checked||!Number.isFinite(expiry)||expiry>this.#now()+MAX_SESSION_MS||expiry<=this.#now()||!binding||!Number.isSafeInteger(binding.revision)||!/^([a-f0-9]{64})$/.test(binding.runtimeSourceRevision)||binding.endpoint?.endpointId!==checked.scope.contextBinding.endpointId||binding.endpoint?.ownership!=='personal'||binding.endpoint?.privacyClass!=='personal'||binding.endpoint?.health!=='healthy')throw fail();
  // Clone trusted nonsecret metadata; later caller mutation cannot broaden it.
  this.#setup=JSON.parse(JSON.stringify({attach:checked,binding,expiresAt:expiry}));this.#state='starting';this.#emit();
  const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),5000);timeout.unref?.();
  try{
   const authentication=await this.#get('/api/auth/v1/session',abort.signal);
   if(authentication.principalId!==checked.scope.principalId||authentication.sessionId!==checked.scope.contextBinding.sessionId||authentication.owner!==true||Date.parse(authentication.adminExpiresAt)<=this.#now()||typeof authentication.csrfToken!=='string'||authentication.csrfToken.length<32||authentication.csrfToken.length>256)throw fail();
   const context=await this.#get('/api/runtime/v1/session-context',abort.signal);if(!this.#bindingMatches(context)||abort.signal.aborted||expiry<=this.#now())throw fail();
   // Only trusted main retains this value; status and transport responses never
   // include it. Runtime polling uses ordinary auth and does not extend admin.
   this.#csrf=authentication.csrfToken;this.#state='active';const generation=++this.#generation;
   this.#timer=setTimeout(()=>void this.stop('deadline'),Math.max(1,expiry-this.#now()));this.#timer.unref?.();
   this.#driver=await driverFactory(Object.freeze({attach:checked,fetchAuthenticated:(input,init)=>this.#fetch(input,init,generation),isScopeCurrent:()=>this.#current(generation)}));
   if(typeof this.#driver?.fence!=='function')throw fail();if(!this.#current(generation)){await this.#driver.fence('scopeChanged');throw fail();}this.#emit();return this.status();
  }catch{await this.stop('unavailable');throw fail();}finally{clearTimeout(timeout);}
 }
 async #fetch(input,init,generation){
  if(!this.#current(generation)){void this.stop('deadline');throw fail();}
  // No Request object or caller headers/credentials/redirect/signal trick can
  // turn this into a generic privileged fetch. The driver supplies JSON only.
  if(typeof input!=='string'||!init||init.method!=='POST'||typeof init.body!=='string'||Buffer.byteLength(init.body)>MAX_BYTES)throw fail();
  const url=new URL(input);if(url.origin!==ORIGIN||url.search||url.hash||url.username||url.password||!url.pathname.startsWith(BASE))throw fail();
  const operation=url.pathname.slice(BASE.length),types=routes[operation];if(!types)throw fail();
  let message;try{message=this.#message(types[0],JSON.parse(init.body));}catch{throw fail();}if(!message)throw fail();
  if(operation==='attach'&&(this.#attachmentId!==null||!isDeepStrictEqual(message,this.#setup.attach)))throw fail();
  if(operation!=='attach'&&(!this.#attachmentId||message.attachmentId!==this.#attachmentId))throw fail();
  const controller=new AbortController();this.#pending.add(controller);
  const signal=init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal;
  const timeout=setTimeout(()=>controller.abort(),5000);timeout.unref?.();
  try{
   const context=await this.#get('/api/runtime/v1/session-context',signal);
   if(!this.#bindingMatches(context)||!this.#current(generation))throw fail();
   const raw=await this.#partition.fetch(url.href,{method:'POST',body:JSON.stringify(message),headers:{'content-type':'application/json','origin':ORIGIN,'x-lifestream-csrf':this.#csrf},credentials:'include',redirect:'error',cache:'no-store',signal});
   const response=this.#message(types[1],await boundedJson(raw));
   if(!response||!this.#current(generation)||operation!=='attach'&&response.attachmentId!==this.#attachmentId)throw fail();
   if(operation==='attach')this.#attachmentId=response.attachmentId;
   if(operation==='admit'&&(response.commandId!==message.commandId||response.requestDigest!==message.requestDigest)||operation==='result'&&(response.commandId!==message.commandId||response.resultDigest!==message.resultDigest))throw fail();
   // Electron response.url is not reliable. Redirects were rejected by fetch;
   // return a fresh response with JSON only, excluding Set-Cookie and headers.
   return new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json','cache-control':'no-store'}});
  }catch{void this.stop('scopeChanged');throw fail();}finally{clearTimeout(timeout);this.#pending.delete(controller);}
 }
 async stop(reason='stop'){
  if(this.#state==='disabled'||this.#state==='stopped')return this.status();
  this.#state='stopped';++this.#generation;clearTimeout(this.#timer);this.#timer=null;this.#csrf=null;
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
