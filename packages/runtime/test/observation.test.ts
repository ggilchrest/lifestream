import test from 'node:test';
import assert from 'node:assert/strict';
import type {VisualAdmissionProvenance} from '../src/perception/admission.ts';
import {VisualObservationStore,type VisualObservationBatch} from '../src/perception/observation.ts';
import type {VisualScope} from '../src/perception/port.ts';

const scope:VisualScope={assistantId:'assistant',principalId:'owner',relationshipId:null,environmentId:'fixture',conversationId:'conversation',sessionId:'session',endpointId:'endpoint',sessionRevision:1,audienceRevision:1,scopeGeneration:1,sourceBindingRef:'fixture-camera',captureConfigurationRevision:1};
function fixture(){
  let now=100_000,audience=1,authorized=true;
  const previous:VisualAdmissionProvenance={requestId:'request',correlationId:'correlation',leaseId:'lease',scope:{...scope},frameIds:['frame-1'],hostSequence:1,provider:{id:'synthetic',version:'1'},capturedAtEarliestMs:99_900,capturedAtLatestMs:99_950,receivedAtMs:99_970,deadlineAtMs:102_970,clockMappingId:'mapping',leaseRevision:1};
  const next:VisualAdmissionProvenance={...previous,scope:{...scope,audienceRevision:2},leaseRevision:2};
  const batch:VisualObservationBatch={scope:{...scope},leaseId:'lease',sequence:1,requestId:'request',capturedAtEarliestMs:99_900,capturedAtLatestMs:99_950,receivedAtMs:99_970,interpretedAtMs:100_000,provider:{...previous.provider},observations:[{observationId:'scene-1',frameIds:['frame-1'],appearance:'A blue notebook is on a table.',inference:null,confidence:null,limitations:['Synthetic observation; no pixel interpretation.']}]};
  const store=new VisualObservationStore({now:()=>now,current:(candidate,lease)=>authorized&&candidate.audienceRevision===audience&&lease==='lease'});
  assert.equal(store.publish(batch),true);
  const prepare=(candidate=scope,explicitQuestion=true)=>store.prepare({scope:{...candidate},leaseId:'lease',viewId:`view-${candidate.audienceRevision}`,revision:candidate.audienceRevision,invalidationKey:`audience-${candidate.audienceRevision}`,conversation:'[]',explicitQuestion,allowAside:true});
  return {store,previous,next,batch,prepare,advance:(ms:number)=>{now+=ms;},setAudience:(value:number)=>{audience=value;},revoke:()=>{authorized=false;}};
}

test('audience count expiry rebuilds a nonprivate scene without extending its original six-second freshness',()=>{
  const f=fixture(),privateView=f.prepare()!;f.advance(2001);f.setAudience(2);
  assert.equal(f.store.rebindAudience(f.previous,f.next),true);
  assert.equal(f.store.isCurrent(privateView),false,'an already selected old-audience view is invalidated');
  const sharedView=f.prepare(f.next.scope)!;assert.ok(sharedView,'a count can expire before the independent scene expires');
  assert.equal(sharedView.conversationContent,privateView.conversationContent);assert.deepEqual(sharedView.observations,privateView.observations);
  assert.equal(sharedView.capturedAtEarliestMs,privateView.capturedAtEarliestMs);assert.equal(sharedView.capturedAtLatestMs,privateView.capturedAtLatestMs);
  assert.equal(sharedView.expiresAtMs,105_900);assert.equal(sharedView.sourceRevision,privateView.sourceRevision);assert.equal(sharedView.requestId,privateView.requestId);
  assert.equal(f.store.publish({...f.batch,scope:f.next.scope}),false,'migration does not reset the admitted sequence');
  f.setAudience(1);assert.equal(f.store.isCurrent(privateView),false,'even restoring the old predicate cannot resurrect a selected view');f.setAudience(2);
  f.advance(3899);assert.equal(f.store.isCurrent(sharedView),false);assert.equal(f.prepare(f.next.scope),null);
  const later={...f.next,scope:{...f.next.scope,audienceRevision:3},leaseRevision:3};f.setAudience(3);
  assert.equal(f.store.rebindAudience(f.next,later),false,'a later audience revision cannot revive an expired scene');f.store.clear();
});

test('audience-only migration preserves mention suppression, withdrawal and retention deadline',()=>{
  const used=fixture(),view=used.prepare(scope,false)!;used.store.markUsed(view);used.advance(2001);used.setAudience(2);
  assert.equal(used.store.rebindAudience(used.previous,used.next),true);assert.equal(used.prepare(used.next.scope,false),null,'the same consumed aside stays suppressed');assert.ok(used.prepare(used.next.scope,true),'explicit questions may use still-current scene evidence');
  used.advance(58_000);assert.deepEqual(used.store.diagnostics(),{sessions:0,observations:0,bytes:0},'migration cannot extend the original retention deadline');used.store.clear();
  const withdrawn=fixture();withdrawn.store.withdrawCurrent(scope.sessionId);withdrawn.setAudience(2);
  assert.equal(withdrawn.store.rebindAudience(withdrawn.previous,withdrawn.next),true);assert.equal(withdrawn.prepare(withdrawn.next.scope),null,'migration cannot re-enable withdrawn scene selection');withdrawn.store.clear();
});

test('migration rejects unrelated or altered proof fields and requires current successor authority',()=>{
  const changed:Array<(next:VisualAdmissionProvenance)=>VisualAdmissionProvenance>=[
    next=>({...next,requestId:'foreign'}),next=>({...next,correlationId:'foreign'}),next=>({...next,leaseId:'foreign'}),
    next=>({...next,clockMappingId:'foreign'}),next=>({...next,hostSequence:2}),next=>({...next,leaseRevision:1}),next=>({...next,leaseRevision:3}),
    next=>({...next,capturedAtEarliestMs:99_901}),next=>({...next,capturedAtLatestMs:99_951}),next=>({...next,receivedAtMs:99_971}),next=>({...next,deadlineAtMs:102_971}),
    next=>({...next,provider:{...next.provider,version:'other'}}),next=>({...next,frameIds:['foreign']}),
    ...(['assistantId','principalId','relationshipId','environmentId','conversationId','sessionId','endpointId','sourceBindingRef'] as const).map(key=>(next:VisualAdmissionProvenance)=>({...next,scope:{...next.scope,[key]:'foreign'}})),
    ...(['sessionRevision','scopeGeneration','captureConfigurationRevision'] as const).map(key=>(next:VisualAdmissionProvenance)=>({...next,scope:{...next.scope,[key]:2}})),
    next=>({...next,scope:{...next.scope,audienceRevision:1}})
  ];
  for(const change of changed){const f=fixture();f.setAudience(2);assert.equal(f.store.rebindAudience(f.previous,change(f.next)),false);f.setAudience(1);assert.ok(f.prepare(),'rejected candidate cannot rewrite the original cache');f.store.clear();}
  for(const patch of [{requestId:'wrong-request'},{hostSequence:2},{capturedAtEarliestMs:99_899},{receivedAtMs:99_969},{frameIds:['wrong-frame']},{provider:{id:'other',version:'1'}}]){
    const f=fixture(),previous={...f.previous,...patch},next={...f.next,...patch};f.setAudience(2);
    assert.equal(f.store.rebindAudience(previous,next),false,'matching altered copies still must match the cached batch');f.store.clear();
  }
  const f=fixture();f.setAudience(2);f.revoke();assert.equal(f.store.rebindAudience(f.previous,f.next),false);assert.equal(f.prepare(f.next.scope),null);f.store.clear();
});

test('migration reads only plain proof descriptors and cannot repeat a completed transition',()=>{
  const f=fixture();f.setAudience(2);let reads=0;
  const getter=Object.defineProperty({...f.next},'scope',{get(){reads++;return f.next.scope;}});
  assert.equal(f.store.rebindAudience(f.previous,getter),false);
  const proxy=new Proxy(f.next,{get(){reads++;throw Error('foreign proof accessor');}});
  assert.equal(f.store.rebindAudience(f.previous,proxy),false);assert.equal(reads,0);
  assert.equal(f.store.rebindAudience(f.previous,f.next),true);assert.equal(f.store.rebindAudience(f.previous,f.next),false,'the old scope no longer owns the cached result');
  assert.ok(f.prepare(f.next.scope));f.store.clear();
});
