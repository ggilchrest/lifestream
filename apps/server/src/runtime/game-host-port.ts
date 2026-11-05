import {captureGameSanityTiming,type GameSanityTiming,type GameSanityTimingInput} from '@lifestream/providers-bizhawk';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual,types as nodeTypes} from 'node:util';
import {performance} from 'node:perf_hooks';
import {GAME_HOST_PROTOCOL as protocol,GAME_HOST_LIMITS,gameHostMessage,gameHostDigest,gameHostCompletionMatches} from '@lifestream/contracts/game-host';
import type * as H from '@lifestream/contracts/game-host';
import type * as G from '@lifestream/contracts/game-activity';
import {nativeSourceWitness,captureNativeSource,nativeSourceException,type NativeSourceWitness,guardGameActivityAdapter} from '@lifestream/providers-bizhawk';
import type {GameActivityAdapter,GameCallContext,GameAdapterBoundaryOptions} from '@lifestream/providers-bizhawk';
import {GameHostDispatchRepository} from '@lifestream/storage-sqlite';
import type {Database,ActivityCheckpointRepository} from '@lifestream/storage-sqlite';
import {runCheckpointedGameController} from './game-activity.ts';
import type {CheckpointedGameControllerPorts} from './game-activity.ts';
import type {AuthenticatedGameRuntime} from './game-host-runtime.ts';

const hostDiagnosticCauses=new Set(['host_invoke_execution_mode', 'host_invoke_pending_operation', 'host_invoke_cancel_pending', 'host_invoke_signal_aborted', 'host_invoke_caller_context', 'host_invoke_command_deadline', 'host_invoke_command_schema', 'host_invoke_current_port_closed', 'host_invoke_current_attachment_closed', 'host_invoke_current_runtime', 'host_invoke_current_wall_lease', 'host_invoke_current_monotonic_lease', 'host_invoke_current_idle_lease', 'host_invoke_current_scope', 'host_invoke_current_principal', 'host_invoke_current_session', 'host_invoke_current_actor', 'host_invoke_current_binding', 'host_invoke_current_native_source', 'host_pending_cancel_cancelled', 'host_pending_cancel_deadline', 'host_pending_cancel_scopeChanged', 'host_pending_cancel_detached', 'host_pending_cancel_shutdown']);
const cancellationSites=new Set(['attachment_current', 'poll_initial_attachment', 'preparation_gate_attachment', 'admit_attachment', 'complete_attachment', 'detach_attachment', 'sweep_preparation', 'sweep_current', 'sweep_post_preparation', 'sweep_refresh_failed', 'poll_initial_failed', 'poll_finish_failed', 'poll_finish_current', 'poll_finish_structure', 'poll_pending', 'admit_pre', 'admit_final', 'complete_final', 'legacy_poll_current', 'legacy_sweep']);
const cancellationPredicates=new Set(['current_port_closed', 'current_attachment_closed', 'current_runtime', 'current_wall_lease', 'current_monotonic_lease', 'current_idle_lease', 'current_scope', 'current_principal', 'current_session', 'current_actor', 'current_binding', 'current_native_source', 'structure_port_closed', 'structure_attachment_closed', 'structure_aborted', 'structure_map_identity', 'structure_wall_lease', 'structure_monotonic_lease', 'structure_idle_lease', 'pending_identity', 'command_wall_deadline', 'command_monotonic_deadline', 'pending_signal_aborted', 'pending_context', 'poll_identity', 'poll_signal_aborted', 'operation_failed', 'poll_settled', 'read_refresh_deadline']);
type CancellationSite='attachment_current'|'poll_initial_attachment'|'preparation_gate_attachment'|'admit_attachment'|'complete_attachment'|'detach_attachment'|'sweep_preparation'|'sweep_current'|'sweep_post_preparation'|'sweep_refresh_failed'|'poll_initial_failed'|'poll_finish_failed'|'poll_finish_current'|'poll_finish_structure'|'poll_pending'|'admit_pre'|'admit_final'|'complete_final'|'legacy_poll_current'|'legacy_sweep';
type CancellationPredicate='current_port_closed'|'current_attachment_closed'|'current_runtime'|'current_wall_lease'|'current_monotonic_lease'|'current_idle_lease'|'current_scope'|'current_principal'|'current_session'|'current_actor'|'current_binding'|'current_native_source'|'structure_port_closed'|'structure_attachment_closed'|'structure_aborted'|'structure_map_identity'|'structure_wall_lease'|'structure_monotonic_lease'|'structure_idle_lease'|'pending_identity'|'command_wall_deadline'|'command_monotonic_deadline'|'pending_signal_aborted'|'pending_context'|'poll_identity'|'poll_signal_aborted'|'operation_failed'|'poll_settled'|'read_refresh_deadline';
type ObservedCause={value?:string;nativeSourceWitness?:NativeSourceWitness};
type CancellationOrigin=Readonly<{site:CancellationSite;predicate:CancellationPredicate;nativeSourceWitness?:NativeSourceWitness}>;
const cancellationOrigin=(site:CancellationSite,predicate:string,observed?:ObservedCause):CancellationOrigin=>({site,predicate:cancellationPredicates.has(predicate)?predicate as CancellationPredicate:'operation_failed',...(predicate==='current_native_source'&&observed?.nativeSourceWitness?{nativeSourceWitness:observed.nativeSourceWitness}:{})});
export class GameHostError extends Error{readonly status:number;readonly code:string;declare readonly diagnosticCause?:string;declare readonly cancellationSite?:string;declare readonly cancellationPredicate?:string;declare readonly nativeSourceWitness?:NativeSourceWitness;constructor(status:number,code:string,diagnosticCause?:string,cancellationSite?:string,cancellationPredicate?:string,witness?:NativeSourceWitness){super(code);this.status=status;this.code=code;if(typeof diagnosticCause==='string'&&hostDiagnosticCauses.has(diagnosticCause))Object.defineProperty(this,'diagnosticCause',{value:diagnosticCause,enumerable:true});if((diagnosticCause==='host_pending_cancel_scopeChanged'||diagnosticCause===undefined&&status===410&&code==='game_host_expired')&&typeof cancellationSite==='string'&&cancellationSites.has(cancellationSite)&&typeof cancellationPredicate==='string'&&cancellationPredicates.has(cancellationPredicate)){Object.defineProperties(this,{cancellationSite:{value:cancellationSite,enumerable:true},cancellationPredicate:{value:cancellationPredicate,enumerable:true}});const closed=cancellationPredicate==='current_native_source'?nativeSourceWitness(witness):undefined;if(closed)Object.defineProperty(this,'nativeSourceWitness',{value:closed,enumerable:true});}}}
/** Closed metadata only; neither getters nor arbitrary error text are read. */
export function gameHostExpiryDetail(error:unknown){
 if(!error||typeof error!=='object'||nodeTypes.isProxy(error))return;
 const value=(name:string)=>Object.getOwnPropertyDescriptor(error,name)?.value;
 if(value('status')!==410||value('code')!=='game_host_expired')return;
 const site=value('cancellationSite'),predicate=value('cancellationPredicate');
 if(typeof site!=='string'||!cancellationSites.has(site)||typeof predicate!=='string'||!cancellationPredicates.has(predicate))return;
 const witness=predicate==='current_native_source'?nativeSourceWitness(value('nativeSourceWitness')):undefined;
 return Object.freeze({cancellationSite:site,cancellationPredicate:predicate,...(witness?{nativeSourceWitness:witness}:{})});
}
/** Preserve only closed client response metadata in ordinary runtime diagnostics. */
export function gameHostDiagnosticResponse(value:unknown){
 if(!value||typeof value!=='object'||nodeTypes.isProxy(value))return;
 const own=(name:string)=>Object.getOwnPropertyDescriptor(value,name)?.value;
 const route=own('route'),status=own('status'),errorCode=own('errorCode');
 if(!['attach','next','admit','result','detach'].includes(route)||!Number.isInteger(status)||status<100||status>599)return;
 const code=['invalid_game_host_message','game_host_scope_denied','game_host_conflict','game_host_expired','game_host_unavailable','game_session_unavailable'].includes(errorCode)?errorCode:undefined;
 const detail=gameHostExpiryDetail({status,code,cancellationSite:own('cancellationSite'),cancellationPredicate:own('cancellationPredicate'),nativeSourceWitness:own('nativeSourceWitness')});
 return Object.freeze({route,status,...(code?{errorCode:code}:{}),...detail});
}
export type GameHostActor={principalId:string;sessionId:string;isCurrent:(scope:G.ActivityScope)=>boolean;runtimeFor?:(scope:G.ActivityScope,repository:ActivityCheckpointRepository)=>AuthenticatedGameRuntime|null};
export type GameHostBinding=Omit<H.GameHostAttach,'protocol'>;
export type GameHostOptions={
 sanityTiming?:GameSanityTimingInput;
 maxAttachments:number;maxDurationMs:number;createRepository:(database:Database)=>ActivityCheckpointRepository;
 /** Independent source/installation/display/authority qualification. Client metadata cannot grant this. */
 resolveAttachment:(actor:GameHostActor,metadata:Readonly<H.GameHostAttach>)=>GameHostBinding|null;
 bindingCurrent:(actor:GameHostActor,binding:Readonly<GameHostBinding>)=>boolean;
 controllerCurrent:(checkpoint:G.ActivityCheckpoint,request:G.GameActionRequest)=>boolean;
 boundary:Pick<GameAdapterBoundaryOptions,'sourceAvailable'|'acceptObservation'|'acceptAction'|'reconcileEffect'|'admitRelease'|'ordinaryGameTime'>;
 /** Captured physical owner read-only inspection; never wire-selected authority. */
 refreshSourceCustody?:(scope:Readonly<G.ActivityScope>,pins:string,signal:AbortSignal)=>Promise<void>;
 /** Exact retired-native proof from authenticated recovery, never wire data. */
 retiredHostCurrent?:(runId:string,hostId:string)=>boolean;
 onAttached?:(join:GameHostJoin)=>void;
};
type Pending={command:H.GameHostCommand;context:GameCallContext;identity:H.GameHostAdmit&{hostId:string;sourceRevision:string};resolve:(result:H.GameHostResult)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;abort:()=>void;deadline:number;delivered:boolean;entered:boolean};
type Attachment={id:string;actor:GameHostActor;binding:Readonly<GameHostBinding>;expires:number;monotonicExpiry:number;lastPoll:number;pending:Pending|null;poll:(()=>void)|null;cancel:H.GameHostCancel|null;closed:boolean;effectUnresolved:boolean;controller:AbortController;adapter:GameActivityAdapter;runtime?:AuthenticatedGameRuntime};
type RetiredAttachment=Readonly<{principalId:string;sessionId:string;wall:number;monotonic:number;origin:CancellationOrigin}>;
const owner=(scope:G.ActivityScope)=>({assistantId:scope.assistantId,principalId:scope.principalId,relationshipId:scope.relationshipId});
function fail(status:number,code:string):never{throw new GameHostError(status,code);}
const safe=(check:()=>boolean)=>{try{return check()===true;}catch{return false;}};
/** A trusted source-only handle; attachment never starts an activity or grants authority. */
export type GameHostJoin={attachmentId:string;scope:Readonly<G.ActivityScope>;adapter:GameActivityAdapter;runtime?:AuthenticatedGameRuntime;
 runController:(input:Parameters<typeof runCheckpointedGameController>[0],ports:Pick<CheckpointedGameControllerPorts,'signal'|'current'|'usageFor'>)=>ReturnType<typeof runCheckpointedGameController>};

export class GameHostPort{
 private readonly attachments=new Map<string,Attachment>();
 private readonly admissions=new Map<string,Attachment>();
 private readonly retiredAttachments=new Map<string,RetiredAttachment>();
 private readonly admissionCleanup=new WeakMap<Attachment,()=>void>();
 private readonly dispatch:GameHostDispatchRepository;
 private readonly repository:ActivityCheckpointRepository;
 private readonly options:Readonly<GameHostOptions>;
 private readonly sanityTiming:GameSanityTiming;
 private readonly sweepTimer:NodeJS.Timeout;
 private closed=false;
 constructor(database:Database,options:GameHostOptions){
  this.sanityTiming=captureGameSanityTiming(options.sanityTiming);
  if(!Number.isSafeInteger(options.maxAttachments)||options.maxAttachments<1||options.maxAttachments>16||!Number.isSafeInteger(options.maxDurationMs)||options.maxDurationMs<1||options.maxDurationMs>120000||typeof options.resolveAttachment!=='function'||typeof options.bindingCurrent!=='function'||typeof options.controllerCurrent!=='function'||typeof options.boundary?.sourceAvailable!=='function')throw new Error('invalid_game_host_options');
  if(options.retiredHostCurrent!==undefined&&typeof options.retiredHostCurrent!=='function')throw new Error('invalid_game_host_options');
  if(options.refreshSourceCustody!==undefined&&typeof options.refreshSourceCustody!=='function')throw new Error('invalid_game_host_options');
  this.options=Object.freeze({...options,boundary:Object.freeze({...options.boundary})});
  this.repository=options.createRepository(database);this.dispatch=new GameHostDispatchRepository(database,this.repository,this.options.retiredHostCurrent);
  this.sweepTimer=setInterval(()=>this.sweepFresh(),250);this.sweepTimer.unref();
 }
 private logicalCurrent(a:Attachment,scope=a.binding.scope,cause?:ObservedCause){
  // Local collection only. Pure probes have no callback or terminal side effect.
  const no=(guard:string)=>{if(cause)cause.value=guard;return false;};
  if(this.closed)return no('port_closed');
  if(a.closed)return no('attachment_closed');
  if(a.runtime&&!safe(a.runtime.isCurrent))return no('runtime');
  if(!(a.poll&&this.options.refreshSourceCustody)&&!(Date.now()<a.expires))return no('wall_lease');
  if(!(a.poll&&this.options.refreshSourceCustody)&&!(performance.now()<a.monotonicExpiry))return no('monotonic_lease');
  if(!(a.poll&&this.options.refreshSourceCustody)&&!(performance.now()-a.lastPoll<this.sanityTiming.hostIdleTimeoutMs))return no('idle_lease');
  if(!isDeepStrictEqual(scope,a.binding.scope))return no('scope');
  if(a.actor.principalId!==scope.principalId)return no('principal');
  if(a.actor.sessionId!==scope.contextBinding.sessionId)return no('session');
  if(!safe(()=>a.actor.isCurrent(scope)))return no('actor');
  if(!safe(()=>this.options.bindingCurrent(a.actor,a.binding)))return no('binding');
  return true;
 }
 private current(a:Attachment,scope=a.binding.scope,cause?:ObservedCause){
  if(!this.logicalCurrent(a,scope,cause))return false;
  const no=(guard:string)=>{if(cause)cause.value=guard;return false;};
  if(!safe(()=>{try{return this.options.boundary.sourceAvailable(scope,a.binding.pinsDigest,cause?value=>{if(!cause.nativeSourceWitness){const closed=nativeSourceWitness(value);if(closed)cause.nativeSourceWitness=closed;}}:undefined);}catch(error){if(cause)captureNativeSource(value=>{if(!cause.nativeSourceWitness)cause.nativeSourceWitness=value;},{stage:'boundary',predicate:'threw',exceptionClass:nativeSourceException(error)});throw error;}}))return no('native_source');
  return true;
 }
 private attachment(actor:GameHostActor,id:string,site:CancellationSite='attachment_current'):Attachment{
  const a=this.attachments.get(id);if(!a)throw this.expired(actor,id);
  if(a.actor.principalId!==actor.principalId||a.actor.sessionId!==actor.sessionId||!safe(()=>actor.isCurrent(a.binding.scope)))fail(403,'game_host_scope_denied');
  const observed:ObservedCause={};if(!this.current(a,a.binding.scope,observed)){this.fence(a,'scopeChanged',cancellationOrigin(site,'current_'+observed.value,observed));throw this.expired(actor,id);}return a;
 }
 private pruneRetired(){
  const wall=Date.now(),monotonic=performance.now();
  for(const [id,value] of this.retiredAttachments)if(!(wall>=value.wall&&wall<value.wall+GAME_HOST_LIMITS.attachmentMs&&monotonic>=value.monotonic&&monotonic<value.monotonic+GAME_HOST_LIMITS.attachmentMs))this.retiredAttachments.delete(id);
 }
 private expired(actor:GameHostActor,id:string,fallback=new GameHostError(410,'game_host_expired')):GameHostError{
  this.pruneRetired();const retired=this.retiredAttachments.get(id);
  // The tombstone carries no scope, callbacks, runtime, or capability. Matching
  // the authenticated principal/session only discloses why this ID retired.
  if(!retired||retired.principalId!==actor.principalId||retired.sessionId!==actor.sessionId)return fallback;
  return new GameHostError(410,'game_host_expired',undefined,retired.origin.site,retired.origin.predicate,retired.origin.nativeSourceWitness);
 }
 attach(actor:GameHostActor,raw:unknown,signal=new AbortController().signal):H.GameHostAttachment|Promise<H.GameHostAttachment>{
  return this.options.refreshSourceCustody?this.attachFresh(actor,raw,signal):this.attachLegacy(actor,raw);
 }
 private attachLegacy(actor:GameHostActor,raw:unknown):H.GameHostAttachment{
  const metadata=gameHostMessage('attach',raw);if(!metadata)fail(400,'invalid_game_host_message');
  if(this.closed)fail(503,'game_host_unavailable');this.sweepFresh();
  if(metadata.scope.principalId!==actor.principalId||metadata.scope.contextBinding.sessionId!==actor.sessionId||!safe(()=>actor.isCurrent(metadata.scope)))fail(403,'game_host_scope_denied');
  let candidate:GameHostBinding|null=null;try{candidate=this.options.resolveAttachment(actor,metadata);}catch{fail(503,'game_host_unavailable');}
  const checked=gameHostMessage('attach',candidate?{protocol,...candidate}:null);
  if(!checked||!isDeepStrictEqual(checked,metadata))fail(503,'game_host_unavailable');
  for(const a of this.attachments.values())if(a.binding.hostId===metadata.hostId||a.binding.scope.runId===metadata.scope.runId)fail(409,'game_host_conflict');
  if(this.attachments.size>=this.options.maxAttachments)fail(503,'game_host_unavailable');
  const {protocol:_,...binding}=checked,id=randomUUID(),expires=Date.now()+GAME_HOST_LIMITS.attachmentMs;
  const actorSnapshot=Object.freeze({principalId:actor.principalId,sessionId:actor.sessionId,isCurrent:actor.isCurrent,...(actor.runtimeFor?{runtimeFor:actor.runtimeFor}:{})});
  const a={id,actor:actorSnapshot,binding:Object.freeze(binding),expires,monotonicExpiry:performance.now()+GAME_HOST_LIMITS.attachmentMs,lastPoll:performance.now(),pending:null,poll:null,cancel:null,closed:false,effectUnresolved:false,controller:new AbortController()} as Attachment;
  const invoke=<R extends H.GameHostResult>(request:H.GameHostRequest,context:GameCallContext)=>this.invoke(a,request,context) as Promise<R>;
  const rawAdapter:GameActivityAdapter={observe:(r,c)=>invoke<G.GameObserveResult>(r,c),applyController:(r,c)=>invoke<G.GameActionResult>(r,c),releaseControls:(r,c)=>invoke<G.GameReleaseResult>(r,c),controlSave:async()=>fail(503,'game_host_unavailable')};
  const boundary=this.options.boundary;
  a.adapter=Object.freeze(guardGameActivityAdapter(rawAdapter,{...(boundary.ordinaryGameTime===true?{ordinaryGameTime:true}:{}),providerRef:binding.providerRef,maxDurationMs:this.options.maxDurationMs,
   sourceAvailable:(scope,pins)=>pins===binding.pinsDigest&&this.current(a,scope),
   ...(boundary.acceptObservation?{acceptObservation:(r:G.GameObserveRequest,o:G.GameObservation)=>this.current(a,r.scope)&&safe(()=>boundary.acceptObservation!(r,o))}:{}),
   ...(boundary.acceptAction?{acceptAction:(r:G.GameActionRequest,result:G.GameActionResult)=>this.current(a,r.scope)&&safe(()=>boundary.acceptAction!(r,result))}:{}),
   claimEffect:async(r,c)=>r.operation==='GameActivityAdapter.applyController'&&this.claim(a,r,c),
   ...(boundary.reconcileEffect?{reconcileEffect:async(r:G.GameActionRequest|G.GameSaveRequest,c:GameCallContext)=>this.current(a,r.scope)&&await boundary.reconcileEffect!(r,c)===true}:{}),
   ...(boundary.admitRelease?{admitRelease:async(r:G.GameReleaseRequest,c:GameCallContext)=>this.current(a,r.scope)&&await boundary.admitRelease!(r,c)===true}:{}),
  }));
  if(actorSnapshot.runtimeFor){const runtime=actorSnapshot.runtimeFor(a.binding.scope,this.repository);if(!runtime)fail(503,'game_host_unavailable');a.runtime=runtime;}
  if(!this.current(a))fail(503,'game_host_unavailable');this.attachments.set(id,a);
  const adapter=a.adapter,repository=this.repository;
  const join:GameHostJoin=Object.freeze({attachmentId:id,scope:a.binding.scope,adapter,...(a.runtime?{runtime:a.runtime}:{}),runController:(input,ports)=>{
   const {signal,current,usageFor}=ports;
   return runCheckpointedGameController(input,{repository,adapter,signal:AbortSignal.any([signal,a.controller.signal]),usageFor,current:(cp,r)=>ports.signal===signal&&ports.current===current&&ports.usageFor===usageFor&&this.current(a,r.scope)&&(!a.runtime||safe(a.runtime.controllerCurrent))&&safe(()=>this.options.controllerCurrent(cp,r))&&safe(()=>current(cp,r))});
  }});
  try{this.options.onAttached?.(join);}catch{this.fence(a,'detached');fail(503,'game_host_unavailable');}
  return {protocol,attachmentId:id,expiresAt:new Date(expires).toISOString(),pollMs:1000,maxMessageBytes:131072};
 }
 private async attachFresh(actor:GameHostActor,raw:unknown,signal:AbortSignal):Promise<H.GameHostAttachment>{
  const beganWall=Date.now(),beganMono=performance.now();
  if(signal.aborted)fail(410,'game_host_expired');
  const metadata=gameHostMessage('attach',raw);if(!metadata)fail(400,'invalid_game_host_message');
  if(this.closed)fail(503,'game_host_unavailable');this.sweepFresh();
  if(metadata.scope.principalId!==actor.principalId||metadata.scope.contextBinding.sessionId!==actor.sessionId||!safe(()=>actor.isCurrent(metadata.scope)))fail(403,'game_host_scope_denied');
  let candidate:GameHostBinding|null=null;try{candidate=this.options.resolveAttachment(actor,metadata);}catch{fail(503,'game_host_unavailable');}
  const checked=gameHostMessage('attach',candidate?{protocol,...candidate}:null);
  if(!checked||!isDeepStrictEqual(checked,metadata))fail(503,'game_host_unavailable');
  for(const a of [...this.attachments.values(),...this.admissions.values()])if(a.binding.hostId===metadata.hostId||a.binding.scope.runId===metadata.scope.runId)fail(409,'game_host_conflict');
  if(new Set([...this.attachments.keys(),...this.admissions.keys()]).size>=this.options.maxAttachments)fail(503,'game_host_unavailable');
  const {protocol:_,...binding}=checked,id=randomUUID(),expires=Date.now()+GAME_HOST_LIMITS.attachmentMs;
  const actorSnapshot=Object.freeze({principalId:actor.principalId,sessionId:actor.sessionId,isCurrent:actor.isCurrent,...(actor.runtimeFor?{runtimeFor:actor.runtimeFor}:{})});
  const a={id,actor:actorSnapshot,binding:Object.freeze(binding),expires,monotonicExpiry:performance.now()+GAME_HOST_LIMITS.attachmentMs,lastPoll:performance.now(),pending:null,poll:null,cancel:null,closed:false,effectUnresolved:false,controller:new AbortController()} as Attachment;
  const invoke=<R extends H.GameHostResult>(request:H.GameHostRequest,context:GameCallContext)=>this.invoke(a,request,context) as Promise<R>;
  const rawAdapter:GameActivityAdapter={observe:(r,c)=>invoke<G.GameObserveResult>(r,c),applyController:(r,c)=>invoke<G.GameActionResult>(r,c),releaseControls:(r,c)=>invoke<G.GameReleaseResult>(r,c),controlSave:async()=>fail(503,'game_host_unavailable')};
  const boundary=this.options.boundary;
  a.adapter=Object.freeze(guardGameActivityAdapter(rawAdapter,{...(boundary.ordinaryGameTime===true?{ordinaryGameTime:true}:{}),providerRef:binding.providerRef,maxDurationMs:this.options.maxDurationMs,
   sourceAvailable:(scope,pins)=>pins===binding.pinsDigest&&this.current(a,scope),
   ...(boundary.acceptObservation?{acceptObservation:(r:G.GameObserveRequest,o:G.GameObservation)=>this.current(a,r.scope)&&safe(()=>boundary.acceptObservation!(r,o))}:{}),
   ...(boundary.acceptAction?{acceptAction:(r:G.GameActionRequest,result:G.GameActionResult)=>this.current(a,r.scope)&&safe(()=>boundary.acceptAction!(r,result))}:{}),
   claimEffect:async(r,c)=>r.operation==='GameActivityAdapter.applyController'&&this.claim(a,r,c),
   ...(boundary.reconcileEffect?{reconcileEffect:async(r:G.GameActionRequest|G.GameSaveRequest,c:GameCallContext)=>this.current(a,r.scope)&&await boundary.reconcileEffect!(r,c)===true}:{}),
   ...(boundary.admitRelease?{admitRelease:async(r:G.GameReleaseRequest,c:GameCallContext)=>this.current(a,r.scope)&&await boundary.admitRelease!(r,c)===true}:{}),
  }));
  this.admissions.set(id,a);let accepted=false;
  const abort=()=>a.controller.abort();signal.addEventListener('abort',abort,{once:true});
  const present=()=>!this.closed&&!a.closed&&!signal.aborted&&!a.controller.signal.aborted&&this.admissions.get(id)===a&&a.binding===binding&&a.actor===actorSnapshot&&actor.principalId===actorSnapshot.principalId&&actor.sessionId===actorSnapshot.sessionId&&actor.isCurrent===actorSnapshot.isCurrent&&actor.runtimeFor===actorSnapshot.runtimeFor&&Date.now()>=beganWall&&performance.now()>=beganMono&&Date.now()<beganWall+this.options.maxDurationMs&&performance.now()<beganMono+this.options.maxDurationMs;
  let timer:ReturnType<typeof setTimeout>|undefined,rejectWait=()=>{};
  try{
  if(!present())fail(410,'game_host_expired');
  if(actorSnapshot.runtimeFor){const runtime=actorSnapshot.runtimeFor(a.binding.scope,this.repository);if(!runtime)fail(503,'game_host_unavailable');const close=runtime.close;let disposed=false;const dispose=()=>{if(!disposed){disposed=true;close.call(runtime);}};this.admissionCleanup.set(a,dispose);if(!present()){try{dispose();}catch{}fail(410,'game_host_expired');}a.runtime=runtime;}
  // Prequalify the original logical ports without requiring the cache being
  // refreshed. The SAME complete original current() runs after the await.
  if(a.runtime&&!safe(a.runtime.isCurrent)||!safe(()=>actorSnapshot.isCurrent(binding.scope))||!safe(()=>this.options.bindingCurrent(actorSnapshot,binding)))fail(503,'game_host_unavailable');
  const runtime=a.runtime,runtimeCurrent=runtime?.isCurrent,runtimeClose=runtime?.close,left=Math.min(this.options.maxDurationMs-(Date.now()-beganWall),this.options.maxDurationMs-(performance.now()-beganMono));
  if(left<=0||!present())fail(410,'game_host_expired');
  const work=Promise.resolve().then(()=>{if(!present())fail(410,'game_host_expired');return this.options.refreshSourceCustody!(binding.scope,binding.pinsDigest,a.controller.signal);});
  await Promise.race([work,new Promise<never>((_,reject)=>{rejectWait=()=>reject(new GameHostError(410,'game_host_expired'));a.controller.signal.addEventListener('abort',rejectWait,{once:true});timer=setTimeout(()=>{a.controller.abort();rejectWait();},left);timer.unref();if(a.controller.signal.aborted)rejectWait();})]);
  if(!present()||a.runtime!==runtime||a.runtime?.isCurrent!==runtimeCurrent||a.runtime?.close!==runtimeClose)fail(410,'game_host_expired');
  if(!this.current(a))fail(503,'game_host_unavailable');
  if(!present()||a.runtime!==runtime||a.runtime?.isCurrent!==runtimeCurrent||a.runtime?.close!==runtimeClose)fail(410,'game_host_expired');
  if(timer){clearTimeout(timer);timer=undefined;}a.controller.signal.removeEventListener('abort',rejectWait);this.attachments.set(id,a);
  const adapter=a.adapter,repository=this.repository;
  const join:GameHostJoin=Object.freeze({attachmentId:id,scope:a.binding.scope,adapter,...(a.runtime?{runtime:a.runtime}:{}),runController:(input,ports)=>{
   const {signal,current,usageFor}=ports;
   return runCheckpointedGameController(input,{repository,adapter,signal:AbortSignal.any([signal,a.controller.signal]),usageFor,current:(cp,r)=>ports.signal===signal&&ports.current===current&&ports.usageFor===usageFor&&this.current(a,r.scope)&&(!a.runtime||safe(a.runtime.controllerCurrent))&&safe(()=>this.options.controllerCurrent(cp,r))&&safe(()=>current(cp,r))});
  }});
  try{this.options.onAttached?.(join);}catch{this.fence(a,'detached');fail(503,'game_host_unavailable');}
  if(!present()||a.runtime!==runtime||a.runtime?.isCurrent!==runtimeCurrent||a.runtime?.close!==runtimeClose||this.attachments.get(id)!==a)fail(410,'game_host_expired');accepted=true;
  return {protocol,attachmentId:id,expiresAt:new Date(expires).toISOString(),pollMs:1000,maxMessageBytes:131072};
  }finally{
   if(timer)clearTimeout(timer);a.controller.signal.removeEventListener('abort',rejectWait);signal.removeEventListener('abort',abort);
   if(this.admissions.get(id)===a)this.admissions.delete(id);
   if(!accepted)this.fence(a,'detached');this.admissionCleanup.delete(a);
  }
 }
 private claims=new WeakMap<Attachment,{requestDigest:string;identity:Pending['identity']}>();
 private claim(a:Attachment,r:G.GameActionRequest,c:GameCallContext):boolean{
  if(a.effectUnresolved||a.pending||this.claims.has(a)||c.signal.aborted||a.runtime&&!safe(a.runtime.controllerCurrent)||!this.current(a,r.scope)||!safe(()=>c.isCurrent(r.scope)))return false;
  const identity={protocol,attachmentId:a.id,hostId:a.binding.hostId,sourceRevision:a.binding.sourceRevision,commandId:randomUUID(),requestDigest:gameHostDigest(r)};
  const {protocol:_,...durableIdentity}=identity;
  if(!this.dispatch.claim(owner(r.scope),r,durableIdentity,(cp,request)=>this.current(a,request.scope)&&!c.signal.aborted&&safe(()=>c.isCurrent(request.scope))&&safe(()=>this.options.controllerCurrent(cp,request))))return false;
  this.claims.set(a,{requestDigest:identity.requestDigest,identity});return true;
 }
 private async invoke(a:Attachment,r:H.GameHostRequest,c:GameCallContext):Promise<H.GameHostResult>{
  // The claim transaction has finished. Let pending Stop/native I/O run before
  // another validation burst, then qualify every original port afresh below.
  await new Promise<void>(resolve=>setImmediate(resolve));
  const observed:ObservedCause={};let cause:string|undefined;
  if(r.executionMode!=='normal')cause='host_invoke_execution_mode';
  else if(a.pending)cause='host_invoke_pending_operation';
  else if(a.cancel)cause='host_invoke_cancel_pending';
  else if(c.signal.aborted)cause='host_invoke_signal_aborted';
  else if(!this.current(a,r.scope,observed))cause='host_invoke_current_'+observed.value;
  else if(!safe(()=>c.isCurrent(r.scope)))cause='host_invoke_caller_context';
  if(cause)return Promise.reject(new GameHostError(409,'game_host_conflict',cause));
  const requestDigest=gameHostDigest(r),claim=this.claims.get(a);let identity:Pending['identity'];
  if(r.operation==='GameActivityAdapter.applyController'){
   if(!claim||claim.requestDigest!==requestDigest)return Promise.reject(new GameHostError(409,'game_host_conflict'));identity=claim.identity;this.claims.delete(a);
  }else identity={protocol,attachmentId:a.id,hostId:a.binding.hostId,sourceRevision:a.binding.sourceRevision,commandId:randomUUID(),requestDigest};
  const expires=Math.min(a.expires,Date.now()+this.options.maxDurationMs,Date.parse(r.deadlineAt),r.operation==='GameActivityAdapter.applyController'?Date.parse(r.payload.admission.expiresAt):Infinity);
  if(expires<=Date.now()){if(r.operation==='GameActivityAdapter.applyController')this.dispatch.unresolved(identity);return Promise.reject(new GameHostError(410,'game_host_expired','host_invoke_command_deadline'));}
  const event=gameHostMessage('event',{protocol,kind:'command',attachmentId:a.id,commandId:identity.commandId,requestDigest,expiresAt:new Date(expires).toISOString(),request:r});
  if(!event||event.kind!=='command'){if(r.operation==='GameActivityAdapter.applyController')this.dispatch.unresolved(identity);return Promise.reject(new GameHostError(400,'invalid_game_host_message','host_invoke_command_schema'));}
  const command=event;
  return new Promise((resolve,reject)=>{
   const abort=()=>this.cancel(a,'cancelled'),timer=setTimeout(()=>this.cancel(a,'deadline'),expires-Date.now());timer.unref();
   a.pending={command,context:c,identity,resolve,reject,timer,abort,deadline:performance.now()+expires-Date.now(),delivered:false,entered:false};
   c.signal.addEventListener('abort',abort,{once:true});if(c.signal.aborted)abort();a.poll?.();
  });
 }
 async next(actor:GameHostActor,raw:unknown,signal:AbortSignal):Promise<H.GameHostEvent>{
  if(this.options.refreshSourceCustody)return this.nextFresh(actor,raw,signal);
  const message=gameHostMessage('next',raw);if(!message)fail(400,'invalid_game_host_message');const a=this.attachment(actor,message.attachmentId);
  if(a.poll)fail(409,'game_host_conflict');if(signal.aborted){this.fence(a,'detached');fail(410,'game_host_expired');}
  a.lastPoll=performance.now();a.expires=Date.now()+GAME_HOST_LIMITS.attachmentMs;a.monotonicExpiry=performance.now()+GAME_HOST_LIMITS.attachmentMs;
  return new Promise((resolve,reject)=>{
   const finish=()=>{cleanup();const observed:ObservedCause={};try{if(!this.current(a,a.binding.scope,observed))fail(410,'game_host_expired');if(a.cancel){const event=a.cancel;a.cancel=null;resolve(event);return;}const pending=a.pending;if(pending&&!pending.delivered){pending.delivered=true;resolve(pending.command);return;}resolve({protocol,kind:'idle',attachmentId:a.id,expiresAt:new Date(a.expires).toISOString()});}catch(error){this.fence(a,'scopeChanged',cancellationOrigin('legacy_poll_current',observed.value?'current_'+observed.value:'operation_failed',observed));reject(error instanceof GameHostError&&error.status===410&&error.code==='game_host_expired'?this.expired(actor,a.id,error):error);}};
   const aborted=()=>{cleanup();this.fence(a,'detached');reject(new GameHostError(410,'game_host_expired'));};
   const timer=setTimeout(finish,GAME_HOST_LIMITS.pollMs);const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',aborted);if(a.poll===finish)a.poll=null;};
   a.poll=finish;signal.addEventListener('abort',aborted,{once:true});if(a.cancel||a.pending&&!a.pending.delivered)finish();
  });
 }
 // Share only the original exact physical inspection. A stale cache is never
 // current; original full actor/runtime/source qualification still follows it.
 private readonly sourceRefreshes=new WeakMap<Attachment,Promise<void>>();
 private readonly sweepRefreshes=new WeakSet<Attachment>();
 private preparationPresent(a:Attachment,cause?:ObservedCause){
  const no=(value:string)=>{if(cause)cause.value='structure_'+value;return false;};
  if(this.closed)return no('port_closed');if(a.closed)return no('attachment_closed');if(a.controller.signal.aborted)return no('aborted');if(this.attachments.get(a.id)!==a)return no('map_identity');if(!(a.poll&&this.options.refreshSourceCustody)&&!(Date.now()<a.expires))return no('wall_lease');if(!(a.poll&&this.options.refreshSourceCustody)&&!(performance.now()<a.monotonicExpiry))return no('monotonic_lease');if(!(a.poll&&this.options.refreshSourceCustody)&&!(performance.now()-a.lastPoll<this.sanityTiming.hostIdleTimeoutMs))return no('idle_lease');return true;
 }
 private async refreshSource(a:Attachment,signal:AbortSignal,site:CancellationSite):Promise<void>{
  const observed:ObservedCause={};
  const refused=(predicate:string):never=>{const origin=cancellationOrigin(site,predicate);throw new GameHostError(410,'game_host_expired',undefined,origin.site,origin.predicate);};
  if(signal.aborted)refused('structure_aborted');if(!this.preparationPresent(a,observed))refused(observed.value!);
  let work=this.sourceRefreshes.get(a);
  if(!work){
   const binding=a.binding,scope=binding.scope,pins=binding.pinsDigest;
   work=Promise.resolve().then(async()=>{
    if(!this.preparationPresent(a,observed))refused(observed.value!);if(a.binding!==binding)refused('current_binding');
    await this.options.refreshSourceCustody!(scope,pins,a.controller.signal);
    if(!this.preparationPresent(a,observed))refused(observed.value!);if(a.binding!==binding)refused('current_binding');if(a.binding.scope!==scope)refused('current_scope');if(a.binding.pinsDigest!==pins)refused('current_binding');
   });
   this.sourceRefreshes.set(a,work);const selected=work;
   void work.finally(()=>{if(this.sourceRefreshes.get(a)===selected)this.sourceRefreshes.delete(a);}).catch(()=>{});
  }
  const now=performance.now(),wall=Date.now(),left=a.poll?this.sanityTiming.readRefreshTimeoutMs:Math.min(this.sanityTiming.readRefreshTimeoutMs,a.expires-wall,a.monotonicExpiry-now,this.sanityTiming.hostIdleTimeoutMs-(now-a.lastPoll));
  if(left<=0)refused(a.expires<=wall?'structure_wall_lease':a.monotonicExpiry<=now?'structure_monotonic_lease':this.sanityTiming.hostIdleTimeoutMs<=now-a.lastPoll?'structure_idle_lease':'read_refresh_deadline');
  let abort=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
  try{
   await Promise.race([work,new Promise<never>((_,reject)=>{
    abort=()=>reject(new GameHostError(410,'game_host_expired',undefined,site,'structure_aborted'));
    signal.addEventListener('abort',abort,{once:true});a.controller.signal.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>reject(new GameHostError(410,'game_host_expired',undefined,site,'read_refresh_deadline')),left);timer.unref();if(signal.aborted||a.controller.signal.aborted)abort();
   })]);
   // A completed inspection may win before an overdue timer callback. Actual
   // attachment, idle and authority leases are still checked after completion.
   if(signal.aborted)refused('structure_aborted');if(Date.now()<wall||performance.now()<now)refused('operation_failed');if(!this.preparationPresent(a,observed))refused(observed.value!);
  }finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);a.controller.signal.removeEventListener('abort',abort);}
 }
 private refreshFailureOrigin(error:unknown,site:CancellationSite):CancellationOrigin{
  const detail=gameHostExpiryDetail(error);
  return detail?{site:detail.cancellationSite as CancellationSite,predicate:detail.cancellationPredicate as CancellationPredicate,...(detail.nativeSourceWitness?{nativeSourceWitness:detail.nativeSourceWitness}:{})}:cancellationOrigin(site,'operation_failed');
 }
 private sweepFresh(){
  this.pruneRetired();
  if(!this.options.refreshSourceCustody){this.sweep();return;}
  for(const a of this.attachments.values()){
   const initial:ObservedCause={};if(!this.preparationPresent(a,initial)){this.fence(a,'scopeChanged',cancellationOrigin('sweep_preparation',initial.value!));continue;}
   if(this.sweepRefreshes.has(a))continue;
   this.sweepRefreshes.add(a);
   void (async()=>{try{
    // Cold authenticated/runtime/source qualification can consume inspection
    // freshness. Do that logical work before the read-only inspection too;
    // this is no admission and never uses cached native custody as a precheck.
    // The complete original current() still runs after the awaited refresh.
    const beforeRefresh:ObservedCause={};if(!this.logicalCurrent(a,a.binding.scope,beforeRefresh)){this.fence(a,'scopeChanged',cancellationOrigin('sweep_current','current_'+beforeRefresh.value,beforeRefresh));return;}
    await this.refreshSource(a,a.controller.signal,'sweep_refresh_failed');const observed:ObservedCause={};if(!this.current(a,a.binding.scope,observed))this.fence(a,'scopeChanged',cancellationOrigin('sweep_current','current_'+observed.value,observed));else if(!this.preparationPresent(a,observed))this.fence(a,'scopeChanged',cancellationOrigin('sweep_post_preparation',observed.value!));
   }catch(error){this.fence(a,'scopeChanged',this.refreshFailureOrigin(error,'sweep_refresh_failed'));}finally{this.sweepRefreshes.delete(a);}})();
  }
 }
 private nextFresh(actor:GameHostActor,raw:unknown,signal:AbortSignal):Promise<H.GameHostEvent>{
  const message=gameHostMessage('next',raw);if(!message)fail(400,'invalid_game_host_message');
  const a=this.attachments.get(message.attachmentId);if(!a)throw this.expired(actor,message.attachmentId);
  // Reserve this original poll slot before the await, without extending its
  // lease. The original full attachment/actor/current checks follow inspection.
  if(a.actor.principalId!==actor.principalId||a.actor.sessionId!==actor.sessionId||!safe(()=>actor.isCurrent(a.binding.scope)))fail(403,'game_host_scope_denied');
  if(a.poll)fail(409,'game_host_conflict');if(signal.aborted){this.fence(a,'detached');fail(410,'game_host_expired');}
  const admission:ObservedCause={};if(!this.preparationPresent(a,admission)){this.fence(a,'scopeChanged',cancellationOrigin('poll_initial_failed',admission.value!));throw this.expired(actor,a.id);}
  return new Promise((resolve,reject)=>{
   let settled=false,qualified=false,finishing=false,requested=false,timer:ReturnType<typeof setTimeout>|undefined;
   const cleanup=()=>{settled=true;if(timer)clearTimeout(timer);signal.removeEventListener('abort',aborted);if(a.poll===finish)a.poll=null;};
   const refuse=(error:unknown,origin:CancellationOrigin)=>{if(settled)return;cleanup();this.fence(a,'scopeChanged',origin);reject(error instanceof GameHostError&&error.status===410&&error.code==='game_host_expired'?this.expired(actor,a.id,error):error);};
   const aborted=()=>{if(settled)return;cleanup();this.fence(a,'detached');reject(new GameHostError(410,'game_host_expired'));};
   const finish=()=>{
    if(settled||a.poll!==finish)return;if(!qualified){requested=true;return;}if(finishing)return;finishing=true;
    void (async()=>{let origin:CancellationOrigin=cancellationOrigin('poll_finish_failed','operation_failed');try{
     await this.refreshSource(a,signal,origin.site);if(settled)return;
     const observed:ObservedCause={};
     if(a.poll!==finish){origin=cancellationOrigin('poll_finish_current','poll_identity');fail(410,'game_host_expired');}if(signal.aborted){origin=cancellationOrigin('poll_finish_current','poll_signal_aborted');fail(410,'game_host_expired');}if(!this.current(a,a.binding.scope,observed)){origin=cancellationOrigin('poll_finish_current','current_'+observed.value,observed);fail(410,'game_host_expired');}
     if(settled){origin=cancellationOrigin('poll_finish_structure','poll_settled');fail(410,'game_host_expired');}if(a.poll!==finish){origin=cancellationOrigin('poll_finish_structure','poll_identity');fail(410,'game_host_expired');}if(signal.aborted){origin=cancellationOrigin('poll_finish_structure','poll_signal_aborted');fail(410,'game_host_expired');}if(!this.preparationPresent(a,observed)){origin=cancellationOrigin('poll_finish_structure',observed.value!);fail(410,'game_host_expired');}
     // Commit a fresh heartbeat only after original owner/runtime/source checks.
     a.lastPoll=performance.now();a.expires=Date.now()+GAME_HOST_LIMITS.attachmentMs;a.monotonicExpiry=performance.now()+GAME_HOST_LIMITS.attachmentMs;
     let event:H.GameHostEvent;
     if(a.cancel){event=a.cancel;a.cancel=null;}else{const pending=a.pending;if(pending&&!pending.delivered){
      const pendingCause:ObservedCause={},current=this.pendingCurrent(a,pending,pendingCause),expired=Date.now()>=Date.parse(pending.command.expiresAt)||performance.now()>=pending.deadline;
      if(settled){origin=cancellationOrigin('poll_finish_structure','poll_settled');fail(410,'game_host_expired');}if(a.poll!==finish){origin=cancellationOrigin('poll_finish_structure','poll_identity');fail(410,'game_host_expired');}if(a.pending!==pending){origin=cancellationOrigin('poll_finish_structure','pending_identity');fail(410,'game_host_expired');}if(!this.preparationPresent(a,observed)){origin=cancellationOrigin('poll_finish_structure',observed.value!);fail(410,'game_host_expired');}
      if(!current||expired||pending.context.signal.aborted){this.cancel(a,expired?'deadline':'scopeChanged',cancellationOrigin('poll_pending',pendingCause.value??'operation_failed',pendingCause));if(!a.cancel)fail(410,'game_host_expired');event=a.cancel;a.cancel=null;}
      else{pending.delivered=true;event=pending.command;}
     }else event={protocol,kind:'idle',attachmentId:a.id,expiresAt:new Date(a.expires).toISOString()};}
     cleanup();resolve(event);
    }catch(error){refuse(error,gameHostExpiryDetail(error)?this.refreshFailureOrigin(error,origin.site):origin);}})();
   };
   a.poll=finish;signal.addEventListener('abort',aborted,{once:true});if(signal.aborted){aborted();return;}
   void (async()=>{let origin:CancellationOrigin=cancellationOrigin('poll_initial_failed','operation_failed');try{
    await this.refreshSource(a,signal,origin.site);if(settled)return;
    if(a.poll!==finish){origin=cancellationOrigin('poll_initial_failed','poll_identity');fail(410,'game_host_expired');}if(this.attachment(actor,message.attachmentId,'poll_initial_attachment')!==a){origin=cancellationOrigin('poll_initial_failed','structure_map_identity');fail(410,'game_host_expired');}
    if(signal.aborted){aborted();return;}
    const observed:ObservedCause={};if(settled){origin=cancellationOrigin('poll_initial_failed','poll_settled');fail(410,'game_host_expired');}if(a.poll!==finish){origin=cancellationOrigin('poll_initial_failed','poll_identity');fail(410,'game_host_expired');}if(!this.preparationPresent(a,observed)){origin=cancellationOrigin('poll_initial_failed',observed.value!);fail(410,'game_host_expired');}
    qualified=true;timer=setTimeout(finish,GAME_HOST_LIMITS.pollMs);
    if(requested||a.cancel||a.pending&&!a.pending.delivered)finish();
   }catch(error){refuse(error,gameHostExpiryDetail(error)?this.refreshFailureOrigin(error,origin.site):origin);}})();
  });
 }
 /** Original pending-command inspection for preparation observation transport.
  * A wire operation label never chooses this lane; the retained broker command
  * and exact original actor/digest/phase must independently match. */
 preparationObservationCurrent(actor:GameHostActor,operation:string,raw:unknown):boolean{
  try{
   if(!['admit','complete'].includes(operation))return false;
   const message=gameHostMessage(operation==='admit'?'admit':'completion',raw);if(!message||!('commandId' in message))return false;
   const a=this.attachment(actor,message.attachmentId,'preparation_gate_attachment'),p=a.pending;
   return !!p&&p.delivered&&p.entered===(operation==='complete')&&p.command.commandId===message.commandId&&p.command.request.operation==='GameActivityAdapter.observe'&&this.pendingCurrent(a,p)&&(operation==='admit'?p.command.requestDigest===(message as any).requestDigest:gameHostCompletionMatches(p.command,message as H.GameHostCompletion));
  }catch{return false;}
 }
 admit(actor:GameHostActor,raw:unknown):H.GameHostAdmission{
  const message=gameHostMessage('admit',raw);if(!message)fail(400,'invalid_game_host_message');const a=this.attachment(actor,message.attachmentId,'admit_attachment'),p=a.pending;
  if(!p||!p.delivered||p.entered||p.command.commandId!==message.commandId||p.command.requestDigest!==message.requestDigest)fail(409,'game_host_conflict');
  {const pendingCause:ObservedCause={};if(!this.pendingCurrent(a,p,pendingCause)){this.cancel(a,'scopeChanged',cancellationOrigin('admit_pre',pendingCause.value!,pendingCause));fail(410,'game_host_expired');}}
  if(p.command.request.operation==='GameActivityAdapter.applyController'){
   const {protocol:_,...identity}=p.identity;
   if(!this.dispatch.enter(owner(p.command.request.scope),p.command.request,identity,(cp,r)=>this.pendingCurrent(a,p)&&safe(()=>this.options.controllerCurrent(cp,r)))){this.cancel(a,'scopeChanged');fail(409,'game_host_conflict');}
  }
  {const pendingCause:ObservedCause={};if(!this.pendingCurrent(a,p,pendingCause)){this.cancel(a,'scopeChanged',cancellationOrigin('admit_final',pendingCause.value!,pendingCause));fail(410,'game_host_expired');}}p.entered=true;
  return {...message,admitted:true,expiresAt:p.command.expiresAt};
 }
 complete(actor:GameHostActor,raw:unknown):H.GameHostAccepted{
  const completion=gameHostMessage('completion',raw);if(!completion)fail(400,'invalid_game_host_message');const a=this.attachment(actor,completion.attachmentId,'complete_attachment'),p=a.pending;
  if(!p||!p.entered||!this.pendingCurrent(a,p)||!gameHostCompletionMatches(p.command,completion)||completion.result.providerRef!==a.binding.providerRef)fail(409,'game_host_conflict');
  if(p.command.request.operation==='GameActivityAdapter.applyController'&&!this.dispatch.receipt(p.identity,completion.resultDigest))fail(409,'game_host_conflict');
  {const pendingCause:ObservedCause={};if(!this.pendingCurrent(a,p,pendingCause)){this.cancel(a,'scopeChanged',cancellationOrigin('complete_final',pendingCause.value!,pendingCause));fail(410,'game_host_expired');}}
  this.clear(a,p);p.resolve(completion.result);
  return {protocol,attachmentId:a.id,commandId:completion.commandId,resultDigest:completion.resultDigest,accepted:true};
 }
 detach(actor:GameHostActor,raw:unknown):H.GameHostDetached{
  const message=gameHostMessage('detach',raw);if(!message)fail(400,'invalid_game_host_message');const a=this.attachment(actor,message.attachmentId,'detach_attachment');this.fence(a,'detached');return {...message,fenced:true};
 }
 private pendingCurrent(a:Attachment,p:Pending,cause?:ObservedCause){
  const no=(value:string)=>{if(cause)cause.value=value;return false;};
  if(a.pending!==p)return no('pending_identity');const observed=cause?{} as ObservedCause:undefined;if(!this.current(a,p.command.request.scope,observed)){if(cause&&observed?.nativeSourceWitness)cause.nativeSourceWitness=observed.nativeSourceWitness;return no('current_'+observed?.value);}if(!(Date.now()<Date.parse(p.command.expiresAt)))return no('command_wall_deadline');if(!(performance.now()<p.deadline))return no('command_monotonic_deadline');if(p.context.signal.aborted)return no('pending_signal_aborted');if(!safe(()=>p.context.isCurrent(p.command.request.scope)))return no('pending_context');return true;
 }
 private clear(a:Attachment,p:Pending){clearTimeout(p.timer);p.context.signal.removeEventListener('abort',p.abort);if(a.pending===p)a.pending=null;}
 private cancel(a:Attachment,reason:H.GameHostCancel['reason'],origin?:CancellationOrigin){
  const p=a.pending;if(!p)return;this.clear(a,p);
  if(p.command.request.operation==='GameActivityAdapter.applyController'){a.effectUnresolved=true;try{this.dispatch.unresolved(p.identity);}catch{/* durable reservation/claim still prevents replay */}}
  a.cancel={protocol,kind:'cancel',attachmentId:a.id,commandId:p.command.commandId,requestDigest:p.command.requestDigest,cancellationId:p.command.request.cancellationId,reason};p.reject(new GameHostError(410,'game_host_expired','host_pending_cancel_'+reason,origin?.site,origin?.predicate,origin?.nativeSourceWitness));a.poll?.();
 }
 private fence(a:Attachment,reason:H.GameHostCancel['reason'],origin?:CancellationOrigin){
  const captured=origin?{site:origin.site,predicate:origin.predicate,...(origin.nativeSourceWitness?{nativeSourceWitness:origin.nativeSourceWitness}:{})}:undefined;
  if(a.closed)return;
  if(reason==='scopeChanged'&&captured&&this.attachments.get(a.id)===a){
   this.pruneRetired();while(this.retiredAttachments.size>=this.options.maxAttachments)this.retiredAttachments.delete(this.retiredAttachments.keys().next().value!);
   this.retiredAttachments.set(a.id,Object.freeze({principalId:a.actor.principalId,sessionId:a.actor.sessionId,wall:Date.now(),monotonic:performance.now(),origin:Object.freeze(captured)}));
  }
  a.closed=true;const dispose=this.admissionCleanup.get(a);if(dispose){try{dispose();}catch{}}else a.runtime?.close();this.cancel(a,reason,captured);a.controller.abort();const claim=this.claims.get(a);if(claim){try{this.dispatch.unresolved(claim.identity);}catch{}this.claims.delete(a);}if(this.attachments.get(a.id)===a)this.attachments.delete(a.id);a.poll?.();
 }
 private sweep(){for(const a of this.attachments.values()){const observed:ObservedCause={};if(!this.current(a,a.binding.scope,observed))this.fence(a,'scopeChanged',cancellationOrigin('legacy_sweep','current_'+observed.value,observed));}}
 close(){if(this.closed)return;this.closed=true;clearInterval(this.sweepTimer);for(const a of [...this.attachments.values(),...this.admissions.values()])this.fence(a,'shutdown');}
}
