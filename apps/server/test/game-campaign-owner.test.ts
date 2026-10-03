import {campaignFixtureData} from './fixtures/gameplay.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type * as G from '@lifestream/contracts/game-activity';
import {CampaignJournalRepository} from '@lifestream/storage-sqlite';
import {prepareGameCampaignContext,gameDecisionInput} from '@lifestream/runtime/activity/game-journal';
import {createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn} from '@lifestream/runtime/inference/prompt';
import {createGameCampaignOwner} from '../src/runtime/game-campaign-owner.ts';
import type {GameHostJoin} from '../src/runtime/game-host-port.ts';
import type {PreparedHostGameStep} from '../src/runtime/game-host-runtime.ts';

function fixture(){
 const data=campaignFixtureData(),host=createGameCampaignOwner(data.ownerOptions),repository=host.createRepository(data.db);
 return {...data,host,repository};
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
