import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {validateVisualMemoryProjection,type VisualMemoryOwner,type VisualMemoryProjection} from '@lifestream/contracts/visual-memory';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const data=(value:unknown,key:string):unknown=>value&&typeof value==='object'&&!types.isProxy(value)?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
function ownerKey(owner:VisualMemoryOwner){const values=['principalId','assistantId','relationshipId'].map(key=>data(owner,key));return values.every(uuid)?sha(JSON.stringify(values)):null;}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function snapshot(value:unknown):VisualMemoryProjection|null {
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
 try{const result=copy(value);return Buffer.byteLength(JSON.stringify(result))<=32768?result as VisualMemoryProjection:null;}catch{return null;}
}
export type VisualMemoryCandidateTrace=Readonly<{
 event:Readonly<Record<string,unknown>>;
 artifact:Readonly<{reference:Readonly<{reference:string;sha256:string;mediaType:'application/json';schemaRef:string;byteLength:number}>;bytes:string}>;
 coverage:'bounded_best_effort';complete:false;durable:false;learningAuthority:false;effectAuthority:false;
}>;
const candidateTraces=new WeakSet<object>();
/** Genuine journal provenance only; this is not a current-memory eligibility check. */
export function isVisualMemoryCandidateTrace(value:VisualMemoryCandidateTrace):boolean{return !!value&&typeof value==='object'&&candidateTraces.has(value);}
type Pending={ownerDigest:string;dedup:string;expiresUtc:number;expiresMono:number;sequence:number;scope:Pick<VisualMemoryProjection['episode']['scope'],'assistantId'|'conversationId'|'sessionId'|'endpointId'|'environmentId'>;memoryId:string;eventTime:string;sourceRefs:string[];artifact:VisualMemoryCandidateTrace['artifact']};
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
   this.pending.push({ownerDigest:key,dedup,expiresUtc:at.utc+60000,expiresMono:at.mono+60000,sequence:++this.sequence,scope:{assistantId:episode.scope.assistantId,conversationId:episode.scope.conversationId,sessionId:episode.scope.sessionId,endpointId:episode.scope.endpointId,environmentId:episode.scope.environmentId},memoryId:memory.memoryId,eventTime:memory.createdAt,sourceRefs:memory.provenance.sourceRefs,artifact});if(this.pending.length>128)this.pending.shift();
   if(!this.queued){this.queued=true;const epoch=this.epoch;queueMicrotask(()=>{if(epoch!==this.epoch)return;this.queued=false;this.drain();});}
  }catch{/* Evidence cannot change projection, source custody or authority. */}
 }
 private drain(){try{
  const at=this.now();if(this.closed||!at)return;const validator=createContractValidator();
  for(const row of this.pending.splice(0)){
   const event={schemaVersion:'2.0.0',eventId:randomUUID(),traceScope:'background',interactionTraceId:null,backgroundJobId:this.producerId,correlationId:row.memoryId,sequence:row.sequence,eventType:'memory.candidateProposed',eventVersion:'1.0.0',eventTime:row.eventTime,processingTime:new Date(at.utc).toISOString(),monotonic:null,assistantId:row.scope.assistantId,conversationId:row.scope.conversationId,sessionId:row.scope.sessionId,endpointId:row.scope.endpointId,environmentId:row.scope.environmentId,executionMode:'normal',privacyClass:'restricted',causedByEventIds:[],sourceEventIds:[],payload:{memoryId:row.memoryId,candidateArtifact:row.artifact.reference,sourceRefs:row.sourceRefs},redactions:['candidate prose, source descriptions and transformation basis omitted; metadata digests retained']};
   if(!validator.validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid)continue;
   const trace:VisualMemoryCandidateTrace=freeze({event,artifact:row.artifact,coverage:'bounded_best_effort',complete:false,durable:false,learningAuthority:false,effectAuthority:false});candidateTraces.add(trace);
   this.retained.push({ownerDigest:row.ownerDigest,dedup:row.dedup,expiresUtc:row.expiresUtc,expiresMono:row.expiresMono,trace});
  }
  if(this.retained.length>128)this.retained.splice(0,this.retained.length-128);
 }catch{/* A diagnostic sink failure is not a memory outcome. */}}
 traces(owner:VisualMemoryOwner):readonly VisualMemoryCandidateTrace[]{try{const key=ownerKey(owner);if(this.closed||!key||!this.now())return Object.freeze([]);return Object.freeze(this.retained.filter(row=>row.ownerDigest===key).map(row=>row.trace));}catch{return Object.freeze([]);}}
 forgetOwner(owner:VisualMemoryOwner){const key=ownerKey(owner);if(!key)return;for(const rows of [this.pending,this.retained])for(let i=rows.length-1;i>=0;i--)if(rows[i]!.ownerDigest===key)rows.splice(i,1);}
 reset(){this.epoch++;this.pending.length=0;this.retained.length=0;this.queued=false;}
 close(){this.closed=true;this.reset();}
}
