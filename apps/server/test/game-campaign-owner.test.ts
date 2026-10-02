import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type * as G from '@lifestream/contracts/game-activity';
import {Database,GameStartRepository,CampaignJournalRepository,type ActivityMetadataOptions,type CampaignJournalOptions} from '@lifestream/storage-sqlite';
import {selectGameWindow} from '@lifestream/runtime/activity/policy';
import {prepareGameCampaignContext,gameDecisionInput} from '@lifestream/runtime/activity/game-journal';
import {createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn} from '@lifestream/runtime/inference/prompt';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import {scriptedGameBounds,scriptedGamePolicy} from '../../../packages/runtime/test/fixtures/game-policy.ts';
import {createGameCampaignOwner,type GameCampaignOwnerSource} from '../src/runtime/game-campaign-owner.ts';
import type {GameHostJoin} from '../src/runtime/game-host-port.ts';
import type {PreparedHostGameStep} from '../src/runtime/game-host-runtime.ts';

function fixture(){
 const f=gameCampaignFixture(),scope=f.input.expectedScope,o={principalId:scope.principalId,assistantId:scope.assistantId,relationshipId:scope.relationshipId!};
 let current=true,retention:{policyRevision:number;retention:{retentionMs:number;maximumEpisodes:number;maximumBytes:number;retentionPolicyRef:string}}|null=null;
 const bounds=structuredClone(scriptedGameBounds),policy=scriptedGamePolicy(Date.now());
 const metadata:ActivityMetadataOptions={maxRuns:4,maxReservations:8,maxControllerReservations:8,maxCheckpointBytes:32768,scopeCurrent:()=>current,quarantined:()=>false,policyFor:()=>({enabled:true,revision:1,retentionMs:3600000,bounds}),allowCreate:()=>current,checkpointCurrent:()=>current,transitionCurrent:()=>current,planningCurrent:()=>current,usageCurrent:()=>current,controllerCurrent:()=>current,controllerUsageCurrent:()=>current};
 const journalOptions:CampaignJournalOptions={maxJournals:4,maxEntryIdentities:32,maxSourceFences:64,maxJournalBytes:32768,scopeCurrent:()=>current,quarantined:()=>false,policyFor:()=>({enabled:true,revision:1,retentionMs:3600000,retentionPolicyRef:f.input.journal.retentionPolicyRef}),allowCreate:()=>current,sourceCurrent:()=>current,journalCurrent:()=>current};
 const checkpoint:G.ActivityCheckpoint={schemaVersion:'1.0.0',recordType:'activityCheckpoint',scope,checkpointId:randomUUID(),revision:1,stateRevision:1,policyRevision:1,pinsDigest:f.input.pinsDigest,goalSummary:'Deterministic fixture only; no CT progress.',recentObservationIds:[f.input.observation.observationId],adviceRefs:[],lastObservationId:f.input.observation.observationId,lastActionReceipt:null,saveArtifact:null,budgetUsed:{wallMs:0,frames:0,actions:0,starts:1,equivalentFailures:0,modelCalls:0,inputTokens:0,outputTokens:0,retries:0,checkpointBytes:0,memoryEpisodes:0},recordedAt:new Date().toISOString(),resumeDisposition:'requiresReconciliation',campaignJournalRef:{campaignId:scope.campaignId,journalId:f.input.journal.journalId,revision:1,accessRevision:1}};
 const planningBounds={deadlineMs:3000,maximumInputTokens:8192,maximumOutputTokens:1024,maximumOutputBytes:16384,maximumChunks:256};
 const observation=structuredClone(f.input.observation);
 observation.visibleState=[{fieldId:'fixture:visible-menu',value:'open',visibility:'visibleNow',firstObservedRef:observation.observationId,lastObservedRef:observation.observationId,timelineId:scope.timelineId,observedAt:observation.receivedAt,freshUntil:new Date(Date.now()+5000).toISOString(),decoderRevision:'1.0.0',manifestDigest:f.input.pinsDigest,limitations:['Scripted field; no native decoder qualification.']}];
 const source:GameCampaignOwnerSource={current:()=>current,startFor:()=>({policy,bounds,window:selectGameWindow({scope,policy,bounds,purpose:'play',nowMs:Date.now()},{policyCurrent:()=>current}),checkpoint,journal:f.input.journal}),observe:async(_join,_signal,afterActionId)=>{const observed=structuredClone(observation);if(afterActionId){observed.observationId=randomUUID();observed.previousActionId=afterActionId;observed.frameNumber+=2;observed.capturedAt=new Date().toISOString();observed.receivedAt=observed.capturedAt;observed.screenshots=observed.screenshots.map(s=>({...s,frameNumber:observed.frameNumber,capturedAt:observed.capturedAt}));}return observed;},bindingFor:(_scope,journal,obs)=>({...f.input.binding,journal,reconciledObservationId:obs.observationId}),campaignBoundary:{...f.boundary,now:Date.now},dispatchBoundary:{maxPlanningAgeMs:30000,maxPlanningFrameDelta:120,maximumObservationAgeMs:10000,validatorRef:'fixture:dispatch',observationCurrent:()=>current,now:Date.now},planningTerminalCurrent:()=>current,settledSourceCurrent:()=>current,retentionFor:()=>retention,requestFor:async(_join,result,dispatch,obs)=>({schemaVersion:'1.0.0',operation:'GameActivityAdapter.applyController',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+3000).toISOString(),cancellationId:randomUUID(),executionMode:'simulation',scope,idempotencyKey:randomUUID(),payload:{actionId:randomUUID(),proposal:result.proposal!,admission:{admissionId:randomUUID(),capabilityInvocationId:randomUUID(),authorityContextRef:{providerRef:'fixture:authority',contextId:randomUUID(),revision:1},dispatchReceipt:{reference:'fixture:receipt',sha256:'a'.repeat(64),mediaType:'application/json',schemaRef:'fixture:receipt',byteLength:1},scopeDigest:'a'.repeat(64),inputDigest:'a'.repeat(64),policyRevision:1,issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3000).toISOString()},inputOwnerLeaseId:randomUUID(),buttonVector:{up:false,down:false,left:false,right:false,a:true,b:false,x:false,y:false,l:false,r:false,start:false,select:false},protectedMenuOperation:'none',expectedFrameNumber:obs.frameNumber,expectedPinsDigest:f.input.pinsDigest,dispatchValidation:dispatch}})};
 const host=createGameCampaignOwner({metadata,journal:journalOptions,startsFor:db=>new GameStartRepository(db,{maxClaims:8,maxAssistantSlots:4,limitsFor:()=>({enabled:true,revision:1,rollingPeriodMs:3600000,rollingStartLimit:2,startsPerWindow:1}),quarantined:()=>false,admissionCurrent:()=>current,inspectionCurrent:()=>current,dispositionCurrent:()=>current}),source,planningBounds,maximumObservationAgeMs:10000,maximumContextBytes:16384});
 const db=new Database({path:':memory:'});db.migrate();const repository=host.createRepository(db);
 const join={scope,runtime:{isCurrent:()=>current,controllerCurrent:()=>current}} as GameHostJoin;
 return {f,scope,o,db,host,repository,join,source,checkpoint,journalOptions,observation,planningBounds,setRetention:(value:typeof retention)=>{retention=value;},withdraw:()=>{current=false;}};
}

test('actual SQLite start claim and selected campaign context are owned once, never re-created by missing runtime authority',async t=>{
 const f=fixture();t.after(()=>f.db.close());
 const selected=await f.host.campaign.selectPlanning(f.join,f.repository,new AbortController().signal);assert.ok(selected);assert.equal(selected.selection.status,'selected');
 assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM game_start_claims').get()!.n,1);
 assert.ok(f.repository.get(f.o,f.scope.runId));
 assert.ok(await f.host.campaign.selectPlanning(f.join,f.repository,new AbortController().signal));
 assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM game_start_claims').get()!.n,1);
 assert.throws(()=>f.host.createRepository(f.db),/Second campaign owner/);
 f.withdraw();assert.equal(await f.host.campaign.selectPlanning(f.join,f.repository,new AbortController().signal),null);
});

test('existing scoped enabled policy requires explicit valid retention and active owner; withdrawal and callback replacement fail closed',t=>{
 const f=fixture();t.after(()=>f.db.close());const valid={policyRevision:1,retention:{retentionMs:3600000,maximumEpisodes:4,maximumBytes:8192,retentionPolicyRef:'fixture:independent-retention'}};
 f.db.connection.prepare('INSERT INTO local_accounts(principal_id,username,owner,password_verifier,created_at) VALUES(?,?,1,?,?)').run(f.o.principalId,'fixture-only','not-a-credential',Date.now());
 f.db.connection.prepare('INSERT INTO automatic_memory_policies VALUES(?,?,?,?,1,1,?)').run('fixture-only',f.o.principalId,f.o.assistantId,f.o.relationshipId,new Date().toISOString());
 assert.equal(f.host.retentionConsentRefFor(f.o,f.scope.activityId),null);f.setRetention(valid);assert.equal(f.host.retentionConsentRefFor(f.o,f.scope.activityId),valid.retention.retentionPolicyRef);
 for(const [key,value] of [['retentionMs',0],['retentionMs',2147483648],['maximumEpisodes',129],['maximumBytes',16385],['retentionPolicyRef',' ']] as const){f.setRetention({...valid,retention:{...valid.retention,[key]:value}});assert.equal(f.host.retentionConsentRefFor(f.o,f.scope.activityId),null);}
 f.setRetention({...valid,policyRevision:2});assert.equal(f.host.retentionConsentRefFor(f.o,f.scope.activityId),null);
 f.setRetention(valid);f.db.connection.prepare('UPDATE automatic_memory_policies SET enabled=0').run();assert.equal(f.host.retentionConsentRefFor(f.o,f.scope.activityId),null);
 f.db.connection.prepare('UPDATE automatic_memory_policies SET enabled=1').run();f.db.connection.prepare('UPDATE local_accounts SET disabled=1').run();assert.equal(f.host.retentionConsentRefFor(f.o,f.scope.activityId),null);
 f.db.connection.prepare('UPDATE local_accounts SET disabled=0').run();f.source.current=()=>true;assert.equal(f.host.retentionConsentRefFor(f.o,f.scope.activityId),null);
});

test('genuine planning identity settles once, freshly dispatches, journals only actual settled SQLite usage and updates checkpoint readback',async t=>{
 const f=fixture();t.after(()=>f.db.close());const selected=(await f.host.campaign.selectPlanning(f.join,f.repository,new AbortController().signal))!;assert.ok(selected);
 const c=f.scope.contextBinding,binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{...f.o,conversationId:c.conversationId,sessionId:c.sessionId,endpointId:c.endpointId},conversation:'[]',sourceRevisions:{journal:'1'}}),game=prepareGameCampaignContext(selected.selection,binding),turn=finalizePreparedTurn({assistantId:f.scope.assistantId,sessionId:c.sessionId,endpointId:c.endpointId,interactionId:randomUUID(),origin:'activityStep',conversation:'[]',preparedTurnBinding:binding,preparedGameCampaignContext:game,deadlineAt:new Date(Date.now()+3000).toISOString()},()=>true),decision=gameDecisionInput(game,binding,requestForFinalizedTurn(turn,binding,()=>true),100,Date.now(),Date.now()+2000);
 const step:PreparedHostGameStep={scope:f.scope,binding,game,turn,bounds:f.planningBounds};
 const proposal:G.GameActionProposal={schemaVersion:'1.0.0',recordType:'gameActionProposal',scope:f.scope,proposalId:randomUUID(),observationId:decision.observationId,observationRevision:decision.observationRevision,preparedViewId:binding.viewId,preparedViewRevision:binding.revision,invalidationKey:binding.invalidationKey,buttons:['a'],durationFrames:2,maxWallMs:100,expectedVisibleOutcome:'Fixture menu might change.',uncertainty:'No actual game.',adviceRefs:[],reason:'Scripted visible-state decision.',preconditions:[{predicateId:randomUUID(),fieldId:'fixture:visible-menu',expectedValue:'open',sourceObservationId:decision.observationId}]};
 const result={decisionInput:decision,proposal,inputTokens:100,outputTokens:10,tokenizerIdentity:'fixture:tokenizer'};
 const reservation={viewId:binding.viewId,viewRevision:binding.revision,invalidationKey:binding.invalidationKey,providerRevision:'fixture:provider',maximumInputTokens:8192,maximumOutputTokens:1024};
 assert.equal(f.repository.reservePlanning(f.o,f.scope,reservation),true);
 assert.equal(f.host.campaign.terminalRef({...result,decisionInput:structuredClone(decision)},step),null);
 const ref=f.host.campaign.terminalRef(result,step);assert.ok(ref);assert.equal(f.host.campaign.publishDecision(result,step),false);
 assert.equal(f.repository.settlePlanning(f.o,f.scope,reservation,{inputTokens:100,outputTokens:10,providerRevision:reservation.providerRevision,completionRef:ref}),true);
 assert.equal(f.host.campaign.publishDecision(result,step),true);assert.equal(f.host.campaign.publishDecision(result,step),false);
 // Actual second observed identity, unchanged qualified visible field.
 const freshId=randomUUID();f.observation.observationId=freshId;f.observation.capturedAt=new Date().toISOString();f.observation.receivedAt=f.observation.capturedAt;f.observation.screenshots=f.observation.screenshots.map(s=>({...s,screenshotId:randomUUID(),capturedAt:f.observation.capturedAt}));f.observation.visibleState=f.observation.visibleState.map(v=>({...v,lastObservedRef:freshId,observedAt:f.observation.receivedAt}));
 const input=await f.host.campaign.prepareController(f.join,step,{state:'completed',completedSteps:1},f.repository,new AbortController().signal);assert.ok(input);
 const request=input.request,time=new Date().toISOString(),receipt:G.GameActionReceipt={schemaVersion:'1.0.0',recordType:'gameActionReceipt',scope:f.scope,actionId:request.payload.actionId,proposalId:proposal.proposalId,idempotencyKey:request.idempotencyKey,inputDigest:request.payload.admission.inputDigest,admissionId:request.payload.admission.admissionId,disposition:'completed',beforeFrame:request.payload.expectedFrameNumber,afterFrame:request.payload.expectedFrameNumber+2,framesApplied:2,buttonsNeutralized:true,startedAt:time,completedAt:time,resultingObservationIds:[],recordedAt:time,reason:null};
 const actionResult:G.GameActionResult={schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:'fixture:native',completedAt:time,outcome:{status:'succeeded',payload:receipt,error:null}},settled={state:'settled' as const,reservationHeld:false,adapterInvoked:true,result:actionResult,playAuthority:false as const,resumeAuthority:false as const};
 assert.equal(await f.host.campaign.recordSettledStep(f.join,input,settled,f.repository),null,'shape alone is not settled usage');
 assert.equal(f.repository.reserveController(f.o,request),true);assert.equal(f.repository.settleController(f.o,request,{receipt,wallMs:10,completionRef:'fixture:native-terminal'}),true);
 assert.deepEqual(await f.host.campaign.recordSettledStep(f.join,input,settled,f.repository),{journalCommitted:true});
 const checkpoint=f.repository.get(f.o,f.scope.runId)!;assert.equal(checkpoint.checkpoint.campaignJournalRef.revision,2);assert.equal(checkpoint.checkpoint.budgetUsed.actions,1);assert.equal(checkpoint.checkpoint.budgetUsed.modelCalls,1);
 const journal=new CampaignJournalRepository(f.db,f.journalOptions).get(f.o,f.f.input.journal.journalId)!;assert.equal(journal.revision,2);assert.ok(journal.entries.some(e=>e.sourceRefs.includes('game-action:'+receipt.actionId)));
 assert.equal(await f.host.campaign.recordSettledStep(f.join,input,settled,f.repository),null,'repeated receipt cannot append a second journal entry');
});
