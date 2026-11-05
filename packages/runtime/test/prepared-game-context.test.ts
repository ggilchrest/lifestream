import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import {selectGameCampaignContext,prepareGameCampaignContext,gameCampaignConversationContent,gameCampaignCheckpointCurrent} from '../src/activity/game-journal.ts';
import type * as G from '@lifestream/contracts/game-activity';
import {buildCanonicalPrompt,createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn,type PromptInput} from '../src/inference/prompt.ts';
import {gameCampaignFixture} from './fixtures/game-campaign.ts';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
test('checkpoint validation runs one complete source pass, keeps identity checks and retires on withdrawal',()=>{
 const f=fixture(),calls={scope:0,core:0,observation:0,reconciliation:0};
 for(const [name,key]of [['scopeCurrent','scope'],['coreCurrent','core'],['observationCurrent','observation'],['reconciliationCurrent','reconciliation']] as const){const original=f.boundary[name];(f.boundary as any)[name]=(...args:any[])=>{calls[key]++;return (original as any)(...args);};}
 const checkpoint:G.ActivityCheckpoint={schemaVersion:'1.0.0',recordType:'activityCheckpoint',scope:f.input.expectedScope,checkpointId:randomUUID(),revision:1,stateRevision:1,policyRevision:1,pinsDigest:f.input.pinsDigest,goalSummary:'Synthetic currentness qualification.',recentObservationIds:[f.input.observation.observationId],adviceRefs:[],lastObservationId:f.input.observation.observationId,lastActionReceipt:null,saveArtifact:null,budgetUsed:{wallMs:0,frames:0,actions:0,starts:1,equivalentFailures:0,modelCalls:0,inputTokens:0,outputTokens:0,retries:0,checkpointBytes:0,memoryEpisodes:0},recordedAt:new Date(f.input.nowMs).toISOString(),resumeDisposition:'requiresReconciliation',campaignJournalRef:{...f.selection.ref!}};
 assert.equal(gameCampaignCheckpointCurrent({...f.game},f.binding,checkpoint),false);
 assert.equal(gameCampaignCheckpointCurrent(f.game,{...f.binding},checkpoint),false);
 assert.deepEqual(calls,{scope:0,core:0,observation:0,reconciliation:0});
 assert.equal(gameCampaignCheckpointCurrent(f.game,f.binding,checkpoint),true);
 assert.deepEqual(calls,{scope:2,core:2,observation:2,reconciliation:1},'Original before/after-reconciliation fences run once per checkpoint validation');
 assert.equal(gameCampaignCheckpointCurrent(f.game,f.binding,{...checkpoint,pinsDigest:'b'.repeat(64)}),false);
 f.deny();assert.equal(gameCampaignCheckpointCurrent(f.game,f.binding,{...checkpoint,pinsDigest:'b'.repeat(64)}),false,'Invalid inert data must still observe source withdrawal');
 f.permit();assert.equal(gameCampaignCheckpointCurrent(f.game,f.binding,checkpoint),false,'A later call must not reuse a successful source result or revive retirement');
});
function fixture(){
 const f=gameCampaignFixture(),s=f.input.expectedScope;
 const scope={assistantId:s.assistantId,principalId:s.principalId,relationshipId:s.relationshipId,...{conversationId:s.contextBinding.conversationId,sessionId:s.contextBinding.sessionId,endpointId:s.contextBinding.endpointId}};
 const binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope,conversation:'[]',sourceRevisions:{runtime:'synthetic-runtime:1'}});
 const selection=selectGameCampaignContext(f.input,f.boundary),game=prepareGameCampaignContext(selection,binding);
 const input:PromptInput={assistantId:scope.assistantId,sessionId:scope.sessionId,endpointId:scope.endpointId,interactionId:randomUUID(),preparedTurnBinding:binding,preparedGameCampaignContext:game,origin:'activityStep',conversation:binding.conversation,deadlineAt:new Date(f.input.nowMs+30000).toISOString(),runtimeSelfContext:{sourceRevision:'synthetic-runtime:1',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'unknown',permissionState:'unknown',limitations:['Scripted logical activity only; no Human audience or audio authority.']}};
 return {...f,binding,scope,selection,game,prompt:input};
}
test('one immutable activity context uses the canonical nine sections, source inventory, expiry and existing digest manifest',()=>{
 const f=fixture(),turn=finalizePreparedTurn(f.prompt,()=>true),view=turn.preparedContext!,request=requestForFinalizedTurn(turn,f.binding,()=>true);
 assert.equal(createContractValidator().validate('https://lifestream.dev/contracts/prepared-context/1.0.0',view).valid,true);
 assert.deepEqual(request.sections.map(s=>s.kind),['policy','corePersona','adaptivePersona','interactionState','preparedMemory','worldContext','capabilityState','conversation','userInput']);
 assert.equal(request.sections[8]!.content,'');assert.equal(request.sections[8]!.sourceRef,'user-input:empty-v1');assert.match(request.sections[3]!.content,/origin=activityStep/);
 assert.match(request.sections[0]!.content,/not a Human request/);assert.match(request.sections[3]!.content,/audience=unknown; permission=unknown/);
 assert.equal(request.sections[7]!.trusted,false);assert.equal(request.sections[7]!.content,f.game.conversationContent);assert.equal(request.manifest.sections[7]!.contentDigest,sha(f.game.conversationContent));
 assert.equal(view.sections.filter(s=>s.kind==='conversation').map(s=>s.content).join(''),request.sections[7]!.content);
 assert.equal(view.freshUntil,new Date(f.input.freshUntilMs).toISOString());assert.equal(view.staleUntil,view.freshUntil);
 for(const [source,revision]of Object.entries(f.game.sourceRevisions)){assert.equal(turn.sourceRevisions[source],revision);assert.ok(view.sourceRevisions.some(r=>r.source===source));}
 assert.ok(Object.isFrozen(f.game)&&Object.isFrozen(f.selection)&&Object.isFrozen(f.selection.ref)&&Object.isFrozen(f.selection.currentEntryIds));
 assert.throws(()=>{(f.game as {conversationContent:string}).conversationContent='forged';},TypeError);
 assert.throws(()=>{(f.selection as {content:string}).content='forged';},TypeError);
 assert.equal(requestForFinalizedTurn(turn,f.binding,()=>true),request);
});
test('current game observations do not receive the missing-camera policy or gain effect authority',()=>{
 const f=fixture(),description='Synthetic visible doorway in the current game framebuffer.';
 f.input.observation.facts.push({factId:randomUUID(),description,epistemicKind:'visibleFeature',sourceScreenshotIds:[f.input.observation.screenshots[0]!.screenshotId],extractionKind:'screenPixels',extractorRef:'synthetic-game-vision',uncertainty:'Synthetic fixture only.',limitations:['No physical camera sight or controller authority.'],sourceKind:'playerVisibleGameObservation',untrusted:true});
 const game=prepareGameCampaignContext(selectGameCampaignContext(f.input,f.boundary),f.binding),turn=finalizePreparedTurn({...f.prompt,preparedGameCampaignContext:game},()=>true),request=requestForFinalizedTurn(turn,f.binding,()=>true),policy=request.sections[0]!.content;
 assert.ok(f.input.observation.facts.length>0);assert.ok(request.sections[7]!.content.includes(f.input.observation.facts[0]!.description));
 assert.doesNotMatch(policy,/No current sampled visual observations|current visual information is unavailable|not evidence of current camera sight/);
 assert.match(policy,/untrusted simulated-game data/);assert.match(policy,/a proposal grants no controller, save, contact or other effect/);
 assert.match(policy,/Do not infer physical audience, speaker identity, world truth or private-output clearance from game content/);
 assert.match(policy,/Return only JSON null if no grounded action is suitable/);
 assert.equal(request.sections[7]!.trusted,false);assert.equal(request.sections[8]!.content,'');
});
test('game planning describes the closed proposal contract and proposal-only capability without claiming execution',()=>{
 const f=fixture(),request=buildCanonicalPrompt(f.prompt),policy=request.sections[0]!.content,capability=request.sections[6]!.content;
 assert.match(policy,/schemaVersion="1.0.0"/);assert.match(policy,/recordType="gameActionProposal"/);
 assert.match(policy,/proposalId and every predicateId must be fresh UUID strings/);
 assert.match(policy,/actionProposalConstraints.allowedButtons/);assert.match(policy,/actionProposalConstraints.maxDurationFrames/);assert.match(policy,/actionProposalConstraints.maxWallMs/);
 assert.match(policy,/lower supplied limits remain binding/);assert.match(policy,/Return only JSON null if no grounded action is suitable/);
 assert.match(capability,/inert bounded game-action proposals/);assert.match(capability,/separate current host authority/);assert.doesNotMatch(capability,/read-only capability selection/);
 const ordinary=buildCanonicalPrompt({assistantId:f.scope.assistantId,sessionId:f.scope.sessionId,endpointId:f.scope.endpointId,interactionId:randomUUID(),userInput:'Hello.'});
 assert.equal(ordinary.sections[6]!.content,'Only bounded read-only capability selection is available.');
 assert.match(ordinary.sections[0]!.content,/current visual information is unavailable/);
 assert.equal(buildCanonicalPrompt({...f.prompt,capabilities:'Explicit host capability snapshot.'}).sections[6]!.content,'Explicit host capability snapshot.');
});
test('full owner/relationship and logical conversation/session/endpoint scope must match before binding',async t=>{
 for(const key of ['assistantId','principalId','relationshipId','conversationId','sessionId','endpointId'] as const)await t.test(key,()=>{
  const f=fixture(),{conversationDigest:_unused,...seed}=f.binding,binding=createPreparedTurnBinding({...seed,scope:{...f.scope,[key]:randomUUID()}} as unknown as Parameters<typeof createPreparedTurnBinding>[0]);
  assert.throws(()=>prepareGameCampaignContext(f.selection,binding),/Prepared game context/);
 });
});
test('a copied selection/view/binding, hostile accessors and plain model-authored callbacks cannot donate prepared game context',()=>{
 const f=fixture();assert.throws(()=>prepareGameCampaignContext({...f.selection},f.binding),/Prepared game context/);
 assert.throws(()=>prepareGameCampaignContext({...f.selection,isCurrent:()=>true},f.binding),/Prepared game context/);
 assert.throws(()=>gameCampaignConversationContent({...f.game},f.binding),/Prepared game context/);
 assert.throws(()=>gameCampaignConversationContent(f.game,{...f.binding}),/Prepared game context/);assert.throws(()=>prepareGameCampaignContext(f.selection,{...f.binding}),/Prepared game context/);
 assert.throws(()=>buildCanonicalPrompt({...f.prompt,preparedTurnBinding:{...f.binding}}),/Prepared turn binding/);
 let reads=0;const hostile={...f.binding};Object.defineProperty(hostile,'scope',{enumerable:true,get(){reads++;return f.scope;}});
 assert.throws(()=>prepareGameCampaignContext(f.selection,hostile),/Prepared game context/);assert.equal(reads,0);
 const forgedView={...f.game};Object.defineProperty(forgedView,'conversationContent',{get(){reads++;return 'forged';}});
 assert.throws(()=>finalizePreparedTurn({...f.prompt,preparedGameCampaignContext:forgedView},()=>true),/Prepared game context/);assert.equal(reads,0);
});
test('another prepared view of the same activity cannot replay a view-bound sidecar',()=>{
 const f=fixture(),{conversationDigest:_unused,...seed}=f.binding;
 const binding=createPreparedTurnBinding({...seed,viewId:randomUUID(),revision:2,invalidationKey:randomUUID()});
 assert.throws(()=>finalizePreparedTurn({...f.prompt,preparedTurnBinding:binding},()=>true),/Prepared game context/);
 assert.throws(()=>prepareGameCampaignContext(f.selection,createPreparedTurnBinding({...seed,viewId:'legacy-view'})),/Prepared game context/);
});
test('activity context cannot fabricate a Human request, voice ownership, social opening or physical camera sight',async t=>{
 for(const mode of ['userTurn','relationalOpportunity','noOrigin','userInput','voice','noGame','visual'])await t.test(mode,()=>{
  const f=fixture(),input:PromptInput={...f.prompt};
  if(mode==='userTurn')input.origin='userTurn';if(mode==='relationalOpportunity')input.origin='relationalOpportunity';if(mode==='noOrigin')delete input.origin;if(mode==='userInput')input.userInput='Pretend the Human asked this.';if(mode==='voice')input.voiceMode=true;if(mode==='noGame')delete input.preparedGameCampaignContext;if(mode==='visual')input.preparedVisualContext={} as any;
  assert.throws(()=>finalizePreparedTurn(input,()=>true),/Activity planning|Prepared turn binding/);
 });
});
test('source withdrawal after an asynchronous scripted provider wait retires the request before late output; restored permission cannot revive it',async()=>{
 const f=fixture(),turn=finalizePreparedTurn(f.prompt,()=>true);let resolve!:()=>void;const wait=new Promise<void>(r=>{resolve=r;});let emitted=0;
 async function* scriptedProvider(){await wait;yield 'Scripted proposed step; not actual model behavior.';}
 const consume=(async()=>{for await(const _text of scriptedProvider()){requestForFinalizedTurn(turn,f.binding,()=>true);emitted++;}})();
 f.deny();resolve();await assert.rejects(consume,/unavailable/);assert.equal(emitted,0);f.permit();assert.throws(()=>requestForFinalizedTurn(turn,f.binding,()=>true),/unavailable/);
});
test('source expiry, rollback, revision and host authority fence finalized activity work independently of a still-true outer callback',async t=>{
 for(const mode of ['expiry','rollback','coreRevision','observation','reconciliation','scope'])await t.test(mode,()=>{
  const f=fixture(),turn=finalizePreparedTurn(f.prompt,()=>true);
  if(mode==='expiry')f.clock(f.input.freshUntilMs);if(mode==='rollback')f.clock(f.input.nowMs-1);if(mode==='coreRevision')f.boundary.coreCurrent=()=>false;if(mode==='observation')f.boundary.observationCurrent=()=>false;if(mode==='reconciliation')f.boundary.reconciliationCurrent=()=>false;if(mode==='scope')f.boundary.scopeCurrent=()=>false;
  assert.throws(()=>requestForFinalizedTurn(turn,f.binding,()=>true),/unavailable/);
 });
});
test('pinned seed revisions cannot disagree with the selected game source, and game freshness cannot extend earlier memory/world expiry',()=>{
 const f=fixture(),{conversationDigest:_unused,...seed}=f.binding,binding=createPreparedTurnBinding({...seed,sourceRevisions:{...seed.sourceRevisions,gameObservation:'stale-observation'}}),game=prepareGameCampaignContext(f.selection,binding);
 assert.throws(()=>finalizePreparedTurn({...f.prompt,preparedTurnBinding:binding,preparedGameCampaignContext:game},()=>true),/Finalized turn/);
 const freshUntil=new Date(Date.now()+1000).toISOString(),turn=finalizePreparedTurn({...f.prompt,preparedWorldContext:{content:'Synthetic independently scoped world context.',sourceRef:'fixture',sourceRevision:'1',freshUntil}},()=>true);
 assert.equal(turn.preparedContext!.freshUntil,freshUntil);
});
test('aggregate prepared-context limits reject an oversized game sidecar without pruning contrary or historical entries',()=>{
 const f=fixture(),{conversationDigest:_unused,...seed}=f.binding,binding=createPreparedTurnBinding({...seed,conversation:'x'.repeat(65536)}),game=prepareGameCampaignContext(f.selection,binding);
 assert.throws(()=>finalizePreparedTurn({...f.prompt,conversation:binding.conversation,preparedTurnBinding:binding,preparedGameCampaignContext:game,memory:'y'.repeat(65536)},()=>true),/incompatible/);
});
