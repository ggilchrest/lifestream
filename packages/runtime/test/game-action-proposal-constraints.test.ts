import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type * as G from '@lifestream/contracts/game-activity';
import {gameCampaignFixture} from './fixtures/game-campaign.ts';
import {selectGameCampaignContext,prepareGameCampaignContext,gameDecisionInput,gameProposalMatchesPreparedContext,type GameActionProposalConstraints} from '../src/activity/game-journal.ts';
import {createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn} from '../src/inference/prompt.ts';
import {runGamePlanningTurn,type GamePlanningResult} from '../src/activity/coordinator.ts';
import {UnderstandingWorkCoordinator} from '../src/understanding/coordinator.ts';
const constraints:GameActionProposalConstraints={allowedButtons:['up','down','left','right','a','b','x','y','l','r','select'],maxDurationFrames:12,maxWallMs:400,grantsAuthority:false};
function fixture(){
 const f=gameCampaignFixture(),scope=f.input.expectedScope,o=f.input.observation;let current:GameActionProposalConstraints|null=structuredClone(constraints);
 o.visibleState=[{fieldId:'ct.ui.controller-domain',value:'ordinaryGameplay',visibility:'visibleNow',firstObservedRef:o.observationId,lastObservedRef:o.observationId,timelineId:scope.timelineId,observedAt:o.receivedAt,freshUntil:new Date(f.input.freshUntilMs).toISOString(),decoderRevision:'1.0.0',manifestDigest:f.input.pinsDigest,limitations:['Synthetic visible-domain fixture; no native authority.']}];
 const input={...f.input,actionProposalConstraints:structuredClone(constraints)},boundary={...f.boundary,actionProposalConstraintsCurrent:(candidate:GameActionProposalConstraints)=>isDeepStrictEqual(candidate,current)};
 const selected=selectGameCampaignContext(input,boundary),c=scope.contextBinding,binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{assistantId:scope.assistantId,principalId:scope.principalId,relationshipId:scope.relationshipId,conversationId:c.conversationId,sessionId:c.sessionId,endpointId:c.endpointId},conversation:'[]',sourceRevisions:{fixture:'1'}}),game=prepareGameCampaignContext(selected,binding),turn=finalizePreparedTurn({assistantId:scope.assistantId,sessionId:c.sessionId,endpointId:c.endpointId,interactionId:randomUUID(),origin:'activityStep',conversation:'[]',preparedTurnBinding:binding,preparedGameCampaignContext:game,maximumOutputTokens:1024},()=>true),request=requestForFinalizedTurn(turn,binding,()=>true),decision=gameDecisionInput(game,binding,request,100,f.input.nowMs,f.input.freshUntilMs);
 const proposal:G.GameActionProposal={schemaVersion:'1.0.0',recordType:'gameActionProposal',scope,proposalId:randomUUID(),observationId:o.observationId,observationRevision:o.revision,preparedViewId:binding.viewId,preparedViewRevision:binding.revision,invalidationKey:binding.invalidationKey,buttons:['right'],durationFrames:12,maxWallMs:400,expectedVisibleOutcome:'Synthetic possible movement.',uncertainty:'No actual model or native game.',adviceRefs:[],reason:'Synthetic proposal validation.',preconditions:[{predicateId:randomUUID(),fieldId:'ct.ui.controller-domain',expectedValue:'ordinaryGameplay',sourceObservationId:o.observationId}]};
 return {...f,input,boundary,selected,binding,game,turn,request,decision,proposal,change:(value:GameActionProposalConstraints|null)=>{current=value;}};
}
test('authentic prepared context includes exact inert controller limits and narrows otherwise valid proposals',()=>{
 const f=fixture(),text=f.request.sections[7]!.content;
 assert.match(text,/"actionProposalConstraints":/);assert.match(text,/"maxDurationFrames":12/);assert.match(text,/"maxWallMs":400/);assert.match(text,/"grantsAuthority":false/);
 assert.equal(gameProposalMatchesPreparedContext(f.game,f.binding,f.decision,f.proposal),true);
 for(const change of [{buttons:['start']},{durationFrames:13},{maxWallMs:401}])assert.equal(gameProposalMatchesPreparedContext(f.game,f.binding,f.decision,{...f.proposal,...change} as G.GameActionProposal),false);
 assert.equal(gameProposalMatchesPreparedContext(f.game,f.binding,f.decision,{...f.proposal,buttons:[]}),true,'neutral remains an inert legal proposal, never manufactured input');
 assert.equal(gameProposalMatchesPreparedContext({...f.game},f.binding,f.decision,f.proposal),false);
 (f.input.actionProposalConstraints.allowedButtons as string[]).push('start');
 assert.equal(gameProposalMatchesPreparedContext(f.game,f.binding,f.decision,{...f.proposal,buttons:['start']}),false,'caller cannot widen captured context');
});
test('missing or changed controller source and replaced currentness callbacks retire original prepared work',async t=>{
 for(const mode of ['missing','limitsChanged','callbackReplaced','sourceRevoked'])await t.test(mode,()=>{
  const f=fixture();
  if(mode==='missing')f.change(null);
  if(mode==='limitsChanged')f.change({...constraints,maxDurationFrames:11});
  if(mode==='callbackReplaced')f.boundary.actionProposalConstraintsCurrent=()=>true;
  if(mode==='sourceRevoked')f.deny();
  assert.throws(()=>requestForFinalizedTurn(f.turn,f.binding,()=>true),/unavailable/);
  f.change(constraints);f.permit();assert.throws(()=>requestForFinalizedTurn(f.turn,f.binding,()=>true),/unavailable/);
 });
});
test('invalid, widened, unbounded or unverified metadata cannot enter selected game context',async t=>{
 for(const change of [null,{...constraints,grantsAuthority:true},{...constraints,allowedButtons:['lua']},{...constraints,allowedButtons:['a','a']},{...constraints,maxDurationFrames:121},{...constraints,maxDurationFrames:1.5},{...constraints,maxWallMs:2001},{...constraints,maxWallMs:0},{...constraints,extra:true}])await t.test(JSON.stringify(change),()=>{
  const f=fixture();assert.equal(selectGameCampaignContext({...f.input,actionProposalConstraints:change as any},f.boundary).status,'unavailable');
 });
 const f=fixture();assert.equal(selectGameCampaignContext(f.input,f.boundary.actionProposalConstraintsCurrent?{...f.boundary,actionProposalConstraintsCurrent:undefined}:f.boundary).status,'unavailable');
});
test('explicit null remains a valid model no-action decision with finite controller restrictions',async()=>{
 const f=fixture(),coordinator=new UnderstandingWorkCoordinator({pressureAllowsWork:()=>true}),published:GamePlanningResult[]=[];
 const outcome=await runGamePlanningTurn({turn:f.turn,binding:f.binding,game:f.game,bounds:{maximumInputTokens:8192,maximumOutputTokens:1024,maximumOutputBytes:16384,maximumChunks:16,deadlineMs:3000},provider:{tokenize:async()=>({count:100,identity:'fixture-tokenizer'}),async *generate(){yield {kind:'text' as const,text:'null'};yield {kind:'done' as const};}}},{run:work=>coordinator.run(work),current:()=>true,admitOnce:()=>true,publish:result=>{published.push(result);return true;},providerRevision:'fixture-provider',tokenizerIdentity:'fixture-tokenizer',providerPreemptionBoundMs:1,providerSlotReleaseBoundMs:1});
 assert.equal(outcome.state,'published');assert.equal(published.length,1);assert.equal(published[0]!.proposal,null);
});
