import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {join} from 'node:path';
import {GameFrameCustody,captureGameSanityTiming} from '@lifestream/providers-bizhawk';
import {createOwnedC72Native} from '@lifestream/providers-bizhawk/owned-c72-native';
import {readC72NativeConfiguration,scopeDigest} from '@lifestream/providers-bizhawk/c72-native-configuration';
import {createNativeFactsPreparation} from '@lifestream/providers-bizhawk/native-facts-preparation';
import {createUbuntuGameAdmission} from './ubuntu-game-admission.ts';
import {createUbuntuNativeApproval} from './ubuntu-native-approval.ts';
import {captureNativeObservationConfiguration,nativeObservationWireBounds} from './native-observation-configuration.ts';
import {GameHostError} from './game-host-port.ts';

const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(code:string,status=409):never=>{throw new GameHostError(status,code);};
const freeze=(v:any):any=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{
 const abort=()=>{signal.removeEventListener('abort',abort);reject(Error('Native observation cancelled'));};
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
 promise.then(value=>{signal.removeEventListener('abort',abort);signal.aborted?reject(Error('Native observation cancelled')):resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
});}
/** Separate native capture owner. No game broker/runtime, campaign/journal,
 * planning/model/provider port, controller authority or frame-approval owner is
 * created or imported. Test boundary is trusted source only, never config/HTTP. */
export function createUbuntuNativeObservation(raw:unknown,ports:any,testBoundary?:any):any{
 if(raw===undefined)return null;
 const c=captureNativeObservationConfiguration(raw);
 const sanityTiming=captureGameSanityTiming(c.sanityTiming);
 if(c.template.environmentId!==ports.environmentId)throw Error('Existing native-observation environment required');
 const admission=createUbuntuGameAdmission(c.template,{timeoutMs:900000});
 const clock=testBoundary?.clock??{wall:Date.now,mono:()=>performance.now(),timeout:setTimeout,clearTimeout,interval:setInterval,clearInterval};
 let scope:any,boundActor:any,approval:any,physical:any,opened:any,custody:any,started=false,consent=false,closed=false;
 let state='awaitingBind',count=0,anchorFrame:number|undefined,busy=false,lastReceipt:any=null,expectedRequest:any=null;
 let untilMono=0,untilWall=0,nativeExpiry=0,deadline:any,monitor:any,closing:Promise<void>|undefined,cleanup='notStarted';
 const controller=new AbortController();let resolveCompletion!:()=>void;
 const completion=new Promise<void>(resolve=>{resolveCompletion=resolve;});
 const profileCurrent=()=>{const row=ports.database.connection.prepare("SELECT profile_id,revision FROM assistant_profiles WHERE assistant_id=? AND status='active'").get(c.template.assistantId);return row?.profile_id===c.profile.profileId&&row?.revision===c.profile.revision;};
 const self=(actor:any)=>actor&&actor.principalId===c.template.principalId&&actor.actorId===c.template.principalId&&actor.effectiveUserId===c.template.principalId;
 const actorCurrent=(actor:any)=>{try{return self(actor)&&typeof actor.isCurrent==='function'&&typeof actor.sessionId==='string'&&/^[a-f0-9-]{36}$/.test(actor.sessionId)&&(!scope||actor.sessionId===scope.contextBinding.sessionId&&actor.isCurrent(scope)===true)&&(!boundActor||boundActor.isCurrent(scope)===true);}catch{return false;}};
 const assertActor=(actor:any,context?:any)=>{if(!actorCurrent(actor))fail('native_observation_scope_denied',403);if(!profileCurrent())fail('game_profile_changed');if(context&&scope)context.assertCurrent({assistantId:scope.assistantId,sessionId:scope.contextBinding.sessionId,endpointId:scope.contextBinding.endpointId,environmentId:scope.environmentId});};
 const assertContext=(actor:any,context:any)=>{if(!context||typeof context.assertCurrent!=='function'||context.principalId!==c.template.principalId||(context.actorId??context.principalId)!==c.template.principalId)fail('native_observation_scope_denied',403);assertActor(actor,context);};
 let lastWall=0,lastMono=0,clockRetired=false;
 const current=()=>{try{const wall=clock.wall(),mono=clock.mono();if(wall<lastWall||mono<lastMono)clockRetired=true;lastWall=wall;lastMono=mono;return !clockRetired&&!closed&&consent&&!controller.signal.aborted&&mono<untilMono&&wall<untilWall&&wall<nativeExpiry&&actorCurrent(boundActor)&&profileCurrent()&&ports.hostCurrent()===true;}catch{return false;}};
 const validTermination=()=>{const p=physical?.terminationReceipt;return p?.removed===true&&p.scopeDigest===scopeDigest(scope)&&p.pinsDigest===c.pinsDigest&&typeof p.receiptRef==='string'&&p.receiptRef.length>0;};
 const stopInternal=()=>closing??=(async()=>{
  consent=false;state='stopping';controller.abort();clock.clearTimeout(deadline);clock.clearInterval(monitor);expectedRequest=null;lastReceipt=null;
  if(!physical){cleanup='notNeeded';state='stopped';resolveCompletion();return;}
  cleanup='pending';let timer:any;
  const stopped=Promise.resolve().then(()=>physical.close()).then(()=>{cleanup=validTermination()?'confirmed':'unconfirmed';},()=>{cleanup='unconfirmed';});
  await Promise.race([stopped,new Promise<void>(resolve=>{timer=clock.timeout(resolve,sanityTiming.cleanupTimeoutMs);})]);clock.clearTimeout(timer);
  custody?.dispose();state='stopped';resolveCompletion();
 })();
 const snapshot=()=>({mode:'nativeObservationOnly',state,started,observations:count,maximumObservations:c.maximumObservations,maximumRunMs:c.maximumRunMs,controllerActions:0,planningSteps:0,modelCalls:0,automaticFrameApprovals:0,ordinaryGameplayQualified:false,sceneProfileReady:false,cleanup,lastReceipt: lastReceipt?{...lastReceipt}:null,restartAvailable:false});
 const physicalDefault=()=>{
  const facts=readC72NativeConfiguration(c.nativeInstallation.configurationFile,scope,c.pinsDigest);
  custody=new GameFrameCustody(join(facts.runDirectory,'frames'),{maxBytes:2097152,maxQueueBytes:4194304,maxLongEdge:1024,maxFrames:8,maxTtlMs:sanityTiming.observationFreshnessMs,current:()=>current()});
  const remaining=Math.max(1,Math.floor(Math.min(c.maximumRunMs,untilMono-clock.mono())));
  return createOwnedC72Native({configurationFile:c.nativeInstallation.configurationFile,sanityTiming,takePairingSecret:(request:any)=>approval.take(request),native:{sanityTiming,frameCustody:custody,bounds:nativeObservationWireBounds,sessionDurationMs:remaining,authenticationTimeoutMs:Math.min(10000,sanityTiming.nativePairingTimeoutMs,remaining),connectionTimeoutMs:Math.min(sanityTiming.nativeReadyTimeoutMs,remaining)},evidence:{sanityTiming,scope,pinsDigest:c.pinsDigest,providerRef:c.providerRef,custody,isCurrent:()=>current()}});
 };
 const capture=async()=>{
  if(!current()||!opened)fail('native_observation_unavailable');if(busy||count>=c.maximumObservations)fail('native_observation_budget_exhausted');busy=true;count++;
  const request={schemaVersion:'1.0.0',operation:'GameActivityAdapter.observe',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Math.min(clock.wall()+sanityTiming.readRefreshTimeoutMs,untilWall,nativeExpiry)).toISOString(),cancellationId:randomUUID(),executionMode:'normal',scope,idempotencyKey:randomUUID(),payload:{expectedPinsDigest:c.pinsDigest,afterActionId:null,maxScreenshots:1}};
  expectedRequest=request;
  const command=new AbortController(),timer=clock.timeout(()=>command.abort(),Math.min(sanityTiming.readRefreshTimeoutMs,untilMono-clock.mono())),signal=AbortSignal.any([controller.signal,command.signal]);
  try{
   const result:any=await abortable(Promise.resolve().then(()=>opened.adapter.observe(request,{signal,isCurrent:()=>current()})),signal);
   if(!current())throw Error('Native observation retired');
   const o=result?.outcome?.payload?.observation;
   if(result?.outcome?.status!=='succeeded'||!o||result.requestId!==request.requestId||result.correlationId!==request.correlationId||!isDeepStrictEqual(o.scope,scope)||o.pinsDigest!==c.pinsDigest||o.untrusted!==true||o.facts?.length!==0||o.visibleState?.length!==0||o.interpretedAt!==null||o.providerConfigurationRef!==null||physical.evidence.acceptObservation(request,o)!==true)throw Error('Exact uninterpreted native observation required');
   const paused=physical.evidence.pausedObservationSample(scope,c.pinsDigest,o.observationId);
   if(!paused||anchorFrame!==undefined&&paused.frameNumber!==anchorFrame)throw Error('Native observation progressed or controls unavailable');
   const frame=physical.evidence.frameForReview(scope,c.pinsDigest);if(!frame)throw Error('Current native PNG unavailable');
   try{
    if(!isDeepStrictEqual(frame.observation,o)||!current())throw Error('Native frame lineage changed');
    anchorFrame??=paused.frameNumber;
    const receipt={schemaVersion:'ct-native-observation-receipt/1',scopeDigest:scopeDigest(scope),pinsDigest:c.pinsDigest,observationId:o.observationId,pngSha256:frame.screenshot.sha256,frameNumber:o.frameNumber,paused:true,controlsNeutral:true,nativeSequence:paused.sequence,nativeMonotonicMs:paused.monotonicMs,capturedAt:o.capturedAt,ordinaryGameplayQualified:false,controllerActions:0,modelCalls:0};
    lastReceipt=Object.freeze({...receipt,receiptRef:'native-observation:'+digest(receipt)});
    return {receipt:lastReceipt,observation:structuredClone(o),mediaType:'image/png',pngBase64:frame.bytes.toString('base64'),meaning:'Current paused native pixels only. No scene, controller, planning or automatic frame approval.'};
   }finally{frame.bytes.fill(0);}
  }catch(error){void stopInternal();throw error;}finally{clock.clearTimeout(timer);command.abort();busy=false;expectedRequest=null;}
 };
 return Object.freeze({assistantId:c.template.assistantId,get scope(){return scope;},
  status(actor:any){assertActor(actor);return {...snapshot(),phase:scope?'bound':'bootstrap',...(scope?{scope,nativeApproval:approval.status(actor)}:{binding:admission.status(actor)})};},
  bind(actor:any,metadata:any){assertActor(actor);if(closed||closing||controller.signal.aborted||started||scope)fail('native_observation_already_bound');admission.bind(actor,metadata);admission.publishBinding();const {ownerPermissionRef,...base}=c.template;scope=freeze({...base,contextBinding:{sessionId:metadata.sessionId,conversationId:metadata.conversationId,endpointId:metadata.endpointId,participationKind:'logicalActivity',humanSpeakerRef:null,audioOwnerEndpointId:null,ownerPermissionRef}});boundActor=actor;state='bound';const prepare=(testBoundary?.prepareFacts??createNativeFactsPreparation({...c.nativePreparation,purpose:'nativeObservationOnly',maximumRunMs:c.maximumRunMs},scope,c.pinsDigest,c.nativeInstallation.configurationFile).prepare);approval=createUbuntuNativeApproval({scope,pinsDigest:c.pinsDigest,purpose:'nativeObservationOnly',maximumRunMs:c.maximumRunMs,maximumObservations:c.maximumObservations,configurationFile:c.nativeInstallation.configurationFile,prepareFacts:prepare,startCurrent:current},testBoundary?.nativeApprovalBoundary);return this.status(actor);},
  reviewNative(actor:any,context:any){assertContext(actor,context);if(closed||closing||controller.signal.aborted||!scope||started)fail('native_observation_review_unavailable');return approval.review(actor,context);},
  approveNative(actor:any,body:any,context:any){assertContext(actor,context);if(closed||closing||controller.signal.aborted||!scope||started)fail('native_observation_review_unavailable');approval.approve(actor,body,context);return this.status(actor);},
  async start(actor:any,body:any,context:any){
   assertContext(actor,context);if(closed||closing||controller.signal.aborted||started||!scope||!approval.current(actor)||ports.hostCurrent()!==true)fail('native_observation_start_unavailable');
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='noControllerInput,noPlanning,observations'||body.observations!==true||body.noPlanning!==true||body.noControllerInput!==true)fail('native_observation_consent_required',400);
   started=true;consent=true;state='starting';untilMono=clock.mono()+c.maximumRunMs;untilWall=clock.wall()+c.maximumRunMs;nativeExpiry=Date.parse(approval.status(actor).expiresAt);
   deadline=clock.timeout(()=>{void stopInternal();},Math.min(c.maximumRunMs,nativeExpiry-clock.wall()));
   monitor=clock.interval(()=>{if(!current()||state==='observing'&&!physical.evidence.sourceAvailable(scope,c.pinsDigest))void stopInternal();},100);
   try{
    physical=(testBoundary?.createPhysical??physicalDefault)({scope,configuration:c,current,takePairingSecret:(request:any)=>approval.take(request)});
    const boundary={providerRef:c.providerRef,maxDurationMs:sanityTiming.readRefreshTimeoutMs,sourceAvailable:(candidate:any,pins:string)=>isDeepStrictEqual(candidate,scope)&&pins===c.pinsDigest&&current()&&physical.evidence.sourceAvailable(candidate,pins),acceptObservation:physical.evidence.acceptObservation,admitObservation:async(request:any)=>current()&&isDeepStrictEqual(request,expectedRequest),claimEffect:async()=>false,acceptAction:()=>false,acceptSave:()=>false,admitRelease:async()=>false};
    const opening=Promise.resolve().then(()=>physical.openNative(boundary,{signal:controller.signal,isCurrent:()=>current()},c.nativeLaunch));
    void opening.then((value:any)=>{if(!current()){value.close?.();void physical.close().catch(()=>{});}},()=>{});
    opened=await abortable(opening,controller.signal);if(!current())throw Error('Native opening retired');state='observing';
    const first=await capture();assertActor(actor,context);return {status:this.status(actor),firstObservation:first};
   }catch(error){void stopInternal();throw error;}
  },
  async observe(actor:any,body:any,context:any){assertContext(actor,context);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length||state!=='observing')fail('native_observation_unavailable');const value=await capture();assertContext(actor,context);return value;},
  async stop(actor:any){assertActor(actor);await stopInternal();return this.status(actor);},
  invalidate(){if(!scope)return;approval?.invalidate();void stopInternal();},
  async close(){if(closed)return closing;closed=true;admission.cancel();approval?.close();return stopInternal();},
  completion:()=>completion
 });
}
