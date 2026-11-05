// SOURCE PROPOSAL ONLY. Fixed launcher import; never load code paths from JSON.
// File gates are private owner instructions, not newly minted app authentication.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {isSelectedCtJobLifecycle,validateDedicatedCtExecutionPolicy} from './ct-job-lifecycle-owner.mjs';
export {validateDedicatedCtExecutionPolicy} from './ct-job-lifecycle-owner.mjs';

const sha=raw=>createHash('sha256').update(raw).digest('hex');
const json=value=>JSON.stringify(value);
const digest=value=>sha(json(value));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fail=code=>{const error=Error(code);error.code=code;throw error;};
const keys=(value,expected)=>assert(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected.split(',').sort().join(','),'closed CT52 job shape required');

/** Legacy sceneProfileDigest wire name binds only this explicit safety profile
 * in general mode; it is not a scene table, visual answer or model approval. */
export function generalFrameSafetyProfile(configuration,configurationSha256){
 if(configuration?.goalMode!=='observedGameplay'||!configuration.gameFrameVision||Array.isArray(configuration.gameFrameVision)||typeof configuration.gameFrameVision!=='object'||configuration.initialDialogue!==''||configuration.reviewedSceneProfile!==undefined||!hash(configurationSha256))fail('ct_job_general_observation_configuration_required');
 const value={schemaVersion:'ct-general-frame-review/1',kind:'ordinaryGameplaySafetyOnly',configurationSha256};
 return Object.freeze({...value,manifestDigest:digest(value)});
}
export function requiredDedicatedCtReviewCount(configuration,stage){
 return configuration?.goalMode==='observedGameplay'&&/^frame-(?:0[1-9]|[12][0-9]|3[0-2])$/.test(stage)?1:2;
}
export function summarizeDedicatedCtFrame(configuration,configurationSha256,value){
 const base={requestId:value.requestId,confirmationDigest:value.confirmationDigest,pngSha256:value.pngSha256,frameNumber:value.frameNumber,expiresAt:value.expiresAt,pngBase64:value.pngBase64};
 if(configuration?.goalMode==='observedGameplay'){
  if(value.sceneProfile!==undefined)fail('ct_job_general_scene_semantics_refused');
  const frameProfile=generalFrameSafetyProfile(configuration,configurationSha256);
  if(value.frameProfile!==undefined&&!isDeepStrictEqual(value.frameProfile,frameProfile))fail('ct_job_general_safety_profile_mismatch');
  return {...base,frameProfile};
 }
 return {...base,sceneProfile:value.sceneProfile};
}
export function validateDedicatedCtFrameIdentity(configuration,configurationSha256,review,payload){
 const summary=summarizeDedicatedCtFrame(configuration,configurationSha256,review),profile=summary.frameProfile??summary.sceneProfile;
 if(!hash(payload.screenshotSha256)||!Number.isSafeInteger(payload.frameNumber)||!hash(payload.sceneProfileDigest)||review.pngSha256!==payload.screenshotSha256||review.frameNumber!==payload.frameNumber||profile?.manifestDigest!==payload.sceneProfileDigest)fail('ct_job_frame_review_identity_mismatch');
 return true;
}

const codeOf=error=>typeof error?.code==='string'&&/^[a-z][a-z0-9_]{1,95}$/.test(error.code)?error.code:'ct_job_failed';
const copy=value=>JSON.parse(json(value));
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export function validateDedicatedCtSelection(selection,configuration,configurationBytes,now=Date.now()){
 const setup=selection?.schemaVersion==='canonical-dedicated-ct-job/4',nonexpiring=setup||selection?.schemaVersion==='canonical-dedicated-ct-job/3',browser=nonexpiring||selection?.schemaVersion==='canonical-dedicated-ct-job/2';
 keys(selection,nonexpiring?'schemaVersion,enabled,jobId,nonce,ownerBinding,jobRoot,metadataDirectory,configurationSha256,preparation,execution':browser?'schemaVersion,enabled,jobId,nonce,ownerBinding,jobRoot,metadataDirectory,configurationSha256,expiresAt':'schemaVersion,enabled,jobId,nonce,sessionId,jobRoot,metadataDirectory,configurationSha256,expiresAt');
 assert.equal(selection.schemaVersion,setup?'canonical-dedicated-ct-job/4':nonexpiring?'canonical-dedicated-ct-job/3':browser?'canonical-dedicated-ct-job/2':'canonical-dedicated-ct-job/1');
 if(browser)assert.equal(selection.ownerBinding,'originalBrowserRequest');
 assert.equal(typeof selection.enabled,'boolean');
 assert(uuid(selection.jobId)&&(browser||uuid(selection.sessionId))&&/^[a-f0-9]{32}$/.test(selection.nonce));
 assert.equal(selection.jobRoot,`/srv/lifestream/workspace/runtime-state/ct-owner-job-${selection.jobId}`);
 assert.equal(selection.metadataDirectory,`/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-${selection.jobId}`);
 assert(hash(selection.configurationSha256)&&Buffer.isBuffer(configurationBytes)&&configurationBytes.length<=262144);
 assert.equal(sha(configurationBytes),selection.configurationSha256);
 assert(isDeepStrictEqual(JSON.parse(configurationBytes.toString('utf8')),configuration));
 assert(configuration?.sessionProfile==='supervised8'&&configuration?.inferenceMode==='supervisedForeground');
 assert(configuration?.campaign?.bounds?.actionBudget===8&&configuration.campaign.bounds.modelCallBudget===8);
 if(nonexpiring){
  keys(selection.preparation,'mode');assert.equal(selection.preparation.mode,'untilCancelled');
  const execution=validateDedicatedCtExecutionPolicy(selection.execution);
  assert(Number.isSafeInteger(configuration.maximumRunMs)&&configuration.maximumRunMs>0&&configuration.maximumRunMs<=90000,'reviewed configuration outer ceiling required');
  assert(execution.maximumGameplayMs<=configuration.maximumRunMs,'execution budget must fit reviewed configuration outer ceiling');
 }else{
  assert(configuration?.maximumRunMs>0&&configuration.maximumRunMs<=90000);
  const remaining=Date.parse(selection.expiresAt)-now;
  // Historical selections retain their exact original staging expiry.
  assert(Number.isFinite(remaining)&&remaining>0&&remaining<=900000,'bounded fresh CT52 staging expiry required');
 }
 return freeze(copy(selection));
}
function lifecycleFor(selection,input){
 if(!['canonical-dedicated-ct-job/3','canonical-dedicated-ct-job/4'].includes(selection.schemaVersion)||!selection.enabled)return null;
 const lifecycle=input.lifecycle;
 assert(isSelectedCtJobLifecycle(lifecycle,selection.execution)===true,'fixed-bootstrap lifecycle matching reviewed policy required');
 assert(lifecycle.signal instanceof AbortSignal&&lifecycle.check()===true,'current original lifecycle required');
 return lifecycle;
}

// Production registration below supplies only the fixed filesystem port.
// Separate pure core supports deterministic refusal/lifecycle tests. It cannot
// construct an actor, HTTP server, provider, process or native controller.
export function createDedicatedCtJobCore(app,input,ports){
 const selection=validateDedicatedCtSelection(input.selection,input.configuration,input.configurationBytes,ports.now());
 const lifecycle=lifecycleFor(selection,input),setup=selection.schemaVersion==='canonical-dedicated-ct-job/4',nonexpiring=setup||selection.schemaVersion==='canonical-dedicated-ct-job/3';
 const selectionDigest=digest(selection),configuration=freeze(copy(input.configuration));
 let browserOwner,owner,closed=false,claimed=false,lastWall=ports.now(),frameSequence=0,generation=null,intentDigest=null,baselineIntent,preparationMethods,statusObservation;
 const abort=new AbortController();
 const end=nonexpiring?null:Date.parse(selection.expiresAt);
 const deadlineTimer=selection.enabled&&!nonexpiring?setTimeout(()=>abort.abort(),Math.max(1,end-ports.now())):null;
 const diagnostic=Object.getOwnPropertyDescriptor(input.evidenceOwner??{},'diagnostic')?.value;
 const reportCurrent=reason=>{try{if(typeof diagnostic==='function')diagnostic(Object.freeze({schemaVersion:'ct-runtime-first-cause/1',source:'launcher',phase:'current',reason}));}catch{}};
 const envelopeFailure=now=>closed?'closed':abort.signal.aborted?'aborted':now<lastWall?'wall_clock_changed':!Number.isFinite(now)?'invalid_clock':!nonexpiring&&now>=end?'selection_expired':undefined;
 const current=()=>{const now=ports.now();let reason=envelopeFailure(now);
  // Preserve the original short-circuit order and the single lifecycle check.
  if(!reason&&lifecycle&&lifecycle.check()!==true)reason='lifecycle_not_current';
  if(reason){reportCurrent(reason);fail('ct_job_expired_or_closed');}lastWall=now;return now;};
 const safePublish=async(name,value)=>ports.publish(name,freeze(copy({schemaVersion:setup?'ct52-job-publication/2':'ct52-job-publication/1',...(setup?{generation,intentDigest}:{}),jobId:selection.jobId,nonce:selection.nonce,selectionDigest,configurationSha256:selection.configurationSha256,...value})));
 const cancelled=()=>abort.abort();lifecycle?.signal.addEventListener('abort',cancelled,{once:true});
 let closing;const close=()=>{if(closing)return closing;closed=true;clearTimeout(deadlineTimer);abort.abort();lifecycle?.signal.removeEventListener('abort',cancelled);closing=Promise.resolve().then(async()=>{await Promise.all([browserOwner?browserOwner.close():owner?.close(),lifecycle?.stop('cancelled')]);});return closing;};
 // Cancellation bounds retained waits without imposing a browser/reviewer deadline.
 const wait=work=>new Promise((resolve,reject)=>{
  const stop=()=>{abort.signal.removeEventListener('abort',stop);reject(Object.assign(Error('ct_job_cancelled_or_closed'),{code:'ct_job_cancelled_or_closed'}));};
  if(abort.signal.aborted){stop();return;}abort.signal.addEventListener('abort',stop,{once:true});
  Promise.resolve().then(()=>{current();return work();}).then(value=>{abort.signal.removeEventListener('abort',stop);try{current();resolve(value);}catch(error){reject(error);}},error=>{abort.signal.removeEventListener('abort',stop);reject(error);});
 });
 const bounded=async(work,kind='owner_prepare')=>{
  current();let timer;
  try{return await Promise.race([wait(work),new Promise((_,reject)=>{timer=setTimeout(()=>{const e=Error('ct_job_deadline');e.code='ct_job_deadline';reject(e);},nonexpiring?selection.execution.operationLimits[kind]:Math.max(1,end-ports.now()));})]);}
  finally{clearTimeout(timer);}
 };
 const dispatch=async(stage,publicationDigest)=>{
  const alternatives=Array.isArray(stage)?stage:[stage];
  current();const value=await wait(()=>ports.waitDispatch(stage,abort.signal,end));current();
  const selectedStage=value?.stage;if(!alternatives.includes(selectedStage))fail('ct_job_dispatch_mismatch');
  keys(value,setup?'schemaVersion,jobId,nonce,stage,selectionDigest,configurationSha256,publicationDigest,preparation,generation,intentDigest,reviewReferences,payload':nonexpiring?'schemaVersion,jobId,nonce,stage,selectionDigest,configurationSha256,publicationDigest,preparation,reviewReferences,payload':'schemaVersion,jobId,nonce,stage,selectionDigest,configurationSha256,publicationDigest,expiresAt,reviewReferences,payload');
  if(nonexpiring){keys(value.preparation,'mode');if(value.preparation.mode!=='untilCancelled')fail('ct_job_dispatch_mismatch');}
  const dispatchExpiry=nonexpiring?null:Date.parse(value.expiresAt);
  if(setup&&(value.generation!==generation||value.intentDigest!==intentDigest))fail('ct_job_dispatch_generation_mismatch');
  if(value.schemaVersion!==(setup?'ct52-worker-dispatch/3':nonexpiring?'ct52-worker-dispatch/2':'ct52-worker-dispatch/1')||value.jobId!==selection.jobId||value.nonce!==selection.nonce||!alternatives.includes(value.stage)||value.selectionDigest!==selectionDigest||value.configurationSha256!==selection.configurationSha256||value.publicationDigest!==publicationDigest||!nonexpiring&&(!Number.isFinite(dispatchExpiry)||dispatchExpiry>end||dispatchExpiry<=ports.now()))fail('ct_job_dispatch_mismatch');
  if(!Array.isArray(value.reviewReferences)||value.reviewReferences.length!==requiredDedicatedCtReviewCount(configuration,selectedStage))fail('ct_job_independent_reviews_required');
  const roles=new Set();
  for(const ref of value.reviewReferences){
   keys(ref,'name,sha256,role');
   if(!['main','independent'].includes(ref.role)||roles.has(ref.role)||!hash(ref.sha256)||!/^review-[a-z0-9-]+\.json$/.test(ref.name))fail('ct_job_review_reference_invalid');
   roles.add(ref.role);
   const review=await wait(()=>ports.readReview(ref.name,ref.sha256));current();
   keys(review,setup?'schemaVersion,jobId,stage,role,status,selectionDigest,configurationSha256,publicationDigest,generation,intentDigest,intentReview,imageReview':'schemaVersion,jobId,stage,role,status,selectionDigest,configurationSha256,publicationDigest,imageReview');
   if(setup){
    if(review.generation!==generation||review.intentDigest!==intentDigest)fail('ct_job_staged_review_generation_mismatch');
    if(selectedStage.startsWith('prepare-')){keys(review.intentReview,'inspected,generation,intentDigest');if(review.intentReview.inspected!==true||review.intentReview.generation!==generation||review.intentReview.intentDigest!==intentDigest)fail('ct_job_actual_intent_review_required');}
    else if(review.intentReview!==null)fail('ct_job_unexpected_intent_review');
   }
   if(review.schemaVersion!==(setup?'ct52-staged-review/3':'ct52-staged-review/2')||review.jobId!==selection.jobId||review.stage!==selectedStage||review.role!==ref.role||review.status!=='PASS'||review.selectionDigest!==selectionDigest||review.configurationSha256!==selection.configurationSha256||review.publicationDigest!==publicationDigest)fail('ct_job_staged_review_mismatch');
   if(selectedStage.startsWith('frame-')){
    const image=review.imageReview;
    keys(image,'inspected,reviewerKind,screenshotSha256,frameNumber,sceneProfileDigest');
    if(image.inspected!==true||!['AGENT','HUMAN'].includes(image.reviewerKind)||!hash(image.screenshotSha256)||!Number.isSafeInteger(image.frameNumber)||!hash(image.sceneProfileDigest))fail('ct_job_actual_image_review_required');
   }else if(review.imageReview!==null)fail('ct_job_premature_image_review');
  }
  await ports.consumeDispatch(selectedStage,digest(value),setup&&Array.isArray(stage)?alternatives:undefined);current();return value;
 };
 const browserMode=nonexpiring||selection.schemaVersion==='canonical-dedicated-ct-job/2';
 if(browserMode&&selection.enabled){try{browserOwner=app.registerDedicatedCtBrowserOwner(configuration,selection.metadataDirectory,input.evidenceOwner,nonexpiring?{current,preparation:'untilCancelled',lifecycle}:{current,expiresAt:end});}catch(error){clearTimeout(deadlineTimer);abort.abort();lifecycle?.signal.removeEventListener('abort',cancelled);void lifecycle?.stop('operation_failed');throw error;}}
 const scopeSummary=()=>({scopeDigest:setup&&baselineIntent?baselineIntent.scopeDigest:digest(owner.scope)});
 const approvalSummary=value=>{
  if(!uuid(value?.requestId)||!Number.isSafeInteger(value.revision)||value.revision<1||!hash(value.confirmationDigest)||!Number.isFinite(Date.parse(value.expiresAt)))fail('ct_job_review_metadata_required');
  if(value.grantExpiresAt!==undefined&&typeof value.grantExpiresAt!=='string'||value.grantExpiresAt!==undefined&&!Number.isFinite(Date.parse(value.grantExpiresAt))||value.requestedClass!==undefined&&value.requestedClass!=='allowSession'||value.reviewAfter!==undefined&&value.reviewAfter!==null&&(typeof value.reviewAfter!=='string'||!Number.isFinite(Date.parse(value.reviewAfter))))fail('ct_job_review_metadata_required');
  return {requestId:value.requestId,revision:value.revision,confirmationDigest:value.confirmationDigest,expiresAt:value.expiresAt,...(value.grantExpiresAt!==undefined?{grantExpiresAt:value.grantExpiresAt}:{}),...(value.requestedClass!==undefined?{requestedClass:value.requestedClass}:{}),...(value.reviewAfter!==undefined?{reviewAfter:value.reviewAfter}:{})};
 };
 const frameSummary=value=>summarizeDedicatedCtFrame(configuration,selection.configurationSha256,value);
 const captureIntent=value=>{
  const general=configuration.goalMode==='observedGameplay',maximumGrantMs=general?configuration.maximumControllerGrantMs:120000,maximumNativeLifetimeMs=general?configuration.nativePreparation?.maximumNativeLifetimeMs:120000;
  if(!Number.isSafeInteger(maximumGrantMs)||maximumGrantMs<1||maximumGrantMs>300000||!Number.isSafeInteger(maximumNativeLifetimeMs)||maximumNativeLifetimeMs<1||maximumNativeLifetimeMs>300000)fail('ct_job_preparation_intent_invalid');
  keys(value,'schemaVersion,scopeDigest,controller,native');keys(value.controller,'termsDigest,operationDigest,grantClass,maximumGrantMs');keys(value.native,'scopeDigest,pinsDigest,templateDigest,purpose,maximumNativeLifetimeMs,requiresActualApproval');
  if(value.schemaVersion!=='ct-unused-preparation-intent/1'||!hash(value.scopeDigest)||!hash(value.controller.termsDigest)||!hash(value.controller.operationDigest)||value.controller.grantClass!=='allowSession'||value.controller.maximumGrantMs!==maximumGrantMs||!hash(value.native.scopeDigest)||!hash(value.native.pinsDigest)||!hash(value.native.templateDigest)||value.native.purpose!=='gameplay'||value.native.maximumNativeLifetimeMs!==maximumNativeLifetimeMs||value.native.requiresActualApproval!==true)fail('ct_job_preparation_intent_invalid');
  return freeze(copy(value));
 };
 const originalPreparationMethod=name=>{
  const method=Object.getOwnPropertyDescriptor(owner,name)?.value;
  if(typeof method!=='function'||preparationMethods&&preparationMethods[name]!==method)fail('ct_job_preparation_owner_changed');return method;
 };
 const reviewIntent=async()=>{
  const method=originalPreparationMethod('reviewPreparationIntent');
  const intent=captureIntent(await bounded(()=>method.call(owner)));
  originalPreparationMethod('reviewPreparationIntent');originalPreparationMethod('preparePreparationRequests');
  if(baselineIntent&&!isDeepStrictEqual(intent,baselineIntent))fail('ct_job_preparation_intent_changed');
  if(!baselineIntent){baselineIntent=intent;intentDigest=digest(intent);}
  // Main's fixed owner wrapper uses this same JSON serialization for the digest.
  if(digest(intent)!==intentDigest)fail('ct_job_preparation_intent_changed');return intent;
 };
 const expired=(permission,native)=>[permission.expiresAt,permission.grantExpiresAt,native.expiresAt].some(value=>!Number.isFinite(Date.parse(value))||Date.parse(value)<=ports.now());
 const preapprovalExpired=Object.freeze({expired:true});
 const startOwner=async(start,permission,native)=>{
  keys(start.payload,'authorityBody,nativeBody,consent');const nativeBody=start.payload.nativeBody;
  keys(nativeBody,'requestId,expectedRevision,confirmationDigest,launchOwnedNative,memoryOnlyPairing');
  if(nativeBody.requestId!==native.requestId||nativeBody.expectedRevision!==native.revision||nativeBody.confirmationDigest!==native.confirmationDigest||nativeBody.launchOwnedNative!==true||nativeBody.memoryOnlyPairing!==true)fail('ct_job_native_confirmation_mismatch');
  const consent=start.payload.consent;keys(consent,'observations,campaignJournal,controllerInput,sharedInference');if(Object.values(consent).some(value=>value!==true))fail('ct_job_explicit_start_consent_required');
  if(setup)await reviewIntent();
  // Check inside the original operation callback, immediately before any POST.
  const result=await bounded(()=>setup&&expired(permission,native)?preapprovalExpired:owner.authority('POST',`/api/authority/v1/requests/${permission.requestId}/approve`,start.payload.authorityBody));
  if(result===preapprovalExpired)return false;
  if(!result||result.status<200||result.status>=300)fail('ct_job_canonical_authority_denied');
  // After authority begins, failures remain terminal; never return to intent.
  await bounded(()=>{if(setup&&expired(permission,native))fail('ct_job_review_metadata_expired');return owner.approveNative(nativeBody);},'native_prepare');
  await bounded(()=>owner.start(consent),'native_start');return true;
 };
 const renewablePreparation=async()=>{
  while(true){
   if(generation===Number.MAX_SAFE_INTEGER)fail('ct_job_generation_exhausted');generation=generation===null?1:generation+1;
   const intent=await reviewIntent();
   const publication=await safePublish(`preparation-intent-${generation}`,{state:'AWAITING_PREPARATION_INTENT_REVIEW',...scopeSummary(),bounds:configuration.campaign.bounds,intent});
   const prepare=await dispatch(`prepare-${generation}`,publication.sha256);keys(prepare.payload,'prepareRequests');if(prepare.payload.prepareRequests!==true)fail('ct_job_prepare_instruction_required');
   const method=originalPreparationMethod('preparePreparationRequests');
   const pair=await bounded(()=>method.call(owner,intentDigest),'native_prepare');originalPreparationMethod('reviewPreparationIntent');originalPreparationMethod('preparePreparationRequests');keys(pair,'intent,permission,native');
   const checked=captureIntent(pair.intent);if(!isDeepStrictEqual(checked,baselineIntent)||digest(checked)!==intentDigest)fail('ct_job_preparation_intent_changed');
   const permission=approvalSummary(pair.permission),native=approvalSummary(pair.native);
   if(permission.requestedClass!=='allowSession'||!Number.isFinite(Date.parse(permission.grantExpiresAt)))fail('ct_job_review_metadata_required');
   const pending=await safePublish(`staged-owner-${generation}`,{state:'OWNER_PREPARED_NOT_STARTED',...scopeSummary(),permission,native,bounds:configuration.campaign.bounds});
   const next=await dispatch([`start-${generation}`,`renew-${generation}`],pending.sha256);
   if(next.stage===`renew-${generation}`){keys(next.payload,'returnToPreparation');if(next.payload.returnToPreparation!==true)fail('ct_job_renew_instruction_required');continue;}
   if(await startOwner(next,pair.permission,pair.native))return;
   // Expired pre-approval metadata stays historical. No timer/POST/registration retry.
  }
 };
 const completion=(async()=>{
  if(!selection.enabled)return {status:'DISABLED',selectionDigest};
  try{
   // No owner/store/native constructor runs merely because Daily starts.
   const ready=await safePublish('registered',{state:'WAITING_FOR_SOLE_WORKER',authenticationEstablished:false,nativeStarted:false});
   const initial=await dispatch('owner',ready.sha256);keys(initial.payload,'prepareOwner');if(initial.payload.prepareOwner!==true)fail('ct_job_owner_instruction_required');
   await ports.claim();claimed=true;current();
   if(browserMode){browserOwner.arm();owner=await (nonexpiring?wait(()=>browserOwner.owner()):bounded(()=>browserOwner.owner()));}
   else owner=app.openDedicatedCtHostSession(selection.sessionId,configuration,selection.metadataDirectory,input.evidenceOwner);current();
   const descriptor=Object.getOwnPropertyDescriptor(owner,'observeStatus');
   if(descriptor){if(!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function')fail('ct_job_status_observation_invalid');statusObservation=descriptor.value;}
   if(setup){preparationMethods=Object.freeze(Object.fromEntries(['reviewPreparationIntent','preparePreparationRequests'].map(name=>[name,originalPreparationMethod(name)])));await renewablePreparation();}else{
    const permission=await bounded(()=>owner.reviewPermission()),native=await bounded(()=>owner.reviewNative(),'native_prepare');
    if(!uuid(permission?.requestId)||!uuid(native?.requestId))fail('ct_job_review_metadata_required');
    const pending=await safePublish('staged-owner',{state:'OWNER_PREPARED_NOT_STARTED',...(browserMode?{...scopeSummary(),permission:approvalSummary(permission),native:approvalSummary(native),bounds:configuration.campaign.bounds}:{scope:owner.scope,permission,native})});
    const start=await dispatch('start',pending.sha256);await startOwner(start,permission,native);
   }
   await safePublish('started',{state:'OWNED_NATIVE_START_REQUESTED',modelActionProven:false});
   while(true){
    let status;
    if(statusObservation){
     if(Object.getOwnPropertyDescriptor(owner,'observeStatus')?.value!==statusObservation)fail('ct_job_status_observation_invalid');
     // Synchronous original-owner observation has no completion/await gap. Only
     // confirmed cleanup can be read after execution retires; active work keeps
     // all existing lifecycle checks below and at every effect boundary.
     const value=statusObservation.call(owner);
     if(Object.getOwnPropertyDescriptor(owner,'observeStatus')?.value!==statusObservation)fail('ct_job_status_observation_invalid');
     if(!value||typeof value!=='object'||!Object.isFrozen(value)||Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!Object.hasOwn(d,'value')))fail('ct_job_status_observation_invalid');
     if(value.kind==='completed'){
      keys(value,'kind,state');if(value.state!=='stopped')fail('ct_job_status_observation_invalid');
      const now=ports.now(),reason=envelopeFailure(now);if(reason){reportCurrent(reason);fail('ct_job_expired_or_closed');}lastWall=now;
      status=value;
     }else{
      keys(value,'kind,state,frameQualification');if(value.kind!=='active'||typeof value.state!=='string'||typeof value.frameQualification!=='string')fail('ct_job_status_observation_invalid');
      current();if(['stopped','failed'].includes(value.state))fail('ct_job_expired_or_closed');status=value;
     }
    }else{current();status=await bounded(()=>owner.status());}
    if(['stopped','failed'].includes(status.state)){
     return await safePublish('terminal',{state:status.state,...(browserMode?scopeSummary():{scope:owner.scope}),modelActionProven:false,evidenceMeaning:'Actual request, decision, action and PNG receipts must establish model acceptance separately.'});
    }
    if(status.frameQualification==='waitingForHuman'){
     if(++frameSequence>(configuration.goalMode==='observedGameplay'?32:9))fail('ct_job_frame_review_budget_exceeded');
     const review=await bounded(()=>owner.reviewFrame());
     const name=`frame-${String(frameSequence).padStart(2,'0')}`;
     const publication=await safePublish(name,{state:'AWAITING_ACTUAL_IMAGE_REVIEW',review:browserMode?frameSummary(review):review});
     const gate=await dispatch(name,publication.sha256);keys(gate.payload,'frameBody,screenshotSha256,frameNumber,sceneProfileDigest');
     if(!hash(gate.payload.screenshotSha256)||!Number.isSafeInteger(gate.payload.frameNumber)||!hash(gate.payload.sceneProfileDigest))fail('ct_job_actual_frame_identity_required');
     // Actual challenge/body matching and screenshot freshness remain the
     // original frame owner's responsibility; never replace it with this file.
     validateDedicatedCtFrameIdentity(configuration,selection.configurationSha256,review,gate.payload);
     for(const ref of gate.reviewReferences){const checked=await wait(()=>ports.readReview(ref.name,ref.sha256));if(checked.imageReview.screenshotSha256!==gate.payload.screenshotSha256||checked.imageReview.frameNumber!==gate.payload.frameNumber||checked.imageReview.sceneProfileDigest!==gate.payload.sceneProfileDigest)fail('ct_job_image_review_identity_mismatch');}
     current();await bounded(()=>owner.approveFrame(gate.payload.frameBody));
    }else await ports.sleep(100,abort.signal);
   }
  }catch(error){
   // Only closed error codes. No error message, profile/auth/history body,
   // generic exception serialization or provider request body is exported.
   return await safePublish('failure',{state:'FAILED_CLOSED',code:codeOf(error),ownerClaimConsumed:claimed});
  }finally{await close();}
 })();
 return Object.freeze({completion,close,selectionDigest});
}

const same=(a,b)=>['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'].every(key=>a[key]===b[key]);
async function ownedDirectory(path){
 assert.equal(await realpath(path),path);const value=await lstat(path);
 assert(value.isDirectory()&&!value.isSymbolicLink()&&value.uid===process.getuid()&&value.gid===process.getgid()&&(value.mode&0o777)===0o700,'private original-owner job directory required');return value;
}
async function readOwned(path,max=262144){
 await ownedDirectory(dirname(path));const before=await lstat(path);
 assert(before.isFile()&&!before.isSymbolicLink()&&before.uid===process.getuid()&&before.gid===process.getgid()&&before.nlink===1&&[0o400,0o600].includes(before.mode&0o777)&&before.size<=max);
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{assert(same(before,await file.stat()));const raw=await file.readFile();assert(raw.length===before.size&&same(before,await file.stat())&&same(before,await lstat(path)));return raw;}finally{await file.close();}
}
async function writeOwned(path,value){
 await ownedDirectory(dirname(path));const raw=Buffer.from(json(value)+'\n');assert(raw.length<=262144);
 const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);
 try{await file.writeFile(raw);await file.sync();}finally{await file.close();}
 const directory=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}
 return {path,sha256:sha(raw),bytes:raw.length};
}
function dispatchStages(stage,setup){
 const stages=Array.isArray(stage)?stage:[stage];
 if(Array.isArray(stage)){
  assert(setup&&stages.length===2&&/^start-[1-9][0-9]*$/.test(stages[0]));const n=Number(stages[0].slice(6));assert(Number.isSafeInteger(n)&&n>0&&stages[1]===`renew-${n}`);
 }else assert(typeof stage==='string'&&(setup?/^(?:owner|(?:prepare|start|renew)-[1-9][0-9]*|frame-(?:0[1-9]|[12][0-9]|3[0-2]))$/:/^(?:owner|start|frame-(?:0[1-9]|[12][0-9]|3[0-2]))$/).test(stage));
 for(const name of stages){const match=/^(?:prepare|start|renew)-([0-9]+)$/.exec(name);if(match)assert(Number.isSafeInteger(Number(match[1]))&&Number(match[1])>0);}
 return stages;
}
// Pure selection logic used by the fixed filesystem port and deterministic tests.
export async function readDedicatedCtDispatchChoice(stage,read,setup=false){
 const stages=dispatchStages(stage,setup),found=[];
 const available=async name=>{try{return await read(name);}catch(error){if(error?.code==='ENOENT')return null;throw error;}};
 for(const name of stages){const raw=await available(name);if(raw!==null)found.push({stage:name,raw});}
 if(found.length>1)fail('ct_job_conflicting_dispatches');
 if(found.length&&stages.length===2){const other=stages.find(name=>name!==found[0].stage);if(await available(other)!==null)fail('ct_job_conflicting_dispatches');}
 return found[0]??null;
}
export async function registerDedicatedCtJob(app,input){
 const selection=validateDedicatedCtSelection(input.selection,input.configuration,input.configurationBytes);
 if(!selection.enabled)return Object.freeze({completion:Promise.resolve({status:'DISABLED'}),close:async()=>{}});
 const lifecycle=lifecycleFor(selection,input); // Refuse a missing/fake bridge before any filesystem claim.
 const root=selection.jobRoot,identity=await ownedDirectory(root),setup=selection.schemaVersion==='canonical-dedicated-ct-job/4';
 const currentRoot=async()=>{const now=await ownedDirectory(root);assert(identity.dev===now.dev&&identity.ino===now.ino,'job root replaced');};
 // One registration on one process start. Repeated normal restart must never
 // reopen a previous owner or resume uncertain native effects.
 const registration=join(root,'REGISTRATION-CLAIM.json');
 try{await writeOwned(registration,{schemaVersion:'ct52-one-use-registration/1',jobId:selection.jobId,nonce:selection.nonce,selectionDigest:digest(selection)});await currentRoot();}
 catch(error){
  if(error?.code!=='EEXIST')throw error;
  const previous=JSON.parse((await readOwned(registration)).toString('utf8'));await currentRoot();
  if(previous.schemaVersion!=='ct52-one-use-registration/1'||previous.jobId!==selection.jobId||previous.nonce!==selection.nonce||previous.selectionDigest!==digest(selection))fail('ct_job_registration_claim_mismatch');
  return Object.freeze({completion:Promise.resolve({status:'CONSUMED_NO_RETRY'}),close:async()=>{}});
 }
 const sleep=(ms,signal)=>new Promise((resolve,reject)=>{if(signal.aborted)return reject(Object.assign(Error(),{code:'ct_job_expired_or_closed'}));const done=()=>{signal.removeEventListener('abort',stop);resolve();},timer=setTimeout(done,ms),stop=()=>{clearTimeout(timer);reject(Object.assign(Error(),{code:'ct_job_expired_or_closed'}));};signal.addEventListener('abort',stop,{once:true});});
 const ports={now:Date.now,sleep,
  publish:async(name,value)=>{await currentRoot();assert(/^[a-z0-9-]+$/.test(name));const result=await writeOwned(join(root,`published-${name}.json`),value);await currentRoot();return result;},
  claim:async()=>{await currentRoot();const result=await writeOwned(join(root,'OWNER-CLAIM.json'),{schemaVersion:'ct52-one-use-owner-claim/1',jobId:selection.jobId,nonce:selection.nonce});await currentRoot();return result;},
  consumeDispatch:async(stage,expectedDigest,alternatives)=>{await currentRoot();const recheck=async()=>{if(alternatives){const choice=await readDedicatedCtDispatchChoice(alternatives,name=>readOwned(join(root,`dispatch-${name}.json`)),setup);if(!choice||choice.stage!==stage||digest(JSON.parse(choice.raw.toString('utf8')))!==expectedDigest)fail('ct_job_dispatch_changed');}};await recheck();const result=await writeOwned(join(root,`CONSUMED-${stage}.json`),{schemaVersion:'ct52-one-use-dispatch-claim/1',jobId:selection.jobId,stage,dispatchDigest:expectedDigest});await currentRoot();await recheck();return result;},
  readReview:async(name,expected)=>{await currentRoot();const raw=await readOwned(join(root,name));await currentRoot();assert.equal(sha(raw),expected);return JSON.parse(raw.toString('utf8'));},
  waitDispatch:async(stage,signal,end)=>{dispatchStages(stage,setup);while((end===null||Date.now()<end)&&!signal.aborted){await currentRoot();const choice=await readDedicatedCtDispatchChoice(stage,name=>readOwned(join(root,`dispatch-${name}.json`)),setup);await currentRoot();if(choice){const value=JSON.parse(choice.raw.toString('utf8'));if(value.stage!==choice.stage)fail('ct_job_dispatch_mismatch');return value;}await sleep(100,signal);}fail('ct_job_dispatch_deadline');}
 };
 return createDedicatedCtJobCore(app,{...input,lifecycle},ports);
}
