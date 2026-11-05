import {ORDINARY_GAME_SESSION_LIMITS} from '@lifestream/contracts/game-host';
import {captureGameSanityTiming} from '../packages/providers-bizhawk/src/game-sanity-timing.ts';
import {captureNativeSource,nativeSourceWitness,nativeSourceException} from '../packages/providers-bizhawk/src/native-source-witness.ts';
import {performance} from 'node:perf_hooks';
import {types as nodeTypes} from 'node:util';

// Non-authorizing closed classification only. No Error.message/name/stack or
// code getter is invoked, and no arbitrary error value leaves this boundary.
const cancellationSites=new Set(['attachment_current', 'poll_initial_attachment', 'preparation_gate_attachment', 'admit_attachment', 'complete_attachment', 'detach_attachment', 'sweep_preparation', 'sweep_current', 'sweep_post_preparation', 'sweep_refresh_failed', 'poll_initial_failed', 'poll_finish_failed', 'poll_finish_current', 'poll_finish_structure', 'poll_pending', 'admit_pre', 'admit_final', 'complete_final', 'legacy_poll_current', 'legacy_sweep']);
const cancellationPredicates=new Set(['current_port_closed', 'current_attachment_closed', 'current_runtime', 'current_wall_lease', 'current_monotonic_lease', 'current_idle_lease', 'current_scope', 'current_principal', 'current_session', 'current_actor', 'current_binding', 'current_native_source', 'structure_port_closed', 'structure_attachment_closed', 'structure_aborted', 'structure_map_identity', 'structure_wall_lease', 'structure_monotonic_lease', 'structure_idle_lease', 'pending_identity', 'command_wall_deadline', 'command_monotonic_deadline', 'pending_signal_aborted', 'pending_context', 'poll_identity', 'poll_signal_aborted', 'operation_failed', 'poll_settled', 'read_refresh_deadline']);
const failurePhases=new Set(['select-planning', 'prepare-planning', 'run-planning', 'prepare-controller', 'run-controller', 'record-settlement', 'publish-episode', 'native-observe', 'client-quiescence', 'wake-handoff', 'wake-handoff-callback', 'frame-capture', 'observation-callback', 'observation-complete']);
const adapterFailureCodes=new Set(['invalidRequest', 'invalidResponse', 'scopeChanged', 'cancelled', 'timedOut', 'unavailable', 'admissionRequired', 'concurrentEffect']);
const hostFailureCodes=new Set(['invalid_game_host_message', 'game_host_scope_denied', 'game_host_conflict', 'game_host_expired', 'game_host_unavailable']);
const adapterDiagnosticCauses=new Set(['host_invoke_execution_mode', 'host_invoke_pending_operation', 'host_invoke_cancel_pending', 'host_invoke_signal_aborted', 'host_invoke_caller_context', 'host_invoke_command_deadline', 'host_invoke_command_schema', 'host_invoke_current_port_closed', 'host_invoke_current_attachment_closed', 'host_invoke_current_runtime', 'host_invoke_current_wall_lease', 'host_invoke_current_monotonic_lease', 'host_invoke_current_idle_lease', 'host_invoke_current_scope', 'host_invoke_current_principal', 'host_invoke_current_session', 'host_invoke_current_actor', 'host_invoke_current_binding', 'host_invoke_current_native_source', 'host_pending_cancel_cancelled', 'host_pending_cancel_deadline', 'host_pending_cancel_scopeChanged', 'host_pending_cancel_detached', 'host_pending_cancel_shutdown', 'provider_result_envelope', 'provider_result_identity', 'provider_observation_scope_pins_images', 'provider_observation_acceptance']);
const plainFailureMessages=Object.freeze({'ct_fresh_wake_handoff_join_required': 'wake_handoff_join_required', 'Synchronous CT handoff custody required': 'handoff_callback_not_synchronous', 'Current owned frame required for evidence': 'current_owned_frame_unavailable', 'ct_annotation_origin_required': 'annotation_origin_required', 'ct_actual_frame_join_required': 'actual_frame_join_required', 'ct_actual_frame_dimensions_required': 'actual_frame_dimensions_required', 'Synchronous CT image custody required': 'observation_callback_not_synchronous', 'ct_evidence_archive_refused': 'evidence_archive_refused'});
export function captureSupervisedGameFailure(error,phase){
 let reason='original_exception_unclassified',cancellation;
 try{
  if(error&&typeof error==='object'&&!nodeTypes.isProxy(error)){
   const proto=Object.getPrototypeOf(error);
   if(proto&&!nodeTypes.isProxy(proto)){
    const constructor=Object.getOwnPropertyDescriptor(proto,'constructor');
    const type=constructor&&Object.hasOwn(constructor,'value')?constructor.value:null;
    if(typeof type==='function'&&!nodeTypes.isProxy(type)){
     const named=Object.getOwnPropertyDescriptor(type,'name'),name=named&&Object.hasOwn(named,'value')?named.value:null;
     const coded=Object.getOwnPropertyDescriptor(error,'code'),code=coded&&Object.hasOwn(coded,'value')?coded.value:null;
     if(name==='GameAdapterBoundaryError'&&typeof code==='string'&&adapterFailureCodes.has(code)){reason='adapter_'+code;if(code==='invalidResponse'){const d=Object.getOwnPropertyDescriptor(error,'diagnosticCause'),cause=d&&Object.hasOwn(d,'value')?d.value:null;if(typeof cause==='string'&&adapterDiagnosticCauses.has(cause))reason+='_'+cause;if(cause==='host_pending_cancel_scopeChanged'){const sd=Object.getOwnPropertyDescriptor(error,'cancellationSite'),pd=Object.getOwnPropertyDescriptor(error,'cancellationPredicate'),site=sd&&Object.hasOwn(sd,'value')?sd.value:null,predicate=pd&&Object.hasOwn(pd,'value')?pd.value:null;if(typeof site==='string'&&cancellationSites.has(site)&&typeof predicate==='string'&&cancellationPredicates.has(predicate))cancellation={cancellationSite:site,cancellationPredicate:predicate};if(cancellation&&predicate==='current_native_source'){const wd=Object.getOwnPropertyDescriptor(error,'nativeSourceWitness'),witness=nativeSourceWitness(wd&&Object.hasOwn(wd,'value')?wd.value:undefined);if(witness)cancellation.nativeSourceWitness=witness;}}}}
     else if(name==='GameHostError'&&typeof code==='string'&&hostFailureCodes.has(code))reason='host_'+code;
     else if(name==='Error'){
      const message=Object.getOwnPropertyDescriptor(error,'message'),value=message&&Object.hasOwn(message,'value')?message.value:null;
      if(typeof value==='string'&&Object.hasOwn(plainFailureMessages,value))reason='plain_'+plainFailureMessages[value];
     }
    }
   }
  }
 }catch{}
 return Object.freeze({schemaVersion:'ct-runtime-first-cause/1',source:'composition',phase:failurePhases.has(phase)?phase:'select-planning',reason,...cancellation});
}

// A receipt records the original retirement disposition, not execution authority.
// nativeShutdownConfirmed is pause/release evidence; full physical removal is
// separately required by the session, including when no action was issued.
const completedReceipts=new WeakSet();
export const isOrderlySupervisedGameCompletion=value=>value!==null&&typeof value==='object'&&completedReceipts.has(value)&&value.orderly===true;

const safe=fn=>{try{return fn()===true;}catch{return false;}};
const positive=(value,max)=>Number.isSafeInteger(value)&&value>=1&&value<=max;
const nativeNames=['resolveAttachment','bindingCurrent','controllerCurrent','sourceCurrent','sourceAvailable','acceptObservation','acceptAction','reconcileEffect','admitRelease','usageFor','shutdownExactOldLease'];
const campaignNames=['selectPlanning','planningCurrent','terminalRef','publishDecision','prepareController','controllerCurrent','recordSettledStep'];

/** Trusted source composition only. The authenticated server supplies its own
 * runtime and coordinator; these callbacks cannot create authentication or consent. */
export function createSupervisedGameRuntime({native,campaign,createRepository,resolveApproval,memory,inferenceQualificationFor,inferenceMode,maximumSteps,maximumRunMs,maximumCommandMs,onStatus=()=>{},onFailure,onRetire,preparation,executionLifecycle,sanityTiming,sessionLifetime,continuousGameTime=false}){
 for(const name of nativeNames)if(typeof native?.[name]!=='function')throw Error('Missing qualified native port: '+name);
 for(const name of campaignNames)if(typeof campaign?.[name]!=='function')throw Error('Missing campaign owner port: '+name);
 if(typeof createRepository!=='function'||typeof resolveApproval!=='function'||!positive(maximumSteps,sessionLifetime==='sessionScoped'?ORDINARY_GAME_SESSION_LIMITS.decisions:64)||!positive(maximumRunMs,sessionLifetime==='sessionScoped'?ORDINARY_GAME_SESSION_LIMITS.maximumMs:sessionLifetime==='authorityBound'?300000:120000)||!positive(maximumCommandMs,120000))throw Error('Invalid finite game composition');
 if(sessionLifetime!==undefined&&(!['authorityBound','sessionScoped'].includes(sessionLifetime)||inferenceMode!=='supervisedForeground'||!preparation))throw Error('Original authority-bound session owner required');
 if(onRetire!==undefined&&typeof onRetire!=='function')throw Error('Invalid game retirement port');
 if(preparation&&(Object.keys(preparation).sort().join(',')!=='begin,current'||typeof preparation.current!=='function'||typeof preparation.begin!=='function'||!executionLifecycle||['check','runOperation','snapshot'].some(name=>typeof executionLifecycle[name]!=='function')))throw Error('Original execution preparation owner required');
 const timing=captureGameSanityTiming(sanityTiming);
 const refreshSourceCustody=native.refreshSourceCustody;
 if(refreshSourceCustody!==undefined&&typeof refreshSourceCustody!=='function')throw Error('Invalid physical custody refresh');
 const nativePins=Object.fromEntries(nativeNames.map(name=>[name,native[name]]));
 const campaignPins=Object.fromEntries(campaignNames.map(name=>[name,campaign[name]]));
 const resourceExhausted=campaign.resourceExhausted;if(resourceExhausted!==undefined&&typeof resourceExhausted!=='function')throw Error('Invalid session resource outcome');
 const waitForObservationChange=campaign.waitForObservationChange;if(waitForObservationChange!==undefined&&typeof waitForObservationChange!=='function')throw Error('Invalid fresh-scene wait port');
 const unchanged=()=>campaign.resourceExhausted===resourceExhausted&&campaign.waitForObservationChange===waitForObservationChange&&native.refreshSourceCustody===refreshSourceCustody&&nativeNames.every(name=>native[name]===nativePins[name])&&campaignNames.every(name=>campaign[name]===campaignPins[name]);
 const abort=new AbortController();
 let repository,join,used=false,stopped=false,timer,expires=0,lastWall=0,shutdownPromise,shutdownFailed=false;
 let finishCompletion;const completed=new Promise(resolve=>{finishCompletion=resolve;});
 const report=value=>{try{onStatus(Object.freeze(value));}catch{}};
 const envelopeCurrent=()=>{
  if(stopped||abort.signal.aborted||!unchanged())return false;
  if(!join)return true;
  const now=Date.now();if(now<lastWall||expires>0&&performance.now()>=expires)return false;lastWall=now;return true;
 };
 const shutdown=()=>{
  if(!join)return Promise.resolve(false);
  if(!shutdownPromise)shutdownPromise=(async()=>{let confirmed=false;try{confirmed=await nativePins.shutdownExactOldLease(join)===true;}catch{shutdownFailed=true;}report({state:confirmed?'stopped':'requiresReconciliation',nativeShutdownConfirmed:confirmed});return confirmed;})();
  return shutdownPromise;
 };
 // Intentional retirement fences the original polling client before native
 // shutdown. Failure-driven retirement keeps the original client failure path
 // so an in-flight denial or source error is not replaced with normal closure.
 const retire=(orderly=false)=>{if(stopped)return completed;stopped=true;if(orderly)try{onRetire?.();}catch{orderly=false;}abort.abort();clearTimeout(timer);try{join?.runtime.close();}catch{orderly=false;}return shutdown().then(confirmed=>{const receipt=Object.freeze({orderly:orderly&&!shutdownFailed,nativeShutdownConfirmed:confirmed});completedReceipts.add(receipt);finishCompletion(receipt);return receipt;});};
 const current=capture=>{if(!envelopeCurrent()||join&&!safe(join.runtime.isCurrent)){captureNativeSource(typeof capture==='function'?capture:undefined,{stage:'boundary',predicate:'boundary_current'});void retire();return false;}return true;};
 // The runtime itself invokes sourceCurrent while checking isCurrent. Keep the
 // outer lease/source predicate separate so that those checks cannot recurse.
 if(inferenceMode!==undefined&&!['backgroundP2','supervisedForeground'].includes(inferenceMode))throw Error('Unknown game inference mode');
 const gameRuntime=Object.freeze({...(sessionLifetime?{sessionLifetime}:{}),...(inferenceMode?{inferenceMode}:{}),...(preparation?{preparation}:{}),resolveApproval,sourceCurrent:scope=>envelopeCurrent()&&safe(()=>nativePins.sourceCurrent(scope)),...(memory?{memory}:{}),...(inferenceQualificationFor?{inferenceQualificationFor}:{})});
 const gameHost=Object.freeze({maxAttachments:1,maxDurationMs:maximumCommandMs,sanityTiming:timing,
  ...(refreshSourceCustody?{refreshSourceCustody:(scope,pins,signal)=>refreshSourceCustody(scope,pins,signal)}:{}),
  createRepository:database=>{if(repository)throw Error('Second game repository refused');repository=createRepository(database);if(!repository)throw Error('Campaign repository unavailable');return repository;},
  resolveAttachment:(actor,metadata)=>current()?nativePins.resolveAttachment(actor,metadata):null,
  bindingCurrent:(actor,binding)=>current()&&safe(()=>nativePins.bindingCurrent(actor,binding)),
  controllerCurrent:(checkpoint,request)=>current()&&safe(()=>nativePins.controllerCurrent(checkpoint,request))&&safe(()=>campaignPins.controllerCurrent(checkpoint,request)),
  boundary:{...(continuousGameTime?{ordinaryGameTime:true}:{}),sourceAvailable:(scope,pins,capture)=>current(capture)&&safe(()=>{try{return nativePins.sourceAvailable(scope,pins,capture);}catch(error){captureNativeSource(capture,{stage:'boundary',predicate:'threw',exceptionClass:nativeSourceException(error)});throw error;}}),
   acceptObservation:(request,observation)=>current()&&safe(()=>nativePins.acceptObservation(request,observation)),
   acceptAction:(request,result)=>current()&&safe(()=>nativePins.acceptAction(request,result)),
   reconcileEffect:async(request,context)=>current()&&await nativePins.reconcileEffect(request,context)===true,
   admitRelease:async(request,context)=>current()&&await nativePins.admitRelease(request,context)===true},
  onAttached:value=>{
   if(used||!repository||!current()||!value?.runtime||!safe(value.runtime.isCurrent))throw Error('Authenticated game runtime unavailable');
   for(const name of ['preparePlanning','runPlanning','publishEpisode','isCurrent','controllerCurrent','close'])if(typeof value.runtime[name]!=='function')throw Error('Incomplete authenticated game runtime');
   used=true;join=value;lastWall=Date.now();expires=performance.now()+maximumRunMs;
   if(preparation)expires=0;else{timer=setTimeout(retire,maximumRunMs);timer.unref();}
   void (async()=>{
    let failurePhase='select-planning',orderly=false;
    try{
     for(let index=0;index<maximumSteps&&current();index++){
      failurePhase='select-planning';const selected=await campaignPins.selectPlanning(join,repository,abort.signal);
      if(!selected||!current()){if(!selected&&current()&&resourceExhausted&&safe(resourceExhausted)){report({state:'resourceBudgetExhausted',index});orderly=true;}break;}
      failurePhase='prepare-planning';const step=join.runtime.preparePlanning(selected.selection,selected.bounds);
      if(preparation&&expires===0){expires=performance.now()+maximumRunMs;timer=setTimeout(retire,maximumRunMs);timer.unref();}
      const model=()=>join.runtime.runPlanning(step,{current:(scope,checkpoint)=>current()&&safe(()=>campaignPins.planningCurrent(scope,checkpoint)),terminalRef:result=>campaignPins.terminalRef(result,step),publishDecision:result=>current()&&safe(()=>campaignPins.publishDecision(result,step))});
      failurePhase='run-planning';const outcome=await(executionLifecycle?executionLifecycle.runOperation('model',model,{disposeLateResult:()=>safe(join.runtime.isQuiescent)}):model());
      // Finish a complete I/O turn, including queued inspection/child-close
      // callbacks, before another synchronous owner/publication validation burst.
      // Currentness is checked again below; no prior eligibility crosses it.
      await new Promise(resolve=>setImmediate(()=>setImmediate(resolve)));
      if(outcome.state!=='published'||!current()){report({state:'suppressed',reason:outcome.reason??outcome.state,index});break;}
      failurePhase='prepare-controller';const controller=await campaignPins.prepareController(join,step,outcome,repository,abort.signal);
      if(continuousGameTime&&(controller===null||controller?.kind==='reobserve')){report({state:controller===null?'modelNoAction':'reobservingChangedScene',index});if(index+1===maximumSteps){report({state:'resourceBudgetExhausted',index});orderly=current();break;}continue;}
      if(controller===null){report({state:'modelNoAction',index});if(index+1<maximumSteps&&waitForObservationChange){report({state:'waitingForSceneChange',index});if(await waitForObservationChange(join,step,repository,abort.signal)&&current())continue;}orderly=current();break;}
      if(!controller||!current()||!safe(join.runtime.controllerCurrent))throw Error('Current controller selection unavailable');
      const control=()=>join.runController(controller,{signal:abort.signal,current:(checkpoint,request)=>current()&&safe(()=>campaignPins.controllerCurrent(checkpoint,request)),usageFor:nativePins.usageFor});
      failurePhase='run-controller';const result=await(executionLifecycle?executionLifecycle.runOperation('controller',control,{disposeLateResult:value=>value?.result?.outcome?.payload?.buttonsNeutralized===true}):control());
      if(result.state!=='settled'){report({state:'requiresReconciliation',index});break;}
      // The campaign owner supplies actual committed journal/source evidence.
      // Memory publication remains subject to independent production consent.
      failurePhase='record-settlement';const recorded=await campaignPins.recordSettledStep(join,controller,result,repository,abort.signal);
      if(!recorded||recorded.journalCommitted!==true)throw Error('Durable campaign journal unavailable');
      if(recorded.episode&&current()){
       failurePhase='publish-episode';const memoryResult=join.runtime.publishEpisode(recorded.episode);
       report({state:'episodePublication',index,retained:memoryResult.state==='retained'});
      }
      report({state:'settled',index});
      if(recorded.goalReached===true){report({state:'goalReached',index});orderly=current();break;}
      if(index===maximumSteps-1){if(sessionLifetime==='sessionScoped')report({state:'resourceBudgetExhausted',index});orderly=current();}
     }
    }catch(error){const failure=captureSupervisedGameFailure(error,failurePhase);try{onFailure?.(failure);}catch{}try{onFailure?.(Object.freeze({...failure,schemaVersion:'ct-runtime-terminal-cause/1'}));}catch{}report({state:'suppressed',reason:'qualifiedCurrentPortsUnavailable'});}
    finally{await retire(orderly);}
   })();
  }
 });
 return Object.freeze({gameHost,gameRuntime,current,stop:async()=>{await retire(true);},completion:()=>completed});
}
