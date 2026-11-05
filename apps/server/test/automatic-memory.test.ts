import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Database,MemoryRepository} from '@lifestream/storage-sqlite';
import {AutomaticMemory,preserveProjectContinuity,validateExtractedMemory,validateMemoryBatch,validateSemanticMemoryBatch,type SemanticMemoryCandidate} from '../src/runtime/automatic-memory.ts';
const semantic=(quote:string,key='project.language',kind='conversationSummary',stance:SemanticMemoryCandidate['stance']='assertion'):SemanticMemoryCandidate=>({key,kind:kind as SemanticMemoryCandidate['kind'],quote,meaning:quote,stance,uncertainty:[],relevance:'Useful attributed project context',dependencies:[]});
const semanticText=(quote:string)=>`User assertion (unverified interpretation): ${quote}\nEvidence: ${quote}`;
const scope=():{principalId:string;assistantId:string;relationshipId:string}=>({principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID()});
function setup(t:any,options:{resolveProvider?:()=>void;extract?:()=>void|Promise<void>;idle?:()=>boolean;contentAllowed?:(owner:ReturnType<typeof scope>,content:string)=>boolean;changed?:()=>void}={}){const root=mkdtempSync(join(tmpdir(),'automatic-memory-')),path=join(root,'db.sqlite');const db=new Database({path});db.migrate();const memories=new MemoryRepository(db),owner=scope();let calls=0,items:unknown[]=[];
 const make=()=>new AutomaticMemory({database:db,memories,provider:()=>{options.resolveProvider?.();return {revision:'synthetic-extractor-v1',provider:{async *generate(){calls++;await options.extract?.();yield {kind:'text' as const,text:JSON.stringify({version:2,items:items.map(value=>{const item=value as Record<string,unknown>;return Object.hasOwn(item,'meaning')?item:semantic(String(item.quote),String(item.key),String(item.kind));})})};yield {kind:'done' as const};}}};},idle:options.idle??(()=>true),...(options.contentAllowed?{contentAllowed:options.contentAllowed}:{}),changed:options.changed??(()=>{})});
 let worker=make();t.after(async()=>{await worker.close();db.close();rmSync(root,{recursive:true,force:true});});
 return {db,memories,owner,get worker(){return worker;},setItems:(values:unknown[])=>items=values,set:(quote:string,key='project.language',kind='conversationSummary')=>items=[{key,kind,quote,subject:'owner',epistemic:'userStatement'}],calls:()=>calls,restart:async()=>{await worker.close();worker=make();}};
}
test('mixed extraction retains only independently validated statements with visible rejection counts across persistence retry',async t=>{
 const f=setup(t),quote='I enjoy measuring the results of my basil experiments.',good={key:'gardening.enjoyment',kind:'preference',quote,subject:'owner',epistemic:'userStatement'},bad={...good,key:'invalidCamelCase',quote:'I never said this invented conclusion.'};
 assert.throws(()=>validateExtractedMemory({items:[good,bad]},quote));assert.throws(()=>validateMemoryBatch({items:[good,good]},quote),/duplicate/);assert.throws(()=>validateMemoryBatch({items:[bad]},quote),/No safely/);assert.throws(()=>validateMemoryBatch({items:[good],extra:true},quote));assert.throws(()=>validateMemoryBatch({items:Array(7).fill(good)},quote),/bound/);
 f.setItems([good,bad]);f.worker.configure(f.owner,true,0);f.worker.enqueue(f.owner,'turn:mixed',quote,'authenticatedTypedOwner');f.db.exec("CREATE TRIGGER reject_mixed BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");await f.worker.tick();const prepared=String(f.db.connection.prepare('SELECT prepared_json AS p FROM automatic_memory_work').get()!.p);assert.ok(!prepared.includes('invented'));await f.restart();f.db.exec('DROP TRIGGER reject_mixed');await f.worker.tick();assert.equal(f.calls(),1);assert.deepEqual(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).map(r=>r.content),[semanticText(quote)]);const job=f.worker.inspect(f.owner).jobs[0]!;assert.equal(job.state,'saved');const result=JSON.parse(String(job.result));assert.equal(result.returnedItemCount,2);assert.equal(result.extractedCount,1);assert.equal(result.rejectedItemCount,1);assert.equal(result.activeCount,1);
});
test('project extraction preserves a following attributable enjoyment and continuation sentence without widening unrelated memory',()=>{
 const input='My gardening project compares compost and plain soil. In my first trial compost grew taller. I enjoyed measuring the result and want to plan a second trial. I do not want to continue the separate reading project.';
 const project={key:'project.basil.trial',kind:'conversationSummary' as const,quote:'My gardening project compares compost and plain soil. In my first trial compost grew taller.',subject:'owner' as const,epistemic:'userStatement' as const};
 const reading={key:'project.reading',kind:'conversationSummary' as const,quote:'I do not want to continue the separate reading project.',subject:'owner' as const,epistemic:'userStatement' as const};
 assert.deepEqual(preserveProjectContinuity([project,reading],input),[{...project,quote:'My gardening project compares compost and plain soil. In my first trial compost grew taller. I enjoyed measuring the result and want to plan a second trial.'},reading]);
});
test('project extraction restores preceding topic context and joins separate enjoyment and continuation statements exactly',()=>{
 const input='My current reading project compares two essays about coastal wetlands. In the first essay, I enjoyed how the writer describes migrating birds at dawn. I want to compare another author describing the same marsh. A separate question asks when the marsh formed.';
 const fragment={key:'project.reading.coastal_wetlands',kind:'preference' as const,quote:'In the first essay, I enjoyed how the writer describes migrating birds at dawn.',subject:'owner' as const,epistemic:'userStatement' as const};
 assert.deepEqual(preserveProjectContinuity([fragment],input),[{...fragment,quote:'My current reading project compares two essays about coastal wetlands. In the first essay, I enjoyed how the writer describes migrating birds at dawn. I want to compare another author describing the same marsh.'}]);
});
test('automatic admission requires one scope approval, persists ordinary project context and excludes unknown speakers and secrets',async t=>{
 const f=setup(t),text='Our project uses Python for its service layer.';f.set(text);
 assert.equal(f.worker.enqueue(f.owner,'turn:1',text,'authenticatedTypedOwner').state,'notAdmitted');f.worker.configure(f.owner,true,0);
 assert.equal(f.worker.enqueue(f.owner,'voice:1',text,'unknownSpeaker').state,'notAdmitted');assert.equal(f.worker.enqueue(f.owner,'secret:1','My password is this-test-value.','authenticatedTypedOwner').state,'notAdmitted');assert.equal(f.worker.enqueue(f.owner,'third:1','My sister has a personal concern.','authenticatedTypedOwner').state,'notAdmitted');
 assert.equal(f.worker.enqueue(f.owner,'turn:1',text,'authenticatedTypedOwner').state,'queued');assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);await f.worker.tick();
 const records=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId);assert.equal(records.length,1);assert.equal(records[0]!.content,semanticText(text));assert.equal(records[0]!.lifecycle.kind,'conversationSummary');assert.equal(records[0]!.provenance.epistemicStatus,'assertion');assert.equal(records[0]!.lifecycle.lastReinforcedAt,null);assert.deepEqual(records[0]!.lifecycle.contradictedBy,[]);
 assert.equal(f.worker.enqueue(f.owner,'turn:1',text,'authenticatedTypedOwner').state,'saved');assert.throws(()=>f.worker.enqueue(f.owner,'turn:1','Different source text','authenticatedTypedOwner'),/identity conflict/);await f.worker.tick();assert.equal(f.calls(),1);
 assert.equal((f.db.connection.prepare('SELECT input_text AS input,prepared_json AS prepared FROM automatic_memory_work').get() as {input:string}).input,'');assert.equal(f.memories.contextRecords(f.owner.assistantId,'another-owner').length,0);
});
test('unresolved differences withhold context; explicit owner correction resolves it, and forgetting cannot be silently relearned',async t=>{
 const f=setup(t);f.worker.configure(f.owner,true,0);
 const add=async(text:string,id:string)=>{f.set(text);f.worker.enqueue(f.owner,id,text,'authenticatedTypedOwner');await f.worker.tick();};
 await add('Our project uses Python.','turn:1');await add('Our project uses Rust.','turn:2');assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);assert.equal(f.memories.list(f.owner.assistantId).filter(r=>r.lifecycle.needsReview).length,2);
 f.worker.enqueue(f.owner,'turn:3','Correction: our project now uses TypeScript.','authenticatedTypedOwner');f.db.connection.prepare("UPDATE automatic_memory_work SET state='prepared',prepared_json=? WHERE source_turn='turn:3'").run(JSON.stringify({items:[{key:'project.language',kind:'conversationSummary',quote:'Correction: our project now uses TypeScript.',subject:'owner',epistemic:'userStatement'}],providerRevision:'historical-v1'}));await f.worker.tick();const current=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId);assert.equal(current.length,1);assert.match(current[0]!.content,/TypeScript/);assert.ok(f.memories.list(f.owner.assistantId).filter(r=>r.id!==current[0]!.id).every(r=>r.lifecycle.status==='superseded'));
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
test('automatic extraction crosses the real SGLang canonical request validator before persistence',async t=>{
 const {createServer}=await import('node:http'),{SglangInferenceProvider}=await import('../../../packages/providers-sglang/src/provider.ts');const quote='Our synthetic project uses a TypeScript service.';let calls=0;
 const server=createServer(async(req,res)=>{for await(const _chunk of req){}calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify({version:2,items:[semantic(quote)]})}}]})}\n\ndata: [DONE]\n\n`);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const db=new Database({path:':memory:'});db.migrate();const memories=new MemoryRepository(db),owner=scope(),address=server.address();assert.ok(address&&typeof address!=='string');const provider=new SglangInferenceProvider({endpoint:`http://127.0.0.1:${address.port}`,model:'synthetic-http-model'}),worker=new AutomaticMemory({database:db,memories,provider:()=>({provider,revision:'synthetic-http'}),idle:()=>true,changed:()=>{}});t.after(async()=>{await worker.close();db.close();});worker.configure(owner,true,0);worker.enqueue(owner,'turn:canonical',quote,'authenticatedTypedOwner');await worker.tick();assert.equal(calls,1);assert.equal(memories.contextRecords(owner.assistantId,owner.principalId)[0]?.content,semanticText(quote));
});

test('a question or a substring of that question cannot contradict an admitted statement',async t=>{const f=setup(t);f.worker.configure(f.owner,true,0);f.set('Our project uses TypeScript.');f.worker.enqueue(f.owner,'turn:statement','Our project uses TypeScript.','authenticatedTypedOwner');await f.worker.tick();f.setItems([]);f.worker.enqueue(f.owner,'turn:question','Which language do we use?','authenticatedTypedOwner');await f.worker.tick();assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,1);assert.equal(f.memories.list(f.owner.assistantId).length,1);assert.deepEqual(validateExtractedMemory({items:[{key:'project.language',kind:'conversationSummary',quote:'language do we use',subject:'owner',epistemic:'userStatement'}]},'Which language do we use?'),[]);});

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

test('meaning-based idle admission retains pronoun-free qualified advice with exact evidence and no verified confidence',async t=>{
 const f=setup(t),quote='Check soil moisture before watering a plant.',item={...semantic(quote,'gardening.water','proceduralHint','advice'),meaning:'Check moisture before watering; applicability depends on the plant.',uncertainty:['Plant needs vary.']};
 assert.throws(()=>validateExtractedMemory({items:[{key:item.key,kind:item.kind,quote,subject:'owner',epistemic:'userStatement'}]},quote),/attributable/,'the retained v1 predicate rejects this pronoun-free source');
 f.worker.configure(f.owner,true,0);f.setItems([item]);assert.equal(f.worker.enqueue(f.owner,'turn:advice',quote,'authenticatedTypedOwner').state,'queued');await f.worker.tick();
 const record=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!;assert.equal(record.provenance.evidenceQuote,quote);assert.equal(record.provenance.proposedMeaning,item.meaning);assert.equal(record.provenance.epistemicStatus,'advice');assert.deepEqual(record.provenance.uncertainty,item.uncertainty);assert.equal(record.lifecycle.confidence,null);assert.equal(record.provenance.sourceRevision,1);assert.match(record.content,/advice \(unverified interpretation\)/);assert.equal(f.calls(),1);
});

test('reasoning-proposed questions, hypotheses and quotations remain qualified rather than becoming assertions',()=>{
 const source='I wonder whether plants hear music. The guide says "Water only when dry." That was a joke.';
 const candidates=[semantic('I wonder whether plants hear music.','plants.question','experiential','hypothesis'),semantic('The guide says "Water only when dry."','plants.quote','proceduralHint','quoted'),semantic('That was a joke.','plants.joke','relational','joke')];
 assert.deepEqual(validateSemanticMemoryBatch({version:2,items:candidates},source).items,candidates);
 assert.deepEqual(validateSemanticMemoryBatch({version:2,items:[]},'I have mentioned myself.').items,[],'first-person wording alone does not force a candidate');
});

test('semantic task output rejects foreign quotes, dependency claims, oversized metadata and accessors without invoking them',()=>{
 const quote='Check moisture before watering.',good=semantic(quote),foreign={...good,key:'foreign',quote:'Not in the original source'};
 const batch=validateSemanticMemoryBatch({version:2,items:[good,foreign]},quote);assert.equal(batch.items.length,1);assert.equal(batch.rejectedItemCount,1);
 assert.throws(()=>validateSemanticMemoryBatch({version:2,items:[{...good,dependencies:['unprovided']}]},quote),/No safely/);
 assert.throws(()=>validateSemanticMemoryBatch({version:2,items:Array(4).fill(good)},quote),/batch/);
 const long='a'.repeat(900),items=[0,1,2].map(n=>({...semantic(long,`topic.${n}`),meaning:'b'.repeat(400),relevance:'c'.repeat(160),uncertainty:['d'.repeat(160)]}));assert.throws(()=>validateSemanticMemoryBatch({version:2,items},long),/bound/);
 let read=0;const accessor={...good};Object.defineProperty(accessor,'meaning',{enumerable:true,get(){read++;throw Error('must not read');}});assert.throws(()=>validateSemanticMemoryBatch({version:2,items:[accessor]},quote));assert.equal(read,0);
 const array=[good];Object.defineProperty(array,'0',{get(){read++;throw Error('must not read');}});assert.throws(()=>validateSemanticMemoryBatch({version:2,items:array},quote));assert.equal(read,0);
 assert.throws(()=>validateSemanticMemoryBatch({version:2,items:[good],principalId:'foreign'},quote),/batch/);
});

test('a model-labelled correction cannot auto-supersede the current owner memory',async t=>{
 const f=setup(t);f.worker.configure(f.owner,true,0);f.set('Our project uses Python.');f.worker.enqueue(f.owner,'turn:old','Our project uses Python.','authenticatedTypedOwner');await f.worker.tick();
 const quote='Correction: the project uses Rust.';f.setItems([{...semantic(quote),meaning:'The project is said to use Rust.',uncertainty:['This conflicts with the retained account.']}]);f.worker.enqueue(f.owner,'turn:proposed-correction',quote,'authenticatedTypedOwner');await f.worker.tick();
 assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);assert.equal(f.memories.list(f.owner.assistantId).filter(r=>r.lifecycle.needsReview===true).length,2);assert.ok(f.memories.list(f.owner.assistantId).every(r=>r.lifecycle.status!=='superseded'));
});

test('durable source mutation or consent withdrawal during reasoning prevents late semantic admission',async t=>{
 for(const fault of ['source','policy'] as const)await t.test(fault,async child=>{
  const entered=deferred(),release=deferred(),f=setup(child,{extract:async()=>{entered.resolve();await release.promise;}}),quote='Check soil before watering.';f.worker.configure(f.owner,true,0);f.setItems([semantic(quote)]);f.worker.enqueue(f.owner,`turn:${fault}`,quote,'authenticatedTypedOwner');
  const running=f.worker.tick();await entered.promise;if(fault==='source')f.db.connection.prepare('UPDATE automatic_memory_work SET input_text=?').run('A changed source');else f.worker.configure(f.owner,false,1);release.resolve();await running;assert.equal(f.memories.list(f.owner.assistantId).length,0);assert.notEqual(workRow(f,`turn:${fault}`).state,'saved');
 });
});

test('forgetting a depended-on source fences prepared semantic work across restart without another inference',async t=>{
 const f=setup(t),oldQuote='I prefer concise replies.';f.worker.configure(f.owner,true,0);f.set(oldQuote,'communication.concise','preference');f.worker.enqueue(f.owner,'turn:dependency',oldQuote,'authenticatedTypedOwner');await f.worker.tick();const old=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!;
 const quote='Use a brief summary before details.';f.setItems([{...semantic(quote,'communication.summary','proceduralHint','advice'),dependencies:[old.id]}]);f.worker.enqueue(f.owner,'turn:dependent',quote,'authenticatedTypedOwner');f.db.exec("CREATE TRIGGER reject_dependent BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");await f.worker.tick();assert.ok(workRow(f,'turn:dependent').prepared);const calls=f.calls();
 f.memories.forget(f.owner.assistantId,old.id,f.owner.principalId);await f.restart();f.db.exec('DROP TRIGGER reject_dependent');await f.worker.tick();assert.equal(f.calls(),calls);assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);assert.notEqual(workRow(f,'turn:dependent').state,'saved');
});

test('forgetting an existing topic while reasoning is held prevents a late candidate from relearning it',async t=>{
 let block=false;const entered=deferred(),release=deferred(),f=setup(t,{extract:async()=>{if(block){entered.resolve();await release.promise;}}}),quote='Check moisture before watering.';f.worker.configure(f.owner,true,0);f.setItems([semantic(quote,'gardening.water','proceduralHint','advice')]);f.worker.enqueue(f.owner,'turn:first',quote,'authenticatedTypedOwner');await f.worker.tick();const original=f.memories.contextRecords(f.owner.assistantId,f.owner.principalId)[0]!;
 block=true;f.worker.enqueue(f.owner,'turn:late-topic',quote,'authenticatedTypedOwner');const running=f.worker.tick();await entered.promise;f.memories.forget(f.owner.assistantId,original.id,f.owner.principalId);release.resolve();await running;assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);assert.equal(f.memories.get(f.owner.assistantId,original.id)?.content,'');assert.notEqual(workRow(f,'turn:late-topic').state,'saved');
});

test('prepared semantic source and scope hashes are revalidated; legacy preparations remain strict exact quotations',async t=>{
 for(const fault of ['sourceDigest','scopeDigest','legacyQuote','oversized'] as const)await t.test(fault,async child=>{
  const f=setup(child),quote='I prefer concise replies.';f.worker.configure(f.owner,true,0);f.set(quote);f.worker.enqueue(f.owner,'turn:prepared',quote,'authenticatedTypedOwner');f.db.exec("CREATE TRIGGER reject_prepared BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");await f.worker.tick();
  let prepared=JSON.parse(workRow(f,'turn:prepared').prepared!);if(fault==='legacyQuote')prepared={items:[{key:'topic',kind:'preference',quote:'I said something foreign.',subject:'owner',epistemic:'userStatement'}],providerRevision:'historical-v1'};else prepared[fault]='0'.repeat(64);
  f.db.connection.prepare('UPDATE automatic_memory_work SET prepared_json=?').run((fault==='oversized'?' '.repeat(16385):'')+JSON.stringify(prepared));f.db.exec('DROP TRIGGER reject_prepared');await f.restart();await f.worker.tick();assert.equal(f.memories.list(f.owner.assistantId).length,0);assert.equal(f.calls(),1);
 });
});
