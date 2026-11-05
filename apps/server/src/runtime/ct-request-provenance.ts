import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type {ActivityScope} from '@lifestream/contracts/game-activity';
import type {InferenceProvider,InferenceRequest} from '@lifestream/runtime/inference';
import {isFinalizedTurnRequest,requestForFinalizedTurn,type FinalizedTurn} from '@lifestream/runtime/inference/prompt';
import type {GameInferenceSelection} from './game-host-runtime.ts';
import {gameDecisionHasPreparedIdentity,type PreparedGameCampaignContext} from '@lifestream/runtime/activity/game-journal';
import type {GamePlanningResult} from '@lifestream/runtime/activity/coordinator';
import type {PreparedTurnBinding} from '@lifestream/runtime/inference/prompt';

const kinds=['policy','corePersona','adaptivePersona','interactionState','preparedMemory','worldContext','capabilityState','conversation','userInput'] as const;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function fail():never{throw Error('CT finalized request provenance unavailable');}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const metadata=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&/^[\x20-\x7e]+$/.test(value);
function freeze<T>(value:T):Readonly<T>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}

export type CtRequestProvenanceInput={
 turn:FinalizedTurn;request:InferenceRequest;scope:Readonly<ActivityScope>;
 expectedProfile:Readonly<{profileId:string;revision:number}>;
 provider:InferenceProvider;providerSelection:()=>Readonly<GameInferenceSelection>|null;
 /** The original host owns authentication, scope and provider-registry currency. */
 current:()=>boolean;
 /** Passive ordinary audit: identity/privacy only; generation still needs its own live admission. */
 purpose?:'passiveOrdinaryCapture';
};
type SectionEvidence={kind:string;sourceRef:string;sourceRevision:string;contentDigest:string;redaction:'none'|'redacted';tokenCount:number;contentBytes:number};
type ScopeMetadata={assistantId:string;principalId:string;relationshipId:string|null;sessionId:string;conversationId:string;endpointId:string;interactionId:string};
export type CtRequestProvenance=Readonly<{
 schemaVersion:'ct-finalized-request-provenance/1';requestDigest:string;requestBytes:number;scopeDigest:string;
 scope:Readonly<ScopeMetadata>;
 profile:Readonly<{profileId:string;revision:number;sourceRef:string;sourceRevision:string}>;
 prepared:Readonly<{viewId:string;revision:number;invalidationKeyDigest:string}>;
 provider:Readonly<GameInferenceSelection>;sections:readonly Readonly<SectionEvidence>[];
 tokenizer:string;tokenMetadataMeaning:'original-section-estimates-not-measured-provider-tokens';
 genuineFinalizedRequestIdentity:true;authenticationMinted:false;gameplayAuthorized:false;
}>;
const generationChecks=new WeakMap<CtRequestProvenance,(request:InferenceRequest,provider:InferenceProvider)=>void>();
const captured=new WeakMap<CtRequestProvenance,(request:InferenceRequest,provider:InferenceProvider)=>void>();
const recorded=new WeakMap<CtRequestProvenance,{turn:FinalizedTurn;request:InferenceRequest;binding:PreparedTurnBinding}>();

function scopeMetadata(scope:Readonly<ActivityScope>,interactionId:string):ScopeMetadata{
 const c=scope.contextBinding;
 const value={assistantId:scope.assistantId,principalId:scope.principalId,relationshipId:scope.relationshipId,sessionId:c.sessionId,conversationId:c.conversationId,endpointId:c.endpointId,interactionId};
 if(Object.entries(value).some(([key,v])=>key==='relationshipId'&&v===null?false:!uuid(v)))fail();
 return value as ScopeMetadata;
}
function scopeDigest(scope:Readonly<ActivityScope>):string{const body=JSON.stringify(scope);if(Buffer.byteLength(body)>16384)fail();return sha(body);}
function selectionMetadata(value:Readonly<GameInferenceSelection>|null):GameInferenceSelection{
 if(!value||!digest(value.configurationDigest)||!metadata(value.providerRef,512)||!metadata(value.providerRevision,512)||!metadata(value.model,512)||value.modelArtifactDigest!==null&&!(typeof value.modelArtifactDigest==='string'&&/^(?:sha256:)?[a-f0-9]{64}$/.test(value.modelArtifactDigest))||value.healthy!==true||value.fixture!==false)fail();
 return {configurationDigest:value.configurationDigest,providerRef:value.providerRef,providerRevision:value.providerRevision,model:value.model,modelArtifactDigest:value.modelArtifactDigest,healthy:true,fixture:false};
}

/** Metadata only. A DTO with identical fields is not an original finalized turn.
 * This proves neither authentication nor native/gameplay authority. Observation
 * and action evidence belong in separate, explicitly allowlisted records. */
export function captureCtRequestProvenance(input:CtRequestProvenanceInput):CtRequestProvenance{
 const {turn,request,provider,current,providerSelection}=input,generate=provider?.generate;
 const purpose=input.purpose,passive=purpose==='passiveOrdinaryCapture';if(purpose!==undefined&&!passive)fail();
 const profile={profileId:input.expectedProfile.profileId,revision:input.expectedProfile.revision};
 if(!uuid(profile.profileId)||!Number.isSafeInteger(profile.revision)||profile.revision<1||typeof current!=='function'||typeof providerSelection!=='function'||!provider||typeof provider.generate!=='function')fail();
 const checkCurrent=()=>{try{if(input.purpose!==purpose||input.current!==current||input.providerSelection!==providerSelection||input.provider!==provider||provider.generate!==generate||current()!==true)fail();}catch{fail();}};
 checkCurrent();
 if(!isFinalizedTurnRequest(turn,request)||!turn.binding||!turn.preparedContext)fail();
 const binding=turn.binding,scope=scopeMetadata(input.scope,request.scope.interactionId),scopePin=scopeDigest(input.scope),selected=selectionMetadata(providerSelection());
 const canonicalRequest=()=>passive?(isFinalizedTurnRequest(turn,request)?request:fail()):requestForFinalizedTurn(turn,binding,current);
 const collect=():CtRequestProvenance=>{
  checkCurrent();
  if(!isFinalizedTurnRequest(turn,request)||canonicalRequest()!==request||input.turn!==turn||input.request!==request||input.expectedProfile.profileId!==profile.profileId||input.expectedProfile.revision!==profile.revision||scopeDigest(input.scope)!==scopePin||JSON.stringify(scopeMetadata(input.scope,request.scope.interactionId))!==JSON.stringify(scope)||JSON.stringify(selectionMetadata(providerSelection()))!==JSON.stringify(selected))fail();
  const b=binding.scope;
  if(b.assistantId!==scope.assistantId||b.principalId!==scope.principalId||b.relationshipId!==scope.relationshipId||b.sessionId!==scope.sessionId||b.conversationId!==scope.conversationId||b.endpointId!==scope.endpointId||request.scope.assistantId!==scope.assistantId||request.scope.sessionId!==scope.sessionId||request.scope.endpointId!==scope.endpointId||request.executionMode!=='live'||!Number.isFinite(Date.parse(request.deadlineAt))||Date.parse(request.deadlineAt)<=Date.now())fail();
  if(request.sections.length!==9||request.manifest.schemaVersion!=='1.0.0'||request.manifest.sections!==turn.sections||request.manifest.sections.length!==9||!metadata(request.manifest.tokenizer,256))fail();
  let total=0;
  const sections=request.sections.map((s,index)=>{
   const m=request.manifest.sections[index]!;
   if(s.kind!==kinds[index]||typeof s.content!=='string'||!metadata(s.sourceRef,2048)||!metadata(s.sourceRevision,2048)||!digest(s.contentDigest)||!Number.isSafeInteger(s.tokenCount)||s.tokenCount<0||!['none','redacted'].includes(s.redaction))fail();
   const bytes=Buffer.byteLength(s.content);total+=bytes;
   if(bytes>131072||total>524288||sha(s.content)!==s.contentDigest||s.tokenCount!==bytes||m.kind!==s.kind||m.sourceRef!==s.sourceRef||m.sourceRevision!==s.sourceRevision||m.contentDigest!==s.contentDigest||m.redaction!==s.redaction||m.tokenCount!==s.tokenCount)fail();
   return {kind:s.kind,sourceRef:s.sourceRef,sourceRevision:s.sourceRevision,contentDigest:s.contentDigest,redaction:s.redaction,tokenCount:s.tokenCount,contentBytes:bytes};
  });
  const core=request.sections[1]!,adaptive=request.sections[2]!,expectedRef='assistant-profile:'+profile.profileId;
  const expectedRevision=new RegExp('^'+profile.revision+':adaptations:[a-f0-9]{64}$');
  if(!core.trusted||!adaptive.trusted||core.sourceRef!==expectedRef||adaptive.sourceRef!==expectedRef||!expectedRevision.test(core.sourceRevision)||adaptive.sourceRevision!==core.sourceRevision||binding.sourceRevisions.persona!==core.sourceRevision||turn.sourceRevisions['section:corePersona']!==core.sourceRevision||turn.sourceRevisions['section:adaptivePersona']!==core.sourceRevision||!core.content.trim()||!adaptive.content.trim()||!request.sections[3]!.content.includes('origin=activityStep;')||request.sections[8]!.content!=='')fail();
  const serialized=JSON.stringify(request);if(Buffer.byteLength(serialized)>1048576)fail();
  checkCurrent();
  if(canonicalRequest()!==request||JSON.stringify(selectionMetadata(providerSelection()))!==JSON.stringify(selected))fail();
  return freeze({schemaVersion:'ct-finalized-request-provenance/1',requestDigest:sha(serialized),requestBytes:Buffer.byteLength(serialized),scopeDigest:scopePin,scope:{...scope},profile:{...profile,sourceRef:expectedRef,sourceRevision:core.sourceRevision},prepared:{viewId:binding.viewId,revision:binding.revision,invalidationKeyDigest:sha(binding.invalidationKey)},provider:{...selected},sections,tokenizer:request.manifest.tokenizer,tokenMetadataMeaning:'original-section-estimates-not-measured-provider-tokens',genuineFinalizedRequestIdentity:true,authenticationMinted:false,gameplayAuthorized:false});
 };
 const evidence=collect();
 // The original mint recursively freezes the complete request and binds it in
 // a private WeakMap. Static section/hash evidence cannot change in place.
 // Currency and the mutable owner/provider inputs must still be checked on
 // every use, including mutations performed by a currentness callback itself.
 const mutableIdentities=()=>{
  if(input.purpose!==purpose||input.turn!==turn||input.request!==request||input.expectedProfile.profileId!==profile.profileId||input.expectedProfile.revision!==profile.revision||scopeDigest(input.scope)!==scopePin||input.current!==current||input.providerSelection!==providerSelection||input.provider!==provider||provider.generate!==generate)fail();
 };
 const mutableCurrent=()=>{
  mutableIdentities();
  if(JSON.stringify(selectionMetadata(providerSelection()))!==JSON.stringify(selected))fail();
  mutableIdentities();checkCurrent();mutableIdentities();
  return true;
 };
 const generationCheck=(actualRequest:InferenceRequest,actualProvider:InferenceProvider)=>{
  if(actualRequest!==request||actualProvider!==provider)fail();
  mutableIdentities();
  if(requestForFinalizedTurn(turn,binding,mutableCurrent)!==request)fail();
  // The final original entry.current callback also runs inside the canonical
  // check. Catch any mutable-input/provider changes it made before returning.
  mutableCurrent();
  // The post-return callbacks above can consume time or withdraw an entry-only
  // source. Keep the original final canonical bracket rather than caching its
  // authority result. The final provider metadata read was also in collect().
  if(requestForFinalizedTurn(turn,binding,current)!==request||JSON.stringify(selectionMetadata(providerSelection()))!==JSON.stringify(selected))fail();
  mutableIdentities();
 };
 generationChecks.set(evidence,generationCheck);
 captured.set(evidence,passive?(actualRequest,actualProvider)=>{
  if(actualRequest!==request||actualProvider!==provider||!isFinalizedTurnRequest(turn,request))fail();
  mutableCurrent();mutableIdentities();
 }:generationCheck);
 recorded.set(evidence,{turn,request,binding});
 return evidence;
}

/** Call on the exact request/provider immediately before original generate().
 * Exported JSON or a copied evidence DTO cannot reconstitute this identity. */
export function assertCtRequestProvenance(evidence:CtRequestProvenance,actualRequest:InferenceRequest,actualProvider:InferenceProvider):void{
 const check=captured.get(evidence);if(!check)fail();check(actualRequest,actualProvider);
}

/** Real provider admission: always run the original complete live source brackets,
 * including for a proof collected by the passive ordinary diagnostic sink. */
export function assertCtRequestGenerationCurrent(evidence:CtRequestProvenance,request:InferenceRequest,provider:InferenceProvider):void{
 const check=generationChecks.get(evidence);if(!check)fail();check(request,provider);
}

/** Let queued cancellation/native timers run before checking a buffered chunk.
 * This waits for no provider data and creates no new deadline or authority. */
export async function assertCtRequestProvenanceAfterYield(evidence:CtRequestProvenance,actualRequest:InferenceRequest,actualProvider:InferenceProvider,signal:AbortSignal):Promise<void>{
 await new Promise<void>(resolve=>setImmediate(resolve));
 signal.throwIfAborted();
 assertCtRequestProvenance(evidence,actualRequest,actualProvider);
}

const visibleFields=new Set(['ct.ui.controller-domain','ct.ui.scene','ct.ui.dialogue.text','ct.ui.dialogue.present','ct.ui.player.x','ct.ui.player.y']);
// The native decoder always adds these pixel observations. Their identifiers
// belong in decision provenance, without making them controller preconditions.
const selectedObservationFields=new Set([...visibleFields,'display.visible.isEntirelyBlack','display.visible.rgbSha256']);
const validator=createContractValidator();
export type CtDecisionProvenanceInput={
 requestEvidence:CtRequestProvenance;result:GamePlanningResult;
 game:PreparedGameCampaignContext;binding:PreparedTurnBinding;
 rawResponseDigest:string;inputMode:'textual-reviewed-frame-facts';
};
type SafePredicate=Readonly<{predicateId:string;fieldId:string;sourceObservationId:string;expectedValueDigest:string;expectedValueType:'string'|'number'|'boolean';expectedNumber?:number}>;
type SafeProposal=Readonly<{proposalId:string;observationId:string;observationRevision:number;preparedViewId:string;preparedViewRevision:number;invalidationKeyDigest:string;buttons:readonly string[];durationFrames:number;maxWallMs:number;preconditions:readonly SafePredicate[]}>;
export type CtDecisionProvenance=Readonly<{
 schemaVersion:'ct-validated-model-decision/1';requestDigest:string;responseDigest:string;
 inputMode:'textual-reviewed-frame-facts';scopeDigest:string;scope:Readonly<ScopeMetadata>;
 decision:Readonly<{viewId:string;viewRevision:number;invalidationKeyDigest:string;observationId:string;observationRevision:number;selectedFactIds:readonly string[];selectedVisibleFieldIds:readonly string[];recentActionIds:readonly string[];selectedCampaignGoalIds:readonly string[];selectedCurrentCampaignEntryIds:readonly string[];conversationSectionDigest:string;preparedMemorySectionDigest:string|null}>;
 proposal:SafeProposal|null;inputTokens:number;outputTokens:number;tokenizerIdentity:string;
 privateFreeTextOmitted:true;recordedIdentityOnly:true;gameplayAuthorized:false;
 responseDigestMeaning:'provided-by-original-stream-hook-not-recomputed-here';
}>;
function ids(values:readonly string[],maximum:number):string[]{
 if(!Array.isArray(values)||values.length>maximum||values.some(v=>!uuid(v))||new Set(values).size!==values.length)fail();return [...values];
}

/** Closed archival DTO, not a new validity/dispatch grant. Publishing a decision
 * can retire its prepared context; use the original identity-only predicate,
 * without refreshing or manufacturing currency. No response free text escapes. */
export function captureCtDecisionProvenance(input:CtDecisionProvenanceInput):CtDecisionProvenance{
 const {requestEvidence:e,result,game,binding}=input,entry=recorded.get(e);
 if(!entry||!isFinalizedTurnRequest(entry.turn,entry.request)||entry.binding!==binding||!digest(input.rawResponseDigest)||input.inputMode!=='textual-reviewed-frame-facts')fail();
 const d=result.decisionInput;
 if(!gameDecisionHasPreparedIdentity(game,binding,d)||game.viewId!==e.prepared.viewId||game.revision!==e.prepared.revision||sha(game.invalidationKey)!==e.prepared.invalidationKeyDigest||game.conversationSectionDigest!==entry.request.sections[7]!.contentDigest||d.viewId!==e.prepared.viewId||d.viewRevision!==e.prepared.revision||sha(d.invalidationKey)!==e.prepared.invalidationKeyDigest||scopeDigest(d.scope)!==e.scopeDigest||d.conversationSectionDigest!==entry.request.sections[7]!.contentDigest||d.preparedMemorySectionDigest!==entry.request.sections[4]!.contentDigest||!uuid(d.observationId)||!Number.isSafeInteger(d.observationRevision)||d.observationRevision<1||!Number.isSafeInteger(result.inputTokens)||result.inputTokens<1||result.inputTokens>32768||d.inputTokens!==result.inputTokens||!Number.isSafeInteger(result.outputTokens)||result.outputTokens<1||result.outputTokens>4096||result.tokenizerIdentity!=='selected-model-tokenizer:'+e.provider.model)fail();
 const selectedFields=d.selectedVisibleFieldIds;
 if(!Array.isArray(selectedFields)||selectedFields.length>7||selectedFields.some(f=>!selectedObservationFields.has(f))||new Set(selectedFields).size!==selectedFields.length)fail();
 let proposal:SafeProposal|null=null;
 if(result.proposal!==null){
  const p=boundedGameDataSnapshot(result.proposal,32768) as GamePlanningResult['proposal'];
  if(!p||!validator.validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/GameActionProposal',p).valid||!isDeepStrictEqual(p.scope,d.scope)||p.observationId!==d.observationId||p.observationRevision!==d.observationRevision||p.preparedViewId!==d.viewId||p.preparedViewRevision!==d.viewRevision||p.invalidationKey!==d.invalidationKey||p.buttons.length>12||new Set(p.buttons).size!==p.buttons.length||p.buttons.includes('up')&&p.buttons.includes('down')||p.buttons.includes('left')&&p.buttons.includes('right'))fail();
  const predicates=p.preconditions.map(v=>{
   if(!visibleFields.has(v.fieldId)||!selectedFields.includes(v.fieldId)||v.sourceObservationId!==d.observationId||!uuid(v.predicateId))fail();
   const type=typeof v.expectedValue;
   if(!['string','number','boolean'].includes(type)||type==='number'&&!Number.isFinite(v.expectedValue)||type==='string'&&Buffer.byteLength(v.expectedValue as string)>2000)fail();
   if(v.fieldId==='ct.ui.dialogue.present'&&type!=='boolean')fail();
   if((v.fieldId==='ct.ui.player.x'||v.fieldId==='ct.ui.player.y')&&(!Number.isSafeInteger(v.expectedValue)||Number(v.expectedValue)<0||Number(v.expectedValue)>4095))fail();
   return {predicateId:v.predicateId,fieldId:v.fieldId,sourceObservationId:v.sourceObservationId,expectedValueDigest:sha(JSON.stringify(v.expectedValue)),expectedValueType:type as 'string'|'number'|'boolean',...((v.fieldId==='ct.ui.player.x'||v.fieldId==='ct.ui.player.y')?{expectedNumber:Number(v.expectedValue)}:{})};
  });
  if(new Set(predicates.map(v=>v.predicateId)).size!==predicates.length||new Set(predicates.map(v=>v.fieldId)).size!==predicates.length)fail();
  proposal={proposalId:p.proposalId,observationId:p.observationId,observationRevision:p.observationRevision,preparedViewId:p.preparedViewId,preparedViewRevision:p.preparedViewRevision,invalidationKeyDigest:e.prepared.invalidationKeyDigest,buttons:[...p.buttons],durationFrames:p.durationFrames,maxWallMs:p.maxWallMs,preconditions:predicates};
 }
 return freeze({schemaVersion:'ct-validated-model-decision/1',requestDigest:e.requestDigest,responseDigest:input.rawResponseDigest,inputMode:input.inputMode,scopeDigest:e.scopeDigest,scope:{...e.scope},decision:{viewId:d.viewId,viewRevision:d.viewRevision,invalidationKeyDigest:e.prepared.invalidationKeyDigest,observationId:d.observationId,observationRevision:d.observationRevision,selectedFactIds:ids(d.selectedFactIds,128),selectedVisibleFieldIds:[...selectedFields],recentActionIds:ids(d.recentActionIds,128),selectedCampaignGoalIds:ids(d.selectedCampaignGoalIds,64),selectedCurrentCampaignEntryIds:ids(d.selectedCurrentCampaignEntryIds,128),conversationSectionDigest:d.conversationSectionDigest,preparedMemorySectionDigest:d.preparedMemorySectionDigest},proposal,inputTokens:result.inputTokens,outputTokens:result.outputTokens,tokenizerIdentity:result.tokenizerIdentity,privateFreeTextOmitted:true,recordedIdentityOnly:true,gameplayAuthorized:false,responseDigestMeaning:'provided-by-original-stream-hook-not-recomputed-here'});
}
