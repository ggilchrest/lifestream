import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createContractValidator} from '@lifestream/contracts';
import {Database} from '../src/database.ts';
import {MemoryRepository} from '../src/memory.ts';
import {VisualMemoryRepository} from '../src/visual-memory.ts';
import {visualEpisode,visualOwner} from './fixtures/visual-episode.ts';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function setup(t:import('node:test').TestContext,path=':memory:'){
 let now=Date.parse('2026-09-30T12:00:00Z');t.mock.method(Date,'now',()=>now);
 let db=new Database({path});db.migrate();let repo=new VisualMemoryRepository(db,()=>now);t.after(()=>db.close());
 const owner=visualOwner(),scope=sha(JSON.stringify([owner.principalId,owner.assistantId,owner.relationshipId]));
 db.connection.prepare('INSERT INTO automatic_memory_policies VALUES (?,?,?,?,?,?,?)').run(scope,owner.principalId,owner.assistantId,owner.relationshipId,1,1,new Date(now).toISOString());
 const policy=repo.configure(owner,true,0,86400000),v=visualEpisode(owner,policy,now);assert.equal(repo.admit(owner,v.episode,v.admission).state,'retained');
 const projected=repo.project(owner,v.episode.episodeId,1,{value:0.6,basis:'SCRIPTED source-to-memory transform estimate',policyRef:'synthetic-transform-v1'});assert.equal(projected.state,'projected');const memoryId=projected.memoryId!;
 return {get db(){return db;},get repo(){return repo;},owner,v,memoryId,activate:()=>repo.activate(owner,v.episode.episodeId,2),advance:(ms:number)=>now+=ms,now:()=>now,reopen:()=>{db.close();db=new Database({path});db.migrate();repo=new VisualMemoryRepository(db,()=>now);}};
}

test('actual activation transaction persists canonical mutation and exact redacted validation artifact without new schema or history IDs',t=>{
 const f=setup(t);assert.equal(f.repo.activationEvidence(f.owner,f.memoryId),null);assert.equal(f.activate().state,'active');
 const evidence=f.repo.activationEvidence(f.owner,f.memoryId)!;assert.ok(evidence);const event=evidence.event,operation=event.operation as any;
 assert.equal(createContractValidator().validate('https://lifestream.dev/contracts/memory-operations/1.0.0',event).valid,true);assert.equal(operation.type,'activate');assert.equal(event.memoryId,f.memoryId);assert.equal(event.actorRef,f.owner.principalId);assert.equal(event.oldRevision,1);assert.equal(event.newRevision,2);assert.equal(event.occurredAt,new Date(f.now()).toISOString());assert.equal(operation.expectedRevision,1);
 assert.equal(evidence.artifact.reference.sha256,sha(evidence.artifact.bytes));assert.equal(evidence.artifact.reference.byteLength,Buffer.byteLength(evidence.artifact.bytes));assert.deepEqual(operation.validationRef,evidence.artifact.reference);
 const validation=JSON.parse(evidence.artifact.bytes);assert.equal(validation.episodeId,f.v.episode.episodeId);assert.equal(validation.sourceDigest,f.v.episode.sourceDigest);assert.equal(validation.memoryPolicyRevision,1);assert.equal(validation.visualPolicyRevision,1);assert.equal(validation.perceptionQualityProved,false);
 for(const prose of [f.v.episode.summary,f.v.episode.observations[0]!.description,'SCRIPTED source-to-memory transform estimate','synthetic-transform-v1'])assert.equal(JSON.stringify(evidence).includes(prose),false);
 assert.equal(new MemoryRepository(f.db).history(f.owner.assistantId,f.memoryId).length,2);assert.equal(Reflect.set(event,'eventId',randomUUID()),false);const before=JSON.stringify(evidence);assert.equal(f.activate().state,'alreadyActive');assert.equal(JSON.stringify(f.repo.activationEvidence(f.owner,f.memoryId)),before);
 for(const key of ['principalId','assistantId','relationshipId'] as const)assert.equal(f.repo.activationEvidence({...f.owner,[key]:randomUUID()},f.memoryId),null);
});

test('activation and mutation evidence roll back together; retry records only the actual committed source',t=>{
 const f=setup(t);f.db.exec("CREATE TRIGGER scripted_activation_failure BEFORE INSERT ON memory_lifecycle_events WHEN NEW.event_type='lifecycleChanged' BEGIN SELECT RAISE(ABORT,'scripted rollback'); END");
 assert.throws(()=>f.activate(),/scripted rollback/);assert.equal(new MemoryRepository(f.db).get(f.owner.assistantId,f.memoryId)!.lifecycle.status,'candidate');assert.equal(f.repo.activationEvidence(f.owner,f.memoryId),null);assert.equal(new MemoryRepository(f.db).history(f.owner.assistantId,f.memoryId).length,1);
 f.db.exec('DROP TRIGGER scripted_activation_failure');assert.equal(f.activate().state,'active');assert.ok(f.repo.activationEvidence(f.owner,f.memoryId));assert.equal(new MemoryRepository(f.db).history(f.owner.assistantId,f.memoryId).length,2);
});

test('canonical source survives real SQLite close/reopen and a legacy activation never receives an invented mutation identity',t=>{
 const root=mkdtempSync(join(tmpdir(),'ls-visual-activation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const f=setup(t,join(root,'db.sqlite'));f.activate();const before=JSON.stringify(f.repo.activationEvidence(f.owner,f.memoryId));f.reopen();assert.equal(JSON.stringify(f.repo.activationEvidence(f.owner,f.memoryId)),before);
 const row=f.db.connection.prepare("SELECT payload_json FROM memory_lifecycle_events WHERE memory_id=? AND revision=2").get(f.memoryId)!;const payload=JSON.parse(String(row.payload_json));delete payload.visualActivationEvidence;f.db.connection.prepare('UPDATE memory_lifecycle_events SET payload_json=? WHERE memory_id=? AND revision=2').run(JSON.stringify(payload),f.memoryId);
 assert.equal(f.repo.activationEvidence(f.owner,f.memoryId),null);assert.equal(f.activate().state,'alreadyActive');assert.equal(f.repo.activationEvidence(f.owner,f.memoryId),null);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM memory_lifecycle_events WHERE memory_id=?').get(f.memoryId)!.n,2);
});

test('forgetting, policy withdrawal and expiry erase validation payload while retaining only the real opaque event UUID',async t=>{
 for(const mode of ['sourceForget','memoryForget','withdrawVisual','withdrawMemory','expiry'] as const)await t.test(mode,child=>{
  const f=setup(child);f.activate();const evidence=f.repo.activationEvidence(f.owner,f.memoryId)!,id=evidence.event.eventId;
  if(mode==='sourceForget')f.repo.forget(f.owner,f.v.episode.episodeId,2);
  else if(mode==='memoryForget')new MemoryRepository(f.db).forget(f.owner.assistantId,f.memoryId,f.owner.principalId);
  else if(mode==='withdrawVisual')f.repo.configure(f.owner,false,1,86400000);
  else if(mode==='withdrawMemory'){f.db.exec('UPDATE automatic_memory_policies SET enabled=0,revision=revision+1');f.repo.configure(f.owner,false,1,86400000);}
  else {f.advance(86400000);f.repo.sweep();}
  assert.equal(f.repo.activationEvidence(f.owner,f.memoryId),null);const history=new MemoryRepository(f.db).history(f.owner.assistantId,f.memoryId),old=history.find(row=>row.revision===2)!;
  assert.deepEqual(old.payload,{payloadRemoved:true,visualActivationEventId:id});assert.equal(JSON.stringify(history).includes('candidateRecordDigest'),false);assert.equal(JSON.stringify(history).includes('blue hat'),false);
  // Repeat source retirement cannot discard or mint the saved receipt identity.
  f.repo.sweep();assert.equal(new MemoryRepository(f.db).history(f.owner.assistantId,f.memoryId).find(row=>row.revision===2)!.payload.visualActivationEventId,id);
 });
});

test('restore consent loss, correction, invalid artifact and clock rollback withhold evidence without fabricating an upcast',async t=>{
 for(const mode of ['restore','correct','artifact','revision','sourceRevision','scope','clock'] as const)await t.test(mode,child=>{
  const f=setup(child);f.activate();
  if(mode==='restore')f.db.exec('UPDATE automatic_memory_policies SET enabled=0');
  else if(mode==='correct')f.repo.correct(f.owner,f.v.episode.episodeId,2,'The scripted interpretation needs correction.');
  else if(mode==='clock')f.advance(-1);
  else {const row=f.db.connection.prepare('SELECT payload_json FROM memory_lifecycle_events WHERE memory_id=? AND revision=2').get(f.memoryId)!,payload=JSON.parse(String(row.payload_json)),evidence=payload.visualActivationEvidence;
   if(mode==='artifact')evidence.artifact.bytes+=' ';
   if(mode==='revision')evidence.event.newRevision++;
   if(mode==='sourceRevision')evidence.event.sourceRevision.revision='fabricated';
   if(mode==='scope')evidence.scope.sessionId=randomUUID();
   f.db.connection.prepare('UPDATE memory_lifecycle_events SET payload_json=? WHERE memory_id=? AND revision=2').run(JSON.stringify(payload),f.memoryId);
  }
  assert.equal(f.repo.activationEvidence(f.owner,f.memoryId),null);
 });
});

test('denied activation and ordinary legacy forgetting do not create visual receipt identities or erase independent Human memory',t=>{
 const f=setup(t);f.db.exec('UPDATE automatic_memory_policies SET enabled=0');assert.equal(f.activate().state,'policyDenied');assert.equal(f.repo.activationEvidence(f.owner,f.memoryId),null);f.db.exec('UPDATE automatic_memory_policies SET enabled=1');f.activate();
 const memories=new MemoryRepository(f.db),id=randomUUID();memories.save({id,assistantId:f.owner.assistantId,content:'Synthetic independent Human statement',provenance:{actor:f.owner.principalId,relationshipId:f.owner.relationshipId,epistemicStatus:'userStatement'},lifecycle:{status:'candidate',revision:1},createdAt:new Date(f.now()).toISOString()});
 f.repo.forget(f.owner,f.v.episode.episodeId,2);assert.equal(memories.get(f.owner.assistantId,id)!.content,'Synthetic independent Human statement');f.db.connection.prepare('UPDATE memory_lifecycle_events SET payload_json=? WHERE memory_id=?').run(JSON.stringify({visualActivationEventId:'SCRIPTED private text is not a UUID',notes:'SCRIPTED source payload'}),id);memories.forget(f.owner.assistantId,id,f.owner.principalId);assert.deepEqual(memories.history(f.owner.assistantId,id)[0]!.payload,{payloadRemoved:true});
});
