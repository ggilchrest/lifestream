import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {performance} from 'node:perf_hooks';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import type {ActivityCheckpointRepository} from '@lifestream/storage-sqlite';
import {prepareGameCampaignContext,type GameCampaignContextSelection,type PreparedGameCampaignContext} from '@lifestream/runtime/activity/game-journal';
import type {GamePlanningBounds} from '@lifestream/runtime/activity/coordinator';
import {finalizePreparedTurn,type FinalizedTurn,type PreparedTurnBinding} from '@lifestream/runtime/inference/prompt';
import type {BackgroundResult} from '@lifestream/runtime/understanding/coordinator';
import {SHARED_PROVIDER_PREEMPTION_BOUND_MS,SHARED_PROVIDER_SLOT_RELEASE_BOUND_MS} from '@lifestream/runtime/understanding/coordinator';
import type {HostRuntimeInput} from './inference.ts';
import type {GameMemoryHostOptions} from './game-memory.ts';
import type {CheckpointedGamePlanningPorts} from './game-activity.ts';

/** Trusted user-consent/source resolver. This is not a wire DTO, model grant,
 * test-profile override, authentication source or enrollment/start operation. */
export type ApprovedGameRuntimeRun={scope:G.ActivityScope;approvedUntil:string;maximumRunMs:number;maximumPlanningSteps:number;observations:true;campaignJournal:true;controllerInput:boolean;memoryEpisodes:boolean};
export type GameRuntimeOptions={
 resolveApproval:(scope:Readonly<G.ActivityScope>)=>ApprovedGameRuntimeRun|null;
 sourceCurrent:(scope:Readonly<G.ActivityScope>)=>boolean;
 /** Operator-qualified exact deployed runtime/model/envelope, never a response
  * from the model endpoint or attachment metadata. Missing proof leaves P2 off. */
 inferenceQualificationFor?:(selection:Readonly<GameInferenceSelection>)=>GameInferenceQualification|null;
 memory?:{options:GameMemoryHostOptions;retentionConsentRefFor:(owner:Readonly<{principalId:string;assistantId:string;relationshipId:string|null}>,activityId:string)=>string|null};
};
export type GameInferenceSelection={configurationDigest:string;providerRef:string;providerRevision:string;model:string;modelArtifactDigest:string|null;healthy:boolean;fixture:boolean};
export type GameInferenceQualification={selectionDigest:string;qualificationRef:string;preemptionBoundMs:number;slotReleaseBoundMs:number;current:()=>boolean};
export type PreparedHostGameStep=Readonly<{scope:Readonly<G.ActivityScope>;binding:PreparedTurnBinding;game:PreparedGameCampaignContext;turn:FinalizedTurn;bounds:Readonly<GamePlanningBounds>}>;
export type HostGamePlanningPublication=Pick<CheckpointedGamePlanningPorts,'current'|'terminalRef'|'publishDecision'>;
/** Scoped methods only. Provider registry, authentication context and the
 * shared work coordinator remain inside their existing server instance. */
export type AuthenticatedGameRuntime={
 scope:Readonly<G.ActivityScope>;
 isCurrent:()=>boolean;controllerCurrent:()=>boolean;
 preparePlanning:(selection:GameCampaignContextSelection,bounds:GamePlanningBounds)=>PreparedHostGameStep;
 runPlanning:(step:PreparedHostGameStep,publication:HostGamePlanningPublication)=>Promise<BackgroundResult>;
 publishEpisode:(episode:G.GameExperienceEpisode)=>{state:'retained'|'unavailable';memoryId:string|null};
 close:()=>void;
};
type InternalGameRuntime={
 current:()=>boolean;prepare:()=>HostRuntimeInput;
 run:(step:PreparedHostGameStep,repository:ActivityCheckpointRepository,publication:HostGamePlanningPublication,current:()=>boolean)=>Promise<BackgroundResult>;
 cancel:(key:string)=>void;
 publishEpisode:AuthenticatedGameRuntime['publishEpisode'];
};
const validator=createContractValidator(),scopeSchema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/ActivityScope';
const safe=(check:()=>boolean)=>{try{return check()===true;}catch{return false;}};
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const unavailable=()=>new Error('Authenticated game runtime unavailable');
const positive=(n:unknown,max:number)=>Number.isSafeInteger(n)&&Number(n)>=1&&Number(n)<=max;

export function approvedGameRuntimeRun(options:GameRuntimeOptions,scope:Readonly<G.ActivityScope>,allowExpired=false):Readonly<ApprovedGameRuntimeRun>|null{
 try{
  const raw=boundedGameDataSnapshot(options.resolveApproval(scope)) as ApprovedGameRuntimeRun|null;
  if(!raw||Object.keys(raw).sort().join(',')!=='approvedUntil,campaignJournal,controllerInput,maximumPlanningSteps,maximumRunMs,memoryEpisodes,observations,scope'||!validator.validate(scopeSchema,raw.scope).valid||!isDeepStrictEqual(raw.scope,scope)||raw.observations!==true||raw.campaignJournal!==true||typeof raw.controllerInput!=='boolean'||typeof raw.memoryEpisodes!=='boolean'||!positive(raw.maximumRunMs,120000)||!positive(raw.maximumPlanningSteps,64))return null;
  const expiry=Date.parse(raw.approvedUntil),now=Date.now();if(!Number.isSafeInteger(expiry)||(!allowExpired&&expiry<=now)||expiry>now+86400000)return null;
  return freeze(raw);
 }catch{return null;}
}
export function captureGameRuntimeOptions(raw:GameRuntimeOptions):Readonly<GameRuntimeOptions>{
 if(typeof raw.resolveApproval!=='function'||typeof raw.sourceCurrent!=='function')throw unavailable();
 if(raw.inferenceQualificationFor!==undefined&&typeof raw.inferenceQualificationFor!=='function')throw unavailable();
 if(raw.memory&&(typeof raw.memory.retentionConsentRefFor!=='function'||!positive(raw.memory.options.maximumCandidates,4)))throw unavailable();
 return Object.freeze({...raw,...(raw.memory?{memory:Object.freeze({...raw.memory,options:Object.freeze({...raw.memory.options,source:Object.freeze({...raw.memory.options.source})})})}:{})});
}
export const gameInferenceSelectionDigest=(selection:Readonly<GameInferenceSelection>)=>createHash('sha256').update(JSON.stringify(selection)).digest('hex');
export function qualifiedGameInferenceBounds(options:Readonly<GameRuntimeOptions>,selection:Readonly<GameInferenceSelection>):{preemptionBoundMs:number;slotReleaseBoundMs:number;current:()=>boolean}|null{
 try{
  if(!selection.healthy||selection.fixture||!/^[a-f0-9]{64}$/.test(selection.configurationDigest))return null;
  const proof=options.inferenceQualificationFor?.(Object.freeze({...selection}));
  if(!proof||Object.keys(proof).sort().join(',')!=='current,preemptionBoundMs,qualificationRef,selectionDigest,slotReleaseBoundMs'||proof.selectionDigest!==gameInferenceSelectionDigest(selection)||typeof proof.qualificationRef!=='string'||!proof.qualificationRef.trim()||proof.qualificationRef.length>1024||typeof proof.current!=='function'||!Number.isFinite(proof.preemptionBoundMs)||proof.preemptionBoundMs<0||proof.preemptionBoundMs>SHARED_PROVIDER_PREEMPTION_BOUND_MS||!Number.isFinite(proof.slotReleaseBoundMs)||proof.slotReleaseBoundMs<0||proof.slotReleaseBoundMs>SHARED_PROVIDER_SLOT_RELEASE_BOUND_MS)return null;
  const qualify=proof.current,preemptionBoundMs=proof.preemptionBoundMs,slotReleaseBoundMs=proof.slotReleaseBoundMs,ref=proof.qualificationRef,digest=proof.selectionDigest;
  const current=()=>proof.current===qualify&&proof.preemptionBoundMs===preemptionBoundMs&&proof.slotReleaseBoundMs===slotReleaseBoundMs&&proof.qualificationRef===ref&&proof.selectionDigest===digest&&safe(qualify);
  return current()?Object.freeze({preemptionBoundMs,slotReleaseBoundMs,current}):null;
 }catch{return null;}
}
/** Production memory has separate configured consent plus the original owner,
 * automatic-memory policy, source custody, correction, audience and forgetting
 * checks. Historical retrieval deliberately does not require a live play lease. */
export function productionGameMemory(options:Readonly<GameRuntimeOptions>):GameMemoryHostOptions|undefined{
 const configured=options.memory;if(!configured)return undefined;
 const original=configured.options,source=original.source;
 return {...original,source:{...source,
  retentionFor:(owner,activityId)=>{
   const consent=configured.retentionConsentRefFor(owner,activityId),policy=source.retentionFor(owner,activityId);
   return typeof consent==='string'&&consent.length>0&&policy?.retentionPolicyRef===consent?policy:null;
  },
  publicationCurrent:episode=>{
   const approval=approvedGameRuntimeRun(options,episode.scope);
   return !!approval&&approval.memoryEpisodes&&safe(()=>options.sourceCurrent(episode.scope))&&safe(()=>source.publicationCurrent(episode));
  },
 }};
}

export function createAuthenticatedGameRuntime(scopeInput:Readonly<G.ActivityScope>,options:Readonly<GameRuntimeOptions>,repository:ActivityCheckpointRepository,internal:InternalGameRuntime):AuthenticatedGameRuntime|null{
 const scope=boundedGameDataSnapshot(scopeInput) as G.ActivityScope|null;if(!scope||!validator.validate(scopeSchema,scope).valid)return null;freeze(scope);
 const approval=approvedGameRuntimeRun(options,scope);if(!approval||!safe(()=>options.sourceCurrent(scope))||!safe(internal.current))return null;
 const began=performance.now(),expires=Math.min(Date.parse(approval.approvedUntil),Date.now()+approval.maximumRunMs),monoExpires=began+expires-Date.now();
 const steps=new WeakSet<PreparedHostGameStep>(),consumed=new WeakSet<PreparedHostGameStep>();
 let closed=false,inFlight=false,used=0,lastWall=Date.now(),activeKey:string|null=null;
 const close=()=>{if(closed)return;closed=true;clearTimeout(timer);if(activeKey)internal.cancel(activeKey);};
 const current=()=>{
  if(closed)return false;const now=Date.now();
  if(now<lastWall||now>=expires||performance.now()>=monoExpires||!safe(internal.current)||!safe(()=>options.sourceCurrent(scope))||!isDeepStrictEqual(approvedGameRuntimeRun(options,scope),approval)){close();return false;}lastWall=now;return true;
 };
 const timer=setTimeout(close,Math.max(1,expires-Date.now()));timer.unref();
 const runtime:AuthenticatedGameRuntime={scope,isCurrent:current,controllerCurrent:()=>approval.controllerInput&&current(),
  preparePlanning:(selection,bounds)=>{
   if(!current()||used>=approval.maximumPlanningSteps||selection.status!=='selected'||!selection.isCurrent())throw unavailable();
   const copy=boundedGameDataSnapshot(bounds) as GamePlanningBounds|null;
   if(!copy||Object.keys(copy).sort().join(',')!=='deadlineMs,maximumChunks,maximumInputTokens,maximumOutputBytes,maximumOutputTokens'||!positive(copy.deadlineMs,30000)||!positive(copy.maximumChunks,4096)||!positive(copy.maximumInputTokens,32768)||!positive(copy.maximumOutputBytes,32768)||!positive(copy.maximumOutputTokens,4096))throw unavailable();freeze(copy);
   const host=internal.prepare(),binding=host.preparedTurnBinding;
   if(!binding||!host.isCurrent()||!current())throw unavailable();
   const game=prepareGameCampaignContext(selection,binding),deadlineAt=new Date(Math.min(expires,Date.now()+copy.deadlineMs,game.expiresAtMs)).toISOString();
   const turn=finalizePreparedTurn({assistantId:scope.assistantId,sessionId:scope.contextBinding.sessionId,endpointId:scope.contextBinding.endpointId,interactionId:randomUUID(),origin:'activityStep',userInput:'',maximumOutputTokens:copy.maximumOutputTokens,conversation:binding.conversation,preparedTurnBinding:binding,preparedGameCampaignContext:game,runtimeSelfContext:host.runtimeSelfContext,...(host.profileProjection?{profileProjection:host.profileProjection}:{}),...(host.preparedRelationshipContext?{preparedRelationshipContext:host.preparedRelationshipContext}:{}),deadlineAt},()=>current()&&host.isCurrent());
   const step=freeze({scope,binding,game,turn,bounds:copy});steps.add(step);return step;
  },
  runPlanning:async(step,publication)=>{
   if(!steps.has(step)||consumed.has(step)||inFlight||!current()||used>=approval.maximumPlanningSteps)return {state:'suppressed',reason:'currentGameRunUnavailable',completedSteps:0};
   const {current:qualify,terminalRef,publishDecision}=publication;
   if(typeof qualify!=='function'||typeof terminalRef!=='function'||typeof publishDecision!=='function')return {state:'suppressed',reason:'currentGameRunUnavailable',completedSteps:0};
   const publicationCurrent=()=>publication.current===qualify&&publication.terminalRef===terminalRef&&publication.publishDecision===publishDecision;
   const pinnedPublication=Object.freeze({current:(scope:G.ActivityScope,checkpoint:Readonly<G.ActivityCheckpoint>)=>publicationCurrent()&&qualify(scope,checkpoint),terminalRef:(result:Parameters<typeof terminalRef>[0])=>publicationCurrent()?terminalRef(result):null,publishDecision:(result:Parameters<typeof publishDecision>[0])=>publicationCurrent()&&publishDecision(result)});
   consumed.add(step);used++;inFlight=true;activeKey='game-decision:'+step.binding.viewId+':'+step.binding.revision;
   try{return await internal.run(step,repository,pinnedPublication,()=>current()&&publicationCurrent());}finally{inFlight=false;activeKey=null;}
  },
  publishEpisode:episode=>current()&&approval.memoryEpisodes&&isDeepStrictEqual(episode.scope,scope)?internal.publishEpisode(episode):{state:'unavailable',memoryId:null},close,
 };
 if(!current()){close();return null;}return Object.freeze(runtime);
}
