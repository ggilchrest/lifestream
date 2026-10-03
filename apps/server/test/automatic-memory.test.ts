import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Database,MemoryRepository} from '@lifestream/storage-sqlite';
import {AutomaticMemory} from '../src/runtime/automatic-memory.ts';
const scope=()=>({principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID()});
function setup(t:any,options:{resolveProvider?:()=>void;extract?:()=>void|Promise<void>;idle?:()=>boolean;contentAllowed?:(owner:ReturnType<typeof scope>,content:string)=>boolean;changed?:()=>void}={}){const root=mkdtempSync(join(tmpdir(),'automatic-memory-')),path=join(root,'db.sqlite');const db=new Database({path});db.migrate();const memories=new MemoryRepository(db),owner=scope();let calls=0,items:unknown[]=[];
 const make=()=>new AutomaticMemory({database:db,memories,provider:()=>{options.resolveProvider?.();return {revision:'synthetic-extractor-v1',provider:{async *generate(request:any){calls++;await options.extract?.();const data=JSON.parse(request.sections.find((section:any)=>section.kind==='userInput').content);yield {kind:'text' as const,text:JSON.stringify({version:2,source:data.sourceIdentity,items:items.map(value=>({...value as object,scope:'relationship',meaning:'Synthetic durable source interpretation',attribution:'authenticated participant',uncertainty:'Participant statement; truth unverified',dependencyRefs:[]}))})};yield {kind:'done' as const};}}};},idle:options.idle??(()=>true),contentAllowed:options.contentAllowed,changed:options.changed??(()=>{})});
 let worker=make();t.after(async()=>{await worker.close();db.close();rmSync(root,{recursive:true,force:true});});
 return {db,memories,owner,get worker(){return worker;},setItems:(values:unknown[])=>items=values,set:(quote:string,key='project.language',kind='conversationSummary')=>items=[{key,kind,quote,subject:'owner',epistemic:'userStatement'}],calls:()=>calls,restart:async()=>{await worker.close();worker=make();}};
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
 const f=setup(t);
 f.worker.configure(f.owner,true,0);f.worker.enqueue(f.owner,'turn:cancel','I prefer quieter replies.','authenticatedTypedOwner');f.worker.configure(f.owner,false,1);await f.worker.tick();assert.equal(f.calls(),0);assert.equal(f.memories.list(f.owner.assistantId).length,0);const job=f.db.connection.prepare('SELECT state,input_text AS input FROM automatic_memory_work').get() as {state:string;input:string};assert.equal(job.state,'cancelled');assert.equal(job.input,'');
});
test('automatic extraction crosses the real SGLang canonical request validator before persistence',async t=>{
 const {createServer}=await import('node:http'),{SglangInferenceProvider}=await import('../../../packages/providers-sglang/src/provider.ts');const quote='Our synthetic project uses a TypeScript service.';let calls=0;
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const messages=JSON.parse(body).messages;const data=JSON.parse(messages.find((message:any)=>message.role==='user').content.split('[userInput; untrusted]\n')[1]);calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify({version:2,source:data.sourceIdentity,items:[{key:'project.language',kind:'conversationSummary',quote,subject:'owner',scope:'relationship',epistemic:'userStatement',meaning:'Synthetic project language',attribution:'authenticated participant',uncertainty:'Truth unverified',dependencyRefs:[]}]})}}]})}\n\ndata: [DONE]\n\n`);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const db=new Database({path:':memory:'});db.migrate();const memories=new MemoryRepository(db),owner=scope(),address=server.address();assert.ok(address&&typeof address!=='string');const provider=new SglangInferenceProvider({endpoint:`http://127.0.0.1:${address.port}`,model:'synthetic-http-model'}),worker=new AutomaticMemory({database:db,memories,provider:()=>({provider,revision:'synthetic-http'}),idle:()=>true,changed:()=>{}});t.after(async()=>{await worker.close();db.close();});worker.configure(owner,true,0);worker.enqueue(owner,'turn:canonical',quote,'authenticatedTypedOwner');await worker.tick();assert.equal(calls,1);assert.equal(memories.contextRecords(owner.assistantId,owner.principalId)[0]?.content,`User stated: ${quote}`);
});

test('reasoning may select zero candidates for a question without changing admitted statements',async t=>{const f=setup(t);f.worker.configure(f.owner,true,0);f.set('Our project uses TypeScript.');f.worker.enqueue(f.owner,'turn:statement','Our project uses TypeScript.','authenticatedTypedOwner');await f.worker.tick();f.setItems([]);f.worker.enqueue(f.owner,'turn:question','Which language do we use?','authenticatedTypedOwner');await f.worker.tick();assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,1);assert.equal(f.memories.list(f.owner.assistantId).length,1);});

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function workRow(f:ReturnType<typeof setup>,source:string){return f.db.connection.prepare('SELECT id,state,input_text AS input,prepared_json AS prepared,reason,attempts FROM automatic_memory_work WHERE source_turn=?').get(source) as {id:string;state:string;input:string;prepared:string|null;reason:string|null;attempts:number};}
function assertExpired(f:ReturnType<typeof setup>,source:string){const row=workRow(f,source);assert.equal(row.state,'expired');assert.equal(row.input,'');assert.equal(row.prepared,null);assert.equal(row.reason,'retention_expired');return row;}
const expiryQuote='I prefer concise explanations.';
function enqueueExpiry(f:ReturnType<typeof setup>,source:string){f.set(expiryQuote,'communication.concise','preference');assert.equal(f.worker.enqueue(f.owner,source,expiryQuote,'authenticatedTypedOwner').state,'queued');}

test('provider completion at the source expiry boundary cannot persist preparation or admit memory',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);const started=deferred(),release=deferred();
 const f=setup(t,{extract:async()=>{started.resolve();await release.promise;}});f.worker.configure(f.owner,true,0);enqueueExpiry(f,'turn:late');
 const expires=now+1000;f.db.connection.prepare('UPDATE automatic_memory_work SET expires_at=?').run(expires);
 f.db.exec("CREATE TEMP TABLE preparation_writes (n INTEGER); CREATE TEMP TRIGGER count_preparation AFTER UPDATE OF prepared_json ON automatic_memory_work WHEN NEW.prepared_json IS NOT NULL BEGIN INSERT INTO preparation_writes VALUES (1); END");
 const running=f.worker.tick();await started.promise;now=expires;release.resolve();await running;
 assertExpired(f,'turn:late');assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM preparation_writes').get()!.n,0);assert.equal(f.memories.list(f.owner.assistantId).length,0);assert.equal(f.worker.isIdle(),true);
 now=expires-500;assert.throws(()=>f.worker.retry(f.owner,workRow(f,'turn:late').id),/unavailable/);await f.worker.tick();assertExpired(f,'turn:late');assert.equal(f.calls(),1);
});

test('expiry during provider resolution prevents transmitting the source to generation',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);const expires=now+1000,f=setup(t,{resolveProvider:()=>{now=expires;}});f.worker.configure(f.owner,true,0);enqueueExpiry(f,'turn:before-provider');f.db.connection.prepare('UPDATE automatic_memory_work SET expires_at=?').run(expires);
 await f.worker.tick();assertExpired(f,'turn:before-provider');assert.equal(f.calls(),0);assert.equal(f.memories.list(f.owner.assistantId).length,0);
});

test('expired durable preparation is scrubbed on restart and cannot be retried after clock rollback',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);const f=setup(t);f.worker.configure(f.owner,true,0);enqueueExpiry(f,'turn:prepared-expiry');
 f.db.exec("CREATE TRIGGER reject_expiry BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");await f.worker.tick();assert.ok(workRow(f,'turn:prepared-expiry').prepared);
 f.db.connection.prepare('UPDATE automatic_memory_work SET expires_at=?').run(now);await f.restart();assertExpired(f,'turn:prepared-expiry');f.db.exec('DROP TRIGGER reject_expiry');
 now-=1000;await f.restart();assert.throws(()=>f.worker.retry(f.owner,workRow(f,'turn:prepared-expiry').id),/unavailable/);await f.worker.tick();assertExpired(f,'turn:prepared-expiry');assert.equal(f.calls(),1);assert.equal(f.memories.list(f.owner.assistantId).length,0);
});

test('prepared admission rechecks durable expiry and policy after content filtering callbacks',async t=>{
 for(const invalidation of ['expiry','policy','terminal'] as const)await t.test(invalidation,async child=>{
  let invalidate=false;const f=setup(child,{contentAllowed:()=>{if(invalidate){if(invalidation==='expiry')f.db.connection.prepare('UPDATE automatic_memory_work SET expires_at=?').run(Date.now());else if(invalidation==='policy')f.worker.configure(f.owner,false,1);else f.db.exec("UPDATE automatic_memory_work SET state='expired',input_text='',prepared_json=NULL,reason='retention_expired'");}return true;}});
  f.worker.configure(f.owner,true,0);enqueueExpiry(f,'turn:filter');f.db.exec("CREATE TRIGGER reject_filter BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");await f.worker.tick();assert.ok(workRow(f,'turn:filter').prepared);f.db.exec('DROP TRIGGER reject_filter');invalidate=true;
  await f.worker.tick();assert.equal(f.memories.list(f.owner.assistantId).length,0);assert.equal(f.calls(),1);const row=workRow(f,'turn:filter');assert.equal(row.state,invalidation==='policy'?'cancelled':'expired');assert.equal(row.input,'');assert.equal(row.prepared,null);
 });
});

test('foreground cancellation cannot requeue expired work or allow late provider output to restore it',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);const started=deferred(),release=deferred();const f=setup(t,{extract:async()=>{started.resolve();await release.promise;}});
 f.worker.configure(f.owner,true,0);enqueueExpiry(f,'turn:foreground-expiry');const expires=now+1000;f.db.connection.prepare('UPDATE automatic_memory_work SET expires_at=?').run(expires);
 const running=f.worker.tick();await started.promise;f.worker.preempt();now=expires;await f.worker.tick();await running;assertExpired(f,'turn:foreground-expiry');
 release.resolve();await new Promise<void>(resolve=>setImmediate(resolve));now=expires-500;await f.worker.tick();assertExpired(f,'turn:foreground-expiry');assert.equal(f.calls(),1);assert.equal(f.memories.list(f.owner.assistantId).length,0);
});

test('foreground preemption preserves an unexpired preparation for admission without repeated extraction',async t=>{
 let preempt=true;const f=setup(t,{contentAllowed:()=>{if(preempt){preempt=false;f.worker.preempt();}return true;}});f.worker.configure(f.owner,true,0);enqueueExpiry(f,'turn:valid-preemption');
 await f.worker.tick();assert.equal(workRow(f,'turn:valid-preemption').state,'prepared');assert.equal(workRow(f,'turn:valid-preemption').reason,'foreground_preempted');assert.equal(f.memories.list(f.owner.assistantId).length,0);
 await f.worker.tick();assert.equal(workRow(f,'turn:valid-preemption').state,'saved');assert.equal(f.memories.list(f.owner.assistantId).length,1);assert.equal(f.calls(),1);
});

test('a post-admission observer failure does not resurrect completed work',async t=>{
 const f=setup(t,{changed:()=>{throw new Error('synthetic observer failure');}});f.worker.configure(f.owner,true,0);enqueueExpiry(f,'turn:saved-terminal');await f.worker.tick();
 assert.equal(workRow(f,'turn:saved-terminal').state,'saved');assert.equal(workRow(f,'turn:saved-terminal').input,'');assert.equal(workRow(f,'turn:saved-terminal').prepared,null);await f.worker.tick();assert.equal(f.calls(),1);assert.equal(f.memories.list(f.owner.assistantId).length,1);
});

test('foreground pauses still expire queued, prepared and failed payloads without starting extraction',async t=>{
 const f=setup(t,{idle:()=>false});f.worker.configure(f.owner,true,0);for(const state of ['queued','prepared','failed']){enqueueExpiry(f,`turn:paused-${state}`);f.db.connection.prepare('UPDATE automatic_memory_work SET state=?,prepared_json=?,expires_at=? WHERE source_turn=?').run(state,state==='prepared'?'{}':null,Date.now()-1,`turn:paused-${state}`);}
 await f.worker.tick();for(const state of ['queued','prepared','failed'])assertExpired(f,`turn:paused-${state}`);assert.equal(f.calls(),0);
});

test('busy extraction does not postpone other source cleanup and keeps valid completed memory',async t=>{
 const started=deferred(),release=deferred(),f=setup(t,{extract:async()=>{started.resolve();await release.promise;}});f.worker.configure(f.owner,true,0);enqueueExpiry(f,'turn:active');
 const running=f.worker.tick();await started.promise;
 for(const state of ['queued','prepared','failed']){enqueueExpiry(f,`turn:busy-${state}`);f.db.connection.prepare('UPDATE automatic_memory_work SET state=?,prepared_json=?,expires_at=? WHERE source_turn=?').run(state,state==='prepared'?'{}':null,Date.now()-1,`turn:busy-${state}`);}
 await f.worker.tick();for(const state of ['queued','prepared','failed'])assertExpired(f,`turn:busy-${state}`);assert.equal(workRow(f,'turn:active').state,'running');
 release.resolve();await running;assert.equal(workRow(f,'turn:active').state,'saved');assert.equal(f.memories.list(f.owner.assistantId).length,1);
 f.db.connection.prepare("UPDATE automatic_memory_work SET expires_at=? WHERE source_turn='turn:active'").run(Date.now()-1);await f.worker.tick();assert.equal(workRow(f,'turn:active').state,'saved');assert.equal(f.memories.list(f.owner.assistantId).length,1);
});

test('busy cleanup releases an expired active extraction without waiting for its provider',async t=>{
 const started=deferred(),release=deferred(),f=setup(t,{extract:async()=>{started.resolve();await release.promise;}});f.worker.configure(f.owner,true,0);enqueueExpiry(f,'turn:busy-active');
 const running=f.worker.tick();await started.promise;f.db.connection.prepare('UPDATE automatic_memory_work SET expires_at=?').run(Date.now()-1);await f.worker.tick();await running;
 assertExpired(f,'turn:busy-active');assert.equal(f.worker.isIdle(),true);release.resolve();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.memories.list(f.owner.assistantId).length,0);
});

test('the initial source retention duration bounds a stalled extraction even when the wall clock stalls',async t=>{
 const now=Date.now();t.mock.method(Date,'now',()=>now);const started=deferred(),release=deferred(),f=setup(t,{extract:async()=>{started.resolve();await release.promise;}});f.worker.configure(f.owner,true,0);enqueueExpiry(f,'turn:timer-expiry');f.db.connection.prepare('UPDATE automatic_memory_work SET expires_at=?').run(now+25);
 const running=f.worker.tick();await started.promise;await running;assertExpired(f,'turn:timer-expiry');assert.equal(f.worker.isIdle(),true);release.resolve();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.memories.list(f.owner.assistantId).length,0);
});
