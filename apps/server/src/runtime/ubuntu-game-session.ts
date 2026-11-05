import {ORDINARY_GAME_SESSION_LIMITS} from '@lifestream/contracts/game-host';
import {isDeepStrictEqual} from 'node:util';
import {isOrderlySupervisedGameCompletion} from '../../../../scripts/supervised-game-runtime.mjs';
import {GAME_HOST_BASE_PATH} from '@lifestream/contracts/game-host';
import {GameHostError,gameHostExpiryDetail} from './game-host-port.ts';

export const UBUNTU_GAME_SESSION_PATH='/api/runtime/v1/game-session';
/** Receives actors ONLY after the existing server local-auth/session/CSRF checks.
 * No cookie, password, ambient session lookup or impersonation transport exists. */
export function createUbuntuGameSession(scope:any,limits:any,executionOwner?:any){
 if(!Number.isSafeInteger(limits.maximumRunMs)||limits.maximumRunMs<1||limits.maximumRunMs>(executionOwner?.sessionLifetime==='sessionScoped'&&typeof executionOwner?.authorityExpiresAt==='function'?ORDINARY_GAME_SESSION_LIMITS.maximumMs:typeof executionOwner?.authorityExpiresAt==='function'?300000:120000)||!Number.isSafeInteger(limits.maximumPlanningSteps)||limits.maximumPlanningSteps<1||limits.maximumPlanningSteps>(executionOwner?.sessionLifetime==='sessionScoped'?ORDINARY_GAME_SESSION_LIMITS.decisions:64))throw Error('Finite scoped game approval required');
 if(limits.inferenceMode!==undefined&&!['backgroundP2','supervisedForeground'].includes(limits.inferenceMode))throw Error('Unknown game inference mode');
 if(executionOwner&&Object.values(Object.getOwnPropertyDescriptors(executionOwner)).some(value=>!('value' in value)))throw Error('Closed original execution owner required');
 const lifecycle=executionOwner?.lifecycle,executionMaximum=executionOwner?.maximumGameplayMs,lifecycleSignal=lifecycle&&Object.getOwnPropertyDescriptor(lifecycle,'signal')?.value;
 if(executionOwner&&(Object.keys(executionOwner).sort().join(',')!==[...(executionOwner.authorityExpiresAt===undefined?[]:['authorityExpiresAt']),'canBegin','lifecycle','maximumGameplayMs',...(executionOwner.sessionLifetime===undefined?[]:['sessionLifetime'])].sort().join(',')||executionOwner.sessionLifetime!==undefined&&executionOwner.sessionLifetime!=='sessionScoped'||executionOwner.authorityExpiresAt!==undefined&&typeof executionOwner.authorityExpiresAt!=='function'||typeof executionOwner.canBegin!=='function'||!Number.isSafeInteger(executionOwner.maximumGameplayMs)||executionOwner.maximumGameplayMs<1||executionOwner.maximumGameplayMs>limits.maximumRunMs||!lifecycle||['check','ready','beginGameplay','snapshot'].some(name=>typeof lifecycle[name]!=='function')||!(lifecycleSignal instanceof AbortSignal)))throw Error('Original execution lifecycle required');
 const lifecyclePins=lifecycle&&Object.fromEntries(['check','ready','beginGameplay','snapshot'].map(name=>[name,lifecycle[name]])),beginPort=executionOwner?.canBegin,authorityExpiryPort=executionOwner?.authorityExpiresAt;
 const executionCurrent=()=>!lifecycle||Object.keys(lifecyclePins).every(name=>Object.getOwnPropertyDescriptor(lifecycle,name)?.value===lifecyclePins[name])&&Object.getOwnPropertyDescriptor(lifecycle,'signal')?.value===lifecycleSignal&&!lifecycleSignal.aborted&&lifecyclePins.check()===true;
 const freeze=(value:any):any=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
 const pinnedScope=freeze(structuredClone(scope));let actor:any,approval:any,broker:any,origin:string,handle:any,authorityOwner:any,permissionReview:any,controllerStartCheck:any,state='ready',consumed=false,consentSnapshot:any=null,executionIssued=false,retired=false,completionConfirmed=false,completionCleanup:any,completionDone:any,preparationStartedAtMs=0;
 const allowed=(value:any)=>value?.principalId===pinnedScope.principalId&&value.sessionId===pinnedScope.contextBinding.sessionId&&value.isCurrent(pinnedScope)===true;
 const authorityCurrent=()=>!retired&&!!actor&&(!executionIssued||!!approval&&Date.now()<Date.parse(approval.approvedUntil))&&allowed(actor);
 const preparationCurrent=()=>consumed&&authorityCurrent()&&executionCurrent();
 const current=()=>!!approval&&preparationCurrent()&&Date.now()<Date.parse(approval.approvedUntil);
 const issueApproval=()=>{if(executionOwner&&Object.getOwnPropertyDescriptor(executionOwner,'authorityExpiresAt')?.value!==authorityExpiryPort)throw new GameHostError(403,'game_execution_not_ready');const authorityUntil=authorityExpiryPort?.(),now=Date.now(),until=Math.min(now+(executionMaximum??limits.maximumRunMs),authorityUntil??Infinity);if(!Number.isSafeInteger(until)||until<=now)throw new GameHostError(403,'game_execution_not_ready');return Object.freeze({scope:pinnedScope,approvedUntil:new Date(until).toISOString(),maximumRunMs:until-now,maximumPlanningSteps:limits.maximumPlanningSteps,observations:true,campaignJournal:true,controllerInput:consentSnapshot.controllerInput,memoryEpisodes:false,...(limits.inferenceMode==='supervisedForeground'?{inferenceMode:'supervisedForeground',sharedInference:true}:{})});};
 const requireIdentity=(value:any)=>{if(value?.principalId!==pinnedScope.principalId||value.sessionId!==pinnedScope.contextBinding.sessionId||actor&&((value.actorId??value.principalId)!==(actor.actorId??actor.principalId)||!isDeepStrictEqual(value.effectiveContext,actor.effectiveContext)))throw new GameHostError(403,'game_session_scope_denied');};
 const requireActor=(value:any)=>{requireIdentity(value);if(!allowed(value))throw new GameHostError(403,'game_session_scope_denied');};
 let terminalReason:'resourceBudgetExhausted'|null=null;
 const status=(value:any)=>{requireIdentity(value);const contextReady=allowed(value);return Object.freeze({terminalReason,...(terminalReason?{message:'This gameplay session reached its declared resource budget.'}:{}),inferenceMode:limits.inferenceMode??'backgroundP2',sharingConsentRequired:limits.inferenceMode==='supervisedForeground',retired,state:retired&&!consumed?'stopped':!contextReady&&!consumed?'contextRequired':current()||executionOwner&&!executionIssued&&preparationCurrent()?state:consumed?'stopped':'ready',scope:pinnedScope,started:consumed,current:current(),contextReady,readyForStart:contextReady&&!consumed,...(!contextReady&&!consumed?{message:'Restore the existing session in Session disclosure and explicitly Unlock the personal session. Assistant and relationship access must still be current.'}:{}),pauseConfirmation:handle?.snapshot().pauseConfirmation??'unconfirmed',restartAvailable:false});};
 const stop=async(value:any)=>{requireActor(value);completionConfirmed=false;retired=true;state='stopping';try{await handle?.stop();}finally{approval=null;state='stopped';}return status(value);};
 const checkStart=(value:any,consent:any,canonicalContext?:any)=>{
  requireActor(value);
  if(consumed||retired||!broker||!handle)throw new GameHostError(409,'game_session_start_unavailable');
  if(!consent||Object.keys(consent).sort().join(',')!==(limits.inferenceMode==='supervisedForeground'?'campaignJournal,controllerInput,observations,sharedInference':'campaignJournal,controllerInput,observations')||limits.inferenceMode==='supervisedForeground'&&consent.sharedInference!==true||consent.observations!==true||consent.campaignJournal!==true||typeof consent.controllerInput!=='boolean')throw new GameHostError(400,'game_session_consent_required');
  actor=value;if(canonicalContext)authorityOwner.context=canonicalContext;
  if(consent.controllerInput&&(!controllerStartCheck||controllerStartCheck()!==true))throw new GameHostError(403,'game_controller_grant_required');
 };
 return Object.freeze({
  scope:pinnedScope,
  started:()=>consumed,
  authorityCurrent:(candidate:any)=>isDeepStrictEqual(candidate,pinnedScope)&&authorityCurrent(),
  configure(input:any){if(broker||!input.broker||!/^http:\/\/127\.0\.0\.1:\d+$/.test(input.origin))throw Error('Single staged game broker required');broker=input.broker;origin=input.origin;authorityOwner={database:input.database,context:null};},
  bindHandle(value:any){if(handle)throw Error('Second launcher handle refused');handle=value;completionCleanup=Object.getOwnPropertyDescriptor(value,'cleanupConfirmed')?.value;completionDone=Object.getOwnPropertyDescriptor(value,'onCompleted')?.value;if(completionDone!==undefined&&typeof completionDone!=='function')throw Error('Fixed completion callback required');},
  current:(candidate:any)=>isDeepStrictEqual(candidate,pinnedScope)&&current(),
  preparationCurrent:(candidate:any)=>isDeepStrictEqual(candidate,pinnedScope)&&(executionOwner?preparationCurrent():current()),
  // One fresh authority/lifecycle traversal also supplies the original consent.
  // A trusted callback may consume wall time or stop the lifecycle; re-read
  // these cheap terminal bounds after it returns, without re-running the graph.
  executionConsent:(candidate:any)=>isDeepStrictEqual(candidate,pinnedScope)&&preparationCurrent()&&(!lifecycleSignal||!lifecycleSignal.aborted)&&(!executionIssued||!!approval&&Date.now()<Date.parse(approval.approvedUntil))?consentSnapshot:null,
  beginExecution(candidate:any){
   if(!executionOwner||!isDeepStrictEqual(candidate,pinnedScope)||executionIssued||approval||!preparationCurrent()||Object.getOwnPropertyDescriptor(executionOwner,'canBegin')?.value!==beginPort||beginPort()!==true||!preparationCurrent())throw new GameHostError(403,'game_execution_not_ready');
   if(consentSnapshot.controllerInput&&(!controllerStartCheck||controllerStartCheck()!==true))throw new GameHostError(403,'game_controller_grant_required');
   // Mint once, only at the original post-image planning boundary. A review
   // pause cannot refresh this wall-clock approval or a native/controller grant.
   executionIssued=true;approval=issueApproval();

   try{const phase=lifecyclePins.snapshot().state;if(phase==='preparing')lifecyclePins.ready();lifecyclePins.beginGameplay();if(!current())throw Error('Execution currentness lost');state='running';if(process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS==='1')try{const gameplayStartedAtMs=Date.parse(approval.approvedUntil)-approval.maximumRunMs;console.info(JSON.stringify({event:'game-execution-started',runId:scope.runId,preparationStartedAtMs,gameplayStartedAtMs,preparationElapsedMs:gameplayStartedAtMs-preparationStartedAtMs,approvalExpiresAtMs:Date.parse(approval.approvedUntil),maximumGameplayMs:approval.maximumRunMs}));}catch{}return approval;}catch(error){completionConfirmed=false;retired=true;approval=null;state='failed';throw error;}
  },
  noteResourceExhaustion:(candidate:any)=>{if(isDeepStrictEqual(candidate,pinnedScope)&&current())terminalReason='resourceBudgetExhausted';},
  custodyCurrent:(candidate:any)=>isDeepStrictEqual(candidate,pinnedScope)&&!!actor&&allowed(actor),
  resolveApproval:(candidate:any)=>isDeepStrictEqual(candidate,pinnedScope)&&current()?approval:null,
  status,stop,
  // Only the original settled completion can survive execution retirement.
  // Identity/authentication remain fresh, and this never makes current() true.
  completed(value:any){requireActor(value);return completionConfirmed&&!!actor&&allowed(actor);},
  retire(){if(!consumed)return;completionConfirmed=false;retired=true;approval=null;state='stopped';void Promise.resolve().then(()=>handle?.stop()).catch(()=>{});},
  authorityOwner:()=>actor&&allowed(actor)&&authorityOwner?.context?authorityOwner:null,
  setPermissionReview(value:any){if(permissionReview)throw Error('Second permission owner refused');permissionReview=value;},
  setControllerStartCheck(value:any){if(controllerStartCheck)throw Error('Second controller Start owner refused');controllerStartCheck=value;},
  checkStart,
  reviewPreparation(value:any,context:any){
   requireActor(value);
   if(consumed||retired||!authorityOwner||!executionCurrent())throw new GameHostError(409,'game_preparation_unavailable');
   context.assertCurrent({assistantId:pinnedScope.assistantId,endpointId:pinnedScope.contextBinding.endpointId,environmentId:pinnedScope.environmentId,sessionId:pinnedScope.contextBinding.sessionId});
   // Bind only the original authenticated context. Do not call permissionReview
   // or create the approval/consent/active-execution state while setup waits.
   actor=value;authorityOwner.context=context;
  },
  async review(value:any,context:any){requireActor(value);if(consumed||!permissionReview)throw new GameHostError(409,'game_permission_review_unavailable');actor=value;authorityOwner.context=context;return permissionReview();},
  async start(value:any,consent:any,canonicalContext?:any){
   checkStart(value,consent,canonicalContext);
   actor=value;consumed=true;preparationStartedAtMs=Date.now();consentSnapshot=freeze(structuredClone(consent));approval=executionOwner?null:issueApproval();executionIssued=!executionOwner;state=executionOwner?'preparing':'starting';
   try{handle.startClient();void handle.ready().then(()=>{if(approval&&!retired)state='running';},()=>{completionConfirmed=false;retired=true;approval=null;state='failed';});void handle.completion().then((receipt:unknown)=>{let confirmed=false;try{confirmed=!retired&&isOrderlySupervisedGameCompletion(receipt)&&typeof completionCleanup==='function'&&Object.getOwnPropertyDescriptor(handle,'cleanupConfirmed')?.value===completionCleanup&&completionCleanup.call(handle)===true&&authorityCurrent()&&executionCurrent()&&!retired;}catch{}completionConfirmed=confirmed;retired=true;if(state!=='failed')state='stopped';approval=null;try{if(completionDone&&Object.getOwnPropertyDescriptor(handle,'onCompleted')?.value===completionDone)completionDone();}catch{}},()=>{completionConfirmed=false;retired=true;state='failed';approval=null;try{if(completionDone&&Object.getOwnPropertyDescriptor(handle,'onCompleted')?.value===completionDone)completionDone();}catch{}});return status(value);}catch(error){completionConfirmed=false;retired=true;approval=null;state='failed';throw error;}
  },
  async fetchAuthenticated(url:string,init:RequestInit){
   if(!actor||!broker||!(executionOwner?preparationCurrent():current())&&!(url===origin+GAME_HOST_BASE_PATH+'/detach'))throw new GameHostError(403,'game_session_scope_denied');
   if(!url.startsWith(origin+GAME_HOST_BASE_PATH+'/')||init.method!=='POST'||init.redirect!=='error'||typeof init.body!=='string'||Buffer.byteLength(init.body)>131072)throw new GameHostError(400,'invalid_game_session_transport');
   const route=url.slice((origin+GAME_HOST_BASE_PATH+'/').length),operation=({attach:'attach',next:'next',admit:'admit',result:'complete',detach:'detach'} as any)[route];
   if(!operation)throw new GameHostError(404,'game_session_route_denied');
   const payload=JSON.parse(init.body);
   if(executionOwner&&!current()&&!['attach','next','detach'].includes(route)&&broker.preparationObservationCurrent?.(actor,operation,payload)!==true)throw new GameHostError(403,'game_execution_not_ready');
   try{const result=await broker[operation](actor,payload,init.signal);return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});}
   catch(error:any){
    const code=error.code??'game_session_unavailable';
    // Closed diagnostic metadata for the original direct-broker response only.
    // It never carries arbitrary error text and cannot change denial semantics.
    const diagnosticCodes=['invalid_game_host_message','game_host_scope_denied','game_host_conflict','game_host_expired','game_host_unavailable','game_session_unavailable'];
    const detail=route==='next'?gameHostExpiryDetail(error):undefined;
    return new Response(JSON.stringify({code}),{status:error.status??503,headers:{'content-type':'application/json',...(typeof code==='string'&&diagnosticCodes.includes(code)?{'x-lifestream-game-host-error':code}:{}),...(detail?{'x-lifestream-game-host-cancellation-site':detail.cancellationSite,'x-lifestream-game-host-cancellation-predicate':detail.cancellationPredicate,...(detail.nativeSourceWitness?{'x-lifestream-game-host-native-source':JSON.stringify(detail.nativeSourceWitness)}:{})}:{})}});
   }
  }
 });
}
