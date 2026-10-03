import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {Database,MemoryRepository} from '@lifestream/storage-sqlite';
import {compileRelationshipContext,relationshipControlDefaults,type SemanticContextReference} from '@lifestream/runtime/context';
import type {InferenceRequest,InferenceProvider} from '@lifestream/runtime/inference';
import {AutomaticMemory} from '../src/runtime/automatic-memory.ts';
import {attachConversationMemoryRecall,captureConversationMemoryRecall,type ConversationMemoryRecallOptions} from '../src/runtime/conversation-memory-context.ts';
import {streamMessage,type HostRuntimeInput} from '../src/runtime/inference.ts';

const query='Which gear deters insects around seedlings?';
const advice='Participant advice: Put fine netting over the vegetable bed. Applicability unverified.';
const idle:ConversationMemoryRecallOptions={mode:'idle',waitBudgetMs:0,fallback:'ordinary-context',warmOnMiss:true};
const bounded:ConversationMemoryRecallOptions={mode:'bounded',waitBudgetMs:200,fallback:'ordinary-context',warmOnMiss:false};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function setup(t:any){
 const db=new Database({path:':memory:'});db.migrate();const memories=new MemoryRepository(db),scope={assistantId:randomUUID(),principalId:randomUUID(),relationshipId:randomUUID()};
 let authorized=true,revision='synthetic-provider:1',judge=async(data:any)=>data.query===query?['guidance']:[] as string[],primaryHook=async()=>{};
 const selections:InferenceRequest[]=[],primary:InferenceRequest[]=[];
 const provider:InferenceProvider={async *generate(request){
  if(request.scope.sessionId==='automatic-memory-recall'){selections.push(request);const data=JSON.parse(request.sections.at(-1)!.content),ids=await judge(data);yield {kind:'text',text:JSON.stringify({version:1,queryDigest:data.queryDigest,sourceDigest:data.sourceDigest,items:ids.map(id=>({id,revision:data.candidates.find((c:any)=>c.id===id)?.revision??1,rationale:'Retained participant advice addresses the requested situation; applicability unverified.'}))})};yield {kind:'done'};return;}
  primary.push(request);await primaryHook();const content=request.sections.find(s=>s.kind==='preparedMemory')!.content;
  yield {kind:'text',text:content.includes('Put fine netting')?'You previously offered advice about fine netting; its applicability remains unverified.':'No selected participant guidance is available.'};yield {kind:'done'};
 }};
 const worker=new AutomaticMemory({database:db,memories,provider:()=>({revision,provider}),idle:()=>true,scopeAllowed:()=>authorized,changed:()=>{}});worker.configure(scope,true,0);
 t.after(async()=>{await worker.close();db.close();});
 for(const [id,content] of [['guidance',advice],['literal','Quoted typing exercise: '+query]]){memories.save({id,assistantId:scope.assistantId,content,provenance:{actor:scope.principalId,relationshipId:scope.relationshipId,sourceFamily:'synthetic:'+id},lifecycle:{status:'candidate',revision:1,kind:'proceduralHint',factuality:'unverified',lastReinforcedAt:null},createdAt:new Date().toISOString()});memories.transition(scope.assistantId,id,'active',scope.principalId);}
 const boundary=()=>createHash('sha256').update(JSON.stringify([worker.policy(scope),memories.contextBoundaryRows(scope.assistantId,scope.principalId)])).digest('hex');
 const host=(options?:ConversationMemoryRecallOptions,text=query,controls:Readonly<Record<string,number>>=relationshipControlDefaults)=>{
  const pin=boundary(),compile=(semanticReferences?:readonly SemanticContextReference[])=>compileRelationshipContext({records:memories.contextRecords(scope.assistantId,scope.principalId,scope.relationshipId).map(m=>({id:m.id,content:m.content,revision:Number(m.lifecycle.revision),sourceFamily:String(m.provenance.sourceFamily),status:'approved',use:m.provenance.correctionOf?'correction' as const:'relevant' as const,personalization:true,mention:true,memoryRecord:true})),userInput:text,audienceScope:'authenticatedSession',profileRevision:'synthetic-profile:1',relationshipRevision:scope.relationshipId+':1',configurationRevision:'synthetic-config:1',controls,...(semanticReferences===undefined?{}:{semanticReferences})});
  const input:HostRuntimeInput={assistantId:scope.assistantId,preparedRelationshipContext:compile(),runtimeSelfContext:{sourceRevision:'synthetic-runtime:1',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'none',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',limitations:['Synthetic text fixture only.']},isCurrent:()=>authorized&&boundary()===pin,inspection:{fullPromptPreview:true}};
  if(options)attachConversationMemoryRecall(input,{worker,scope,query:text,options,compile:refs=>compile(refs)});return input;
 };
 const turn=async(input:HostRuntimeInput,text=query,signal?:AbortSignal)=>{
  const server=createServer((_req,res)=>{const disconnected=new AbortController();res.once('close',()=>{if(!res.writableEnded)disconnected.abort();});void streamMessage(res,provider,{assistantId:scope.assistantId,userInput:text},'synthetic-session',disconnected.signal,undefined,input.runtimeSelfContext,input);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const started=performance.now();
  try{const response=await fetch('http://127.0.0.1:'+((server.address() as any).port),{signal}),output=await response.text();return {status:response.status,output,elapsedMs:performance.now()-started};}
  finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 };
 return {db,memories,scope,worker,host,turn,selections,primary,setJudge:(fn:typeof judge)=>judge=fn,setPrimary:(fn:typeof primaryHook)=>primaryHook=fn,revoke:()=>worker.configure(scope,false,1),setAuthorized:(v:boolean)=>authorized=v,setProvider:(v:string)=>revision=v};
}

test('the ordinary finalized conversation receives attributed semantic guidance and omits a literal distractor',async t=>{
 const f=setup(t),before=f.memories.history(f.scope.assistantId,'guidance'),h=f.host(bounded),reply=await f.turn(h);
 assert.equal(reply.status,200);assert.match(reply.output,/message.delta/);assert.match(reply.output,/previously offered advice about fine netting.*unverified/);assert.match(reply.output,/interaction.completed/);assert.equal(f.selections.length,1);assert.equal(f.primary.length,1);
 const section=f.primary[0]!.sections.find(s=>s.kind==='preparedMemory')!;assert.match(section.content,/Participant advice.*Applicability unverified/);assert.doesNotMatch(section.content,/Quoted typing/);assert.ok(h.preparedRelationshipContext!.relevantContext.some(r=>r.id==='guidance'));assert.equal(h.memoryRecall!.coverage,'fresh');assert.deepEqual(f.memories.history(f.scope.assistantId,'guidance'),before);
});
test('idle consumption distinguishes a first new query miss from a completed warm exact-query result',async t=>{
 const f=setup(t),cold=f.host(idle);assert.match((await f.turn(cold)).output,/No selected participant guidance/);assert.equal(cold.memoryRecall!.coverage,'miss');assert.equal(f.selections.length,0);
 await f.worker.tick();assert.equal(f.selections.length,1);const warm=f.host(idle);assert.match((await f.turn(warm)).output,/previously offered advice about fine netting/);assert.equal(warm.memoryRecall!.coverage,'idleWarm');assert.equal(f.selections.length,1,'warm ordinary turn adds no selector call');
 const other=f.host({...idle,warmOnMiss:false},'How do volcanoes form?');await f.turn(other,'How do volcanoes form?');assert.equal(other.memoryRecall!.coverage,'miss');assert.equal(f.selections.length,1,'unseen query is not falsely covered by a different cached query');
});
test('default turns and disabled or nondefault context controls never add a selector call',async t=>{
 const f=setup(t),normal=f.host();await f.turn(normal);assert.equal(normal.prepareMemory,undefined);assert.equal(normal.memoryRecall,undefined);assert.equal(f.selections.length,0);
 for(const controls of [{...relationshipControlDefaults,callbackFrequency:0},{...relationshipControlDefaults,personalizationIntensity:0},{...relationshipControlDefaults,relevanceThreshold:1},{...relationshipControlDefaults,relevanceThreshold:.9}]){const h=f.host(bounded,query,controls);await f.turn(h);assert.equal(h.memoryRecall,undefined);}
 await f.worker.tick();assert.equal(f.selections.length,0);
});
test('successful semantic zero omits unrelated retained words without fabricating successful recall',async t=>{
 const f=setup(t);f.setJudge(async()=>[]);const h=f.host(bounded);const r=await f.turn(h);assert.match(r.output,/No selected participant guidance/);assert.equal(h.memoryRecall!.state,'empty');assert.equal(h.preparedRelationshipContext!.relevantContext.length,0);assert.equal(f.primary.length,1);assert.doesNotMatch(f.primary[0]!.sections.find(s=>s.kind==='preparedMemory')!.content,/Quoted typing/);
});
test('the explicit wait budget releases an ignoring selector and ordinary fallback cannot consume late output',async t=>{
 const f=setup(t),began=deferred(),release=deferred();f.setJudge(async()=>{began.resolve();await release.promise;return ['guidance'];});const h=f.host({...bounded,waitBudgetMs:20});const pending=f.turn(h);await began.promise;const reply=await pending;assert.match(reply.output,/No selected participant guidance/);assert.equal(h.memoryRecall!.state,'fallback');assert.equal(h.memoryRecall!.reason,'preparation_budget');assert.equal(f.worker.isIdle(),true);release.resolve();await new Promise<void>(r=>setImmediate(r));assert.equal((await f.worker.conversationRecall(f.scope,query,0,{current:()=>true})).coverage,'miss');
});
test('disconnect while optional preparation waits prevents provider admission despite late selector output',async t=>{
 const f=setup(t),began=deferred(),release=deferred();f.setJudge(async()=>{began.resolve();await release.promise;return ['guidance'];});const abort=new AbortController(),pending=f.turn(f.host({...bounded,waitBudgetMs:500}),query,abort.signal);await began.promise;abort.abort();await assert.rejects(pending);for(let n=0;n<30&&!f.worker.isIdle();n++)await new Promise(r=>setTimeout(r,5));assert.equal(f.worker.isIdle(),true);assert.equal(f.primary.length,0);release.resolve();
});
test('withdrawal during semantic preparation prevents an ordinary stale reply',async t=>{
 const f=setup(t),began=deferred(),release=deferred();f.setJudge(async()=>{began.resolve();await release.promise;return ['guidance'];});const pending=f.turn(f.host({...bounded,waitBudgetMs:500}));await began.promise;f.revoke();release.resolve();const reply=await pending;assert.equal(reply.status,409);assert.equal(f.primary.length,0);assert.doesNotMatch(reply.output,/fine netting/);
});
test('forget, correction, consent, provider and authorization changes fence late conversational output',async t=>{
 for(const cause of ['forget','correction','consent','provider','authorization'] as const)await t.test(cause,async child=>{
  const f=setup(child),began=deferred(),release=deferred();f.setPrimary(async()=>{began.resolve();await release.promise;});const h=f.host({...bounded,waitBudgetMs:500}),pending=f.turn(h);await began.promise;
  if(cause==='forget')f.memories.forget(f.scope.assistantId,'guidance',f.scope.principalId);if(cause==='correction'){const proposal=f.memories.proposeCorrection(f.scope.assistantId,'guidance','Participant correction: Old guidance withdrawn.',f.scope.principalId)!;f.memories.applyCorrection(f.scope.assistantId,'guidance',proposal.revision,2,f.scope.principalId);}if(cause==='consent')f.revoke();if(cause==='provider')f.setProvider('synthetic-provider:2');if(cause==='authorization')f.setAuthorized(false);
  release.resolve();const reply=await pending;assert.match(reply.output,/runtime_input_stale/);assert.doesNotMatch(reply.output,/message.delta|previously offered advice|interaction.completed/);
 });
});
test('idle work coalesces queries and cannot reuse warm results after source or provider mutation',async t=>{
 const f=setup(t);f.setJudge(async()=>['guidance']);assert.equal(f.worker.precomputeRecall(f.scope,'old query'),true);assert.equal(f.worker.precomputeRecall(f.scope,query),true);await f.worker.tick();assert.equal(f.selections.length,1);assert.equal(JSON.parse(f.selections[0]!.sections.at(-1)!.content).query,query);
 assert.equal((await f.worker.conversationRecall(f.scope,query,0,{current:()=>true})).coverage,'idleWarm');f.setProvider('synthetic-provider:2');assert.equal((await f.worker.conversationRecall(f.scope,query,0,{current:()=>true})).coverage,'miss');assert.equal(f.selections.length,1);
});
test('experimental configuration is captured, bounded and cannot invent a fallback or an idle wait',()=>{
 for(const value of [{...idle,waitBudgetMs:1},{...bounded,waitBudgetMs:5001},{...bounded,waitBudgetMs:-1},{...bounded,fallback:'ignore-privacy'},{...bounded,extra:true}])assert.throws(()=>captureConversationMemoryRecall(value as any),/Invalid experimental/);
 const mutable={...bounded},captured=captureConversationMemoryRecall(mutable)!;mutable.waitBudgetMs=3000;assert.equal(captured.waitBudgetMs,200);assert.equal(Object.isFrozen(captured),true);assert.equal(captureConversationMemoryRecall(undefined),undefined);
});
test('synthetic preparation overhead separates default, cold idle, warm idle, fresh selection and budget fallback',async t=>{
 const f=setup(t),samples:Record<string,{preparationMs:number;loopbackResponseMs:number;coverage:string}[]>={};
 const measure=async(name:string,options?:ConversationMemoryRecallOptions)=>{const h=f.host(options),r=await f.turn(h);(samples[name]??=[]).push({preparationMs:h.memoryRecall?.preparationMs??0,loopbackResponseMs:r.elapsedMs,coverage:h.memoryRecall?.coverage??'default'});};
 for(let i=0;i<10;i++)await measure('default');for(let i=0;i<10;i++)await measure('idleCold',{...idle,warmOnMiss:false});f.worker.precomputeRecall(f.scope,query);await f.worker.tick();for(let i=0;i<10;i++)await measure('idleWarm',idle);
 f.setProvider('synthetic-provider:measured');for(let i=0;i<10;i++)await measure('boundedFast',bounded);
 f.setJudge(async()=>{await new Promise(r=>setTimeout(r,10));return ['guidance'];});for(let i=0;i<10;i++)await measure('boundedSynthetic10ms',bounded);
 const held=deferred();f.setJudge(async()=>{await held.promise;return ['guidance'];});for(let i=0;i<10;i++)await measure('boundedBudget10ms',{...bounded,waitBudgetMs:10});held.resolve();
 const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]!;
 const summary=Object.fromEntries(Object.entries(samples).map(([name,rows])=>[name,{samples:rows.length,preparationMedianMs:percentile(rows.map(r=>r.preparationMs),.5),preparationP95Ms:percentile(rows.map(r=>r.preparationMs),.95),loopbackResponseMedianMs:percentile(rows.map(r=>r.loopbackResponseMs),.5),loopbackResponseP95Ms:percentile(rows.map(r=>r.loopbackResponseMs),.95),coverage:[...new Set(rows.map(r=>r.coverage))]}]));
 assert.deepEqual(summary.idleCold.coverage,['miss']);assert.deepEqual(summary.idleWarm.coverage,['idleWarm']);assert.deepEqual(summary.boundedBudget10ms.coverage,['miss']);console.log('SYNTHETIC_RECALL_OVERHEAD '+JSON.stringify({qualification:'Scripted provider and local loopback fixture only; no selected-model latency, onset, audio or resource claim. Loopback includes HTTP setup and completion.',summary}));
});
