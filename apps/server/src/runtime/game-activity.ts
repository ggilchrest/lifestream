import {GameAdapterBoundaryError} from '@lifestream/providers-bizhawk';
import {createContractValidator} from '@lifestream/contracts';
import type {PreparedTurnBinding} from '@lifestream/runtime/inference/prompt';
import {gameWindowCurrent,manualGameStartCurrent,type GameWindowSelection,type ManualGameStartSelection} from '@lifestream/runtime/activity/policy';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameStartRepository} from '@lifestream/storage-sqlite';
import type {ActivityCheckpointRepository,PlanningReservation,ControllerUsage} from '@lifestream/storage-sqlite';
import {runGamePlanningTurn,type GamePlanningResult} from '@lifestream/runtime/activity/coordinator';
import {gameCampaignCheckpointCurrent,gameControllerContextCurrent,type GameDispatchSelection,type PreparedGameCampaignContext} from '@lifestream/runtime/activity/game-journal';
import type {DiscoveryAdministration} from '../admin/understanding.ts';
import {isDeepStrictEqual} from 'node:util';
/** First-party temporal-to-durable metadata join. Host admission remains an
 * independent required predicate; no timer/enrollment/start/dispatch is created. */
export function claimConfiguredGameStart(repository:GameStartRepository,raw:{scope:G.ActivityScope;policy:G.GamePolicy;bounds:G.GameBounds},window:GameWindowSelection):boolean {
 const input=boundedGameDataSnapshot(raw) as typeof raw|null;if(!input||Object.keys(input).sort().join(',')!=='bounds,policy,scope'||!gameWindowCurrent(window,input.scope,{policy:input.policy,bounds:input.bounds})||window.purpose!=='play'||window.status!=='inside'||window.policyRevision!==input.policy.revision||!window.windowId||!window.localDate||!window.occurrenceKey)return false;
 return repository.claim({...input,windowId:window.windowId,localDate:window.localDate,occurrenceKey:window.occurrenceKey},()=>gameWindowCurrent(window,input.scope,{policy:input.policy,bounds:input.bounds}));
}
/** An original explicit foreground selection, with exact run/context and finite
 * expiry, enters the same durable claim/slot owner as configured starts. */
export function claimManualGameStart(repository:GameStartRepository,raw:{scope:G.ActivityScope;policy:G.GamePolicy;bounds:G.GameBounds},selection:ManualGameStartSelection):boolean{
 const input=boundedGameDataSnapshot(raw) as typeof raw|null;
 if(!input||Object.keys(input).sort().join(',')!=='bounds,policy,scope'||!manualGameStartCurrent(selection,input.scope,{policy:input.policy,bounds:input.bounds})||selection.status!=='selected'||selection.expiresAtMs===null)return false;
 return repository.claimManual({...input,expiresAtMs:selection.expiresAtMs},()=>manualGameStartCurrent(selection,input.scope,{policy:input.policy,bounds:input.bounds}));
}
export type CheckpointedGamePlanningPorts={
 /** The existing runtime instance, shared with foreground and other P2 work. */
 background:Pick<DiscoveryAdministration,'runBackground'>;
 inferenceMode?:'backgroundP2'|'supervisedForeground';
 foreground?:Pick<DiscoveryAdministration,'runSupervisedForeground'>;
 sharingConsentCurrent?:()=>boolean;
 repository:ActivityCheckpointRepository;
 /** Actual current authorized running lifecycle/lease/window/source and budgets;
  * restored checkpoint metadata alone never supplies this predicate. */
 current:(scope:G.ActivityScope,checkpoint:Readonly<G.ActivityCheckpoint>)=>boolean;
 /** Independently qualified provider terminal evidence, not a model assertion. */
 terminalRef:(result:GamePlanningResult)=>string|null;
 /** Persist/CAS the current inert decision only. No controller dispatch here. */
 publishDecision:(result:GamePlanningResult)=>boolean;
 providerRevision:string;tokenizerIdentity:string;
 providerPreemptionBoundMs?:number;providerSlotReleaseBoundMs?:number;now?:()=>number;
};
/** One decision uses the existing prepared view, P2 coordinator and persistent
 * once-only ledger. No new coordinator/history, schedule, game effect or replay. */
export async function runCheckpointedGamePlanning(input:Parameters<typeof runGamePlanningTurn>[0]&{scope:G.ActivityScope},ports:CheckpointedGamePlanningPorts){
 const {game,binding,turn,provider}=input,repository=ports.repository,background=ports.background;
 const scope=boundedGameDataSnapshot(input.scope) as G.ActivityScope|null,mode=ports.inferenceMode??'backgroundP2',foreground=ports.foreground,sharingConsentCurrent=ports.sharingConsentCurrent;
 const suppressed=()=>({state:'suppressed' as const,reason:'currentGameRunUnavailable',completedSteps:0});
 if(!scope||!['backgroundP2','supervisedForeground'].includes(mode)||mode==='supervisedForeground'&&(!foreground||typeof foreground.runSupervisedForeground!=='function'||typeof sharingConsentCurrent!=='function'))return suppressed();freeze(scope);
 const owner={assistantId:scope.assistantId,principalId:scope.principalId,relationshipId:scope.relationshipId},providerRevision=ports.providerRevision,tokenizerIdentity=ports.tokenizerIdentity,preemption=ports.providerPreemptionBoundMs,release=ports.providerSlotReleaseBoundMs;
 const diagnostics=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1'&&typeof scope.runId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(scope.runId);let currentnessReported=false;
 const trace=(phase:string)=>{if(diagnostics)try{console.info(JSON.stringify({event:'game-planning-publication-stage',runId:scope.runId,phase,observedAtMs:Date.now()}));}catch{}};
 const refuse=(predicate:string)=>{if(diagnostics&&!currentnessReported){currentnessReported=true;try{console.info(JSON.stringify({event:'game-checkpoint-currentness-refusal',runId:scope.runId,predicate,observedAtMs:Date.now()}));}catch{}}return false;};
 // Keep every original short-circuit comparison and callback in its order.
 const current=()=>{let stage='repository_identity';try{
  if(ports.repository!==repository)return refuse(stage);stage='coordinator_identity';if(ports.background!==background)return refuse(stage);
  stage='mode_identity';if((ports.inferenceMode??'backgroundP2')!==mode)return refuse(stage);stage='foreground_identity';if(ports.foreground!==foreground)return refuse(stage);
  stage='sharing_identity';if(ports.sharingConsentCurrent!==sharingConsentCurrent)return refuse(stage);stage='sharing_consent';if(mode==='supervisedForeground'&&sharingConsentCurrent?.()!==true)return refuse(stage);
  stage='provider_revision';if(ports.providerRevision!==providerRevision)return refuse(stage);stage='tokenizer_identity';if(ports.tokenizerIdentity!==tokenizerIdentity)return refuse(stage);
  stage='preemption_bound';if(ports.providerPreemptionBoundMs!==preemption)return refuse(stage);stage='release_bound';if(ports.providerSlotReleaseBoundMs!==release)return refuse(stage);
  stage='checkpoint_read';const record=repository.get(owner,scope.runId);if(!record)return refuse(stage);
  stage='checkpoint_scope';if(!isDeepStrictEqual(record.checkpoint.scope,scope))return refuse(stage);
  stage='checkpoint_source';if(!gameCampaignCheckpointCurrent(game,binding,record.checkpoint))return refuse(stage);
  stage='owner_current';return ports.current(scope,freeze(record.checkpoint))===true||refuse(stage);
 }catch{return refuse(stage+'_threw');}};
 // The full original currentness graph can follow synchronous observation and
 // prepared-view validation. Let pending native inspection/cancellation I/O
 // finish before starting this new validation phase; retain no authority result.
 // The original finalized turn's deadline was fixed by preparePlanning and is
 // revalidated by runGamePlanningTurn after this yield, never renewed here.
 await new Promise<void>(resolve=>setImmediate(resolve));
 if(!current())return suppressed();
 let reservation:PlanningReservation|undefined;
 return runGamePlanningTurn({...input,game,binding,turn,provider},{run:work=>mode==='supervisedForeground'?foreground!.runSupervisedForeground({key:work.key,deadlineAt:work.deadlineAt,current:work.current,admitOnce:work.admitOnce,steps:work.steps,publish:work.publish,sharingConsentCurrent:()=>current()&&sharingConsentCurrent!()}):background.runBackground(work),current,providerRevision,tokenizerIdentity,...(preemption===undefined?{}:{providerPreemptionBoundMs:preemption}),...(release===undefined?{}:{providerSlotReleaseBoundMs:release}),...(ports.now?{now:ports.now}:{}),admitOnce:(binding,bounds,revision)=>{
  if(!current())return false;
  const candidate={viewId:binding.viewId,viewRevision:binding.revision,invalidationKey:binding.invalidationKey,providerRevision:revision,maximumInputTokens:bounds.maximumInputTokens,maximumOutputTokens:bounds.maximumOutputTokens};
  try{if(!repository.reservePlanning(owner,scope,candidate))return false;}catch(error){if(diagnostics&&error instanceof Error&&'code' in error&&error.code==='capacity'&&error.message==='Activity metadata capacity')try{console.info(JSON.stringify({event:'game-planning-reservation-refused',runId:scope.runId,predicate:'metadata_capacity',observedAtMs:Date.now()}));}catch{}throw error;}reservation=Object.freeze(candidate);return current();
 },publish:result=>{
  trace('entered');try{if(!reservation||!current()||!isDeepStrictEqual(result.decisionInput.scope,scope))return false;trace('current');const completionRef=ports.terminalRef(result);if(typeof completionRef!=='string'||!completionRef.trim()||!current())return false;
   if(!repository.settlePlanning(owner,scope,reservation,{inputTokens:result.inputTokens,outputTokens:result.outputTokens,providerRevision,completionRef})||!current())return false;
   trace('usage-settled');const published=ports.publishDecision(result)===true;trace(published?'decision-published':'decision-refused');const retained=published&&current();trace(retained?'complete':'currency-lost');return retained;
  }catch{return false;}
 }});
}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}

export type CheckpointedGameControllerPorts={
 repository:ActivityCheckpointRepository;
 /** Already guarded adapter with actual source/admission/native qualification.
  * No default transport, capability resolver or effect grant is supplied here. */
 adapter:{applyController:(request:G.GameActionRequest,context:{signal:AbortSignal;isCurrent:(scope:G.ActivityScope)=>boolean})=>Promise<G.GameActionResult>};
 signal:AbortSignal;
 current:(checkpoint:Readonly<G.ActivityCheckpoint>,request:Readonly<G.GameActionRequest>)=>boolean;
 /** Independently qualified actual monotonic terminal usage. Returning data
  * is insufficient: the existing repository requalifies it transactionally. */
 usageFor:(request:Readonly<G.GameActionRequest>,result:Readonly<G.GameActionResult>)=>ControllerUsage|null;
};
const controllerValidator=createContractValidator(),gameSchema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const consumedDispatchSelections=new WeakSet<GameDispatchSelection>(),inFlightDispatchSelections=new WeakSet<GameDispatchSelection>();
/** One explicit source-host join, no timer, new coordinator, generic grant,
 * replay or automatic continuation. Budget reservation never authorizes I/O. */
export async function runCheckpointedGameController(input:{game:PreparedGameCampaignContext;binding:PreparedTurnBinding;decision:G.GameDecisionInput;dispatch:GameDispatchSelection;request:G.GameActionRequest},ports:CheckpointedGameControllerPorts){
 const report=(state:'suppressed'|'settled'|'requiresReconciliation',reservationHeld:boolean,adapterInvoked:boolean,result:G.GameActionResult|null=null)=>Object.freeze({state,reservationHeld,adapterInvoked,result,playAuthority:false as const,resumeAuthority:false as const});
 const request=boundedGameDataSnapshot(input.request,131072) as G.GameActionRequest|null;
 if(!request||!controllerValidator.validate(gameSchema+'GameActionRequest',request).valid)return report('suppressed',false,false);freeze(request);
 let phase='input-validation',firstRefusal=false;
 const refusal=(predicate:string,error?:unknown)=>{if(firstRefusal||process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS!=='1')return;firstRefusal=true;try{const rawCode=error instanceof GameAdapterBoundaryError?Object.getOwnPropertyDescriptor(error,'code')?.value:undefined,code=typeof rawCode==='string'&&['invalidRequest','invalidResponse','scopeChanged','cancelled','timedOut','unavailable','admissionRequired','concurrentEffect'].includes(rawCode)?rawCode:'operation_threw';console.info(JSON.stringify({event:'game-controller-first-refusal',runId:request.scope.runId,actionId:request.payload.actionId,phase,predicate,code,observedAtMs:Date.now(),requestExpiresAtMs:Date.parse(request.deadlineAt),admissionExpiresAtMs:Date.parse(request.payload.admission.expiresAt)}));}catch{}};

 const {game,binding,decision,dispatch}=input,repository=ports.repository,adapter=ports.adapter,apply=adapter?.applyController,signal=ports.signal,qualify=ports.current,usageFor=ports.usageFor;
 const owner={assistantId:request.scope.assistantId,principalId:request.scope.principalId,relationshipId:request.scope.relationshipId};
 const pinned=()=>ports.repository===repository&&ports.adapter===adapter&&adapter.applyController===apply&&ports.signal===signal&&ports.current===qualify&&ports.usageFor===usageFor;
 let checking=false,retired=false;
 const current=()=>{if(retired||checking){retired=true;return false;}checking=true;try{
  if(!pinned()||signal.aborted){refusal('port_or_signal_current');retired=true;return false;}
  const eligible=gameControllerContextCurrent(dispatch,game,binding,decision,request.payload.proposal,request.payload.dispatchValidation,()=>{try{
   const row=repository.get(owner,request.scope.runId);
   if(!row||!isDeepStrictEqual(row.checkpoint.scope,request.scope)||qualify(freeze(row.checkpoint),request)!==true||retired||!pinned()||signal.aborted){refusal('checkpoint_or_caller_current');return null;}
   return row.checkpoint;
  }catch(error){refusal('qualification_threw',error);throw error;}});
  if(!eligible||retired||!pinned()||signal.aborted){refusal('prepared_after_caller');retired=true;return false;}return true;
 }catch(error){refusal('qualification_threw',error);retired=true;return false;}finally{checking=false;}};

 if(typeof apply!=='function'||typeof qualify!=='function'||typeof usageFor!=='function'||!dispatch||typeof dispatch!=='object'||consumedDispatchSelections.has(dispatch)||inFlightDispatchSelections.has(dispatch))return report('suppressed',false,false);
 inFlightDispatchSelections.add(dispatch);let held=false,invoked=false;
 try{
  // Give pending physical inspection/child-close callbacks a complete I/O
  // turn between synchronous qualification bursts. Every original check runs
  // after the handoff; neither handoff enters the repository transaction.
  await new Promise<void>(resolve=>setImmediate(()=>setImmediate(resolve)));
  phase='before-reservation';if(!current())return report('suppressed',false,false);
  if(!repository.reserveController(owner,request))return report('suppressed',false,false);held=true;consumedDispatchSelections.add(dispatch);
  await new Promise<void>(resolve=>setImmediate(()=>setImmediate(resolve)));
  phase='after-reservation';if(!current())return report('requiresReconciliation',true,false);
  const context=Object.freeze({signal,isCurrent:(scope:G.ActivityScope)=>isDeepStrictEqual(scope,request.scope)&&current()});
  phase='adapter-call';invoked=true;const raw=await apply.call(adapter,request,context);phase='adapter-result';const result=boundedGameDataSnapshot(raw,131072) as G.GameActionResult|null;
  if(!result||!controllerValidator.validate(gameSchema+'GameActionResult',result).valid||result.operation!==request.operation||result.requestId!==request.requestId||result.correlationId!==request.correlationId||!current())return report('requiresReconciliation',true,true);
  freeze(result);const usage=boundedGameDataSnapshot(usageFor(request,result),131072) as ControllerUsage|null;
  if(!usage||result.outcome.status!=='succeeded'||!isDeepStrictEqual(usage.receipt,result.outcome.payload)||!current())return report('requiresReconciliation',true,true,result);
  if(!repository.settleController(owner,request,usage))return report('requiresReconciliation',true,true,result);held=false;
  // Settlement is an immutable historical accounting fact. Later source loss
  // withholds the result from downstream current planning; no refund/retry.
  return current()?report('settled',false,true,result):report('requiresReconciliation',false,true);
 }catch(error){refusal('operation_threw',error);return report(held?'requiresReconciliation':'suppressed',held,invoked);}finally{inFlightDispatchSelections.delete(dispatch);}
}
