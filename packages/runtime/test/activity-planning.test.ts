import {createRequire} from 'node:module';
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
import {SglangInferenceProvider} from '../../providers-sglang/src/provider.ts';
function fixture(mode?:'manyCurrent'|'manyGoals',turnCurrent:()=>boolean=()=>true){
 const f=gameCampaignFixture(),s=f.input.expectedScope,o=f.input.observation;
 o.visibleState.push({fieldId:'scripted-visible-menu',value:'open',visibility:'visibleNow',firstObservedRef:o.observationId,lastObservedRef:o.observationId,timelineId:s.timelineId,observedAt:o.receivedAt,freshUntil:new Date(f.input.freshUntilMs).toISOString(),decoderRevision:'1.0.0',manifestDigest:f.input.pinsDigest,limitations:['Scripted reviewed field; no actual game.']});
 if(mode==='manyCurrent')for(let i=0;i<16;i++){const e={...f.input.journal.entries[1]!,entryId:randomUUID()};f.input.journal.entries.push(e);f.input.binding.entryBindings.push({...f.input.binding.entryBindings[1]!,entryId:e.entryId});}
 if(mode==='manyGoals')for(let i=0;i<8;i++)f.input.journal.goals.push({...f.input.journal.goals[0]!,goalId:randomUUID()});
 if(mode)f.input.maximumBytes=65536;
 const scope={assistantId:s.assistantId,principalId:s.principalId,relationshipId:s.relationshipId,conversationId:s.contextBinding.conversationId,sessionId:s.contextBinding.sessionId,endpointId:s.contextBinding.endpointId},binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope,conversation:'[]',sourceRevisions:{conversation:'synthetic:1'}}),selection=selectGameCampaignContext(f.input,f.boundary),game=prepareGameCampaignContext(selection,binding),turn=finalizePreparedTurn({assistantId:s.assistantId,sessionId:scope.sessionId,endpointId:scope.endpointId,interactionId:randomUUID(),conversation:'[]',origin:'activityStep',preparedTurnBinding:binding,preparedGameCampaignContext:game,maximumOutputTokens:1024},turnCurrent);
 const proposal:G.GameActionProposal={schemaVersion:'1.0.0',recordType:'gameActionProposal',scope:s,proposalId:randomUUID(),observationId:o.observationId,observationRevision:o.revision,preparedViewId:binding.viewId,preparedViewRevision:binding.revision,invalidationKey:binding.invalidationKey,buttons:['a'],durationFrames:1,maxWallMs:100,expectedVisibleOutcome:'A scripted menu transition may occur.',uncertainty:'Synthetic planning only.',adviceRefs:[],reason:'Test the supported current scripted menu.',preconditions:[{predicateId:randomUUID(),fieldId:o.visibleState[0]!.fieldId,expectedValue:'open',sourceObservationId:o.observationId}]};
 let admissions=0,calls=0;const published:GamePlanningResult[]=[],requests:InferenceRequest[]=[],coordinator=new UnderstandingWorkCoordinator({pressureAllowsWork:()=>true}),provider:InferenceProvider={tokenize:async()=>({count:100,identity:'scripted-tokenizer:1'}),async *generate(request){calls++;requests.push(request);yield {kind:'text',text:JSON.stringify(proposal)};yield {kind:'done'};}};
 const host:GamePlanningHost={run:work=>coordinator.run(work),current:()=>true,admitOnce:()=>{admissions++;return true;},publish:result=>{published.push(result);return true;},providerRevision:'scripted-provider:1',tokenizerIdentity:'scripted-tokenizer:1',providerPreemptionBoundMs:1,providerSlotReleaseBoundMs:1};
 const input={turn,binding,game,provider,bounds:{maximumInputTokens:8192,maximumOutputTokens:1024,maximumOutputBytes:32768,maximumChunks:100,deadlineMs:3000}};
 return {...f,sourceInput:f.input,turn,binding,game,proposal,host,provider,input,coordinator,published,requests,admissions:()=>admissions,calls:()=>calls};
}
test('first planning failure retains only bounded categories and counters before provider cleanup returns',async t=>{
 for(const [mode,phase,reason] of [
  ['provider','provider-stream','provider_response_limit'],['chunks','provider-stream','chunk_limit'],
  ['bytes','provider-stream','output_byte_limit'],['missingDone','provider-stream','terminal_missing'],
  ['json','json-parse','json_invalid'],['proposal','proposal-validation','proposal_invalid'],
  ['thrown','provider-stream','operation_threw'],['cancel','provider-stream','cancelled'],
 ] as const)await t.test(mode,async t=>{
  const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';
  t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
  const logs:string[]=[];t.mock.method(console,'info',(value:string)=>logs.push(value));
  const f=fixture();let reaped=false;
  f.provider.generate=async function*(){try{
   if(mode==='provider'){yield {kind:'error',error:{code:'response_limit',message:'PRIVATE_PROVIDER_SENTINEL'}};return;}
   if(mode==='thrown')throw Error('PRIVATE_ERROR_SENTINEL');
   if(mode==='cancel'){const release=f.coordinator.foregroundStarted();release();yield {kind:'text',text:'null'};return;}
   if(mode==='chunks'){for(let i=0;i<=f.input.bounds.maximumChunks;i++)yield {kind:'text',text:' '};return;}
   yield {kind:'text',text:mode==='bytes'?'x'.repeat(32769):mode==='json'?'PRIVATE_OUTPUT_SENTINEL':mode==='proposal'?'{}':'null'};
   if(mode!=='missingDone')yield {kind:'done'};
  }finally{reaped=true;}};
  const result=await runGamePlanningTurn(f.input,f.host);assert.ok(['failed','cancelled'].includes(result.state));
  assert.equal(reaped,true);assert.equal(f.admissions(),1);assert.equal(f.published.length,0);
  assert.equal(logs.length,1);const entry=JSON.parse(logs[0]!);
  assert.deepEqual(Object.keys(entry).sort(),['chunks','event','interactionId','outputBytes','phase','reason']);
  assert.equal(entry.event,'game-planning-first-failure');assert.equal(entry.phase,phase);assert.equal(entry.reason,reason);
  assert.ok(Number.isSafeInteger(entry.chunks)&&entry.chunks>=0&&entry.chunks<=101);assert.ok(Number.isSafeInteger(entry.outputBytes)&&entry.outputBytes>=0&&entry.outputBytes<=32768);
  assert.doesNotMatch(logs.join(''),/PRIVATE|scripted-visible-menu|scripted-provider/);
 });
});
test('optional planning diagnostics disabled or throwing cannot alter failure or publication',async t=>{
 for(const mode of ['disabled','throwing'])await t.test(mode,async t=>{
  const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;if(mode==='throwing')process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';else delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;
  t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
  let reports=0;t.mock.method(console,'info',()=>{reports++;throw Error('PRIVATE_REPORTER');});
  const f=fixture();f.provider.generate=async function*(){yield {kind:'text',text:'PRIVATE_BAD_JSON'};yield {kind:'done'};};
  assert.equal((await runGamePlanningTurn(f.input,f.host)).state,'failed');assert.equal(reports,mode==='throwing'?1:0);assert.equal(f.admissions(),1);assert.equal(f.published.length,0);
 });
});
test('pending native inspection I/O finishes before the separate planning admission phase',async()=>{
 const f=fixture();let inspectionCompleted=false,handoffs=0;
 setImmediate(()=>{inspectionCompleted=true;});const original=f.host.run;
 f.host.run=work=>{handoffs++;assert.equal(inspectionCompleted,true,'Admission must not starve an already queued inspection');return original(work);};
 assert.equal((await runGamePlanningTurn(f.input,f.host)).state,'published');
 assert.equal(handoffs,1);assert.equal(f.calls(),1);assert.equal(f.admissions(),1);
});
test('source, provider and deadline withdrawal during the admission I/O turn prevents any handoff or reservation',async t=>{
 for(const mode of ['source','provider','deadline'])await t.test(mode,async()=>{
  const f=fixture();let handoffs=0,clock=f.sourceInput.nowMs;f.host.now=()=>clock;const original=f.host.run;
  f.host.run=work=>{handoffs++;return original(work);};
  setImmediate(()=>{if(mode==='source')f.deny();if(mode==='provider')f.host.providerRevision='replacement';if(mode==='deadline')clock+=3000;});
  await assert.rejects(runGamePlanningTurn(f.input,f.host),/unavailable/);
  assert.equal(handoffs,0);assert.equal(f.admissions(),0);assert.equal(f.calls(),0);assert.equal(f.published.length,0);
 });
});
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


test('each planning boundary checks the original turn around one fresh host check without recursive expansion',async()=>{
 const order:string[]=[];let allowed=true;
 const f=fixture(undefined,()=>{order.push('turn');return allowed;});
 f.host.current=()=>{order.push('host');return true;};order.length=0;
 f.host.run=async work=>{
  assert.deepEqual(order,['turn','host','turn'],'initial request is checked once');
  order.length=0;assert.equal(work.current(),true);assert.deepEqual(order,['turn','host','turn']);
  allowed=false;order.length=0;assert.equal(work.current(),false);assert.deepEqual(order,['turn']);
  allowed=true;order.length=0;assert.equal(work.current(),false,'restoring an authority cannot revive retired work');assert.deepEqual(order,[]);
  assert.equal(work.admitOnce(),false);return {state:'suppressed',reason:'synthetic-inspection',completedSteps:0};
 };
 assert.equal((await runGamePlanningTurn(f.input,f.host)).state,'suppressed');
 assert.equal(f.admissions(),0);assert.equal(f.calls(),0);assert.equal(f.published.length,0);
});

test('callback clock/provider changes, source revocation and exceptions retire planning at either side of the host check',async t=>{
 for(const site of ['entry-before','host','entry-after'])for(const change of ['clock-backwards','deadline','provider','tokenizer','source','throw'])await t.test(site+':'+change,async()=>{
  let entry=0,mutate:((site:string)=>void)=()=>{};
  const f=fixture(undefined,()=>{mutate(++entry===1?'entry-before':'entry-after');return true;});
  const began=f.sourceInput.nowMs;let clock=began;
  f.host.now=()=>clock;f.host.current=()=>{mutate('host');return true;};
  f.host.run=async work=>{
   entry=0;mutate=where=>{if(where!==site)return;if(change==='clock-backwards')clock=began-1;if(change==='deadline')clock=began+f.input.bounds.deadlineMs;if(change==='provider')f.host.providerRevision='changed-provider';if(change==='tokenizer')f.host.tokenizerIdentity='changed-tokenizer';if(change==='source')f.deny();if(change==='throw')throw Error('Synthetic currentness failure');};
   assert.equal(work.current(),false,'mutation must be detected in this check');
   mutate=()=>{};clock=began;f.host.providerRevision='scripted-provider:1';f.host.tokenizerIdentity='scripted-tokenizer:1';f.permit();
   assert.equal(work.current(),false,'even transient failure permanently retires this work');assert.equal(work.admitOnce(),false);
   return {state:'suppressed',reason:'synthetic-inspection',completedSteps:0};
  };
  assert.equal((await runGamePlanningTurn(f.input,f.host)).state,'suppressed');assert.equal(f.admissions(),0);assert.equal(f.calls(),0);assert.equal(f.published.length,0);
 });
});

test('source withdrawal while generation is suspended rejects the returned chunk before publication',async()=>{
 const f=fixture();let resume!:()=>void,entered!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
 f.provider.generate=async function*(){entered();await gate;yield {kind:'text',text:JSON.stringify(f.proposal)};yield {kind:'done'};};
 const running=runGamePlanningTurn(f.input,f.host);await ready;f.deny();resume();
 assert.equal((await running).state,'cancelled');assert.equal(f.admissions(),1);assert.equal(f.published.length,0);
});


test('copied finalized turns retain the original closed validator rejection before admission',async()=>{
 const f=fixture();await assert.rejects(runGamePlanningTurn({...f.input,turn:{...f.turn}},f.host),/Finalized turn is unavailable or does not match its prepared binding/);
 assert.equal(f.admissions(),0);assert.equal(f.calls(),0);assert.equal(f.published.length,0);
});


test('reentrant failed currentness cannot be restored by the outer host callback',async()=>{
 const f=fixture();let reenter:(()=>void)|undefined;
 f.host.current=()=>{reenter?.();return true;};
 f.host.run=async work=>{
  reenter=()=>{reenter=undefined;f.host.providerRevision='temporarily-revoked';assert.equal(work.current(),false);f.host.providerRevision='scripted-provider:1';};
  assert.equal(work.current(),false);assert.equal(work.current(),false);assert.equal(work.admitOnce(),false);
  return {state:'suppressed',reason:'synthetic-inspection',completedSteps:0};
 };
 await runGamePlanningTurn(f.input,f.host);assert.equal(f.admissions(),0);assert.equal(f.calls(),0);
});

test('planning yields to a pending event-loop callback before the next provider effect',async()=>{
 const f=fixture();let serviced=false,generated=false,checks=0;
 // Representative bounded synchronous validation plus immediately fulfilled
 // provider promises must not form one uninterrupted microtask chain.
 f.host.current=()=>{const until=performance.now()+1;while(performance.now()<until){}checks++;return true;};
 f.provider.tokenize=async()=>{if(!generated)setImmediate(()=>{serviced=true;});return {count:100,identity:'scripted-tokenizer:1'};};
 f.provider.generate=async function*(){generated=true;assert.equal(serviced,true,'pending work must receive an event-loop turn before generation');yield {kind:'text',text:'null'};yield {kind:'done'};};
 assert.equal((await runGamePlanningTurn(f.input,f.host)).state,'published');assert.equal(generated,true);assert.ok(checks>0);assert.equal(f.admissions(),1);
});

test('revocation while planning yields is checked before tokenization without refunding admission',async()=>{
 const f=fixture();let tokenizations=0,admissions=0;
 f.host.admitOnce=()=>{admissions++;setImmediate(()=>{f.deny();});return true;};
 f.provider.tokenize=async()=>{tokenizations++;return {count:100,identity:'scripted-tokenizer:1'};};
 const result=await runGamePlanningTurn(f.input,f.host);
 assert.equal(result.state,'cancelled');assert.equal(admissions,1);assert.equal(tokenizations,0);assert.equal(f.calls(),0);assert.equal(f.published.length,0);
});

// R23 reached provider stop/[DONE] but no text. These are controlled stream
// fixtures, not reconstruction of the unretained historical provider fields.
test('actual provider stream distinguishes empty, non-content and usable planning output',async t=>{
 for(const mode of ['empty','nonContent','whitespace','proposal','null','invalidJson']as const)await t.test(mode,async t=>{
  const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';
  t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
  const logs:Record<string,unknown>[]=[];t.mock.method(console,'info',(value:string)=>logs.push(JSON.parse(value)));
  const f=fixture();let fetches=0;
  const delta=mode==='nonContent'?{reasoning_content:'PRIVATE_NON_CONTENT',tool_calls:[{function:{arguments:JSON.stringify(f.proposal)}}]}:mode==='whitespace'?{content:'  '}:mode==='proposal'?{content:JSON.stringify(f.proposal)}:mode==='null'?{content:'null'}:mode==='invalidJson'?{content:'PRIVATE_INVALID_JSON'}:{};
  const frames=[{id:'chatcmpl-synthetic',choices:[{delta:{role:'assistant',content:null},finish_reason:null}]},{id:'chatcmpl-synthetic',choices:[{delta,finish_reason:null}]},{id:'chatcmpl-synthetic',choices:[{delta:{},finish_reason:'stop'}]}];
  const raw=frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')+'data: [DONE]\n\n';
  t.mock.method(globalThis,'fetch',async(_url,options)=>{fetches++;const body=JSON.parse(String(options?.body));assert.equal(body.max_tokens,1024);assert.deepEqual(body.chat_template_kwargs,{enable_thinking:false});assert.ok(f.requests[0]?.responseFormat);assert.deepEqual(body.response_format,f.requests[0]?.responseFormat);assert.equal(body.response_format.json_schema.name,'game_action_proposal');t.diagnostic(JSON.stringify({fixture:mode,finalizedResponseFormatPresent:f.requests[0]?.responseFormat!==undefined,dispatchedResponseFormatPresent:body.response_format!==undefined,maximumOutputTokens:body.max_tokens,directAnswerMode:body.chat_template_kwargs.enable_thinking===false}));const bytes=new TextEncoder().encode(raw);return new Response(new ReadableStream({start(controller){for(let n=0;n<bytes.length;n+=7)controller.enqueue(bytes.slice(n,n+7));controller.close();}}));});
  const actual=new SglangInferenceProvider({endpoint:'http://synthetic.invalid',model:'synthetic'});
  f.provider.generate=(request,context)=>{f.requests.push(request);return actual.generate(request,context);};
  const result=await runGamePlanningTurn(f.input,f.host);
  assert.equal(fetches,1);assert.equal(f.admissions(),1);assert.equal(actual.pendingTransportCleanupCount,0);
  assert.equal(result.state,mode==='proposal'||mode==='null'?'published':'failed');assert.equal(f.published.length,mode==='proposal'||mode==='null'?1:0);
  assert.ok(logs.some(v=>v.phase==='provider-finish-stop'));assert.ok(logs.some(v=>v.phase==='provider-terminal-done'));
  const shape=logs.find(v=>v.phase==='stream-shape')!;assert.equal(shape.dataFrames,3);assert.equal(shape.reasoningBytes,mode==='nonContent'?Buffer.byteLength('PRIVATE_NON_CONTENT'):0);assert.equal(shape.toolCallFrames,mode==='nonContent'?1:0);assert.equal(shape.contentBytes,typeof delta.content==='string'?Buffer.byteLength(delta.content):0);const requestShape=logs.find(v=>v.phase==='request-shape')!;assert.equal(requestShape.responseFormatKind,'nullable-object');assert.match(String(requestShape.responseFormatSha256),/^[a-f0-9]{64}$/);
  const failure=logs.filter(v=>v.event==='game-planning-first-failure');
  if(mode==='proposal'||mode==='null'){assert.equal(failure.length,0);assert.deepEqual(f.published[0]!.proposal,mode==='null'?null:f.proposal);}
  else{assert.equal(failure.length,1);assert.equal(failure[0]!.reason,mode==='invalidJson'?'json_invalid':'output_empty');if(mode==='empty'||mode==='nonContent'){assert.equal(failure[0]!.chunks,1);assert.equal(failure[0]!.outputBytes,0);}}
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|synthetic.invalid|expectedVisibleOutcome/);
 });
});

test('host proposal decoding syntax preserves null and rejects empty/extra objects without granting semantic validity',()=>{
 const f=fixture(),request=requestForFinalizedTurn(f.turn,f.binding,()=>true),format=request.responseFormat!;
 assert.equal(format.type,'json_schema');assert.equal(format.json_schema.name,'game_action_proposal');assert.ok(Object.isFrozen(format));assert.ok(Object.isFrozen(format.json_schema.schema));
 const Ajv=createRequire(import.meta.url)('ajv/dist/2020').default,validate=new Ajv({strict:false}).compile(format.json_schema.schema);
 assert.equal(validate(f.proposal),true);assert.equal(validate(null),true);
 for(const value of [{},{...f.proposal,extra:'not permitted'},[],true,'',0])assert.equal(validate(value),false);
 // A decoding-valid source mismatch is still untrusted and rejected by the
 // unchanged genuine prepared-context validator, rather than gaining authority.
 const stale={...f.proposal,observationId:randomUUID()};assert.equal(validate(stale),true);const decision=gameDecisionInput(f.game,f.binding,request,100,Date.now(),Date.now()+1000);assert.equal(gameProposalMatchesPreparedContext(f.game,f.binding,decision,stale),false);
});
