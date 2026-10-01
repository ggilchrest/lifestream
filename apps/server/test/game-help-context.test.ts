import {conversationFixtureProvider} from './fixtures/conversation-provider.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,MemoryRepository,GameHelpRepository,type GameEpisodeOptions} from '@lifestream/storage-sqlite';
import type {InferenceProvider,InferenceRequest} from '@lifestream/runtime/inference';
import {fixtureGameHelpItem,fixtureEpisode,fixtureGameEpisodeSources} from '../../../packages/runtime/test/fixtures/game-memory.ts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {type ExperienceScope} from '@lifestream/contracts/experience';
import type {ExperientialLearning} from '../src/runtime/experience.ts';

async function setup(t:import('node:test').TestContext,retentionMs=60000){
 const root=await mkdtemp(join(tmpdir(),'ls-game-memory-http-')),config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 let now=Date.now(),current=true,meaningful=true,paused=true,configured=true,helpBoundary=1;const e=fixtureEpisode(now);e.expiresAt=new Date(now+retentionMs).toISOString();e.summary='The gate stayed closed.';e.uncertainty='Hidden cause unknown.';const sources=fixtureGameEpisodeSources(e);
 const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex');
 const source:GameEpisodeOptions={maximumFences:8,scopeCurrent:o=>o.principalId===e.scope.principalId&&o.assistantId===e.scope.assistantId&&o.relationshipId===e.scope.relationshipId,quarantined:()=>false,retentionFor:()=>({retentionMs:86400000,retentionPolicyRef:e.retentionPolicyRef,maximumEpisodes:4,maximumBytes:8192}),sourceRecordsFor:()=>sources,meaningfulGroundingCurrent:()=>meaningful,publicationCurrent:()=>current,retainedSourceCurrent:()=>current,now:()=>now};
 const app=createLifestreamServer({config,experienceTestClock:()=>now,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]},gameMemory:{source,maximumCandidates:4,help:{maximumCandidates:1,options:{maximumFences:8,retentionFor:()=>({revision:1,policyRef:'test-only:help-retention',retentionMs:30000,maximumItems:4,maximumBytes:8192}),boundaryRevision:()=>String(helpBoundary),pendingCurrent:()=>paused&&configured,situationKeyFor:()=> 'd'.repeat(64)}},estimate:()=>({value:.6,basis:'Scripted summary fidelity only, not perception truth.',policyRef:'test-only:game-transform:1'})}});
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
 const internals=app as unknown as {gameHelp:GameHelpRepository;database:Database;memories:MemoryRepository;providers:{inference:InferenceProvider};experience:ExperientialLearning;experienceSources:(scope:ExperienceScope)=>import('@lifestream/contracts/experience').Source[]};
 const requests:InferenceRequest[]=[];internals.providers.inference=conversationFixtureProvider({async *generate(input){requests.push(input);yield {kind:'text',text:'Scripted historical reply.'};yield {kind:'done'};}});
 const owner={assistantId,relationshipId},path=`/api/admin/v1/assistants/${assistantId}/relationships/${relationshipId}`;
 const item=fixtureGameHelpItem(e,now);
 return {item,help:internals.gameHelp,now:()=>now,unpause:()=>paused=false,unconfigure:()=>configured=false,change:()=>helpBoundary++,queue:()=>app.publishGameHelp({item,episodeId:e.episodeId,expiresAt:now+30000}),app,e,source,sources,internals,requests,request,api,owner,path,identity,enable:()=>api('/api/runtime/v1/memory',{...owner,enabled:true,expectedRevision:0}),withdraw:()=>current=false,meaningless:()=>meaningful=false,advance:(ms:number)=>now+=ms,reply:()=>request('/api/runtime/v1/messages',{...owner,userInput:'What pending question did you have about the game gate?'})};
}


test('retained pending question reaches existing ordinary nine-section foreground context without channel or game effects',{timeout:15000},async t=>{
 const f=await setup(t);assert.equal(f.queue().state,'unavailable');await f.enable();assert.ok(f.app.publishGameEpisode(f.e).memoryId);assert.equal(f.queue().state,'retained');assert.equal(f.queue().state,'unavailable');
 const result=await f.reply();assert.match(await result.text(),/interaction.completed/);const request=f.requests[0]!;assert.equal(request.sections.length,9);const memory=request.sections.find(s=>s.kind==='preparedMemory')!.content;assert.match(memory,/Queued game question/);assert.match(memory,/How would you approach this recorded gate/);assert.ok(memory.includes(f.item.queuedAt));assert.ok(memory.includes(f.e.scope.timelineId));assert.match(memory,/delivery\/reply\/image unproved/);assert.ok(!memory.includes(f.item.recipientRef));assert.ok(!memory.includes(f.item.channelRef));assert.equal(f.help.get({...f.owner,principalId:f.identity.principalId},f.item.helpId)!.item.status,'queued');assert.equal(f.internals.database.connection.prepare('SELECT count(*) AS n FROM game_start_claims').get()!.n,0);
});
for(const cause of ['helpForget','sourceForget','sourceWithdraw','policy','pause','recipient','epoch','expiry','audience']as const)test('held ordinary pending-help reply is fenced after '+cause,{timeout:15000},async t=>{
 const f=await setup(t);await f.enable();const published=f.app.publishGameEpisode(f.e);assert.ok(published.memoryId);assert.equal(f.queue().state,'retained');let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);t.after(()=>release());
 f.internals.providers.inference=conversationFixtureProvider({async*generate(input){f.requests.push(input);entered();await held;yield {kind:'text',text:'LATE_PENDING_HELP_PROSE'};yield {kind:'done'};}});const pending=f.reply();await started;assert.match(f.requests[0]!.sections.find(s=>s.kind==='preparedMemory')!.content,/Queued game question/);
 if(cause==='helpForget')f.help.forget({...f.owner,principalId:f.identity.principalId},f.item.helpId,1);if(cause==='sourceForget')f.internals.memories.forget(f.owner.assistantId,published.memoryId!,f.identity.principalId);if(cause==='sourceWithdraw')f.withdraw();if(cause==='policy')await f.api('/api/runtime/v1/memory',{...f.owner,enabled:false,expectedRevision:1});if(cause==='pause')f.unpause();if(cause==='recipient')f.unconfigure();if(cause==='epoch')f.change();if(cause==='expiry')f.advance(30000);if(cause==='audience')await f.api('/api/runtime/v1/audience',{mode:'shared',seconds:300});
 release();assert.doesNotMatch(await(await pending).text(),/LATE_PENDING_HELP_PROSE/);f.internals.providers.inference=conversationFixtureProvider({async*generate(input){f.requests.push(input);yield {kind:'text',text:'Safe new reply'};yield {kind:'done'};}});await(await f.reply()).text();if(cause!=='epoch')assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/Queued game question/);
});
test('unrelated foreground request and unknown audience withhold pending game questions',{timeout:15000},async t=>{
 const f=await setup(t);await f.enable();assert.ok(f.app.publishGameEpisode(f.e).memoryId);assert.equal(f.queue().state,'retained');await(await f.request('/api/runtime/v1/messages',{...f.owner,userInput:'Calculate eighteen plus forty.'})).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/Queued game question/);await f.api('/api/runtime/v1/audience',{mode:'clear'});await(await f.reply()).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/Queued game question/);
});
test('foreign relationship cannot select another relationship pending help',{timeout:15000},async t=>{
 const f=await setup(t);await f.enable();assert.ok(f.app.publishGameEpisode(f.e).memoryId);assert.equal(f.queue().state,'retained');const assistant=await f.api('/api/admin/v1/assistants',{displayName:'Other synthetic Assistant'});await f.api(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});const relationship=(await f.api(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).relationship;await(await f.request('/api/runtime/v1/messages',{assistantId:assistant.assistantId,relationshipId:relationship.relationshipId,userInput:'What pending question did you have about the game gate?'})).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/Queued game question/);
});
test('oversized pending question is omitted intact by existing optional context budget',{timeout:15000},async t=>{
 const f=await setup(t);await f.enable();assert.ok(f.app.publishGameEpisode(f.e).memoryId);f.item.question='Recorded gate '+ 'x'.repeat(800);assert.equal(f.queue().state,'retained');await(await f.reply()).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/Queued game question/);assert.equal(f.help.get({...f.owner,principalId:f.identity.principalId},f.item.helpId)!.item.question,f.item.question);
});

test('forgetting an omitted pending topic does not cancel an independent foreground reply',{timeout:15000},async t=>{
 const f=await setup(t);await f.enable();assert.ok(f.app.publishGameEpisode(f.e).memoryId);assert.equal(f.queue().state,'retained');let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);t.after(()=>release());f.internals.providers.inference=conversationFixtureProvider({async*generate(input){f.requests.push(input);entered();await held;yield {kind:'text',text:'INDEPENDENT_CALCULATION_REPLY'};yield {kind:'done'};}});const response=f.request('/api/runtime/v1/messages',{...f.owner,userInput:'Calculate eighteen plus forty.'});await started;assert.doesNotMatch(f.requests[0]!.sections.find(s=>s.kind==='preparedMemory')!.content,/Queued game question/);f.help.forget({...f.owner,principalId:f.identity.principalId},f.item.helpId,1);release();assert.match(await(await response).text(),/INDEPENDENT_CALCULATION_REPLY/);
});
