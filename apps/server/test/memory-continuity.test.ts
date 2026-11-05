import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {Database,MemoryRepository,type MemoryRecord} from '@lifestream/storage-sqlite';
import {compileRelationshipContext,type RelationshipContextRecord} from '@lifestream/runtime/context';
import type {InferenceRequest} from '@lifestream/runtime/inference';
import {AutomaticMemory,type MemoryActorAttribution,type SemanticMemoryCandidate} from '../src/runtime/automatic-memory.ts';
import {selectSemanticMemory} from '../src/runtime/semantic-memory-recall.ts';
import {selectedMemorySources} from '../src/runtime/memory-source-selection.ts';
import {attachConversationMemoryRecall,captureConversationMemoryRecall} from '../src/runtime/conversation-memory-context.ts';
import {prepareHostMemory,type HostRuntimeInput} from '../src/runtime/inference.ts';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote='Check soil moisture before watering a plant.';
const advice:SemanticMemoryCandidate={key:'gardening.water',kind:'proceduralHint',quote,meaning:'Check moisture before watering; applicability depends on the plant.',stance:'advice',uncertainty:['Plant needs vary.'],relevance:'Useful conditional guidance',dependencies:[]};
function fixture(t:TestContext){
 const db=new Database({path:':memory:'});db.migrate();const memories=new MemoryRepository(db),scope={principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID()};let calls=0,actorCurrent=true;
 const proof:MemoryActorAttribution={actorId:randomUUID(),effectiveUserId:scope.principalId,sessionId:randomUUID(),contextRef:randomUUID(),generation:1,authorityRevision:1};
 const make=()=>new AutomaticMemory({database:db,memories,actorCurrent:actor=>actorCurrent&&JSON.stringify(actor)===JSON.stringify(proof),provider:()=>({revision:'synthetic-current',provider:{async *generate(){calls++;throw Error('Prepared continuation must not call inference');}}}),idle:()=>true,changed:()=>{}});
 let worker=make();t.after(async()=>{await worker.close();db.close();});
 return {db,memories,scope,proof,calls:()=>calls,get worker(){return worker;},revokeActor(){actorCurrent=false;},async restart(){await worker.close();worker=make();},prepare(item=advice,actor?:MemoryActorAttribution){worker.configure(scope,true,0);assert.equal(worker.enqueue(scope,'prepared-v2',item.quote,actor?'administrativeTypedActor':'authenticatedTypedOwner',actor).state,'queued');const row=db.connection.prepare('SELECT id,scope_key AS scope,policy_revision AS revision FROM automatic_memory_work').get()!;const prepared={version:2,items:[item],returnedItemCount:1,rejectedItemCount:0,providerRevision:'historical-v2-selected-provider',sourceDigest:hash(item.quote),scopeDigest:row.scope,policyRevision:row.revision,dependencies:[] as {id:string;revision:number;contentDigest:string}[]};this.write(prepared);return prepared;},write(prepared:unknown){db.connection.prepare("UPDATE automatic_memory_work SET state='prepared',prepared_json=?").run(JSON.stringify(prepared));}};
}
test('installed v2 pending advice survives restart with its exact evidence, qualifications and no new inference',async t=>{
 const f=fixture(t);f.prepare();await f.restart();await f.worker.tick();const [record]=f.memories.contextRecords(f.scope.assistantId,f.scope.principalId);assert.ok(record);
 assert.equal(record.provenance.transformation,'qualified-semantic-proposal-v2');assert.equal(record.provenance.epistemicStatus,'advice');assert.equal(record.provenance.evidenceQuote,quote);assert.equal(record.provenance.proposedMeaning,advice.meaning);assert.deepEqual(record.provenance.uncertainty,advice.uncertainty);assert.equal(record.provenance.extractorRevision,'historical-v2-selected-provider');assert.equal(record.lifecycle.confidence,null);assert.match(record.content,/User advice \(unverified interpretation\)/);assert.doesNotMatch(record.content,/User stated:/);assert.equal(f.calls(),0);
 const row=f.db.connection.prepare('SELECT state,input_text AS input,prepared_json AS prepared FROM automatic_memory_work').get()!;assert.equal(row.state,'saved');assert.equal(row.input,'');assert.equal(row.prepared,null);await f.worker.tick();assert.equal(f.memories.list(f.scope.assistantId).length,1);
});
test('malformed version, source, scope, counts and unsupported dependency preparations never become owner statements',async t=>{
 for(const fault of ['version','source','scope','counts','unknownDependency','foreignDependency','changedDependency'] as const)await t.test(fault,async child=>{
  const f=fixture(child),prepared=f.prepare();
  if(fault==='version')prepared.version=3;
  if(fault==='source')prepared.sourceDigest='0'.repeat(64);
  if(fault==='scope')prepared.scopeDigest='0'.repeat(64);
  if(fault==='counts')prepared.returnedItemCount=2;
  if(fault==='unknownDependency')prepared.items[0]={...advice,dependencies:[randomUUID()]};
  if(fault==='foreignDependency'||fault==='changedDependency'){
   const dependency:MemoryRecord={id:randomUUID(),assistantId:f.scope.assistantId,content:'A separately retained source',provenance:{actor:fault==='foreignDependency'?randomUUID():f.scope.principalId,relationshipId:f.scope.relationshipId},lifecycle:{status:'active',revision:1},createdAt:new Date().toISOString()};f.memories.save(dependency);
   prepared.items[0]={...advice,dependencies:[dependency.id]};prepared.dependencies=[{id:dependency.id,revision:fault==='changedDependency'?2:1,contentDigest:hash(dependency.content)}];
  }
  f.write(prepared);await f.restart();await f.worker.tick();assert.equal(f.calls(),0);assert.ok(!f.memories.list(f.scope.assistantId).some(r=>r.provenance.transformation==='qualified-semantic-proposal-v2'));assert.notEqual(f.db.connection.prepare('SELECT state FROM automatic_memory_work').get()!.state,'saved');
 });
});
test('pending administrative v2 continuation retains its real actor and refuses a revoked actor after restart',async t=>{
 for(const revoke of [false,true])await t.test(revoke?'revoked':'current',async child=>{
  const f=fixture(child);f.prepare(advice,f.proof);if(revoke)f.revokeActor();await f.restart();await f.worker.tick();const records=f.memories.contextRecords(f.scope.assistantId,f.scope.principalId);assert.equal(f.calls(),0);
  if(revoke){assert.equal(records.length,0);return;}
  assert.equal(records.length,1);assert.equal(records[0]!.provenance.actorId,f.proof.actorId);assert.equal(records[0]!.provenance.effectiveUserId,f.scope.principalId);assert.equal(records[0]!.provenance.administrativeOrigin,true);assert.match(records[0]!.content,new RegExp('Administrator '+f.proof.actorId+' for this account advice'));assert.doesNotMatch(records[0]!.content,/User stated:/);
 });
});
function retained(id:string,content:string):MemoryRecord{return {id,assistantId:'synthetic-assistant',content,provenance:{actor:'synthetic-owner',relationshipId:'synthetic-relationship',epistemicStatus:'advice'},lifecycle:{revision:1,status:'active',kind:'proceduralHint',factuality:'unverified'},createdAt:new Date().toISOString()};}
const scope={assistantId:'synthetic-assistant',principalId:'synthetic-owner',relationshipId:'synthetic-relationship'};
function selection(request:InferenceRequest,id:string){const payload=JSON.parse(request.sections.find(s=>s.kind==='userInput')!.content);return JSON.stringify({version:1,queryDigest:payload.queryDigest,sourceDigest:payload.sourceDigest,items:[{id,revision:1,rationale:'Conditional guidance is relevant to this current task.'}]});}
test('semantic selector follows only validated provider references rather than literal query overlap',async()=>{
 const relevant=retained('meaning-match','When the substrate is still damp, postpone adding more liquid.'),distractor=retained('literal-match','An unrelated puzzle repeats the words water and plant.');const records=[distractor,relevant];let calls=0;
 const result=await selectSemanticMemory({scope,query:'Should I water the plant now?',limit:20,deadlineAt:new Date(Date.now()+1000).toISOString(),read:()=>records,current:()=>true,generate:async request=>{calls++;assert.equal(request.responseFormat?.type,'json_schema');assert.match(request.sections[0]!.content,/not literal word overlap/);return selection(request,relevant.id);}});
 assert.equal(calls,1);assert.deepEqual(result.memories.map(r=>r.id),[relevant.id]);assert.deepEqual(result.selection.map(r=>r.id),[relevant.id]);assert.equal(result.candidateCount,2);assert.equal(relevant.lifecycle.factuality,'unverified');
});
test('semantic selector rejects foreign references, missing digests, late source changes and overlong output',async t=>{
 for(const fault of ['foreignId','digest','source','scope','outputBound'] as const)await t.test(fault,async()=>{
  let current=true;const records=[retained('retained','Useful conditional source')];
  await assert.rejects(selectSemanticMemory({scope,query:'A current query',limit:20,deadlineAt:new Date(Date.now()+1000).toISOString(),read:()=>records,current:()=>current,generate:async request=>{const raw=JSON.parse(selection(request,records[0]!.id));if(fault==='foreignId')raw.items[0].id='foreign';if(fault==='digest')raw.sourceDigest='wrong';if(fault==='source')records[0]!.content='Changed retained source';if(fault==='scope')current=false;return fault==='outputBound'?' '.repeat(4097):JSON.stringify(raw);}}));
 });
});
test('memory reference projection keeps baseline and corrections while refusing unowned, duplicate or stale references',()=>{
 const base:RelationshipContextRecord={id:'baseline',content:'Approved convention',revision:1,sourceFamily:'approved',status:'approved',use:'baseline',personalization:true,mention:true};const memory={...base,id:'retained',memoryRecord:true,use:'relevant' as const};
 assert.deepEqual(selectedMemorySources([base,memory],[]),[base]);assert.deepEqual(selectedMemorySources([base,memory],[{id:'retained',revision:1}]),[base,memory]);
 for(const refs of [[{id:'foreign',revision:1}],[{id:'retained',revision:2}],[{id:'retained',revision:1},{id:'retained',revision:1}]])assert.throws(()=>selectedMemorySources([base,memory],refs));
});
function host():HostRuntimeInput{return {assistantId:'synthetic-assistant',runtimeSelfContext:{audienceScope:'authenticatedSession'} as HostRuntimeInput['runtimeSelfContext'],preparedRelationshipContext:compileRelationshipContext({records:[],userInput:'query',audienceScope:'authenticatedSession',profileRevision:'profile:1',relationshipRevision:'relationship:1',configurationRevision:'default:1'}),isCurrent:()=>true};}
const idle={mode:'idle' as const,waitBudgetMs:0,fallback:'ordinary-context' as const,warmOnMiss:true};
test('idle recall misses add zero synchronous provider calls and warm only after a current completed reply',async()=>{
 const h=host();let calls=0,warm=0,completion=0,current=true;h.isCurrent=()=>current;h.onCompleted=()=>{completion++;};
 attachConversationMemoryRecall(h,{scope,query:'current question',options:idle,compile:()=>undefined,worker:{async conversationRecall(_scope,_query,budget){calls++;assert.equal(budget,0);return {state:'fallback',coverage:'miss',reason:'no_completed_idle_result'};},precomputeRecall(){warm++;return true;}}});
 await prepareHostMemory(h,new AbortController().signal);assert.equal(calls,1);assert.equal(h.memoryRecall?.providerCalls,0);assert.equal(warm,0);h.onCompleted?.('completed');assert.equal(warm,1);assert.equal(completion,1);current=false;h.onCompleted?.('stale');assert.equal(warm,1);
});
test('fresh warm recall uses exact source references and currentness fences before prompt preparation',async()=>{
 const h=host(),context=h.preparedRelationshipContext!;let current=true;const references=[{id:'retained',revision:1}];let compiled=0;
 attachConversationMemoryRecall(h,{scope,query:'question',options:idle,worker:{async conversationRecall(){return {state:'selected',coverage:'idleWarm',reason:'completed_idle_result',lease:{references,freshUntil:new Date(Date.now()+1000).toISOString(),providerCalls:1,isCurrent:()=>current}};},precomputeRecall(){throw Error('Warm selected result must not enqueue again');}},compile:refs=>{compiled++;assert.deepEqual(refs,references);return structuredClone(context);}});
 await prepareHostMemory(h,new AbortController().signal);assert.equal(compiled,1);assert.equal(h.memoryRecall?.selectedReferences,1);assert.equal(h.isCurrent(),true);current=false;assert.equal(h.isCurrent(),false);
});
test('private/zero-control restrictions and cancellation cannot trigger recall or warming',async()=>{
 for(const mode of ['unknownAudience','noPersonalization','noCallbacks','cancelled','stale'] as const){
  const h=host();let calls=0;if(mode==='unknownAudience')h.runtimeSelfContext.audienceScope='unknown';if(mode==='noPersonalization')h.preparedRelationshipContext!.configurationControls={personalizationIntensity:0};if(mode==='noCallbacks')h.preparedRelationshipContext!.configurationControls={callbackFrequency:0};if(mode==='stale')h.isCurrent=()=>false;
  attachConversationMemoryRecall(h,{scope,query:'question',options:idle,compile:()=>undefined,worker:{async conversationRecall(){calls++;throw Error('Must not recall');},precomputeRecall(){throw Error('Must not warm');}}});
  const signal=new AbortController();if(mode==='cancelled')signal.abort();if(mode==='cancelled'||mode==='stale')await assert.rejects(prepareHostMemory(h,signal.signal));else await prepareHostMemory(h,signal.signal);assert.equal(calls,0);
 }
 for(const options of [{...idle,waitBudgetMs:1},{...idle,warmOnMiss:'true'},{...idle,extra:true},{...idle,mode:'bounded',waitBudgetMs:5001}])assert.throws(()=>captureConversationMemoryRecall(options as never));
});

test('actual stream prepares selected memory before provider admission and retains the later reply metadata hook',async()=>{
 const {streamMessage}=await import('../src/runtime/inference.ts');
 const h=host(),assistantId=randomUUID(),sessionId=randomUUID(),record:RelationshipContextRecord={id:'selected-memory',content:'Conditional plant guidance: check plant soil before watering.',revision:1,sourceFamily:'retained-synthetic',status:'approved',use:'relevant',personalization:true,mention:true,memoryRecord:true};
 h.assistantId=assistantId;h.runtimeSelfContext={sourceRevision:'synthetic-runtime:1',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',limitations:['Synthetic stream only.']};
 let closed=false,metadata=0,seen:InferenceRequest|undefined;
 h.onReplyCompleted=async()=>{metadata++;assert.equal(closed,true);};
 attachConversationMemoryRecall(h,{scope:{...scope,assistantId},query:'plant watering guidance',options:idle,worker:{async conversationRecall(){return {state:'selected',coverage:'idleWarm',reason:'completed_idle_result',lease:{references:[{id:record.id,revision:1}],freshUntil:new Date(Date.now()+10000).toISOString(),providerCalls:1,isCurrent:()=>true}};},precomputeRecall(){throw Error('Selected idle result must not rewarm');}},compile:references=>compileRelationshipContext({records:selectedMemorySources([record],references),userInput:'plant watering guidance',audienceScope:'authenticatedSession',profileRevision:'profile:1',relationshipRevision:'relationship:1',configurationRevision:'default:1'})});
 let output='',status=0;const response={destroyed:false,writableEnded:false,writeHead(code:number){status=code;},write(value:string){output+=value;return true;},end(){this.writableEnded=true;}} as unknown as import('node:http').ServerResponse;
 await streamMessage(response,{async *generate(request){seen=request;try{yield {kind:'text' as const,text:'A synthetic reply.'};yield {kind:'done' as const};}finally{closed=true;}}},{assistantId,userInput:'plant watering guidance'},sessionId,new AbortController().signal,undefined,h.runtimeSelfContext,h);
 assert.equal(status,200);assert.match(output,/interaction.completed/);assert.doesNotMatch(output,/interaction.error/);assert.ok(seen);assert.match(seen.sections.find(s=>s.kind==='preparedMemory')!.content,/Conditional plant guidance/);assert.equal(metadata,1);assert.equal(h.memoryRecall?.selectedReferences,1);
});

test('actual idle worker recall reads only current owner relationship sources and retires a warm lease after forgetting',async t=>{
 const db=new Database({path:':memory:'});db.migrate();const memories=new MemoryRepository(db),owned={principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID()};
 const create=(relationshipId:string,content:string)=>{const record:MemoryRecord={id:randomUUID(),assistantId:owned.assistantId,content,provenance:{actor:owned.principalId,relationshipId},lifecycle:{status:'candidate',revision:1},createdAt:new Date().toISOString()};memories.save(record);return memories.transition(owned.assistantId,record.id,'active',owned.principalId,undefined,1)!;};
 const own=create(owned.relationshipId,'Conditional guidance about the current project.'),foreign=create(randomUUID(),'Foreign relationship retained source must not be sent to this recall task.');let calls=0;
 const worker=new AutomaticMemory({database:db,memories,provider:()=>({revision:'synthetic-selected',provider:{async *generate(request){calls++;const payload=JSON.parse(request.sections.find(s=>s.kind==='userInput')!.content);assert.deepEqual(payload.candidates.map((c:{id:string})=>c.id),[own.id]);assert.ok(!JSON.stringify(payload).includes(foreign.content));yield {kind:'text' as const,text:JSON.stringify({version:1,queryDigest:payload.queryDigest,sourceDigest:payload.sourceDigest,items:[{id:own.id,revision:own.lifecycle.revision,rationale:'Useful current task guidance.'}]})};yield {kind:'done' as const};}}}),idle:()=>true,changed:()=>{}});
 t.after(async()=>{await worker.close();db.close();});worker.configure(owned,true,0);
 const miss=await worker.conversationRecall(owned,'current project query',0,{current:()=>true});assert.equal(miss.state,'fallback');assert.equal(calls,0);
 assert.equal(worker.precomputeRecall(owned,'current project query',()=>true),true);await worker.tick();assert.equal(calls,1);
 const warm=await worker.conversationRecall(owned,'current project query',0,{current:()=>true});assert.equal(warm.state,'selected');assert.equal(warm.coverage,'idleWarm');assert.deepEqual(warm.lease!.references,[{id:own.id,revision:own.lifecycle.revision}]);assert.equal(warm.lease!.isCurrent(),true);assert.equal(calls,1);
 memories.forget(owned.assistantId,own.id,owned.principalId);assert.equal(warm.lease!.isCurrent(),false);const after=await worker.conversationRecall(owned,'current project query',0,{current:()=>true});assert.equal(after.state,'fallback');assert.equal(calls,1);
});
