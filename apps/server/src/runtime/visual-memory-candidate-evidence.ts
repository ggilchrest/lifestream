import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {isVisualActivationEvidence,isVisualCorrectionEvidence,type VisualActivationEvidence,type VisualCorrectionEvidence} from '@lifestream/storage-sqlite';
import {validateVisualMemoryProjection,type VisualMemoryOwner,type VisualMemoryProjection} from '@lifestream/contracts/visual-memory';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const data=(value:unknown,key:string):unknown=>value&&typeof value==='object'&&!types.isProxy(value)?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
function ownerKey(owner:VisualMemoryOwner){const values=['principalId','assistantId','relationshipId'].map(key=>data(owner,key));return values.every(uuid)?sha(JSON.stringify(values)):null;}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function snapshot<T=VisualMemoryProjection>(value:unknown):T|null {
 let nodes=0;const seen=new Set<object>();
 const copy=(v:unknown,depth=0):unknown=>{
  if(++nodes>4096||depth>16)throw Error('bound');
  if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
  if(typeof v==='string'&&Buffer.byteLength(v)<=8192)return v;
  if(!v||typeof v!=='object'||types.isProxy(v)||seen.has(v))throw Error('plain');
  const array=Array.isArray(v);if(Object.getPrototypeOf(v)!==(array?Array.prototype:Object.prototype))throw Error('prototype');seen.add(v);
  const out:Record<string,unknown>|unknown[]=array?[]:{};
  for(const key of Reflect.ownKeys(v)){if(array&&key==='length')continue;if(typeof key!=='string')throw Error('key');const d=Object.getOwnPropertyDescriptor(v,key)!;if(!d.enumerable||!Object.hasOwn(d,'value'))throw Error('accessor');Object.defineProperty(out,key,{value:copy(d.value,depth+1),enumerable:true,writable:true,configurable:true});}
  seen.delete(v);return out;
 };
 try{const result=copy(value);return Buffer.byteLength(JSON.stringify(result))<=32768?result as T:null;}catch{return null;}
}
export type VisualMemoryCandidateTrace=Readonly<{
 event:Readonly<Record<string,unknown>>;
 artifact:Readonly<{reference:Readonly<{reference:string;sha256:string;mediaType:'application/json';schemaRef:string;byteLength:number}>;bytes:string}>;
 coverage:'bounded_best_effort';complete:false;durable:false;learningAuthority:false;effectAuthority:false;
}>;
export type VisualMemoryLifecycleTrace=VisualMemoryCandidateTrace & Readonly<{sourceMutation:VisualActivationEvidence['event']}>;
export type VisualMemoryCorrectionTrace=VisualMemoryCandidateTrace & Readonly<{sourceReceipt:VisualCorrectionEvidence['sourceReceipt']}>;
const candidateTraces=new WeakSet<object>(),lifecycleTraces=new WeakSet<object>(),correctionTraces=new WeakSet<object>();
const traceOwners=new WeakMap<object,string>();
/** Genuine journal provenance only; this is not a current-memory eligibility check. */
export function isVisualMemoryCandidateTrace(value:VisualMemoryCandidateTrace):boolean{return !!value&&typeof value==='object'&&candidateTraces.has(value);}
/** Genuine asynchronous projection of a recorded canonical mutation source. */
export function isVisualMemoryLifecycleTrace(value:VisualMemoryCandidateTrace):value is VisualMemoryLifecycleTrace{return !!value&&typeof value==='object'&&lifecycleTraces.has(value);}
export function isVisualMemoryCorrectionTrace(value:VisualMemoryCandidateTrace):value is VisualMemoryCorrectionTrace{return !!value&&typeof value==='object'&&correctionTraces.has(value);}
export function visualMemoryCorrectionOwnersMatch(candidate:VisualMemoryCandidateTrace,correction:VisualMemoryCorrectionTrace):boolean{return isVisualMemoryCandidateTrace(candidate)&&isVisualMemoryCorrectionTrace(correction)&&traceOwners.get(candidate)!==undefined&&traceOwners.get(candidate)===traceOwners.get(correction);}
export function visualMemoryTraceOwnersMatch(candidate:VisualMemoryCandidateTrace,lifecycle:VisualMemoryLifecycleTrace):boolean{return isVisualMemoryCandidateTrace(candidate)&&isVisualMemoryLifecycleTrace(lifecycle)&&traceOwners.get(candidate)!==undefined&&traceOwners.get(candidate)===traceOwners.get(lifecycle);}
type Pending={ownerDigest:string;dedup:string;expiresUtc:number;expiresMono:number;sequence:number;scope:{assistantId:string;environmentId:string;conversationId:string|null;sessionId:string|null;endpointId:string|null};memoryId:string;eventTime:string;eventType:'memory.candidateProposed'|'memory.lifecycleChanged';payload:Record<string,unknown>;sourceEventIds:string[];sourceMutation:VisualActivationEvidence['event']|null;sourceCorrection?:VisualCorrectionEvidence['sourceReceipt'];artifact:VisualMemoryCandidateTrace['artifact']};
type Retained={ownerDigest:string;dedup:string;expiresUtc:number;expiresMono:number;trace:VisualMemoryCandidateTrace};

/** Optional restricted diagnostics at the existing projection owner. The stored
 * artifact is explicitly redacted metadata, not a full MemoryRecord or media.
 * UTC source time is preserved; an unrecorded source monotonic clock stays null. */
export class VisualMemoryCandidateEvidence {
 private readonly producerId=randomUUID();private sequence=0;private epoch=0;private queued=false;private closed=false;
 private readonly pending:Pending[]=[];private readonly retained:Retained[]=[];
 private lastUtc=-Infinity;private lastMono=-Infinity;
 private readonly clocks:{utcMs:()=>number;monotonicMs:()=>number};
 constructor(clocks:{utcMs:()=>number;monotonicMs:()=>number}={utcMs:Date.now,monotonicMs:()=>performance.now()}){this.clocks=clocks;}
 private now(){try{const utc=this.clocks.utcMs(),mono=this.clocks.monotonicMs();if(!Number.isFinite(utc)||!Number.isFinite(mono)||utc<0||mono<0||utc<this.lastUtc||mono<this.lastMono)throw Error('clock');this.lastUtc=utc;this.lastMono=mono;
  for(const rows of [this.pending,this.retained])for(let i=rows.length-1;i>=0;i--)if(utc>=rows[i]!.expiresUtc||mono>=rows[i]!.expiresMono)rows.splice(i,1);return {utc,mono};
 }catch{this.reset();return null;}}
 record(owner:VisualMemoryOwner,source:unknown):void {
  try{
   if(this.closed)return;const key=ownerKey(owner),at=this.now(),projection=snapshot(source);if(!key||!at||!projection||!validateVisualMemoryProjection(projection).valid)return;
   const {episode,memoryRecord:memory}=projection;
   if(ownerKey(episode.scope)!==key||memory.status!=='candidate'||Date.parse(memory.createdAt)>at.utc)return;
   const recordDigest=sha(JSON.stringify(memory)),dedup=sha(JSON.stringify([key,memory.memoryId,recordDigest]));
   if(this.pending.some(row=>row.dedup===dedup)||this.retained.some(row=>row.dedup===dedup))return;
   const confidence=memory.extensions['lifestream.conversationalVision'].transformationConfidence;
   const bytes=JSON.stringify({schemaVersion:'1.0.0',recordType:'redactedVisualMemoryCandidateMetadata',memoryId:memory.memoryId,assistantId:memory.assistantId,status:'candidate',factuality:'unverified',createdAt:memory.createdAt,sourceEpisodeId:episode.episodeId,sourceEpisodeRevision:episode.revision,sourceDigest:episode.sourceDigest,recordDigest,confidence:memory.confidence,transformation:{id:memory.provenance.transformationId,version:memory.provenance.transformationVersion,basisDigest:sha(confidence.basis),policyRefDigest:sha(confidence.policyRef)},sourceRefs:memory.provenance.sourceRefs,rawMediaRetained:false});
   if(Buffer.byteLength(bytes)>4096)return;const digest=sha(bytes);
   const artifact=freeze({reference:{reference:`urn:lifestream:visual-memory-candidate-metadata:sha256:${digest}`,sha256:digest,mediaType:'application/json' as const,schemaRef:'urn:lifestream:visual-memory-candidate-metadata:1.0.0',byteLength:Buffer.byteLength(bytes)},bytes});
   this.enqueue({ownerDigest:key,dedup,scope:{assistantId:episode.scope.assistantId,conversationId:episode.scope.conversationId,sessionId:episode.scope.sessionId,endpointId:episode.scope.endpointId,environmentId:episode.scope.environmentId},memoryId:memory.memoryId,eventTime:memory.createdAt,eventType:'memory.candidateProposed',payload:{memoryId:memory.memoryId,candidateArtifact:artifact.reference,sourceRefs:memory.provenance.sourceRefs},sourceEventIds:[],sourceMutation:null,artifact},at);
  }catch{/* Evidence cannot change projection, source custody or authority. */}
 }
 /** Only original existing-owner reads can donate a mutation identity. Schema
  * validity alone, copied envelopes and legacy status rows are insufficient. */
 recordActivation(owner:VisualMemoryOwner,source:VisualActivationEvidence):void {
  try{
   if(this.closed||!isVisualActivationEvidence(source))return;
   const key=ownerKey(owner),at=this.now(),evidence=snapshot<VisualActivationEvidence>(source);if(!key||!at||!evidence||evidence.ownerDigest!==key)return;
   const event=evidence.event,operation=event.operation as {type:string};
   if(operation.type!=='activate'||event.assistantId!==data(owner,'assistantId')||event.actorRef!==data(owner,'principalId')||Date.parse(String(event.occurredAt))>at.utc||!createContractValidator().validate('https://lifestream.dev/contracts/memory-operations/1.0.0',event).valid)return;
   const memoryId=event.memoryId as string,dedup=sha(JSON.stringify([key,'activation',event.eventId]));
   if(this.pending.some(row=>row.dedup===dedup)||this.retained.some(row=>row.dedup===dedup))return;
   this.enqueue({ownerDigest:key,dedup,scope:evidence.scope,memoryId,eventTime:event.occurredAt as string,eventType:'memory.lifecycleChanged',payload:{memoryId,lifecycleEventId:event.eventId,oldRevision:event.oldRevision,newRevision:event.newRevision,sourceRevision:event.sourceRevision},sourceEventIds:[event.eventId as string],sourceMutation:freeze(event),artifact:freeze(evidence.artifact)},at);
  }catch{/* Optional projection never changes mutation outcome or source custody. */}
 }
 /** A trace projects the actual SQLite record change, without relabeling its
  * Human entry as MemoryRecord evidence or inventing a canonical operation. */
 recordCorrection(owner:VisualMemoryOwner,source:VisualCorrectionEvidence):void {
  try{
   if(this.closed||!isVisualCorrectionEvidence(source))return;
   const key=ownerKey(owner),at=this.now(),evidence=snapshot<VisualCorrectionEvidence>(source);if(!key||!at||!evidence||evidence.ownerDigest!==key)return;
   const receipt=evidence.sourceReceipt;if(receipt.assistantId!==data(owner,'assistantId')||Date.parse(receipt.occurredAt)>at.utc)return;
   const dedup=sha(JSON.stringify([key,'correction',receipt.eventId]));if(this.pending.some(row=>row.dedup===dedup)||this.retained.some(row=>row.dedup===dedup))return;
   this.enqueue({ownerDigest:key,dedup,scope:evidence.scope,memoryId:receipt.memoryId,eventTime:receipt.occurredAt,eventType:'memory.lifecycleChanged',payload:{memoryId:receipt.memoryId,lifecycleEventId:receipt.eventId,oldRevision:receipt.oldRevision,newRevision:receipt.newRevision,sourceRevision:receipt.sourceRevision},sourceEventIds:[receipt.eventId],sourceMutation:null,sourceCorrection:freeze(receipt),artifact:freeze(evidence.artifact)},at);
  }catch{/* Optional diagnostic projection cannot admit, correct or erase memory. */}
 }
 private enqueue(row:Omit<Pending,'sequence'|'expiresUtc'|'expiresMono'>,at:{utc:number;mono:number}){
  this.pending.push({...row,sequence:++this.sequence,expiresUtc:at.utc+60000,expiresMono:at.mono+60000});if(this.pending.length>128)this.pending.shift();
  if(!this.queued){this.queued=true;const epoch=this.epoch;queueMicrotask(()=>{if(epoch!==this.epoch)return;this.queued=false;this.drain();});}
 }
 private drain(){try{
  const at=this.now();if(this.closed||!at)return;const validator=createContractValidator();
  for(const row of this.pending.splice(0)){
   const event={schemaVersion:'2.0.0',eventId:randomUUID(),traceScope:'background',interactionTraceId:null,backgroundJobId:this.producerId,correlationId:row.memoryId,sequence:row.sequence,eventType:row.eventType,eventVersion:'1.0.0',eventTime:row.eventTime,processingTime:new Date(at.utc).toISOString(),monotonic:null,assistantId:row.scope.assistantId,conversationId:row.scope.conversationId,sessionId:row.scope.sessionId,endpointId:row.scope.endpointId,environmentId:row.scope.environmentId,executionMode:'normal',privacyClass:'restricted',causedByEventIds:[],sourceEventIds:row.sourceEventIds,payload:row.payload,redactions:['memory source prose, media and transformation basis omitted; exact redacted metadata retained']};
   if(!validator.validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid)continue;
   const trace:VisualMemoryCandidateTrace=freeze({event,artifact:row.artifact,...(row.sourceMutation?{sourceMutation:row.sourceMutation}:{}),...(row.sourceCorrection?{sourceReceipt:row.sourceCorrection}:{}),coverage:'bounded_best_effort',complete:false,durable:false,learningAuthority:false,effectAuthority:false});
   if(row.sourceMutation)lifecycleTraces.add(trace);else if(row.sourceCorrection)correctionTraces.add(trace);else candidateTraces.add(trace);traceOwners.set(trace,row.ownerDigest);
   this.retained.push({ownerDigest:row.ownerDigest,dedup:row.dedup,expiresUtc:row.expiresUtc,expiresMono:row.expiresMono,trace});
  }
  if(this.retained.length>128)this.retained.splice(0,this.retained.length-128);
 }catch{/* A diagnostic sink failure is not a memory outcome. */}}
 traces(owner:VisualMemoryOwner):readonly VisualMemoryCandidateTrace[]{try{const key=ownerKey(owner);if(this.closed||!key||!this.now())return Object.freeze([]);return Object.freeze(this.retained.filter(row=>row.ownerDigest===key&&candidateTraces.has(row.trace)).map(row=>row.trace));}catch{return Object.freeze([]);}}
 lifecycleTraces(owner:VisualMemoryOwner):readonly VisualMemoryLifecycleTrace[]{try{const key=ownerKey(owner);if(this.closed||!key||!this.now())return Object.freeze([]);return Object.freeze(this.retained.filter(row=>row.ownerDigest===key).map(row=>row.trace).filter(isVisualMemoryLifecycleTrace));}catch{return Object.freeze([]);}}
 correctionTraces(owner:VisualMemoryOwner):readonly VisualMemoryCorrectionTrace[]{try{const key=ownerKey(owner);if(this.closed||!key||!this.now())return Object.freeze([]);return Object.freeze(this.retained.filter(row=>row.ownerDigest===key).map(row=>row.trace).filter(isVisualMemoryCorrectionTrace));}catch{return Object.freeze([]);}}
 forgetOwner(owner:VisualMemoryOwner){const key=ownerKey(owner);if(!key)return;for(const rows of [this.pending,this.retained])for(let i=rows.length-1;i>=0;i--)if(rows[i]!.ownerDigest===key)rows.splice(i,1);}
 reset(){this.epoch++;this.pending.length=0;this.retained.length=0;this.queued=false;}
 close(){this.closed=true;this.reset();}
}
