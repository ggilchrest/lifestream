// Synthetic native ports with the real supervisor and session. No engine,
// original state, network, model, or controller calls occur in these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSelectedCtJobLifecycle} from '../../../integration/ct-launcher/ct-job-lifecycle-owner.mjs';
import {createUbuntuGameSession} from '../src/runtime/ubuntu-game-session.ts';
import {createSupervisedGameRuntime,isOrderlySupervisedGameCompletion} from '../../../scripts/supervised-game-runtime.mjs';

const flush=async()=>{for(let i=0;i<4;i++)await new Promise<void>(r=>setImmediate(r));};
function deferred(){let resolve!:(v?:any)=>void,reject!:(e?:any)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function fixture(options:any={}){
 const shutdown=deferred(),ready=deferred(),physical=deferred();let actorCurrent=true,lifecycleCurrent=true,phase='preparing',nativeCurrent=true,removed=false,mono=0;
 const scope={principalId:'synthetic-principal',contextBinding:{sessionId:'synthetic-session'}};
 const actor={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>actorCurrent};
 const legacyLifecycle={signal:new AbortController().signal,check:()=>lifecycleCurrent,ready(){phase='ready';},beginGameplay(){phase='playing';},snapshot:()=>({state:phase})};
 const lifecycle=options.actualLifecycle?createSelectedCtJobLifecycle({maximumGameplayMs:64000,operationLimits:{owner_prepare:1000,native_prepare:1000,native_start:1000,model:3000,controller:500,settle:5000},cleanupTimeoutMs:1000},{isCurrent:()=>lifecycleCurrent&&actorCurrent,canExecute:()=>true,isQuiescent:()=>true,onStop:async()=>true,clock:{now:()=>mono,setTimeout:()=>({}),clearTimeout(){}}}):legacyLifecycle;
 const session=createUbuntuGameSession(scope,{maximumRunMs:90000,maximumPlanningSteps:1,inferenceMode:'supervisedForeground'},{lifecycle,maximumGameplayMs:64000,canBegin:()=>true});
 const native:any={resolveAttachment:()=>null,bindingCurrent:()=>true,controllerCurrent:()=>true,sourceCurrent:()=>true,sourceAvailable:()=>true,acceptObservation:()=>true,acceptAction:()=>true,reconcileEffect:async()=>true,admitRelease:async()=>true,usageFor:()=>null,shutdownExactOldLease:()=>shutdown.promise};
 const campaign:any={selectPlanning:async()=>({selection:{},bounds:{}}),planningCurrent:()=>true,terminalRef:()=>null,publishDecision:()=>true,prepareController:async()=>null,controllerCurrent:()=>true,recordSettledStep:()=>assert.fail('No action')};
 const supervisor=createSupervisedGameRuntime({native,campaign,createRepository:()=>({}) as any,resolveApproval:()=>null,maximumSteps:1,maximumRunMs:90000,maximumCommandMs:1000,...(options.retireThrows?{onRetire:()=>{throw Error('Synthetic retirement callback failure');}}:{})});
 const runtime={isCurrent:()=>nativeCurrent,preparePlanning:()=>({}),runPlanning:async()=>({state:options.failed?'suppressed':'published'}),publishEpisode:()=>assert.fail('No memory'),controllerCurrent:()=>true,close(){nativeCurrent=false;if(options.closeThrows)throw Error('Synthetic runtime close failure');}};
 const completion=supervisor.completion().then(async receipt=>{if(options.physical)await physical.promise;removed=options.removed!==false;return options.void?undefined:options.copy?{...receipt}:receipt;});
 session.configure({broker:{},origin:'http://127.0.0.1:1',database:{}});
 session.bindHandle({startClient(){},ready:()=>ready.promise,completion:()=>completion,cleanupConfirmed:()=>{if(options.cleanupThrows)throw Error('Synthetic cleanup check failure');return removed;},stop:()=>supervisor.stop(),snapshot:()=>({pauseConfirmation:'confirmed'})});
 await session.start(actor,{observations:true,campaignJournal:true,controllerInput:false,sharedInference:true});
 session.beginExecution(scope);supervisor.gameHost.createRepository!({} as any);supervisor.gameHost.onAttached!({runtime} as any);
 if(!options.holdReady)ready.resolve();await flush();
 return {session,scope,actor,supervisor,shutdown,ready,physical,completion,lifecycle,advance:(ms:number)=>{mono+=ms;},revoke:()=>{actorCurrent=false;},loseLifecycle:()=>{lifecycleCurrent=false;}};
}

test('only settled confirmed null-action completion survives retirement; pending native/physical cleanup is not completion',async()=>{
 const f=await fixture({physical:true});assert.equal(f.session.completed(f.actor),false);assert.equal(f.session.authorityCurrent(f.scope),true);
 f.shutdown.resolve(false);await flush();assert.equal(f.session.completed(f.actor),false,'Physical cleanup is still pending');
 f.physical.resolve();const receipt=await f.completion;await flush();
 assert.equal(isOrderlySupervisedGameCompletion(receipt),true);assert.equal(receipt.nativeShutdownConfirmed,false,'No controller action required pause/release');assert(Object.isFrozen(receipt));
 assert.equal(f.session.completed(f.actor),true);assert.equal(f.session.current(f.scope),false);assert.equal(f.session.authorityCurrent(f.scope),false);assert.equal(f.session.status(f.actor).state,'stopped');
 assert.throws(()=>f.session.beginExecution(f.scope));assert.equal(f.session.resolveApproval(f.scope),null);
});
for(const options of [{void:true},{copy:true},{failed:true}])test('stopped status cannot substitute for original orderly completion '+JSON.stringify(options),async()=>{
 const f=await fixture(options);f.shutdown.resolve(true);await f.completion;await flush();assert.equal(f.session.status(f.actor).state,'stopped');assert.equal(f.session.completed(f.actor),false);
});
for(const failure of ['unremoved','checkThrows','throw','physical'])test('unconfirmed or failed cleanup cannot publish normal completion: '+failure,async()=>{
 const f=await fixture({physical:failure==='physical',removed:failure!=='unremoved',cleanupThrows:failure==='checkThrows'});if(failure==='throw')f.shutdown.reject(Error('Synthetic shutdown failure'));else f.shutdown.resolve(false);
 if(failure==='physical'){f.physical.reject(Error('Synthetic physical cleanup failure'));await assert.rejects(f.completion);}else await f.completion;
 await flush();assert.equal(f.session.completed(f.actor),false);
});
for(const failure of ['retire','ready','auth','lifecycle','expiry'])test('prior invalidation remains sticky after later orderly native shutdown: '+failure,async t=>{
 if(failure==='expiry')t.mock.timers.enable({apis:['Date'],now:100000});
 const f=await fixture({holdReady:failure==='ready'});
 if(failure==='retire')f.session.retire();else if(failure==='ready'){f.ready.reject(Error('Synthetic attach failure'));await flush();}else if(failure==='auth')f.revoke();else if(failure==='lifecycle')f.loseLifecycle();else t.mock.timers.setTime(200000);
 f.shutdown.resolve(true);await f.completion;await flush();
 if(failure==='auth')assert.throws(()=>f.session.completed(f.actor));else assert.equal(f.session.completed(f.actor),false);
 assert.equal(f.session.current(f.scope),false);
});
test('fresh actor identity/authentication is required even after confirmed completion',async()=>{
 const f=await fixture();f.shutdown.resolve(true);await f.completion;await flush();assert.equal(f.session.completed(f.actor),true);
 assert.throws(()=>f.session.completed({...f.actor,sessionId:'another-session'}));f.revoke();assert.throws(()=>f.session.completed(f.actor));
});
test('later session invalidation cannot reuse its earlier completion latch',async()=>{
 const f=await fixture();f.shutdown.resolve(true);await f.completion;await flush();assert.equal(f.session.completed(f.actor),true);f.session.retire();assert.equal(f.session.completed(f.actor),false);
});

for(const options of [{retireThrows:true},{closeThrows:true}])test('throwing retirement callbacks cannot mint orderly completion '+JSON.stringify(options),async()=>{
 const f=await fixture(options);f.shutdown.resolve(false);const receipt=await f.completion;await flush();assert.equal(isOrderlySupervisedGameCompletion(receipt),false);assert.equal(f.session.completed(f.actor),false);
});
test('real lifecycle gameplay expiry during pending physical cleanup refuses completion',async()=>{
 const f=await fixture({actualLifecycle:true,physical:true});f.shutdown.resolve(false);await flush();assert.equal(f.session.completed(f.actor),false);
 f.advance(64000);f.physical.resolve();await f.completion;await flush();assert.equal(f.session.completed(f.actor),false);assert.equal(f.lifecycle.snapshot().reason,'gameplay_budget_exhausted');
});
