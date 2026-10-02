import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupervisedGameRuntime} from '../../../scripts/supervised-game-runtime.mjs';
import {createAuthenticatedGameRuntime,captureGameRuntimeOptions} from '../src/runtime/game-host-runtime.ts';
import {fixtureEpisode} from '../../../packages/runtime/test/fixtures/game-memory.ts';
import type {ActivityCheckpointRepository,Database} from '@lifestream/storage-sqlite';
import type {GameHostJoin} from '../src/runtime/game-host-port.ts';

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
