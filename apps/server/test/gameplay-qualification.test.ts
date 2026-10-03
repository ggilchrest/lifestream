import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createGameInferenceQualificationBinding,type GameQualificationReceipt} from '../src/runtime/gameplay-qualification.ts';
import {qualifiedGameInferenceBounds} from '../src/runtime/game-host-runtime.ts';

function fixture(){
 let time=Date.now(),generation=true;
 const receipt:GameQualificationReceipt={schemaVersion:'1.0.0',recordType:'gameInferenceQualification',qualificationRef:'test-only:measured-cancellation',selection:{configurationDigest:'a'.repeat(64),providerRef:'local:inference',providerRevision:'candidate-native',model:'test-only-model',modelArtifactDigest:'b'.repeat(64),healthy:true,fixture:false},process:{pid:42,processStartTicks:'123',binarySha256:'c'.repeat(64),modelSha256:'b'.repeat(64),projectorSha256:'d'.repeat(64),envelopeDigest:'e'.repeat(64)},preemptionBoundMs:10,slotReleaseBoundMs:250,verifiedAt:new Date(time-1000).toISOString(),expiresAt:new Date(time+10000).toISOString()};
 let bytes:Buffer=Buffer.from(JSON.stringify(receipt));const options={receipt,receiptSha256:createHash('sha256').update(bytes).digest('hex'),readReceipt:()=>bytes,processCurrent:(p:GameQualificationReceipt['process'])=>generation&&p.pid===42&&p.processStartTicks==='123',now:()=>time};
 return {receipt,options,qualify:()=>createGameInferenceQualificationBinding(options),setTime:(t:number)=>{time=t;},setBytes:(b:Buffer)=>{bytes=b;},restart:()=>{generation=false;},time};
}
test('measured artifact qualifies only the exact selected model, process generation and priority bounds',()=>{
 const f=fixture(),qualify=f.qualify(),proof=qualify(f.receipt.selection);assert.ok(proof);assert.equal(proof.current(),true);
 const bounds=qualifiedGameInferenceBounds({resolveApproval:()=>null,sourceCurrent:()=>false,inferenceQualificationFor:qualify},f.receipt.selection);assert.ok(bounds);assert.equal(bounds.preemptionBoundMs,10);assert.equal(bounds.slotReleaseBoundMs,250);
 for(const [key,value] of [['providerRevision','other'],['configurationDigest','f'.repeat(64)],['modelArtifactDigest','f'.repeat(64)],['model','other'],['providerRef','other'],['healthy',false],['fixture',true]] as const)assert.equal(qualify({...f.receipt.selection,[key]:value}),null);
 f.restart();assert.equal(proof.current(),false);assert.equal(bounds.current(),false);
});
test('changed bytes, callbacks, descriptor, expiration and clock rollback cannot revive qualification',()=>{
 const f=fixture(),proof=f.qualify()(f.receipt.selection)!;f.setBytes(Buffer.from('{}'));assert.equal(proof.current(),false);
 const g=fixture(),p=g.qualify()(g.receipt.selection)!;g.options.processCurrent=()=>true;assert.equal(p.current(),false);
 const h=fixture(),q=h.qualify()(h.receipt.selection)!;h.receipt.process.pid++;assert.equal(q.current(),false);
 const i=fixture(),r=i.qualify()(i.receipt.selection)!;i.setTime(i.time+10001);assert.equal(r.current(),false);
 const j=fixture(),s=j.qualify()(j.receipt.selection)!;j.setTime(j.time-1);assert.equal(s.current(),false);j.setTime(j.time);assert.equal(s.current(),false);
});
test('unknown, unmeasured, unbound and over-budget qualification artifacts are rejected before use',()=>{
 for(const key of ['preemptionBoundMs','slotReleaseBoundMs'] as const){const f=fixture();f.receipt[key]=key==='preemptionBoundMs'?10.01:250.01;assert.throws(f.qualify,/qualification unavailable/);}
 const f=fixture();f.receipt.selection.modelArtifactDigest=null;assert.throws(f.qualify,/qualification unavailable/);
 const g=fixture();(g.receipt as any).healthOnly=true;assert.throws(g.qualify,/qualification unavailable/);
});
