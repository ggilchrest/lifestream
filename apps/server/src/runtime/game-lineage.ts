import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot,validateCampaignJournal} from '@lifestream/contracts/game-journal';
import {gameEpisodeSnapshot,gameProjectionSnapshot,gameEpisodeDigest} from '@lifestream/contracts/game-memory';
import type * as G from '@lifestream/contracts/game-activity';
import {createReplayManifest,replayTrace,type ReplayEvent} from '@lifestream/runtime/replay';

/** Offline supplied snapshots only. No receipt authenticates its own authority,
 * current custody, native effect or platform qualification through this API. */
export type GameLineageInput=Readonly<{
 decisions:readonly G.GameDecisionInput[];proposals:readonly G.GameActionProposal[];
 admissions:readonly G.GameAdmission[];actions:readonly G.GameActionReceipt[];
 observations:readonly G.GameObservation[];campaigns:readonly G.GameCampaignJournal[];
 episodes:readonly G.GameExperienceEpisode[];projections:readonly G.GameMemoryProjection[];
 terminalEpisodes:readonly Readonly<{episodeId:string;revision:number;state:'forgotten'|'expired'|'invalidated'}>[];
}>;
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),ref=(v:string)=>`sha256:${hash(v)}`;
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=(v:unknown)=>hash(JSON.stringify(canonical(v))),same=isDeepStrictEqual;
const fail=()=>{throw Error('Invalid bounded game diagnostic snapshot.');};
const fields='actions,admissions,campaigns,decisions,episodes,observations,projections,proposals,terminalEpisodes';
const date=(v:string)=>Date.parse(v),unique=(v:readonly string[])=>new Set(v).size===v.length;
function inputSnapshot(raw:unknown):GameLineageInput{
 const input=boundedGameDataSnapshot(raw,262144) as GameLineageInput|null;
 if(!input||Object.keys(input).sort().join(',')!==fields||Object.values(input).some(v=>!Array.isArray(v)||v.length>32))return fail();
 const groups=[['decisions','GameDecisionInput','viewId'],['proposals','GameActionProposal','proposalId'],['admissions','GameAdmission','admissionId'],['actions','GameActionReceipt','actionId'],['observations','GameObservation','observationId'],['campaigns','GameCampaignJournal','scope'],['episodes','GameExperienceEpisode','episodeId'],['projections','GameMemoryProjection','memoryRecord']] as const;
 for(const [key,type,identity] of groups){
  const rows=input[key] as readonly any[];
  if(rows.some(row=>!validator.validate(schema+type,row).valid)||!unique(rows.map(row=>identity==='scope'?digest([row.scope,row.journal.journalId,row.journal.revision,row.journal.accessRevision]):identity==='memoryRecord'?row.memoryRecord.memoryId:row[identity])))fail();
 }
 for(const e of input.episodes)if(!gameEpisodeSnapshot(e,date(e.recordedAt)))fail();
 for(const p of input.projections)if(!gameProjectionSnapshot(p,date(p.memoryRecord.createdAt),['candidate','active']))fail();
 for(const c of input.campaigns)if(!validateCampaignJournal(c.journal,date(c.journal.updatedAt)))fail();
 for(const t of input.terminalEpisodes)if(Object.keys(t).sort().join(',')!=='episodeId,revision,state'||!validator.validate('https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/UUID',t.episodeId).valid||!Number.isSafeInteger(t.revision)||t.revision<1||!['forgotten','expired','invalidated'].includes(t.state))fail();
 if(!unique(input.terminalEpisodes.map(t=>t.episodeId)))fail();
 return input;
}

export function correlateGameLineage(raw:unknown){
 const input=inputSnapshot(raw),missing=new Set<string>(),contradictions=new Set<string>(),events:Record<string,unknown>[]=[];
 const observations=new Map(input.observations.map(o=>[o.observationId,o])),decisions=new Map(input.decisions.map(d=>[d.viewId,d])),proposals=new Map(input.proposals.map(p=>[p.proposalId,p])),admissions=new Map(input.admissions.map(a=>[a.admissionId,a])),actions=new Map(input.actions.map(a=>[a.actionId,a])),episodes=new Map(input.episodes.map(e=>[e.episodeId,e])),terminal=new Map(input.terminalEpisodes.map(t=>[t.episodeId,t]));
 for(const o of input.observations){
  if(date(o.receivedAt)<date(o.capturedAt)||o.interpretedAt!==null&&date(o.interpretedAt)<date(o.receivedAt)||!unique(o.screenshots.map(s=>s.screenshotId))||o.screenshots.some(s=>s.frameNumber!==o.frameNumber||s.capturedAt!==o.capturedAt)||o.facts.some(f=>f.sourceScreenshotIds.some(id=>!o.screenshots.some(s=>s.screenshotId===id))))contradictions.add('observationSourceMismatch');
  if(o.previousActionId){const a=actions.get(o.previousActionId);if(!a)missing.add('previousActionMissing');else if(!same(o.scope,a.scope)||a.startedAt===null||a.beforeFrame!==null&&o.frameNumber<a.beforeFrame||a.startedAt!==null&&date(o.capturedAt)<date(a.startedAt))contradictions.add('observationActionMismatch');}
  events.push({kind:'observation',observation:ref(o.observationId),revision:o.revision,scope:digest(o.scope),pinsDigest:o.pinsDigest,frameNumber:o.frameNumber,capturedAt:o.capturedAt,receivedAt:o.receivedAt,interpretedAt:o.interpretedAt,previousAction:o.previousActionId?ref(o.previousActionId):null,screenshots:o.screenshots.map(s=>({source:ref(s.screenshotId),sha256:s.sha256,frameNumber:s.frameNumber,capturedAt:s.capturedAt,expiresAt:s.expiresAt})),factIds:o.facts.map(f=>ref(f.factId)),rawMediaAvailable:false});
 }
 for(const d of input.decisions){
  const o=observations.get(d.observationId),c=input.campaigns.find(c=>c.journal.journalId===d.campaignJournalRef.journalId&&c.journal.revision===d.campaignJournalRef.revision&&c.journal.accessRevision===d.campaignJournalRef.accessRevision);
  if(!o)missing.add('decisionObservationMissing');else if(!same(o.scope,d.scope)||o.revision!==d.observationRevision||date(o.receivedAt)>date(d.selectedAt)||o.interpretedAt!==null&&date(o.interpretedAt)>date(d.selectedAt)||d.selectedFactIds.some(id=>!o.facts.some(f=>f.factId===id))||d.selectedVisibleFieldIds.some(id=>!o.visibleState.some(f=>f.fieldId===id)))contradictions.add('decisionObservationMismatch');
  if(!c)missing.add('decisionCampaignMissing');else if(!same(c.scope,d.scope)||c.journal.campaignId!==d.campaignJournalRef.campaignId||c.journal.campaignId!==d.scope.campaignId||d.selectedCampaignGoalIds.some(id=>!c.journal.goals.some(g=>g.goalId===id))||d.selectedCurrentCampaignEntryIds.some(id=>!c.entryBindings.some(e=>e.entryId===id&&e.currentDisposition==='current')))contradictions.add('decisionCampaignMismatch');
  if(date(d.selectedAt)>=date(d.freshUntil))contradictions.add('decisionClockMismatch');
  events.push({kind:'decision',view:ref(d.viewId),revision:d.viewRevision,scope:digest(d.scope),observation:ref(d.observationId),observationRevision:d.observationRevision,selectedAt:d.selectedAt,freshUntil:d.freshUntil,conversationSectionDigest:d.conversationSectionDigest,preparedMemorySectionDigest:d.preparedMemorySectionDigest,inputTokens:d.inputTokens,campaign:ref(d.campaignJournalRef.campaignId),journal:ref(d.campaignJournalRef.journalId),journalRevision:d.campaignJournalRef.revision,adviceRefs:d.adviceRefs.map(ref),authority:false});
 }
 for(const p of input.proposals){
  const d=decisions.get(p.preparedViewId);
  if(!d)missing.add('proposalDecisionMissing');else if(!same(p.scope,d.scope)||p.preparedViewRevision!==d.viewRevision||p.invalidationKey!==d.invalidationKey||p.observationId!==d.observationId||p.observationRevision!==d.observationRevision||p.adviceRefs.some(r=>!d.adviceRefs.includes(r))||p.preconditions.some(c=>c.sourceObservationId!==d.observationId))contradictions.add('proposalDecisionMismatch');
  events.push({kind:'proposal',proposal:ref(p.proposalId),view:ref(p.preparedViewId),scope:digest(p.scope),observation:ref(p.observationId),durationFrames:p.durationFrames,maxWallMs:p.maxWallMs,adviceRefs:p.adviceRefs.map(ref),authority:false});
 }
 for(const a of input.admissions){if(date(a.issuedAt)>=date(a.expiresAt))contradictions.add('admissionClockMismatch');events.push({kind:'admission',admission:ref(a.admissionId),scopeDigest:a.scopeDigest,inputDigest:a.inputDigest,policyRevision:a.policyRevision,issuedAt:a.issuedAt,expiresAt:a.expiresAt,authority:false});}
 for(const a of input.actions){
  const p=proposals.get(a.proposalId),admission=admissions.get(a.admissionId);
  if(!p)missing.add('actionProposalMissing');else if(!same(p.scope,a.scope)||a.framesApplied!==null&&a.framesApplied>p.durationFrames)contradictions.add('actionProposalMismatch');
  if(!admission)missing.add('actionAdmissionMissing');else if(a.inputDigest!==admission.inputDigest||a.startedAt!==null&&(date(a.startedAt)<date(admission.issuedAt)||date(a.startedAt)>=date(admission.expiresAt)))contradictions.add('actionAdmissionMismatch');
  if(a.startedAt!==null&&(a.beforeFrame===null||date(a.startedAt)>date(a.recordedAt))||a.completedAt!==null&&(a.startedAt===null||date(a.completedAt)<date(a.startedAt)||date(a.completedAt)>date(a.recordedAt))||a.framesApplied!==null&&(a.beforeFrame===null||a.afterFrame===null||a.afterFrame-a.beforeFrame!==a.framesApplied))contradictions.add('actionFrameClockMismatch');
  if(['started','completed','failed','outcomeUnknown'].includes(a.disposition)&&a.startedAt===null||['proposed','admitted'].includes(a.disposition)&&a.startedAt!==null)contradictions.add('actionMilestoneMismatch');
  if(a.disposition==='completed'&&(!a.buttonsNeutralized||a.completedAt===null))missing.add('completedActionReleaseMissing');
  if(a.startedAt!==null&&!a.resultingObservationIds.length)missing.add('actionResultObservationMissing');
  for(const id of a.resultingObservationIds){const o=observations.get(id);if(!o)missing.add('actionResultObservationMissing');else if(!same(o.scope,a.scope)||o.previousActionId!==a.actionId||a.afterFrame!==null&&o.frameNumber<a.afterFrame||a.completedAt!==null&&date(o.capturedAt)<date(a.completedAt))contradictions.add('actionResultObservationMismatch');}
  events.push({kind:'actionReceipt',action:ref(a.actionId),proposal:ref(a.proposalId),admission:ref(a.admissionId),scope:digest(a.scope),inputDigest:a.inputDigest,disposition:a.disposition,beforeFrame:a.beforeFrame,afterFrame:a.afterFrame,framesApplied:a.framesApplied,buttonsNeutralized:a.buttonsNeutralized,startedAt:a.startedAt,completedAt:a.completedAt,recordedAt:a.recordedAt,resultingObservationIds:a.resultingObservationIds.map(ref),effectProved:false});
 }
 for(const c of input.campaigns){
  if(c.scope.campaignId!==c.journal.campaignId||c.entryBindings.some(b=>!c.journal.entries.some(e=>e.entryId===b.entryId)))contradictions.add('campaignBindingMismatch');
  events.push({kind:'campaignJournal',scope:digest(c.scope),campaign:ref(c.journal.campaignId),journal:ref(c.journal.journalId),revision:c.journal.revision,accessRevision:c.journal.accessRevision,updatedAt:c.journal.updatedAt,pinsDigest:c.pinsDigest,reconciliationState:c.reconciliationState,entryIds:c.journal.entries.map(e=>ref(e.entryId)),entrySources:c.journal.entries.map(e=>({entry:ref(e.entryId),epistemicKind:e.epistemicKind,recordedAt:e.recordedAt,sourceRefs:e.sourceRefs.map(ref)})),ordinarySaveDigest:c.ordinarySaveArtifact?.artifact.sha256??null,ordinarySaveReadbackProved:false});
 }
 for(const e of input.episodes){
  const t=terminal.get(e.episodeId);if(t){if(t.revision<=e.revision)contradictions.add('terminalEpisodeRevisionMismatch');continue;}
  for(const id of e.sourceObservationIds){const o=observations.get(id);if(!o)missing.add('episodeObservationMissing');else if(!same(o.scope,e.scope)||o.pinsDigest!==e.pinsDigest||o.frameNumber<e.frameRange.from||o.frameNumber>e.frameRange.to||date(o.capturedAt)<date(e.occurredFrom)||date(o.capturedAt)>date(e.occurredTo))contradictions.add('episodeObservationMismatch');}
  for(const id of e.sourceActionIds){const a=actions.get(id);if(!a)missing.add('episodeActionMissing');else if(!same(a.scope,e.scope)||!e.sourceAdmissionIds.includes(a.admissionId)||a.startedAt===null||a.beforeFrame===null||a.beforeFrame<e.frameRange.from||a.afterFrame!==null&&a.afterFrame>e.frameRange.to||date(a.recordedAt)>date(e.recordedAt))contradictions.add('episodeActionMismatch');}
  if(e.adviceRefs.length)missing.add('authenticatedAdviceCustodyMissing');
  events.push({kind:'retainedEpisode',episode:ref(e.episodeId),revision:e.revision,scope:digest(e.scope),sourceDigest:gameEpisodeDigest(e),pinsDigest:e.pinsDigest,sourceFamily:ref(e.independenceKey),occurredFrom:e.occurredFrom,occurredTo:e.occurredTo,recordedAt:e.recordedAt,expiresAt:e.expiresAt,actionIds:e.sourceActionIds.map(ref),observationIds:e.sourceObservationIds.map(ref),adviceRefs:e.adviceRefs.map(ref),rawMediaAvailable:false});
 }
 for(const p of input.projections){const e=episodes.get(p.episode.episodeId),t=terminal.get(p.episode.episodeId);if(t){if(t.revision<=p.episode.revision)contradictions.add('terminalEpisodeRevisionMismatch');continue;}if(!e)missing.add('projectionEpisodeMissing');else if(!same(e,p.episode))contradictions.add('projectionEpisodeMismatch');events.push({kind:'memoryProjection',episode:ref(p.episode.episodeId),revision:p.episode.revision,memory:ref(p.memoryRecord.memoryId),sourceDigest:gameEpisodeDigest(p.episode),factuality:p.memoryRecord.factuality,status:p.memoryRecord.status,transformationConfidence:p.memoryRecord.confidence,createdAt:p.memoryRecord.createdAt});}
 for(const t of input.terminalEpisodes)events.push({kind:'terminalEpisode',episode:ref(t.episodeId),revision:t.revision,state:t.state});
 for(const name of ['decisions','actions','observations','campaigns','episodes'] as const)if(!input[name].length)missing.add(name+'CoverageMissing');
 return {schemaVersion:'1.0.0',kind:'supplied-game-diagnostic-lineage',status:contradictions.size?'contradictoryMetadata':'partialDiagnosticCorrelation',coverage:'bounded_best_effort',contradictions:[...contradictions].sort(),missingEvidence:[...missing].sort(),events,claimsRuntimeAcceptance:false,sourceCurrencyProved:false,nativeEffectsProved:false,perceptionQualityProved:false,rawMediaAvailable:false,qualificationGaps:['Authenticated prepared-input/admission/controller source custody and actual monotonic execution remain unproved.','Actual graphical ordinary-speed display, interruption pause/neutral controls and separate Linux/Windows qualification remain unproved.','Ordinary-save flush, durable readback/restart/load and honest crash-loss recovery remain unproved.','Configured-hours, contact/attachment delivery/authenticated advice and native causal outcomes remain separately qualified.','Selected-provider screen interpretation, paired speech/resource/onset and Human relevance/control remain unproved.','Journal and memory payloads are supplied snapshots, not proof of current retention or consent. Terminal episode metadata suppresses stale episode/projection payloads.']};
}

/** Re-derive a redacted trace; no caller runner, provider, capture, save, contact
 * or learning callback is accepted or imported. Equality is metadata only. */
export async function replayGameLineage(input:unknown){
 const correlation=correlateGameLineage(input),sourceTraceId=`game-diagnostics:${digest(correlation)}`,replayId=randomUUID();
 const manifest=createReplayManifest({replayId,sourceTraceId,artifactRefs:[`sha256:${digest(correlation)}`],providerRefs:['derived:game-diagnostic-metadata-v1']});
 const events:ReplayEvent[]=correlation.events.map((payload,index)=>({id:`${sourceTraceId}:${index}`,traceId:sourceTraceId,sequence:index,payload}));
 const replay=await replayTrace(events,manifest,{idFactory:()=>randomUUID()});
 return {correlation,manifest,...replay,claimsRuntimeAcceptance:false,liveEffects:false,durableReinforcement:false,perceptionReplayed:false};
}
