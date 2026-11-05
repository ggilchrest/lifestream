import {ORDINARY_GAME_SESSION_LIMITS} from '@lifestream/contracts/game-host';
import {captureGameSanityTiming,type GameSanityTiming,type GameSanityTimingInput} from './game-sanity-timing.ts';
import {nativeExecutionLifetimeCurrent,nativeExecutionSessionScoped,nativeExecutionLifetimeSignal,nativeExecutionCustodyBounds,type NativeExecutionLifetime} from './native-execution-lifetime.ts';
import {isDeepStrictEqual} from 'node:util';
import {GAME_HOST_PROTOCOL as protocol,GAME_HOST_BASE_PATH,GAME_HOST_LIMITS,gameHostMessage,gameHostDigest,gameHostCompletionMatches} from '@lifestream/contracts/game-host';
import type {GameHostAttach,GameHostAttachment,GameHostCommand,GameHostRequest,GameHostResult,GameHostMessages,GameHostMessageName} from '@lifestream/contracts/game-host';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameActivityAdapter,GameCallContext} from './port.js';
import type {GameAdapterBoundaryOptions} from './provider.js';
import {WINDOWS_HOST_BACKEND_URL} from './windows-host-lifecycle.ts';
import {nativeSourceWitness,nativeSourceException,type NativeSourceWitness} from './native-source-witness.ts';
import {beginNativeRefreshTiming,type NativeRefreshTiming} from './native-refresh-timing.ts';

export type GameHostClientFailure='unconfigured'|'invalidMessage'|'denied'|'transportLost'|'expired'|'scopeChanged'|'cancelled'|'closed';
export type GameHostDiagnosticPhase='client'|'native-open'|'native-current'|'attach'|'poll'|'command'|'native-lifetime'|'attachment-lifetime'|'cancellation';
export const GAME_HOST_ERROR_HEADER='x-lifestream-game-host-error';
export const GAME_HOST_RESPONSE_CODES=Object.freeze(['invalid_game_host_message','game_host_scope_denied','game_host_conflict','game_host_expired','game_host_unavailable','game_session_unavailable'] as const);
const cancellationSites=new Set(['attachment_current', 'poll_initial_attachment', 'preparation_gate_attachment', 'admit_attachment', 'complete_attachment', 'detach_attachment', 'sweep_preparation', 'sweep_current', 'sweep_post_preparation', 'sweep_refresh_failed', 'poll_initial_failed', 'poll_finish_failed', 'poll_finish_current', 'poll_finish_structure', 'poll_pending', 'admit_pre', 'admit_final', 'complete_final', 'legacy_poll_current', 'legacy_sweep']);
const cancellationPredicates=new Set(['current_port_closed', 'current_attachment_closed', 'current_runtime', 'current_wall_lease', 'current_monotonic_lease', 'current_idle_lease', 'current_scope', 'current_principal', 'current_session', 'current_actor', 'current_binding', 'current_native_source', 'structure_port_closed', 'structure_attachment_closed', 'structure_aborted', 'structure_map_identity', 'structure_wall_lease', 'structure_monotonic_lease', 'structure_idle_lease', 'pending_identity', 'command_wall_deadline', 'command_monotonic_deadline', 'pending_signal_aborted', 'pending_context', 'poll_identity', 'poll_signal_aborted', 'operation_failed', 'poll_settled', 'read_refresh_deadline']);
export type GameHostResponseWitness=Readonly<{route:'attach'|'next'|'admit'|'result'|'detach';status:number;errorCode?:typeof GAME_HOST_RESPONSE_CODES[number];cancellationSite?:string;cancellationPredicate?:string;nativeSourceWitness?:NativeSourceWitness}>;
export type GameHostClientDiagnostic=Readonly<{schemaVersion:'ct-runtime-first-cause/1'|'ct-runtime-terminal-cause/1';source:'client';phase:GameHostDiagnosticPhase;reason:GameHostClientFailure;responseWitness?:GameHostResponseWitness;nativeSourceWitness?:NativeSourceWitness}>;
export class GameHostClientError extends Error{
 readonly code:GameHostClientFailure;
 constructor(code:GameHostClientFailure,readonly responseWitness?:GameHostResponseWitness,readonly nativeSourceWitness?:NativeSourceWitness){super('Game host fenced: '+code);this.code=code;}
}
export interface GameHostFenceContext{
 readonly reason:GameHostClientFailure;
 readonly activeCommand:GameHostCommand|null;
 /** Captured original action, never a mutable successor/global lease lookup. */
 readonly lastEnteredAction:G.GameActionRequest|null;
}
export interface WindowsGameHostClientOptions{
 sanityTiming?:GameSanityTimingInput;
 /** Explicit trusted source configuration; never accepted from a protocol message. */
 backendUrl?:string;
 attach:GameHostAttach;
 /** Trusted main/session transport supplies existing Cookie/CSRF/Origin/Host.
  * This module neither discovers credentials nor accepts a URL from the wire. */
 fetchAuthenticated:(url:string,init:RequestInit)=>Promise<Response>;
 isScopeCurrent:(scope:G.ActivityScope)=>boolean;
 sourceIsQualified:(attachment:GameHostAttach)=>boolean;
 nativeBoundary:GameAdapterBoundaryOptions;
 /** Trusted factory MUST install this exact boundary at its final native entry
  * (e.g. listenForNativeBizHawk); it must not double-wrap an already guarded port.
  * Resolve ONLY after native mutual authentication (transport.ready), so final
  * /admit cannot precede an authentication wait. Caller owns approved pairing/
  * child setup. No credentials are generated here. */
 openNative:(boundary:GameAdapterBoundaryOptions,context:GameCallContext)=>Promise<{adapter:GameActivityAdapter;close():void}>;
 /** Independently qualified safety path for the captured exact old input lease.
  * Completing this notification is not pause/neutralization evidence. */
 shutdownExactOldLease:(context:GameHostFenceContext)=>Promise<void>;
 httpTimeoutMs:number;
 /** Local emulator boot, mutual authentication and GUI proof have their own
  * finite budget. HTTP request deadlines remain independent. */
 nativeStartupTimeoutMs?:number;
 sessionDurationMs:number;
 /** Opaque original-owner timing for /3 only; never supplied by wire messages. */
 executionLifetime?:NativeExecutionLifetime;
 shutdownTimeoutMs:number;
 /** Fixed owner metadata only; never supplied by HTTP or used for authority. */
 onFailure?:(value:GameHostClientDiagnostic)=>void;
 /** Fixed in-process physical-owner read-only inspection; never a wire grant. */
 refreshNativeCustody?:(signal:AbortSignal)=>Promise<void>;
 /** Metadata-only sink of the original failed read; never an authority input. */
 captureRefreshTimeout?:(timing:NativeRefreshTiming)=>void;
}
/** Canonical IPv4 loopback origin only; paths, aliases, credentials and redirects stay refused. */
export function qualifiedGameHostBackendUrl(input:unknown=WINDOWS_HOST_BACKEND_URL):string{
 if(typeof input!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9]\d{3,4}$/.test(input))throw new GameHostClientError('unconfigured');
 const port=Number(new URL(input).port);if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new GameHostClientError('unconfigured');
 return input;
}
type Active={command:GameHostCommand;controller:AbortController;entryAttempted:boolean;entered:boolean;wallDeadline:number;monoDeadline:number;timer:ReturnType<typeof setTimeout>;done:Promise<void>};
function bounded<T>(promise:Promise<T>,signal:AbortSignal,onSettled?:()=>void):Promise<T>{return new Promise((resolve,reject)=>{
 const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason??new GameHostClientError('cancelled'));};
 if(signal.aborted){void promise.catch(()=>{});abort();return;}signal.addEventListener('abort',abort,{once:true});
 promise.then(value=>{try{onSettled?.();}catch{}signal.removeEventListener('abort',abort);resolve(value);},error=>{try{onSettled?.();}catch{}signal.removeEventListener('abort',abort);reject(error);});
});}
function finite(value:number,min:number,max:number){return Number.isSafeInteger(value)&&value>=min&&value<=max;}
/** Inert until every trusted port is supplied. One finite attachment, one poll,
 * one command, final one-time admission; no reconnect, retry or redispatch. */
export class WindowsGameHostClient{
 private readonly options:Readonly<WindowsGameHostClientOptions>|undefined;
 private readonly sessionScoped:boolean=false; // Immutable cap selection, not currentness.
 private readonly sanityTiming:GameSanityTiming;
 private readonly controller=new AbortController();private readonly seen=new Set<string>();
 private attachment:GameHostAttachment|undefined;private native:{adapter:GameActivityAdapter;close():void}|undefined;
 private active:Active|undefined;private lastEnteredAction:G.GameActionRequest|null=null;
 private started=false;private failure:GameHostClientFailure|undefined;private shutdown:Promise<void>|undefined;
 private polling=false;
 private attachmentDeadline=0;private attachmentMono=0;private attachmentTimer:ReturnType<typeof setTimeout>|undefined;
 private accepted=0;private admissions=0;private detachAttempted=false;
 private resolveReady!:()=>void;private rejectReady!:(error:Error)=>void;
 readonly ready=new Promise<void>((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
 constructor(input?:WindowsGameHostClientOptions){
  void this.ready.catch(()=>{});
  this.sanityTiming=captureGameSanityTiming(input?.sanityTiming);
  if(!input)return;
  this.sessionScoped=!!input.executionLifetime&&nativeExecutionSessionScoped(input.executionLifetime);
  const backendUrl=qualifiedGameHostBackendUrl(input.backendUrl),attach=gameHostMessage('attach',input.attach),b=input.nativeBoundary;
  if(!attach||!b||b.providerRef!==attach.providerRef||!finite(b.maxDurationMs,1,120000)||
   !['fetchAuthenticated','isScopeCurrent','sourceIsQualified','openNative','shutdownExactOldLease'].every(k=>typeof input[k as keyof WindowsGameHostClientOptions]==='function')||
   !['sourceAvailable','acceptObservation','acceptAction','reconcileEffect','admitRelease'].every(k=>typeof b[k as keyof GameAdapterBoundaryOptions]==='function')||
   !finite(input.httpTimeoutMs,1,120000)||input.nativeStartupTimeoutMs!==undefined&&!finite(input.nativeStartupTimeoutMs,1,120000)||!finite(input.sessionDurationMs,1,this.sessionScoped?ORDINARY_GAME_SESSION_LIMITS.maximumMs:600000)||!finite(input.shutdownTimeoutMs,1,120000))throw new GameHostClientError('unconfigured');
  if(input.refreshNativeCustody!==undefined&&typeof input.refreshNativeCustody!=='function')throw new GameHostClientError('unconfigured');
  if(input.captureRefreshTimeout!==undefined&&typeof input.captureRefreshTimeout!=='function')throw new GameHostClientError('unconfigured');
  if(input.onFailure!==undefined&&typeof input.onFailure!=='function')throw new GameHostClientError('unconfigured');
  if(Object.hasOwn(input,'executionLifetime')&&!nativeExecutionLifetimeCurrent(input.executionLifetime!))throw new GameHostClientError('unconfigured');
  this.options=Object.freeze({...input,backendUrl,attach,nativeBoundary:Object.freeze({...b})});
 }
 get snapshot(){return Object.freeze({configured:!!this.options,started:this.started,fenced:!!this.failure,reason:this.failure??null,nativeConnected:!!this.native&&!this.failure,attached:!!this.attachment&&!this.failure,backendUrl:this.options?.backendUrl??WINDOWS_HOST_BACKEND_URL,admissionAttempts:this.admissions,acceptedIngress:this.accepted,activeCommandId:this.active?.command.commandId??null,pauseConfirmation:'unconfirmed',gameplayReady:false});}
 close(){this.fence('closed');}
 private fence(reason:GameHostClientFailure,phase:GameHostDiagnosticPhase='client',responseWitness?:GameHostResponseWitness,sourceWitness?:NativeSourceWitness){
  if(this.failure)return;this.failure=reason;
  const witness=reason==='scopeChanged'?nativeSourceWitness(sourceWitness):undefined;
  // Report the captured enum before cancellation can hide it during cleanup.
  if(reason!=='closed')try{this.options?.onFailure?.(Object.freeze({schemaVersion:'ct-runtime-first-cause/1',source:'client',phase,reason,...(reason==='denied'&&responseWitness?{responseWitness}:{}),...(witness?{nativeSourceWitness:witness}:{})}));}catch{}
  try{this.options?.onFailure?.(Object.freeze({schemaVersion:'ct-runtime-terminal-cause/1',source:'client',phase,reason,...(reason==='denied'&&responseWitness?{responseWitness}:{}),...(witness?{nativeSourceWitness:witness}:{})}));}catch{}
  this.rejectReady(new GameHostClientError(reason));
  const context=Object.freeze({reason,activeCommand:this.active?.command??null,lastEnteredAction:this.lastEnteredAction});
  this.active?.controller.abort(new GameHostClientError(reason));this.controller.abort(new GameHostClientError(reason));
  if(this.attachmentTimer)clearTimeout(this.attachmentTimer);
  if(this.options){const c=new AbortController(),timer=setTimeout(()=>c.abort(),Math.min(this.options.shutdownTimeoutMs,this.sanityTiming.cleanupTimeoutMs));
   this.shutdown=bounded(Promise.resolve().then(()=>this.options!.shutdownExactOldLease(context)),c.signal).catch(()=>{}).finally(()=>clearTimeout(timer));}
 }
 private async refreshNativeCustody(){
  const refresh=this.options!.refreshNativeCustody;
  if(!refresh)return;
  if(this.controller.signal.aborted)throw new GameHostClientError(this.failure??'cancelled');
  const measured=beginNativeRefreshTiming(this.sanityTiming.readRefreshTimeoutMs);
  const timeout=new AbortController(),signal=AbortSignal.any([this.controller.signal,timeout.signal]);
  const timer=setTimeout(()=>timeout.abort(),this.sanityTiming.readRefreshTimeoutMs);
  try{await bounded(Promise.resolve().then(()=>{measured.entered();return refresh(signal);}),signal,measured.settled);}
  catch(error){
   if(this.controller.signal.aborted)throw new GameHostClientError(this.failure??'cancelled');
   if(timeout.signal.aborted)try{this.options!.captureRefreshTimeout?.(measured.snapshot());}catch{}
   throw new GameHostClientError('scopeChanged',undefined,timeout.signal.aborted?{stage:'client-refresh',predicate:'read_refresh_deadline'}:{stage:'client-refresh',predicate:'refresh_rejected',exceptionClass:nativeSourceException(error)});
  }
  finally{clearTimeout(timer);}
 }
 private check(scope=this.options!.attach.scope,requireNative=true){
  if(this.options?.executionLifetime&&!nativeExecutionLifetimeCurrent(this.options.executionLifetime))throw new GameHostClientError('expired');
  if(this.controller.signal.aborted)throw new GameHostClientError(this.failure??'cancelled');
  let current=false,checking='scope_equal',first:NativeSourceWitness|undefined;
  try{
   const o=this.options!;
   current=isDeepStrictEqual(scope,o.attach.scope)&&(checking='scope_current',o.isScopeCurrent(scope)===true)&&(checking='installation_current',o.sourceIsQualified(o.attach)===true)&&(!requireNative||(checking='native_source_current',o.nativeBoundary.sourceAvailable(scope,o.attach.pinsDigest,value=>{if(!first)first=nativeSourceWitness(value);})===true));
  }catch(error){first??=nativeSourceWitness({stage:'client-current',predicate:checking,exceptionClass:nativeSourceException(error)});}
  if(!current)throw new GameHostClientError('scopeChanged',undefined,first??{stage:'client-current',predicate:checking});
  if(this.attachment&&!this.polling&&!this.active&&(Date.now()>=this.attachmentDeadline||performance.now()>=this.attachmentMono))throw new GameHostClientError('expired');
 }
 private lease(expiresAt:string){
  const left=Date.parse(expiresAt)-Date.now();if(left<=0||left>GAME_HOST_LIMITS.attachmentMs)throw new GameHostClientError('invalidMessage');
  this.attachmentDeadline=Date.parse(expiresAt);this.attachmentMono=performance.now()+left;
  if(this.attachmentTimer)clearTimeout(this.attachmentTimer);this.attachmentTimer=setTimeout(()=>{if(!this.polling&&!this.active)this.fence('expired','attachment-lifetime');},left);
 }
 private async post<N extends GameHostMessageName>(route:'attach'|'next'|'admit'|'result'|'detach',outgoing:GameHostMessageName,input:unknown,incoming:N,signal:AbortSignal):Promise<GameHostMessages[N]>{
  const measuredAt=performance.now();let reportTiming=route!=='next',returned=false;
  const o=this.options!,message=gameHostMessage(outgoing,input);if(!message)throw new GameHostClientError('invalidMessage');
  const body=JSON.stringify(message);if(Buffer.byteLength(body)>GAME_HOST_LIMITS.messageBytes)throw new GameHostClientError('invalidMessage');
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new GameHostClientError('transportLost')),o.httpTimeoutMs),combined=AbortSignal.any([signal,deadline.signal]);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;let responseBody:ReadableStream<Uint8Array>|null= null;
  try{
   const url=o.backendUrl!+GAME_HOST_BASE_PATH+'/'+route;
   const response=await bounded(Promise.resolve().then(()=>o.fetchAuthenticated(url,{method:'POST',body,headers:{'content-type':'application/json'},redirect:'error',cache:'no-store',signal:combined})),combined);
   responseBody=response.body;if(response.redirected||response.url&&response.url!==url)throw new GameHostClientError('transportLost');
   const status=response.status;
   if(status!==200){
    // Same response, before the original denial/cleanup. Never read an error
    // body or await diagnostic work; absent/unknown metadata stays absent.
    let responseWitness:GameHostResponseWitness|undefined;
    if(Number.isSafeInteger(status)&&status>=100&&status<=599){
     let code:string|null=null;try{code=response.headers.get(GAME_HOST_ERROR_HEADER);}catch{}
     let detail:{cancellationSite:string;cancellationPredicate:string;nativeSourceWitness?:NativeSourceWitness}|undefined;
     if(route==='next'&&status===410&&code==='game_host_expired')try{
      const site=response.headers.get('x-lifestream-game-host-cancellation-site'),predicate=response.headers.get('x-lifestream-game-host-cancellation-predicate');
      if(site&&cancellationSites.has(site)&&predicate&&cancellationPredicates.has(predicate)){
       detail={cancellationSite:site,cancellationPredicate:predicate};
       if(predicate==='current_native_source')try{const raw=response.headers.get('x-lifestream-game-host-native-source');if(raw&&raw.length<=1024){const witness=nativeSourceWitness(JSON.parse(raw));if(witness)detail.nativeSourceWitness=witness;}}catch{}
      }
     }catch{}
     responseWitness=Object.freeze({route,status,...(GAME_HOST_RESPONSE_CODES.includes(code as any)?{errorCode:code as typeof GAME_HOST_RESPONSE_CODES[number]}:{}),...detail});
    }
    throw new GameHostClientError('denied',responseWitness);
   }
   if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||!response.body)throw new GameHostClientError('invalidMessage');
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>GAME_HOST_LIMITS.messageBytes))throw new GameHostClientError('invalidMessage');
   reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
   for(;;){const chunk=await bounded(reader.read(),combined);if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>GAME_HOST_LIMITS.messageBytes)throw new GameHostClientError('invalidMessage');chunks.push(chunk.value);}
   const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)),parsed=gameHostMessage(incoming,JSON.parse(text));
   if(!parsed)throw new GameHostClientError('invalidMessage');if(route==='next'&&(parsed as any).kind==='command')reportTiming=true;returned=true;return parsed;
  }catch(error){reportTiming=true;throw error instanceof GameHostClientError?error:new GameHostClientError('transportLost');}
  finally{if(reportTiming&&process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')try{console.info(JSON.stringify({event:'game-native-http-timing',runId:o.attach.scope.runId,route,outcome:returned?'returned':'failed',elapsedMs:Math.round((performance.now()-measuredAt)*100)/100}));}catch{}clearTimeout(timer);if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}else if(responseBody)void responseBody.cancel().catch(()=>{});}
 }
 private checkActive(active:Active){
  this.check(active.command.request.scope);if(this.active!==active||active.controller.signal.aborted)throw new GameHostClientError('cancelled');
  if(Date.now()>=active.wallDeadline||performance.now()>=active.monoDeadline)throw new GameHostClientError('expired');
 }
 private async admit(request:GameHostRequest,context:GameCallContext):Promise<boolean>{
  const a=this.active;if(!a)throw new GameHostClientError('invalidMessage');if(this.options!.refreshNativeCustody)await this.refreshNativeCustody();this.checkActive(a);
  if(a.entryAttempted||gameHostDigest(request)!==a.command.requestDigest||context.signal.aborted)throw new GameHostClientError('invalidMessage');
  a.entryAttempted=true;this.admissions++;
  const c=a.command,reply=await this.post('admit','admit',{protocol,attachmentId:c.attachmentId,commandId:c.commandId,requestDigest:c.requestDigest},'admission',AbortSignal.any([context.signal,a.controller.signal,this.controller.signal]));
  if(this.options!.refreshNativeCustody)await this.refreshNativeCustody();this.checkActive(a);const expires=Date.parse(reply.expiresAt);
  if(reply.attachmentId!==c.attachmentId||reply.commandId!==c.commandId||reply.requestDigest!==c.requestDigest||expires<=Date.now()||expires>a.wallDeadline)throw new GameHostClientError('invalidMessage');
  const left=expires-Date.now();a.wallDeadline=expires;a.monoDeadline=Math.min(a.monoDeadline,performance.now()+left);clearTimeout(a.timer);a.timer=setTimeout(()=>this.fence('expired'),Math.max(1,Math.min(left,a.monoDeadline-performance.now())));
  this.checkActive(a);a.entered=true;if(request.operation==='GameActivityAdapter.applyController')this.lastEnteredAction=request;return true;
 }
 private boundary():GameAdapterBoundaryOptions{
  const b=this.options!.nativeBoundary;
  const boundary:GameAdapterBoundaryOptions={...b,sourceAvailable:(scope,pins)=>pins===this.options!.attach.pinsDigest&&b.sourceAvailable(scope,pins)===true,
   acceptObservation:(request,observation)=>b.acceptObservation!(request,observation)===true,
   acceptAction:(request,result)=>b.acceptAction!(request,result)===true,
   reconcileEffect:async(request,context)=>await b.reconcileEffect!(request,context)===true,
   claimEffect:async(request,context)=>{if(request.operation!=='GameActivityAdapter.applyController')return false;return this.admit(request,context);},
   admitObservation:(request,context)=>this.admit(request,context),
   admitRelease:async(request,context)=>{this.check();if(await b.admitRelease!(request,context)!==true)return false;return this.admit(request,context);}};
  return Object.freeze(boundary);
 }
 private command(command:GameHostCommand){
  this.check(command.request.scope);const r=command.request,o=this.options!;
  if(this.active||command.attachmentId!==this.attachment!.attachmentId||r.operation!=='GameActivityAdapter.releaseControls'&&r.payload.expectedPinsDigest!==o.attach.pinsDigest)throw new GameHostClientError('invalidMessage');
  const keys=['command:'+command.commandId,'request:'+r.requestId,'idempotency:'+r.idempotencyKey,'cancel:'+r.cancellationId];
  if(r.operation==='GameActivityAdapter.applyController')keys.push('action:'+r.payload.actionId,'admission:'+r.payload.admission.admissionId,'invocation:'+r.payload.admission.capabilityInvocationId);
  if(keys.some(k=>this.seen.has(k))||this.seen.size+keys.length>(this.sessionScoped?ORDINARY_GAME_SESSION_LIMITS.nativeRequests*8:1024))throw new GameHostClientError('invalidMessage');for(const key of keys)this.seen.add(key);
  const expiry=Date.parse(command.expiresAt),original=Math.min(Date.parse(r.deadlineAt),r.operation==='GameActivityAdapter.applyController'?Date.parse(r.payload.admission.expiresAt):Infinity);
  if(expiry>Date.parse(r.deadlineAt)||expiry<=Date.now())throw new GameHostClientError('invalidMessage');
  const end=Math.min(expiry,original),left=end-Date.now();if(left<=0||left>o.nativeBoundary.maxDurationMs)throw new GameHostClientError('expired');
  const a:Active={command,controller:new AbortController(),entryAttempted:false,entered:false,wallDeadline:end,monoDeadline:performance.now()+left,timer:setTimeout(()=>this.fence('expired','command'),left),done:Promise.resolve()};this.active=a;
  a.done=this.execute(a).catch(error=>this.fence(error instanceof GameHostClientError?error.code:'transportLost','command',error instanceof GameHostClientError?error.responseWitness:undefined,error instanceof GameHostClientError?error.nativeSourceWitness:undefined)).finally(()=>{clearTimeout(a.timer);if(this.active===a)this.active=undefined;});
 }
 private async execute(a:Active){
  const r=a.command.request,context:GameCallContext=Object.freeze({signal:AbortSignal.any([a.controller.signal,this.controller.signal]),isCurrent:(scope:G.ActivityScope)=>{try{this.checkActive(a);return isDeepStrictEqual(scope,r.scope);}catch{return false;}}});
  const adapter=this.native!.adapter;if(this.options!.refreshNativeCustody)await this.refreshNativeCustody();this.checkActive(a);
  const operation:Promise<GameHostResult>=r.operation==='GameActivityAdapter.observe'?adapter.observe(r,context):r.operation==='GameActivityAdapter.applyController'?adapter.applyController(r,context):adapter.releaseControls(r,context);
  const result=await bounded(operation,context.signal);if(this.options!.refreshNativeCustody)await this.refreshNativeCustody();this.checkActive(a);
  if(!a.entered||result.providerRef!==this.options!.attach.providerRef)throw new GameHostClientError('invalidMessage');
  const completion=gameHostMessage('completion',{protocol,attachmentId:a.command.attachmentId,commandId:a.command.commandId,requestDigest:a.command.requestDigest,resultDigest:gameHostDigest(result),result});
  if(!completion||!gameHostCompletionMatches(a.command,completion))throw new GameHostClientError('invalidMessage');
  const reply=await this.post('result','completion',completion,'accepted',context.signal);if(this.options!.refreshNativeCustody)await this.refreshNativeCustody();this.checkActive(a);
  if(reply.attachmentId!==completion.attachmentId||reply.commandId!==completion.commandId||reply.resultDigest!==completion.resultDigest)throw new GameHostClientError('invalidMessage');this.accepted++;
 }
 async run(parentSignal=new AbortController().signal):Promise<void>{
  if(!this.options)throw new GameHostClientError('unconfigured');if(this.started||this.failure)throw new GameHostClientError('closed');
  const lifetime=this.options.executionLifetime,originalSignal=lifetime?nativeExecutionLifetimeSignal(lifetime):undefined,remaining=lifetime?nativeExecutionCustodyBounds(lifetime).remainingMs:this.options.sessionDurationMs;this.started=true;
  const onAbort=()=>this.fence('cancelled','cancellation');parentSignal.addEventListener('abort',onAbort,{once:true});if(parentSignal.aborted)onAbort();
  const sessionTimer=setTimeout(()=>this.fence('expired','native-lifetime'),remaining);
  const originalAbort=()=>this.fence('cancelled','cancellation');originalSignal?.addEventListener('abort',originalAbort,{once:true});if(originalSignal?.aborted)originalAbort();
  let diagnosticPhase:GameHostDiagnosticPhase='native-open';
  try{
   // Prepare only the independently qualified owned installation. No command
   // or effect can enter before actual native authentication and backend attach.
   this.check(this.options.attach.scope,false);
   const opening=Promise.resolve().then(()=>this.options!.openNative(this.boundary(),{signal:this.controller.signal,isCurrent:scope=>{try{this.check(scope,false);return true;}catch{return false;}}}));
   void opening.then(value=>{if(this.failure)try{value.close();}catch{}},()=>{});
   const connectionTimer=setTimeout(()=>this.fence('transportLost','native-open'),this.options.nativeStartupTimeoutMs??this.sanityTiming.startupOverallTimeoutMs);
   try{this.native=await bounded(opening,this.controller.signal);}finally{clearTimeout(connectionTimer);}diagnosticPhase='native-current';if(this.options.refreshNativeCustody){this.check(this.options.attach.scope,false);await this.refreshNativeCustody();}this.check();
   diagnosticPhase='attach';const attachment=await this.post('attach','attach',this.options.attach,'attachment',this.controller.signal);if(this.options.refreshNativeCustody)await this.refreshNativeCustody();this.check();this.lease(attachment.expiresAt);this.attachment=attachment;this.resolveReady();
   diagnosticPhase='poll';for(;;){
    // Heartbeat freshness admits this poll. Its refresh and HTTP stages each
    // keep their original watchdog; an old heartbeat cannot abort accepted work.
    if(!this.active&&(Date.now()>=this.attachmentDeadline||performance.now()>=this.attachmentMono))throw new GameHostClientError('expired');
    const started=performance.now();this.polling=true;let event:GameHostMessages['event'];
    try{if(this.options.refreshNativeCustody)await this.refreshNativeCustody();this.check();event=await this.post('next','next',{protocol,attachmentId:this.attachment.attachmentId},'event',this.controller.signal);if(this.options.refreshNativeCustody)await this.refreshNativeCustody();this.check();
    if(event.attachmentId!==this.attachment.attachmentId)throw new GameHostClientError('invalidMessage');
    if(event.kind==='idle')this.lease(event.expiresAt);
    else if(event.kind==='command')this.command(event);
    else{const a=this.active;if(!a||event.commandId!==a.command.commandId||event.requestDigest!==a.command.requestDigest||event.cancellationId!==a.command.request.cancellationId)throw new GameHostClientError('invalidMessage');this.fence('cancelled');}
    }finally{this.polling=false;}
    // Bound a server returning immediate replies; polling still runs beside I/O.
    const wait=event.kind==='idle'?Math.max(0,GAME_HOST_LIMITS.pollMs-(performance.now()-started)):0;
    if(wait>0){let wake=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
     try{await bounded(new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,wait);this.controller.signal.addEventListener('abort',wake,{once:true});}),this.controller.signal);}
     finally{if(timer)clearTimeout(timer);this.controller.signal.removeEventListener('abort',wake);}}
   }
  }catch(error){this.fence(error instanceof GameHostClientError?error.code:'transportLost',diagnosticPhase,error instanceof GameHostClientError?error.responseWitness:undefined,error instanceof GameHostClientError?error.nativeSourceWitness:undefined);}
  finally{
   clearTimeout(sessionTimer);originalSignal?.removeEventListener('abort',originalAbort);parentSignal.removeEventListener('abort',onAbort);if(this.attachmentTimer)clearTimeout(this.attachmentTimer);
   await this.shutdown;if(this.active)await this.active.done;try{this.native?.close();}catch{}
   if(this.attachment&&!this.detachAttempted){this.detachAttempted=true;const c=new AbortController();try{const reply=await this.post('detach','detach',{protocol,attachmentId:this.attachment.attachmentId},'detached',c.signal);if(reply.attachmentId!==this.attachment.attachmentId)throw new GameHostClientError('invalidMessage');}catch{}}
  }
  throw new GameHostClientError(this.failure??'closed');
 }
}
