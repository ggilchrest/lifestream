import {beginCanonicalPresenceExecutionScope,finishCanonicalPresenceExecutionScope} from './ubuntu-presence-composition.ts';
import {isAssembledCanonicalPresenceOwners,canonicalPresenceProducerValidation,canonicalPresenceProducer} from './canonical-presence-owners.ts';
import {createHash} from 'node:crypto';
import {capturePresenceTerminalCustody,matchesPresenceTerminalCustody,type PresenceTerminalCustodyOwners,type PresenceTerminalCustodyTicket} from './presence-terminal-custody.ts';
import {createContractValidator} from '@lifestream/contracts';
import type {InitiativeScope} from '@lifestream/storage-sqlite';
import type {AudienceObservation} from './audience.ts';
import type {InitiativeOwner,QualifiedInitiativeEvent,QualifiedInitiativeSource} from './initiative-host.ts';

/** Independent persistent consent/lease and enrolled association. Never conversation visibility. */
export type PresenceBinding={
 scope:InitiativeScope;sessionId:string;endpointId:string;siteRef:string;zoneRef:string;resourceId:string;
 cameraSourceId:string;identitySourceId:string;enrollmentRef:string;enrollmentRevision:number;
 captureLeaseId:string;captureFence:string;configurationRevision:number;
};
export type PresenceCameraSample={sourceId:string;resourceId:string;captureLeaseId:string;captureFence:string;sequence:number;observedAt:number;expiresAt:number;evidenceRef:string;coverageKnown:boolean;occupants:number};
export type PresenceIdentitySample={sourceId:string;principalId:string;siteRef:string;zoneRef:string;resourceId:string;enrollmentRef:string;enrollmentRevision:number;sequence:number;observedAt:number;expiresAt:number;evidenceRef:string;status:'supported'|'qualifiedAbsent'|'uncertain'|'unavailable'};
/** Affirmative availability is a separate configured owner, never identity or privacy. */
export type PresenceAvailabilitySelection={binding:PresenceBinding;initiativeConfigurationId:string;initiativeConfigurationRevision:number;sessionRevision:number};
export type PresenceAvailabilityWindow={windowId:string;revision:number;selection:PresenceAvailabilitySelection;evidenceRef:string;availableFrom:number;expiresAt:number};
export type PresenceAvailabilityPort={terminalCustody?:PresenceTerminalCustodyOwners;revision:number;read:(selection:PresenceAvailabilitySelection)=>PresenceAvailabilityWindow|null;current:(selection:PresenceAvailabilitySelection,window:PresenceAvailabilityWindow)=>boolean;signal:AbortSignal};
/** The factory supplies the canonical Session revision, not the window owner. */
export type QualifiedPresenceAvailability=PresenceAvailabilityPort&{selection:(binding:PresenceBinding,configuration:{configurationId:string;revision:number})=>PresenceAvailabilitySelection|null};
export type QualifiedPresencePorts={
 binding:()=>PresenceBinding|null;
 /** Real current persistent policy, permission, resource lease/fence and association owner. */
 current:(binding:PresenceBinding)=>boolean;
 owner:(scope:InitiativeScope)=>InitiativeOwner|undefined;
 camera:(binding:PresenceBinding)=>PresenceCameraSample|null;
 /** Independent enrolled source; no scene-count or model/login promotion. */
 identity:(binding:PresenceBinding)=>PresenceIdentitySample|null;
 availability?:QualifiedPresenceAvailability;
 now?:()=>number;monotonicMs?:()=>number;
};
type Evidence={binding:PresenceBinding;owner:InitiativeOwner;camera:PresenceCameraSample;identity:PresenceIdentitySample;utc:number;mono:number;until:number;key:string;present:boolean;absent:boolean;tuning:{dwell:number;absence:number;ttl:number;checkInInterval:number;checkInTtl:number};checkIn:boolean};
const hash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=256;
const scopeKey=(s:InitiativeScope)=>hash([s.assistantId,s.userId,s.relationshipId,s.deploymentId]);
const validator=createContractValidator();
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};

// Closed data copies never invoke a window/selection accessor or retain mutable owner objects.
const dataCopy=(v:unknown,depth=0):unknown=>{
 if(depth>5)throw Error('Availability depth');
 if(v===null||['string','number','boolean'].includes(typeof v))return v;
 if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Availability data');
 const descriptors=Object.getOwnPropertyDescriptors(v),keys=Object.keys(descriptors);if(keys.length>24)throw Error('Availability fields');
 const result:Record<string,unknown>={};for(const k of keys){const d=descriptors[k]!;if(!Object.hasOwn(d,'value'))throw Error('Availability accessor');Object.defineProperty(result,k,{value:dataCopy(d.value,depth+1),enumerable:true,writable:true,configurable:true});}return result;
};
const exactFields=(v:object,keys:string[])=>Object.keys(v).sort().join('|')===keys.sort().join('|');
const boundedRef=(v:unknown):v is string=>typeof v==='string'&&Buffer.byteLength(v)>0&&Buffer.byteLength(v)<=128;
const sourceExecutionTokens=new WeakMap<object,Map<object,object>>();
/** Membership only: tokens exist solely inside the original synchronous Source wrapper. */
export function matchesCanonicalSourceExecutionScope(source:unknown,token:object,producer:object):boolean{return !!source&&typeof source==='object'&&sourceExecutionTokens.get(source)?.get(token)===producer;}
const canonicalOpportunityGuards=new WeakMap<()=>boolean,{source:QualifiedPresenceSource;eventId:string;validate:()=>boolean}>();
/** Fixed source/event/guard identity only; no supplied callback or getter. */
export function isCanonicalQualifiedPresenceGuard(guard:unknown,source:unknown,eventId:string):guard is ()=>boolean{if(typeof guard!=='function')return false;const entry=canonicalOpportunityGuards.get(guard as ()=>boolean);return !!entry&&entry.source===source&&entry.eventId===eventId;}
/** Original Producer validation paired with this exact Source-held guard. */
export function canonicalQualifiedPresenceGuardValidation(guard:unknown,source:unknown,eventId:string):(()=>boolean)|null{if(typeof guard!=='function')return null;const entry=canonicalOpportunityGuards.get(guard as ()=>boolean);return entry&&entry.source===source&&entry.eventId===eventId?entry.validate:null;}
type OperationCustody={owners:PresenceTerminalCustodyOwners;ticket:PresenceTerminalCustodyTicket};
type AvailabilityCustody={window:PresenceAvailabilityWindow;fingerprint:string;until:number;invalid:boolean;event?:QualifiedInitiativeEvent;eventUntil?:number};

/** Bounded one-binding reducer. A real identity/enrollment producer is still required. */
export class QualifiedPresenceSource implements QualifiedInitiativeSource {
 readonly sourceId:string;
 private readonly now:()=>number;private readonly mono:()=>number;
 private latest:Evidence|undefined;private lastUtc=-Infinity;private lastMono=-Infinity;
 private readonly custody=new Map<string,{camera:PresenceCameraSample;identity:PresenceIdentitySample;cameraUntil:number;identityUntil:number}>();
 private absentSince:number|undefined;private absentMono:number|undefined;private absentDuration=0;private presentSince:number|undefined;private presentMono:number|undefined;
 private event:QualifiedInitiativeEvent|undefined;private transition=0;
 private readonly ports:QualifiedPresencePorts;
 private readonly availability:QualifiedPresenceAvailability|undefined;private readonly availabilityRevision:number|undefined;private readonly availabilitySignal:AbortSignal|undefined;private readonly availabilityMethods:readonly unknown[]|undefined;
 private readonly availabilityOwners:PresenceTerminalCustodyOwners|undefined;
 #eventCustody:OperationCustody|undefined;
 #eventRetirements=new WeakMap<OperationCustody,{retired:boolean}>();
 private captureOperation():OperationCustody|undefined{const owners=this.availabilityOwners,ticket=owners&&capturePresenceTerminalCustody(owners);return owners&&ticket?{owners,ticket}:undefined;}
 private operationCurrent(operation:OperationCustody|undefined):boolean{return !!operation&&matchesPresenceTerminalCustody(operation.ticket,operation.owners);}
 /** A private SAME entry ticket; no owner/clock callback and no recapture. */
 opportunityGuard(sourceEventId:string):(()=>boolean)|null{
  const event=this.event,operation=this.#eventCustody;if(!event||event.sourceEventId!==sourceEventId||event.kind!=='availableCheckIn')return null;
  const owners=operation?.owners;if(!isAssembledCanonicalPresenceOwners(owners))return ()=>this.operationCurrent(operation);
  const producerValidation=canonicalPresenceProducerValidation(owners);if(!producerValidation)return null;
  const ticket=operation?.ticket,retirement=this.#eventRetirements.get(operation!)??{retired:false};this.#eventRetirements.set(operation!,retirement);
  const guard=()=>!retirement.retired&&!!owners&&!!ticket&&matchesPresenceTerminalCustody(ticket,owners);
  const validate=()=>{
   const accepted=guard()&&producerValidation()&&guard();
   if(!accepted){retirement.retired=true;if(this.event===event&&this.#eventCustody===operation)Reflect.apply(originalSourceReset,this,[]);}
   return accepted;
  };
  canonicalOpportunityGuards.set(guard,{source:this,eventId:sourceEventId,validate});return guard;
 }
 private readonly windows=new Map<string,AvailabilityCustody>();private checkInAt:{utc:number;mono:number}|undefined;
 constructor(sourceId:string,ports:QualifiedPresencePorts){
  this.ports=ports;
  try{const a=ports.availability;if(a){const d=Object.getOwnPropertyDescriptors(a);if(['revision','read','current','signal','selection'].every(k=>Object.hasOwn(d[k]??{},'value'))&&Number.isSafeInteger(d.revision!.value)&&Number(d.revision!.value)>0&&['read','current','selection'].every(k=>typeof d[k]!.value==='function')&&d.signal!.value instanceof AbortSignal){const owners=d.terminalCustody;if(!owners||!Object.hasOwn(owners,'value')||!capturePresenceTerminalCustody(owners.value))throw Error('Missing availability custody');this.availabilityOwners=owners.value;this.availability=a;this.availabilityRevision=d.revision!.value;this.availabilitySignal=d.signal!.value;this.availabilityMethods=[d.read!.value,d.current!.value,d.selection!.value];}}}catch{/* Invalid optional owner remains off. */}
  if(!text(sourceId)||Buffer.byteLength(sourceId)>80)throw new Error('A bounded configured presence source is required');
  this.sourceId=sourceId;this.now=ports.now??Date.now;this.mono=ports.monotonicMs??(()=>performance.now());
 }
 private reset():void{this.latest=undefined;this.absentSince=undefined;this.absentMono=undefined;this.absentDuration=0;this.presentSince=undefined;this.presentMono=undefined;this.event=undefined;this.#eventCustody=undefined;}
 private read(capturedClocks?:{utc:number;mono:number}):Evidence|undefined{
  try{
   const utc=capturedClocks?.utc??this.now(),mono=capturedClocks?.mono??this.mono();
   if(![utc,mono].every(Number.isFinite)||utc<this.lastUtc||mono<this.lastMono)return undefined;
   this.lastUtc=utc;this.lastMono=mono;
   const raw=this.ports.binding();if(!raw)return undefined;const b=structuredClone(raw);
   if(!b.scope||![b.scope.assistantId,b.scope.userId,b.scope.relationshipId,b.scope.deploymentId,b.sessionId,b.endpointId,b.siteRef,b.zoneRef,b.resourceId,b.cameraSourceId,b.identitySourceId,b.enrollmentRef,b.captureLeaseId,b.captureFence].every(text)||b.identitySourceId===b.cameraSourceId||![b.enrollmentRevision,b.configurationRevision].every(v=>Number.isSafeInteger(v)&&v>0)||this.ports.current(b)!==true)return undefined;
   const owner=this.ports.owner(b.scope),config=owner?.configuration;
   if(owner?.consentCurrent!==true||scopeKey(owner.scope)!==scopeKey(b.scope)||!config||!validator.validate('https://lifestream.dev/contracts/relational-initiative/1.0.0#/$defs/RelationalInitiativeConfiguration',config).valid||config.lifecycle!=='active'||['assistantId','userId','relationshipId','deploymentId'].some(k=>config[k]!==b.scope[k as keyof InitiativeScope])||config.parentConfigurationRevision!==`${config.configurationId}:${config.revision}`||!(config.consentRefs as string[]).length||!(config.endpointIds as string[]).includes(b.endpointId))return undefined;
   const t=object(config.tuning),tuning={dwell:Number(t.arrivalDwellSeconds),absence:Number(t.meaningfulAbsenceSeconds),ttl:Number(t.arrivalTtlSeconds),checkInInterval:Number(t.checkInIntervalSeconds),checkInTtl:Number(t.checkInTtlSeconds)};
   if(![tuning.dwell,tuning.absence,tuning.ttl].every(v=>Number.isFinite(v)&&v>0))return undefined;
   const camera=structuredClone(this.ports.camera(b)),identity=structuredClone(this.ports.identity(b));
   if(!camera||!identity||camera.sourceId!==b.cameraSourceId||camera.resourceId!==b.resourceId||camera.captureLeaseId!==b.captureLeaseId||camera.captureFence!==b.captureFence||identity.sourceId!==b.identitySourceId||identity.principalId!==b.scope.userId||identity.siteRef!==b.siteRef||identity.zoneRef!==b.zoneRef||identity.resourceId!==b.resourceId||identity.enrollmentRef!==b.enrollmentRef||identity.enrollmentRevision!==b.enrollmentRevision)return undefined;
   for(const s of [camera,identity])if(!Number.isSafeInteger(s.sequence)||s.sequence<1||!text(s.evidenceRef)||![s.observedAt,s.expiresAt].every(Number.isFinite)||s.observedAt>utc||utc-s.observedAt>5000||s.expiresAt<=utc||s.expiresAt>s.observedAt+5000)return undefined;
   if(typeof camera.coverageKnown!=='boolean'||!Number.isInteger(camera.occupants)||camera.occupants<0||camera.occupants>100||!['supported','qualifiedAbsent','uncertain','unavailable'].includes(identity.status))return undefined;
   const key=hash([b,config,owner.boundary]),prior=this.custody.get(key);
   if(!prior&&this.custody.size>=8)return undefined;
   if(prior&&(camera.sequence<prior.camera.sequence||identity.sequence<prior.identity.sequence||camera.observedAt<prior.camera.observedAt||identity.observedAt<prior.identity.observedAt||camera.sequence===prior.camera.sequence&&hash(camera)!==hash(prior.camera)||identity.sequence===prior.identity.sequence&&hash(identity)!==hash(prior.identity)))return undefined;
   const cameraUntil=prior&&camera.sequence===prior.camera.sequence?prior.cameraUntil:mono+camera.expiresAt-utc;
   const identityUntil=prior&&identity.sequence===prior.identity.sequence?prior.identityUntil:mono+identity.expiresAt-utc;
   const finalUtc=capturedClocks?.utc??this.now(),finalMono=capturedClocks?.mono??this.mono();
   if(![finalUtc,finalMono].every(Number.isFinite)||finalUtc<utc||finalMono<mono||finalUtc>=Math.min(camera.expiresAt,identity.expiresAt)||finalMono>=Math.min(cameraUntil,identityUntil))return undefined;
   this.lastUtc=finalUtc;this.lastMono=finalMono;
   this.custody.set(key,{camera,identity,cameraUntil,identityUntil});
   return {binding:b,owner:structuredClone(owner),camera,identity,utc:finalUtc,mono:finalMono,until:Math.min(cameraUntil,identityUntil),key,tuning,checkIn:(config.allowedKinds as string[]).includes('availableCheckIn')&&Number.isInteger(tuning.checkInInterval)&&tuning.checkInInterval>=300&&tuning.checkInInterval<=7200&&Number.isInteger(tuning.checkInTtl)&&tuning.checkInTtl>=30&&tuning.checkInTtl<=600,present:identity.status==='supported'&&camera.coverageKnown&&camera.occupants===1,absent:identity.status==='qualifiedAbsent'&&camera.coverageKnown&&camera.occupants===0};
  }catch{return undefined;}
 }
 private availabilityStable():boolean{
  try{const a=this.availability,d=a&&Object.getOwnPropertyDescriptors(a);return !!a&&this.ports.availability===a&&d?.revision?.value===this.availabilityRevision&&d?.signal?.value===this.availabilitySignal&&d?.terminalCustody?.value===this.availabilityOwners&&this.availabilitySignal?.aborted===false&&[d?.read?.value,d?.current?.value,d?.selection?.value].every((v,i)=>v===this.availabilityMethods?.[i]);}catch{return false;}
 }
 private availabilityEvidenceCurrent(e:Evidence,capturedClocks?:{utc:number;mono:number}):boolean{
  const actual=this.read(capturedClocks);return !!actual&&actual.key===e.key&&actual.present&&actual.checkIn&&hash(actual.binding)===hash(e.binding)&&hash(actual.camera)===hash(e.camera)&&hash(actual.identity)===hash(e.identity)&&this.fresh(actual);
 }
 private selection(e:Evidence,capturedClocks?:{utc:number;mono:number}):PresenceAvailabilitySelection|undefined{
  const a=this.availability;if(!a||!this.availabilityStable())return undefined;
  const c=e.owner.configuration!,raw=a.selection(structuredClone(e.binding),{configurationId:String(c.configurationId),revision:Number(c.revision)});if(!this.availabilityStable()||!raw||!this.availabilityEvidenceCurrent(e,capturedClocks))return undefined;
  const s=dataCopy(raw) as PresenceAvailabilitySelection;
  if(!exactFields(s,['binding','initiativeConfigurationId','initiativeConfigurationRevision','sessionRevision'])||hash(s.binding)!==hash(e.binding)||s.initiativeConfigurationId!==c.configurationId||s.initiativeConfigurationRevision!==c.revision||!Number.isSafeInteger(s.sessionRevision)||s.sessionRevision<1||!this.availabilityStable()||!this.availabilityEvidenceCurrent(e,capturedClocks))return undefined;
  return s;
 }
 private window(e:Evidence,operation:OperationCustody|undefined):{row:AvailabilityCustody;selection:PresenceAvailabilitySelection}|undefined{
  try{
   if(!e.present||!e.checkIn||!this.fresh(e))return undefined;
   const a=this.availability,owners=this.availabilityOwners;if(!a||!owners)return undefined;
   if(!operation||operation.owners!==owners)return undefined;
   const s=this.selection(e);if(!s)return undefined;
   const raw=a.read(structuredClone(s));if(!this.availabilityStable()||!raw||!this.availabilityEvidenceCurrent(e))return undefined;
   const w=dataCopy(raw) as PresenceAvailabilityWindow;
   if(!exactFields(w,['windowId','revision','selection','evidenceRef','availableFrom','expiresAt'])||!boundedRef(w.windowId)||!boundedRef(w.evidenceRef)||!Number.isSafeInteger(w.revision)||w.revision<1||hash(w.selection)!==hash(s)||![w.availableFrom,w.expiresAt].every(Number.isFinite)||w.availableFrom>e.utc||w.expiresAt<=e.utc||w.expiresAt>w.availableFrom+600000)return undefined;
   // Every effectful owner callback is followed by signal/identity and original selection fences.
   if(hash(this.selection(e))!==hash(s)||a.current(structuredClone(s),structuredClone(w))!==true||!this.availabilityStable()||!this.availabilityEvidenceCurrent(e)||hash(this.selection(e))!==hash(s))return undefined;
   const utc=this.now(),mono=this.mono();if(![utc,mono].every(Number.isFinite)||utc<e.utc||mono<e.mono||utc>=w.expiresAt||utc>=Math.min(e.camera.expiresAt,e.identity.expiresAt)||mono>=e.until)return undefined;
   // Clocks are configured callbacks too. Keep their original residuals and fence
   // captured evidence/selection once; the final owner check follows those callbacks.
   if(!this.availabilityStable()||!this.availabilityEvidenceCurrent(e)||hash(this.selection(e))!==hash(s)||!this.availabilityStable())return undefined;
   // The affirmative verdict follows every configured clock callback. Reuse the
   // original guards at their captured high-water clocks after that verdict,
   // without invoking a clock that could revoke it again or extending custody.
   const capturedClocks={utc:this.lastUtc,mono:this.lastMono};
   if(![capturedClocks.utc,capturedClocks.mono].every(Number.isFinite)||capturedClocks.utc<utc||capturedClocks.mono<mono||capturedClocks.utc>=w.expiresAt||capturedClocks.utc>=Math.min(e.camera.expiresAt,e.identity.expiresAt)||capturedClocks.mono>=e.until)return undefined;
   if(a.current(structuredClone(s),structuredClone(w))!==true||!this.availabilityStable()||!this.availabilityEvidenceCurrent(e,capturedClocks)||hash(this.selection(e,capturedClocks))!==hash(s)||!this.availabilityStable())return undefined;
   // Original material is evaluated once BEFORE the final private fence.
   const key=hash([e.key,this.availabilityRevision,w.windowId,w.revision]),fingerprint=hash(w);let row=this.windows.get(key);
   const freshRow=!row?{window:structuredClone(w),fingerprint,until:e.mono+w.expiresAt-e.utc,invalid:false}:undefined;
   if(!this.operationCurrent(operation))return undefined;
   this.lastUtc=Math.max(this.lastUtc,utc);this.lastMono=Math.max(this.lastMono,mono);
   if(row&&row.fingerprint!==fingerprint){row.invalid=true;return undefined;}
   if(!row){if(this.windows.size>=8)return undefined;row=freshRow!;this.windows.set(key,row);}
   if(row.invalid||mono>=row.until)return undefined;
   return {row,selection:s};
  }catch{return undefined;}
 }
 private checkIn(e:Evidence,operation:OperationCustody|undefined):QualifiedInitiativeEvent|undefined{
  const found=this.window(e,operation);if(!found)return undefined;const {row,selection}=found;
  // Original occurrence lifetime and both clock budgets are never extended on repeat reads.
  if(row.event)return e.utc<row.event.expiresAt&&e.mono<Math.min(row.until,row.eventUntil!)?row.event:undefined;
  const last=this.checkInAt;if(last&&(e.utc-last.utc<e.tuning.checkInInterval*1000||e.mono-last.mono<e.tuning.checkInInterval*1000))return undefined;
  const at={utc:e.utc,mono:e.mono};
  const w=row.window,eventUntil=Math.min(row.until,e.mono+e.tuning.checkInTtl*1000),event:QualifiedInitiativeEvent={scope:structuredClone(e.binding.scope),userId:e.binding.scope.userId,sessionId:e.binding.sessionId,endpointId:e.binding.endpointId,sourceId:this.sourceId,sourceRevision:e.binding.configurationRevision,evidenceRef:`presence:${hash([e.camera.evidenceRef,e.identity.evidenceRef,w.evidenceRef]).slice(0,64)}`,sourceEventId:hash([this.sourceId,e.key,'availableCheckIn',this.availabilityRevision,selection,w.windowId,w.revision,w.availableFrom]),kind:'availableCheckIn',topicRef:null,observedAt:e.utc,expiresAt:Math.min(w.expiresAt,e.utc+e.tuning.checkInTtl*1000),context:'privateAvailable',modality:'text',identityQualified:true,privateAudience:true};
  if(!this.operationCurrent(operation))return undefined;this.checkInAt=at;row.eventUntil=eventUntil;row.event=event;return row.event;
 }
 private fresh(e:Evidence):boolean{return e.utc<=Math.min(e.camera.expiresAt,e.identity.expiresAt)&&e.mono<e.until;}
 private compatible(previous:Evidence,next:Evidence):boolean{
  return previous.key===next.key&&next.utc>=previous.utc&&next.mono>=previous.mono&&next.mono<previous.until&&next.camera.observedAt>=previous.camera.observedAt&&next.identity.observedAt>=previous.identity.observedAt;
 }
 /** Pulls only configured source ports. No camera acquisition, provider or output calls. */
 poll():AudienceObservation|null{
  const operation=this.captureOperation(),e=this.read();if(!e){this.reset();return null;}
  const previous=this.latest;
  if(previous&&!this.compatible(previous,e))this.reset();
  const old=this.latest;
  if(old&&(e.camera.sequence<old.camera.sequence||e.identity.sequence<old.identity.sequence||e.camera.sequence===old.camera.sequence&&hash(e.camera)!==hash(old.camera)||e.identity.sequence===old.identity.sequence&&hash(e.identity)!==hash(old.identity))){this.reset();return null;}
  // Frozen wall clocks or repeated sample reads cannot refresh monotonic freshness.
  if(old&&(e.camera.sequence===old.camera.sequence||e.identity.sequence===old.identity.sequence))e.until=Math.min(e.until,old.until);
  // Re-reading a sample may expose current evidence; it never advances transition clocks.
  const advancing=!old||e.camera.sequence>old.camera.sequence&&e.identity.sequence>old.identity.sequence;
  if(advancing){
   const at=Math.min(e.camera.observedAt,e.identity.observedAt);
   if(e.absent){
    this.event=undefined;this.presentSince=undefined;this.presentMono=undefined;this.absentSince??=at;this.absentMono??=e.mono;
    this.absentDuration=Math.max(0,Math.min(at-this.absentSince,e.mono-this.absentMono)/1000);
   }else if(e.present){
    if(this.presentSince===undefined){this.presentSince=at;this.presentMono=e.mono;this.absentSince=undefined;this.absentMono=undefined;this.transition++;}
    const dwell=Math.max(0,Math.min(at-this.presentSince,e.mono-this.presentMono!)/1000);
    if((!this.event||this.event.kind==='availableCheckIn')&&this.absentDuration>=e.tuning.absence&&dwell>=e.tuning.dwell){
     const sourceEventId=hash([e.key,this.transition,this.presentSince]),expiry=e.utc+e.tuning.ttl*1000;
     this.event={scope:structuredClone(e.binding.scope),userId:e.binding.scope.userId,sessionId:e.binding.sessionId,endpointId:e.binding.endpointId,sourceId:this.sourceId,sourceRevision:e.binding.configurationRevision,evidenceRef:`presence:${hash([e.camera.evidenceRef,e.identity.evidenceRef]).slice(0,64)}`,sourceEventId,kind:'arrivalReturn',topicRef:null,observedAt:e.utc,expiresAt:expiry,context:'privateAvailable',modality:'text',dwellSeconds:dwell,absenceSeconds:this.absentDuration,identityQualified:true,privateAudience:true};
    }
   }else{this.reset();}
  }
  // Unknown/contradictory evidence never bridges a prior absence or present dwell.
  if(!e.present&&!e.absent){this.absentSince=undefined;this.absentMono=undefined;this.absentDuration=0;this.presentSince=undefined;this.presentMono=undefined;this.event=undefined;this.#eventCustody=undefined;}
  this.latest=e;
  if(e.present&&this.event?.kind!=='arrivalReturn')this.event=this.checkIn(e,operation);
  const observation:AudienceObservation={sourceId:this.sourceId,evidenceRef:`presence:${hash([e.camera.evidenceRef,e.identity.evidenceRef]).slice(0,64)}`,endpointId:e.binding.endpointId,principalId:e.binding.scope.userId,observedAt:new Date(Math.min(e.camera.observedAt,e.identity.observedAt)).toISOString(),expiresAt:new Date(Math.min(e.camera.expiresAt,e.identity.expiresAt)).toISOString(),coverageKnown:e.camera.coverageKnown,ownerPresent:e.present,occupants:e.camera.occupants};
  if(this.event?.kind==='availableCheckIn'){if(!this.operationCurrent(operation)){this.reset();return null;}this.#eventCustody=operation;}return observation;
 }
 /** Revalidate actual source/lease/enrollment/policy now; do not extend the original event. */
 resolve(scope:InitiativeScope,sessionId:string,sourceEventId:string):QualifiedInitiativeEvent|undefined{
  const operation=this.#eventCustody,event=this.event,producer=operation&&canonicalPresenceProducer(operation.owners);
  if(!operation||!event||event.kind!=='availableCheckIn'||!producer)return Reflect.apply(originalSourceResolve,this,[scope,sessionId,sourceEventId]);
  const token={},tokens=sourceExecutionTokens.get(this)??new Map<object,object>();sourceExecutionTokens.set(this,tokens);tokens.set(token,producer);
  let finished=false;
  const retire=()=>{const retirement=this.#eventRetirements.get(operation)??{retired:false};retirement.retired=true;this.#eventRetirements.set(operation,retirement);if(this.event===event&&this.#eventCustody===operation)Reflect.apply(originalSourceReset,this,[]);};
  try{
   beginCanonicalPresenceExecutionScope(this,token,producer);
   const result=Reflect.apply(originalSourceResolve,this,[scope,sessionId,sourceEventId]) as QualifiedInitiativeEvent|undefined;
   const valid=finishCanonicalPresenceExecutionScope(this,token,producer);finished=true;
   if(!valid||!matchesPresenceTerminalCustody(operation.ticket,operation.owners)){retire();return undefined;}return result;
  }finally{
   if(!finished&&!finishCanonicalPresenceExecutionScope(this,token,producer))retire();
   if(tokens.get(token)===producer)tokens.delete(token);if(tokens.size===0&&sourceExecutionTokens.get(this)===tokens)sourceExecutionTokens.delete(this);
  }
 }
 private resolveOriginal(scope:InitiativeScope,sessionId:string,sourceEventId:string):QualifiedInitiativeEvent|undefined{
  const operation=this.captureOperation(),original=this.event,latest=this.latest;
  if(!original||scopeKey(scope)!==scopeKey(original.scope)||sessionId!==original.sessionId||sourceEventId!==original.sourceEventId)return undefined;
  const e=this.read();
  if(!latest||!e||!this.compatible(latest,e)||!this.fresh(e)||!e.present||e.camera.sequence<latest.camera.sequence||e.identity.sequence<latest.identity.sequence||e.camera.sequence===latest.camera.sequence&&hash(e.camera)!==hash(latest.camera)||e.identity.sequence===latest.identity.sequence&&hash(e.identity)!==hash(latest.identity)||e.utc>=original.expiresAt){this.reset();return undefined;}
  if(original.kind==='availableCheckIn'){const found=this.window(e,operation);if(!found?.row.event||found.row.event.sourceEventId!==original.sourceEventId||e.mono>=Math.min(found.row.until,found.row.eventUntil!)){this.reset();return undefined;}}
  const result=structuredClone(original);if(original.kind==='availableCheckIn'&&!this.operationCurrent(operation)){this.reset();return undefined;}return result;
 }
 opportunityId():string|undefined{return this.event?.sourceEventId;}
 stop():void{this.reset();}
}

// Reset only the original held event, using the fixed original implementation.
const originalSourceReset=Object.getOwnPropertyDescriptor(QualifiedPresenceSource.prototype,'reset')!.value as (this:QualifiedPresenceSource)=>void;
const originalSourceResolve=Object.getOwnPropertyDescriptor(QualifiedPresenceSource.prototype,'resolveOriginal')!.value as (this:QualifiedPresenceSource,scope:InitiativeScope,sessionId:string,eventId:string)=>QualifiedInitiativeEvent|undefined;
