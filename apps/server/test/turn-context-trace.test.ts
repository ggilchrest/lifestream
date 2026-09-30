import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import {createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn,isFinalizedTurnRequest} from '@lifestream/runtime/inference/prompt';
import {unavailableVisualSelection} from '@lifestream/runtime/perception/observation';
import {VisualTurnEvidence,startVisualTurnEvidence} from '../src/runtime/visual-turn-evidence.ts';
import {captureTurnContextTrace,materializeTurnContextTrace,correlateTurnContextTrace,replayTurnContextTrace} from '../src/runtime/turn-context-trace.ts';

function fixture(options:{environment?:string;legacy?:boolean;replay?:boolean}={}){
 let utc=Date.now(),mono=100;
 const actor={principalId:randomUUID(),assistantId:randomUUID(),sessionId:randomUUID()};
 const binding=createPreparedTurnBinding({viewId:options.legacy?'legacy-view':randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{...actor,relationshipId:randomUUID(),conversationId:randomUUID(),endpointId:randomUUID()},conversation:'PRIVATE_SCENE_AND_DIALOGUE',sourceRevisions:{conversation:'source-1'}});
 const journal=new VisualTurnEvidence({utcMs:()=>utc,monotonicMs:()=>mono});
 const open=()=>{
  const interactionId=randomUUID();
  const recorder=startVisualTurnEvidence(journal.observer(actor,unavailableVisualSelection('no_observations'),binding,null,options.environment),interactionId,'text');
  const turn=finalizePreparedTurn({assistantId:actor.assistantId,sessionId:actor.sessionId,interactionId,endpointId:binding.scope.endpointId,conversation:binding.conversation,userInput:'PRIVATE_INPUT_SECRET',preparedTurnBinding:binding,executionMode:options.replay?'replay':'live'},()=>true);
  const request=requestForFinalizedTurn(turn,binding,()=>true);
  return {recorder,turn,request};
 };
 return {actor,binding,journal,open,advance:(ms:number)=>{utc+=ms;mono+=ms;},rollback:()=>{utc--;},recover:()=>{utc+=2;}};
}

test('actual finalizer records published context events asynchronously with exact manifest and section digests',async()=>{
 const environment=randomUUID(),f=fixture({environment});try{
  const t=f.open();t.recorder.finalized(t.turn,t.request);
  assert.deepEqual(f.journal.contextTraces(f.actor),[]);f.advance(10);await Promise.resolve();
  const [trace]=f.journal.contextTraces(f.actor);assert.ok(trace);
  assert.equal(trace.events.length,10);assert.equal(trace.complete,false);assert.equal(trace.durable,false);assert.equal(trace.deliveryProved,false);
  assert.equal(trace.events[0]!.eventType,'context.viewSelected');
  assert.deepEqual(trace.events[0]!.payload,{viewId:f.binding.viewId,revision:1,sourceRevisions:t.turn.preparedContext!.sourceRevisions.map(s=>({providerRef:s.source,revision:s.revision,highWaterMark:null})),freshness:'fresh'});
  const validator=createContractValidator();
  for(const [i,event] of trace.events.entries()){
   assert.ok(validator.validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid);
   assert.equal(event.sequence,i);assert.equal(event.environmentId,environment);assert.equal(event.executionMode,'normal');assert.equal(event.interactionTraceId,t.request.scope.interactionId);
   assert.equal(Date.parse(event.processingTime as string)-Date.parse(event.eventTime as string),10);
   if(i)assert.equal((event.payload as {reference:string}).reference,`urn:lifestream:prompt-section:sha256:${t.request.manifest.sections[i-1]!.contentDigest}`);
  }
  assert.equal(trace.manifest.bytes,JSON.stringify(t.request.manifest));
  assert.equal(trace.manifest.reference.sha256,createHash('sha256').update(trace.manifest.bytes).digest('hex'));assert.equal(trace.manifest.reference.byteLength,Buffer.byteLength(trace.manifest.bytes));
  assert.equal(trace.manifest.reference.schemaRef,'urn:lifestream:runtime-input-manifest:1.0.0');
  assert.doesNotMatch(JSON.stringify(trace),/PRIVATE_INPUT_SECRET|PRIVATE_SCENE_AND_DIALOGUE/);
  assert.equal(Reflect.set(trace.events[0]!,'privacyClass','public'),false);
  assert.equal(Reflect.set(trace.manifest.reference,'sha256','forged'),false);
  assert.deepEqual(f.journal.contextTraces({...f.actor,principalId:randomUUID()}),[]);
 }finally{f.journal.close();}
});

test('copied frozen finalizers and copied requests cannot donate canonical context provenance',async()=>{
 const f=fixture({environment:randomUUID()});try{
  const t=f.open(),copy=Object.freeze({...t.turn});
  assert.equal(isFinalizedTurnRequest(t.turn,t.request),true);assert.equal(isFinalizedTurnRequest(copy,t.request),false);assert.equal(isFinalizedTurnRequest(t.turn,Object.freeze({...t.request})),false);
  assert.equal(isFinalizedTurnRequest({},undefined),false);
  t.recorder.finalized(copy,t.request);t.recorder.providerInvoked();await Promise.resolve();assert.deepEqual(f.journal.receipts(f.actor),[]);assert.deepEqual(f.journal.contextTraces(f.actor),[]);
  assert.equal(captureTurnContextTrace(copy,t.request,randomUUID()),null);
  const capture=captureTurnContextTrace(t.turn,t.request,randomUUID());assert.ok(capture);
  assert.equal(materializeTurnContextTrace({...capture},{occurredAtMs:1,processingAtMs:2,monotonicMs:1,clockId:randomUUID()}),null);
  t.recorder.finalized(t.turn,t.request);await Promise.resolve();assert.equal(f.journal.contextTraces(f.actor).length,1);
 }finally{f.journal.close();}
});

test('missing host environment, legacy IDs and replay do not fabricate canonical runtime identities',async()=>{
 for(const options of [{},{environment:'invalid'},{environment:randomUUID(),legacy:true},{environment:randomUUID(),replay:true}]){
  const f=fixture(options);try{const t=f.open();t.recorder.finalized(t.turn,t.request);await Promise.resolve();assert.equal(f.journal.receipts(f.actor).length,1);assert.deepEqual(f.journal.contextTraces(f.actor),[]);}finally{f.journal.close();}
 }
});

test('canonical metadata obeys original expiry, reset, clock loss, close and bounded eviction',async()=>{
 for(const mode of ['expiry','reset','rollback','close'] as const){
  const f=fixture({environment:randomUUID()});const t=f.open();t.recorder.finalized(t.turn,t.request);
  if(mode==='reset')f.journal.reset();else if(mode==='rollback'){f.rollback();f.journal.contextTraces(f.actor);f.recover();}else if(mode==='close')f.journal.close();
  await Promise.resolve();if(mode==='expiry'){assert.equal(f.journal.contextTraces(f.actor).length,1);f.advance(60000);}
  assert.deepEqual(f.journal.contextTraces(f.actor),[]);f.journal.close();
 }
 const f=fixture({environment:randomUUID()});try{
  for(let i=0;i<140;i++){const t=f.open();t.recorder.finalized(t.turn,t.request);}
  await Promise.resolve();assert.equal(f.journal.contextTraces(f.actor).length,128);
 }finally{f.journal.close();}
});

test('read-only provenance diagnostics do not retire, refresh or re-admit a finalized turn',()=>{
 const f=fixture({environment:randomUUID()});try{
  const t=f.open();assert.ok(captureTurnContextTrace(t.turn,t.request,randomUUID()));
  assert.equal(requestForFinalizedTurn(t.turn,f.binding,()=>true),t.request);
  assert.equal(materializeTurnContextTrace(captureTurnContextTrace(t.turn,t.request,randomUUID())!,{occurredAtMs:2,processingAtMs:1,monotonicMs:0,clockId:randomUUID()}),null);
  assert.equal(requestForFinalizedTurn(t.turn,f.binding,()=>true),t.request);
 }finally{f.journal.close();}
});

test('late observation of the finalized milestone preserves expiry rather than reporting a fresh view',async()=>{
 const f=fixture({environment:randomUUID()});try{
  const t=f.open();f.advance(31000);t.recorder.finalized(t.turn,t.request);await Promise.resolve();
  const trace=f.journal.contextTraces(f.actor)[0]!;
  assert.equal((trace.events[0]!.payload as {freshness:string}).freshness,'stale');
  assert.equal(trace.deliveryProved,false);
 }finally{f.journal.close();}
});

test('canonical context joins original finalized receipt; mismatched digests, scope, time and stage stay unjoined',async()=>{
 const f=fixture({environment:randomUUID()});try{
  const t=f.open();t.recorder.finalized(t.turn,t.request);t.recorder.providerInvoked();await Promise.resolve();
  const trace=f.journal.contextTraces(f.actor)[0]!,receipt=f.journal.receipts(f.actor)[0]!;
  const joined=correlateTurnContextTrace(trace,receipt);assert.ok(joined);assert.equal(joined.manifestDigest,receipt.finalized!.manifestDigest);assert.equal(joined.deliveryProved,false);assert.equal(joined.learningAuthority,false);
  for(const bad of [{...receipt,interactionId:randomUUID()},{...receipt,occurredAtMs:receipt.occurredAtMs+1},{...receipt,stage:'providerInvoked' as const},{...receipt,finalized:{...receipt.finalized!,manifestDigest:'0'.repeat(64)}},{...receipt,finalized:{...receipt.finalized!,conversationSectionDigest:'0'.repeat(64)}}])assert.equal(correlateTurnContextTrace(trace,bad),null);
  assert.equal(correlateTurnContextTrace({...trace},receipt),null);
  let getters=0;const hostile={...receipt};Object.defineProperty(hostile,'finalized',{get(){getters++;return receipt.finalized;}});assert.equal(correlateTurnContextTrace(trace,hostile),null);assert.equal(getters,0);
  assert.equal(correlateTurnContextTrace(trace,new Proxy(receipt,{})),null);
 }finally{f.journal.close();}
});

test('isolated canonical semantic replay preserves original source/time/manifest with new IDs and explicit virtual clock',async()=>{
 const f=fixture({environment:randomUUID()});try{
  const t=f.open();t.recorder.finalized(t.turn,t.request);await Promise.resolve();const trace=f.journal.contextTraces(f.actor)[0]!,before=JSON.stringify(trace);
  f.journal.reset();const replay=replayTurnContextTrace(trace);assert.ok(replay);
  assert.equal(replay.manifest,trace.manifest);assert.equal(replay.sourceTraceId,t.request.scope.interactionId);assert.equal(replay.complete,false);assert.equal(replay.liveEffects,false);assert.equal(replay.durableReinforcement,false);assert.equal(replay.perceptionReplayed,false);assert.equal(replay.timeline,'source-relative-virtual');
  const validator=createContractValidator();
  for(const [i,event] of replay.events.entries()){
   assert.ok(validator.validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid);
   assert.notEqual(event.eventId,trace.events[i]!.eventId);assert.deepEqual(event.sourceEventIds,[trace.events[i]!.eventId]);assert.equal(event.executionMode,'replay');assert.equal(event.eventTime,trace.events[i]!.eventTime);assert.equal(event.environmentId,replay.environmentId);assert.notEqual(event.environmentId,trace.events[i]!.environmentId);
   assert.equal((event.monotonic as {clockId:string}).clockId,replay.clockMapping.replayClockId);assert.deepEqual(event.payload,trace.events[i]!.payload);
  }
  assert.equal(JSON.stringify(trace),before);assert.deepEqual(f.journal.contextTraces(f.actor),[]);assert.equal(replayTurnContextTrace({...trace}),null);assert.equal(replayTurnContextTrace(replay as never),null,'replay cannot impersonate a newly retained normal source');assert.doesNotMatch(JSON.stringify(replay),/PRIVATE_INPUT_SECRET|PRIVATE_SCENE_AND_DIALOGUE/);
 }finally{f.journal.close();}
});
