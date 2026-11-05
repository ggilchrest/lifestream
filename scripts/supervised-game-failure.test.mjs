import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {captureSupervisedGameFailure,createSupervisedGameRuntime} from './supervised-game-runtime.mjs';
import {GameAdapterBoundaryError} from '../packages/providers-bizhawk/src/provider.ts';
import {GameHostError} from '../apps/server/src/runtime/game-host-port.ts';
import {runGameObservationCommand} from '../apps/server/src/runtime/game-observation-deadline.ts';
import {captureCtWakeHandoff} from '../apps/server/src/runtime/ct-wake-handoff.ts';

const classified=(error,phase='select-planning')=>captureSupervisedGameFailure(error,phase);
test('original adapter and host errors retain only closed code and phase',()=>{
 for(const code of ['invalidRequest','invalidResponse','scopeChanged','cancelled','timedOut','unavailable','admissionRequired','concurrentEffect'])assert.equal(classified(new GameAdapterBoundaryError(code)).reason,'adapter_'+code);
 for(const code of ['invalid_game_host_message','game_host_scope_denied','game_host_conflict','game_host_expired','game_host_unavailable'])assert.equal(classified(new GameHostError(409,code)).reason,'host_'+code);
 assert.deepEqual(classified(Error('ct_fresh_wake_handoff_join_required'),'wake-handoff'),{schemaVersion:'ct-runtime-first-cause/1',source:'composition',phase:'wake-handoff',reason:'plain_wake_handoff_join_required'});
 assert.equal(Object.isFrozen(classified(Error('private'))),true);
});
test('unknown errors and malicious own codes cannot export arbitrary text',()=>{
 for(const error of [Error('PRIVATE'),new GameHostError(500,'PRIVATE'),Object.assign(Error('PRIVATE'),{code:'timedOut'}),null,42,Object.create(null)])assert.equal(classified(error).reason,'original_exception_unclassified');
 const error=new GameAdapterBoundaryError('timedOut');Object.defineProperty(error,'code',{get(){assert.fail('code getter');}});Object.defineProperty(error,'name',{get(){assert.fail('name getter');}});Object.defineProperty(error,'stack',{get(){assert.fail('stack getter');}});assert.equal(classified(error).reason,'original_exception_unclassified');
 const plain=Error();Object.defineProperty(plain,'message',{get(){assert.fail('message getter');}});assert.equal(classified(plain).reason,'original_exception_unclassified');
 assert.equal(classified(Error('PRIVATE'),'PRIVATE').phase,'select-planning');
});
test('proxy error, immediate prototype and constructor are rejected without traps',()=>{
 let traps=0;const handler={get(){traps++;throw Error('trap');},getPrototypeOf(){traps++;throw Error('trap');},getOwnPropertyDescriptor(){traps++;throw Error('trap');}};
 for(const error of [new Proxy(Error(),handler),Object.create(new Proxy({},handler)),Object.create({constructor:new Proxy(function GameAdapterBoundaryError(){},handler)})])assert.equal(classified(error).reason,'original_exception_unclassified');
 assert.equal(traps,0);
 const proto={};Object.defineProperty(proto,'constructor',{get(){assert.fail('constructor getter');}});assert.equal(classified(Object.create(proto)).reason,'original_exception_unclassified');
});
function failingSupervisor(error,{throwReporter=false}={}){
 const events=[];let current=true;
 const runtime={isCurrent:()=>current,controllerCurrent:()=>current,preparePlanning:()=>assert.fail('planning after rejected observation'),runPlanning:()=>assert.fail('model'),publishEpisode:()=>assert.fail('memory'),close:()=>{events.push('close');current=false;}};
 const native=Object.fromEntries(['resolveAttachment','bindingCurrent','controllerCurrent','sourceCurrent','sourceAvailable','acceptObservation','acceptAction','reconcileEffect','admitRelease','usageFor'].map(name=>[name,()=>current]));native.shutdownExactOldLease=async()=>{events.push('shutdown');return true;};
 const campaign={selectPlanning:async()=>{events.push('observe');throw error;},planningCurrent:()=>current,terminalRef:()=>null,publishDecision:()=>false,prepareController:()=>assert.fail('controller'),controllerCurrent:()=>current,recordSettledStep:()=>assert.fail('settle')};
 const owner=createSupervisedGameRuntime({native,campaign,createRepository:()=>({}),resolveApproval:()=>null,maximumSteps:1,maximumRunMs:1000,maximumCommandMs:100,onFailure:value=>{events.push(value);if(throwReporter)throw Error('private reporter failure');},onStatus:value=>events.push(value)});
 owner.gameHost.createRepository({});owner.gameHost.onAttached({runtime,runController:()=>assert.fail('controller')});return {owner,events};
}
test('earlier original invalidResponse is preserved before generic suppression and derivative closure',async()=>{
 const f=failingSupervisor(new GameAdapterBoundaryError('invalidResponse'));await f.owner.completion();assert.deepEqual(f.events.slice(0,5),['observe',classified(new GameAdapterBoundaryError('invalidResponse')),{...classified(new GameAdapterBoundaryError('invalidResponse')),schemaVersion:'ct-runtime-terminal-cause/1'},{state:'suppressed',reason:'qualifiedCurrentPortsUnavailable'},'close']);assert.equal(f.events.filter(v=>v==='shutdown').length,1);
 // This is the original post-retirement rejection, not a substitute first cause.
 assert.equal(f.owner.gameHost.bindingCurrent({},{}),false);assert.equal(f.events[1].reason,'adapter_invalidResponse');
});
test('optional diagnostic callback throwing preserves original suppression and exact once retirement',async()=>{
 const f=failingSupervisor(new GameAdapterBoundaryError('timedOut'),{throwReporter:true});await f.owner.completion();assert.equal(f.events[1].reason,'adapter_timedOut');assert.equal(f.events.filter(v=>v==='close').length,1);assert.equal(f.events.filter(v=>v==='shutdown').length,1);assert.equal(f.events[2].schemaVersion,'ct-runtime-terminal-cause/1');assert.equal(f.events[2].reason,'adapter_timedOut');assert.equal(f.events[3].reason,'qualifiedCurrentPortsUnavailable');
});
// Execute the exact selected source.observe method with inert native/session
// ports. This proves phase, original call count/rethrow and frame disposal only;
// it grants no image approval and performs no engine, auth, model or DB work.
function selectedObserve(patch={}){
 const raw=readFileSync(new URL('../apps/server/src/runtime/ubuntu-game-composition.mjs',import.meta.url),'utf8'),start=raw.indexOf('  observe:async(join,signal,afterActionId=null)=>{'),end=raw.indexOf('\n  bindingFor:',start);assert(start>=0&&end>start);
 const records=[],observation={observationId:randomUUID(),screenshots:[]};let sourceChecks=0,nativeCalls=0;
 const args={runGameObservationCommand,observeUntilFrameReviewed:options=>options.observe(),current:()=>true,frameOwner:null,configuration:{maximumRunMs:80000,maximumCommandMs:3000,onFailure:v=>records.push(v)},executionOwner:null,waitingForFrame:false,lifecycle:null,randomUUID,scope:{},attach:{pinsDigest:'a'.repeat(64)},sourceCurrent:()=>{sourceChecks++;return true;},awaitClientQuiescence:async()=>true,lastObservation:null,wakeRequired:false,wakeJoined:false,captureCtWakeHandoff,physical:{wakePreparationReceipt:null},evidence:{frameForReview:()=>null},captureCtObservationEvidence:()=>({}),reviewedScene:null,captureSupervisedGameFailure,goal:null,...patch};
 const observe=compileFunction('return ({'+raw.slice(start,end)+'}).observe;',Object.keys(args))(...Object.values(args));
 const join={adapter:{observe:async()=>{nativeCalls++;return {outcome:{payload:{observation}}};}}};return {observe:(join,signal=new AbortController().signal,afterActionId=null)=>observe(join,signal,afterActionId),join,records,observation,counts:()=>({sourceChecks,nativeCalls}),args};
}
test('selected native-observe exception is rethrown by identity once and reporter failure cannot replace it',async()=>{
 const error=new GameHostError(409,'game_host_scope_denied'),f=selectedObserve({configuration:{maximumRunMs:80000,maximumCommandMs:3000,onFailure:()=>{throw Error('reporter');}}});let calls=0;f.join.adapter.observe=async()=>{calls++;throw error;};await assert.rejects(f.observe(f.join,new AbortController().signal),v=>v===error);assert.equal(calls,1);assert.deepEqual(f.counts(),{sourceChecks:0,nativeCalls:0});
 const normal=selectedObserve();normal.join.adapter.observe=async()=>{throw error;};await assert.rejects(normal.observe(normal.join),v=>v===error);assert.deepEqual(normal.records,[classified(error,'native-observe')]);
});
test('selected client ACK wait exception is retained without another native observe or guard evaluation',async()=>{
 const error=new GameAdapterBoundaryError('timedOut'),f=selectedObserve({executionOwner:{},awaitClientQuiescence:async()=>{throw error;}});await assert.rejects(f.observe(f.join),v=>v===error);assert.deepEqual(f.records,[classified(error,'client-quiescence')]);assert.deepEqual(f.counts(),{sourceChecks:0,nativeCalls:1});
});
test('original wake handoff validator failure survives with its exact observation substage',async()=>{
 const f=selectedObserve({wakeRequired:true});await assert.rejects(f.observe(f.join),/ct_fresh_wake_handoff_join_required/);assert.deepEqual(f.records,[classified(Error('ct_fresh_wake_handoff_join_required'),'wake-handoff')]);assert.equal(f.counts().nativeCalls,1);
});
test('selected frame capture and synchronous callback failures preserve closed phase and zero frame bytes',async()=>{
 const missing=selectedObserve({configuration:{maximumRunMs:80000,maximumCommandMs:3000,onObservation:()=>assert.fail('no frame'),onFailure:v=>missing.records.push(v)}});await assert.rejects(missing.observe(missing.join),/Current owned frame/);assert.equal(missing.records[0].phase,'frame-capture');assert.equal(missing.records[0].reason,'plain_current_owned_frame_unavailable');
 const bytes=Buffer.from('DISPOSABLE'),f=selectedObserve({evidence:{frameForReview:()=>({bytes})},configuration:{maximumRunMs:80000,maximumCommandMs:3000,onObservation:()=>Promise.resolve(),onFailure:v=>f.records.push(v)}});await assert.rejects(f.observe(f.join),/Synchronous CT image/);assert.deepEqual(f.records,[classified(Error('Synchronous CT image custody required'),'observation-callback')]);assert(bytes.every(v=>v===0));
});
test('selected ordinary successful or unavailable observation emits no diagnostic and preserves return',async()=>{
 const f=selectedObserve();assert.equal(await f.observe(f.join),f.observation);assert.deepEqual(f.records,[]);assert.equal(f.counts().nativeCalls,1);const none=selectedObserve();none.join.adapter.observe=async()=>({outcome:{payload:{}}});assert.equal(await none.observe(none.join),null);assert.deepEqual(none.records,[]);
});

test('original observation callback cannot archive after synchronous frame validation spends its deadline',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 const bytes=Buffer.from('DISPOSABLE');let archives=0;
 const f=selectedObserve({evidence:{frameForReview:()=>({bytes})},captureCtObservationEvidence:()=>{t.mock.timers.tick(3001);return {};},configuration:{maximumRunMs:80000,maximumCommandMs:3000,onObservation:()=>{archives++;},onFailure:v=>f.records.push(v)}});
 await assert.rejects(f.observe(f.join),error=>error.code==='timedOut');assert.equal(archives,0);assert(bytes.every(v=>v===0));assert.equal(f.records[0].phase,'observation-callback');
});
