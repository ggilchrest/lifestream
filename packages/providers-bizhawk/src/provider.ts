import {ordinaryEntryFrameMatches} from '@lifestream/contracts/game-host';
import {nativeSourceWitness,type NativeSourceWitness,type NativeSourceCapture} from './native-source-witness.ts';
import {createContractValidator} from '@lifestream/contracts';
import {isDeepStrictEqual,types as nodeTypes} from 'node:util';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameActivityAdapter,GameCallContext} from './port.js';
import {ordinarySaveResultMatches} from './native-saves.ts';
type Request=G.GameObserveRequest|G.GameActionRequest|G.GameReleaseRequest|G.GameSaveRequest;
type Result=G.GameObserveResult|G.GameActionResult|G.GameReleaseResult|G.GameSaveResult;
const schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const validator=createContractValidator();
const definitions={observe:['GameObserveRequest','GameObserveResult'],applyController:['GameActionRequest','GameActionResult'],releaseControls:['GameReleaseRequest','GameReleaseResult'],controlSave:['GameSaveRequest','GameSaveResult']} as const;
// Non-authorizing closed cause metadata only; no arbitrary error fields escape.
const adapterDiagnosticCauses=new Set(['host_invoke_execution_mode', 'host_invoke_pending_operation', 'host_invoke_cancel_pending', 'host_invoke_signal_aborted', 'host_invoke_caller_context', 'host_invoke_command_deadline', 'host_invoke_command_schema', 'host_invoke_current_port_closed', 'host_invoke_current_attachment_closed', 'host_invoke_current_runtime', 'host_invoke_current_wall_lease', 'host_invoke_current_monotonic_lease', 'host_invoke_current_idle_lease', 'host_invoke_current_scope', 'host_invoke_current_principal', 'host_invoke_current_session', 'host_invoke_current_actor', 'host_invoke_current_binding', 'host_invoke_current_native_source', 'host_pending_cancel_cancelled', 'host_pending_cancel_deadline', 'host_pending_cancel_scopeChanged', 'host_pending_cancel_detached', 'host_pending_cancel_shutdown', 'provider_result_envelope', 'provider_result_identity', 'provider_observation_scope_pins_images', 'provider_observation_acceptance']);
const cancellationSites=new Set(['attachment_current', 'poll_initial_attachment', 'preparation_gate_attachment', 'admit_attachment', 'complete_attachment', 'detach_attachment', 'sweep_preparation', 'sweep_current', 'sweep_post_preparation', 'sweep_refresh_failed', 'poll_initial_failed', 'poll_finish_failed', 'poll_finish_current', 'poll_finish_structure', 'poll_pending', 'admit_pre', 'admit_final', 'complete_final', 'legacy_poll_current', 'legacy_sweep']);
const cancellationPredicates=new Set(['current_port_closed', 'current_attachment_closed', 'current_runtime', 'current_wall_lease', 'current_monotonic_lease', 'current_idle_lease', 'current_scope', 'current_principal', 'current_session', 'current_actor', 'current_binding', 'current_native_source', 'structure_port_closed', 'structure_attachment_closed', 'structure_aborted', 'structure_map_identity', 'structure_wall_lease', 'structure_monotonic_lease', 'structure_idle_lease', 'pending_identity', 'command_wall_deadline', 'command_monotonic_deadline', 'pending_signal_aborted', 'pending_context', 'poll_identity', 'poll_signal_aborted', 'operation_failed', 'poll_settled', 'read_refresh_deadline']);
const adapterBoundaryCodes=new Set(['invalidRequest','invalidResponse','scopeChanged','cancelled','timedOut','unavailable','admissionRequired','concurrentEffect']);
const ownData=(value:object,key:string):unknown=>{const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
function capturedBoundaryError(error:unknown):{code:GameAdapterBoundaryError['code'];effect:boolean}|null{
 try{
  if(!error||typeof error!=='object'||nodeTypes.isProxy(error))return null;
  let proto=Object.getPrototypeOf(error),boundary=false,depth=0;
  while(proto&&depth++<128){if(nodeTypes.isProxy(proto))return null;if(proto===GameAdapterBoundaryError.prototype){boundary=true;break;}proto=Object.getPrototypeOf(proto);}
  const code=ownData(error,'code'),effect=ownData(error,'effectMayHaveStarted');
  return boundary&&typeof code==='string'&&adapterBoundaryCodes.has(code)&&typeof effect==='boolean'?{code:code as GameAdapterBoundaryError['code'],effect}:null;
 }catch{return null;}
}
function capturedDiagnosticCause(error:unknown):string|undefined{
 try{
  if(!error||typeof error!=='object'||nodeTypes.isProxy(error))return;
  const proto=Object.getPrototypeOf(error);if(!proto||nodeTypes.isProxy(proto))return;
  const type=ownData(proto,'constructor');if(typeof type!=='function'||nodeTypes.isProxy(type))return;
  const name=ownData(type,'name'),cause=ownData(error,'diagnosticCause');
  if(typeof cause!=='string'||!adapterDiagnosticCauses.has(cause))return;
  if(name==='GameAdapterBoundaryError'&&ownData(error,'code')==='invalidResponse')return cause;
  if(name!=='GameHostError')return;
  const code=ownData(error,'code'),status=ownData(error,'status');
  if(cause==='host_invoke_command_deadline'||cause.startsWith('host_pending_cancel_'))return code==='game_host_expired'&&status===410?cause:undefined;
  if(cause==='host_invoke_command_schema')return code==='invalid_game_host_message'&&status===400?cause:undefined;
  return cause.startsWith('host_invoke_')&&code==='game_host_conflict'&&status===409?cause:undefined;
 }catch{return;}
}
function capturedCancellation(error:unknown,cause:string|undefined):{site:string;predicate:string;nativeSourceWitness?:NativeSourceWitness}|undefined{
 try{if(cause!=='host_pending_cancel_scopeChanged'||!error||typeof error!=='object'||nodeTypes.isProxy(error))return;const site=ownData(error,'cancellationSite'),predicate=ownData(error,'cancellationPredicate');if(typeof site==='string'&&cancellationSites.has(site)&&typeof predicate==='string'&&cancellationPredicates.has(predicate)){const witness=predicate==='current_native_source'?nativeSourceWitness(ownData(error,'nativeSourceWitness')):undefined;return {site,predicate,...(witness?{nativeSourceWitness:witness}:{})};}}catch{}return;
}
export class GameAdapterBoundaryError extends Error{
 readonly code:'invalidRequest'|'invalidResponse'|'scopeChanged'|'cancelled'|'timedOut'|'unavailable'|'admissionRequired'|'concurrentEffect';
 readonly effectMayHaveStarted:boolean;
 declare readonly diagnosticCause?:string;
 declare readonly cancellationSite?:string;declare readonly cancellationPredicate?:string;declare readonly nativeSourceWitness?:NativeSourceWitness;
 constructor(code:GameAdapterBoundaryError['code'],effectMayHaveStarted=false,diagnosticCause?:string,cancellationSite?:string,cancellationPredicate?:string,witness?:NativeSourceWitness){super('Game adapter '+code);this.code=code;this.effectMayHaveStarted=effectMayHaveStarted;if(code==='invalidResponse'&&typeof diagnosticCause==='string'&&adapterDiagnosticCauses.has(diagnosticCause))Object.defineProperty(this,'diagnosticCause',{value:diagnosticCause,enumerable:true});if(code==='invalidResponse'&&diagnosticCause==='host_pending_cancel_scopeChanged'&&typeof cancellationSite==='string'&&cancellationSites.has(cancellationSite)&&typeof cancellationPredicate==='string'&&cancellationPredicates.has(cancellationPredicate))Object.defineProperties(this,{cancellationSite:{value:cancellationSite,enumerable:true},cancellationPredicate:{value:cancellationPredicate,enumerable:true}});const closed=code==='invalidResponse'&&diagnosticCause==='host_pending_cancel_scopeChanged'&&typeof cancellationSite==='string'&&cancellationSites.has(cancellationSite)&&cancellationPredicate==='current_native_source'?nativeSourceWitness(witness):undefined;if(closed)Object.defineProperty(this,'nativeSourceWitness',{value:closed,enumerable:true});}
}
function requireTrue(value:unknown,code:GameAdapterBoundaryError['code']='invalidResponse'):asserts value{if(!value)throw new GameAdapterBoundaryError(code);}
function immutable<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;}
function message<T>(input:T,definition:string,request=false):T{
 const code=request?'invalidRequest':'invalidResponse';let nodes=0,bytes=0;const seen=new Set<unknown>();
 const plain=(value:unknown,depth=0):boolean=>{if(++nodes>8192||depth>32)return false;if(typeof value==='string'){if(value.length>131072)return false;bytes+=Buffer.byteLength(value)+2;return bytes<=131072;}if(value===null||typeof value==='boolean')return true;if(typeof value==='number')return Number.isFinite(value);if(typeof value!=='object'||nodeTypes.isProxy(value)||seen.has(value))return false;seen.add(value);const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);if(prototype!==(array?Array.prototype:Object.prototype))return false;const keys=Reflect.ownKeys(value);if(keys.length>8192)return false;if(array&&keys.length!==(value as unknown[]).length+1)return false;const valid=keys.every(key=>{if(typeof key!=='string')return false;bytes+=Buffer.byteLength(key)+4;if(bytes>131072)return false;const descriptor=Object.getOwnPropertyDescriptor(value,key)!;if(array&&key==='length')return true;return descriptor.enumerable===true&&Object.hasOwn(descriptor,'value')&&plain(descriptor.value,depth+1);});seen.delete(value);return valid;};
 let text:string;try{requireTrue(plain(input),code);text=JSON.stringify(input);}catch{throw new GameAdapterBoundaryError(code);}
 requireTrue(typeof text==='string'&&Buffer.byteLength(text)<=131072,code);
 // Only lossless plain JSON: getters, prototypes, cycles and nonfinite values
 // cannot become a shape-valid dispatch after serialization.
 const value:unknown=JSON.parse(text);requireTrue(isDeepStrictEqual(input,value),code);requireTrue(validator.validate(schema+definition,value).valid,code);return immutable(value as T);
}
export interface GameAdapterBoundaryOptions{
 ordinaryGameTime?:true;providerRef:string;maxDurationMs:number;
 /** True only for an independently qualified exact installation/display/pins.
  * Discovery, schema validity and a healthy socket are insufficient. */
 sourceAvailable:(scope:G.ActivityScope,pinsDigest:string,capture?:NativeSourceCapture)=>boolean;
 /** Reviewed per-revision visibility/decoder/media provenance, not a model assertion. */
 acceptObservation?:(request:G.GameObserveRequest,observation:G.GameObservation)=>boolean;
 /** Optional final entry hook for an authenticated remote host. When supplied,
  * it must admit this exact observation immediately before native I/O. It does
  * not replace source or observation provenance qualification. */
 admitObservation?:(request:G.GameObserveRequest,context:GameCallContext)=>Promise<boolean>;
 /** Resolve actual native result/input-lease/neutralization evidence for this
  * exact action, including rejected outcomes. Required before entry; captured
  * once and strict true after receipt. Never supplies capability authority. */
 acceptAction?:(request:G.GameActionRequest,result:G.GameActionResult)=>boolean;
 /** Resolve actual qualified ordinary-save flush/readback evidence for this
  * exact request/result. A shaped success or opaque reference is insufficient.
  * Required before entry, and strict true after receipt; never authorizes load. */
 acceptSave?:(request:G.GameSaveRequest,result:G.GameSaveResult)=>boolean;
 /** Must resolve current authenticated dispatch evidence AND durably claim the
  * exact idempotency identity before I/O. No default/in-memory grant is made. */
 claimEffect?:(request:G.GameActionRequest|G.GameSaveRequest,context:GameCallContext)=>Promise<boolean>;
 /** Resolve a potentially executed original operation from durable adapter
  * evidence/safety state; never redispatch it or treat a retry as resolution. */
 reconcileEffect?:(original:G.GameActionRequest|G.GameSaveRequest,context:GameCallContext)=>Promise<boolean>;
 /** Trusted shutdown intent for the exact old lease, independent of gameplay
  * authority. It cannot authorize gameplay or touch a successor lease. */
 admitRelease?:(request:G.GameReleaseRequest,context:GameCallContext)=>Promise<boolean>;
}
/** Closed adapter envelope boundary. Transport/Lua, durable admission ledger,
 * installed artifact/field decoder and OS qualification remain separate owners. */
export function guardGameActivityAdapter(adapter:GameActivityAdapter,options:GameAdapterBoundaryOptions):GameActivityAdapter{
 requireTrue(typeof options.providerRef==='string'&&options.providerRef.length>0&&options.providerRef.length<=500&&Number.isSafeInteger(options.maxDurationMs)&&options.maxDurationMs>0&&options.maxDurationMs<=120000,'unavailable');
 const acceptAction=options.acceptAction;
 const effects=new Map<string,{request:G.GameActionRequest|G.GameSaveRequest;phase:'pending'|'unresolved'}>();
 async function call(method:keyof typeof definitions,input:Request,context:GameCallContext):Promise<Result>{
  const request=message(input,definitions[method][0],true),deadline=Date.parse(request.deadlineAt),remaining=deadline-Date.now(),monotonicDeadline=performance.now()+remaining,controller=new AbortController();requireTrue(remaining>0&&remaining<=options.maxDurationMs,'invalidRequest');
  const signal=AbortSignal.any([context.signal,controller.signal]),bound=Object.freeze({signal,isCurrent:context.isCurrent}),effect=method!=='observe',run=request.scope.runId;let entered=false,locked=false,confirmedTerminal=false,validationCause:string|undefined;
  const admissionExpires=method==='applyController'||method==='controlSave'?Date.parse((request as G.GameActionRequest|G.GameSaveRequest).payload.admission.expiresAt):Infinity;
  let timerFailure:'admissionRequired'|'timedOut'|null=null,phase='entry-current',firstPredicate='requirement_failed';
  const denied=(code:GameAdapterBoundaryError['code'],predicate:string):never=>{firstPredicate=predicate;throw new GameAdapterBoundaryError(code,entered&&effect);};
  const check=()=>{if(timerFailure)denied(timerFailure,'timer_expired');if(Date.now()>=admissionExpires)denied('admissionRequired','admission_expired');if(Date.now()>=deadline||performance.now()>=monotonicDeadline)denied('timedOut','request_expired');if(signal.aborted)denied('cancelled','signal_aborted');let current=false;try{current=context.isCurrent(request.scope);}catch{}if(!current)denied('scopeChanged','caller_current');};
  const timerCode=admissionExpires<=deadline?'admissionRequired':'timedOut';
  const timer=setTimeout(()=>{timerFailure=timerCode;controller.abort();},Math.max(1,Math.min(remaining,admissionExpires-Date.now())));let abort=()=>{};
  const wait=async<T>(action:()=>Promise<T>):Promise<T>=>{check();try{return await Promise.race([Promise.resolve().then(()=>{check();return action();}),new Promise<never>((_,reject)=>{abort=()=>reject(new GameAdapterBoundaryError(timerFailure??(Date.now()>=admissionExpires?'admissionRequired':Date.now()>=deadline||performance.now()>=monotonicDeadline?'timedOut':'cancelled'),entered&&effect));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}};
  try{
   check();phase='request-validation';if(method==='applyController'||method==='controlSave'){const admission=(request as G.GameActionRequest|G.GameSaveRequest).payload.admission;requireTrue(Date.parse(admission.issuedAt)<=Date.now()&&Date.parse(admission.expiresAt)>Date.now(),'admissionRequired');}if(method==='applyController'){const action=request as G.GameActionRequest;requireTrue(isDeepStrictEqual(action.payload.proposal.scope,request.scope),'invalidRequest');requireTrue(action.payload.dispatchValidation.planningObservationId===action.payload.proposal.observationId&&action.payload.expectedFrameNumber===action.payload.dispatchValidation.checkedFrameNumber,'invalidRequest');requireTrue(Object.entries(action.payload.buttonVector).every(([button,pressed])=>pressed===action.payload.proposal.buttons.includes(button as G.GameActionProposal['buttons'][number])),'invalidRequest');requireTrue(action.payload.dispatchValidation.predicateChecks.length===action.payload.proposal.preconditions.length&&action.payload.proposal.preconditions.every(predicate=>action.payload.dispatchValidation.predicateChecks.some(checked=>checked.predicateId===predicate.predicateId&&checked.fieldId===predicate.fieldId&&checked.observedValue===predicate.expectedValue&&checked.matched)),'invalidRequest');requireTrue(Date.parse(action.payload.dispatchValidation.preparedContextFreshUntil)>Date.now(),'invalidRequest');requireTrue(action.payload.protectedMenuOperation!=='uncertain','admissionRequired');}
   // Awaiting already-resolved admission work only drains microtasks. Let
   // inspection I/O finish before the next source/claim burst. Safety release
   // stays immediate; no source or authority result crosses this handoff.
   if(method!=='releaseControls')await new Promise<void>(resolve=>setImmediate(()=>setImmediate(resolve)));
   phase='source-current';if(method!=='releaseControls'){const digest=(request as Exclude<Request,G.GameReleaseRequest>).payload.expectedPinsDigest;requireTrue(options.sourceAvailable(request.scope,digest),'unavailable');check();}
   // Safety release can preempt an effect and must not wait for model/transport
   // completion. Exact lease fencing belongs to the trusted shutdown callback.
   if(method==='releaseControls'){requireTrue(options.admitRelease,'admissionRequired');requireTrue(await wait(()=>options.admitRelease!(request as G.GameReleaseRequest,bound)),'admissionRequired');}
   else if(method==='observe'&&options.admitObservation!==undefined){requireTrue(typeof options.admitObservation==='function','admissionRequired');requireTrue(await wait(()=>options.admitObservation!(request as G.GameObserveRequest,bound)),'admissionRequired');}
   else if(effect){phase='effect-claim';const previous=effects.get(run);if(previous){requireTrue(previous.phase==='unresolved'&&options.reconcileEffect,'concurrentEffect');previous.phase='pending';try{requireTrue(await wait(()=>options.reconcileEffect!(previous.request,bound)),'concurrentEffect');check();effects.delete(run);}catch(error){previous.phase='unresolved';throw error;}}requireTrue(effects.size<64,'concurrentEffect');effects.set(run,{request:request as G.GameActionRequest|G.GameSaveRequest,phase:'pending'});locked=true;requireTrue(options.claimEffect,'admissionRequired');if(method==='applyController')requireTrue(typeof acceptAction==='function','unavailable');if(method==='controlSave')requireTrue(typeof options.acceptSave==='function','unavailable');requireTrue(await wait(()=>options.claimEffect!(request as G.GameActionRequest|G.GameSaveRequest,bound)),'admissionRequired');}
   if(method!=='releaseControls')await new Promise<void>(resolve=>setImmediate(()=>setImmediate(resolve)));
   phase='pre-adapter-current';check();if(method!=='releaseControls')requireTrue(options.sourceAvailable(request.scope,(request as Exclude<Request,G.GameReleaseRequest>).payload.expectedPinsDigest),'unavailable');check();
   const raw=await wait(()=>{check();entered=true;phase='raw-adapter';return (adapter[method] as (r:Request,c:GameCallContext)=>Promise<Result>).call(adapter,request,bound);});phase='result-validation';check();validationCause='provider_result_envelope';const result=message(raw,definitions[method][1]);validationCause='provider_result_identity';requireTrue(result.operation===request.operation&&result.requestId===request.requestId&&result.correlationId===request.correlationId&&result.providerRef===options.providerRef&&Date.parse(result.completedAt)<=Date.now()&&Date.parse(result.completedAt)<=deadline);validationCause=undefined;
   if(result.outcome.status==='succeeded'){
    if(method==='observe'){const observation=(result as G.GameObserveResult).outcome.payload!.observation;validationCause='provider_observation_scope_pins_images';requireTrue(isDeepStrictEqual(observation.scope,request.scope)&&observation.pinsDigest===(request as G.GameObserveRequest).payload.expectedPinsDigest&&observation.screenshots.length<=(request as G.GameObserveRequest).payload.maxScreenshots);validationCause='provider_observation_acceptance';requireTrue(options.acceptObservation&&options.acceptObservation(request as G.GameObserveRequest,observation));validationCause=undefined;check();}
    else if(method==='applyController'){const receipt=(result as G.GameActionResult).outcome.payload!,action=request as G.GameActionRequest;requireTrue(isDeepStrictEqual(receipt.scope,request.scope)&&receipt.actionId===action.payload.actionId&&receipt.proposalId===action.payload.proposal.proposalId&&receipt.idempotencyKey===action.idempotencyKey&&receipt.admissionId===action.payload.admission.admissionId&&receipt.inputDigest===action.payload.admission.inputDigest);if(receipt.framesApplied!==null)requireTrue(receipt.framesApplied<=action.payload.proposal.durationFrames&&receipt.afterFrame!==null&&receipt.beforeFrame!==null&&receipt.afterFrame>=receipt.beforeFrame&&receipt.afterFrame-receipt.beforeFrame===receipt.framesApplied&&ordinaryEntryFrameMatches(action,receipt.beforeFrame,options.ordinaryGameTime===true));const recorded=Date.parse(receipt.recordedAt),completed=receipt.completedAt===null?null:Date.parse(receipt.completedAt),started=receipt.startedAt===null?null:Date.parse(receipt.startedAt),resultAt=Date.parse(result.completedAt);requireTrue(recorded<=resultAt);if(started!==null)requireTrue(started>=Date.parse(action.payload.admission.issuedAt)&&started<Date.parse(action.payload.admission.expiresAt)&&started<deadline&&started<=recorded);if(completed!==null)requireTrue(started!==null&&completed>=started&&completed<=recorded);if(['completed','cancelled','failed'].includes(receipt.disposition)&&receipt.buttonsNeutralized)requireTrue(receipt.framesApplied!==null&&started!==null&&completed!==null);if(receipt.disposition==='completed')requireTrue(receipt.buttonsNeutralized);}
    else if(method==='releaseControls'){const payload=(result as G.GameReleaseResult).outcome.payload!;requireTrue(payload.targetInputOwnerLeaseId===(request as G.GameReleaseRequest).payload.targetInputOwnerLeaseId);if(payload.disposition==='neutralizedAndPaused')requireTrue(payload.pauseFrameNumber===payload.verifiedFrameNumber&&payload.verifiedMonotonicMs!>payload.pauseConfirmedMonotonicMs!&&payload.activityEpochAfterFence!>request.scope.activityEpoch);}
    else{requireTrue(ordinarySaveResultMatches(request,result,Date.now()));requireTrue(options.acceptSave!(request as G.GameSaveRequest,result as G.GameSaveResult)===true);check();}
   }
   if(method==='applyController'){requireTrue(acceptAction!(request as G.GameActionRequest,result as G.GameActionResult)===true);check();}
   check();if(method!=='releaseControls')requireTrue(options.sourceAvailable(request.scope,(request as Exclude<Request,G.GameReleaseRequest>).payload.expectedPinsDigest),'unavailable');check();confirmedTerminal=method==='controlSave'&&result.outcome.status==='succeeded'||method==='applyController'&&result.outcome.status==='succeeded'&&['completed','cancelled','failed'].includes((result as G.GameActionResult).outcome.payload!.disposition)&&(result as G.GameActionResult).outcome.payload!.buttonsNeutralized||effect&&result.outcome.status==='rejected';return result;
  }catch(error){const boundary=capturedBoundaryError(error),cause=capturedDiagnosticCause(error),cancellation=capturedCancellation(error,cause);if(method==='applyController'&&process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')try{console.info(JSON.stringify({event:'game-adapter-first-refusal',runId:request.scope.runId,actionId:(request as G.GameActionRequest).payload.actionId,phase,predicate:firstPredicate,code:boundary?.code??(entered?'invalidResponse':'unavailable'),observedAtMs:Date.now(),requestExpiresAtMs:deadline,admissionExpiresAtMs:admissionExpires,effectMayHaveStarted:entered}));}catch{}if(boundary)throw new GameAdapterBoundaryError(boundary.code,boundary.effect||entered&&effect,boundary.code==='invalidResponse'?(cause??validationCause):undefined,cancellation?.site,cancellation?.predicate,cancellation?.nativeSourceWitness);throw new GameAdapterBoundaryError(entered?'invalidResponse':'unavailable',entered&&effect,entered?(cause??validationCause):undefined,cancellation?.site,cancellation?.predicate,cancellation?.nativeSourceWitness);}
  finally{clearTimeout(timer);if(locked){if(!entered||confirmedTerminal)effects.delete(run);else effects.get(run)!.phase='unresolved';}controller.abort();}
 }
 return {observe:(r,c)=>call('observe',r,c) as Promise<G.GameObserveResult>,applyController:(r,c)=>call('applyController',r,c) as Promise<G.GameActionResult>,releaseControls:(r,c)=>call('releaseControls',r,c) as Promise<G.GameReleaseResult>,controlSave:(r,c)=>call('controlSave',r,c) as Promise<G.GameSaveResult>};
}
