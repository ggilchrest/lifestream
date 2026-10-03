import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {ChildProcess} from 'node:child_process';
import type * as G from '@lifestream/contracts/game-activity';
import {gameHostDigest,type NativeControllerUsageEvidence,type NativeShutdownEvidence} from '@lifestream/contracts/game-host';
import type {GameActivityAdapter} from './port.js';
import type {GameFrameCustody} from './frame-custody.js';
import type {LiveFrameDecoder} from './live-frame-decoder.js';

const buttons={up:'Up',down:'Down',left:'Left',right:'Right',a:'A',b:'B',x:'X',y:'Y',l:'L',r:'R',start:'Start',select:'Select'} as const;
const neutral=Object.fromEntries(Object.keys(buttons).map(key=>[key,false])) as G.GameReleaseRequest['payload']['neutralButtons'];
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type NativeAction={requestId:string;correlationId:string;inputOwnerLeaseId:string;startedMonotonicMs:number;completedMonotonicMs:number;verifiedInputFrames:number;requestedButtons:G.GameActionRequest['payload']['buttonVector'];receipt:G.GameActionReceipt};
/** Local owned-file readback, not a transport DTO or remote attestation. */
export type NativeControllerReadback={scope:G.ActivityScope;pinsDigest:string;providerRef:string;action:NativeAction;wallMs:number};
export type NativeShutdownReadback={scope:G.ActivityScope;pinsDigest:string;providerRef:string;action:G.GameActionRequest;release:G.GameReleaseResult};
const immutable=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;};
type NativeSnapshot={schemaVersion:string;recordType:string;scope:G.ActivityScope;pinsDigest:string;providerRef:string;version:string;system:string;romSha1:string;sequence:number;frameNumber:number;monotonicMs:number;checkedAt:string;paused:boolean;buttonsAvailable:boolean;buttons:Record<string,boolean>;lastObservation?:G.GameObserveResult;lastAction?:NativeAction;lastActionResult?:G.GameActionResult;actionStarted?:{actionId:string;inputOwnerLeaseId:string};lastRelease?:G.GameReleaseResult;event:string};
export type NativeGameEvidenceOptions={directory:string;scope:G.ActivityScope;pinsDigest:string;providerRef:string;romSha1:string;sourceFiles:readonly {path:string;sha256:string}[];custody:GameFrameCustody;decoder?:LiveFrameDecoder;sessionDurationMs:number;isCurrent:(scope:G.ActivityScope)=>boolean};

/** Concrete native readback ports for an owned graphical child. Native writes
 * the fixed evidence file; wire assertions and schema-valid results alone cannot
 * qualify an action. This supplies no capability claim or memory consent. */
export class NativeGameEvidence{
 readonly evidenceFile:string;
 private readonly options:Readonly<NativeGameEvidenceOptions>;
 private child:ChildProcess|undefined;private readonly expiresMono:number;private readonly expiresWall:number;
 private lastSequence=0;private lastMono=0;private readonly receipts=new Map<string,NativeAction>();
 private readonly capturedActions=new Map<string,{request:G.GameActionRequest;result:G.GameActionResult}>();
 private shutdownReadback:NativeShutdownReadback|undefined;
 constructor(options:NativeGameEvidenceOptions){
  if(!isAbsolute(options.directory)||!/^[a-f0-9]{64}$/.test(options.pinsDigest)||!/^[a-f0-9]{40}$/.test(options.romSha1)||!options.sourceFiles.length||options.sourceFiles.length>16||!Number.isSafeInteger(options.sessionDurationMs)||options.sessionDurationMs<1||options.sessionDurationMs>600000||typeof options.isCurrent!=='function')throw Error('Native evidence setup unavailable');
  const directory=realpathSync(options.directory);this.evidenceFile=resolve(directory,'native-evidence.json');
  if(existsSync(this.evidenceFile)||existsSync(this.evidenceFile+'.next'))throw Error('Fresh owned native evidence directory required');
  const sourceFiles=options.sourceFiles.map(file=>{if(!isAbsolute(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Native source pin unavailable');return Object.freeze({...file,path:realpathSync(file.path)});});
  this.options=Object.freeze({...options,directory,scope:structuredClone(options.scope),sourceFiles:Object.freeze(sourceFiles)});
  this.expiresMono=performance.now()+options.sessionDurationMs;this.expiresWall=Date.now()+options.sessionDurationMs;
  if(!this.filesCurrent())throw Error('Native source pins changed');
 }
 bindOwnedProcess(child:ChildProcess):void{if(this.child||!child.pid||child.exitCode!==null)throw Error('Owned native child unavailable');this.child=child;}
 installationAvailable=(scope:G.ActivityScope,pins:string):boolean=>{
  try{return pins===this.options.pinsDigest&&isDeepStrictEqual(scope,this.options.scope)&&Date.now()<this.expiresWall&&performance.now()<this.expiresMono&&this.options.isCurrent(scope)===true&&this.filesCurrent();}catch{return false;}
 };
 private filesCurrent():boolean{try{return this.options.sourceFiles.every(file=>{const stat=lstatSync(file.path);return stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=134217728&&realpathSync(file.path)===file.path&&digest(readFileSync(file.path))===file.sha256;});}catch{return false;}}
 private ownedScope(scope:G.ActivityScope):boolean{return isDeepStrictEqual(scope,this.options.scope)&&!!this.child?.pid&&this.child.exitCode===null&&this.child.signalCode===null;}
 private snapshot():NativeSnapshot|null{
  try{
   const stat=lstatSync(this.evidenceFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>65536||realpathSync(this.evidenceFile)!==this.evidenceFile)return null;
   const value=JSON.parse(readFileSync(this.evidenceFile,'utf8')) as NativeSnapshot;
   if(value.schemaVersion!=='1.0.0'||value.recordType!=='nativeGameEvidence'||!isDeepStrictEqual(value.scope,this.options.scope)||value.pinsDigest!==this.options.pinsDigest||value.providerRef!==this.options.providerRef||value.version!=='2.11.1'||value.system!=='SNES'||value.romSha1!==this.options.romSha1||!Number.isSafeInteger(value.sequence)||value.sequence<this.lastSequence||!Number.isFinite(value.monotonicMs)||value.monotonicMs<this.lastMono||!Number.isSafeInteger(value.frameNumber)||value.frameNumber<0||!Number.isFinite(Date.parse(value.checkedAt))||Date.parse(value.checkedAt)>Date.now()||value.buttonsAvailable!==true||Object.values(buttons).some(name=>typeof value.buttons?.[name]!=='boolean'))return null;
   this.lastSequence=value.sequence;this.lastMono=value.monotonicMs;return value;
  }catch{return null;}
 }
 sourceAvailable=(scope:G.ActivityScope,pins:string):boolean=>{
  try{const proof=this.snapshot();return pins===this.options.pinsDigest&&this.ownedScope(scope)&&Date.now()<this.expiresWall&&performance.now()<this.expiresMono&&this.options.isCurrent(scope)===true&&this.filesCurrent()&&!!proof&&proof.event!=='closed'&&Date.now()-Date.parse(proof.checkedAt)<=5000;}catch{return false;}
 };
 acceptObservation=(request:G.GameObserveRequest,observation:G.GameObservation):boolean=>{
  if(!this.sourceAvailable(request.scope,observation.pinsDigest))return false;
  const proof=this.snapshot()?.lastObservation,original=proof?.outcome.payload?.observation;
  if(!proof||proof.requestId!==request.requestId||proof.correlationId!==request.correlationId||proof.outcome.status!=='succeeded'||!original||observation.untrusted!==true||observation.screenshots.length!==1)return false;
  const source=(o:G.GameObservation)=>({...o,visibleState:[],interpretedAt:null,providerConfigurationRef:null});
  if(!isDeepStrictEqual(source(original),source(observation)))return false;
  let frame:ReturnType<GameFrameCustody['read']>|undefined;
  try{
   frame=this.options.custody.read(observation.screenshots[0]!.mediaRef,request.scope);
   if(!isDeepStrictEqual(frame.screenshot,observation.screenshots[0])||digest(frame.bytes)!==frame.screenshot.sha256)return false;
   const fields=this.options.decoder?.decode({scope:request.scope,observation,bytes:frame.bytes,now:Date.now()})??[];
   return isDeepStrictEqual(fields,observation.visibleState);
  }catch{return false;}finally{frame?.bytes.fill(0);}
 };
 acceptAction=(request:G.GameActionRequest,result:G.GameActionResult):boolean=>{
  if(!this.sourceAvailable(request.scope,request.payload.expectedPinsDigest))return false;
  const snapshot=this.snapshot(),proof=snapshot?.lastAction,receipt=result.outcome.payload;
  if(!isDeepStrictEqual(snapshot?.lastActionResult,result))return false;
  if(result.outcome.status==='rejected')return snapshot?.actionStarted?.actionId!==request.payload.actionId;
  if(!proof||!receipt||result.operation!==request.operation||result.requestId!==request.requestId||result.correlationId!==request.correlationId||result.providerRef!==this.options.providerRef||!isDeepStrictEqual(receipt.scope,request.scope)||proof.requestId!==request.requestId||proof.correlationId!==request.correlationId||proof.inputOwnerLeaseId!==request.payload.inputOwnerLeaseId||!isDeepStrictEqual(proof.requestedButtons,request.payload.buttonVector)||!isDeepStrictEqual(proof.receipt,receipt)||receipt.actionId!==request.payload.actionId||receipt.proposalId!==request.payload.proposal.proposalId||receipt.inputDigest!==request.payload.admission.inputDigest||receipt.admissionId!==request.payload.admission.admissionId||receipt.idempotencyKey!==request.idempotencyKey||receipt.beforeFrame!==request.payload.expectedFrameNumber||receipt.afterFrame===null||receipt.beforeFrame===null||receipt.framesApplied!==receipt.afterFrame-receipt.beforeFrame||!Number.isSafeInteger(proof.verifiedInputFrames)||proof.verifiedInputFrames<0||proof.verifiedInputFrames!==receipt.framesApplied||receipt.buttonsNeutralized!==true||!Number.isFinite(proof.startedMonotonicMs)||proof.startedMonotonicMs<0||!Number.isFinite(proof.completedMonotonicMs)||proof.completedMonotonicMs<proof.startedMonotonicMs||proof.completedMonotonicMs-proof.startedMonotonicMs>request.payload.proposal.maxWallMs)return false;
  if(this.receipts.size>=64&&!this.receipts.has(receipt.actionId))return false;
  const previous=this.capturedActions.get(receipt.actionId);
  if(previous&&(!isDeepStrictEqual(previous.request,request)||!isDeepStrictEqual(previous.result,result)||!isDeepStrictEqual(this.receipts.get(receipt.actionId),proof)))return false;
  this.receipts.set(receipt.actionId,structuredClone(proof));this.capturedActions.set(receipt.actionId,{request:structuredClone(request),result:structuredClone(result)});return true;
 };
 usageFor=(request:G.GameActionRequest,result:G.GameActionResult):{receipt:G.GameActionReceipt;wallMs:number;completionRef:string}|null=>{
  const proof=this.receipts.get(request.payload.actionId);
  if(!proof||result.outcome.status!=='succeeded'||!isDeepStrictEqual(proof.receipt,result.outcome.payload)||proof.requestId!==request.requestId)return null;
  return {receipt:structuredClone(proof.receipt),wallMs:Math.ceil(proof.completedMonotonicMs-proof.startedMonotonicMs),completionRef:'nativeEvidence:'+digest(Buffer.from(JSON.stringify(proof)))};
 };
 /** Export only an already-accepted exact action, while the actual owned source
  * is still current. No caller-supplied timestamps or frame estimates are used. */
 captureControllerReadback=(request:G.GameActionRequest,result:G.GameActionResult):Readonly<NativeControllerReadback>|null=>{
  try{
   const captured=this.capturedActions.get(request.payload.actionId),proof=this.receipts.get(request.payload.actionId);
   if(!captured||!proof||result.outcome.status!=='succeeded'||!isDeepStrictEqual(captured.request,request)||!isDeepStrictEqual(captured.result,result)||!this.sourceAvailable(request.scope,request.payload.expectedPinsDigest))return null;
   const action:NativeAction={requestId:proof.requestId,correlationId:proof.correlationId,inputOwnerLeaseId:proof.inputOwnerLeaseId,startedMonotonicMs:proof.startedMonotonicMs,completedMonotonicMs:proof.completedMonotonicMs,verifiedInputFrames:proof.verifiedInputFrames,requestedButtons:structuredClone(proof.requestedButtons),receipt:structuredClone(proof.receipt)};
   return immutable({scope:structuredClone(this.options.scope),pinsDigest:this.options.pinsDigest,providerRef:this.options.providerRef,action,wallMs:Math.ceil(action.completedMonotonicMs-action.startedMonotonicMs)});
  }catch{return null;}
 };
 /** Safety readback remains available after gameplay currentness is fenced.
  * Only the recorded owned old lease can qualify; never a successor lookup. */
 captureShutdownReadback=(action:G.GameActionRequest):Readonly<NativeShutdownReadback>|null=>{
  try{
   const recorded=this.shutdownReadback,proof=this.snapshot();
   if(!recorded||!isDeepStrictEqual(recorded.action,action)||!this.ownedScope(action.scope)||!proof||proof.actionStarted?.inputOwnerLeaseId!==action.payload.inputOwnerLeaseId||!isDeepStrictEqual(proof.lastRelease,recorded.release)||!proof.paused||Object.values(proof.buttons).some(value=>value!==false)||proof.frameNumber!==recorded.release.outcome.payload?.verifiedFrameNumber)return null;
   return immutable(structuredClone(recorded));
  }catch{return null;}
 };
 controllerUsageEvidenceFor=(request:G.GameActionRequest,result:G.GameActionResult):NativeControllerUsageEvidence|null=>{
  const captured=this.captureControllerReadback(request,result);if(!captured)return null;
  return immutable({schemaVersion:'1.0.0',recordType:'nativeControllerUsageEvidence',scope:captured.scope,pinsDigest:captured.pinsDigest,providerRef:captured.providerRef,requestDigest:gameHostDigest(request),resultDigest:gameHostDigest(result),inputOwnerLeaseId:captured.action.inputOwnerLeaseId,startedMonotonicMs:captured.action.startedMonotonicMs,completedMonotonicMs:captured.action.completedMonotonicMs,verifiedInputFrames:captured.action.verifiedInputFrames,nativeActionDigest:gameHostDigest(captured.action)});
 };
 shutdownEvidenceFor=(action:G.GameActionRequest):NativeShutdownEvidence|null=>{
  const captured=this.captureShutdownReadback(action);if(!captured)return null;
  return immutable({schemaVersion:'1.0.0',recordType:'nativeShutdownEvidence',scope:captured.scope,pinsDigest:captured.pinsDigest,providerRef:captured.providerRef,actionRequestDigest:gameHostDigest(captured.action),targetInputOwnerLeaseId:captured.action.payload.inputOwnerLeaseId,release:captured.release});
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
  this.shutdownReadback=undefined;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000||!action||!this.ownedScope(action.scope))return false;
  const id=()=>randomUUID(),request:G.GameReleaseRequest={schemaVersion:'1.0.0',operation:'GameActivityAdapter.releaseControls',requestId:id(),correlationId:id(),deadlineAt:new Date(Date.now()+timeoutMs).toISOString(),cancellationId:id(),executionMode:'normal',scope:structuredClone(action.scope),idempotencyKey:id(),payload:{targetInputOwnerLeaseId:action.payload.inputOwnerLeaseId,reason:'stop',neutralButtons:neutral}};
  if(!await this.admitRelease(request))return false;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const operation=adapter.releaseControls(request,{signal:controller.signal,isCurrent:scope=>this.ownedScope(scope)});
   const cancelled=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('Native shutdown deadline')),{once:true}));
   const result=await Promise.race([operation,cancelled]),proof=this.snapshot(),receipt=result.outcome.payload;
   const confirmed=!!proof&&result.operation===request.operation&&result.requestId===request.requestId&&result.correlationId===request.correlationId&&result.providerRef===this.options.providerRef&&result.outcome.status==='succeeded'&&receipt?.targetInputOwnerLeaseId===action.payload.inputOwnerLeaseId&&receipt.disposition==='neutralizedAndPaused'&&receipt.emulatorPaused===true&&receipt.buttonsNeutralized===true&&receipt.confirmationSource==='adapterObserved'&&Number.isSafeInteger(receipt.pauseFrameNumber)&&Number(receipt.pauseFrameNumber)>=0&&receipt.pauseFrameNumber===receipt.verifiedFrameNumber&&Number.isFinite(receipt.pauseConfirmedMonotonicMs)&&Number(receipt.pauseConfirmedMonotonicMs)>=0&&Number.isFinite(receipt.verifiedMonotonicMs)&&Number(receipt.verifiedMonotonicMs)>=Number(receipt.pauseConfirmedMonotonicMs)&&proof.monotonicMs>=Number(receipt.verifiedMonotonicMs)&&proof.actionStarted?.inputOwnerLeaseId===action.payload.inputOwnerLeaseId&&proof.frameNumber===receipt.verifiedFrameNumber&&isDeepStrictEqual(proof.lastRelease,result)&&proof.paused===true&&Object.values(proof.buttons).every(value=>value===false);
   if(!confirmed)return false;
   this.shutdownReadback={scope:structuredClone(this.options.scope),pinsDigest:this.options.pinsDigest,providerRef:this.options.providerRef,action:structuredClone(action),release:structuredClone(result)};return true;
  }catch{return false;}finally{clearTimeout(timer);}
 }
}
