import {ordinaryEntryFrameMatches} from '@lifestream/contracts/game-host';
import {ORDINARY_GAME_SESSION_LIMITS} from '@lifestream/contracts/game-host';
import {captureFrameApproval,type FrameApprovalCapture} from './native-source-witness.ts';
import {captureGameSanityTiming,type GameSanityTiming,type GameSanityTimingInput} from './game-sanity-timing.ts';
import {captureNativeSource,nativeSourceAge,nativeSourceException,type NativeSourceCapture,type NativeSourceWitness} from './native-source-witness.ts';
import {nativeExecutionLifetimeCurrent,nativeExecutionSessionScoped,nativeExecutionLifetimeSignal,nativeExecutionCustodyBounds,type NativeExecutionLifetime} from './native-execution-lifetime.ts';
import {DESKTOP_SESSION_LIMITS} from '@lifestream/contracts/desktop-session';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,existsSync,openSync,fstatSync,readSync,closeSync,constants,type BigIntStats} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {ChildProcess} from 'node:child_process';
import type * as G from '@lifestream/contracts/game-activity';
import type {GameActivityAdapter} from './port.js';
import type {GameFrameCustody} from './frame-custody.js';
import type {LiveFrameDecoder} from './live-frame-decoder.js';
import type {NativeFrameDecoder} from './native-host.js';
type FrameDecoder=Pick<LiveFrameDecoder,'revision'|'manifestDigest'|'decode'>&{capture?:()=>LiveFrameDecoder};
type ObservationDecoderCapture={request:G.GameObserveRequest;source:G.GameObservation;decoder:FrameDecoder;expiresWall:number;expiresMono:number;configurationRef:string};
const observationSource=(o:G.GameObservation)=>({...o,visibleState:[],interpretedAt:null,providerConfigurationRef:null});

const buttons={up:'Up',down:'Down',left:'Left',right:'Right',a:'A',b:'B',x:'X',y:'Y',l:'L',r:'R',start:'Start',select:'Select'} as const;
const neutral=Object.fromEntries(Object.keys(buttons).map(key=>[key,false])) as G.GameReleaseRequest['payload']['neutralButtons'];
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sourceIdentity=(s:BigIntStats)=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs] as const;
const sameSourceIdentity=(a:readonly bigint[],b:readonly bigint[])=>a.length===b.length&&a.every((v,i)=>v===b[i]);
type NativeAction={requestId:string;correlationId:string;inputOwnerLeaseId:string;startedMonotonicMs:number;completedMonotonicMs:number;verifiedInputFrames:number;requestedButtons:G.GameActionRequest['payload']['buttonVector'];receipt:G.GameActionReceipt};
type NativeSnapshot={schemaVersion:string;recordType:string;scope:G.ActivityScope;pinsDigest:string;providerRef:string;version:string;system:string;romSha1:string;sequence:number;frameNumber:number;monotonicMs:number;checkedAt:string;paused:boolean;buttonsAvailable:boolean;buttons:Record<string,boolean>;lastObservation?:G.GameObserveResult;lastAction?:NativeAction;lastActionResult?:G.GameActionResult;actionStarted?:{actionId:string;inputOwnerLeaseId:string};lastRelease?:G.GameReleaseResult;event:string};
export type NativeGameEvidenceOptions={sanityTiming?:GameSanityTimingInput;directory:string;scope:G.ActivityScope;pinsDigest:string;providerRef:string;romSha1:string;sourceFiles:readonly {path:string;sha256:string}[];custody:GameFrameCustody;decoder?:FrameDecoder;sessionDurationMs:number;executionLifetime?:NativeExecutionLifetime;isCurrent:(scope:G.ActivityScope)=>boolean;ownedCustodyCurrent?:(capture?:NativeSourceCapture)=>boolean};

/** Concrete native readback ports for an owned graphical child. Native writes
 * the fixed evidence file; wire assertions and schema-valid results alone cannot
 * qualify an action. This supplies no capability claim or memory consent. */
export class NativeGameEvidence{
 readonly evidenceFile:string;
 private readonly sanityTiming:GameSanityTiming;
 private readonly options:Readonly<NativeGameEvidenceOptions>;
 // Immutable policy classification only; never a cached lifetime/currentness result.
 private readonly sessionScoped:boolean;
 private child:ChildProcess|undefined;private readonly expiresMono:number;private readonly expiresWall:number;
 private lastSequence=0;private lastMono=0;private readonly receipts=new Map<string,NativeAction>();
 // At most the original sixteen source paths. This remembers a stable FD hash,
 // never authentication, native inspection, lease, process or evidence currency.
 private readonly sourceQualifications=new Map<string,readonly bigint[]>();
 // Both authenticated-native and outer-host guards validate the same result.
 // Retain only its exact decoder binding through the original finite request;
 // this is interpretation provenance, never cached source/approval authority.
 private readonly observationDecoders=new Map<string,ObservationDecoderCapture>();
 private captureRequired=false;
 private pruneObservationDecoders():void{for(const [id,value] of this.observationDecoders)if(Date.now()>=value.expiresWall||performance.now()>=value.expiresMono)this.observationDecoders.delete(id);}
 private matchesObservationDecoder(value:ObservationDecoderCapture,request:G.GameObserveRequest,observation:G.GameObservation):boolean{
  return Date.now()<value.expiresWall&&performance.now()<value.expiresMono&&isDeepStrictEqual(value.request,request)&&isDeepStrictEqual(value.source,observationSource(observation));
 }
 captureObservationDecoder=(request:G.GameObserveRequest,observation:G.GameObservation):NativeFrameDecoder=>{
  this.pruneObservationDecoders();
  if(this.observationDecoders.size>=32&&this.sessionScoped)this.observationDecoders.delete(this.observationDecoders.keys().next().value!);
  const now=Date.now(),mono=performance.now(),deadline=Date.parse(request.deadlineAt),shot=observation.screenshots[0],until=Math.min(deadline,Date.parse(shot?.expiresAt??''));
  if(!this.options.decoder||this.observationDecoders.size>=32||this.observationDecoders.has(observation.observationId)||!Number.isFinite(until)||until<=now||deadline>now+120000||observation.screenshots.length!==1||!this.sourceAvailable(request.scope,observation.pinsDigest))throw Error('Original observation decoder capture unavailable');
  const proof=this.snapshot()?.lastObservation;
  if(proof?.requestId!==request.requestId||proof.correlationId!==request.correlationId||proof.outcome.status!=='succeeded'||!isDeepStrictEqual(proof.outcome.payload?.observation,observation))throw Error('Original observation decoder source unavailable');
  const decoder=this.options.decoder.capture?.()??this.options.decoder;
  const value:ObservationDecoderCapture={request:structuredClone(request),source:structuredClone(observationSource(observation)),decoder,expiresWall:until,expiresMono:mono+(until-now),configurationRef:'live-frame:'+decoder.manifestDigest};
  if(!this.matchesObservationDecoder(value,request,observation))throw Error('Original observation decoder capture expired');
  this.captureRequired=true;this.observationDecoders.set(observation.observationId,value);
  return Object.freeze({configurationRef:value.configurationRef,decode:({request,observation,bytes})=>{
   if(this.observationDecoders.get(observation.observationId)!==value||!this.matchesObservationDecoder(value,request,observation))throw Error('Original observation decoder binding changed');
   return decoder.decode({scope:request.scope,observation,bytes,now:Date.now()});
  }});
 };
 constructor(options:NativeGameEvidenceOptions){
  this.sanityTiming=captureGameSanityTiming(options.sanityTiming);
  this.sessionScoped=!!options.executionLifetime&&nativeExecutionSessionScoped(options.executionLifetime);
  if(!isAbsolute(options.directory)||!/^[a-f0-9]{64}$/.test(options.pinsDigest)||!/^[a-f0-9]{40}$/.test(options.romSha1)||!options.sourceFiles.length||options.sourceFiles.length>16||!Number.isSafeInteger(options.sessionDurationMs)||options.sessionDurationMs<1||options.sessionDurationMs>(this.sessionScoped?ORDINARY_GAME_SESSION_LIMITS.maximumMs:600000)||typeof options.isCurrent!=='function')throw Error('Native evidence setup unavailable');
  const directory=realpathSync(options.directory);this.evidenceFile=resolve(directory,'native-evidence.json');
  if(existsSync(this.evidenceFile)||existsSync(this.evidenceFile+'.next'))throw Error('Fresh owned native evidence directory required');
  const sourceFiles=options.sourceFiles.map(file=>{if(!isAbsolute(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Native source pin unavailable');return Object.freeze({...file,path:realpathSync(file.path)});});
  this.options=Object.freeze({...options,directory,scope:structuredClone(options.scope),sourceFiles:Object.freeze(sourceFiles)});
  if(Object.hasOwn(options,'executionLifetime')&&!nativeExecutionLifetimeCurrent(options.executionLifetime!))throw Error('Original native evidence lifetime unavailable');
  const custody=options.executionLifetime?nativeExecutionCustodyBounds(options.executionLifetime):null;
  this.expiresMono=performance.now()+(custody?.remainingMs??options.sessionDurationMs);this.expiresWall=custody?Date.parse(custody.expiresAt):Date.now()+options.sessionDurationMs;
  if(!this.filesCurrent())throw Error('Native source pins changed');
 }
 bindOwnedProcess(child:ChildProcess):void{if(this.child||!child.pid||child.exitCode!==null)throw Error('Owned native child unavailable');this.child=child;}
 installationAvailable=(scope:G.ActivityScope,pins:string):boolean=>{
  try{return pins===this.options.pinsDigest&&isDeepStrictEqual(scope,this.options.scope)&&Date.now()<this.expiresWall&&performance.now()<this.expiresMono&&(!this.options.executionLifetime||nativeExecutionLifetimeCurrent(this.options.executionLifetime))&&this.options.isCurrent(scope)===true&&this.filesCurrent();}catch{return false;}
 };
 private filesCurrent(capture?:NativeSourceCapture):boolean{
  let checking='file_stat',selected:string|undefined;
  try{return this.options.sourceFiles.every(file=>{
   selected=file.path;checking='file_stat';const named=lstatSync(file.path,{bigint:true});
   const yes=(v:boolean,predicate:string)=>{if(!v){this.sourceQualifications.delete(file.path);captureNativeSource(capture,{stage:'files',predicate});}return v;};
   if(!yes((checking='file_regular',named.isFile()),'file_regular')||!yes((checking='file_symlink',!named.isSymbolicLink()),'file_symlink')||!yes((checking='file_size',named.size<=134217728n),'file_size')||!yes((checking='file_realpath',realpathSync(file.path)===file.path),'file_realpath'))return false;
   checking='file_digest';
   // Open on every use; no path/FD substitution or mutable-file TTL is trusted.
   // NONBLOCK prevents a raced replacement by a FIFO from blocking the caller.
   const fd=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    const opened=fstatSync(fd,{bigint:true}),identity=sourceIdentity(opened);
    const stable=()=>{
     const fdNow=fstatSync(fd,{bigint:true}),pathNow=lstatSync(file.path,{bigint:true});
     return fdNow.isFile()&&!fdNow.isSymbolicLink()&&pathNow.isFile()&&!pathNow.isSymbolicLink()&&sameSourceIdentity(identity,sourceIdentity(fdNow))&&sameSourceIdentity(identity,sourceIdentity(pathNow))&&realpathSync(file.path)===file.path;
    };
    if(!yes(opened.isFile()&&!opened.isSymbolicLink()&&opened.size<=134217728n&&sameSourceIdentity(sourceIdentity(named),identity)&&stable(),'file_digest'))return false;
    const previous=this.sourceQualifications.get(file.path);
    if(previous&&sameSourceIdentity(previous,identity))return true;
    this.sourceQualifications.delete(file.path);
    // A changed identity must earn a new expected-hash proof. Read only this FD,
    // bound bytes and require EOF plus unchanged named/FD metadata afterward.
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(65536);let total=0;
    for(;;){
     const count=readSync(fd,buffer,0,Math.min(buffer.length,Number(opened.size)-total+1),null);
     if(count===0)break;total+=count;
     if(!yes(BigInt(total)<=opened.size&&total<=134217728,'file_digest'))return false;
     hash.update(buffer.subarray(0,count));
    }
    if(!yes(BigInt(total)===opened.size&&hash.digest('hex')===file.sha256&&stable(),'file_digest'))return false;
    this.sourceQualifications.set(file.path,identity);return true;
   }finally{closeSync(fd);}
  });}catch(error){if(selected)this.sourceQualifications.delete(selected);captureNativeSource(capture,{stage:'files',predicate:checking,exceptionClass:nativeSourceException(error)});return false;}
 }
 private ownedScope(scope:G.ActivityScope,capture?:NativeSourceCapture):boolean{let checking='scope';const yes=(v:boolean,predicate:string)=>{if(!v)captureNativeSource(capture,{stage:'owned-scope',predicate});return v;};try{return yes((checking='scope',isDeepStrictEqual(scope,this.options.scope)),'scope')&&yes((checking='child_pid',!!this.child?.pid),'child_pid')&&yes((checking='child_exit',this.child!.exitCode===null),'child_exit')&&yes((checking='child_signal',this.child!.signalCode===null),'child_signal')&&yes((checking='owned_custody',!this.options.ownedCustodyCurrent||this.options.ownedCustodyCurrent(capture)===true),'owned_custody');}catch(error){captureNativeSource(capture,{stage:'owned-scope',predicate:checking,exceptionClass:nativeSourceException(error)});throw error;}}
 private snapshot(capture?:NativeSourceCapture):NativeSnapshot|null{
  let checking='snapshot_stat';try{
   const bad=(v:boolean,predicate:string)=>{if(v)captureNativeSource(capture,{stage:'snapshot',predicate});return v;};
   const stat=lstatSync(this.evidenceFile);if(bad((checking='snapshot_regular',!stat.isFile()),'snapshot_regular')||bad((checking='snapshot_symlink',stat.isSymbolicLink()),'snapshot_symlink')||bad((checking='snapshot_size_min',stat.size<2),'snapshot_size_min')||bad((checking='snapshot_size_max',stat.size>65536),'snapshot_size_max')||bad((checking='snapshot_realpath',realpathSync(this.evidenceFile)!==this.evidenceFile),'snapshot_realpath'))return null;
   checking='snapshot_read_parse';const value=JSON.parse(readFileSync(this.evidenceFile,'utf8')) as NativeSnapshot;
   if(bad((checking='snapshot_schema',value.schemaVersion!=='1.0.0'),'snapshot_schema')||bad((checking='snapshot_record',value.recordType!=='nativeGameEvidence'),'snapshot_record')||bad((checking='snapshot_scope',!isDeepStrictEqual(value.scope,this.options.scope)),'snapshot_scope')||bad((checking='snapshot_pins',value.pinsDigest!==this.options.pinsDigest),'snapshot_pins')||bad((checking='snapshot_provider',value.providerRef!==this.options.providerRef),'snapshot_provider')||bad((checking='snapshot_version',value.version!=='2.11.1'),'snapshot_version')||bad((checking='snapshot_system',value.system!=='SNES'),'snapshot_system')||bad((checking='snapshot_rom',value.romSha1!==this.options.romSha1),'snapshot_rom')||bad((checking='snapshot_sequence_integer',!Number.isSafeInteger(value.sequence)),'snapshot_sequence_integer')||bad((checking='snapshot_sequence_regressed',value.sequence<this.lastSequence),'snapshot_sequence_regressed')||bad((checking='snapshot_monotonic_finite',!Number.isFinite(value.monotonicMs)),'snapshot_monotonic_finite')||bad((checking='snapshot_monotonic_regressed',value.monotonicMs<this.lastMono),'snapshot_monotonic_regressed')||bad((checking='snapshot_frame_integer',!Number.isSafeInteger(value.frameNumber)),'snapshot_frame_integer')||bad((checking='snapshot_frame_negative',value.frameNumber<0),'snapshot_frame_negative')||bad((checking='snapshot_checked_finite',!Number.isFinite(Date.parse(value.checkedAt))),'snapshot_checked_finite')||bad((checking='snapshot_checked_future',Date.parse(value.checkedAt)>Date.now()),'snapshot_checked_future')||bad((checking='snapshot_buttons_available',value.buttonsAvailable!==true),'snapshot_buttons_available')||bad((checking='snapshot_buttons',Object.values(buttons).some(name=>typeof value.buttons?.[name]!=='boolean')),'snapshot_buttons'))return null;
   this.lastSequence=value.sequence;this.lastMono=value.monotonicMs;return value;
  }catch(error){captureNativeSource(capture,{stage:'snapshot',predicate:checking,exceptionClass:nativeSourceException(error)});return null;}
 }
 sourceAvailable=(scope:G.ActivityScope,pins:string,capture?:NativeSourceCapture):boolean=>{
  let checking='source_pins',first:NativeSourceWitness|undefined;const local:NativeSourceCapture=value=>{if(!first)first=value;};
  const yes=(v:boolean,predicate:string)=>{if(!v)captureNativeSource(local,{stage:'source',predicate});return v;};
  try{
   let snapshotWitness:NativeSourceWitness|undefined;const proof=this.snapshot(value=>{if(!snapshotWitness)snapshotWitness=value;});
   let proofAge=0;
   const result=yes((checking='source_pins',pins===this.options.pinsDigest),'source_pins')&&(checking='owned_custody',this.ownedScope(scope,local))&&yes((checking='source_wall_lease',Date.now()<this.expiresWall),'source_wall_lease')&&yes((checking='source_monotonic_lease',performance.now()<this.expiresMono),'source_monotonic_lease')&&yes((checking='source_execution_lifetime',!this.options.executionLifetime||nativeExecutionLifetimeCurrent(this.options.executionLifetime,local)),'source_execution_lifetime')&&yes((checking='source_current',this.options.isCurrent(scope)===true),'source_current')&&(checking='file_regular',this.filesCurrent(local))&&(()=>{if(!proof){if(snapshotWitness)local(snapshotWitness);else yes(false,'source_proof_absent');return false;}return true;})()&&yes((checking='source_proof_closed',proof!.event!=='closed'),'source_proof_closed')&&((checking='source_proof_stale',proofAge=Date.now()-Date.parse(proof!.checkedAt))<=this.sanityTiming.sourceProofFreshnessMs||(()=>{captureNativeSource(local,{stage:'source',predicate:'source_proof_stale',ageMs:nativeSourceAge(proofAge)});return false;})());
   if(!result&&first)captureNativeSource(capture,first);return result;
  }catch(error){captureNativeSource(capture,first??{stage:'source',predicate:checking,exceptionClass:nativeSourceException(error)});return false;}
 };
 /** Read-only change detection for an already owned run. This neither captures
  * a frame nor supplies controller/scene authority. Every poll keeps full custody. */
 currentFrameNumber=(scope:G.ActivityScope,pins:string):number|null=>{
  const proof=this.snapshot();return proof&&this.sourceAvailable(scope,pins)?proof.frameNumber:null;
 };
 /** Separate authenticated human PNG lane, never the native control protocol. */
 frameForReview=(scope:G.ActivityScope,pins:string,capture?:FrameApprovalCapture)=>{
  let captured=false;
  const report=(stage:string,predicate:string,exceptionClass?:string)=>{if(!capture||captured)return;captured=true;captureFrameApproval(capture,{stage,predicate,approvalPublished:false,...(exceptionClass?{exceptionClass}:{})});};
  const sourceCapture=capture?(value:NativeSourceWitness)=>report(value.stage,value.predicate,value.exceptionClass):undefined;
  if(!this.sourceAvailable(scope,pins,sourceCapture)){report('frame-source','native_source_unavailable');return null;}
  const observation=this.snapshot(sourceCapture)?.lastObservation?.outcome.payload?.observation;
  if(!observation){report('frame-source','observation_absent');return null;}
  if(observation.screenshots.length!==1){report('frame-source','screenshot_count');return null;}
  try{const frame=this.options.custody.read(observation.screenshots[0]!.mediaRef,scope);if(!isDeepStrictEqual(frame.screenshot,observation.screenshots[0])){frame.bytes.fill(0);report('frame-source','screenshot_identity');return null;}return {...frame,observation:structuredClone(observation)};}catch(error){report('frame-source','custody_read_threw',nativeSourceException(error));return null;}
 };

 /** Readback sample only: no pause command, action lease, scene interpretation
  * or gameplay qualification. Exact current original observation is required. */
 /** Normal preparation is command-quiescent while the owned game clock runs.
  * This sample proves current neutral readback and monotonic observation lineage,
  * not a scene classification, execution grant, or controller admission. */
 neutralObservationSample=(scope:G.ActivityScope,pins:string,observationId:string)=>{
  if(!this.sessionScoped||!this.sourceAvailable(scope,pins))return null;
  const proof=this.snapshot(),observation=proof?.lastObservation?.outcome.payload?.observation;
  if(!proof||!observation||observation.observationId!==observationId||proof.frameNumber<observation.frameNumber||Object.values(buttons).some(button=>proof.buttons[button]!==false))return null;
  return Object.freeze({observationId,frameNumber:proof.frameNumber,sequence:proof.sequence,monotonicMs:proof.monotonicMs,checkedAt:proof.checkedAt,paused:proof.paused===true,controlsNeutral:true,grantsAuthority:false});
 };
 pausedObservationSample=(scope:G.ActivityScope,pins:string,observationId:string)=>{
  if(!this.sourceAvailable(scope,pins))return null;
  const proof=this.snapshot(),observation=proof?.lastObservation?.outcome.payload?.observation;
  if(!proof||!observation||observation.observationId!==observationId||proof.frameNumber!==observation.frameNumber||proof.paused!==true||Object.values(buttons).some(button=>proof.buttons[button]!==false))return null;
  return Object.freeze({observationId,frameNumber:proof.frameNumber,sequence:proof.sequence,monotonicMs:proof.monotonicMs,checkedAt:proof.checkedAt,paused:true,controlsNeutral:true});
 };
 acceptObservation=(request:G.GameObserveRequest,observation:G.GameObservation):boolean=>{
  if(!this.sourceAvailable(request.scope,observation.pinsDigest))return false;
  const proof=this.snapshot()?.lastObservation,original=proof?.outcome.payload?.observation;
  if(!proof||proof.requestId!==request.requestId||proof.correlationId!==request.correlationId||proof.outcome.status!=='succeeded'||!original||observation.untrusted!==true||observation.screenshots.length!==1)return false;
  if(!isDeepStrictEqual(observationSource(original),observationSource(observation)))return false;
  this.pruneObservationDecoders();
  if(this.observationDecoders.size>=32&&this.sessionScoped)this.observationDecoders.delete(this.observationDecoders.keys().next().value!);const captured=this.observationDecoders.get(observation.observationId);
  if(captured?(!this.matchesObservationDecoder(captured,request,observation)||observation.providerConfigurationRef!==captured.configurationRef):(this.captureRequired||this.options.decoder?.capture!==undefined))return false;
  let frame:ReturnType<GameFrameCustody['read']>|undefined;
  try{
   frame=this.options.custody.read(observation.screenshots[0]!.mediaRef,request.scope);
   if(!isDeepStrictEqual(frame.screenshot,observation.screenshots[0])||digest(frame.bytes)!==frame.screenshot.sha256)return false;
   const fields=(captured?.decoder??this.options.decoder)?.decode({scope:request.scope,observation,bytes:frame.bytes,now:Date.now()})??[];
   return isDeepStrictEqual(fields,observation.visibleState)&&(!captured||this.matchesObservationDecoder(captured,request,observation));
  }catch{return false;}finally{frame?.bytes.fill(0);}
 };
 acceptAction=(request:G.GameActionRequest,result:G.GameActionResult):boolean=>{
  if(!this.sourceAvailable(request.scope,request.payload.expectedPinsDigest))return false;
  const snapshot=this.snapshot(),proof=snapshot?.lastAction,receipt=result.outcome.payload;
  if(!isDeepStrictEqual(snapshot?.lastActionResult,result))return false;
  if(result.outcome.status==='rejected')return snapshot?.actionStarted?.actionId!==request.payload.actionId;
  if(!proof||!receipt||proof.requestId!==request.requestId||proof.correlationId!==request.correlationId||proof.inputOwnerLeaseId!==request.payload.inputOwnerLeaseId||!isDeepStrictEqual(proof.requestedButtons,request.payload.buttonVector)||!isDeepStrictEqual(proof.receipt,receipt)||receipt.actionId!==request.payload.actionId||receipt.idempotencyKey!==request.idempotencyKey||!ordinaryEntryFrameMatches(request,receipt.beforeFrame,this.sessionScoped)||receipt.afterFrame===null||receipt.beforeFrame===null||receipt.framesApplied!==receipt.afterFrame-receipt.beforeFrame||proof.verifiedInputFrames!==receipt.framesApplied||receipt.buttonsNeutralized!==true||!Number.isFinite(proof.startedMonotonicMs)||!Number.isFinite(proof.completedMonotonicMs)||proof.completedMonotonicMs<proof.startedMonotonicMs||proof.completedMonotonicMs-proof.startedMonotonicMs>request.payload.proposal.maxWallMs)return false;
  if(this.receipts.size>=64&&!this.receipts.has(receipt.actionId)){if(this.sessionScoped)this.receipts.delete(this.receipts.keys().next().value!);else return false;}
  this.receipts.set(receipt.actionId,structuredClone(proof));return true;
 };
 usageFor=(request:G.GameActionRequest,result:G.GameActionResult):{receipt:G.GameActionReceipt;wallMs:number;completionRef:string}|null=>{
  const proof=this.receipts.get(request.payload.actionId);
  if(!proof||result.outcome.status!=='succeeded'||!isDeepStrictEqual(proof.receipt,result.outcome.payload)||proof.requestId!==request.requestId)return null;
  return {receipt:structuredClone(proof.receipt),wallMs:Math.ceil(proof.completedMonotonicMs-proof.startedMonotonicMs),completionRef:'nativeEvidence:'+digest(Buffer.from(JSON.stringify(proof)))};
 };
 reconcileEffect=async(request:G.GameActionRequest|G.GameSaveRequest):Promise<boolean>=>{
  if(request.operation!=='GameActivityAdapter.applyController'||!this.ownedScope(request.scope))return false;
  const proof=this.snapshot(),action=proof?.lastAction;
  return !!action&&action.receipt.actionId===request.payload.actionId&&action.receipt.idempotencyKey===request.idempotencyKey&&action.inputOwnerLeaseId===request.payload.inputOwnerLeaseId&&action.receipt.buttonsNeutralized===true&&['completed','cancelled','failed'].includes(action.receipt.disposition);
 };
 admitRelease=async(request:G.GameReleaseRequest):Promise<boolean>=>{
  if(!this.ownedScope(request.scope)||Date.parse(request.deadlineAt)<=Date.now()||Date.parse(request.deadlineAt)>Date.now()+5000)return false;
  const proof=this.snapshot(),lease=proof?.actionStarted?.inputOwnerLeaseId;
  return !!lease&&lease===request.payload.targetInputOwnerLeaseId&&isDeepStrictEqual(request.payload.neutralButtons,neutral);
 };
 async shutdownExactOldLease(action:G.GameActionRequest|null,adapter:GameActivityAdapter,timeoutMs=3000):Promise<boolean>{
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000||!action||!this.ownedScope(action.scope))return false;
  const id=()=>randomUUID(),request:G.GameReleaseRequest={schemaVersion:'1.0.0',operation:'GameActivityAdapter.releaseControls',requestId:id(),correlationId:id(),deadlineAt:new Date(Date.now()+timeoutMs).toISOString(),cancellationId:id(),executionMode:'normal',scope:structuredClone(action.scope),idempotencyKey:id(),payload:{targetInputOwnerLeaseId:action.payload.inputOwnerLeaseId,reason:'stop',neutralButtons:neutral}};
  if(!await this.admitRelease(request))return false;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const operation=adapter.releaseControls(request,{signal:controller.signal,isCurrent:scope=>this.ownedScope(scope)});
   const cancelled=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('Native shutdown deadline')),{once:true}));
   const result=await Promise.race([operation,cancelled]),proof=this.snapshot();
   const payload=result.outcome.payload;
   return this.ownedScope(action.scope)&&this.filesCurrent()&&!controller.signal.aborted&&Date.now()<Date.parse(request.deadlineAt)&&!!proof&&result.operation===request.operation&&result.requestId===request.requestId&&result.correlationId===request.correlationId&&result.providerRef===this.options.providerRef&&payload?.targetInputOwnerLeaseId===request.payload.targetInputOwnerLeaseId&&payload.emulatorPaused===true&&payload.buttonsNeutralized===true&&payload.confirmationSource==='adapterObserved'&&payload.activityEpochAfterFence===action.scope.activityEpoch+1&&typeof payload.pauseConfirmedMonotonicMs==='number'&&typeof payload.verifiedMonotonicMs==='number'&&Number.isFinite(payload.pauseConfirmedMonotonicMs)&&Number.isFinite(payload.verifiedMonotonicMs)&&payload.verifiedMonotonicMs-payload.pauseConfirmedMonotonicMs>=DESKTOP_SESSION_LIMITS.stationaryFrameMs&&result.outcome.status==='succeeded'&&result.outcome.payload?.disposition==='neutralizedAndPaused'&&isDeepStrictEqual(proof.lastRelease,result)&&proof.paused===true&&Object.values(proof.buttons).every(value=>value===false)&&result.outcome.payload.pauseFrameNumber===result.outcome.payload.verifiedFrameNumber;
  }catch{return false;}finally{clearTimeout(timer);}
 }
}
