// Pure full owner/prepare/start/frame workflow fixtures; no live app, native, or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import * as launcher from '../dedicated-ct-job.mjs';
const {createDedicatedCtJobCore,readDedicatedCtDispatchChoice,generalFrameSafetyProfile,requiredDedicatedCtReviewCount,summarizeDedicatedCtFrame,validateDedicatedCtFrameIdentity}=launcher;
import {createSelectedCtJobLifecycle} from '../ct-job-lifecycle-owner.mjs';
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex'),copy=value=>structuredClone(value),flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
const execution={maximumGameplayMs:80000,operationLimits:{owner_prepare:30000,native_prepare:30000,native_start:30000,model:3000,controller:500,settle:5000},cleanupTimeoutMs:10000};
function fixture(options={}){
 let wall=Date.now(),mono=0,current=true,waiter=null,closing=0,materializations=0,frameApproved=0,terminalUnused=false,requestPairs=[];const calls=[],publications=new Map(),reviews=new Map(),consumed=new Set(),timers=new Map();
 const intent={schemaVersion:'ct-unused-preparation-intent/1',scopeDigest:sha('native canonical scope'),controller:{termsDigest:sha('exact80s policy terms'),operationDigest:sha('operation'),grantClass:'allowSession',maximumGrantMs:options.intentGrant??options.maximumGrant??120000},native:{scopeDigest:sha('native canonical scope'),pinsDigest:sha('native pins'),templateDigest:sha('reviewed template'),purpose:'gameplay',maximumNativeLifetimeMs:options.intentLifetime??options.maximumLifetime??120000,requiresActualApproval:true}};
 const configuration={sessionProfile:'supervised8',inferenceMode:'supervisedForeground',maximumRunMs:90000,campaign:{bounds:{actionBudget:8,modelCallBudget:8}},...(options.general?{goalMode:'observedGameplay',initialDialogue:'',gameFrameVision:{kind:'synthetic-test'},maximumControllerGrantMs:options.maximumGrant??120000,nativePreparation:{maximumNativeLifetimeMs:options.maximumLifetime??120000}}:{})},configurationBytes=Buffer.from(JSON.stringify(configuration)),jobId=randomUUID();
 const selection={schemaVersion:'canonical-dedicated-ct-job/4',enabled:true,jobId,nonce:'a'.repeat(32),ownerBinding:'originalBrowserRequest',jobRoot:`/srv/lifestream/workspace/runtime-state/ct-owner-job-${jobId}`,metadataDirectory:`/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-${jobId}`,configurationSha256:sha(configurationBytes.toString()),preparation:{mode:'untilCancelled'},execution:copy(execution)};
 const lifecycle=createSelectedCtJobLifecycle(selection.execution,{isCurrent:()=>current,canExecute:()=>true,isQuiescent:()=>true,onStop:()=>true,clock:{now:()=>mono,setTimeout:(fn,ms)=>{const id={};timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)}});
 const advance=ms=>{wall+=ms;mono+=ms;};
 const owner={scope:{runId:jobId,sessionId:'TEST-secret-owner-selector'},reviewPermission:()=>assert.fail('/4 cannot use separate legacy review'),reviewNative:()=>assert.fail('/4 cannot use separate legacy native review'),
  reviewPreparationIntent(){calls.push('intent');if(terminalUnused)throw Object.assign(Error('synthetic terminal state'),{code:'ct_unused_state_denied'});if(options.expireOnPreStartIntent&&materializations&&consumed.has('start-1'))advance(120001);return copy(intent);},
  preparePreparationRequests(expected){calls.push('prepare');assert.equal(expected,sha(intent));if(terminalUnused)throw Object.assign(Error('synthetic terminal state'),{code:'ct_unused_state_denied'});materializations++;const previous=requestPairs.at(-1);if(previous&&Date.parse(previous.permission.expiresAt)>wall&&Date.parse(previous.native.expiresAt)>wall){requestPairs.push(previous);return copy(previous);}const permission={requestId:randomUUID(),revision:1,confirmationDigest:sha('permission-'+materializations),expiresAt:new Date(wall+120000).toISOString(),grantExpiresAt:new Date(wall+120000).toISOString(),requestedClass:'allowSession',reviewAfter:null},native={requestId:randomUUID(),revision:1,confirmationDigest:sha('native-'+materializations),expiresAt:new Date(wall+120000).toISOString()};const pair={intent:copy(intent),permission,native};requestPairs.push(pair);return copy(pair);},
  authority:async(...args)=>{calls.push(['authority',...args]);if(options.expireAfterAuthority)advance(120001);return {status:options.authorityDenied?403:200};},
  approveNative:body=>{calls.push(['approve-native',body]);if(options.nativeApprovalFails)throw Error('synthetic native refused');},start:consent=>{calls.push(['start',consent]);},
  status:()=>({state:options.frame&&frameApproved<(options.frames??1)?'running':'stopped',frameQualification:'waitingForHuman'}),reviewFrame:()=>({requestId:randomUUID(),confirmationDigest:sha('frame challenge'),pngSha256:sha('synthetic PNG'),frameNumber:123,...(options.general?{}:{sceneProfile:{manifestDigest:sha('synthetic scene')}})}),approveFrame:body=>{calls.push(['approve-frame',body]);frameApproved++;},close:()=>{closing++;calls.push('close');}
 };
 if(options.observeStatus)owner.observeStatus=()=>{const value=owner.status();return Object.freeze(value.state==='stopped'?{kind:'completed',state:'stopped'}:{kind:'active',...value});};
 const app={registerDedicatedCtBrowserOwner:()=>({arm(){calls.push('arm');},owner:async()=>owner,close:()=>owner.close()}),openDedicatedCtHostSession:()=>assert.fail('No session selector lookup')};
 const ports={now:()=>wall,publish:async(name,value)=>{const row={path:name,sha256:sha(JSON.stringify(value)+'\n'),value:copy(value)};publications.set(name,row);return {path:name,sha256:row.sha256};},claim:async()=>{calls.push('claim');},consumeDispatch:async stage=>{assert(!consumed.has(stage));consumed.add(stage);},readReview:async(name,pin)=>{const value=reviews.get(name);assert.equal(sha(value),pin);return copy(value);},sleep:async()=>{},waitDispatch:async(stage,signal,end)=>{assert.equal(end,null);assert.equal(waiter,null,'Exactly one worker waiter');return await new Promise((resolve,reject)=>{const abort=()=>{waiter=null;reject(Object.assign(Error('cancelled'),{code:'ct_job_cancelled_or_closed'}));};signal.addEventListener('abort',abort,{once:true});waiter={stage,resolve:v=>{signal.removeEventListener('abort',abort);waiter=null;resolve(v);}};});}};
 const core=createDedicatedCtJobCore(app,{selection,configuration,configurationBytes,evidenceOwner:{},lifecycle},ports);
 async function waiting(stage){for(let i=0;i<30;i++){if(waiter&&(Array.isArray(waiter.stage)?waiter.stage.includes(stage):waiter.stage===stage))return;await flush();}assert.fail('Missing expected waiter '+stage+'; failure='+(publications.get('failure')?.value.code??'none'));}
 async function deliver(stage,{mutateDispatch,mutateReview,payload}={}){
  await waiting(stage);const name=stage==='owner'?'registered':stage.startsWith('prepare-')?'preparation-intent-'+stage.slice(8):/^(start|renew)-/.test(stage)?'staged-owner-'+stage.split('-')[1]:stage;const pub=publications.get(name);assert(pub,name);
  const image=stage.startsWith('frame-')?{inspected:true,reviewerKind:'AGENT',screenshotSha256:sha('synthetic PNG'),frameNumber:123,sceneProfileDigest:pub.value.review.frameProfile?.manifestDigest??sha('synthetic scene')}:null;
  const refs=(options.general&&stage.startsWith('frame-')?['main']:['main','independent']).map(role=>{const review={schemaVersion:'ct52-staged-review/3',jobId,stage,role,status:'PASS',selectionDigest:pub.value.selectionDigest,configurationSha256:selection.configurationSha256,publicationDigest:pub.sha256,generation:pub.value.generation,intentDigest:pub.value.intentDigest,intentReview:stage.startsWith('prepare-')?{inspected:true,generation:pub.value.generation,intentDigest:pub.value.intentDigest}:null,imageReview:copy(image)};mutateReview?.(review,role);const name=`review-${stage}-${role}.json`;reviews.set(name,review);return {name,sha256:sha(review),role};});
  const pair=requestPairs.at(-1),defaultPayload=stage==='owner'?{prepareOwner:true}:stage.startsWith('prepare-')?{prepareRequests:true}:stage.startsWith('renew-')?{returnToPreparation:true}:stage.startsWith('start-')?{authorityBody:{requestId:pair.permission.requestId,expectedRevision:1},nativeBody:{requestId:pair.native.requestId,expectedRevision:1,confirmationDigest:pair.native.confirmationDigest,launchOwnedNative:true,memoryOnlyPairing:true},consent:{observations:true,campaignJournal:true,controllerInput:true,sharedInference:true}}:{frameBody:{ordinaryGameplay:true},screenshotSha256:sha('synthetic PNG'),frameNumber:123,sceneProfileDigest:pub.value.review.frameProfile?.manifestDigest??sha('synthetic scene')};
  const value={schemaVersion:'ct52-worker-dispatch/3',jobId,nonce:selection.nonce,stage,selectionDigest:pub.value.selectionDigest,configurationSha256:selection.configurationSha256,publicationDigest:pub.sha256,preparation:{mode:'untilCancelled'},generation:pub.value.generation,intentDigest:pub.value.intentDigest,reviewReferences:refs,payload:payload??defaultPayload};mutateDispatch?.(value);waiter.resolve(value);await flush();
 }
 return {core,selection,configuration,configurationBytes,lifecycle,calls,publications,consumed,requestPairs,intent,owner,timers,advance,waiting,deliver,materializations:()=>materializations,closed:()=>closing,deny:()=>terminalUnused=true,revoke:()=>current=false};
}
const bind=async f=>{await f.deliver('owner');await f.waiting('prepare-1');};
const prepare=async(f,n=1)=>{await f.deliver('prepare-'+n);await f.waiting('start-'+n);};
const general={goalMode:'observedGameplay',initialDialogue:'',gameFrameVision:{kind:'synthetic-test'}},configurationPin=sha('synthetic configuration');
test('general helpers bind safety-only profile to configuration and preserve exact image identity',()=>{
 const profile=generalFrameSafetyProfile(general,configurationPin);
 assert.deepEqual(profile,{schemaVersion:'ct-general-frame-review/1',kind:'ordinaryGameplaySafetyOnly',configurationSha256:configurationPin,manifestDigest:sha({schemaVersion:'ct-general-frame-review/1',kind:'ordinaryGameplaySafetyOnly',configurationSha256:configurationPin})});
 assert(Object.isFrozen(profile));
 const review={requestId:randomUUID(),confirmationDigest:sha('challenge'),pngSha256:sha('image'),frameNumber:42,expiresAt:'2099-01-01T00:00:00Z',pngBase64:'synthetic-not-image'};
 const summary=summarizeDedicatedCtFrame(general,configurationPin,review);assert.deepEqual(summary,{...review,frameProfile:profile});assert.equal(Object.hasOwn(summary,'sceneProfile'),false);
 const payload={screenshotSha256:review.pngSha256,frameNumber:42,sceneProfileDigest:profile.manifestDigest};assert.equal(validateDedicatedCtFrameIdentity(general,configurationPin,review,payload),true);
 for(const changed of [{screenshotSha256:sha('different')},{frameNumber:43},{sceneProfileDigest:sha('scene substitution')}])assert.throws(()=>validateDedicatedCtFrameIdentity(general,configurationPin,review,{...payload,...changed}));
 assert.throws(()=>summarizeDedicatedCtFrame(general,configurationPin,{...review,sceneProfile:{manifestDigest:sha('scene')}}));
 assert.throws(()=>summarizeDedicatedCtFrame(general,configurationPin,{...review,frameProfile:{...profile,configurationSha256:sha('other')}}));
 for(const changed of [{goalMode:'movementOnly'},{initialDialogue:'answer leakage'},{gameFrameVision:null},{gameFrameVision:[]},{reviewedSceneProfile:{}}])assert.throws(()=>generalFrameSafetyProfile({...general,...changed},configurationPin));
});
test('single frame reviewer applies only to general frames 01..32; owner, preparation, start and legacy retain two',()=>{
 for(const frame of ['01','09','10','19','20','31','32']){assert.equal(requiredDedicatedCtReviewCount(general,'frame-'+frame),1);assert.equal(requiredDedicatedCtReviewCount({},'frame-'+frame),2);}
 for(const stage of ['owner','prepare-1','start-1','renew-1','frame-00','frame-33','frame-001'])assert.equal(requiredDedicatedCtReviewCount(general,stage),2);
});
test('fixed dispatch reader accepts stages through32 and refuses beyond32 before any read',async()=>{
 for(const stage of ['frame-01','frame-09','frame-10','frame-32'])assert.equal((await readDedicatedCtDispatchChoice(stage,async()=>Buffer.from('{}'),true)).stage,stage);
 for(const stage of ['frame-00','frame-33','frame-99','frame-001'])await assert.rejects(readDedicatedCtDispatchChoice(stage,()=>assert.fail('Invalid stage must not read'),true));
});
for(const [maximumGrant,maximumLifetime] of [[1,1],[120000,120000],[300000,300000],[240000,180000]])test('full general preparation preserves exact configured limits '+maximumGrant+'/'+maximumLifetime,async()=>{
 const f=fixture({general:true,frame:true,maximumGrant,maximumLifetime});await bind(f);assert.equal(f.publications.get('preparation-intent-1').value.intent.controller.maximumGrantMs,maximumGrant);assert.equal(f.publications.get('preparation-intent-1').value.intent.native.maximumNativeLifetimeMs,maximumLifetime);
 await prepare(f);await f.deliver('start-1');await f.deliver('frame-01');await f.core.completion;
 assert(f.publications.has('terminal'));assert(!f.publications.has('failure'));assert.deepEqual([...f.consumed],['owner','prepare-1','start-1','frame-01']);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='start').length,1);
 assert.equal(Object.hasOwn(f.publications.get('frame-01').value.review,'sceneProfile'),false);
});
for(const options of [{maximumGrant:0},{maximumGrant:300001},{maximumLifetime:0},{maximumLifetime:300001},{maximumGrant:240000,intentGrant:120000},{maximumLifetime:180000,intentLifetime:120000}])test('invalid or mismatched exact preparation limits fail before preparation '+JSON.stringify(options),async()=>{
 const f=fixture({general:true,...options});await f.deliver('owner');await f.core.completion;assert.equal(f.publications.get('failure').value.code,'ct_job_preparation_intent_invalid');assert.equal(f.materializations(),0);assert(!f.calls.some(x=>Array.isArray(x)&&x[0]==='start'));
});
for(const [generalMode,frames,budget] of [[true,32,32],[true,33,32],[false,10,9]])test('full frame sequence preserves '+(generalMode?'general32':'legacy9')+' budget for '+frames+' frames',async()=>{
 const f=fixture({general:generalMode,frame:true,frames});await bind(f);await prepare(f);await f.deliver('start-1');
 for(let n=1;n<=Math.min(frames,budget);n++)await f.deliver('frame-'+String(n).padStart(2,'0'));
 await f.core.completion;assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='approve-frame').length,budget);
 if(frames>budget){assert.equal(f.publications.get('failure').value.code,'ct_job_frame_review_budget_exceeded');assert(!f.publications.has('frame-'+String(budget+1).padStart(2,'0')));}else assert(f.publications.has('terminal'));
 assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='start').length,1);
});
for(const kind of ['extraReviewer','wrongImage','wrongFrame','wrongProfile'])test('general frame still refuses invalid review or exact identity '+kind,async()=>{
 const f=fixture({general:true,frame:true});await bind(f);await prepare(f);await f.deliver('start-1');await f.deliver('frame-01',{mutateDispatch:value=>{if(kind==='extraReviewer')value.reviewReferences.push({...value.reviewReferences[0],role:'independent'});if(kind==='wrongImage')value.payload.screenshotSha256=sha('wrong');if(kind==='wrongFrame')value.payload.frameNumber++;if(kind==='wrongProfile')value.payload.sceneProfileDigest=sha('wrong');}});await f.core.completion;assert(f.publications.has('failure'));assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='approve-frame').length,0);
});

test('general full preparation and frame review coexist with the R14 synchronous completion observation',async()=>{
 const f=fixture({general:true,frame:true,maximumGrant:300000,maximumLifetime:300000,observeStatus:true});await bind(f);await prepare(f);await f.deliver('start-1');await f.deliver('frame-01');await f.core.completion;
 assert(f.publications.has('terminal'));assert(!f.publications.has('failure'));assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='start').length,1);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='approve-frame').length,1);
});
for(const stage of ['owner','prepare-1','start-1'])test('general mode still requires both independent reviews at '+stage,async()=>{
 const f=fixture({general:true,frame:true});if(stage!=='owner')await bind(f);if(stage==='start-1')await prepare(f);
 await f.deliver(stage,{mutateDispatch:value=>{value.reviewReferences.pop();}});await f.core.completion;assert.equal(f.publications.get('failure').value.code,'ct_job_independent_reviews_required');assert(!f.calls.some(x=>Array.isArray(x)&&x[0]==='start'));
});
