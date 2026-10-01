import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import {Database,MemoryRepository,VisualMemoryRepository,isVisualErasureEvidence,visualSourceMutationIdentity} from '@lifestream/storage-sqlite';
import {AutomaticMemory} from '../src/runtime/automatic-memory.ts';
import {VisualMemoryCandidateEvidence,isVisualMemoryErasureTrace,isVisualMemoryCorrectionTrace,isVisualMemoryLifecycleTrace,isVisualMemoryCandidateTrace} from '../src/runtime/visual-memory-candidate-evidence.ts';
import {visualEpisode,visualOwner} from '../../../packages/storage-sqlite/test/fixtures/visual-episode.ts';
import {correlateVisualMemoryErasure,replayVisualMemoryErasure} from '../src/runtime/turn-context-trace.ts';
function fixture(t:TestContext,project=true,hasEnvironment=true){
 const environmentId=randomUUID(),db=new Database({path:':memory:'});db.migrate();const owner=visualOwner(),memories=new MemoryRepository(db);let allowed=true,changed=()=>{},scopeRead=()=>allowed,calls=0;
 const worker=new AutomaticMemory({...(hasEnvironment?{environmentId}:{}),database:db,memories,provider:()=>({revision:'unused',provider:{async *generate(){calls++;yield {kind:'done' as const};}}}),idle:()=>false,scopeAllowed:()=>scopeRead(),changed:()=>changed()});t.after(async()=>{await worker.close();db.close();});
 worker.configure(owner,true,0);worker.configureVisual(owner,true,0,86400000);const source=new VisualMemoryRepository(db),v=visualEpisode(owner,worker.inspect(owner).visual.policy,Date.now());assert.equal(worker.enqueueVisual(owner,v.episode,v.admission).state,'retained');
 const p=project?worker.projectVisual(owner,v.episode.episodeId,1,{value:0.6,basis:'Synthetic estimated transformation',policyRef:'synthetic-transform-v1'}):null;const memoryId=p&&'memoryId' in p?p.memoryId!:null;
 const forget=()=>worker.forgetVisual(owner,v.episode.episodeId,project?2:1);
 return {db,environmentId,owner,memories,worker,source,v,memoryId,forget,calls:()=>calls,deny:()=>allowed=false,onChange:(fn:()=>void)=>changed=fn,onScope:(fn:()=>boolean)=>scopeRead=fn};
}
test('original committed scoped forget donates a minimal separate asynchronous trace after deleting prior histories',async t=>{
 const f=fixture(t);await Promise.resolve();assert.equal(f.worker.visualCandidateHistory(f.owner).length,1);
 f.forget();assert.deepEqual(f.worker.visualErasureHistory(f.owner),[]);assert.deepEqual(f.worker.visualCandidateHistory(f.owner),[]);assert.deepEqual(f.worker.visualLifecycleHistory(f.owner),[]);assert.deepEqual(f.worker.visualCorrectionHistory(f.owner),[]);
 await Promise.resolve();const [trace]=f.worker.visualErasureHistory(f.owner);assert.ok(trace);assert.equal(isVisualMemoryErasureTrace(trace),true);assert.equal(isVisualMemoryCorrectionTrace(trace),false);assert.equal(isVisualMemoryLifecycleTrace(trace),false);assert.equal(isVisualMemoryCandidateTrace(trace),false);
 const actual=f.memories.history(f.owner.assistantId,f.memoryId!).at(-1)!,mutation=actual.payload.visualMutation as any;
 assert.equal(trace.sourceReceipt.eventId,mutation.eventId);assert.equal(trace.sourceReceipt.oldRevision,1);assert.equal(trace.sourceReceipt.newRevision,2);assert.equal(trace.sourceReceipt.occurredAt,actual.occurredAt);assert.deepEqual(trace.event.sourceEventIds,[mutation.eventId]);assert.equal(trace.event.eventType,'memory.lifecycleChanged');assert.equal(trace.event.environmentId,f.environmentId);assert.equal(trace.event.conversationId,null);assert.equal(trace.event.sessionId,null);assert.equal(trace.event.endpointId,null);assert.equal(trace.event.monotonic,null);
 assert.equal(createContractValidator().validate('https://lifestream.dev/contracts/interaction-trace-event/2.0.0',trace.event).valid,true);assert.equal(trace.durable,false);assert.equal(trace.complete,false);assert.equal(trace.effectAuthority,false);
 assert.doesNotMatch(JSON.stringify(trace),/blue hat|principalId|relationshipId|episodeId|sourceDigest|sourceObservationIds|sourceBindingRef|humanEntryId|canonical|invalidate/u);assert.equal(f.memories.get(f.owner.assistantId,f.memoryId!)!.content,'');assert.equal(f.worker.inspect(f.owner).visual.episodes[0]!.episode,null);assert.equal(f.calls(),0);
});
test('source-only or missing actual host environment preserves erasure without fabricated evidence',async t=>{
 for(const mode of ['sourceOnly','missingEnvironment'] as const)await t.test(mode,async c=>{
  const f=fixture(c,mode!=='sourceOnly',mode!=='missingEnvironment');f.forget();await Promise.resolve();assert.deepEqual(f.worker.visualErasureHistory(f.owner),[]);assert.equal(f.worker.inspect(f.owner).visual.episodes[0]!.episode,null);if(f.memoryId)assert.equal(f.memories.get(f.owner.assistantId,f.memoryId)!.content,'');assert.equal(f.calls(),0);
 });
});
test('receipt comes only from the successfully committed original operation, with exact idempotency and no restart upcast',async t=>{
 const f=fixture(t),result=f.source.forgetWithEvidence(f.owner,f.v.episode.episodeId,2,f.environmentId),source=result.evidence!;assert.equal(result.forgotten,true);assert.ok(isVisualErasureEvidence(source));assert.equal(f.source.erasureEvidenceCurrent(source),true);assert.equal(new VisualMemoryRepository(f.db).erasureEvidenceCurrent(source),false);assert.equal(isVisualErasureEvidence(structuredClone(source)),false);assert.equal(f.source.erasureEvidenceCurrent(structuredClone(source)),false);assert.equal(isVisualErasureEvidence(visualSourceMutationIdentity('erasure',1)),false);
 let utc=Date.now(),mono=0;const journal=new VisualMemoryCandidateEvidence({utcMs:()=>utc,monotonicMs:()=>mono});t.after(()=>journal.close());journal.recordErasure(f.owner,source);journal.recordErasure(f.owner,source);assert.deepEqual(journal.erasureTraces(f.owner,s=>f.source.erasureEvidenceCurrent(s)),[]);await Promise.resolve();assert.equal(journal.erasureTraces(f.owner,s=>f.source.erasureEvidenceCurrent(s)).length,1);
 assert.throws(()=>f.source.forgetWithEvidence(f.owner,f.v.episode.episodeId,2,f.environmentId),/conflict/);assert.equal(f.memories.history(f.owner.assistantId,f.memoryId!).filter(e=>e.eventType==='forgotten').length,1);
 journal.reset();utc=Date.parse(source.sourceReceipt.occurredAt)+60000;mono+=60000;journal.recordErasure(f.owner,source);await Promise.resolve();assert.deepEqual(journal.erasureTraces(f.owner,()=>true),[]);
});
test('transaction rollback and foreign/stale owner cannot create successful erasure provenance',t=>{
 const f=fixture(t);f.db.exec("CREATE TRIGGER fail_erasure_evidence BEFORE INSERT ON memory_lifecycle_events WHEN NEW.event_type='forgotten' BEGIN SELECT RAISE(ABORT,'synthetic erasure rollback'); END");assert.throws(()=>f.source.forgetWithEvidence(f.owner,f.v.episode.episodeId,2,f.environmentId),/rollback/);assert.equal(f.worker.inspect(f.owner).visual.episodes[0]!.episode!.state,'retained');assert.notEqual(f.memories.get(f.owner.assistantId,f.memoryId!)!.content,'');
 f.db.exec('DROP TRIGGER fail_erasure_evidence');assert.throws(()=>f.source.forgetWithEvidence({...f.owner,principalId:randomUUID()},f.v.episode.episodeId,2,f.environmentId),/conflict/);assert.throws(()=>f.source.forgetWithEvidence(f.owner,f.v.episode.episodeId,1,f.environmentId),/conflict/);assert.ok(f.source.forgetWithEvidence(f.owner,f.v.episode.episodeId,2,f.environmentId).evidence);
});
test('a trigger replacing the original minted mutation UUID cannot manufacture original-operation evidence',t=>{
 const f=fixture(t),pseudo=randomUUID();f.db.exec(`CREATE TRIGGER forge_erasure_uuid AFTER INSERT ON memory_lifecycle_events WHEN NEW.event_type='forgotten' BEGIN UPDATE memory_lifecycle_events SET payload_json=json_set(payload_json,'$.visualMutation.eventId','${pseudo}') WHERE memory_id=NEW.memory_id AND revision=NEW.revision; END`);
 const result=f.source.forgetWithEvidence(f.owner,f.v.episode.episodeId,2,f.environmentId);assert.equal(result.evidence,null);assert.equal(f.memories.get(f.owner.assistantId,f.memoryId!)!.content,'');
});
test('corrupt pre-erasure projection or revision cannot block privacy erasure or receive invented facts',async t=>{
 for(const mode of ['canonical','revision','relationship'] as const)await t.test(mode,c=>{
  const f=fixture(c),memory=f.memories.get(f.owner.assistantId,f.memoryId!)!;
  if(mode==='revision')f.db.connection.prepare('UPDATE memories SET lifecycle_json=? WHERE id=?').run(JSON.stringify({...memory.lifecycle,revision:'unknown'}),f.memoryId!);
  else f.db.connection.prepare('UPDATE memories SET provenance_json=? WHERE id=?').run(JSON.stringify({...memory.provenance,...(mode==='canonical'?{canonical:{invalid:true}}:{relationshipId:randomUUID()})}),f.memoryId!);
  assert.equal(f.source.forgetWithEvidence(f.owner,f.v.episode.episodeId,2,f.environmentId).evidence,null);assert.equal(f.memories.get(f.owner.assistantId,f.memoryId!)!.content,'');assert.equal(f.worker.inspect(f.owner).visual.episodes[0]!.episode,null);
 });
});
test('copy/proxy/accessor/factory receipts cannot enter the diagnostic journal or run untrusted code',async t=>{
 const f=fixture(t),source=f.source.forgetWithEvidence(f.owner,f.v.episode.episodeId,2,f.environmentId).evidence!,journal=new VisualMemoryCandidateEvidence();t.after(()=>journal.close());let touched=0;
 for(const fake of [structuredClone(source),new Proxy(source,{get(){touched++;throw Error('untrusted');}}),{get ownerDigest(){touched++;return source.ownerDigest;}}])journal.recordErasure(f.owner,fake as any);
 await Promise.resolve();assert.deepEqual(journal.erasureTraces(f.owner,()=>true),[]);assert.equal(touched,0);journal.recordErasure({...f.owner,relationshipId:randomUUID()},source);await Promise.resolve();assert.deepEqual(journal.erasureTraces(f.owner,()=>true),[]);
});
test('original tombstone or event withdrawal/corruption retires erasure inspection without restoring source data',async t=>{
 for(const mode of ['content','provenance','revision','uuid','eventRemoved'] as const)await t.test(mode,async c=>{
  const f=fixture(c);f.forget();await Promise.resolve();assert.equal(f.worker.visualErasureHistory(f.owner).length,1);
  if(mode==='content')f.db.connection.prepare("UPDATE memories SET content='PRIVATE_CORRUPT_CONTENT' WHERE id=?").run(f.memoryId!);
  else if(mode==='provenance')f.db.connection.prepare('UPDATE memories SET provenance_json=? WHERE id=?').run(JSON.stringify({actor:f.owner.principalId,payloadRemoved:true,relationshipId:f.owner.relationshipId}),f.memoryId!);
  else if(mode==='revision')f.db.connection.prepare('UPDATE memories SET lifecycle_json=? WHERE id=?').run(JSON.stringify({status:'invalidated',contentRemoved:true,revision:99}),f.memoryId!);
  else if(mode==='uuid')f.db.connection.prepare("UPDATE memory_lifecycle_events SET payload_json=json_set(payload_json,'$.visualMutation.eventId',?) WHERE memory_id=? AND event_type='forgotten'").run(randomUUID(),f.memoryId!);
  else f.db.connection.prepare("DELETE FROM memory_lifecycle_events WHERE memory_id=? AND event_type='forgotten'").run(f.memoryId!);
  assert.deepEqual(f.worker.visualErasureHistory(f.owner),[]);assert.equal(f.worker.inspect(f.owner).visual.episodes[0]!.episode,null);assert.equal(f.calls(),0);
 });
});
test('owner/consent/close fences and final host-hook source withdrawal withhold inspection',async t=>{
 for(const mode of ['owner','policy','visualPolicy','close','finalHook'] as const)await t.test(mode,async c=>{
  const f=fixture(c);f.forget();await Promise.resolve();assert.equal(f.worker.visualErasureHistory(f.owner).length,1);
  if(mode==='owner')f.deny();else if(mode==='policy')f.worker.configure(f.owner,false,1);else if(mode==='visualPolicy')f.worker.configureVisual(f.owner,false,1,86400000);else if(mode==='close')await f.worker.close();else {let checks=0;f.onScope(()=>{if(++checks===2)f.db.connection.prepare("DELETE FROM memory_lifecycle_events WHERE memory_id=? AND event_type='forgotten'").run(f.memoryId!);return true;});}
  assert.deepEqual(f.worker.visualErasureHistory(f.owner),[]);assert.equal(f.calls(),0);
 });
});
test('changed callbacks can revoke/close diagnostics after successful erasure without resurrecting memory',async t=>{
 const f=fixture(t);f.onChange(()=>{f.onChange(()=>{});f.worker.configureVisual(f.owner,false,1,86400000);});f.forget();await Promise.resolve();assert.deepEqual(f.worker.visualErasureHistory(f.owner),[]);assert.equal(f.memories.get(f.owner.assistantId,f.memoryId!)!.content,'');
});
test('erasure diagnostic expiry on either clock and rollback/close cannot extend or replay source eligibility',async t=>{
 for(const mode of ['utc','monotonic','rollback','close'] as const)await t.test(mode,async c=>{
  const f=fixture(c),source=f.source.forgetWithEvidence(f.owner,f.v.episode.episodeId,2,f.environmentId).evidence!;let utc=Date.now(),mono=10;
  const journal=new VisualMemoryCandidateEvidence({utcMs:()=>utc,monotonicMs:()=>mono});c.after(()=>journal.close());journal.recordErasure(f.owner,source);await Promise.resolve();assert.equal(journal.erasureTraces(f.owner,s=>f.source.erasureEvidenceCurrent(s)).length,1);
  if(mode==='utc')utc+=60000;else if(mode==='monotonic')mono+=60000;else if(mode==='rollback')utc--;else journal.close();
  assert.deepEqual(journal.erasureTraces(f.owner,s=>f.source.erasureEvidenceCurrent(s)),[]);
 });
});
test('genuine historical memory/owner join and pure replay preserve only actual opaque identities, with deleted lineage missing',async t=>{
 const f=fixture(t);await Promise.resolve();const [candidate]=f.worker.visualCandidateHistory(f.owner);assert.ok(candidate);f.forget();await Promise.resolve();const [erasure]=f.worker.visualErasureHistory(f.owner);assert.ok(erasure);
 const join=correlateVisualMemoryErasure(candidate,erasure)!;assert.equal(join.state,'joined');assert.equal(join.sourceMutationEventId,erasure.sourceReceipt.eventId);assert.equal(join.episodeMetadataAvailable,false);assert.equal(join.sourceFamilyJoined,false);assert.equal(join.intermediateHistoryComplete,false);assert.equal(join.replyFencingProved,false);assert.equal(join.currentEligibilityProved,false);
 const before=JSON.stringify(f.memories.history(f.owner.assistantId,f.memoryId!)),replay=replayVisualMemoryErasure(candidate,erasure)!;assert.equal(replay.events.length,2);assert.equal(replay.executionMode,'replay');assert.equal(replay.episodeMetadataAvailable,false);assert.equal(replay.liveEffects,false);assert.equal(replay.durableReinforcement,false);assert.equal(replay.perceptionReplayed,false);assert.notEqual(replay.environmentId,erasure.event.environmentId);assert.equal(replay.events[0]!.backgroundJobId,replay.events[1]!.backgroundJobId);assert.deepEqual(replay.events[1]!.sourceEventIds,[erasure.event.eventId]);assert.equal(replay.events[1]!.eventTime,erasure.event.eventTime);assert.deepEqual(replay.sourceReceipt,erasure.sourceReceipt);assert.equal(JSON.stringify(f.memories.history(f.owner.assistantId,f.memoryId!)),before);assert.equal(isVisualMemoryErasureTrace(replay as any),false);assert.equal(isVisualErasureEvidence(replay.sourceReceipt),false);assert.equal(f.calls(),0);
 assert.equal(correlateVisualMemoryErasure(structuredClone(candidate),erasure),null);assert.equal(replayVisualMemoryErasure(candidate,structuredClone(erasure)),null);
 const other=fixture(t);other.forget();await Promise.resolve();assert.equal(correlateVisualMemoryErasure(candidate,other.worker.visualErasureHistory(other.owner)[0]!),null);
});
