import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import type {VisualScope} from '@lifestream/runtime/perception/port';
import type {VisualAdmissionProvenance,VisualDropReason} from '@lifestream/runtime/perception/admission';

type Actor=Readonly<{principalId:string;assistantId:string;sessionId:string}>;
type Kind='negotiated'|'cameraEnabled'|'cameraEnableInactive'|'cameraRenewed'|'cameraRenewInactive'|'cameraInactiveObserved'|'cameraStopNoop'|'captureLeaseEnded'|'batchAdmitted'|'batchRejected'|'batchFailed'|'cameraRejected'|'contextExpired';
type Reason=VisualDropReason|'stop'|'expired'|'invalidated'|'host_processing_failed'|null;
type Frame=Readonly<{frameId:string;sequence:number;capturedMonotonicMs:number;clockMappingId:string}>;
export type VisualLifecycleReceipt=Readonly<{
 eventId:string;sequence:number;occurredAtMs:number;kind:Kind;reason:Reason;
 scopeDigest:string|null;leaseDigest:string|null;clockMappingDigest:string|null;
 requestDigest:string|null;correlationDigest:string|null;hostSequence:number|null;
 sourceEpochs:Readonly<{session:number;audience:number;generation:number;configuration:number}>|null;
 providerDigest:string|null;
 frames:readonly Readonly<{frameDigest:string;sequence:number|null;capturedMonotonicMs:number|null;clockMappingDigest:string|null}>[];
 selectedVersion:'1.0.0'|null;observedCaptureActive:boolean|null;
 coverage:'bounded_best_effort';authority:false;
}>;
type Input=Readonly<{kind:Kind;reason?:Reason;scope?:VisualScope|null;leaseId?:string|null;clockMappingId?:string|null;provenance?:VisualAdmissionProvenance|null;frames?:readonly Frame[];selectedVersion?:'1.0.0'|null;metadata?:unknown;requestId?:string;hostSequence?:number;captureActive?:boolean}>;
type Entry={actor:string;receipt:VisualLifecycleReceipt;expiresAtMs:number;expiresMono:number};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const data=(value:unknown,key:string):unknown=>value&&typeof value==='object'&&!types.isProxy(value)?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
const string=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=4096;
const digest=(value:unknown)=>string(value)?hash(value):null;
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
function actorKey(actor:Actor){const fields=['principalId','assistantId','sessionId'].map(key=>data(actor,key));return fields.every(string)?hash(JSON.stringify(fields)):null;}
const kinds=new Set<Kind>(['negotiated','cameraEnabled','cameraEnableInactive','cameraRenewed','cameraRenewInactive','cameraInactiveObserved','cameraStopNoop','captureLeaseEnded','batchAdmitted','batchRejected','batchFailed','cameraRejected','contextExpired']);
const reasons=new Set<Reason>(['disabled','unsupported','unconfigured','source_unavailable','permission_denied','lease_conflict','stale_revision','stale_lease','scope_changed','clock_challenge_invalid','clock_uncertain','frame_invalid','frame_oversize','frame_stale','frame_future','rate_limited','foreground_priority','provider_unavailable','provider_invalid','deadline','replaced','cancelled','stop','expired','invalidated','host_processing_failed',null]);

/** Source-host diagnostics, not a canonical trace envelope or an authority token.
 * No raw IDs, frame bytes, scene text, input strings or consent are retained.
 * Bounded pending/retained rings drain asynchronously without a consumer callback. */
export class VisualLifecycleEvidence{
 private readonly pending:Entry[]=[];private readonly retained:Entry[]=[];
 private sequence=0;private epoch=0;private queued=false;private closed=false;
 private lastUtc=-Infinity;private lastMono=-Infinity;
 private readonly clocks:{utcMs:()=>number;monotonicMs:()=>number};
 constructor(clocks:{utcMs:()=>number;monotonicMs:()=>number}={utcMs:Date.now,monotonicMs:()=>performance.now()}){this.clocks=clocks;}
 private now(){
  try{const utc=this.clocks.utcMs(),mono=this.clocks.monotonicMs();if(!time(utc)||!time(mono)||utc<this.lastUtc||mono<this.lastMono)throw Error('clock');this.lastUtc=utc;this.lastMono=mono;
   for(const rows of [this.pending,this.retained])for(let i=rows.length-1;i>=0;i--)if(utc>=rows[i]!.expiresAtMs||mono>=rows[i]!.expiresMono)rows.splice(i,1);return {utc,mono};
  }catch{this.reset();return null;}
 }
 record(actor:Actor,input:Input):void{
  try{
   if(this.closed)return;const key=actorKey(actor),at=this.now(),kind=data(input,'kind'),reason=data(input,'reason')??null;
   if(!key||!at||!kinds.has(kind as Kind)||!reasons.has(reason as Reason))return;
   const metadata=data(input,'metadata'),provenance=data(input,'provenance'),scope=data(input,'scope')??data(provenance,'scope');
   const scopeValues=['assistantId','principalId','relationshipId','environmentId','conversationId','sessionId','endpointId','sessionRevision','audienceRevision','scopeGeneration','sourceBindingRef','captureConfigurationRevision'].map(field=>[field,data(scope,field)] as const);
   const validScope=scopeValues.every(([field,value])=>['sessionRevision','audienceRevision','scopeGeneration','captureConfigurationRevision'].includes(field)?integer(value):field==='relationshipId'&&value===null||string(value));
   // Refuse a foreign scope rather than recording it under the supplied actor.
   if(scope&&(!validScope||['principalId','assistantId','sessionId'].some(field=>data(scope,field)!==data(actor,field))))return;
   const frames=data(input,'frames')??data(metadata,'frames');const sanitized:VisualLifecycleReceipt['frames'][number][]=[];
   if(Array.isArray(frames)&&!types.isProxy(frames)&&frames.length<=3){for(let i=0;i<frames.length;i++){const frame=data(frames,String(i)),frameId=data(frame,'frameId');if(!string(frameId))continue;const sequence=data(frame,'sequence'),captured=data(frame,'capturedMonotonicMs');sanitized.push(Object.freeze({frameDigest:hash(frameId),sequence:integer(sequence)?sequence:null,capturedMonotonicMs:time(captured)?captured:null,clockMappingDigest:digest(data(frame,'clockMappingId'))}));}}
   const provider=data(provenance,'provider'),providerId=data(provider,'id'),providerVersion=data(provider,'version'),hostSequence=data(input,'hostSequence')??data(provenance,'hostSequence');
   const sourceEpochs=validScope?Object.freeze({session:data(scope,'sessionRevision') as number,audience:data(scope,'audienceRevision') as number,generation:data(scope,'scopeGeneration') as number,configuration:data(scope,'captureConfigurationRevision') as number}):null;
   const receipt:VisualLifecycleReceipt=Object.freeze({eventId:randomUUID(),sequence:++this.sequence,occurredAtMs:at.utc,kind:kind as Kind,reason:reason as Reason,scopeDigest:validScope?hash(JSON.stringify(Object.fromEntries(scopeValues.slice().sort(([a],[b])=>a.localeCompare(b))))):null,leaseDigest:digest(data(input,'leaseId')??data(provenance,'leaseId')??data(metadata,'leaseId')),clockMappingDigest:digest(data(input,'clockMappingId')??data(provenance,'clockMappingId')),requestDigest:digest(data(input,'requestId')??data(provenance,'requestId')),correlationDigest:digest(data(provenance,'correlationId')??data(metadata,'correlationId')),hostSequence:integer(hostSequence)?hostSequence:null,sourceEpochs,providerDigest:string(providerId)&&string(providerVersion)?hash(JSON.stringify([providerId,providerVersion])):null,frames:Object.freeze(sanitized),selectedVersion:data(input,'selectedVersion')==='1.0.0'?'1.0.0':null,observedCaptureActive:typeof data(input,'captureActive')==='boolean'?data(input,'captureActive') as boolean:null,coverage:'bounded_best_effort',authority:false});
   this.pending.push({actor:key,receipt,expiresAtMs:at.utc+60000,expiresMono:at.mono+60000});if(this.pending.length>128)this.pending.shift();
   if(!this.queued){this.queued=true;const epoch=this.epoch;queueMicrotask(()=>{if(epoch!==this.epoch)return;this.queued=false;if(this.closed||!this.now())return;this.retained.push(...this.pending.splice(0));if(this.retained.length>128)this.retained.splice(0,this.retained.length-128);});}
  }catch{/* Optional diagnostic failure never changes host behavior. */}
 }
 receipts(actor:Actor):readonly VisualLifecycleReceipt[]{try{const key=actorKey(actor);if(this.closed||!key||!this.now())return Object.freeze([]);return Object.freeze(this.retained.filter(row=>row.actor===key).map(row=>row.receipt));}catch{return Object.freeze([]);}}
 reset(){this.epoch++;this.pending.length=0;this.retained.length=0;this.queued=false;}
 close(){this.closed=true;this.reset();}
}
