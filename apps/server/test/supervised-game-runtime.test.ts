import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupervisedGameRuntime} from '../../../scripts/supervised-game-runtime.mjs';
import {createAuthenticatedGameRuntime,captureGameRuntimeOptions} from '../src/runtime/game-host-runtime.ts';
import {fixtureEpisode} from '../../../packages/runtime/test/fixtures/game-memory.ts';
import type {ActivityCheckpointRepository,Database} from '@lifestream/storage-sqlite';
import type {GameHostJoin} from '../src/runtime/game-host-port.ts';

for(const mode of ['native','internal','approval','wall','monotonic']as const)test('owner currentness retains original '+mode+' refusal and exact finite bounds despite a throwing observer',t=>{
 let wall=Date.now(),mono=100,native=true,internal=true,sourceCalls=0,internalCalls=0;const began=wall;
 t.mock.method(Date,'now',()=>wall);t.mock.method(performance,'now',()=>mono);
 const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
 const logs:Record<string,unknown>[]=[];t.mock.method(console,'info',(value:string)=>{logs.push(JSON.parse(value));throw Error('PRIVATE_REPORTER');});
 const scope=fixtureEpisode().scope,repository={}as ActivityCheckpointRepository;
 let approval={scope,approvedUntil:new Date(began+20000).toISOString(),maximumRunMs:10000,maximumPlanningSteps:1,observations:true,campaignJournal:true,controllerInput:false,memoryEpisodes:false};
 const options=captureGameRuntimeOptions({resolveApproval:()=>approval,sourceCurrent:()=>{sourceCalls++;return native;}});
 const runtime=createAuthenticatedGameRuntime(scope,options,repository,{current:()=>{internalCalls++;return internal;},prepare:()=>{throw Error('No preparation or model work in currentness fixture');},run:async()=>{throw Error('No model work');},cancel:()=>assert.fail('no active key'),publishEpisode:()=>({state:'unavailable',memoryId:null})})!;
 assert.ok(runtime);t.after(()=>runtime.close());const priorSource=sourceCalls,priorInternal=internalCalls;
 if(mode==='native')native=false;if(mode==='internal')internal=false;if(mode==='approval')approval={...approval,approvedUntil:new Date(began+25000).toISOString()};if(mode==='wall')wall=began+10000;if(mode==='monotonic')mono=10100;
 assert.equal(runtime.isCurrent(),false);const entries=logs.filter(v=>v.event==='game-owner-currentness-refusal');assert.equal(entries.length,1);
 assert.equal(entries[0]!.predicate,mode==='native'?'native_source':mode==='internal'?'internal_owner':mode==='approval'?'approval_identity':mode==='wall'?'approval_wall_deadline':'approval_monotonic_deadline');
 assert.equal(entries[0]!.runtimeExpiresAtMs,began+10000);assert.equal(entries[0]!.approvedUntilMs,began+20000);assert.equal(entries[0]!.runLimitMs,10000);
 assert.equal(sourceCalls-priorSource,mode==='native'?1:0);assert.equal(internalCalls-priorInternal,mode==='native'||mode==='internal'?1:0);assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|assistantId|principalId/);
 native=true;internal=true;wall=began;mono=100;assert.equal(runtime.isCurrent(),false);assert.equal(logs.length,1,'closed owner is not revived or probed by metadata');
});

test('supervision joins the actual scoped runtime source predicate without recursive currency',async()=>{
 const scope=fixtureEpisode().scope,repository={} as ActivityCheckpointRepository;
 let nativeCurrent=true,shutdowns=0;
 const native={resolveAttachment:()=>null,bindingCurrent:()=>nativeCurrent,controllerCurrent:()=>false,sourceCurrent:()=>nativeCurrent,sourceAvailable:()=>nativeCurrent,acceptObservation:()=>false,acceptAction:()=>false,reconcileEffect:async()=>false,admitRelease:async()=>false,usageFor:()=>null,shutdownExactOldLease:async()=>{shutdowns++;return true;}};
 const campaign={selectPlanning:async()=>null,planningCurrent:()=>false,terminalRef:()=>null,publishDecision:()=>false,prepareController:async()=>null,controllerCurrent:()=>false,recordSettledStep:async()=>null};
 const composition=createSupervisedGameRuntime({native,campaign,createRepository:()=>repository,resolveApproval:()=>({scope,approvedUntil:new Date(Date.now()+1000).toISOString(),maximumRunMs:1000,maximumPlanningSteps:1,observations:true,campaignJournal:true,controllerInput:false,memoryEpisodes:false}),maximumSteps:1,maximumRunMs:1000,maximumCommandMs:50});
 // The production runtime pins the exact approval. Use one fixed deadline.
 const approval=composition.gameRuntime.resolveApproval(scope);
 const options=captureGameRuntimeOptions({...composition.gameRuntime,resolveApproval:()=>approval});
 const runtime=createAuthenticatedGameRuntime(scope,options,repository,{current:()=>true,prepare:()=>{throw Error('No planning input authorized by this fixture');},run:async()=>{throw Error('No model call authorized by this fixture');},cancel:()=>{},publishEpisode:()=>({state:'unavailable',memoryId:null})})!;
 assert.ok(runtime);assert.equal(runtime.isCurrent(),true);
 composition.gameHost.createRepository({} as Database);
 composition.gameHost.onAttached!({runtime,scope,runController:async()=>{throw Error('No controller authorized by this fixture');}} as GameHostJoin);
 assert.equal(runtime.isCurrent(),true);
 await composition.completion();assert.equal(runtime.isCurrent(),false);assert.equal(shutdowns,1);
 nativeCurrent=false;assert.equal(composition.gameRuntime.sourceCurrent(scope),false);
});

test('new preparation attachment has no gameplay timer while initial selection is held; withdrawal still closes the original runtime and native owner',async t=>{
 const {createSelectedCtJobLifecycle}=await import('../../../integration/ct-launcher/ct-job-lifecycle-owner.mjs');
 t.mock.timers.enable({apis:['setTimeout']});
 const scope=fixtureEpisode().scope,repository={} as ActivityCheckpointRepository;
 let nativeCurrent=true,shutdowns=0,models=0,release!:(value:null)=>void;
 const selected=new Promise<null>(resolve=>{release=resolve;});
 const lifecycle=createSelectedCtJobLifecycle({maximumGameplayMs:64000,operationLimits:{owner_prepare:120000,native_prepare:120000,native_start:120000,model:3000,controller:500,settle:5000},cleanupTimeoutMs:5000},{isCurrent:()=>nativeCurrent,canExecute:()=>false,isQuiescent:()=>false,onStop:async()=>true});
 const native={resolveAttachment:()=>null,bindingCurrent:()=>nativeCurrent,controllerCurrent:()=>false,sourceCurrent:()=>nativeCurrent,sourceAvailable:()=>nativeCurrent,acceptObservation:()=>false,acceptAction:()=>false,reconcileEffect:async()=>false,admitRelease:async()=>false,usageFor:()=>null,shutdownExactOldLease:async()=>{shutdowns++;return true;}};
 const campaign={selectPlanning:()=>selected,planningCurrent:()=>false,terminalRef:()=>null,publishDecision:()=>false,prepareController:async()=>null,controllerCurrent:()=>false,recordSettledStep:async()=>null};
 const composition=createSupervisedGameRuntime({native,campaign,createRepository:()=>repository,resolveApproval:()=>null,preparation:{current:()=>nativeCurrent,begin:()=>false},executionLifecycle:lifecycle,maximumSteps:1,maximumRunMs:90000,maximumCommandMs:50});
 const runtime=createAuthenticatedGameRuntime(scope,captureGameRuntimeOptions(composition.gameRuntime),repository,{current:()=>true,prepare:()=>{throw Error('No qualified selection');},run:async()=>{models++;throw Error('No model');},cancel(){},publishEpisode:()=>({state:'unavailable',memoryId:null})})!;
 assert.ok(runtime);composition.gameHost.createRepository({} as Database);composition.gameHost.onAttached!({runtime,scope,runController:async()=>{throw Error('No controller');}} as GameHostJoin);
 t.mock.timers.tick(90001);assert.equal(runtime.isCurrent(),true);assert.equal(composition.current(),true);assert.equal(lifecycle.snapshot().gameplayStarted,false);assert.equal(models,0);assert.equal(shutdowns,0);
 nativeCurrent=false;release(null);await composition.completion();assert.equal(runtime.isCurrent(),false);assert.equal(shutdowns,1);assert.equal(models,0);await lifecycle.stop();
});
