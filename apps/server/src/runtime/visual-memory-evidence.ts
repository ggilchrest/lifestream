import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import type {VisualMemoryOwner} from '@lifestream/contracts/visual-memory';

export type VisualMemoryIntakeState='queued'|'policyDenied'|'replaced'|'sourceExpired'|'scopeChanged'|'invalidEpisode'|'unattributedSubject'|'retained'|'duplicateSource'|'appearanceBound'|'sessionBound'|'capacityExceeded'|'unclassified';
export type VisualMemoryIntakeReceipt=Readonly<{
 eventId:string;sequence:number;occurredAtMs:number;
 producerScope:'backgroundVisualMemoryIntake';ownerDigest:string;requestDigest:string;
 state:VisualMemoryIntakeState;coverage:'bounded_best_effort';authority:false;
}>;
const states=new Set<VisualMemoryIntakeState>(['queued','policyDenied','replaced','sourceExpired','scopeChanged','invalidEpisode','unattributedSubject','retained','duplicateSource','appearanceBound','sessionBound','capacityExceeded','unclassified']);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const data=(value:unknown,key:string):unknown=>value&&typeof value==='object'&&!types.isProxy(value)?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
function ownerKey(owner:VisualMemoryOwner){const values=['principalId','assistantId','relationshipId'].map(key=>data(owner,key));return values.every(value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value))?hash(JSON.stringify(values)):null;}
type Entry={receipt:VisualMemoryIntakeReceipt;expiresAtMs:number;expiresMono:number};

/** Background source-processing diagnostics. There is no fabricated Human turn,
 * session, caller consent or memory currency claim. No source prose is retained. */
export class VisualMemoryEvidence{
 private readonly pending:Entry[]=[];private readonly retained:Entry[]=[];
 private readonly clocks:{utcMs:()=>number;monotonicMs:()=>number};
 private sequence=0;private epoch=0;private queued=false;private closed=false;
 private lastUtc=-Infinity;private lastMono=-Infinity;
 constructor(clocks:{utcMs:()=>number;monotonicMs:()=>number}={utcMs:Date.now,monotonicMs:()=>performance.now()}){this.clocks=clocks;}
 private now(){
  try{const utc=this.clocks.utcMs(),mono=this.clocks.monotonicMs();if(!Number.isFinite(utc)||!Number.isFinite(mono)||utc<0||mono<0||utc<this.lastUtc||mono<this.lastMono)throw Error('clock');this.lastUtc=utc;this.lastMono=mono;
   for(const rows of [this.pending,this.retained])for(let i=rows.length-1;i>=0;i--)if(utc>=rows[i]!.expiresAtMs||mono>=rows[i]!.expiresMono)rows.splice(i,1);return {utc,mono};
  }catch{this.reset();return null;}
 }
 record(owner:VisualMemoryOwner,requestId:string,state:string):void{
  try{
   if(this.closed)return;const key=ownerKey(owner),at=this.now();if(!key||!at||typeof requestId!=='string'||!requestId||Buffer.byteLength(requestId)>4096)return;
   const normalized=Buffer.byteLength(requestId)<=256?requestId:`sha256:${hash(requestId)}`;
   const receipt:VisualMemoryIntakeReceipt=Object.freeze({eventId:randomUUID(),sequence:++this.sequence,occurredAtMs:at.utc,producerScope:'backgroundVisualMemoryIntake',ownerDigest:key,requestDigest:hash(normalized),state:states.has(state as VisualMemoryIntakeState)?state as VisualMemoryIntakeState:'unclassified',coverage:'bounded_best_effort',authority:false});
   this.pending.push({receipt,expiresAtMs:at.utc+60000,expiresMono:at.mono+60000});if(this.pending.length>128)this.pending.shift();
   if(!this.queued){this.queued=true;const epoch=this.epoch;queueMicrotask(()=>{if(epoch!==this.epoch)return;this.queued=false;if(this.closed||!this.now())return;this.retained.push(...this.pending.splice(0));if(this.retained.length>128)this.retained.splice(0,this.retained.length-128);});}
  }catch{/* Diagnostics cannot change admission, consent, learning or source custody. */}
 }
 receipts(owner:VisualMemoryOwner):readonly VisualMemoryIntakeReceipt[]{try{const key=ownerKey(owner);if(this.closed||!key||!this.now())return Object.freeze([]);return Object.freeze(this.retained.filter(row=>row.receipt.ownerDigest===key).map(row=>row.receipt));}catch{return Object.freeze([]);}}
 reset(){this.epoch++;this.pending.length=0;this.retained.length=0;this.queued=false;}
 close(){this.closed=true;this.reset();}
}
