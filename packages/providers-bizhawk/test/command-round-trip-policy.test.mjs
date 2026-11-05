import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {randomUUID} from 'node:crypto';
import {GAME_HOST_PROTOCOL} from '@lifestream/contracts/game-host';
import {captureGameSanityTiming} from '../src/game-sanity-timing.ts';
import {WindowsGameHostClient} from '../src/game-host-client.ts';
import {observe} from './game-host-fixtures.ts';
import {createSupervisedGameRuntime} from '../../../scripts/supervised-game-runtime.mjs';

// Resolve only the server policy's package import to its actual source policy;
// no compiler race, app construction, network, native owner or provider call.
const policyUrl=new URL('../../../apps/server/src/runtime/supervised-game-session.ts',import.meta.url).href;
const timingUrl=new URL('../src/game-sanity-timing.ts',import.meta.url).href;
const hook=registerHooks({resolve(specifier,context,next){
 if(specifier==='@lifestream/providers-bizhawk'&&context.parentURL===policyUrl)return {url:timingUrl,shortCircuit:true};
 return next(specifier,context);
}});
const {applySupervisedGameSanityTiming,finiteSupervisedGameConfiguration,supervisedSessionBounds}=await import(policyUrl);
hook.deregister();
const seed=()=>({sessionProfile:'supervised8',inferenceMode:'supervisedForeground',maximumRunMs:90000,maximumPlanningSteps:8,maximumCommandMs:3000,maximumObservationAgeMs:10000,maximumControllerGrantMs:300000,nativePreparation:{maximumNativeLifetimeMs:300000},planningBounds:{deadlineMs:3000,maximumInputTokens:8192,maximumOutputTokens:1024},campaign:{bounds:structuredClone(supervisedSessionBounds)}});

test('legacy configuration decodes to a whole-command60s budget independent of15s reads',()=>{
 const legacy=captureGameSanityTiming();const {commandRoundTripTimeoutMs:unused,...oldPolicy}=legacy;
 const input={...seed(),sanityTiming:oldPolicy},decoded=applySupervisedGameSanityTiming(input);
 assert.equal(decoded.maximumCommandMs,60000);assert.equal(decoded.sanityTiming.readRefreshTimeoutMs,15000);
 assert.equal(decoded.maximumObservationAgeMs,180000);assert.equal(decoded.maximumRunMs,90000);
 assert.equal(decoded.maximumControllerGrantMs,300000);assert.equal(decoded.nativePreparation.maximumNativeLifetimeMs,300000);
 assert.equal(decoded.campaign.bounds.modelCallBudget,8);assert.equal(decoded.campaign.bounds.actionBudget,8);
 for(const key of ['maxActionWallMs','maxInputLeaseMs'])assert.equal(decoded.campaign.bounds[key],500);
 assert.equal(decoded.campaign.bounds.maxActionFrames,12);assert.equal(decoded.campaign.bounds.startBudget,1);
 assert.equal(decoded.campaign.bounds.fastForwardEnabled,false);assert.equal(decoded.campaign.bounds.rewindEnabled,false);
 assert.equal(input.maximumCommandMs,3000);assert.equal(finiteSupervisedGameConfiguration(decoded),true);
});
test('trusted read and command overrides remain independent and immutably captured',()=>{
 const input={readRefreshTimeoutMs:2000,commandRoundTripTimeoutMs:90000};const timing=captureGameSanityTiming(input);
 input.commandRoundTripTimeoutMs=1;assert.equal(timing.commandRoundTripTimeoutMs,90000);assert.equal(timing.readRefreshTimeoutMs,2000);assert(Object.isFrozen(timing));
 const decoded=applySupervisedGameSanityTiming({...seed(),sanityTiming:timing});
 assert.equal(decoded.maximumCommandMs,90000);assert.equal(decoded.sanityTiming.readRefreshTimeoutMs,2000);
 const qualification=applySupervisedGameSanityTiming({...seed(),sessionProfile:'qualification',sanityTiming:{commandRoundTripTimeoutMs:120000}});
 assert.equal(qualification.maximumCommandMs,120000);
});
test('command allowance rejects coercion, nonfinite, zero, fractional and over-cap values without getters',()=>{
 for(const value of [undefined,null,true,'60000',NaN,Infinity,-Infinity,0,-1,1.5,120001])assert.throws(()=>captureGameSanityTiming({commandRoundTripTimeoutMs:value}));
 assert.equal(captureGameSanityTiming({commandRoundTripTimeoutMs:120000}).commandRoundTripTimeoutMs,120000);
 let calls=0;assert.throws(()=>captureGameSanityTiming(Object.defineProperty({},'commandRoundTripTimeoutMs',{enumerable:true,get(){calls++;throw Error('not data');}})));assert.equal(calls,0);
});
function runtimeOptions(maximumCommandMs){
 const yes=()=>true,no=()=>assert.fail('No runtime work in policy test');
 const native=Object.fromEntries(['resolveAttachment','bindingCurrent','controllerCurrent','sourceCurrent','sourceAvailable','acceptObservation','acceptAction','reconcileEffect','admitRelease','usageFor','shutdownExactOldLease'].map(k=>[k,yes]));
 const campaign=Object.fromEntries(['selectPlanning','planningCurrent','terminalRef','publishDecision','prepareController','controllerCurrent','recordSettledStep'].map(k=>[k,no]));
 return {native,campaign,createRepository:no,resolveApproval:()=>null,maximumSteps:8,maximumRunMs:90000,maximumCommandMs};
}
test('actual composition accepts the whole60/120s command range and refuses unbounded inputs',async()=>{
 for(const timeout of [60000,120000]){const runtime=createSupervisedGameRuntime(runtimeOptions(timeout));assert.equal(runtime.gameHost.maxDurationMs,timeout);await runtime.stop();}
 for(const timeout of [0,NaN,Infinity,120001,'60000'])assert.throws(()=>createSupervisedGameRuntime(runtimeOptions(timeout)),/Invalid finite/);
});
test('actual client constructor accepts60/120s command envelopes without opening any channel',()=>{
 const scope=observe().scope,no=()=>assert.fail('No client operation in constructor test');
 const options={attach:{protocol:GAME_HOST_PROTOCOL,hostId:randomUUID(),scope,pinsDigest:'a'.repeat(64),providerRef:'synthetic',sourceRevision:'b'.repeat(64)},fetchAuthenticated:no,isScopeCurrent:()=>true,sourceIsQualified:()=>true,nativeBoundary:{providerRef:'synthetic',maxDurationMs:120000,sourceAvailable:no,acceptObservation:no,acceptAction:no,reconcileEffect:no,admitRelease:no},openNative:no,shutdownExactOldLease:no,httpTimeoutMs:60000,sessionDurationMs:90000,shutdownTimeoutMs:60000};
 for(const timeout of [1,999,60000,120000]){const client=new WindowsGameHostClient({...options,httpTimeoutMs:timeout});assert.equal(client.snapshot.configured,true);assert.equal(client.snapshot.started,false);}
 for(const timeout of [NaN,Infinity,120001,'60000'])assert.throws(()=>new WindowsGameHostClient({...options,httpTimeoutMs:timeout}));
});
