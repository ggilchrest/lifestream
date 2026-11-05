import {createSelectedCtJobLifecycle,isSelectedCtJobLifecycle} from '../ct-job-lifecycle-owner.mjs';
import {createCtJobLifecycle} from '../ct-job-lifecycle.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createDedicatedCtJobCore,validateDedicatedCtSelection,registerDedicatedCtJob} from '../dedicated-ct-job.mjs';

const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const jobId='c9d9b828-542e-4c3a-8c34-2ed070b3cb6a';
const sessionId='3be38958-982a-47fb-ae0f-4438b6947e65';
const requestId='1d31b29a-930b-48b1-aeda-d5e60beea745';
const nativeId='673405ee-7115-41fe-96a7-d1688931de3f';
const png=sha('synthetic PNG identity'),scene=sha('synthetic reviewed scene');
function fixture(options={}){
 let wall=Date.now(),started=false,approved=false,bridge,acceptBrowser,armed=false;const calls=[],publications=new Map(),reviews=new Map(),consumed=new Set();
 const configuration={sessionProfile:'supervised8',inferenceMode:'supervisedForeground',maximumRunMs:90000,campaign:{bounds:{actionBudget:8,modelCallBudget:8}}};
 const configurationBytes=Buffer.from(JSON.stringify(configuration));
 const selection={schemaVersion:'canonical-dedicated-ct-job/1',enabled:true,jobId,nonce:'a'.repeat(32),sessionId,jobRoot:`/srv/lifestream/workspace/runtime-state/ct-owner-job-${jobId}`,metadataDirectory:`/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-${jobId}`,configurationSha256:sha(configurationBytes.toString()),expiresAt:new Date(wall+90000).toISOString()};
 if(options.browser){selection.schemaVersion='canonical-dedicated-ct-job/2';delete selection.sessionId;selection.ownerBinding='originalBrowserRequest';}
 const input={selection,configuration,configurationBytes,evidenceOwner:{request(){},response(){}}};
 const owner={scope:{runId:jobId,sessionId:'TEST-secret-selector',ownerPermissionRef:'TEST-secret-permission'},
  reviewPermission:()=>{calls.push('permission');return {requestId,revision:1,confirmationDigest:sha('permission'),expiresAt:new Date(wall+80000).toISOString(),grantExpiresAt:new Date(wall+80000).toISOString(),requestedClass:'allowSession',reviewAfter:null,scope:{sessionId:'TEST-secret-selector'}};},
  reviewNative:()=>{calls.push('native-review');return {requestId:nativeId,revision:1,confirmationDigest:sha('native challenge'),expiresAt:new Date(wall+80000).toISOString(),scope:{sessionId:'TEST-secret-selector'}};},
  authority:async(method,url,body)=>{calls.push(['authority',method,url,body]);return {status:options.authorityDenied?403:200};},
  approveNative:body=>{calls.push(['native-approval',body]);},
  start:body=>{calls.push(['start',body]);started=true;},
  status:()=>{calls.push('status');return {state:approved?'stopped':'running',frameQualification:'waitingForHuman'};},
  reviewFrame:()=>{calls.push('frame-review');return {requestId,confirmationDigest:sha('frame challenge'),pngSha256:png,frameNumber:84569,sceneProfile:{manifestDigest:scene}};},
  approveFrame:body=>{calls.push(['frame-approval',body]);approved=true;},
  close:async()=>{calls.push('owner-close');if(options.cleanup)await options.cleanup;}
 };
 const app={registerDedicatedCtBrowserOwner:()=>{if(options.registerDenied)throw Error('TEST-register-refused');calls.push('register');let resolve,reject;const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});void pending.catch(()=>{});let closing;acceptBrowser=()=>resolve(owner);bridge={arm(){armed=true;calls.push('arm');if(!options.deferBrowser)resolve(owner);},owner:()=>pending,close(){if(closing)return closing;reject(Error('TEST-closed'));return closing=owner.close();}};return bridge;},openDedicatedCtHostSession:(...args)=>{calls.push(['open',...args]);if(options.browser)assert.fail('New browser job cannot resolve a session selector');if(options.authDenied)throw Object.assign(Error('NEVER_EXPORT_PRIVATE_AUTH_BODY'),{code:'local_context_locked'});return owner;},shutdown:()=>{throw Error('Daily shutdown must never occur');}};
 const ports={now:()=>wall,
  publish:async(name,value)=>{const row={path:name,sha256:sha(JSON.stringify(value)+'\n')};publications.set(name,{...row,value});return row;},
  sleep:async()=>{wall+=100;if(options.expire)wall+=90000;},
  claim:async()=>{calls.push('claim');if(options.alreadyClaimed)throw Object.assign(Error('private irrelevant'),{code:'eexist'});},
  consumeDispatch:async stage=>{assert(!consumed.has(stage));consumed.add(stage);},
  readReview:async(name,pin)=>{const review=reviews.get(name);assert.equal(sha(review),pin);return structuredClone(review);},
  waitDispatch:async stage=>{
   calls.push(['worker-gate',stage]);
   if(options.denyStage===stage)throw Object.assign(Error('PRIVATE_GATE_ERROR'),{code:'ct_job_dispatch_deadline'});
   const pub=publications.get(stage==='owner'?'registered':stage==='start'?'staged-owner':stage).value;
   const publication=publications.get(stage==='owner'?'registered':stage==='start'?'staged-owner':stage);
   const reviewReferences=['main','independent'].map(role=>{
    const image=stage.startsWith('frame-')?{inspected:true,reviewerKind:options.kindByRole?.[role]??options.reviewerKind??'AGENT',screenshotSha256:png,frameNumber:84569,sceneProfileDigest:scene}:null;
    if(options.fakeAutomatic&&image)image.reviewerKind='AUTOMATIC';
    if(options.wrongHumanImage&&image)image.screenshotSha256=sha('wrong');
    const review={schemaVersion:'ct52-staged-review/2',jobId,stage,role,status:'PASS',selectionDigest:pub.selectionDigest,configurationSha256:selection.configurationSha256,publicationDigest:publication.sha256,imageReview:image};
    options.mutateReview?.(review,role,stage);
    const name=`review-${stage}-${role}.json`;reviews.set(name,review);return {name,sha256:sha(review),role};
   });
   const payload=stage==='owner'?{prepareOwner:true}:stage==='start'?{authorityBody:{expectedRevision:1},nativeBody:{requestId:nativeId,expectedRevision:1,confirmationDigest:sha('native challenge'),launchOwnedNative:true,memoryOnlyPairing:true},consent:{observations:true,campaignJournal:true,controllerInput:true,sharedInference:true}}:{frameBody:{requestId,confirmationDigest:sha('frame challenge'),ordinaryGameplay:true,noProtectedMenus:true},screenshotSha256:png,frameNumber:84569,sceneProfileDigest:scene};
   const result={schemaVersion:'ct52-worker-dispatch/1',jobId,nonce:selection.nonce,stage,selectionDigest:pub.selectionDigest,configurationSha256:selection.configurationSha256,publicationDigest:publication.sha256,expiresAt:selection.expiresAt,reviewReferences,payload};
   options.mutate?.(result,stage);return result;
  }
 };
 return {app,input,ports,calls,publications,owner,started:()=>started,acceptBrowser:()=>acceptBrowser(),armed:()=>armed};
}



const flush=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};
const reviewedPolicy=()=>({maximumGameplayMs:64000,operationLimits:{owner_prepare:1000,native_prepare:1000,native_start:1000,model:3000,controller:500,settle:5000},cleanupTimeoutMs:1000});
function nonexpiring(options={}){
 const f=fixture({browser:true,...options}),policy=options.executionPolicy??reviewedPolicy();let clock=0,current=true,stops=0;
 const timers=new Map();const trusted={isCurrent:()=>current,canExecute:()=>true,isQuiescent:()=>true,onStop:()=>{stops++;return true;},clock:{now:()=>clock,setTimeout:(fn,ms)=>{const id={};timers.set(id,{fn,at:clock+ms});return id;},clearTimeout:id=>timers.delete(id)}};
 if(options.signal)trusted.signal=options.signal;
 const selection=f.input.selection;selection.schemaVersion='canonical-dedicated-ct-job/3';delete selection.expiresAt;selection.preparation={mode:'untilCancelled'};selection.execution=policy;
 f.input.configurationBytes=Buffer.from(JSON.stringify(f.input.configuration));selection.configurationSha256=sha(f.input.configurationBytes.toString());
 const lifecycle=createSelectedCtJobLifecycle(policy,trusted);f.input.lifecycle=lifecycle;
 const legacy=f.ports.waitDispatch;f.ports.waitDispatch=async(...args)=>{const value=await legacy(...args);value.schemaVersion='ct52-worker-dispatch/2';delete value.expiresAt;value.preparation={mode:'untilCancelled'};return options.mutateDispatch?.(value,args[0])??value;};
 return {...f,lifecycle,trusted,timers,advance:ms=>{clock+=ms;},revoke:()=>current=false,stops:()=>stops};
}
test('explicit /3 preparation and execution are closed, nonexpiring and independent of wall idle; no90s default or legacy reinterpretation',()=>{
 const f=nonexpiring(),value=validateDedicatedCtSelection(f.input.selection,f.input.configuration,f.input.configurationBytes,Date.now()+86400000*365);
 assert.equal(f.input.configuration.maximumRunMs,90000);assert.equal(value.execution.maximumGameplayMs,64000);assert.equal(value.preparation.mode,'untilCancelled');assert.equal(Object.hasOwn(value,'expiresAt'),false);assert.equal(Object.hasOwn(value,'sessionId'),false);assert.equal(Object.hasOwn(value,'lifecycle'),false);
 for(const change of [s=>s.expiresAt='2999-01-01T00:00:00Z',s=>delete s.preparation,s=>s.preparation.mode='forever',s=>s.preparation.extra=true,s=>delete s.execution,s=>delete s.execution.maximumGameplayMs,s=>s.execution.maximumGameplayMs=Infinity,s=>s.execution.maximumGameplayMs=90001,s=>delete s.execution.operationLimits.settle,s=>s.execution.operationLimits.model=3001,s=>s.execution.cleanupTimeoutMs=0,s=>s.lifecycle={},s=>s.sessionId=sessionId]){
  const selection=structuredClone(f.input.selection);change(selection);assert.throws(()=>validateDedicatedCtSelection(selection,f.input.configuration,f.input.configurationBytes));
 }
 const smaller=structuredClone(f.input.configuration);smaller.maximumRunMs=40000;const bytes=Buffer.from(JSON.stringify(smaller)),above=structuredClone(f.input.selection);above.configurationSha256=sha(bytes.toString());assert.throws(()=>validateDedicatedCtSelection(above,smaller,bytes),/outer ceiling/);
 const old=fixture({browser:true});old.input.selection.expiresAt='2000-01-01T00:00:00Z';assert.throws(()=>validateDedicatedCtSelection(old.input.selection,old.input.configuration,old.input.configurationBytes));
});
test('only the fixed lifecycle factory brands exact selected watchdogs; raw helpers, fake methods and mutated policies refuse before registration or filesystem claims',async()=>{
 const f=nonexpiring();assert.equal(isSelectedCtJobLifecycle(f.lifecycle,f.input.selection.execution),true);
 const bad=[undefined,{},Object.freeze({signal:new AbortController().signal,check:()=>true}),createCtJobLifecycle({...f.trusted,...reviewedPolicy()})];
 for(const lifecycle of bad){const input={...f.input,lifecycle};assert.throws(()=>createDedicatedCtJobCore(f.app,input,f.ports),/fixed-bootstrap/);await assert.rejects(registerDedicatedCtJob(f.app,input),/fixed-bootstrap/);}
 assert(!f.calls.includes('register'));const changed=structuredClone(f.input.selection.execution);changed.operationLimits.owner_prepare++;assert.equal(isSelectedCtJobLifecycle(f.lifecycle,changed),false);
 assert.throws(()=>createSelectedCtJobLifecycle(reviewedPolicy(),{...f.trusted,maximumGameplayMs:1}),/fixed original lifecycle ports/);
 await f.lifecycle.stop('cancelled');await bad.at(-1).stop('cancelled');
});
test('waiting for either worker or original browser has no whole-task timer even after long idle; cancellation still settles original cleanup once',async()=>{
 for(const stage of ['worker','browser']){
  const f=nonexpiring({deferBrowser:stage==='browser'});if(stage==='worker')f.ports.waitDispatch=()=>new Promise(()=>{});
  const before=process.getActiveResourcesInfo().filter(x=>x==='Timeout').length,core=createDedicatedCtJobCore(f.app,f.input,f.ports);await flush();
  assert.equal(process.getActiveResourcesInfo().filter(x=>x==='Timeout').length,before);assert.equal(f.timers.size,0);f.advance(86400000*365);assert.equal(f.lifecycle.check(),true);assert.equal(f.lifecycle.snapshot().activeGameplayMs,0);
  if(stage==='browser')assert.equal(f.armed(),true);else assert.equal(f.armed(),false);
  const closing=core.close();assert.equal(core.close(),closing);await closing;await core.completion;assert.equal(f.calls.filter(x=>x==='owner-close').length,1);assert.equal(f.stops(),1);assert.equal(f.started(),false);
 }
});
test('the original lifecycle revocation signal cancels a reviewer wait without a dispatch, browser bind or native start',async()=>{
 const controller=new AbortController(),f=nonexpiring({signal:controller.signal});f.ports.waitDispatch=()=>new Promise(()=>{});const core=createDedicatedCtJobCore(f.app,f.input,f.ports);await flush();controller.abort();await core.completion;
 assert(f.publications.has('failure'));assert.equal(f.armed(),false);assert.equal(f.started(),false);assert.equal(f.stops(),1);
});
test('the exact original lifecycle is passed to server lifetime; runner start/attach/frame gates never infer gameplay entry',async()=>{
 const f=nonexpiring(),register=f.app.registerDedicatedCtBrowserOwner,snapshots=[];let lifetime;
 f.app.registerDedicatedCtBrowserOwner=(...args)=>{lifetime=args[3];return register(...args);};
 const start=f.owner.start;f.owner.start=body=>{snapshots.push(f.lifecycle.snapshot());return start(body);};
 await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;assert(f.publications.has('terminal'));assert.equal(lifetime.lifecycle,f.lifecycle);assert.equal(lifetime.preparation,'untilCancelled');assert.equal(Object.hasOwn(lifetime,'expiresAt'),false);assert.equal(typeof lifetime.current,'function');
 assert.equal(snapshots.length,1);assert.equal(snapshots[0].gameplayStarted,false);assert.equal(f.lifecycle.snapshot().gameplayStarted,false);for(const pub of f.publications.values()){assert(!JSON.stringify(pub.value).includes('TEST-secret'));assert.equal(Object.hasOwn(pub.value,'lifecycle'),false);assert.equal(Object.hasOwn(pub.value,'expiresAt'),false);}
});
test('/3 dispatch /2 requires exact nonexpiring mode and original two reviews; expiry or legacy-schema substitution cannot consume a claim',async()=>{
 for(const mutate of [v=>{v.expiresAt='2999-01-01T00:00:00Z';},v=>{v.schemaVersion='ct52-worker-dispatch/1';},v=>{v.preparation.mode='latest';},v=>{delete v.preparation;},v=>{v.reviewReferences.pop();},v=>{v.jobId=sessionId;}]){
  const f=nonexpiring({mutateDispatch:v=>{mutate(v);return v;}});await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;assert(f.publications.has('failure'));assert(!f.calls.includes('claim'));assert.equal(f.armed(),false);
 }
 const legacy=fixture({browser:true}),oldWait=legacy.ports.waitDispatch;legacy.ports.waitDispatch=async(...args)=>{const v=await oldWait(...args);v.schemaVersion='ct52-worker-dispatch/2';delete v.expiresAt;v.preparation={mode:'untilCancelled'};return v;};await createDedicatedCtJobCore(legacy.app,legacy.input,legacy.ports).completion;assert(legacy.publications.has('failure'));assert(!legacy.calls.includes('claim'));
});
test('actual preparation RPC retains its explicit finite watchdog and cannot turn into native/model work after timeout',async()=>{
 const policy=reviewedPolicy();policy.operationLimits.owner_prepare=5;const f=nonexpiring({executionPolicy:policy});f.owner.reviewPermission=()=>new Promise(()=>{});
 await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;assert.equal(f.publications.get('failure').value.code,'ct_job_deadline');assert.equal(f.started(),false);assert.equal(f.stops(),1);
});
test('RPC response after original currentness loss is refused before native approval, start or other effects',async()=>{
 const f=nonexpiring(),read=f.owner.reviewPermission;f.owner.reviewPermission=()=>{const value=read();f.revoke();return value;};await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;
 assert(f.publications.has('failure'));assert.equal(f.started(),false);assert(!f.calls.includes('native-review'));assert.equal(f.stops(),1);
});

test('runner metadata polling does not contend with the real model operation ledger or pause its active gameplay clock',async()=>{
 const f=nonexpiring();let finish,operation,polls=0;
 f.owner.start=()=>{f.lifecycle.ready();f.lifecycle.beginGameplay();operation=f.lifecycle.runOperation('model',()=>new Promise(resolve=>{finish=resolve;}));};
 f.owner.status=async()=>{polls++;assert.equal(f.lifecycle.snapshot().operation,'model');f.advance(37);assert.equal(f.lifecycle.snapshot().activeGameplayMs,37);finish('synthetic model result');assert.equal(await operation,'synthetic model result');return {state:'stopped'};};
 await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;
 assert.equal(polls,1);assert(f.publications.has('terminal'));assert(!f.publications.has('failure'));assert.equal(f.lifecycle.snapshot().activeGameplayMs,37);assert.equal(f.stops(),1);
});
