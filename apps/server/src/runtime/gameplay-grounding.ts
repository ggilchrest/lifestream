import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {gameEpisodeDigest,gameEpisodeSnapshot} from '@lifestream/contracts/game-memory';
import type * as G from '@lifestream/contracts/game-activity';
import {CampaignJournalRepository,type Database,type CampaignJournalOptions,type GameEpisodeSources,type GameEpisodeRetention} from '@lifestream/storage-sqlite';
import type {GameCampaignOwnerSource} from './game-campaign-owner.ts';
import type {GameMemoryHostOptions} from './game-memory.ts';

type Owner={principalId:string;assistantId:string;relationshipId:string|null};
type Entry=G.CampaignJournal['entries'][number];
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const facts=(o:G.GameObservation)=>o.facts.filter(f=>f.sourceScreenshotIds.length>0&&f.sourceScreenshotIds.every(id=>o.screenshots.some(s=>s.screenshotId===id))).slice(0,4);
/** Describe only qualified visible facts. A completed control never establishes
 * the model's expected outcome, story milestone or ordinary-save persistence. */
export function gameObservationJournalEntries(o:G.GameObservation,receipt:G.GameActionReceipt,time:string):Entry[]{
 return facts(o).map(f=>({entryId:randomUUID(),kind:'currentSituation',epistemicKind:f.epistemicKind==='visibleFeature'?'observation':'inference',content:f.description,sourceRefs:['game-observation:'+o.observationId,'game-fact:'+f.factId,'game-action:'+receipt.actionId],sourceSessionRef:'game-run:'+o.scope.runId,recordedAt:time,limitations:[...f.limitations,'Simulated game observation; historical after this frame. No current-progress or save-persistence claim.',f.uncertainty].filter(Boolean)}));
}
const summary=(o:G.GameObservation,r:G.GameActionReceipt)=>`Recorded ${r.disposition} controller attempt (${r.framesApplied} frames, controls neutralized). Resulting player-visible observation: ${facts(o).map(f=>`${f.epistemicKind==='inference'?'Interpretation':'Visible feature'}: ${f.description}`).join(' ')}`;
export type GameplayGroundingOptions={database:()=>Database;journal:CampaignJournalOptions;scopeCurrent:(owner:Readonly<Owner>)=>boolean;quarantined:()=>boolean;retentionFor:(owner:Readonly<Owner>,activityId:string)=>{policyRevision:number;retention:GameEpisodeRetention}|null;publicationCurrent:(scope:Readonly<G.ActivityScope>)=>boolean;maximumFences:number;estimate:GameMemoryHostOptions['estimate']};

/** Selected episode sources are captured from the genuinely settled ledger and
 * freshly observed result. Durable journal custody controls later historical
 * retrieval; the live planning lease cannot authorize historical memory. */
export function createGameplayGrounding(options:GameplayGroundingOptions){
 const original=options,pins={...options};options=Object.freeze({...options,journal:Object.freeze({...options.journal})});
 const unchanged=()=>Object.entries(pins).every(([k,v])=>(original as any)[k]===v)&&Object.entries(options.journal).every(([k,v])=>(original.journal as any)[k]===v);
 const pending=new Map<string,{episode:G.GameExperienceEpisode;sources:GameEpisodeSources}>();
 const owner=(scope:G.ActivityScope):Owner=>({principalId:scope.principalId,assistantId:scope.assistantId,relationshipId:scope.relationshipId});
 const episodeReferenceCurrent=(o:Readonly<Owner>,ref:string)=>{
  if(!ref.startsWith('game-episode:'))return true;
  const id=ref.slice(13),row=options.database().connection.prepare('SELECT owner_key,state,payload_json,expires_at FROM game_experience_episodes WHERE episode_id=?').get(id);
  if(row)return row.owner_key===hash([o.principalId,o.assistantId,o.relationshipId])&&row.state==='retained'&&row.payload_json!==null&&Number(row.expires_at)>Date.now();
  const p=pending.get(id);return !!p&&isDeepStrictEqual(owner(p.episode.scope),o)&&Date.parse(p.episode.expiresAt)>Date.now()&&options.publicationCurrent(p.episode.scope);
 };
 const journal:CampaignJournalOptions=Object.freeze({...options.journal,sourceCurrent:(o,entry)=>unchanged()&&options.journal.sourceCurrent(o,entry)&&entry.sourceRefs.every(ref=>episodeReferenceCurrent(o,ref))});
 const retentionFor=(o:Readonly<Owner>,id:string)=>{
  if(!unchanged())return null;
  const p=options.retentionFor(o,id);if(!p||!Number.isSafeInteger(p.policyRevision)||p.policyRevision<1)return null;
  const r=p.retention;
  return Number.isSafeInteger(r.retentionMs)&&r.retentionMs>=1&&r.retentionMs<=3600000&&Number.isSafeInteger(r.maximumEpisodes)&&r.maximumEpisodes>=1&&r.maximumEpisodes<=4&&Number.isSafeInteger(r.maximumBytes)&&r.maximumBytes>=1&&r.maximumBytes<=8192&&typeof r.retentionPolicyRef==='string'&&r.retentionPolicyRef.trim()?p:null;
 };
 const retained=(e:Readonly<G.GameExperienceEpisode>)=>{
  try{
   const o=owner(e.scope);if(!unchanged()||!o.relationshipId||!options.scopeCurrent(o)||options.quarantined())return false;
   const journals=new CampaignJournalRepository(options.database(),journal);
   const rows=options.database().connection.prepare('SELECT journal_id FROM campaign_journals WHERE campaign_id=? AND state=\'active\'').all(e.scope.campaignId) as {journal_id:string}[];
   return rows.some(row=>{const journal=journals.peekCurrent({...o,relationshipId:o.relationshipId!},row.journal_id);return !!journal&&e.sourceActionIds.every(id=>journal.entries.some(entry=>entry.sourceRefs.includes('game-action:'+id)))&&e.sourceObservationIds.every(id=>journal.entries.some(entry=>entry.sourceRefs.includes('game-observation:'+id)))&&journal.entries.some(entry=>entry.content===e.summary&&entry.sourceRefs.includes('game-episode:'+e.episodeId));});
  }catch{return false;}
 };
 const episodeFor:NonNullable<GameCampaignOwnerSource['episodeFor']>=(join,journal,request,result,observation)=>{
  try{
   const r=result.result?.outcome.payload,o=owner(join.scope),policy=retentionFor(o,join.scope.activityId),now=Date.now();
   if(!r||result.state!=='settled'||!policy||!facts(observation).length||!options.publicationCurrent(join.scope)||!isDeepStrictEqual(join.scope,observation.scope)||observation.previousActionId!==r.actionId||pending.size>=options.maximumFences)return null;
   const row=options.database().connection.prepare("SELECT fingerprint FROM activity_controller_reservations WHERE run_id=? AND action_id=? AND state='settled' AND settlement_digest IS NOT NULL").get(join.scope.runId,r.actionId);
   if(!row||row.fingerprint!==hash(request)||r.startedAt===null||r.beforeFrame===null||r.afterFrame===null||!r.buttonsNeutralized||r.disposition==='outcomeUnknown'||observation.frameNumber<r.afterFrame||Date.parse(observation.capturedAt)<Date.parse(r.completedAt??''))return null;
   const entryIds=journal.entries.filter(entry=>entry.sourceRefs.includes('game-action:'+r.actionId)&&entry.sourceRefs.includes('game-observation:'+observation.observationId)).map(entry=>entry.entryId);
   if(!entryIds.length)return null;
   const e:G.GameExperienceEpisode={schemaVersion:'1.0.0',recordType:'gameExperienceEpisode',scope:structuredClone(join.scope),episodeId:randomUUID(),revision:1,pinsDigest:observation.pinsDigest,policyRevision:policy.policyRevision,frameRange:{from:r.beforeFrame,to:observation.frameNumber},occurredFrom:r.startedAt,occurredTo:observation.capturedAt,rawEvidenceAvailability:'notRetained',sourceAdmissionIds:[r.admissionId],summary:summary(observation,r),sourceObservationIds:[observation.observationId],sourceActionIds:[r.actionId],independenceKey:r.actionId,sourceKind:'simulatedGameExperience',uncertainty:'Only the recorded resulting view is supported. Intended outcome, hidden causes, current progress and ordinary-save persistence are unproved.',adviceRefs:[],recordedAt:new Date(now).toISOString(),retentionPolicyRef:policy.retention.retentionPolicyRef,expiresAt:new Date(Date.parse(r.startedAt)+policy.retention.retentionMs).toISOString(),state:'retained',untrusted:true};
   if(!gameEpisodeSnapshot(e,now)||Buffer.byteLength(JSON.stringify(e))>policy.retention.maximumBytes)return null;
   pending.set(e.episodeId,{episode:structuredClone(e),sources:{observations:[structuredClone(observation)],actions:[structuredClone(r)]}});return e;
  }catch{return null;}
 };
 const memory:GameMemoryHostOptions={maximumCandidates:4,estimate:options.estimate,source:{maximumFences:options.maximumFences,scopeCurrent:o=>unchanged()&&options.scopeCurrent(o),quarantined:()=>!unchanged()||options.quarantined(),retentionFor:(o,id)=>retentionFor(o,id)?.retention??null,sourceRecordsFor:e=>{const p=pending.get(e.episodeId);return unchanged()&&p&&gameEpisodeDigest(e)===gameEpisodeDigest(p.episode)?structuredClone(p.sources):null;},meaningfulGroundingCurrent:(e,s)=>{const p=pending.get(e.episodeId);return !!p&&isDeepStrictEqual(p.sources,s)&&e.summary===summary(s.observations[0]!,s.actions[0]!)&&retained(e);},publicationCurrent:e=>options.publicationCurrent(e.scope)&&retained(e),retainedSourceCurrent:retained}};
 return Object.freeze({episodeFor,memory,journal,retentionFor,clearPending:()=>pending.clear()});
}
