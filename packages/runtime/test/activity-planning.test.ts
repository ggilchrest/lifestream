import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type * as G from '@lifestream/contracts/game-activity';
import {createContractValidator} from '@lifestream/contracts';
import {gameCampaignFixture} from './fixtures/game-campaign.ts';
import {selectGameCampaignContext,prepareGameCampaignContext,gameDecisionInput,gameProposalMatchesPreparedContext} from '../src/activity/game-journal.ts';
import {createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn} from '../src/inference/prompt.ts';
import {runGamePlanningTurn,type GamePlanningHost,type GamePlanningResult} from '../src/activity/coordinator.ts';
import {UnderstandingWorkCoordinator} from '../src/understanding/coordinator.ts';
import type {InferenceProvider,InferenceChunk,InferenceRequest} from '../src/inference/port.ts';
function fixture(mode?:'manyCurrent'|'manyGoals'){
 const f=gameCampaignFixture(),s=f.input.expectedScope,o=f.input.observation;
 o.visibleState.push({fieldId:'scripted-visible-menu',value:'open',visibility:'visibleNow',firstObservedRef:o.observationId,lastObservedRef:o.observationId,timelineId:s.timelineId,observedAt:o.receivedAt,freshUntil:new Date(f.input.freshUntilMs).toISOString(),decoderRevision:'1.0.0',manifestDigest:f.input.pinsDigest,limitations:['Scripted reviewed field; no actual game.']});
 if(mode==='manyCurrent')for(let i=0;i<16;i++){const e={...f.input.journal.entries[1]!,entryId:randomUUID()};f.input.journal.entries.push(e);f.input.binding.entryBindings.push({...f.input.binding.entryBindings[1]!,entryId:e.entryId});}
 if(mode==='manyGoals')for(let i=0;i<8;i++)f.input.journal.goals.push({...f.input.journal.goals[0]!,goalId:randomUUID()});
 if(mode)f.input.maximumBytes=65536;
 const scope={assistantId:s.assistantId,principalId:s.principalId,relationshipId:s.relationshipId,conversationId:s.contextBinding.conversationId,sessionId:s.contextBinding.sessionId,endpointId:s.contextBinding.endpointId},binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope,conversation:'[]',sourceRevisions:{conversation:'synthetic:1'}}),selection=selectGameCampaignContext(f.input,f.boundary),game=prepareGameCampaignContext(selection,binding),turn=finalizePreparedTurn({assistantId:s.assistantId,sessionId:scope.sessionId,endpointId:scope.endpointId,interactionId:randomUUID(),conversation:'[]',origin:'activityStep',preparedTurnBinding:binding,preparedGameCampaignContext:game,maximumOutputTokens:1024},()=>true);
 const proposal:G.GameActionProposal={schemaVersion:'1.0.0',recordType:'gameActionProposal',scope:s,proposalId:randomUUID(),observationId:o.observationId,observationRevision:o.revision,preparedViewId:binding.viewId,preparedViewRevision:binding.revision,invalidationKey:binding.invalidationKey,buttons:['a'],durationFrames:1,maxWallMs:100,expectedVisibleOutcome:'A scripted menu transition may occur.',uncertainty:'Synthetic planning only.',adviceRefs:[],reason:'Test the supported current scripted menu.',preconditions:[{predicateId:randomUUID(),fieldId:o.visibleState[0]!.fieldId,expectedValue:'open',sourceObservationId:o.observationId}]};
 let admissions=0,calls=0;const published:GamePlanningResult[]=[],requests:InferenceRequest[]=[],coordinator=new UnderstandingWorkCoordinator({pressureAllowsWork:()=>true}),provider:InferenceProvider={tokenize:async()=>({count:100,identity:'scripted-tokenizer:1'}),async *generate(request){calls++;requests.push(request);yield {kind:'text',text:JSON.stringify(proposal)};yield {kind:'done'};}};
 const host:GamePlanningHost={run:work=>coordinator.run(work),current:()=>true,admitOnce:()=>{admissions++;return true;},publish:result=>{published.push(result);return true;},providerRevision:'scripted-provider:1',tokenizerIdentity:'scripted-tokenizer:1',providerPreemptionBoundMs:1,providerSlotReleaseBoundMs:1};
 const input={turn,binding,game,provider,bounds:{maximumInputTokens:8192,maximumOutputTokens:1024,maximumOutputBytes:32768,maximumChunks:100,deadlineMs:3000}};
 return {...f,sourceInput:f.input,turn,binding,game,proposal,host,provider,input,coordinator,published,requests,admissions:()=>admissions,calls:()=>calls};
}
test('one P2 planning decision uses the same cached nine-section request and publishes an inert canonical proposal with exact decision evidence',async()=>{
 const f=fixture(),request=requestForFinalizedTurn(f.turn,f.binding,()=>true),result=await runGamePlanningTurn(f.input,f.host);
 assert.equal(result.state,'published');assert.equal(f.calls(),1);assert.equal(f.admissions(),1);assert.equal(f.requests[0],request);assert.equal(request.sections.length,9);assert.equal(request.maximumOutputTokens,1024);assert.equal(request.sections[8]!.content,'');
 const value=f.published[0]!;assert.deepEqual(value.proposal,f.proposal);assert.equal(value.decisionInput.conversationSectionDigest,request.manifest.sections[7]!.contentDigest);assert.equal(value.decisionInput.preparedMemorySectionDigest,request.manifest.sections[4]!.contentDigest);assert.deepEqual(value.decisionInput.selectedVisibleFieldIds,['scripted-visible-menu']);assert.equal(value.decisionInput.inputTokens,100);assert.ok(Date.parse(value.decisionInput.freshUntil)<=Date.parse(f.turn.preparedContext!.freshUntil));assert.ok(Date.parse(value.decisionInput.freshUntil)-Date.parse(value.decisionInput.selectedAt)<=f.input.bounds.deadlineMs);assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.proposal));assert.equal(createContractValidator().validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/GameDecisionInput',value.decisionInput).valid,true);
 assert.equal(gameProposalMatchesPreparedContext(f.game,f.binding,{...value.decisionInput},f.proposal),false,'model-authored decision evidence is not an authentic host sidecar');
 assert.equal('admission' in value,false);assert.equal('buttonVector' in value,false);assert.equal('saveArtifact' in value,false);
});
test('explicit JSON null yields no action, without a controller call or fabricated attempt',async()=>{
 const f=fixture();f.provider.generate=async function*(){yield {kind:'text',text:'null'};yield {kind:'done'};};assert.equal((await runGamePlanningTurn(f.input,f.host)).state,'published');assert.equal(f.published[0]!.proposal,null);
});
test('unverified provider priority, foreground pressure and durable duplicate/budget reservation suppress planning before model calls',async t=>{
 for(const mode of ['missingPreemption','slowPreemption','missingSlotRelease','slowSlotRelease','foreground','budget'])await t.test(mode,async()=>{
  const f=fixture();let release=()=>{};if(mode==='missingPreemption')delete f.host.providerPreemptionBoundMs;if(mode==='slowPreemption')f.host.providerPreemptionBoundMs=11;if(mode==='missingSlotRelease')delete f.host.providerSlotReleaseBoundMs;if(mode==='slowSlotRelease')f.host.providerSlotReleaseBoundMs=251;if(mode==='foreground')release=f.coordinator.foregroundStarted();if(mode==='budget')f.host.admitOnce=()=>false;
  const result=await runGamePlanningTurn(f.input,f.host);release();assert.equal(result.state,'suppressed');assert.equal(f.calls(),0);assert.equal(f.published.length,0);
 });
});
test('missing/mismatched selected tokenizer or finite input/output token limits refuse results without silently estimating',async t=>{
 for(const mode of ['missing','identity','nan','fraction','inputLimit','outputLimit'])await t.test(mode,async()=>{
  const f=fixture();let n=0;if(mode==='missing')delete f.provider.tokenize;else f.provider.tokenize=async()=>({count:mode==='nan'?NaN:mode==='fraction'?1.5:mode==='inputLimit'?8193:mode==='outputLimit'&&n++>0?1025:100,identity:mode==='identity'?'other-tokenizer':'scripted-tokenizer:1'});
  assert.equal((await runGamePlanningTurn(f.input,f.host)).state,'failed');assert.equal(f.published.length,0);assert.equal(f.calls(),mode==='outputLimit'?1:0);assert.equal(f.admissions(),1,'once-only reservation is not refunded by validation failure');
 });
});
test('foreign scope/view/source/advice, hidden or previously revealed predicates and forbidden controls cannot become accepted proposals',async t=>{
 for(const mode of ['scope','epoch','timeline','view','revision','key','observation','observationRevision','advice','hiddenField','predicateValue','predicateSource','pastField','duration','wall','opposites','extraSave','arbitraryLua'])await t.test(mode,async()=>{
  const f=fixture(),p:any=f.proposal;if(mode==='scope')p.scope.assistantId=randomUUID();if(mode==='epoch')p.scope.activityEpoch++;if(mode==='timeline')p.scope.timelineId=randomUUID();if(mode==='view')p.preparedViewId=randomUUID();if(mode==='revision')p.preparedViewRevision++;if(mode==='key')p.invalidationKey=randomUUID();if(mode==='observation')p.observationId=randomUUID();if(mode==='observationRevision')p.observationRevision++;if(mode==='advice')p.adviceRefs=['unattributed-advice'];if(mode==='hiddenField')p.preconditions[0].fieldId='hidden-future-progress';if(mode==='predicateValue')p.preconditions[0].expectedValue='other-state';if(mode==='predicateSource')p.preconditions[0].sourceObservationId=randomUUID();if(mode==='pastField')p.preconditions[0].fieldId='previously-revealed-unselected';if(mode==='duration')p.durationFrames=121;if(mode==='wall')p.maxWallMs=2001;if(mode==='opposites')p.buttons=['left','right'];if(mode==='extraSave')p.saveState='forbidden';if(mode==='arbitraryLua')p.buttons=['lua'];
  assert.equal((await runGamePlanningTurn(f.input,f.host)).state,'failed');assert.equal(f.published.length,0);
 });
});
test('tool requests, malformed JSON, missing terminal, byte/chunk overflow and hostile provider output are rejected',async t=>{
 for(const mode of ['tool','json','noTerminal','bytes','chunks','getter'])await t.test(mode,async()=>{
  const f=fixture();let reads=0;f.provider.generate=async function*():AsyncGenerator<InferenceChunk>{if(mode==='tool')yield {kind:'capabilityRequest',capability:{name:'arbitrary',input:{},effect:'read-only'}};else if(mode==='getter'){const raw={kind:'text'};Object.defineProperty(raw,'text',{enumerable:true,get(){reads++;return JSON.stringify(f.proposal);}});yield raw as InferenceChunk;}else if(mode==='chunks'){for(let i=0;i<101;i++)yield {kind:'text',text:' '};}else yield {kind:'text',text:mode==='bytes'?'x'.repeat(32769):mode==='json'?'```json\nnull\n```':JSON.stringify(f.proposal)};if(mode!=='noTerminal')yield {kind:'done'};};
  assert.equal((await runGamePlanningTurn(f.input,f.host)).state,'failed');assert.equal(f.published.length,0);assert.equal(reads,0);
 });
});
test('foreground preemption fences suspended planning; another optional job cannot fan out until the uncooperative provider settles',async()=>{
 const f=fixture();let resolve!:()=>void;const gate=new Promise<void>(r=>{resolve=r;});let entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});f.provider.generate=async function*(){entered();await gate;yield {kind:'text',text:JSON.stringify(f.proposal)};yield {kind:'done'};};
 const running=runGamePlanningTurn(f.input,f.host);await ready;const release=f.coordinator.foregroundStarted();assert.equal(f.coordinator.isIdle(),false);const other=fixture();other.host.run=f.host.run;assert.equal((await runGamePlanningTurn(other.input,other.host)).state,'suppressed');assert.equal(other.calls(),0);resolve();assert.equal((await running).state,'cancelled');assert.equal(f.published.length,0);release();assert.equal(f.coordinator.isIdle(),true);
});
test('source/provider/UTC withdrawal after tokenizer await prevents generation and never publishes stale planning',async t=>{
 for(const mode of ['source','provider','clock'])await t.test(mode,async()=>{
  const f=fixture();let clock=f.sourceInput.nowMs;f.host.now=()=>clock;f.provider.tokenize=async()=>{if(mode==='source')f.deny();if(mode==='provider')f.host.providerRevision='new-provider';if(mode==='clock')clock--;return {count:100,identity:'scripted-tokenizer:1'};};assert.equal((await runGamePlanningTurn(f.input,f.host)).state,'cancelled');assert.equal(f.calls(),0);assert.equal(f.published.length,0);
 });
});
test('closed explicit bounds, copied contexts and changed output limits cannot create a planning call',async()=>{
 const f=fixture();await assert.rejects(runGamePlanningTurn({...f.input,bounds:{...f.input.bounds,deadlineMs:0}},f.host),/unavailable/);await assert.rejects(runGamePlanningTurn({...f.input,bounds:{...f.input.bounds,maximumOutputTokens:512}},f.host),/unavailable/);await assert.rejects(runGamePlanningTurn({...f.input,game:{...f.game}},f.host),/Prepared game context/);assert.equal(f.admissions(),0);assert.equal(f.calls(),0);
});
test('decision evidence rejects an invalid token count rather than accepting a fabricated count',()=>{
 const f=fixture(),request=requestForFinalizedTurn(f.turn,f.binding,()=>true);assert.throws(()=>gameDecisionInput(f.game,f.binding,request,-1,Date.now(),Date.parse(f.turn.preparedContext!.freshUntil)),/Prepared game context/);
});

test('decision evidence refuses excessive complete current-entry/goal selections instead of silently pruning history',async t=>{for(const mode of ['manyCurrent','manyGoals'] as const)await t.test(mode,async()=>{const f=fixture(mode);assert.equal((await runGamePlanningTurn(f.input,f.host)).state,'failed');assert.equal(f.calls(),0);assert.equal(f.published.length,0);});});
