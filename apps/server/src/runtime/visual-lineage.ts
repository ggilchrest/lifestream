import {createHash,randomUUID} from 'node:crypto';
import {types,isDeepStrictEqual} from 'node:util';
import {validateVisualEpisode,validateVisualMemoryProjection,type VisualObservationEpisode,type VisualMemoryProjection} from '@lifestream/contracts/visual-memory';
import {createReplayManifest,replayTrace,type ReplayEvent} from '@lifestream/runtime/replay';
import type {VisualPublicationReceipt} from './visual-input.ts';
import type {VisualTurnReceipt} from './visual-turn-evidence.ts';
import type {VisualLifecycleReceipt} from './visual-lifecycle-evidence.ts';

/** Supplied diagnostic snapshots carry no consent, identity or action authority.
 * The caller must obtain scoped receipts through their existing host/repository.
 * This correlator is deliberately outside the conversational hot path. */
export type VisualLineageInput=Readonly<{
 publications:readonly VisualPublicationReceipt[];
 turns:readonly VisualTurnReceipt[];
 episodes:readonly VisualObservationEpisode[];
 projections:readonly VisualMemoryProjection[];
 terminalSources:readonly Readonly<{episodeId:string;revision:number;state:'forgotten'|'expired'|'invalidated'}>[];
 lifecycle?:readonly VisualLifecycleReceipt[];
}>;
const maximumBytes=4*1024*1024,maximumRows=128;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const digest=(value:unknown)=>hash(JSON.stringify(value));
const scopeDigest=(scope:unknown)=>digest(Object.fromEntries(Object.entries(scope as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b))));
const id=(value:string)=>`sha256:${hash(value)}`;
// Match the producer's labeled truncation digests without equating them with raw
// identity or silently treating a long source binding as a different source.
const diagnosticId=(value:string)=>Buffer.byteLength(value)<=256?value:`sha256:${hash(value)}`;
const diagnosticScope=(scope:VisualObservationEpisode['scope'])=>Object.fromEntries(Object.entries(scope).map(([key,value])=>[key,typeof value==='string'?diagnosticId(value):value]));
function providerBindingMatches(value:string,p:VisualPublicationReceipt){
 try{const fields=JSON.parse(value);return Array.isArray(fields)&&fields.length===4&&fields.slice(0,3).every(string)&&orderedSame([diagnosticId(fields[0]),diagnosticId(fields[1]),diagnosticId(fields[2]),fields[3]],[p.admission.provider.id,p.admission.provider.version,p.admission.scope.sourceBindingRef,p.admission.scope.captureConfigurationRevision]);}catch{return false;}
}
const fail=()=>{throw Error('Invalid bounded visual diagnostic snapshot.');};
const number=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=8640000000000000;
const milliseconds=(value:number)=>new Date(value).getTime();
const string=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=4096;
const hex=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const list=(value:unknown):value is unknown[]=>Array.isArray(value)&&value.length<=maximumRows;
const strings=(value:unknown)=>Array.isArray(value)&&value.length<=128&&value.every(string)&&new Set(value).size===value.length;
const keys=(value:unknown,expected:string):boolean=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected.split(',').sort().join(',');
const oneOf=(value:unknown,values:string)=>typeof value==='string'&&values.split(',').includes(value);

/** Reject accessors, proxies, cycles, binary data and excess size before reading
 * arbitrary fields or serializing. A detached copy prevents later mutation. */
function snapshot(input:unknown):VisualLineageInput{
 let nodes=0,bytes=0;const seen=new Set<object>();
 const plain=(value:unknown,depth=0):boolean=>{
  if(++nodes>100000||depth>24)return false;
  if(typeof value==='string'){bytes+=Buffer.byteLength(value)+2;return bytes<=maximumBytes;}
  if(value===null||typeof value==='boolean')return true;if(typeof value==='number')return Number.isFinite(value);
  if(typeof value!=='object'||types.isProxy(value)||seen.has(value))return false;
  const array=Array.isArray(value);if(Object.getPrototypeOf(value)!==(array?Array.prototype:Object.prototype))return false;
  seen.add(value);const own=Reflect.ownKeys(value);
  if(own.length>100000||array&&own.length!==(value as unknown[]).length+1)return false;
  const valid=own.every(key=>{if(typeof key!=='string')return false;bytes+=Buffer.byteLength(key)+4;const descriptor=Object.getOwnPropertyDescriptor(value,key)!;return bytes<=maximumBytes&&(array&&key==='length'||descriptor.enumerable===true&&Object.hasOwn(descriptor,'value')&&plain(descriptor.value,depth+1));});
  seen.delete(value);return valid;
 };
 try{if(!plain(input))return fail();const text=JSON.stringify(input);if(Buffer.byteLength(text)>maximumBytes)return fail();return JSON.parse(text) as VisualLineageInput;}catch{return fail();}
}
function validate(input:VisualLineageInput){
 if(!keys(input,'publications,turns,episodes,projections,terminalSources')&&!keys(input,'publications,turns,episodes,projections,terminalSources,lifecycle')||![input.publications,input.turns,input.episodes,input.projections,input.terminalSources,input.lifecycle??[]].every(list))fail();
 for(const l of input.lifecycle??[]){
  if(!keys(l,'eventId,sequence,occurredAtMs,kind,reason,scopeDigest,leaseDigest,clockMappingDigest,requestDigest,correlationDigest,hostSequence,sourceEpochs,providerDigest,frames,selectedVersion,observedCaptureActive,coverage,authority')||
   !string(l.eventId)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(l.eventId)||!number(l.sequence)||l.sequence<1||!time(l.occurredAtMs)||
   !oneOf(l.kind,'negotiated,cameraEnabled,cameraEnableInactive,cameraRenewed,cameraRenewInactive,cameraInactiveObserved,cameraStopNoop,captureLeaseEnded,batchAdmitted,batchRejected,batchFailed,cameraRejected,contextExpired')||
   !(l.reason===null||oneOf(l.reason,'disabled,unsupported,unconfigured,source_unavailable,permission_denied,lease_conflict,stale_revision,stale_lease,scope_changed,clock_challenge_invalid,clock_uncertain,frame_invalid,frame_oversize,frame_stale,frame_future,rate_limited,foreground_priority,provider_unavailable,provider_invalid,deadline,replaced,cancelled,stop,expired,invalidated,host_processing_failed'))||
   ![l.scopeDigest,l.leaseDigest,l.clockMappingDigest,l.requestDigest,l.correlationDigest,l.providerDigest].every(value=>value===null||hex(value))||!(l.hostSequence===null||number(l.hostSequence))||
   l.sourceEpochs!==null&&(!keys(l.sourceEpochs,'session,audience,generation,configuration')||!Object.values(l.sourceEpochs).every(number))||
   !Array.isArray(l.frames)||l.frames.length>3||l.frames.some(f=>!keys(f,'frameDigest,sequence,capturedMonotonicMs,clockMappingDigest')||!hex(f.frameDigest)||!(f.sequence===null||number(f.sequence))||!(f.capturedMonotonicMs===null||time(f.capturedMonotonicMs))||!(f.clockMappingDigest===null||hex(f.clockMappingDigest)))||
   !(l.selectedVersion===null||l.selectedVersion==='1.0.0')||!(l.observedCaptureActive===null||typeof l.observedCaptureActive==='boolean')||l.coverage!=='bounded_best_effort'||l.authority!==false)fail();
 }
 for(const p of input.publications){
  const a=p.admission,s=a?.scope;
  if(!keys(p,'admission,publication,perceptionStatus,disposition,reason,observationIds,completedAtMs,captureFreshUntilMs')||
   !keys(a,'requestId,correlationId,leaseId,scope,frameIds,hostSequence,provider,capturedAtEarliestMs,capturedAtLatestMs,receivedAtMs,deadlineAtMs,clockMappingId,leaseRevision')||
   !keys(s,'assistantId,principalId,relationshipId,environmentId,conversationId,sessionId,endpointId,sessionRevision,audienceRevision,scopeGeneration,sourceBindingRef,captureConfigurationRevision')||
   ![a.requestId,a.correlationId,a.leaseId,a.clockMappingId,s.assistantId,s.principalId,s.environmentId,s.conversationId,s.sessionId,s.endpointId,s.sourceBindingRef].every(string)||!(s.relationshipId===null||string(s.relationshipId))||
   ![a.hostSequence,a.leaseRevision,s.sessionRevision,s.audienceRevision,s.scopeGeneration,s.captureConfigurationRevision].every(number)||![a.capturedAtEarliestMs,a.capturedAtLatestMs,a.receivedAtMs,a.deadlineAtMs,p.completedAtMs,p.captureFreshUntilMs].every(time)||
   !keys(a.provider,'id,version')||!Object.values(a.provider).every(string)||!strings(a.frameIds)||!a.frameIds.length||!strings(p.observationIds)||
   !oneOf(p.perceptionStatus,'complete,empty,rejected,timedOut,cancelled,failed')||!oneOf(p.disposition,'published,withdrawn,deferred,discarded')||
   !oneOf(p.reason,'published,no_observations,scheduler_deferral,scope_changed,provider_unavailable,audience_rebind_failed,observation_expired,observation_not_admitted,perception_unsuccessful,host_processing_failed')||
   p.publication!==null&&(!keys(p.publication,'audienceRevision,leaseRevision')||!Object.values(p.publication).every(number))||
   a.capturedAtEarliestMs>a.capturedAtLatestMs||a.capturedAtEarliestMs>a.receivedAtMs||a.receivedAtMs>p.completedAtMs||a.receivedAtMs>=a.deadlineAtMs)fail();
  if(p.disposition==='published'&&(p.reason!=='published'||p.perceptionStatus!=='complete'||!p.observationIds.length||!p.publication||p.completedAtMs>=p.captureFreshUntilMs))fail();
 }
 for(const t of input.turns){
  const l=t.lineage,s=l?.selected,f=t.finalized;
  if(!keys(t,'interactionId,modality,sequence,occurredAtMs,stage,outcome,channel,receivedSamples,lineage,finalized,coverage,endpointAcknowledged')||!string(t.interactionId)||!number(t.sequence)||t.sequence<1||!time(t.occurredAtMs)||
   !oneOf(t.modality,'text,audio')||!oneOf(t.stage,'finalized,admissionRejected,providerInvoked,generationEnded,outputEmitted,synthesisCompleted,playbackFenced,endpointSettled,turnEnded')||
   !(t.outcome===null||oneOf(t.outcome,'completed,exhausted,failed,cancelled,invalidated,deadline,disconnected,stopped,timeout,context_unavailable,provider_unavailable'))||!(t.channel===null||oneOf(t.channel,'text,audio'))||!(t.receivedSamples===null||number(t.receivedSamples))||
   t.coverage!=='bounded_best_effort'||typeof t.endpointAcknowledged!=='boolean'||!keys(l,'selectionReason,selected,publication')||!oneOf(l.selectionReason,'selected,clock_unavailable,invalid_input,scope_unavailable,capture_unavailable,provider_unavailable,no_observations,withdrawn,expired,unengaged,aside_interval,exposure_capacity,unchanged_scene,no_topic_relevance,budget,expiry_capacity')||
   s!==null&&(!keys(s,'requestId,sourceRevision,leaseId,audienceRevision,captureConfigurationRevision,capturedAtEarliestMs,capturedAtLatestMs,expiresAtMs,observationIds,frameIds')||![s.requestId,s.leaseId].every(string)||![s.sourceRevision,s.audienceRevision,s.captureConfigurationRevision].every(number)||![s.capturedAtEarliestMs,s.capturedAtLatestMs,s.expiresAtMs].every(time)||!strings(s.observationIds)||!strings(s.frameIds)||!s.observationIds.length||!s.frameIds.length||s.capturedAtEarliestMs>s.capturedAtLatestMs||s.capturedAtLatestMs>=s.expiresAtMs)||
   l.publication!==null&&(!keys(l.publication,'requestId,hostSequence,audienceRevision,leaseRevision,clockMappingId')||![l.publication.requestId,l.publication.clockMappingId].every(string)||![l.publication.hostSequence,l.publication.audienceRevision,l.publication.leaseRevision].every(number))||
   f!==null&&(!keys(f,'viewId,revision,invalidationKey,manifestDigest,conversationSectionDigest,visualIncluded,sections')||!(f.viewId===null||string(f.viewId))||!(f.revision===null||number(f.revision))||!(f.invalidationKey===null||string(f.invalidationKey))||!hex(f.manifestDigest)||!hex(f.conversationSectionDigest)||typeof f.visualIncluded!=='boolean'||!Array.isArray(f.sections)||f.sections.length!==9||f.sections.some(section=>!keys(section,'kind,contentDigest,tokenCount')||!oneOf(section.kind,'policy,corePersona,adaptivePersona,interactionState,preparedMemory,worldContext,capabilityState,conversation,userInput')||!hex(section.contentDigest)||!number(section.tokenCount))||new Set(f.sections.map(section=>section.kind)).size!==9||f.sections.find(section=>section.kind==='conversation')?.contentDigest!==f.conversationSectionDigest))fail();
  if(t.endpointAcknowledged&&(t.stage!=='endpointSettled'||t.modality!=='audio'||!oneOf(t.outcome,'completed,stopped')))fail();
  if(s===null&&l.publication!==null||s!==null&&l.selectionReason!=='selected'||f?.visualIncluded&&s===null)fail();
 }
 for(const e of input.episodes)if(!validateVisualEpisode(e).valid||e.sourceDigest!==digest({scope:e.scope,observations:e.observations}))fail();
 for(const p of input.projections)if(!validateVisualMemoryProjection(p).valid)fail();
 for(const t of input.terminalSources)if(!keys(t,'episodeId,revision,state')||!string(t.episodeId)||!number(t.revision)||!oneOf(t.state,'forgotten,expired,invalidated'))fail();
 for(const [rows,key] of [[input.publications,(p:VisualPublicationReceipt)=>p.admission.requestId],[input.episodes,(e:VisualObservationEpisode)=>e.episodeId],[input.projections,(p:VisualMemoryProjection)=>p.memoryRecord.memoryId],[input.terminalSources,(t:VisualLineageInput['terminalSources'][number])=>t.episodeId]] as const){
  const values=rows.map(row=>(key as (value:unknown)=>string)(row));if(new Set(values).size!==values.length)fail();
 }
}
const subset=(items:readonly string[],sources:readonly string[])=>items.every(item=>sources.includes(item));
const orderedSame=(a:unknown,b:unknown)=>isDeepStrictEqual(a,b);

/** Partial diagnostics only: matching supplied IDs is not authenticated source
 * currency, source completeness, perception quality or runtime acceptance. */
export function correlateVisualLineage(value:unknown){
 const input=snapshot(value);validate(input);
 const contradictions=new Set<string>(),missing=new Set<string>();
 const publicationById=new Map(input.publications.map(p=>[p.admission.requestId,p]));
 const events:Record<string,unknown>[]=input.publications.map(p=>({kind:'publication',request:id(p.admission.requestId),scope:scopeDigest(p.admission.scope),lease:id(p.admission.leaseId),clockMapping:id(p.admission.clockMappingId),hostSequence:p.admission.hostSequence,publicationAudienceRevision:p.publication?.audienceRevision??null,publicationLeaseRevision:p.publication?.leaseRevision??null,sourceEpochs:{session:p.admission.scope.sessionRevision,audience:p.admission.scope.audienceRevision,generation:p.admission.scope.scopeGeneration,configuration:p.admission.scope.captureConfigurationRevision},provider:digest(p.admission.provider),frameIds:p.admission.frameIds.map(id),observationIds:p.observationIds.map(id),captureFromMs:p.admission.capturedAtEarliestMs,captureToMs:p.admission.capturedAtLatestMs,receivedAtMs:p.admission.receivedAtMs,completedAtMs:p.completedAtMs,freshUntilMs:p.captureFreshUntilMs,perceptionStatus:p.perceptionStatus,disposition:p.disposition,reason:p.reason}));
 const lifecycle=[...(input.lifecycle??[])].sort((a,b)=>a.sequence-b.sequence);
 if(!lifecycle.length)missing.add('lifecycleCoverageMissing');
 if(new Set(lifecycle.map(l=>l.eventId)).size!==lifecycle.length||new Set(lifecycle.map(l=>l.sequence)).size!==lifecycle.length)contradictions.add('duplicateLifecycleReceipt');
 if(lifecycle[0]?.sequence!==1&&lifecycle.length||lifecycle.some((l,i)=>i>0&&l.sequence!==lifecycle[i-1]!.sequence+1))missing.add('lifecycleSequenceGap');
 for(const [i,l] of lifecycle.entries()){
  if(i>0&&l.occurredAtMs<lifecycle[i-1]!.occurredAtMs)contradictions.add('lifecycleClockReversed');
  if(['cameraEnabled','cameraRenewed','cameraStopNoop'].includes(l.kind)&&l.observedCaptureActive!==true||['cameraEnableInactive','cameraRenewInactive','cameraInactiveObserved'].includes(l.kind)&&l.observedCaptureActive!==false)contradictions.add('cameraStateMilestoneMismatch');
  events.push({kind:'lifecycle',sourceEventDigest:hash(l.eventId),sequence:l.sequence,occurredAtMs:l.occurredAtMs,stage:l.kind,reason:l.reason,scopeDigest:l.scopeDigest,leaseDigest:l.leaseDigest,clockMappingDigest:l.clockMappingDigest,requestDigest:l.requestDigest,correlationDigest:l.correlationDigest,hostSequence:l.hostSequence,sourceEpochs:l.sourceEpochs,providerDigest:l.providerDigest,frames:l.frames,selectedVersion:l.selectedVersion,observedCaptureActive:l.observedCaptureActive,authority:false});
 }
 for(const p of input.publications){
  const a=p.admission,admissions=lifecycle.filter(l=>l.kind==='batchAdmitted'&&l.requestDigest===hash(a.requestId));
  if(!admissions.length){missing.add('publicationAdmissionMissing');continue;}
  if(admissions.length>1)contradictions.add('duplicateLifecycleAdmission');
  for(const l of admissions){
   const epochs={session:a.scope.sessionRevision,audience:a.scope.audienceRevision,generation:a.scope.scopeGeneration,configuration:a.scope.captureConfigurationRevision};
   if(l.hostSequence!==a.hostSequence||l.leaseDigest!==hash(a.leaseId)||l.clockMappingDigest!==hash(a.clockMappingId)||l.correlationDigest!==hash(a.correlationId)||l.scopeDigest!==scopeDigest(a.scope)||!orderedSame(l.sourceEpochs,epochs)||l.providerDigest!==digest([a.provider.id,a.provider.version])||l.occurredAtMs<a.receivedAtMs||l.occurredAtMs>p.completedAtMs)contradictions.add('lifecyclePublicationMismatch');
   if(!l.frames.length)missing.add('admittedFrameMetadataMissing');
   else if(!orderedSame(l.frames.map(f=>f.frameDigest),a.frameIds.map(hash))||l.frames.some(f=>f.sequence===null||f.capturedMonotonicMs===null||f.clockMappingDigest!==hash(a.clockMappingId))||new Set(l.frames.map(f=>f.sequence)).size!==l.frames.length||l.frames.some((f,i)=>i>0&&f.sequence!<=l.frames[i-1]!.sequence!))contradictions.add('admittedFrameMetadataMismatch');
   if(!lifecycle.some(row=>row.kind==='cameraEnabled'&&row.leaseDigest===l.leaseDigest&&row.sequence<l.sequence))missing.add('captureEnablementMissing');
   if(lifecycle.some(row=>row.kind==='captureLeaseEnded'&&row.leaseDigest===l.leaseDigest&&row.sequence<l.sequence))contradictions.add('leaseEndedBeforeAdmission');
  }
 }
 const groups=new Map<string,VisualTurnReceipt[]>();
 for(const t of input.turns){const rows=groups.get(t.interactionId)??[];rows.push(t);groups.set(t.interactionId,rows);}
 const turns=[...groups].map(([interactionId,rows])=>{
  rows.sort((a,b)=>a.sequence-b.sequence);const first=rows[0]!;
  if(new Set(rows.map(r=>r.sequence)).size!==rows.length)contradictions.add('duplicateTurnSequence');
  if(first.sequence!==1||rows.some((r,i)=>i>0&&r.sequence!==rows[i-1]!.sequence+1))missing.add('turnSequenceGap');
  if(rows.some((r,i)=>r.modality!==first.modality||!orderedSame(r.lineage,first.lineage)||i>0&&r.occurredAtMs<rows[i-1]!.occurredAtMs))contradictions.add('turnLineageChanged');
  const finalized=rows.flatMap(r=>r.finalized?[r.finalized]:[]),f=finalized[0]??null,s=first.lineage.selected,link=first.lineage.publication;
  if(finalized.some(item=>!orderedSame(item,f)))contradictions.add('preparedManifestChanged');
  if(!f)missing.add('preparedManifestMissing');
  if(s){const p=publicationById.get(s.requestId);
   if(!p)missing.add('selectedPublicationMissing');
   else if(p.disposition!=='published'||!p.publication||s.sourceRevision!==p.admission.hostSequence||s.leaseId!==p.admission.leaseId||s.audienceRevision!==p.publication.audienceRevision||s.captureConfigurationRevision!==p.admission.scope.captureConfigurationRevision||s.capturedAtEarliestMs!==p.admission.capturedAtEarliestMs||s.capturedAtLatestMs!==p.admission.capturedAtLatestMs||s.expiresAtMs!==p.captureFreshUntilMs||!subset(s.observationIds,p.observationIds)||!subset(s.frameIds,p.admission.frameIds)||first.occurredAtMs<p.completedAtMs||first.sequence===1&&first.occurredAtMs>=s.expiresAtMs)contradictions.add('selectedPublicationMismatch');
   if(link&&(link.requestId!==s.requestId||p&&(link.hostSequence!==p.admission.hostSequence||link.leaseRevision!==p.publication?.leaseRevision||link.audienceRevision!==p.publication?.audienceRevision||link.clockMappingId!==p.admission.clockMappingId)))contradictions.add('publicationLinkMismatch');
   if(!link)missing.add('publicationLinkMissing');
  }
  const stages=rows.map(r=>r.stage),has=(stage:VisualTurnReceipt['stage'])=>stages.includes(stage);
  if(has('providerInvoked')&&!has('finalized'))missing.add('providerFinalizationMissing');
  for(const r of rows)events.push({kind:'turn',interaction:id(interactionId),sequence:r.sequence,occurredAtMs:r.occurredAtMs,stage:r.stage,outcome:r.outcome,channel:r.channel,receivedSamples:r.receivedSamples,endpointAcknowledged:r.endpointAcknowledged,selectedRequest:s?id(s.requestId):null,selectedSourceRevision:s?.sourceRevision??null,selectionReason:r.lineage.selectionReason,manifest:r.finalized?.manifestDigest??null,conversationSection:r.finalized?.conversationSectionDigest??null,sections:r.finalized?.sections??null});
  return {interaction:id(interactionId),modality:first.modality,selectedRequest:s?id(s.requestId):null,selectedObservationIds:s?.observationIds.map(id)??[],contextIncluded:f?.visualIncluded===true,providerInvocationRecorded:has('providerInvoked'),generationCompleted:rows.some(r=>r.stage==='generationEnded'&&r.outcome==='completed'),outputEmissionRecorded:has('outputEmitted'),endpointAcknowledgmentRecorded:rows.some(r=>r.endpointAcknowledged),deliveryProved:false,manifestDigest:f?.manifestDigest??null,conversationSectionDigest:f?.conversationSectionDigest??null};
 });
 const terminalById=new Map(input.terminalSources.map(t=>[t.episodeId,t]));
 const episodeById=new Map(input.episodes.map(e=>[e.episodeId,e]));
 for(const e of input.episodes){
  const terminal=terminalById.get(e.episodeId);
  if(terminal){if(terminal.revision<=e.revision)contradictions.add('terminalRevisionMismatch');continue;}
  for(const o of e.observations){const p=publicationById.get(o.batchId);
   if(!p)missing.add('retainedPublicationMissing');
   else if(p.disposition!=='published'||!orderedSame(diagnosticScope(e.scope),{...p.admission.scope,audienceRevision:p.publication?.audienceRevision??p.admission.scope.audienceRevision})||!p.observationIds.includes(o.observationId)||!subset(o.sourceFrameIds,p.admission.frameIds)||Date.parse(o.earliestCaptureAt)!==milliseconds(p.admission.capturedAtEarliestMs)||Date.parse(o.latestCaptureAt)!==milliseconds(p.admission.capturedAtLatestMs)||Date.parse(o.receivedAt)!==milliseconds(p.admission.receivedAtMs)||Date.parse(o.interpretedAt)>p.completedAtMs||Date.parse(o.interpretedAt)<p.admission.receivedAtMs||Date.parse(o.expiresAt)!==milliseconds(p.captureFreshUntilMs)||!providerBindingMatches(o.providerConfigurationRef,p))contradictions.add('retainedPublicationMismatch');
  }
  events.push({kind:'retainedSource',episode:id(e.episodeId),revision:e.revision,state:e.state,sourceDigest:e.sourceDigest,scope:scopeDigest(diagnosticScope(e.scope)),sourceFamilies:e.independenceKeys.map(id),occurredAt:e.occurredAt,retainedAt:e.retainedAt,expiresAt:e.expiresAt,observationIds:e.sourceObservationIds.map(id),requests:[...new Set(e.observations.map(o=>id(o.batchId)))],correctionRefs:e.correctionRefs.map(id),rawMediaAvailable:false});
 }
 for(const p of input.projections){const e=episodeById.get(p.episode.episodeId),t=terminalById.get(p.episode.episodeId);
  if(t){if(t.revision<=p.episode.revision)contradictions.add('terminalRevisionMismatch');continue;}
  if(!e)missing.add('projectionSourceMissing');else if(!orderedSame(e,p.episode))contradictions.add('projectionSourceMismatch');
  events.push({kind:'memoryProjection',episode:id(p.episode.episodeId),episodeRevision:p.episode.revision,memory:id(p.memoryRecord.memoryId),status:p.memoryRecord.status,factuality:p.memoryRecord.factuality,sourceDigest:p.episode.sourceDigest,transformationConfidence:p.memoryRecord.confidence,transformationPolicyHash:id(p.memoryRecord.extensions['lifestream.conversationalVision'].transformationConfidence.policyRef),createdAt:p.memoryRecord.createdAt});
 }
 for(const t of input.terminalSources)events.push({kind:'terminalSource',episode:id(t.episodeId),revision:t.revision,state:t.state});
 if(!input.publications.length)missing.add('publicationCoverageMissing');if(!input.turns.length)missing.add('turnCoverageMissing');
 return {schemaVersion:'1.0.0',kind:'supplied-visual-diagnostic-lineage',status:contradictions.size?'contradictoryMetadata':'partialDiagnosticCorrelation',coverage:'bounded_best_effort',contradictions:[...contradictions].sort(),missingEvidence:[...missing].sort(),turns,events,claimsRuntimeAcceptance:false,sourceCurrencyProved:false,perceptionQualityProved:false,rawMediaAvailable:false,limitations:['Supplied metadata is not an authenticated or complete canonical lifecycle trace.','Optional lifecycle receipts cover host milestones where retained; missing ingress or pre-retention memory admission remains unproved.','Runtime capture state and lease termination are separate from physical capture or broker-release acknowledgment.','Endpoint acknowledgment is a recorded diagnostic; actual delivery, perception and Human acceptance remain unproved.','No raw media, scene prose, Human corrections, prompts, recipients or private chain-of-thought are replayed.','Terminal sources suppress retained source and projection payloads; replay grants no eligibility, learning or effects.']};
}

/** Re-derive the redacted trace from the bounded original snapshot. Never accept
 * a caller-provided report, provider route, runner callback or event payload. */
export async function replayVisualLineage(input:unknown){
 const correlation=correlateVisualLineage(input),sourceTraceId=`visual-diagnostics:${digest(correlation)}`,replayId=randomUUID();
 const manifest=createReplayManifest({replayId,sourceTraceId,artifactRefs:[`sha256:${digest(correlation)}`],providerRefs:['derived:visual-diagnostic-metadata-v1']});
 const events:ReplayEvent[]=correlation.events.map((payload,index)=>({id:`${sourceTraceId}:${index}`,traceId:sourceTraceId,sequence:index,payload}));
 const replay=await replayTrace(events,manifest,{idFactory:()=>randomUUID()});
 return {correlation,manifest,...replay,claimsRuntimeAcceptance:false,liveEffects:false,durableReinforcement:false,perceptionReplayed:false};
}
