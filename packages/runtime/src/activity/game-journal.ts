import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot,campaignJournalSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import {createHash,randomUUID} from 'node:crypto';
import type {GameActionIntent} from '../inference/game-intent-format.ts';
import {isDeepStrictEqual} from 'node:util';
import {selectCampaignContext} from './journal.ts';
import {isPreparedTurnBinding,type PreparedTurnBinding} from '../inference/prompt.ts';
import {hasCanonicalContextScope} from '../context/prepared-view.ts';
import type {InferenceRequest} from '../inference/port.ts';
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
export type GameActionProposalConstraints=Readonly<{allowedButtons:readonly G.GameActionProposal['buttons'][number][];maxDurationFrames:number;maxWallMs:number;grantsAuthority:false}>;
export type GamePlanningTask='ordinaryCtProgress';
export type GameCampaignContextInput={planningTask?:GamePlanningTask;actionProposalConstraints?:GameActionProposalConstraints;binding:G.GameCampaignJournal;journal:G.CampaignJournal;observation:G.GameObservation;expectedScope:G.ActivityScope;pinsDigest:string;maximumObservationAgeMs:number;freshUntilMs:number;maximumBytes:number;nowMs:number};
export type GameCampaignContextBoundary={
 /** Host-owned ordinary Play event, never inferred from journal or game text. */
 planningTaskCurrent?:(task:GamePlanningTask)=>boolean;
 /** Inert restrictions from the same scoped controller owner; not execution authority. */
 actionProposalConstraintsCurrent?:(constraints:GameActionProposalConstraints)=>boolean;
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
const selections=new WeakMap<GameCampaignContextSelection,{scope:G.ActivityScope;input:GameCampaignContextInput;sourceRevisions:Readonly<Record<string,string>>;admissionCurrent:()=>boolean;activeCurrent:(includePlanningObservation:boolean)=>boolean;admittedView:PreparedGameCampaignContext|null}>();
export type PreparedGameCampaignContext=Readonly<{planningTask?:GamePlanningTask;actionWallSafetyLimitMs?:number;viewId:string;revision:number;invalidationKey:string;baseConversationDigest:string;conversationContent:string;conversationSectionDigest:string;eligibleAdviceRefs:readonly string[];expiresAtMs:number;sourceRevisions:Readonly<Record<string,string>>}>;
const preparedGames=new WeakMap<PreparedGameCampaignContext,{binding:PreparedTurnBinding;selection:GameCampaignContextSelection;phase:'prepared'|'planning'|'dispatch';dispatchProposal:G.GameActionProposal|null}>();
const decisions=new WeakMap<G.GameDecisionInput,PreparedGameCampaignContext>();
const boundIntents=new WeakSet<G.GameDecisionInput>();
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const unavailable=()=>new Error('Prepared game context is unavailable or does not match its logical activity view');
// A model-input representation only. Original observations and validators keep
// every field. Shared metadata is explicit and rows override common properties.
// This changes neither source eligibility nor output/dispatch authority.
type GameContextSerialization='sharedVisibleStateV1'|'recentAttemptV1';
function serializedGameContext(content:string,serialization?:GameContextSerialization):string {
 if(serialization===undefined)return content;
 if(!['sharedVisibleStateV1','recentAttemptV1'].includes(serialization))throw unavailable();
 const value=JSON.parse(content);
 if(serialization==='recentAttemptV1'){
  const journal=value.journal,pinned=new Set<string>([...journal.summaryEntryIds,...journal.goals.flatMap((goal:G.CampaignJournal['goals'][number])=>goal.sourceEntryIds)]);
  const attempts=journal.entries.filter((entry:G.CampaignJournal['entries'][number])=>entry.kind==='attemptOutcome'&&!pinned.has(entry.entryId)).sort((a:G.CampaignJournal['entries'][number],b:G.CampaignJournal['entries'][number])=>Date.parse(b.recordedAt)-Date.parse(a.recordedAt)||b.entryId.localeCompare(a.entryId));
  if(attempts.length>1){
   const keep=new Set<string>(journal.entries.filter((entry:G.CampaignJournal['entries'][number])=>entry.kind!=='attemptOutcome'||pinned.has(entry.entryId)||entry.entryId===attempts[0].entryId).map((entry:G.CampaignJournal['entries'][number])=>entry.entryId));
   journal.entries=journal.entries.filter((entry:G.CampaignJournal['entries'][number])=>keep.has(entry.entryId));
   value.entryBindings=value.entryBindings.filter((entry:G.GameCampaignJournal['entryBindings'][number])=>keep.has(entry.entryId));
   value.currentEntryIds=value.currentEntryIds.filter((id:string)=>keep.has(id));value.historicalEntryIds=value.historicalEntryIds.filter((id:string)=>keep.has(id));
   value.limitations.push('Only the latest unpinned attempt outcome is shown; earlier attempts remain in retained history. All goals and summary sources are included.');
  }
 }
 const fields=value.observation?.visibleState;
 if(Array.isArray(fields)&&fields.length>=2){
  const common=Object.fromEntries(Object.entries(fields[0]).filter(([key,item])=>key!=='fieldId'&&key!=='value'&&fields.every(field=>Object.hasOwn(field,key)&&isDeepStrictEqual(field[key],item))));
  if(Object.keys(common).length){const rows=fields.map(field=>Object.fromEntries(Object.entries(field).filter(([key])=>!Object.hasOwn(common,key))));value.observation.visibleState={encoding:'common-properties-then-row/1',common,rows};}
 }
 const compact=JSON.stringify(value);return Buffer.byteLength(compact)<Buffer.byteLength(content)?compact:content;
}
/** Bind one authentic selection to the existing host-created activity view. No
 * second journal read, camera scope, Human utterance or independent history. */
export function prepareGameCampaignContext(selection:GameCampaignContextSelection,binding:PreparedTurnBinding,serialization?:GameContextSerialization):PreparedGameCampaignContext {
 if(!isPreparedTurnBinding(binding)||!hasCanonicalContextScope(binding))throw unavailable();
 const entry=selections.get(selection),snapshot=boundedGameDataSnapshot(binding) as PreparedTurnBinding|null;
 if(!entry||!snapshot||selection.status!=='selected'||!selection.content||!selection.digest||selection.freshUntilMs===null||!entry.admissionCurrent())throw unavailable();
 const actor=entry.scope,context=actor.contextBinding,scope=snapshot.scope;
 if(!scope||scope.assistantId!==actor.assistantId||scope.principalId!==actor.principalId||scope.relationshipId!==actor.relationshipId||scope.conversationId!==context.conversationId||scope.sessionId!==context.sessionId||scope.endpointId!==context.endpointId||typeof snapshot.conversation!=='string'||snapshot.conversationDigest!==sha(snapshot.conversation))throw unavailable();
 const eligibleAdviceRefs=[...new Set(entry.input.binding.entryBindings.flatMap(e=>e.sourceAdviceRefs))];
 const conversationContent=snapshot.conversation+'\nPlanning view references (identity only; no effect authority): '+JSON.stringify({viewId:snapshot.viewId,revision:snapshot.revision,invalidationKey:snapshot.invalidationKey})+'\nEligible proposal adviceRefs (citation identifiers only; journal sourceRefs are not advice): '+JSON.stringify(eligibleAdviceRefs)+'\nUntrusted logical activity context (not a Human statement or authority): '+serializedGameContext(selection.content,serialization);
 const view:PreparedGameCampaignContext=frozen({...(entry.input.planningTask?{planningTask:entry.input.planningTask,...(entry.input.actionProposalConstraints?{actionWallSafetyLimitMs:entry.input.actionProposalConstraints.maxWallMs}:{})}:{}),viewId:snapshot.viewId,revision:snapshot.revision,invalidationKey:snapshot.invalidationKey,baseConversationDigest:snapshot.conversationDigest,conversationContent,conversationSectionDigest:sha(conversationContent),eligibleAdviceRefs,expiresAtMs:selection.freshUntilMs,sourceRevisions:entry.sourceRevisions});
 if(!entry.admissionCurrent())throw unavailable();preparedGames.set(view,{binding,selection,phase:'prepared',dispatchProposal:null});return view;
}
/** One host-admitted model invocation. Snapshot freshness is an admission
 * check; live scope/core/source checks continue throughout the active decision. */
export function admitGamePlanningContext(view:PreparedGameCampaignContext,binding:PreparedTurnBinding):boolean {
 try{const entry=preparedGameIdentity(view,binding),source=selections.get(entry.selection)!;if(entry.phase!=='prepared'||source.admittedView||!source.admissionCurrent())return false;source.admittedView=view;entry.phase='planning';return true;}catch{return false;}
}
/** Only a published decision may retire its planning observation into history.
 * This creates no dispatch validation or controller grant. */
export function beginGameDispatchValidation(view:PreparedGameCampaignContext,binding:PreparedTurnBinding,decision:G.GameDecisionInput,proposal:G.GameActionProposal):boolean {
 try{const entry=preparedGameIdentity(view,binding),source=selections.get(entry.selection)!;if(entry.phase!=='planning'||source.admittedView!==view||!gameProposalMatchesPreparedContext(view,binding,decision,proposal))return false;const copy=boundedGameDataSnapshot(proposal) as G.GameActionProposal|null;if(!copy)return false;entry.dispatchProposal=frozen(copy);entry.phase='dispatch';return true;}catch{return false;}
}
/** Only the exact minted view/binding can admit these already prepared bytes. */
export function gameCampaignConversationContent(view:PreparedGameCampaignContext,binding:PreparedTurnBinding):string {
 const entry=preparedGameIdentity(view,binding);
 const source=selections.get(entry.selection)!;
 if(!(entry.phase==='prepared'?source.admissionCurrent():source.admittedView===view&&source.activeCurrent(entry.phase==='planning')))throw unavailable();
 return view.conversationContent;
}
// Identity alone supplies no current use grant. Keep it separate so a caller
// can validate inert checkpoint data before ONE complete source check.
function preparedGameIdentity(view:PreparedGameCampaignContext,binding:PreparedTurnBinding){
 const entry=preparedGames.get(view);
 if(!entry||entry.binding!==binding||view.viewId!==binding.viewId||view.revision!==binding.revision||view.invalidationKey!==binding.invalidationKey||view.baseConversationDigest!==binding.conversationDigest)throw unavailable();
 return entry;
}
/** Bind durable metadata to the same already selected game source. This reads
 * no second journal/prompt history and supplies no live continuation authority. */
function checkpointIdentityMatches(view:PreparedGameCampaignContext,binding:PreparedTurnBinding,raw:G.ActivityCheckpoint):boolean {
 const selected=preparedGameIdentity(view,binding),checkpoint=boundedGameDataSnapshot(raw) as G.ActivityCheckpoint|null,source=selections.get(selected.selection)!;
 return !!checkpoint&&validator.validate(schema+'ActivityCheckpoint',checkpoint).valid&&isDeepStrictEqual(checkpoint.scope,source.scope)&&checkpoint.pinsDigest===source.input.pinsDigest&&isDeepStrictEqual(checkpoint.campaignJournalRef,selected.selection.ref);
}
export function gameCampaignCheckpointCurrent(view:PreparedGameCampaignContext,binding:PreparedTurnBinding,raw:G.ActivityCheckpoint):boolean {
 try{if(!checkpointIdentityMatches(view,binding,raw))return false;gameCampaignConversationContent(view,binding);return true;}catch{return false;}
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
 try{if(decisions.get(decision)!==view)return false;const copy=boundedGameDataSnapshot(proposal) as G.GameActionProposal|null;if(!copy)return false;proposal=copy;gameCampaignConversationContent(view,binding);const prepared=preparedGames.get(view)!,entry=selections.get(prepared.selection)!,o=entry.input.observation;if(prepared.phase==='dispatch'&&!isDeepStrictEqual(prepared.dispatchProposal,proposal))return false;
  if(!validator.validate(schema+'GameActionProposal',proposal).valid||!isDeepStrictEqual(proposal.scope,entry.scope)||proposal.observationId!==decision.observationId||proposal.observationRevision!==decision.observationRevision||proposal.preparedViewId!==binding.viewId||proposal.preparedViewRevision!==binding.revision||proposal.invalidationKey!==binding.invalidationKey||proposal.adviceRefs.some(ref=>!decision.adviceRefs.includes(ref))||new Set(proposal.preconditions.map(p=>p.predicateId)).size!==proposal.preconditions.length||new Set(proposal.preconditions.map(p=>p.fieldId)).size!==proposal.preconditions.length||proposal.buttons.includes('up')&&proposal.buttons.includes('down')||proposal.buttons.includes('left')&&proposal.buttons.includes('right'))return false;
  // Ordinary Play chooses the hold in frames. Its wall limit is the scoped
  // controller owner's fixed safety ceiling, never a model duration estimate.
  if(view.actionWallSafetyLimitMs!==undefined&&proposal.maxWallMs!==view.actionWallSafetyLimitMs)return false;
  const limits=entry.input.actionProposalConstraints;
  if(limits&&(proposal.durationFrames>limits.maxDurationFrames||proposal.maxWallMs>limits.maxWallMs||proposal.buttons.some(button=>!limits.allowedButtons.includes(button))))return false;
  return proposal.preconditions.every(p=>{const field=o.visibleState.find(f=>f.fieldId===p.fieldId);return field?.visibility==='visibleNow'&&field.timelineId===entry.scope.timelineId&&field.lastObservedRef===o.observationId&&p.sourceObservationId===o.observationId&&isDeepStrictEqual(field.value,p.expectedValue);});
 }catch{return false;}
}
/** Bind one actual model intent to its original immutable planning observation.
 * Never read a later observation, repair model choices, or create admission. */
export function bindGameActionIntent(view:PreparedGameCampaignContext,binding:PreparedTurnBinding,decision:G.GameDecisionInput,raw:unknown):G.GameActionProposal|null {
 if(boundIntents.has(decision)||decisions.get(decision)!==view)throw unavailable();
 const prepared=preparedGameIdentity(view,binding),entry=selections.get(prepared.selection)!;
 if(prepared.phase!=='planning'||entry.admittedView!==view)throw unavailable();
 gameCampaignConversationContent(view,binding);
 if(raw===null){boundIntents.add(decision);return null;}
 const intent=boundedGameDataSnapshot(raw) as GameActionIntent|null;
 const keys='adviceRefs,buttons,durationFrames,expectedVisibleOutcome,maxWallMs,preconditions,reason,recordType,schemaVersion,uncertainty';
 if(!intent||Object.keys(intent).sort().join(',')!==keys||intent.schemaVersion!=='1.0.0'||intent.recordType!=='gameActionIntent'||!Array.isArray(intent.preconditions)||intent.preconditions.length<1||intent.preconditions.length>8)throw unavailable();
 const o=entry.input.observation;
 const preconditions=intent.preconditions.map(predicate=>{
  if(!predicate||typeof predicate!=='object'||Array.isArray(predicate)||Object.keys(predicate).join(',')!=='fieldId'||typeof predicate.fieldId!=='string')throw unavailable();
  const fields=o.visibleState.filter(field=>field.fieldId===predicate.fieldId),field=fields[0];
  if(fields.length!==1||!field||field.visibility!=='visibleNow'||field.timelineId!==entry.scope.timelineId||field.lastObservedRef!==o.observationId)throw unavailable();
  return {predicateId:randomUUID(),fieldId:field.fieldId,expectedValue:field.value,sourceObservationId:o.observationId};
 });
 const {schemaVersion:_version,recordType:_type,preconditions:_predicates,...choices}=intent;
 const proposal:G.GameActionProposal={...choices,schemaVersion:'1.0.0',recordType:'gameActionProposal',scope:entry.scope,proposalId:randomUUID(),observationId:o.observationId,observationRevision:o.revision,preparedViewId:binding.viewId,preparedViewRevision:binding.revision,invalidationKey:binding.invalidationKey,preconditions};
 if(!gameProposalMatchesPreparedContext(view,binding,decision,proposal))throw unavailable();
 gameCampaignConversationContent(view,binding);boundIntents.add(decision);return frozen(proposal);
}
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
type DispatchValidation=G.GameActionRequest['payload']['dispatchValidation'];
export type GameDispatchBoundary={
 /** Configured host bounds; model data cannot select these limits. */
 // The trusted ordinary route can qualify the same owned native target here;
 // this need not be a model's semantic-scene comparison. Explicit predicates
 // and each observation's distinct identity/provenance remain checked below.
 ordinaryGameTime?:true;sceneCurrent?:(planning:G.GameObservation,current:G.GameObservation)=>boolean;
 maxPlanningAgeMs:number;maxPlanningFrameDelta:number;maximumObservationAgeMs:number;validatorRef:string;
 /** Actual current installed/visible-state/epoch/input source qualification.
  * This callback does not issue capability admission or controller authority. */
 observationCurrent:(observation:Readonly<G.GameObservation>)=>boolean;now?:()=>number;
};
export type GameDispatchRefusal='prepared_proposal_invalid'|'scene_comparison_not_current'|'observation_identity_invalid'|'observation_lineage_or_expiry'|'observation_revision_changed'|'diagnostic_image_changed'|'observation_provenance_invalid'|'precondition_changed_or_expired'|'dispatch_currentness_lost'|'dispatch_validation_error';
export type GameDispatchSelection=Readonly<{status:'selected'|'unavailable';reason?:GameDispatchRefusal;validation:Readonly<DispatchValidation>|null;isCurrent:()=>boolean}>;
const dispatchSelections=new WeakMap<GameDispatchSelection,{currentWith:(qualification:()=>boolean)=>boolean;validation:Readonly<DispatchValidation>;view:PreparedGameCampaignContext;binding:PreparedTurnBinding;decision:G.GameDecisionInput;proposal:G.GameActionProposal}>();
/** Revalidate the same genuine prepared proposal against a separately qualified
 * fresh observation. This emits inert validation metadata, never a dispatch,
 * admission, lease, save operation or renewed prepared-context expiry. */
export function selectGameDispatchValidation(view:PreparedGameCampaignContext,binding:PreparedTurnBinding,decision:G.GameDecisionInput,rawProposal:G.GameActionProposal,rawObservation:G.GameObservation,boundary:GameDispatchBoundary):GameDispatchSelection{
 const no=(reason:GameDispatchRefusal):GameDispatchSelection=>frozen({status:'unavailable',reason,validation:null,isCurrent:()=>false});
 try{
  if(!gameProposalMatchesPreparedContext(view,binding,decision,rawProposal))return no('prepared_proposal_invalid');
  const proposal=boundedGameDataSnapshot(rawProposal) as G.GameActionProposal|null,o=boundedGameDataSnapshot(rawObservation) as G.GameObservation|null,entry=selections.get(preparedGames.get(view)!.selection)!;
  const maxAge=boundary.maxPlanningAgeMs,maxDelta=boundary.maxPlanningFrameDelta,observationAge=boundary.maximumObservationAgeMs,validatorRef=boundary.validatorRef,qualify=boundary.observationCurrent,clock=boundary.now??Date.now,now=clock(),startMono=performance.now(),planning=entry.input.observation,ordinary=boundary.ordinaryGameTime===true,sceneCurrent=boundary.sceneCurrent;
  if(ordinary&&(!o||validatorRef!=='owned-bizhawk-dispatch:live-v1'||typeof sceneCurrent!=='function'||sceneCurrent(planning,o)!==true))return no('scene_comparison_not_current');
  if(!proposal||!o||!validator.validate(schema+'GameObservation',o).valid||!Number.isSafeInteger(maxAge)||maxAge<1||maxAge>300000||!Number.isSafeInteger(maxDelta)||maxDelta<0||maxDelta>2147483647||!Number.isSafeInteger(observationAge)||observationAge<1||observationAge>300000||typeof validatorRef!=='string'||validatorRef.length<1||validatorRef.length>1024||typeof qualify!=='function'||!Number.isSafeInteger(now)||now<0||!isDeepStrictEqual(o.scope,entry.scope)||o.pinsDigest!==entry.input.pinsDigest)return no('observation_identity_invalid');
  const captured=Date.parse(o.capturedAt),received=Date.parse(o.receivedAt),planningCaptured=Date.parse(planning.capturedAt),expiry=Math.min(preparedGames.get(view)?.phase==='dispatch'?Infinity:view.expiresAtMs,ordinary?Infinity:planningCaptured+maxAge,captured+observationAge);
  if(captured<Date.parse(decision.selectedAt)||captured>received||received>now||o.interpretedAt!==null&&(Date.parse(o.interpretedAt)<received||Date.parse(o.interpretedAt)>now)||o.frameNumber<planning.frameNumber||!ordinary&&o.frameNumber-planning.frameNumber>maxDelta||expiry<=now)return no('observation_lineage_or_expiry');
  if(o.observationId===planning.observationId&&(o.revision!==planning.revision||!isDeepStrictEqual(o,planning)))return no('observation_revision_changed');
  if(!ordinary&&preparedGames.get(view)?.phase==='dispatch'){
   // An aged planning snapshot is usable only against the same visible scene.
   // These are host-qualified fields/PNG identities, never model assertions.
   const before=planning.visibleState.find(f=>f.fieldId==='display.visible.rgbSha256'),after=o.visibleState.find(f=>f.fieldId==='display.visible.rgbSha256');
   if(before||after){if(!before||!after||!isDeepStrictEqual(before.value,after.value))return no('diagnostic_image_changed');}
   else if(!isDeepStrictEqual(planning.screenshots.map(s=>[s.sha256,s.width,s.height]),o.screenshots.map(s=>[s.sha256,s.width,s.height])))return no('diagnostic_image_changed');
  }
  const screenshotIds=new Set(o.screenshots.map(s=>s.screenshotId));
  if(screenshotIds.size!==o.screenshots.length||new Set(o.visibleState.map(f=>f.fieldId)).size!==o.visibleState.length||new Set(o.facts.map(f=>f.factId)).size!==o.facts.length||o.screenshots.some(s=>s.frameNumber!==o.frameNumber||s.capturedAt!==o.capturedAt||Date.parse(s.expiresAt)<=now)||o.facts.some(f=>f.sourceScreenshotIds.some(id=>!screenshotIds.has(id))))return no('observation_provenance_invalid');
  const predicates=proposal.preconditions.map(p=>({p,field:o.visibleState.find(f=>f.fieldId===p.fieldId)}));
  if(predicates.some(({p,field})=>!field||field.visibility!=='visibleNow'||field.timelineId!==entry.scope.timelineId||field.lastObservedRef!==o.observationId||Date.parse(field.observedAt)<captured||Date.parse(field.observedAt)>received||Date.parse(field.freshUntil)<=now||!isDeepStrictEqual(field.value,p.expectedValue)))return no('precondition_changed_or_expired');
  const freshUntil=Math.min(expiry,...predicates.map(({field})=>Date.parse(field!.freshUntil))),monoDeadline=startMono+freshUntil-now;
  frozen(o);frozen(proposal);let retired=false,checking=false,lastNow=now;
  const isCurrent=(qualification?:()=>boolean)=>{
   if(retired||checking){retired=true;return false;}checking=true;
   try{const time=clock();if(!Number.isSafeInteger(time)||time<lastNow||time>=freshUntil||performance.now()>=monoDeadline||boundary.maxPlanningAgeMs!==maxAge||boundary.maxPlanningFrameDelta!==maxDelta||boundary.maximumObservationAgeMs!==observationAge||boundary.validatorRef!==validatorRef||boundary.ordinaryGameTime!==(ordinary?true:undefined)||boundary.sceneCurrent!==sceneCurrent||ordinary&&sceneCurrent!(planning,o)!==true||boundary.observationCurrent!==qualify||(boundary.now??Date.now)!==clock||!gameProposalMatchesPreparedContext(view,binding,decision,proposal)||qualify(o)!==true){retired=true;return false;}
    if(qualification&&qualification()!==true){retired=true;return false;}
    const after=clock();if(retired||boundary.maxPlanningAgeMs!==maxAge||boundary.maxPlanningFrameDelta!==maxDelta||boundary.maximumObservationAgeMs!==observationAge||boundary.validatorRef!==validatorRef||boundary.ordinaryGameTime!==(ordinary?true:undefined)||boundary.sceneCurrent!==sceneCurrent||ordinary&&sceneCurrent!(planning,o)!==true||boundary.observationCurrent!==qualify||(boundary.now??Date.now)!==clock||!Number.isSafeInteger(after)||after<time||after>=freshUntil||performance.now()>=monoDeadline||!gameProposalMatchesPreparedContext(view,binding,decision,proposal)){retired=true;return false;}lastNow=after;return true;
   }catch{retired=true;return false;}finally{checking=false;}
  };
  if(!isCurrent())return no('dispatch_currentness_lost');
  const validation:DispatchValidation=frozen({planningObservationId:planning.observationId,dispatchObservationId:o.observationId,dispatchObservationRevision:o.revision,checkedFrameNumber:o.frameNumber,checkedAt:new Date(now).toISOString(),validatorRef,predicateChecks:predicates.map(({p,field})=>({predicateId:p.predicateId,fieldId:p.fieldId,observedValue:field!.value,matched:true as const,sourceObservationId:o.observationId})),planningCapturedAt:planning.capturedAt,planningFrameNumber:planning.frameNumber,preparedContextFreshUntil:new Date(freshUntil).toISOString()});
  if(!isCurrent())return no('dispatch_currentness_lost');const selection:GameDispatchSelection=frozen({status:'selected',validation,isCurrent:()=>isCurrent()});dispatchSelections.set(selection,{currentWith:isCurrent,validation,view,binding,decision,proposal});return selection;
 }catch{return no('dispatch_validation_error');}
}
/** Only the original still-current host selection exposes canonical metadata.
 * A copied wrapper or DTO cannot renew its identity or controller authority. */
export function gameDispatchValidationFor(selection:GameDispatchSelection):Readonly<DispatchValidation>|null{
 const source=dispatchSelections.get(selection);return source&&selection.isCurrent()?source.validation:null;
}
/** Match genuine prepared identities and expose their validation with one full
 * source check. All compared bytes are bounded/frozen; no authority callback or
 * I/O occurs between that check and this immutable projection. */
export function gameDispatchValidationForPrepared(selection:GameDispatchSelection,view:PreparedGameCampaignContext,binding:PreparedTurnBinding,decision:G.GameDecisionInput,rawProposal:G.GameActionProposal):Readonly<DispatchValidation>|null{
 try{const source=dispatchSelections.get(selection),proposal=boundedGameDataSnapshot(rawProposal);if(!source||source.view!==view||source.binding!==binding||source.decision!==decision||!proposal||!isDeepStrictEqual(source.proposal,proposal))return null;return selection.isCurrent()?source.validation:null;}catch{return null;}
}
/** One complete prepared-source qualification brackets the live checkpoint/owner
 * callback. Immutable identity checks do not repeat the authority graph. No
 * result crosses an await; every invocation rechecks the original live sources. */
export function gameControllerContextCurrent(selection:GameDispatchSelection,view:PreparedGameCampaignContext,binding:PreparedTurnBinding,decision:G.GameDecisionInput,rawProposal:G.GameActionProposal,expected:Readonly<DispatchValidation>,qualification:()=>Readonly<G.ActivityCheckpoint>|null):boolean {
 try{
  const source=dispatchSelections.get(selection),proposal=boundedGameDataSnapshot(rawProposal);
  if(!source||source.view!==view||source.binding!==binding||source.decision!==decision||!proposal||!isDeepStrictEqual(source.proposal,proposal)||!isDeepStrictEqual(source.validation,expected))return false;
  return source.currentWith(()=>{const checkpoint=qualification();return !!checkpoint&&checkpointIdentityMatches(view,binding,checkpoint);});
 }catch{return false;}
}
/** Exact original prepared/decision/proposal binding; inert metadata cannot be
 * transplanted onto another proposal or copied selection. Never an I/O grant. */
export function gameDispatchSelectionMatchesPreparedContext(selection:GameDispatchSelection,view:PreparedGameCampaignContext,binding:PreparedTurnBinding,decision:G.GameDecisionInput,rawProposal:G.GameActionProposal):boolean{
 try{const source=dispatchSelections.get(selection),proposal=boundedGameDataSnapshot(rawProposal);return !!source&&source.view===view&&source.binding===binding&&source.decision===decision&&!!proposal&&isDeepStrictEqual(source.proposal,proposal)&&gameProposalMatchesPreparedContext(view,binding,decision,source.proposal)&&selection.isCurrent();}catch{return false;}
}
/** Typed game wrapper around the same compact journal; this creates no action,
 * save, runtime run, alternate Assistant or extra inference prompt section. */
export function selectGameCampaignContext(value:GameCampaignContextInput,boundary:GameCampaignContextBoundary):GameCampaignContextSelection{
 const startedMono=performance.now();
 const no=(reason:GameCampaignContextSelection['reason']):GameCampaignContextSelection=>frozen({status:'unavailable',reason,content:null,digest:null,ref:null,currentEntryIds:[],historicalEntryIds:[],freshUntilMs:null,isCurrent:()=>false});
 const input=boundedGameDataSnapshot(value) as GameCampaignContextInput|null;if(!input)return no('invalidInput');
 if(Object.keys(input).sort().join(',')!==[...(input.planningTask===undefined?[]:['planningTask']),...(input.actionProposalConstraints===undefined?[]:['actionProposalConstraints']),'binding','expectedScope','freshUntilMs','journal','maximumBytes','maximumObservationAgeMs','nowMs','observation','pinsDigest'].sort().join(',')||!Number.isSafeInteger(input.nowMs)||input.nowMs<0||!Number.isSafeInteger(input.maximumObservationAgeMs)||input.maximumObservationAgeMs<1||input.maximumObservationAgeMs>300000||!Number.isSafeInteger(input.maximumBytes)||input.maximumBytes<1||input.maximumBytes>262144||!Number.isSafeInteger(input.freshUntilMs)||!/^[a-f0-9]{64}$/.test(input.pinsDigest))return no('invalidInput');
 const limits=input.actionProposalConstraints;
 if(limits&&(Object.keys(limits).sort().join(',')!=='allowedButtons,grantsAuthority,maxDurationFrames,maxWallMs'||limits.grantsAuthority!==false||!validator.validate(schema+'GameActionProposal/properties/buttons',limits.allowedButtons).valid||!validator.validate(schema+'GameActionProposal/properties/durationFrames',limits.maxDurationFrames).valid||!validator.validate(schema+'GameActionProposal/properties/maxWallMs',limits.maxWallMs).valid||typeof boundary.actionProposalConstraintsCurrent!=='function'))return no('invalidInput');
 if(input.actionProposalConstraints!==undefined&&!limits)return no('invalidInput');
 if(input.planningTask!==undefined&&(input.planningTask!=='ordinaryCtProgress'||typeof boundary.planningTaskCurrent!=='function'))return no('invalidInput');
 const taskCheck=boundary.planningTaskCurrent;
 const taskCurrent=()=>input.planningTask===undefined||boundary.planningTaskCurrent===taskCheck&&taskCheck?.(input.planningTask)===true;
 const constraintsCheck=boundary.actionProposalConstraintsCurrent;
 const constraintsCurrent=()=>!limits||boundary.actionProposalConstraintsCurrent===constraintsCheck&&constraintsCheck?.(limits)===true;
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
 const ref={campaignId:journal.campaignId,journalId:journal.journalId,revision:journal.revision,accessRevision:journal.accessRevision};let retired=false,admissionExpired=false,checking=false,lastNow=nowMs;const monoDeadline=startedMono+input.freshUntilMs-nowMs,clock=boundary.now??Date.now;
 const checkCurrent=(admission:boolean,includePlanningObservation:boolean)=>{
  if(retired||checking){retired=true;return false;}checking=true;
  try{const now=clock();if(!Number.isSafeInteger(now)||now<lastNow){retired=true;return false;}if(admission&&(admissionExpired||now>=input.freshUntilMs||performance.now()>=monoDeadline)){admissionExpired=true;return false;}if(boundary.scopeCurrent(expectedScope,input.pinsDigest)!==true||boundary.coreCurrent(frozen(ref),frozen(journal))!==true||includePlanningObservation&&boundary.observationCurrent(observation)!==true||boundary.reconciliationCurrent(binding,observation)!==true||!constraintsCurrent()||!taskCurrent()){retired=true;return false;}
   // Recheck owner/core/source predicates after the reconciliation callback.
   const sourceCurrent=boundary.scopeCurrent(expectedScope,input.pinsDigest)===true&&boundary.coreCurrent(ref,journal)===true&&(!includePlanningObservation||boundary.observationCurrent(observation)===true)&&constraintsCurrent()&&taskCurrent(),afterNow=clock();if(!sourceCurrent||!Number.isSafeInteger(afterNow)||afterNow<now){retired=true;return false;}if(admission&&(afterNow>=input.freshUntilMs||performance.now()>=monoDeadline)){admissionExpired=true;return false;}lastNow=afterNow;return true;
  }catch{retired=true;return false;}finally{checking=false;}
 };
 const isCurrent=()=>checkCurrent(true,true);
 if(!isCurrent())return no('sourceChanged');
 const core=selectCampaignContext(journal,input.maximumBytes,nowMs,isCurrent);if(core.status!=='selected')return no(core.reason==='budgetExceeded'?'budgetExceeded':'sourceChanged');
 const currentEntryIds=binding.entryBindings.filter(entry=>entry.currentDisposition==='current').map(entry=>entry.entryId),historicalEntryIds=binding.entryBindings.filter(entry=>entry.currentDisposition==='historical').map(entry=>entry.entryId);
 const content=JSON.stringify({sourceKind:'gameCampaignJournal',observationDomain:'simulatedGame',untrusted:true,scope:expectedScope,pinsDigest:input.pinsDigest,...(limits?{actionProposalConstraints:limits}:{}),observation:{observationId:observation.observationId,revision:observation.revision,frameNumber:observation.frameNumber,capturedAt:observation.capturedAt,receivedAt:observation.receivedAt,interpretedAt:observation.interpretedAt,providerConfigurationRef:observation.providerConfigurationRef,facts:observation.facts,visibleState:observation.visibleState},journal:JSON.parse(core.content!),entryBindings:binding.entryBindings,currentEntryIds,historicalEntryIds,ordinarySave:binding.ordinarySaveArtifact?{sha256:binding.ordinarySaveArtifact.artifact.sha256,sourceTimelineId:binding.ordinarySaveArtifact.sourceTimelineId,sourceFrameNumber:binding.ordinarySaveArtifact.sourceFrameNumber,verifiedAt:binding.ordinarySaveArtifact.verifiedAt}:null,limitations:['Simulated game history cannot establish physical audience, speaker identity or world truth.','Historical entries do not prove lost milestones remain current after an older ordinary-save load.','No save bytes, emulator snapshots or executable controls are included.','This selection is planning context; each effect still requires fresh dispatch validation and current authority.']});
 if(Buffer.byteLength(content)>input.maximumBytes)return no('budgetExceeded');if(!isCurrent())return no('sourceChanged');
 const selection:GameCampaignContextSelection=frozen({status:'selected',reason:'selected',content,digest:sha(content),ref:structuredClone(ref),currentEntryIds,historicalEntryIds,freshUntilMs:input.freshUntilMs,isCurrent});
 selections.set(selection,{scope:expectedScope,input,admissionCurrent:isCurrent,activeCurrent:includeObservation=>checkCurrent(false,includeObservation),admittedView:null,sourceRevisions:frozen({gameScope:`content-sha256:${sha(JSON.stringify(expectedScope))}`,gamePins:input.pinsDigest,gameObservation:`${observation.observationId}:${observation.revision}`,gameCampaign:`${ref.journalId}:${ref.revision}:${ref.accessRevision}`,gameReconciliation:`content-sha256:${sha(JSON.stringify(binding))}`,gameContext:`content-sha256:${selection.digest}`})});
 return selection;
}
