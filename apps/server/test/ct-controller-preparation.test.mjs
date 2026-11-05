// Pure synthetic request metadata only. No grant, approval, DB, HTTP or native.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const entry=process.env.CT_BINDING_ENTRY??'source';if(!['source','compiled'].includes(entry))throw Error('Closed test entry required');
const prefix=entry==='compiled'?'../dist':'../src',extension=entry==='compiled'?'js':'ts';
const {createGameControllerAuthority}=await import(`${prefix}/runtime/game-controller-authority.${extension}`);
const {supervisedSessionBounds}=await import(`${prefix}/runtime/supervised-game-session.${extension}`);
function fixture(){
 const scope={assistantId:randomUUID(),principalId:randomUUID(),environmentId:randomUUID(),runId:randomUUID(),contextBinding:{sessionId:randomUUID(),endpointId:randomUUID()}};
 const configuration={scope,pinsDigest:'a'.repeat(64),bounds:structuredClone(supervisedSessionBounds),policyRevision:1,sessionProfile:'supervised8'};let current=true,record,creates=0;
 const owner={context:{principalId:scope.principalId,assertCurrent(){assert.equal(current,true,'TEST original context withdrawn');}}};
 const repository={createRequest(value){creates++;record={...structuredClone(value.request),requestId:randomUUID(),revision:1,state:'pending'};return {request:structuredClone(record)};},inspectRequest(){return structuredClone(record);}};
 const authority=createGameControllerAuthority(configuration,{authorityOwner:()=>current?owner:null},{repository});
 const request=authority.review();return {authority,request,configuration,creates:()=>creates,withdraw:()=>{current=false;},change:fn=>fn(record)};
}
test('CT35 retained preparation snapshots the exact original run and cannot create a second request',()=>{
 const f=fixture(),value=f.authority.inspectPreparation(f.request.invocationId);assert.equal(value.executionOwner,'ctSession');assert.equal(value.permissionRequestId,f.request.requestId);assert.equal(value.grantsAuthority,false);assert.equal(value.dispatchStarted,false);assert.deepEqual(value.input.bounds,supervisedSessionBounds);
 assert(Object.isFrozen(value.input.bounds));assert(Object.isFrozen(value.input.scope));assert(Object.isFrozen(value.preparation.request.scope.targetRefs));
 f.configuration.bounds.actionBudget=999;f.configuration.scope.runId=randomUUID();f.configuration.policyRevision=999;
 assert.deepEqual(f.authority.inspectPreparation(f.request.invocationId),value);assert.equal(f.creates(),1);assert.throws(()=>f.authority.inspectPreparation(randomUUID()));assert.equal(f.creates(),1);
});
test('CT35 retained inspection refuses expired, denied, changed and withdrawn original request evidence',async t=>{
 const cases=[['expired',r=>{r.expiresAt=new Date(0).toISOString();}],['denied',r=>{r.state='denied';}],['different targets',r=>{r.scope.targetRefs=['urn:TEST:other-run'];}],['different session',r=>{r.sessionId=randomUUID();}],['changed expiry',r=>{r.grantExpiresAt=new Date(Date.now()+3600000).toISOString();}],['changed terms',r=>{r.effectSummary='TEST widened';}],['different input digest',r=>{r.inputDigest='f'.repeat(64);}]];
 for(const [label,change]of cases)await t.test(label,()=>{const f=fixture();f.change(change);assert.throws(()=>f.authority.inspectPreparation(f.request.invocationId));assert.equal(f.creates(),1);});
 const f=fixture();f.withdraw();assert.throws(()=>f.authority.inspectPreparation(f.request.invocationId));assert.equal(f.creates(),1);
});
