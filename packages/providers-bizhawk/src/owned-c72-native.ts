import {gameHostDigest} from '@lifestream/contracts/game-host';
import {openOwnedGameMedia,ownedGameMediaAvailable} from './native-game-media.ts';
import {createContractValidator} from '@lifestream/contracts';
import {captureGameSanityTiming} from './game-sanity-timing.ts';
import {captureNativeSource,nativeSourceAge,nativeSourceException,type NativeSourceCapture,type NativeSourceWitness} from './native-source-witness.ts';
import {nativeExecutionCustodyBounds} from './native-execution-lifetime.ts';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync,unlinkSync,lstatSync,openSync,closeSync,fstatSync,fsyncSync,constants} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual,types} from 'node:util';
import {NativeGameEvidence} from './native-evidence.ts';
import {listenForNativeBizHawk,nativeBridgeEnvironment} from './native-host.ts';
import {C72_IMAGE,readC72NativeConfiguration,readNativeFile,readNativePublishedFile,readCreatedEngineCid,canonicalNativePath,c72NativePlan,scopeDigest,fileDigest} from './c72-native-configuration.ts';
import {captureWakePreludeConfiguration,validateWakePreludeReceipt} from './ct-wake-prelude.ts';
import {createNativeOwnerFailureWitness,type NativeOwnerFailureStage,type NativeOwnerFailurePredicate,type NativeOwnerFailureWitness} from './native-owner-failure-witness.ts';
import {captureNativeOriginalError} from './native-original-error.ts';
import {createNativeInspectionTiming,captureNativeRefreshTiming,type NativeRefreshTiming} from './native-refresh-timing.ts';

const environment=()=>({PATH:'/home/gg/.local/bin:/usr/local/bin:/usr/bin:/bin',HOME:'/home/gg',XDG_RUNTIME_DIR:'/run/user/1000',LANG:'C.UTF-8'});
const cidPattern=/^[a-f0-9]{64}$/;
const inspectTemplate='{"id":{{json .ID}},"image":{{json .Image}},"invocation":{{json (index .Config.Labels "dev.lifestream.ct.native-invocation")}},"running":{{json .State.Running}}}';
const imageId=(value:any)=>typeof value==='string'?value.replace(/^sha256:/,''):null;
/** Whole milliseconds for Node's subprocess API, clipped down to the original
 * scheduling allowance. Zero must never turn an exhausted budget into no limit. */
export function nativeProcessTimeoutMs(remainingMs:number):number{
 if(!Number.isFinite(remainingMs)||remainingMs<1||remainingMs>120000)throw Error('Native subprocess timeout budget unavailable');
 return Math.floor(remainingMs);
}
/** Starts ONE native-only image via exact owned CID. Test ports replace only
 * process/listener operations; the backend never accepts them from HTTP/JSON. */
/** Historical cleanup recovery only. Expired facts remain invalid for opening
 * a native session. Exact closed evidence plus the engine's removal event can
 * re-establish its deterministic terminal receipt after a coordinator restart. */
export async function recoverOwnedC72Termination(options:any,testBoundary?:any){
 let recoveryPhase='owner-current';try{
 if(!testBoundary&&(process.platform!=='linux'||process.getuid?.()!==1000))throw Error('Owned terminal recovery requires Ubuntu owner');
 const {stateRoot,runId,pinsDigest,owner,current,signal}=options;
 const need=(value:any)=>{if(!value)throw Error('Owned terminal recovery unavailable');};
 need(typeof current==='function'&&signal instanceof AbortSignal&&/^[a-f0-9-]{36}$/.test(runId)&&/^[a-f0-9]{64}$/.test(pinsDigest));
 const admitted=()=>!signal.aborted&&current()===true;need(admitted());canonicalNativePath(stateRoot,true,true);
 const root=join(stateRoot,'runs',runId),factsFile=join(stateRoot,'facts',runId+'.json');canonicalNativePath(root,true,true);canonicalNativePath(join(root,'evidence'),true,true);
 const files=[factsFile,join(root,'consumed.json'),join(root,'evidence','native-custody.json'),join(root,'evidence','native-evidence.json')];
 const read=(file:string,max=65536)=>{const bytes=readNativeFile(file,max,true);try{return {value:JSON.parse(bytes.toString('utf8')),digest:fileDigest(bytes)};}finally{bytes.fill(0);}};
 recoveryPhase='file-read';const captured=files.map(file=>read(file)),[facts,consumed,custody,native]=captured.map(item=>item.value),scope=facts.scope;
 recoveryPhase='scope';need(createContractValidator().validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/ActivityScope',scope).valid&&scope.runId===runId&&['assistantId','principalId','relationshipId','environmentId'].every(key=>scope[key]===owner[key]));
 recoveryPhase='closed-native';const scopePin=scopeDigest(scope);need(facts.schemaVersion==='ct-native-c72/1'&&facts.image===C72_IMAGE&&facts.runDirectory===root&&facts.pinsDigest===pinsDigest&&consumed.scopeDigest===scopePin&&consumed.pinsDigest===pinsDigest&&/^[a-f0-9]{32}$/.test(consumed.nonce)&&custody.schemaVersion==='ct-native-custody/1'&&custody.scopeDigest===scopePin&&custody.pinsDigest===pinsDigest&&custody.invocation===consumed.nonce&&custody.image===C72_IMAGE);
 need(native.schemaVersion==='1.0.0'&&native.recordType==='nativeGameEvidence'&&native.event==='closed'&&isDeepStrictEqual(native.scope,scope)&&native.pinsDigest===pinsDigest&&native.romSha1===facts.romSha1&&native.paused===true&&native.buttonsAvailable===true&&Object.keys(native.buttons??{}).sort().join(',')===['A','B','Down','L','Left','R','Right','Select','Start','Up','X','Y'].sort().join(',')&&Object.values(native.buttons).every(value=>value===false));
 recoveryPhase='closed-time';const ended=Date.parse(native.checkedAt);need(Number.isFinite(ended)&&ended<=Date.now());
 recoveryPhase='cid-files-absent';for(const name of ['owned.cid','engine.cid']){try{lstatSync(join(root,name));throw Error('Native CID still present');}catch(error){if((error as any)?.code!=='ENOENT')throw error;}}
 const sourceCurrent=()=>{try{return admitted()&&files.every((file,index)=>read(file).digest===captured[index]!.digest);}catch{return false;}};need(sourceCurrent());
 const execute=testBoundary?.exec??(async(args:string[])=>{try{const result=await promisify(execFile)('/usr/bin/podman',args,{env:environment(),timeout:5000,maxBuffer:65536,signal});return {code:0,stdout:result.stdout};}catch(error){if((error as any)?.code===1)return {code:1,stdout:''};throw error;}});
 recoveryPhase='removal-event';const events=await execute(['events','--stream=false','--since',new Date(ended-10000).toISOString(),'--until',new Date().toISOString(),'--filter','event=remove','--filter','label=dev.lifestream.ct.native-invocation='+consumed.nonce,'--format','json']);need(sourceCurrent()&&events.code===0&&typeof events.stdout==='string'&&Buffer.byteLength(events.stdout)<=65536);
 const rows=events.stdout.trim().split('\n').filter(Boolean).map((line:string)=>JSON.parse(line));need(rows.length===1);const event=rows[0];need(event.Type==='container'&&event.Status==='remove'&&/^[a-f0-9]{64}$/.test(event.ID)&&event.Attributes?.['dev.lifestream.ct.native-invocation']===consumed.nonce&&Number.isFinite(event.time)&&event.time*1000>=ended-1000&&event.time*1000<=Date.now());
 recoveryPhase='engine-label-absent';const remaining=await execute(['ps','--all','--no-trunc','--filter','label=dev.lifestream.ct.native-invocation='+consumed.nonce,'--format','{{.ID}}']);need(sourceCurrent()&&remaining.code===0&&remaining.stdout.trim()==='');
 recoveryPhase='engine-cid-absent';const absent=await execute(['container','exists',event.ID]);need(sourceCurrent()&&absent.code===1);
 const value={scopeDigest:scopePin,pinsDigest,invocation:consumed.nonce,containerIdDigest:fileDigest(Buffer.from(event.ID)),removed:true};
 // Closed-before-input proof is separate from removal and never a gameplay
 // receipt. Only the reviewed peer/entry pair writes actionStarted durably
 // before resume/input and never removes it from subsequent closed evidence.
 const dispatches=options.unstartedDispatches;
 let noEntryDigest:string|null=null;
 if(Array.isArray(dispatches)&&dispatches.length>0&&dispatches.length<=64&&
   dispatches.every((row:any)=>row.run_id===runId&&['claimed','unresolved'].includes(row.state)&&row.receipt_digest===null&&['action_id','attachment_id','command_id','host_id'].every(key=>/^[a-f0-9-]{36}$/.test(row[key]))&&['request_digest','source_revision'].every(key=>/^[a-f0-9]{64}$/.test(row[key])))&&
   ['actionStarted','lastAction','lastActionResult'].every(key=>!Object.hasOwn(native,key))&&Number.isSafeInteger(native.sequence)&&native.sequence>0){
  try{
   const reviewed=['entry','peer'].map(name=>({name,digest:fileDigest(readNativeFile(fileURLToPath(new URL('../native/'+name+'.lua',import.meta.url)),262144))}));
   if(reviewed.every(item=>facts.sources?.[item.name]?.sha256===item.digest)){
    const journal=testBoundary?.journal??(async(args:string[])=>{const result=await promisify(execFile)('/usr/bin/journalctl',args,{env:environment(),timeout:5000,maxBuffer:65536,signal});return result.stdout;});
    const output=await journal(['--user','-u','lifestream-backend.service','--since',new Date(ended-10000).toISOString(),'--until',new Date(ended+1000).toISOString(),'--no-pager','-o','json','--grep',runId]);
    need(sourceCurrent()&&typeof output==='string'&&Buffer.byteLength(output)<=65536);
    const records=output.trim().split('\n').filter(Boolean).map((line:string)=>JSON.parse(line));
    const refusals=dispatches.map((dispatch:any)=>{
     const matches=records.filter((record:any)=>{try{const message=JSON.parse(record.MESSAGE);return record._SYSTEMD_USER_UNIT==='lifestream-backend.service'&&/^[1-9][0-9]*$/.test(record._PID)&&message.event==='game-adapter-first-refusal'&&message.runId===runId&&message.actionId===dispatch.action_id;}catch{return false;}});
     need(matches.length===1);const record=matches[0],message=JSON.parse(record.MESSAGE);
     need(typeof record.__CURSOR==='string'&&record.__CURSOR.length>0&&record.__CURSOR.length<=2048&&message.phase==='pre-adapter-current'&&message.effectMayHaveStarted===false&&((message.predicate==='admission_expired'&&message.code==='admissionRequired')||(message.predicate==='caller_current'&&message.code==='scopeChanged'))&&Number.isSafeInteger(message.observedAtMs)&&message.observedAtMs>=ended-10000&&message.observedAtMs<=ended+1000&&Number.isSafeInteger(message.requestExpiresAtMs)&&message.requestExpiresAtMs===message.admissionExpiresAtMs&&message.observedAtMs>=message.admissionExpiresAtMs&&Math.abs(Number(record.__REALTIME_TIMESTAMP)/1000-message.observedAtMs)<1000);
     return {actionId:dispatch.action_id,pid:record._PID,journalCursor:record.__CURSOR,refusal:message};
    });
    need(sourceCurrent());noEntryDigest=fileDigest(Buffer.from(JSON.stringify({kind:'closed-before-native-input/1',scopeDigest:scopePin,pinsDigest,nativeDigest:captured[3]!.digest,files:captured.map(item=>item.digest),dispatches,reviewed,refusals,termination:value})));
   }
  }catch{noEntryDigest=null;}
 }
 // Receipt ingress is not canonical settlement. It can establish that the
 // retained digest is this original native result, while the full charge and
 // dispatch remain unconfirmed. Never manufacture or replay a request here.
 let receivedDigest:string|null=null;
 try{const result=native.lastActionResult,receipt=result?.outcome?.payload;
  if(Array.isArray(dispatches)&&dispatches.length===1&&dispatches[0].run_id===runId&&dispatches[0].state==='entered'&&typeof dispatches[0].receipt_digest==='string'&&
   createContractValidator().validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/GameActionResult',result).valid&&result.outcome.status==='succeeded'&&isDeepStrictEqual(receipt.scope,scope)&&receipt.actionId===dispatches[0].action_id&&result.providerRef===native.providerRef&&Date.parse(result.completedAt)<=Date.parse(native.checkedAt)&&
   native.lastAction?.requestId===result.requestId&&native.lastAction?.correlationId===result.correlationId&&isDeepStrictEqual(native.lastAction?.receipt,receipt)&&gameHostDigest(result)===dispatches[0].receipt_digest)receivedDigest=dispatches[0].receipt_digest;
 }catch{};
 const receivedNativeReceipt=(expected:unknown)=>receivedDigest&&isDeepStrictEqual(expected,dispatches)&&sourceCurrent()?receivedDigest:null;
 const noControllerEntry=(expected:unknown)=>noEntryDigest&&isDeepStrictEqual(expected,dispatches)&&sourceCurrent()?noEntryDigest:null;
 return Object.freeze({scope:Object.freeze(structuredClone(scope)),...value,receiptRef:'native-termination:'+fileDigest(Buffer.from(JSON.stringify(value))),current:sourceCurrent,noControllerEntry,receivedNativeReceipt});
 }catch(error){try{options.onFailure?.({phase:recoveryPhase});}catch{}throw error;}
}

export function createOwnedC72Native(options:any,testBoundary?:any){
 if(!testBoundary&&(process.platform!=='linux'||process.getuid?.()!==1000))throw Error('Owned c72 native host requires Ubuntu owner');
 const timing=captureGameSanityTiming(options.sanityTiming);
 const scope=structuredClone(options.evidence.scope),pins=options.evidence.pinsDigest;
 const facts=readC72NativeConfiguration(options.configurationFile,scope,pins);
 if(typeof options.takePairingSecret!=='function')throw Error('Trusted in-memory native pairing owner required');
 if(!options.native?.frameCustody||options.native.frameCustody.directory!==join(facts.runDirectory,'frames'))throw Error('Shared native frame custody changed');
 const nonce=randomUUID().replaceAll('-',''),plan=c72NativePlan(facts,nonce),runIdentity=canonicalNativePath(facts.runDirectory,true,true);
 const refreshEvidenceDirectory=join(facts.runDirectory,'evidence'),refreshEvidenceIdentity=canonicalNativePath(refreshEvidenceDirectory,true,true);
 const startedWall=Date.now(),expiresMono=performance.now()+Math.max(0,Date.parse(facts.expiresAt)-startedWall);let lastWall=startedWall,clockCurrent=true;
 const execute=testBoundary?.exec??(async(args:string[],timeout=5000)=>{
  // Keep child-local defense in depth; Podman may reset this mask internally.
  // Canonical private CID publication is owned below, outside the engine.
  const creating=args[0]==='create';
  try{const result=await promisify(execFile)(creating?'/bin/sh':facts.wrapper.path,creating?['-c','umask 077; exec "$@"','--',facts.wrapper.path,...args]:args,{env:environment(),timeout:nativeProcessTimeoutMs(timeout),maxBuffer:8192});return result.stdout;}
  catch(error){
   // Only the read-only inspection lane may retry a killed timeout. Create,
   // start, remove and all native effects retain their original one-shot path.
   if(args[0]==='inspect'&&error&&typeof error==='object'&&!types.isProxy(error)&&Object.getOwnPropertyDescriptor(error,'killed')?.value===true&&Object.getOwnPropertyDescriptor(error,'signal')?.value==='SIGTERM')throw Object.assign(Error('Native inspection read timed out'),{code:'ETIMEDOUT'});
   throw error;
  }
 });
 const current=()=>options.evidence.isCurrent(scope)===true;
 let child:any,host:any,transport:any,cid:string|undefined,createAttempted=false,closed=false,launchConsumed=false,createOperation:Promise<string>|undefined;
 let inspectChecked=0,verifiedRunning=false,lastSequence=0,lastReceiptWall=0,lastReceiptMono=0,startTicks:number|undefined,monoPid:number|undefined,configurationHash:string|undefined;
 let cleanupDeadline=Infinity;
 const cleanupLeft=(maximum:number)=>{const left=Math.min(maximum,cleanupDeadline-performance.now());if(left<=0)throw Error('Native cleanup deadline');return Math.max(1,Math.floor(left));};
 let lastAction:any=null,confirmed=false,poll:any,closePromise:Promise<void>|undefined,shutdownPromise:Promise<boolean>|undefined;
 let wakeProof:Readonly<any>|null=null;
 const ownerFailureWitnesses=new WeakMap<object,NativeOwnerFailureWitness>();
 const ownerError=(stage:NativeOwnerFailureStage,predicate:NativeOwnerFailurePredicate,message:string)=>{
  const error=Error(message),witness=createNativeOwnerFailureWitness(stage,predicate,error);
  if(witness)ownerFailureWitnesses.set(error,witness);return error;
 };
 let inspectionOperation:Promise<void>|undefined,nativeSignal:AbortSignal|undefined;
 const inspectionTiming=createNativeInspectionTiming();let refreshTimeoutCaptured=false;
 const captureRefreshTimeout=(client:NativeRefreshTiming)=>{
  if(refreshTimeoutCaptured)return;const captured=captureNativeRefreshTiming(client);if(!captured)return;refreshTimeoutCaptured=true;
  const snapshot={schemaVersion:'ct-native-refresh-timeout/1',scopeDigest:scopeDigest(scope),pinsDigest:pins,client:captured,
   inspection:inspectionTiming.snapshot(),nativeWallRemainingMs:Math.max(0,Date.parse(facts.expiresAt)-Date.now()),
   nativeMonotonicRemainingMs:Math.max(0,Math.floor(expiresMono-performance.now())),authority:false};
  const directory=openSync(refreshEvidenceDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
   const same=(actual:any,expected:any)=>actual.isDirectory()&&!actual.isSymbolicLink()&&actual.dev===expected.dev&&actual.ino===expected.ino&&actual.uid===process.getuid?.()&&actual.gid===process.getgid?.()&&(actual.mode&0o777)===0o700;
   const parentCurrent=()=>{
    if(!same(canonicalNativePath(facts.runDirectory,true,true),runIdentity)||!same(canonicalNativePath(refreshEvidenceDirectory,true,true),refreshEvidenceIdentity)||!same(fstatSync(directory),refreshEvidenceIdentity))throw Error('Native refresh diagnostic directory changed');
   };
   parentCurrent();
   const target='/proc/self/fd/'+directory+'/native-refresh-timeout.json',fd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);
   try{
    parentCurrent();const opened=fstatSync(fd);
    if(!opened.isFile()||opened.nlink!==1||opened.uid!==process.getuid?.()||opened.gid!==process.getgid?.()||(opened.mode&0o777)!==0o400||opened.size!==0)throw Error('Native refresh diagnostic file changed');
    const data=JSON.stringify(snapshot)+'\n';writeFileSync(fd,data);parentCurrent();
    const after=fstatSync(fd),named=lstatSync(target);
    if(after.dev!==opened.dev||after.ino!==opened.ino||after.nlink!==1||after.uid!==opened.uid||after.gid!==opened.gid||(after.mode&0o777)!==0o400||after.size!==Buffer.byteLength(data)||named.dev!==after.dev||named.ino!==after.ino||named.nlink!==1||(named.mode&0o777)!==0o400)throw Error('Native refresh diagnostic file changed');
   }finally{closeSync(fd);}
  }finally{closeSync(directory);}
 };
 // Passive private evidence only: never evaluates an authority/currentness guard.
 // First failure and first close are separate immutable records, including when
 // cleanup/cancellation wins the race before the old generic refresh wrapper.
 let refreshFailureCaptured=false,nativeCloseCaptured=false,firstCloseInitiator:string|null=null,closeOriginalCause:NativeOwnerFailureWitness|undefined;
 let originalInspectionRejection:ReturnType<typeof inspectionTiming.snapshot>=null;
 const diagnosticMilliseconds=(value:number)=>Math.min(600001,Math.max(0,Math.floor(value)));
 const writeLifecycleDiagnostic=(name:'native-refresh-first-failure.json'|'native-close-first-cause.json',snapshot:unknown)=>{
  const directory=openSync(refreshEvidenceDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
   const same=(actual:any,expected:any)=>actual.isDirectory()&&!actual.isSymbolicLink()&&actual.dev===expected.dev&&actual.ino===expected.ino&&actual.uid===process.getuid?.()&&actual.gid===process.getgid?.()&&(actual.mode&0o777)===0o700;
   const parentCurrent=()=>{if(!same(canonicalNativePath(facts.runDirectory,true,true),runIdentity)||!same(canonicalNativePath(refreshEvidenceDirectory,true,true),refreshEvidenceIdentity)||!same(fstatSync(directory),refreshEvidenceIdentity))throw Error('Native lifecycle diagnostic directory changed');};
   parentCurrent();const data=JSON.stringify(snapshot)+'\n';if(Buffer.byteLength(data)>16384)throw Error('Native lifecycle diagnostic bound');
   const target='/proc/self/fd/'+directory+'/'+name,fd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);
   try{
    parentCurrent();const opened=fstatSync(fd);
    if(!opened.isFile()||opened.nlink!==1||opened.uid!==process.getuid?.()||opened.gid!==process.getgid?.()||(opened.mode&0o777)!==0o400||opened.size!==0)throw Error('Native lifecycle diagnostic file changed');
    writeFileSync(fd,data);fsyncSync(fd);parentCurrent();const after=fstatSync(fd),named=lstatSync(target);
    if(after.dev!==opened.dev||after.ino!==opened.ino||after.uid!==opened.uid||after.gid!==opened.gid||after.nlink!==1||(after.mode&0o777)!==0o400||after.size!==Buffer.byteLength(data)||named.dev!==after.dev||named.ino!==after.ino||named.uid!==after.uid||named.gid!==after.gid||named.nlink!==1||(named.mode&0o777)!==0o400)throw Error('Native lifecycle diagnostic file changed');
    fsyncSync(directory);
   }finally{closeSync(fd);}
  }finally{closeSync(directory);}
 };
 const lifecycleDiagnosticState=()=>({recordedAtMs:Date.now(),ownerElapsedMs:diagnosticMilliseconds(Date.now()-startedWall),
  nativeWallRemainingMs:diagnosticMilliseconds(Date.parse(facts.expiresAt)-Date.now()),nativeMonotonicRemainingMs:diagnosticMilliseconds(expiresMono-performance.now()),
  inspection:inspectionTiming.snapshot(),inspectionAtOriginalRejection:originalInspectionRejection,ownerClosed:closed,nativeSignalAborted:nativeSignal?.aborted??false,diagnosticArmed:custodyDiagnosticArmed,authority:false});
 const captureRefreshFailure=(branch:'not_armed'|'owner_closed'|'caller_aborted'|'demand_abort'|'demand_timeout'|'inspection_rejected'|'post_await_abort'|'post_await_close',error:unknown,signal:AbortSignal,started:number)=>{
  if(refreshFailureCaptured)return;refreshFailureCaptured=true;
  try{
   const original=error&&typeof error==='object'?ownerFailureWitnesses.get(error):undefined;
   const cause=original??createNativeOwnerFailureWitness('inspect-poll','inspection_rejected',error);
   writeLifecycleDiagnostic('native-refresh-first-failure.json',{schemaVersion:'ct-native-refresh-first-failure/1',scopeDigest:scopeDigest(scope),pinsDigest:pins,
    branch,cause,refreshElapsedMs:diagnosticMilliseconds(performance.now()-started),callerAborted:signal.aborted,closeInitiatorAtFailure:firstCloseInitiator,...lifecycleDiagnosticState()});
  }catch{} // Diagnostic failure never replaces the original error/settlement.
 };
 type NativeCloseInitiator='external_close'|'owned_failure'|'native_signal_abort'|'native_handle_close'|'startup_catch'|'composition_close'|'composition_completion'|'composition_stop'|'late_native_disposal';
 const captureNativeClose=(initiator:NativeCloseInitiator)=>{
  if(nativeCloseCaptured)return;nativeCloseCaptured=true;
  const safeInitiator=['external_close','owned_failure','native_signal_abort','native_handle_close','startup_catch','composition_close','composition_completion','composition_stop','late_native_disposal'].includes(initiator)?initiator:'external_close';firstCloseInitiator=safeInitiator;
  try{writeLifecycleDiagnostic('native-close-first-cause.json',{schemaVersion:'ct-native-close-first-cause/1',scopeDigest:scopeDigest(scope),pinsDigest:pins,initiator:safeInitiator,...(closeOriginalCause?{cause:closeOriginalCause}:{}),...lifecycleDiagnosticState()});}catch{}
 };
 const installedSources=[facts.wrapper,facts.seccomp,facts.frontend,...Object.values(facts.sources),{path:facts.continuation.path,sha256:facts.continuation.sha256},{path:options.configurationFile,sha256:fileDigest(readNativeFile(options.configurationFile,32768,true))}];
 const sourcePins={frontend:facts.frontend.sha256,...Object.fromEntries(Object.entries(facts.sources).map(([key,value]:[string,any])=>[key,value.sha256])),continuation:facts.continuation.sha256};
 const readCid=()=>{try{const bytes=readNativeFile(plan.cidfile,128,true),value=bytes.toString('ascii').trim();if(!cidPattern.test(value))throw Error();return value;}catch(error){if((error as any)?.code==='ENOENT')return undefined;throw Error('Exact owned native CID unavailable');}};
 const readEngineCid=()=>readCreatedEngineCid(plan.engineCidfile,facts.runDirectory,runIdentity);
 const freshCidTargets=()=>{
  if(readEngineCid()!==undefined)throw Error('Fresh engine CID already exists');
  try{lstatSync(plan.cidfile);}catch(error){if((error as any)?.code==='ENOENT')return;throw error;}
  throw Error('Fresh canonical CID already exists');
 };
 const publishCid=(selected:string)=>{
  if(!cidPattern.test(selected)||readEngineCid()!==selected)throw Error('Created engine CID unavailable');
  const directory=openSync(facts.runDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const parentCurrent=()=>{const named=canonicalNativePath(facts.runDirectory,true,true),opened=fstatSync(directory);if([named,opened].some(s=>s.dev!==runIdentity.dev||s.ino!==runIdentity.ino||s.uid!==process.getuid?.()||s.gid!==process.getgid?.()||(s.mode&0o777)!==0o700))throw Error('Created CID directory changed');};
  try{
   parentCurrent();const target='/proc/self/fd/'+directory+'/owned.cid',fd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{cid=selected;writeFileSync(fd,selected);fsyncSync(fd);const opened=fstatSync(fd),named=lstatSync(target);if(opened.dev!==named.dev||opened.ino!==named.ino||opened.uid!==process.getuid?.()||opened.gid!==process.getgid?.()||opened.nlink!==1||(opened.mode&0o777)!==0o600||opened.size!==64)throw Error('Canonical CID publication changed');parentCurrent();if(readCid()!==selected||readEngineCid()!==selected)throw Error('Canonical CID byte binding changed');fsyncSync(directory);}finally{closeSync(fd);}
  }finally{closeSync(directory);}
 };
 const inspect=async(expected:string,running?:boolean,timeoutMs=timing.inspectionTimeoutMs)=>{
  const raw=await execute(['inspect','--format',inspectTemplate,expected],timeoutMs);if(Buffer.byteLength(raw)>2048)throw Error('Owned native inspection exceeded bound');
  const value=JSON.parse(raw);if(value.id!==expected||value.invocation!==nonce||imageId(value.image)!==C72_IMAGE||typeof value.running!=='boolean'||running!==undefined&&value.running!==running)throw Error('Exact native container custody changed');
  return value;
 };
 let custodyDiagnosticArmed=false,custodyDiagnosticReported=false;
 const reportCustodyFailure=options.onFailure;
 if(reportCustodyFailure!==undefined&&typeof reportCustodyFailure!=='function')throw Error('Trusted native diagnostic callback required');
 const custodyRefused=(reason:string)=>{if(custodyDiagnosticArmed&&!closed&&!custodyDiagnosticReported){custodyDiagnosticReported=true;try{reportCustodyFailure?.(Object.freeze({schemaVersion:'ct-runtime-first-cause/1',source:'native',phase:'custody-current',reason}));}catch{}}return false;};
 const custodyCurrent=(capture?:NativeSourceCapture)=>{
  let stage='custody-pre',checking='custody_clock_read',detail:string|undefined,failedAge=0;const bad=(value:boolean,predicate:string)=>{if(value)detail=predicate;return value;};const refused=(reason:string,ageMs?:number)=>{captureNativeSource(capture,{stage,predicate:detail??checking,...(ageMs===undefined?{}:{ageMs:nativeSourceAge(ageMs)})});return custodyRefused(reason);};
  try{
   const now=Date.now(),mono=performance.now();
   if(now<lastWall){clockCurrent=false;detail='wall_not_regressed';}lastWall=now;
   checking='clock_latch_current';if(!clockCurrent)return refused('clock_changed');
   checking='monotonic_before_expiry';if(mono>=expiresMono)return refused('native_lease_expired');
   checking='child_unavailable';if(bad((checking='child_pid_present',!child?.pid),'child_pid_present')||bad((checking='child_exit_null',child.exitCode!==null),'child_exit_null')||bad((checking='child_signal_null',child.signalCode!==null),'child_signal_null'))return refused('child_unavailable');
   checking='cid_or_running_unavailable';if(bad((checking='cid_present',!cid),'cid_present')||bad((checking='verified_running_true',!verifiedRunning),'verified_running_true'))return refused('cid_or_running_unavailable');
   checking='inspect_clock_changed';if(now<inspectChecked)return refused('inspect_clock_changed');
   checking='inspect_not_fresh';if((failedAge=now-inspectChecked)>timing.inspectionFreshnessMs)return refused('inspect_not_fresh',failedAge);
   checking='wall_before_expiry';if(now>=Date.parse(facts.expiresAt))return refused('native_lease_expired');
   stage='custody-read';checking='custody_read_parse';
   const receiptBytes=readNativePublishedFile(join(facts.runDirectory,'evidence/native-custody.json'),8192,true);
   let proof;try{proof=JSON.parse(receiptBytes.toString('utf8'));}catch(error){if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')try{console.info(JSON.stringify({event:'native-custody-read-refusal',phase:'json-parse',reason:'invalid_json'}));}catch{}throw error;}
   // A supervisor receipt can be published during this synchronous read. Its
   // timestamp must be compared at validation, with both original clocks and
   // authority/inspection fences retained through completion of the read.
   stage='custody-post';checking='custody_clock_read';const readWall=Date.now(),readMono=performance.now();
   checking='clock_changed';if(bad((checking='wall_not_regressed',readWall<now),'wall_not_regressed')||bad((checking='monotonic_not_regressed',readMono<mono),'monotonic_not_regressed')){clockCurrent=false;return refused('clock_changed');}lastWall=readWall;
   checking='monotonic_before_expiry';if(readMono>=expiresMono)return refused('native_lease_expired');
   checking='inspect_clock_changed';if(readWall<inspectChecked)return refused('inspect_clock_changed');
   checking='inspect_not_fresh';if((failedAge=readWall-inspectChecked)>timing.inspectionFreshnessMs)return refused('inspect_not_fresh',failedAge);
   checking='wall_before_expiry';if(readWall>=Date.parse(facts.expiresAt))return refused('native_lease_expired');
   checking='continuation_changed';if(facts.wakePreparation&&!isDeepStrictEqual(proof.disposableContinuation,{bytes:facts.continuation.bytes,sha256:facts.continuation.sha256,readOnly:true,independentCopy:true}))return refused('continuation_changed');
   checking='receipt_identity_or_pins_changed';if(bad((checking='receipt_schema_matches',proof.schemaVersion!=='ct-native-custody/1'),'receipt_schema_matches')||bad((checking='receipt_invocation_matches',proof.invocation!==nonce),'receipt_invocation_matches')||bad((checking='receipt_image_matches',proof.image!==C72_IMAGE),'receipt_image_matches')||bad((checking='receipt_scope_digest_matches',proof.scopeDigest!==scopeDigest(scope)),'receipt_scope_digest_matches')||bad((checking='receipt_pins_digest_matches',proof.pinsDigest!==pins),'receipt_pins_digest_matches')||bad((checking='receipt_source_pins_match',!isDeepStrictEqual(proof.sourcePins,sourcePins)),'receipt_source_pins_match')||bad((checking='receipt_image_pins_match',!isDeepStrictEqual(proof.imagePins,facts.imagePins)),'receipt_image_pins_match')||bad((checking='receipt_viewable_true',proof.viewable!==true),'receipt_viewable_true')||bad((checking='receipt_startup_paused_true',proof.startupPaused!==true),'receipt_startup_paused_true')||bad((checking='receipt_pid_integer',!Number.isSafeInteger(proof.pid)),'receipt_pid_integer')||bad((checking='receipt_pid_positive',proof.pid<1),'receipt_pid_positive')||bad((checking='receipt_start_ticks_integer',!Number.isSafeInteger(proof.startTicks)),'receipt_start_ticks_integer')||bad((checking='receipt_start_ticks_positive',proof.startTicks<1),'receipt_start_ticks_positive'))return refused('receipt_identity_or_pins_changed');
   checking='receipt_sequence_invalid';if(bad((checking='receipt_sequence_integer',!Number.isSafeInteger(proof.sequence)),'receipt_sequence_integer')||bad((checking='receipt_sequence_positive',proof.sequence<1),'receipt_sequence_positive')||bad((checking='receipt_sequence_not_regressed',proof.sequence<lastSequence),'receipt_sequence_not_regressed'))return refused('receipt_sequence_invalid');
   checking='receipt_time_invalid';if(!Number.isSafeInteger(proof.checkedAtMs))return refused('receipt_time_invalid');
   checking='receipt_future';if(proof.checkedAtMs>readWall)return refused('receipt_future');
   checking='receipt_stale';if((failedAge=readWall-proof.checkedAtMs)>timing.receiptFreshnessMs)return refused('receipt_stale',failedAge);
   checking='receipt_time_regressed';if(proof.checkedAtMs<lastReceiptWall)return refused('receipt_time_regressed');
   checking='receipt_config_sha_shape';if(bad(!/^[a-f0-9]{64}$/.test(proof.configSha256),'receipt_config_sha_shape'))return refused('receipt_identity_or_pins_changed');
   checking='process_identity_changed';if(startTicks!==undefined&&(bad((checking='process_start_ticks_match',startTicks!==proof.startTicks),'process_start_ticks_match')||bad((checking='process_pid_matches',monoPid!==proof.pid),'process_pid_matches')||bad((checking='process_configuration_matches',configurationHash!==proof.configSha256),'process_configuration_matches')))return refused('process_identity_changed');
   checking='receipt_sequence_stalled';if(lastSequence===proof.sequence&&(failedAge=readMono-lastReceiptMono)>timing.noProgressTimeoutMs)return refused('receipt_sequence_stalled',failedAge);
   if(proof.sequence>lastSequence)lastReceiptMono=readMono;
   startTicks=proof.startTicks;monoPid=proof.pid;configurationHash=proof.configSha256;lastSequence=proof.sequence;lastReceiptWall=proof.checkedAtMs;
   checking='wake_receipt_changed';if(wakeProof&&fileDigest(readNativeFile(wakeProof.receiptFile,16384,true))!==wakeProof.receiptSha256)return refused('wake_receipt_changed');
   return true;
  }catch(error){captureNativeSource(capture,{stage,predicate:checking,exceptionClass:nativeSourceException(error)});return custodyRefused('custody_read_failed');}
 };
 const evidence=(testBoundary?.createEvidence??((input:any)=>new NativeGameEvidence(input)))({...options.evidence,sanityTiming:timing,directory:join(facts.runDirectory,'evidence'),romSha1:facts.romSha1,sourceFiles:installedSources,ownedCustodyCurrent:(capture?:NativeSourceCapture)=>custodyCurrent(capture)&&(!facts.wakePreparation||wakeProof!==null||(()=>{captureNativeSource(capture,{stage:'owned-scope',predicate:'wake_proof_missing'});return false;})()),sessionDurationMs:Math.min(options.native.sessionDurationMs,Date.parse(facts.expiresAt)-Date.now())});
 // Read-only exact inspection is shared with the original 500ms poll. This
 // never supplies source/operation authority; the original synchronous checks
 // still run after each awaiting client continuation.
 const inspectionOwnerCurrent=(selected:string)=>{
  const now=Date.now(),mono=performance.now();if(now<lastWall)clockCurrent=false;lastWall=now;
  let predicate:NativeOwnerFailurePredicate|undefined;
  if(!clockCurrent)predicate='clock_current';else if(closed)predicate='owner_closed';else if(nativeSignal?.aborted)predicate='signal_current';else if(!child?.pid)predicate='child_pid';else if(child.exitCode!==null||child.signalCode!==null)predicate='child_running';else if(cid!==selected)predicate='cid_current';else if(!verifiedRunning)predicate='verified_running';else if(mono>=expiresMono)predicate='native_monotonic_current';else if(now>=Date.parse(facts.expiresAt))predicate='native_wall_current';else if(!evidence.installationAvailable(scope,pins))predicate='installation_current';
  if(predicate)throw ownerError('inspect-poll',predicate,'Native inspection owner unavailable');
  if(closed)predicate='owner_closed';else if(nativeSignal?.aborted)predicate='signal_current';else if(cid!==selected)predicate='cid_current';
  if(predicate)throw ownerError('inspect-poll',predicate,'Native inspection owner changed');
 };
 const refreshInspection=()=>{
  if(inspectionOperation)return inspectionOperation;
  const selected=cid;
  const measured=inspectionTiming.begin();
  const operation=Promise.resolve().then(async()=>{
   if(!selected)throw ownerError('inspect-poll','cid_current','Native inspection CID unavailable');
   const deadline=Math.min(performance.now()+timing.readRefreshTimeoutMs,expiresMono);
   for(let attempt=0;;attempt++){
    measured.phase('owner-before');inspectionOwnerCurrent(selected);const left=deadline-performance.now();if(left<=0)throw ownerError('inspect-poll','readback_deadline','Native inspection refresh deadline');
    // The remaining monotonic allowance is fractional; Node's process timeout
    // accepts whole milliseconds. Round down without renewing this deadline.
    const timeoutMs=Math.floor(Math.min(timing.inspectionTimeoutMs,left));
    if(timeoutMs<1)throw ownerError('inspect-poll','readback_deadline','Native inspection refresh deadline');
    try{measured.phase('engine-read');await inspect(selected,true,timeoutMs);break;}
    catch(error){
     const timedOut=error&&typeof error==='object'&&!types.isProxy(error)&&Object.getOwnPropertyDescriptor(error,'code')?.value==='ETIMEDOUT';
     if(!timedOut||attempt>=1||performance.now()>=deadline)throw error;
     measured.phase('owner-before');inspectionOwnerCurrent(selected); // Revalidate identity/auth before ONE read retry.
    }
   }
   const inspectedWall=Date.now(),inspectedMono=performance.now();
   measured.phase('owner-after');
   inspectionOwnerCurrent(selected);
   // Source validation cannot make an older inspection look newer. Preserve
   // the measured completion time and reject if qualification used its freshness.
   const now=Date.now(),mono=performance.now();if(now<lastWall||now<inspectedWall||mono<inspectedMono){clockCurrent=false;throw ownerError('inspect-poll','inspect_clock_current','Native inspection clock changed');}
   let predicate:NativeOwnerFailurePredicate|undefined;
   if(closed)predicate='owner_closed';else if(nativeSignal?.aborted)predicate='signal_current';else if(cid!==selected)predicate='cid_current';else if(mono>=expiresMono)predicate='native_monotonic_current';else if(now>=Date.parse(facts.expiresAt))predicate='native_wall_current';else if(now-inspectedWall>timing.inspectionFreshnessMs)predicate='inspect_fresh';
   if(predicate)throw ownerError('inspect-poll',predicate,'Native inspection completion unavailable');
   lastWall=now;inspectChecked=inspectedWall;
   measured.phase('finished');
  });
  inspectionOperation=operation;void operation.catch(()=>{originalInspectionRejection??=inspectionTiming.snapshot();measured.phase('failed');}).catch(()=>{});void operation.finally(()=>{if(inspectionOperation===operation)inspectionOperation=undefined;}).catch(()=>{});return operation;
 };
 const refreshCustody=async(signal:AbortSignal)=>{
  const refreshStarted=performance.now();
  if(!custodyDiagnosticArmed||closed||signal.aborted){const error=Error('Native inspection refresh unavailable');captureRefreshFailure(!custodyDiagnosticArmed?'not_armed':closed?'owner_closed':'caller_aborted',error,signal,refreshStarted);throw error;}
  // Demand joins an exact in-flight inspection or begins a new one; do not
  // reuse an earlier completed cache before subsequent qualification.
  const work=refreshInspection();
  await new Promise<void>((resolve,reject)=>{
   let settled=false;
   const abort=()=>finish(Error('Native inspection refresh cancelled'),undefined,'demand_abort');
   const timer=setTimeout(()=>finish(Error('Native inspection refresh deadline'),ownerError('inspect-poll','readback_deadline','Native inspection refresh deadline'),'demand_timeout'),timing.readRefreshTimeoutMs);
   const finish=(error?:Error,original?:unknown,branch:'demand_abort'|'demand_timeout'|'inspection_rejected'='inspection_rejected')=>{
    if(settled)return;settled=true;if(error)captureRefreshFailure(branch,original??error,signal,refreshStarted);clearTimeout(timer);signal.removeEventListener('abort',abort);
    // Demand-owned inspections are skipped by the background poll. Preserve
    // their original closed witness here before the client fences/cleans up.
    // A late result after caller cancellation is not a new failure.
    if(original!==undefined&&!closed&&!signal.aborted)reportNativeOpenFailure('inspect-poll',original,createNativeOwnerFailureWitness('inspect-poll','inspection_rejected',original));
    error?reject(error):resolve();
   };
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   work.then(()=>finish(),error=>finish(Error('Native inspection refresh unavailable'),error));
  });
  if(signal.aborted||closed){const error=Error('Native inspection refresh cancelled');captureRefreshFailure(signal.aborted?'post_await_abort':'post_await_close',error,signal,refreshStarted);throw error;}
 };
 const acceptWakeProof=()=>{
  if(!facts.wakePreparation||wakeProof)return true;
  const receiptFile=evidence.evidenceFile+'.wake.json';let bytes:Buffer;
  try{bytes=readNativeFile(receiptFile,16384,true);}catch(error){if((error as any)?.code==='ENOENT')return false;throw error;}
  if(!custodyCurrent()||!cid||monoPid===undefined||startTicks===undefined)throw Error('Wake native custody unavailable');
  const value=validateWakePreludeReceipt(JSON.parse(bytes.toString('utf8')),{scope,scopeDigest:scopeDigest(scope),pinsDigest:pins,invocationNonce:nonce,pid:monoPid,startTicks,nowMs:Date.now(),maximumScreenshotTtlMs:options.native.frameCustody.limits.maxTtlMs});
  for(const shot of [value.initialScreenshot,value.finalScreenshot]){
   const actual=readNativeFile(join(facts.runDirectory,'frames',shot.mediaRef+'.png'),2097152,true);
   try{if(actual.length!==shot.byteLength||fileDigest(actual)!==shot.sha256)throw Error('Wake actual frame identity changed');}finally{actual.fill(0);}
  }
  const readback=JSON.parse(readNativeFile(evidence.evidenceFile,65536,true).toString('utf8'));
  // The immutable file is moved before the rolling evidence snapshot. A scan
  // may see that narrow publication gap; it remains inside the same deadline.
  if(readback.wakePrelude===undefined)return false;
  if(!isDeepStrictEqual(readback.scope,scope)||readback.pinsDigest!==pins||readback.frameNumber!==84569||readback.paused!==true||readback.buttonsAvailable!==true||!isDeepStrictEqual(readback.wakePrelude,value)||!readback.buttons||Object.keys(readback.buttons).sort().join(',')!==['Up','Down','Left','Right','A','B','X','Y','L','R','Start','Select'].sort().join(',')||Object.values(readback.buttons).some(v=>v!==false))throw Error('Wake current paused native readback changed');
  if(!custodyCurrent()||!readNativeFile(receiptFile,16384,true).equals(bytes))throw Error('Wake immutable receipt changed');
  // Preserve only these two bounded game images before the ordinary custody
  // store expires them. Copies are historical evidence, never fresh inputs.
  const archivedImages=[];
  for(const [name,shot] of [['wake-initial.png',value.initialScreenshot],['wake-handoff.png',value.finalScreenshot]] as const){
   const body=readNativeFile(join(facts.runDirectory,'frames',shot.mediaRef+'.png'),2097152,true),path=join(facts.runDirectory,'evidence',name);
   try{if(fileDigest(body)!==shot.sha256||body.length!==shot.byteLength)throw Error('Wake image archive changed');writeFileSync(path,body,{flag:'wx',mode:0o600});archivedImages.push(Object.freeze({path,sha256:shot.sha256,byteLength:body.length,frameNumber:shot.frameNumber,capturedAt:shot.capturedAt}));}finally{body.fill(0);}
  }
  wakeProof=Object.freeze({receiptFile,receiptSha256:fileDigest(bytes),scopeDigest:scopeDigest(scope),pinsDigest:pins,invocationNonce:nonce,containerIdDigest:fileDigest(Buffer.from(cid)),nativePid:monoPid,nativeStartTicks:startTicks,engineeringActions:33,engineeringFrames:396,handoffFrame:84569,archivedImages:Object.freeze(archivedImages),finalScreenshot:Object.freeze({...value.finalScreenshot})});
  return true;
 };
 const shutdown=()=>shutdownPromise??=(async()=>{
  if(lastAction&&transport?.safetyRelease){const unavailable=async()=>{throw Error('Safety release only');};confirmed=await evidence.shutdownExactOldLease(lastAction,{observe:unavailable,applyController:unavailable,controlSave:unavailable,releaseControls:transport.safetyRelease},3000);}return confirmed;
 })();
 let termination:any=null,fullyClosed=false;
 const cleanup=async()=>{
  if(!createAttempted)return;
  const recovered=readCid();if(!recovered&&cid)throw Error('Owned CID marker lost; no container action taken');
  if(cid&&recovered!==cid)throw Error('Owned CID marker changed; no container action taken');
  const engine=readEngineCid();if(!engine||recovered&&recovered!==engine)throw Error('Created engine CID unconfirmed; no container action taken');
  const selected=cid??recovered??engine;await inspect(selected,recovered?undefined:false,cleanupLeft(timing.inspectionTimeoutMs)); // Never names, latest, all, or unrelated processes.
  try{await execute(['stop','--time','15',selected],cleanupLeft(20000));}catch{/* Exact inspect/removal below reconciles a bounded stop timeout. */}
  // Reassert identity even when stop timed out. Removal remains exact and bounded.
  await inspect(selected,undefined,cleanupLeft(timing.inspectionTimeoutMs));await execute(['rm',selected],cleanupLeft(15000));
  // Podman may remove its CID file with the exact container; Docker may retain it.
  // Absence is accepted only after the successful exact unforced removal above.
  let marker;try{marker=lstatSync(plan.cidfile);}catch(error){if((error as any)?.code!=='ENOENT')throw error;}
  if(marker){if(!marker.isFile()||readCid()!==selected)throw Error('Owned CID marker changed after cleanup');unlinkSync(plan.cidfile);}
  const engineAfter=readEngineCid();if(engineAfter!==undefined){if(engineAfter!==selected)throw Error('Engine CID marker changed after cleanup');unlinkSync(plan.engineCidfile);}
  cid=undefined;verifiedRunning=false;
  const value={scopeDigest:scopeDigest(scope),pinsDigest:pins,invocation:nonce,containerIdDigest:fileDigest(Buffer.from(selected)),removed:true};termination=Object.freeze({...value,receiptRef:'native-termination:'+fileDigest(Buffer.from(JSON.stringify(value)))});
  // A stop timeout followed by verified removal is reconciled; retain consumed marker.
 };
 const close=(initiator:NativeCloseInitiator='external_close')=>closePromise??=(async()=>{
  cleanupDeadline=performance.now()+timing.cleanupTimeoutMs;
  captureNativeClose(initiator);closed=true;
  try{await shutdown();}finally{
   clearInterval(poll);
   try{await host?.close();}finally{try{await createOperation?.catch(()=>{});await cleanup();}finally{
    if(child?.pid&&child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await Promise.race([exited,new Promise<void>(resolve=>setTimeout(resolve,Math.max(1,Math.min(20000,cleanupDeadline-performance.now()))))]);if(child.exitCode===null&&child.signalCode===null){const killed=new Promise<void>(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await Promise.race([killed,new Promise<void>(resolve=>setTimeout(resolve,Math.max(1,Math.min(5000,cleanupDeadline-performance.now()))))]);if(child.exitCode===null&&child.signalCode===null)throw Error('Owned native wrapper exit unconfirmed');}}
   }}
  }
  fullyClosed=true;
 })();
 const ownedFailure=(stage:NativeOwnerFailureStage,predicate:NativeOwnerFailurePredicate,error?:unknown,transportCode?:unknown)=>{
  if(!closed)reportNativeOpenFailure(stage,error,createNativeOwnerFailureWitness(stage,predicate,error,transportCode));
  closeOriginalCause??=createNativeOwnerFailureWitness(stage,predicate,error,transportCode);verifiedRunning=false;void close('owned_failure').catch(()=>{});
 };
 const writeRecord=(value:any)=>new Promise<void>((resolve,reject)=>{const line=JSON.stringify(value)+'\n';if(Buffer.byteLength(line)>65536)return reject(Error('Native command exceeded bound'));child.stdin.write(line,(error:any)=>error?reject(error):resolve());});
 const takePairing=(signal:AbortSignal)=>new Promise<Uint8Array>((resolve,reject)=>{
  let settled=false;const finish=(error?:Error,value?:Uint8Array)=>{if(settled){value?.fill(0);return;}settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve(value!);};
  const abort=()=>finish(Error('Native pairing cancelled')),timer=setTimeout(()=>finish(Error('Native pairing deadline')),timing.nativePairingTimeoutMs);
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted){abort();return;}
  Promise.resolve().then(()=>{if(signal.aborted||closed||!current())throw Error('Native pairing scope withdrawn');return options.takePairingSecret(Object.freeze({scope:structuredClone(scope),pinsDigest:pins,approvalRef:facts.pairing.approvalRef,expiresAt:facts.pairing.expiresAt,invocationNonce:nonce,signal}));}).then(value=>{
   if(!(value instanceof Uint8Array)||value.byteLength!==32){if(value instanceof Uint8Array)value.fill(0);finish(Error('Exact approved in-memory native pairing required'));return;}finish(undefined,value);
  },()=>finish(Error('Native pairing unavailable')));
 });
 const prepared=(signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  let bytes='';const timer=setTimeout(()=>finish(Error('Native preparation deadline')),timing.nativePreparationTimeoutMs);
  const finish=(error?:Error)=>{clearTimeout(timer);child.stdout.off('data',data);child.off('exit',ended);child.off('error',ended);signal.removeEventListener('abort',aborted);error?reject(error):resolve();};
  const ended=()=>finish(Error('Native agent preparation ended')),aborted=()=>finish(Error('Native preparation cancelled'));
  const data=(part:Buffer)=>{bytes+=part.toString('utf8');if(Buffer.byteLength(bytes)>1024)return finish(Error('Native preparation exceeded bound'));if(bytes.includes('\n')){try{const value=JSON.parse(bytes.trim());if(value.event!=='native-prepared'||value.invocation!==nonce)throw Error();finish();}catch{finish(Error('Native preparation identity changed'));}}};
  child.stdout.on('data',data);child.once('exit',ended);child.once('error',ended);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
 });
 const nativeOpenErrnos=new Set(['EACCES','EPERM','ENOENT','EEXIST','ENOTDIR','ELOOP','ENOSPC','EMFILE','ENFILE','EPIPE','ECONNREFUSED','ECONNRESET','EADDRINUSE','ETIMEDOUT','EIO']);
 let nativeOpenFailureReported=false;
 const reportNativeOpenFailure=(stage:string,error:unknown,originalWitness?:NativeOwnerFailureWitness)=>{
  if(nativeOpenFailureReported)return;nativeOpenFailureReported=true;
  try{
   const tagged=error&&typeof error==='object'?ownerFailureWitnesses.get(error):undefined;
   const witness:any={...(tagged??originalWitness??{stage,exceptionClass:nativeSourceException(error)})};
   // Local first-error evidence precedes cleanup. Never publish its bounded,
   // scrubbed original message/stack/cause or subprocess stderr through HTTP.
   try{
    canonicalNativePath(join(facts.runDirectory,'evidence'),true,true);
    writeFileSync(join(facts.runDirectory,'evidence','native-open-original-error.private.json'),JSON.stringify({schemaVersion:'native-open-original-error/1',witness,original:captureNativeOriginalError(error,{captureStderr:stage.includes('inspect')})})+'\n',{flag:'wx',mode:0o600});
   }catch{} // Diagnostic persistence cannot change the failure or cleanup.
   // Read only an own data property, never error text, getters or process output.
   if(error&&typeof error==='object'&&!types.isProxy(error)){
    const code=Object.getOwnPropertyDescriptor(error,'code');
    if(code&&Object.hasOwn(code,'value')){
     if(typeof code.value==='string'&&nativeOpenErrnos.has(code.value))witness.errno=code.value;
     else if(Number.isSafeInteger(code.value)&&code.value>=0&&code.value<=255)witness.exitCode=code.value;
    }
    const stderr=Object.getOwnPropertyDescriptor(error,'stderr');
    if(stderr&&Object.hasOwn(stderr,'value')&&typeof stderr.value==='string'&&stderr.value.length<=8192&&Buffer.byteLength(stderr.value)<=8192){
     witness.stderrClass=stderr.value.length===0?'empty':stderr.value.includes('current system boot ID differs from cached boot ID')?'cached_boot_id_mismatch':'unclassified';
    }
   }
   reportCustodyFailure?.(Object.freeze({schemaVersion:'ct-runtime-first-cause/1',source:'native',phase:'native-open',reason:'open_failed',nativeOpenWitness:Object.freeze(witness)}));
  }catch{} // Optional diagnostics cannot replace the original failure or cleanup.
 };
 const openNative=async(boundary:any,context:any,launch:any)=>{
  // One whole-startup ceiling, independently clipped to the actual native grant.
  const startupDeadline=Math.min(performance.now()+timing.startupOverallTimeoutMs,expiresMono);
  const startupLeft=(limit=timing.startupOverallTimeoutMs)=>{
   const left=Math.min(limit,startupDeadline-performance.now());
   if(left<=0||Date.now()>=Date.parse(facts.expiresAt)||context.signal.aborted||closed)throw Error('Native startup deadline');
   return Math.max(1,Math.floor(left));
  };
  const startupWait=<T>(work:Promise<T>,limit=timing.startupOverallTimeoutMs,disposeLate?:(value:T)=>void)=>new Promise<T>((resolve,reject)=>{
   let done=false;const finish=(failed:boolean,error:unknown,value?:T)=>{if(done){if(value!==undefined)disposeLate?.(value);return;}done=true;clearTimeout(timer);context.signal.removeEventListener('abort',abort);failed?reject(error):resolve(value!);};
   const abort=()=>finish(true,Error('Native startup cancelled')),timer=setTimeout(()=>finish(true,Error('Native startup deadline')),startupLeft(limit));
   context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
   work.then(value=>{try{startupLeft();finish(false,undefined,value);}catch{finish(true,Error('Native startup deadline'));}},error=>finish(true,error));
  });
  let openStage='guard';
  try{
  if(closed||launchConsumed||context.signal.aborted||!current()||!context.isCurrent(scope)||launch.host!=='127.0.0.1'||!Number.isInteger(launch.port)||launch.port<1024||launch.port>65535||!isDeepStrictEqual(launch.continuation,facts.continuation))throw Error('Owned native launch fenced');
  // Re-read every closed fact/pin and fresh directory immediately before consuming
  // the one-run marker. No pairing body is read during readiness or construction.
  openStage='facts';
  if(!isDeepStrictEqual(readC72NativeConfiguration(options.configurationFile,scope,pins),facts))throw Error('Native approved facts changed');
  openStage='consume';
  nativeSignal=context.signal;launchConsumed=true;writeFileSync(join(facts.runDirectory,'consumed.json'),JSON.stringify({nonce,scopeDigest:scopeDigest(scope),pinsDigest:pins}),{flag:'wx',mode:0o600});
  const abort=()=>{void close('native_signal_abort').catch(()=>{});};context.signal.addEventListener('abort',abort,{once:true});
  let secret:Buffer|undefined;
  try{
   openStage='create-check';
   createOperation=Promise.resolve().then(async()=>{if(closed||context.signal.aborted||!current())throw Error('Native create cancelled');freshCidTargets();createAttempted=true;openStage='create';const output=(await execute(plan.argv,startupLeft(45000))).trim();openStage='create-identity';if(!cidPattern.test(output)||readEngineCid()!==output)throw Error('Native create ownership unavailable');openStage='inspect-created';await startupWait(inspect(output,false,startupLeft(timing.inspectionTimeoutMs)));openStage='publish-cid';publishCid(output);cid=output;return output;});const raw=(await startupWait(createOperation)).trim(),recorded=readCid();
   openStage='published-identity';
   if(!cidPattern.test(raw)||raw!==recorded)throw Error('Native create ownership unavailable');cid=raw;openStage='inspect-published';await startupWait(inspect(cid,false,startupLeft(timing.inspectionTimeoutMs)));
   openStage='start-wrapper';
   if(closed||context.signal.aborted||!current()||Date.now()>=Date.parse(facts.expiresAt))throw Error('Native launch cancelled or approval expired');
   child=(testBoundary?.spawn??spawn)(facts.wrapper.path,['start','--attach','--interactive',cid],{env:environment(),stdio:['pipe','pipe','ignore']});
   evidence.bindOwnedProcess(child);child.once('error',(error:unknown)=>ownedFailure('wrapper-error','wrapper_ended',error));child.once('exit',(code:unknown,signal:unknown)=>ownedFailure('wrapper-exit','wrapper_ended',Object.assign(Error('Native wrapper ended'),{code,signal})));
   child.stdin.on('error',(error:unknown)=>ownedFailure('wrapper-stdin','wrapper_stdin_error',error));
   openStage='prepare';
   const waiting=startupWait(prepared(context.signal),timing.nativePreparationTimeoutMs);void waiting.catch(()=>{});
   openStage='prepare-write';
   await startupWait(writeRecord({phase:'prepare',...(options.native.executionLifetime?{nativeAuthority:nativeExecutionCustodyBounds(options.native.executionLifetime)}:{}),scopeDigest:scopeDigest(scope),pinsDigest:pins,sessionDurationMs:options.native.sessionDurationMs,expiresAtMs:Date.parse(facts.expiresAt),romSha1:facts.romSha1,sourcePins,imagePins:facts.imagePins,...(facts.wakePreparation?{wakePreparation:facts.wakePreparation}:{}),sanityTiming:{startupOverallTimeoutMs:timing.startupOverallTimeoutMs,noProgressTimeoutMs:timing.noProgressTimeoutMs,inspectionTimeoutMs:timing.inspectionTimeoutMs,cleanupTimeoutMs:timing.cleanupTimeoutMs}}));
   openStage='prepare-wait';
   await waiting;
   openStage='pair';
   if(closed||context.signal.aborted||!current()||Date.now()>=Date.parse(facts.expiresAt))throw Error('Native launch expired');
   const supplied=await startupWait(takePairing(context.signal),timing.nativePairingTimeoutMs,value=>value.fill(0));
   secret=Buffer.from(supplied);supplied.fill(0);
   if(closed||context.signal.aborted||!current()||Date.now()>=Date.parse(facts.expiresAt))throw Error('Native pairing scope expired');
   const native={...options.native,sanityTiming:timing,connectionTimeoutMs:timing.nativeStartupTimeoutMs,refreshSourceCustody:refreshCustody,wakePrelude:facts.wakePreparation?captureWakePreludeConfiguration({kind:facts.wakePreparation,invocationNonce:nonce}):undefined,pairingSecret:secret,port:launch.port,romSha1:facts.romSha1,scope,pinsDigest:pins,boundary,shutdownAdmission:evidence.admitRelease,onDisconnect:(code:unknown)=>ownedFailure('transport-disconnect','transport_closed',undefined,code)};
   openStage='listen';
   host=await startupWait((testBoundary?.listen??listenForNativeBizHawk)(native),timing.nativeStartupTimeoutMs,(value:any)=>{void value.close();});
   openStage='launch-write';
   await startupWait(writeRecord({phase:'launch',environment:{...nativeBridgeEnvironment(native),LIFESTREAM_BIZHAWK_EVIDENCE_FILE:evidence.evidenceFile}}));secret.fill(0);secret=undefined;
   openStage='connect';transport=await startupWait(host.connected,timing.nativeStartupTimeoutMs);openStage='ready';await startupWait(transport.ready,timing.nativeReadyTimeoutMs);
   openStage='inspect-running';
   await startupWait(inspect(cid,true,startupLeft(timing.inspectionTimeoutMs)));verifiedRunning=true;inspectChecked=Date.now();
   poll=setInterval(()=>{if(inspectionOperation||!cid)return;void refreshInspection().catch(error=>ownedFailure('inspect-poll','inspection_rejected',error));},500);poll.unref?.();
   openStage='readback';
   const deadline=Math.min(performance.now()+timing.nativeReadyTimeoutMs,expiresMono,startupDeadline);
   while(true){
    if(closed)throw ownerError('readback','owner_closed','Native GUI/source or wake preparation unavailable');
    if(context.signal.aborted)throw ownerError('readback','signal_current','Native GUI/source or wake preparation unavailable');
    if(!current())throw ownerError('readback','readback_current','Native GUI/source or wake preparation unavailable');
    if(performance.now()>=deadline)throw ownerError('readback','readback_deadline','Native GUI/source or wake preparation unavailable');
    if(custodyCurrent()&&acceptWakeProof())break;
    await startupWait(new Promise(resolve=>setTimeout(resolve,20)));
   }
   if(closed)throw ownerError('readback','owner_closed','Native readback unavailable');
   if(context.signal.aborted)throw ownerError('readback','signal_current','Native readback unavailable');
   if(!current())throw ownerError('readback','readback_current','Native readback unavailable');
   if(performance.now()>=deadline)throw ownerError('readback','readback_deadline','Native readback unavailable');
   if(!evidence.sourceAvailable(scope,pins))throw ownerError('readback','source_available','Native readback unavailable');
   custodyDiagnosticArmed=true;
   return {adapter:{...transport.adapter,applyController:async(request:any,call:any)=>{lastAction=request;return transport.adapter.applyController(request,call);}},close:()=>{context.signal.removeEventListener('abort',abort);void close('native_handle_close').catch(()=>{});}};
  }catch(error){reportNativeOpenFailure(openStage,error);context.signal.removeEventListener('abort',abort);closeOriginalCause??=error&&typeof error==='object'?ownerFailureWitnesses.get(error):undefined;await close('startup_catch');throw error;}finally{secret?.fill(0);}
  }catch(error){reportNativeOpenFailure(openStage,error);throw error;}
 };
 return Object.freeze({evidence,openNative,get mediaAvailable(){return !closed&&custodyCurrent()&&ownedGameMediaAvailable(join(facts.runDirectory,'evidence'));},openMedia:(signal:AbortSignal,observerCurrent:()=>boolean)=>openOwnedGameMedia({directory:join(facts.runDirectory,'evidence'),runId:scope.runId,pinsDigest:pins,invocation:nonce,current:()=>!closed&&custodyCurrent()&&observerCurrent(),signal}),refreshCustody,captureRefreshTimeout,close,shutdownExactOldLease:shutdown,get wakePreparationReceipt(){return wakeProof;},get transportQuiescent(){return transport?.isQuiescent()===true;},get pauseConfirmed(){return confirmed;},get terminationReceipt(){return fullyClosed?termination:null;}});
}
