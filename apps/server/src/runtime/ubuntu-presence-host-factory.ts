/*BEGIN_CAMERA1_HEADER*/import {UbuntuOwnedFrameBinding} from './ubuntu-presence-native-frame5.mjs';
export type UbuntuNativeFrameSource={revision:number;broker:import('./production-camera-binding.ts').CameraResourceBroker;capture:(input:Readonly<{resourceId:string;leaseId:string;fencingToken:string;purpose:'identityEnrollment'|'persistentPresence';expiresAt:number}>,signal:AbortSignal)=>Promise<{bytes:Uint8Array;capturedMonotonicMs:number}>};
const nativeUbuntuFrameOwners=new WeakMap<object,any>();
export function readNativeUbuntuFrameOwner(value:unknown):any|null{
 if(!value||typeof value!=='object')return null;const owner=nativeUbuntuFrameOwners.get(value);if(!owner)return null;
 try{const d=Object.getOwnPropertyDescriptors(owner.source);return Object.getPrototypeOf(value)===UbuntuPresenceHost.prototype&&owner.host===value&&owner.configuration.nativeFrameSource===owner.source&&owner.configuration.composition===owner.clockOwner&&owner.clockOwner.now===owner.utcSource&&owner.clockOwner.monotonicMs===owner.monotonicSource&&owner.clockOwner.broker===owner.broker&&Object.keys(d).sort().join('|')==='broker|capture|revision'&&d.broker?.value===owner.broker&&d.capture?.value===owner.capture&&d.revision?.value===owner.sourceRevision&&(value as any).composition===owner.composition&&(value as any).frameChannels===owner.channels&&!((value as any).closed)&&Object.getOwnPropertyDescriptor(UbuntuPresenceHost.prototype,'nativeFrameSnapshot')?.value===nativeOriginalSnapshot&&Object.getOwnPropertyDescriptor(UbuntuPresenceHost.prototype,'submitFrame')?.value===nativeOriginalSubmit?owner:null;}catch{return null;}
}
/*END_CAMERA1_HEADER*/import {canonicalHostEpoch,canonicalAvailabilityCustody,assembleCanonicalPresenceOwners} from './canonical-presence-owners.ts';
import {capturePresenceTerminalCustody,matchesPresenceTerminalCustody,type PresenceTerminalCustodyOwners} from './presence-terminal-custody.ts';
import {createHash,randomBytes} from 'node:crypto';
import {UbuntuPresenceFrameChannel,type PresenceChannelOffer,type PresenceFrameMetadata} from './ubuntu-presence-frame-channel.ts';
import type {Database} from '@lifestream/storage-sqlite';
import type {LocalAuthentication,LocalContext} from '../auth/local-auth.ts';
import {AudienceCoordinator} from './audience.ts';
import type {PresenceBinding,PresenceAvailabilityPort,PresenceAvailabilitySelection,QualifiedPresenceAvailability} from './qualified-presence-source.ts';
import {readSessionEndpoint} from './session-context.ts';
import {CameraPresenceLifecycle,type CameraPresenceRefresh} from './camera-presence-lifecycle.ts';
import {UbuntuPresenceComposition,type UbuntuPresenceOptions,type UbuntuPresenceGrant,type UbuntuPresenceFrame} from './ubuntu-presence-composition.ts';
import {UbuntuPresenceRetention,type UbuntuRetentionOptions,type UbuntuRetentionAssociation} from './ubuntu-presence-retention.ts';
import type {CameraResourceLease,ProductionCameraPorts} from './production-camera-binding.ts';

type Destination=Parameters<import('./initiative-host.ts').InitiativeHost['receiveQualified']>[1];
export type UbuntuPresenceHostConfiguration={
 revision:number;sourceId:string;/*BEGIN_CAMERA1_OPTION*/
 /** Operator-owned Ubuntu producer only; absence never configures capture. */nativeFrameSource?:UbuntuNativeFrameSource;/*END_CAMERA1_OPTION*/
 composition:Omit<UbuntuPresenceOptions,'authentication'>;
 retention:Omit<UbuntuRetentionOptions,'authentication'|'enrollment'|'fence'>;
 /** Configured host records, including original expired/revoked association for
  * deletion. Never browser descriptors or effective-subject impersonation. */
 association:(context:LocalContext)=>UbuntuRetentionAssociation|null;
 current:(context:LocalContext)=>boolean;
 destination:()=>Destination|null;
 camera?:ProductionCameraPorts;
 /** Affirmative configured availability; absence never synthesizes a check-in. */
 availability?:PresenceAvailabilityPort;
 /** Explicit deployment enablement, independent of request bodies. */
 internalActions?:{enrollment?:boolean;observation?:boolean};
 setupActions?:{stop?:boolean;revoke?:boolean};
 /** Independently configured, read-only owner facts. Request intent cannot
  * supply authority, device mapping, key/retention/model readiness or coverage. */
 browserSetup?:{deploymentRevision:number;read:(context:LocalContext)=>UbuntuPresenceSetupFacts|null;current:(context:LocalContext,facts:UbuntuPresenceSetupFacts)=>boolean};
};
export type UbuntuPresenceHostPorts={database:Database;authentication:LocalAuthentication;audience:AudienceCoordinator;configuration:UbuntuPresenceHostConfiguration;current:()=>boolean};
export type UbuntuPresenceStatus={version:1;state:'unavailable'|'inactive'|'observationReserved';configurationRevision:number|null;device:'AnkerWork B600 Video Bar';captureActive:boolean;physicalCapture:'notStarted';permission:'unknown'|'denied'|'granted';observationActive:boolean;retentionPolicy:'unavailable'|'configured';enrollment:'notInspected';recognition:'notActivated'|'prepared';capabilities:{prepare:false;confirm:false;sample:false;commit:false;start:false;stop:boolean;revoke:boolean}};
export type UbuntuPresenceSetupFacts={reviewRevision:number;retentionExpiresAt:number;sourceBindingRevision:number;sourceBindingToken:string;permission:'unknown'|'denied'|'granted';sourceReady:boolean;keyReady:boolean;modelReady:boolean;retentionReady:boolean;enrollmentAllowed:boolean;observationAllowed:boolean};
export type UbuntuPresenceSetup={version:1;state:'unavailable'|'reviewable';configurationRevision:number|null;reviewRevision:number|null;device:'AnkerWork B600 Video Bar';permission:'unknown'|'denied'|'granted';source:'available'|'unavailable';key:'available'|'unavailable';model:'available'|'unavailable';templateStorage:'serverPrivateEncrypted';retentionExpiresAt:string|null;framePolicy:'transientServerProcessing';physicalProvenance:'unverified';templateLimit:1;frameMaxBytes:2097152;frameLifetimeMs:5000;observationLeaseMaxMs:60000;capabilities:{captureAndSave:boolean;startObservation:boolean}};
type ActionBase={expectedRevision:number;reviewRevision:number;idempotencyKey:string};
export type UbuntuPresenceSetupAction=ActionBase&(
 {operation:'captureAndSave';enrollmentConsent:true;recognitionConsent:boolean;confirmCaptureAndSave:true}|
 {operation:'startObservation';recognitionConsent:true}|
 {operation:'nextFrame'|'renewObservation';observationId:string}|
 {operation:'bindClock';channelId:string;challengeId:string;endpointClockId:string;endpointReceivedMonotonicMs:number}/*BEGIN_CAMERA1_ACTION*/|{operation:'captureNativeFrame';channelId:string}/*END_CAMERA1_ACTION*/);
export type UbuntuPresenceSetupResult={version:1;state:'unavailable'|'frameRequired'|'observationReserved'|'clockBound'|'renewed'/*BEGIN_CAMERA1_STATE*/|'nativeFrameCompleted'/*END_CAMERA1_STATE*/;configurationRevision:number;reviewRevision:number;/*BEGIN_CAMERA1_FRAME_TYPE*/frame?:UbuntuPresenceFrameResult;/*END_CAMERA1_FRAME_TYPE*/channel?:PresenceChannelOffer;observationId?:string;sourceBinding?:{revision:number;token:string}};
export type UbuntuPresenceFrameResult={version:1;state:'stored'|'supported'|'uncertain'|'incomplete'|'unavailable';configurationRevision:number};
const unavailableSetup=():UbuntuPresenceSetup=>({version:1,state:'unavailable',configurationRevision:null,reviewRevision:null,device:'AnkerWork B600 Video Bar',permission:'unknown',source:'unavailable',key:'unavailable',model:'unavailable',templateStorage:'serverPrivateEncrypted',retentionExpiresAt:null,framePolicy:'transientServerProcessing',physicalProvenance:'unverified',templateLimit:1,frameMaxBytes:2097152,frameLifetimeMs:5000,observationLeaseMaxMs:60000,capabilities:{captureAndSave:false,startObservation:false}});
const opaque=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function validUbuntuSetupAction(value:unknown):value is UbuntuPresenceSetupAction{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const v=value as Record<string,unknown>,extra=/*BEGIN_CAMERA1_VALID_EXTRA*/v.operation==='captureNativeFrame'?['channelId']:/*END_CAMERA1_VALID_EXTRA*/v.operation==='captureAndSave'?['enrollmentConsent','recognitionConsent','confirmCaptureAndSave']:v.operation==='startObservation'?['recognitionConsent']:v.operation==='nextFrame'||v.operation==='renewObservation'?['observationId']:v.operation==='bindClock'?['channelId','challengeId','endpointClockId','endpointReceivedMonotonicMs']:null;
 if(!extra||Object.keys(v).sort().join('|')!==['operation','expectedRevision','reviewRevision','idempotencyKey',...extra].sort().join('|')||![v.expectedRevision,v.reviewRevision].every(x=>Number.isSafeInteger(x)&&Number(x)>0)||typeof v.idempotencyKey!=='string'||!/^[-a-zA-Z0-9_]{16,80}$/.test(v.idempotencyKey))return false;
 return /*BEGIN_CAMERA1_VALID_FRAME*/v.operation==='captureNativeFrame'?opaque(v.channelId):/*END_CAMERA1_VALID_FRAME*/v.operation==='captureAndSave'?v.enrollmentConsent===true&&v.confirmCaptureAndSave===true&&typeof v.recognitionConsent==='boolean':v.operation==='startObservation'?v.recognitionConsent===true:v.operation==='bindClock'?[v.channelId,v.challengeId,v.endpointClockId].every(opaque)&&Number.isFinite(v.endpointReceivedMonotonicMs)&&Number(v.endpointReceivedMonotonicMs)>=0:opaque(v.observationId);
}
export type UbuntuPresenceCommand={operation:'stop'|'revoke';expectedRevision:number;idempotencyKey:string};
export type UbuntuPresenceCommandResult={state:'stopped'|'deleted'|'pending'|'incomplete'|'unavailable';configurationRevision:number};
export class UbuntuPresenceHostError extends Error{readonly status:number;readonly code:string;constructor(status:number,code:string){super(code);this.status=status;this.code=code;}}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const canonical=(v:unknown):string=>v&&typeof v==='object'&&!Array.isArray(v)?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`:JSON.stringify(v);
const key=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const binding=(g:UbuntuPresenceGrant):UbuntuRetentionAssociation=>{const {purpose,sessionId,captureLeaseId,captureFence,authorityExpiresAt,...a}=g;return a;};
const unavailable=():UbuntuPresenceStatus=>({version:1,state:'unavailable',configurationRevision:null,device:'AnkerWork B600 Video Bar',captureActive:false,physicalCapture:'notStarted',permission:'unknown',observationActive:false,retentionPolicy:'unavailable',enrollment:'notInspected',recognition:'notActivated',capabilities:{prepare:false,confirm:false,sample:false,commit:false,start:false,stop:false,revoke:false}});
type Captured={sessionId:string;association:UbuntuRetentionAssociation};
type Cached={contextKey:string;requestKey:string;startedAt:number;startedMono:number;promise:Promise<UbuntuPresenceCommandResult>};

/** Inactive production preparation. No constructor grants, directories, keys,
 * worker, capture, permission prompt or pump timer. Physical ingress is absent. */
export class UbuntuPresenceHost {
 readonly composition:UbuntuPresenceComposition;
 readonly retention:UbuntuPresenceRetention;
 readonly lifecycle:CameraPresenceLifecycle;
 readonly #custody=canonicalHostEpoch(this);
 private readonly configuration:UbuntuPresenceHostConfiguration;
 private readonly configurationKey:string;
 private readonly availabilityOwner:PresenceAvailabilityPort|undefined;private readonly availabilityValues:readonly unknown[]|undefined;
 private readonly availabilityOwners:PresenceTerminalCustodyOwners|undefined;
 private readonly observations=new Map<object,Captured>();
 private latestObservation:object|undefined;
 private readonly enrollments=new Map<object,string>();
 private readonly requests=new Map<string,Cached>();
 private readonly frameChannels:UbuntuPresenceFrameChannel;/*BEGIN_CAMERA1_FIELDS*/
 private readonly nativeFrameBinding:UbuntuOwnedFrameBinding|undefined;private readonly nativeOffers=new Map<string,PresenceChannelOffer>();/*END_CAMERA1_FIELDS*/
 private readonly webObservations=new Map<string,{handle:object;context:LocalContext;reviewRevision:number}>();
 private readonly webChannels=new Map<string,{context:LocalContext;factsKey:string;grantKey:string}>();
 private readonly webRequests=new Map<string,{requestKey:string;contextKey:string;utc:number;mono:number;settled:boolean;promise:Promise<UbuntuPresenceSetupResult>}>();
 private readonly leases=new Map<string,{lease:CameraResourceLease;sessionId:string}>();private acquiringSession:string|undefined;
 private closed=false;private pumping=0;private withdrawing=false;
 private published:{associationKey:string;identity:{principalId:string;sessionId:string;endpointId:string};sourceId:string|null;evidenceRef:string|null;revision:number}|undefined;
 private readonly ports:UbuntuPresenceHostPorts;
 constructor(ports:UbuntuPresenceHostPorts){
  this.ports=ports;const c=this.configuration=ports.configuration;this.configurationKey=this.configKey();
  try{const d=Object.getOwnPropertyDescriptor(c,'availability'),a=d&&Object.hasOwn(d,'value')?d.value as PresenceAvailabilityPort:undefined;if(a&&canonicalAvailabilityCustody(a)){const fields=Object.getOwnPropertyDescriptors(a);if(['revision','read','current','signal'].every(k=>Object.hasOwn(fields[k]??{},'value'))){this.availabilityOwner=a;this.availabilityValues=[fields.revision!.value,fields.read!.value,fields.current!.value,fields.signal!.value];}}}catch{/* Missing actual canonical owner remains unavailable. */}
  this.retention=new UbuntuPresenceRetention({...c.retention,authentication:ports.authentication,enrollment:c.composition.enrollment,fence:a=>this.fenceAssociation(a)});
  const original=c.composition;
  const broker:UbuntuPresenceOptions['broker']={resource:id=>original.broker.resource(id),lease:id=>original.broker.lease(id),assertLease:(lease,fence)=>original.broker.assertLease(lease,fence),acquireLease:input=>{const sessionId=this.acquiringSession;if(sessionId&&this.leases.size>=8)throw new UbuntuPresenceHostError(503,'camera_presence_lease_capacity');const lease=original.broker.acquireLease(input);if(sessionId)this.set(this.leases,lease.leaseId,{lease:structuredClone(lease),sessionId});return lease;},releaseLease:input=>{const captured=this.leases.get(input.leaseId);original.broker.releaseLease(input);if(captured?.lease.fencingToken===input.fencingToken&&this.leases.get(input.leaseId)===captured)this.delete(this.leases,input.leaseId);},renewLease:input=>{const captured=this.leases.get(input.leaseId),lease=original.broker.renewLease(input);if(captured&&lease.fencingToken===captured.lease.fencingToken&&this.leases.get(input.leaseId)===captured){const next=structuredClone(lease);this.#custody.invalidate();captured.lease=next;}return lease;}};
  const selection:UbuntuPresenceOptions['selection']=(context,purpose)=>{if(!this.authorized(context))return null;const s=original.selection(context,purpose);if(!s||s.actorId!==context.principalId||s.binding.scope.userId!==context.principalId)return null;
   if(purpose==='persistentPresence'){const a=c.association(context);if(!a||!this.retention.eligible(context.sessionId,a)||!this.sameSelection(a,s))return null;}return this.authorized(context)?s:null;
  };
  // Actual enrollment owners keep methods on their prototype. Preserve the
  // original own-method legacy ports, and bind only absent own methods to the
  // captured original class object before installing the retention wrapper.
  const inheritedEnrollment:Partial<UbuntuPresenceOptions['enrollment']>={};
  for(const name of ['confirmPurpose','load','revoke'] as const)if(!Object.hasOwn(original.enrollment,name)){
   const method=original.enrollment[name];Object.defineProperty(inheritedEnrollment,name,{value:method.bind(original.enrollment),enumerable:true});
  }
  this.composition=new UbuntuPresenceComposition({...original,broker,authentication:ports.authentication,selection,frameCurrent:(frame,g)=>{
   const accepted=original.frameCurrent(frame,g)===true;
   return accepted&&(!this.frameChannels.owns(frame)||this.webGrantCurrent(g)&&this.frameChannels.current(frame,g));
  },enrollment:{...original.enrollment,...inheritedEnrollment,enroll:async(g,features,confirmation,current)=>{
   if(!this.retention.canRecord(g,current))return {status:'unavailable'};
   const result=await original.enrollment.enroll(g,features,confirmation,current);
   if(!result||typeof result!=='object'||(result as {status?:unknown}).status!=='stored')return result;
   if(this.retention.recordStored(g,result,current))return result;
   // A stored-but-untracked enrollment is never accepted. Exact independently
   // current removal owner must fence/delete it; a missing owner stays honest.
   await this.cleanupUntracked(g);return {status:'incomplete'};
  }}});
  this.frameChannels=new UbuntuPresenceFrameChannel({authentication:ports.authentication,capture:h=>this.composition.operationCapture(h),release:h=>this.release(h),frameCurrent:(f,g)=>original.frameCurrent(f,g)===true&&this.webGrantCurrent(g),...(original.now?{now:original.now}:{}),...(original.monotonicMs?{monotonicMs:original.monotonicMs}:{})});
  this.availabilityOwners=assembleCanonicalPresenceOwners(this,ports.database,ports.authentication,this.composition.producer,this.retention,original.broker,original.enrollment,this.availabilityOwner)??undefined;
  const camera=c.camera??{broker:original.broker,selection:()=>null,scopeCurrent:()=>false,hostLeaseCurrent:()=>false};
  const {availability:_legacyAvailability,...presence}=this.composition.producer.presencePorts();
  this.lifecycle=new CameraPresenceLifecycle({database:ports.database,audience:ports.audience,sourceId:c.sourceId,camera,presence,destination:()=>this.validConfiguration()?c.destination():null,...(this.availabilityOwner&&this.availabilityOwners?{availability:this.availabilityPorts()}:{}),...(original.now?{now:original.now}:{})});/*BEGIN_CAMERA1_REGISTER*/
  const source=c.nativeFrameSource;
  if(source&&process.platform==='linux'&&Object.getPrototypeOf(this)===UbuntuPresenceHost.prototype){
   const d=Object.getOwnPropertyDescriptors(source);
   if(Object.keys(d).sort().join('|')==='broker|capture|revision'&&d.broker?.value===original.broker&&typeof d.capture?.value==='function'&&Number.isSafeInteger(d.revision?.value)&&(d.revision.value as number)>0){
    const owner=Object.freeze({host:this,configuration:c,clockOwner:original,utcSource:original.now,monotonicSource:original.monotonicMs,source,sourceRevision:d.revision.value,broker:original.broker,capture:d.capture.value,composition:this.composition,channels:this.frameChannels,
     clock:original.monotonicMs??(()=>performance.now()),snapshot:nativeOriginalSnapshot.bind(this),submit:nativeOriginalSubmit.bind(this),
     bind:(context:LocalContext,reply:Parameters<UbuntuPresenceFrameChannel['bind']>[1])=>this.frameChannels.bind(context,reply),
     final:(context:LocalContext,snapshot:any)=>{const f=this.setupFacts(context);return !!f&&key(f)===snapshot.factsKey&&this.originalContext(context)&&this.authorized(context)&&readNativeUbuntuFrameOwner(this)===owner;},
     release:(context:LocalContext,channelId:string,snapshot:any)=>{const row=this.webChannels.get(channelId);if(row&&row.grantKey===key(snapshot.capture.grant)&&row.factsKey===snapshot.factsKey&&key(row.context)===key(context)){this.delete(this.webChannels,channelId);this.delete(this.nativeOffers,channelId);this.frameChannels.close(channelId);}}});
    nativeUbuntuFrameOwners.set(this,owner);this.nativeFrameBinding=new UbuntuOwnedFrameBinding(this);
   }
  }
/*END_CAMERA1_REGISTER*/
 }
/*BEGIN_CAMERA1_METHODS*/
 private nativeFrameSnapshot(context:LocalContext,channelId:string):any|null{
  try{const owner=readNativeUbuntuFrameOwner(this),f=this.setupFacts(context),row=this.webChannels.get(channelId),offer=this.nativeOffers.get(channelId);
   if(!owner||!f||!row||!offer||key(row.context)!==key(context)||row.factsKey!==key(f)||!this.authorized(context))return null;
   const handle=this.frameChannels.handle(context,channelId),capture=handle&&this.composition.operationCapture(handle);
   if(!capture||row.grantKey!==key(capture.grant)||capture.grant.actorId!==context.principalId||capture.grant.sessionId!==context.sessionId||capture.lease.resourceId!==capture.grant.resourceId||capture.lease.leaseId!==capture.grant.captureLeaseId||capture.lease.fencingToken!==capture.grant.captureFence)return null;
   if(readNativeUbuntuFrameOwner(this)!==owner||!this.reviewCurrent(context,f)||!this.originalContext(context))return null;
   return {capture:structuredClone(capture),challenge:structuredClone(offer.challenge),configurationRevision:this.configuration.revision,reviewRevision:f.reviewRevision,factsKey:row.factsKey};
  }catch{return null;}
 }
 cancelNativeFrame(context:LocalContext,channelId:string):void{this.nativeFrameBinding?.cancel(context,channelId);}
/*END_CAMERA1_METHODS*/ private set<K,V>(map:Map<K,V>,key:K,value:V):void{this.#custody.invalidate();map.set(key,value);}
 private delete<K,V>(map:Map<K,V>,key:K):boolean{if(!map.has(key))return false;this.#custody.invalidate();return map.delete(key);}
 private clear<K,V>(map:Map<K,V>):void{if(!map.size)return;this.#custody.invalidate();map.clear();}
 /** Same entry ticket, no original owner/clock/current callback in this closure. */
 terminalGuard():()=>boolean{const owners=this.availabilityOwners,ticket=owners&&capturePresenceTerminalCustody(owners);return ()=>!!owners&&!!ticket&&matchesPresenceTerminalCustody(ticket,owners);}
 private availabilityStable():boolean{
  try{const a=this.availabilityOwner,d=Object.getOwnPropertyDescriptor(this.configuration,'availability');if(!a||!d||!Object.hasOwn(d,'value')||d.value!==a)return false;
   const fields=Object.getOwnPropertyDescriptors(a);return ['revision','read','current','signal'].every((k,i)=>Object.hasOwn(fields[k]??{},'value')&&fields[k]!.value===this.availabilityValues?.[i])&&!!this.availabilityOwners&&a.signal.aborted===false;
  }catch{return false;}
 }
 private availabilitySelection(b:PresenceBinding,c:{configurationId:string;revision:number}):PresenceAvailabilitySelection|null{
  try{
   if(!this.availabilityStable())return null;const context=this.ports.authentication.hostSessionContext(b.sessionId);
   if(context.principalId!==b.scope.userId||!this.authorized(context))return null;
   const p=this.composition.producer.presencePorts(),actual=p.binding(),association=this.configuration.association(structuredClone(context));
   if(!actual||key(actual)!==key(b)||p.current(structuredClone(b))!==true||!association||this.currentAssociationKey(b)!==key(association)||!this.retention.eligible(b.sessionId,association))return null;
   const owner=this.configuration.composition.owner(structuredClone(b.scope)),config=owner?.configuration,endpoint=readSessionEndpoint(this.ports.database,b.sessionId);
   if(owner?.consentCurrent!==true||key(owner.scope)!==key(b.scope)||config?.configurationId!==c.configurationId||config?.revision!==c.revision||config.lifecycle!=='active'||!endpoint.endpoint||endpoint.endpoint.endpointId!==b.endpointId||!Number.isSafeInteger(endpoint.revision)||endpoint.revision<1||!this.ports.database.connection.prepare('SELECT 1 FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').get(context.principalId,b.endpointId))return null;
   // Callbacks above cannot certify their own late revocation. Retention is tied
   // to the same captured observation association and actual authenticated actor.
   const latest=this.latestObservation&&this.observations.get(this.latestObservation);
   if(!this.availabilityStable()||!this.authorized(context)||!this.originalContext(context)||key(p.binding())!==key(b)||p.current(structuredClone(b))!==true||!this.retention.eligible(b.sessionId,association)||this.currentAssociationKey(b)!==key(association)||!latest||latest.sessionId!==b.sessionId||key(latest.association)!==key(association)||!this.availabilityStable()||!this.originalContext(context))return null;
   const final=readSessionEndpoint(this.ports.database,b.sessionId);if(final.revision!==endpoint.revision||final.endpoint?.endpointId!==b.endpointId||!this.availabilityStable()||!this.originalContext(context))return null;
   return {binding:structuredClone(b),initiativeConfigurationId:c.configurationId,initiativeConfigurationRevision:c.revision,sessionRevision:endpoint.revision};
  }catch{return null;}
 }
 private availabilityPorts():QualifiedPresenceAvailability{
  const a=this.availabilityOwner!;return {terminalCustody:this.availabilityOwners!,revision:a.revision,signal:a.signal,selection:(b,c)=>this.availabilitySelection(b,c),read:s=>{
   const current=this.availabilitySelection(s.binding,{configurationId:s.initiativeConfigurationId,revision:s.initiativeConfigurationRevision});if(!current||key(current)!==key(s))return null;
   const result=a.read(structuredClone(s)),after=this.availabilitySelection(s.binding,{configurationId:s.initiativeConfigurationId,revision:s.initiativeConfigurationRevision});return after&&key(after)===key(s)?result:null;
  },current:(s,w)=>{
   const before=this.availabilitySelection(s.binding,{configurationId:s.initiativeConfigurationId,revision:s.initiativeConfigurationRevision});if(!before||key(before)!==key(s)||a.current(structuredClone(s),structuredClone(w))!==true)return false;
   const after=this.availabilitySelection(s.binding,{configurationId:s.initiativeConfigurationId,revision:s.initiativeConfigurationRevision});return !!after&&key(after)===key(s);
  }};
 }
 private configKey(){const c=this.configuration;return digest([c.revision,c.sourceId,c.internalActions,c.setupActions,c.composition.execution,c.composition.observation,c.browserSetup?.deploymentRevision]);}
 private validConfiguration():boolean{try{return !this.closed&&this.ports.current()===true&&this.configKey()===this.configurationKey;}catch{return false;}}
 private originalContext(context:LocalContext):boolean{try{if(this.closed)return false;this.ports.authentication.assertCurrent(context,false);const fresh=this.ports.authentication.hostSessionContext(context.sessionId);return fresh.principalId===context.principalId&&key(fresh)===key(context);}catch{return false;}}
 private authorized(context:LocalContext):boolean{
  try{return this.validConfiguration()&&this.originalContext(context)&&this.configuration.current(structuredClone(context))===true&&this.validConfiguration()&&this.originalContext(context);}catch{return false;}
 }
 private sameSelection(a:UbuntuRetentionAssociation,s:NonNullable<ReturnType<UbuntuPresenceOptions['selection']>>):boolean{
  const b=s.binding,e=this.configuration.composition.execution.model;
  return key(a)===key({actorId:s.actorId,endpointId:b.endpointId,resourceId:b.resourceId,siteRef:b.siteRef,zoneRef:b.zoneRef,enrollmentRef:b.enrollmentRef,enrollmentRevision:b.enrollmentRevision,consentRevision:s.consentRevision,registrationRevision:s.registrationRevision,modelRevision:e.modelRevision,calibrationRevision:e.calibration.revision,expiresAt:s.retentionExpiresAt});
 }
 private async cleanupUntracked(g:UbuntuPresenceGrant):Promise<void>{
  try{const a=binding(g),context=this.ports.authentication.hostSessionContext(g.sessionId);if(!this.authorized(context)||context.principalId!==a.actorId)return;
   const startUtc=(this.configuration.composition.now??Date.now)(),startMono=(this.configuration.composition.monotonicMs??(()=>performance.now()))(),auth=this.configuration.retention.authorizeRemoval(context,a);
   if(!auth||auth.mode!=='removalOnly'||key(binding(auth.grant))!==key(a)||auth.grant.sessionId!==context.sessionId||auth.grant.purpose!=='identityEnrollment'||!Number.isFinite(auth.grant.authorityExpiresAt)||auth.grant.authorityExpiresAt<=startUtc||auth.grant.authorityExpiresAt>startUtc+5000)return;
   const grant=structuredClone(auth.grant),until=startMono+grant.authorityExpiresAt-startUtc;
   const current=()=>{try{if(!this.authorized(context)||auth.current()!==true||!this.validConfiguration()||!this.originalContext(context))return false;const utc=(this.configuration.composition.now??Date.now)(),mono=(this.configuration.composition.monotonicMs??(()=>performance.now()))();return utc>=startUtc&&mono>=startMono&&utc<grant.authorityExpiresAt&&mono<until;}catch{return false;}};
   if(current())await this.configuration.composition.enrollment.revoke(structuredClone(grant),current);
  }catch{/* Original owner remains responsible for exact durable fence. */}
 }
 private webGrantCurrent(grant:UbuntuPresenceGrant):boolean{const row=[...this.webChannels.values()].find(r=>r.grantKey===key(grant));if(!row)return false;const facts=this.setupFacts(row.context);return !!facts&&key(facts)===row.factsKey&&this.originalContext(row.context);}
 private offer(context:LocalContext,handle:object,facts:UbuntuPresenceSetupFacts):PresenceChannelOffer|null{
  const capture=this.composition.operationCapture(handle);if(!capture)return null;const channel=this.frameChannels.open(context,handle);if(!channel)return null;if(!this.reviewCurrent(context,facts)){this.frameChannels.close(channel.channelId);return null;}
  this.set(this.webChannels,channel.channelId,{context:structuredClone(context),factsKey:key(facts),grantKey:key(capture.grant)});/*BEGIN_CAMERA1_OFFER*/if(this.nativeFrameBinding)this.set(this.nativeOffers,channel.channelId,structuredClone(channel));/*END_CAMERA1_OFFER*/return channel;
 }
 private setupFacts(context:LocalContext):UbuntuPresenceSetupFacts|null{
  const owner=this.configuration.browserSetup;if(!owner||!this.authorized(context))return null;
  try{const startUtc=(this.configuration.composition.now??Date.now)(),startMono=(this.configuration.composition.monotonicMs??(()=>performance.now()))(),raw=owner.read(structuredClone(context));if(!raw)return null;const facts=structuredClone(raw);
   if(Object.keys(facts).sort().join('|')!==['reviewRevision','retentionExpiresAt','sourceBindingRevision','sourceBindingToken','permission','sourceReady','keyReady','modelReady','retentionReady','enrollmentAllowed','observationAllowed'].sort().join('|')||![facts.reviewRevision,facts.sourceBindingRevision,owner.deploymentRevision].every(x=>Number.isSafeInteger(x)&&x>0)||!opaque(facts.sourceBindingToken)||!['unknown','denied','granted'].includes(facts.permission)||![facts.sourceReady,facts.keyReady,facts.modelReady,facts.retentionReady,facts.enrollmentAllowed,facts.observationAllowed].every(x=>typeof x==='boolean')||!Number.isFinite(facts.retentionExpiresAt)||!Number.isFinite(new Date(facts.retentionExpiresAt).getTime())||facts.retentionExpiresAt<=startUtc)return null;
   if(owner.current(structuredClone(context),structuredClone(facts))!==true||this.configuration.browserSetup!==owner||!this.authorized(context))return null;
   const endUtc=(this.configuration.composition.now??Date.now)(),endMono=(this.configuration.composition.monotonicMs??(()=>performance.now()))();return endUtc>=startUtc&&endMono>=startMono&&endUtc<Math.min(facts.retentionExpiresAt,startUtc+5000)&&endMono<startMono+5000&&this.originalContext(context)&&this.configuration.browserSetup===owner?facts:null;
  }catch{return null;}
 }
 private reviewCurrent(context:LocalContext,facts:UbuntuPresenceSetupFacts):boolean{const actual=this.setupFacts(context);return !!actual&&key(actual)===key(facts)&&this.originalContext(context);}
 setup(context:LocalContext):UbuntuPresenceSetup{
  const f=this.setupFacts(context);if(!f)return unavailableSetup();const ready=f.permission==='granted'&&f.sourceReady&&f.keyReady&&f.modelReady&&f.retentionReady/*BEGIN_CAMERA1_READY*/&&!!this.nativeFrameBinding&&!!readNativeUbuntuFrameOwner(this)/*END_CAMERA1_READY*/;
  return {...unavailableSetup(),state:'reviewable',configurationRevision:this.configuration.revision,reviewRevision:f.reviewRevision,permission:f.permission,source:f.sourceReady?'available':'unavailable',key:f.keyReady?'available':'unavailable',model:f.modelReady?'available':'unavailable',retentionExpiresAt:new Date(f.retentionExpiresAt).toISOString(),capabilities:{captureAndSave:ready&&f.enrollmentAllowed&&this.configuration.internalActions?.enrollment===true,startObservation:ready&&f.observationAllowed&&this.configuration.internalActions?.observation===true}};
 }
 setupOperation(context:LocalContext,body:UbuntuPresenceSetupAction):Promise<UbuntuPresenceSetupResult>{
  if(!validUbuntuSetupAction(body))throw new UbuntuPresenceHostError(422,'camera_presence_invalid_setup');const request=structuredClone(body),captured=structuredClone(context),f=this.setupFacts(captured);
  if(!f||!f.sourceReady||!f.keyReady||!f.modelReady||!f.retentionReady||f.permission!=='granted')throw new UbuntuPresenceHostError(503,'camera_presence_setup_unavailable');
  if(request.expectedRevision!==this.configuration.revision||request.reviewRevision!==f.reviewRevision)throw new UbuntuPresenceHostError(409,'camera_presence_review_changed');
  const id=key([captured.principalId,captured.sessionId,request.idempotencyKey]),requestKey=key(request),contextKey=key(captured),utc=(this.configuration.composition.now??Date.now)(),mono=(this.configuration.composition.monotonicMs??(()=>performance.now()))();
  if(!this.originalContext(captured))throw new UbuntuPresenceHostError(403,'camera_presence_scope_unavailable');
  // Keep unresolved exact operations, and every <5s idempotency record. Only
  // settled expired records may release capacity on this explicit request.
  if(![utc,mono].every(Number.isFinite))throw new UbuntuPresenceHostError(503,'camera_presence_clock_unavailable');
  for(const [priorId,row]of [...this.webRequests])if(row.settled&&utc>=row.utc&&mono>=row.mono&&(utc>=row.utc+5000||mono>=row.mono+5000)&&this.webRequests.get(priorId)===row)this.webRequests.delete(priorId);
  this.frameChannels.retireExpired();for(const [channelId]of [...this.webChannels])if(!this.frameChannels.has(channelId)){/*BEGIN_CAMERA1_PRUNE*/this.delete(this.nativeOffers,channelId);/*END_CAMERA1_PRUNE*/this.delete(this.webChannels,channelId);}
  if(!this.originalContext(captured))throw new UbuntuPresenceHostError(403,'camera_presence_scope_unavailable');const old=this.webRequests.get(id);
  if(old){if(old.requestKey!==requestKey||old.contextKey!==contextKey||utc<old.utc||mono<old.mono||utc>=old.utc+5000||mono>=old.mono+5000)throw new UbuntuPresenceHostError(409,'camera_presence_idempotency_changed');return old.promise;}
  if(this.webRequests.size>=32)throw new UbuntuPresenceHostError(429,'camera_presence_request_capacity');
  const unavailable=():UbuntuPresenceSetupResult=>({version:1,state:'unavailable',configurationRevision:this.configuration.revision,reviewRevision:f.reviewRevision});
  const promise=Promise.resolve().then(()=>{const facts=this.setupFacts(captured);if(!facts||key(facts)!==key(f)||!this.authorized(captured))return unavailable();
   if(request.operation==='captureAndSave'){
    if(!facts.enrollmentAllowed)return unavailable();const handle=this.prepareEnrollment(captured.sessionId);if(!handle)return unavailable();
    if(!this.confirmEnrollment(handle,{enrollment:true,recognition:request.recognitionConsent})||!this.reviewCurrent(captured,facts)){this.release(handle);return unavailable();}
    const channel=this.offer(captured,handle,facts);if(!channel){this.release(handle);return unavailable();}
    if(!this.originalContext(captured)){this.frameChannels.close(channel.channelId);return unavailable();}return {...unavailable(),state:'frameRequired' as const,channel,sourceBinding:{revision:f.sourceBindingRevision,token:f.sourceBindingToken}};
   }
   if(request.operation==='startObservation'){
    if(!facts.observationAllowed||this.webObservations.size>=4)return unavailable();const handle=this.openObservation(captured.sessionId);if(!handle)return unavailable();
    if(!this.reviewCurrent(captured,facts)){this.composition.closeObservation(handle);this.delete(this.observations,handle);return unavailable();}const observationId=randomBytes(32).toString('hex');this.set(this.webObservations,observationId,{handle,context:captured,reviewRevision:f.reviewRevision});return {...unavailable(),state:'observationReserved' as const,observationId,sourceBinding:{revision:f.sourceBindingRevision,token:f.sourceBindingToken}};
   }
/*BEGIN_CAMERA1_CAPTURE_BRANCH*/   if(request.operation==='captureNativeFrame'){
    if(!this.nativeFrameBinding||!readNativeUbuntuFrameOwner(this))return unavailable();
    return this.nativeFrameBinding.capture(captured,request.channelId).then((frame:any)=>this.reviewCurrent(captured,facts)&&this.authorized(captured)?{...unavailable(),state:'nativeFrameCompleted' as const,frame}:unavailable(),()=>unavailable());
   }
/*END_CAMERA1_CAPTURE_BRANCH*/   if(request.operation==='bindClock'){const recorded=this.webChannels.get(request.channelId);if(!recorded||recorded.factsKey!==key(facts)||key(recorded.context)!==contextKey)return unavailable();const bound=this.frameChannels.bind(captured,{channelId:request.channelId,challengeId:request.challengeId,endpointClockId:request.endpointClockId,endpointReceivedMonotonicMs:request.endpointReceivedMonotonicMs});if(!bound||!this.reviewCurrent(captured,facts)){this.delete(this.webChannels,request.channelId);this.frameChannels.close(request.channelId);return unavailable();}return {...unavailable(),state:'clockBound' as const};}
   const observation=this.webObservations.get(request.observationId);if(!observation||key(observation.context)!==contextKey||observation.reviewRevision!==facts.reviewRevision||!facts.observationAllowed)return unavailable();
   if(request.operation==='renewObservation'){if(!this.renewObservation(observation.handle)||!this.reviewCurrent(captured,facts)){this.stopSession(captured.sessionId);return unavailable();}return {...unavailable(),state:'renewed' as const};}
   const handle=this.prepareObservation(observation.handle);if(!handle)return unavailable();const channel=this.offer(captured,handle,facts);if(!channel){this.release(handle);return unavailable();}if(!this.originalContext(captured)){this.frameChannels.close(channel.channelId);return unavailable();}return {...unavailable(),state:'frameRequired' as const,channel,observationId:request.observationId};
  });const row={requestKey,contextKey,utc,mono,settled:false,promise};this.webRequests.set(id,row);const settled=()=>{if(this.webRequests.get(id)===row)row.settled=true;};void promise.then(settled,settled);return promise;
 }
 async submitFrame(context:LocalContext,metadata:PresenceFrameMetadata,bytes:Uint8Array):Promise<UbuntuPresenceFrameResult>{
  const no:UbuntuPresenceFrameResult={version:1,state:'unavailable',configurationRevision:this.configuration.revision};const facts=this.setupFacts(context),recorded=this.webChannels.get(metadata.channelId);if(!facts||!recorded||key(facts)!==recorded.factsKey||key(context)!==key(recorded.context)||!this.authorized(context))return no;
  const handle=this.frameChannels.handle(context,metadata.channelId);if(!handle)return no;const capture=this.composition.operationCapture(handle);if(!capture)return no;
  const frame=this.frameChannels.accept(context,metadata,bytes);if(!frame)return no;
  try{const result=capture.grant.purpose==='identityEnrollment'?await this.enroll(handle,frame,{confirmed:true,indices:[0]}):await this.recognize(handle,frame);
   const state=result&&typeof result==='object'?(result as {status?:unknown}).status:undefined;
   if(!this.authorized(context)||!this.frameChannels.current(frame,capture.grant))return no;
   if(capture.grant.purpose==='persistentPresence'&&(state==='supported'||state==='uncertain')){await this.refresh();return this.reviewCurrent(context,facts)&&this.frameChannels.current(frame,capture.grant)?{...no,state}:no;}
   if(!this.reviewCurrent(context,facts))return no;return {...no,state:state==='stored'||state==='incomplete'?state:'unavailable'};
  }finally{/*BEGIN_CAMERA1_FRAME_CLEANUP*/this.delete(this.nativeOffers,metadata.channelId);/*END_CAMERA1_FRAME_CLEANUP*/this.delete(this.webChannels,metadata.channelId);this.frameChannels.close(metadata.channelId);}
 }
 status(context:LocalContext):UbuntuPresenceStatus{
  if(!this.authorized(context))return unavailable();let permission:UbuntuPresenceStatus['permission']='unknown';
  try{const s=this.configuration.composition.selection(context,'identityEnrollment');if(s?.actorId===context.principalId&&s.deviceName==='AnkerWork B600 Video Bar'){const p=this.configuration.composition.broker.resource(s.binding.resourceId).permissionStatus;if(['unknown','denied','granted'].includes(p))permission=p as typeof permission;}}catch{}
  if(!this.authorized(context))return unavailable();let captureActive=false;for(const held of this.leases.values())if(held.sessionId===context.sessionId){try{const lease=this.configuration.composition.broker.lease(held.lease.leaseId);this.configuration.composition.broker.assertLease(lease,held.lease.fencingToken);if(key(lease)===key(held.lease)&&lease.status==='active')captureActive=true;}catch{}}if(!this.authorized(context))return unavailable();const observationActive=captureActive&&[...this.observations.values()].some(o=>o.sessionId===context.sessionId);return {...unavailable(),state:observationActive?'observationReserved':'inactive',configurationRevision:this.configuration.revision,permission,captureActive,physicalCapture:'notStarted',observationActive,recognition:observationActive?'prepared':'notActivated',retentionPolicy:'configured',capabilities:{...unavailable().capabilities,stop:this.configuration.setupActions?.stop===true,revoke:this.configuration.setupActions?.revoke===true}};
 }
 /** Internal already-admitted frame composition only; not a route/permission API. */
 prepareEnrollment(sessionId:string):object|null{if(this.configuration.internalActions?.enrollment!==true||!this.validConfiguration()||this.enrollments.size>=8)return null;const previous=this.acquiringSession;this.acquiringSession=sessionId;try{const handle=this.composition.prepare(sessionId,'identityEnrollment');if(handle)this.set(this.enrollments,handle,sessionId);return handle;}finally{this.acquiringSession=previous;}}
 confirmEnrollment(handle:object,consent:{enrollment:true;recognition:boolean}):boolean{return this.configuration.internalActions?.enrollment===true&&this.validConfiguration()&&this.composition.confirmPurpose(handle,consent);}
 enroll(handle:object,frame:UbuntuPresenceFrame,confirmation:{confirmed:true;indices:number[]}):Promise<unknown>{return this.configuration.internalActions?.enrollment===true&&this.validConfiguration()?this.composition.enroll(handle,frame,confirmation):Promise.resolve(null);}
 release(handle:object):void{this.delete(this.enrollments,handle);this.composition.release(handle);}
 openObservation(sessionId:string):object|null{
  if(!this.validConfiguration()||this.configuration.internalActions?.observation!==true)return null;try{const c=this.ports.authentication.hostSessionContext(sessionId),a=this.configuration.association(c);if(!this.authorized(c)||!a||a.actorId!==c.principalId||!this.retention.eligible(sessionId,a))return null;
   const previous=this.acquiringSession;this.acquiringSession=sessionId;let h:object|null;try{h=this.composition.openObservation(sessionId);}finally{this.acquiringSession=previous;}if(!h)return null;if(!this.authorized(c)){this.composition.closeObservation(h);return null;}this.set(this.observations,h,{sessionId,association:structuredClone(a)});this.latestObservation=h;return h;
  }catch{return null;}
 }
 prepareObservation(handle:object):object|null{return this.validConfiguration()&&this.observations.has(handle)?this.composition.prepareObservation(handle):null;}
 recognize(handle:object,frame:UbuntuPresenceFrame){return this.validConfiguration()?this.composition.recognize(handle,frame):Promise.resolve({status:'unavailable'} as const);}
 renewObservation(handle:object):boolean{return this.validConfiguration()&&this.observations.has(handle)&&this.composition.renewObservation(handle);}
 private withdrawPublished(sessionId?:string):void{const old=this.published;if(!old||sessionId&&old.identity.sessionId!==sessionId)return;this.published=undefined;const current=this.ports.audience.snapshot(old.identity);if(current.basis==='automatic'&&current.sourceId===old.sourceId&&current.evidenceRef===old.evidenceRef&&current.revision===old.revision)this.ports.audience.observe(old.identity,null);}
 private currentAssociationKey(actual?:PresenceBinding):string|null{try{const b=actual??this.composition.producer.presencePorts().binding();if(!b)return null;const captured=[...this.observations.values()].find(o=>o.sessionId===b.sessionId&&o.association.actorId===b.scope.userId&&o.association.endpointId===b.endpointId&&o.association.resourceId===b.resourceId&&o.association.siteRef===b.siteRef&&o.association.zoneRef===b.zoneRef&&o.association.enrollmentRef===b.enrollmentRef&&o.association.enrollmentRevision===b.enrollmentRevision);return captured?key(captured.association):null;}catch{return null;}}
 private fenceAssociation(a:UbuntuRetentionAssociation):void{
  // Retention owns its removal latch here. Polling producer eligibility would
  // re-enter that latch and retire an unrelated legitimate successor. Use only
  // the captured association of the exact latest observation generation.
  const latest=this.latestObservation&&this.observations.get(this.latestObservation),affected=!!latest&&key(latest.association)===key(a)||this.published?.associationKey===key(a);
  if(this.published?.associationKey===key(a))this.withdrawPublished();for(const [h,o] of [...this.observations])if(key(o.association)===key(a)){this.delete(this.observations,h);if(this.latestObservation===h)this.latestObservation=undefined;this.composition.closeObservation(h);}if(affected){this.lifecycle.source.stop();this.lifecycle.initiative.invalidate('sourceChanged');}
 }
 stopSession(sessionId:string):void{/*BEGIN_CAMERA1_STOP*/this.nativeFrameBinding?.stopSession(sessionId);for(const [id,row]of this.webChannels)if(row.context.sessionId===sessionId)this.delete(this.nativeOffers,id);/*END_CAMERA1_STOP*/if([...this.enrollments.values()].includes(sessionId)||[...this.observations.values()].some(o=>o.sessionId===sessionId)||[...this.webChannels.values()].some(o=>o.context.sessionId===sessionId))this.#custody.invalidate();for(const [id,row]of [...this.webChannels])if(row.context.sessionId===sessionId)this.delete(this.webChannels,id);this.frameChannels.stopSession(sessionId);for(const [id,o]of [...this.webObservations])if(o.context.sessionId===sessionId)this.delete(this.webObservations,id);const latest=this.latestObservation&&this.observations.get(this.latestObservation),affected=this.published?.identity.sessionId===sessionId||!!latest&&latest.sessionId===sessionId;this.withdrawPublished(sessionId);for(const [h,owner]of [...this.enrollments])if(owner===sessionId)this.release(h);for(const [h,o] of [...this.observations])if(o.sessionId===sessionId){this.delete(this.observations,h);if(this.latestObservation===h)this.latestObservation=undefined;this.composition.closeObservation(h);}if(affected){this.lifecycle.source.stop();this.lifecycle.initiative.invalidate('sourceChanged');}}
 /** Only the exact currently published automatic source avoids self-withdrawal.
  * Manual/restricted/replacement/expired audience decisions remain independent. */
 ownAudiencePublication():boolean{
  if(!this.pumping||!this.validConfiguration())return false;try{const b=this.composition.producer.presencePorts().binding();if(!b)return false;const p=this.composition.producer.presencePorts(),camera=p.camera(b),identity=p.identity(b),context=this.ports.authentication.hostSessionContext(b.sessionId);if(!camera||!identity||context.principalId!==b.scope.userId||!this.authorized(context)||p.current(b)!==true)return false;const scope={principalId:b.scope.userId,sessionId:b.sessionId,endpointId:b.endpointId},s=this.ports.audience.snapshot(scope);const accepted=s.sourceId===this.configuration.sourceId&&s.basis==='automatic'&&s.evidenceRef===`presence:${digest([camera.evidenceRef,identity.evidenceRef]).slice(0,64)}`&&s.expiresAt===new Date(Math.min(camera.expiresAt,identity.expiresAt)).toISOString()&&digest(p.binding())===digest(b)&&this.originalContext(context);const associationKey=this.currentAssociationKey(b);if(accepted&&associationKey)this.published={associationKey,identity:scope,sourceId:s.sourceId,evidenceRef:s.evidenceRef,revision:s.revision};return accepted&&associationKey!==null;}catch{return false;}
 }
 refresh():Promise<CameraPresenceRefresh>{if(!this.validConfiguration())return Promise.resolve({status:'unavailable'});this.pumping++;return this.lifecycle.refresh().finally(()=>{try{this.ownAudiencePublication();}finally{this.pumping--;}});}
 withdraw():void{if(this.withdrawing||this.closed)return;/*BEGIN_CAMERA1_WITHDRAW*/for(const row of [...this.webChannels.values()])this.nativeFrameBinding?.stopSession(row.context.sessionId);this.clear(this.nativeOffers);/*END_CAMERA1_WITHDRAW*/this.#custody.invalidate();this.withdrawing=true;try{this.clear(this.webChannels);this.frameChannels.closeAll();this.clear(this.webObservations);this.withdrawPublished();for(const [h]of [...this.enrollments])this.release(h);this.latestObservation=undefined;for(const [h]of [...this.observations]){this.delete(this.observations,h);this.composition.closeObservation(h);}this.lifecycle.source.stop();this.lifecycle.initiative.invalidate('sourceChanged');}finally{this.withdrawing=false;}}
 command(context:LocalContext,body:UbuntuPresenceCommand):Promise<UbuntuPresenceCommandResult>{
  if(!body||Object.keys(body).sort().join('|')!=='expectedRevision|idempotencyKey|operation'||!['stop','revoke'].includes(body.operation)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1||typeof body.idempotencyKey!=='string'||!/^[-a-zA-Z0-9_]{16,80}$/.test(body.idempotencyKey))throw new UbuntuPresenceHostError(422,'camera_presence_invalid_request');
  if(!this.authorized(context))throw new UbuntuPresenceHostError(403,'camera_presence_scope_unavailable');if(body.expectedRevision!==this.configuration.revision)throw new UbuntuPresenceHostError(409,'camera_presence_revision_changed');
  if(this.configuration.setupActions?.[body.operation]!==true)throw new UbuntuPresenceHostError(503,'camera_presence_action_unavailable');
  const id=key([context.principalId,context.sessionId,body.idempotencyKey]),requestKey=key(body),contextKey=key(context),now=(this.configuration.composition.now??Date.now)(),mono=(this.configuration.composition.monotonicMs??(()=>performance.now()))(),cached=this.requests.get(id);
  if(cached){if(cached.contextKey!==contextKey||cached.requestKey!==requestKey||now<cached.startedAt||now-cached.startedAt>=5000||mono<cached.startedMono||mono-cached.startedMono>=5000)throw new UbuntuPresenceHostError(409,'camera_presence_idempotency_changed');return cached.promise;}
  if(this.requests.size>=32)throw new UbuntuPresenceHostError(429,'camera_presence_request_capacity');
  const promise=Promise.resolve().then(async()=>{if(!this.authorized(context))return {state:'unavailable',configurationRevision:this.configuration.revision} as const;
   if(body.operation==='stop'){this.stopSession(context.sessionId);return {state:'stopped',configurationRevision:this.configuration.revision} as const;}
   const a=this.configuration.association(structuredClone(context));if(!a||a.actorId!==context.principalId||!this.authorized(context))return {state:'unavailable',configurationRevision:this.configuration.revision} as const;
   const result=await this.retention.erase(context.sessionId,a,'withdrawal');return {state:result.status,configurationRevision:this.configuration.revision};
  });this.requests.set(id,{contextKey,requestKey,startedAt:now,startedMono:mono,promise});return promise;
 }
 close():void{if(this.closed)return;/*BEGIN_CAMERA1_CLOSE*/this.nativeFrameBinding?.close();nativeUbuntuFrameOwners.delete(this);this.clear(this.nativeOffers);/*END_CAMERA1_CLOSE*/this.#custody.close();this.closed=true;this.clear(this.webChannels);this.frameChannels.dispose();this.clear(this.webObservations);this.webRequests.clear();for(const [h]of [...this.enrollments])this.release(h);this.latestObservation=undefined;for(const [h]of [...this.observations]){this.delete(this.observations,h);this.composition.closeObservation(h);}this.composition.close();this.retention.close();this.lifecycle.close();this.requests.clear();this.clear(this.leases);}
}
/*BEGIN_CAMERA1_PROTOTYPES*/const nativeOriginalSnapshot=Object.getOwnPropertyDescriptor(UbuntuPresenceHost.prototype,'nativeFrameSnapshot')!.value;const nativeOriginalSubmit=UbuntuPresenceHost.prototype.submitFrame;
/*END_CAMERA1_PROTOTYPES*/export function createUbuntuPresenceHost(ports:Partial<UbuntuPresenceHostPorts>|null=null):UbuntuPresenceHost|null{
 if(!ports?.configuration)return null;const c=ports.configuration;
 if(!ports.database||!ports.authentication||!ports.audience||typeof ports.current!=='function'||!Number.isSafeInteger(c.revision)||c.revision<1||typeof c.sourceId!=='string'||!c.sourceId||Buffer.byteLength(c.sourceId)>80||!c.composition||!c.retention||![c.current,c.destination,c.association,c.retention.authorizeRemoval,c.retention.enrollmentCurrent].every(fn=>typeof fn==='function'))throw new UbuntuPresenceHostError(503,'camera_presence_configuration_unavailable');
 return new UbuntuPresenceHost(ports as UbuntuPresenceHostPorts);
}
export const unavailableUbuntuPresenceStatus=unavailable;

export const unavailableUbuntuPresenceSetup=unavailableSetup;
