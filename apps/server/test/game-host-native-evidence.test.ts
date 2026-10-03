import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {GAME_HOST_PROTOCOL as protocol,GAME_HOST_NATIVE_EVIDENCE_VERSION,gameHostDigest} from '@lifestream/contracts/game-host';
import {GameHostPort,GameHostError,type GameHostJoin} from '../src/runtime/game-host-port.ts';
import {fixture} from './fixtures/game-host.ts';
import {nativeGameplayFixture} from './fixtures/native-gameplay.ts';

// Actual native evidence file/hash reader, durable dispatch and backend ingress.
// The native child/producer and actor/source qualification are synthetic.
function host(){
 const f=fixture(),request=f.input.request;f.options.now=Date.now;
 const native=nativeGameplayFixture(request.scope,request.payload.expectedPinsDigest,'scripted:guarded');
 const metadata={protocol,hostId:randomUUID(),scope:request.scope,pinsDigest:request.payload.expectedPinsDigest,providerRef:'scripted:guarded',sourceRevision:'b'.repeat(64),nativeEvidenceVersion:GAME_HOST_NATIVE_EVIDENCE_VERSION};
 const {protocol:ignored,...binding}=metadata;let current=true,qualified=true,joined!:GameHostJoin;
 const actor={principalId:request.scope.principalId,sessionId:request.scope.contextBinding.sessionId,isCurrent:()=>current};
 const port=new GameHostPort(f.db,{maxAttachments:2,maxDurationMs:10000,createRepository:()=>f.repository,resolveAttachment:()=>binding,bindingCurrent:()=>current,controllerCurrent:()=>current,boundary:{sourceAvailable:()=>current,acceptAction:()=>qualified},nativeEvidence:{qualifyUsage:(_binding,r,result,proof)=>qualified&&isDeepStrictEqual(native.evidence.controllerUsageEvidenceFor(r,result),proof),qualifyShutdown:(_binding,r,proof)=>qualified&&isDeepStrictEqual(native.evidence.shutdownEvidenceFor(r),proof)},onAttached:join=>joined=join});
 const attachment=port.attach(actor,metadata);
 const enter=async()=>{
  const done=joined.runController(f.input,{signal:f.controller.signal,current:f.ports.current,usageFor:joined.nativeUsageFor!});
  const event=await port.next(actor,{protocol,attachmentId:attachment.attachmentId},new AbortController().signal);assert.equal(event.kind,'command');if(event.kind!=='command')throw Error();
  const admit={protocol,attachmentId:attachment.attachmentId,commandId:event.commandId,requestDigest:event.requestDigest};port.admit(actor,admit);
  const result=await native.raw.applyController(request,{signal:f.controller.signal,isCurrent:()=>true});assert.equal(native.evidence.acceptAction(request,result),true);
  const evidence=native.evidence.controllerUsageEvidenceFor(request,result)!;
  port.complete(actor,{...admit,result,resultDigest:gameHostDigest(result),nativeUsage:evidence});
  assert.equal((await done).state,'settled');return {result,evidence};
 };
 const release=async()=>{assert.equal(await native.evidence.shutdownExactOldLease(request,native.raw,1000),true);return {protocol,attachmentId:attachment.attachmentId,nativeEvidenceVersion:GAME_HOST_NATIVE_EVIDENCE_VERSION,evidence:native.evidence.shutdownEvidenceFor(request)!};};
 return {f,native,request,port,actor,attachment,enter,release,join:()=>joined,withdraw:()=>{current=false;},unqualify:()=>{qualified=false;},close:()=>{port.close();f.db.close();native.close();}};
}

test('opt-in yields exact measured usage, then same-actor old-lease evidence after gameplay fence only once',async t=>{
 const h=host();t.after(h.close);await h.enter();assert.equal(h.f.repository.get(h.f.owner,h.request.scope.runId)!.used.wallMs,13);
 const report=await h.release(),shutdown=h.join().shutdownExactOldLease!();h.withdraw();
 assert.throws(()=>h.port.shutdownReceipt({...h.actor,principalId:randomUUID()},report),e=>e instanceof GameHostError&&e.status===403);
 assert.throws(()=>h.port.shutdownReceipt({...h.actor,sessionId:randomUUID()},report),e=>e instanceof GameHostError&&e.status===403);
 assert.equal(h.port.shutdownReceipt(h.actor,report).nativeShutdownConfirmed,true);assert.equal(await shutdown,true);
 assert.throws(()=>h.port.shutdownReceipt(h.actor,report),e=>e instanceof GameHostError&&e.status===410);
 await assert.rejects(h.port.next(h.actor,{protocol,attachmentId:h.attachment.attachmentId},new AbortController().signal));
 assert.equal(h.native.controls(),1);assert.equal(h.native.releases(),1);
});
for(const mode of ['wrongLease','wrongAction','wrongScope','qualifierWithdrawn','missing'] as const)test('historical shutdown '+mode+' cannot confirm or resume authority',async t=>{
 const h=host();t.after(h.close);await h.enter();const report=await h.release(),shutdown=h.join().shutdownExactOldLease!();h.withdraw();
 if(mode==='wrongLease'){report.evidence=structuredClone(report.evidence);report.evidence.targetInputOwnerLeaseId=randomUUID();report.evidence.release.outcome.payload!.targetInputOwnerLeaseId=report.evidence.targetInputOwnerLeaseId;}
 if(mode==='wrongAction'){report.evidence=structuredClone(report.evidence);report.evidence.actionRequestDigest='c'.repeat(64);}
 if(mode==='wrongScope'){report.evidence=structuredClone(report.evidence);report.evidence.scope.runId=randomUUID();}
 if(mode==='qualifierWithdrawn')h.unqualify();
 const message=mode==='missing'?{...report,evidence:null}:report;
 assert.equal(h.port.shutdownReceipt(h.actor,message).nativeShutdownConfirmed,false);assert.equal(await shutdown,false);
 assert.equal(h.f.repository.get(h.f.owner,h.request.scope.runId)!.used.actions,1);assert.equal(h.native.controls(),1);
});
test('no entered controller cannot manufacture a shutdown success',async t=>{
 const h=host();t.after(h.close);assert.equal(await h.join().shutdownExactOldLease!(),false);
 assert.throws(()=>h.port.shutdownReceipt(h.actor,{protocol,attachmentId:h.attachment.attachmentId,nativeEvidenceVersion:GAME_HOST_NATIVE_EVIDENCE_VERSION,evidence:null}));assert.equal(h.native.controls(),0);
});

test('historical receipt expires after its single five-second budget',{timeout:8000},async t=>{
 const h=host();t.after(h.close);await h.enter();const report=await h.release(),shutdown=h.join().shutdownExactOldLease!();h.withdraw();
 await new Promise(resolve=>setTimeout(resolve,5050));assert.equal(await shutdown,false);
 assert.throws(()=>h.port.shutdownReceipt(h.actor,report));assert.equal(h.native.controls(),1);
});
