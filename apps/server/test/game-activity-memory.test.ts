import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,MemoryRepository,type GameEpisodeOptions} from '@lifestream/storage-sqlite';
import type {InferenceProvider,InferenceRequest} from '@lifestream/runtime/inference';
import {fixtureEpisode,fixtureGameEpisodeSources} from '../../../packages/runtime/test/fixtures/game-memory.ts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {defaultTopics,type ExperienceScope} from '@lifestream/contracts/experience';
import type {ExperientialLearning} from '../src/runtime/experience.ts';

async function setup(t:import('node:test').TestContext,retentionMs=60000){
 const root=await mkdtemp(join(tmpdir(),'ls-game-memory-http-')),config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 let now=Date.now(),current=true,meaningful=true;const e=fixtureEpisode(now);e.expiresAt=new Date(now+retentionMs).toISOString();e.summary='The gate stayed closed.';e.uncertainty='Hidden cause unknown.';const sources=fixtureGameEpisodeSources(e);
 const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex');
 const source:GameEpisodeOptions={maximumFences:8,scopeCurrent:o=>o.principalId===e.scope.principalId&&o.assistantId===e.scope.assistantId&&o.relationshipId===e.scope.relationshipId,quarantined:()=>false,retentionFor:()=>({retentionMs:86400000,retentionPolicyRef:e.retentionPolicyRef,maximumEpisodes:4,maximumBytes:8192}),sourceRecordsFor:()=>sources,meaningfulGroundingCurrent:()=>meaningful,publicationCurrent:()=>current,retainedSourceCurrent:()=>current,now:()=>now};
 const app=createLifestreamServer({config,experienceTestClock:()=>now,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]},gameMemory:{source,maximumCandidates:4,estimate:()=>({value:.6,basis:'Scripted summary fidelity only, not perception truth.',policyRef:'test-only:game-transform:1'})}});
 t.after(async()=>{await app.shutdown();await rm(root,{recursive:true,force:true});});await app.start();
 const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin:base,'content-type':'application/json'};
 const request=(path:string,body?:unknown,extra:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const api=async(path:string,body?:unknown)=>{const r=await request(path,body),v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;};
 const signed=await request('/api/auth/v1/setup',{username:'synthetic',password,installerToken});assert.equal(signed.status,201);headers.cookie=signed.headers.get('set-cookie')!.split(';')[0]!;const identity=(await signed.json()).session;headers['x-lifestream-csrf']=identity.csrfToken;
 const assistant=await api('/api/admin/v1/assistants',{displayName:'Synthetic game recall Assistant'}),assistantId=assistant.assistantId as string;await api(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});
 const relationship=(await api(`/api/admin/v1/assistants/${assistantId}/relationships`,{})).relationship,relationshipId=relationship.relationshipId as string;
 await api('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()});await api('/api/runtime/v1/audience',{mode:'solo',seconds:300});
 e.scope.principalId=identity.principalId;e.scope.assistantId=assistantId;e.scope.relationshipId=relationshipId;
 for(const record of [...sources.actions,...sources.observations])record.scope=structuredClone(e.scope);
 const internals=app as unknown as {database:Database;memories:MemoryRepository;providers:{inference:InferenceProvider};experience:ExperientialLearning;experienceSources:(scope:ExperienceScope)=>import('@lifestream/contracts/experience').Source[]};
 const requests:InferenceRequest[]=[];internals.providers.inference={async *generate(input){requests.push(input);yield {kind:'text',text:'Scripted historical reply.'};yield {kind:'done'};}};
 const owner={assistantId,relationshipId},path=`/api/admin/v1/assistants/${assistantId}/relationships/${relationshipId}`;
 return {app,e,source,sources,internals,requests,request,api,owner,path,identity,enable:()=>api('/api/runtime/v1/memory',{...owner,enabled:true,expectedRevision:0}),withdraw:()=>current=false,meaningless:()=>meaningful=false,advance:(ms:number)=>now+=ms,reply:()=>request('/api/runtime/v1/messages',{...owner,userInput:'Recall the gate in our past game.'})};
}

test('trusted source publication reaches existing active memory and ordinary nine-section HTTP replies',{timeout:15000},async t=>{
 const f=await setup(t);assert.deepEqual(f.app.publishGameEpisode(f.e),{state:'unavailable',memoryId:null});await f.enable();
 const published=f.app.publishGameEpisode(f.e);assert.equal(published.state,'retained');assert.ok(published.memoryId);assert.deepEqual(f.app.publishGameEpisode(f.e),{state:'unavailable',memoryId:null});
 const memory=f.internals.memories.get(f.owner.assistantId,published.memoryId!)!;assert.equal(memory.lifecycle.status,'active');assert.equal(memory.lifecycle.revision,2);assert.equal(memory.lifecycle.factuality,'unverified');assert.equal(memory.lifecycle.lastReinforcedAt,null);assert.equal(memory.provenance.sourceTurnRef,undefined);
 assert.equal(f.internals.database.connection.prepare('SELECT count(*) AS n FROM automatic_memory_work').get()!.n,0);
 assert.match(await(await f.reply()).text(),/interaction.completed/);assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.sections.length,9);
 const prepared=f.requests[0]!.sections.find(s=>s.kind==='preparedMemory')!.content;
 assert.match(prepared,/Past simulated game experience/);assert.ok(prepared.includes(f.e.occurredFrom));assert.ok(prepared.includes(f.e.scope.timelineId));assert.match(prepared,/The gate stayed closed/);assert.match(prepared,/Hidden cause unknown/);assert.match(prepared,/not current progress/);assert.doesNotMatch(prepared,/participantStatement/);
 const exported=await f.api(`/api/admin/v1/assistants/${f.owner.assistantId}/memories/export`);assert.equal(exported.memories[0].provenance.canonical.factuality,'unverified');assert.equal(exported.memories[0].provenance.canonical.confidence,.6);
 assert.equal(f.internals.memories.activateGameCandidate(f.owner.assistantId,published.memoryId!,f.identity.principalId,1),undefined);
 assert.throws(()=>f.internals.memories.proposeCorrection(f.owner.assistantId,published.memoryId!,'A fabricated victory',f.identity.principalId),/source-aware/);
});

for(const cause of ['source','expiry','policy','forget','audience']as const)test('held ordinary reply is fenced by game '+cause,{timeout:15000},async t=>{
 const f=await setup(t);await f.enable();const published=f.app.publishGameEpisode(f.e);assert.ok(published.memoryId);
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);t.after(()=>release());
 f.internals.providers.inference={async *generate(input){f.requests.push(input);entered();await held;yield {kind:'text',text:'LATE_GAME_MEMORY_REPLY'};yield {kind:'done'};}};
 const pending=f.reply();await started;assert.match(f.requests[0]!.sections.find(s=>s.kind==='preparedMemory')!.content,/The gate stayed closed/);
 if(cause==='source')f.withdraw();if(cause==='expiry')f.advance(60000);if(cause==='policy')await f.api('/api/runtime/v1/memory',{...f.owner,enabled:false,expectedRevision:1});if(cause==='audience')await f.api('/api/runtime/v1/audience',{mode:'shared',seconds:300});
 if(cause==='forget'){
  const relationship=(await f.api(f.path)).relationship,body={action:'forget-derived-information',expectedRevision:relationship.revision,idempotencyKey:randomUUID(),targets:[{kind:'memory',id:published.memoryId,revision:2}]};
  assert.equal((await f.request(f.path+'/privacy',body,{'x-lifestream-csrf':'wrong'})).status,403);
  const forgotten=await f.api(f.path+'/privacy',body);assert.equal(forgotten.receipt.status,'completed');assert.ok(forgotten.receipt.artifacts.some((a:any)=>a.owner==='native-memory'&&a.disposition==='payloadRemoved'));
  assert.equal(f.internals.database.connection.prepare('SELECT content FROM memories WHERE id=?').get(published.memoryId!)!.content,'');assert.equal(f.internals.database.connection.prepare('SELECT payload_json FROM game_experience_episodes').get()!.payload_json,null);
  assert.equal((await f.api(f.path+'/privacy',body)).receipt.operationId,forgotten.receipt.operationId);assert.deepEqual(f.app.publishGameEpisode(f.e),{state:'unavailable',memoryId:null});
 }
 release();assert.doesNotMatch(await(await pending).text(),/LATE_GAME_MEMORY_REPLY/);
 f.internals.providers.inference={async *generate(input){f.requests.push(input);yield {kind:'text',text:'Safe independent reply.'};yield {kind:'done'};}};
 await(await f.reply()).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/The gate stayed closed/);
});

test('unknown and shared audience exclude personal game recall without creating live game or contact authority',{timeout:15000},async t=>{
 const f=await setup(t);await f.enable();assert.ok(f.app.publishGameEpisode(f.e).memoryId);
 for(const mode of ['shared','clear']){await f.api('/api/runtime/v1/audience',{mode,...(mode==='shared'?{seconds:300}:{})});await(await f.reply()).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/The gate stayed closed/);}
 assert.equal(f.internals.database.connection.prepare('SELECT count(*) AS n FROM game_start_claims').get()!.n,0);
});

test('unqualified meaningful grounding cannot enter durable game memory',{timeout:15000},async t=>{const f=await setup(t);await f.enable();f.meaningless();assert.deepEqual(f.app.publishGameEpisode(f.e),{state:'unavailable',memoryId:null});assert.equal(f.internals.database.connection.prepare('SELECT count(*) AS n FROM game_experience_episodes').get()!.n,0);});

test('changing caller options cannot replace captured retained-source qualification',{timeout:15000},async t=>{const f=await setup(t);await f.enable();assert.ok(f.app.publishGameEpisode(f.e).memoryId);f.withdraw();f.source.retainedSourceCurrent=()=>true;f.source.publicationCurrent=()=>true;await(await f.reply()).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/The gate stayed closed/);});

test('privacy target cannot cross a game memory relationship while original owner can still erase it',{timeout:15000},async t=>{
 const f=await setup(t);await f.enable();const published=f.app.publishGameEpisode(f.e);assert.ok(published.memoryId);
 const assistant=await f.api('/api/admin/v1/assistants',{displayName:'Separate synthetic Assistant'}),other=(await f.api(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).relationship,path=`/api/admin/v1/assistants/${assistant.assistantId}/relationships/${other.relationshipId}`;
 const denied=await f.request(path+'/privacy',{action:'forget-derived-information',expectedRevision:other.revision,idempotencyKey:randomUUID(),targets:[{kind:'memory',id:published.memoryId,revision:2}]});assert.equal(denied.status,409);
 assert.equal(f.internals.memories.get(f.owner.assistantId,published.memoryId!)!.content,f.e.summary);
 const relationship=(await f.api(f.path)).relationship;assert.equal((await f.api(f.path+'/privacy',{action:'forget-derived-information',expectedRevision:relationship.revision,idempotencyKey:randomUUID(),targets:[{kind:'memory',id:published.memoryId,revision:2}]})).receipt.status,'completed');
});

test('authenticated game source ledger joins reflection only under separate learning consent and forget scrubs lineage',{timeout:15000},async t=>{
 const f=await setup(t,3600000);await f.enable();const published=f.app.publishGameEpisode(f.e);assert.ok(published.memoryId);
 const scope={...f.owner,principalId:f.identity.principalId},path=f.path+'/experience/v1',service=f.internals.experience;
 let view=await f.api(path);assert.equal(view.state.configuration.enabled,false);assert.equal(f.internals.experienceSources(scope).length,1);
 await service.tick();assert.equal(service.repository.read(scope).funnel.eligible,0);assert.equal(f.requests.length,0);
 await f.api(path,{schemaVersion:'1.0.0',operation:'configure',expectedRevision:view.state.revision,enabled:true,frozen:false,retention:'sourceBound',topicPolicies:defaultTopics});
 await service.tick();view=await f.api(path);assert.equal(view.state.funnel.eligible,1);assert.equal(view.state.funnel.calls,0);
 assert.equal(f.internals.database.connection.prepare('SELECT count(*) AS n FROM experience_turns').get()!.n,0,'game sources cannot manufacture completed Human turns');
 const job=service.repository.jobs(scope)[0]!,source=f.internals.experienceSources(scope)[0]!;assert.equal(source.id,'game-episode:'+f.e.episodeId);assert.equal(source.occurredAt,f.e.occurredFrom);
 assert.equal(JSON.parse(source.content).scope.timelineId,f.e.scope.timelineId);assert.equal(service.repository.episodes(scope)[0]!.eligibleReason,'outcome');
 await service.tick();assert.equal(service.repository.read(scope).funnel.eligible,1,'one original family is one episode');
 const relationship=(await f.api(f.path)).relationship;await f.api(f.path+'/privacy',{action:'forget-derived-information',expectedRevision:relationship.revision,idempotencyKey:randomUUID(),targets:[{kind:'memory',id:published.memoryId,revision:2}]});
 assert.deepEqual(f.internals.experienceSources(scope),[]);view=await f.api(path);assert.equal(service.repository.current(job),false);assert.equal(view.state.funnel.published,0);assert.doesNotMatch(JSON.stringify(view),/The gate stayed closed/);
 assert.deepEqual(f.app.publishGameEpisode(f.e),{state:'unavailable',memoryId:null});
});

for(const cause of ['source','expiry','policy']as const)test('actual retained game reflection source disappears after '+cause,{timeout:15000},async t=>{
 const f=await setup(t);await f.enable();assert.ok(f.app.publishGameEpisode(f.e).memoryId);const scope={...f.owner,principalId:f.identity.principalId};assert.equal(f.internals.experienceSources(scope).length,1);
 if(cause==='source')f.withdraw();if(cause==='expiry')f.advance(60000);if(cause==='policy')await f.api('/api/runtime/v1/memory',{...f.owner,enabled:false,expectedRevision:1});
 assert.deepEqual(f.internals.experienceSources(scope),[]);assert.equal(f.internals.database.connection.prepare('SELECT count(*) AS n FROM game_start_claims').get()!.n,0);
});

test('source-bound game reflection publishes an uncertain continuation into an ordinary private HTTP reply',{timeout:15000},async t=>{
 const f=await setup(t,3600000);await f.enable();assert.ok(f.app.publishGameEpisode(f.e).memoryId);const scope={...f.owner,principalId:f.identity.principalId},path=f.path+'/experience/v1';let view=await f.api(path);
 f.internals.providers.inference={tokenize:async()=>({count:40,identity:'scripted-tokenizer'}),async*generate(input){f.requests.push(input);if(input.scope.sessionId.startsWith('experience:')){const data=JSON.parse(input.sections.at(-1)!.content);yield {kind:'text',text:JSON.stringify({recordType:'reflectionResult',decision:'change',conclusion:'A past simulated attempt leaves an unresolved question.',items:[{id:'past-game-gate',expectedRevision:0,kind:'question',topic:'games',statement:'The recorded gate attempt did not cross; the cause is unknown.',nextStep:'Ask about the past game gate attempt.',uncertainty:'high',sourceRefs:data.sources.map((s:any)=>s.id),disposition:'open'}],changes:[]})};}else yield {kind:'text',text:'Scripted ordinary continuation.'};yield {kind:'done'};}};
 await f.api(path,{schemaVersion:'1.0.0',operation:'configure',expectedRevision:view.state.revision,enabled:true,frozen:false,retention:'sourceBound',topicPolicies:defaultTopics});await f.internals.experience.tick();f.advance(60001);await f.internals.experience.tick();
 view=await f.api(path);assert.equal(view.state.funnel.calls,1,JSON.stringify(view));assert.equal(view.state.funnel.published,1,JSON.stringify(view));assert.equal(view.state.items[0].uncertainty,'high');assert.equal(view.state.items[0].topic,'games');assert.ok(view.state.imprints.every((i:any)=>i.value===0));
 const response=await f.request('/api/runtime/v1/messages',{...f.owner,userInput:'What should we work on next?'});assert.match(await response.text(),/interaction.completed/);const prepared=f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content;assert.match(prepared,/Ask about the past game gate attempt/);assert.equal(f.requests.at(-1)!.sections.length,9);
 await f.api('/api/runtime/v1/audience',{mode:'shared',seconds:300});await(await f.request('/api/runtime/v1/messages',{...f.owner,userInput:'What should we work on next?'})).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/Ask about the past game gate attempt/);
 assert.equal(f.internals.database.connection.prepare('SELECT count(*) AS n FROM game_start_claims').get()!.n,0);
});
