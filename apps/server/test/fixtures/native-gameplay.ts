import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {ChildProcess} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type * as G from '@lifestream/contracts/game-activity';
import {GameFrameCustody,NativeGameEvidence,guardGameActivityAdapter} from '@lifestream/providers-bizhawk';
import type {GameActivityAdapter,WindowsGameHostClientOptions} from '@lifestream/providers-bizhawk';
import {framePng,frameResult} from '../../../../packages/providers-bizhawk/test/game-host-frame-fixtures.ts';

/** Synthetic native producer/child, actual owned file/hash/PNG readback and
 * production evidence producer. No emulator, enrollment or live input. */
export function nativeGameplayFixture(scope:G.ActivityScope,pinsDigest:string,providerRef:string){
 const directory=mkdtempSync(join(tmpdir(),'joined-native-gameplay-')),source=join(directory,'pinned-source.txt'),content='synthetic native source';writeFileSync(source,content);
 let current=true,sequence=0,frame=10,mono=300,controls=0,observations=0,releases=0;
 const custody=new GameFrameCustody(directory,{maxBytes:2097152,maxQueueBytes:2097152,maxLongEdge:1024,maxFrames:8,maxTtlMs:5000,current:()=>current});
 const evidence=new NativeGameEvidence({directory,scope,pinsDigest,providerRef,romSha1:'b'.repeat(40),sourceFiles:[{path:source,sha256:createHash('sha256').update(content).digest('hex')}],custody,sessionDurationMs:10000,isCurrent:()=>current});
 const child={pid:process.pid,exitCode:null,signalCode:null} as unknown as ChildProcess;evidence.bindOwnedProcess(child);
 const snapshot:any={schemaVersion:'1.0.0',recordType:'nativeGameEvidence',scope,pinsDigest,providerRef,version:'2.11.1',system:'SNES',romSha1:'b'.repeat(40),sequence:0,frameNumber:frame,monotonicMs:mono,checkedAt:'',paused:false,buttonsAvailable:true,buttons:Object.fromEntries(['Up','Down','Left','Right','A','B','X','Y','L','R','Start','Select'].map(key=>[key,false])),event:'ready'};
 const write=()=>{snapshot.sequence=++sequence;snapshot.monotonicMs=mono;snapshot.frameNumber=frame;snapshot.checkedAt=new Date().toISOString();writeFileSync(evidence.evidenceFile,JSON.stringify(snapshot));};write();
 const raw:GameActivityAdapter={
  observe:async request=>{
   observations++;const png=framePng(),result=frameResult(request,png),o=result.outcome.payload!.observation;result.providerRef=providerRef;o.scope=structuredClone(scope);o.pinsDigest=pinsDigest;o.frameNumber=frame;o.previousActionId=request.payload.afterActionId;
   o.screenshots[0]!.frameNumber=frame;writeFileSync(join(directory,o.screenshots[0]!.mediaRef+'.png'),png);assert.equal(custody.ingest(o),true);
   snapshot.lastObservation=result;snapshot.event='observe';write();return result;
  },
  applyController:async request=>{
   controls++;const time=new Date().toISOString(),before=frame;frame+=request.payload.proposal.durationFrames;
   const receipt:G.GameActionReceipt={schemaVersion:'1.0.0',recordType:'gameActionReceipt',scope:structuredClone(scope),actionId:request.payload.actionId,proposalId:request.payload.proposal.proposalId,idempotencyKey:request.idempotencyKey,inputDigest:request.payload.admission.inputDigest,admissionId:request.payload.admission.admissionId,disposition:'completed',beforeFrame:before,afterFrame:frame,framesApplied:frame-before,buttonsNeutralized:true,startedAt:time,completedAt:time,resultingObservationIds:[],recordedAt:time,reason:null};
   const result:G.GameActionResult={schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef,completedAt:time,outcome:{status:'succeeded',error:null,payload:receipt}};
   const start=mono;mono+=12.75;
   snapshot.lastAction={requestId:request.requestId,correlationId:request.correlationId,inputOwnerLeaseId:request.payload.inputOwnerLeaseId,startedMonotonicMs:start,completedMonotonicMs:mono,verifiedInputFrames:receipt.framesApplied,requestedButtons:request.payload.buttonVector,receipt};snapshot.lastActionResult=result;snapshot.actionStarted={actionId:request.payload.actionId,inputOwnerLeaseId:request.payload.inputOwnerLeaseId};snapshot.event='action';write();return result;
  },
  releaseControls:async request=>{
   releases++;const start=Math.ceil(mono);mono=start+5;
   const result:G.GameReleaseResult={schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef,completedAt:new Date().toISOString(),outcome:{status:'succeeded',error:null,payload:{targetInputOwnerLeaseId:request.payload.targetInputOwnerLeaseId,disposition:'neutralizedAndPaused',confirmedAt:new Date().toISOString(),emulatorPaused:true,buttonsNeutralized:true,pauseFrameNumber:frame,verifiedFrameNumber:frame,pauseConfirmedMonotonicMs:start,verifiedMonotonicMs:mono,activityEpochAfterFence:scope.activityEpoch+1,confirmationSource:'adapterObserved',resumeRequiresFreshObservation:true}}};
   snapshot.lastRelease=result;snapshot.paused=true;snapshot.event='release';write();return result;
  },controlSave:async()=>{throw Error('Ordinary saves are unavailable in this fixture');}
 };
 const ports:Pick<WindowsGameHostClientOptions,'nativeBoundary'|'sourceIsQualified'|'isScopeCurrent'|'openNative'|'nativeEvidence'|'frameTransfer'|'shutdownExactOldLease'>={
  nativeBoundary:{providerRef,maxDurationMs:5000,sourceAvailable:evidence.sourceAvailable,acceptObservation:evidence.acceptObservation,acceptAction:evidence.acceptAction,reconcileEffect:evidence.reconcileEffect,admitRelease:evidence.admitRelease},
  sourceIsQualified:()=>evidence.installationAvailable(scope,pinsDigest),isScopeCurrent:()=>current,
  openNative:async boundary=>({adapter:guardGameActivityAdapter(raw,boundary),close:()=>{}}),nativeEvidence:{usageFor:evidence.controllerUsageEvidenceFor},
  frameTransfer:{maximumFrames:8,maximumBytes:2097152,maximumLongEdge:1024,maximumAgeMs:5000,readOwnedFrame:async(request,observation)=>{if(!evidence.acceptObservation(request,observation))return null;return custody.read(observation.screenshots[0]!.mediaRef,scope).bytes;}},
  shutdownExactOldLease:async context=>{
   if(!context.lastEnteredAction)return null;
   if(!await evidence.shutdownExactOldLease(context.lastEnteredAction,raw,1000))return null;
   return evidence.shutdownEvidenceFor(context.lastEnteredAction);
  }
 };
 return {directory,evidence,ports,raw,snapshot,write,controls:()=>controls,observations:()=>observations,releases:()=>releases,withdraw:()=>{current=false;},close:()=>{custody.dispose();rmSync(directory,{recursive:true,force:true});}};
}
