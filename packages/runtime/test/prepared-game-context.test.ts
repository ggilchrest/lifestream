import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import {selectGameCampaignContext,prepareGameCampaignContext,gameCampaignConversationContent} from '../src/activity/game-journal.ts';
import {buildCanonicalPrompt,createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn,type PromptInput} from '../src/inference/prompt.ts';
import {gameCampaignFixture} from './fixtures/game-campaign.ts';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
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
