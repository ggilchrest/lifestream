import {createContractValidator} from '@lifestream/contracts';
import {isDeepStrictEqual,types as nodeTypes} from 'node:util';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameActivityAdapter,GameCallContext} from './port.js';
type Request=G.GameObserveRequest|G.GameActionRequest|G.GameReleaseRequest|G.GameSaveRequest;
type Result=G.GameObserveResult|G.GameActionResult|G.GameReleaseResult|G.GameSaveResult;
const schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const validator=createContractValidator();
const definitions={observe:['GameObserveRequest','GameObserveResult'],applyController:['GameActionRequest','GameActionResult'],releaseControls:['GameReleaseRequest','GameReleaseResult'],controlSave:['GameSaveRequest','GameSaveResult']} as const;
export class GameAdapterBoundaryError extends Error{
 readonly code:'invalidRequest'|'invalidResponse'|'scopeChanged'|'cancelled'|'timedOut'|'unavailable'|'admissionRequired'|'concurrentEffect';
 readonly effectMayHaveStarted:boolean;
 constructor(code:GameAdapterBoundaryError['code'],effectMayHaveStarted=false){super('Game adapter '+code);this.code=code;this.effectMayHaveStarted=effectMayHaveStarted;}
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
 providerRef:string;maxDurationMs:number;
 /** True only for an independently qualified exact installation/display/pins.
  * Discovery, schema validity and a healthy socket are insufficient. */
 sourceAvailable:(scope:G.ActivityScope,pinsDigest:string)=>boolean;
 /** Reviewed per-revision visibility/decoder/media provenance, not a model assertion. */
 acceptObservation?:(request:G.GameObserveRequest,observation:G.GameObservation)=>boolean;
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
 const effects=new Map<string,{request:G.GameActionRequest|G.GameSaveRequest;phase:'pending'|'unresolved'}>();
 async function call(method:keyof typeof definitions,input:Request,context:GameCallContext):Promise<Result>{
  const request=message(input,definitions[method][0],true),deadline=Date.parse(request.deadlineAt),remaining=deadline-Date.now(),monotonicDeadline=performance.now()+remaining,controller=new AbortController();requireTrue(remaining>0&&remaining<=options.maxDurationMs,'invalidRequest');
  const signal=AbortSignal.any([context.signal,controller.signal]),bound=Object.freeze({signal,isCurrent:context.isCurrent}),effect=method!=='observe',run=request.scope.runId;let entered=false,locked=false,confirmedTerminal=false;
  const admissionExpires=method==='applyController'||method==='controlSave'?Date.parse((request as G.GameActionRequest|G.GameSaveRequest).payload.admission.expiresAt):Infinity;
  const check=()=>{if(Date.now()>=admissionExpires)throw new GameAdapterBoundaryError('admissionRequired',entered&&effect);if(Date.now()>=deadline||performance.now()>=monotonicDeadline)throw new GameAdapterBoundaryError('timedOut',entered&&effect);if(signal.aborted)throw new GameAdapterBoundaryError('cancelled',entered&&effect);let current=false;try{current=context.isCurrent(request.scope);}catch{}if(!current)throw new GameAdapterBoundaryError('scopeChanged',entered&&effect);};
  const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(remaining,admissionExpires-Date.now())));let abort=()=>{};
  const wait=async<T>(action:()=>Promise<T>):Promise<T>=>{check();try{return await Promise.race([Promise.resolve().then(()=>{check();return action();}),new Promise<never>((_,reject)=>{abort=()=>reject(new GameAdapterBoundaryError(Date.now()>=admissionExpires?'admissionRequired':Date.now()>=deadline||performance.now()>=monotonicDeadline?'timedOut':'cancelled',entered&&effect));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}};
  try{
   check();if(method==='applyController'||method==='controlSave'){const admission=(request as G.GameActionRequest|G.GameSaveRequest).payload.admission;requireTrue(Date.parse(admission.issuedAt)<=Date.now()&&Date.parse(admission.expiresAt)>Date.now(),'admissionRequired');}if(method==='applyController'){const action=request as G.GameActionRequest;requireTrue(isDeepStrictEqual(action.payload.proposal.scope,request.scope),'invalidRequest');requireTrue(action.payload.dispatchValidation.planningObservationId===action.payload.proposal.observationId&&action.payload.expectedFrameNumber===action.payload.dispatchValidation.checkedFrameNumber,'invalidRequest');requireTrue(Object.entries(action.payload.buttonVector).every(([button,pressed])=>pressed===action.payload.proposal.buttons.includes(button as G.GameActionProposal['buttons'][number])),'invalidRequest');requireTrue(action.payload.dispatchValidation.predicateChecks.length===action.payload.proposal.preconditions.length&&action.payload.proposal.preconditions.every(predicate=>action.payload.dispatchValidation.predicateChecks.some(checked=>checked.predicateId===predicate.predicateId&&checked.fieldId===predicate.fieldId&&checked.observedValue===predicate.expectedValue&&checked.matched)),'invalidRequest');requireTrue(Date.parse(action.payload.dispatchValidation.preparedContextFreshUntil)>Date.now(),'invalidRequest');requireTrue(action.payload.protectedMenuOperation!=='uncertain','admissionRequired');}
   if(method!=='releaseControls'){const digest=(request as Exclude<Request,G.GameReleaseRequest>).payload.expectedPinsDigest;requireTrue(options.sourceAvailable(request.scope,digest),'unavailable');check();}
   // Safety release can preempt an effect and must not wait for model/transport
   // completion. Exact lease fencing belongs to the trusted shutdown callback.
   if(method==='releaseControls'){requireTrue(options.admitRelease,'admissionRequired');requireTrue(await wait(()=>options.admitRelease!(request as G.GameReleaseRequest,bound)),'admissionRequired');}
   else if(effect){const previous=effects.get(run);if(previous){requireTrue(previous.phase==='unresolved'&&options.reconcileEffect,'concurrentEffect');previous.phase='pending';try{requireTrue(await wait(()=>options.reconcileEffect!(previous.request,bound)),'concurrentEffect');check();effects.delete(run);}catch(error){previous.phase='unresolved';throw error;}}requireTrue(effects.size<64,'concurrentEffect');effects.set(run,{request:request as G.GameActionRequest|G.GameSaveRequest,phase:'pending'});locked=true;requireTrue(options.claimEffect,'admissionRequired');requireTrue(await wait(()=>options.claimEffect!(request as G.GameActionRequest|G.GameSaveRequest,bound)),'admissionRequired');}
   check();if(method!=='releaseControls')requireTrue(options.sourceAvailable(request.scope,(request as Exclude<Request,G.GameReleaseRequest>).payload.expectedPinsDigest),'unavailable');check();
   const raw=await wait(()=>{check();entered=true;return (adapter[method] as (r:Request,c:GameCallContext)=>Promise<Result>).call(adapter,request,bound);});check();const result=message(raw,definitions[method][1]);requireTrue(result.operation===request.operation&&result.requestId===request.requestId&&result.correlationId===request.correlationId&&result.providerRef===options.providerRef&&Date.parse(result.completedAt)<=Date.now()&&Date.parse(result.completedAt)<=deadline);
   if(result.outcome.status==='succeeded'){
    if(method==='observe'){const observation=(result as G.GameObserveResult).outcome.payload!.observation;requireTrue(isDeepStrictEqual(observation.scope,request.scope)&&observation.pinsDigest===(request as G.GameObserveRequest).payload.expectedPinsDigest&&observation.screenshots.length<=(request as G.GameObserveRequest).payload.maxScreenshots);requireTrue(options.acceptObservation&&options.acceptObservation(request as G.GameObserveRequest,observation));check();}
    else if(method==='applyController'){const receipt=(result as G.GameActionResult).outcome.payload!,action=request as G.GameActionRequest;requireTrue(isDeepStrictEqual(receipt.scope,request.scope)&&receipt.actionId===action.payload.actionId&&receipt.proposalId===action.payload.proposal.proposalId&&receipt.idempotencyKey===action.idempotencyKey&&receipt.admissionId===action.payload.admission.admissionId&&receipt.inputDigest===action.payload.admission.inputDigest);if(receipt.framesApplied!==null)requireTrue(receipt.framesApplied<=action.payload.proposal.durationFrames&&receipt.afterFrame!==null&&receipt.beforeFrame!==null&&receipt.afterFrame>=receipt.beforeFrame&&receipt.afterFrame-receipt.beforeFrame===receipt.framesApplied&&receipt.beforeFrame===action.payload.expectedFrameNumber);if(receipt.disposition==='completed')requireTrue(receipt.framesApplied!==null&&receipt.startedAt!==null&&receipt.completedAt!==null&&receipt.buttonsNeutralized);}
    else if(method==='releaseControls'){const payload=(result as G.GameReleaseResult).outcome.payload!;requireTrue(payload.targetInputOwnerLeaseId===(request as G.GameReleaseRequest).payload.targetInputOwnerLeaseId);if(payload.disposition==='neutralizedAndPaused')requireTrue(payload.pauseFrameNumber===payload.verifiedFrameNumber&&payload.verifiedMonotonicMs!>payload.pauseConfirmedMonotonicMs!&&payload.activityEpochAfterFence!>request.scope.activityEpoch);}
    else{const payload=(result as G.GameSaveResult).outcome.payload!,save=request as G.GameSaveRequest;requireTrue(payload.action===save.payload.action&&payload.timelineId===request.scope.timelineId&&payload.saveArtifact.pinsDigest===save.payload.expectedPinsDigest);if(save.payload.action==='verifyOrdinarySave')requireTrue(isDeepStrictEqual(payload.saveArtifact.artifact,save.payload.saveArtifact!.artifact)&&payload.saveArtifact.sourceTimelineId===save.payload.saveArtifact!.sourceTimelineId&&payload.saveArtifact.sourceFrameNumber===save.payload.saveArtifact!.sourceFrameNumber&&payload.saveArtifact.createdAt===save.payload.saveArtifact!.createdAt);}
   }
   check();if(method!=='releaseControls')requireTrue(options.sourceAvailable(request.scope,(request as Exclude<Request,G.GameReleaseRequest>).payload.expectedPinsDigest),'unavailable');check();confirmedTerminal=method==='controlSave'&&result.outcome.status==='succeeded'||method==='applyController'&&result.outcome.status==='succeeded'&&['completed','cancelled','failed'].includes((result as G.GameActionResult).outcome.payload!.disposition)&&(result as G.GameActionResult).outcome.payload!.buttonsNeutralized||effect&&result.outcome.status==='rejected';return result;
  }catch(error){if(error instanceof GameAdapterBoundaryError)throw new GameAdapterBoundaryError(error.code,error.effectMayHaveStarted||entered&&effect);throw new GameAdapterBoundaryError(entered?'invalidResponse':'unavailable',entered&&effect);}
  finally{clearTimeout(timer);if(locked){if(!entered||confirmedTerminal)effects.delete(run);else effects.get(run)!.phase='unresolved';}controller.abort();}
 }
 return {observe:(r,c)=>call('observe',r,c) as Promise<G.GameObserveResult>,applyController:(r,c)=>call('applyController',r,c) as Promise<G.GameActionResult>,releaseControls:(r,c)=>call('releaseControls',r,c) as Promise<G.GameReleaseResult>,controlSave:(r,c)=>call('controlSave',r,c) as Promise<G.GameSaveResult>};
}
