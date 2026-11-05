import {sameObservedGameScene,observedGameSceneRejection} from './game-scene-eligibility.ts';
import {gamePhase} from './game-phase-timing.ts';
import {createCtJobLifecycle} from '../../../../integration/ct-launcher/ct-job-lifecycle.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {captureFrameApproval,nativeSourceException} from '@lifestream/providers-bizhawk';
import {runGameObservationCommand} from './game-observation-deadline.ts';
import {captureSupervisedGameFailure} from '../../../../scripts/supervised-game-runtime.mjs';
import {createNativeExecutionLifetime} from '../../../../packages/providers-bizhawk/src/native-execution-lifetime.ts';
import {createDialogueMovementGoal,createVisibleMovementGoal} from './game-visual-goal.ts';
import {captureCtVisibleGoalPolicy} from './ct-visible-goal-policy.ts';
import {captureCtActionEvidence} from './ct-action-evidence.ts';
import {captureCtWakeHandoff} from './ct-wake-handoff.ts';
import {captureCtObservationEvidence} from './ct-observation-evidence.ts';
import {captureReviewedGameScene} from './reviewed-game-scene.ts';
import {captureReviewedDialogueProfile} from './reviewed-dialogue-profile.ts';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {GameStartRepository} from '@lifestream/storage-sqlite';
import {selectGameWindow,selectManualGameStart} from '@lifestream/runtime/activity/policy';
import {GameFrameCustody} from '@lifestream/providers-bizhawk';
import {LiveFrameDecoder} from '@lifestream/providers-bizhawk';
import {createOwnedUbuntuNative} from '@lifestream/providers-bizhawk/owned-ubuntu-native';
import {createOwnedC72Native} from '../../../../packages/providers-bizhawk/src/owned-c72-native.ts';
import {scopeDigest as evidenceScopeDigest,readC72NativeConfiguration} from '../../../../packages/providers-bizhawk/src/c72-native-configuration.ts';
import {createReviewedLiveFrame,createOwnedPlayFrameQualification,observeUntilFrameReviewed} from '../../../../packages/providers-bizhawk/src/reviewed-live-frame.ts';
import {join as joinPath} from 'node:path';
import {createUbuntuGameHostJoin} from './ubuntu-game-join.mjs';
import {createGameCampaignOwner} from './game-campaign-owner.ts';
import {qualifiedGameInferenceBounds,supervisedGameProviderAvailable,gameInferenceSelectionDigest} from './game-host-runtime.ts';
import {ctControllerAdapterForProfile} from './ct-controller-buttons.ts';
import {createGameObservationInterpreter} from './game-frame-interpretation.ts';
import {captureGameSanityTiming} from '../../../../packages/providers-bizhawk/src/game-sanity-timing.ts';

/** Wait only for new visible evidence after an actual model abstention. The
 * original run signal/currentness owns lifetime; no inference or neutral input. */
export async function awaitChangedGameScene(observation,{observe,current,signal,frameNumber}){
 const key=value=>{const shots=value?.screenshots;if(!Array.isArray(shots)||shots.length!==1)return null;const shot=shots[0],rgb=value.visibleState?.find(field=>field.fieldId==='display.visible.rgbSha256');return typeof shot.sha256==='string'?JSON.stringify([rgb?.value??shot.sha256,shot.width,shot.height]):null;};
 const before=key(observation);if(!before)return false;let observedFrame=observation.frameNumber;
 while(!signal.aborted&&current()===true){
  try{await delay(1000,undefined,{signal});}catch{return false;}
  if(signal.aborted||current()!==true)return false;
  if(frameNumber){const frame=frameNumber();if(!Number.isSafeInteger(frame)||frame<observedFrame)return false;if(frame===observedFrame)continue;}
  const next=await observe(signal);if(!next||signal.aborted||current()!==true)return false;
  const after=key(next);if(!after)return false;observedFrame=next.frameNumber;if(after!==before)return true;
 }
 return false;
}

/** Finite active metadata capacity follows the configured retained-run envelope.
 * Durable historical accounting is never deleted or reset by this policy. */
export function gameMetadataCapacity(retainedRuns,bounds,sessionScoped=false){
 if(!Number.isSafeInteger(retainedRuns)||retainedRuns<1||retainedRuns>64||!Number.isSafeInteger(bounds?.modelCallBudget)||bounds.modelCallBudget<1||bounds.modelCallBudget>(sessionScoped?1536:128)||!Number.isSafeInteger(bounds?.actionBudget)||bounds.actionBudget<1||bounds.actionBudget>(sessionScoped?512:128))throw Error('Finite game metadata envelope required');
 return {maxRuns:retainedRuns,maxReservations:Math.min(8192,Math.max(64,retainedRuns*bounds.modelCallBudget)),maxControllerReservations:Math.min(8192,Math.max(64,retainedRuns*bounds.actionBudget))};
}

/** Existing lifecycle, fixed ordinary-product watchdogs and trusted owner ports.
 * Setup retains independent native/grant expiry; gameplay starts once after image preparation. */
export function createOrdinaryGameLifecycle(options){
 const timing=captureGameSanityTiming(options.sanityTiming);
 let lifecycle;
 lifecycle=createCtJobLifecycle({...(options.sessionLifetime?{sessionLifetime:options.sessionLifetime}:{}),maximumGameplayMs:options.maximumGameplayMs,cleanupTimeoutMs:timing.cleanupTimeoutMs,
  operationLimits:{owner_prepare:timing.startupOverallTimeoutMs,native_prepare:timing.nativePreparationTimeoutMs,native_start:timing.startupOverallTimeoutMs,model:timing.planningTimeoutMs,controller:timing.commandRoundTripTimeoutMs,settle:timing.settlementTimeoutMs},
  isCurrent:options.isCurrent,canExecute:options.canExecute,isQuiescent:options.isQuiescent,onStop:options.onStop,onStopCause:reason=>{try{if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')console.info(JSON.stringify({event:'game-lifecycle-first-stop',runId:options.runId,reason,operation:lifecycle.snapshot().operation,observedAtMs:Date.now()}));}catch{}}});
 return lifecycle;
}

/** Select the ordinary product route, not controller authority. Native dialogue
 * cue decoding remains a fresh explicit predicate on this route; its presence
 * does not turn authenticated ordinary Play into a diagnostic/reviewed scene. */
export function usesOwnedOrdinaryTarget(configuration,hasReviewedScene=false){
 return configuration.ordinaryGameplay==='continuous'&&configuration.ordinarySessionLifetime==='sessionScoped'&&typeof configuration.playConsentCurrent==='function'&&!hasReviewedScene;
}

export function createUbuntuGameComposition(configuration,{session,authority,nativeFactory,takePairingSecret,executionOwner,gameFrameInterpretation}={}){
 if(!session||!authority)throw Error('Existing authenticated server session owner required');
 const attach=configuration.attach,scope=attach.scope,c=configuration.campaign,controllerProfile=configuration.sessionProfile;
 const installation=configuration.nativeInstallation;
 const sanityTiming=captureGameSanityTiming(configuration.sanityTiming);
 const reviewedScene=configuration.reviewedSceneProfile?captureReviewedGameScene(configuration.reviewedSceneProfile):null;
 const reviewedDialogue=configuration.reviewedDialogueProfile===undefined?null:captureReviewedDialogueProfile(configuration.reviewedDialogueProfile);
 if(reviewedDialogue&&(configuration.goalMode!=='observedGameplay'||!configuration.gameFrameVision||reviewedScene))throw Error('Reviewed dialogue requires general game vision without a scene table');
 const foreground=configuration.inferenceMode==='supervisedForeground',selectionPin=configuration.inferenceSelection?gameInferenceSelectionDigest(configuration.inferenceSelection()):null;
 const lifecycle=executionOwner?.lifecycle;
 const sessionCurrent=candidate=>executionOwner?session.preparationCurrent(candidate):session.current(candidate);
 const executionConsent=executionOwner&&typeof session.executionConsent==='function'?session.executionConsent:null;
 const interpretationPorts=gameFrameInterpretation;
 const interpretationPin=interpretationPorts?{...interpretationPorts}:null;
 const interpretationCurrent=()=>{
  if(!interpretationPin)return true;
  if(gameFrameInterpretation!==interpretationPorts||!Object.entries(interpretationPin).every(([key,value])=>interpretationPorts[key]===value))return false;
  try{return interpretationPin.current===undefined||interpretationPin.current()===true;}catch{return false;}
 };
 const controllerGrantCurrent=authority.canStart;
 const current=()=>{try{
  const selected=configuration.inferenceSelection?.();
  if(!interpretationCurrent()||!selected)return false;
  if(!foreground)return sessionCurrent(scope)&&!!qualifiedGameInferenceBounds({resolveApproval:()=>null,sourceCurrent:()=>false,inferenceQualificationFor:configuration.inferenceQualificationFor},selected);
  // The original accessor qualifies scope, actor, lifecycle and expiry afresh.
  // Its consent result is local to this call; all source/grant checks still run.
  const consent=executionConsent?(session.executionConsent===executionConsent?executionConsent(scope):null):sessionCurrent(scope)?session.resolveApproval(scope)??(executionOwner?session.executionConsent(scope):null):null;
  return consent?.sharedInference===true&&(consent.controllerInput!==true||authority.canStart===controllerGrantCurrent&&typeof controllerGrantCurrent==='function'&&controllerGrantCurrent())&&gameInferenceSelectionDigest(selected)===selectionPin&&supervisedGameProviderAvailable(selected);
 }catch{return false;}};
 let nativeInstallation={...installation,sanityTiming,evidence:{...installation.evidence,sanityTiming}},frameOwner,waitingForFrame=false,nativeExpires=Infinity,wakeRequired=false,wakeJoined=false,lastObservation=null,executionLifetime,pendingNativeObservation=null,frameReviewExpiresAt=null;
 const frameAuthorityExpiresAt=()=>Math.min(nativeExpires,executionOwner&&!session.resolveApproval(scope)?nativeExpires:Date.parse(session.resolveApproval(scope)?.approvedUntil??new Date(0).toISOString()));
 if(typeof configuration.playConsentCurrent==='function')frameOwner=createOwnedPlayFrameQualification({ordinaryGameTime:configuration.ordinaryGameplay==='continuous',scope,pinsDigest:attach.pinsDigest,maximumRetentionMs:sanityTiming.observationFreshnessMs,expiresAt:frameAuthorityExpiresAt,current:()=>configuration.playConsentCurrent(scope)===true&&current(),...(reviewedDialogue?{reviewedDialogue}:{})});
 else if(installation.frameManifestFile)frameOwner=createReviewedLiveFrame({...(reviewedScene?{reviewedScene}:{}),...(reviewedDialogue?{reviewedDialogue}:{}),...(configuration.goalMode==='observedGameplay'?{maximumRetentionMs:sanityTiming.observationFreshnessMs}:{}),file:installation.frameManifestFile,scope,pinsDigest:attach.pinsDigest,initialManifest:installation.frameManifest,expiresAt:frameAuthorityExpiresAt});
 if(!nativeFactory){
  const container=installation.kind==='c72-container'?readC72NativeConfiguration(installation.configurationFile,scope,attach.pinsDigest):null;
  if(container){nativeExpires=Date.parse(container.expiresAt);wakeRequired=container.wakePreparation!==undefined;if(executionOwner)executionLifetime=createNativeExecutionLifetime(lifecycle,container.expiresAt,container.sessionLifetime);}
  if(executionOwner&&!executionLifetime)throw Error('Original reviewed c72 native authority required for execution lifetime');
  const custody=new GameFrameCustody(container?joinPath(container.runDirectory,'frames'):installation.frameDirectory,{maxBytes:c.bounds.maxScreenshotBytes,maxQueueBytes:c.bounds.screenshotQueueByteBudget,maxLongEdge:c.bounds.maxScreenshotLongEdge,maxFrames:32,maxTtlMs:sanityTiming.observationFreshnessMs,current:sessionCurrent});
  const decoder=frameOwner?.decoder??new LiveFrameDecoder(installation.frameManifest);
  nativeInstallation={...installation,sanityTiming,native:{...(executionLifetime?{executionLifetime}:{}),...(container?{sessionDurationMs:configuration.maximumRunMs,authenticationTimeoutMs:Math.min(10000,sanityTiming.nativePairingTimeoutMs),connectionTimeoutMs:sanityTiming.nativeStartupTimeoutMs}:installation.native),sanityTiming,bounds:c.bounds,frameCustody:custody,frameDecoder:{capture:(request,observation)=>evidence.captureObservationDecoder(request,observation),configurationRef:()=> 'live-frame:'+decoder.manifestDigest,decode:({request,observation,bytes})=>decoder.decode({scope:request.scope,observation,bytes,now:Date.now()})}},evidence:{...installation.evidence,...(executionLifetime?{executionLifetime}:{}),sanityTiming,custody,decoder}};
 }
 const physical=(nativeFactory??(installation.kind==='c72-container'?createOwnedC72Native:createOwnedUbuntuNative))({...nativeInstallation,takePairingSecret,...(configuration.onFailure?{onFailure:configuration.onFailure}:{}),evidence:{...nativeInstallation.evidence,scope,pinsDigest:attach.pinsDigest,providerRef:attach.providerRef,isCurrent:candidate=>isDeepStrictEqual(candidate,scope)&&current()}});
 const evidence=physical.evidence;
 const terminalCurrent=(candidate,ref)=>{const receipt=physical.terminationReceipt;return isDeepStrictEqual(candidate,scope)&&session.custodyCurrent?.(scope)===true&&receipt?.removed===true&&receipt.scopeDigest===evidenceScopeDigest(scope)&&receipt.pinsDigest===attach.pinsDigest&&receipt.receiptRef===ref;};
 // Native installation qualification already calls this exact original current
 // port. Do not walk the controller/session graph twice in one synchronous pass.
 const sourceCurrent=candidate=>isDeepStrictEqual(candidate,scope)&&evidence.installationAvailable(scope,attach.pinsDigest);
 // These are trusted runtime ports, never callbacks decoded from game/job JSON.
 // The native/reviewed decoder still owns menu safety and controller-domain proof.
 const interpretObservation=interpretationPorts?createGameObservationInterpreter({decoder:interpretationPorts.decoder,inference:interpretationPorts.inference,onRefusal:interpretationPorts.onRefusal,
  sourceCurrent:candidate=>interpretationCurrent()&&sourceCurrent(candidate),pinsDigestFor:candidate=>isDeepStrictEqual(candidate,scope)?attach.pinsDigest:null,
  observationCurrent:observation=>current()&&!!frameOwner&&frameOwner.current(observation)&&evidence.sourceAvailable(scope,attach.pinsDigest),
  readFrame:async(observation,screenshot,signal)=>{
   if(signal.aborted||!current()||!frameOwner?.current(observation))return null;
   const frame=evidence.frameForReview(scope,attach.pinsDigest);if(!frame)return null;
   if(frame.observation.observationId!==observation.observationId||frame.observation.revision!==observation.revision||frame.observation.frameNumber!==observation.frameNumber||!isDeepStrictEqual(frame.observation.scope,scope)||!isDeepStrictEqual(frame.screenshot,screenshot)){frame.bytes.fill(0);return null;}
   return frame.bytes;
  },maximumDurationMs:interpretationPorts.maximumDurationMs,maximumBytes:c.bounds.maxScreenshotBytes,maximumLongEdge:c.bounds.maxScreenshotLongEdge,maximumObservationAgeMs:sanityTiming.observationFreshnessMs}):null;
 const refreshSourceCustody=async signal=>{
  if(signal.aborted||!sourceCurrent(scope))throw Error('Native source refresh fenced');
  await gamePhase(scope.runId,'source-refresh',()=>physical.refreshCustody(signal));
  if(signal.aborted||!sourceCurrent(scope))throw Error('Native source refresh fenced');
 };
 const retainedRuns=typeof configuration.playConsentCurrent==='function'?Math.min(64,configuration.startLimits.rollingStartLimit):4;
 // Metadata policy reads always check quarantined before scope/policy. That
 // guard owns one complete fresh source qualification; these following hooks
 // bind the owner and read policy data without repeating the same graph. The
 // repository retains its independent checkpoint and post-mutation checks.
 const metadata={...gameMetadataCapacity(retainedRuns,c.bounds,configuration.ordinarySessionLifetime==='sessionScoped'),...(typeof configuration.playConsentCurrent==='function'?{capacityScope:'retainedRuns'}:{}),maxCheckpointBytes:c.bounds.maxCheckpointBytes??32768,scopeCurrent:owner=>owner.assistantId===scope.assistantId&&owner.principalId===scope.principalId&&owner.relationshipId===scope.relationshipId,quarantined:()=>!current(),policyFor:()=>({enabled:true,revision:c.policy.revision,retentionMs:configuration.metadataRetentionMs,bounds:c.bounds}),allowCreate:current,checkpointCurrent:current,transitionCurrent:current,planningCurrent:current,usageCurrent:current,controllerCurrent:current,controllerUsageCurrent:current};
 const journal={...(configuration.ordinarySessionLifetime==='sessionScoped'?{retainHistoricalAttempts:true}:{}),maxJournals:retainedRuns,maxEntryIdentities:Math.min(8192,Math.max(128,retainedRuns*(c.bounds.actionBudget+1))),maxSourceFences:configuration.ordinarySessionLifetime==='sessionScoped'?65536:256,maxJournalBytes:32768,scopeCurrent:()=>current(),quarantined:()=>!current(),policyFor:()=>current()?{enabled:true,revision:c.policy.revision,retentionMs:configuration.metadataRetentionMs,retentionPolicyRef:c.journal.retentionPolicyRef}:null,allowCreate:current,sourceCurrent:current,journalCurrent:current};
 const campaignBoundary={scopeCurrent:sourceCurrent,coreCurrent:current,observationCurrent:o=>evidence.sourceAvailable(o.scope,o.pinsDigest)&&(!frameOwner||frameOwner.current(o)),reconciliationCurrent:current,now:Date.now};
 const goalPolicy=configuration.sessionProfile==='supervised8'?captureCtVisibleGoalPolicy(configuration):null;
 const goalOptions=configuration.sessionProfile==='supervised8'&&goalPolicy.kind!=='observedGameplay'&&configuration.reviewedSceneProfile?{scope,manifestDigest:reviewedScene.decoder.manifestDigest,displacement:16,current:observation=>current()&&frameOwner.current(observation)}:null;
 const goal=goalOptions?(goalPolicy.kind==='movementOnly'?createVisibleMovementGoal(goalOptions):createDialogueMovementGoal({...goalOptions,initialDialogue:goalPolicy.initialDialogue})):null;
 let manualStart;
 const explicitStartCurrent=(candidate,policy,bounds)=>{
  const consent=session.resolveApproval(scope)??(executionOwner?session.executionConsent(scope):null);
  return foreground&&session.started()===true&&sourceCurrent(candidate)&&isDeepStrictEqual(candidate,scope)&&isDeepStrictEqual(policy,c.policy)&&isDeepStrictEqual(bounds,c.bounds)&&consent?.observations===true&&consent.campaignJournal===true&&consent.sharedInference===true&&!!lastObservation&&(!frameOwner||frameOwner.current(lastObservation));
 };
 const terminalJournalCurrent=()=>terminalCurrent(scope,physical.terminationReceipt?.receiptRef);
 const terminalJournalOptions={...journal,scopeCurrent:o=>o.principalId===scope.principalId&&o.assistantId===scope.assistantId&&o.relationshipId===scope.relationshipId&&terminalJournalCurrent(),quarantined:()=>!terminalJournalCurrent(),policyFor:()=>terminalJournalCurrent()?{enabled:true,revision:c.policy.revision,retentionMs:configuration.metadataRetentionMs,retentionPolicyRef:c.journal.retentionPolicyRef}:null,allowCreate:()=>false,sourceCurrent:terminalJournalCurrent,journalCurrent:terminalJournalCurrent};
 const ordinaryTarget=usesOwnedOrdinaryTarget(configuration,!!reviewedScene);
 const source={...(ordinaryTarget?{ordinaryTargetCurrent:campaignBoundary.observationCurrent}:configuration.ordinaryGameplay==='continuous'?{sameObservedScene:sameObservedGameScene,sceneRejectionReason:observedGameSceneRejection}:{}),...(configuration.onRejected?{onRejected:configuration.onRejected}:{}),...(configuration.onDecision?{onDecision:configuration.onDecision}:{}),...(configuration.onSettled?{onSettled:configuration.onSettled}:{}),terminalJournalOptions,terminalReceiptUsageFor:evidence.usageFor,...(executionOwner||foreground?{startAfterObservation:true}:{}),...(executionOwner&&typeof configuration.playConsentCurrent!=='function'?{runSettlement:work=>lifecycle.runOperation('settle',work,{disposeLateResult:()=>true})}:{}),current:sourceCurrent,terminalCurrent,goalReached:()=>goal?.snapshot().phase==='complete',
  onRefusal:reason=>configuration.onFailure?.(Object.freeze({schemaVersion:'ct-runtime-first-cause/1',source:'composition',phase:reason.startsWith('controller_')?'prepare-controller':'select-planning',reason:'campaign_'+reason})),
  startFor:()=>{
   if(!current())return null;
   if(foreground){
    // One selection after actual image review. Holding/reusing it cannot extend
    // native permission, an already issued approval, or the foreground bound.
    // The once-only admission token keeps its finite diagnostic ceiling even
    // when the execution session is bound to longer original authority.
    if(!manualStart){const nowMs=Date.now(),approval=session.resolveApproval(scope);manualStart=selectManualGameStart({scope,policy:c.policy,bounds:c.bounds,nowMs,expiresAtMs:Math.min(nativeExpires,nowMs+Math.min(120000,c.bounds.wallBudgetMs,configuration.maximumRunMs),approval?Date.parse(approval.approvedUntil):Infinity)},{explicitStartCurrent});}
    return {policy:c.policy,bounds:c.bounds,manualStart,checkpoint:c.checkpoint,journal:c.journal};
   }
   return {policy:c.policy,bounds:c.bounds,window:selectGameWindow({scope,policy:c.policy,bounds:c.bounds,purpose:'play',nowMs:Date.now()},{policyCurrent:current}),checkpoint:c.checkpoint,journal:c.journal};
  },
  observe:async(join,signal,afterActionId=null)=>{
   let observationPhase='native-observe';
   try{
   configuration.onActivityPhase?.('observing');
   const observation=await gamePhase(scope.runId,'observation',()=>observeUntilFrameReviewed({signal,current,frameOwner,maximumRunMs:configuration.maximumRunMs,...(frameOwner?.qualifyOwnedFrame?{qualifyForPlay:observation=>{if(!current())throw Error('Play authority changed');const frame=evidence.frameForReview(scope,attach.pinsDigest);if(!frame||frame.observation.observationId!==observation.observationId)throw Error('Current owned game framebuffer required');try{return frameOwner.qualifyOwnedFrame(frame);}finally{frame.bytes.fill(0);}}}:{}),...(executionOwner?{preparation:'untilCancelled'}:{}),onWaiting:value=>{waitingForFrame=value;if(value&&lifecycle?.snapshot().state==='playing')lifecycle.waitForReview();},observe:()=>{const operation=runGameObservationCommand(configuration.maximumCommandMs,signal,async({signal,deadlineAt,check})=>{
   observationPhase='native-observe';const request={schemaVersion:'1.0.0',operation:'GameActivityAdapter.observe',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt,cancellationId:randomUUID(),executionMode:'normal',scope,idempotencyKey:randomUUID(),payload:{expectedPinsDigest:attach.pinsDigest,afterActionId,maxScreenshots:1}};
   if(typeof physical.refreshCustody==='function')await refreshSourceCustody(signal);check();
   const result=await join.adapter.observe(request,{signal,isCurrent:sourceCurrent}),observation=result.outcome.payload?.observation??null;check();if(!observation)return null;observationPhase='client-quiescence';if(executionOwner&&!await awaitClientQuiescence(signal))return null;if(typeof physical.refreshCustody==='function')await refreshSourceCustody(signal);check();lastObservation=observation;
   if(wakeRequired&&!wakeJoined){observationPhase='wake-handoff';const handoff=captureCtWakeHandoff(scope,attach.pinsDigest,physical.wakePreparationReceipt,observation);observationPhase='wake-handoff-callback';check();const written=configuration.onNativePreparation?.(handoff);if(written&&typeof written.then==='function')throw Error('Synchronous CT handoff custody required');wakeJoined=true;}
   if(configuration.onObservation){
    observationPhase='frame-capture';if(typeof physical.refreshCustody==='function')await refreshSourceCustody(signal);check();const frame=evidence.frameForReview(scope,attach.pinsDigest);if(!frame)throw Error('Current owned frame required for evidence');
    try{const dialogueAnnotation=reviewedDialogue&&observation.visibleState.some(f=>f.fieldId==='ct.ui.dialogue.present'&&typeof f.value==='boolean'&&f.visibility==='visibleNow'&&f.lastObservedRef===observation.observationId&&f.timelineId===scope.timelineId&&Date.parse(f.freshUntil)>Date.now())?reviewedDialogue.descriptor:null;const record=captureCtObservationEvidence(scope,observation,frame,reviewedScene?.descriptor.qualificationRef??dialogueAnnotation?.qualificationRef??null,reviewedScene?.descriptor.annotationOrigin??dialogueAnnotation?.annotationOrigin??'UNSPECIFIED');observationPhase='observation-callback';check();const written=configuration.onObservation(record,frame.bytes);if(written&&typeof written.then==='function')throw Error('Synchronous CT image custody required');}finally{frame.bytes.fill(0);}
   }
   check();return observation;
   });pendingNativeObservation=operation;const clear=()=>{if(pendingNativeObservation===operation)pendingNativeObservation=null;};void operation.then(clear,clear);return operation;}}));
   observationPhase='observation-complete';if(observation){lastObservation=observation;if(lifecycle?.snapshot().state==='review')lifecycle.beginGameplay();}
   if(observation&&goal&&goal.observe(observation)==='unavailable')return null;return observation;
   }catch(error){try{configuration.onFailure?.(captureSupervisedGameFailure(error,observationPhase));}catch{}throw error;}
  },
  bindingFor:(_scope,journal,observation)=>({...c.binding,scope,journal,pinsDigest:attach.pinsDigest,reconciliationState:'current',reconciledObservationId:observation.observationId,reconciledAt:observation.receivedAt}),
  ...(interpretObservation?{interpretObservation:async(join,observation,signal,accounting)=>{
   // The campaign owner accounts planning perception and the one normal
   // pre-dispatch scene comparison against the original checkpoint.
   // Settlement observations do not invoke a model.
   if(signal.aborted||!current()||!interpretationCurrent()||!frameOwner?.current(observation))return null;
   if(typeof physical.refreshCustody==='function')await refreshSourceCustody(signal);
   configuration.onActivityPhase?.('observing');
   const interpreted=await gamePhase(scope.runId,'vision',()=>interpretObservation(join,observation,signal,accounting));
   configuration.onActivityPhase?.('thinking');
   if(!interpreted||signal.aborted||!current()||!interpretationCurrent()||!frameOwner.current(interpreted))return null;
   const published=interpretationPin.onInterpretedObservation?.(interpreted);if(published&&typeof published.then==='function')throw Error('Synchronous interpreted observation custody required');
   return !signal.aborted&&current()&&interpretationCurrent()&&frameOwner.current(interpreted)?interpreted:null;
  }}:{}),
  ...(typeof configuration.playConsentCurrent==='function'?{waitForObservationChange:async(join,signal)=>awaitChangedGameScene(lastObservation,{observe:signal=>source.observe(join,signal),current,signal,frameNumber:()=>evidence.currentFrameNumber(scope,attach.pinsDigest)})}:{}),
  ...(typeof configuration.playConsentCurrent==='function'?{planningTaskFor:candidate=>isDeepStrictEqual(candidate,scope)&&configuration.playConsentCurrent(candidate)===true?'ordinaryCtProgress':null}:{}),
  actionProposalConstraintsFor:candidate=>sourceCurrent(candidate)?authority.planningConstraintsFor?.(candidate)??null:null,
  campaignBoundary,dispatchBoundary:{maxPlanningAgeMs:sanityTiming.observationFreshnessMs,maxPlanningFrameDelta:c.bounds.maxActionFrames,maximumObservationAgeMs:sanityTiming.observationFreshnessMs,validatorRef:configuration.ordinaryGameplay==='continuous'?'owned-bizhawk-dispatch:live-v1':'owned-bizhawk-dispatch:1',observationCurrent:campaignBoundary.observationCurrent,now:Date.now},
  requestFor:(join,result,dispatch,observation,signal)=>goal?.snapshot().phase==='complete'?Promise.resolve(null):frameOwner&&!frameOwner.current(observation)?Promise.resolve(null):authority.requestFor(join,result,dispatch,observation,signal),planningTerminalCurrent:()=>current(),settledSourceCurrent:(_join,request,result)=>{if(!current()||!result.result||!evidence.acceptAction(request,result.result))return false;if(configuration.onAction){const written=configuration.onAction(captureCtActionEvidence(request,result.result));if(written&&typeof written.then==='function')throw Error('Synchronous CT action custody required');}return true;}
 };
 const campaignOwnerOptions={continuousGameTime:configuration.ordinaryGameplay==='continuous',sessionScoped:configuration.ordinarySessionLifetime==='sessionScoped',settlementTimeoutMs:sanityTiming.settlementTimeoutMs,metadata,journal,startsFor:database=>new GameStartRepository(database,{maxClaims:64,maxAssistantSlots:4,limitsFor:()=>current()?configuration.startLimits:null,quarantined:()=>!current()&&!terminalCurrent(scope,physical.terminationReceipt?.receiptRef),admissionCurrent:current,inspectionCurrent:candidate=>current()||terminalCurrent(candidate,physical.terminationReceipt?.receiptRef),dispositionCurrent:(candidate,next,_revision,ref)=>next==='stopped'&&terminalCurrent(candidate,ref)}),source,planningBounds:configuration.planningBounds,maximumObservationAgeMs:sanityTiming.observationFreshnessMs,maximumContextBytes:configuration.maximumContextBytes};
 const native={resolveAttachment:(actor,metadata)=>sessionCurrent(metadata.scope)&&actor.principalId===scope.principalId&&actor.sessionId===scope.contextBinding.sessionId&&isDeepStrictEqual(metadata,attach)?(({protocol,...binding})=>binding)(metadata):null,bindingCurrent:()=>current(),controllerCurrent:()=>current()&&(!frameOwner||frameOwner.current()),sourceCurrent,
  ...(typeof physical.refreshCustody==='function'?{refreshSourceCustody:async(candidate,pins,signal)=>{if(pins!==attach.pinsDigest||!isDeepStrictEqual(candidate,scope))throw Error('Native source refresh fenced');await refreshSourceCustody(signal);}}:{}),
  sourceAvailable:evidence.sourceAvailable,acceptObservation:evidence.acceptObservation,acceptAction:evidence.acceptAction,reconcileEffect:evidence.reconcileEffect,admitRelease:evidence.admitRelease,usageFor:evidence.usageFor,shutdownExactOldLease:physical.shutdownExactOldLease};
 const campaignOwner=createGameCampaignOwner(campaignOwnerOptions);
 const join=createUbuntuGameHostJoin({client:{sanityTiming,...(typeof physical.refreshCustody==='function'?{refreshNativeCustody:signal=>physical.refreshCustody(signal)}:{}),...(typeof physical.captureRefreshTimeout==='function'?{captureRefreshTimeout:value=>physical.captureRefreshTimeout(value)}:{}),attach,backendUrl:configuration.backendUrl,fetchAuthenticated:session.fetchAuthenticated,isScopeCurrent:sessionCurrent,...(executionLifetime?{executionLifetime}:{}),sourceIsQualified:metadata=>evidence.installationAvailable(metadata.scope,metadata.pinsDigest),nativeBoundary:{...(configuration.ordinaryGameplay==='continuous'?{ordinaryGameTime:true}:{}),providerRef:attach.providerRef,maxDurationMs:configuration.maximumCommandMs,sourceAvailable:evidence.sourceAvailable,acceptObservation:evidence.acceptObservation,acceptAction:evidence.acceptAction,reconcileEffect:evidence.reconcileEffect,admitRelease:evidence.admitRelease},openNative:async(boundary,context)=>{const open=()=>physical.openNative(boundary,context,configuration.nativeLaunch);const opened=await(lifecycle?lifecycle.runOperation('native_start',open,{disposeLateResult:async()=>{await physical.close('late_native_disposal');return physical.terminationReceipt?.removed===true;}}):open());return {...opened,adapter:ctControllerAdapterForProfile(controllerProfile,opened.adapter)};},shutdownExactOldLease:physical.shutdownExactOldLease,...(configuration.onFailure?{onFailure:configuration.onFailure}:{}),httpTimeoutMs:sanityTiming.commandRoundTripTimeoutMs,nativeStartupTimeoutMs:sanityTiming.startupOverallTimeoutMs,sessionDurationMs:configuration.maximumRunMs,shutdownTimeoutMs:sanityTiming.cleanupTimeoutMs},composition:{sanityTiming,inferenceMode:configuration.inferenceMode,...(executionOwner?.authorityExpiresAt?{sessionLifetime:configuration.ordinarySessionLifetime==='sessionScoped'?'sessionScoped':'authorityBound'}:{}),...(executionOwner?{executionLifecycle:lifecycle,preparation:{current:session.preparationCurrent,begin:candidate=>{session.beginExecution(candidate);return true;}}}:{}),native,campaign:campaignOwner.campaign,createRepository:campaignOwner.createRepository,resolveApproval:session.resolveApproval,inferenceQualificationFor:configuration.inferenceQualificationFor,continuousGameTime:configuration.ordinaryGameplay==='continuous',maximumSteps:configuration.maximumPlanningSteps,maximumRunMs:configuration.maximumRunMs,maximumCommandMs:configuration.maximumCommandMs,onStatus:value=>{if(value.state==='resourceBudgetExhausted')session.noteResourceExhaustion?.(scope);configuration.onStatus?.(value);},...(configuration.onFailure?{onFailure:configuration.onFailure}:{})}});
 let closing;const closePhysical=(initiator='composition_close')=>closing??=(async()=>{await physical.close(initiator);const receipt=physical.terminationReceipt;if(receipt&&terminalCurrent(scope,receipt.receiptRef))campaignOwner.recordTerminal(scope,receipt.receiptRef);})();
 const withFrame=(call,capture)=>{
  if(!frameOwner){captureFrameApproval(capture,{stage:'composition',predicate:'frame_owner_absent',approvalPublished:false});throw Error('Current native frame review unavailable');}
  if(!current()){captureFrameApproval(capture,{stage:'composition',predicate:'composition_current_false',approvalPublished:false});throw Error('Current native frame review unavailable');}
  let frame;try{frame=evidence.frameForReview(scope,attach.pinsDigest,capture);}catch(error){captureFrameApproval(capture,{stage:'composition',predicate:'frame_read_threw',approvalPublished:false,exceptionClass:nativeSourceException(error)});throw error;}
  if(!frame){captureFrameApproval(capture,{stage:'composition',predicate:'frame_absent',approvalPublished:false});throw Error('Current native frame unavailable');}
  try{return call(frame);}finally{frame.bytes.fill(0);}
 };
 // Coordinate only with the command already issued by the observation loop.
 // Its original cancellation/deadline remains authoritative; never await the
 // outer human-review loop or issue another observation to satisfy approval.
 const awaitFrameCustodyReady=async(reviewExpires=Infinity)=>{
  if(!frameOwner||!current())throw Error('Current native frame review unavailable');
  const operation=pendingNativeObservation;if(!operation)return;
  const wall=Date.now(),mono=performance.now(),remaining=Math.min(reviewExpires,frameAuthorityExpiresAt())-wall;
  if(!Number.isFinite(remaining)||remaining<=0)throw Error('Current native frame review expired');
  let timer;try{await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Current native frame review expired')),remaining);})]);}
  finally{clearTimeout(timer);}
  if(Date.now()<wall||performance.now()<mono||Date.now()>=reviewExpires||performance.now()-mono>=remaining||!current())throw Error('Current native frame review unavailable');
 };
 const awaitFrameReviewReady=()=>awaitFrameCustodyReady();
 const awaitFrameApprovalReady=()=>awaitFrameCustodyReady(frameReviewExpiresAt);
 const awaitClientQuiescence=signal=>join.waitForClientQuiescence(signal);
 const executionQuiescent=()=>!!lastObservation&&!!(configuration.ordinaryGameplay==='continuous'?evidence.neutralObservationSample(scope,attach.pinsDigest,lastObservation.observationId):evidence.pausedObservationSample(scope,attach.pinsDigest,lastObservation.observationId))&&physical.transportQuiescent===true&&join.clientSnapshot().activeCommandId===null;
 const executionReady=()=>current()&&(!frameOwner||frameOwner.current(lastObservation))&&executionQuiescent();
 // Viewing follows the original authenticated preparation lifetime. Controller
 // grants and inference qualification stay on their own command paths; walking
 // that graph for every audio packet blocks the same event loop's decisions.
 const mediaCurrent=()=>sessionCurrent(scope);
 return Object.freeze({get mediaAvailable(){return mediaCurrent()&&physical.mediaAvailable===true;},openMedia:(signal,observerCurrent)=>{if(!mediaCurrent()||typeof physical.openMedia!=='function')throw Error('Owned game media unavailable');return physical.openMedia(signal,()=>mediaCurrent()&&observerCurrent());},ownedGameTargetCurrent:observation=>typeof frameOwner?.qualifyOwnedFrame==='function'&&sourceCurrent(scope)&&frameOwner.current(observation),awaitFrameReviewReady,awaitFrameApprovalReady,executionReady,executionQuiescent,cleanupConfirmed:()=>!join.clientSnapshot().started||physical.terminationReceipt?.removed===true,join,physical,serverOptions:join.serverOptions,startClient:()=>join.runClient(),ready:()=>join.clientReady(),completion:()=>join.completion().finally(()=>closePhysical('composition_completion')),stop:()=>join.stop().finally(()=>closePhysical('composition_stop')),close:()=>join.stop().finally(()=>closePhysical('composition_close')),reviewFrame:capture=>withFrame(frame=>{const review=frameOwner.review(frame);frameReviewExpiresAt=Date.parse(review.expiresAt);return review;},capture),approveFrame:(body,capture)=>withFrame(frame=>{const result=frameOwner.approve(body,frame,capture);waitingForFrame=false;return result;},capture),snapshot:()=>({...join.clientSnapshot(),goal:goal?.snapshot()??null,frameQualification:frameOwner?(waitingForFrame?'waitingForHuman':frameOwner.current()?'qualified':'required'):'staticManifest',pauseConfirmation:physical.pauseConfirmed?'confirmed':'unconfirmed'})});
}
