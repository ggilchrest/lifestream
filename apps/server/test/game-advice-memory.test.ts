import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,MemoryRepository,GameHelpRepository,type GameEpisodeOptions,type GameEpisodeSources,type GameEpisodeAdviceSource} from '@lifestream/storage-sqlite';
import type {InferenceProvider,InferenceRequest} from '@lifestream/runtime/inference';
import {fixtureGameHelpItem,fixtureEpisode,fixtureGameEpisodeSources} from '../../../packages/runtime/test/fixtures/game-memory.ts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';

async function setup(t:import('node:test').TestContext,retentionMs=60000){
 const root=await mkdtemp(join(tmpdir(),'ls-game-memory-http-')),config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 let now=Date.now(),current=true,meaningful=true,authenticated=true,paused=true,configured=true,helpBoundary=1;const e=fixtureEpisode(now);e.expiresAt=new Date(now+retentionMs).toISOString();e.summary='The gate stayed closed.';e.uncertainty='Hidden cause unknown.';const sources=fixtureGameEpisodeSources(e),records=new Map<string,GameEpisodeSources>([[e.episodeId,sources]]);
 const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex');
 const source:GameEpisodeOptions={maximumFences:8,scopeCurrent:o=>o.principalId===e.scope.principalId&&o.assistantId===e.scope.assistantId&&o.relationshipId===e.scope.relationshipId,quarantined:()=>false,retentionFor:()=>({retentionMs:86400000,retentionPolicyRef:e.retentionPolicyRef,maximumEpisodes:4,maximumBytes:8192}),sourceRecordsFor:episode=>records.get(episode.episodeId)??null,adviceSourceCurrent:(_episode,source)=>authenticated&&source.authenticatedReplyEvidenceRef==='scripted:authenticated-reply',meaningfulGroundingCurrent:()=>meaningful,publicationCurrent:()=>current,retainedSourceCurrent:()=>current,now:()=>now};
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
 const internals=app as unknown as {gameHelp:GameHelpRepository;database:Database;memories:MemoryRepository;providers:{inference:InferenceProvider};};
 const requests:InferenceRequest[]=[];internals.providers.inference={async *generate(input){requests.push(input);yield {kind:'text',text:'Scripted historical reply.'};yield {kind:'done'};}};
 const owner={assistantId,relationshipId},path=`/api/admin/v1/assistants/${assistantId}/relationships/${relationshipId}`;
 await api('/api/runtime/v1/memory',{...owner,enabled:true,expectedRevision:0});
 const original=app.publishGameEpisode(e);assert.ok(original.memoryId);
 const item=fixtureGameHelpItem(e,now);assert.equal(app.publishGameHelp({item,episodeId:e.episodeId,expiresAt:now+30000}).state,'retained');
 const sourceTurnRef=randomUUID(),human=internals.memories.save({id:randomUUID(),assistantId,content:'User stated: Try the recorded gate once.',provenance:{actor:identity.principalId,relationshipId,sourceTurnRef,sourceFamily:`turn:${sourceTurnRef}`,epistemicStatus:'userStatement',transformation:'exact-attributed-quote-v1'},lifecycle:{status:'candidate',revision:1},createdAt:new Date(now).toISOString()});
 assert.ok(internals.memories.transition(assistantId,human.id,'active',identity.principalId,undefined,1));
 const advice:GameEpisodeAdviceSource={adviceRef:'game-advice:'+randomUUID(),helpId:item.helpId,helpRevision:1,memoryId:human.id,memoryRevision:2,sourceTurnRef,sourceSessionRef:randomUUID(),receivedAt:new Date(now).toISOString(),questionDeliveryEvidenceRef:'scripted:question-delivered',authenticatedReplyEvidenceRef:'scripted:authenticated-reply'};
 now+=1000;const derived=fixtureEpisode(now);derived.scope=structuredClone(e.scope);derived.summary='The advised gate attempt remained unresolved.';derived.uncertainty='Advice success is unproved.';derived.adviceRefs=[advice.adviceRef];derived.expiresAt=new Date(now+20000).toISOString();records.set(derived.episodeId,{...fixtureGameEpisodeSources(derived),advice:[advice]});
 const published=app.publishGameEpisode(derived);assert.ok(published.memoryId);
 return {advice,derived,human,published,original,item,help:internals.gameHelp,now:()=>now,unpause:()=>paused=false,unconfigure:()=>configured=false,change:()=>helpBoundary++,app,e,source,sources,internals,requests,request,api,owner,path,identity,withdraw:()=>authenticated=false,advance:(ms:number)=>now+=ms,reply:()=>request('/api/runtime/v1/messages',{...owner,userInput:'Recall the advised gate attempt in our past game.'})};
}

test('advice-bearing historical game memory reaches ordinary authenticated HTTP context with uncertainty and no channel authority',{timeout:15000},async t=>{
 const f=await setup(t);assert.match(await(await f.reply()).text(),/interaction.completed/);
 const request=f.requests.at(-1)!,prepared=request.sections.find(s=>s.kind==='preparedMemory')!.content;
 assert.equal(request.sections.length,9);assert.match(prepared,/The advised gate attempt remained unresolved/);assert.match(prepared,/Advice success is unproved/);assert.match(prepared,/Past simulated game experience/);assert.ok(prepared.includes(f.derived.occurredFrom));assert.ok(prepared.includes(f.derived.scope.timelineId));assert.match(prepared,/not current progress/);
 for(const ref of [f.advice.authenticatedReplyEvidenceRef,f.advice.questionDeliveryEvidenceRef,f.advice.adviceRef,f.item.channelRef,f.item.recipientRef])assert.ok(!prepared.includes(ref));
 const m=f.internals.memories.get(f.owner.assistantId,f.published.memoryId!)!;assert.equal(m.lifecycle.factuality,'unverified');assert.equal(m.lifecycle.lastReinforcedAt,null);assert.equal(m.provenance.sourceTurnRef,undefined);
 assert.equal(f.internals.database.connection.prepare('SELECT count(*) AS n FROM game_start_claims').get()!.n,0);assert.equal(f.help.get({...f.owner,principalId:f.identity.principalId},f.item.helpId)!.item.status,'queued','fixture custody does not manufacture channel delivery');
});

for(const cause of ['humanPrivacyForget','humanCorrection','humanInvalidation','helpForget','originalPrivacyForget','authWithdrawal','expiry','memoryConsent','sharedAudience']as const)test('held advice-bearing ordinary HTTP reply is fenced after '+cause,{timeout:15000},async t=>{
 const f=await setup(t);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);t.after(()=>release());
 f.internals.providers.inference={async*generate(input){f.requests.push(input);entered();await held;yield {kind:'text',text:'LATE_ADVICE_MEMORY_PROSE'};yield {kind:'done'};}};
 const pending=f.reply();await started;assert.match(f.requests[0]!.sections.find(s=>s.kind==='preparedMemory')!.content,/The advised gate attempt remained unresolved/);
 if(cause==='humanPrivacyForget'||cause==='originalPrivacyForget'){
  const relationship=(await f.api(f.path)).relationship,body={action:'forget-derived-information',expectedRevision:relationship.revision,idempotencyKey:randomUUID(),targets:[{kind:'memory',id:cause==='humanPrivacyForget'?f.human.id:f.original.memoryId,revision:2}]};
  assert.equal((await f.request(f.path+'/privacy',body,{'x-lifestream-csrf':'wrong'})).status,403);
  const receipt=(await f.api(f.path+'/privacy',body)).receipt;assert.equal(receipt.status,'completed');assert.equal((await f.api(f.path+'/privacy',body)).receipt.operationId,receipt.operationId);
 }
 if(cause==='humanCorrection'){const p=f.internals.memories.proposeCorrection(f.owner.assistantId,f.human.id,'Corrected synthetic advice',f.identity.principalId)!;assert.ok(f.internals.memories.applyCorrection(f.owner.assistantId,f.human.id,p.revision,2,f.identity.principalId));}
 if(cause==='humanInvalidation')assert.ok(f.internals.memories.transition(f.owner.assistantId,f.human.id,'invalidated',f.identity.principalId,undefined,2));
 if(cause==='helpForget')f.help.forget({...f.owner,principalId:f.identity.principalId},f.item.helpId,1);
 if(cause==='authWithdrawal')f.withdraw();if(cause==='expiry')f.advance(20000);
 if(cause==='memoryConsent')await f.api('/api/runtime/v1/memory',{...f.owner,enabled:false,expectedRevision:1});
 if(cause==='sharedAudience')await f.api('/api/runtime/v1/audience',{mode:'shared',seconds:300});
 release();assert.doesNotMatch(await(await pending).text(),/LATE_ADVICE_MEMORY_PROSE/);
 f.internals.providers.inference={async*generate(input){f.requests.push(input);yield {kind:'text',text:'Safe new reply'};yield {kind:'done'};}};await(await f.reply()).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/The advised gate attempt remained unresolved/);
 if(['humanPrivacyForget','humanCorrection','humanInvalidation','helpForget','originalPrivacyForget'].includes(cause)){
  assert.equal(f.internals.database.connection.prepare('SELECT content FROM memories WHERE id=?').get(f.published.memoryId!)!.content,'');assert.equal(f.internals.database.connection.prepare('SELECT payload_json FROM game_experience_episodes WHERE episode_id=?').get(f.derived.episodeId)!.payload_json,null);assert.equal(f.internals.database.connection.prepare('SELECT source_json FROM game_episode_advice_sources WHERE episode_id=?').get(f.derived.episodeId)!.source_json,null);assert.deepEqual(f.app.publishGameEpisode(f.derived),{state:'unavailable',memoryId:null});
 }
});

test('unknown audience and foreign relationship cannot select advice-bearing personal game recall',{timeout:15000},async t=>{
 const f=await setup(t);await f.api('/api/runtime/v1/audience',{mode:'clear'});await(await f.reply()).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/The advised gate attempt remained unresolved/);
 await f.api('/api/runtime/v1/audience',{mode:'solo',seconds:300});const assistant=await f.api('/api/admin/v1/assistants',{displayName:'Separate synthetic Assistant'});await f.api(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});const other=(await f.api(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).relationship;
 await(await f.request('/api/runtime/v1/messages',{assistantId:assistant.assistantId,relationshipId:other.relationshipId,userInput:'Recall the advised gate attempt in our past game.'})).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/The advised gate attempt remained unresolved/);
});

test('historical advice recall does not inherit a current pause or recipient contact grant',{timeout:15000},async t=>{
 const f=await setup(t);f.unpause();f.unconfigure();f.change();await(await f.reply()).text();
 assert.match(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/The advised gate attempt remained unresolved/);
 f.withdraw();f.source.adviceSourceCurrent=()=>true;await(await f.reply()).text();
 assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/The advised gate attempt remained unresolved/,'captured historical authentication cannot be replaced by mutating caller options');
});
