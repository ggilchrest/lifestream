import {ORDINARY_GAME_SESSION_LIMITS} from '@lifestream/contracts/game-host';
import {nativeExecutionLifetimeCurrent,nativeExecutionSessionScoped,nativeExecutionLifetimeSignal,nativeExecutionCustodyBounds,type NativeExecutionLifetime} from './native-execution-lifetime.ts';
import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Duplex} from 'node:stream';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameActivityAdapter,GameCallContext} from './port.js';
import {guardGameActivityAdapter,type GameAdapterBoundaryOptions} from './provider.ts';

const MAX_FRAME=131072,MAX_REQUESTS=256,MAX_PENDING=8;
const protocol='lifestream-game-control/1';
type Request=G.GameObserveRequest|G.GameActionRequest|G.GameReleaseRequest|G.GameSaveRequest;
type Result=G.GameObserveResult|G.GameActionResult|G.GameReleaseResult|G.GameSaveResult;
export class GameTransportError extends Error{
 readonly code:'invalidFrame'|'authenticationFailed'|'disconnected'|'closed'|'capacity'|'invalidResponse'|'scopeChanged'|'cancelled'|'timedOut';
 constructor(code:GameTransportError['code']){super('Game transport '+code);this.code=code;}
}
/** The referenced native socket API prefixes UTF-8 BYTES, not JS characters.
 * This control lane accepts text only. Screenshots need separate custody. */
export function encodeGameControlFrame(text:string):Buffer{
 const payload=Buffer.from(text,'utf8');
 if(payload.length<1||payload.length>MAX_FRAME||new TextDecoder('utf-8',{fatal:true}).decode(payload)!==text)throw new GameTransportError('invalidFrame');
 return Buffer.concat([Buffer.from(String(payload.length)+' ','ascii'),payload]);
}
/** Incremental, finite allocation even when a peer never completes a frame. */
export class GameControlFrameDecoder{
 private header='';private payload:Buffer|null=null;private offset=0;private closed=false;
 private readonly receive:(text:string)=>void;
 constructor(receive:(text:string)=>void){this.receive=receive;}
 push(chunk:Uint8Array):void{
  if(this.closed||chunk.byteLength>MAX_FRAME*2)throw new GameTransportError('invalidFrame');
  try{let at=0;while(at<chunk.byteLength&&!this.closed){
   if(this.payload===null){const byte=chunk[at++]!;
    if(byte===32){const length=Number(this.header);if(!/^[1-9][0-9]{0,5}$/.test(this.header)||length>MAX_FRAME)throw new GameTransportError('invalidFrame');this.payload=Buffer.alloc(length);this.header='';this.offset=0;}
    else{if(byte<48||byte>57||this.header.length>=6)throw new GameTransportError('invalidFrame');this.header+=String.fromCharCode(byte);}
   }else{const count=Math.min(this.payload.length-this.offset,chunk.byteLength-at);this.payload.set(chunk.subarray(at,at+count),this.offset);at+=count;this.offset+=count;
    if(this.offset===this.payload.length){const payload=this.payload;this.payload=null;this.offset=0;let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(payload);}finally{payload.fill(0);}this.receive(text);}
   }
  }}catch{this.dispose();throw new GameTransportError('invalidFrame');}
 }
 finish():void{const truncated=this.header!==''||this.payload!==null;this.dispose();if(truncated)throw new GameTransportError('invalidFrame');}
 dispose():void{this.closed=true;this.header='';this.payload?.fill(0);this.payload=null;this.offset=0;}
}
export interface GameTransportOptions{
 /** An explicitly paired local bridge credential. Never sourced from the game,
  * model, network address or a default. The caller retains its own copy. */
 pairingSecret:Uint8Array;scope:G.ActivityScope;pinsDigest:string;
 authenticationTimeoutMs:number;sessionDurationMs:number;executionLifetime?:NativeExecutionLifetime;
 boundary:GameAdapterBoundaryOptions;
 /** Trusted read-only source decoder; it can enrich fields but cannot replace
  * scope, source pixels, timestamps, action lineage or any effect result. */
 enrichObservation?:(request:G.GameObserveRequest,observation:G.GameObservation)=>G.GameObservation;
 /** Fixed native owner's read-only exact inspection, never a wire/authority port.
  * Original source checks and request deadline still apply after this await. */
 refreshSourceCustody?:(signal:AbortSignal)=>Promise<void>;
 /** Host must fence input ownership and pursue actual pause on channel loss.
  * Calling this notification does not prove pause or effect resolution. */
 onDisconnect:(code:GameTransportError['code'])=>void;
 /** Independent exact old lease readback admission, supplied only by trusted
  * native ownership code. Never uses a successor scope or creates a game grant. */
 shutdownAdmission?:(request:G.GameReleaseRequest)=>Promise<boolean>;
}
export interface AuthenticatedGameTransport{adapter:GameActivityAdapter;ready:Promise<void>;close:()=>void;isQuiescent:()=>boolean;safetyRelease?:GameActivityAdapter['releaseControls'];}
/** Operates only an already connected stream supplied by an authorized host.
 * No listener, launch, reconnect, automatic retry or native effect is created.
 * The peer still needs a reviewed Lua bridge and installed-build qualification. */
export function createAuthenticatedGameTransport(stream:Duplex,options:GameTransportOptions):AuthenticatedGameTransport{
 const valid=createContractValidator().validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/ActivityScope',options.scope).valid;
 const sessionScoped=!!options.executionLifetime&&nativeExecutionSessionScoped(options.executionLifetime); // Policy metadata only.
 if(!valid||options.pairingSecret.byteLength<32||options.pairingSecret.byteLength>128||!/^[a-f0-9]{64}$/.test(options.pinsDigest)||!Number.isSafeInteger(options.authenticationTimeoutMs)||options.authenticationTimeoutMs<1||options.authenticationTimeoutMs>10000||!Number.isSafeInteger(options.sessionDurationMs)||options.sessionDurationMs<options.authenticationTimeoutMs||options.sessionDurationMs>(sessionScoped?ORDINARY_GAME_SESSION_LIMITS.maximumMs:600000)||typeof options.onDisconnect!=='function')throw new GameTransportError('authenticationFailed');
 if(options.refreshSourceCustody!==undefined&&typeof options.refreshSourceCustody!=='function')throw new GameTransportError('authenticationFailed');
 const refreshSourceCustody=options.refreshSourceCustody;
 const lifetime=options.executionLifetime;if(Object.hasOwn(options,'executionLifetime')&&!nativeExecutionLifetimeCurrent(lifetime!))throw new GameTransportError('authenticationFailed');
 const originalSignal=lifetime?nativeExecutionLifetimeSignal(lifetime):undefined,sessionDuration=lifetime?nativeExecutionCustodyBounds(lifetime).remainingMs:options.sessionDurationMs;
 const scope=structuredClone(options.scope),pinsDigest=options.pinsDigest,secret=Buffer.from(options.pairingSecret),providerRef=options.boundary.providerRef;
 const challenge={type:'challenge',protocol,sessionId:randomUUID(),nonce:randomBytes(32).toString('hex'),providerRef,pinsDigest,scopeDigest:createHash('sha256').update(JSON.stringify(scope)).digest('hex'),expiresAt:new Date(Date.now()+options.authenticationTimeoutMs).toISOString()};
 const expected=createHmac('sha256',secret).update(JSON.stringify(challenge)).digest();secret.fill(0);
 const hostProof=createHmac('sha256',options.pairingSecret).update(protocol+' host '+JSON.stringify(challenge)).digest();
 let state:'authenticating'|'ready'|'closed'='authenticating',readyResolve!:()=>void,readyReject!:(e:Error)=>void,authTimer:ReturnType<typeof setTimeout>|undefined,sessionTimer:ReturnType<typeof setTimeout>|undefined;
 const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void ready.catch(()=>{});
 const safetyLane=Symbol('original exact-old-lease safety lane');
 type Entry={safety:boolean;operation:Request['operation'];correlationId:string;phase:'pending'|'abandoned'|'delivered';resolve:(r:Result)=>void;reject:(e:Error)=>void;cleanup:()=>void};
 const entries=new Map<string,Entry>();let activeCalls=0,pendingSourceRefreshes=0;
 const fail=(code:GameTransportError['code'])=>{
  if(state==='closed')return;state='closed';clearTimeout(authTimer);clearTimeout(sessionTimer);expected.fill(0);hostProof.fill(0);decoder.dispose();
  originalSignal?.removeEventListener('abort',originalAbort);stream.off('data',onData);stream.off('end',onEnd);stream.off('close',onClose);stream.off('error',onError);stream.on('error',()=>{});
  const error=new GameTransportError(code);readyReject(error);for(const entry of entries.values()){entry.cleanup();if(entry.phase==='pending')entry.reject(error);}entries.clear();stream.destroy();try{options.onDisconnect(code);}catch{}
 };
 const send=(text:string)=>{
  const frame=encodeGameControlFrame(text);if(stream.destroyed||!stream.writable||stream.writableLength+frame.byteLength>MAX_FRAME*2){fail('capacity');throw new GameTransportError('capacity');}
  try{stream.write(frame,error=>{if(error)fail('disconnected');});}catch{fail('disconnected');throw new GameTransportError('disconnected');}
 };
 const decoder=new GameControlFrameDecoder(text=>{
  let message:any;try{message=JSON.parse(text);}catch{fail('invalidResponse');return;}
  if(state==='authenticating'){
   if(lifetime&&!nativeExecutionLifetimeCurrent(lifetime)){fail('scopeChanged');return;}
   const exact=message&&typeof message==='object'&&!Array.isArray(message)&&Object.keys(message).length===2&&message.type==='authenticate'&&typeof message.proof==='string'&&/^[a-f0-9]{64}$/.test(message.proof)&&text===JSON.stringify({type:'authenticate',proof:message.proof});
   if(!exact||Date.now()>=Date.parse(challenge.expiresAt)||!timingSafeEqual(Buffer.from(message.proof,'hex'),expected)){fail('authenticationFailed');return;}
   expected.fill(0);clearTimeout(authTimer);state='ready';send(JSON.stringify({type:'authenticated',protocol,sessionId:challenge.sessionId,proof:hostProof.toString('hex')}));hostProof.fill(0);readyResolve();return;
  }
  if(state==='closed')return;
  const entry=message&&typeof message==='object'&&!Array.isArray(message)&&typeof message.requestId==='string'?entries.get(message.requestId):undefined;
  if(!entry||message.operation!==entry.operation||message.correlationId!==entry.correlationId||message.providerRef!==providerRef||entry.phase==='delivered'){fail('invalidResponse');return;}
  if(lifetime&&!entry.safety&&!nativeExecutionLifetimeCurrent(lifetime)){entry.cleanup();if(entry.phase==='pending')entry.reject(new GameTransportError('scopeChanged'));entry.phase='delivered';return;}
  // One late reply for a specifically abandoned call may be discarded. It
  // cannot become a successor's result or evidence of reconciled execution.
  if(entry.phase==='abandoned'){entry.phase='delivered';return;}
  entry.phase='delivered';entry.cleanup();entry.resolve(message as Result);
 });
 const onData=(chunk:Buffer)=>{try{decoder.push(chunk);}catch{fail('invalidFrame');}};
 const onEnd=()=>{try{decoder.finish();fail('disconnected');}catch{fail('invalidFrame');}};
 const onClose=()=>fail('disconnected'),onError=()=>fail('disconnected');
 stream.on('data',onData);stream.on('end',onEnd);stream.on('close',onClose);stream.on('error',onError);
 const originalAbort=()=>{
  if(state==='authenticating'){fail('scopeChanged');return;}
  // Keep only the independently admitted original-lease safety release lane.
  // Physical onStop owns its bounded neutralization and final channel close.
  for(const entry of entries.values())if(!entry.safety&&entry.phase==='pending'){entry.phase='abandoned';entry.cleanup();entry.reject(new GameTransportError('scopeChanged'));}
 };originalSignal?.addEventListener('abort',originalAbort,{once:true});
 authTimer=setTimeout(()=>fail('authenticationFailed'),options.authenticationTimeoutMs);sessionTimer=setTimeout(()=>fail('timedOut'),sessionDuration);if(originalSignal?.aborted)originalAbort();
 async function call(request:Request,context:GameCallContext,lane?:typeof safetyLane):Promise<Result>{
  const safety=lane===safetyLane;if(safety&&request.operation!=='GameActivityAdapter.releaseControls')throw new GameTransportError('scopeChanged');
  if(state==='closed')throw new GameTransportError('closed');
  if(!isDeepStrictEqual(request.scope,scope)||request.operation!=='GameActivityAdapter.releaseControls'&&request.payload.expectedPinsDigest!==pinsDigest)throw new GameTransportError('scopeChanged');
  const remaining=Date.parse(request.deadlineAt)-Date.now(),monoDeadline=performance.now()+remaining;
  const check=()=>{if(lifetime&&!safety&&!nativeExecutionLifetimeCurrent(lifetime))throw new GameTransportError('scopeChanged');if(context.signal.aborted)throw new GameTransportError('cancelled');if(Date.now()>=Date.parse(request.deadlineAt)||performance.now()>=monoDeadline)throw new GameTransportError('timedOut');if(!context.isCurrent(scope))throw new GameTransportError('scopeChanged');if(state==='closed')throw new GameTransportError('closed');
   // Authentication is an await boundary. A pre-handshake admission cannot
   // become permission to write after source/policy or finite authority changes.
   if(request.operation!=='GameActivityAdapter.releaseControls'&&!options.boundary.sourceAvailable(scope,pinsDigest))throw new GameTransportError('scopeChanged');
   if(request.operation==='GameActivityAdapter.applyController'||request.operation==='GameActivityAdapter.controlSave'){if(Date.now()>=Date.parse(request.payload.admission.expiresAt))throw new GameTransportError('scopeChanged');}
   if(request.operation==='GameActivityAdapter.applyController'&&Date.now()>=Date.parse(request.payload.dispatchValidation.preparedContextFreshUntil))throw new GameTransportError('scopeChanged');
  };
  check();if(entries.has(request.requestId)||entries.size>=(sessionScoped?ORDINARY_GAME_SESSION_LIMITS.nativeRequests:MAX_REQUESTS)+(request.operation==='GameActivityAdapter.releaseControls'?1:0))throw new GameTransportError('capacity');
  const pending=[...entries.values()].filter(e=>e.phase==='pending').length;
  if(pending>=MAX_PENDING+(request.operation==='GameActivityAdapter.releaseControls'?1:0))throw new GameTransportError('capacity');
  return new Promise<Result>((resolve,reject)=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   const cleanup=()=>{clearTimeout(timer);context.signal.removeEventListener('abort',abort);};
   const abandon=(code:GameTransportError['code'])=>{if(entry.phase!=='pending')return;entry.phase='abandoned';cleanup();reject(new GameTransportError(code));};
   const abort=()=>abandon('cancelled');
   const entry:Entry={safety,operation:request.operation,correlationId:request.correlationId,phase:'pending',resolve,reject,cleanup};entries.set(request.requestId,entry);
   context.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>abandon('timedOut'),Math.max(1,remaining));
   void ready.then(()=>{if(entry.phase!=='pending')return;try{check();send(JSON.stringify(request));}catch(error){entry.phase='abandoned';cleanup();reject(error instanceof GameTransportError?error:new GameTransportError('scopeChanged'));}},()=>{if(entry.phase==='pending')abandon('authenticationFailed');});
   if(context.signal.aborted)abort();
  });
 }
 const observe=async(r:G.GameObserveRequest,c:GameCallContext):Promise<G.GameObserveResult>=>{
  const sourceDeadline=refreshSourceCustody?Date.parse(r.deadlineAt):0,sourceMono=refreshSourceCustody?performance.now()+Math.max(0,sourceDeadline-Date.now()):0;
  const result=await call(r,c) as G.GameObserveResult;
  if(!options.enrichObservation||result.outcome.status!=='succeeded')return result;
  if(!createContractValidator().validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/GameObserveResult',result).valid||!result.outcome.payload)throw new GameTransportError('invalidResponse');
  const original=result.outcome.payload.observation;
  if(!isDeepStrictEqual(original.scope,r.scope)||original.pinsDigest!==r.payload.expectedPinsDigest)throw new GameTransportError('scopeChanged');
  if(refreshSourceCustody){
   // Native I/O can outlive the inspection cache. Refresh before the decoder's
   // ORIGINAL synchronous sourceAvailable checks, inside the original call.
   // Source/currentness is checked by the captured physical owner both before
   // and after its exact inspection; do not require a stale cache to refresh it.
   const operationCurrent=()=>{if(c.signal.aborted)throw new GameTransportError('cancelled');if(Date.now()>=sourceDeadline||performance.now()>=sourceMono)throw new GameTransportError('timedOut');if(state==='closed'||lifetime&&!nativeExecutionLifetimeCurrent(lifetime))throw new GameTransportError('scopeChanged');};
   operationCurrent();let aborted=()=>{};
   pendingSourceRefreshes++;const refreshing=Promise.resolve().then(()=>{operationCurrent();return refreshSourceCustody(c.signal);}).finally(()=>{pendingSourceRefreshes--;});
   try{await Promise.race([refreshing,new Promise<never>((_,reject)=>{aborted=()=>reject(new GameTransportError('cancelled'));c.signal.addEventListener('abort',aborted,{once:true});if(c.signal.aborted)aborted();})]);}
   finally{c.signal.removeEventListener('abort',aborted);}
   operationCurrent();if(!c.isCurrent(scope))throw new GameTransportError('scopeChanged');operationCurrent();
  }
  const snapshot=structuredClone(original),decoded=options.enrichObservation(r,structuredClone(original));
  const source=(value:G.GameObservation)=>({...value,visibleState:[],interpretedAt:null,providerConfigurationRef:null});
  if(!isDeepStrictEqual(source(snapshot),source(decoded)))throw new GameTransportError('invalidResponse');
  return {...result,outcome:{...result.outcome,payload:{...result.outcome.payload,observation:decoded}}};
 };
 const wire:GameActivityAdapter={observe,applyController:(r,c)=>call(r,c) as Promise<G.GameActionResult>,releaseControls:(r,c)=>call(r,c) as Promise<G.GameReleaseResult>,controlSave:(r,c)=>call(r,c) as Promise<G.GameSaveResult>};
 let adapter:GameActivityAdapter;try{adapter=guardGameActivityAdapter(wire,options.boundary);send(JSON.stringify(challenge));}catch(error){fail('authenticationFailed');throw error;}
 const safety=options.shutdownAdmission?guardGameActivityAdapter({...wire,releaseControls:(r,c)=>call(r,c,safetyLane) as Promise<G.GameReleaseResult>},{providerRef,maxDurationMs:5000,sourceAvailable:()=>false,admitRelease:options.shutdownAdmission}):undefined;
 const track=<T>(work:()=>Promise<T>):Promise<T>=>{activeCalls++;try{return Promise.resolve(work()).finally(()=>{activeCalls--;});}catch(error){activeCalls--;return Promise.reject(error);}};
 const originalAdapter=adapter;adapter={observe:(r,c)=>track(()=>originalAdapter.observe(r,c)),applyController:(r,c)=>track(()=>originalAdapter.applyController(r,c)),releaseControls:(r,c)=>track(()=>originalAdapter.releaseControls(r,c)),controlSave:(r,c)=>track(()=>originalAdapter.controlSave(r,c))};
 const isQuiescent=()=>state==='ready'&&activeCalls===0&&pendingSourceRefreshes===0&&[...entries.values()].every(entry=>entry.phase==='delivered')&&(!lifetime||nativeExecutionLifetimeCurrent(lifetime));
 return {adapter,ready,isQuiescent,close:()=>fail('closed'),...(safety?{safetyRelease:(r:G.GameReleaseRequest,c:GameCallContext)=>track(()=>safety.releaseControls(r,c))}:{})};
}
