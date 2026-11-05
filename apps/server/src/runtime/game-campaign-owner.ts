import type {GameSceneRejection} from './game-scene-eligibility.ts';
import {gamePhase} from './game-phase-timing.ts';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {reconcileClosedUndispatchedControllers,ActivityCheckpointRepository,CampaignJournalRepository,type Database,type ActivityMetadataOptions,type ActivityMetadataPolicy,type ControllerUsage,type CampaignJournalOptions,type GameStartRepository,type GameEpisodeRetention,type PlanningReservation,type PlanningUsage} from '@lifestream/storage-sqlite';
import type * as G from '@lifestream/contracts/game-activity';
import {beginGameDispatchValidation,selectGameCampaignContext,selectGameDispatchValidation,gameDispatchValidationFor,gameDecisionHasPreparedIdentity,type GameCampaignContextBoundary,type GameActionProposalConstraints,type GameDispatchBoundary,type GameDispatchRefusal} from '@lifestream/runtime/activity/game-journal';
import {finalizedTurnDeadlineCurrent} from '@lifestream/runtime/inference/prompt';
import type {GameWindowSelection,ManualGameStartSelection} from '@lifestream/runtime/activity/policy';
import type {GamePlanningBounds,GamePlanningResult} from '@lifestream/runtime/activity/coordinator';
import type {GameHostJoin} from './game-host-port.ts';
import type {PreparedHostGameStep} from './game-host-runtime.ts';
import type {SupervisedGameCampaign} from '../../../../scripts/supervised-game-runtime.mjs';
import {claimConfiguredGameStart,claimManualGameStart} from './game-activity.ts';

export type GameInputRejection=GameSceneRejection|GameDispatchRefusal|'scene_comparison_not_confirmed'|'ordinary_target_not_current';
type Owner={principalId:string;assistantId:string;relationshipId:string};
type MemoryOwner={principalId:string;assistantId:string;relationshipId:string|null};
type Start={policy:G.GamePolicy;bounds:G.GameBounds;checkpoint:G.ActivityCheckpoint;journal:G.CampaignJournal}&({window:GameWindowSelection;manualStart?:never}|{manualStart:ManualGameStartSelection;window?:never});
export type GameCampaignRefusal='admission_unavailable'|'initial_observation_unavailable'|'start_selection_unavailable'|'start_claim_refused'|'checkpoint_unavailable'|'journal_unavailable'|'observation_unavailable'|'interpretation_unavailable'|'interpreted_observation_invalid'|'binding_unavailable'|'context_unavailable'|'controller_context_unavailable'|'controller_admission_unavailable'|'controller_observation_unavailable'|'controller_dispatch_validation_unavailable'|'controller_request_unavailable';
export type GameObservationAccounting={
 priorScene?:Readonly<{observationId:string;description:string}>;
 admitOnce:(candidate:Pick<PlanningReservation,'providerRevision'|'maximumInputTokens'|'maximumOutputTokens'>)=>boolean;
 settleUsage:(usage:PlanningUsage)=>boolean;
};
export type GameCampaignOwnerSource={
 onDecision?:(proposal:G.GameActionProposal|null,decisionId:string)=>void;
 onRejected?:(proposalId:string,reason?:GameInputRejection)=>void;
 // Trusted authenticated ordinary-Play owner only; never model/window text.
 ordinaryTargetCurrent?:(observation:G.GameObservation)=>boolean;
 sameObservedScene?:(before:G.GameObservation,after:G.GameObservation)=>boolean;
 sceneRejectionReason?:(before:G.GameObservation,after:G.GameObservation)=>GameSceneRejection|null;
 onSettled?:(receipt:G.GameActionReceipt)=>void;
 onRefusal?:(reason:GameCampaignRefusal)=>void;
 startAfterObservation?:true;
 runSettlement?:<T>(work:()=>T)=>Promise<T>;
 current:(scope:Readonly<G.ActivityScope>)=>boolean;
 /** Separate terminal metadata currentness; never permission for new gameplay. */
 terminalCurrent?:(scope:Readonly<G.ActivityScope>,receiptRef:string)=>boolean;
 terminalJournalOptions?:CampaignJournalOptions;
 terminalReceiptUsageFor?:(request:G.GameActionRequest,result:G.GameActionResult)=>ControllerUsage|null;
 goalReached?:(observation:Readonly<G.GameObservation>)=>boolean;
 startFor:(join:GameHostJoin)=>Start|null;
 observe:(join:GameHostJoin,signal:AbortSignal,afterActionId?:string|null)=>Promise<G.GameObservation|null>;
 /** Optional model interpretation of this already approved image. Runs only
  * after the real checkpoint exists and shares its finite inference ledger. */
 /** Present only for the currently authenticated ordinary Play event. */
 planningTaskFor?:(scope:Readonly<G.ActivityScope>)=>'ordinaryCtProgress'|null;
 waitForObservationChange?:(join:GameHostJoin,signal:AbortSignal)=>Promise<boolean>;
 interpretObservation?:(join:GameHostJoin,observation:Readonly<G.GameObservation>,signal:AbortSignal,accounting:GameObservationAccounting)=>Promise<G.GameObservation|null>;
 bindingFor:(scope:Readonly<G.ActivityScope>,journal:G.CampaignJournal,observation:G.GameObservation)=>G.GameCampaignJournal|null;
 /** Inert limits from the existing controller owner; absence is legacy context only. */
 actionProposalConstraintsFor?:(scope:Readonly<G.ActivityScope>)=>GameActionProposalConstraints|null;
 campaignBoundary:GameCampaignContextBoundary;dispatchBoundary:GameDispatchBoundary;
 requestFor:(join:GameHostJoin,result:GamePlanningResult,dispatch:NonNullable<ReturnType<typeof gameDispatchValidationFor>>,observation:G.GameObservation,signal:AbortSignal)=>Promise<G.GameActionRequest|null>;
 planningTerminalCurrent:(result:GamePlanningResult,step:PreparedHostGameStep)=>boolean;
 settledSourceCurrent:(join:GameHostJoin,request:G.GameActionRequest,result:Awaited<ReturnType<GameHostJoin['runController']>>)=>boolean;
 episodeFor?:(join:GameHostJoin,journal:G.CampaignJournal,request:G.GameActionRequest,result:Awaited<ReturnType<GameHostJoin['runController']>>,resultingObservation:G.GameObservation)=>G.GameExperienceEpisode|null;
 /** Actual reviewed scoped retention, not a default derived from enabled memory. */
 retentionFor?:(owner:Owner,activityId:string)=>{policyRevision:number;retention:GameEpisodeRetention}|null;
};
const safe=(fn:()=>boolean)=>{try{return fn()===true;}catch{return false;}};
const owner=(scope:G.ActivityScope):Owner|null=>scope.relationshipId?{principalId:scope.principalId,assistantId:scope.assistantId,relationshipId:scope.relationshipId}:null;
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,child])=>[key,canonical(child)])):value;
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';

/** Owns the existing SQLite repositories and actual selected/settled sources.
 * No native qualifier, policy, capability, owner identity or retention is minted. */
export function createGameCampaignOwner(options:{metadata:ActivityMetadataOptions;journal:CampaignJournalOptions;startsFor:(database:Database)=>GameStartRepository;source:GameCampaignOwnerSource;planningBounds:GamePlanningBounds;maximumObservationAgeMs:number;maximumContextBytes:number;settlementTimeoutMs?:number;sessionScoped?:boolean;continuousGameTime?:boolean}){
 const settlementTimeoutMs=options.settlementTimeoutMs??30000;
 if(!Number.isSafeInteger(settlementTimeoutMs)||settlementTimeoutMs<1||settlementTimeoutMs>60000)throw Error('Invalid game settlement sanity timeout');
 const rawSource=options.source,source=Object.freeze({...rawSource,...(rawSource.terminalJournalOptions?{terminalJournalOptions:Object.freeze({...rawSource.terminalJournalOptions})}:{}),campaignBoundary:Object.freeze({...rawSource.campaignBoundary}),dispatchBoundary:Object.freeze({...rawSource.dispatchBoundary})});
 const sourcePinned=()=>Object.entries(source).every(([key,value])=>key==='campaignBoundary'||key==='dispatchBoundary'||key==='terminalJournalOptions'?Object.entries(value).every(([nested,fn])=>(rawSource as any)[key]?.[nested]===fn):(rawSource as any)[key]===value);
 const planningBounds=Object.freeze({...options.planningBounds});
 let database:Database|undefined,checkpoints:ActivityCheckpointRepository|undefined,journals:CampaignJournalRepository|undefined,starts:GameStartRepository|undefined;
 const terminalReceipts=new Map<string,{result:G.GameActionResult;usage:ControllerUsage}>();let terminalMetadataPolicy:ActivityMetadataPolicy|null=null;
 const settledEntries=new Map<string,{scope:G.ActivityScope;entry:G.CampaignJournal['entries'][number];binding:G.GameCampaignJournal['entryBindings'][number];fingerprint:string;settlementDigest:string}>();
 const completed=new WeakMap<PreparedHostGameStep,{result:GamePlanningResult;ref:string;ledgerRevision:number}>(),published=new WeakSet<PreparedHostGameStep>();
 const current=(scope:G.ActivityScope)=>sourcePinned()&&safe(()=>source.current(scope));
 let resourceExhausted=false;const sessionScoped=options.sessionScoped===true;
 let refusalReported=false;
 const refuse=(reason:GameCampaignRefusal):null=>{if(!refusalReported){refusalReported=true;try{source.onRefusal?.(reason);}catch{}}return null;};
 const createRepository=(db:Database)=>{if(database)throw Error('Second campaign owner refused');database=db;checkpoints=new ActivityCheckpointRepository(db,options.metadata);journals=new CampaignJournalRepository(db,options.journal);starts=options.startsFor(db);return checkpoints;};
 const retentionConsentRefFor=(o:Readonly<MemoryOwner>,activityId:string):string|null=>{
  if(!database||!o.relationshipId||!sourcePinned()||!source.retentionFor)return null;
  const scopedOwner={...o,relationshipId:o.relationshipId};
  const policy=source.retentionFor(scopedOwner,activityId);if(!policy)return null;
  const row=database.connection.prepare('SELECT revision FROM automatic_memory_policies WHERE principal_id=? AND assistant_id=? AND relationship_id=? AND enabled=1').get(o.principalId,o.assistantId,o.relationshipId);
  if(!row||row.revision!==policy.policyRevision||!database.connection.prepare('SELECT 1 FROM local_accounts WHERE principal_id=? AND disabled=0').get(o.principalId))return null;
  const r=policy.retention;
  return Number.isSafeInteger(r.retentionMs)&&r.retentionMs>=1&&r.retentionMs<=2147483647&&Number.isSafeInteger(r.maximumEpisodes)&&r.maximumEpisodes>=1&&r.maximumEpisodes<=128&&Number.isSafeInteger(r.maximumBytes)&&r.maximumBytes>=1&&r.maximumBytes<=16384&&typeof r.retentionPolicyRef==='string'&&r.retentionPolicyRef.trim().length>0&&Buffer.byteLength(r.retentionPolicyRef)<=2048?r.retentionPolicyRef:null;
 };
 const interpretedObservation=async(join:GameHostJoin,observation:G.GameObservation,signal:AbortSignal,priorScene?:Readonly<{observationId:string;description:string}>):Promise<G.GameObservation|null>=>{
  if(!source.interpretObservation)return observation;const o=owner(join.scope);if(!o)return null;
    const original=structuredClone(observation);let reservation:PlanningReservation|undefined,settled=false;
    const inferenceCurrent=()=>!signal.aborted&&safe(()=>join.runtime!.isCurrent())&&current(join.scope)&&safe(()=>source.campaignBoundary.observationCurrent(original));
    const accounting:GameObservationAccounting=Object.freeze({...(priorScene?{priorScene}:{}),
     admitOnce:candidate=>{
      if(reservation||!inferenceCurrent())return false;
      const bounded=boundedGameDataSnapshot(candidate) as typeof candidate|null;
      if(!bounded||Object.keys(bounded).sort().join(',')!=='maximumInputTokens,maximumOutputTokens,providerRevision')return false;
      const next=Object.freeze({...bounded,viewId:original.observationId,viewRevision:original.revision,invalidationKey:randomUUID()});
      try{if(!checkpoints!.reservePlanning(o,join.scope,next))return false;reservation=next;return inferenceCurrent();}catch{return false;}
     },
     settleUsage:usage=>{
      if(!reservation||settled||!inferenceCurrent())return false;
      try{if(!checkpoints!.settlePlanning(o,join.scope,reservation,usage))return false;settled=true;return inferenceCurrent();}catch{return false;}
     }
    });
    let interpreted:G.GameObservation|null;
    try{interpreted=await source.interpretObservation(join,observation,signal,accounting);}catch{return refuse('interpretation_unavailable');}
    if(!interpreted)return refuse('interpretation_unavailable');
    // Interpretation may append attributed facts, never replace native fields,
    // frame identity, timestamps, scope, lineage or per-image approval evidence.
    const copy=boundedGameDataSnapshot(interpreted,131072) as G.GameObservation|null;
    if(!copy||!reservation||!settled||!inferenceCurrent()||!validator.validate(schema+'GameObservation',copy).valid||
     !isDeepStrictEqual({...copy,facts:original.facts,interpretedAt:original.interpretedAt,providerConfigurationRef:original.providerConfigurationRef},original)||
     copy.facts.length<original.facts.length||!isDeepStrictEqual(copy.facts.slice(0,original.facts.length),original.facts))return refuse('interpreted_observation_invalid');
    return copy;
 };
 const planningObservations=new Map<string,G.GameObservation>();
 const campaign:SupervisedGameCampaign={
  ...(sessionScoped?{resourceExhausted:()=>resourceExhausted}:{}),
  selectPlanning:async(join,repository,signal)=>{
   const o=owner(join.scope);if(!o||repository!==checkpoints||!journals||!starts||signal.aborted||!join.runtime?.isCurrent()||!current(join.scope))return refuse('admission_unavailable');
   let record=checkpoints!.get(o,join.scope.runId),initialObservation:G.GameObservation|null=null;
   if(!record){
    let start=source.startAfterObservation?null:source.startFor(join);
    if(!source.startAfterObservation&&(!start||!isDeepStrictEqual(start.checkpoint.scope,join.scope)||start.journal.campaignId!==join.scope.campaignId)||!current(join.scope))return refuse('start_selection_unavailable');
    // Native observation/review is a prerequisite, not a gameplay start.
    initialObservation=await source.observe(join,signal,null);
    if(!initialObservation||signal.aborted||!current(join.scope)||!join.runtime.isCurrent())return refuse('initial_observation_unavailable');
    if(source.startAfterObservation)start=source.startFor(join);
    if(!start||!isDeepStrictEqual(start.checkpoint.scope,join.scope)||start.journal.campaignId!==join.scope.campaignId||!current(join.scope))return refuse('start_selection_unavailable');
    try{
     const input={scope:join.scope,policy:start.policy,bounds:start.bounds};
     if(!(start.manualStart?claimManualGameStart(starts,input,start.manualStart):claimConfiguredGameStart(starts,input,start.window)))return refuse('start_claim_refused');
    }catch(error){refuse('start_claim_refused');throw error;}
    journals.put(o,start.journal,0);checkpoints!.put(o,start.checkpoint,0);record=checkpoints!.get(o,join.scope.runId);
   }
   if(!record)return refuse('checkpoint_unavailable');
   if(sessionScoped){
    const policy=options.metadata.policyFor(o,join.scope.activityId),b=policy?.bounds,u=record.used,h=record.reserved,vision=!!source.interpretObservation;
    const required={actions:1,frames:b?.maxActionFrames??0,wallMs:b?.maxActionWallMs??0,modelCalls:vision?(options.continuousGameTime?3:2):1,inputTokens:options.planningBounds.maximumInputTokens+(vision?(options.continuousGameTime?16384:8192):0),outputTokens:options.planningBounds.maximumOutputTokens+(vision?(options.continuousGameTime?512:256):0),checkpointBytes:options.metadata.maxCheckpointBytes};
    const limits={actions:b?.actionBudget,frames:b?.frameBudget,wallMs:b?.wallBudgetMs,modelCalls:b?.modelCallBudget,inputTokens:b?.inputTokenBudget,outputTokens:b?.outputTokenBudget,checkpointBytes:b?.checkpointByteBudget};
    if(b&&Object.entries(required).some(([key,amount])=>Number((u as any)[key])+Number((h as any)[key]??0)+amount>Number((limits as any)[key]))){resourceExhausted=true;return null;}
   }
   const journal=journals.get(o,record.checkpoint.campaignJournalRef.journalId);
   if(!journal)return refuse('journal_unavailable');let observation=initialObservation??await source.observe(join,signal,record.checkpoint.lastActionReceipt?.actionId??null);
   if(!observation||signal.aborted||!join.runtime.isCurrent()||!current(join.scope))return refuse('observation_unavailable');
   observation=await interpretedObservation(join,observation,signal);if(!observation)return null;
   const selectedBinding=source.bindingFor(join.scope,journal,observation);if(!selectedBinding)return refuse('binding_unavailable');
   const binding=structuredClone(selectedBinding);
   // Only this owner's fully committed receipt/observation pairs can fill new
   // outcome bindings. Journal text or sourceRefs alone never establish lineage.
   for(const entry of journal.entries){
    const settled=settledEntries.get(entry.entryId);if(!settled)continue;
    const row=database?.readGet<{fingerprint:string;settlement_digest:string}>("SELECT fingerprint,settlement_digest FROM activity_controller_reservations WHERE run_id=? AND action_id=? AND state='settled'",join.scope.runId,settled.binding.sourceActionIds[0]);
    if(!isDeepStrictEqual(settled.scope,join.scope)||!isDeepStrictEqual(settled.entry,entry)||!row||row.fingerprint!==settled.fingerprint||row.settlement_digest!==settled.settlementDigest)return refuse('binding_unavailable');
    const existing=binding.entryBindings.find(candidate=>candidate.entryId===entry.entryId);
    if(existing&&!isDeepStrictEqual(existing,settled.binding))return refuse('binding_unavailable');
    if(!existing)binding.entryBindings.push(structuredClone(settled.binding));
   }
   const taskCheck=source.planningTaskFor,planningTask=taskCheck?.(join.scope);
   if(taskCheck&&!planningTask)return refuse('context_unavailable');
   const actionProposalConstraints=source.actionProposalConstraintsFor?.(join.scope);
   if(source.actionProposalConstraintsFor&&!actionProposalConstraints)return refuse('context_unavailable');
   const constraintBoundary={...source.campaignBoundary,...(planningTask?{planningTaskCurrent:(candidate:unknown)=>rawSource.planningTaskFor===taskCheck&&taskCheck?.(join.scope)===candidate}:{}),...(actionProposalConstraints?{actionProposalConstraintsCurrent:(candidate:GameActionProposalConstraints)=>current(join.scope)&&isDeepStrictEqual(source.actionProposalConstraintsFor?.(join.scope),candidate)}:{})};
   const now=Date.now(),selection=selectGameCampaignContext({...(planningTask?{planningTask}:{}),...(actionProposalConstraints?{actionProposalConstraints}:{}),binding,journal,observation,expectedScope:join.scope,pinsDigest:record.checkpoint.pinsDigest,maximumObservationAgeMs:options.maximumObservationAgeMs,freshUntilMs:Math.min(now+planningBounds.deadlineMs,Date.parse(observation.capturedAt)+options.maximumObservationAgeMs),maximumBytes:options.maximumContextBytes,nowMs:now},constraintBoundary);
   if(selection.status==='selected'&&current(join.scope)){planningObservations.set(observation.observationId,structuredClone(observation));if(planningObservations.size>2)planningObservations.delete(planningObservations.keys().next().value!);return {selection,bounds:planningBounds};}return refuse('context_unavailable');
  },
  planningCurrent:(scope,checkpoint)=>current(scope)&&isDeepStrictEqual(scope,checkpoint.scope),
  terminalRef:(result,step)=>{
   if(!step||!current(step.scope)||!gameDecisionHasPreparedIdentity(step.game,step.binding,result.decisionInput)||!safe(()=>source.planningTerminalCurrent(result,step)))return null;
   const o=owner(step.scope),row=o&&checkpoints?.get(o,step.scope.runId);if(!row)return null;
   const previous=completed.get(step);if(previous)return previous.result===result?previous.ref:null;
   const ref='game-planning-completion:'+randomUUID();completed.set(step,{result,ref,ledgerRevision:row.ledgerRevision});return ref;
  },
  publishDecision:(result,step)=>{
   if(!step||published.has(step)||completed.get(step)?.result!==result||!current(step.scope))return false;
   const o=owner(step.scope),row=o&&checkpoints?.get(o,step.scope.runId);if(!row||row.ledgerRevision<=completed.get(step)!.ledgerRevision)return false;
   if(!finalizedTurnDeadlineCurrent(step.turn,step.binding))return false;published.add(step);try{source.onDecision?.(result.proposal,result.intentEvidence.interactionId);}catch{}return true;
  },
  prepareController:async(join,step,_outcome,repository,signal)=>{
   const trace=(phase:string,request?:G.GameActionRequest|null,reason?:GameInputRejection)=>{if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')try{console.info(JSON.stringify({event:'game-controller-preparation-stage',runId:join.scope.runId,phase,observedAtMs:Date.now(),qualification:options.continuousGameTime?(source.ordinaryTargetCurrent?'ownedNative':'semanticComparison'):'reviewedExact',...(reason?{reason}:{}),...(request?{planningObservationId:request.payload.proposal.observationId,dispatchObservationId:request.payload.dispatchValidation.dispatchObservationId,predicateSources:request.payload.dispatchValidation.predicateChecks.map(value=>({fieldId:value.fieldId,sourceObservationId:value.sourceObservationId,matched:value.matched})),issuedAtMs:Date.parse(request.payload.admission.issuedAt),requestExpiresAtMs:Date.parse(request.deadlineAt),admissionExpiresAtMs:Date.parse(request.payload.admission.expiresAt),sourceFreshUntilMs:Date.parse(request.payload.dispatchValidation.preparedContextFreshUntil)}:{})}));}catch{}};trace('entered');
   const result=completed.get(step)?.result;if(!published.has(step)||!result||repository!==checkpoints||signal.aborted||!current(join.scope)||!join.runtime?.controllerCurrent())return refuse('controller_context_unavailable');
   if(result.proposal===null)return null;
   if(!beginGameDispatchValidation(step.game,step.binding,result.decisionInput,result.proposal))return refuse('controller_admission_unavailable');
   trace('dispatch-admitted');const observation=await source.observe(join,signal);trace(observation?'observation-received':'observation-unavailable');if(!observation||signal.aborted||!current(join.scope))return refuse('controller_observation_unavailable');
   let dispatchObservation=observation,dispatchBoundary=source.dispatchBoundary,targetRejected=false;
   if(options.continuousGameTime&&source.ordinaryTargetCurrent){
    // The model used the original interpreted planning observation. This is a
    // separately identified fresh native target sample, not new visual facts.
    // Ordinary bounded gameplay needs ownership/predicates, not another model's
    // fallible opinion that the scene stayed semantically identical.
    const targetCurrent=source.ordinaryTargetCurrent;
    // Pair identity is inert. The original owned-target guard runs once in the
    // normal observation-current slot at each validation pass, not again from
    // every pair-identity comparison. Only failure metadata is latched here.
    dispatchBoundary={...source.dispatchBoundary,ordinaryGameTime:true,sceneCurrent:(before,after)=>before.observationId===result.decisionInput.observationId&&after.observationId===observation.observationId&&source.ordinaryTargetCurrent===targetCurrent,observationCurrent:after=>{const allowed=source.ordinaryTargetCurrent===targetCurrent&&targetCurrent(after);if(!allowed)targetRejected=true;return allowed;}};
   }else if(options.continuousGameTime){
    const planning=planningObservations.get(result.decisionInput.observationId),perceived=await interpretedObservation(join,observation,signal,planning?{observationId:planning.observationId,description:planning.facts.filter(f=>f.extractorRef===planning.providerConfigurationRef).map(f=>f.description).join('\n').slice(0,600)}:undefined);
    if(!planning||!perceived||!source.sameObservedScene||!source.sameObservedScene(planning,perceived)){const reason:GameInputRejection=!planning?'planning_scene_unavailable':!perceived?'current_scene_unavailable':source.sceneRejectionReason?.(planning,perceived)??'scene_comparison_not_confirmed';trace('rejected',undefined,reason);try{source.onRejected?.(result.proposal.proposalId,reason);}catch{}return {kind:'reobserve' as const};}
    // Use the actual compared image, preserving its identity and provenance.
    // An extra un-interpreted capture cannot establish scene compatibility.
    // Continuous native entry checks lineage, not elapsed-frame age.
    dispatchObservation=perceived;dispatchBoundary={...source.dispatchBoundary,ordinaryGameTime:true,sceneCurrent:(before,after)=>before.observationId===planning.observationId&&after.observationId===perceived.observationId&&source.sameObservedScene!(planning,perceived)};
   }
   const dispatch=selectGameDispatchValidation(step.game,step.binding,result.decisionInput,result.proposal,dispatchObservation,dispatchBoundary),validation=gameDispatchValidationFor(dispatch);if(!validation){const reason=targetRejected?'ordinary_target_not_current':dispatch.reason??'dispatch_currentness_lost';trace('rejected',undefined,reason);try{source.onRejected?.(result.proposal.proposalId,reason);}catch{}return options.continuousGameTime?{kind:'reobserve' as const}:refuse('controller_dispatch_validation_unavailable');}
   trace('dispatch-validated');const request=await source.requestFor(join,result,validation,dispatchObservation,signal);trace(request?'request-prepared':'request-unavailable',request);
   if(!request||signal.aborted||!current(join.scope)||!isDeepStrictEqual(request.payload.proposal,result.proposal)||!isDeepStrictEqual(request.payload.dispatchValidation,validation))return refuse('controller_request_unavailable');
   return {game:step.game,binding:step.binding,decision:result.decisionInput,dispatch,request};
  },
  ...(source.waitForObservationChange?{waitForObservationChange:async(join:GameHostJoin,step:PreparedHostGameStep,repository:ActivityCheckpointRepository,signal:AbortSignal)=>{
   const result=completed.get(step)?.result;
   return published.has(step)&&result?.proposal===null&&repository===checkpoints&&!signal.aborted&&current(join.scope)&&await source.waitForObservationChange!(join,signal)===true&&!signal.aborted&&current(join.scope);
  }}:{}),
  controllerCurrent:(checkpoint,request)=>current(request.scope)&&isDeepStrictEqual(checkpoint.scope,request.scope)&&safe(()=>options.metadata.controllerCurrent?.(checkpoint,request)===true),
  recordSettledStep:async(join,input,result,repository,signal=AbortSignal.timeout(settlementTimeoutMs))=>{
   const o=owner(join.scope),receipt=result.result?.outcome.payload;
   if(!o||repository!==checkpoints||!journals||!database||!current(join.scope)||result.state!=='settled'||!receipt||!safe(()=>source.settledSourceCurrent(join,input.request,result)))return null;
   const request=input.request;
   if(!isDeepStrictEqual(request.scope,join.scope)||!isDeepStrictEqual(receipt.scope,request.scope)||receipt.actionId!==request.payload.actionId||receipt.proposalId!==request.payload.proposal.proposalId||receipt.idempotencyKey!==request.idempotencyKey||receipt.admissionId!==request.payload.admission.admissionId||receipt.inputDigest!==request.payload.admission.inputDigest||receipt.buttonsNeutralized!==true)return null;
   const settlement=database.connection.prepare("SELECT fingerprint,settlement_digest FROM activity_controller_reservations WHERE run_id=? AND action_id=? AND state='settled' AND settlement_digest IS NOT NULL").get(join.scope.runId,receipt.actionId);
   if(!settlement||settlement.fingerprint!==fingerprint(request))return null;
   if(source.terminalJournalOptions&&source.terminalReceiptUsageFor){
    const usage=source.terminalReceiptUsageFor(request,result.result!),policy=options.metadata.policyFor(o,join.scope.activityId);
    if(usage&&policy&&fingerprint(usage)===settlement.settlement_digest&&terminalReceipts.size<64){terminalReceipts.set(receipt.actionId,structuredClone({result:result.result!,usage}));terminalMetadataPolicy=structuredClone(policy);}
   }
   const resultingObservation=boundedGameDataSnapshot(await source.observe(join,signal,receipt.actionId),131072) as G.GameObservation|null;
   if(!resultingObservation||!validator.validate(schema+'GameObservation',resultingObservation).valid||signal.aborted||!current(join.scope)||!isDeepStrictEqual(resultingObservation.scope,join.scope)||resultingObservation.previousActionId!==receipt.actionId||resultingObservation.pinsDigest!==request.payload.expectedPinsDigest||resultingObservation.frameNumber<(receipt.afterFrame??Infinity)||Date.parse(resultingObservation.capturedAt)<Date.parse(receipt.completedAt??'')||Date.parse(resultingObservation.capturedAt)>Date.now()||Date.now()-Date.parse(resultingObservation.capturedAt)>options.maximumObservationAgeMs||!safe(()=>source.campaignBoundary.observationCurrent(resultingObservation)))return null;
   const commit=()=>{
   const record=checkpoints!.get(o,join.scope.runId);if(!record)return null;
   const previous=journals!.get(o,record.checkpoint.campaignJournalRef.journalId);if(!previous||previous.entries.some(entry=>entry.sourceRefs.includes('game-action:'+receipt.actionId)))return null;
   const time=new Date().toISOString(),entry={entryId:randomUUID(),kind:'attemptOutcome' as const,epistemicKind:'observation' as const,content:`Recorded controller receipt ${receipt.actionId}: ${receipt.disposition}; ${receipt.framesApplied??'unknown'} frames; controls ${receipt.buttonsNeutralized?'neutralized':'unconfirmed'}. Qualified resulting observation ${resultingObservation.observationId} was captured at frame ${resultingObservation.frameNumber}.`,sourceRefs:['game-action:'+receipt.actionId,...new Set([...receipt.resultingObservationIds,resultingObservation.observationId].map(id=>'game-observation:'+id))],sourceSessionRef:'game-run:'+join.scope.runId,recordedAt:time,limitations:['Controller accounting and resulting observation identity alone do not establish game progress or save persistence.']};
   const journal=journals!.put(o,{...previous,revision:previous.revision+1,entries:[...previous.entries,entry],updatedAt:time},previous.revision);
   const readback=journals!.get(o,journal.journalId);if(!readback||readback.revision!==journal.revision||!readback.entries.some(e=>e.entryId===entry.entryId))return null;
   const next=checkpoints!.put(o,{...record.checkpoint,revision:record.checkpoint.revision+1,stateRevision:record.checkpoint.stateRevision+1,budgetUsed:record.used,lastActionReceipt:receipt,lastObservationId:resultingObservation.observationId,recentObservationIds:[...new Set([...record.checkpoint.recentObservationIds,...receipt.resultingObservationIds,resultingObservation.observationId])].slice(-16),recordedAt:time,campaignJournalRef:{campaignId:journal.campaignId,journalId:journal.journalId,revision:journal.revision,accessRevision:journal.accessRevision}},record.checkpoint.revision);
   const checkpointReadback=checkpoints!.get(o,join.scope.runId);
   if(!checkpointReadback||checkpointReadback.checkpoint.revision!==next.revision||!isDeepStrictEqual(checkpointReadback.checkpoint.campaignJournalRef,next.campaignJournalRef)||!current(join.scope))return null;
   const retainedEntryIds=new Set(readback.entries.map(entry=>entry.entryId));for(const id of settledEntries.keys())if(!retainedEntryIds.has(id))settledEntries.delete(id);
   terminalReceipts.delete(receipt.actionId);
   if(settledEntries.size>=64)return null;
   settledEntries.set(entry.entryId,{scope:structuredClone(join.scope),entry:structuredClone(entry),binding:{entryId:entry.entryId,runId:join.scope.runId,timelineId:join.scope.timelineId,sourceObservationIds:[resultingObservation.observationId],sourceActionIds:[receipt.actionId],sourceAdviceRefs:[],ordinarySaveDigest:null,currentDisposition:'current'},fingerprint:String(settlement.fingerprint),settlementDigest:String(settlement.settlement_digest)});
   const episode=source.episodeFor?.(join,readback,input.request,result,resultingObservation)??null;
   try{source.onSettled?.(receipt);}catch{}
   return {journalCommitted:true as const,...(source.goalReached&&safe(()=>source.goalReached!(resultingObservation))?{goalReached:true as const}:{}),...(episode?{episode}:{})};
   };
   return gamePhase(join.scope.runId,'settlement',async()=>source.runSettlement?source.runSettlement(commit):commit());
  }
 };
 const recordTerminal=(scope:G.ActivityScope,receiptRef:string):boolean=>{
  if(!starts||!sourcePinned()||typeof receiptRef!=='string'||!receiptRef.trim()||receiptRef.length>2048||!source.terminalCurrent||!safe(()=>source.terminalCurrent!(scope,receiptRef)))return false;
  const row=starts.inspect(scope);if(!row)return false;
  const stopped=row.recordedDisposition==='stopped'||row.recordedDisposition==='completed'||starts.noteDisposition(scope,'stopped',row.revision,receiptRef);
  if(stopped&&database){
   const terminal=()=>sourcePinned()&&safe(()=>source.terminalCurrent!(scope,receiptRef));
   reconcileClosedUndispatchedControllers(database,scope,terminal);
   if(source.terminalJournalOptions&&terminalMetadataPolicy&&terminalReceipts.size){
    try{const result=new CampaignJournalRepository(database,source.terminalJournalOptions).recordClosedControllerReceipts(scope,[...terminalReceipts.values()],terminalMetadataPolicy,options.metadata.maxCheckpointBytes,terminal);if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')console.info(JSON.stringify({event:'game-terminal-receipt-audit',runId:scope.runId,state:result?'recorded':'unavailable',...(result??{})}));}catch{if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')console.info(JSON.stringify({event:'game-terminal-receipt-audit',runId:scope.runId,state:'unavailable'}));}
   }
  }
  return stopped;
 };
 return Object.freeze({createRepository,campaign:Object.freeze(campaign),retentionConsentRefFor,recordTerminal});
}
