import {createPresenceTerminalCustodyOwner,type PresenceTerminalCustodyHandle} from './presence-terminal-custody.ts';
import {createHash,randomBytes} from 'node:crypto';
import type {LocalAuthentication,LocalContext} from '../auth/local-auth.ts';
import type {InitiativeOwner} from './initiative-host.ts';
import type {PresenceBinding,PresenceCameraSample,PresenceIdentitySample,QualifiedPresencePorts} from './qualified-presence-source.ts';

/** Returned ONLY by a configured host verifier of a registered protected channel.
 * This adapter does not implement that verifier, OS attestation or recognition.
 * Neither browser authentication nor request JSON is a verifier implementation. */
export type PresenceProducerAuthority={
 binding:PresenceBinding;actorId:string;endpointRevision:number;registrationRevision:number;
 attestationRevision:number;modelRevision:string;purpose:'persistentPresence';
 permission:'granted';consentCurrent:true;enrollmentCurrent:true;leaseExpiresAt:number;
};
export type PresenceProducerPorts={
 authentication:Pick<LocalAuthentication,'hostSessionContext'|'assertCurrent'>;
 /** Verifies the actual channel, executable/model, enrollment, endpoint ownership,
  * consent and original broker lease. Must return null on any unavailable owner. */
 verify:(channel:object,context:LocalContext)=>PresenceProducerAuthority|null;
 owner:QualifiedPresencePorts['owner'];now?:()=>number;monotonicMs?:()=>number;
};
export type PresenceProducerChallenge={capabilityId:string;nonce:string;sequence:number;issuedAt:number;expiresAt:number};
export type PresenceProducerConnection={challenge:()=>PresenceProducerChallenge|null;admit:(packet:string)=>boolean;close:()=>void};
type Capture={channel:object;sessionId:string;authority:PresenceProducerAuthority;contextKey:string;key:string;generation:number;leaseUntil:number};
type Challenge={capture:Capture;wire:PresenceProducerChallenge;until:number};
type Evidence={capture:Capture;camera:PresenceCameraSample;identity:PresenceIdentitySample;until:number};
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bounded=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=256;
const keys=(v:unknown,expected:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...expected].sort().join('|');
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
function valid(a:PresenceProducerAuthority):boolean{
 const b=a.binding;
 return keys(a,['binding','actorId','endpointRevision','registrationRevision','attestationRevision','modelRevision','purpose','permission','consentCurrent','enrollmentCurrent','leaseExpiresAt'])&&
 keys(b,['scope','sessionId','endpointId','siteRef','zoneRef','resourceId','cameraSourceId','identitySourceId','enrollmentRef','enrollmentRevision','captureLeaseId','captureFence','configurationRevision'])&&keys(b.scope,['assistantId','userId','relationshipId','deploymentId'])&&
 [...Object.values(b.scope),b.sessionId,b.endpointId,b.siteRef,b.zoneRef,b.resourceId,b.cameraSourceId,b.identitySourceId,b.enrollmentRef,b.captureLeaseId,b.captureFence,a.actorId,a.modelRevision].every(bounded)&&
 b.cameraSourceId!==b.identitySourceId&&[b.enrollmentRevision,b.configurationRevision,a.endpointRevision,a.registrationRevision,a.attestationRevision].every(positive)&&
 a.purpose==='persistentPresence'&&a.permission==='granted'&&a.consentCurrent===true&&a.enrollmentCurrent===true&&Number.isFinite(a.leaseExpiresAt);
}

const producerEpochs=new WeakMap<object,bigint>();
function producerCustody(){const owner=createPresenceTerminalCustodyOwner('producer');const wrapper=Object.freeze({handle:owner.handle,invalidate(){producerEpochs.set(wrapper,producerEpochs.get(wrapper)!+1n);return owner.invalidate();},close(){producerEpochs.set(wrapper,producerEpochs.get(wrapper)!+1n);return owner.close();}});producerEpochs.set(wrapper,0n);return wrapper;}
const canonicalProducers=new WeakMap<object,{owner:ReturnType<typeof createPresenceTerminalCustodyOwner>;closed:boolean;validate:()=>boolean;captureRetirement:()=>()=>void}>();
/** Actual constructor identity only; not a current-verdict registration. */
export function canonicalQualifiedPresenceProducerCustody(value:unknown):PresenceTerminalCustodyHandle|null{if(!value||typeof value!=='object')return null;const entry=canonicalProducers.get(value);return entry&&!entry.closed?entry.owner.handle:null;}

/** Fixed original read bound only by the real constructor; no caller registrar. */
export function canonicalQualifiedPresenceProducerValidation(value:unknown):(()=>boolean)|null{if(!value||typeof value!=='object')return null;const entry=canonicalProducers.get(value);return entry&&!entry.closed?entry.validate:null;}

/** Capture only original Producer identities; never a caller invalidator. */
export function captureCanonicalQualifiedPresenceProducerRetirement(value:unknown):(()=>void)|null{if(!value||typeof value!=='object')return null;const entry=canonicalProducers.get(value);return entry&&!entry.closed?entry.captureRetirement():null;}

/** Host-only derived-evidence custody. Default unavailable; no routes, capture or grants. */
export class QualifiedPresenceProducer {
 #custody=producerCustody();private readonly ports:PresenceProducerPorts|null;private readonly now:()=>number;private readonly mono:()=>number;
 private generation=0;private active:Capture|undefined;private evidence:Evidence|undefined;private closed=false;
 private lastUtc=-Infinity;private lastMono=-Infinity;private clockFailed=false;
 private readonly challenges=new Map<string,Challenge>();private readonly sequences=new Map<string,number>();
 constructor(ports:PresenceProducerPorts|null=null){const entry={owner:this.#custody,closed:false,validate:()=>!entry.closed&&!!Reflect.apply(originalProducerRead,this,[]),captureRetirement:()=>{const evidence=this.evidence,capture=this.active,epoch=producerEpochs.get(this.#custody);return ()=>{if(capture&&this.active===capture&&this.evidence===evidence&&producerEpochs.get(this.#custody)===epoch)Reflect.apply(originalProducerRetire,this,[capture]);};}};canonicalProducers.set(this,entry);this.ports=ports;this.now=ports?.now??Date.now;this.mono=ports?.monotonicMs??(()=>performance.now());}
 private clocks():{utc:number;mono:number}|null{
  let utc:number,mono:number;
  try{utc=this.now();mono=this.mono();}catch{this.#custody.invalidate();this.clockFailed=true;this.active=undefined;this.evidence=undefined;this.challenges.clear();return null;}
  if(this.clockFailed||![utc,mono].every(Number.isFinite)||utc<this.lastUtc||mono<this.lastMono){this.#custody.invalidate();this.clockFailed=true;this.active=undefined;this.evidence=undefined;this.challenges.clear();return null;}
  this.lastUtc=utc;this.lastMono=mono;return {utc,mono};
 }
 private authority(channel:object,sessionId:string):{authority:PresenceProducerAuthority;contextKey:string}|null{
  try{
   if(this.closed||!this.ports||!channel||typeof channel!=='object'||!bounded(sessionId))return null;
   const context=this.ports.authentication.hostSessionContext(sessionId);this.ports.authentication.assertCurrent(context,false);
   const raw=this.ports.verify(channel,context);if(!raw)return null;const authority=structuredClone(raw);
   if(!valid(authority)||authority.actorId!==context.principalId||authority.binding.sessionId!==context.sessionId||authority.binding.scope.userId!==(context.effectiveContext?.effectiveUserId??context.principalId))return null;
   // Revalidate authentication after the trusted verifier; it may run host work.
   this.ports.authentication.assertCurrent(context,false);
   return {authority,contextKey:digest(context)};
  }catch{return null;}
 }
 private current(c:Capture):boolean{
  const clock=this.clocks();if(!clock||this.active!==c)return false;
  const actual=this.authority(c.channel,c.sessionId);
  const end=this.clocks();
  const accepted=!!actual&&!!end&&this.active===c&&actual.contextKey===c.contextKey&&digest(actual.authority)===digest(c.authority)&&end.utc<c.authority.leaseExpiresAt&&end.mono<c.leaseUntil;
  if(!accepted)this.retire(c);return accepted;
 }
 private retire(c:Capture):void{
  if(this.active===c||this.evidence?.capture===c||[...this.challenges.values()].some(ch=>ch.capture===c))this.#custody.invalidate();
  for(const [id,ch]of this.challenges)if(ch.capture===c)this.challenges.delete(id);
  if(this.evidence?.capture===c)this.evidence=undefined;
  if(this.active===c)this.active=undefined;
 }
 open(channel:object,sessionId:string):PresenceProducerConnection|null{
  const originalGeneration=this.generation;
  const clock=this.clocks(),verified=this.authority(channel,sessionId),end=this.clocks();
  if(this.closed||this.generation!==originalGeneration||!clock||!end||!verified||verified.authority.leaseExpiresAt<=end.utc||end.mono>=clock.mono+verified.authority.leaseExpiresAt-clock.utc)return null;
  // A genuine renewed expiry requires fresh admission but retains sequence custody.
  const {leaseExpiresAt:_,...identity}=verified.authority;
  const key=digest([identity,verified.contextKey]);
  if(!this.sequences.has(key)&&this.sequences.size>=8)return null;
  if(this.active)this.retire(this.active);
  this.#custody.invalidate();const c:Capture={channel,sessionId,...verified,key,generation:++this.generation,leaseUntil:clock.mono+verified.authority.leaseExpiresAt-clock.utc};this.active=c;this.sequences.set(key,this.sequences.get(key)??0);
  return Object.freeze({challenge:()=>this.challenge(c),admit:(packet:string)=>this.admit(c,packet),close:()=>this.retire(c)});
 }
 private challenge(c:Capture):PresenceProducerChallenge|null{
  try{
   if(!this.current(c)){this.retire(c);return null;}const clock=this.clocks();if(!clock)return null;
   for(const [id,ch]of this.challenges)if(clock.utc>=ch.wire.expiresAt||clock.mono>=ch.until){this.#custody.invalidate();this.challenges.delete(id);}
   if(this.challenges.size>=16)return null;
   const sequence=(this.sequences.get(c.key)??0)+1;if(!positive(sequence))return null;this.#custody.invalidate();this.sequences.set(c.key,sequence);
   const expiresAt=Math.min(clock.utc+5000,c.authority.leaseExpiresAt);
   const wire={capabilityId:randomBytes(32).toString('hex'),nonce:randomBytes(32).toString('hex'),sequence,issuedAt:clock.utc,expiresAt};
   this.challenges.set(wire.capabilityId,{capture:c,wire,until:Math.min(c.leaseUntil,clock.mono+expiresAt-clock.utc)});return structuredClone(wire);
  }catch{this.retire(c);return null;}
 }
 private admit(c:Capture,packet:string):boolean{
  try{
   if(typeof packet!=='string'||Buffer.byteLength(packet)>4096)return false;
   const p:unknown=JSON.parse(packet);if(!keys(p,['capabilityId','nonce','sequence','observedAt','expiresAt','camera','identity']))return false;
   const ch=this.challenges.get(String(p.capabilityId));if(!ch||ch.capture!==c||p.nonce!==ch.wire.nonce)return false;
   // Consume the genuine single-use capability before further parsing/current callbacks.
   this.#custody.invalidate();this.challenges.delete(ch.wire.capabilityId);
   if(!keys(p.camera,['coverageKnown','occupants'])||!keys(p.identity,['status'])||typeof p.camera.coverageKnown!=='boolean'||!Number.isInteger(p.camera.occupants)||Number(p.camera.occupants)<0||Number(p.camera.occupants)>100||typeof p.identity.status!=='string'||!['supported','qualifiedAbsent','uncertain','unavailable'].includes(p.identity.status)||p.sequence!==ch.wire.sequence)return false;
   const clock=this.clocks();if(!clock||!this.current(c))return false;
   if(!Number.isFinite(p.observedAt)||!Number.isFinite(p.expiresAt)||Number(p.observedAt)<ch.wire.issuedAt||Number(p.observedAt)>clock.utc||Number(p.expiresAt)<=clock.utc||Number(p.expiresAt)>ch.wire.expiresAt||Number(p.expiresAt)>Number(p.observedAt)+5000||clock.mono>=ch.until)return false;
   const prior=this.evidence;if(prior?.capture.key===c.key&&Number(p.sequence)<=prior.camera.sequence)return false;
   const b=c.authority.binding,evidenceRef=`producer:${digest([ch.wire,p])}`;
   const camera:PresenceCameraSample={sourceId:b.cameraSourceId,resourceId:b.resourceId,captureLeaseId:b.captureLeaseId,captureFence:b.captureFence,sequence:ch.wire.sequence,observedAt:Number(p.observedAt),expiresAt:Number(p.expiresAt),evidenceRef,coverageKnown:p.camera.coverageKnown,occupants:Number(p.camera.occupants)};
   const identity:PresenceIdentitySample={sourceId:b.identitySourceId,principalId:b.scope.userId,siteRef:b.siteRef,zoneRef:b.zoneRef,resourceId:b.resourceId,enrollmentRef:b.enrollmentRef,enrollmentRevision:b.enrollmentRevision,sequence:ch.wire.sequence,observedAt:Number(p.observedAt),expiresAt:Number(p.expiresAt),evidenceRef,status:p.identity.status as PresenceIdentitySample['status']};
   // Any original host callback withdrawal during validation wins over late admission.
   if(!this.current(c))return false;const end=this.clocks();if(!end||end.utc>=camera.expiresAt||end.mono>=ch.until||this.active!==c||this.evidence?.capture.key===c.key&&this.evidence.camera.sequence>=camera.sequence)return false;
   this.#custody.invalidate();this.evidence={capture:c,camera,identity,until:Math.min(ch.until,clock.mono+camera.expiresAt-clock.utc)};return true;
  }catch{return false;}
 }
 private read():Evidence|undefined{
  try{const e=this.evidence;if(!e)return undefined;const clock=this.clocks();if(this.evidence!==e||this.active!==e.capture)return undefined;if(!clock||clock.utc>=e.camera.expiresAt||clock.mono>=e.until||!this.current(e.capture)){this.retire(e.capture);return undefined;}const end=this.clocks();if(!end||end.utc>=e.camera.expiresAt||end.mono>=e.until||this.evidence!==e||this.active!==e.capture)return undefined;return e;}catch{return undefined;}
 }
 presencePorts():QualifiedPresencePorts{
  return {binding:()=>{const e=this.read();return e?structuredClone(e.capture.authority.binding):null;},current:b=>{const e=this.read();return !!e&&digest(b)===digest(e.capture.authority.binding);},owner:s=>this.ports?.owner(s),camera:b=>{const e=this.read();return e&&digest(b)===digest(e.capture.authority.binding)?structuredClone(e.camera):null;},identity:b=>{const e=this.read();return e&&digest(b)===digest(e.capture.authority.binding)?structuredClone(e.identity):null;},now:this.now,monotonicMs:this.mono};
 }
 close():void{this.#custody.close();const entry=canonicalProducers.get(this);if(entry)entry.closed=true;this.closed=true;this.active=undefined;this.evidence=undefined;this.challenges.clear();}
}

// Captured at module initialization, never through a replaceable instance read.
const originalProducerRead=Object.getOwnPropertyDescriptor(QualifiedPresenceProducer.prototype,'read')!.value as (this:QualifiedPresenceProducer)=>unknown;
const originalProducerRetire=Object.getOwnPropertyDescriptor(QualifiedPresenceProducer.prototype,'retire')!.value as (this:QualifiedPresenceProducer,capture:Capture)=>void;
