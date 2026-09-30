import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,MemoryRepository,GameExperienceRepository,CampaignJournalRepository} from '@lifestream/storage-sqlite';
import type * as G from '@lifestream/contracts/game-activity';
import {createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn} from '@lifestream/runtime/inference/prompt';
import {selectGameCampaignContext,prepareGameCampaignContext,gameDecisionInput} from '@lifestream/runtime/activity/game-journal';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import {fixtureEpisode,fixtureGameEpisodeSources,projection} from '../../../packages/runtime/test/fixtures/game-memory.ts';
import {correlateGameLineage,replayGameLineage,type GameLineageInput} from '../src/runtime/game-lineage.ts';
import {evaluateLocalGameFile} from '../../../scripts/qualify-local-game.mjs';

function fixture(t:import('node:test').TestContext){
 const f=gameCampaignFixture(),scope=f.input.expectedScope,owner={principalId:scope.principalId,assistantId:scope.assistantId,relationshipId:scope.relationshipId!},db=new Database({path:':memory:'});db.migrate();t.after(()=>db.close());
 const journal=new CampaignJournalRepository(db,{maxJournals:4,maxEntryIdentities:32,maxSourceFences:64,maxJournalBytes:32768,scopeCurrent:()=>true,quarantined:()=>false,policyFor:()=>({enabled:true,revision:1,retentionMs:86400000,retentionPolicyRef:f.input.journal.retentionPolicyRef}),allowCreate:()=>true,journalCurrent:()=>true,sourceCurrent:()=>true,now:()=>f.input.nowMs});
 journal.put(owner,f.input.journal,0);f.input.journal=journal.get(owner,f.input.journal.journalId)!;f.input.binding.journal=f.input.journal;
 const context=scope.contextBinding,binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{...owner,conversationId:context.conversationId,sessionId:context.sessionId,endpointId:context.endpointId},conversation:'[]',sourceRevisions:{journal:String(f.input.journal.revision)}}),game=prepareGameCampaignContext(selectGameCampaignContext(f.input,f.boundary),binding);
 const turn=finalizePreparedTurn({assistantId:owner.assistantId,sessionId:context.sessionId,endpointId:context.endpointId,interactionId:randomUUID(),origin:'activityStep',conversation:'[]',preparedTurnBinding:binding,preparedGameCampaignContext:game},()=>true),request=requestForFinalizedTurn(turn,binding,()=>true),decision=gameDecisionInput(game,binding,request,100,f.input.nowMs,f.input.freshUntilMs);
 const now=f.input.nowMs+1000,e=fixtureEpisode(now);e.scope=structuredClone(scope);e.summary='PRIVATE_SCRIPTED_GAME_SUMMARY';e.uncertainty='PRIVATE_SCRIPTED_UNCERTAINTY';const sources=fixtureGameEpisodeSources(e),action=sources.actions[0]!;
 const proposal:G.GameActionProposal={schemaVersion:'1.0.0',recordType:'gameActionProposal',scope,proposalId:action.proposalId,observationId:decision.observationId,observationRevision:decision.observationRevision,preparedViewId:decision.viewId,preparedViewRevision:decision.viewRevision,invalidationKey:decision.invalidationKey,buttons:['a'],durationFrames:10,maxWallMs:2000,expectedVisibleOutcome:'PRIVATE_SCRIPTED_EXPECTATION',uncertainty:'Not native gameplay.',adviceRefs:[],reason:'PRIVATE_SCRIPTED_REASON',preconditions:[{predicateId:randomUUID(),fieldId:'scripted-visible-field',expectedValue:'open',sourceObservationId:decision.observationId}]};
 const admission:G.GameAdmission={admissionId:action.admissionId,capabilityInvocationId:randomUUID(),authorityContextRef:{providerRef:'PRIVATE_SCRIPTED_AUTHORITY',contextId:randomUUID(),revision:1},dispatchReceipt:{reference:'PRIVATE_SCRIPTED_DISPATCH',sha256:'c'.repeat(64),mediaType:'application/json',schemaRef:'scripted:dispatch',byteLength:100},scopeDigest:'d'.repeat(64),inputDigest:action.inputDigest,policyRevision:1,issuedAt:decision.selectedAt,expiresAt:decision.freshUntil};
 db.connection.prepare('INSERT INTO automatic_memory_policies VALUES(?,?,?,?,?,?,?)').run('scripted:explicit-memory',owner.principalId,owner.assistantId,owner.relationshipId,1,1,new Date(now).toISOString());
 const repository=new GameExperienceRepository(db,{maximumFences:16,scopeCurrent:()=>true,quarantined:()=>false,retentionFor:()=>({retentionMs:86400000,retentionPolicyRef:e.retentionPolicyRef,maximumEpisodes:4,maximumBytes:8192}),sourceRecordsFor:()=>sources,meaningfulGroundingCurrent:()=>true,publicationCurrent:()=>true,retainedSourceCurrent:()=>true,now:()=>now});
 assert.equal(repository.admit(e),true);const memories=new MemoryRepository(db,repository.memorySources(4)),saved=memories.saveGameProjection(projection(e,now));assert.ok(memories.activateGameCandidate(owner.assistantId,saved.id,owner.principalId,1));
 const input:GameLineageInput={decisions:[decision],proposals:[proposal],admissions:[admission],actions:sources.actions,observations:[f.input.observation,...sources.observations],campaigns:[f.input.binding],episodes:[repository.get(owner,e.episodeId)!],projections:[{schemaVersion:'1.0.0',recordType:'gameMemoryProjection',episode:e,memoryRecord:memories.get(owner.assistantId,saved.id)!.provenance.canonical} as G.GameMemoryProjection],terminalEpisodes:[]};
 return {input,repository,memories,owner,db,request};
}

test('actual prepared request and isolated SQLite journal/source/projection join scripted receipts without native acceptance',t=>{
 const f=fixture(t),r=correlateGameLineage(f.input);assert.equal(f.request.sections.length,9);assert.deepEqual(r.contradictions,[]);assert.deepEqual(r.missingEvidence,[]);assert.equal(r.status,'partialDiagnosticCorrelation');assert.equal(r.nativeEffectsProved,false);assert.equal(r.sourceCurrencyProved,false);assert.equal(r.claimsRuntimeAcceptance,false);assert.equal(r.events.filter(e=>e.kind==='memoryProjection').length,1);assert.ok(r.qualificationGaps.some(g=>g.includes('Linux/Windows')));const serialized=JSON.stringify(r);for(const secret of ['PRIVATE_',f.owner.principalId,f.input.episodes[0]!.summary,f.input.observations[1]!.facts[0]!.description])assert.ok(!serialized.includes(secret));
});

test('isolated game metadata replay pins artifact and creates new IDs without affecting memory or ledger',async t=>{
 const f=fixture(t),before=JSON.stringify(f.input),rows=f.db.connection.prepare('SELECT count(*) AS n FROM memories').get()!.n,r=await replayGameLineage(f.input),again=await replayGameLineage(f.input);assert.equal(r.comparison.equal,true);assert.notEqual(r.manifest.replayId,again.manifest.replayId);assert.equal(r.manifest.liveRoute,false);assert.ok(r.events.every((e,i)=>e.id!==r.comparison.sourceEventIds[i]&&e.sourceEventIds?.[0]===r.comparison.sourceEventIds[i]));assert.equal(r.durableReinforcement,false);assert.equal(r.liveEffects,false);assert.equal(r.perceptionReplayed,false);assert.equal(JSON.stringify(f.input),before);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM memories').get()!.n,rows);assert.equal(r.events.find(e=>e.payload.kind==='retainedEpisode')!.payload.occurredFrom,f.input.episodes[0]!.occurredFrom);
});

const mutations:readonly [string,(v:any)=>void,string][]=[
 ['decision source',v=>v.decisions[0].observationRevision++,'decisionObservationMismatch'],
 ['campaign scope',v=>v.campaigns[0].scope.timelineId=randomUUID(),'decisionCampaignMismatch'],
 ['proposal identity',v=>v.proposals[0].invalidationKey=randomUUID(),'proposalDecisionMismatch'],
 ['input digest',v=>v.admissions[0].inputDigest='f'.repeat(64),'actionAdmissionMismatch'],
 ['expired admission',v=>v.admissions[0].expiresAt=v.actions[0].startedAt,'actionAdmissionMismatch'],
 ['wrong frame delta',v=>v.actions[0].framesApplied--,'actionFrameClockMismatch'],
 ['exceeded frame command',v=>v.proposals[0].durationFrames=1,'actionProposalMismatch'],
 ['foreign result',v=>v.observations[1].scope.relationshipId=randomUUID(),'actionResultObservationMismatch'],
 ['wrong result frame',v=>{v.observations[1].frameNumber--;v.observations[1].screenshots[0].frameNumber--;},'actionResultObservationMismatch'],
 ['detached screenshot',v=>v.observations[1].facts[0].sourceScreenshotIds=[randomUUID()],'observationSourceMismatch'],
 ['episode pins',v=>{v.episodes[0].pinsDigest='f'.repeat(64);v.projections=[];},'episodeObservationMismatch'],
 ['unstarted effect',v=>{v.actions[0].startedAt=null;v.actions[0].completedAt=null;},'actionMilestoneMismatch'],
 ['terminal revision',v=>v.terminalEpisodes=[{episodeId:v.episodes[0].episodeId,revision:1,state:'forgotten'}],'terminalEpisodeRevisionMismatch']
];
for(const [name,mutate,code] of mutations)test(`supplied game ${name} exposes contradictory lineage without effect authority`,t=>{const f=fixture(t),input=JSON.parse(JSON.stringify(f.input));mutate(input);const r=correlateGameLineage(input);assert.ok(r.contradictions.includes(code));assert.equal(r.status,'contradictoryMetadata');assert.equal(r.nativeEffectsProved,false);assert.equal(r.claimsRuntimeAcceptance,false);});

test('missing admission, outcome, custody and control release stay explicit rather than imply completion',t=>{
 const f=fixture(t),input=JSON.parse(JSON.stringify(f.input));input.admissions=[];input.actions[0].resultingObservationIds=[];input.actions[0].buttonsNeutralized=false;input.observations=input.observations.slice(0,1);const r=correlateGameLineage(input);assert.deepEqual(r.contradictions,[]);assert.ok(r.missingEvidence.includes('actionAdmissionMissing'));assert.ok(r.missingEvidence.includes('actionResultObservationMissing'));assert.ok(r.missingEvidence.includes('completedActionReleaseMissing'));assert.ok(r.missingEvidence.includes('episodeObservationMissing'));assert.equal(r.nativeEffectsProved,false);
});

test('newer source forgetting suppresses episode/projection replay and cannot reactivate actual memory',async t=>{
 const f=fixture(t),e=f.input.episodes[0]!;f.repository.forget(f.owner,e.episodeId,e.revision);const row=f.repository.inspect(f.owner)[0]!;assert.equal(row.episode,null);const r=await replayGameLineage({...f.input,terminalEpisodes:[{episodeId:e.episodeId,revision:row.revision,state:'forgotten'}]});assert.deepEqual(r.correlation.contradictions,[]);assert.ok(r.events.every(e=>!['retainedEpisode','memoryProjection'].includes(e.payload.kind as string)));assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,0);assert.equal(r.durableReinforcement,false);
});

test('closed bounded game snapshot rejects getters, proxies, cycles, raw/save secrets and invented authority',t=>{
 const f=fixture(t),input=f.input;let calls=0;const getter={...input};Object.defineProperty(getter,'actions',{enumerable:true,get(){calls++;return input.actions;}});assert.throws(()=>correlateGameLineage(getter));assert.equal(calls,0);const cyclic:any={...input};cyclic.self=cyclic;
 for(const value of [new Proxy(input,{}),cyclic,{...input,rawSave:'PRIVATE_SAVE'}, {...input,actions:Array(33).fill(input.actions[0])},{...input,actions:[...input.actions,...input.actions]}])assert.throws(()=>correlateGameLineage(value));
 for(const mutate of [(v:any)=>v.actions[0].authority=true,(v:any)=>v.observations[0].rawScreenshot='PRIVATE_FRAME',(v:any)=>v.campaigns[0].ordinarySaveArtifact.emulatorSnapshot='PRIVATE_STATE',(v:any)=>v.projections[0].memoryRecord.confidence=1]){const v=JSON.parse(JSON.stringify(input));mutate(v);assert.throws(()=>correlateGameLineage(v));}
});

test('offline local game file qualifier retains exact input/source hashes and redacted real SQLite lineage',async t=>{
 const f=fixture(t),dir=await mkdtemp(join(tmpdir(),'game-lineage-actual-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'input.json'),output=join(dir,'report.json');await writeFile(path,JSON.stringify(f.input),{mode:0o600});const result=await evaluateLocalGameFile(path,output),report=JSON.parse(await readFile(output,'utf8'));assert.equal(result.status,'partialDiagnosticCorrelation');assert.equal(result.metadataReplayEqual,true);assert.equal(result.claimsRuntimeAcceptance,false);assert.deepEqual(report.correlation.contradictions,[]);assert.deepEqual(report.correlation.missingEvidence,[]);assert.doesNotMatch(JSON.stringify(report),/PRIVATE_|ownerPermissionRef|rawSave/);assert.equal(f.memories.contextRecords(f.owner.assistantId,f.owner.principalId).length,1);
});

test('retained advice refs expose missing authenticated custody rather than a successful lesson',t=>{
 const f=fixture(t),input=JSON.parse(JSON.stringify(f.input));input.episodes[0].adviceRefs=['scripted:unqualified-advice'];input.projections=[];const result=correlateGameLineage(input);assert.deepEqual(result.contradictions,[]);assert.ok(result.missingEvidence.includes('authenticatedAdviceCustodyMissing'));assert.equal(result.nativeEffectsProved,false);assert.equal(result.sourceCurrencyProved,false);
});

test('result previous-action references cannot borrow an unstarted or foreign timeline receipt',t=>{
 const f=fixture(t),input=JSON.parse(JSON.stringify(f.input));input.actions[0].scope.timelineId=randomUUID();assert.ok(correlateGameLineage(input).contradictions.includes('observationActionMismatch'));
 input.actions[0].scope=input.observations[1].scope;input.actions[0].startedAt=null;input.actions[0].completedAt=null;assert.ok(correlateGameLineage(input).contradictions.includes('observationActionMismatch'));
});

test('metadata command duration and UTC wall timestamps never establish native monotonic performance',t=>{
 const f=fixture(t),input=JSON.parse(JSON.stringify(f.input));input.proposals[0].maxWallMs=1;const result=correlateGameLineage(input);assert.deepEqual(result.contradictions,[]);assert.ok(result.qualificationGaps.some(g=>g.includes('monotonic')));assert.equal(result.nativeEffectsProved,false);
});
