import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Database,MemoryRepository,type MemoryRecord} from '@lifestream/storage-sqlite';
import {AutomaticMemory} from '../src/runtime/automatic-memory.ts';
import type {InferenceRequest} from '@lifestream/runtime/inference';
type Payload={task:string;stage:string;query:string;queryDigest:string;sourceDigest:string;limit:number;candidates:{id:string;revision:number;content:string;proposedMeaning:string}[]};
const response=(data:Payload,ids:string[])=>({version:1,queryDigest:data.queryDigest,sourceDigest:data.sourceDigest,items:ids.map(id=>({id,revision:data.candidates.find(c=>c.id===id)?.revision??1,rationale:'The retained guidance addresses this requested situation; applicability unverified.'}))});
function setup(t:any,judge:(data:Payload)=>unknown|Promise<unknown>,options:{idle?:()=>boolean;contentAllowed?:(scope:any,content:string)=>boolean;revision?:()=>string;done?:boolean}={}){
 const db=new Database({path:':memory:'});db.migrate();const memories=new MemoryRepository(db),scope={assistantId:randomUUID(),principalId:randomUUID(),relationshipId:randomUUID()},requests:InferenceRequest[]=[];
 const worker=new AutomaticMemory({database:db,memories,provider:()=>({revision:options.revision?.()??'synthetic-semantic-selector-v1',provider:{async *generate(request){requests.push(request);const raw=await judge(JSON.parse(request.sections.at(-1)!.content));yield {kind:'text' as const,text:typeof raw==='string'?raw:JSON.stringify(raw)};if(options.done!==false)yield {kind:'done' as const};}}}),idle:options.idle??(()=>true),contentAllowed:options.contentAllowed,changed:()=>{}});worker.configure(scope,true,0);t.after(async()=>{await worker.close();db.close();});
 const save=(id:string,content:string,owner=scope)=>{memories.save({id,assistantId:owner.assistantId,content,provenance:{actor:owner.principalId,relationshipId:owner.relationshipId,sourceFamily:'independent:'+id},lifecycle:{status:'candidate',revision:1,kind:'proceduralHint',factuality:'unverified',confidence:0,lastReinforcedAt:null},createdAt:new Date().toISOString()});return memories.transition(owner.assistantId,id,'active',owner.principalId)!;};
 return {db,memories,scope,worker,requests,save};
}
test('meaning selection changes with the query, rejects literal distractors and returns zero for unrelated tasks',async t=>{
 const plants='What could deter tiny animals from eating new shoots?',reading='How can a reader keep track of a novel?',none='Describe a lunar crater.';
 const choices=new Map([[plants,['garden']], [reading,['reading']], [none,[]]]);
 const f=setup(t,data=>response(data,choices.get(data.query)??[]));f.save('garden','Participant advice: Put fine netting over the vegetable bed.');f.save('reading','Participant suggestion: Insert a paper strip at the current page.');f.save('distractor','Quoted typing exercise: '+plants);
 const before=f.memories.history(f.scope.assistantId,'garden');
 for(const [query,ids] of choices){const result=await f.worker.recall(f.scope,query);assert.deepEqual(result.memories.map(record=>record.id),ids);assert.equal(result.complete,true);assert.equal(result.state,ids.length?'selected':'empty');}
 assert.equal(f.requests.length,3);assert.ok(f.requests.every(request=>request.sections[0]!.content.includes('meaning')));assert.deepEqual(f.memories.history(f.scope.assistantId,'garden'),before);assert.equal(f.memories.get(f.scope.assistantId,'garden')!.lifecycle.factuality,'unverified');
});
test('an irrelevant-only corpus yields zero across unrelated queries without query-independent filling',async t=>{
 const f=setup(t,data=>response(data,[]));for(let i=0;i<30;i++)f.save('record:'+i,'Participant statement: The ensemble rehearses scales and tunes.');
 for(const query of ['How do tectonic plates move?','What is the origin of prime numbers?']){const result=await f.worker.recall(f.scope,query);assert.equal(result.state,'empty');assert.equal(result.memories.length,0);assert.equal(result.complete,true);assert.equal('candidateCount' in result&&result.candidateCount,30);}
 assert.equal(f.requests.length,2);const queries=f.requests.map(request=>JSON.parse(request.sections.at(-1)!.content).queryDigest);assert.notEqual(queries[0],queries[1]);
});
test('bounded batches inspect a later relevant source and reasoning reranks references across batches',async t=>{
 const offered=new Set<string>();const f=setup(t,data=>{data.candidates.forEach(c=>offered.add(c.id));return response(data,data.candidates.filter(c=>c.id==='zz-relevant').map(c=>c.id));});
 for(let i=0;i<45;i++)f.save('record:'+String(i).padStart(2,'0'),'A fictional orchestra meets to rehearse.');f.save('zz-relevant','Participant advice: Put fine netting over the vegetable bed.');
 const result=await f.worker.recall(f.scope,'Protecting vegetable seedlings from pests?');assert.deepEqual(result.memories.map(record=>record.id),['zz-relevant']);assert.equal(offered.size,46);assert.equal(f.requests.length,3);assert.equal(JSON.parse(f.requests[2]!.sections.at(-1)!.content).stage,'rank');assert.equal('providerCalls' in result&&result.providerCalls,3);
});
test('closed references, digests, schema, output and completion bounds reject fabricated selections',async t=>{
 for(const change of ['foreign','revision','query','source','extra','duplicate','count','oversize','prose','incomplete'] as const)await t.test(change,async child=>{
  const f=setup(child,data=>{const raw=response(data,['owned']);if(change==='foreign')raw.items[0]!.id='foreign';if(change==='revision')raw.items[0]!.revision++;if(change==='query')raw.queryDigest='stale';if(change==='source')raw.sourceDigest='stale';if(change==='extra')Object.assign(raw,{tool:true});if(change==='duplicate')raw.items.push(raw.items[0]!);if(change==='count')raw.items.push({...raw.items[0]!,id:'owned2'});if(change==='oversize')raw.items[0]!.rationale='x'.repeat(5000);return change==='prose'?'I think the answer is owned.':raw;},{done:change!=='incomplete'});f.save('owned','Participant advice: keep the roots damp.');const before=f.memories.history(f.scope.assistantId,'owned');const result=await f.worker.recall(f.scope,'How to care for the planter?',1);assert.equal(result.state,'unavailable');assert.equal(result.memories.length,0);assert.equal(result.complete,false);assert.deepEqual(f.memories.history(f.scope.assistantId,'owned'),before);
 });
});
test('scope, consent, idle lease and source inventory bounds exclude inputs before inference',async t=>{
 const f=setup(t,data=>response(data,[]));f.save('owned','Participant advice: use netting.');f.save('foreign','Foreign statement.',{...f.scope,principalId:'foreign'});f.save('foreign-relationship','Different relationship.',{...f.scope,relationshipId:'foreign'});
 await f.worker.recall(f.scope,'Protect seedlings?');assert.deepEqual(JSON.parse(f.requests[0]!.sections.at(-1)!.content).candidates.map((r:any)=>r.id),['owned']);
 f.worker.configure(f.scope,false,1);assert.equal((await f.worker.recall(f.scope,'Protect seedlings?')).state,'unavailable');assert.equal(f.requests.length,1);assert.ok(f.memories.listForOwnerAdministration(f.scope.assistantId,f.scope.principalId,f.scope.relationshipId).length);
 const busy=setup(t,data=>response(data,[]),{idle:()=>false});busy.save('owned','Retained source.');assert.equal((await busy.worker.recall(busy.scope,'Read source?')).state,'unavailable');assert.equal(busy.requests.length,0);
 const many=setup(t,data=>response(data,[]));for(let i=0;i<241;i++)many.save('owned:'+i,'Synthetic bounded inventory.');assert.equal((await many.worker.recall(many.scope,'Search?')).state,'unavailable');assert.equal(many.requests.length,0);
 const bytes=setup(t,data=>response(data,[]));for(let i=0;i<32;i++)bytes.save('owned:'+i,'x'.repeat(20000));assert.equal((await bytes.worker.recall(bytes.scope,'Search?')).state,'unavailable');assert.equal(bytes.requests.length,0);
});
test('source mutation, correction, withdrawal and provider revision changes fence late selected output',async t=>{
 for(const change of ['forget','correction','policy','provider','authorization'] as const)await t.test(change,async child=>{
  let providerRevision='fixture:1',authorized=true;const f=setup(child,data=>{const raw=response(data,['owned']);if(change==='forget')f.memories.forget(f.scope.assistantId,'owned',f.scope.principalId);if(change==='correction'){const old=f.memories.get(f.scope.assistantId,'owned')!,event=f.memories.proposeCorrection(f.scope.assistantId,'owned','New reviewed content.',f.scope.principalId)!;f.memories.applyCorrection(f.scope.assistantId,'owned',event.revision,Number(old.lifecycle.revision),f.scope.principalId);}if(change==='policy')f.worker.configure(f.scope,false,1);if(change==='provider')providerRevision='fixture:2';if(change==='authorization')authorized=false;return raw;},{revision:()=>providerRevision});f.save('owned','Old retained participant advice.');const result=await f.worker.recall(f.scope,'Relevant advice?',20,{current:()=>authorized});assert.equal(result.state,'unavailable');assert.equal(result.memories.length,0);assert.equal(result.complete,false);
 });
});
test('foreground preemption and disconnect terminate selection despite an ignoring provider and release the shared lease',async t=>{
 for(const stop of ['foreground','disconnect','close'] as const)await t.test(stop,async child=>{
  let started!:()=>void,release!:()=>void;const began=new Promise<void>(r=>started=r),held=new Promise<void>(r=>release=r),f=setup(child,async data=>{started();await held;return response(data,['owned']);});f.save('owned','Retained participant guidance.');const controller=new AbortController(),pending=f.worker.recall(f.scope,'Find guidance?',20,{signal:controller.signal});await began;
  const competing=await f.worker.recall(f.scope,'Another query?');assert.equal(competing.state,'unavailable');assert.equal(f.requests.length,1);
  if(stop==='foreground')f.worker.preempt();else if(stop==='disconnect')controller.abort();else await f.worker.close();assert.equal((await pending).state,'unavailable');assert.equal(f.worker.isIdle(),true);release();await new Promise<void>(r=>setImmediate(r));assert.equal(f.memories.get(f.scope.assistantId,'owned')!.lifecycle.lastReinforcedAt,null);
 });
});
test('the optional semantic deadline releases a hung provider without producing recall',async t=>{
 let started!:()=>void,release!:()=>void;const began=new Promise<void>(r=>started=r),held=new Promise<void>(r=>release=r),f=setup(t,async data=>{started();await held;return response(data,['owned']);});f.save('owned','Retained guidance.');t.mock.timers.enable({apis:['setTimeout']});const pending=f.worker.recall(f.scope,'Find guidance?');await began;t.mock.timers.tick(60000);assert.equal((await pending).state,'unavailable');assert.equal(f.worker.isIdle(),true);release();
});
test('semantic selection uses the existing canonical SGLang adapter with a synthetic loopback response',async t=>{
 const {createServer}=await import('node:http'),{SglangInferenceProvider}=await import('../../../packages/providers-sglang/src/provider.ts');let observed=false;
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const messages=JSON.parse(body).messages,data=JSON.parse(messages.find((m:any)=>m.role==='user').content.split('[userInput; untrusted]\n')[1]);observed=data.task==='semantic-memory-recall-v1';res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(response(data,['owned']))}}]})}\n\ndata: [DONE]\n\n`);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const f=setup(t,data=>response(data,[])),address=server.address();assert.ok(address&&typeof address!=='string');const provider=new SglangInferenceProvider({endpoint:'http://127.0.0.1:'+address.port,model:'synthetic-semantic-model'});await f.worker.close();const worker=new AutomaticMemory({database:f.db,memories:f.memories,provider:()=>({provider,revision:'synthetic-loopback'}),idle:()=>true,changed:()=>{}});t.after(()=>worker.close());f.save('owned','Participant guidance: use fine netting over a vegetable bed.');const result=await worker.recall(f.scope,'What blocks insects from young plants?');assert.equal(result.state,'selected');assert.deepEqual(result.memories.map(r=>r.id),['owned']);assert.equal(observed,true);
});


test('privacy callbacks cannot transmit or select a source revoked during projection',async t=>{
 let invalidated=false;const f=setup(t,data=>response(data,['owned']),{contentAllowed:(_scope,text)=>{if(!invalidated&&text.includes('"id":"owned"')){invalidated=true;f.memories.forget(f.scope.assistantId,'owned',f.scope.principalId);}return true;}});f.save('owned','Retained participant guidance.');const result=await f.worker.recall(f.scope,'Find guidance?');assert.equal(result.memories.length,0);assert.equal(f.requests.length,0);assert.equal(f.memories.get(f.scope.assistantId,'owned')!.content,'');
});
test('legacy literal search returns no unrelated reserve and owner inspection remains a distinct operation',async t=>{
 const f=setup(t,data=>response(data,[]));f.save('owned','Retained ensemble rehearsal schedule.');assert.equal(f.memories.search(f.scope.assistantId,'Tectonic plate motion?').length,0);assert.equal(f.memories.search(f.scope.assistantId,'ensemble').length,1);f.worker.configure(f.scope,false,1);assert.equal((await f.worker.recall(f.scope,'ensemble')).state,'unavailable');assert.equal(f.requests.length,0);assert.equal(f.memories.listForOwnerAdministration(f.scope.assistantId,f.scope.principalId,f.scope.relationshipId).length,1);
});
