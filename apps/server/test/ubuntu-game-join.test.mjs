import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createUbuntuGameHostJoin} from '../src/runtime/ubuntu-game-join.mjs';
import {observe} from '../../../packages/providers-bizhawk/test/game-host-fixtures.ts';
import {GAME_HOST_PROTOCOL as protocol} from '@lifestream/contracts/game-host';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return {promise,resolve,reject};};

// Real join, supervisor and polling client. Transport replies and native ownership
// are controlled; no server, emulator, model, credential or controller is opened.
function fixture({pending='refresh'}={}){
 const scope=observe().scope,attachmentId=randomUUID(),selection=deferred(),refresh=deferred(),refreshEntered=deferred(),poll=deferred(),pollEntered=deferred(),failureEntered=deferred(),shutdownEntered=deferred(),releaseShutdown=deferred();
 const diagnostics=[],statuses=[],order=[];let refreshes=0,shutdownPromise,physicalClosed=false,runtimeClosed=false,runtimeCurrent=true,shutdowns=0;
 const closePhysical=()=>{if(!physicalClosed){physicalClosed=true;order.push('physical-close');refresh.reject(Error('Synthetic native owner closed'));}};
 // Like the owned native shutdown port, repeated cleanup callers share one
 // captured operation. Keep it pending to expose retirement ordering.
 const shutdown=()=>shutdownPromise??=(async()=>{shutdowns++;order.push('shutdown');shutdownEntered.resolve();await releaseShutdown.promise;return true;})();
 const unused=async()=>assert.fail('No native command or controller effect expected');
 const runtime={isCurrent:()=>runtimeCurrent&&!runtimeClosed,controllerCurrent:()=>runtimeCurrent&&!runtimeClosed,preparePlanning:()=>({}),runPlanning:async()=>({state:'published',reason:'publishedSupervisedForeground',completedSteps:1}),publishEpisode:()=>({state:'unavailable',memoryId:null}),close:()=>{runtimeClosed=true;order.push('runtime-close');}};
 const native={resolveAttachment:()=>null,bindingCurrent:()=>true,controllerCurrent:()=>true,sourceCurrent:()=>true,sourceAvailable:()=>true,acceptObservation:()=>true,acceptAction:()=>false,reconcileEffect:async()=>false,admitRelease:async()=>false,usageFor:()=>null,shutdownExactOldLease:shutdown};
 const campaign={selectPlanning:()=>selection.promise,planningCurrent:()=>true,terminalRef:()=>null,publishDecision:()=>true,prepareController:async()=>null,controllerCurrent:()=>false,recordSettledStep:unused};
 const reply=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 let join;
 join=createUbuntuGameHostJoin({client:{attach:{protocol,hostId:randomUUID(),scope,pinsDigest:'a'.repeat(64),providerRef:'synthetic-bridge',sourceRevision:'b'.repeat(64)},isScopeCurrent:()=>true,sourceIsQualified:()=>true,
  nativeBoundary:{providerRef:'synthetic-bridge',maxDurationMs:1000,sourceAvailable:()=>true,acceptObservation:()=>true,acceptAction:()=>false,reconcileEffect:async()=>false,admitRelease:async()=>false},
  openNative:async()=>({adapter:{observe:unused,applyController:unused,controlSave:unused,releaseControls:unused},close:closePhysical}),
  refreshNativeCustody:async()=>{if(++refreshes===3&&pending==='refresh'){refreshEntered.resolve();await refresh.promise;}},shutdownExactOldLease:shutdown,httpTimeoutMs:1000,sessionDurationMs:5000,shutdownTimeoutMs:2000,onFailure:value=>{diagnostics.push(value);order.push('diagnostic:'+value.reason);if(value.schemaVersion==='ct-runtime-first-cause/1')failureEntered.resolve();},
  fetchAuthenticated:async(url,init)=>{const route=url.split('/').at(-1);if(route==='attach'){join.serverOptions.gameHost.onAttached({scope,runtime,runController:unused});return reply({protocol,attachmentId,expiresAt:new Date(Date.now()+5000).toISOString(),pollMs:1000,maxMessageBytes:131072});}if(route==='detach')return reply({protocol,attachmentId,fenced:true});if(route==='next'&&pending==='poll'){pollEntered.resolve();return poll.promise;}assert.fail('No poll request while native refresh is held: '+route);}},
  composition:{native,campaign,createRepository:()=>({}),resolveApproval:()=>null,inferenceQualificationFor:()=>null,maximumSteps:1,maximumRunMs:5000,maximumCommandMs:1000,onStatus:value=>statuses.push(value)}});
 join.serverOptions.gameHost.createRepository({});
 const clientDone=join.runClient().catch(error=>error),completion=join.completion().finally(closePhysical);
 return {join,selection,refresh,refreshEntered,poll,pollEntered,failureEntered,shutdownEntered,releaseShutdown,diagnostics,statuses,order,clientDone,completion,shutdowns:()=>shutdowns,loseRuntime:()=>{runtimeCurrent=false;},
  async dispose(){selection.resolve(null);releaseShutdown.resolve();refresh.reject(Error('Synthetic fixture cleanup'));await join.stop();await completion;await clientDone;}};
}

for(const mode of ['no-action','explicit-stop'])test('retirement fences pending native refresh before held shutdown: '+mode,{timeout:5000},async()=>{
 const f=fixture();try{
  await f.refreshEntered.promise;
  assert.equal(f.join.clientSnapshot().fenced,false);
  if(mode==='no-action')f.selection.resolve({selection:{},bounds:{}});else void f.join.stop();
  await f.shutdownEntered.promise;
  assert.equal(f.join.clientSnapshot().reason,'closed','The original client must be fenced before native shutdown can wait or close');
  assert.equal(f.order[0],'diagnostic:closed');
  assert.equal(f.shutdowns(),1);
  f.releaseShutdown.resolve();await f.completion;await f.clientDone;
  assert.equal(f.diagnostics.some(value=>value.schemaVersion==='ct-runtime-first-cause/1'),false);
  assert.equal(f.diagnostics.some(value=>value.nativeSourceWitness?.predicate==='refresh_rejected'),false);
  if(mode==='no-action')assert.equal(f.statuses.filter(value=>value.state==='modelNoAction').length,1);
  await f.join.stop();assert.equal(f.shutdowns(),1);
 }finally{await f.dispose();}
});

test('normal no-action completion does not invent a refresh failure after physical close',{timeout:5000},async()=>{
 const f=fixture();try{
  await f.refreshEntered.promise;f.selection.resolve({selection:{},bounds:{}});
  await f.shutdownEntered.promise;f.releaseShutdown.resolve();await f.completion;await f.clientDone;
  assert.equal(f.statuses.filter(value=>value.state==='modelNoAction').length,1);
  assert.deepEqual(f.diagnostics.filter(value=>value.schemaVersion==='ct-runtime-first-cause/1'),[]);
  assert.equal(f.join.clientSnapshot().reason,'closed');
 }finally{await f.dispose();}
});

test('a genuine native refresh failure remains the first cause when retirement follows',{timeout:5000},async()=>{
 const f=fixture();try{
  await f.refreshEntered.promise;f.refresh.reject(new RangeError('Synthetic genuine inspection failure'));
  await f.shutdownEntered.promise;
  const first=f.diagnostics.filter(value=>value.schemaVersion==='ct-runtime-first-cause/1');
  assert.equal(first.length,1);assert.equal(first[0].reason,'scopeChanged');
  assert.deepEqual(first[0].nativeSourceWitness,{stage:'client-refresh',predicate:'refresh_rejected',exceptionClass:'RangeError'});
  void f.join.stop();f.releaseShutdown.resolve();await f.completion;await f.clientDone;
  assert.equal(f.join.clientSnapshot().reason,'scopeChanged');assert.equal(f.diagnostics.filter(value=>value.schemaVersion==='ct-runtime-first-cause/1').length,1);assert.equal(f.shutdowns(),1);
 }finally{await f.dispose();}
});

test('failure-driven retirement preserves an in-flight poll denial without a prior diagnostic',{timeout:5000},async()=>{
 const f=fixture({pending:'poll'});try{
  await f.pollEntered.promise;f.loseRuntime();assert.equal(f.join.current(),false);
  await f.shutdownEntered.promise;assert.equal(f.join.clientSnapshot().fenced,false);
  f.poll.resolve(new Response(null,{status:410,headers:{'x-lifestream-game-host-error':'game_host_expired','x-lifestream-game-host-cancellation-site':'poll_finish_current','x-lifestream-game-host-cancellation-predicate':'current_runtime'}}));
  await f.failureEntered.promise;
  const first=f.diagnostics.find(value=>value.schemaVersion==='ct-runtime-first-cause/1');
  assert.equal(first.reason,'denied');assert.deepEqual(first.responseWitness,{route:'next',status:410,errorCode:'game_host_expired',cancellationSite:'poll_finish_current',cancellationPredicate:'current_runtime'});
  f.releaseShutdown.resolve();await f.completion;await f.clientDone;
  assert.equal(f.join.clientSnapshot().reason,'denied');assert.equal(f.shutdowns(),1);
 }finally{await f.dispose();}
});
