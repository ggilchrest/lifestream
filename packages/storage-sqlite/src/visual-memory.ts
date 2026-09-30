import {createHash,randomUUID} from 'node:crypto';
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
type Row={episode_id:string;revision:number;state:string;expires_at:number;payload_json:string|null};
export type VisualRetainedWindow=Readonly<{fromMs:number;toMs:number;complete:boolean;reason:'complete'|'scopeUnavailable'|'invalidWindow'|'capacityExceeded'|'missingSource';boundaryRevision:string;episodes:readonly VisualObservationEpisode[]}>;
type WindowGuard={repository:VisualMemoryRepository;owner:VisualMemoryOwner;fromMs:number;toMs:number;revision:string;lastNow:number;deadline:number;retired:boolean;checking:boolean};
const windowGuards=new WeakMap<VisualRetainedWindow,WindowGuard>();
function immutable<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;}

/** Run inside the source lifecycle transaction. Candidate content and historic
 * event payloads are erased; opaque lifecycle receipts remain. */
export function retireVisualProjections(tx:Transaction,now:number){
 const rows=tx.all<{id:string;assistant_id:string;provenance_json:string;lifecycle_json:string}>("SELECT id,assistant_id,provenance_json,lifecycle_json FROM memories WHERE json_extract(provenance_json,'$.visualEpisodeId') IN (SELECT episode_id FROM visual_observation_episodes WHERE state<>'retained') AND json_extract(lifecycle_json,'$.contentRemoved') IS NOT 1");
 for(const row of rows){const provenance=JSON.parse(row.provenance_json) as {actor:string},lifecycle=JSON.parse(row.lifecycle_json) as {revision:number},revision=tx.get<{n:number}>('SELECT COALESCE(MAX(revision),0)+1 AS n FROM memory_lifecycle_events WHERE memory_id=?',row.id)!.n;
  tx.run("UPDATE memories SET content='',provenance_json=?,lifecycle_json=? WHERE id=?",JSON.stringify({actor:provenance.actor,payloadRemoved:true}),JSON.stringify({status:'invalidated',revision:lifecycle.revision+1,contentRemoved:true,reason:'visual source retired',changedBy:provenance.actor}),row.id);
  tx.run('UPDATE memory_lifecycle_events SET payload_json=? WHERE memory_id=?',JSON.stringify({payloadRemoved:true}),row.id);
  tx.run('INSERT INTO memory_lifecycle_events (memory_id,assistant_id,revision,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?)',row.id,row.assistant_id,revision,'forgotten',JSON.stringify({status:'invalidated',contentRemoved:true,reason:'visual source retired'}),new Date(now).toISOString());
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
 /** Complete bounded inventory with terminal receipts; fresh permission is supplied by the host. */
 inspect(owner:VisualMemoryOwner,allowed:boolean,limit=128){
  this.sweep();if(!Number.isSafeInteger(limit)||limit<1||limit>128)throw Error('Visual inventory bound exceeded');
  if(!allowed)return {policy:this.policy(owner),episodes:[],complete:false};
  const rows=this.db.connection.prepare('SELECT episode_id,revision,state,expires_at,payload_json FROM visual_observation_episodes WHERE scope_key=? ORDER BY retained_at DESC,episode_id LIMIT ?').all(key(owner),limit+1) as Row[];
  return {policy:this.policy(owner),complete:rows.length<=limit,episodes:rows.slice(0,limit).map(row=>({episodeId:row.episode_id,revision:row.revision,state:row.state,expiresAt:new Date(row.expires_at).toISOString(),episode:row.payload_json?JSON.parse(row.payload_json) as VisualObservationEpisode:null}))};
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
