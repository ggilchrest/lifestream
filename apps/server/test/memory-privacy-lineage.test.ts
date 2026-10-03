import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Database,MemoryRepository} from '@lifestream/storage-sqlite';
import {AutomaticMemory} from '../src/runtime/automatic-memory.ts';
import {RelationshipRecovery,type RecoveryRelationship} from '../src/admin/relationship-recovery.ts';
import {recoveryDigest} from '../src/admin/recovery-journal.ts';

test('withdrawn correction descendants remain owned and are erased by the pinned privacy plan after interruption and database reopen',async t=>{
 const root=await mkdtemp(join(tmpdir(),'memory-privacy-lineage-')),path=join(root,'state.sqlite');
 let db=new Database({path});db.migrate();let memories=new MemoryRepository(db);
 t.after(()=>{db.close();return rm(root,{recursive:true,force:true});});
 db.exec('CREATE TABLE assistant_relationships (relationship_id TEXT PRIMARY KEY,assistant_id TEXT NOT NULL,user_id TEXT NOT NULL,payload_json TEXT NOT NULL); CREATE TABLE assistant_relationship_configurations (configuration_id TEXT PRIMARY KEY,relationship_id TEXT NOT NULL,payload_json TEXT NOT NULL); CREATE TABLE assistant_relationship_idempotency (idempotency_key TEXT PRIMARY KEY,relationship_id TEXT NOT NULL,operation TEXT NOT NULL,response_json TEXT NOT NULL)');
 const owner={principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID()},quote='Our synthetic bicycle label is amber willow.';
 const worker=new AutomaticMemory({database:db,memories,idle:()=>true,changed:()=>{},provider:()=>({revision:'synthetic-lineage-v1',provider:{async *generate(request){const data=JSON.parse(request.sections.at(-1)!.content);yield {kind:'text' as const,text:JSON.stringify({version:2,source:data.sourceIdentity,items:[{key:'bicycle.label',kind:'preference',quote,subject:'owner',scope:'relationship',epistemic:'userStatement',meaning:'Participant bicycle label.',attribution:'Authenticated participant statement.',uncertainty:'Truth unverified.',dependencyRefs:[]}]})};yield {kind:'done' as const};}}})});
 t.after(()=>worker.close());worker.configure(owner,true,0);worker.enqueue(owner,'turn:lineage',quote,'authenticatedTypedOwner');await worker.tick();
 const original=memories.contextRecords(owner.assistantId,owner.principalId)[0]!;assert.ok(original);worker.configure(owner,false,1);await worker.close();
 assert.equal(memories.get(owner.assistantId,original.id),undefined);
 assert.equal(memories.listForOwnerAdministration(owner.assistantId,owner.principalId,owner.relationshipId).length,1,'withdrawal retains owner custody');
 let current=original;const ids=[original.id],payloads=[original.content];
 for(const content of ['User stated: Our synthetic bicycle label is blue spruce.','User stated: Our synthetic bicycle label is copper pine.']){
  const proposal=memories.proposeCorrection(owner.assistantId,current.id,content,owner.principalId)!;
  current=memories.applyCorrection(owner.assistantId,current.id,proposal.revision,Number(current.lifecycle.revision),owner.principalId);ids.push(current.id);payloads.push(content);
 }
 const retained=memories.listForOwnerAdministration(owner.assistantId,owner.principalId,owner.relationshipId);
 assert.equal(retained.length,3);assert.equal(retained.find(m=>m.id===original.id)!.lifecycle.status,'superseded');
 assert.equal(current.provenance.correctionOf,ids[1]);assert.equal(memories.contextRecords(owner.assistantId,owner.principalId).length,0,'owner correction cannot grant recall');
 const unrelated={...original,id:randomUUID(),content:'An unrelated retained owner note.',provenance:{actor:owner.principalId,relationshipId:owner.relationshipId}},foreign={...original,id:randomUUID(),content:'A foreign owner note.',provenance:{actor:randomUUID(),relationshipId:owner.relationshipId,correctionOf:original.id}},otherAssistant={...original,id:randomUUID(),assistantId:randomUUID(),content:'Another assistant note.',provenance:{actor:owner.principalId,correctionOf:original.id}};
 for(const record of [unrelated,foreign,otherAssistant])memories.save(record);
 const relationship:RecoveryRelationship={relationshipId:owner.relationshipId,assistantId:owner.assistantId,userId:owner.principalId,revision:1,status:'active',candidates:[]};
 db.connection.prepare('INSERT INTO assistant_relationships VALUES (?,?,?,?)').run(owner.relationshipId,owner.assistantId,owner.principalId,JSON.stringify(relationship));
 // This component fixture exercises actual plan/apply and SQLite restart;
 // durable filesystem journal and authenticated HTTP remain separate witnesses.
 let recovery=new RelationshipRecovery(db,memories);
 const intent=recovery.prepare(relationship,{action:'forget-derived-information',expectedRevision:1,idempotencyKey:randomUUID(),targets:[{kind:'memory',id:original.id,revision:memories.getForPrivacy(owner.assistantId,original.id,owner.principalId)!.lifecycle.revision}]});
 assert.deepEqual(new Set(intent.memoryIds),new Set(ids),'the plan must include the entire retained correction lineage');
 for(const content of payloads)assert.ok(intent.contentDigests.includes(recoveryDigest(content)),'withdrawn current payload is fenced against replay');
 assert.ok(!intent.memoryIds.includes(unrelated.id)&&!intent.memoryIds.includes(foreign.id)&&!intent.memoryIds.includes(otherAssistant.id));
 const pinned=recovery.journal.admit(intent),pinnedBytes=JSON.stringify(pinned),forget=memories.forget.bind(memories);
 t.mock.method(memories,'forget',(...args:Parameters<typeof forget>)=>{forget(...args);throw Error('Synthetic interruption after payload removal');});
 assert.throws(()=>recovery.apply(pinned),/Synthetic interruption/);
 assert.equal(memories.getForPrivacy(owner.assistantId,original.id,owner.principalId)!.content,'');
 assert.equal(memories.listForOwnerAdministration(owner.assistantId,owner.principalId,owner.relationshipId).length,3,'retained descendants remain visible until cleanup succeeds');
 db.close();db=new Database({path});db.migrate();memories=new MemoryRepository(db);recovery=new RelationshipRecovery(db,memories);recovery.journal.admit(pinned);
 const receipt=recovery.apply(pinned);assert.equal(receipt.status,'completed');assert.equal(receipt.retryRequired,false);assert.equal(JSON.stringify(pinned),pinnedBytes);
 assert.deepEqual(new Set(receipt.artifacts.filter(a=>a.owner==='native-memory').map(a=>a.id)),new Set(ids));
 for(const id of ids){const memory=memories.getForPrivacy(owner.assistantId,id,owner.principalId)!;assert.equal(memory.content,'');assert.equal(memory.lifecycle.contentRemoved,true);assert.equal(memory.provenance.payloadRemoved,true);assert.ok(memories.history(owner.assistantId,id).some(e=>e.eventType==='forgotten'));assert.doesNotMatch(JSON.stringify([memory,memories.history(owner.assistantId,id)]),/amber willow|blue spruce|copper pine/);}
 assert.deepEqual(memories.listForOwnerAdministration(owner.assistantId,owner.principalId,owner.relationshipId).map(m=>m.id),[unrelated.id],'administration still exposes unrelated retained payload');
 for(const record of [unrelated,foreign,otherAssistant])assert.equal(memories.getForPrivacy(record.assistantId,record.id,String(record.provenance.actor))!.content,record.content);
 const revisions=ids.map(id=>memories.getForPrivacy(owner.assistantId,id,owner.principalId)!.lifecycle.revision);assert.deepEqual(recovery.apply(pinned),receipt);assert.deepEqual(ids.map(id=>memories.getForPrivacy(owner.assistantId,id,owner.principalId)!.lifecycle.revision),revisions,'completed retry is idempotent');
});
