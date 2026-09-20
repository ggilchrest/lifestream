import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Database,MemoryRepository} from '@lifestream/storage-sqlite';
import {AutomaticMemory,validateExtractedMemory} from '../src/runtime/automatic-memory.ts';
const scope=()=>({principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID()});
function setup(t:any){const root=mkdtempSync(join(tmpdir(),'automatic-memory-')),path=join(root,'db.sqlite');const db=new Database({path});db.migrate();const memories=new MemoryRepository(db),owner=scope();let calls=0,items:unknown[]=[];
 const make=()=>new AutomaticMemory({database:db,memories,provider:()=>({revision:'synthetic-extractor-v1',provider:{async *generate(){calls++;yield {kind:'text' as const,text:JSON.stringify({items})};yield {kind:'done' as const};}}}),idle:()=>true,changed:()=>{}});
 let worker=make();t.after(async()=>{await worker.close();db.close();rmSync(root,{recursive:true,force:true});});
 return {db,memories,owner,get worker(){return worker;},set:(quote:string,key='project.language',kind='conversationSummary')=>items=[{key,kind,quote,subject:'owner',epistemic:'userStatement'}],calls:()=>calls,restart:async()=>{await worker.close();worker=make();}};
}
test('automatic admission requires one scope approval, persists ordinary project context and excludes unknown speakers and secrets',async t=>{
 const f=setup(t),text='Our project uses Python for its service layer.';f.set(text);
 assert.equal(f.worker.enqueue(f.owner,'turn:1',text,'authenticatedTypedOwner').state,'notAdmitted');f.worker.configure(f.owner,true,0);
 assert.equal(f.worker.enqueue(f.owner,'voice:1',text,'unknownSpeaker').state,'notAdmitted');assert.equal(f.worker.enqueue(f.owner,'secret:1','My password is this-test-value.','authenticatedTypedOwner').state,'notAdmitted');assert.equal(f.worker.enqueue(f.owner,'third:1','My sister has a personal concern.','authenticatedTypedOwner').state,'notAdmitted');
 assert.equal(f.worker.enqueue(f.owner,'turn:1',text,'authenticatedTypedOwner').state,'queued');assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);await f.worker.tick();
 const records=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId);assert.equal(records.length,1);assert.equal(records[0]!.content,`User stated: ${text}`);assert.equal(records[0]!.lifecycle.kind,'conversationSummary');assert.equal(records[0]!.provenance.epistemicStatus,'userStatement');assert.equal(records[0]!.lifecycle.lastReinforcedAt,null);assert.deepEqual(records[0]!.lifecycle.contradictedBy,[]);
 assert.equal(f.worker.enqueue(f.owner,'turn:1',text,'authenticatedTypedOwner').state,'saved');assert.throws(()=>f.worker.enqueue(f.owner,'turn:1','Different source text','authenticatedTypedOwner'),/identity conflict/);await f.worker.tick();assert.equal(f.calls(),1);
 assert.equal((f.db.connection.prepare('SELECT input_text AS input,prepared_json AS prepared FROM automatic_memory_work').get() as {input:string}).input,'');assert.equal(f.memories.contextRecords(f.owner.assistantId,'another-owner').length,0);
});
test('unresolved differences withhold context; explicit owner correction resolves it, and forgetting cannot be silently relearned',async t=>{
 const f=setup(t);f.worker.configure(f.owner,true,0);
 const add=async(text:string,id:string)=>{f.set(text);f.worker.enqueue(f.owner,id,text,'authenticatedTypedOwner');await f.worker.tick();};
 await add('Our project uses Python.','turn:1');await add('Our project uses Rust.','turn:2');assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);assert.equal(f.memories.list(f.owner.assistantId).filter(r=>r.lifecycle.needsReview).length,2);
 await add('Correction: our project now uses TypeScript.','turn:3');const current=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId);assert.equal(current.length,1);assert.match(current[0]!.content,/TypeScript/);assert.ok(f.memories.list(f.owner.assistantId).filter(r=>r.id!==current[0]!.id).every(r=>r.lifecycle.status==='superseded'));
 f.memories.forget(f.owner.assistantId,current[0]!.id,f.owner.principalId);await add('Our project now uses TypeScript.','turn:4');assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);assert.equal(f.memories.get(f.owner.assistantId,current[0]!.id)?.content,'');
});
test('durable prepared extraction retries persistence after restart without another provider call or duplicate records',async t=>{
 const f=setup(t),text='I prefer concise explanations.';f.set(text,'communication.concise','preference');f.worker.configure(f.owner,true,0);f.worker.enqueue(f.owner,'turn:retry',text,'authenticatedTypedOwner');
 f.db.exec("CREATE TRIGGER reject_automatic_memory BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");await f.worker.tick();assert.equal(f.calls(),1);assert.equal(f.memories.list(f.owner.assistantId).length,0);assert.ok((f.db.connection.prepare('SELECT prepared_json AS p FROM automatic_memory_work').get() as {p:string}).p);
 await f.restart();f.db.exec('DROP TRIGGER reject_automatic_memory');await f.worker.tick();assert.equal(f.calls(),1);assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,1);await f.worker.tick();assert.equal(f.memories.list(f.owner.assistantId).length,1);
});
test('extraction cannot invent quotes or owner attribution and policy withdrawal cancels queued data',async t=>{
 const f=setup(t);assert.throws(()=>validateExtractedMemory({items:[{key:'invented',kind:'preference',quote:'I like an invented thing.',subject:'owner',epistemic:'userStatement'}]},'I said something else.'));
 f.worker.configure(f.owner,true,0);f.worker.enqueue(f.owner,'turn:cancel','I prefer quieter replies.','authenticatedTypedOwner');f.worker.configure(f.owner,false,1);await f.worker.tick();assert.equal(f.calls(),0);assert.equal(f.memories.list(f.owner.assistantId).length,0);const job=f.db.connection.prepare('SELECT state,input_text AS input FROM automatic_memory_work').get() as {state:string;input:string};assert.equal(job.state,'cancelled');assert.equal(job.input,'');
});
