import {selectSemanticMemory} from './semantic-memory-recall.ts';
import {createHash} from 'node:crypto';
import {memoryProposalInstruction,validateMemoryProposals,proposalDigest,proposalContent,type MemoryProposalBatch} from './memory-proposals.ts';
import {VisualMemoryRepository,retireVisualProjections,retireGameExperience,type VisualMemoryAdmission,type Database,type MemoryRepository,type MemoryRecord} from '@lifestream/storage-sqlite';
import type {VisualTransformationConfidence} from '@lifestream/contracts/visual-memory';
import {buildCanonicalPrompt} from '@lifestream/runtime/inference/prompt';
import type {InferenceProvider} from '@lifestream/runtime/inference';
import {visualPublicationEpisode,type VisualMemoryPublication,type VisualMemorySelection} from './visual-memory-intake.ts';
import {VisualMemoryEvidence} from './visual-memory-evidence.ts';
import {VisualMemoryCandidateEvidence,isVisualMemoryLifecycleTrace,type VisualMemoryCandidateTrace} from './visual-memory-candidate-evidence.ts';
export type MemoryScope={principalId:string;assistantId:string;relationshipId:string};
type Work={id:string;scope:string;source:string;sourceContext:string|null;revision:number;input:string;prepared:string|null;proposalDigest:string|null;attempts:number;expires:number;state:string;reason:string|null};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key=(scope:MemoryScope)=>hash([scope.principalId,scope.assistantId,scope.relationshipId]);
const secret=/(?:\b(?:password|passphrase|api[ _-]?key|access[ _-]?token|private[ _-]?key|secret|social security|credit card)\b|-----BEGIN|\b(?:sk|ghp|gho)[_-][A-Za-z0-9_-]{12,}|\b\d{3}-\d{2}-\d{4}\b)/iu;
// Retained conservative privacy screen; it does not score semantic worth.
const thirdParty=/\b(?:my|our)\s+(?:sister|brother|mother|father|friend|colleague|coworker|partner|wife|husband|daughter|son|client|patient)\b/iu;
async function* bounded<T>(source:AsyncIterable<T>,signal:AbortSignal):AsyncGenerator<T>{
 const iterator=source[Symbol.asyncIterator]();let cancel=()=>{};const stopped=new Promise<never>((_resolve,reject)=>{cancel=()=>reject(new Error("Memory extraction cancelled"));signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});void stopped.catch(()=>{});
 try{while(true){const next=await Promise.race([iterator.next(),stopped]);if(next.done)return;yield next.value;}}
 finally{signal.removeEventListener('abort',cancel);if(signal.aborted)void iterator.return?.().catch(()=>{});}
}
export class AutomaticMemory {
 private readonly environmentId:string|undefined;
 private readonly database:Database;private readonly memories:MemoryRepository;private readonly visual:VisualMemoryRepository;
 private readonly provider:()=>{provider:InferenceProvider;revision:string};private readonly idle:()=>boolean;
 private readonly scopeAllowed:(scope:MemoryScope)=>boolean;private readonly contentAllowed:(scope:MemoryScope,content:string)=>boolean;
 private readonly changed:()=>void;private timer:ReturnType<typeof setInterval>;private controller:AbortController|null=null;private activeWork:{id:string;expires:number}|null=null;private closed=false;
 private readonly visualPending=new Map<string,{publication:VisualMemoryPublication;selection:VisualMemorySelection;scope:MemoryScope;memoryRevision:number;visualRevision:number}>();
 private readonly visualIntakeReceipts=new Map<string,{scope:MemoryScope;requestId:string;state:string;expires:number}>();
 private readonly visualIntakeJournal=new VisualMemoryEvidence();
 private readonly visualCandidateJournal=new VisualMemoryCandidateEvidence();
 private noteVisual(scope:MemoryScope,requestId:string,state:string){
  const id=hash([key(scope),requestId]);this.visualIntakeReceipts.delete(id);this.visualIntakeReceipts.set(id,{scope,requestId,state,expires:Date.now()+60000});
  if(this.visualIntakeReceipts.size>128)this.visualIntakeReceipts.delete(this.visualIntakeReceipts.keys().next().value!);
  this.visualIntakeJournal.record(scope,requestId,state);
 }
 /** Internal owner-scoped diagnostics only; never part of model input or recall. */
 visualIntakeHistory(scope:MemoryScope){
  try{if(this.closed||!this.scopeAllowed(scope))return Object.freeze([]);const receipts=this.visualIntakeJournal.receipts(scope);return !this.closed&&this.scopeAllowed(scope)?receipts:Object.freeze([]);}catch{return Object.freeze([]);}
 }
 private readableVisualTraceSources<T extends VisualMemoryCandidateTrace>(scope:MemoryScope,traces:readonly T[]):readonly T[]{
  try{this.visual.sweep();for(const trace of traces){const memoryId=(trace.event.payload as {memoryId:string}).memoryId,record=this.memories.get(scope.assistantId,memoryId);
   if(!record||record.provenance.actor!==scope.principalId||record.provenance.relationshipId!==scope.relationshipId||typeof record.provenance.visualEpisodeId!=='string'||!['candidate','active'].includes(String(record.lifecycle.status)))throw Error('source');
   if(isVisualMemoryLifecycleTrace(trace)){const current=this.visual.activationEvidence(scope,memoryId);if(!current||current.event.eventId!==trace.sourceMutation.eventId||current.artifact.reference.sha256!==trace.artifact.reference.sha256)throw Error('mutation source');}
   else {const metadata=JSON.parse(trace.artifact.bytes);if(record.provenance.visualEpisodeId!==metadata.sourceEpisodeId||record.provenance.visualSourceDigest!==metadata.sourceDigest)throw Error('candidate source');}
  }return traces;}catch{this.visualCandidateJournal.forgetOwner(scope);return Object.freeze([]);}
 }
 /** Historical candidate metadata only; consent and current owner scope fence reads. */
 visualCandidateHistory(scope:MemoryScope){
  try{const memory=this.policy(scope),visual=this.visual.policy(scope);if(this.closed||!memory.enabled||!visual.enabled||!this.scopeAllowed(scope))return Object.freeze([]);return !this.closed&&this.scopeAllowed(scope)&&this.policy(scope).enabled&&this.policy(scope).revision===memory.revision&&this.visual.policy(scope).enabled&&this.visual.policy(scope).revision===visual.revision?this.readableVisualTraceSources(scope,this.visualCandidateJournal.traces(scope)):Object.freeze([]);}catch{return Object.freeze([]);}
 }
 /** Same restricted source journal and scope/consent fences as candidate metadata. */
 visualLifecycleHistory(scope:MemoryScope){
  try{const memory=this.policy(scope),visual=this.visual.policy(scope);if(this.closed||!memory.enabled||!visual.enabled||!this.scopeAllowed(scope))return Object.freeze([]);return !this.closed&&this.scopeAllowed(scope)&&this.policy(scope).enabled&&this.policy(scope).revision===memory.revision&&this.visual.policy(scope).enabled&&this.visual.policy(scope).revision===visual.revision?this.readableVisualTraceSources(scope,this.visualCandidateJournal.lifecycleTraces(scope)):Object.freeze([]);}catch{return Object.freeze([]);}
 }
 /** Restricted correction diagnostics, distinct from eligible recall and from
  * canonical activation operations. Read the actual source after host hooks. */
 visualCorrectionHistory(scope:MemoryScope){
  try{
   const memory=this.policy(scope),visual=this.visual.policy(scope);if(this.closed||!memory.enabled||!visual.enabled||!this.scopeAllowed(scope))return Object.freeze([]);
   const traces=this.visualCandidateJournal.correctionTraces(scope);
   if(this.closed||!this.scopeAllowed(scope)||!this.policy(scope).enabled||this.policy(scope).revision!==memory.revision||!this.visual.policy(scope).enabled||this.visual.policy(scope).revision!==visual.revision)return Object.freeze([]);
   for(const trace of traces){const source=this.visual.correctionEvidence(scope,trace.sourceReceipt.memoryId);if(!source||source.sourceReceipt.eventId!==trace.sourceReceipt.eventId||source.artifact.reference.sha256!==trace.artifact.reference.sha256){this.visualCandidateJournal.forgetOwner(scope);return Object.freeze([]);}}
   return traces;
  }catch{this.visualCandidateJournal.forgetOwner(scope);return Object.freeze([]);}
 }
 constructor(options:{environmentId?:string;database:Database;memories:MemoryRepository;provider:()=>{provider:InferenceProvider;revision:string};idle:()=>boolean;changed:()=>void;scopeAllowed?:(scope:MemoryScope)=>boolean;contentAllowed?:(scope:MemoryScope,content:string)=>boolean}){
  this.environmentId=typeof options.environmentId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(options.environmentId)?options.environmentId:undefined;this.scopeAllowed=options.scopeAllowed??(()=>true);this.contentAllowed=options.contentAllowed??(()=>true);this.database=options.database;this.memories=options.memories;this.provider=options.provider;this.idle=options.idle;this.changed=options.changed;
  this.visual=new VisualMemoryRepository(this.database);this.sweepExpired();this.database.exec("UPDATE automatic_memory_work SET state=CASE WHEN prepared_json IS NULL THEN 'queued' ELSE 'prepared' END WHERE state='running'");
  this.timer=setInterval(()=>void this.tick(),500);this.timer.unref();
 }
 policy(scope:MemoryScope){const row=this.database.connection.prepare('SELECT enabled,revision,approved_at AS approvedAt FROM automatic_memory_policies WHERE scope_key=?').get(key(scope)) as {enabled:number;revision:number;approvedAt:string}|undefined;return row?{...row,enabled:row.enabled===1}:{enabled:false,revision:0,approvedAt:null};}
 configureVisual(scope:MemoryScope,enabled:boolean,expectedRevision:number,retentionMs:number|null){
  if(enabled&&(!this.policy(scope).enabled||!this.scopeAllowed(scope)))throw Error('Visual memory requires current owned memory consent');
  const policy=this.visual.configure(scope,enabled,expectedRevision,retentionMs);this.visualCandidateJournal.forgetOwner(scope);this.changed();return policy;
 }
 /** Canonical host-only intake. No synthetic user turn or inference-provider call. */
 enqueueVisual(scope:MemoryScope,input:unknown,admission:VisualMemoryAdmission,current:()=>boolean=()=>admission.current){
  let copy:unknown;try{const raw=JSON.stringify(input);if(Buffer.byteLength(raw)>8192)return {state:'invalidEpisode' as const};copy=JSON.parse(raw);}catch{return {state:'invalidEpisode' as const};}
  const memoryRevision=this.policy(scope).revision;
  if(!this.policy(scope).enabled||!this.scopeAllowed(scope))return {state:'policyDenied' as const};
  const value=copy as {summary?:unknown;observations?:unknown};
  if(typeof value?.summary!=='string'||!Array.isArray(value.observations)||secret.test(value.summary)||!this.contentAllowed(scope,value.summary)||value.observations.some(o=>!o||typeof o.description!=='string'||secret.test(o.description)||!this.contentAllowed(scope,o.description)))return {state:'policyDenied' as const};
  // Content/privacy hooks may revoke authority while checking the source.
  if(!this.scopeAllowed(scope)||!this.policy(scope).enabled||this.policy(scope).revision!==memoryRevision)return {state:'policyDenied' as const};
  if(!current())return {state:'scopeChanged' as const};
  if(!this.policy(scope).enabled||this.policy(scope).revision!==memoryRevision)return {state:'policyDenied' as const};
  const result=this.visual.admit(scope,copy,admission);if(result.state==='retained')this.changed();return result;
 }
 /** One latest publication per session, at most four sessions. No model work,
  * persistence or foreground waiting occurs in the publication callback. */
 queueVisualPublication(publication:VisualMemoryPublication,selection:VisualMemorySelection){
  if(this.closed||!publication.batch.scope.relationshipId)return {state:'notAdmitted' as const};
  const scope={principalId:publication.batch.scope.principalId,assistantId:publication.batch.scope.assistantId,relationshipId:publication.batch.scope.relationshipId};
  const memory=this.policy(scope),visual=this.visual.policy(scope);
  if(!memory.enabled||!visual.enabled||!this.scopeAllowed(scope)||!publication.isCurrent()){this.noteVisual(scope,publication.batch.requestId,'policyDenied');return {state:'policyDenied' as const};}
  try{
   const serialized=JSON.stringify({batch:publication.batch,freshUntilMs:publication.freshUntilMs,selection});if(Buffer.byteLength(serialized)>32768)return {state:'capacityExceeded' as const};
   const copy=JSON.parse(serialized) as {batch:VisualMemoryPublication['batch'];freshUntilMs:number;selection:VisualMemorySelection};
   if(!publication.isCurrent()||this.policy(scope).revision!==memory.revision||this.visual.policy(scope).revision!==visual.revision)return {state:'policyDenied' as const};
   const pendingKey=publication.batch.scope.sessionId;
   if(!this.visualPending.has(pendingKey)&&this.visualPending.size>=4)return {state:'capacityExceeded' as const};
   const previous=this.visualPending.get(pendingKey);if(previous)this.noteVisual(previous.scope,previous.publication.batch.requestId,'replaced');
   this.visualPending.set(pendingKey,{publication:{batch:copy.batch,freshUntilMs:copy.freshUntilMs,isCurrent:publication.isCurrent},selection:copy.selection,scope,memoryRevision:memory.revision,visualRevision:visual.revision});this.noteVisual(scope,copy.batch.requestId,'queued');return {state:'queued' as const};
  }catch{return {state:'notAdmitted' as const};}
 }
 private visualCurrent(item:{publication:VisualMemoryPublication;scope:MemoryScope;memoryRevision:number;visualRevision:number}){
  try{return item.publication.freshUntilMs>Date.now()&&this.policy(item.scope).enabled&&this.policy(item.scope).revision===item.memoryRevision&&this.visual.policy(item.scope).enabled&&this.visual.policy(item.scope).revision===item.visualRevision&&this.scopeAllowed(item.scope)&&item.publication.isCurrent();}catch{return false;}
 }
 /** Minimal successful-forget diagnostics under current owner/consent, never
  * recalled content. The actual source is checked after final host hooks. */
 visualErasureHistory(scope:MemoryScope){
  try{
   const memory=this.policy(scope),visual=this.visual.policy(scope);if(this.closed||!memory.enabled||!visual.enabled||!this.scopeAllowed(scope))return Object.freeze([]);
   if(this.closed||!this.scopeAllowed(scope)||!this.policy(scope).enabled||this.policy(scope).revision!==memory.revision||!this.visual.policy(scope).enabled||this.visual.policy(scope).revision!==visual.revision)return Object.freeze([]);
   return this.visualCandidateJournal.erasureTraces(scope,source=>this.visual.erasureEvidenceCurrent(source));
  }catch{this.visualCandidateJournal.forgetOwner(scope);return Object.freeze([]);}
 }
 forgetVisual(scope:MemoryScope,id:string,revision:number){
  if(!this.scopeAllowed(scope))throw Error('Visual memory scope unavailable');
  const result=this.visual.forgetWithEvidence(scope,id,revision,this.environmentId);this.visualCandidateJournal.forgetOwner(scope);
  try{if(result.evidence&&!this.closed&&this.policy(scope).enabled&&this.visual.policy(scope).enabled&&this.scopeAllowed(scope)&&this.visual.erasureEvidenceCurrent(result.evidence))this.visualCandidateJournal.recordErasure(scope,result.evidence);}catch{/* Optional diagnostics cannot change committed forgetting. */}
  this.changed();
 }
 correctVisual(scope:MemoryScope,id:string,revision:number,content:string){
  const policy=this.policy(scope),visual=this.visual.inspect(scope,this.scopeAllowed(scope)),episode=visual.episodes.find(row=>row.episodeId===id)?.episode;
  if(!policy.enabled||!this.scopeAllowed(scope)||!episode||typeof content!=='string'||!content.trim()||content.length>1200||secret.test(content)||!this.contentAllowed(scope,content)||!this.contentAllowed(scope,episode.summary)||episode.observations.some(o=>!this.contentAllowed(scope,o.description)))throw Error('Visual correction scope unavailable');
  if(!this.scopeAllowed(scope)||!this.policy(scope).enabled||this.policy(scope).revision!==policy.revision||this.visual.policy(scope).revision!==visual.policy.revision)throw Error('Visual correction scope changed');
  const result=this.visual.correct(scope,id,revision,content,this.environmentId);this.visualCandidateJournal.forgetOwner(scope);
  if(episode.memoryRecordId){try{const source=this.visual.correctionEvidence(scope,episode.memoryRecordId);if(source)this.visualCandidateJournal.recordCorrection(scope,source);}catch{/* Source mutation remains committed if optional diagnostics fail. */}}
  this.changed();return result;
 }
 projectVisual(scope:MemoryScope,id:string,revision:number,estimate:VisualTransformationConfidence|null){
  const policy=this.policy(scope),visual=this.visual.inspect(scope,this.scopeAllowed(scope)),episode=visual.episodes.find(row=>row.episodeId===id)?.episode;
  if(!policy.enabled||!this.scopeAllowed(scope)||!episode||!this.contentAllowed(scope,episode.summary)||episode.observations.some(o=>!this.contentAllowed(scope,o.description)))return {state:'policyDenied' as const};
  if(!this.scopeAllowed(scope)||!this.policy(scope).enabled||this.policy(scope).revision!==policy.revision||this.visual.policy(scope).revision!==visual.policy.revision)return {state:'policyDenied' as const};
  const result=this.visual.project(scope,id,revision,estimate);
  if(result.state==='projected'){
   // Read the actual committed projection before invalidation callbacks. This
   // optional background evidence never repairs a missing source or mints a turn.
   try{const episode=this.visual.inspect(scope,true).episodes.find(row=>row.episodeId===id)?.episode,memory=this.memories.get(scope.assistantId,result.memoryId);if(episode&&memory)this.visualCandidateJournal.record(scope,{schemaVersion:'1.0.0',recordType:'visualMemoryProjection',episode,memoryRecord:memory.provenance.canonical});}catch{/* Projection success is independent of diagnostics. */}
   this.changed();
  }
  return result;
 }
 activateVisual(scope:MemoryScope,id:string,revision:number){
  const policy=this.policy(scope),visual=this.visual.inspect(scope,this.scopeAllowed(scope)),episode=visual.episodes.find(row=>row.episodeId===id)?.episode;
  if(!policy.enabled||!this.scopeAllowed(scope)||!episode||!this.contentAllowed(scope,episode.summary)||episode.observations.some(o=>!this.contentAllowed(scope,o.description)))return {state:'policyDenied' as const};
  if(!this.scopeAllowed(scope)||!this.policy(scope).enabled||this.policy(scope).revision!==policy.revision||this.visual.policy(scope).revision!==visual.policy.revision)return {state:'policyDenied' as const};
  const result=this.visual.activate(scope,id,revision);if(result.state==='active'){try{const evidence=this.visual.activationEvidence(scope,result.memoryId);if(evidence)this.visualCandidateJournal.recordActivation(scope,evidence);}catch{/* Actual mutation is independent of optional trace projection. */}this.changed();}return result;
 }
 visualEpisodesCurrent(scope:MemoryScope,episodes:readonly import('@lifestream/contracts/visual-memory').VisualObservationEpisode[],memoryRevision:number){
  if(!this.scopeAllowed(scope)||!this.policy(scope).enabled||this.policy(scope).revision!==memoryRevision)return false;
  if(!episodes.length)return true;
  const inventory=this.visual.inspect(scope,true);return inventory.policy.enabled&&episodes.every(episode=>episode.processingPolicyRevision===inventory.policy.revision&&inventory.episodes.some(row=>row.episode&&JSON.stringify(row.episode)===JSON.stringify(episode)))&&this.scopeAllowed(scope)&&this.policy(scope).revision===memoryRevision&&this.visual.policy(scope).revision===inventory.policy.revision;
 }
 /** Typed retained input for independently enabled reflection. It does not
  * require or manufacture a numeric canonical-memory projection estimate. */
 retainedVisualEpisodes(scope:MemoryScope){
  const policy=this.policy(scope),inventory=this.visual.inspect(scope,policy.enabled&&this.scopeAllowed(scope));
  const episodes=inventory.episodes.flatMap(row=>row.episode&&row.episode.state==='retained'&&!row.episode.correctionRefs.length&&row.episode.processingPolicyRevision===inventory.policy.revision?[row.episode]:[]);
  const eligible=episodes.filter(episode=>{const text=JSON.stringify(episode);return !secret.test(text)&&this.contentAllowed(scope,text);});
  if(!policy.enabled||!this.visualEpisodesCurrent(scope,eligible,policy.revision)||this.visual.policy(scope).revision!==inventory.policy.revision||!inventory.policy.enabled)return [];
  return eligible;
 }
 visualHistory(scope:MemoryScope,fromMs:number,toMs:number){
  const policy=this.policy(scope),allowed=()=>this.policy(scope).enabled&&this.policy(scope).revision===policy.revision&&this.scopeAllowed(scope),window=this.visual.retainedWindow(scope,allowed(),fromMs,toMs);
  const content=()=>window.episodes.every(episode=>this.contentAllowed(scope,episode.summary)&&episode.observations.every(o=>this.contentAllowed(scope,o.description)));let retired=!window.complete;
  const isCurrent=()=>{try{if(retired||!allowed()||!content()||!allowed()||!this.visual.retainedWindowCurrent(window,allowed())){retired=true;return false;}return true;}catch{retired=true;return false;}};
  if(!isCurrent())return {window:this.visual.retainedWindow(scope,false,fromMs,toMs),isCurrent:()=>false};return {window,isCurrent};
 }
 configure(scope:MemoryScope,enabled:boolean,expectedRevision:number){
  this.database.transaction(tx=>{const current=this.policy(scope);if(current.revision!==expectedRevision)throw new Error('Memory policy revision conflict');tx.run('INSERT INTO automatic_memory_policies VALUES (?,?,?,?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,approved_at=excluded.approved_at',key(scope),scope.principalId,scope.assistantId,scope.relationshipId,enabled?1:0,expectedRevision+1,new Date().toISOString());tx.run("UPDATE automatic_memory_work SET state='cancelled',input_text='',prepared_json=NULL,reason='policy_changed' WHERE scope_key=? AND state IN ('queued','running','prepared')",key(scope));if(!enabled){retireGameExperience(tx,scope);tx.run('UPDATE visual_memory_policies SET enabled=0,revision=revision+1 WHERE scope_key=? AND enabled=1',key(scope));tx.run("UPDATE visual_observation_episodes SET state='invalidated',payload_json=NULL,revision=revision+1 WHERE scope_key=? AND state='retained'",key(scope));retireVisualProjections(tx,Date.now());}});
  this.visualCandidateJournal.forgetOwner(scope);this.controller?.abort();return this.policy(scope);
 }
 enqueue(scope:MemoryScope,source:string,input:string,attribution:'authenticatedTypedOwner'|'unknownSpeaker',sourceContext:{sessionRef:string;messageRef:string}|null=null){
  const context=sourceContext?{sessionRef:sourceContext.sessionRef,messageRef:sourceContext.messageRef}:null;if(context&&Object.values(context).some(value=>typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>160))return {state:'notAdmitted'};
  const policy=this.policy(scope);if(!this.scopeAllowed(scope)||!policy.enabled||attribution!=='authenticatedTypedOwner'||!source||source.length>160||input.length>4000||secret.test(input)||thirdParty.test(input))return {state:'notAdmitted'};
  const id=hash([key(scope),source]);const existing=this.database.connection.prepare('SELECT state,input_digest AS digest,source_context_json AS sourceContext FROM automatic_memory_work WHERE id=?').get(id) as {state:string;digest:string;sourceContext:string|null}|undefined;if(existing){if(existing.digest!==hash(input)||existing.sourceContext!==(context?JSON.stringify(context):null))throw new Error('Memory source identity conflict');return {state:existing.state};}
  this.database.connection.prepare("DELETE FROM automatic_memory_work WHERE created_at<? AND state NOT IN ('queued','running','prepared') AND reason IS NOT 'source_removed' AND proposal_digest IS NULL").run(Date.now()-30*86400000);
  const total=this.database.connection.prepare('SELECT count(*) AS n FROM automatic_memory_work').get() as {n:number};if(total.n>=10000)return {state:'capacityExceeded'};
  const count=this.database.connection.prepare("SELECT count(*) AS n FROM automatic_memory_work WHERE state IN ('queued','running','prepared')").get() as {n:number};if(count.n>=128)return {state:'capacityExceeded'};
  const now=Date.now();this.database.connection.prepare("UPDATE automatic_memory_work SET state='cancelled',input_text='',prepared_json=NULL,reason='coalesced' WHERE scope_key=? AND state='queued' AND attempts=0 AND expires_at>?").run(key(scope),now);this.database.connection.prepare("INSERT INTO automatic_memory_work (id,scope_key,source_turn,policy_revision,state,input_text,input_digest,created_at,expires_at,source_context_json) VALUES (?,?,?,?,'queued',?,?,?,?,?)").run(id,key(scope),source,policy.revision,input,hash(input),now,now+86400000,context?JSON.stringify(context):null);return {state:'queued'};
 }
 /** Host-only source revocation. Source receipts are tombstones, including after
  * restart; deleting a distinct game episode never selects these turn sources. */
 revokeSource(scope:MemoryScope,source:string){
  if(!this.scopeAllowed(scope))throw Error('Memory source owner unavailable');
  const id=hash([key(scope),source]);
  this.database.connection.prepare("UPDATE automatic_memory_work SET state='cancelled',input_text='',prepared_json=NULL,result_json=NULL,reason='source_removed' WHERE id=? AND scope_key=?").run(id,key(scope));
  if(this.activeWork?.id===id)this.controller?.abort('source_removed');
  const records=this.database.connection.prepare("SELECT id FROM memories WHERE assistant_id=? AND json_extract(provenance_json,'$.actor')=? AND json_extract(provenance_json,'$.relationshipId')=? AND json_extract(provenance_json,'$.sourceTurnRef')=?").all(scope.assistantId,scope.principalId,scope.relationshipId,source);
  for(const record of records)this.memories.forget(scope.assistantId,String(record.id),scope.principalId);
  this.changed();
 }
 inspect(scope:MemoryScope){this.sweepExpired();const jobs=this.database.connection.prepare('SELECT id,state,result_json AS result,reason,created_at AS createdAt FROM automatic_memory_work WHERE scope_key=? ORDER BY created_at DESC LIMIT 20').all(key(scope));const visual=this.visual.inspect(scope,this.scopeAllowed(scope));const allowedEpisodes=visual.episodes.filter(row=>!row.episode||this.contentAllowed(scope,row.episode.summary)&&row.episode.observations.every(o=>this.contentAllowed(scope,o.description))&&row.corrections.every(c=>this.contentAllowed(scope,c.content)));const current=this.visual.policy(scope);const valid=this.scopeAllowed(scope)&&current.revision===visual.policy.revision;return {policy:this.policy(scope),jobs,visual:{...visual,policy:current,episodes:valid?allowedEpisodes:[],complete:valid&&visual.complete&&allowedEpisodes.length===visual.episodes.length,intakeReceipts:valid?[...this.visualIntakeReceipts.values()].filter(row=>key(row.scope)===key(scope)).map(({requestId,state})=>({requestId,state})):[]}};}
 isIdle(){return !this.controller;}
 preempt(){this.controller?.abort('foreground');}
 retry(scope:MemoryScope,id:string){this.sweepExpired();const result=this.database.connection.prepare("UPDATE automatic_memory_work SET state=CASE WHEN prepared_json IS NULL THEN 'queued' ELSE 'prepared' END,reason='retry_requested' WHERE id=? AND scope_key=? AND state='failed' AND attempts<6 AND expires_at>?").run(id,key(scope),Date.now());if(result.changes!==1)throw new Error('Memory retry is unavailable');}
 private expireWork(id:string){this.database.connection.prepare("UPDATE automatic_memory_work SET state='expired',input_text='',prepared_json=NULL,reason='retention_expired' WHERE id=? AND state IN ('queued','running','prepared','failed')").run(id);}
 private sweepExpired(){
  this.visual.sweep();const now=Date.now();
  for(const [id,row] of this.visualIntakeReceipts)if(row.expires<=now)this.visualIntakeReceipts.delete(id);
  for(const [id,item] of this.visualPending)if(!this.visualCurrent(item)){this.visualPending.delete(id);this.noteVisual(item.scope,item.publication.batch.requestId,item.publication.freshUntilMs<=now?'sourceExpired':'scopeChanged');}
  // Source retention is independent of foreground scheduling. Preserve receipts
  // for completed admission; only pending work and retained payloads expire.
  this.database.connection.prepare("UPDATE automatic_memory_work SET state='expired',input_text='',prepared_json=NULL,reason='retention_expired' WHERE expires_at<=? AND (state IN ('queued','running','prepared','failed') OR input_text<>'' OR prepared_json IS NOT NULL)").run(now);
  if(this.activeWork){const current=this.database.connection.prepare('SELECT state,expires_at AS expires FROM automatic_memory_work WHERE id=?').get(this.activeWork.id) as {state:string;expires:number}|undefined;
   if(this.activeWork.expires<=now||current?.state==='expired'||(current&&current.expires<=now)){this.expireWork(this.activeWork.id);this.controller?.abort('retention_expired');}
  }
 }
 private requireCurrent(work:Work,controller:AbortController,sweep=true){
  if(sweep)this.sweepExpired();controller.signal.throwIfAborted();
  const current=this.database.connection.prepare('SELECT state,expires_at AS expires,scope_key AS scope,policy_revision AS revision,input_digest AS digest,source_context_json AS sourceContext FROM automatic_memory_work WHERE id=?').get(work.id) as (Pick<Work,'state'|'expires'|'scope'|'revision'|'sourceContext'>&{digest:string})|undefined;
  if(!current||!['running','prepared'].includes(current.state)||current.expires<=Date.now()||work.expires<=Date.now()||current.scope!==work.scope||current.revision!==work.revision||current.digest!==hash(work.input)||current.sourceContext!==work.sourceContext)throw new Error('Memory work is no longer current');
 }
 /** Explicit optional semantic retrieval, sharing the existing idle worker
  * lease, selected provider, foreground preemption and 60-second ceiling. */
 async recall(scope:MemoryScope,query:string,limit=20,call:{signal?:AbortSignal;current?:()=>boolean}={}){
  const unavailable=(reason:string)=>({state:'unavailable' as const,reason,memories:[] as MemoryRecord[],selection:[],complete:false});
  if(typeof query!=='string'||!query.trim()||Buffer.byteLength(query)>2000||!Number.isSafeInteger(limit)||limit<1||limit>100)return unavailable('invalid_query');
  const policy=this.policy(scope),allowed=()=>!this.closed&&this.policy(scope).enabled&&this.policy(scope).revision===policy.revision&&this.scopeAllowed(scope)&&(call.current?.()??true);
  if(!allowed())return unavailable('permission_unavailable');if(secret.test(query)||!this.contentAllowed(scope,query))return unavailable('query_privacy_denied');if(!allowed())return unavailable('permission_unavailable');if(this.controller||!this.idle())return unavailable('worker_busy');
  const controller=this.controller=new AbortController(),signal=call.signal?AbortSignal.any([controller.signal,call.signal]):controller.signal,deadlineAt=new Date(Date.now()+55000).toISOString(),timeout=setTimeout(()=>controller.abort('deadline'),60000);
  const current=()=>{signal.throwIfAborted();return allowed();};
  try{
   const sourceRead=()=>this.memories.contextRecords(scope.assistantId,scope.principalId,scope.relationshipId);
   const read=()=>{const records=sourceRead().filter(record=>this.contentAllowed(scope,JSON.stringify(record))),confirmed=new Map(sourceRead().map(record=>[record.id,hash(record)]));return records.filter(record=>confirmed.get(record.id)===hash(record));};
   const runtime=this.provider();if(!current())throw Error('Semantic recall scope changed');
   const result=await selectSemanticMemory({scope,query:query.trim(),limit,deadlineAt,read,current,generate:async request=>{
    if(!current()||this.provider().revision!==runtime.revision)throw Error('Semantic recall provider changed');let output='',done=false;
    for await(const chunk of bounded(runtime.provider.generate(request,{signal}),signal)){if(!current()||done)throw Error('Semantic recall scope/output changed');if(chunk.kind==='text')output+=chunk.text??'';else if(chunk.kind==='done')done=true;else throw Error('Semantic recall provider failed');if(Buffer.byteLength(output)>4096)throw Error('Semantic recall output bound exceeded');}
    if(!done||secret.test(output)||!this.contentAllowed(scope,output))throw Error('Semantic recall response unavailable');return output;
   }});
   if(!current()||this.provider().revision!==runtime.revision)throw Error('Semantic recall scope/provider changed');
   return {state:result.memories.length?'selected' as const:'empty' as const,complete:true,...result,providerRevision:runtime.revision,qualification:'Model-proposed relevance; source evidence and truth remain unverified.'};
  }catch{return unavailable('semantic_selection_unavailable');}finally{clearTimeout(timeout);if(this.controller===controller)this.controller=null;}
 }
 async tick():Promise<void>{
  if(this.closed)return;this.sweepExpired();if(this.controller||!this.idle())return;
  const pending=this.visualPending.entries().next().value;
  if(pending){
   const [id,item]=pending;this.visualPending.delete(id);
   try{if(this.visualCurrent(item)){const candidate=visualPublicationEpisode(item.publication.batch,item.selection,this.visual.policy(item.scope),Date.now(),item.publication.freshUntilMs);const result=candidate?this.enqueueVisual(item.scope,candidate.episode,candidate.admission,()=>this.visualCurrent(item)):{state:'unattributedSubject'};this.noteVisual(item.scope,item.publication.batch.requestId,result.state);if(result.state==='retained'&&candidate&&item.selection.transformationConfidence){try{const projected=this.projectVisual(item.scope,candidate.episode.episodeId,1,item.selection.transformationConfidence);if(projected.state==='projected')this.activateVisual(item.scope,candidate.episode.episodeId,2);}catch{/* The retained typed source is independent of optional projection failure. */}}}}catch{this.noteVisual(item.scope,item.publication.batch.requestId,'invalidEpisode');}
   return;
  }
  const work=this.database.connection.prepare("SELECT id,scope_key AS scope,source_turn AS source,source_context_json AS sourceContext,policy_revision AS revision,input_text AS input,prepared_json AS prepared,proposal_digest AS proposalDigest,attempts,expires_at AS expires,state,reason FROM automatic_memory_work WHERE state IN ('queued','prepared') ORDER BY created_at LIMIT 1").get() as Work|undefined;if(!work)return;
  if(work.attempts>=2&&!work.prepared&&work.reason!=='retry_requested'){this.database.connection.prepare("UPDATE automatic_memory_work SET state='failed',reason='extraction_attempt_limit' WHERE id=?").run(work.id);return;}
  const owner=this.database.connection.prepare('SELECT principal_id AS principalId,assistant_id AS assistantId,relationship_id AS relationshipId,enabled,revision FROM automatic_memory_policies WHERE scope_key=?').get(work.scope) as (MemoryScope&{enabled:number;revision:number})|undefined;
  if(!owner||!owner.enabled||owner.revision!==work.revision||!this.scopeAllowed(owner)){this.database.connection.prepare("UPDATE automatic_memory_work SET state='cancelled',input_text='',prepared_json=NULL,reason='policy_changed' WHERE id=?").run(work.id);return;}
  const controller=this.controller=new AbortController();this.activeWork={id:work.id,expires:work.expires};
  const remaining=Math.max(0,work.expires-Date.now()),timeout=setTimeout(()=>controller.abort(remaining<=60000?'retention_expired':undefined),Math.min(60000,remaining));
  try{
   const claim=this.database.connection.prepare("UPDATE automatic_memory_work SET state='running',attempts=attempts+1 WHERE id=? AND state IN ('queued','prepared') AND expires_at>?").run(work.id,Date.now());if(claim.changes!==1)throw new Error('Memory work is no longer queued');this.requireCurrent(work,controller);
   let prepared:{proposal:MemoryProposalBatch;providerRevision:string};
   const source={turnRef:work.source,revision:hash(work.input),...(work.sourceContext?JSON.parse(work.sourceContext):{sessionRef:null,messageRef:null})};
   if(work.prepared){prepared=JSON.parse(work.prepared);validateMemoryProposals(prepared.proposal,work.input,source);if(proposalDigest(prepared.proposal)!==work.proposalDigest)throw Error('Memory proposal identity conflict');}
   else{
    const runtime=this.provider(),existing=this.memories.list(owner.assistantId).filter(r=>r.provenance.actor===owner.principalId&&r.provenance.relationshipId===owner.relationshipId&&typeof r.provenance.memoryTopic==='string'&&['active','candidate','contradicted'].includes(String(r.lifecycle.status))).slice(-24).map(r=>({key:r.provenance.memoryTopic,statement:r.content,status:r.lifecycle.status}));
    const request=buildCanonicalPrompt({assistantId:owner.assistantId,sessionId:'automatic-memory-worker',interactionId:work.id,endpointId:null,userInput:JSON.stringify({source:work.input,sourceIdentity:source,existing}),capabilities:'No tools or effects are available. Extraction does not persist records.',conversation:'No conversational reply is requested.',deadlineAt:new Date(Math.min(Date.now()+55000,work.expires)).toISOString(),executionMode:'live',maximumOutputTokens:2048});
    // Host-authored extraction policy retains the canonical provider section order and trust boundary.
    const policy=request.sections[0]!;policy.content=memoryProposalInstruction;policy.sourceRevision='automatic-memory-proposals-v2';policy.contentDigest=createHash('sha256').update(memoryProposalInstruction).digest('hex');policy.tokenCount=Buffer.byteLength(memoryProposalInstruction);
    request.manifest.sections=request.sections.map(({kind,sourceRevision,sourceRef,contentDigest,redaction,tokenCount})=>({kind,sourceRevision,sourceRef,contentDigest,redaction,tokenCount}));let output='',done=false;this.requireCurrent(work,controller);
    for await(const chunk of bounded(runtime.provider.generate(request,{signal:controller.signal}),controller.signal)){controller.signal.throwIfAborted();if(chunk.kind==='text')output+=chunk.text??'';else if(chunk.kind==='done')done=true;else throw new Error('Memory provider extraction failed');if(Buffer.byteLength(output)>4096)throw new Error('Memory output bound exceeded');}
    if(!done)throw new Error('Incomplete memory extraction');const proposal=validateMemoryProposals(JSON.parse(output),work.input,source);if(proposal.items.some(item=>secret.test(JSON.stringify(item))||thirdParty.test(item.quote)))throw Error('Memory proposal privacy denied');prepared={proposal,providerRevision:runtime.revision};
    this.requireCurrent(work,controller);const saved=this.database.connection.prepare("UPDATE automatic_memory_work SET prepared_json=?,proposal_digest=?,state='prepared' WHERE id=? AND state='running' AND expires_at>? AND (proposal_digest IS NULL OR proposal_digest=?)").run(JSON.stringify(prepared),proposalDigest(prepared.proposal),work.id,Date.now(),proposalDigest(prepared.proposal));if(saved.changes!==1)throw new Error('Memory preparation is no longer current');
   }
   controller.signal.throwIfAborted();if(this.policy(owner).revision!==work.revision||!this.scopeAllowed(owner))throw new Error('Memory policy changed');
   const records:MemoryRecord[]=prepared.proposal.items.filter(item=>!secret.test(JSON.stringify(item))&&!thirdParty.test(item.quote)&&this.contentAllowed(owner,JSON.stringify(item))&&this.contentAllowed(owner,proposalContent(item))).map((item,i)=>{const digest=hash([work.id,i]),id=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;return {id,assistantId:owner.assistantId,content:proposalContent(item),provenance:{actor:owner.principalId,source:`turn:${work.source}`,sourceTurnRef:work.source,sourceSessionRef:source.sessionRef,sourceMessageRef:source.messageRef,sourceFamily:`turn:${work.source}`,relationshipId:owner.relationshipId,automaticMemoryKey:hash([work.scope,item.key]),memoryTopic:item.key,epistemicStatus:item.epistemic,proposedMeaning:item.meaning,attribution:item.attribution,uncertainty:item.uncertainty,dependencyRefs:item.dependencyRefs,proposalDigest:proposalDigest(prepared.proposal),proposalVersion:2,sourceRevision:source.revision,policyRevision:work.revision,extractorRevision:prepared.providerRevision,transformation:'exact-attributed-quote-v2'},lifecycle:{kind:item.kind,factuality:'unverified',sensitivity:'private',confidence:0,status:'candidate',revision:1,lastReinforcedAt:null,contradictedBy:[]},createdAt:new Date().toISOString()};});
   const directCorrection=/^\s*(?:correction\s*[:,-]|actually\b|I\s+(?:no longer|changed my mind)|instead\b)/iu.test(work.input);
   // Content/scope policy hooks may invalidate work synchronously. Recheck after
   // them, immediately before the repository's synchronous admission transaction.
   if(!this.scopeAllowed(owner)||this.policy(owner).revision!==work.revision)throw new Error('Memory policy changed');this.requireCurrent(work,controller);
   const ids=this.memories.admitAutomatic(records,owner.principalId,directCorrection&&prepared.proposal.items.every(item=>item.epistemic==='userStatement'),()=>{this.requireCurrent(work,controller,false);return this.policy(owner).enabled&&this.policy(owner).revision===work.revision&&this.scopeAllowed(owner);});
   const activeCount=ids.filter(id=>this.memories.get(owner.assistantId,id)?.lifecycle.status==='active').length,reviewCount=ids.filter(id=>this.memories.get(owner.assistantId,id)?.lifecycle.needsReview===true).length;
   this.database.connection.prepare("UPDATE automatic_memory_work SET state=?,input_text='',prepared_json=NULL,result_json=?,reason=NULL WHERE id=?").run(activeCount?'saved':reviewCount?'needsReview':'noMemory',JSON.stringify({memoryIds:ids,activeCount,reviewCount,extractedCount:prepared.proposal.items.length,admissibleCount:records.length,returnedItemCount:prepared.proposal.items.length,rejectedItemCount:prepared.proposal.items.length-records.length}),work.id);this.changed();
  }catch(error){
   if(error instanceof Error&&error.message==='Memory proposal identity conflict'){this.database.connection.prepare("UPDATE automatic_memory_work SET state='cancelled',input_text='',prepared_json=NULL,reason='proposal_identity_conflict' WHERE id=?").run(work.id);return;}
   if(controller.signal.reason==='retention_expired')this.expireWork(work.id);this.sweepExpired();
   if(!this.closed&&controller.signal.reason==='foreground'){this.database.connection.prepare("UPDATE automatic_memory_work SET state=CASE WHEN prepared_json IS NULL THEN 'queued' ELSE 'prepared' END,reason='foreground_preempted' WHERE id=? AND state IN ('running','prepared') AND expires_at>?").run(work.id,Date.now());return;}
   if(!this.closed)this.database.connection.prepare("UPDATE automatic_memory_work SET state=CASE WHEN attempts<2 THEN CASE WHEN prepared_json IS NULL THEN 'queued' ELSE 'prepared' END ELSE 'failed' END,reason='extraction_or_persistence_failed' WHERE id=? AND state IN ('running','prepared') AND expires_at>?").run(work.id,Date.now());
  }finally{clearTimeout(timeout);this.sweepExpired();if(this.controller===controller){this.controller=null;this.activeWork=null;}}
 }
 async close(){this.closed=true;this.visualIntakeJournal.close();this.visualCandidateJournal.close();this.visualPending.clear();this.visualIntakeReceipts.clear();clearInterval(this.timer);this.controller?.abort();while(this.controller)await new Promise(r=>setTimeout(r,5));}
}
