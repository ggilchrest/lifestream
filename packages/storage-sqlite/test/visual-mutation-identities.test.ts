import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createContractValidator} from '@lifestream/contracts';
import {Database} from '../src/database.ts';
import {MemoryRepository} from '../src/memory.ts';
import {VisualMemoryRepository} from '../src/visual-memory.ts';
import {visualEpisode,visualOwner} from './fixtures/visual-episode.ts';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function fixture(t:TestContext,project=true){
 const root=mkdtempSync(join(tmpdir(),'ls-visual-mutations-')),path=join(root,'state.sqlite');
 let now=Date.parse('2026-10-01T00:00:00Z'),db=new Database({path});db.migrate();let visual=new VisualMemoryRepository(db,()=>now);
 t.mock.timers.enable({apis:['Date'],now});t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 const owner=visualOwner(),policy=visual.configure(owner,true,0,86400000),v=visualEpisode(owner,policy,now);assert.equal(visual.admit(owner,v.episode,v.admission).state,'retained');
 const p=project?visual.project(owner,v.episode.episodeId,1,{value:0.6,basis:'Synthetic source transformation',policyRef:'synthetic-v1'}):null;
 const memoryId=p&&'memoryId' in p?p.memoryId!:null;
 return {get db(){return db;},get visual(){return visual;},owner,v,memoryId,history:()=>new MemoryRepository(db).history(owner.assistantId,memoryId!),advance:(ms:number)=>now+=ms,reopen:()=>{db.close();db=new Database({path});db.migrate();visual=new VisualMemoryRepository(db,()=>now);}};
}
test('actual correction transaction binds its own mutation UUID and record revisions to the distinct original Human entry',t=>{
 const f=fixture(t),reply=f.visual.correct(f.owner,f.v.episode.episodeId,2,'Synthetic exact Human correction.'),event=f.history().at(-1)!,mutation=event.payload.visualMutation as any;
 assert.match(mutation.eventId,uuid);assert.equal(reply.correctionMutationEventId,mutation.eventId);assert.notEqual(mutation.eventId,reply.correctionId);assert.notEqual(mutation.eventId,f.memoryId);
 assert.deepEqual(mutation,{recordType:'visualSourceMutationIdentity',eventId:reply.correctionMutationEventId,kind:'correction',oldRevision:1,newRevision:2});assert.equal(event.payload.correctionId,reply.correctionId);assert.equal(event.memoryId,f.memoryId);assert.equal(event.assistantId,f.owner.assistantId);assert.equal(event.occurredAt,f.visual.inspect(f.owner,true).episodes[0]!.corrections[0]!.occurredAt);
 assert.equal(new MemoryRepository(f.db).get(f.owner.assistantId,f.memoryId!)!.lifecycle.revision,2);assert.equal(new MemoryRepository(f.db).list(f.owner.assistantId).length,1);
 assert.equal(createContractValidator().validate('https://lifestream.dev/contracts/memory-operations/1.0.0',mutation).valid,false);assert.doesNotMatch(JSON.stringify(mutation),/blue hat|Human correction|sourceDigest|relationship/);
 const before=JSON.stringify(f.history());f.reopen();assert.equal(JSON.stringify(f.history()),before);
});
test('source-only correction does not fabricate a projected memory mutation or MemoryRecord identity',t=>{
 const f=fixture(t,false),reply=f.visual.correct(f.owner,f.v.episode.episodeId,1,'Synthetic source-only correction.');assert.equal(reply.correctionMutationEventId,null);assert.equal(new MemoryRepository(f.db).list(f.owner.assistantId).length,0);assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM memory_lifecycle_events WHERE event_type='visualCorrectionApplied'").get()!.n,0);
});
test('correction write failure rolls back memory, entry and mutation receipt; stale or foreign scope cannot mint another committed event',t=>{
 const f=fixture(t);f.db.exec("CREATE TRIGGER fail_visual_identity BEFORE INSERT ON memory_lifecycle_events WHEN NEW.event_type='visualUserCorrection' BEGIN SELECT RAISE(ABORT,'synthetic identity failure'); END");assert.throws(()=>f.visual.correct(f.owner,f.v.episode.episodeId,2,'Synthetic correction.'),/identity failure/);assert.equal(f.history().length,1);assert.equal(new MemoryRepository(f.db).get(f.owner.assistantId,f.memoryId!)!.lifecycle.revision,1);assert.equal(f.visual.inspect(f.owner,true).episodes[0]!.corrections.length,0);
 f.db.exec('DROP TRIGGER fail_visual_identity');const reply=f.visual.correct(f.owner,f.v.episode.episodeId,2,'Synthetic correction.');assert.match(reply.correctionMutationEventId!,uuid);assert.throws(()=>f.visual.correct(f.owner,f.v.episode.episodeId,2,'Stale.'),/conflict/);assert.throws(()=>f.visual.correct({...f.owner,principalId:randomUUID()},f.v.episode.episodeId,3,'Foreign.'),/unavailable/);assert.equal(f.history().length,2);
});
test('each original erasure owner preserves only prior opaque mutation identity and commits its own actual revision receipt',async t=>{
 for(const mode of ['sourceForget','memoryForget','policy','expiry','restore'] as const)await t.test(mode,c=>{
  const f=fixture(c),reply=f.visual.correct(f.owner,f.v.episode.episodeId,2,'PRIVATE_CORRECTION_PROSE');
  if(mode==='sourceForget')f.visual.forget(f.owner,f.v.episode.episodeId,3);else if(mode==='memoryForget')new MemoryRepository(f.db).forget(f.owner.assistantId,f.memoryId!,f.owner.principalId);else if(mode==='policy')f.visual.configure(f.owner,false,1,86400000);else if(mode==='expiry'){f.advance(86400000);f.visual.sweep();}else f.visual.quarantine();
  const history=f.history(),prior=history.find(e=>e.eventType==='visualCorrectionApplied')!,last=history.at(-1)!,mutation=last.payload.visualMutation as any;
  assert.deepEqual(prior.payload,{payloadRemoved:true,visualMutationEventId:reply.correctionMutationEventId});assert.match(mutation.eventId,uuid);assert.notEqual(mutation.eventId,reply.correctionMutationEventId);assert.deepEqual(mutation,{recordType:'visualSourceMutationIdentity',eventId:mutation.eventId,kind:'erasure',oldRevision:2,newRevision:3});assert.equal(last.eventType,'forgotten');assert.equal(last.payload.contentRemoved,true);assert.equal(f.visual.inspect(f.owner,true).episodes[0]!.episode,null);const tombstone=new MemoryRepository(f.db).get(f.owner.assistantId,f.memoryId!)!;assert.equal(tombstone.content,'');assert.equal(tombstone.lifecycle.contentRemoved,true);assert.equal(tombstone.lifecycle.revision,3);assert.equal(new MemoryRepository(f.db).contextRecords(f.owner.assistantId,f.owner.principalId).length,0);
  assert.doesNotMatch(JSON.stringify(history),/PRIVATE_CORRECTION_PROSE|blue hat|sourceDigest|correctionId|visual-episode:/);f.visual.sweep();assert.deepEqual(f.history(),history);f.reopen();assert.deepEqual(f.history(),history);
 });
});
test('erasure transaction failure commits no source erasure or new receipt',t=>{
 const f=fixture(t);f.db.exec("CREATE TRIGGER fail_erasure_identity BEFORE INSERT ON memory_lifecycle_events WHEN NEW.event_type='forgotten' BEGIN SELECT RAISE(ABORT,'synthetic erasure failure'); END");assert.throws(()=>f.visual.forget(f.owner,f.v.episode.episodeId,2),/erasure failure/);assert.equal(f.visual.inspect(f.owner,true).episodes[0]!.state,'retained');assert.equal(f.history().length,1);assert.equal(new MemoryRepository(f.db).get(f.owner.assistantId,f.memoryId!)!.lifecycle.revision,1);
 f.db.exec('DROP TRIGGER fail_erasure_identity');f.visual.forget(f.owner,f.v.episode.episodeId,2);assert.match((f.history().at(-1)!.payload.visualMutation as any).eventId,uuid);
});
test('legacy and ordinary Human erasure do not acquire visual mutation identities or retain untrusted pseudo IDs',t=>{
 const f=fixture(t),memories=new MemoryRepository(f.db),id=randomUUID();memories.save({id,assistantId:f.owner.assistantId,content:'Synthetic independent Human advice.',provenance:{actor:f.owner.principalId},lifecycle:{status:'candidate',revision:1},createdAt:new Date().toISOString()});
 f.db.connection.prepare('UPDATE memory_lifecycle_events SET payload_json=? WHERE memory_id=?').run(JSON.stringify({visualMutation:{recordType:'visualSourceMutationIdentity',eventId:randomUUID()},visualMutationEventId:'PRIVATE_PSEUDO_ID',notes:'PRIVATE_PSEUDO_PROSE'}),id);memories.forget(f.owner.assistantId,id,f.owner.principalId);assert.deepEqual(memories.history(f.owner.assistantId,id).map(e=>e.payload),[{payloadRemoved:true},{status:'invalidated',contentRemoved:true}]);
 const row=f.history()[0]!;assert.equal(row.payload.visualMutation,undefined);assert.equal(row.payload.visualMutationEventId,undefined);assert.equal(f.visual.inspect(f.owner,true).episodes[0]!.state,'retained');
});
test('corrupt original revision cannot block privacy erasure or acquire fabricated revision facts',t=>{
 const f=fixture(t);f.db.connection.prepare('UPDATE memories SET lifecycle_json=? WHERE id=?').run(JSON.stringify({status:'candidate',revision:'unknown'}),f.memoryId!);
 f.visual.forget(f.owner,f.v.episode.episodeId,2);const receipt=f.history().at(-1)!.payload.visualMutation as any;assert.match(receipt.eventId,uuid);assert.equal(receipt.oldRevision,null);assert.equal(receipt.newRevision,null);assert.equal(new MemoryRepository(f.db).get(f.owner.assistantId,f.memoryId!)!.content,'');assert.equal(f.visual.inspect(f.owner,true).episodes[0]!.episode,null);
});
