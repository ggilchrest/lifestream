import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryRepository,type Database} from '@lifestream/storage-sqlite';
import {FixtureInferenceProvider} from '@lifestream/runtime/inference/fixture';
import type {InferenceRequest} from '@lifestream/runtime/inference';
import {createLifestreamServer} from '../src/index.ts';
import {LocalAuthentication} from '../src/auth/local-auth.ts';
import {loadProfile} from '../src/config/loader.ts';
import type {AutomaticMemory} from '../src/runtime/automatic-memory.ts';
import type {ConversationMemoryRecallOptions} from '../src/runtime/conversation-memory-context.ts';
const query='Which gear deters insects around seedlings?',quote='Put fine netting over the vegetable bed.';
const bounded:ConversationMemoryRecallOptions={mode:'bounded',waitBudgetMs:500,fallback:'ordinary-context',warmOnMiss:false};
const idle:ConversationMemoryRecallOptions={mode:'idle',waitBudgetMs:0,fallback:'ordinary-context',warmOnMiss:true};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
async function fixture(t:any,options?:ConversationMemoryRecallOptions){
 const root=await mkdtemp(join(tmpdir(),'semantic-conversation-http-'));let guidanceId='',primaryHook=async()=>{},selectorHook=async()=>{};const primary:InferenceRequest[]=[],selectors:InferenceRequest[]=[];
 // Observe and rethrow the real durability error; never waive fsync for a passing witness.
 const writeExclusive=(LocalAuthentication.prototype as any).writeExclusive;
 t.mock.method(LocalAuthentication.prototype as any,'writeExclusive',function(this:LocalAuthentication,...args:any[]){try{return writeExclusive.apply(this,args);}catch(error){const e=error as Error&{code?:string};if(e.code==='EPERM'&&e.stack?.includes('fsyncSync'))console.log('DIRECTORY_DURABILITY_BLOCKED '+JSON.stringify({operation:'LocalAuthentication.writeExclusive',code:e.code,fsync:true}));throw error;}});
 const original=FixtureInferenceProvider.prototype.generate;
 FixtureInferenceProvider.prototype.generate=async function*(request){
  if(request.scope.sessionId==='automatic-memory-worker'){const data=JSON.parse(request.sections.at(-1)!.content);yield {kind:'text',text:JSON.stringify({version:2,source:data.sourceIdentity,items:data.source===quote?[{key:'garden.netting',kind:'proceduralHint',quote,subject:'owner',scope:'relationship',epistemic:'advice',meaning:'Equipment advice for protecting seedlings from insects.',attribution:'Authenticated participant offered advice.',uncertainty:'Applicability unverified.',dependencyRefs:[]}]:[]})};yield {kind:'done'};return;}
  if(request.scope.sessionId==='automatic-memory-recall'){selectors.push(request);const data=JSON.parse(request.sections.at(-1)!.content);await selectorHook();yield {kind:'text',text:JSON.stringify({version:1,queryDigest:data.queryDigest,sourceDigest:data.sourceDigest,items:data.query===query?data.candidates.filter((c:any)=>c.id===guidanceId).map((c:any)=>({id:c.id,revision:c.revision,rationale:'Participant advice concerns the requested protection; applicability unverified.'})):[]})};yield {kind:'done'};return;}
  primary.push(request);await primaryHook();const section=request.sections.find(s=>s.kind==='preparedMemory')!.content;yield {kind:'text',text:section.includes(quote)?'You offered fine netting advice; applicability remains unverified.':'No selected participant guidance is available.'};yield {kind:'done'};
 };
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:':memory:',artifactDirectory:join(root,'artifacts')};const installerToken=randomBytes(32).toString('hex');
 const app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]},...(options?{conversationMemoryRecall:options}:{})});
 t.after(async()=>{await app.shutdown();FixtureInferenceProvider.prototype.generate=original;await rm(root,{recursive:true,force:true});});await app.start();
 const base='http://127.0.0.1:'+app.address().port,headers:Record<string,string>={'content-type':'application/json',origin:base};
 const api=async(path:string,body:unknown,expected=200)=>{const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)}),data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));if(r.headers.get('set-cookie'))headers.cookie=r.headers.get('set-cookie')!.split(';')[0]!;if(data.session)headers['x-lifestream-csrf']=data.session.csrfToken;return data;};
 const setup=await api('/api/auth/v1/setup',{username:'owner',password:randomBytes(32).toString('hex'),installerToken},201);
 await api('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'});await api('/api/runtime/v1/audience',{mode:'solo',seconds:300});
 const assistant=await api('/api/admin/v1/assistants',{displayName:'Synthetic ordinary recall'},201);await api('/api/admin/v1/assistants/'+assistant.assistantId+'/activate',{profileId:assistant.profile.profileId,expectedActiveRevision:null});const relationship=(await api('/api/admin/v1/assistants/'+assistant.assistantId+'/relationships',{},201)).relationship;
 const scope={assistantId:assistant.assistantId,principalId:setup.session.principalId,relationshipId:relationship.relationshipId};await api('/api/runtime/v1/memory',{assistantId:scope.assistantId,relationshipId:scope.relationshipId,enabled:true,expectedRevision:0});
 const worker=(app as unknown as {automaticMemory:AutomaticMemory}).automaticMemory,db=(app as unknown as {database:Database}).database,memories=new MemoryRepository(db);
 worker.enqueue(scope,'synthetic-guidance',quote,'authenticatedTypedOwner',{sessionRef:'synthetic-fixture-session',messageRef:'synthetic-guidance'});await worker.tick();guidanceId=memories.contextRecords(scope.assistantId,scope.principalId,scope.relationshipId)[0]!.id;
 const distractor={id:randomUUID(),assistantId:scope.assistantId,content:'Quoted typing exercise: '+query,provenance:{actor:scope.principalId,relationshipId:scope.relationshipId,sourceFamily:'independent-typing-example'},lifecycle:{status:'candidate',revision:1},createdAt:new Date().toISOString()};memories.save(distractor);memories.transition(scope.assistantId,distractor.id,'active',scope.principalId);
 const turn=async(text=query,extra:Record<string,unknown>={},signal?:AbortSignal)=>{const r=await fetch(base+'/api/runtime/v1/messages',{method:'POST',headers,signal,body:JSON.stringify({assistantId:scope.assistantId,relationshipId:scope.relationshipId,userInput:text,inspect:true,...extra})});return {status:r.status,output:await r.text()};};
 return {app,api,scope,worker,memories,primary,selectors,turn,guidanceId,setPrimary:(fn:typeof primaryHook)=>primaryHook=fn,setSelector:(fn:typeof selectorHook)=>selectorHook=fn};
}
test('actual authenticated ordinary route defaults remain unchanged and client JSON cannot activate semantic recall',{timeout:30000},async t=>{
 const f=await fixture(t),reply=await f.turn(query,{conversationMemoryRecall:bounded,semanticReferences:[{id:f.guidanceId,revision:2}],preparedRelationshipContext:{approvedBaseline:['INJECTED_HOST_VIEW']}});
 assert.equal(reply.status,200);assert.match(reply.output,/No selected participant guidance/);assert.match(reply.output,/interaction.completed/);assert.equal(f.selectors.length,0);assert.doesNotMatch(f.primary[0]!.sections.find(s=>s.kind==='preparedMemory')!.content,/fine netting|INJECTED_HOST_VIEW/);
});
test('actual authenticated ordinary conversation composes fresh semantic source selection and attributed reply',{timeout:30000},async t=>{
 const f=await fixture(t,bounded),reply=await f.turn();assert.equal(reply.status,200);assert.match(reply.output,/You offered fine netting advice.*unverified/);assert.match(reply.output,/interaction.completed/);assert.equal(f.selectors.length,1);
 const section=f.primary[0]!.sections.find(s=>s.kind==='preparedMemory')!;assert.match(section.content,/Participant advice \(unverified applicability\)/);assert.match(section.content,/Authenticated participant offered advice/);assert.doesNotMatch(section.content,/Quoted typing/);assert.match(reply.output,/"coverage":"fresh"/);
});
test('actual ordinary idle mode has first-query fallback then consumes the completed worker projection',{timeout:30000},async t=>{
 const f=await fixture(t,idle),cold=await f.turn();assert.match(cold.output,/No selected participant guidance/);assert.match(cold.output,/"coverage":"miss"/);assert.equal(f.selectors.length,0);
 for(let n=0;n<3&&!f.selectors.length;n++)await f.worker.tick();assert.equal(f.selectors.length,1);const warm=await f.turn();assert.match(warm.output,/You offered fine netting advice/);assert.match(warm.output,/"coverage":"idleWarm"/);assert.equal(f.selectors.length,1);
});
test('actual route drops late generated semantic guidance after consent withdrawal',{timeout:30000},async t=>{
 const f=await fixture(t,bounded),began=deferred(),release=deferred();f.setPrimary(async()=>{began.resolve();await release.promise;});const pending=f.turn();await began.promise;
 await f.api('/api/runtime/v1/memory',{assistantId:f.scope.assistantId,relationshipId:f.scope.relationshipId,enabled:false,expectedRevision:1});release.resolve();const reply=await pending;assert.match(reply.output,/runtime_input_stale|cancelled/);assert.doesNotMatch(reply.output,/You offered fine netting|interaction.completed/);
});
test('actual route rejects shared-audience withdrawal during optional memory preparation',{timeout:30000},async t=>{
 const f=await fixture(t,bounded),began=deferred(),release=deferred();f.setSelector(async()=>{began.resolve();await release.promise;});const pending=f.turn();await began.promise;
 await f.api('/api/runtime/v1/audience',{mode:'shared',seconds:300});release.resolve();const reply=await pending;assert.equal(reply.status,409);assert.equal(f.primary.length,0);assert.doesNotMatch(reply.output,/You offered fine netting/);
});
