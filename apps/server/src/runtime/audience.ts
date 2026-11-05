import {randomUUID} from 'node:crypto';
// Endpoint-scoped disclosure evidence. This does not identify speakers or grant authority.
export type AudienceIdentity={principalId:string;sessionId:string;endpointId:string|null};
export type AudienceObservation={sourceId:string;evidenceRef:string;endpointId:string;principalId:string;observedAt:string;expiresAt:string;coverageKnown:boolean;ownerPresent:boolean;occupants:number};
export type AudienceSnapshot={classification:'solo-supported'|'shared'|'unknown';basis:'automatic'|'manual'|'unavailable'|'restricted';revision:number;sourceId:string|null;evidenceRef:string|null;expiresAt:string|null;automatic:boolean;privateAllowed:boolean;leaseId:string|null;leaseExpiresAt:string|null;personalSessionState?:'unlocked'|'locked';personalSessionId?:string|null;personalSessionEpoch?:string;personalSessionBasis?:'explicitUnlock'|'savedPreference'};
export type AudienceLeaseRequest={operation:'begin'|'renew'|'end';leaseId:string;expectedAudienceRevision:number};
/** Host-bound camera facts. Count evidence contains no owner or speaker identity. */
export type CameraAudienceBinding={sourceId:string;sourceBindingRef:string;leaseId:string;captureEpoch:string;configurationRevision:number};
export type CameraAudienceEvidence={evidenceRef:string;sequence:number;value:'zero'|'one'|'multiple'|'uncertain';capturedAtEarliest:string;capturedAtLatest:string;interpretedAt:string;expiresAt:string;declaredFieldOfView:string;coverage:'frameOnly'|'obstructed'|'unknown';confidence:number|null;limitations:string[];uncertaintyReasons:string[]};
export type CameraAudienceReason='cameraStarted'|'countChanged'|'countExpired'|'cameraEnded'|'requalified';
export class AudienceLeaseError extends Error {
 readonly status:number;readonly code:string;
 constructor(status:number,code:string,message:string){super(message);this.status=status;this.code=code;}
}
const LEASE_LIVENESS_MS=20_000;
export type AudienceOptions={sourceIds?:string[];cameraSourceIds?:string[];onCameraChanged?:(identity:AudienceIdentity,snapshot:AudienceSnapshot,reason:CameraAudienceReason)=>void;monotonicMs?:()=>number;poll?:(identity:AudienceIdentity,signal:AbortSignal)=>Promise<AudienceObservation|null>;subscribeInvalidation?:(listener:()=>void)=>()=>void;now?:()=>number};
type CameraLane={binding:CameraAudienceBinding;active:boolean;sequence:number;capture:number;restrictionAt:number;lastNow:number;deadlineMono:number;lastMono:number;epoch:number;evidence?:CameraAudienceEvidence|undefined;qualification?:{sourceId:string;observedAt:number;evidenceRef:string}|undefined;timer?:ReturnType<typeof setTimeout>|undefined};
type PersonalDeclaration={id:string;current:()=>boolean;source?:'savedPreference';policyRevision?:number};
type PersonalOwner={epoch:number;retired:Set<string>;commands:Map<string,{operation:'unlock'|'lock';declarationId:string;key:string}>;blocked:boolean};
export type PersonalSessionRequest={operation:'unlock'|'lock';operationId:string;declarationId:string;expectedAudienceRevision:number;expectedPersonalSessionEpoch:string;expectedSessionRevision:number;endpointId:string;expectedEndpointRevision:number};
type Entry={generation:number;identity:AudienceIdentity;observation?:AudienceObservation|undefined;manual?:{mode:'solo'|'shared';expires:number}|undefined;lease?:{id:string;expires:number;current:()=>boolean}|undefined;personal?:PersonalDeclaration|undefined;personalManaged?:boolean;restorationBlocked?:boolean;camera?:CameraLane|undefined;restricted:boolean;revision:number;key:string;value:AudienceSnapshot;listeners:Set<(value:AudienceSnapshot)=>void>;touched:number;polling?:AbortController|undefined};
const cameraBindingKeys=['sourceId','sourceBindingRef','leaseId','captureEpoch','configurationRevision'];
const cameraEvidenceKeys=['evidenceRef','sequence','value','capturedAtEarliest','capturedAtLatest','interpretedAt','expiresAt','declaredFieldOfView','coverage','confidence','limitations','uncertaintyReasons'];
const exact=(value:unknown,keys:string[]):boolean=>!!value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return !!d&&Object.hasOwn(d,'value');});
const boundedText=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value)<=256;
const sameCamera=(left:CameraAudienceBinding,right:CameraAudienceBinding)=>cameraBindingKeys.every(key=>left[key as keyof CameraAudienceBinding]===right[key as keyof CameraAudienceBinding]);
export class AudienceCoordinator{
 private readonly entries=new Map<string,Entry>();private readonly timer:ReturnType<typeof setInterval>;private readonly now:()=>number;
 private readonly mono:()=>number;
 private readonly personalEpoch=randomUUID();
 private readonly personalOwners=new Map<string,PersonalOwner>();
 private unsubscribeSource:(()=>void)|undefined;private readonly options:AudienceOptions;private readonly changed:()=>void;
 constructor(options:AudienceOptions={},changed:()=>void=()=>{}){this.options=options;this.changed=changed;this.now=options.now??Date.now;this.mono=options.monotonicMs??options.now??(()=>performance.now());this.timer=setInterval(()=>this.tick(),250);this.timer.unref();try{this.unsubscribeSource=options.subscribeInvalidation?.(()=>{for(const e of this.entries.values()){e.generation++;e.polling?.abort();e.observation=undefined;e.lease=undefined;this.reconcile(e);}});}catch(error){clearInterval(this.timer);throw error;}}
 private entry(identity:AudienceIdentity):Entry{const key=JSON.stringify(identity);let e=this.entries.get(key);if(!e){if(this.entries.size>=1000)throw new Error('Audience session capacity reached');const value:AudienceSnapshot={classification:'unknown',basis:'unavailable',revision:0,sourceId:null,evidenceRef:null,expiresAt:null,automatic:false,privateAllowed:false,leaseId:null,leaseExpiresAt:null};e={generation:0,identity:{...identity},restricted:false,revision:0,key:'',value,listeners:new Set(),touched:this.now()};this.entries.set(key,e);}e.touched=this.now();return e;}
 snapshot(identity:AudienceIdentity):AudienceSnapshot{return structuredClone(this.reconcile(this.entry(identity)));}
 configuredCameraSource(sourceId:string):boolean{return (this.options.cameraSourceIds??[]).includes(sourceId);}
 private validCameraBinding(identity:AudienceIdentity,binding:CameraAudienceBinding):boolean{return !!identity.endpointId&&exact(binding,cameraBindingKeys)&&(this.options.cameraSourceIds??[]).includes(binding.sourceId)&&boundedText(binding.sourceBindingRef)&&boundedText(binding.captureEpoch)&&typeof binding.leaseId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(binding.leaseId)&&Number.isSafeInteger(binding.configurationRevision)&&binding.configurationRevision>=0;}
 private retireCameraClearance(e:Entry):void{e.restorationBlocked=true;if(e.manual?.mode==='solo')e.manual=undefined;e.lease=undefined;if(e.personal){this.retirePersonalId(this.personalOwner(e.identity),e.personal.id);e.personal=undefined;e.restricted=true;}if(e.camera){e.camera.qualification=undefined;e.camera.restrictionAt=Math.max(e.camera.restrictionAt,this.now());}}
 private scheduleCameraExpiry(e:Entry,lane:CameraLane):void{
  clearTimeout(lane.timer);if(!lane.evidence)return;
  lane.timer=setTimeout(()=>{
   if(e.camera!==lane)return;lane.timer=undefined;this.reconcile(e,'countExpired');
   // Timer rounding or an early wake cannot defer privacy expiry to the polling
   // interval. Re-arm until either clock reaches the conservative deadline.
   if(lane.evidence)this.scheduleCameraExpiry(e,lane);
  },Math.max(1,Math.ceil(Math.min(lane.deadlineMono-this.mono(),Date.parse(lane.evidence.expiresAt)-this.now()))));lane.timer.unref();
 }
 /** Called only by the host after a camera lease is authorized, never by a model or a route body. */
 beginCamera(identity:AudienceIdentity,binding:CameraAudienceBinding):AudienceSnapshot{
  if(!this.validCameraBinding(identity,binding))throw new AudienceLeaseError(422,'camera_audience_binding_invalid','A configured host camera binding is required');
  const e=this.entry(identity);this.reconcile(e);
  if(e.camera?.active&&sameCamera(e.camera.binding,binding))return structuredClone(e.value);
  if(!e.camera?.active&&[...this.entries.values()].filter(entry=>entry.camera?.active).length>=4)throw new AudienceLeaseError(409,'camera_audience_capacity','Camera audience capacity reached');
  clearTimeout(e.camera?.timer);e.generation++;e.polling?.abort();
  const now=this.now(),mono=this.mono();
  e.camera={binding:structuredClone(binding),active:true,sequence:-1,capture:-Infinity,restrictionAt:now,lastNow:now,lastMono:mono,deadlineMono:mono,epoch:(e.camera?.epoch??0)+1};
  this.retireCameraClearance(e);return structuredClone(this.reconcile(e,'cameraStarted'));
 }
 private validCameraEvidence(input:CameraAudienceEvidence):boolean{
  if(!exact(input,cameraEvidenceKeys))return false;
  const now=this.now(),first=Date.parse(input.capturedAtEarliest),last=Date.parse(input.capturedAtLatest),interpreted=Date.parse(input.interpretedAt),expiry=Date.parse(input.expiresAt);
  return boundedText(input.evidenceRef)&&Number.isSafeInteger(input.sequence)&&input.sequence>=0&&['zero','one','multiple','uncertain'].includes(input.value)&&['frameOnly','obstructed','unknown'].includes(input.coverage)&&typeof input.declaredFieldOfView==='string'&&input.declaredFieldOfView.trim().length>0&&Buffer.byteLength(input.declaredFieldOfView)<=512&&(input.confidence===null||Number.isFinite(input.confidence)&&input.confidence>=0&&input.confidence<=1)&&Array.isArray(input.limitations)&&input.limitations.length<=8&&input.limitations.every(item=>typeof item==='string'&&item.trim().length>0&&Buffer.byteLength(item)<=512)&&Array.isArray(input.uncertaintyReasons)&&input.uncertaintyReasons.length<=16&&input.uncertaintyReasons.every(boundedText)&&[first,last,interpreted,expiry,now].every(Number.isFinite)&&first<=last&&last-first<=2250&&first<=interpreted&&interpreted<=now&&last<=now+250&&expiry>now&&expiry<=first+2000;
 }
 observeCamera(identity:AudienceIdentity,binding:CameraAudienceBinding,input:CameraAudienceEvidence):boolean{
  if(!this.validCameraBinding(identity,binding))return false;
  const e=this.entry(identity);this.reconcile(e);const lane=e.camera;
  if(!lane?.active||!sameCamera(lane.binding,binding)||!this.validCameraEvidence(input)||input.sequence<=lane.sequence||Date.parse(input.capturedAtEarliest)<lane.capture)return false;
  const now=this.now(),mono=this.mono();if(!Number.isFinite(mono)||now<lane.lastNow||mono<lane.lastMono)return false;
  lane.sequence=input.sequence;lane.capture=Date.parse(input.capturedAtEarliest);lane.evidence=structuredClone(input);lane.deadlineMono=mono+Date.parse(input.expiresAt)-now;lane.lastNow=now;lane.lastMono=mono;
  if(input.value!=='one'||input.coverage!=='frameOnly')this.retireCameraClearance(e);
  this.scheduleCameraExpiry(e,lane);
  this.reconcile(e,'countChanged');return true;
 }
 endCamera(identity:AudienceIdentity,binding:CameraAudienceBinding):AudienceSnapshot{
  const e=this.entry(identity),lane=e.camera;if(!this.validCameraBinding(identity,binding)||!lane||!sameCamera(lane.binding,binding))return structuredClone(this.reconcile(e));
  if(lane.active){lane.active=false;lane.evidence=undefined;lane.epoch++;clearTimeout(lane.timer);lane.timer=undefined;this.retireCameraClearance(e);}
  return structuredClone(this.reconcile(e,'cameraEnded'));
 }
 /** Missing or unusable count withdraws clearance without ending authorized capture. */
 withdrawCameraEvidence(identity:AudienceIdentity,binding:CameraAudienceBinding):AudienceSnapshot{
  const e=this.entry(identity),lane=e.camera;
  if(!this.validCameraBinding(identity,binding)||!lane?.active||!sameCamera(lane.binding,binding))return structuredClone(this.reconcile(e));
  lane.evidence=undefined;clearTimeout(lane.timer);lane.timer=undefined;this.retireCameraClearance(e);
  return structuredClone(this.reconcile(e,'countChanged'));
 }
 requalifyCamera(identity:AudienceIdentity,input:{binding:CameraAudienceBinding;expectedAudienceRevision:number;ownerEvidence:AudienceObservation}):AudienceSnapshot{
  const e=this.entry(identity);this.reconcile(e);const lane=e.camera,o=input.ownerEvidence;
  if(!lane?.active||!this.validCameraBinding(identity,input.binding)||!sameCamera(lane.binding,input.binding)||!Number.isSafeInteger(input.expectedAudienceRevision)||input.expectedAudienceRevision!==e.revision)throw new AudienceLeaseError(409,'camera_audience_revision_changed','Camera audience scope changed');
  if(e.restricted||e.manual?.mode==='shared'||lane.evidence?.value!=='one'||lane.evidence.coverage!=='frameOnly'||!this.valid(identity,o)||o.sourceId===lane.binding.sourceId||!o.ownerPresent||!o.coverageKnown||o.occupants!==1||Date.parse(o.observedAt)<=lane.restrictionAt||Date.parse(o.observedAt)>this.now())throw new AudienceLeaseError(409,'camera_audience_unqualified','Fresh independent owner and audience coverage requalification is required');
  e.generation++;e.polling?.abort();e.observation=structuredClone(o);e.manual=undefined;e.lease=undefined;lane.qualification={sourceId:o.sourceId,observedAt:Date.parse(o.observedAt),evidenceRef:o.evidenceRef};lane.epoch++;
  return structuredClone(this.reconcile(e,'requalified'));
 }
 /** Bounded diagnostic copy; the camera evidence is not an identity or permission. */
 cameraEvidence(identity:AudienceIdentity):CameraAudienceEvidence|null{const e=this.entry(identity);this.reconcile(e);return e.camera?.evidence?structuredClone(e.camera.evidence):null;}
 lease(identity:AudienceIdentity,input:AudienceLeaseRequest,current:()=>boolean=()=>true):AudienceSnapshot{
  if(!input||Object.keys(input).some(k=>!['operation','leaseId','expectedAudienceRevision'].includes(k))||!['begin','renew','end'].includes(input.operation)||typeof input.leaseId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.leaseId)||!Number.isSafeInteger(input.expectedAudienceRevision)||input.expectedAudienceRevision<0)throw new AudienceLeaseError(422,'audience_lease_invalid','A lease operation, random UUID and audience revision are required');
  const e=this.entry(identity);this.reconcile(e);
  // A late close from an older app process cannot withdraw its replacement or a
  // subsequent manual decision. Cleanup never creates audience permission.
  if(input.operation==='end'&&e.lease?.id!==input.leaseId)return structuredClone(e.value);
  if(input.operation==='end'){
   // The exact owner may withdraw only its contribution even if independent
   // evidence revised the snapshot. A stale revision must not strand a lease.
   e.lease=undefined;return structuredClone(this.reconcile(e));
  }
  if(input.operation==='renew'&&e.lease?.id!==input.leaseId)throw new AudienceLeaseError(409,'audience_lease_inactive','The lease is inactive or expired');
  if(e.revision!==input.expectedAudienceRevision)throw new AudienceLeaseError(409,'audience_revision_conflict','The audience revision changed');
  if(input.operation==='renew')e.lease!.expires=this.now()+LEASE_LIVENESS_MS;
  else{
   if(!identity.endpointId||!this.leaseCurrent(current))throw new AudienceLeaseError(409,'audience_lease_scope_changed','The authenticated endpoint changed');
   if(e.restricted||e.manual?.mode==='shared'||this.contradiction(e.observation)||e.camera&&!e.value.privateAllowed)throw new AudienceLeaseError(409,'audience_lease_restricted','The current audience restricts private access');
   if(e.lease?.id===input.leaseId)throw new AudienceLeaseError(409,'audience_lease_active','Renew an active lease instead of beginning it again');
   e.generation++;e.polling?.abort();e.manual=undefined;e.lease={id:input.leaseId,expires:this.now()+LEASE_LIVENESS_MS,current};
  }
  return structuredClone(this.reconcile(e));
 }
 private leaseCurrent(current:()=>boolean):boolean{try{return current();}catch{return false;}}
 /** Registration is protected-only. Reconnection reads this same in-memory
  * declaration; no clock, heartbeat, visibility or storage policy grants it. */
 personalSnapshot(identity:AudienceIdentity):AudienceSnapshot{
  const e=this.entry(identity);
  if(!e.personalManaged){e.personalManaged=true;e.restricted=true;e.manual=undefined;e.lease=undefined;e.key='';}
  return structuredClone(this.reconcile(e));
 }
 private personalOwner(identity:AudienceIdentity):PersonalOwner{
  const key=JSON.stringify([identity.principalId,identity.sessionId]);let owner=this.personalOwners.get(key);
  if(!owner){if(this.personalOwners.size>=1000)throw new AudienceLeaseError(429,'personal_session_capacity','Personal-session capacity reached');owner={epoch:0,retired:new Set(),commands:new Map(),blocked:false};this.personalOwners.set(key,owner);}return owner;
 }
 private personalCommandKey(input:PersonalSessionRequest):string{return JSON.stringify([input.operation,input.operationId,input.declarationId,input.expectedAudienceRevision,input.expectedPersonalSessionEpoch,input.expectedSessionRevision,input.endpointId,input.expectedEndpointRevision]);}
 personalCommandRecorded(identity:AudienceIdentity,input:PersonalSessionRequest):boolean{return (input.operation==='lock'||input.endpointId===identity.endpointId)&&input.expectedPersonalSessionEpoch===this.personalEpoch&&this.personalOwners.get(JSON.stringify([identity.principalId,identity.sessionId]))?.commands.get(input.operationId)?.key===this.personalCommandKey(input);}
 private personalWithdrawalSnapshot(identity:AudienceIdentity):AudienceSnapshot{
  // Entry capacity cannot prevent owner-wide withdrawal. This result describes
  // restriction only and does not allocate any new disclosure authority.
  if(this.entries.has(JSON.stringify(identity))||this.entries.size<1000)return this.personalSnapshot(identity);
  return {classification:'unknown',basis:'restricted',revision:0,sourceId:null,evidenceRef:null,expiresAt:null,automatic:false,privateAllowed:false,leaseId:null,leaseExpiresAt:null,personalSessionState:'locked',personalSessionId:null,personalSessionEpoch:this.personalEpoch};
 }
 private retirePersonalId(owner:PersonalOwner,id:string):void{if(owner.retired.has(id))return;if(owner.retired.size>=256){owner.blocked=true;return;}owner.retired.add(id);}
 personalSession(identity:AudienceIdentity,input:PersonalSessionRequest,current:()=>boolean):AudienceSnapshot{
  const keys=['operation','operationId','declarationId','expectedAudienceRevision','expectedPersonalSessionEpoch','expectedSessionRevision','endpointId','expectedEndpointRevision'];
  const uuid=(value:string)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  if(!exact(input,keys)||!['unlock','lock'].includes(input.operation)||!uuid(input.operationId)||!uuid(input.declarationId)||!Number.isSafeInteger(input.expectedAudienceRevision)||input.expectedAudienceRevision<0||!uuid(input.endpointId)||!Number.isSafeInteger(input.expectedSessionRevision)||input.expectedSessionRevision<1||!Number.isSafeInteger(input.expectedEndpointRevision)||input.expectedEndpointRevision<1)throw new AudienceLeaseError(422,'personal_session_invalid','A closed manual-session command is required');
  if(input.expectedPersonalSessionEpoch!==this.personalEpoch)throw new AudienceLeaseError(409,'personal_session_source_changed','Refresh the current personal session before a new explicit action');
  if(input.operation==='unlock'&&input.endpointId!==identity.endpointId)throw new AudienceLeaseError(409,'personal_session_scope_changed','The authenticated personal endpoint changed');
  const commandKey=this.personalCommandKey(input);
  const existingOwner=this.personalOwners.get(JSON.stringify([identity.principalId,identity.sessionId])),previous=existingOwner?.commands.get(input.operationId);
  if(previous){if(previous.key!==commandKey)throw new AudienceLeaseError(409,'personal_session_command_conflict','The original command identity and admitted body must be preserved');return this.personalWithdrawalSnapshot(identity);}
  if(input.operation==='lock'){
   // Withdrawal cannot be refused for exhausted admission bookkeeping.
   let owner:PersonalOwner;try{owner=this.personalOwner(identity);}catch{
    for(const entry of this.entries.values())if(entry.identity.principalId===identity.principalId&&entry.identity.sessionId===identity.sessionId){entry.personal=undefined;entry.personalManaged=true;entry.restricted=true;entry.manual=undefined;entry.lease=undefined;entry.key='';}
    for(const entry of this.entries.values())if(entry.identity.principalId===identity.principalId&&entry.identity.sessionId===identity.sessionId)this.reconcile(entry);
    return this.personalWithdrawalSnapshot(identity);
   }
   owner.epoch++;this.retirePersonalId(owner,input.declarationId);
   if(owner.commands.size>=256)owner.blocked=true;else owner.commands.set(input.operationId,{operation:'lock',declarationId:input.declarationId,key:commandKey});
   const entries=[...this.entries.values()].filter(entry=>entry.identity.principalId===identity.principalId&&entry.identity.sessionId===identity.sessionId);
   // Clear every owned contribution before any callback can publish a snapshot.
   for(const entry of entries){if(entry.personal)this.retirePersonalId(owner,entry.personal.id);entry.generation++;entry.polling?.abort();entry.personal=undefined;entry.personalManaged=true;entry.restricted=true;entry.manual=undefined;entry.lease=undefined;entry.key='';}
   for(const entry of entries)this.reconcile(entry);
   return this.personalWithdrawalSnapshot(identity);
  }
  let e:Entry;try{e=this.entry(identity);}catch{throw new AudienceLeaseError(429,'personal_session_capacity','Personal-session capacity reached');}
  this.personalSnapshot(identity);const owner=this.personalOwner(identity),epoch=owner.epoch;
  if(owner.commands.size>=256)owner.blocked=true;
  if(owner.blocked||owner.retired.has(input.declarationId))throw new AudienceLeaseError(409,'personal_session_retired','Use a new explicit Unlock; this admission is retired or capacity is exhausted');
  if(input.expectedAudienceRevision!==e.revision)throw new AudienceLeaseError(409,'personal_session_revision_conflict','Refresh the current manual session before unlocking');
  if(e.personal){if(e.personal.id===input.declarationId)return structuredClone(e.value);throw new AudienceLeaseError(409,'personal_session_already_unlocked','The personal session is already unlocked');}
  const generation=e.generation,admitted=()=>owner.epoch===epoch&&!owner.blocked&&!owner.retired.has(input.declarationId)&&this.leaseCurrent(current)&&owner.epoch===epoch&&!owner.blocked&&!owner.retired.has(input.declarationId);
  if(!identity.endpointId||!admitted()||e.generation!==generation)throw new AudienceLeaseError(409,'personal_session_scope_changed','The authenticated personal endpoint changed');
  const lane=e.camera,cameraClear=!lane||!!(lane.active&&lane.evidence?.value==='one'&&lane.evidence.coverage==='frameOnly'&&lane.qualification);
  if(e.manual?.mode==='shared'||this.contradiction(e.observation)||!cameraClear)throw new AudienceLeaseError(409,'personal_session_restricted','Independent audience evidence prevents private disclosure');
  owner.commands.set(input.operationId,{operation:'unlock',declarationId:input.declarationId,key:commandKey});
  e.generation++;e.polling?.abort();e.manual=undefined;e.lease=undefined;e.restricted=false;e.personal={id:input.declarationId,current:admitted};
  const value=this.reconcile(e);
  if(e.personal?.id!==input.declarationId||!value.privateAllowed||!admitted()){if(e.personal?.id===input.declarationId){e.personal=undefined;e.restricted=true;this.reconcile(e);}this.retirePersonalId(owner,input.declarationId);throw new AudienceLeaseError(409,'personal_session_retired','The manual session was withdrawn during admission');}
  return structuredClone(value);
 }
 /** Host-only admission from an already-current DURABLE saved preference.
  * This is a new session-bound contribution, never a replayed Unlock command.
  * Missing policy, manual withdrawal, or independent audience restriction denies.
  */
 restoreSavedPersonal(identity:AudienceIdentity,policyRevision:number,current:()=>boolean):AudienceSnapshot{
  if(!identity.endpointId||!Number.isSafeInteger(policyRevision)||policyRevision<1||!this.leaseCurrent(current))throw new AudienceLeaseError(409,'saved_personal_policy_changed','The saved browser policy is unavailable');
  const e=this.entry(identity);this.reconcile(e);const owner=this.personalOwner(identity);
  if(e.restorationBlocked||owner.epoch!==0||owner.blocked||owner.commands.size>0||e.manual?.mode==='shared'||this.contradiction(e.observation))throw new AudienceLeaseError(409,'saved_personal_policy_restricted','An explicit or independent restriction is current');
  const lane=e.camera,cameraClear=!lane||!!(lane.active&&lane.evidence?.value==='one'&&lane.evidence.coverage==='frameOnly'&&lane.qualification);
  if(!cameraClear)throw new AudienceLeaseError(409,'saved_personal_policy_restricted','Independent camera clearance is unavailable');
  if(e.personal){if(e.personal.source==='savedPreference'&&e.personal.policyRevision===policyRevision)return structuredClone(e.value);throw new AudienceLeaseError(409,'saved_personal_already_admitted','The current personal contribution must be retained');}
  this.personalSnapshot(identity);const epoch=owner.epoch;
  const admitted=()=>owner.epoch===epoch&&!owner.blocked&&this.leaseCurrent(current)&&owner.epoch===epoch&&!owner.blocked;
  if(!admitted())throw new AudienceLeaseError(409,'saved_personal_policy_changed','The saved browser policy changed');
  e.generation++;e.polling?.abort();e.manual=undefined;e.lease=undefined;e.restricted=false;
  e.personal={id:randomUUID(),current:admitted,source:'savedPreference',policyRevision};
  const value=this.reconcile(e);
  if(!value.privateAllowed||!admitted()){e.personal=undefined;e.restricted=true;this.reconcile(e);throw new AudienceLeaseError(409,'saved_personal_policy_changed','The saved browser policy changed');}
  return structuredClone(value);
 }
 /** Durable binding withdrawal retires all live auth-session contributions. */
 withdrawSavedBinding(principalId:string,endpointId:string):void{
  const entries=[...this.entries.values()].filter(e=>e.identity.principalId===principalId&&e.identity.endpointId===endpointId);
  for(const e of entries){let owner:PersonalOwner|undefined;try{owner=this.personalOwner(e.identity);}catch{/* Capacity never blocks withdrawal. */}if(owner){owner.epoch++;if(e.personal)this.retirePersonalId(owner,e.personal.id);}e.personal=undefined;e.personalManaged=true;e.restorationBlocked=true;e.restricted=true;e.manual=undefined;e.lease=undefined;e.generation++;e.polling?.abort();e.key='';}
  for(const e of entries)this.reconcile(e);
 }
 private contradiction(o:AudienceObservation|undefined):boolean{return !!o&&(o.occupants>1||o.coverageKnown&&(!o.ownerPresent||o.occupants!==1));}
 declare(identity:AudienceIdentity,mode:'solo'|'shared'|'clear'|'lock'|'unlock',seconds=300):AudienceSnapshot{
  if(!['solo','shared','clear','lock','unlock'].includes(mode))throw new Error('Unsupported audience declaration');
  if(!Number.isInteger(seconds)||seconds<1||seconds>900)throw new Error('A manual declaration must expire within fifteen minutes');
  // An explicit control action fences a pending lease acquisition even when it
  // leaves the classification unchanged (for example, clearing unknown).
  const e=this.entry(identity);if(e.personalManaged&&['solo','clear','unlock'].includes(mode))throw new AudienceLeaseError(409,'personal_session_controls_required','Use explicit personal-session Lock or Unlock');if(e.personal){this.retirePersonalId(this.personalOwner(identity),e.personal.id);e.personal=undefined;}e.generation++;e.polling?.abort();e.lease=undefined;e.key='';if(mode==='lock'){e.restorationBlocked=true;e.restricted=true;e.manual=undefined;}else if(mode==='unlock'){e.restorationBlocked=false;e.restricted=false;e.manual=undefined;e.observation=undefined;}else if(mode==='clear')e.manual=undefined;else{if(!identity.endpointId)throw new Error('Open Session disclosure and apply a choice before declaring an audience');e.manual={mode,expires:this.now()+seconds*1000};}if(e.camera){if(mode!=='solo')this.retireCameraClearance(e);else e.manual=undefined;}return structuredClone(this.reconcile(e));
 }
 // Only an operator-configured source adapter can publish automatic evidence.
 observe(identity:AudienceIdentity,input:AudienceObservation|null):void{const e=this.entry(identity);e.generation++;e.polling?.abort();this.applyObservation(e,input);}
 private applyObservation(e:Entry,input:AudienceObservation|null):void{e.observation=undefined;if(input&&this.valid(e.identity,input))e.observation=structuredClone(input);this.reconcile(e);}
 private valid(identity:AudienceIdentity,o:AudienceObservation):boolean{const now=this.now(),at=Date.parse(o.observedAt),expires=Date.parse(o.expiresAt);return !!identity.endpointId&&o.endpointId===identity.endpointId&&o.principalId===identity.principalId&&(this.options.sourceIds??[]).includes(o.sourceId)&&typeof o.evidenceRef==='string'&&o.evidenceRef.length>0&&o.evidenceRef.length<=256&&Number.isInteger(o.occupants)&&o.occupants>=0&&o.occupants<=100&&typeof o.coverageKnown==='boolean'&&typeof o.ownerPresent==='boolean'&&Number.isFinite(at)&&at<=now+500&&now-at<=5000&&Number.isFinite(expires)&&expires>now&&expires<=at+5000;}
 private reconcile(e:Entry,cameraReason?:CameraAudienceReason):AudienceSnapshot{
  const now=this.now();if(e.manual&&e.manual.expires<=now)e.manual=undefined;if(e.observation&&!this.valid(e.identity,e.observation))e.observation=undefined;
  const lane=e.camera;
  if(lane){
   const mono=this.mono();
   if(lane.evidence&&(!lane.active||!Number.isFinite(now)||!Number.isFinite(mono)||now<lane.lastNow||mono<lane.lastMono||now>=Date.parse(lane.evidence.expiresAt)||mono>=lane.deadlineMono)){
    lane.evidence=undefined;clearTimeout(lane.timer);lane.timer=undefined;this.retireCameraClearance(e);cameraReason??='countExpired';
   }
   lane.lastNow=Math.max(lane.lastNow,now);lane.lastMono=Math.max(lane.lastMono,mono);
   const q=lane.qualification,o=e.observation;
   if(q&&(!o||o.sourceId!==q.sourceId||Date.parse(o.observedAt)<q.observedAt||!o.coverageKnown||!o.ownerPresent||o.occupants!==1)){
    this.retireCameraClearance(e);cameraReason??='countChanged';
   }
  }
  if(e.lease&&(e.lease.expires<=now||!this.leaseCurrent(e.lease.current)||e.restricted||this.contradiction(e.observation)))e.lease=undefined;
  const personal=e.personal;
  if(personal){
   const live=this.leaseCurrent(personal.current),currentLane=e.camera;
   const cameraClear=!currentLane||!!(currentLane.active&&currentLane.evidence?.value==='one'&&currentLane.evidence.coverage==='frameOnly'&&currentLane.qualification);
   if(e.personal===personal&&(!live||e.restricted||e.manual?.mode==='shared'||this.contradiction(e.observation)||!cameraClear)){
    e.personal=undefined;e.restorationBlocked=true;e.restricted=true;this.retirePersonalId(this.personalOwner(e.identity),personal.id);
   }
  }
  const o=e.observation,m=e.manual;let classification:AudienceSnapshot['classification']='unknown',basis:AudienceSnapshot['basis']='unavailable',expiresAt:string|null=null,sourceId:string|null=null,evidenceRef:string|null=null;
  if(e.restricted){basis='restricted';}
  else if(m?.mode==='shared'){classification='shared';basis='manual';expiresAt=new Date(m.expires).toISOString();}
  else if(o&&o.occupants>1){classification='shared';basis='automatic';expiresAt=o.expiresAt;sourceId=o.sourceId;evidenceRef=o.evidenceRef;}
  else if(lane){
   const count=lane.evidence;
   basis=count?'automatic':'restricted';sourceId=lane.binding.sourceId;evidenceRef=count?.evidenceRef??null;expiresAt=count?.expiresAt??null;
   if(count?.value==='multiple')classification='shared';
   else if(count?.value==='one'&&count.coverage==='frameOnly'&&lane.qualification)classification='solo-supported';
  }
  // Known automatic coverage can contradict a still-current manual solo declaration.
  else if(o&&o.coverageKnown){if(o.ownerPresent&&o.occupants===1)classification='solo-supported';basis='automatic';expiresAt=o.expiresAt;sourceId=o.sourceId;evidenceRef=o.evidenceRef;}
  else if(m?.mode==='solo'){classification='solo-supported';basis='manual';expiresAt=new Date(m.expires).toISOString();}
  else if(e.lease){classification='solo-supported';basis='manual';expiresAt=new Date(e.lease.expires).toISOString();}
  else if(e.personal){classification='solo-supported';basis='manual';expiresAt=null;}
  // A count heartbeat updates diagnostic times/references without cancelling an
  // admitted reply. Privacy/source changes and explicit qualification epochs do
  // revise the scope; expiry is an independent restriction, not a heartbeat.
  const leaseId=e.lease?.id??null,key=JSON.stringify([classification,basis,sourceId,leaseId,...(lane?[lane.epoch,lane.active]:[]),...(e.personalManaged?['personal',e.personal?.id??null]:[])]);const changed=key!==e.key;e.key=key;if(changed)e.revision++;
  e.value={classification,basis,revision:e.revision,sourceId,evidenceRef,expiresAt,automatic:basis==='automatic',privateAllowed:classification==='solo-supported'&&(!e.personalManaged||!!e.personal),leaseId,leaseExpiresAt:e.lease?new Date(e.lease.expires).toISOString():null,...(e.personalManaged?{personalSessionState:e.personal?'unlocked' as const:'locked' as const,personalSessionId:e.personal?.id??null,personalSessionEpoch:this.personalEpoch,personalSessionBasis:e.personal?.source==='savedPreference'?'savedPreference' as const:'explicitUnlock' as const}:{})};
  if(changed){if(cameraReason&&this.options.onCameraChanged)this.options.onCameraChanged({...e.identity},structuredClone(e.value),cameraReason);else this.changed();for(const fn of e.listeners)fn(structuredClone(e.value));}return e.value;
 }
 subscribe(identity:AudienceIdentity,fn:(value:AudienceSnapshot)=>void):()=>void{const e=this.entry(identity);if(e.listeners.size>=16)throw new Error('Too many audience subscribers');e.listeners.add(fn);fn(this.snapshot(identity));return ()=>e.listeners.delete(fn);}
 tick():void{const now=this.now();for(const [key,e]of this.entries){this.reconcile(e);if(!e.personalManaged&&!e.listeners.size&&now-e.touched>1800000){e.polling?.abort();clearTimeout(e.camera?.timer);this.entries.delete(key);continue;}if(this.options.poll&&e.identity.endpointId&&!e.polling){const generation=e.generation,controller=e.polling=new AbortController(),timeout=setTimeout(()=>controller.abort(),750);const promise=Promise.resolve().then(()=>this.options.poll!(e.identity,controller.signal));void Promise.race([promise,new Promise<null>(resolve=>controller.signal.addEventListener('abort',()=>resolve(null),{once:true}))]).then(value=>{if(this.entries.get(key)===e&&e.generation===generation)this.applyObservation(e,value);},()=>{if(this.entries.get(key)===e&&e.generation===generation)this.applyObservation(e,null);}).finally(()=>{clearTimeout(timeout);if(e.polling===controller)e.polling=undefined;});}}}
 close():void{clearInterval(this.timer);this.unsubscribeSource?.();for(const e of this.entries.values()){e.polling?.abort();clearTimeout(e.camera?.timer);}this.entries.clear();}
}
