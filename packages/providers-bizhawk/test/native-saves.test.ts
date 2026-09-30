import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {GameSaveRequest,GameSaveResult} from '@lifestream/contracts/game-activity';
import {fixtureEpisode} from '../../runtime/test/fixtures/game-memory.ts';
import {ordinarySaveResultMatches} from '../src/native-saves.ts';

function fixture(){
 const now=Date.now(),time=new Date(now).toISOString(),e=fixtureEpisode(now),digest=e.pinsDigest;
 const request:GameSaveRequest={schemaVersion:'1.0.0',operation:'GameActivityAdapter.controlSave',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(now+10000).toISOString(),cancellationId:randomUUID(),executionMode:'simulation',scope:e.scope,idempotencyKey:randomUUID(),payload:{action:'flushSaveRam',purpose:'ordinaryInGame',expectedPinsDigest:digest,saveArtifact:null,admission:{admissionId:randomUUID(),capabilityInvocationId:randomUUID(),authorityContextRef:{providerRef:'synthetic:authority',contextId:randomUUID(),revision:1},dispatchReceipt:{reference:'synthetic:dispatch',sha256:digest,mediaType:'application/json',schemaRef:'synthetic:dispatch',byteLength:1},scopeDigest:digest,inputDigest:digest,policyRevision:1,issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+10000).toISOString()}}};
 const result:GameSaveResult={schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:'synthetic:adapter',completedAt:time,outcome:{status:'succeeded',error:null,payload:{action:'flushSaveRam',timelineId:e.scope.timelineId,confirmedAt:time,saveArtifact:{artifact:{reference:'synthetic:ordinary-save',sha256:digest,mediaType:'application/octet-stream',schemaRef:'synthetic:save-format',byteLength:32},contentClass:'opaqueGameSaveRam',modelReadable:false,pinsDigest:digest,sourceTimelineId:e.scope.timelineId,sourceFrameNumber:10,createdAt:new Date(now-2000).toISOString(),verifiedAt:time,readbackQualificationRef:'synthetic:shape-only-readback'}}}};
 return {now,request,result};
}

test('ordinary save correlation permits existing game-save creation time and proves only supplied metadata',()=>{
 const f=fixture(),before=JSON.stringify(f);assert.equal(ordinarySaveResultMatches(f.request,f.result,f.now),true);assert.equal(JSON.stringify(f),before);assert.equal(f.result.outcome.payload!.saveArtifact.modelReadable,false);
});

test('verification preserves older-save source timeline/frame/artifact while matching the current operation timeline',()=>{
 const f=fixture(),save=f.result.outcome.payload!.saveArtifact;save.sourceTimelineId=randomUUID();save.verifiedAt=new Date(f.now-1000).toISOString();f.request.payload.action='verifyOrdinarySave';f.request.payload.saveArtifact=structuredClone(save);f.result.outcome.payload!.action='verifyOrdinarySave';save.verifiedAt=new Date(f.now).toISOString();assert.equal(ordinarySaveResultMatches(f.request,f.result,f.now),true);
 for(const field of ['sourceTimelineId','sourceFrameNumber','createdAt','artifact']as const){const result=structuredClone(f.result),s=result.outcome.payload!.saveArtifact;if(field==='sourceTimelineId')s[field]=randomUUID();if(field==='sourceFrameNumber')s[field]++;if(field==='createdAt')s[field]=new Date(f.now-3000).toISOString();if(field==='artifact')s[field].sha256='f'.repeat(64);assert.equal(ordinarySaveResultMatches(f.request,result,f.now),false);}
 f.request.payload.saveArtifact.pinsDigest='f'.repeat(64);assert.equal(ordinarySaveResultMatches(f.request,f.result,f.now),false);
});

for(const mode of ['requestIdentity','correlationIdentity','action','timeline','pins','empty','notSucceeded','missingPayload','notOrdinary','modelReadable','futureCompleted','afterDeadline','afterAdmission','beforeAdmission','staleReadback','creationAfterReadback','readbackAfterConfirmation','saveState','rawBytes','path','infiniteClock']as const)test('ordinary save supplied '+mode+' is refused without opening a save or emulator',()=>{
 const f=fixture(),p=f.result.outcome.payload!,s=p.saveArtifact;
 if(mode==='requestIdentity')f.result.requestId=randomUUID();if(mode==='correlationIdentity')f.result.correlationId=randomUUID();if(mode==='action')p.action='verifyOrdinarySave';if(mode==='timeline')p.timelineId=randomUUID();if(mode==='pins')s.pinsDigest='f'.repeat(64);if(mode==='empty')s.artifact.byteLength=0;
 if(mode==='notSucceeded'){f.result.outcome.status='outcomeUnknown';f.result.outcome.payload=null;}if(mode==='missingPayload')f.result.outcome.payload=null;if(mode==='notOrdinary')f.request.payload.purpose='recoverySnapshot' as any;if(mode==='modelReadable')s.modelReadable=true as any;
 if(mode==='futureCompleted')f.result.completedAt=new Date(f.now+1).toISOString();if(mode==='afterDeadline')f.request.deadlineAt=new Date(f.now-1).toISOString();if(mode==='afterAdmission')f.request.payload.admission.expiresAt=new Date(f.now).toISOString();if(mode==='beforeAdmission')f.request.payload.admission.issuedAt=new Date(f.now+1).toISOString();if(mode==='staleReadback')s.verifiedAt=new Date(f.now-1001).toISOString();if(mode==='creationAfterReadback')s.createdAt=new Date(f.now+1).toISOString();if(mode==='readbackAfterConfirmation')s.verifiedAt=new Date(f.now+1).toISOString();
 if(mode==='saveState')f.request.payload.action='savestate' as any;if(mode==='rawBytes')(s as any).rawSave=[1,2,3];if(mode==='path')(f.request.payload as any).path='/private/save';if(mode==='infiniteClock')f.now=Infinity;
 assert.equal(ordinarySaveResultMatches(f.request,f.result,f.now),false);
});

test('hostile save metadata cannot execute a getter/proxy or smuggle binary/state payloads',()=>{
 const f=fixture();let calls=0;const getter={...f.result};Object.defineProperty(getter,'outcome',{enumerable:true,get(){calls++;return f.result.outcome;}});assert.equal(ordinarySaveResultMatches(f.request,getter,f.now),false);assert.equal(calls,0);
 const cyclic:any={...f.result};cyclic.self=cyclic;
 for(const value of [new Proxy(f.result,{}),cyclic,{...f.result,raw:Buffer.from('PRIVATE_SAVE')},{...f.result,extra:'x'.repeat(131073)}])assert.equal(ordinarySaveResultMatches(f.request,value,f.now),false);
});
