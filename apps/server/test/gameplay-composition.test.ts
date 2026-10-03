// Synthetic local sources only. These tests establish source wiring, not CT,
// actual provider performance, native window, ordinary-save or Human acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join as pathJoin} from 'node:path';
import {Database,ActivityCheckpointRepository,GameExperienceRepository,CampaignJournalRepository,MemoryRepository} from '@lifestream/storage-sqlite';
import type * as G from '@lifestream/contracts/game-activity';
import {createPreparedTurnBinding,type PreparedTurnBinding,type RuntimeSelfContext} from '@lifestream/runtime/inference/prompt';
import {projectGameEpisode} from '@lifestream/runtime/activity/memory';
import {selectGameCampaignContext} from '@lifestream/runtime/activity/game-journal';
import type {InferenceProvider,InferenceRequest} from '@lifestream/runtime/inference';
import {campaignFixtureData} from './fixtures/gameplay.ts';
import {DiscoveryAdministration} from '../src/admin/understanding.ts';
import {createGameplayComposition,type GameplayCompositionOptions} from '../src/runtime/gameplay-composition.ts';
import {createAuthenticatedGameRuntime,captureGameRuntimeOptions,productionGameMemory,qualifiedGameInferenceBounds} from '../src/runtime/game-host-runtime.ts';
import {runCheckpointedGamePlanning,runCheckpointedGameController} from '../src/runtime/game-activity.ts';
import {gameMemoryContextRecord} from '../src/runtime/game-memory.ts';
import type {GameHostJoin} from '../src/runtime/game-host-port.ts';

function fixture(mode:'normal'|'noUsage'|'noConsent'|'noShutdown'|'noFacts'|'wrongModel'='normal',path=':memory:'){
 const f=campaignFixtureData(path),scope=f.scope,statuses:Readonly<Record<string,unknown>>[]=[],requests:InferenceRequest[]=[],episodes:G.GameExperienceEpisode[]=[];
 let live=true,shutdowns=0,controls=0,binding:PreparedTurnBinding;
 let restored:ReturnType<typeof createGameplayComposition>|undefined;
 const retention={policyRevision:1,retention:{retentionMs:3600000,maximumEpisodes:4,maximumBytes:8192,retentionPolicyRef:'test-only:reviewed-game-retention'}};
 f.db.connection.prepare('INSERT INTO local_accounts(principal_id,username,owner,password_verifier,created_at) VALUES(?,?,1,?,?)').run(f.o.principalId,'fixture-only','not-a-credential',Date.now());
 f.db.connection.prepare('INSERT INTO automatic_memory_policies VALUES(?,?,?,?,1,1,?)').run('fixture-only',f.o.principalId,f.o.assistantId,f.o.relationshipId,new Date().toISOString());
 f.observation.facts=mode==='noFacts'?[]:[{factId:randomUUID(),description:'The visible gate remains closed.',epistemicKind:'visibleFeature',sourceScreenshotIds:[f.observation.screenshots[0]!.screenshotId],extractionKind:'screenPixels',extractorRef:null,uncertainty:'The hidden cause is unknown.',limitations:['Synthetic qualified screenshot; no real CT.'],sourceKind:'playerVisibleGameObservation',untrusted:true}];
 f.source.current=()=>live;
 f.source.bindingFor=(_scope,journal,observation)=>({...f.f.input.binding,journal,entryBindings:journal.entries.map(entry=>f.f.input.binding.entryBindings.find(b=>b.entryId===entry.entryId)??{entryId:entry.entryId,runId:scope.runId,timelineId:scope.timelineId,sourceObservationIds:entry.sourceRefs.filter(r=>r.startsWith('game-observation:')).map(r=>r.slice(17)),sourceActionIds:entry.sourceRefs.filter(r=>r.startsWith('game-action:')).map(r=>r.slice(12)),sourceAdviceRefs:[],ordinarySaveDigest:null,currentDisposition:'historical'}),reconciledObservationId:observation.observationId,reconciledAt:observation.receivedAt});
 f.source.observe=async(_join,signal,afterActionId)=>{
  if(signal.aborted)return null;
  const time=new Date().toISOString();f.observation.observationId=randomUUID();f.observation.capturedAt=time;f.observation.receivedAt=time;f.observation.previousActionId=afterActionId??null;
  if(afterActionId)f.observation.frameNumber+=2;
  f.observation.screenshots=f.observation.screenshots.map(s=>({...s,capturedAt:time,frameNumber:f.observation.frameNumber}));
  f.observation.visibleState=f.observation.visibleState.map(v=>({...v,lastObservedRef:f.observation.observationId,observedAt:time,freshUntil:new Date(Date.now()+5000).toISOString()}));
  return structuredClone(f.observation);
 };
 const selected={configurationDigest:'a'.repeat(64),providerRef:'test-only:provider',providerRevision:'test-only:provider:1',model:'test-only:model',modelArtifactDigest:'b'.repeat(64),healthy:true,fixture:false};
 const receipt={schemaVersion:'1.0.0' as const,recordType:'gameInferenceQualification' as const,qualificationRef:'test-only:measured-envelope',selection:selected,process:{pid:123,processStartTicks:'456',binarySha256:'c'.repeat(64),modelSha256:'b'.repeat(64),projectorSha256:null,envelopeDigest:'d'.repeat(64)},preemptionBoundMs:10,slotReleaseBoundMs:250,verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+30000).toISOString()},bytes=Buffer.from(JSON.stringify(receipt));
 const usage=new Map<string,{receipt:G.GameActionReceipt;wallMs:number;completionRef:string}>();
 const native:GameplayCompositionOptions['native']={resolveAttachment:()=>null,bindingCurrent:()=>live,controllerCurrent:()=>live,sourceCurrent:()=>live,sourceAvailable:()=>live,acceptObservation:()=>live,acceptAction:()=>live,reconcileEffect:async()=>false,admitRelease:async()=>false,usageFor:(request,result)=>mode==='noUsage'||result.outcome.payload?.actionId!==request.payload.actionId?null:usage.get(request.payload.actionId)??null,shutdownExactOldLease:async()=>{shutdowns++;return mode!=='noShutdown';}};
 const approval={scope,approvedUntil:new Date(Date.now()+10000).toISOString(),maximumRunMs:10000,maximumPlanningSteps:1,observations:true as const,campaignJournal:true as const,controllerInput:true,memoryEpisodes:true};
 const options:GameplayCompositionOptions={native,nativeEvidence:{qualifyUsage:()=>false,qualifyShutdown:()=>false},maximumOwnedFrames:8,campaign:f.ownerOptions,grounding:{scopeCurrent:()=>true,quarantined:()=>false,retentionFor:()=>mode==='noConsent'?null:retention,maximumFences:4,estimate:()=>({value:0.6,basis:'Synthetic source-to-summary transformation, no perception calibration.',policyRef:'test-only:transformation'})},qualification:{receipt,receiptSha256:createHash('sha256').update(bytes).digest('hex'),readReceipt:()=>bytes,processCurrent:()=>live},resolveApproval:()=>approval,maximumSteps:1,maximumRunMs:10000,maximumCommandMs:1000,onStatus:s=>statuses.push(s)};
 const composition=createGameplayComposition(options,()=>f.db),repository=composition.gameHost.createRepository(f.db),runtimeOptions=captureGameRuntimeOptions(composition.gameRuntime),memory=productionGameMemory(runtimeOptions)!;
 let source=new GameExperienceRepository(f.db,memory.source),memories=new MemoryRepository(f.db,source.memorySources(4));
 const admin=new DiscoveryAdministration(f.db,{snapshot:()=>({boundary:'test-only:composition',configuration:undefined}),evidenceAllowed:()=>false,sourceAllowed:()=>false,forget:()=> 'missing',changed:()=>{}});
 const provider:InferenceProvider={tokenize:async()=>({count:100,identity:'test-only:tokenizer'}),async *generate(request){
  requests.push(request);
  const proposal:G.GameActionProposal={schemaVersion:'1.0.0',recordType:'gameActionProposal',scope,proposalId:randomUUID(),observationId:f.observation.observationId,observationRevision:1,preparedViewId:binding.viewId,preparedViewRevision:binding.revision,invalidationKey:binding.invalidationKey,buttons:['a'],durationFrames:2,maxWallMs:100,expectedVisibleOutcome:'The gate might open.',uncertainty:'Synthetic hypothesis; no result yet.',adviceRefs:[],reason:'Test the visible menu once.',preconditions:[{predicateId:randomUUID(),fieldId:'fixture:visible-menu',expectedValue:'open',sourceObservationId:f.observation.observationId}]};
  yield {kind:'text',text:JSON.stringify(proposal)};yield {kind:'done'};
 }};
 const runtime=createAuthenticatedGameRuntime(scope,runtimeOptions,repository,{current:()=>live,prepare:()=>{
  const c=scope.contextBinding;binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{...f.o,conversationId:c.conversationId,sessionId:c.sessionId,endpointId:c.endpointId},conversation:'[]',sourceRevisions:{journal:'1'}});
  const runtimeSelfContext:RuntimeSelfContext={sourceRevision:'test-only:runtime',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'unavailable',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'unknown',permissionState:'authenticatedSession',limitations:['Synthetic qualified activity, no physical audience or live effects.']};
  return {assistantId:scope.assistantId,preparedTurnBinding:binding,runtimeSelfContext,isCurrent:()=>live};
 },run:(step,repo,publication,current)=>{
  const qualified=qualifiedGameInferenceBounds(runtimeOptions,mode==='wrongModel'?{...selected,model:'other'}:selected);
  return runCheckpointedGamePlanning({...step,provider},{repository:repo,background:admin,...publication,current:(s,c)=>live&&current()&&qualified?.current()===true&&publication.current(s,c),providerRevision:selected.providerRevision,tokenizerIdentity:'test-only:tokenizer',...(qualified?{providerPreemptionBoundMs:qualified.preemptionBoundMs,providerSlotReleaseBoundMs:qualified.slotReleaseBoundMs}:{})});
 },cancel:key=>admin.cancelBackground(key,'scopeInvalidated'),publishEpisode:episode=>{
  episodes.push(episode);if(!source.admit(episode))return {state:'unavailable',memoryId:null};
  const projection=projectGameEpisode({episode,memoryId:randomUUID(),estimate:memory.estimate(episode)!,nowMs:Date.now()},()=>true)!;
  const saved=memories.saveGameProjection(projection),active=memories.activateGameCandidate(scope.assistantId,saved.id,scope.principalId,1);return {state:active?'retained':'unavailable',memoryId:active?.id??null};
 }})!;
 const join:GameHostJoin & {nativeUsageFor:typeof native.usageFor;shutdownExactOldLease:()=>Promise<boolean>}={scope,attachmentId:randomUUID(),runtime,nativeUsageFor:native.usageFor,shutdownExactOldLease:()=>native.shutdownExactOldLease(join),adapter:{} as GameHostJoin['adapter'],runController:(input,ports)=>runCheckpointedGameController(input,{...ports,repository,adapter:{applyController:async request=>{
  controls++;const begin=performance.now(),time=new Date().toISOString(),r:G.GameActionReceipt={schemaVersion:'1.0.0',recordType:'gameActionReceipt',scope,actionId:request.payload.actionId,proposalId:request.payload.proposal.proposalId,idempotencyKey:request.idempotencyKey,inputDigest:request.payload.admission.inputDigest,admissionId:request.payload.admission.admissionId,disposition:'completed',beforeFrame:request.payload.expectedFrameNumber,afterFrame:request.payload.expectedFrameNumber+2,framesApplied:2,buttonsNeutralized:true,startedAt:time,completedAt:time,resultingObservationIds:[],recordedAt:time,reason:null};
  const result:G.GameActionResult={schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:'test-only:native',completedAt:time,outcome:{status:'succeeded',payload:r,error:null}};
  usage.set(r.actionId,{receipt:r,wallMs:Math.ceil(performance.now()-begin),completionRef:'test-only:native-terminal:'+r.actionId});return result;
 }}})};
 return {...f,get db(){return f.db;},options,retention,composition,repository,get episodeSource(){return source;},get memories(){return memories;},runtime,join,statuses,requests,episodes,sourceObserve:()=>f.source.observe(join,new AbortController().signal),sourceBinding:(journal:G.CampaignJournal,observation:G.GameObservation)=>f.source.bindingFor(scope,journal,observation),controls:()=>controls,shutdowns:()=>shutdowns,start:()=>composition.gameHost.onAttached!(join),withdraw:()=>{live=false;},reopen:()=>{admin.close();f.db.close();f.db=new Database({path});f.db.migrate();restored=createGameplayComposition(options,()=>f.db);restored.gameHost.createRepository(f.db);const historical=productionGameMemory(captureGameRuntimeOptions(restored.gameRuntime))!;source=new GameExperienceRepository(f.db,historical.source);memories=new MemoryRepository(f.db,source.memorySources(4));return new ActivityCheckpointRepository(f.db,f.ownerOptions.metadata);},close:async()=>{await composition.stop();await restored?.stop();admin.close();f.db.close();}};
}

test('synthetic prepared planning -> measured controller settlement -> actual fresh view -> durable journal -> governed episode and later historical recall',async t=>{
 const f=fixture();t.after(()=>f.close());assert.ok(f.runtime);f.start();await f.composition.completion();
 assert.equal(f.requests.length,1,JSON.stringify(f.statuses));assert.equal(f.controls(),1);assert.equal(f.shutdowns(),1);assert.equal(f.episodes.length,1);assert.equal(f.statuses.find(s=>s.state==='episodePublication')?.retained,true,JSON.stringify(f.statuses));
 const row=f.repository.get(f.o,f.scope.runId)!;assert.equal(row.used.modelCalls,1);assert.equal(row.used.actions,1);assert.equal(row.used.frames,2);assert.equal(row.checkpoint.campaignJournalRef.revision,3);assert.equal(row.checkpoint.saveArtifact,null);
 const journal=new CampaignJournalRepository(f.db,f.journalOptions).get(f.o,row.checkpoint.campaignJournalRef.journalId)!;
 assert.ok(journal.entries.some(e=>e.kind==='currentSituation'&&e.content==='The visible gate remains closed.'));
 assert.ok(journal.entries.some(e=>e.kind==='sessionSummary'&&e.content.includes('remains closed')));
 assert.equal(journal.goals.some(g=>g.status==='completed'),false,'dispatch success cannot complete a goal');
 assert.equal(f.runtime.isCurrent(),false,'completion removes live authority');
 const episode=f.episodeSource.get(f.o,f.episodes[0]!.episodeId)!;assert.ok(episode);assert.match(episode.summary,/remains closed/);assert.doesNotMatch(episode.summary,/gate might open/);assert.equal(episode.rawEvidenceAvailability,'notRetained');
 const memoryId=f.db.connection.prepare('SELECT id FROM memories').get()!.id as string,record=f.memories.get(f.scope.assistantId,memoryId)!;assert.ok(record);
 assert.match(gameMemoryContextRecord(record).content,/Historical game memory/);assert.match(gameMemoryContextRecord(record).content,/remains closed/);
 // A later selection must reconcile all new journal entries rather than pretend
 // its earlier save contains this attempt. Source bindings are historical here.
 const observation=(await f.sourceObserve())!,binding=f.sourceBinding(journal,observation);
 assert.ok(binding);const selected=selectGameCampaignContext({...f.f.input,binding:binding!,journal,observation,nowMs:Date.now(),freshUntilMs:Date.now()+2000},f.source.campaignBoundary);assert.equal(selected.status,'selected');assert.match(selected.content!,/remains closed/);
 f.episodeSource.forget(f.o,episode.episodeId,1);assert.equal(f.episodeSource.get(f.o,episode.episodeId),null);const erased=f.memories.get(f.scope.assistantId,memoryId)!;assert.equal(erased.content,'');assert.equal(erased.lifecycle.contentRemoved,true);assert.equal(erased.provenance.payloadRemoved,true);assert.equal(f.db.connection.prepare('SELECT content FROM memories WHERE id=?').get(memoryId)!.content,'');
});

test('missing native usage preserves held reservation and cannot record a journal outcome or memory',async t=>{
 const f=fixture('noUsage');t.after(()=>f.close());f.start();await f.composition.completion();assert.equal(f.controls(),1);assert.equal(f.episodes.length,0);assert.equal(f.repository.get(f.o,f.scope.runId)!.used.actions,0);assert.equal(f.db.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'reserved');assert.equal(f.repository.get(f.o,f.scope.runId)!.checkpoint.campaignJournalRef.revision,1);assert.equal(f.statuses.some(s=>s.state==='requiresReconciliation'),true);
});

test('composition requires explicit trusted native evidence ports and finite frame capacity before allocating repositories',async t=>{
 const f=fixture();t.after(()=>f.close());let databaseCalls=0;
 for(const patch of [{nativeEvidence:undefined},{nativeEvidence:{qualifyUsage:()=>true}},{maximumOwnedFrames:0},{maximumOwnedFrames:65}])assert.throws(()=>createGameplayComposition({...f.options,...patch} as GameplayCompositionOptions,()=>{databaseCalls++;return f.db;}),/Missing qualified native evidence/);
 assert.equal(databaseCalls,0);assert.equal(f.controls(),0);assert.equal(f.shutdowns(),0);
});
test('missing consent or meaningful visual facts still records truthful controller history without memory',async t=>{
 for(const mode of ['noConsent','noFacts'] as const){const f=fixture(mode);try{f.start();await f.composition.completion();assert.equal(f.controls(),1);assert.equal(f.episodes.length,0);assert.equal(f.repository.get(f.o,f.scope.runId)!.checkpoint.campaignJournalRef.revision,2);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM memories').get()!.n,0);}finally{await f.close();}}
});
test('wrong selected model refuses inference; unconfirmed native shutdown never reports confirmed stop',async t=>{
 const f=fixture('wrongModel');t.after(()=>f.close());f.start();await f.composition.completion();assert.equal(f.requests.length,0);assert.equal(f.controls(),0);assert.equal(f.episodes.length,0);
 const g=fixture('noShutdown');t.after(()=>g.close());g.start();await g.composition.completion();assert.equal(g.shutdowns(),1);assert.equal(g.statuses.find(s=>s.nativeShutdownConfirmed===false)?.state,'requiresReconciliation');assert.equal(g.statuses.some(s=>s.nativeShutdownConfirmed===true),false);
});

test('actual SQLite reopen preserves historical episode/journal and consumed budget without restoring live play authority',async t=>{
 const directory=mkdtempSync(pathJoin(tmpdir(),'gameplay-source-reopen-')),f=fixture('normal',pathJoin(directory,'state.sqlite'));t.after(async()=>{await f.close();rmSync(directory,{recursive:true,force:true});});
 f.start();await f.composition.completion();assert.equal(f.episodes.length,1);const id=f.episodes[0]!.episodeId;
 const reopened=f.reopen(),row=reopened.get(f.o,f.scope.runId)!;assert.equal(row.used.actions,1);assert.equal(row.used.modelCalls,1);assert.equal(row.used.frames,2);
 assert.match(f.episodeSource.get(f.o,id)!.summary,/remains closed/);assert.equal(f.runtime.isCurrent(),false);assert.throws(f.start,/Authenticated game runtime unavailable/);assert.equal(f.controls(),1);assert.equal(f.shutdowns(),1);
 const journal=new CampaignJournalRepository(f.db,f.journalOptions).peekCurrent(f.o,row.checkpoint.campaignJournalRef.journalId)!;assert.equal(journal.revision,3);assert.ok(journal.entries.some(e=>e.sourceRefs.includes('game-episode:'+id)));
});

test('forgetting a grounded journal fact removes dependent episode and derived payload before historical reuse',async t=>{
 const f=fixture();t.after(()=>f.close());f.start();await f.composition.completion();assert.equal(f.episodes.length,1);
 const id=f.episodes[0]!.episodeId,row=f.repository.get(f.o,f.scope.runId)!,journal=new CampaignJournalRepository(f.db,f.journalOptions);
 const fact=journal.get(f.o,row.checkpoint.campaignJournalRef.journalId)!.entries.find(e=>e.sourceRefs.some(r=>r.startsWith('game-fact:')))!;
 journal.forgetSource(f.o,fact.sourceRefs.find(r=>r.startsWith('game-fact:'))!);
 assert.equal(f.episodeSource.get(f.o,id),null);assert.equal(f.db.connection.prepare('SELECT payload_json FROM game_experience_episodes WHERE episode_id=?').get(id)!.payload_json,null);
 const raw=f.db.connection.prepare('SELECT content,lifecycle_json,provenance_json FROM memories').get()!;assert.equal(raw.content,'');assert.equal(JSON.parse(raw.lifecycle_json as string).contentRemoved,true);assert.equal(JSON.parse(raw.provenance_json as string).payloadRemoved,true);
});

test('retention cannot exceed the independently approved four x8192 bytes /one hour ceiling',async()=>{
 for(const [key,value] of [['maximumEpisodes',5],['maximumBytes',8193],['retentionMs',3600001]] as const){const f=fixture();try{f.retention.retention[key]=value;f.start();await f.composition.completion();assert.equal(f.controls(),1);assert.equal(f.episodes.length,0);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM game_experience_episodes').get()!.n,0);}finally{await f.close();}}
});

test('journal custody predicate is read-only inside episode admission transaction and immediately rejects source fences',async t=>{
 const f=fixture();t.after(()=>f.close());f.start();await f.composition.completion();const row=f.repository.get(f.o,f.scope.runId)!,journal=new CampaignJournalRepository(f.db,f.journalOptions);
 const changes=f.db.connection.prepare('SELECT total_changes() AS n').get()!.n;
 f.db.transaction(()=>assert.ok(journal.peekCurrent(f.o,row.checkpoint.campaignJournalRef.journalId)));
 assert.equal(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n,changes);
 journal.forgetSource(f.o,'game-observation:'+f.episodes[0]!.sourceObservationIds[0]);
 f.db.transaction(()=>assert.equal(journal.peekCurrent(f.o,row.checkpoint.campaignJournalRef.journalId)?.entries.some(e=>e.sourceRefs.includes('game-episode:'+f.episodes[0]!.episodeId))??false,false));
});

test('gameplay refuses an unjoined legacy host and never falls back to configured generic native evidence callbacks',async t=>{
 const f=fixture();t.after(()=>f.close());delete (f.join as any).nativeUsageFor;
 assert.throws(f.start,/Joined native evidence unavailable/);assert.equal(f.runtime.isCurrent(),false);assert.equal(f.requests.length,0);assert.equal(f.controls(),0);assert.equal(f.episodes.length,0);assert.equal(f.shutdowns(),0);
});
