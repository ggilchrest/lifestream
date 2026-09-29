import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import {buildCanonicalPrompt,createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn,type PromptInput} from '../src/inference/prompt.ts';
import {materializePreparedContext,requestFromPreparedContext} from '../src/context/prepared-view.ts';
import {VisualObservationStore} from '../src/perception/observation.ts';
import type {VisualScope} from '../src/perception/port.ts';

const validator=createContractValidator(),schema='https://lifestream.dev/contracts/prepared-context/1.0.0';
function fixture(conversation='[]',sourceRevisions={runtime:'runtime:1'}){
  const scope={assistantId:randomUUID(),principalId:randomUUID(),relationshipId:null,conversationId:randomUUID(),sessionId:randomUUID(),endpointId:randomUUID()};
  const binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope,conversation,sourceRevisions});
  const input:PromptInput={assistantId:scope.assistantId,sessionId:scope.sessionId,endpointId:scope.endpointId,interactionId:randomUUID(),conversation,userInput:'What is visible?',preparedTurnBinding:binding,deadlineAt:new Date(Date.now()+30_000).toISOString(),runtimeSelfContext:{sourceRevision:'runtime:1',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',limitations:[]}};
  return {scope,binding,input};
}

test('fully bound finalized turns consume a schema-valid immutable prepared view and the existing manifest',()=>{
  const f=fixture(),legacy=buildCanonicalPrompt(f.input),turn=finalizePreparedTurn(f.input,()=>true),view=turn.preparedContext;assert.ok(view);
  assert.deepEqual(validator.validate(schema,view),{valid:true,errors:[]});assert.equal(view.viewId,f.binding.viewId);assert.equal(view.invalidationKey,f.binding.invalidationKey);
  const request=requestForFinalizedTurn(turn,f.binding,()=>true);assert.deepEqual(request,legacy);assert.equal(request.sections.length,9);
  assert.deepEqual(view.sections.map(section=>section.kind),['session','relationalMemory','worldContext','conversation']);
  assert.equal(view.sourceRevisions.find(source=>source.source==='section:worldContext')?.freshness,'unavailable');
  assert.ok(Object.isFrozen(view)&&Object.isFrozen(view.sections)&&Object.isFrozen(view.sections[0]));
  assert.throws(()=>{(view.sections[0] as {content:string}).content='rewritten';},TypeError);
  assert.equal(requestForFinalizedTurn(turn,f.binding,()=>true),request,'one cached request, no rebuilt or separately refreshed context');
});

test('canonical section fragments preserve the full accepted conversation and Unicode boundaries losslessly',()=>{
  for(const text of ['x'.repeat(65_536),'x'.repeat(31_999)+'🙂'+'z'.repeat(2_000),'é'.repeat(32_768)]){
    const f=fixture(text),turn=finalizePreparedTurn(f.input,()=>true),view=turn.preparedContext!;
    assert.deepEqual(validator.validate(schema,view),{valid:true,errors:[]});
    const parts=view.sections.filter(section=>section.kind==='conversation');assert.ok(parts.length>1);assert.equal(parts.map(part=>part.content).join(''),text);
    for(const part of parts){assert.ok(part.content.length<=32_000);assert.equal(part.tokenEstimate,Buffer.byteLength(part.content));assert.equal(part.content.isWellFormed(),true);}
    const request=requestForFinalizedTurn(turn,f.binding,()=>true);assert.equal(request.sections[7]!.content,text);assert.equal(request.sections[7]!.contentDigest,createHash('sha256').update(text).digest('hex'));
  }
});

test('visual sidecar, complete conversation digest and omissions bind the same canonical view after world preparation',()=>{
  const f=fixture('x'.repeat(63_000)),now=Date.now(),scope:VisualScope={...f.scope,environmentId:'fixture',sessionRevision:1,audienceRevision:1,scopeGeneration:1,sourceBindingRef:'synthetic-camera',captureConfigurationRevision:1};
  const store=new VisualObservationStore({now:()=>now,current:()=>true});
  store.publish({scope,leaseId:'lease',sequence:1,requestId:'request',capturedAtEarliestMs:now-100,capturedAtLatestMs:now-50,receivedAtMs:now-25,interpretedAtMs:now,provider:{id:'fixture',version:'1'},observations:[{observationId:'observation',frameIds:['frame'],appearance:'A blue notebook.',inference:null,confidence:null,limitations:['Synthetic only.']}]});
  const visual=store.prepare({scope,leaseId:'lease',viewId:f.binding.viewId,revision:1,invalidationKey:f.binding.invalidationKey,conversation:f.binding.conversation,explicitQuestion:true,allowAside:false});assert.ok(visual);
  const worldExpiry=new Date(now+2_000).toISOString();
  const turn=finalizePreparedTurn({...f.input,preparedVisualContext:visual,preparedWorldContext:{content:'Qualified synthetic world data.',sourceRef:'fixture:world',sourceRevision:'world:8',freshUntil:worldExpiry},visualOmissions:[{observationId:'excluded',reason:'budget'}]},()=>true),view=turn.preparedContext!;
  assert.deepEqual(validator.validate(schema,view),{valid:true,errors:[]});assert.equal(view.viewId,visual.viewId);assert.equal(view.revision,visual.revision);assert.equal(view.invalidationKey,visual.invalidationKey);assert.equal(view.freshUntil,worldExpiry);assert.equal(view.staleUntil,worldExpiry);
  assert.equal(view.sections.filter(part=>part.kind==='conversation').map(part=>part.content).join(''),visual.conversationContent);
  assert.equal(requestForFinalizedTurn(turn,f.binding,()=>true).manifest.sections[7]!.contentDigest,visual.conversationSectionDigest);assert.deepEqual(view.omissions,['visual:excluded:budget']);store.clear();
});

test('prepared context cannot be copied onto another request or changed after materialization',()=>{
  const f=fixture(),request=buildCanonicalPrompt(f.input),now=Date.now();
  const view=materializePreparedContext(request,f.binding,{now,freshUntil:now+1000,sourceRevisions:{runtime:'1'}});
  assert.throws(()=>requestFromPreparedContext({...view},request),/incompatible/);assert.throws(()=>requestFromPreparedContext(view,{...request}),/incompatible/);
  assert.throws(()=>{request.sections[7]!.content='changed';},TypeError);
  assert.throws(()=>materializePreparedContext({...request,scope:{...request.scope,sessionId:randomUUID()}},f.binding,{now,freshUntil:now+1000,sourceRevisions:{runtime:'1'}}),/incompatible/);
});

test('declared source expiry independently retires cached admission without extending the request deadline',t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});const f=fixture(),deadline=f.input.deadlineAt;
  const turn=finalizePreparedTurn({...f.input,preparedWorldContext:{content:'Source data.',sourceRef:'fixture',sourceRevision:'1',freshUntil:new Date(now+100).toISOString()}},()=>true);
  assert.equal(requestForFinalizedTurn(turn,f.binding,()=>true).deadlineAt,deadline);
  t.mock.timers.setTime(now+101);assert.throws(()=>requestForFinalizedTurn(turn,f.binding,()=>true),/unavailable/);
  t.mock.timers.setTime(now);assert.throws(()=>requestForFinalizedTurn(turn,f.binding,()=>true),/unavailable/);
  for(const freshUntil of ['invalid',new Date(now-1).toISOString()])assert.throws(()=>finalizePreparedTurn({...f.input,preparedWorldContext:{content:'Source data.',sourceRef:'fixture',sourceRevision:'1',freshUntil}},()=>true),/incompatible/);
});

test('composite source identities remain explicit integrity references within the frozen schema bounds',()=>{
  const composite='revision:'.repeat(100),name='source-'.repeat(18),f=fixture('[]',{runtime:'runtime:1',[name]:composite});
  const turn=finalizePreparedTurn(f.input,()=>true),view=turn.preparedContext!;assert.deepEqual(validator.validate(schema,view),{valid:true,errors:[]});
  const entry=view.sourceRevisions.find(source=>source.source.startsWith('source-sha256:'));assert.ok(entry);assert.match(entry.revision,/^revision-sha256:[0-9a-f]{64}$/u);assert.equal(turn.sourceRevisions[`seed:${name}`],composite);
});

test('canonical context rejects invalid expiry and oversized aggregate data instead of silently truncating',()=>{
  const f=fixture(),request=buildCanonicalPrompt(f.input),now=Date.now();
  assert.throws(()=>materializePreparedContext({...request,deadlineAt:'invalid'},f.binding,{now,freshUntil:now+1000,sourceRevisions:{runtime:'1'}}),/incompatible/);
  assert.throws(()=>finalizePreparedTurn({...f.input,memory:'x'.repeat(100_000),world:'y'.repeat(100_000)},()=>true),/incompatible/);
  assert.throws(()=>finalizePreparedTurn({...f.input,visualOmissions:Array.from({length:65},(_,index)=>({observationId:String(index),reason:'budget'}))},()=>true),/incompatible/);
});

test('legacy identifiers and unbound endpoints continue without fabricated canonical scope',()=>{
  const f=fixture();
  for(const patch of [{sessionId:'legacy-session'},{endpointId:null}]){
    const scope={...f.binding.scope,...patch},binding=createPreparedTurnBinding({viewId:f.binding.viewId,revision:f.binding.revision,invalidationKey:f.binding.invalidationKey,scope,conversation:f.binding.conversation,sourceRevisions:f.binding.sourceRevisions});
    assert.ok(binding);
    const turn=finalizePreparedTurn({...f.input,...patch,preparedTurnBinding:binding},()=>true);assert.equal(turn.preparedContext,null);assert.ok(requestForFinalizedTurn(turn,binding,()=>true));
  }
});
