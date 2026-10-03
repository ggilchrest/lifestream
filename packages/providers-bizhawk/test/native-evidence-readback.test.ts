import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {ChildProcess} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type * as G from '@lifestream/contracts/game-activity';
import {NativeGameEvidence} from '../src/native-evidence.ts';
import {GameFrameCustody} from '../src/frame-custody.ts';
import type {GameActivityAdapter} from '../src/port.ts';
import {action,applied} from './game-host-fixtures.ts';
import {GAME_HOST_PROTOCOL as protocol,GAME_HOST_NATIVE_EVIDENCE_VERSION,gameHostDigest,gameHostMessage,gameHostUsageMatches,gameHostShutdownMatches} from '@lifestream/contracts/game-host';

// Actual bounded file readback and source hashes; the owned child and the native
// file producer are explicitly synthetic. No emulator, input or live source.
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'native-readback-')),source=join(directory,'source.txt');
 writeFileSync(source,'synthetic pinned native implementation');
 const r=action(),result=applied(r),child={pid:process.pid,exitCode:null,signalCode:null} as unknown as ChildProcess;
 let current=true,sequence=0;
 const custody=new GameFrameCustody(directory,{maxBytes:1024,maxQueueBytes:1024,maxLongEdge:256,maxFrames:1,maxTtlMs:5000,current:()=>current});
 const evidence=new NativeGameEvidence({directory,scope:r.scope,pinsDigest:r.payload.expectedPinsDigest,providerRef:result.providerRef,romSha1:'b'.repeat(40),sourceFiles:[{path:source,sha256:createHash('sha256').update('synthetic pinned native implementation').digest('hex')}],custody,sessionDurationMs:5000,isCurrent:()=>current});
 evidence.bindOwnedProcess(child);
 const nativeAction={requestId:r.requestId,correlationId:r.correlationId,inputOwnerLeaseId:r.payload.inputOwnerLeaseId,startedMonotonicMs:100,completedMonotonicMs:112.75,verifiedInputFrames:2,requestedButtons:r.payload.buttonVector,receipt:result.outcome.payload};
 const snapshot:any={schemaVersion:'1.0.0',recordType:'nativeGameEvidence',scope:r.scope,pinsDigest:r.payload.expectedPinsDigest,providerRef:result.providerRef,version:'2.11.1',system:'SNES',romSha1:'b'.repeat(40),sequence:0,frameNumber:12,monotonicMs:300,checkedAt:'',paused:false,buttonsAvailable:true,buttons:Object.fromEntries(['Up','Down','Left','Right','A','B','X','Y','L','R','Start','Select'].map(key=>[key,false])),lastAction:nativeAction,lastActionResult:result,actionStarted:{actionId:r.payload.actionId,inputOwnerLeaseId:r.payload.inputOwnerLeaseId},event:'action'};
 const write=()=>{snapshot.sequence=++sequence;snapshot.checkedAt=new Date().toISOString();writeFileSync(evidence.evidenceFile,JSON.stringify(snapshot));};write();
 const release=(mutate?:(result:G.GameReleaseResult)=>void):GameActivityAdapter=>{
  const unavailable=async()=>{throw Error('Only synthetic old-lease safety readback is configured');};
  return {observe:unavailable,applyController:unavailable,controlSave:unavailable,releaseControls:async request=>{
   const result:G.GameReleaseResult={schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:'synthetic-bridge',completedAt:new Date().toISOString(),outcome:{status:'succeeded',error:null,payload:{targetInputOwnerLeaseId:request.payload.targetInputOwnerLeaseId,disposition:'neutralizedAndPaused',confirmedAt:new Date().toISOString(),emulatorPaused:true,buttonsNeutralized:true,pauseFrameNumber:12,verifiedFrameNumber:12,pauseConfirmedMonotonicMs:290,verifiedMonotonicMs:295,activityEpochAfterFence:r.scope.activityEpoch+1,confirmationSource:'adapterObserved',resumeRequiresFreshObservation:true}}};
   mutate?.(result);snapshot.lastRelease=result;snapshot.paused=true;write();return result;
  }};
 };
 return {directory,source,r,result,child,evidence,snapshot,nativeAction,write,release,setCurrent:(value:boolean)=>{current=value;},dispose:()=>{custody.dispose();rmSync(directory,{recursive:true,force:true});}};
}

test('controller capture requires accepted exact owned readback and preserves measured monotonic usage',()=>{
 const f=fixture();try{
  assert.equal(f.evidence.captureControllerReadback(f.r,f.result),null);
  assert.equal(f.evidence.acceptAction(f.r,f.result),true);
  const captured=f.evidence.captureControllerReadback(f.r,f.result)!;
  assert.equal(captured.action.startedMonotonicMs,100);assert.equal(captured.action.completedMonotonicMs,112.75);
  assert.equal(captured.wallMs,13);assert.notEqual(captured.wallMs,f.r.payload.proposal.maxWallMs);
  assert.equal(Object.isFrozen(captured),true);assert.equal(Object.isFrozen(captured.action.receipt),true);
  assert.throws(()=>{captured.action.completedMonotonicMs=900;},TypeError);
  f.nativeAction.completedMonotonicMs=150;f.write();
  assert.equal(captured.action.completedMonotonicMs,112.75);
  assert.equal(f.evidence.acceptAction(f.r,f.result),false,'An accepted action cannot be overwritten with a different native measurement');
 }finally{f.dispose();}
});

test('wire usage retains owned measurement and closed correlation; shape and hashes alone cannot replace it',()=>{
 const f=fixture();try{
  assert.equal(f.evidence.acceptAction(f.r,f.result),true);const evidence=f.evidence.controllerUsageEvidenceFor(f.r,f.result)!;
  assert.equal(gameHostUsageMatches(f.r,f.result,evidence),true);
  const completion={protocol,attachmentId:randomUUID(),commandId:randomUUID(),requestDigest:gameHostDigest(f.r),resultDigest:gameHostDigest(f.result),result:f.result,nativeUsage:evidence};
  assert.ok(gameHostMessage('completion',completion));
  for(const patch of [{extra:true},{verifiedInputFrames:1.5},{startedMonotonicMs:-1},{completedMonotonicMs:99}])assert.equal(gameHostMessage('completion',{...completion,nativeUsage:{...evidence,...patch}}),null);
  for(const patch of [{inputOwnerLeaseId:randomUUID()},{resultDigest:'f'.repeat(64)},{completedMonotonicMs:113},{verifiedInputFrames:1}])assert.equal(gameHostUsageMatches(f.r,f.result,{...evidence,...patch}),false);
  const wrong={...f.result,requestId:randomUUID()};assert.equal(gameHostUsageMatches(f.r,wrong,{...evidence,resultDigest:gameHostDigest(wrong)}),false);
 }finally{f.dispose();}
});

test('wire shutdown preserves original action lease and stationary native readback in a closed evidence-only message',async()=>{
 const f=fixture();try{
  assert.equal(f.evidence.acceptAction(f.r,f.result),true);assert.equal(await f.evidence.shutdownExactOldLease(f.r,f.release(),1000),true);
  const evidence=f.evidence.shutdownEvidenceFor(f.r)!,binding={hostId:randomUUID(),scope:f.r.scope,pinsDigest:f.r.payload.expectedPinsDigest,providerRef:f.result.providerRef,sourceRevision:'b'.repeat(64)};
  const message={protocol,attachmentId:randomUUID(),nativeEvidenceVersion:GAME_HOST_NATIVE_EVIDENCE_VERSION,evidence};
  assert.ok(gameHostMessage('shutdown',message));assert.equal(gameHostShutdownMatches(binding,f.r,evidence),true);
  assert.equal(gameHostMessage('shutdown',{...message,nativeEvidenceVersion:'future'}),null);assert.equal(gameHostMessage('shutdown',{...message,evidence:{...evidence,extra:true}}),null);
  const moved=structuredClone(evidence);moved.release.outcome.payload!.verifiedFrameNumber!++;assert.equal(gameHostMessage('shutdown',{...message,evidence:moved}),null);
  assert.equal(gameHostShutdownMatches(binding,f.r,{...evidence,actionRequestDigest:'c'.repeat(64)}),false);
  assert.equal(gameHostShutdownMatches(binding,{...f.r,payload:{...f.r.payload,inputOwnerLeaseId:randomUUID()}},evidence),false);
 }finally{f.dispose();}
});

for(const scenario of ['negative','nonfinite','backward','overbound','wrongLease','wrongFrames','wrongReceiptScope','wrongResultIdentity'] as const)test('native readback refuses '+scenario,()=>{
 const f=fixture();try{
  if(scenario==='negative')f.nativeAction.startedMonotonicMs=-1;
  if(scenario==='nonfinite')f.nativeAction.completedMonotonicMs=Infinity;
  if(scenario==='backward')f.nativeAction.completedMonotonicMs=99;
  if(scenario==='overbound')f.nativeAction.completedMonotonicMs=201;
  if(scenario==='wrongLease')f.nativeAction.inputOwnerLeaseId=randomUUID();
  if(scenario==='wrongFrames')f.nativeAction.verifiedInputFrames=1;
  if(scenario==='wrongReceiptScope')f.result.outcome.payload!.scope.runId=randomUUID();
  if(scenario==='wrongResultIdentity')f.result.correlationId=randomUUID();
  f.write();assert.equal(f.evidence.acceptAction(f.r,f.result),false);
  assert.equal(f.evidence.captureControllerReadback(f.r,f.result),null);
 }finally{f.dispose();}
});

test('capture refuses changed request, source, currentness or owned process',()=>{
 const f=fixture();try{
  assert.equal(f.evidence.acceptAction(f.r,f.result),true);
  const changed=structuredClone(f.r);changed.payload.inputOwnerLeaseId=randomUUID();
  assert.equal(f.evidence.captureControllerReadback(changed,f.result),null);
  f.setCurrent(false);assert.equal(f.evidence.captureControllerReadback(f.r,f.result),null);f.setCurrent(true);
  writeFileSync(f.source,'changed');assert.equal(f.evidence.captureControllerReadback(f.r,f.result),null);
  writeFileSync(f.source,'synthetic pinned native implementation');
  (f.child as any).exitCode=0;assert.equal(f.evidence.captureControllerReadback(f.r,f.result),null);
 }finally{f.dispose();}
});

test('shutdown capture survives gameplay fence only after exact owned old-lease pause and neutral readback',async()=>{
 const f=fixture();try{
  assert.equal(f.evidence.captureShutdownReadback(f.r),null);f.setCurrent(false);
  assert.equal(await f.evidence.shutdownExactOldLease(f.r,f.release()),true);
  const captured=f.evidence.captureShutdownReadback(f.r)!;
  assert.equal(captured.release.outcome.payload!.targetInputOwnerLeaseId,f.r.payload.inputOwnerLeaseId);
  assert.equal(Object.isFrozen(captured.action.payload),true);
  const changed=structuredClone(f.r);changed.requestId=randomUUID();assert.equal(f.evidence.captureShutdownReadback(changed),null);
  f.snapshot.actionStarted.inputOwnerLeaseId=randomUUID();f.write();
  assert.equal(f.evidence.captureShutdownReadback(f.r),null,'A successor lease must not be mistaken for the old lease');
 }finally{f.dispose();}
});

for(const scenario of ['wrongLease','wrongRequest','unpaused','movingFrame','nonfinite','backward','unconfirmed'] as const)test('shutdown never confirms '+scenario,async()=>{
 const f=fixture();try{
  const adapter=f.release(result=>{
   const receipt=result.outcome.payload!;
   if(scenario==='wrongLease')receipt.targetInputOwnerLeaseId=randomUUID();
   if(scenario==='wrongRequest')result.requestId=randomUUID();
   if(scenario==='unpaused')receipt.emulatorPaused=false;
   if(scenario==='movingFrame')receipt.verifiedFrameNumber=13;
   if(scenario==='nonfinite')receipt.verifiedMonotonicMs=null;
   if(scenario==='backward')receipt.verifiedMonotonicMs=289;
   if(scenario==='unconfirmed')receipt.confirmationSource='unconfirmed';
  });
  assert.equal(await f.evidence.shutdownExactOldLease(f.r,adapter),false);
  assert.equal(f.evidence.captureShutdownReadback(f.r),null);
 }finally{f.dispose();}
});

test('no entered action never manufactures a shutdown lease or proof',async()=>{
 const f=fixture();try{assert.equal(await f.evidence.shutdownExactOldLease(null,f.release()),false);assert.equal(f.evidence.captureShutdownReadback(f.r),null);}finally{f.dispose();}
});
