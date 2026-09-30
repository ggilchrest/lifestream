import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot,campaignJournalSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {selectCampaignContext} from './journal.ts';
import {isPreparedTurnBinding,type PreparedTurnBinding} from '../inference/prompt.ts';
import {hasCanonicalContextScope} from '../context/prepared-view.ts';
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
const selections=new WeakMap<GameCampaignContextSelection,{scope:G.ActivityScope;sourceRevisions:Readonly<Record<string,string>>}>();
export type PreparedGameCampaignContext=Readonly<{viewId:string;revision:number;invalidationKey:string;baseConversationDigest:string;conversationContent:string;conversationSectionDigest:string;expiresAtMs:number;sourceRevisions:Readonly<Record<string,string>>}>;
const preparedGames=new WeakMap<PreparedGameCampaignContext,{binding:PreparedTurnBinding;selection:GameCampaignContextSelection}>();
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
 const conversationContent=snapshot.conversation+'\nUntrusted logical activity context (not a Human statement or authority): '+selection.content;
 const view:PreparedGameCampaignContext=frozen({viewId:snapshot.viewId,revision:snapshot.revision,invalidationKey:snapshot.invalidationKey,baseConversationDigest:snapshot.conversationDigest,conversationContent,conversationSectionDigest:sha(conversationContent),expiresAtMs:selection.freshUntilMs,sourceRevisions:entry.sourceRevisions});
 if(!selection.isCurrent())throw unavailable();preparedGames.set(view,{binding,selection});return view;
}
/** Only the exact minted view/binding can admit these already prepared bytes. */
export function gameCampaignConversationContent(view:PreparedGameCampaignContext,binding:PreparedTurnBinding):string {
 const entry=preparedGames.get(view);
 if(!entry||entry.binding!==binding||view.viewId!==binding.viewId||view.revision!==binding.revision||view.invalidationKey!==binding.invalidationKey||view.baseConversationDigest!==binding.conversationDigest||!entry.selection.isCurrent())throw unavailable();
 return view.conversationContent;
}
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
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
 selections.set(selection,{scope:expectedScope,sourceRevisions:frozen({gameScope:`content-sha256:${sha(JSON.stringify(expectedScope))}`,gamePins:input.pinsDigest,gameObservation:`${observation.observationId}:${observation.revision}`,gameCampaign:`${ref.journalId}:${ref.revision}:${ref.accessRevision}`,gameReconciliation:`content-sha256:${sha(JSON.stringify(binding))}`,gameContext:`content-sha256:${selection.digest}`})});
 return selection;
}
