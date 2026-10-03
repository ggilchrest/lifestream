import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import {ActivityCheckpointRepository,CampaignJournalRepository,type Database,type ActivityMetadataOptions,type CampaignJournalOptions,type GameStartRepository,type GameEpisodeRetention} from '@lifestream/storage-sqlite';
import type * as G from '@lifestream/contracts/game-activity';
import {selectGameCampaignContext,selectGameDispatchValidation,gameDispatchValidationFor,gameDecisionHasPreparedIdentity,type GameCampaignContextBoundary,type GameDispatchBoundary} from '@lifestream/runtime/activity/game-journal';
import type {GameWindowSelection} from '@lifestream/runtime/activity/policy';
import type {GamePlanningBounds,GamePlanningResult} from '@lifestream/runtime/activity/coordinator';
import type {GameHostJoin} from './game-host-port.ts';
import type {PreparedHostGameStep} from './game-host-runtime.ts';
import type {SupervisedGameCampaign} from '../../../../scripts/supervised-game-runtime.mjs';
import {claimConfiguredGameStart} from './game-activity.ts';
import {gameObservationJournalEntries} from './gameplay-grounding.ts';

type Owner={principalId:string;assistantId:string;relationshipId:string};
type MemoryOwner={principalId:string;assistantId:string;relationshipId:string|null};
type Start={policy:G.GamePolicy;bounds:G.GameBounds;window:GameWindowSelection;checkpoint:G.ActivityCheckpoint;journal:G.CampaignJournal};
export type GameCampaignOwnerSource={
 current:(scope:Readonly<G.ActivityScope>)=>boolean;
 startFor:(join:GameHostJoin)=>Start|null;
 observe:(join:GameHostJoin,signal:AbortSignal,afterActionId?:string|null)=>Promise<G.GameObservation|null>;
 bindingFor:(scope:Readonly<G.ActivityScope>,journal:G.CampaignJournal,observation:G.GameObservation)=>G.GameCampaignJournal|null;
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
export function createGameCampaignOwner(options:{metadata:ActivityMetadataOptions;journal:CampaignJournalOptions;startsFor:(database:Database)=>GameStartRepository;source:GameCampaignOwnerSource;planningBounds:GamePlanningBounds;maximumObservationAgeMs:number;maximumContextBytes:number}){
 const rawSource=options.source,source=Object.freeze({...rawSource,campaignBoundary:Object.freeze({...rawSource.campaignBoundary}),dispatchBoundary:Object.freeze({...rawSource.dispatchBoundary})});
 const sourcePinned=()=>Object.entries(source).every(([key,value])=>key==='campaignBoundary'||key==='dispatchBoundary'?Object.entries(value).every(([nested,fn])=>(rawSource as any)[key]?.[nested]===fn):(rawSource as any)[key]===value);
 const planningBounds=Object.freeze({...options.planningBounds});
 let database:Database|undefined,checkpoints:ActivityCheckpointRepository|undefined,journals:CampaignJournalRepository|undefined,starts:GameStartRepository|undefined;
 const completed=new WeakMap<PreparedHostGameStep,{result:GamePlanningResult;ref:string;ledgerRevision:number}>(),published=new WeakSet<PreparedHostGameStep>();
 const current=(scope:G.ActivityScope)=>sourcePinned()&&safe(()=>source.current(scope));
 const campaignBoundary:GameCampaignContextBoundary={...source.campaignBoundary,coreCurrent:(ref,journal)=>{
  const row=database?.connection.prepare('SELECT owner_key FROM campaign_journals WHERE journal_id=?').get(ref.journalId);if(!row||typeof row.owner_key!=='string'||!journals)return false;
  try{const ids=JSON.parse(row.owner_key);if(!Array.isArray(ids)||ids.length!==3||!ids.every(id=>typeof id==='string'))return false;const o={principalId:ids[0] as string,assistantId:ids[1] as string,relationshipId:ids[2] as string},actual=journals.peekCurrent(o,ref.journalId);return !!actual&&sourcePinned()&&actual.revision===ref.revision&&actual.accessRevision===ref.accessRevision&&isDeepStrictEqual(actual,journal)&&source.campaignBoundary.coreCurrent(ref,journal)===true;}catch{return false;}
 }};
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
 const campaign:SupervisedGameCampaign={
  selectPlanning:async(join,repository,signal)=>{
   const o=owner(join.scope);if(!o||repository!==checkpoints||!journals||!starts||signal.aborted||!join.runtime?.isCurrent()||!current(join.scope))return null;
   let record=checkpoints!.get(o,join.scope.runId);
   if(!record){
    const start=source.startFor(join);
    if(!start||!isDeepStrictEqual(start.checkpoint.scope,join.scope)||start.journal.campaignId!==join.scope.campaignId||!current(join.scope))return null;
    if(!claimConfiguredGameStart(starts,{scope:join.scope,policy:start.policy,bounds:start.bounds},start.window))return null;
    journals.put(o,start.journal,0);checkpoints!.put(o,start.checkpoint,0);record=checkpoints!.get(o,join.scope.runId);
   }
   if(!record)return null;const journal=journals.get(o,record.checkpoint.campaignJournalRef.journalId);
   if(!journal)return null;const observation=await source.observe(join,signal,record.checkpoint.lastActionReceipt?.actionId??null);
   if(!observation||signal.aborted||!join.runtime.isCurrent()||!current(join.scope))return null;
   const binding=source.bindingFor(join.scope,journal,observation);if(!binding)return null;
   const now=Date.now(),selection=selectGameCampaignContext({binding,journal,observation,expectedScope:join.scope,pinsDigest:record.checkpoint.pinsDigest,maximumObservationAgeMs:options.maximumObservationAgeMs,freshUntilMs:Math.min(now+planningBounds.deadlineMs,Date.parse(observation.capturedAt)+options.maximumObservationAgeMs),maximumBytes:options.maximumContextBytes,nowMs:now},campaignBoundary);
   return selection.status==='selected'&&current(join.scope)?{selection,bounds:planningBounds}:null;
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
   published.add(step);return true;
  },
  prepareController:async(join,step,_outcome,repository,signal)=>{
   const result=completed.get(step)?.result;if(!published.has(step)||!result||repository!==checkpoints||signal.aborted||!current(join.scope)||!join.runtime?.controllerCurrent())return null;
   if(result.proposal===null)return null;
   const observation=await source.observe(join,signal);if(!observation||signal.aborted||!current(join.scope))return null;
   const dispatch=selectGameDispatchValidation(step.game,step.binding,result.decisionInput,result.proposal,observation,source.dispatchBoundary),validation=gameDispatchValidationFor(dispatch);if(!validation)return null;
   const request=await source.requestFor(join,result,validation,observation,signal);
   if(!request||signal.aborted||!current(join.scope)||!isDeepStrictEqual(request.payload.proposal,result.proposal)||!isDeepStrictEqual(request.payload.dispatchValidation,validation))return null;
   return {game:step.game,binding:step.binding,decision:result.decisionInput,dispatch,request};
  },
  controllerCurrent:(checkpoint,request)=>current(request.scope)&&isDeepStrictEqual(checkpoint.scope,request.scope)&&safe(()=>options.metadata.controllerCurrent?.(checkpoint,request)===true),
  recordSettledStep:async(join,input,result,repository,signal=AbortSignal.timeout(5000))=>{
   const o=owner(join.scope),receipt=result.result?.outcome.payload;
   if(!o||repository!==checkpoints||!journals||!database||!current(join.scope)||result.state!=='settled'||!receipt||!safe(()=>source.settledSourceCurrent(join,input.request,result)))return null;
   const request=input.request;
   if(!isDeepStrictEqual(request.scope,join.scope)||!isDeepStrictEqual(receipt.scope,request.scope)||receipt.actionId!==request.payload.actionId||receipt.proposalId!==request.payload.proposal.proposalId||receipt.idempotencyKey!==request.idempotencyKey||receipt.admissionId!==request.payload.admission.admissionId||receipt.inputDigest!==request.payload.admission.inputDigest||receipt.buttonsNeutralized!==true)return null;
   const settlement=database.connection.prepare("SELECT fingerprint FROM activity_controller_reservations WHERE run_id=? AND action_id=? AND state='settled' AND settlement_digest IS NOT NULL").get(join.scope.runId,receipt.actionId);
   if(!settlement||settlement.fingerprint!==fingerprint(request))return null;
   const resultingObservation=boundedGameDataSnapshot(await source.observe(join,signal,receipt.actionId),131072) as G.GameObservation|null;
   if(!resultingObservation||!validator.validate(schema+'GameObservation',resultingObservation).valid||signal.aborted||!current(join.scope)||!isDeepStrictEqual(resultingObservation.scope,join.scope)||resultingObservation.previousActionId!==receipt.actionId||resultingObservation.pinsDigest!==request.payload.expectedPinsDigest||resultingObservation.frameNumber<(receipt.afterFrame??Infinity)||Date.parse(resultingObservation.capturedAt)<Date.parse(receipt.completedAt??'')||Date.parse(resultingObservation.capturedAt)>Date.now()||Date.now()-Date.parse(resultingObservation.capturedAt)>options.maximumObservationAgeMs||!safe(()=>source.campaignBoundary.observationCurrent(resultingObservation)))return null;
   const record=checkpoints!.get(o,join.scope.runId);if(!record)return null;
   const previous=journals.get(o,record.checkpoint.campaignJournalRef.journalId);if(!previous||previous.entries.some(entry=>entry.sourceRefs.includes('game-action:'+receipt.actionId)))return null;
   const time=new Date().toISOString(),entry={entryId:randomUUID(),kind:'attemptOutcome' as const,epistemicKind:'observation' as const,content:`Recorded controller receipt ${receipt.actionId}: ${receipt.disposition}; ${receipt.framesApplied??'unknown'} frames; controls ${receipt.buttonsNeutralized?'neutralized':'unconfirmed'}. Qualified resulting observation ${resultingObservation.observationId} was captured at frame ${resultingObservation.frameNumber}.`,sourceRefs:['game-action:'+receipt.actionId,...new Set([...receipt.resultingObservationIds,resultingObservation.observationId].map(id=>'game-observation:'+id))],sourceSessionRef:'game-run:'+join.scope.runId,recordedAt:time,limitations:['Controller accounting and resulting observation identity alone do not establish game progress or save persistence.']};
   let journal=journals.put(o,{...previous,revision:previous.revision+1,entries:[...previous.entries,entry,...gameObservationJournalEntries(resultingObservation,receipt,time)],updatedAt:time},previous.revision);
   let readback=journals.get(o,journal.journalId);if(!readback||readback.revision!==journal.revision||!readback.entries.some(e=>e.entryId===entry.entryId))return null;
   const episode=boundedGameDataSnapshot(source.episodeFor?.(join,readback,input.request,result,resultingObservation)??null,16384) as G.GameExperienceEpisode|null;
   if(episode){
    if(!validator.validate(schema+'GameExperienceEpisode',episode).valid||!isDeepStrictEqual(episode.scope,join.scope)||episode.pinsDigest!==resultingObservation.pinsDigest||episode.sourceActionIds.length!==1||episode.sourceActionIds[0]!==receipt.actionId||episode.sourceAdmissionIds.length!==1||episode.sourceAdmissionIds[0]!==receipt.admissionId||episode.sourceObservationIds.length!==1||episode.sourceObservationIds[0]!==resultingObservation.observationId||!current(join.scope))return null;
    const factRefs=[...new Set(readback.entries.filter(e=>e.sourceRefs.includes('game-action:'+receipt.actionId)&&e.sourceRefs.includes('game-observation:'+resultingObservation.observationId)).flatMap(e=>e.sourceRefs.filter(ref=>ref.startsWith('game-fact:'))))];
    const summaryEntry={entryId:randomUUID(),kind:'sessionSummary' as const,epistemicKind:'inference' as const,content:episode.summary,sourceRefs:['game-episode:'+episode.episodeId,'game-action:'+receipt.actionId,'game-observation:'+resultingObservation.observationId,...factRefs],sourceSessionRef:'game-run:'+join.scope.runId,recordedAt:time,limitations:[episode.uncertainty,'Recorded simulated-game history; no save persistence or current-progress claim.']};
    journal=journals.put(o,{...readback,revision:readback.revision+1,entries:[...readback.entries,summaryEntry],updatedAt:time},readback.revision);
    readback=journals.get(o,journal.journalId);if(!readback||readback.revision!==journal.revision||!readback.entries.some(e=>e.entryId===summaryEntry.entryId))return null;
   }
   const next=checkpoints!.put(o,{...record.checkpoint,revision:record.checkpoint.revision+1,stateRevision:record.checkpoint.stateRevision+1,budgetUsed:record.used,lastActionReceipt:receipt,lastObservationId:resultingObservation.observationId,recentObservationIds:[...new Set([...record.checkpoint.recentObservationIds,...receipt.resultingObservationIds,resultingObservation.observationId])].slice(-16),recordedAt:time,campaignJournalRef:{campaignId:journal.campaignId,journalId:journal.journalId,revision:journal.revision,accessRevision:journal.accessRevision}},record.checkpoint.revision);
   const checkpointReadback=checkpoints!.get(o,join.scope.runId);
   if(!checkpointReadback||checkpointReadback.checkpoint.revision!==next.revision||!isDeepStrictEqual(checkpointReadback.checkpoint.campaignJournalRef,next.campaignJournalRef)||!current(join.scope))return null;
   return {journalCommitted:true as const,...(episode?{episode}:{})};
  }
 };
 return Object.freeze({createRepository,campaign:Object.freeze(campaign),retentionConsentRefFor});
}
