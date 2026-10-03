import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot,campaignJournalSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import {GameStartRepository,type Database,type ActivityMetadataOptions,type CampaignJournalOptions,type GameStartLimits} from '@lifestream/storage-sqlite';
import {selectGameWindow,gameWindowCurrent,type GameWindowSelection} from '@lifestream/runtime/activity/policy';
import type {GameHostBinding} from './game-host-port.ts';
import {createGameObservationReader,type GameFrameDecoder} from './game-frame-interpretation.ts';
import type {GameplayCompositionOptions} from './gameplay-composition.ts';

/** Operator-adopted finite run; it is never constructed from client metadata.
 * Existing save/reconciliation and canonical admission owners remain required. */
export type GameplayRun={attachment:GameHostBinding;approvedUntil:string;policy:G.GamePolicy;bounds:G.GameBounds;startLimits:GameStartLimits;checkpoint:G.ActivityCheckpoint;journal:G.CampaignJournal};
export type GameplayRunOwners={
 native:GameplayCompositionOptions['native'];nativeEvidence:GameplayCompositionOptions['nativeEvidence'];
 qualification:GameplayCompositionOptions['qualification'];decoder:GameFrameDecoder;
 runFor:(binding:Readonly<GameHostBinding>)=>GameplayRun|null;
 startCurrent:(run:Readonly<GameplayRun>)=>boolean;
 reconcile:(run:Readonly<GameplayRun>,journal:G.CampaignJournal,observation:G.GameObservation)=>G.GameCampaignJournal|null;
 reconciliationCurrent:(binding:G.GameCampaignJournal,observation:G.GameObservation)=>boolean;
 admitController:GameplayCompositionOptions['campaign']['source']['requestFor'];
 admissionCurrent:(request:Readonly<G.GameActionRequest>)=>boolean;
 historicalSourceCurrent:(owner:Readonly<{principalId:string;assistantId:string;relationshipId:string}>,entry:Readonly<G.CampaignJournal['entries'][number]>)=>boolean;
 retentionFor:GameplayCompositionOptions['grounding']['retentionFor'];
 estimate:GameplayCompositionOptions['grounding']['estimate'];
 maximumSteps:number;maximumRunMs:number;maximumCommandMs:number;maximumOwnedFrames:number;
 planningBounds:GameplayCompositionOptions['campaign']['planningBounds'];maximumObservationAgeMs:number;maximumContextBytes:number;
 onStatus?:GameplayCompositionOptions['onStatus'];
};
type Host={database:()=>Database;current:()=>boolean;quarantined:()=>boolean;readFrame:(scope:Readonly<G.ActivityScope>,observation:Readonly<G.GameObservation>,shot:Readonly<G.GameScreenshot>)=>Buffer|null};
const checked=(fn:()=>boolean)=>{try{return fn()===true;}catch{return false;}};
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';

/** Actual startup adapter over the server's existing owners/repositories, not
 * another runtime or fixture runtime. The trusted operator selects external
 * native, save, admission and qualification owners; absent truth fails closed. */
export function gameplayOptionsFromOwners(input:GameplayRunOwners,host:Host):GameplayCompositionOptions{
 for(const name of ['runFor','startCurrent','reconcile','reconciliationCurrent','admitController','admissionCurrent','historicalSourceCurrent','retentionFor','estimate'] as const)if(typeof input[name]!=='function')throw Error('Missing gameplay owner: '+name);
 const owners={...input},original=input;
 const unchanged=()=>Object.entries(owners).every(([key,value])=>(original as any)[key]===value);
 let run:GameplayRun|null=null,window:GameWindowSelection|null=null,lastWall=Date.now(),clockInvalid=false;
 const owner=(scope:G.ActivityScope)=>({principalId:scope.principalId,assistantId:scope.assistantId,relationshipId:scope.relationshipId!});
 const ownerCurrent=(o:Readonly<{principalId:string;assistantId:string;relationshipId:string|null}>)=>{
  if(!run||!unchanged()||host.quarantined()||!o.relationshipId||!isDeepStrictEqual(o,owner(run.attachment.scope)))return false;
  const db=host.database();return !!db.connection.prepare('SELECT 1 FROM local_accounts WHERE principal_id=? AND disabled=0').get(o.principalId)&&!!db.connection.prepare("SELECT 1 FROM assistant_relationships WHERE relationship_id=? AND assistant_id=? AND user_id=? AND json_extract(payload_json,'$.status')='active'").get(o.relationshipId,o.assistantId,o.principalId);
 };
 const current=(scope:Readonly<G.ActivityScope>)=>{
  const now=Date.now();if(clockInvalid||now<lastWall){clockInvalid=true;return false;}lastWall=now;
  return !!run&&unchanged()&&host.current()&&!host.quarantined()&&now<Date.parse(run.approvedUntil)&&isDeepStrictEqual(scope,run.attachment.scope)&&!!window&&gameWindowCurrent(window,scope,{policy:run.policy,bounds:run.bounds})&&checked(()=>owners.startCurrent(run!))&&checked(()=>owners.native.sourceCurrent(scope));
 };
 const adopt=(binding:Readonly<GameHostBinding>)=>{
  if(run||!unchanged()||!host.current())return false;
  const selected=boundedGameDataSnapshot(owners.runFor(binding),262144) as GameplayRun|null;
  if(!selected||!isDeepStrictEqual(selected.attachment,binding)||!validator.validate(schema+'GamePolicy',selected.policy).valid||!validator.validate(schema+'GameBounds',selected.bounds).valid||!validator.validate(schema+'ActivityCheckpoint',selected.checkpoint).valid||!campaignJournalSnapshot(selected.journal,Date.now())||!isDeepStrictEqual(selected.checkpoint.scope,binding.scope)||selected.checkpoint.pinsDigest!==binding.pinsDigest||selected.checkpoint.campaignJournalRef.journalId!==selected.journal.journalId||selected.journal.campaignId!==binding.scope.campaignId||selected.checkpoint.policyRevision!==selected.policy.revision||selected.startLimits.revision!==selected.policy.revision||!Number.isFinite(Date.parse(selected.approvedUntil))||Date.parse(selected.approvedUntil)<=Date.now()||Date.parse(selected.approvedUntil)>Date.now()+owners.maximumRunMs||!checked(()=>owners.startCurrent(selected)))return false;
  run=selected;window=selectGameWindow({scope:binding.scope,policy:run.policy,bounds:run.bounds,purpose:'play',nowMs:Date.now()},{policyCurrent:()=>unchanged()&&checked(()=>owners.startCurrent(run!))});return current(binding.scope)&&ownerCurrent(owner(binding.scope));
 };
 const metadata:ActivityMetadataOptions={maxRuns:1,maxReservations:64,maxControllerReservations:64,maxCheckpointBytes:32768,scopeCurrent:ownerCurrent,quarantined:host.quarantined,policyFor:o=>run&&ownerCurrent(o)?{enabled:true,revision:run.policy.revision,retentionMs:3600000,bounds:run.bounds}:null,allowCreate:cp=>current(cp.scope)&&isDeepStrictEqual(cp,run?.checkpoint),checkpointCurrent:cp=>current(cp.scope)&&cp.pinsDigest===run?.attachment.pinsDigest,transitionCurrent:(_previous,next)=>current(next.scope),planningCurrent:cp=>current(cp.scope),usageCurrent:cp=>current(cp.scope),controllerCurrent:(cp,request)=>current(cp.scope)&&current(request.scope)&&checked(()=>owners.admissionCurrent(request)),controllerUsageCurrent:(cp,request)=>current(cp.scope)&&current(request.scope)&&checked(()=>owners.admissionCurrent(request))};
 const journal:CampaignJournalOptions={maxJournals:1,maxEntryIdentities:128,maxSourceFences:128,maxJournalBytes:32768,scopeCurrent:ownerCurrent,quarantined:host.quarantined,policyFor:o=>run&&ownerCurrent(o)?{enabled:true,revision:run.policy.revision,retentionMs:3600000,retentionPolicyRef:run.journal.retentionPolicyRef}:null,allowCreate:(o,j)=>ownerCurrent(o)&&current(run!.attachment.scope)&&j.campaignId===run!.journal.campaignId,sourceCurrent:(o,e)=>ownerCurrent(o)&&checked(()=>owners.historicalSourceCurrent(o,e)),journalCurrent:(o,j)=>ownerCurrent(o)&&j.campaignId===run?.journal.campaignId};
 const observe:GameplayCompositionOptions['campaign']['source']['observe']=async(join,signal,afterActionId)=>{
  if(!run||!current(join.scope))return null;
  const read=createGameObservationReader({decoder:owners.decoder,sourceCurrent:current,pinsDigestFor:scope=>current(scope)?run!.attachment.pinsDigest:null,readFrame:async(o,s)=>host.readFrame(o.scope,o,s),maximumDurationMs:owners.maximumCommandMs,maximumBytes:run.bounds.maxScreenshotBytes,maximumLongEdge:run.bounds.maxScreenshotLongEdge,maximumObservationAgeMs:owners.maximumObservationAgeMs});
  return read(join,signal,afterActionId??null);
 };
 const source:GameplayCompositionOptions['campaign']['source']={current,
  startFor:join=>run&&current(join.scope)&&checked(()=>owners.startCurrent(run!))?{policy:run.policy,bounds:run.bounds,checkpoint:run.checkpoint,journal:run.journal,window:window!}:null,
  observe,bindingFor:(scope,j,o)=>current(scope)?owners.reconcile(run!,j,o):null,
  campaignBoundary:{scopeCurrent:(scope,pins)=>current(scope)&&pins===run?.attachment.pinsDigest,coreCurrent:(_ref,j)=>run?.journal.campaignId===j.campaignId&&ownerCurrent(owner(run.attachment.scope)),observationCurrent:o=>current(o.scope)&&checked(()=>owners.decoder.current(o)),reconciliationCurrent:(b,o)=>current(b.scope)&&checked(()=>owners.reconciliationCurrent(b,o))},
  dispatchBoundary:{maxPlanningAgeMs:30000,maxPlanningFrameDelta:120,maximumObservationAgeMs:owners.maximumObservationAgeMs,validatorRef:'lifestream:gameplay-owned-dispatch-v1',observationCurrent:o=>current(o.scope)&&checked(()=>owners.decoder.current(o)),now:Date.now},
  requestFor:async(...args)=>{if(!current(args[0].scope)||args[4].aborted)return null;const request=await owners.admitController(...args);return request&&current(request.scope)&&!args[4].aborted&&checked(()=>owners.admissionCurrent(request))?request:null;},
  planningTerminalCurrent:(_result,step)=>current(step.scope),
  settledSourceCurrent:(join,request,result)=>current(join.scope)&&checked(()=>owners.admissionCurrent(request))&&!!result.result&&checked(()=>owners.native.acceptAction(request,result.result!))};
 const native={...owners.native,resolveAttachment:(actor:Parameters<typeof owners.native.resolveAttachment>[0],raw:Parameters<typeof owners.native.resolveAttachment>[1])=>{const binding=owners.native.resolveAttachment(actor,raw);return binding&&adopt(binding)?binding:null;},bindingCurrent:(actor:Parameters<typeof owners.native.bindingCurrent>[0],binding:GameHostBinding)=>current(binding.scope)&&checked(()=>owners.native.bindingCurrent(actor,binding)),sourceCurrent:current};
 return {native,nativeEvidence:owners.nativeEvidence,maximumOwnedFrames:owners.maximumOwnedFrames,
  campaign:{metadata,journal,startsFor:db=>new GameStartRepository(db,{maxClaims:4,maxAssistantSlots:1,quarantined:host.quarantined,limitsFor:i=>run&&current(i.scope)?run.startLimits:null,admissionCurrent:(i,limits)=>!!run&&current(i.scope)&&isDeepStrictEqual(i.policy,run.policy)&&isDeepStrictEqual(i.bounds,run.bounds)&&isDeepStrictEqual(limits,run.startLimits)&&checked(()=>owners.startCurrent(run!)),inspectionCurrent:current,dispositionCurrent:()=>false}),source,planningBounds:owners.planningBounds,maximumObservationAgeMs:owners.maximumObservationAgeMs,maximumContextBytes:owners.maximumContextBytes},
  grounding:{scopeCurrent:ownerCurrent,quarantined:host.quarantined,retentionFor:owners.retentionFor,maximumFences:4,estimate:owners.estimate},qualification:owners.qualification,
  resolveApproval:scope=>current(scope)?{scope:structuredClone(scope),approvedUntil:run!.approvedUntil,maximumRunMs:owners.maximumRunMs,maximumPlanningSteps:owners.maximumSteps,observations:true,campaignJournal:true,controllerInput:true,memoryEpisodes:true}:null,
  maximumSteps:owners.maximumSteps,maximumRunMs:owners.maximumRunMs,maximumCommandMs:owners.maximumCommandMs,...(owners.onStatus?{onStatus:owners.onStatus}:{})};
}
