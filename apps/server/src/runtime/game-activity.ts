import {gameWindowCurrent,type GameWindowSelection} from '@lifestream/runtime/activity/policy';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameStartRepository} from '@lifestream/storage-sqlite';
import type {ActivityCheckpointRepository,PlanningReservation} from '@lifestream/storage-sqlite';
import {runGamePlanningTurn,type GamePlanningResult} from '@lifestream/runtime/activity/coordinator';
import {gameCampaignCheckpointCurrent} from '@lifestream/runtime/activity/game-journal';
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
