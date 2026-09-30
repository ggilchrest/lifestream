import {createContractValidator} from '@lifestream/contracts';
import type {PreparedTurnBinding} from '@lifestream/runtime/inference/prompt';
import {gameWindowCurrent,type GameWindowSelection} from '@lifestream/runtime/activity/policy';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameStartRepository} from '@lifestream/storage-sqlite';
import type {ActivityCheckpointRepository,PlanningReservation,ControllerUsage} from '@lifestream/storage-sqlite';
import {runGamePlanningTurn,type GamePlanningResult} from '@lifestream/runtime/activity/coordinator';
import {gameCampaignCheckpointCurrent,gameDispatchSelectionMatchesPreparedContext,gameDispatchValidationFor,type GameDispatchSelection,type PreparedGameCampaignContext} from '@lifestream/runtime/activity/game-journal';
import type {DiscoveryAdministration} from '../admin/understanding.ts';
import {isDeepStrictEqual} from 'node:util';
/** First-party temporal-to-durable metadata join. Host admission remains an
 * independent required predicate; no timer/enrollment/start/dispatch is created. */
export function claimConfiguredGameStart(repository:GameStartRepository,raw:{scope:G.ActivityScope;policy:G.GamePolicy;bounds:G.GameBounds},window:GameWindowSelection):boolean {
 const input=boundedGameDataSnapshot(raw) as typeof raw|null;if(!input||Object.keys(input).sort().join(',')!=='bounds,policy,scope'||!gameWindowCurrent(window,input.scope,{policy:input.policy,bounds:input.bounds})||window.purpose!=='play'||window.status!=='inside'||window.policyRevision!==input.policy.revision||!window.windowId||!window.localDate||!window.occurrenceKey)return false;
 return repository.claim({...input,windowId:window.windowId,localDate:window.localDate,occurrenceKey:window.occurrenceKey},()=>gameWindowCurrent(window,input.scope,{policy:input.policy,bounds:input.bounds}));
}
export type CheckpointedGamePlanningPorts={
 /** The existing runtime instance, shared with foreground and other P2 work. */
 background:Pick<DiscoveryAdministration,'runBackground'>;
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
 const scope=boundedGameDataSnapshot(input.scope) as G.ActivityScope|null;
 const suppressed=()=>({state:'suppressed' as const,reason:'currentGameRunUnavailable',completedSteps:0});
 if(!scope)return suppressed();freeze(scope);
 const owner={assistantId:scope.assistantId,principalId:scope.principalId,relationshipId:scope.relationshipId},providerRevision=ports.providerRevision,tokenizerIdentity=ports.tokenizerIdentity,preemption=ports.providerPreemptionBoundMs,release=ports.providerSlotReleaseBoundMs;
 const current=()=>{try{if(ports.repository!==repository||ports.background!==background||ports.providerRevision!==providerRevision||ports.tokenizerIdentity!==tokenizerIdentity||ports.providerPreemptionBoundMs!==preemption||ports.providerSlotReleaseBoundMs!==release)return false;const record=repository.get(owner,scope.runId);return !!record&&isDeepStrictEqual(record.checkpoint.scope,scope)&&gameCampaignCheckpointCurrent(game,binding,record.checkpoint)&&ports.current(scope,freeze(record.checkpoint))===true;}catch{return false;}};
 if(!current())return suppressed();
 let reservation:PlanningReservation|undefined;
 return runGamePlanningTurn({...input,game,binding,turn,provider},{run:work=>background.runBackground(work),current,providerRevision,tokenizerIdentity,...(preemption===undefined?{}:{providerPreemptionBoundMs:preemption}),...(release===undefined?{}:{providerSlotReleaseBoundMs:release}),...(ports.now?{now:ports.now}:{}),admitOnce:(binding,bounds,revision)=>{
  if(!current())return false;
  const candidate={viewId:binding.viewId,viewRevision:binding.revision,invalidationKey:binding.invalidationKey,providerRevision:revision,maximumInputTokens:bounds.maximumInputTokens,maximumOutputTokens:bounds.maximumOutputTokens};
  if(!repository.reservePlanning(owner,scope,candidate))return false;reservation=Object.freeze(candidate);return current();
 },publish:result=>{
  try{if(!reservation||!current()||!isDeepStrictEqual(result.decisionInput.scope,scope))return false;const completionRef=ports.terminalRef(result);if(typeof completionRef!=='string'||!completionRef.trim()||!current())return false;
   if(!repository.settlePlanning(owner,scope,reservation,{inputTokens:result.inputTokens,outputTokens:result.outputTokens,providerRevision,completionRef})||!current())return false;
   return ports.publishDecision(result)===true&&current();
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
 const {game,binding,decision,dispatch}=input,repository=ports.repository,adapter=ports.adapter,apply=adapter?.applyController,signal=ports.signal,qualify=ports.current,usageFor=ports.usageFor;
 const owner={assistantId:request.scope.assistantId,principalId:request.scope.principalId,relationshipId:request.scope.relationshipId};
 const pinned=()=>ports.repository===repository&&ports.adapter===adapter&&adapter.applyController===apply&&ports.signal===signal&&ports.current===qualify&&ports.usageFor===usageFor;
 const prepared=()=>gameDispatchSelectionMatchesPreparedContext(dispatch,game,binding,decision,request.payload.proposal)&&isDeepStrictEqual(gameDispatchValidationFor(dispatch),request.payload.dispatchValidation);
 let checking=false,retired=false;
 const current=()=>{if(retired||checking){retired=true;return false;}checking=true;try{if(!pinned()||signal.aborted||!prepared()){retired=true;return false;}const row=repository.get(owner,request.scope.runId);if(!row||!gameCampaignCheckpointCurrent(game,binding,row.checkpoint)||!isDeepStrictEqual(row.checkpoint.scope,request.scope)||qualify(freeze(row.checkpoint),request)!==true){retired=true;return false;}const preparedCurrent=prepared(),eligible=!retired&&preparedCurrent&&pinned()&&!signal.aborted;if(!eligible)retired=true;return eligible;}catch{retired=true;return false;}finally{checking=false;}};
 if(typeof apply!=='function'||typeof qualify!=='function'||typeof usageFor!=='function'||!dispatch||typeof dispatch!=='object'||consumedDispatchSelections.has(dispatch)||inFlightDispatchSelections.has(dispatch))return report('suppressed',false,false);
 inFlightDispatchSelections.add(dispatch);let held=false,invoked=false;
 try{
  if(!current())return report('suppressed',false,false);
  if(!repository.reserveController(owner,request))return report('suppressed',false,false);held=true;consumedDispatchSelections.add(dispatch);
  if(!current())return report('requiresReconciliation',true,false);
  const context=Object.freeze({signal,isCurrent:(scope:G.ActivityScope)=>isDeepStrictEqual(scope,request.scope)&&current()});
  invoked=true;const raw=await apply.call(adapter,request,context),result=boundedGameDataSnapshot(raw,131072) as G.GameActionResult|null;
  if(!result||!controllerValidator.validate(gameSchema+'GameActionResult',result).valid||result.operation!==request.operation||result.requestId!==request.requestId||result.correlationId!==request.correlationId||!current())return report('requiresReconciliation',true,true);
  freeze(result);const usage=boundedGameDataSnapshot(usageFor(request,result),131072) as ControllerUsage|null;
  if(!usage||result.outcome.status!=='succeeded'||!isDeepStrictEqual(usage.receipt,result.outcome.payload)||!current())return report('requiresReconciliation',true,true,result);
  if(!repository.settleController(owner,request,usage))return report('requiresReconciliation',true,true,result);held=false;
  // Settlement is an immutable historical accounting fact. Later source loss
  // withholds the result from downstream current planning; no refund/retry.
  return current()?report('settled',false,true,result):report('requiresReconciliation',false,true);
 }catch{return report(held?'requiresReconciliation':'suppressed',held,invoked);}finally{inFlightDispatchSelections.delete(dispatch);}
}
