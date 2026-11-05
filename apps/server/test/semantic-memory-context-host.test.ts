import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {registerHooks} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {FixtureInferenceProvider} from '@lifestream/runtime/inference/fixture';
import {selectedRelationshipSources,type CompiledRelationshipContext} from '@lifestream/runtime/context';
import type {MemoryRecord} from '@lifestream/storage-sqlite';
import type {AutomaticMemory,MemoryScope} from '../src/runtime/automatic-memory.ts';
import {attachConversationMemoryRecall} from '../src/runtime/conversation-memory-context.ts';
import {streamMessage,type HostRuntimeInput} from '../src/runtime/inference.ts';
import {loadProfile} from '../src/config/loader.ts';

// Main exclusively owns index.ts. Exercise its original preparation owner with
// exactly the separately delivered callsite hunk applied in memory, leaving
// this checkout's index.ts and all shared worktrees byte-for-byte unchanged.
const indexURL=new URL('../src/index.ts',import.meta.url).href;
const before='compileRelationshipContext({ records,userInput:options.userInput';
const after='compileRelationshipContext({ records,...(options.semanticReferences===undefined?{}:{semanticReferences:options.semanticReferences}),userInput:options.userInput';
let patches=0;
const hook=registerHooks({load(url,context,nextLoad){
 const loaded=nextLoad(url,context);
 if(url!==indexURL)return loaded;
 const source=typeof loaded.source==='string'?loaded.source:Buffer.from(loaded.source!).toString();
 const original=source.split(before).length-1,integrated=source.split(after).length-1;
 assert.equal(original+integrated,1,'exact original or integrated Main-owned callsite must exist once');patches++;
 // After composition, exercise the already-integrated production callsite unchanged.
 return integrated?loaded:{...loaded,source:source.replace(before,after)};
}});
const {createLifestreamServer}=await import('../src/index.ts');hook.deregister();assert.equal(patches,1);
const query='Should I water the plant now?',advice='Qualified advice: Allow damp substrate to dry before adding liquid.';
const idle={mode:'idle' as const,waitBudgetMs:0,fallback:'ordinary-context' as const,warmOnMiss:true};
async function fixture(t:TestContext){
 const root=await mkdtemp(join(tmpdir(),'semantic-context-host-')),config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'data.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomBytes(32).toString('hex'),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();
 t.after(async()=>{await app.shutdown();await rm(root,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin,'content-type':'application/json'};
 const setup=await fetch(origin+'/api/auth/v1/setup',{method:'POST',headers,body:JSON.stringify({username:'synthetic-owner',password:randomBytes(32).toString('hex'),installerToken}),signal:AbortSignal.timeout(5000)});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;const session=(await setup.json() as any).session;headers['x-lifestream-csrf']=session.csrfToken;
 const api=async(path:string,body:unknown)=>{const response=await fetch(origin+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(5000)}),value=await response.json() as Record<string,any>;assert.ok(response.ok,JSON.stringify(value));return value;};
 const assistant=await api('/api/admin/v1/assistants',{displayName:'Synthetic semantic preparation'}),path='/api/admin/v1/assistants/'+assistant.assistantId;await api(path+'/activate',{profileId:assistant.profile.profileId,expectedActiveRevision:null});
 const relationship=(await api(path+'/relationships',{})).relationship,scope:MemoryScope={assistantId:assistant.assistantId,principalId:session.principalId,relationshipId:relationship.relationshipId};
 const {automaticMemory:worker,memories,admin}=app as unknown as {automaticMemory:AutomaticMemory;memories:import('@lifestream/storage-sqlite').MemoryRepository;admin:{getPreparedRelationshipContext:(assistant:string,relationship:string,actor:string,options:{userInput:string;audienceScope:'authenticatedSession';semanticReferences?:readonly {id:string;revision:number}[]})=>CompiledRelationshipContext|undefined}};
 const retain=(content:string,owner=scope.principalId,relationshipId=scope.relationshipId)=>{const record:MemoryRecord={id:randomUUID(),assistantId:scope.assistantId,content,provenance:{actor:owner,relationshipId},lifecycle:{status:'candidate',revision:1},createdAt:new Date().toISOString()};memories.save(record);return memories.transition(scope.assistantId,record.id,'active',owner,undefined,1)!;};
 const selected=retain(advice),unselected=retain('Water plant is unrelated literal filler.'),foreign=retain('Other relationship source.',scope.principalId,randomUUID());retain('Other owner source.',randomUUID());
 worker.configure(scope,true,0);let selectionCalls=0;
 t.mock.method(FixtureInferenceProvider.prototype,'generate',async function*(request){
  selectionCalls++;const payload=JSON.parse(request.sections.find((section:{kind:string})=>section.kind==='userInput')!.content);
  assert.equal(payload.task,'semantic-memory-recall-v1');assert.deepEqual(payload.candidates.map((record:{id:string})=>record.id).sort(),[selected.id,unselected.id].sort());
  yield {kind:'text' as const,text:JSON.stringify({version:1,queryDigest:payload.queryDigest,sourceDigest:payload.sourceDigest,items:[{id:selected.id,revision:selected.lifecycle.revision,rationale:'Conditional guidance is useful for the current question.'}]})};yield {kind:'done' as const};
 });
 const compile=(semanticReferences?:readonly {id:string;revision:number}[])=>admin.getPreparedRelationshipContext(scope.assistantId,scope.relationshipId,scope.principalId,{userInput:query,audienceScope:'authenticatedSession',...(semanticReferences===undefined?{}:{semanticReferences})});
 assert.equal(worker.precomputeRecall(scope,query,()=>true),true);await worker.tick();assert.equal(selectionCalls,1);
 const host:HostRuntimeInput={assistantId:scope.assistantId,runtimeSelfContext:{sourceRevision:'synthetic:1',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',limitations:['Owned synthetic preparation, not physical audience or model-quality acceptance.']},preparedRelationshipContext:compile()!,isCurrent:()=>true};
 attachConversationMemoryRecall(host,{worker,scope,query,options:idle,compile});
 return {app,worker,scope,host,compile,selected,unselected,foreign,memories,session,selectionCalls:()=>selectionCalls};
}
function response(){let output='',status=0;const value={destroyed:false,writableEnded:false,writeHead(code:number){status=code;},write(text:string){output+=text;return true;},end(){this.writableEnded=true;}} as unknown as import('node:http').ServerResponse;return {value,output:()=>output,status:()=>status};}

test('original host scoped memory selection reaches the prepared prompt without a literal match or another selection call',async t=>{
 const f=await fixture(t),res=response();let prompt='';
 await streamMessage(res.value,{async *generate(request){prompt=request.sections.find(section=>section.kind==='preparedMemory')!.content;yield {kind:'text' as const,text:'Synthetic bounded reply.'};yield {kind:'done' as const};}},{assistantId:f.scope.assistantId,userInput:query},f.session.sessionId,new AbortController().signal,undefined,f.host.runtimeSelfContext,f.host);
 assert.equal(res.status(),200);assert.match(res.output(),/interaction.completed/);assert.match(prompt,/Allow damp substrate to dry/);assert.doesNotMatch(prompt,/unrelated literal filler|Other relationship|Other owner/);
 assert.equal(f.selectionCalls(),1);assert.deepEqual(selectedRelationshipSources(f.host.preparedRelationshipContext!)!.filter(source=>source.memoryRecord).map(source=>source.id),[f.selected.id]);
 for(const refs of [[{id:f.selected.id,revision:1}],[{id:f.foreign.id,revision:f.foreign.lifecycle.revision}],[{id:randomUUID(),revision:1}]])assert.throws(()=>f.compile(refs),/Semantic memory source changed/);
});

test('late forgetting, correction, consent revocation and lease expiry stop the same prepared output before a text delta',async t=>{
 for(const fault of ['forget','correction','consent','expiry'] as const)await t.test(fault,async child=>{
  const f=await fixture(child),res=response();let proposed=false;
  const originalNow=Date.now;let restore:()=>void=()=>{};
  try{
   await streamMessage(res.value,{async *generate(request){assert.match(request.sections.find(section=>section.kind==='preparedMemory')!.content,/Allow damp substrate/);proposed=true;
    if(fault==='forget')f.memories.forget(f.scope.assistantId,f.selected.id,f.scope.principalId);
    else if(fault==='correction'){const proposal=f.memories.proposeCorrection(f.scope.assistantId,f.selected.id,'A later reviewed convention.',f.scope.principalId)!;f.memories.applyCorrection(f.scope.assistantId,f.selected.id,proposal.revision,f.selected.lifecycle.revision as number,f.scope.principalId);}
    else if(fault==='consent')f.worker.configure(f.scope,false,f.worker.policy(f.scope).revision);
    else{const fake=child.mock.method(Date,'now',()=>originalNow()+60001);restore=()=>fake.mock.restore();}
    yield {kind:'text' as const,text:'MUST_NOT_BE_DELIVERED'};yield {kind:'done' as const};
   }},{assistantId:f.scope.assistantId,userInput:query},f.session.sessionId,new AbortController().signal,undefined,f.host.runtimeSelfContext,f.host);
   assert.equal(proposed,true);assert.match(res.output(),/runtime_input_stale/);assert.doesNotMatch(res.output(),/message.delta|MUST_NOT_BE_DELIVERED|interaction.completed/);assert.equal(f.host.isCurrent(),false);assert.equal(f.selectionCalls(),1);
  }finally{restore();}
 });
});

test('empty optional selection keeps current mandatory memory corrections in the original host projection',async t=>{
 const f=await fixture(t),proposal=f.memories.proposeCorrection(f.scope.assistantId,f.selected.id,'The reviewed current convention replaces the old interpretation.',f.scope.principalId)!;
 const correction=f.memories.applyCorrection(f.scope.assistantId,f.selected.id,proposal.revision,f.selected.lifecycle.revision as number,f.scope.principalId),view=f.compile([])!;
 assert.ok(view.selections.some(source=>source.id===correction.id&&source.lane==='correction'));assert.ok(!view.selections.some(source=>source.id===f.unselected.id));
 assert.throws(()=>f.compile([{id:f.selected.id,revision:f.selected.lifecycle.revision as number}]),/Semantic memory source changed/);
});
