import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn,type PromptInput} from '@lifestream/runtime/inference/prompt';
import {selectGameCampaignContext,prepareGameCampaignContext,gameDecisionInput} from '@lifestream/runtime/activity/game-journal';
import type {GamePlanningResult} from '@lifestream/runtime/activity/coordinator';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import type {ActivityScope} from '@lifestream/contracts/game-activity';
import type {InferenceProvider} from '@lifestream/runtime/inference';
import {captureCtRequestProvenance,assertCtRequestProvenance,captureCtDecisionProvenance,type CtRequestProvenanceInput} from '../src/runtime/ct-request-provenance.ts';

const secretPersona='SYNTHETIC_PERSONA_NEVER_EXPORT';
const secretHistory='SYNTHETIC_HISTORY_NEVER_EXPORT';
const secretPermission='SYNTHETIC_AUTHORITY_REFERENCE_NEVER_EXPORT';
const secretInvalidation='ef9a21cc-6be7-4136-b123-123456789abc';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Original minting functions with synthetic values only. No auth, selected
 * provider, actual Tifa profile or gameplay is established by these fixtures. */
function fixture(patch:Partial<PromptInput>={},revision=3,additionalFields:string[]=[]){
 let current=true,generations=0;
 const campaign=gameCampaignFixture(),scope:ActivityScope=campaign.input.expectedScope;
 scope.contextBinding.ownerPermissionRef=secretPermission;
 campaign.input.journal.summary=secretHistory;
 const observation=campaign.input.observation;
 observation.visibleState=[{fieldId:'ct.ui.scene',value:secretHistory,visibility:'visibleNow',firstObservedRef:observation.observationId,lastObservedRef:observation.observationId,timelineId:scope.timelineId,observedAt:observation.capturedAt,freshUntil:new Date(campaign.input.freshUntilMs).toISOString(),decoderRevision:'1.0.0',manifestDigest:'a'.repeat(64),limitations:[]}];
 observation.visibleState.push(...additionalFields.map(fieldId=>({...observation.visibleState[0]!,fieldId,value:fieldId==='display.visible.isEntirelyBlack'?false:sha('synthetic-pixels')})));
 const profileId=randomUUID(),sourceRevision=revision+':adaptations:'+sha('[]');
 const binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:secretInvalidation,scope:{assistantId:scope.assistantId,principalId:scope.principalId,relationshipId:scope.relationshipId,conversationId:scope.contextBinding.conversationId,sessionId:scope.contextBinding.sessionId!,endpointId:scope.contextBinding.endpointId},conversation:secretHistory,sourceRevisions:Object.hasOwn(patch,'profileProjection')&&patch.profileProjection===undefined?{fixture:'synthetic-boundary:1'}:{persona:sourceRevision}});
 const campaignSelection=selectGameCampaignContext(campaign.input,campaign.boundary);assert.equal(campaignSelection.status,'selected');
 const game=prepareGameCampaignContext(campaignSelection,binding);
 const turn=finalizePreparedTurn({assistantId:scope.assistantId,sessionId:scope.contextBinding.sessionId!,endpointId:scope.contextBinding.endpointId,interactionId:randomUUID(),origin:'activityStep',conversation:secretHistory,userInput:'',preparedTurnBinding:binding,preparedGameCampaignContext:game,profileProjection:{sourceRef:'assistant-profile:'+profileId,sourceRevision,corePersona:secretPersona,adaptivePersona:'SYNTHETIC_ADAPTIVE_NEVER_EXPORT'},...patch},()=>current);
 const request=requestForFinalizedTurn(turn,binding,()=>current);
 const provider={async *generate(){generations++;throw Error('Synthetic provider must never be called');}} as InferenceProvider;
 let selection={configurationDigest:sha('synthetic-configuration'),providerRef:'synthetic-provider-metadata',providerRevision:'synthetic-revision:1',model:'synthetic-model',modelArtifactDigest:sha('synthetic-model'),healthy:true,fixture:false};
 const input:CtRequestProvenanceInput={turn,request,scope,expectedProfile:{profileId,revision},provider,providerSelection:()=>selection,current:()=>current};
 return {input,sourceRevision,request,provider,turn,scope,game,binding,campaign,setCurrent:(v:boolean)=>{current=v;},setSelection:(v:Partial<typeof selection>)=>{selection={...selection,...v};},generations:()=>generations};
}

test('genuine finalized identity produces bounded frozen metadata without private request bodies',()=>{
 const f=fixture(),e=captureCtRequestProvenance(f.input);
 assertCtRequestProvenance(e,f.request,f.provider);
 assert.equal(e.requestDigest,sha(JSON.stringify(f.request)));
 assert.equal(e.requestBytes,Buffer.byteLength(JSON.stringify(f.request)));
 assert.equal(e.profile.sourceRevision,f.sourceRevision);
 assert.equal(e.sections.length,9);
 for(const [i,s]of e.sections.entries()){
  assert.equal(s.contentDigest,sha(f.request.sections[i]!.content));
  assert.equal(s.tokenCount,f.request.manifest.sections[i]!.tokenCount);
  assert.equal(Object.hasOwn(s,'content'),false);
 }
 const serialized=JSON.stringify(e);
 for(const text of [secretPersona,secretHistory,secretPermission,'SYNTHETIC_ADAPTIVE_NEVER_EXPORT',secretInvalidation])assert.equal(serialized.includes(text),false);
 assert.equal(e.authenticationMinted,false);assert.equal(e.gameplayAuthorized,false);
 assert.equal(e.tokenMetadataMeaning,'original-section-estimates-not-measured-provider-tokens');
 assert.ok(Object.isFrozen(e)&&Object.isFrozen(e.sections)&&Object.isFrozen(e.sections[0])&&Object.isFrozen(e.provider));
 assert.equal(f.generations(),0);
});

test('matching request DTO, copied turn and copied evidence never recreate original identities',()=>{
 const f=fixture(),e=captureCtRequestProvenance(f.input),copy=structuredClone(f.request);
 assert.throws(()=>captureCtRequestProvenance({...f.input,request:copy}),/provenance unavailable/);
 assert.throws(()=>captureCtRequestProvenance({...f.input,turn:{...f.turn}}),/provenance unavailable/);
 assert.throws(()=>assertCtRequestProvenance(e,copy,f.provider),/provenance unavailable/);
 assert.throws(()=>assertCtRequestProvenance(structuredClone(e),f.request,f.provider),/provenance unavailable/);
 assert.equal(f.generations(),0);
});

test('provider boundary rejects substituted provider, metadata drift and currency loss',()=>{
 for(const change of ['object','method','revision','configuration','model','unhealthy','fixture','scope'] as const){
  const f=fixture(),e=captureCtRequestProvenance(f.input);
  if(change==='object'){assert.throws(()=>assertCtRequestProvenance(e,f.request,{...f.provider}),/provenance unavailable/);continue;}
  if(change==='method')f.provider.generate=async function*(){throw Error('replacement never called');};
  if(change==='revision')f.setSelection({providerRevision:'replacement'});
  if(change==='configuration')f.setSelection({configurationDigest:sha('replacement')});
  if(change==='model')f.setSelection({model:'replacement'});
  if(change==='unhealthy')f.setSelection({healthy:false});
  if(change==='fixture')f.setSelection({fixture:true});
  if(change==='scope')f.setCurrent(false);
  assert.throws(()=>assertCtRequestProvenance(e,f.request,f.provider),/provenance unavailable|Finalized turn/);
  assert.equal(f.generations(),0);
 }
});

test('provider callback that retires the original turn is refused before evidence publication',()=>{
 const f=fixture();f.input.providerSelection=()=>{f.setCurrent(false);return {configurationDigest:sha('x'),providerRef:'synthetic',providerRevision:'1',model:'synthetic',modelArtifactDigest:null,healthy:true,fixture:false};};
 assert.throws(()=>captureCtRequestProvenance(f.input),/provenance unavailable|Finalized turn/);
});

test('wrong expected profile ID or revision rejects an otherwise genuine finalized request',()=>{
 const f=fixture();
 assert.throws(()=>captureCtRequestProvenance({...f.input,expectedProfile:{profileId:randomUUID(),revision:3}}),/provenance unavailable/);
 assert.throws(()=>captureCtRequestProvenance({...f.input,expectedProfile:{...f.input.expectedProfile,revision:30}}),/provenance unavailable/);
});

test('neutral unselected fallback does not count as the expected Tifa persona',()=>{
 const f=fixture({profileProjection:undefined});
 assert.throws(()=>captureCtRequestProvenance(f.input),/provenance unavailable/);
});

test('wrong source revision, activity origin and nonempty Human input refuse provenance',()=>{
 // Build each through the original mint; do not fake a WeakMap entry.
 for(const patch of [{origin:'userTurn' as const},{userInput:'not an activity step'}]){
  assert.throws(()=>fixture(patch),/Activity planning|Prepared game context|Prepared turn binding/);
 }
 const f=fixture();f.input.expectedProfile={profileId:f.input.expectedProfile.profileId,revision:2};
 assert.throws(()=>captureCtRequestProvenance(f.input),/provenance unavailable/);
});

test('scope and expected-profile mutation after capture cannot reuse admitted evidence',()=>{
 for(const which of ['scope','run','profile','callback'] as const){
  const f=fixture(),e=captureCtRequestProvenance(f.input);
  if(which==='scope')f.scope.contextBinding.endpointId=randomUUID();
  if(which==='run')f.scope.runId=randomUUID();
  if(which==='profile')f.input.expectedProfile={...f.input.expectedProfile,revision:4};
  if(which==='callback')f.input.current=()=>true;
  assert.throws(()=>assertCtRequestProvenance(e,f.request,f.provider),/provenance unavailable/);
 }
});

test('existing prefixed model artifact digest is preserved rather than normalized',()=>{
 const f=fixture();f.setSelection({modelArtifactDigest:'sha256:'+sha('model')});
 const evidence=captureCtRequestProvenance(f.input);
 assert.equal(evidence.provider.modelArtifactDigest,'sha256:'+sha('model'));
 assertCtRequestProvenance(evidence,f.request,f.provider);
});

test('request content/manifest mutations are refused; error exports no submitted body',()=>{
 const f=fixture();
 for(const mutate of [(r:typeof f.request)=>{r.sections[1]!.content='PRIVATE_MUTATION';},(r:typeof f.request)=>{r.manifest.sections[1]!.contentDigest=sha('PRIVATE_MUTATION');}]){
  const altered=structuredClone(f.request);mutate(altered);
  assert.throws(()=>captureCtRequestProvenance({...f.input,request:altered}),(error:Error)=>error.message==='CT finalized request provenance unavailable'&&!JSON.stringify(error).includes('PRIVATE_MUTATION'));
 }
});

test('original immutable finalized request and section manifest reject in-place tampering',()=>{
 const f=fixture();
 assert.throws(()=>{f.request.sections[1]!.content='changed';},TypeError);
 assert.throws(()=>{f.request.manifest.sections[1]!.sourceRef='changed';},TypeError);
 assertCtRequestProvenance(captureCtRequestProvenance(f.input),f.request,f.provider);
});

function decisionFixture(additionalFields:string[]=[]){
 const f=fixture({},3,additionalFields),requestEvidence=captureCtRequestProvenance(f.input),now=Date.now();
 const decision=gameDecisionInput(f.game,f.binding,f.request,100,now,f.game.expiresAtMs);
 const result:GamePlanningResult={decisionInput:decision,inputTokens:100,outputTokens:30,tokenizerIdentity:'selected-model-tokenizer:'+requestEvidence.provider.model,proposal:{schemaVersion:'1.0.0',recordType:'gameActionProposal',scope:f.scope,proposalId:randomUUID(),observationId:decision.observationId,observationRevision:decision.observationRevision,preparedViewId:decision.viewId,preparedViewRevision:decision.viewRevision,invalidationKey:secretInvalidation,buttons:['left'],durationFrames:12,maxWallMs:500,expectedVisibleOutcome:'PRIVATE_EXPECTED_OUTCOME',uncertainty:'PRIVATE_UNCERTAINTY',reason:'PRIVATE_REASON',adviceRefs:[],preconditions:[{predicateId:randomUUID(),fieldId:'ct.ui.scene',expectedValue:secretHistory,sourceObservationId:decision.observationId}]}};
 const input={requestEvidence,result,game:f.game,binding:f.binding,rawResponseDigest:sha(JSON.stringify(result.proposal)),inputMode:'textual-reviewed-frame-facts' as const};
 return {...f,result,decision,input};
}

test('closed decision metadata joins original identity and hashes every private free-text value',()=>{
 const f=decisionFixture(),e=captureCtDecisionProvenance(f.input),body=JSON.stringify(e);
 assert.equal(e.requestDigest,f.input.requestEvidence.requestDigest);
 assert.equal(e.decision.observationId,f.decision.observationId);
 assert.equal(e.decision.invalidationKeyDigest,sha(secretInvalidation));
 assert.equal(e.proposal!.preconditions[0]!.expectedValueDigest,sha(JSON.stringify(secretHistory)));
 assert.deepEqual(e.proposal!.buttons,['left']);assert.equal(e.proposal!.durationFrames,12);
 for(const text of [secretInvalidation,secretPermission,secretPersona,secretHistory,'PRIVATE_REASON','PRIVATE_UNCERTAINTY','PRIVATE_EXPECTED_OUTCOME','SYNTHETIC_ADAPTIVE_NEVER_EXPORT'])assert.equal(body.includes(text),false);
 assert.equal(Object.hasOwn(e,'decisionInput'),false);assert.equal(Object.hasOwn(e.proposal!,'scope'),false);
 assert.equal(e.recordedIdentityOnly,true);assert.equal(e.gameplayAuthorized,false);
 assert.ok(Object.isFrozen(e)&&Object.isFrozen(e.proposal)&&Object.isFrozen(e.proposal!.preconditions));
 assert.equal(f.generations(),0);
});

test('copied decision/game/binding or mismatched request evidence cannot donate original decision identity',()=>{
 const f=decisionFixture();
 for(const patch of [{result:{...f.result,decisionInput:structuredClone(f.decision)}},{game:{...f.game}},{binding:{...f.binding}},{requestEvidence:structuredClone(f.input.requestEvidence)},{requestEvidence:decisionFixture().input.requestEvidence}])assert.throws(()=>captureCtDecisionProvenance({...f.input,...patch}),/provenance unavailable/);
});

test('decision archival remains attributable after current context retires without granting renewed use',()=>{
 const f=decisionFixture();f.setCurrent(false);f.campaign.deny();
 const e=captureCtDecisionProvenance(f.input);assert.equal(e.recordedIdentityOnly,true);assert.equal(e.gameplayAuthorized,false);
 assert.throws(()=>assertCtRequestProvenance(f.input.requestEvidence,f.request,f.provider),/provenance unavailable|Finalized turn/);
});

test('mismatched proposal scope, view, observation, counters and raw digest refuse without exporting body',()=>{
 const f=decisionFixture(),p=f.result.proposal!;
 for(const patch of [{scope:{...p.scope,principalId:randomUUID()}},{preparedViewId:randomUUID()},{observationId:randomUUID()},{invalidationKey:randomUUID()},{buttons:['left','right']},{reason:secretHistory,preconditions:[{...p.preconditions[0],fieldId:'private.history',expectedValue:secretHistory}]}])assert.throws(()=>captureCtDecisionProvenance({...f.input,result:{...f.result,proposal:{...p,...patch} as typeof p}}),(error:Error)=>error.message==='CT finalized request provenance unavailable');
 for(const patch of [{inputTokens:101},{outputTokens:4097},{tokenizerIdentity:'PRIVATE_REASON'}])assert.throws(()=>captureCtDecisionProvenance({...f.input,result:{...f.result,...patch}}),/provenance unavailable/);
 assert.throws(()=>captureCtDecisionProvenance({...f.input,rawResponseDigest:secretHistory}),/provenance unavailable/);
});

test('explicit null decision emits no invented proposal or raw private decision fields',()=>{
 const f=decisionFixture(['display.visible.isEntirelyBlack','display.visible.rgbSha256']),e=captureCtDecisionProvenance({...f.input,result:{...f.result,proposal:null,outputTokens:1},rawResponseDigest:sha('null')});
 assert.equal(e.proposal,null);assert.equal(e.responseDigest,sha('null'));assert.equal(JSON.stringify(e).includes(secretHistory),false);
 assert.deepEqual(e.decision.selectedVisibleFieldIds,['ct.ui.scene','display.visible.isEntirelyBlack','display.visible.rgbSha256']);
 assert.equal(e.outputTokens,1);assert.equal(e.gameplayAuthorized,false);
});

test('pixel observation identity does not expand controller preconditions or accept unknown fields',()=>{
 const f=decisionFixture(['display.visible.isEntirelyBlack','display.visible.rgbSha256']);
 const p=f.result.proposal!;
 assert.doesNotThrow(()=>captureCtDecisionProvenance(f.input));
 for(const fieldId of ['display.visible.isEntirelyBlack','display.visible.rgbSha256'])assert.throws(()=>captureCtDecisionProvenance({...f.input,result:{...f.result,proposal:{...p,preconditions:[{...p.preconditions[0]!,fieldId}]}}}),/provenance unavailable/);
 const unknown=decisionFixture(['private.unreviewed.field']);
 assert.throws(()=>captureCtDecisionProvenance({...unknown.input,result:{...unknown.result,proposal:null}}),/provenance unavailable/);
});
