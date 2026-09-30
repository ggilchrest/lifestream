import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot,campaignJournalSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {selectCampaignContext} from './journal.ts';
import {isPreparedTurnBinding,type PreparedTurnBinding} from '../inference/prompt.ts';
import {hasCanonicalContextScope} from '../context/prepared-view.ts';
import type {InferenceRequest} from '../inference/port.ts';
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
export type GameCampaignContextInput={binding:G.GameCampaignJournal;journal:G.CampaignJournal;observation:G.GameObservation;expectedScope:G.ActivityScope;pinsDigest:string;maximumObservationAgeMs:number;freshUntilMs:number;maximumBytes:number;nowMs:number};
export type GameCampaignContextBoundary={
 /** Exact installed/graphical/source/authority qualification is host truth. */
 scopeCurrent:(scope:G.ActivityScope,pinsDigest:string)=>boolean;
 coreCurrent:(ref:G.CampaignJournalRef,journal:G.CampaignJournal)=>boolean;
 observationCurrent:(observation:G.GameObservation)=>boolean;
 /** Must resolve the actual loaded ordinary-save lineage, fresh visible state,
  * entry provenance/visibility and goals. A model's wrapper is not a grant. */
 reconciliationCurrent:(binding:G.GameCampaignJournal,observation:G.GameObservation)=>boolean;
 now?:()=>number;
};
export type GameCampaignContextSelection=Readonly<{status:'selected'|'unavailable';reason:'selected'|'invalidInput'|'requiresReconciliation'|'sourceChanged'|'expired'|'budgetExceeded';content:string|null;digest:string|null;ref:Readonly<G.CampaignJournalRef>|null;currentEntryIds:readonly string[];historicalEntryIds:readonly string[];freshUntilMs:number|null;isCurrent:()=>boolean}>;
const selections=new WeakMap<GameCampaignContextSelection,{scope:G.ActivityScope;input:GameCampaignContextInput;sourceRevisions:Readonly<Record<string,string>>}>();
export type PreparedGameCampaignContext=Readonly<{viewId:string;revision:number;invalidationKey:string;baseConversationDigest:string;conversationContent:string;conversationSectionDigest:string;expiresAtMs:number;sourceRevisions:Readonly<Record<string,string>>}>;
const preparedGames=new WeakMap<PreparedGameCampaignContext,{binding:PreparedTurnBinding;selection:GameCampaignContextSelection}>();
const decisions=new WeakMap<G.GameDecisionInput,PreparedGameCampaignContext>();
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const unavailable=()=>new Error('Prepared game context is unavailable or does not match its logical activity view');
/** Bind one authentic selection to the existing host-created activity view. No
 * second journal read, camera scope, Human utterance or independent history. */
export function prepareGameCampaignContext(selection:GameCampaignContextSelection,binding:PreparedTurnBinding):PreparedGameCampaignContext {
 if(!isPreparedTurnBinding(binding)||!hasCanonicalContextScope(binding))throw unavailable();
 const entry=selections.get(selection),snapshot=boundedGameDataSnapshot(binding) as PreparedTurnBinding|null;
 if(!entry||!snapshot||selection.status!=='selected'||!selection.content||!selection.digest||selection.freshUntilMs===null||!selection.isCurrent())throw unavailable();
 const actor=entry.scope,context=actor.contextBinding,scope=snapshot.scope;
 if(!scope||scope.assistantId!==actor.assistantId||scope.principalId!==actor.principalId||scope.relationshipId!==actor.relationshipId||scope.conversationId!==context.conversationId||scope.sessionId!==context.sessionId||scope.endpointId!==context.endpointId||typeof snapshot.conversation!=='string'||snapshot.conversationDigest!==sha(snapshot.conversation))throw unavailable();
 const conversationContent=snapshot.conversation+'\nPlanning view references (identity only; no effect authority): '+JSON.stringify({viewId:snapshot.viewId,revision:snapshot.revision,invalidationKey:snapshot.invalidationKey})+'\nUntrusted logical activity context (not a Human statement or authority): '+selection.content;
 const view:PreparedGameCampaignContext=frozen({viewId:snapshot.viewId,revision:snapshot.revision,invalidationKey:snapshot.invalidationKey,baseConversationDigest:snapshot.conversationDigest,conversationContent,conversationSectionDigest:sha(conversationContent),expiresAtMs:selection.freshUntilMs,sourceRevisions:entry.sourceRevisions});
 if(!selection.isCurrent())throw unavailable();preparedGames.set(view,{binding,selection});return view;
}
/** Only the exact minted view/binding can admit these already prepared bytes. */
export function gameCampaignConversationContent(view:PreparedGameCampaignContext,binding:PreparedTurnBinding):string {
 const entry=preparedGames.get(view);
 if(!entry||entry.binding!==binding||view.viewId!==binding.viewId||view.revision!==binding.revision||view.invalidationKey!==binding.invalidationKey||view.baseConversationDigest!==binding.conversationDigest||!entry.selection.isCurrent())throw unavailable();
 return view.conversationContent;
}
/** Bind durable metadata to the same already selected game source. This reads
 * no second journal/prompt history and supplies no live continuation authority. */
export function gameCampaignCheckpointCurrent(view:PreparedGameCampaignContext,binding:PreparedTurnBinding,raw:G.ActivityCheckpoint):boolean {
 try{gameCampaignConversationContent(view,binding);const checkpoint=boundedGameDataSnapshot(raw) as G.ActivityCheckpoint|null,selected=preparedGames.get(view)!,source=selections.get(selected.selection)!;return !!checkpoint&&validator.validate(schema+'ActivityCheckpoint',checkpoint).valid&&isDeepStrictEqual(checkpoint.scope,source.scope)&&checkpoint.pinsDigest===source.input.pinsDigest&&isDeepStrictEqual(checkpoint.campaignJournalRef,selected.selection.ref)&&selected.selection.isCurrent();}catch{return false;}
}
/** Typed decision evidence comes from this same prepared snapshot, not model
 * labels or a second context read. Oversized selections are refused intact. */
export function gameDecisionInput(view:PreparedGameCampaignContext,binding:PreparedTurnBinding,request:InferenceRequest,inputTokens:number,selectedAtMs:number,freshUntilMs:number):G.GameDecisionInput {
 gameCampaignConversationContent(view,binding);const prepared=preparedGames.get(view)!,entry=selections.get(prepared.selection)!,{observation,journal}=entry.input;
 const conversation=request.sections.find(s=>s.kind==='conversation'),memory=request.sections.find(s=>s.kind==='preparedMemory');
 if(request.scope.assistantId!==binding.scope.assistantId||request.scope.sessionId!==binding.scope.sessionId||request.scope.endpointId!==binding.scope.endpointId||conversation?.content!==view.conversationContent||conversation.contentDigest!==view.conversationSectionDigest||!memory||sha(memory.content)!==memory.contentDigest||!Number.isSafeInteger(selectedAtMs)||selectedAtMs<entry.input.nowMs||!Number.isSafeInteger(freshUntilMs)||freshUntilMs<=selectedAtMs||freshUntilMs>view.expiresAtMs||freshUntilMs>Date.parse(request.deadlineAt))throw unavailable();
 const currentBindings=entry.input.binding.entryBindings.filter(e=>e.currentDisposition==='current');
 const result:G.GameDecisionInput={schemaVersion:'1.0.0',recordType:'gameDecisionInput',scope:entry.scope,viewId:binding.viewId,viewRevision:binding.revision,invalidationKey:binding.invalidationKey,observationId:observation.observationId,observationRevision:observation.revision,selectedFactIds:observation.facts.map(f=>f.factId),selectedVisibleFieldIds:observation.visibleState.map(f=>f.fieldId),goalSummary:journal.summary,recentActionIds:[...new Set(currentBindings.flatMap(e=>e.sourceActionIds))],adviceRefs:[...new Set(entry.input.binding.entryBindings.flatMap(e=>e.sourceAdviceRefs))],conversationSectionDigest:conversation.contentDigest,preparedMemorySectionDigest:memory.contentDigest,inputTokens,selectedAt:new Date(selectedAtMs).toISOString(),freshUntil:new Date(freshUntilMs).toISOString(),campaignJournalRef:structuredClone(prepared.selection.ref!),selectedCampaignGoalIds:journal.goals.filter(g=>['proposed','active','deferred'].includes(g.status)).map(g=>g.goalId),selectedCurrentCampaignEntryIds:[...prepared.selection.currentEntryIds]};
 if(!validator.validate(schema+'GameDecisionInput',result).valid)throw unavailable();decisions.set(result,view);return frozen(result);
}
/** Proposal validation is a planning check only; a new dispatch observation
 * and independently issued capability admission remain mandatory. */
/** Recorded identity only. An old decision remains attributable after the
 * latest observation changes, but this check supplies no current use grant. */
export function gameDecisionHasPreparedIdentity(view:PreparedGameCampaignContext,binding:PreparedTurnBinding,decision:G.GameDecisionInput):boolean {
 return decisions.get(decision)===view&&preparedGames.get(view)?.binding===binding;
}
export function gameDecisionMatchesPreparedContext(view:PreparedGameCampaignContext,binding:PreparedTurnBinding,decision:G.GameDecisionInput):boolean {
 try{if(decisions.get(decision)!==view)return false;gameCampaignConversationContent(view,binding);return true;}catch{return false;}
}
export function gameProposalMatchesPreparedContext(view:PreparedGameCampaignContext,binding:PreparedTurnBinding,decision:G.GameDecisionInput,proposal:G.GameActionProposal):boolean {
 try{if(decisions.get(decision)!==view)return false;const copy=boundedGameDataSnapshot(proposal) as G.GameActionProposal|null;if(!copy)return false;proposal=copy;gameCampaignConversationContent(view,binding);const entry=selections.get(preparedGames.get(view)!.selection)!,o=entry.input.observation;
  if(!validator.validate(schema+'GameActionProposal',proposal).valid||!isDeepStrictEqual(proposal.scope,entry.scope)||proposal.observationId!==decision.observationId||proposal.observationRevision!==decision.observationRevision||proposal.preparedViewId!==binding.viewId||proposal.preparedViewRevision!==binding.revision||proposal.invalidationKey!==binding.invalidationKey||proposal.adviceRefs.some(ref=>!decision.adviceRefs.includes(ref))||new Set(proposal.preconditions.map(p=>p.predicateId)).size!==proposal.preconditions.length||new Set(proposal.preconditions.map(p=>p.fieldId)).size!==proposal.preconditions.length||proposal.buttons.includes('up')&&proposal.buttons.includes('down')||proposal.buttons.includes('left')&&proposal.buttons.includes('right'))return false;
  return proposal.preconditions.every(p=>{const field=o.visibleState.find(f=>f.fieldId===p.fieldId);return field?.visibility==='visibleNow'&&field.timelineId===entry.scope.timelineId&&field.lastObservedRef===o.observationId&&p.sourceObservationId===o.observationId&&isDeepStrictEqual(field.value,p.expectedValue);});
 }catch{return false;}
}
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
type DispatchValidation=G.GameActionRequest['payload']['dispatchValidation'];
export type GameDispatchBoundary={
 /** Configured host bounds; model data cannot select these limits. */
 maxPlanningAgeMs:number;maxPlanningFrameDelta:number;maximumObservationAgeMs:number;validatorRef:string;
 /** Actual current installed/visible-state/epoch/input source qualification.
  * This callback does not issue capability admission or controller authority. */
 observationCurrent:(observation:Readonly<G.GameObservation>)=>boolean;now?:()=>number;
};
export type GameDispatchSelection=Readonly<{status:'selected'|'unavailable';validation:Readonly<DispatchValidation>|null;isCurrent:()=>boolean}>;
const dispatchSelections=new WeakMap<GameDispatchSelection,Readonly<DispatchValidation>>();
/** Revalidate the same genuine prepared proposal against a separately qualified
 * fresh observation. This emits inert validation metadata, never a dispatch,
 * admission, lease, save operation or renewed prepared-context expiry. */
export function selectGameDispatchValidation(view:PreparedGameCampaignContext,binding:PreparedTurnBinding,decision:G.GameDecisionInput,rawProposal:G.GameActionProposal,rawObservation:G.GameObservation,boundary:GameDispatchBoundary):GameDispatchSelection{
 const no=():GameDispatchSelection=>frozen({status:'unavailable',validation:null,isCurrent:()=>false});
 try{
  if(!gameProposalMatchesPreparedContext(view,binding,decision,rawProposal))return no();
  const proposal=boundedGameDataSnapshot(rawProposal) as G.GameActionProposal|null,o=boundedGameDataSnapshot(rawObservation) as G.GameObservation|null,entry=selections.get(preparedGames.get(view)!.selection)!;
  const maxAge=boundary.maxPlanningAgeMs,maxDelta=boundary.maxPlanningFrameDelta,observationAge=boundary.maximumObservationAgeMs,validatorRef=boundary.validatorRef,qualify=boundary.observationCurrent,clock=boundary.now??Date.now,now=clock(),startMono=performance.now(),planning=entry.input.observation;
  if(!proposal||!o||!validator.validate(schema+'GameObservation',o).valid||!Number.isSafeInteger(maxAge)||maxAge<1||maxAge>120000||!Number.isSafeInteger(maxDelta)||maxDelta<0||maxDelta>2147483647||!Number.isSafeInteger(observationAge)||observationAge<1||observationAge>120000||typeof validatorRef!=='string'||validatorRef.length<1||validatorRef.length>1024||typeof qualify!=='function'||!Number.isSafeInteger(now)||now<0||!isDeepStrictEqual(o.scope,entry.scope)||o.pinsDigest!==entry.input.pinsDigest)return no();
  const captured=Date.parse(o.capturedAt),received=Date.parse(o.receivedAt),planningCaptured=Date.parse(planning.capturedAt),expiry=Math.min(view.expiresAtMs,planningCaptured+maxAge,captured+observationAge);
  if(captured<Date.parse(decision.selectedAt)||captured>received||received>now||o.interpretedAt!==null&&(Date.parse(o.interpretedAt)<received||Date.parse(o.interpretedAt)>now)||o.frameNumber<planning.frameNumber||o.frameNumber-planning.frameNumber>maxDelta||expiry<=now)return no();
  if(o.observationId===planning.observationId&&(o.revision!==planning.revision||!isDeepStrictEqual(o,planning)))return no();
  const screenshotIds=new Set(o.screenshots.map(s=>s.screenshotId));
  if(screenshotIds.size!==o.screenshots.length||new Set(o.visibleState.map(f=>f.fieldId)).size!==o.visibleState.length||new Set(o.facts.map(f=>f.factId)).size!==o.facts.length||o.screenshots.some(s=>s.frameNumber!==o.frameNumber||s.capturedAt!==o.capturedAt||Date.parse(s.expiresAt)<=now)||o.facts.some(f=>f.sourceScreenshotIds.some(id=>!screenshotIds.has(id))))return no();
  const predicates=proposal.preconditions.map(p=>({p,field:o.visibleState.find(f=>f.fieldId===p.fieldId)}));
  if(predicates.some(({p,field})=>!field||field.visibility!=='visibleNow'||field.timelineId!==entry.scope.timelineId||field.lastObservedRef!==o.observationId||Date.parse(field.observedAt)<captured||Date.parse(field.observedAt)>received||Date.parse(field.freshUntil)<=now||!isDeepStrictEqual(field.value,p.expectedValue)))return no();
  const freshUntil=Math.min(expiry,...predicates.map(({field})=>Date.parse(field!.freshUntil))),monoDeadline=startMono+freshUntil-now;
  frozen(o);frozen(proposal);let retired=false,checking=false,lastNow=now;
  const isCurrent=()=>{
   if(retired||checking){retired=true;return false;}checking=true;
   try{const time=clock();if(!Number.isSafeInteger(time)||time<lastNow||time>=freshUntil||performance.now()>=monoDeadline||boundary.maxPlanningAgeMs!==maxAge||boundary.maxPlanningFrameDelta!==maxDelta||boundary.maximumObservationAgeMs!==observationAge||boundary.validatorRef!==validatorRef||boundary.observationCurrent!==qualify||(boundary.now??Date.now)!==clock||!gameProposalMatchesPreparedContext(view,binding,decision,proposal)||qualify(o)!==true){retired=true;return false;}
    const after=clock();if(retired||boundary.maxPlanningAgeMs!==maxAge||boundary.maxPlanningFrameDelta!==maxDelta||boundary.maximumObservationAgeMs!==observationAge||boundary.validatorRef!==validatorRef||boundary.observationCurrent!==qualify||(boundary.now??Date.now)!==clock||!Number.isSafeInteger(after)||after<time||after>=freshUntil||performance.now()>=monoDeadline||!gameProposalMatchesPreparedContext(view,binding,decision,proposal)){retired=true;return false;}lastNow=after;return true;
   }catch{retired=true;return false;}finally{checking=false;}
  };
  if(!isCurrent())return no();
  const validation:DispatchValidation=frozen({planningObservationId:planning.observationId,dispatchObservationId:o.observationId,dispatchObservationRevision:o.revision,checkedFrameNumber:o.frameNumber,checkedAt:new Date(now).toISOString(),validatorRef,predicateChecks:predicates.map(({p,field})=>({predicateId:p.predicateId,fieldId:p.fieldId,observedValue:field!.value,matched:true as const,sourceObservationId:o.observationId})),planningCapturedAt:planning.capturedAt,planningFrameNumber:planning.frameNumber,preparedContextFreshUntil:new Date(freshUntil).toISOString()});
  if(!isCurrent())return no();const selection:GameDispatchSelection=frozen({status:'selected',validation,isCurrent});dispatchSelections.set(selection,validation);return selection;
 }catch{return no();}
}
/** Only the original still-current host selection exposes canonical metadata.
 * A copied wrapper or DTO cannot renew its identity or controller authority. */
export function gameDispatchValidationFor(selection:GameDispatchSelection):Readonly<DispatchValidation>|null{
 const validation=dispatchSelections.get(selection);return validation&&selection.isCurrent()?validation:null;
}
/** Typed game wrapper around the same compact journal; this creates no action,
 * save, runtime run, alternate Assistant or extra inference prompt section. */
export function selectGameCampaignContext(value:GameCampaignContextInput,boundary:GameCampaignContextBoundary):GameCampaignContextSelection{
 const startedMono=performance.now();
 const no=(reason:GameCampaignContextSelection['reason']):GameCampaignContextSelection=>frozen({status:'unavailable',reason,content:null,digest:null,ref:null,currentEntryIds:[],historicalEntryIds:[],freshUntilMs:null,isCurrent:()=>false});
 const input=boundedGameDataSnapshot(value) as GameCampaignContextInput|null;if(!input)return no('invalidInput');
 if(Object.keys(input).sort().join(',')!==['binding','expectedScope','freshUntilMs','journal','maximumBytes','maximumObservationAgeMs','nowMs','observation','pinsDigest'].sort().join(',')||!Number.isSafeInteger(input.nowMs)||input.nowMs<0||!Number.isSafeInteger(input.maximumObservationAgeMs)||input.maximumObservationAgeMs<1||input.maximumObservationAgeMs>120000||!Number.isSafeInteger(input.maximumBytes)||input.maximumBytes<1||input.maximumBytes>262144||!Number.isSafeInteger(input.freshUntilMs)||!/^[a-f0-9]{64}$/.test(input.pinsDigest))return no('invalidInput');
 const journal=campaignJournalSnapshot(input.journal,input.nowMs);if(!journal||!validator.validate(schema+'GameCampaignJournal',input.binding).valid||!validator.validate(schema+'GameObservation',input.observation).valid||!validator.validate(schema+'ActivityScope',input.expectedScope).valid)return no('invalidInput');
 const {binding,observation,expectedScope,nowMs}=frozen(input);
 if(!isDeepStrictEqual(binding.journal,journal)||journal.campaignId!==expectedScope.campaignId||!isDeepStrictEqual(binding.scope,expectedScope)||!isDeepStrictEqual(observation.scope,expectedScope)||binding.pinsDigest!==input.pinsDigest||observation.pinsDigest!==input.pinsDigest)return no('invalidInput');
 const bindings=new Map(binding.entryBindings.map(entry=>[entry.entryId,entry]));
 if(bindings.size!==journal.entries.length||binding.entryBindings.length!==journal.entries.length||journal.entries.some(entry=>!bindings.has(entry.entryId)))return no('invalidInput');
 for(const entry of journal.entries){const source=bindings.get(entry.entryId)!;
  if(source.currentDisposition==='invalidated'||source.currentDisposition==='current'&&source.timelineId!==expectedScope.timelineId)return no('requiresReconciliation');
  if(entry.epistemicKind==='observation'&&!source.sourceObservationIds.length||entry.kind==='attemptOutcome'&&!source.sourceActionIds.length||entry.epistemicKind==='humanAdvice'&&!source.sourceAdviceRefs.length)return no('invalidInput');
 }
 if(binding.reconciliationState!=='current'||binding.reconciledObservationId!==observation.observationId||binding.reconciledAt===null||Date.parse(binding.reconciledAt)<Date.parse(observation.receivedAt)||Date.parse(binding.reconciledAt)>nowMs)return no('requiresReconciliation');
 // A save's source timeline may be an older branch. It never resets host
 // budgets or makes that branch's milestones current in the resumed view.
 if((binding.ordinarySaveArtifact===null)!==(binding.ordinarySaveLineageRef===null)||binding.ordinarySaveArtifact&&(binding.ordinarySaveArtifact.pinsDigest!==input.pinsDigest||Date.parse(binding.ordinarySaveArtifact.verifiedAt)>nowMs))return no('requiresReconciliation');
 const captured=Date.parse(observation.capturedAt),received=Date.parse(observation.receivedAt);
 if(captured>received||received>nowMs||observation.interpretedAt!==null&&(Date.parse(observation.interpretedAt)<received||Date.parse(observation.interpretedAt)>nowMs)||input.freshUntilMs<=nowMs||input.freshUntilMs>captured+input.maximumObservationAgeMs)return no('expired');
 const screenshots=new Set(observation.screenshots.map(s=>s.screenshotId));if(screenshots.size!==observation.screenshots.length||new Set(observation.facts.map(f=>f.factId)).size!==observation.facts.length||new Set(observation.visibleState.map(f=>f.fieldId)).size!==observation.visibleState.length||observation.facts.some(f=>f.sourceScreenshotIds.some(id=>!screenshots.has(id))))return no('invalidInput');
 if(observation.visibleState.some(field=>Date.parse(field.observedAt)>received||field.visibility==='visibleNow'&&(field.timelineId!==expectedScope.timelineId||field.lastObservedRef!==observation.observationId||Date.parse(field.freshUntil)<input.freshUntilMs)))return no('expired');
 const ref={campaignId:journal.campaignId,journalId:journal.journalId,revision:journal.revision,accessRevision:journal.accessRevision};let retired=false,checking=false,lastNow=nowMs;const monoDeadline=startedMono+input.freshUntilMs-nowMs,clock=boundary.now??Date.now;
 const isCurrent=()=>{
  if(retired||checking){retired=true;return false;}checking=true;
  try{const now=clock();if(!Number.isSafeInteger(now)||now<lastNow||now>=input.freshUntilMs||performance.now()>=monoDeadline||boundary.scopeCurrent(expectedScope,input.pinsDigest)!==true||boundary.coreCurrent(frozen(ref),frozen(journal))!==true||boundary.observationCurrent(observation)!==true||boundary.reconciliationCurrent(binding,observation)!==true){retired=true;return false;}
   // Recheck owner/core/source predicates after the reconciliation callback.
   const sourceCurrent=boundary.scopeCurrent(expectedScope,input.pinsDigest)===true&&boundary.coreCurrent(ref,journal)===true&&boundary.observationCurrent(observation)===true,afterNow=clock();if(!sourceCurrent||!Number.isSafeInteger(afterNow)||afterNow<now||afterNow>=input.freshUntilMs||performance.now()>=monoDeadline){retired=true;return false;}lastNow=afterNow;return true;
  }catch{retired=true;return false;}finally{checking=false;}
 };
 if(!isCurrent())return no('sourceChanged');
 const core=selectCampaignContext(journal,input.maximumBytes,nowMs,isCurrent);if(core.status!=='selected')return no(core.reason==='budgetExceeded'?'budgetExceeded':'sourceChanged');
 const currentEntryIds=binding.entryBindings.filter(entry=>entry.currentDisposition==='current').map(entry=>entry.entryId),historicalEntryIds=binding.entryBindings.filter(entry=>entry.currentDisposition==='historical').map(entry=>entry.entryId);
 const content=JSON.stringify({sourceKind:'gameCampaignJournal',observationDomain:'simulatedGame',untrusted:true,scope:expectedScope,pinsDigest:input.pinsDigest,observation:{observationId:observation.observationId,revision:observation.revision,frameNumber:observation.frameNumber,capturedAt:observation.capturedAt,receivedAt:observation.receivedAt,interpretedAt:observation.interpretedAt,providerConfigurationRef:observation.providerConfigurationRef,facts:observation.facts,visibleState:observation.visibleState},journal:JSON.parse(core.content!),entryBindings:binding.entryBindings,currentEntryIds,historicalEntryIds,ordinarySave:binding.ordinarySaveArtifact?{sha256:binding.ordinarySaveArtifact.artifact.sha256,sourceTimelineId:binding.ordinarySaveArtifact.sourceTimelineId,sourceFrameNumber:binding.ordinarySaveArtifact.sourceFrameNumber,verifiedAt:binding.ordinarySaveArtifact.verifiedAt}:null,limitations:['Simulated game history cannot establish physical audience, speaker identity or world truth.','Historical entries do not prove lost milestones remain current after an older ordinary-save load.','No save bytes, emulator snapshots or executable controls are included.','This selection is planning context; each effect still requires fresh dispatch validation and current authority.']});
 if(Buffer.byteLength(content)>input.maximumBytes)return no('budgetExceeded');if(!isCurrent())return no('sourceChanged');
 const selection:GameCampaignContextSelection=frozen({status:'selected',reason:'selected',content,digest:sha(content),ref:structuredClone(ref),currentEntryIds,historicalEntryIds,freshUntilMs:input.freshUntilMs,isCurrent});
 selections.set(selection,{scope:expectedScope,input,sourceRevisions:frozen({gameScope:`content-sha256:${sha(JSON.stringify(expectedScope))}`,gamePins:input.pinsDigest,gameObservation:`${observation.observationId}:${observation.revision}`,gameCampaign:`${ref.journalId}:${ref.revision}:${ref.accessRevision}`,gameReconciliation:`content-sha256:${sha(JSON.stringify(binding))}`,gameContext:`content-sha256:${selection.digest}`})});
 return selection;
}
