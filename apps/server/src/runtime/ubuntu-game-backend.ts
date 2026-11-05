import {createGameActivityFeed} from './game-activity-feed.ts';
import {createOrdinaryGameLifecycle} from './ubuntu-game-composition.mjs';
import {captureFrameApproval,nativeSourceException,type FrameApprovalCapture} from '@lifestream/providers-bizhawk';
import {finiteSupervisedGameConfiguration,applySupervisedGameSanityTiming,ordinaryGameSessionConfiguration} from './supervised-game-session.ts';
import {captureReviewedGameScene} from './reviewed-game-scene.ts';
import {captureReviewedDialogueProfile} from './reviewed-dialogue-profile.ts';
import {captureCtVisibleGoalPolicy} from './ct-visible-goal-policy.ts';
import {isDeepStrictEqual} from 'node:util';
import {createUbuntuGameAdmission} from './ubuntu-game-admission.ts';
import {createUbuntuGameSession} from './ubuntu-game-session.ts';
import {createGameControllerAuthority} from './game-controller-authority.ts';
import {GameHostError} from './game-host-port.ts';
import {createContractValidator} from '@lifestream/contracts';
import {gameInferenceSelectionDigest,qualifiedGameInferenceBounds,supervisedGameProviderAvailable} from './game-host-runtime.ts';
import {c72NativeReadiness,scopeDigest} from '@lifestream/providers-bizhawk/c72-native-configuration';
import {createHash} from 'node:crypto';
import {createUbuntuNativeApproval} from './ubuntu-native-approval.ts';
import {createNativeFactsPreparation} from '@lifestream/providers-bizhawk/native-facts-preparation';
import {readNativeFile,fileDigest} from '@lifestream/providers-bizhawk/c72-native-configuration';
import {captureGameSanityTiming} from '@lifestream/providers-bizhawk';

const unavailable=(code:string):never=>{throw new GameHostError(409,code);};
/** Independently reviewed operator facts from the private launch configuration,
 * never model output or HTTP fields. Match the existing registry at every use. */
export function configuredGameInferenceQualification(value:any){
 const pin=value&&Object.freeze(structuredClone(value));let lastWall=Date.now();
 return (selection:any)=>{
  if(!pin||Object.keys(pin).sort().join(',')!=='expiresAt,preemptionBoundMs,qualificationRef,selectionDigest,slotReleaseBoundMs'||pin.selectionDigest!==gameInferenceSelectionDigest(selection)||!Number.isFinite(Date.parse(pin.expiresAt)))return null;
  const current=()=>{const now=Date.now();if(now<lastWall)return false;lastWall=now;return now<Date.parse(pin.expiresAt);};
  return {selectionDigest:pin.selectionDigest,qualificationRef:pin.qualificationRef,preemptionBoundMs:pin.preemptionBoundMs,slotReleaseBoundMs:pin.slotReleaseBoundMs,current};
 };
}
/** Nonsecret independently qualified operator evidence may arrive after bind.
 * Missing/expired/changed files deny readiness; no model/health call is made. */
export function fileGameInferenceQualification(path:string){
 let lastWall=Date.now(),clockValid=true;
 return(selection:any)=>{try{
  const now=Date.now();if(now<lastWall)clockValid=false;lastWall=now;if(!clockValid)return null;
  const bytes=readNativeFile(path,8192,true),pin=fileDigest(bytes),value=JSON.parse(bytes.toString('utf8')),remaining=Date.parse(value.expiresAt)-now;if(!Number.isFinite(remaining)||remaining<1||remaining>120000)return null;
  const proof=configuredGameInferenceQualification(value)(selection);if(!proof)return null;const deadline=performance.now()+remaining;
  return {...proof,current:()=>{try{return clockValid&&performance.now()<deadline&&proof.current()&&fileDigest(readNativeFile(path,8192,true))===pin;}catch{return false;}}};
 }catch{return null;}};
}
/** Read-only forecast of the SAME durable rolling limit enforced by claimManual.
 * This is UI/prelaunch readiness, never a reservation, refund or start claim. */
export function configuredGameStartReadiness(limits:any,database:any,assistantId:string,now=Date.now()){
 try{
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(limits?.rollingPeriodMs)||limits.rollingPeriodMs<1||!Number.isSafeInteger(limits?.rollingStartLimit)||limits.rollingStartLimit<1)throw Error();
  const floor=database.connection.prepare('SELECT observed_at FROM activity_metadata_clock WHERE singleton=1').get();
  if(!floor||now<floor.observed_at)throw Error();
  const rows=database.connection.prepare('SELECT claimed_at FROM game_start_claims WHERE assistant_id=? AND claimed_at>? ORDER BY claimed_at DESC LIMIT ?').all(assistantId,now-limits.rollingPeriodMs,limits.rollingStartLimit);
  if(rows.length<limits.rollingStartLimit)return Object.freeze({available:true,nextEligibleAt:null});
  return Object.freeze({available:false,nextEligibleAt:new Date(rows[limits.rollingStartLimit-1].claimed_at+limits.rollingPeriodMs).toISOString()});
 }catch{return Object.freeze({available:false,nextEligibleAt:null});}
}
/** Ordinary Play uses the already approved model/action ledger. Vision and
 * planning each consume a real model call; this does not expand that budget. */
export function ordinaryGamePlanningSteps(bounds:any,usesVision:boolean,sessionScoped=false):number{
 const calls=bounds?.modelCallBudget,actions=bounds?.actionBudget;
 if(!Number.isSafeInteger(calls)||calls<1||!Number.isSafeInteger(actions)||actions<1)throw Error('Finite ordinary game resources required');
 const steps=Math.min(sessionScoped?512:64,actions,Math.floor(calls/(usesVision?2:1)));
 if(steps<1)throw Error('Ordinary game decision budget unavailable');return steps;
}
/** Source configuration only. This owner never opens a DB, authenticates a
 * user, creates identities, changes history or constructs another HTTP server. */
export function createUbuntuGameBackend(configuration:any,ports:any){
 if(configuration.inferenceMode!==undefined&&!['backgroundP2','supervisedForeground'].includes(configuration.inferenceMode))throw Error('Unknown game inference mode');
 let bounds=configuration.campaign?.bounds;
 if(configuration.sessionProfile==='supervised8')captureCtVisibleGoalPolicy(configuration);
 if(!finiteSupervisedGameConfiguration(configuration)||!/^[a-f0-9]{64}$/.test(configuration.attach?.pinsDigest??'')||!createContractValidator().validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/GameBounds',bounds).valid)throw Error('Finite pinned supervised CT configuration required');
 configuration=applySupervisedGameSanityTiming(configuration);bounds=configuration.campaign.bounds;
 const scene=configuration.reviewedSceneProfile===undefined?null:captureReviewedGameScene(configuration.reviewedSceneProfile);
 const generalVision=configuration.gameFrameVision!==undefined;
 if(generalVision&&(configuration.goalMode!=='observedGameplay'||scene)||configuration.goalMode==='observedGameplay'&&!generalVision)throw Error('General game vision requires an observed gameplay goal without a scene table');
 const dialogue=configuration.reviewedDialogueProfile===undefined?null:captureReviewedDialogueProfile(configuration.reviewedDialogueProfile);
 if(dialogue&&(!generalVision||configuration.goalMode!=='observedGameplay'||scene))throw Error('Reviewed dialogue requires general game vision without a scene table');
 const interpretationReady=()=>generalVision&&typeof ports.gameFrameInterpretationFor==='function'&&ports.gameFrameInterpretationReady?.()===true;
 const sessionScoped=ports.ordinaryPlay===true&&configuration.ordinarySessionLifetime==='sessionScoped';
 if(sessionScoped){configuration=ordinaryGameSessionConfiguration(configuration);bounds=configuration.campaign.bounds;}
 const authorityBound=ports.ordinaryPlay===true&&['authorityBound','sessionScoped'].includes(configuration.ordinarySessionLifetime);
 if(ports.ordinaryPlay===true)configuration={...configuration,maximumPlanningSteps:ordinaryGamePlanningSteps(bounds,!!configuration.gameFrameVision,sessionScoped)};
 if(authorityBound){
  configuration={...configuration,maximumRunMs:Math.min(configuration.maximumControllerGrantMs??120000,configuration.nativePreparation?.maximumNativeLifetimeMs??120000)};
  // The native peer counts paused planning time after its first input. Keep
  // that elapsed task bound coherent with the original authority envelope;
  // actual absolute grant expiry still ends execution sooner, without renewal.
  bounds={...bounds,wallBudgetMs:configuration.maximumRunMs};
 }
 configuration={...configuration,sanityTiming:captureGameSanityTiming(configuration.sanityTiming),...(scene?{reviewedSceneProfile:structuredClone(configuration.reviewedSceneProfile)}:{}),...(dialogue?{reviewedDialogueProfile:dialogue.profile}:{}),attach:structuredClone(configuration.attach),campaign:{...configuration.campaign,bounds:Object.freeze(structuredClone(bounds))}};
 const admission=createUbuntuGameAdmission(configuration.template,{timeoutMs:configuration.admissionTimeoutMs??900000}),template=admission.template;
 const activityFeed=createGameActivityFeed(template.runId);
 if(template.environmentId!==ports.environmentId||!configuration.profile||!Number.isInteger(configuration.profile.revision)||configuration.profile.revision<1)throw Error('Existing CT profile/environment binding required');
 const profilePin=Object.freeze({...configuration.profile});
 const configuredQualification=configuration.inferenceQualificationFor??(configuration.inferenceQualificationFile?fileGameInferenceQualification(configuration.inferenceQualificationFile):configuredGameInferenceQualification(configuration.inferenceQualification));
 const inferenceQualificationFor=configuredQualification;

 let executionOwner=ports.executionOwner;
 let session:any,authority:any,composition:any,nativeApproval:any,boundActor:any,closed=false,preparationFailed=false,playIntent=false,preview:any=null,playAbort:AbortController|undefined;
 const profileCurrent=()=>{
  const row=(ports.identityDatabase??ports.database).readGet("SELECT profile_id,revision FROM assistant_profiles WHERE assistant_id=? AND status='active'",template.assistantId);
  return !!row&&row.profile_id===profilePin.profileId&&row.revision===profilePin.revision;
 };
 const check=()=>{if(closed)unavailable('game_backend_closed');if(!profileCurrent())unavailable('game_profile_changed');};
 const ownedActors=new WeakSet<object>();
 const identity=(actor:any)=>{
  if(actor.principalId!==template.principalId||(actor.actorId??actor.principalId)!==template.principalId)throw new GameHostError(403,'game_session_scope_denied');
  if(!boundActor||actor===boundActor||ownedActors.has(actor))return actor;
  // Later requests cannot replace the original Bind's authenticated context or
  // selection revision with a newly resolved actor for the same logical IDs.
  const pinned=boundActor,current=(scope:any)=>actor.isCurrent(scope)===true&&pinned.isCurrent(scope)===true;
  const selected=Object.freeze({...actor,isCurrent:current,...(actor.runtimeFor?{runtimeFor:(scope:any,repository:any)=>current(scope)?actor.runtimeFor(scope,repository):null}:{})});ownedActors.add(selected);return selected;
 };
 const broker=Object.fromEntries(['attach','next','admit','complete','detach','preparationObservationCurrent'].map(method=>[method,(...args:any[])=>{const value=ports.broker();if(!value)unavailable('game_native_unavailable');return value[method](...args);} ]));
 // Consumed native sessions cannot launch again. Their running source/custody
 // checks are separate from these prelaunch checks for empty run directories.
 const ready=()=>(configuration.sessionProfile!=='supervised8'||(generalVision?interpretationReady():!!scene))&&!!configuration.nativeInstallation&&!!configuration.nativeLaunch&&(configuration.nativeInstallation.kind!=='c72-container'||!!nativeApproval&&!!session&&!session.started()&&c72NativeReadiness(configuration.nativeInstallation,session.scope,configuration.attach.pinsDigest,configuration.nativeLaunch))&&!!ports.inferenceSelection&&(configuration.inferenceMode==='supervisedForeground'?supervisedGameProviderAvailable(ports.inferenceSelection()):!!qualifiedGameInferenceBounds({resolveApproval:()=>null,sourceCurrent:()=>false,inferenceQualificationFor},ports.inferenceSelection()));
 const controllerReadyForExecution=()=>{const consent=session?.executionConsent(session.scope);return !!consent&&(!consent.controllerInput||authority?.canStart()===true);};
 const status=(actor:any)=>{
  check();actor=identity(actor);if(!session)return admission.status(actor);
  const value=session.status(actor);
  const native=nativeApproval?(value.contextReady?nativeApproval.status(actor):{required:true,state:'contextRequired'}):{required:false,state:'notRequired'};
  const selection=ports.inferenceSelection?.();
  const frameQualification=composition?.snapshot().frameQualification??'notStarted',controllerPermissionCurrent=value.contextReady&&authority.canStart();
  const configurationReady=ready(),startBudget=configuredGameStartReadiness(configuration.startLimits,ports.database,template.assistantId);
  if(value.state==='stopped')activityFeed.phase('stopped');
  return {...value,...(value.contextReady?{activityFeed:activityFeed.snapshot(),liveMedia:{runId:template.runId,available:composition?.mediaAvailable===true}}:{}),...(preview&&value.contextReady&&Date.parse(preview.expiresAt)>Date.now()?{currentFrame:preview}:{}),phase:'bound',preparing:!!playAbort&&!session.started(),readyForPlay:value.contextReady&&!value.started&&!playAbort&&startBudget.available,cleanupConfirmed:!composition||composition.cleanupConfirmed(),goal:composition?.snapshot().goal??null,sessionProfile:configuration.sessionProfile??'qualification',sceneProfileReady:!!scene,gameFrameVisionReady:interpretationReady(),sessionBudget:{seconds:configuration.maximumRunMs/1000,modelCalls:bounds.modelCallBudget,actions:bounds.actionBudget,frames:bounds.frameBudget},nativeApproval:native,frameQualification,controllerPermissionCurrent,controllerReady:value.current&&controllerPermissionCurrent&&frameQualification==='qualified',...(selection?{inference:{mode:configuration.inferenceMode??'backgroundP2',availableForSelectedMode:configuration.inferenceMode==='supervisedForeground'?supervisedGameProviderAvailable(selection):!!qualifiedGameInferenceBounds({resolveApproval:()=>null,sourceCurrent:()=>false,inferenceQualificationFor},selection),nativeP2BoundsRequired:configuration.inferenceMode!=='supervisedForeground',selection:structuredClone(selection),selectionDigest:gameInferenceSelectionDigest(selection),qualified:!!qualifiedGameInferenceBounds({resolveApproval:()=>null,sourceCurrent:()=>false,inferenceQualificationFor},selection)}}:{}),configurationReady,startBudget,readyForStart:startBudget.available&&value.readyForStart&&configurationReady&&(!native.required||native.state==='approved'),readinessReason:!startBudget.available?'The configured CT start budget is unavailable; wait until the next eligible start.':configuration.sessionProfile==='supervised8'&&!(generalVision?interpretationReady():!!scene)?(generalVision?'The selected local game image interpreter must be qualified before this session can start.':'An independently reviewed changing-scene profile is required before this session can start.'):!configurationReady?'Native facts are prepared by Review native game session; source/inference must have current qualification.':native.required&&native.state!=='approved'?'Review and explicitly approve this exact native session before Start.':null};
 };
 return Object.freeze({
  // Retire only an expired bootstrap that never bound, reviewed or started.
  // This synchronous terminal step owns no native child or issued authority.
  retireExpiredBootstrap(actor:any){if(closed||session||boundActor||authority||composition||nativeApproval||playAbort||executionOwner)return false;check();actor=identity(actor);if(!admission.expiredUnbound(actor))return false;closed=true;return true;},
  timingCurrent:()=>!closed&&profileCurrent()&&(!session?.started()||session.authorityCurrent(session.scope)),
  executionReady:()=>!closed&&profileCurrent()&&controllerReadyForExecution()&&composition?.executionReady()===true,
  executionQuiescent:()=>!closed&&composition?.executionQuiescent()===true,
  cleanupConfirmed:()=>!composition||composition.cleanupConfirmed(),
  get authorityHost(){return authority?.host;},
  get nativePreparationUnstarted(){try{return !closed&&!!session&&!session.started()&&boundActor?.isCurrent(session.scope)===true&&session.status(boundActor).contextReady===true;}catch{return false;}},
  get assistantId(){return template.assistantId;},
  get operation(){return authority?.operation;},
  get scope(){return session?.scope;},
  status,
  observeStatus(actor:any){
   check();actor=identity(actor);
   if(session?.completed(actor)&&composition?.cleanupConfirmed()===true){check();return Object.freeze({kind:'completed',state:'stopped'});}
   const value=status(actor);
   return Object.freeze({kind:'active',state:value.state,frameQualification:value.frameQualification??'notStarted'});
  },
  bind(actor:any,metadata:any){
   check();actor=identity(actor);if(session)unavailable('game_session_already_bound');
   admission.bind(actor,metadata);admission.publishBinding();boundActor=actor;
   const {ownerPermissionRef,...base}=template;
   const scope={...base,contextBinding:{sessionId:metadata.sessionId,conversationId:metadata.conversationId,endpointId:metadata.endpointId,participationKind:'logicalActivity',humanSpeakerRef:null,audioOwnerEndpointId:null,ownerPermissionRef}};
   if(ports.ordinaryPlay===true)ports.reconcileClosedControllerHolds?.(scope,()=>actor.isCurrent(scope)===true);
   if(ports.ordinaryPlay===true&&!executionOwner){
    const lifecycle=createOrdinaryGameLifecycle({...(sessionScoped?{sessionLifetime:'sessionScoped'}:{}),runId:scope.runId,maximumGameplayMs:configuration.maximumRunMs,sanityTiming:configuration.sanityTiming,
     isCurrent:()=>!closed&&profileCurrent()&&(session?.started()?session.authorityCurrent(scope):boundActor?.isCurrent(scope)===true),
     canExecute:()=>!closed&&profileCurrent()&&controllerReadyForExecution()&&composition?.executionReady()===true,
     isQuiescent:()=>composition?.executionQuiescent()===true,
     onStop:async()=>{await composition?.close();return !composition||composition.cleanupConfirmed()===true;}});
    executionOwner={lifecycle,maximumGameplayMs:configuration.maximumRunMs,...(sessionScoped?{sessionLifetime:'sessionScoped'}:{}),...(authorityBound?{authorityExpiresAt:()=>{const nativeUntil=Date.parse(nativeApproval?.status(boundActor).expiresAt??''),controllerUntil=authority?.currentGrantExpiresAt();return Number.isSafeInteger(nativeUntil)&&Number.isSafeInteger(controllerUntil)?Math.min(nativeUntil,controllerUntil):NaN;}}:{})};
   }
   session=createUbuntuGameSession(scope,{maximumRunMs:configuration.maximumRunMs,maximumPlanningSteps:configuration.maximumPlanningSteps,inferenceMode:configuration.inferenceMode},executionOwner?{...executionOwner,canBegin:()=>!closed&&profileCurrent()&&controllerReadyForExecution()&&composition?.executionReady()===true}:undefined);
   session.configure({broker,origin:ports.origin(),database:ports.database});
   authority=createGameControllerAuthority({scope,pinsDigest:configuration.attach.pinsDigest,bounds:configuration.campaign.bounds,policyRevision:configuration.campaign.policy.revision,sessionProfile:configuration.sessionProfile,maximumGrantMs:configuration.maximumControllerGrantMs??120000,maximumCommandMs:configuration.maximumCommandMs,...(sessionScoped?{sessionLifetime:'sessionScoped'}:{}),...(ports.ordinaryPlay===true?{playTargetCurrent:(candidate:any,observation:any)=>playIntent&&isDeepStrictEqual(candidate,scope)&&(executionOwner?session.preparationCurrent(scope):session.current(scope))&&composition?.ownedGameTargetCurrent(observation)===true}:{})},session);
   if(configuration.nativeInstallation?.kind==='c72-container'){
    const preparation=configuration.nativePreparation?createNativeFactsPreparation(configuration.nativePreparation,scope,configuration.attach.pinsDigest,configuration.nativeInstallation.configurationFile):null;
    nativeApproval=createUbuntuNativeApproval({scope,pinsDigest:configuration.attach.pinsDigest,configurationFile:configuration.nativeInstallation.configurationFile,maximumNativeLifetimeMs:configuration.nativePreparation?.maximumNativeLifetimeMs??120000,...(sessionScoped?{sessionLifetime:'sessionScoped'}:{}),inspectTemplate:preparation?()=>preparation.inspectTemplate():undefined,prepareFacts:preparation?()=>preparation.prepare():undefined,startCurrent:()=>{const consent=executionOwner?session.executionConsent(scope):session.resolveApproval(scope);return !closed&&profileCurrent()&&(executionOwner?session.preparationCurrent(scope):session.current(scope))&&!!consent&&(!consent.controllerInput||authority.canStart());}});
   }
   session.bindHandle({...((ports.ordinaryPlay===true&&executionOwner)?{onCompleted:()=>{void executionOwner.lifecycle.stop('completed');}}:{}),startClient(){if(!composition)unavailable('game_native_unavailable');void composition.startClient().catch(()=>{});},ready:()=>composition.ready(),completion:()=>composition.completion(),cleanupConfirmed:()=>composition.cleanupConfirmed(),stop:async()=>{await composition?.close();},snapshot:()=>composition?.snapshot()??{pauseConfirmation:'unconfirmed'}});
   return status(actor);
  },
  review(actor:any,context:any){check();actor=identity(actor);if(!session)unavailable('game_session_binding_required');return session.review(actor,context);},
  reviewPreparationIntent(actor:any,context:any){
   check();actor=identity(actor);if(!session||!nativeApproval)unavailable('game_native_facts_required');
   if(preparationFailed)unavailable('game_preparation_failed');
   session.reviewPreparation(actor,context);
   return Object.freeze({schemaVersion:'ct-unused-preparation-intent/1',scopeDigest:scopeDigest(session.scope),controller:authority.preparationIntent(),native:nativeApproval.preparationIntent(actor,context)});
  },
  preparePreparationRequests(actor:any,context:any,expectedIntentDigest:string){
   // This synchronous bridge has no await gap between strict unused-state
   // checks and the two original request producers. It grants no authority.
   check();actor=identity(actor);if(!session||!nativeApproval)unavailable('game_native_facts_required');
   if(preparationFailed)unavailable('game_preparation_failed');
   session.reviewPreparation(actor,context);
   const inspect=()=>Object.freeze({schemaVersion:'ct-unused-preparation-intent/1',scopeDigest:scopeDigest(session.scope),controller:authority.preparationIntent(),native:nativeApproval.preparationIntent(actor,context)});
   const intent=inspect(),digest=(value:any)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
   if(!/^[a-f0-9]{64}$/.test(expectedIntentDigest)||digest(intent)!==expectedIntentDigest)unavailable('game_preparation_intent_changed');
   try{
    const permission=authority.review(),native=nativeApproval.review(actor,context);
    if(!isDeepStrictEqual(inspect(),intent))unavailable('game_preparation_intent_changed');
    return Object.freeze({intent,permission,native});
   }catch(error){preparationFailed=true;throw error;}
  },
  inspectControllerPreparation(local:any,assistantId:string,invocationId:string){
   if(!authority?.ownsPreparation(invocationId))return null; // Ordinary tools keep their existing owner.
   check();
   if(assistantId!==template.assistantId||local.principalId!==template.principalId||local.sessionId!==session.scope.contextBinding.sessionId||boundActor?.isCurrent(session.scope)!==true||session.status(boundActor).contextReady!==true)throw new GameHostError(403,'game_session_scope_denied');
   try{return authority.inspectPreparation(invocationId);}catch{unavailable('game_controller_preparation_unavailable');}
  },
  reviewNative(actor:any,context:any){check();actor=identity(actor);if(!session||!nativeApproval)unavailable('game_native_facts_required');if(session.status(actor).started)unavailable('game_native_approval_consumed');return nativeApproval.review(actor,context);},
  approveNative(actor:any,body:any,context:any){check();actor=identity(actor);if(!session||!nativeApproval)unavailable('game_native_facts_required');if(session.status(actor).started)unavailable('game_native_approval_consumed');nativeApproval.approve(actor,body,context);return status(actor);},
  async reviewFrame(actor:any,context:any){
   const assertCurrent=()=>{check();actor=identity(actor);if(!(executionOwner?session?.preparationCurrent(session.scope):session?.current(session.scope))||actor.isCurrent(session.scope)!==true)throw new GameHostError(403,'game_session_context_required');context.assertCurrent({assistantId:session.scope.assistantId,endpointId:session.scope.contextBinding.endpointId,environmentId:session.scope.environmentId,sessionId:session.scope.contextBinding.sessionId});};
   let recorded=false;
   const report:FrameApprovalCapture=value=>{if(recorded)return;recorded=true;try{console.info(JSON.stringify({event:'game-frame-review-first-refusal',observedAtMs:Date.now(),...value}));}catch{}};
   const capture:FrameApprovalCapture|undefined=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1'?value=>captureFrameApproval(report,value):undefined;
   assertCurrent();try{await composition.awaitFrameReviewReady();}catch(error){captureFrameApproval(capture,{stage:'backend',predicate:'review_coordination_wait_threw',approvalPublished:false,exceptionClass:nativeSourceException(error)});unavailable('game_native_frame_required');}
   assertCurrent();try{return composition.reviewFrame(capture);}catch(error){captureFrameApproval(capture,{stage:'backend',predicate:'composition_review_threw',approvalPublished:false,exceptionClass:nativeSourceException(error)});unavailable('game_native_frame_required');}
  },
  async approveFrame(actor:any,body:any,context:any){
   const assertCurrent=()=>{check();actor=identity(actor);if(!(executionOwner?session?.preparationCurrent(session.scope):session?.current(session.scope))||actor.isCurrent(session.scope)!==true)throw new GameHostError(403,'game_session_context_required');context.assertCurrent({assistantId:session.scope.assistantId,endpointId:session.scope.contextBinding.endpointId,environmentId:session.scope.environmentId,sessionId:session.scope.contextBinding.sessionId});};
   let recorded=false;
   const report:FrameApprovalCapture=value=>{if(recorded)return;recorded=true;try{console.info(JSON.stringify({event:'game-frame-approval-first-refusal',observedAtMs:Date.now(),...value}));}catch{}};
   const capture:FrameApprovalCapture|undefined=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1'?value=>captureFrameApproval(report,value):undefined;
   assertCurrent();try{await composition.awaitFrameApprovalReady();}catch(error){captureFrameApproval(capture,{stage:'backend',predicate:'coordination_wait_threw',approvalPublished:false,exceptionClass:nativeSourceException(error)});unavailable('game_native_frame_review_required');}
   // Fresh actor and canonical-context checks precede the original synchronous
   // PNG approval publication. No authorization result crosses the await.
   assertCurrent();try{composition.approveFrame(body,capture);}catch(error){captureFrameApproval(capture,{stage:'backend',predicate:'composition_approval_threw',approvalPublished:false,exceptionClass:nativeSourceException(error)});unavailable('game_native_frame_review_required');}
   try{return status(actor);}catch(error){captureFrameApproval(capture,{stage:'backend',predicate:'post_approval_status_threw',approvalPublished:true,exceptionClass:nativeSourceException(error)});unavailable('game_native_frame_review_required');}
  },
  async play(actor:any,context:any,refreshActor:()=>any,approveController:(request:any)=>Promise<void>,signal?:AbortSignal){
   check();actor=identity(actor);if(ports.ordinaryPlay!==true||configuration.sessionProfile!=='supervised8'||configuration.inferenceMode!=='supervisedForeground'||configuration.nativeInstallation?.kind!=='c72-container'||!generalVision||!session||!nativeApproval||session.started()||playAbort)unavailable('game_play_unavailable');
   const value=status(actor);if(!value.contextReady)throw new GameHostError(403,'game_session_context_required');if(!value.startBudget.available)throw new GameHostError(409,'game_start_budget_exhausted');
   playAbort=new AbortController();const activeAbort=playAbort,linked=AbortSignal.any([activeAbort.signal,...(signal?[signal]:[])]);
   const ongoing=()=>{if(linked.aborted)throw new GameHostError(409,'game_play_cancelled');check();actor=identity(refreshActor());context.assertCurrent({assistantId:session.scope.assistantId,endpointId:session.scope.contextBinding.endpointId,environmentId:session.scope.environmentId,sessionId:session.scope.contextBinding.sessionId});};
   try{ongoing();let cancelWait:(()=>void)|undefined;const cancelled=new Promise<never>((_resolve,reject)=>{cancelWait=()=>reject(new GameHostError(409,'game_play_cancelled'));linked.addEventListener('abort',cancelWait,{once:true});if(linked.aborted)cancelWait();});try{await Promise.race([ports.prepareForPlay?.(session.scope,()=>{try{ongoing();return true;}catch{return false;}},linked),cancelled]);}finally{if(cancelWait)linked.removeEventListener('abort',cancelWait);}ongoing();
   const request=await session.review(actor,context);ongoing();await approveController(request);ongoing();
   check();actor=identity(refreshActor());if(!authority.canStart())throw new GameHostError(403,'game_controller_grant_required');
   const native=nativeApproval.review(actor,context);nativeApproval.approve(actor,{requestId:native.requestId,expectedRevision:native.revision,confirmationDigest:native.confirmationDigest,launchOwnedNative:true,memoryOnlyPairing:true},context);
   playIntent=true;
   try{return await this.start(actor,{observations:true,campaignJournal:true,controllerInput:true,sharedInference:true},context,refreshActor);}catch(error){if(!session.started())playIntent=false;throw error;}
   }finally{if(playAbort===activeAbort)playAbort=undefined;}
  },
  async start(actor:any,consent:any,context:any,refreshActor:()=>any){
   check();actor=identity(actor);if(!session)unavailable('game_session_binding_required');
   if(!consent||Object.keys(consent).sort().join(',')!==(configuration.inferenceMode==='supervisedForeground'?'campaignJournal,controllerInput,observations,sharedInference':'campaignJournal,controllerInput,observations')||configuration.inferenceMode==='supervisedForeground'&&consent.sharedInference!==true||consent.observations!==true||consent.campaignJournal!==true||typeof consent.controllerInput!=='boolean')throw new GameHostError(400,'game_session_consent_required');
   const state=status(actor);if(state.startBudget.available!==true){if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')console.info(JSON.stringify({event:'game-start-budget-refusal',runId:session.scope.runId,nextEligibleAt:state.startBudget.nextEligibleAt}));throw new GameHostError(409,'game_start_budget_exhausted');}if(!state.contextReady)throw new GameHostError(403,'game_session_context_required');
   session.checkStart(actor,consent,context); // Non-consuming authority gate BEFORE composition, pairing or native launch.
   if(nativeApproval&&!nativeApproval.current(actor))unavailable('game_native_approval_required');
   if(!ready())unavailable('game_native_qualification_required');
   if(!composition){
    const scope=session.scope,c=configuration.campaign;
    const {createUbuntuGameComposition}=await import('./ubuntu-game-composition.mjs');
    check();session.checkStart(identity(refreshActor()),consent,context);if(nativeApproval&&!nativeApproval.current(identity(refreshActor())))unavailable('game_native_approval_required');if(!ready())unavailable('game_native_qualification_required');
    try{composition=createUbuntuGameComposition({...configuration,onFailure:(value:any)=>{activityFeed.failure(value);configuration.onFailure?.(value);},onStatus:(value:any)=>{if(value.state==='requiresReconciliation')activityFeed.unconfirmed();if(value.state==='suppressed'&&value.reason==='provider_inference_unavailable')activityFeed.failure({phase:'run-planning',reason:'provider_inference_unavailable'});configuration.onStatus?.(value);},onActivityPhase:activityFeed.phase,onDecision:activityFeed.decision,onSettled:activityFeed.outcome,onRejected:activityFeed.rejected,...(playIntent?{playConsentCurrent:(candidate:any)=>playIntent&&isDeepStrictEqual(candidate,scope)&&(executionOwner?session.preparationCurrent(scope):session.current(scope)),onObservation:(record:any,bytes:Uint8Array)=>{const shot=record.screenshot;preview=Object.freeze({pngBase64:Buffer.from(bytes).toString('base64'),sha256:shot.sha256,frameNumber:record.frameNumber,expiresAt:new Date(Math.min(Date.now()+configuration.sanityTiming.observationFreshnessMs,Date.parse(session.resolveApproval(scope)?.approvedUntil??nativeApproval.status(actor).expiresAt??''))).toISOString()});}}:{}),inferenceQualificationFor,inferenceSelection:ports.inferenceSelection,backendUrl:ports.origin(),attach:{...configuration.attach,scope},campaign:{...c,checkpoint:{...c.checkpoint,scope},binding:{...c.binding,scope}}},{session,authority,executionOwner:executionOwner,...(generalVision?{gameFrameInterpretation:ports.gameFrameInterpretationFor(scope,session)}:{}),takePairingSecret:(request:any)=>nativeApproval.take(request)});}
    catch{throw new GameHostError(503,'game_native_composition_unavailable');}
    try{ports.install(composition.serverOptions);}catch(error){await composition.close();composition=undefined;throw error;}
   }
   return session.start(identity(refreshActor()),consent,context);
  },
  media(actor:any,signal:AbortSignal){check();actor=identity(actor);const selected=actor;
   const requireMedia=(value:boolean,reason:string)=>{if(!value){if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')try{console.info(JSON.stringify({event:'game-media-first-refusal',runId:template.runId,reason}));}catch{}unavailable('game_live_media_unavailable');}};
   const mediaCurrent=()=>!!session&&(executionOwner?session.preparationCurrent(session.scope):session.current(session.scope));
   requireMedia(!!session,'session_absent');requireMedia(!!composition,'composition_absent');requireMedia(mediaCurrent(),'session_not_current');requireMedia(selected.isCurrent(session!.scope)===true,'actor_not_current');requireMedia(composition!.mediaAvailable===true,'native_media_unavailable');
   return composition!.openMedia(signal,()=>!closed&&selected.isCurrent(session!.scope)===true);},
  async stop(actor:any){check();playAbort?.abort();actor=identity(actor);void executionOwner?.lifecycle.stop('cancelled');if(!session)unavailable('game_session_binding_required');nativeApproval?.invalidate();return session.stop(actor);},
  async close(){if(closed)return;closed=true;playAbort?.abort();void executionOwner?.lifecycle.stop('shutdown');preview=null;admission.cancel();nativeApproval?.close();await composition?.close();},
  invalidate(){nativeApproval?.invalidate();session?.retire();void executionOwner?.lifecycle.stop('revoked');},
  bindingMatches(value:any){return !!session&&value.assistantId===session.scope.assistantId&&value.sessionId===session.scope.contextBinding.sessionId&&value.endpointId===session.scope.contextBinding.endpointId&&value.environmentId===session.scope.environmentId;}
 });
}

/** Preserve the existing canonical host for ordinary capabilities. Only the
 * exact CT operation is routed to the authenticated run's controller owner. */
export function ubuntuGameAuthorityRouter(base:any,backend:()=>any,environmentId:string){
 const ownerFor=(binding:any)=>{
  if(binding.environmentId===environmentId){const owner=backend()?.authorityHost;if(owner?.environmentId!==environmentId)throw Error('CT authority owner unavailable');return owner;}
  if(base&&binding.environmentId===base.environmentId)return base;
  throw Error('Authority environment owner unavailable');
 };
 return {environmentId,
  environmentIdFor(binding:any){return ownerFor(binding).environmentId;},
  assertCurrent(binding:any,principalId?:string){ownerFor(binding).assertCurrent(binding,principalId);},
  assertProposalCurrent(request:any,principalId:string){const ct=backend();if(ct?.operation&&isDeepStrictEqual(request.scope,ct.operation))return ct.authorityHost.assertProposalCurrent(request,principalId);return base?.assertProposalCurrent?.(request,principalId);},
  resolveProposal(...args:any[]){if(isDeepStrictEqual(args[0]?.scope,backend()?.operation)||!base?.resolveProposal)throw Error('Use authenticated CT permission review');return base.resolveProposal(...args);},
  ...(base?.validateProposal?{validateProposal:(...args:any[])=>isDeepStrictEqual(args[0]?.scope,backend()?.operation)?undefined:base.validateProposal(...args)}:{})
 };
}
