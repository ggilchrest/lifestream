import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn} from '@lifestream/runtime/inference/prompt';
import {compileRelationshipContext} from '@lifestream/runtime/context';
import {captureTurnContextTrace,materializeTurnContextTrace,correlateVisualMemoryCandidate,replayVisualMemoryContextJoin} from '../src/runtime/turn-context-trace.ts';
import {createContractValidator} from '@lifestream/contracts';
import {Database,MemoryRepository} from '@lifestream/storage-sqlite';
import {AutomaticMemory} from '../src/runtime/automatic-memory.ts';
import {VisualMemoryCandidateEvidence} from '../src/runtime/visual-memory-candidate-evidence.ts';
import {visualEpisode,visualOwner} from '../../../packages/storage-sqlite/test/fixtures/visual-episode.ts';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function setup(t:import('node:test').TestContext){
 const db=new Database({path:':memory:'});db.migrate();const owner=visualOwner(),memories=new MemoryRepository(db);let allowed=true,calls=0,changed=()=>{};
 const worker=new AutomaticMemory({database:db,memories,provider:()=>({revision:'unused-scripted',provider:{async *generate(){calls++;yield {kind:'done' as const};}}}),idle:()=>false,scopeAllowed:()=>allowed,changed:()=>changed()});
 t.after(async()=>{await worker.close();db.close();});worker.configure(owner,true,0);worker.configureVisual(owner,true,0,86400000);
 const v=visualEpisode(owner,worker.inspect(owner).visual.policy,Date.now());assert.equal(worker.enqueueVisual(owner,v.episode,v.admission).state,'retained');
 const estimate={value:0.6,basis:'SCRIPTED transformation basis, not perception accuracy',policyRef:'synthetic-transform-policy-v1'};
 const project=()=>worker.projectVisual(owner,v.episode.episodeId,1,estimate);
 const source=()=>{const episode=worker.inspect(owner).visual.episodes[0]!.episode!;return {schemaVersion:'1.0.0',recordType:'visualMemoryProjection',episode,memoryRecord:memories.get(owner.assistantId,episode.memoryRecordId!)!.provenance.canonical};};
 return {db,owner,worker,memories,v,estimate,project,source,deny:()=>allowed=false,onChange:(fn:()=>void)=>changed=fn,calls:()=>calls};
}
test('actual SQLite projection emits one asynchronous canonical candidate with exact redacted artifact and source IDs',async t=>{
 const f=setup(t),result=f.project();assert.equal(result.state,'projected');assert.deepEqual(f.worker.visualCandidateHistory(f.owner),[]);await Promise.resolve();
 const rows=f.worker.visualCandidateHistory(f.owner);assert.equal(rows.length,1);const trace=rows[0]!,event=trace.event,payload=event.payload as any,canonical=f.source().memoryRecord as any;
 assert.equal(createContractValidator().validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid,true);
 assert.equal(event.eventType,'memory.candidateProposed');assert.equal(event.traceScope,'background');assert.equal(event.interactionTraceId,null);assert.equal(event.monotonic,null);assert.deepEqual(event.sourceEventIds,[]);assert.deepEqual(event.causedByEventIds,[]);
 assert.equal(event.eventTime,canonical.createdAt);assert.equal(event.environmentId,f.v.episode.scope.environmentId);assert.equal(event.sessionId,f.v.episode.scope.sessionId);assert.equal(payload.memoryId,canonical.memoryId);assert.deepEqual(payload.sourceRefs,canonical.provenance.sourceRefs);
 assert.equal(trace.artifact.reference.sha256,sha(trace.artifact.bytes));assert.equal(trace.artifact.reference.byteLength,Buffer.byteLength(trace.artifact.bytes));assert.equal(payload.candidateArtifact,trace.artifact.reference);
 const metadata=JSON.parse(trace.artifact.bytes);assert.equal(metadata.recordDigest,sha(JSON.stringify(canonical)));assert.equal(metadata.factuality,'unverified');assert.equal(metadata.status,'candidate');assert.equal(metadata.sourceEpisodeRevision,2);assert.equal(metadata.transformation.basisDigest,sha(f.estimate.basis));
 for(const prose of [f.v.episode.summary,f.v.episode.observations[0]!.description,f.estimate.basis,f.estimate.policyRef])assert.equal(JSON.stringify(trace).includes(prose),false);
 assert.equal(trace.complete,false);assert.equal(trace.durable,false);assert.equal(trace.learningAuthority,false);assert.equal(trace.effectAuthority,false);assert.equal(f.calls(),0);assert.equal(Reflect.set(event,'eventType','memory.lifecycleChanged'),false);
 assert.equal(f.worker.activateVisual(f.owner,f.v.episode.episodeId,2).state,'active');await Promise.resolve();assert.equal(f.worker.visualCandidateHistory(f.owner).length,1);assert.equal((f.worker.visualCandidateHistory(f.owner)[0]!.event.payload as any).memoryId,canonical.memoryId);assert.equal(JSON.parse(trace.artifact.bytes).status,'candidate');
});
test('missing confidence, denied source and duplicate projection never claim candidate or lifecycle success',async t=>{
 const f=setup(t);assert.notEqual(f.worker.projectVisual(f.owner,f.v.episode.episodeId,1,null).state,'projected');await Promise.resolve();assert.deepEqual(f.worker.visualCandidateHistory(f.owner),[]);
 assert.equal(f.project().state,'projected');const source=f.source();assert.notEqual(f.project().state,'projected');await Promise.resolve();assert.equal(f.worker.visualCandidateHistory(f.owner).length,1);
 const journal=new VisualMemoryCandidateEvidence();t.after(()=>journal.close());journal.record(f.owner,source);journal.record(f.owner,source);journal.record({...f.owner,relationshipId:randomUUID()},source);await Promise.resolve();assert.equal(journal.traces(f.owner).length,1);
 f.deny();assert.equal(f.project().state,'policyDenied');assert.deepEqual(f.worker.visualCandidateHistory(f.owner),[]);
});
test('owner isolation, consent revision, forgetting and correction fence retained or queued metadata',async t=>{
 for(const mode of ['scope','memory','visual','forget','correct','reentrant-memory'] as const)await t.test(mode,async child=>{
  const f=setup(child);if(mode==='reentrant-memory')f.onChange(()=>{f.onChange(()=>{});f.worker.configure(f.owner,false,1);});assert.equal(f.project().state,'projected');
  if(mode==='scope')f.deny();else if(mode==='memory')f.worker.configure(f.owner,false,1);else if(mode==='visual')f.worker.configureVisual(f.owner,false,1,86400000);else if(mode==='forget')f.worker.forgetVisual(f.owner,f.v.episode.episodeId,2);else if(mode==='correct')f.worker.correctVisual(f.owner,f.v.episode.episodeId,2,'The prior scripted feature was mistaken.');
  await Promise.resolve();assert.deepEqual(f.worker.visualCandidateHistory(f.owner),[]);
  if(mode==='memory'||mode==='reentrant-memory'){f.worker.configure(f.owner,true,2);f.worker.configureVisual(f.owner,true,2,86400000);assert.deepEqual(f.worker.visualCandidateHistory(f.owner),[]);}
 });
 const f=setup(t);f.project();await Promise.resolve();for(const key of ['principalId','assistantId','relationshipId'] as const)assert.deepEqual(f.worker.visualCandidateHistory({...f.owner,[key]:randomUUID()}),[]);
});
test('bounded candidate rings preserve producer sequence and both TTL clocks, reset and close fence async drain',async t=>{
 const f=setup(t);f.project();const source=f.source();
 for(const mode of ['utc','mono','rollback','reset','close'] as const){let utc=Date.now()+100,mono=1000;const journal=new VisualMemoryCandidateEvidence({utcMs:()=>utc,monotonicMs:()=>mono});journal.record(f.owner,source);
  if(mode==='utc'){await Promise.resolve();utc+=60000;}else if(mode==='mono'){await Promise.resolve();mono+=60000;}else if(mode==='rollback')utc--;else if(mode==='reset')journal.reset();else journal.close();
  assert.deepEqual(journal.traces(f.owner),[]);await Promise.resolve();assert.deepEqual(journal.traces(f.owner),[]);journal.close();
 }
 const journal=new VisualMemoryCandidateEvidence();t.after(()=>journal.close());
 for(let i=0;i<140;i++){const copy=structuredClone(source) as any;copy.memoryRecord.memoryId=randomUUID();copy.episode.memoryRecordId=copy.memoryRecord.memoryId;journal.record(f.owner,copy);}
 await Promise.resolve();const rows=journal.traces(f.owner);assert.equal(rows.length,128);assert.equal(rows[0]!.event.sequence,13);assert.equal(new Set(rows.map(row=>row.event.backgroundJobId)).size,1);
});
test('malformed projection, hostile accessor/proxy and broken diagnostic clocks cannot invent a source',async t=>{
 const f=setup(t);f.project();const source=f.source(),journal=new VisualMemoryCandidateEvidence();t.after(()=>journal.close());let calls=0;
 const hostile={...source};Object.defineProperty(hostile,'episode',{enumerable:true,get(){calls++;return source.episode;}});journal.record(f.owner,hostile);journal.record(f.owner,new Proxy(source,{}));
 const foreign=structuredClone(source) as any;foreign.memoryRecord.provenance.sourceRefs=['not-the-source'];journal.record(f.owner,foreign);
 const active=structuredClone(source) as any;active.memoryRecord.status='active';journal.record(f.owner,active);
 const owner:any={...f.owner};Object.defineProperty(owner,'principalId',{get(){calls++;return f.owner.principalId;}});journal.record(owner,source);
 const broken=new VisualMemoryCandidateEvidence({utcMs:()=>{throw Error('SCRIPTED clock failure');},monotonicMs:()=>0});assert.doesNotThrow(()=>broken.record(f.owner,source));broken.close();await Promise.resolve();assert.equal(calls,0);assert.deepEqual(journal.traces(f.owner),[]);
});

function selectedTrace(f:ReturnType<typeof setup>,options:{assistantId?:string;marked?:boolean;eventMs?:number}={}){
 const record=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!;
 const assistantId=options.assistantId??f.owner.assistantId,sessionId=randomUUID(),interactionId=randomUUID(),endpointId=randomUUID();
 const context=compileRelationshipContext({records:[{id:record.id,content:record.content,revision:Number(record.lifecycle.revision),sourceFamily:String(record.provenance.sourceFamily),status:'approved',use:'relevant',personalization:true,mention:true,memoryRecord:options.marked!==false,visualObservation:true}],userInput:'blue hat',audienceScope:'authenticatedSession',profileRevision:'synthetic-p1',relationshipRevision:'synthetic-r1',configurationRevision:'synthetic-c1'});
 const binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{...f.owner,assistantId,sessionId,conversationId:randomUUID(),endpointId},conversation:'SCRIPTED isolated conversation',sourceRevisions:{conversation:'synthetic-c1'}});
 const turn=finalizePreparedTurn({assistantId,sessionId,interactionId,endpointId,conversation:binding.conversation,preparedTurnBinding:binding,preparedRelationshipContext:context},()=>true),request=requestForFinalizedTurn(turn,binding,()=>true);
 const capture=captureTurnContextTrace(turn,request,randomUUID())!;assert.ok(capture);const time=options.eventMs??Date.now();return materializeTurnContextTrace(capture,{occurredAtMs:time,processingAtMs:time,monotonicMs:100,clockId:randomUUID()})!;
}

test('genuine candidate joins exact finalized selected MemoryRecord across sessions without currency, owner or delivery promotion',async t=>{
 const f=setup(t);f.project();f.worker.activateVisual(f.owner,f.v.episode.episodeId,2);await Promise.resolve();const candidate=f.worker.visualCandidateHistory(f.owner)[0]!,context=selectedTrace(f);
 const joined=correlateVisualMemoryCandidate(candidate,context);assert.ok(joined);assert.equal(joined.sourceCandidateEventId,candidate.event.eventId);assert.equal(joined.memoryId,f.source().episode.memoryRecordId);assert.equal(joined.crossSession,true);assert.equal(joined.sourceEnvironmentId,f.v.episode.scope.environmentId);
 assert.equal(joined.sourceCurrencyProved,false);assert.equal(joined.ownerEquivalenceProved,false);assert.equal(joined.deliveryProved,false);assert.equal(joined.learningAuthority,false);assert.equal(joined.effectAuthority,false);assert.equal(joined.complete,false);
 for(const invalid of [selectedTrace(f,{marked:false}),selectedTrace(f,{assistantId:randomUUID()}),selectedTrace(f,{eventMs:0})])assert.equal(correlateVisualMemoryCandidate(candidate,invalid),null);
 assert.equal(correlateVisualMemoryCandidate({...candidate},context),null);assert.equal(correlateVisualMemoryCandidate(candidate,{...context}),null);assert.equal(correlateVisualMemoryCandidate(new Proxy(candidate,{}),context),null);
 let calls=0;const hostile={...candidate};Object.defineProperty(hostile,'event',{get(){calls++;return candidate.event;}});assert.equal(correlateVisualMemoryCandidate(hostile,context),null);assert.equal(calls,0);
});

test('isolated joined candidate/context replay preserves actual lineage, times and artifacts after forgetting without any live mutation',async t=>{
 const f=setup(t);f.project();f.worker.activateVisual(f.owner,f.v.episode.episodeId,2);await Promise.resolve();const candidate=f.worker.visualCandidateHistory(f.owner)[0]!,context=selectedTrace(f),before=JSON.stringify({candidate,context});
 f.worker.forgetVisual(f.owner,f.v.episode.episodeId,2);assert.deepEqual(f.worker.visualCandidateHistory(f.owner),[]);
 const rowBefore=JSON.stringify(f.worker.inspect(f.owner)),replay=replayVisualMemoryContextJoin(candidate,context);assert.ok(replay);assert.equal(JSON.stringify(f.worker.inspect(f.owner)),rowBefore);assert.equal(f.calls(),0);
 assert.equal(replay.candidateArtifact,candidate.artifact);assert.equal(replay.manifest,context.manifest);assert.equal(replay.sourceCandidateMonotonicClockAvailable,false);assert.equal(replay.complete,false);assert.equal(replay.liveEffects,false);assert.equal(replay.durableReinforcement,false);assert.equal(replay.sourceCurrencyProved,false);
 const validator=createContractValidator();for(const [i,event] of replay.events.entries()){
  const original=i===0?candidate.event:context.events[i-1]!;assert.equal(validator.validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',event).valid,true);assert.deepEqual(event.sourceEventIds,[original.eventId]);assert.notEqual(event.eventId,original.eventId);assert.equal(event.eventTime,original.eventTime);assert.equal(event.environmentId,replay.environmentId);assert.equal(event.executionMode,'replay');assert.deepEqual(event.payload,original.payload);
 }
 assert.equal(replay.events[0]!.monotonic,null);assert.notEqual(replay.events[0]!.backgroundJobId,candidate.event.backgroundJobId);assert.equal(JSON.stringify({candidate,context}),before);
 assert.equal(replayVisualMemoryContextJoin({...candidate},context),null);assert.equal(replayVisualMemoryContextJoin(candidate,replay as never),null);assert.equal(correlateVisualMemoryCandidate(candidate,replay as never),null);
 assert.doesNotMatch(JSON.stringify(replay),/SCRIPTED isolated conversation|confirmed participant appears|SCRIPTED transformation basis/);
});
