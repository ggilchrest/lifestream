// Fixed-bootstrap timing construction, not a JSON-selected actor or authority.
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createCtJobLifecycle} from './ct-job-lifecycle.mjs';
import {captureGameSanityTiming} from '../../packages/providers-bizhawk/dist/game-sanity-timing.js';
const keys=(value,expected)=>assert(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected.split(',').sort().join(','),'closed explicit execution policy required');
const operationCaps=Object.freeze({owner_prepare:120000,native_prepare:120000,native_start:120000,model:120000,controller:500,settle:60000});
/** Explicit policy construction from trusted scheduling configuration. These
 * watchdogs never extend a grant, native lease, 90s budget or 500ms effect. */
export function createDedicatedCtExecutionPolicy(sanityTiming,maximumGameplayMs=90000){
 const timing=captureGameSanityTiming(sanityTiming);
 return validateDedicatedCtExecutionPolicy({maximumGameplayMs,operationLimits:{owner_prepare:timing.startupOverallTimeoutMs,native_prepare:timing.startupOverallTimeoutMs,native_start:timing.startupOverallTimeoutMs,model:timing.planningTimeoutMs,controller:500,settle:timing.settlementTimeoutMs},cleanupTimeoutMs:timing.cleanupTimeoutMs});
}
export function validateDedicatedCtExecutionPolicy(value){
 keys(value,'maximumGameplayMs,operationLimits,cleanupTimeoutMs');
 assert(Number.isSafeInteger(value.maximumGameplayMs)&&value.maximumGameplayMs>0&&value.maximumGameplayMs<=90000,'explicit reviewed gameplay budget within the supervised8 compatibility ceiling required');
 assert(Number.isSafeInteger(value.cleanupTimeoutMs)&&value.cleanupTimeoutMs>0&&value.cleanupTimeoutMs<=120000,'explicit cleanup watchdog required');
 keys(value.operationLimits,Object.keys(operationCaps).join(','));
 for(const [name,cap] of Object.entries(operationCaps))assert(Number.isSafeInteger(value.operationLimits[name])&&value.operationLimits[name]>0&&value.operationLimits[name]<=cap,'explicit original operation watchdog required');
 return Object.freeze({maximumGameplayMs:value.maximumGameplayMs,operationLimits:Object.freeze({...value.operationLimits}),cleanupTimeoutMs:value.cleanupTimeoutMs});
}
const selectedPolicies=new WeakMap();
const trustedNames=new Set(['isCurrent','canExecute','isQuiescent','onStop','signal','clock','onStopCause']);
export function createSelectedCtJobLifecycle(executionPolicy,trustedPorts){
 const selected=validateDedicatedCtExecutionPolicy(executionPolicy);
 assert(trustedPorts&&typeof trustedPorts==='object'&&!Array.isArray(trustedPorts)&&Object.keys(trustedPorts).every(name=>trustedNames.has(name)),'fixed original lifecycle ports required');
 const lifecycle=createCtJobLifecycle({...trustedPorts,...selected});
 selectedPolicies.set(lifecycle,selected);
 return lifecycle;
}
export function isSelectedCtJobLifecycle(value,expectedExecutionPolicy){
 try{return selectedPolicies.has(value)&&isDeepStrictEqual(selectedPolicies.get(value),validateDedicatedCtExecutionPolicy(expectedExecutionPolicy));}catch{return false;}
}
