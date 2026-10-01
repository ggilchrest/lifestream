import {createHash,randomUUID} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import {isDeepStrictEqual} from 'node:util';
import {validateVisualEpisode,validateVisualMemoryProjection,type VisualMemoryProjection,type VisualTransformationConfidence,type VisualMemoryOwner,type VisualMemoryScope,type VisualObservationEpisode} from '@lifestream/contracts/visual-memory';
import type {Database,Transaction} from './database.ts';

export type VisualMemoryPolicy={enabled:boolean;revision:number;retentionMs:number|null;retentionPolicyRef:string|null};
export type VisualMemoryAdmission={
 /** Host-derived current scope and verified visual subject association, never account login alone. */
 scope:VisualMemoryScope;policyRevision:number;current:boolean;
 reason:'meaningfulEvent'|'meaningfulChange'|'conversationRelevance'|'appearanceContinuity';
 verifiedSubjectRef:string;
};
export type VisualMemoryDisposition='retained'|'policyDenied'|'scopeChanged'|'invalidEpisode'|'unattributedSubject'|'sourceExpired'|'duplicateSource'|'appearanceBound'|'sessionBound'|'capacityExceeded';
export type VisualMemoryReceipt={state:VisualMemoryDisposition;episodeId?:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key=(owner:VisualMemoryOwner)=>digest([owner.principalId,owner.assistantId,owner.relationshipId]);
const policyRef=(owner:VisualMemoryOwner,revision:number)=>`visual-memory-policy:${key(owner)}:${revision}`;
const ownerValid=(owner:VisualMemoryOwner)=>[owner.principalId,owner.assistantId,owner.relationshipId].every(x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(x));
/** Source identity excludes retention, lifecycle and summary; recall or paraphrase is not new evidence. */
export const visualEpisodeSourceDigest=(episode:Pick<VisualObservationEpisode,'scope'|'observations'>)=>digest({scope:episode.scope,observations:episode.observations});
export type VisualUserCorrection={recordType:'visualUserCorrection';sourceType:'humanEntry';correctionId:string;actor:string;relationshipId:string;episodeId:string;sourceEpisodeRevision:number;sourceDigest:string;sourceObservationIds:string[];content:string;occurredAt:string;untrusted:true};
/** Existing payload erasure keeps original opaque mutation UUIDs only. Legacy
 * rows remain exactly payloadRemoved; no identity is minted by erasure. */
const activationIdSql="CASE WHEN json_valid(payload_json) THEN coalesce(json_extract(payload_json,'$.visualActivationEvidence.event.eventId'),json_extract(payload_json,'$.visualActivationEventId')) ELSE NULL END";
const mutationIdSql="CASE WHEN json_valid(payload_json) THEN coalesce(CASE WHEN event_type IN ('visualCorrectionApplied','forgotten') AND json_extract(payload_json,'$.visualMutation.recordType')='visualSourceMutationIdentity' THEN json_extract(payload_json,'$.visualMutation.eventId') ELSE NULL END,json_extract(payload_json,'$.visualMutationEventId')) ELSE NULL END";
const opaqueId=(expression:string,field:string)=>`CASE WHEN length(${expression})=36 AND ${expression} LIKE '________-____-____-____-____________' AND ${expression} NOT GLOB '*[^0-9a-f-]*' THEN json_object('${field}',${expression}) ELSE '{}' END`;
export const visualLifecyclePayloadErasure=`json_patch(json_patch(?,${opaqueId(activationIdSql,'visualActivationEventId')}),${opaqueId(mutationIdSql,'visualMutationEventId')})`;
/** Internal original-owner receipt, not a canonical MemoryLifecycleEvent.
 * A Human correction entry is not a MemoryRecord; payload erasure is not the
 * source-preserving canonical invalidate operation. Mint only in the actual
 * SQLite mutation transaction, and retain only its opaque UUID after erasure. */
export function visualSourceMutationIdentity(kind:'correction'|'erasure',oldRevision:unknown){
 // Optional diagnostics cannot prevent privacy erasure of a corrupt row.
 // Unknown historical revisions stay null rather than receiving a default.
 const valid=typeof oldRevision==='number'&&Number.isSafeInteger(oldRevision)&&oldRevision>=1&&Number.isSafeInteger(oldRevision+1);
 return {recordType:'visualSourceMutationIdentity' as const,eventId:randomUUID(),kind,oldRevision:valid?oldRevision:null,newRevision:valid?oldRevision+1:null};
}
export type VisualActivationEvidence=Readonly<{schemaVersion:'1.0.0';recordType:'visualActivationEvidence';ownerDigest:string;scope:Readonly<Pick<VisualMemoryScope,'assistantId'|'environmentId'|'conversationId'|'sessionId'|'endpointId'>>;event:Readonly<Record<string,unknown>>;artifact:Readonly<{reference:Readonly<{reference:string;sha256:string;mediaType:'application/json';schemaRef:string;byteLength:number}>;bytes:string}>}>;
export type VisualCorrectionEvidence=Readonly<{schemaVersion:'1.0.0';recordType:'visualCorrectionEvidence';ownerDigest:string;scope:Readonly<{assistantId:string;environmentId:string;conversationId:null;sessionId:null;endpointId:null}>;sourceReceipt:Readonly<{eventId:string;assistantId:string;memoryId:string;oldRevision:number;newRevision:number;occurredAt:string;humanEntryId:string;sourceRevision:Readonly<{providerRef:string;revision:string;highWaterMark:null}>}>;artifact:VisualActivationEvidence['artifact']}>;
const visualCorrectionSources=new WeakSet<object>();
/** Original retained SQLite source read only; no currency or truth authority. */
export function isVisualCorrectionEvidence(value:unknown):value is VisualCorrectionEvidence{return !!value&&typeof value==='object'&&visualCorrectionSources.has(value);}
const visualActivationSources=new WeakSet<object>();
/** Genuine original-owner read provenance, not current eligibility or authority. */
export function isVisualActivationEvidence(value:unknown):value is VisualActivationEvidence{return !!value&&typeof value==='object'&&visualActivationSources.has(value);}
/** Called only within the actual activation owner's transaction after current
 * consent/source/typed projection/candidate/capacity checks have succeeded. */
function activationEvidence(owner:VisualMemoryOwner,episode:VisualObservationEpisode,memory:VisualMemoryProjection['memoryRecord'],oldRevision:number,now:number,memoryPolicyRevision:number):VisualActivationEvidence|null {
 try{
  if(!Number.isSafeInteger(now)||now<Date.parse(memory.createdAt)||now>=Date.parse(episode.expiresAt)||memory.status!=='candidate'||!Number.isSafeInteger(oldRevision)||oldRevision<1||!Number.isSafeInteger(memoryPolicyRevision)||memoryPolicyRevision<1||!validateVisualMemoryProjection({schemaVersion:'1.0.0',recordType:'visualMemoryProjection',episode,memoryRecord:memory}).valid)return null;
  const sourceRevision={providerRef:'urn:lifestream:sqlite:visual-memory',revision:`episode:${episode.episodeId}:${episode.revision}:${episode.sourceDigest}`,highWaterMark:null};
  const bytes=JSON.stringify({schemaVersion:'1.0.0',recordType:'redactedVisualActivationValidation',memoryId:memory.memoryId,assistantId:owner.assistantId,episodeId:episode.episodeId,episodeRevision:episode.revision,sourceDigest:episode.sourceDigest,candidateRecordDigest:digest(memory),oldRevision,newRevision:oldRevision+1,memoryPolicyRevision,visualPolicyRevision:episode.processingPolicyRevision,validatedAt:new Date(now).toISOString(),checks:['ownedCurrentConsent','retainedUncorrectedSource','typedProjection','candidateRevision','scopeCapacity'],perceptionQualityProved:false});
  const sha256=createHash('sha256').update(bytes).digest('hex'),reference={reference:`urn:lifestream:visual-activation-validation:sha256:${sha256}`,sha256,mediaType:'application/json' as const,schemaRef:'urn:lifestream:visual-activation-validation:1.0.0',byteLength:Buffer.byteLength(bytes)};
  const event={schemaVersion:'1.0.0',eventId:randomUUID(),assistantId:owner.assistantId,memoryId:memory.memoryId,oldRevision,newRevision:oldRevision+1,occurredAt:new Date(now).toISOString(),actorRef:owner.principalId,correlationId:memory.memoryId,operation:{type:'activate',memoryId:memory.memoryId,expectedRevision:oldRevision,validationRef:reference,reason:{code:'visual_candidate_validated',summary:'Current owned consent and retained typed candidate checks passed; perception remains unverified.'}},sourceRevision};
  if(!createContractValidator().validate('https://lifestream.dev/contracts/memory-operations/1.0.0',event).valid)return null;
  return immutable({schemaVersion:'1.0.0',recordType:'visualActivationEvidence',ownerDigest:key(owner),scope:{assistantId:owner.assistantId,environmentId:episode.scope.environmentId,conversationId:episode.scope.conversationId,sessionId:episode.scope.sessionId,endpointId:episode.scope.endpointId},event,artifact:{reference,bytes}});
 }catch{return null;}
}
type Row={episode_id:string;revision:number;state:string;expires_at:number;payload_json:string|null};
export type VisualRetainedWindow=Readonly<{fromMs:number;toMs:number;complete:boolean;reason:'complete'|'scopeUnavailable'|'invalidWindow'|'capacityExceeded'|'missingSource';boundaryRevision:string;episodes:readonly VisualObservationEpisode[]}>;
type WindowGuard={repository:VisualMemoryRepository;owner:VisualMemoryOwner;fromMs:number;toMs:number;revision:string;lastNow:number;deadline:number;retired:boolean;checking:boolean};
const windowGuards=new WeakMap<VisualRetainedWindow,WindowGuard>();
function immutable<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;}

/** Run inside the source lifecycle transaction. Candidate content and historic
 * event payloads are erased; opaque lifecycle receipts remain. */
export function retireVisualProjections(tx:Transaction,now:number){
 const rows=tx.all<{id:string;assistant_id:string;provenance_json:string;lifecycle_json:string}>("SELECT id,assistant_id,provenance_json,lifecycle_json FROM memories WHERE json_extract(provenance_json,'$.visualEpisodeId') IN (SELECT episode_id FROM visual_observation_episodes WHERE state<>'retained') AND json_extract(lifecycle_json,'$.contentRemoved') IS NOT 1");
 tx.run(`UPDATE memory_lifecycle_events SET payload_json=${visualLifecyclePayloadErasure} WHERE event_type='visualUserCorrection' AND json_extract(payload_json,'$.episodeId') IN (SELECT episode_id FROM visual_observation_episodes WHERE state<>'retained')`,JSON.stringify({payloadRemoved:true}));
 for(const row of rows){const provenance=JSON.parse(row.provenance_json) as {actor:string},lifecycle=JSON.parse(row.lifecycle_json) as {revision:number},revision=tx.get<{n:number}>('SELECT COALESCE(MAX(revision),0)+1 AS n FROM memory_lifecycle_events WHERE memory_id=?',row.id)!.n;
  tx.run("UPDATE memories SET content='',provenance_json=?,lifecycle_json=? WHERE id=?",JSON.stringify({actor:provenance.actor,payloadRemoved:true}),JSON.stringify({status:'invalidated',revision:lifecycle.revision+1,contentRemoved:true,reason:'visual source retired',changedBy:provenance.actor}),row.id);
  tx.run(`UPDATE memory_lifecycle_events SET payload_json=${visualLifecyclePayloadErasure} WHERE memory_id=?`,JSON.stringify({payloadRemoved:true}),row.id);
  tx.run('INSERT INTO memory_lifecycle_events (memory_id,assistant_id,revision,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?)',row.id,row.assistant_id,revision,'forgotten',JSON.stringify({status:'invalidated',contentRemoved:true,reason:'visual source retired',visualMutation:visualSourceMutationIdentity('erasure',lifecycle.revision)}),new Date(now).toISOString());
 }return rows.length;
}

/** Typed episodes stay separate from owner quotes and canonical MemoryRecord projections.
 * No numeric transformation confidence, source turn, preference or reinforcement is fabricated. */
export class VisualMemoryRepository{
 private readonly db:Database;private readonly now:()=>number;
 constructor(db:Database,now:()=>number=Date.now){this.db=db;this.now=now;this.sweep();}
 policy(owner:VisualMemoryOwner):VisualMemoryPolicy{
  const row=this.db.connection.prepare('SELECT enabled,revision,retention_ms FROM visual_memory_policies WHERE scope_key=?').get(key(owner));
  return row?{enabled:row.enabled===1,revision:Number(row.revision),retentionMs:row.retention_ms===null?null:Number(row.retention_ms),retentionPolicyRef:policyRef(owner,Number(row.revision))}:{enabled:false,revision:0,retentionMs:null,retentionPolicyRef:null};
 }
 configure(owner:VisualMemoryOwner,enabled:boolean,expectedRevision:number,retentionMs:number|null):VisualMemoryPolicy{
  if(!ownerValid(owner)||typeof enabled!=='boolean'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!(retentionMs===null||Number.isSafeInteger(retentionMs)&&retentionMs>0)||enabled&&retentionMs===null)throw Error('Invalid visual memory policy');
  const now=this.now();if(!Number.isSafeInteger(now)||retentionMs!==null&&!Number.isSafeInteger(now+retentionMs))throw Error('Invalid visual retention duration');
  this.db.transaction(tx=>{
   if(this.policy(owner).revision!==expectedRevision)throw Error('Visual memory policy revision conflict');
   tx.run('INSERT INTO visual_memory_policies VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,retention_ms=excluded.retention_ms,approved_at=excluded.approved_at',key(owner),owner.principalId,owner.assistantId,owner.relationshipId,enabled?1:0,expectedRevision+1,retentionMs,now);
   // Disabling or changing processing policy retires old derived payloads immediately.
   tx.run("UPDATE visual_observation_episodes SET state='invalidated',payload_json=NULL,revision=revision+1 WHERE scope_key=? AND state='retained'",key(owner));
   retireVisualProjections(tx,now);
  });return this.policy(owner);
 }
 sweep():number{
  const now=this.now();return this.db.transaction(tx=>{tx.run("UPDATE visual_observation_episodes SET state='expired',payload_json=NULL,revision=revision+1 WHERE state='retained' AND expires_at<=?",now);const n=tx.get<{n:number}>('SELECT changes() AS n')!.n;retireVisualProjections(tx,now);return n;});
 }
 /** An optional host estimate enables only a canonical, inert candidate. No
  * observation score, default number, model call or source turn is fabricated. */
 project(owner:VisualMemoryOwner,id:string,expectedRevision:number,estimate:VisualTransformationConfidence|null){
  this.sweep();if(estimate===null)return {state:'estimateUnavailable' as const};
  const now=this.now(),policy=this.policy(owner);if(!policy.enabled)return {state:'policyDenied' as const};
  return this.db.transaction(tx=>{
   const row=tx.get<Row>('SELECT episode_id,revision,state,expires_at,payload_json FROM visual_observation_episodes WHERE scope_key=? AND episode_id=?',key(owner),id);
   if(!row||row.state!=='retained'||row.revision!==expectedRevision||!row.payload_json||row.expires_at<=now)return {state:'sourceUnavailable' as const};
   const source=JSON.parse(row.payload_json) as VisualObservationEpisode;
   if(source.state!=='retained'||source.correctionRefs.length)return {state:'sourceUnavailable' as const};
   if(source.memoryRecordId)return {state:'alreadyProjected' as const,memoryId:source.memoryRecordId};
   if(source.processingPolicyRevision!==policy.revision||source.sourceDigest!==visualEpisodeSourceDigest(source)||!validateVisualEpisode(source).valid)return {state:'sourceUnavailable' as const};
   if(Number(tx.get<{n:number}>("SELECT count(*) AS n FROM memories WHERE assistant_id=? AND json_extract(provenance_json,'$.actor')=? AND json_extract(provenance_json,'$.relationshipId')=? AND json_extract(provenance_json,'$.visualEpisodeId') IS NOT NULL AND json_extract(lifecycle_json,'$.status')='candidate'",owner.assistantId,owner.principalId,owner.relationshipId)!.n)>=128)return {state:'capacityExceeded' as const};
   const memoryId=randomUUID(),episode:VisualObservationEpisode={...source,revision:row.revision+1,memoryRecordId:memoryId};
   const projection:VisualMemoryProjection={schemaVersion:'1.0.0',recordType:'visualMemoryProjection',episode,memoryRecord:{schemaVersion:'2.0.0',memoryId,assistantId:owner.assistantId,kind:'experiential',content:episode.summary,factuality:'unverified',confidence:estimate.value,sensitivity:'personal',status:'candidate',provenance:{sourceType:'interaction',sourceRefs:[`visual-episode:${id}:${episode.revision}:${episode.sourceDigest}`],transformationId:'lifestream.visual-episode-projection',transformationVersion:'1.0.0'},createdAt:new Date(now).toISOString(),createdBy:owner.principalId,lastReinforcedAt:null,contradictedBy:[],extensions:{'lifestream.conversationalVision':{schemaVersion:'1.0.0',sourceKind:'modelVisualObservation',episodeId:id,episodeRevision:episode.revision,transformationConfidence:structuredClone(estimate),sourceDigest:episode.sourceDigest,rawMediaRetained:false}}}};
   if(Buffer.byteLength(JSON.stringify(episode))>8192)return {state:'capacityExceeded' as const};
   if(!validateVisualMemoryProjection(projection).valid)return {state:'invalidEstimate' as const};
   const memory=projection.memoryRecord,lifecycle={kind:memory.kind,factuality:memory.factuality,confidence:memory.confidence,sensitivity:memory.sensitivity,status:memory.status,revision:1,lastReinforcedAt:null,contradictedBy:[],visualCandidate:true};
   tx.run('INSERT INTO memories VALUES (?,?,?,?,?,?)',memoryId,owner.assistantId,memory.content,JSON.stringify({actor:owner.principalId,relationshipId:owner.relationshipId,epistemicStatus:'modelVisualObservation',visualEpisodeId:id,visualEpisodeRevision:episode.revision,visualSourceDigest:episode.sourceDigest,canonical:memory}),JSON.stringify(lifecycle),memory.createdAt);
   tx.run('INSERT INTO memory_lifecycle_events (memory_id,assistant_id,revision,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?)',memoryId,owner.assistantId,1,'created',JSON.stringify(lifecycle),memory.createdAt);
   tx.run('UPDATE visual_observation_episodes SET revision=?,payload_json=? WHERE episode_id=?',episode.revision,JSON.stringify(episode),id);
   return {state:'projected' as const,memoryId};
  });
 }
 /** Admit a validated candidate under current owner memory consent. Recall is
  * not reinforcement and does not change the source event or episode revision. */
 activate(owner:VisualMemoryOwner,id:string,expectedRevision:number){
  this.sweep();const now=this.now();return this.db.transaction(tx=>{
   const enabled=()=>!!tx.get('SELECT 1 FROM automatic_memory_policies WHERE principal_id=? AND assistant_id=? AND relationship_id=? AND enabled=1',owner.principalId,owner.assistantId,owner.relationshipId)&&this.policy(owner).enabled;
   if(!enabled())return {state:'policyDenied' as const};
   const row=tx.get<Row>('SELECT episode_id,revision,state,expires_at,payload_json FROM visual_observation_episodes WHERE scope_key=? AND episode_id=?',key(owner),id);if(!row||row.state!=='retained'||row.revision!==expectedRevision||!row.payload_json||row.expires_at<=now)return {state:'sourceUnavailable' as const};
   const episode=JSON.parse(row.payload_json) as VisualObservationEpisode;if(!episode.memoryRecordId||episode.state!=='retained'||episode.correctionRefs.length||episode.processingPolicyRevision!==this.policy(owner).revision)return {state:'sourceUnavailable' as const};
   const memory=tx.get<{provenance_json:string;lifecycle_json:string}>('SELECT provenance_json,lifecycle_json FROM memories WHERE id=? AND assistant_id=?',episode.memoryRecordId,owner.assistantId);if(!memory)return {state:'sourceUnavailable' as const};
   const provenance=JSON.parse(memory.provenance_json),lifecycle=JSON.parse(memory.lifecycle_json),canonical=provenance.canonical as VisualMemoryProjection['memoryRecord'];if(provenance.actor!==owner.principalId||provenance.relationshipId!==owner.relationshipId||!validateVisualMemoryProjection({schemaVersion:'1.0.0',recordType:'visualMemoryProjection',episode,memoryRecord:canonical}).valid)return {state:'sourceUnavailable' as const};
   if(canonical.status==='active')return {state:'alreadyActive' as const};if(canonical.status!=='candidate'||lifecycle.status!=='candidate')return {state:'sourceUnavailable' as const};
   const count=tx.get<{n:number}>("SELECT count(*) AS n FROM memories WHERE assistant_id=? AND json_extract(provenance_json,'$.actor')=? AND json_extract(lifecycle_json,'$.status')='active'",owner.assistantId,owner.principalId)!.n;if(count>=240)return {state:'capacityExceeded' as const};
   const memoryPolicy=tx.get<{revision:number}>('SELECT revision FROM automatic_memory_policies WHERE principal_id=? AND assistant_id=? AND relationship_id=? AND enabled=1',owner.principalId,owner.assistantId,owner.relationshipId);
   const evidence=memoryPolicy?activationEvidence(owner,episode,canonical,Number(lifecycle.revision),now,memoryPolicy.revision):null;
   canonical.status='active';const next={...lifecycle,status:'active',revision:Number(lifecycle.revision)+1};
   const metadata={visualOccurredAt:episode.occurredAt,visualExpiresAt:episode.expiresAt,visualSourceFamily:episode.independenceKeys[0],visualUncertainty:episode.observations.map(o=>o.uncertainty),visualLimitations:[...new Set(episode.observations.flatMap(o=>[...o.limitations,...o.subject.limitations]))]};
   tx.run('UPDATE memories SET provenance_json=?,lifecycle_json=? WHERE id=?',JSON.stringify({...provenance,...metadata,canonical}),JSON.stringify(next),episode.memoryRecordId);
   const revision=tx.get<{n:number}>('SELECT COALESCE(MAX(revision),0)+1 AS n FROM memory_lifecycle_events WHERE memory_id=?',episode.memoryRecordId)!.n;
   tx.run('INSERT INTO memory_lifecycle_events (memory_id,assistant_id,revision,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?)',episode.memoryRecordId,owner.assistantId,revision,'lifecycleChanged',JSON.stringify({...next,...(evidence?{visualActivationEvidence:evidence}:{})}),new Date(now).toISOString());return {state:'active' as const,memoryId:episode.memoryRecordId};
  });
 }
 /** Read existing new-format source evidence only. Legacy rows stay missing;
  * no historical upcast, identity fabrication or new activation occurs. */
 activationEvidence(owner:VisualMemoryOwner,memoryId:string):VisualActivationEvidence|null {
  try{
   if(!ownerValid(owner)||!this.policy(owner).enabled||!this.db.connection.prepare('SELECT 1 FROM automatic_memory_policies WHERE principal_id=? AND assistant_id=? AND relationship_id=? AND enabled=1').get(owner.principalId,owner.assistantId,owner.relationshipId))return null;
   const row=this.db.connection.prepare("SELECT payload_json,occurred_at FROM memory_lifecycle_events WHERE assistant_id=? AND memory_id=? AND event_type='lifecycleChanged' AND json_type(payload_json,'$.visualActivationEvidence')='object' ORDER BY revision DESC LIMIT 1").get(owner.assistantId,memoryId);if(!row)return null;
   const evidence=JSON.parse(String(row.payload_json)).visualActivationEvidence as VisualActivationEvidence;
   if(evidence.schemaVersion!=='1.0.0'||evidence.recordType!=='visualActivationEvidence'||evidence.ownerDigest!==key(owner)||evidence.event.assistantId!==owner.assistantId||evidence.event.memoryId!==memoryId||evidence.event.actorRef!==owner.principalId||evidence.event.occurredAt!==row.occurred_at||!createContractValidator().validate('https://lifestream.dev/contracts/memory-operations/1.0.0',evidence.event).valid)return null;
   const operation=evidence.event.operation as {type:string;expectedRevision:number;validationRef:unknown};if(operation.type!=='activate'||operation.expectedRevision!==evidence.event.oldRevision)return null;
   const {reference,bytes}=evidence.artifact;if(typeof bytes!=='string'||Buffer.byteLength(bytes)>4096||reference.byteLength!==Buffer.byteLength(bytes)||reference.sha256!==createHash('sha256').update(bytes).digest('hex')||reference.mediaType!=='application/json'||reference.schemaRef!=='urn:lifestream:visual-activation-validation:1.0.0'||reference.reference!==`urn:lifestream:visual-activation-validation:sha256:${reference.sha256}`||JSON.stringify((evidence.event.operation as {validationRef:unknown}).validationRef)!==JSON.stringify(reference))return null;
   const validation=JSON.parse(bytes),now=this.now();if(!Number.isSafeInteger(now)||now<Date.parse(String(evidence.event.occurredAt))||validation.schemaVersion!=='1.0.0'||validation.recordType!=='redactedVisualActivationValidation'||validation.memoryId!==memoryId||validation.assistantId!==owner.assistantId||validation.validatedAt!==evidence.event.occurredAt||validation.oldRevision!==evidence.event.oldRevision||validation.newRevision!==evidence.event.newRevision||validation.newRevision!==validation.oldRevision+1)return null;
   const episodeRow=this.db.connection.prepare('SELECT state,expires_at,payload_json FROM visual_observation_episodes WHERE scope_key=? AND episode_id=?').get(key(owner),validation.episodeId);
   if(!episodeRow||episodeRow.state!=='retained'||Number(episodeRow.expires_at)<=now||!episodeRow.payload_json)return null;
   const episode=JSON.parse(String(episodeRow.payload_json)) as VisualObservationEpisode,memoryRow=this.db.connection.prepare('SELECT provenance_json FROM memories WHERE assistant_id=? AND id=?').get(owner.assistantId,memoryId);if(!memoryRow)return null;
   const memory=JSON.parse(String(memoryRow.provenance_json)).canonical as VisualMemoryProjection['memoryRecord'];
   if(validation.candidateRecordDigest!==digest({...memory,status:'candidate'})||!isDeepStrictEqual(evidence.event.sourceRevision,{providerRef:'urn:lifestream:sqlite:visual-memory',revision:`episode:${episode.episodeId}:${episode.revision}:${episode.sourceDigest}`,highWaterMark:null})||memory.status!=='active'||episode.memoryRecordId!==memoryId||episode.revision!==validation.episodeRevision||episode.sourceDigest!==validation.sourceDigest||episode.processingPolicyRevision!==this.policy(owner).revision||!validateVisualMemoryProjection({schemaVersion:'1.0.0',recordType:'visualMemoryProjection',episode,memoryRecord:memory}).valid)return null;
   const {assistantId,environmentId,conversationId,sessionId,endpointId}=episode.scope;if(!isDeepStrictEqual(evidence.scope,{assistantId,environmentId,conversationId,sessionId,endpointId}))return null;
   const result=immutable(evidence);visualActivationSources.add(result);return result;
  }catch{return null;}
 }
 /** Project only an actual current correction source. A copied source entry,
  * missing mutation UUID or erased scope cannot acquire source provenance. */
 correctionEvidence(owner:VisualMemoryOwner,memoryId:string):VisualCorrectionEvidence|null {
  try{
   this.sweep();const now=this.now(),policy=this.policy(owner);if(!ownerValid(owner)||!policy.enabled||!this.db.connection.prepare('SELECT 1 FROM automatic_memory_policies WHERE principal_id=? AND assistant_id=? AND relationship_id=? AND enabled=1').get(owner.principalId,owner.assistantId,owner.relationshipId))return null;
   const row=this.db.connection.prepare("SELECT payload_json,occurred_at FROM memory_lifecycle_events WHERE assistant_id=? AND memory_id=? AND event_type='visualCorrectionApplied' ORDER BY revision DESC LIMIT 1").get(owner.assistantId,memoryId);
   const stored=this.db.connection.prepare('SELECT provenance_json,lifecycle_json FROM memories WHERE assistant_id=? AND id=?').get(owner.assistantId,memoryId);if(!row||!stored||Buffer.byteLength(String(row.payload_json))>4096||Buffer.byteLength(String(stored.provenance_json))>32768||Buffer.byteLength(String(stored.lifecycle_json))>4096)return null;
   const payload=JSON.parse(String(row.payload_json)),mutation=payload.visualMutation,provenance=JSON.parse(String(stored.provenance_json)),lifecycle=JSON.parse(String(stored.lifecycle_json));
   if(typeof payload.visualMutationEnvironmentId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(payload.visualMutationEnvironmentId)||!mutation||!isDeepStrictEqual(Object.keys(mutation).sort(),['eventId','kind','newRevision','oldRevision','recordType'])||mutation.recordType!=='visualSourceMutationIdentity'||mutation.kind!=='correction'||typeof mutation.eventId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(mutation.eventId)||!Number.isSafeInteger(mutation.oldRevision)||mutation.oldRevision<1||mutation.newRevision!==mutation.oldRevision+1||lifecycle.revision!==mutation.newRevision||lifecycle.status!=='contradicted'||lifecycle.needsReview!==true||payload.status!=='contradicted'||payload.actor!==owner.principalId||provenance.actor!==owner.principalId||provenance.relationshipId!==owner.relationshipId)return null;
   const source=this.db.connection.prepare("SELECT payload_json,revision FROM visual_observation_episodes WHERE scope_key=? AND episode_id=? AND state='retained' AND expires_at>?").get(key(owner),provenance.visualEpisodeId,now);if(!source?.payload_json||Buffer.byteLength(String(source.payload_json))>8192)return null;
   const episode=JSON.parse(String(source.payload_json)) as VisualObservationEpisode,canonical=provenance.canonical as VisualMemoryProjection['memoryRecord'];
   if(episode.revision!==Number(source.revision)||episode.processingPolicyRevision!==policy.revision||episode.memoryRecordId!==memoryId||!['principalId','assistantId','relationshipId'].every(field=>episode.scope[field as keyof VisualMemoryOwner]===owner[field as keyof VisualMemoryOwner])||!validateVisualMemoryProjection({schemaVersion:'1.0.0',recordType:'visualMemoryProjection',episode,memoryRecord:canonical}).valid)return null;
   const entry=this.db.connection.prepare("SELECT payload_json FROM memory_lifecycle_events WHERE assistant_id=? AND memory_id=? AND event_type='visualUserCorrection' ORDER BY revision DESC LIMIT 1").get(owner.assistantId,`visual-episode:${episode.episodeId}`);if(!entry||Buffer.byteLength(String(entry.payload_json))>8192)return null;
   const correction=JSON.parse(String(entry.payload_json)) as VisualUserCorrection;
   if(correction.recordType!=='visualUserCorrection'||correction.sourceType!=='humanEntry'||correction.untrusted!==true||typeof correction.content!=='string'||!correction.content.trim()||Buffer.byteLength(correction.content)>2400||correction.actor!==owner.principalId||correction.relationshipId!==owner.relationshipId||correction.episodeId!==episode.episodeId||correction.correctionId!==payload.correctionId||!episode.correctionRefs.includes(correction.correctionId)||correction.sourceEpisodeRevision!==payload.sourceEpisodeRevision||correction.sourceEpisodeRevision!==episode.revision-1||correction.sourceDigest!==episode.sourceDigest||!isDeepStrictEqual(correction.sourceObservationIds,episode.sourceObservationIds)||correction.occurredAt!==row.occurred_at||!Number.isFinite(Date.parse(correction.occurredAt))||!Number.isSafeInteger(now)||Date.parse(correction.occurredAt)>now||Date.parse(correction.occurredAt)<Date.parse(canonical.createdAt))return null;
   const sourceReceipt={eventId:mutation.eventId,assistantId:owner.assistantId,memoryId,oldRevision:mutation.oldRevision as number,newRevision:mutation.newRevision as number,occurredAt:correction.occurredAt,humanEntryId:correction.correctionId,sourceRevision:{providerRef:'urn:lifestream:sqlite:visual-memory',revision:`correction:${mutation.eventId}`,highWaterMark:null}};
   const bytes=JSON.stringify({schemaVersion:'1.0.0',recordType:'redactedVisualCorrectionSource',...sourceReceipt,mutationEnvironmentId:payload.visualMutationEnvironmentId,episodeId:episode.episodeId,episodeRevision:episode.revision,sourceDigest:episode.sourceDigest,status:'contradicted',needsReview:true,correctedFactProved:false}),sha256=createHash('sha256').update(bytes).digest('hex');
   const scope={assistantId:owner.assistantId,environmentId:payload.visualMutationEnvironmentId as string,conversationId:null,sessionId:null,endpointId:null};
   const evidence:VisualCorrectionEvidence=immutable({schemaVersion:'1.0.0',recordType:'visualCorrectionEvidence',ownerDigest:key(owner),scope,sourceReceipt,artifact:{reference:{reference:`urn:lifestream:visual-correction-source:sha256:${sha256}`,sha256,mediaType:'application/json',schemaRef:'urn:lifestream:visual-correction-source:1.0.0',byteLength:Buffer.byteLength(bytes)},bytes}});visualCorrectionSources.add(evidence);return evidence;
  }catch{return null;}
 }
 admit(owner:VisualMemoryOwner,input:unknown,admission:VisualMemoryAdmission):VisualMemoryReceipt{
  this.sweep();let bytes:string;
  try{bytes=JSON.stringify(input);if(Buffer.byteLength(bytes)>8192)return {state:'invalidEpisode'};}catch{return {state:'invalidEpisode'};}
  // Snapshot caller objects before validating or inspecting them.
  const episode=JSON.parse(bytes!) as VisualObservationEpisode;
  if(!validateVisualEpisode(episode).valid)return {state:'invalidEpisode'};
  const policy=this.policy(owner),now=this.now(),scopeKey=key(owner);
  if(!policy.enabled||policy.revision!==admission.policyRevision||policy.revision!==episode.processingPolicyRevision||episode.retentionPolicyRef!==policy.retentionPolicyRef)return {state:'policyDenied'};
  if(admission.current!==true||!ownerValid(owner)||!isDeepStrictEqual(episode.scope,admission.scope)||['principalId','assistantId','relationshipId'].some(field=>episode.scope[field as keyof VisualMemoryOwner]!==owner[field as keyof VisualMemoryOwner]))return {state:'scopeChanged'};
  if(!['meaningfulEvent','meaningfulChange','conversationRelevance','appearanceContinuity'].includes(admission.reason))return {state:'invalidEpisode'};
  if(episode.state!=='candidate'||episode.revision!==1||episode.memoryRecordId!==null||episode.correctionRefs.length||episode.sourceDigest!==visualEpisodeSourceDigest(episode))return {state:'invalidEpisode'};
  const observationIds=episode.observations.map(o=>o.observationId),families=[...new Set(episode.observations.map(o=>o.independenceKey))];
  if(new Set(observationIds).size!==observationIds.length||families.length!==1||!isDeepStrictEqual([...episode.sourceObservationIds].sort(),[...observationIds].sort())||!isDeepStrictEqual([...episode.independenceKeys].sort(),[...families].sort())||new Set(episode.observations.map(o=>o.batchId)).size!==1)return {state:'invalidEpisode'};
  // This path admits personal observations only with independent host visual association.
  if(!admission.verifiedSubjectRef||episode.observations.some(o=>o.subject.subjectRef!==admission.verifiedSubjectRef||o.subject.binding==='unidentified'||!o.subject.basisRefs.length))return {state:'unattributedSubject'};
  const earliest=Math.min(...episode.observations.map(o=>Date.parse(o.earliestCaptureAt)));
  const expires=Date.parse(episode.expiresAt);
  if(Date.parse(episode.occurredAt)!==earliest||expires<=now||expires>earliest+policy.retentionMs!||episode.observations.some(o=>{
   const capture=Date.parse(o.earliestCaptureAt),latest=Date.parse(o.latestCaptureAt),received=Date.parse(o.receivedAt),interpreted=Date.parse(o.interpretedAt);
   // The producer's interval includes clock uncertainty, not a claimed exact
   // future event. Preserve it; earliest capture must still precede receipt.
   return capture>latest||capture>received||latest>received+250||latest-capture>2250||received>interpreted||interpreted>now||Date.parse(o.expiresAt)<=now||Date.parse(o.expiresAt)>capture+6000;
  }))return {state:'sourceExpired'};
  const sessionKey=digest([scopeKey,episode.scope.sessionId]),appearanceKey=admission.reason==='appearanceContinuity'?digest([sessionKey,admission.verifiedSubjectRef]):null;
  const sources=[...new Set([...families.map(x=>`family:${x}`),...observationIds.map(x=>`observation:${x}`),...episode.observations.flatMap(o=>o.sourceFrameIds.map(x=>`frame:${x}`))])].map(x=>digest([scopeKey,x]));
  const retained={...episode,state:'retained' as const,retainedAt:new Date(now).toISOString()};
  if(Buffer.byteLength(JSON.stringify(retained))>8192)return {state:'invalidEpisode'};
  return this.db.transaction(tx=>{
   // Atomic durable policy check precedes all payload/fence writes.
   if(!this.policy(owner).enabled||this.policy(owner).revision!==policy.revision)return {state:'policyDenied'};
   if(tx.get('SELECT 1 FROM visual_observation_episodes WHERE episode_id=?',episode.episodeId)||sources.some(source=>tx.get('SELECT 1 FROM visual_episode_sources WHERE scope_key=? AND source_key=?',scopeKey,source)))return {state:'duplicateSource'};
   if(appearanceKey&&tx.get('SELECT 1 FROM visual_observation_episodes WHERE appearance_key=?',appearanceKey))return {state:'appearanceBound'};
   if(Number(tx.get<{n:number}>('SELECT count(*) AS n FROM visual_observation_episodes WHERE session_key=? AND retained_at>?',sessionKey,now-3600000)!.n)>=12)return {state:'sessionBound'};
   if(Number(tx.get<{n:number}>('SELECT count(*) AS n FROM visual_observation_episodes WHERE scope_key=?',scopeKey)!.n)>=10000)return {state:'capacityExceeded'};
   tx.run('INSERT INTO visual_observation_episodes VALUES (?,?,?,?,?,?,?,?,?)',episode.episodeId,scopeKey,sessionKey,appearanceKey,1,'retained',now,expires,JSON.stringify(retained));
   for(const source of sources)tx.run('INSERT INTO visual_episode_sources VALUES (?,?,?)',scopeKey,source,episode.episodeId);
   return {state:'retained',episodeId:episode.episodeId};
  });
 }
 /** An authenticated Human entry qualifies the original interpretation; it is
  * not a rewritten observation or independently observed sensor opportunity.
  * No numeric transformation confidence or spoken turn is manufactured. */
 correct(owner:VisualMemoryOwner,id:string,expectedRevision:number,content:string,environmentId?:string){
  this.sweep();const now=this.now(),policy=this.policy(owner);
  if(!ownerValid(owner)||!policy.enabled||typeof content!=='string'||!content.trim()||content.length>1200||Buffer.byteLength(content)>2400)throw Error('Visual correction unavailable');
  return this.db.transaction(tx=>{
   const row=tx.get<Row>('SELECT episode_id,revision,state,expires_at,payload_json FROM visual_observation_episodes WHERE scope_key=? AND episode_id=?',key(owner),id);
   if(!row||row.state!=='retained'||row.revision!==expectedRevision||!row.payload_json||row.expires_at<=now)throw Error('Visual correction revision conflict');
   const original=JSON.parse(row.payload_json) as VisualObservationEpisode;
   if(!validateVisualEpisode(original).valid||!['retained','superseded'].includes(original.state)||original.sourceDigest!==visualEpisodeSourceDigest(original)||original.processingPolicyRevision!==policy.revision||!['principalId','assistantId','relationshipId'].every(field=>original.scope[field as keyof VisualMemoryOwner]===owner[field as keyof VisualMemoryOwner])||original.correctionRefs.length>=16)throw Error('Visual correction source unavailable');
   const correction:VisualUserCorrection={recordType:'visualUserCorrection',sourceType:'humanEntry',correctionId:randomUUID(),actor:owner.principalId,relationshipId:owner.relationshipId,episodeId:id,sourceEpisodeRevision:expectedRevision,sourceDigest:original.sourceDigest,sourceObservationIds:[...original.sourceObservationIds],content,occurredAt:new Date(now).toISOString(),untrusted:true};
   const episode:VisualObservationEpisode={...original,revision:row.revision+1,state:'superseded',correctionRefs:[...original.correctionRefs,correction.correctionId]};
   if(Buffer.byteLength(JSON.stringify(episode))>8192)throw Error('Visual correction capacity exceeded');
   let correctionMutationEventId:string|null=null;
   if(original.memoryRecordId){
    const memory=tx.get<{provenance_json:string;lifecycle_json:string}>('SELECT provenance_json,lifecycle_json FROM memories WHERE id=? AND assistant_id=?',original.memoryRecordId,owner.assistantId);
    if(!memory)throw Error('Visual correction projection unavailable');
    const provenance=JSON.parse(memory.provenance_json),lifecycle=JSON.parse(memory.lifecycle_json),canonical=provenance.canonical as VisualMemoryProjection['memoryRecord'];
    if(provenance.actor!==owner.principalId||provenance.relationshipId!==owner.relationshipId||provenance.visualEpisodeRevision!==row.revision||!validateVisualMemoryProjection({schemaVersion:'1.0.0',recordType:'visualMemoryProjection',episode:original,memoryRecord:canonical}).valid)throw Error('Visual correction projection unavailable');
    canonical.status='contradicted';canonical.provenance.sourceRefs=[`visual-episode:${id}:${episode.revision}:${episode.sourceDigest}`];canonical.extensions['lifestream.conversationalVision'].episodeRevision=episode.revision;
    const next={...lifecycle,status:'contradicted',revision:Number(lifecycle.revision)+1,changedBy:owner.principalId,needsReview:true};
    tx.run('UPDATE memories SET provenance_json=?,lifecycle_json=? WHERE id=?',JSON.stringify({...provenance,visualEpisodeRevision:episode.revision,canonical}),JSON.stringify(next),original.memoryRecordId);
    const revision=tx.get<{n:number}>('SELECT COALESCE(MAX(revision),0)+1 AS n FROM memory_lifecycle_events WHERE memory_id=?',original.memoryRecordId)!.n;
    const visualMutation=visualSourceMutationIdentity('correction',lifecycle.revision);correctionMutationEventId=visualMutation.eventId;
    tx.run('INSERT INTO memory_lifecycle_events (memory_id,assistant_id,revision,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?)',original.memoryRecordId,owner.assistantId,revision,'visualCorrectionApplied',JSON.stringify({actor:owner.principalId,correctionId:correction.correctionId,status:'contradicted',sourceEpisodeRevision:expectedRevision,visualMutation,visualMutationEnvironmentId:typeof environmentId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(environmentId)?environmentId:null}),correction.occurredAt);
   }
   const eventKey=`visual-episode:${id}`,eventRevision=tx.get<{n:number}>('SELECT COALESCE(MAX(revision),0)+1 AS n FROM memory_lifecycle_events WHERE memory_id=?',eventKey)!.n;
   tx.run('INSERT INTO memory_lifecycle_events (memory_id,assistant_id,revision,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?)',eventKey,owner.assistantId,eventRevision,'visualUserCorrection',JSON.stringify(correction),correction.occurredAt);
   tx.run('UPDATE visual_observation_episodes SET revision=?,payload_json=? WHERE episode_id=?',episode.revision,JSON.stringify(episode),id);
   return {episodeId:id,revision:episode.revision,sourceObservationIds:episode.sourceObservationIds,correctionId:correction.correctionId,correctionMutationEventId};
  });
 }
 /** Complete bounded inventory with terminal receipts; fresh permission is supplied by the host. */
 inspect(owner:VisualMemoryOwner,allowed:boolean,limit=128){
  this.sweep();if(!Number.isSafeInteger(limit)||limit<1||limit>128)throw Error('Visual inventory bound exceeded');
  if(!allowed)return {policy:this.policy(owner),episodes:[],complete:false};
  const rows=this.db.connection.prepare('SELECT episode_id,revision,state,expires_at,payload_json FROM visual_observation_episodes WHERE scope_key=? ORDER BY retained_at DESC,episode_id LIMIT ?').all(key(owner),limit+1) as Row[];
  return {policy:this.policy(owner),complete:rows.length<=limit,episodes:rows.slice(0,limit).map(row=>({episodeId:row.episode_id,revision:row.revision,state:row.state,expiresAt:new Date(row.expires_at).toISOString(),episode:row.payload_json?JSON.parse(row.payload_json) as VisualObservationEpisode:null,corrections:row.payload_json?(this.db.connection.prepare("SELECT payload_json FROM memory_lifecycle_events WHERE memory_id=? AND assistant_id=? AND event_type='visualUserCorrection' ORDER BY revision LIMIT 16").all(`visual-episode:${row.episode_id}`,owner.assistantId) as {payload_json:string}[]).map(event=>JSON.parse(event.payload_json) as VisualUserCorrection):[]}))};
 }
 /** Exhaustive scoped inventory, never a top-k semantic search. Missing erased
  * metadata suppresses coverage rather than hiding a potential contrary source.
  * Historical eligibility uses retention, not the old capture's six-second TTL. */
 retainedWindow(owner:VisualMemoryOwner,allowed:boolean,fromMs:number,toMs:number):VisualRetainedWindow{
  this.sweep();const now=this.now(),policy=this.policy(owner);
  const unavailable=(reason:VisualRetainedWindow['reason'])=>immutable({fromMs,toMs,complete:false,reason,boundaryRevision:'unavailable',episodes:[]} as VisualRetainedWindow);
  if(!ownerValid(owner)||!allowed||!policy.enabled)return unavailable('scopeUnavailable');
  if(!Number.isSafeInteger(fromMs)||!Number.isSafeInteger(toMs)||fromMs<0||fromMs>=toMs||toMs>now||now-toMs>6000)return unavailable('invalidWindow');
  // Retention time can be later than capture. Include all late admissions,
  // including those beyond the pinned end, so they change the boundary.
  const rows=this.db.connection.prepare('SELECT episode_id,revision,state,expires_at,payload_json FROM visual_observation_episodes WHERE scope_key=? AND retained_at>=? ORDER BY retained_at,episode_id LIMIT 129').all(key(owner),fromMs) as Row[];
  if(rows.length>128)return unavailable('capacityExceeded');
  const revision=digest([key(owner),policy,fromMs,toMs,rows]),episodes:VisualObservationEpisode[]=[];let complete=true;
  for(const row of rows){
   if(row.state!=='retained'||!row.payload_json){complete=false;continue;}
   const episode=JSON.parse(row.payload_json) as VisualObservationEpisode,capture=Date.parse(episode.occurredAt);
   if(!validateVisualEpisode(episode).valid||episode.state!=='retained'||episode.revision!==row.revision||episode.sourceDigest!==visualEpisodeSourceDigest(episode)||episode.processingPolicyRevision!==policy.revision||Date.parse(episode.expiresAt)<=now||!['principalId','assistantId','relationshipId'].every(field=>episode.scope[field as keyof VisualMemoryOwner]===owner[field as keyof VisualMemoryOwner])){complete=false;continue;}
   if(capture>=fromMs&&capture<toMs)episodes.push(episode);
  }
  const result=immutable({fromMs,toMs,complete,reason:complete?'complete':'missingSource',boundaryRevision:revision,episodes} as VisualRetainedWindow);
  if(complete)windowGuards.set(result,{repository:this,owner:structuredClone(owner),fromMs,toMs,revision,lastNow:now,deadline:performance.now()+6000-(now-toMs),retired:false,checking:false});return result;
 }
 /** Authentic local selection only; no JSON clone can revive a stale boundary. */
 retainedWindowCurrent(window:VisualRetainedWindow,allowed:boolean):boolean{
  const guard=windowGuards.get(window);if(!guard||guard.retired||guard.repository!==this)return false;if(guard.checking){guard.retired=true;return false;}guard.checking=true;
  try{const now=this.now();if(!allowed||now<guard.lastNow||performance.now()>=guard.deadline){guard.retired=true;return false;}
   const current=this.retainedWindow(guard.owner,allowed,guard.fromMs,guard.toMs);
   if(!current.complete||current.boundaryRevision!==guard.revision||guard.retired){guard.retired=true;return false;}guard.lastNow=now;return true;
  }catch{guard.retired=true;return false;}finally{guard.checking=false;}
 }
 forget(owner:VisualMemoryOwner,id:string,expectedRevision:number):boolean{
  this.sweep();return this.db.transaction(tx=>{tx.run("UPDATE visual_observation_episodes SET state='forgotten',payload_json=NULL,revision=revision+1 WHERE scope_key=? AND episode_id=? AND revision=? AND state='retained'",key(owner),id,expectedRevision);
   if(tx.get<{n:number}>('SELECT changes() AS n')!.n!==1)throw Error('Visual episode revision conflict');retireVisualProjections(tx,this.now());return true;});
 }
 /** Restore never carries visual consent or payload forward without current safety replay support. */
 quarantine():number{
  return this.db.transaction(tx=>{
   const n=Number(tx.get<{n:number}>("SELECT count(*) AS n FROM visual_observation_episodes WHERE state='retained'")!.n);
   tx.run("UPDATE visual_observation_episodes SET state='invalidated',payload_json=NULL,revision=revision+1 WHERE state='retained'");
   tx.run('UPDATE visual_memory_policies SET enabled=0,revision=revision+1');retireVisualProjections(tx,this.now());return n;
  });
 }
}
