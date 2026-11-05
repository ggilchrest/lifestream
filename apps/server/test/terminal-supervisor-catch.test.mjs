import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupervisedGameRuntime} from '../../../scripts/supervised-game-runtime.mjs';
import {GameAdapterBoundaryError} from '../../../packages/providers-bizhawk/src/provider.ts';
test('actual supervisor caught boundary code survives recoverable probe and precedes unchanged retirement',async()=>{
 const order=[],reports=[];const runtime={preparePlanning(){assert.fail('No model');},runPlanning(){assert.fail('No model');},publishEpisode(){},isCurrent:()=>true,controllerCurrent:()=>false,close(){order.push('runtime-close');}};
 const native=Object.fromEntries(['resolveAttachment','bindingCurrent','controllerCurrent','sourceCurrent','sourceAvailable','acceptObservation','acceptAction','reconcileEffect','admitRelease','usageFor','shutdownExactOldLease'].map(k=>[k,()=>true]));
 const campaign=Object.fromEntries(['selectPlanning','planningCurrent','terminalRef','publishDecision','prepareController','controllerCurrent','recordSettledStep'].map(k=>[k,()=>null]));campaign.selectPlanning=async()=>{throw new GameAdapterBoundaryError('timedOut');};
 const r=createSupervisedGameRuntime({native,campaign,createRepository:()=>({}),resolveApproval:()=>null,maximumSteps:1,maximumRunMs:80000,maximumCommandMs:3000,onFailure:v=>{reports.push(v);order.push(v.schemaVersion);if(v.schemaVersion==='ct-runtime-first-cause/1')throw Error('Optional probe reporter refusal');}});r.gameHost.createRepository({});r.gameHost.onAttached({runtime,scope:{}});await r.completion();assert.deepEqual(reports,[{schemaVersion:'ct-runtime-first-cause/1',source:'composition',phase:'select-planning',reason:'adapter_timedOut'},{schemaVersion:'ct-runtime-terminal-cause/1',source:'composition',phase:'select-planning',reason:'adapter_timedOut'}]);assert.deepEqual(order.slice(0,3),['ct-runtime-first-cause/1','ct-runtime-terminal-cause/1','runtime-close']);
});
