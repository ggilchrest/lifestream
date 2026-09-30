import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateVisualEpisode,type VisualMemoryOwner,type VisualMemoryScope,type VisualObservationEpisode} from '@lifestream/contracts/visual-memory';
import type {Database} from './database.ts';

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
  });return this.policy(owner);
 }
 sweep():number{
  return Number(this.db.connection.prepare("UPDATE visual_observation_episodes SET state='expired',payload_json=NULL,revision=revision+1 WHERE state='retained' AND expires_at<=?").run(this.now()).changes);
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
   return capture>latest||latest>received||received>interpreted||interpreted>now||Date.parse(o.expiresAt)<=now;
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
 forget(owner:VisualMemoryOwner,id:string,expectedRevision:number):boolean{
  this.sweep();const result=this.db.connection.prepare("UPDATE visual_observation_episodes SET state='forgotten',payload_json=NULL,revision=revision+1 WHERE scope_key=? AND episode_id=? AND revision=? AND state='retained'").run(key(owner),id,expectedRevision);
  if(result.changes!==1)throw Error('Visual episode revision conflict');return true;
 }
 /** Restore never carries visual consent or payload forward without current safety replay support. */
 quarantine():number{
  return this.db.transaction(tx=>{
   const n=Number(tx.get<{n:number}>("SELECT count(*) AS n FROM visual_observation_episodes WHERE state='retained'")!.n);
   tx.run("UPDATE visual_observation_episodes SET state='invalidated',payload_json=NULL,revision=revision+1 WHERE state='retained'");
   tx.run('UPDATE visual_memory_policies SET enabled=0,revision=revision+1');return n;
  });
 }
}
