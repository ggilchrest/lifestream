// Dedicated core + real session/supervisor, entirely synthetic ports and memory.
import {createUbuntuGameSession} from '../../../apps/server/src/runtime/ubuntu-game-session.ts';
import {createSupervisedGameRuntime} from '../../../scripts/supervised-game-runtime.mjs';
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
 const timers=new Map();const trusted={isCurrent:()=>current&&(options.current?.()??true),canExecute:()=>true,isQuiescent:()=>true,onStop:()=>{stops++;return true;},clock:{now:()=>clock,setTimeout:(fn,ms)=>{const id={};timers.set(id,{fn,at:clock+ms});return id;},clearTimeout:id=>timers.delete(id)}};
 if(options.signal)trusted.signal=options.signal;
 const selection=f.input.selection;selection.schemaVersion='canonical-dedicated-ct-job/3';delete selection.expiresAt;selection.preparation={mode:'untilCancelled'};selection.execution=policy;
 f.input.configurationBytes=Buffer.from(JSON.stringify(f.input.configuration));selection.configurationSha256=sha(f.input.configurationBytes.toString());
 const lifecycle=createSelectedCtJobLifecycle(policy,trusted);f.input.lifecycle=lifecycle;
 const legacy=f.ports.waitDispatch;f.ports.waitDispatch=async(...args)=>{const value=await legacy(...args);value.schemaVersion='ct52-worker-dispatch/2';delete value.expiresAt;value.preparation={mode:'untilCancelled'};return options.mutateDispatch?.(value,args[0])??value;};
 return {...f,lifecycle,trusted,timers,advance:ms=>{clock+=ms;},revoke:()=>current=false,stops:()=>stops};
}
async function actualSession(){
 let resolveShutdown,actorCurrent=true,nativeCurrent=true;
 const shutdown=new Promise(resolve=>{resolveShutdown=resolve;}),scope={principalId:'synthetic-principal',contextBinding:{sessionId:'synthetic-session'}};
 const actor={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>actorCurrent};
 const session=createUbuntuGameSession(scope,{maximumRunMs:90000,maximumPlanningSteps:1});
 const current=()=>nativeCurrent;
 const native={resolveAttachment:()=>null,bindingCurrent:current,controllerCurrent:current,sourceCurrent:current,sourceAvailable:current,acceptObservation:current,acceptAction:current,reconcileEffect:async()=>true,admitRelease:async()=>true,usageFor:()=>null,shutdownExactOldLease:()=>shutdown};
 const campaign={selectPlanning:async()=>({selection:{},bounds:{}}),planningCurrent:current,terminalRef:()=>null,publishDecision:current,prepareController:async()=>null,controllerCurrent:current,recordSettledStep:()=>assert.fail('No controller')};
 const supervisor=createSupervisedGameRuntime({native,campaign,createRepository:()=>({}),resolveApproval:()=>null,maximumSteps:1,maximumRunMs:90000,maximumCommandMs:1000});
 const runtime={isCurrent:current,controllerCurrent:current,preparePlanning:()=>({}),runPlanning:async()=>({state:'published'}),publishEpisode:()=>assert.fail('No memory'),close(){nativeCurrent=false;}};
 session.configure({broker:{},origin:'http://127.0.0.1:1',database:{}});
 session.bindHandle({startClient(){},ready:()=>Promise.resolve(),completion:()=>supervisor.completion(),cleanupConfirmed:()=>true,stop:()=>supervisor.stop(),snapshot:()=>({})});
 await session.start(actor,{observations:true,campaignJournal:true,controllerInput:false});
 return {session,actor,scope,start(){supervisor.gameHost.createRepository({});supervisor.gameHost.onAttached({runtime});},async finish(){await flush();resolveShutdown(false);await supervisor.completion();await flush();},revoke(){actorCurrent=false;}};
}
for(const original of [true,false])test((original?'legacy awaited status reproduces false failure':'synchronous original observation publishes normal terminal')+' after real null-action completion',async()=>{
 const s=await actualSession(),f=nonexpiring({current:()=>s.session.authorityCurrent(s.scope)});
 const start=f.owner.start;f.owner.start=value=>{start(value);s.start();};
 f.owner.status=async()=>{await s.finish();return s.session.status(s.actor);};
 if(!original){
  f.owner.observeStatus=()=>s.session.completed(s.actor)?Object.freeze({kind:'completed',state:'stopped'}):Object.freeze({kind:'active',state:'running',frameQualification:'qualified'});
  f.ports.sleep=async()=>{await s.finish();};
 }
 await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;
 assert.equal(f.publications.has('terminal'),!original);assert.equal(f.publications.has('failure'),original);
 assert.equal(f.started(),true);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='start').length,1);
 if(original)assert.equal(f.publications.get('failure').value.code,'ct_job_expired_or_closed');else assert.equal(f.publications.get('terminal').value.state,'stopped');
 assert.equal(s.session.current(s.scope),false);assert.equal(s.session.resolveApproval(s.scope),null);
});
test('revoked original actor is still refused after confirmed normal completion',async()=>{
 const s=await actualSession(),f=nonexpiring({current:()=>s.session.authorityCurrent(s.scope)});f.owner.start=()=>s.start();
 f.owner.observeStatus=()=>s.session.completed(s.actor)?Object.freeze({kind:'completed',state:'stopped'}):Object.freeze({kind:'active',state:'running',frameQualification:'qualified'});
 f.ports.sleep=async()=>{await s.finish();s.revoke();};await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;
 assert(f.publications.has('failure'));assert(!f.publications.has('terminal'));
});
for(const kind of ['accessor','async','thenable','mutable','changed','stoppedOnly','activeStopped','activeLost'])test('invalid or non-current observation cannot publish completion: '+kind,async()=>{
 const f=nonexpiring();let getterCalls=0;
 if(kind==='accessor')Object.defineProperty(f.owner,'observeStatus',{get(){getterCalls++;return ()=>Object.freeze({kind:'completed',state:'stopped'});}});
 else f.owner.observeStatus=()=>kind==='async'?Promise.resolve(Object.freeze({kind:'completed',state:'stopped'})):kind==='thenable'?Object.freeze({kind:'completed',state:'stopped',then(){assert.fail('No thenable assimilation');}}):kind==='mutable'?{kind:'completed',state:'stopped'}:kind==='stoppedOnly'?Object.freeze({state:'stopped'}):Object.freeze({kind:'active',state:'stopped',frameQualification:'qualified'});
 const start=f.owner.start;f.owner.start=value=>{start(value);if(kind==='changed')f.owner.observeStatus=()=>Object.freeze({kind:'completed',state:'stopped'});if(kind==='activeLost')f.revoke();};
 await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;assert(f.publications.has('failure'));assert(!f.publications.has('terminal'));assert.equal(getterCalls,0);
});

for(const reason of ['clockRegressed','invalidClock','selectionExpired'])test('completed observation retains original outer envelope refusal: '+reason,async()=>{
 const f=reason==='selectionExpired'?fixture({browser:true}):nonexpiring();
 f.owner.observeStatus=()=>{const original=f.ports.now();f.ports.now=()=>reason==='clockRegressed'?original-1:reason==='invalidClock'?NaN:Date.parse(f.input.selection.expiresAt);return Object.freeze({kind:'completed',state:'stopped'});};
 await createDedicatedCtJobCore(f.app,f.input,f.ports).completion;assert.equal(f.publications.get('failure').value.code,'ct_job_expired_or_closed');assert(!f.publications.has('terminal'));
});
