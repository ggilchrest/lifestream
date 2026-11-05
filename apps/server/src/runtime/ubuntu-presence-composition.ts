import {matchesCanonicalSourceExecutionScope} from './qualified-presence-source.ts';
import {createHash,randomBytes} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync,type BigIntStats} from 'node:fs';
import {basename,dirname,isAbsolute,join} from 'node:path';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {LocalAuthentication,LocalContext} from '../auth/local-auth.ts';
import type {CameraResourceBroker,CameraResourceLease} from './production-camera-binding.ts';
import {captureCanonicalQualifiedPresenceProducerRetirement,QualifiedPresenceProducer,type PresenceProducerAuthority,type PresenceProducerConnection} from './qualified-presence-producer.ts';
import type {PresenceBinding,QualifiedPresencePorts} from './qualified-presence-source.ts';
import {UbuntuPresenceObservationSession,type UbuntuObservationSnapshot} from './ubuntu-presence-observation-session.ts';

type Purpose='identityEnrollment'|'persistentPresence';
type ModelManifest={artifactRoot:string;runtimeVersion:'4.12.0';modelRevision:string;calibration:{revision:string;modelRevision:string;cosineThreshold:number;margin:number;detectionThreshold:number;minFacePixels:number};detector:{path:string;bytes:number;sha256:string};recognizer:{path:string;bytes:number;sha256:string};provenanceApproved:true};
export type UbuntuPresenceSelection={binding:PresenceBinding;actorId:string;endpointRevision:number;registrationRevision:number;deviceName:'AnkerWork B600 Video Bar';permission:'granted';foregroundVisible:true;consentRevision:number;enrollmentConsent:boolean;recognitionConsent:boolean;retentionExpiresAt:number;enrollmentCurrent:boolean};
export type UbuntuPresenceGrant={purpose:Purpose;sessionId:string;captureLeaseId:string;captureFence:string;authorityExpiresAt:number;actorId:string;endpointId:string;resourceId:string;siteRef:string;zoneRef:string;enrollmentRef:string;enrollmentRevision:number;consentRevision:number;registrationRevision:number;modelRevision:string;calibrationRevision:string;expiresAt:number};
export type UbuntuPresenceFrame={bytes:Uint8Array;observedAt:number;receivedAt:number;captureLeaseId:string;captureFence:string;sourceId:string;configurationRevision:number};
/** Internal captured authority only; never a browser-supplied descriptor. */
export type UbuntuOperationCapture={context:LocalContext;grant:UbuntuPresenceGrant;binding:PresenceBinding;lease:CameraResourceLease;untilMonotonicMs:number};
export type UbuntuEnrollmentPort={confirmPurpose:(g:UbuntuPresenceGrant,consent:{enrollment:true;recognition:boolean},current:()=>boolean)=>boolean;enroll:(g:UbuntuPresenceGrant,features:number[][],confirmation:{confirmed:true;indices:number[]},current:()=>boolean)=>Promise<unknown>;load:(g:UbuntuPresenceGrant,current:()=>boolean)=>Promise<{confirmed:true;grant:UbuntuPresenceGrant;features:number[][]}|null>;revoke:(g:UbuntuPresenceGrant,current:()=>boolean)=>Promise<unknown>};
export type UbuntuPresenceOptions={authentication:Pick<LocalAuthentication,'hostSessionContext'|'assertCurrent'>;broker:CameraResourceBroker;
 /** ORIGINAL host endpoint/config/consent owner. No browser/request descriptor. */
 selection:(context:LocalContext,purpose:Purpose)=>UbuntuPresenceSelection|null;
 enrollment:UbuntuEnrollmentPort;owner:QualifiedPresencePorts['owner'];
 /** Immutable configured server custody manifest. Revision is NOT OS/camera attestation. */
 execution:{revision:number;python:string;pythonSha256:string;worker:string;workerSha256:string;recognizerSha256:string;model:ModelManifest};
 /** Reads original accepted frame/clock-mapping custody. Submitted metadata alone
  * never satisfies this gate. Missing host frame owner is unavailable. */
 frameCurrent:(frame:UbuntuPresenceFrame,grant:UbuntuPresenceGrant)=>boolean;
 /** Independent, current coverage/count owner; missing coverage is always unknown. */
 coverage?:(binding:PresenceBinding)=>{coverageKnown:boolean;occupants:number}|null;
 /** Explicit foreground observation configuration; absence preserves one-shot mode. */
 observation?:{leaseTtlMs:number};
 now?:()=>number;monotonicMs?:()=>number;
};
type Operation={handle:object;context:LocalContext;selection:UbuntuPresenceSelection;purpose:Purpose;lease:CameraResourceLease;grant:UbuntuPresenceGrant;executionKey:string;until:number;generation:number;closed:boolean;consumed:boolean;frameCurrent?:()=>boolean;channel?:object;connection?:PresenceProducerConnection;observation?:{handle:object;frame:object}};
type Observation={handle:object;sessionId:string;owner:UbuntuPresenceObservationSession;channel:object;connection?:PresenceProducerConnection};
type Recognition={status:'supported'|'uncertain'|'unavailable'};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const text=(v:unknown)=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=256;
const closed=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
const validFeatures=(v:unknown):v is number[][]=>Array.isArray(v)&&v.length>=1&&v.length<=3&&v.every(f=>Array.isArray(f)&&f.length===128&&f.every(n=>typeof n==='number'&&Number.isFinite(n))&&Math.hypot(...f)>1e-8);

/** Verify configured code bytes through owned canonical FDs. This protects other
 * UIDs and accidental replacement, not hostile same-UID/kernel compromise. */
function code(path:string,digest:string,maximum:number,rootExecutable=false):boolean{
 let fd:number|undefined;try{
  if(!isAbsolute(path)||realpathSync(path)!==path||! /^[a-f0-9]{64}$/.test(digest))return false;
  const before=lstatSync(path);fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);
  if(!s.isFile()||s.uid!==process.getuid?.()&&!(rootExecutable&&s.uid===0)||s.mode&0o022||rootExecutable&&!(s.mode&0o111)||s.size<1||s.size>maximum||before.dev!==s.dev||before.ino!==s.ino)return false;
  const sha=createHash('sha256'),buffer=Buffer.alloc(65536);let size=0,n;
  while((n=readSync(fd,buffer,0,buffer.length,null))>0){size+=n;if(size>maximum)return false;sha.update(buffer.subarray(0,n));}
  const end=fstatSync(fd),after=lstatSync(path);return size===s.size&&sha.digest('hex')===digest&&[end,after].every(x=>x.ino===s.ino&&x.dev===s.dev&&x.size===s.size&&x.mtimeMs===s.mtimeMs&&x.mode===s.mode)&&realpathSync(path)===path;
 }catch{return false;}finally{if(fd!==undefined)closeSync(fd);}
}

type ExecutionTuple={worker:string;recognizer:string;python:string;workerSha256:string;recognizerSha256:string;pythonSha256:string};
type PythonScope={source:object;token:object;producer:object;retire:()=>void;attempted:boolean;unavailable:boolean;poisoned:boolean;tuple?:ExecutionTuple;fd?:number;stat?:BigIntStats};
const actualCompositions=new WeakMap<object,UbuntuPresenceComposition>();
const executionScopes=new WeakMap<UbuntuPresenceComposition,PythonScope>();
const actualUid=process.getuid?.bind(process),actualEuid=process.geteuid?.bind(process);
function unprivileged():boolean{
 let fd:number|undefined;try{const uid=actualUid?.(),euid=actualEuid?.();if(uid===undefined||euid===undefined||uid===0||euid===0)return false;fd=openSync('/proc/self/status',constants.O_RDONLY|constants.O_NOFOLLOW);const buffer=Buffer.alloc(4096);let text='',n=0;for(let i=0;i<4;i++){n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;text+=buffer.subarray(0,n).toString('utf8');}if(n!==0)return false;const rows=text.split('\n').filter(x=>x.startsWith('CapEff:'));return rows.length===1&&/^CapEff:\s+0{16}$/.test(rows[0]!);}catch{return false;}finally{if(fd!==undefined)try{closeSync(fd);}catch{}}
}
const pythonFields=['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'] as const;
function rootParents(path:string):boolean{try{let current=dirname(path);for(let i=0;i<32;i++){const s=lstatSync(current,{bigint:true});if(!s.isDirectory()||s.uid!==0n||(s.mode&0o022n)!==0n||realpathSync(current)!==current)return false;if(current==='/')return true;current=dirname(current);}return false;}catch{return false;}}
function tuple(e:unknown):ExecutionTuple|null{
 try{if(!e||typeof e!=='object')return null;const d=Object.getOwnPropertyDescriptors(e),names=['worker','python','workerSha256','recognizerSha256','pythonSha256'];if(!names.every(k=>Object.hasOwn(d[k]??{},'value')&&typeof d[k]!.value==='string')||!Object.hasOwn(d.revision??{},'value')||!positive(d.revision!.value)||!Object.hasOwn(d.model??{},'value'))return null;const model=d.model!.value;if(!model||typeof model!=='object')return null;const m=Object.getOwnPropertyDescriptors(model);if(!Object.hasOwn(m.runtimeVersion??{},'value')||m.runtimeVersion!.value!=='4.12.0'||!Object.hasOwn(m.provenanceApproved??{},'value')||m.provenanceApproved!.value!==true)return null;return {worker:d.worker!.value,recognizer:join(dirname(d.worker!.value),'local-presence-recognizer.py'),python:d.python!.value,workerSha256:d.workerSha256!.value,recognizerSha256:d.recognizerSha256!.value,pythonSha256:d.pythonSha256!.value};}catch{return null;}
}
function complete(t:ExecutionTuple):boolean{return basename(t.worker)==='ubuntu-presence-worker.py'&&code(t.worker,t.workerSha256,65536)&&code(t.recognizer,t.recognizerSha256,65536)&&code(t.python,t.pythonSha256,64*1024*1024,true);}
function pythonCurrent(s:PythonScope,path:string,digest:string):boolean{
 try{if(s.fd===undefined||!s.stat||!s.tuple||path!==s.tuple.python||digest!==s.tuple.pythonSha256||!unprivileged()||!isAbsolute(path)||realpathSync(path)!==path||!rootParents(path))return false;const fd=fstatSync(s.fd,{bigint:true}),now=lstatSync(path,{bigint:true});return fd.isFile()&&now.isFile()&&fd.uid===0n&&(fd.mode&0o022n)===0n&&(fd.mode&0o111n)!==0n&&fd.size>0n&&fd.size<=BigInt(64*1024*1024)&&pythonFields.every(k=>fd[k]===s.stat![k]&&now[k]===s.stat![k]);}catch{return false;}
}
function pythonCode(composition:UbuntuPresenceComposition,e:unknown,path:string,digest:string):boolean{
 const s=executionScopes.get(composition);if(!s||s.poisoned||s.unavailable)return code(path,digest,64*1024*1024,true);
 if(!s.attempted){s.attempted=true;const t=tuple(e);if(!t||t.python!==path||t.pythonSha256!==digest||!unprivileged()||!rootParents(path)){s.unavailable=true;return code(path,digest,64*1024*1024,true);}try{const stat=lstatSync(path,{bigint:true});if(!stat.isFile()||stat.uid!==0n||(stat.mode&0o022n)!==0n||(stat.mode&0o111n)===0n){s.unavailable=true;return code(path,digest,64*1024*1024,true);}if(!complete(t)){s.poisoned=true;return false;}s.tuple=t;s.fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);s.stat=stat;}catch{s.poisoned=true;return false;}}
 if(!pythonCurrent(s,path,digest)){s.poisoned=true;return false;}return true;
}
/** Fixed Source membership and actual constructor pairing; no supplied body/controller. */
export function beginCanonicalPresenceExecutionScope(source:object,token:object,producer:object):boolean{
 if(!matchesCanonicalSourceExecutionScope(source,token,producer))return false;const c=actualCompositions.get(producer);if(!c)return false;const active=executionScopes.get(c);if(active){active.poisoned=true;return false;}const retire=captureCanonicalQualifiedPresenceProducerRetirement(producer);if(!retire)return false;executionScopes.set(c,{source,token,producer,retire,attempted:false,unavailable:false,poisoned:false});return true;
}
/** Terminal proofs are captured scalars; no manifest/current/clock re-query. */
export function finishCanonicalPresenceExecutionScope(source:object,token:object,producer:object):boolean{
 if(!matchesCanonicalSourceExecutionScope(source,token,producer))return false;const c=actualCompositions.get(producer),s=c&&executionScopes.get(c);if(!c||!s||s.source!==source||s.token!==token)return true;let accepted=!s.poisoned;
 try{if(s.tuple)accepted=accepted&&pythonCurrent(s,s.tuple.python,s.tuple.pythonSha256)&&complete(s.tuple);}catch{accepted=false;}finally{if(s.fd!==undefined){try{closeSync(s.fd);}catch{accepted=false;}delete s.fd;}if(executionScopes.get(c)===s)executionScopes.delete(c);}
 if(!accepted)s.retire();return accepted;
}

/** Explicit internal composition; absent configuration is unavailable. No route,
 * installer, permission prompt, native attestation, camera or provider activation.
 * Authenticated frame submission does NOT prove physical camera provenance.
 * QualifiedPresenceProducer's attestationRevision here identifies this actual
 * server custody-verification manifest, never the parked native channel profile. */
export class UbuntuPresenceComposition {
 readonly producer:QualifiedPresenceProducer;
 private readonly options:UbuntuPresenceOptions|null;private readonly now:()=>number;private readonly mono:()=>number;
 private readonly operations=new Map<object,Operation>();private readonly channels=new Map<object,Operation>();
 private readonly observations=new Map<object,Observation>();private readonly observationChannels=new Map<object,Observation>();
 private generation=0;private closed=false;private worker:ChildProcessWithoutNullStreams|undefined;private workerOperation:Operation|undefined;private stopWorker:(()=>void)|undefined;private busy=false;private lastUtc=-Infinity;private lastMono=-Infinity;
 constructor(options:UbuntuPresenceOptions|null=null){
  this.options=options;this.now=options?.now??Date.now;this.mono=options?.monotonicMs??(()=>performance.now());
  this.producer=new QualifiedPresenceProducer(options?{authentication:options.authentication,verify:(channel,context)=>this.verify(channel,context),owner:options.owner,now:this.now,monotonicMs:this.mono}:null);actualCompositions.set(this.producer,this);
 }
 private clocks(){const utc=this.now(),mono=this.mono();if(![utc,mono].every(Number.isFinite)||utc<this.lastUtc||mono<this.lastMono)throw Error('CLOCK_INVALID');this.lastUtc=utc;this.lastMono=mono;return {utc,mono};}
 private execution(){const e=this.options?.execution;return !!e&&positive(e.revision)&&basename(e.worker)==='ubuntu-presence-worker.py'&&code(e.worker,e.workerSha256,65536)&&code(join(dirname(e.worker),'local-presence-recognizer.py'),e.recognizerSha256,65536)&&pythonCode(this,e,e.python,e.pythonSha256)&&e.model?.runtimeVersion==='4.12.0'&&e.model.provenanceApproved===true;}
 private selected(sessionId:string,purpose:Purpose):{context:LocalContext;selection:UbuntuPresenceSelection}|null{
  try{if(this.closed||!this.options||!this.execution())return null;const context=this.options.authentication.hostSessionContext(sessionId);this.options.authentication.assertCurrent(context,false);
   const raw=this.options.selection(context,purpose);if(!raw)return null;const s=structuredClone(raw),b=s.binding;
   if(!closed(s,['binding','actorId','endpointRevision','registrationRevision','deviceName','permission','foregroundVisible','consentRevision','enrollmentConsent','recognitionConsent','retentionExpiresAt','enrollmentCurrent'])||!b||!closed(b,['scope','sessionId','endpointId','siteRef','zoneRef','resourceId','cameraSourceId','identitySourceId','enrollmentRef','enrollmentRevision','captureLeaseId','captureFence','configurationRevision'])||!closed(b.scope,['assistantId','userId','relationshipId','deploymentId'])||![...Object.values(b.scope),b.sessionId,b.endpointId,b.siteRef,b.zoneRef,b.resourceId,b.cameraSourceId,b.identitySourceId,b.enrollmentRef,b.captureLeaseId,b.captureFence,s.actorId].every(text)||b.cameraSourceId===b.identitySourceId||![b.enrollmentRevision,b.configurationRevision,s.endpointRevision,s.registrationRevision,s.consentRevision].every(positive)||s.actorId!==context.principalId||b.sessionId!==context.sessionId||b.scope.userId!==(context.effectiveContext?.effectiveUserId??context.principalId)||s.deviceName!=='AnkerWork B600 Video Bar'||s.permission!=='granted'||s.foregroundVisible!==true||s.enrollmentConsent!==true||purpose==='persistentPresence'&&(s.recognitionConsent!==true||s.enrollmentCurrent!==true)||!Number.isFinite(s.retentionExpiresAt)||s.retentionExpiresAt<=this.now())return null;
   const r=this.options.broker.resource(b.resourceId);if(r.resourceId!==b.resourceId||r.kind!=='camera'||r.health!=='healthy'||r.removed||r.permissionStatus!=='granted'||!r.capabilities.includes('capture'))return null;
   this.options.authentication.assertCurrent(context,false);return this.closed?null:{context,selection:s};
  }catch{return null;}
 }
 prepare(sessionId:string,purpose:Purpose):object|null{
  let lease:CameraResourceLease|undefined;
  try{if(!['identityEnrollment','persistentPresence'].includes(purpose)||this.operations.size>=4||!this.options)return null;
   const generation=this.generation,start=this.clocks(),s=this.selected(sessionId,purpose);if(!s||generation!==this.generation)return null;
   // Existing broker arbitration uses capture, with a distinct host purpose owner.
   const leaseOwner=`ubuntu-presence:${purpose}:${randomBytes(16).toString('hex')}`,executionKey=hash(this.options.execution);if(this.operations.size>=4)return null;
   lease=this.options.broker.acquireLease({resourceId:s.selection.binding.resourceId,operation:'capture',owner:leaseOwner,ttlMs:Math.max(1,Math.min(5000,Math.floor(s.selection.retentionExpiresAt-start.utc)))});
   const end=this.clocks(),authorityExpiresAt=Math.min(lease.expiresAt,start.utc+5000);if(this.closed||generation!==this.generation||this.operations.size>=4||lease.owner!==leaseOwner||executionKey!==hash(this.options.execution)||lease.resourceId!==s.selection.binding.resourceId||lease.operation!=='capture'||lease.status!=='active'||authorityExpiresAt<=end.utc||lease.expiresAt>end.utc+5000||!text(lease.leaseId)||!text(lease.fencingToken))throw Error('LEASE_INVALID');
   const b=s.selection.binding,e=this.options.execution.model,handle=Object.freeze({});const grant:UbuntuPresenceGrant={purpose,sessionId,actorId:s.context.principalId,endpointId:b.endpointId,resourceId:b.resourceId,siteRef:b.siteRef,zoneRef:b.zoneRef,enrollmentRef:b.enrollmentRef,enrollmentRevision:b.enrollmentRevision,consentRevision:s.selection.consentRevision,registrationRevision:s.selection.registrationRevision,modelRevision:e.modelRevision,calibrationRevision:e.calibration.revision,captureLeaseId:lease.leaseId,captureFence:lease.fencingToken,authorityExpiresAt,expiresAt:s.selection.retentionExpiresAt};
   const op:Operation={handle,...s,purpose,lease:structuredClone(lease),grant,executionKey,until:start.mono+authorityExpiresAt-start.utc,generation,closed:false,consumed:false};this.operations.set(handle,op);
   if(!this.current(op)){this.release(handle);return null;}return handle;
  }catch{if(lease)try{this.options?.broker.releaseLease({leaseId:lease.leaseId,fencingToken:lease.fencingToken});}catch{}return null;}
 }
 /** Foreground source owner only. Does not start media, worker, enrollment or keys. */
 openObservation(sessionId:string):object|null{
  if(!this.options?.observation||this.closed||this.observations.size>=4)return null;
  const handle=Object.freeze({}),channel=Object.freeze({}),generation=this.generation;
  const owner=new UbuntuPresenceObservationSession({broker:this.options.broker,leaseTtlMs:this.options.observation.leaseTtlMs,now:this.now,monotonicMs:this.mono,
   snapshot:()=>this.observationSnapshot(sessionId),onWithdraw:()=>this.closeObservation(handle)});
  const observation={handle,sessionId,owner,channel};this.observations.set(handle,observation);this.observationChannels.set(channel,observation);
  if(!owner.open()||this.closed||generation!==this.generation||this.observations.get(handle)!==observation){this.closeObservation(handle);return null;}return handle;
 }
 private observationSnapshot(sessionId:string):UbuntuObservationSnapshot|null{
  const selected=this.selected(sessionId,'persistentPresence');return selected&&this.options?{binding:structuredClone(selected.selection.binding),contextKey:hash(selected.context),selectionKey:hash(selected.selection),executionKey:hash([this.options.execution,this.options.observation]),retentionExpiresAt:selected.selection.retentionExpiresAt,actorId:selected.context.principalId,endpointRevision:selected.selection.endpointRevision,registrationRevision:selected.selection.registrationRevision,modelRevision:this.options.execution.model.modelRevision}:null;
 }
 prepareObservation(handle:object):object|null{
  const observation=this.observations.get(handle);if(!observation||!this.options||this.closed||this.operations.size>=4||this.busy||this.worker)return null;
  const frame=observation.owner.begin();if(!frame)return null;
  try{const selected=this.selected(observation.sessionId,'persistentPresence'),capture=observation.owner.read();if(!selected||!capture||capture.snapshot.contextKey!==hash(selected.context)||capture.snapshot.selectionKey!==hash(selected.selection)||this.observations.get(handle)!==observation)return null;
   const b=selected.selection.binding,e=this.options.execution.model,opHandle=Object.freeze({}),lease=capture.lease;
   const grant:UbuntuPresenceGrant={purpose:'persistentPresence',sessionId:observation.sessionId,actorId:selected.context.principalId,endpointId:b.endpointId,resourceId:b.resourceId,siteRef:b.siteRef,zoneRef:b.zoneRef,enrollmentRef:b.enrollmentRef,enrollmentRevision:b.enrollmentRevision,consentRevision:selected.selection.consentRevision,registrationRevision:selected.selection.registrationRevision,modelRevision:e.modelRevision,calibrationRevision:e.calibration.revision,captureLeaseId:lease.leaseId,captureFence:lease.fencingToken,authorityExpiresAt:frame.expiresAt,expiresAt:selected.selection.retentionExpiresAt};
   const op:Operation={handle:opHandle,...selected,purpose:'persistentPresence',lease,grant,executionKey:hash(this.options.execution),until:frame.until,generation:this.generation,closed:false,consumed:false,observation:{handle,frame:frame.handle}};
   this.operations.set(opHandle,op);if(!this.current(op)){this.release(opHandle);return null;}return opHandle;
  }finally{if(![...this.operations.values()].some(op=>op.observation?.handle===handle&&op.observation.frame===frame.handle))observation.owner.finish(frame.handle);}
 }
 renewObservation(handle:object):boolean{
  const observation=this.observations.get(handle);if(!observation||this.busy||this.worker||[...this.operations.values()].some(op=>op.observation?.handle===handle))return false;
  if(!observation.owner.renew()||this.observations.get(handle)!==observation){this.closeObservation(handle);return false;}
  // Re-admit the original producer on the actual renewed expiry. Evidence is
  // unavailable until a fresh result; original sequence custody remains intact.
  observation.connection?.close();delete observation.connection;return true;
 }
 closeObservation(handle:object):void{
  const observation=this.observations.get(handle);if(!observation)return;this.observations.delete(handle);this.observationChannels.delete(observation.channel);
  observation.connection?.close();for(const op of [...this.operations.values()])if(op.observation?.handle===handle)this.release(op.handle);observation.owner.close();
 }
 private current(op:Operation):boolean{
  try{if(!this.options||this.closed||op.closed||this.operations.get(op.handle)!==op||op.generation!==this.generation)return false;
   const start=this.clocks();if(start.utc>=Math.min(op.grant.authorityExpiresAt,op.grant.expiresAt)||start.mono>=op.until)return false;
   const selected=this.selected(op.context.sessionId,op.purpose);if(!selected||hash(selected.context)!==hash(op.context)||hash(selected.selection)!==hash(op.selection))return false;
   const lease=this.options.broker.lease(op.lease.leaseId);this.options.broker.assertLease(lease,op.lease.fencingToken);
   if(op.observation&&!this.observations.get(op.observation.handle)?.owner.currentFrame(op.observation.frame))return false;
   const frameOkay=!op.frameCurrent||op.frameCurrent()===true;
   const end=this.clocks();return frameOkay&&!this.closed&&!op.closed&&hash(this.options.execution)===op.executionKey&&this.operations.get(op.handle)===op&&lease.status==='active'&&hash(lease)===hash(op.lease)&&end.utc<Math.min(op.grant.authorityExpiresAt,op.grant.expiresAt)&&end.mono<op.until;
  }catch{return false;}
 }
 private authority(op:Operation):PresenceProducerAuthority{
  return {binding:{...structuredClone(op.selection.binding),captureLeaseId:op.lease.leaseId,captureFence:op.lease.fencingToken},actorId:op.context.principalId,endpointRevision:op.selection.endpointRevision,registrationRevision:op.selection.registrationRevision,attestationRevision:this.options!.execution.revision,modelRevision:op.grant.modelRevision,purpose:'persistentPresence',permission:'granted',consentCurrent:true,enrollmentCurrent:true,leaseExpiresAt:op.grant.authorityExpiresAt};
 }
 operationCapture(handle:object):UbuntuOperationCapture|null{
  const op=this.operations.get(handle);if(!op||!this.current(op))return null;
  const captured=structuredClone({context:op.context,grant:op.grant,binding:op.selection.binding,lease:op.lease,untilMonotonicMs:op.until});
  return this.operations.get(handle)===op&&this.current(op)&&hash(captured)===hash({context:op.context,grant:op.grant,binding:op.selection.binding,lease:op.lease,untilMonotonicMs:op.until})?captured:null;
 }
 /** Explicit authenticated setup action, separate from template confirmation.
  * No frame, worker, credential or permission is created by this operation. */
 confirmPurpose(handle:object,consent:{enrollment:true;recognition:boolean}):boolean{
  const op=this.operations.get(handle);if(!op||op.purpose!=='identityEnrollment'||!this.options||!closed(consent,['enrollment','recognition'])||consent.enrollment!==true||typeof consent.recognition!=='boolean'||!this.current(op))return false;
  try{return this.options.enrollment.confirmPurpose(structuredClone(op.grant),structuredClone(consent),()=>this.current(op))===true&&this.current(op);}catch{return false;}
 }
 private verify(channel:object,context:LocalContext):PresenceProducerAuthority|null{
  const observation=this.observationChannels.get(channel);if(observation&&this.options){const capture=observation.owner.read();if(!capture||capture.snapshot.contextKey!==hash(context)||this.observationChannels.get(channel)!==observation)return null;const b=capture.snapshot.binding,e=this.options.execution;
   return {binding:{...b,captureLeaseId:capture.lease.leaseId,captureFence:capture.lease.fencingToken},actorId:capture.snapshot.actorId,endpointRevision:capture.snapshot.endpointRevision,registrationRevision:capture.snapshot.registrationRevision,attestationRevision:e.revision,modelRevision:capture.snapshot.modelRevision,purpose:'persistentPresence',permission:'granted',consentCurrent:true,enrollmentCurrent:true,leaseExpiresAt:Math.min(capture.lease.expiresAt,capture.snapshot.retentionExpiresAt)};
  }
  const op=this.channels.get(channel);if(!op||op.purpose!=='persistentPresence'||hash(context)!==hash(op.context)||!this.current(op)||this.channels.get(channel)!==op)return null;return this.authority(op);
 }
 private async execute(op:Operation,frame:UbuntuPresenceFrame,templates:unknown):Promise<Record<string,unknown>|null>{
  if(!this.options||this.busy||this.worker||op.consumed||!this.current(op)||!closed(frame,['bytes','observedAt','receivedAt','captureLeaseId','captureFence','sourceId','configurationRevision'])||!(frame.bytes instanceof Uint8Array)||frame.bytes.byteLength<4||frame.bytes.byteLength>2*1024*1024||![frame.observedAt,frame.receivedAt].every(Number.isFinite)||frame.observedAt>frame.receivedAt||frame.receivedAt>this.now()||this.now()-frame.observedAt>=5000||frame.captureLeaseId!==op.lease.leaseId||frame.captureFence!==op.lease.fencingToken||frame.sourceId!==op.selection.binding.cameraSourceId||frame.configurationRevision!==op.selection.binding.configurationRevision)return null;
  try{if(this.options.frameCurrent(frame,structuredClone(op.grant))!==true||op.consumed||!this.current(op))return null;}catch{return null;}
  op.consumed=true;op.frameCurrent=()=>this.options?.frameCurrent(frame,structuredClone(op.grant))===true;this.busy=true;const e=this.options.execution,id=randomBytes(32).toString('hex'),jpeg=Buffer.from(frame.bytes),grant={purpose:op.purpose,sessionId:op.grant.sessionId,actorId:op.grant.actorId,endpointId:op.grant.endpointId,resourceId:op.grant.resourceId,siteRef:op.grant.siteRef,zoneRef:op.grant.zoneRef,captureLeaseId:op.grant.captureLeaseId,captureFence:op.grant.captureFence,enrollmentRef:op.grant.enrollmentRef,enrollmentRevision:op.grant.enrollmentRevision,modelRevision:op.grant.modelRevision,calibrationRevision:op.grant.calibrationRevision,observedAt:frame.observedAt,expiresAt:Math.min(frame.observedAt+5000,op.grant.authorityExpiresAt,op.grant.expiresAt)};
  const control=Buffer.from(JSON.stringify({operationId:id,manifest:e.model,grant,templates:templates?{confirmed:true,grant,features:templates}:null}));
  if(control.length>32768){control.fill(0);jpeg.fill(0);delete op.frameCurrent;this.busy=false;return null;}
  let child:ChildProcessWithoutNullStreams;
  try{child=spawn(e.python,['-I',e.worker,'--recognizer-sha256',e.recognizerSha256],{stdio:['pipe','pipe','pipe'],env:{LANG:'C.UTF-8'},cwd:dirname(e.worker)});this.worker=child;this.workerOperation=op;}catch{control.fill(0);jpeg.fill(0);delete op.frameCurrent;this.busy=false;return null;}
  // Exactly one owned child. Failed closure retains ownership and denies new work.
  return await new Promise<Record<string,unknown>|null>(resolve=>{
   let settled=false,ended=false,invalid=false,result:Record<string,unknown>|null=null,line=Buffer.alloc(0),sequence=0,rows=0,stderrBytes=0;
   const wipe=()=>{jpeg.fill(0);control.fill(0);line.fill(0);delete op.frameCurrent;};
   const finish=()=>{clearTimeout(timeout);clearTimeout(kill);clearTimeout(reap);const okay=!settled&&!invalid&&ended&&line.length===0&&this.current(op);wipe();if(this.worker===child){this.worker=undefined;this.workerOperation=undefined;this.stopWorker=undefined;this.busy=false;}if(!settled){settled=true;resolve(okay?result:null);}};
   const terminate=()=>{invalid=true;ended=false;result=null;try{child.kill('SIGTERM');}catch{}if(!kill)kill=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}
    // Rejection is bounded even when the OS cannot confirm closure. Only the
    // exact close event releases owned-child/busy custody; never spawn around it.
    reap=setTimeout(()=>{if(!settled){settled=true;wipe();resolve(null);}},100);
   },100);};
   const timeout=setTimeout(terminate,Math.max(1,Math.min(op.until-this.mono(),op.grant.authorityExpiresAt-this.now())));let kill:ReturnType<typeof setTimeout>|undefined,reap:ReturnType<typeof setTimeout>|undefined;
   this.stopWorker=terminate;
   child.once('error',()=>{terminate();});child.once('close',(exit)=>{if(exit!==0)result=null;finish();});child.stderr.on('data',chunk=>{stderrBytes+=Buffer.byteLength(chunk);if(stderrBytes>8192)terminate();});
   child.stdin.on('error',()=>terminate());
   child.stdout.on('data',(chunk:Buffer)=>{
    if(settled||invalid)return;if(ended||chunk.length>16384||line.length+chunk.length>16384){terminate();return;}line=Buffer.concat([line,chunk]);
    for(let newline;(newline=line.indexOf(10))>=0;){const bytes=line.subarray(0,newline);line=line.subarray(newline+1);if(bytes.length>8192||++rows>129){terminate();return;}
     let value:unknown;try{value=JSON.parse(bytes.toString());}catch{terminate();return;}
     if(closed(value,['kind','operationId','sequence'])&&value.kind==='current'&&value.operationId===id&&value.sequence===sequence+1&&sequence<128&&!ended){sequence++;
      const allowed=this.current(op);child.stdin.write(JSON.stringify({kind:'current',operationId:id,sequence,allowed})+'\n');if(!allowed)terminate();
     }else if(closed(value,['kind','operationId','result'])&&value.kind==='result'&&value.operationId===id&&!ended&&value.result&&typeof value.result==='object'&&!Array.isArray(value.result)){
      ended=true;result=value.result as Record<string,unknown>;child.stdin.end();
     }else{terminate();return;}
     if(ended&&line.length){terminate();return;}
    }
   });
   const a=Buffer.alloc(4),b=Buffer.alloc(4);a.writeUInt32BE(control.length);b.writeUInt32BE(jpeg.length);child.stdin.write(a);child.stdin.write(control);child.stdin.write(b);child.stdin.write(jpeg);
  });
 }
 async recognize(handle:object,frame:UbuntuPresenceFrame):Promise<Recognition>{
  const op=this.operations.get(handle);if(!op||op.purpose!=='persistentPresence'||!this.options||!this.current(op))return {status:'unavailable'};
  const loaded=await this.options.enrollment.load(structuredClone(op.grant),()=>this.current(op));
  if(!loaded||loaded.confirmed!==true||hash(loaded.grant)!==hash(op.grant)||!validFeatures(loaded.features)||!this.current(op))return {status:'unavailable'};
  let result:Record<string,unknown>|null;try{result=await this.execute(op,frame,loaded.features);}finally{for(const f of loaded.features)f.fill(0);}
  if(!result||!closed(result,['status'])||!['supported','uncertain','unavailable'].includes(String(result.status))||!this.current(op))return {status:'unavailable'};
  if(result.status==='unavailable')return {status:'unavailable'};
  const camera=this.options.coverage?.(structuredClone(op.selection.binding))??{coverageKnown:false,occupants:0};
  if(!closed(camera,['coverageKnown','occupants'])||typeof camera.coverageKnown!=='boolean'||!Number.isInteger(camera.occupants)||camera.occupants<0||camera.occupants>100||!this.current(op))return {status:'unavailable'};
  const observation=op.observation?this.observations.get(op.observation.handle):undefined;
  if(op.observation&&!observation)return {status:'unavailable'};
  if(observation){if(!observation.connection){const connection=this.producer.open(observation.channel,op.context.sessionId);if(connection)observation.connection=connection;}}
  else if(!op.channel){op.channel=Object.freeze({});this.channels.set(op.channel,op);const connection=this.producer.open(op.channel,op.context.sessionId);if(connection)op.connection=connection;}
  const connection=observation?.connection??op.connection,challenge=connection?.challenge();if(!challenge||!this.current(op))return {status:'unavailable'};
  const okay=connection!.admit(JSON.stringify({capabilityId:challenge.capabilityId,nonce:challenge.nonce,sequence:challenge.sequence,observedAt:this.now(),expiresAt:Math.min(challenge.expiresAt,op.grant.authorityExpiresAt),camera,identity:{status:result.status}}));
  return okay?{status:result.status as 'supported'|'uncertain'}:{status:'unavailable'};
 }
 async enroll(handle:object,frame:UbuntuPresenceFrame,confirmation:{confirmed:true;indices:number[]}):Promise<unknown>{
  const op=this.operations.get(handle);if(!op||op.purpose!=='identityEnrollment'||!this.options||!closed(confirmation,['confirmed','indices'])||confirmation.confirmed!==true||!Array.isArray(confirmation.indices)||confirmation.indices.length!==1||confirmation.indices[0]!==0||!this.current(op))return null;
  const result=await this.execute(op,frame,null);if(!result||!closed(result,['status','feature'])||result.status!=='feature'||!validFeatures([result.feature])||!this.current(op))return null;
  const feature=result.feature as number[],features=[feature];try{return await this.options.enrollment.enroll(structuredClone(op.grant),features,structuredClone(confirmation),()=>this.current(op));}finally{feature.fill(0);}
 }
 /** Explicit current host setup/removal authority; no frame, worker or key
  * acquisition. The owner durably fences before acknowledgement/key deletion. */
 async revoke(handle:object):Promise<unknown>{
  const op=this.operations.get(handle);if(!op||op.purpose!=='identityEnrollment'||!this.options||!this.current(op))return null;
  return await this.options.enrollment.revoke(structuredClone(op.grant),()=>this.current(op));
 }
 release(handle:object):void{
  const op=this.operations.get(handle);if(!op)return;op.closed=true;this.operations.delete(handle);op.connection?.close();if(op.channel)this.channels.delete(op.channel);
  if(this.workerOperation===op)this.stopWorker?.();
  if(op.observation)this.observations.get(op.observation.handle)?.owner.finish(op.observation.frame);
  else try{this.options?.broker.releaseLease({leaseId:op.lease.leaseId,fencingToken:op.lease.fencingToken});}catch{}
 }
 close():void{if(this.closed)return;this.closed=true;this.generation++;for(const observation of [...this.observations.values()])this.closeObservation(observation.handle);for(const op of [...this.operations.values()])this.release(op.handle);this.producer.close();this.stopWorker?.();}
}
