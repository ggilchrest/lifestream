import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeOwnerFailureWitness,captureNativeOwnerFailure,nativeOwnerFailureStages,nativeOwnerFailurePredicates,nativeOwnerTransportCodes} from '../src/native-owner-failure-witness.ts';

test('original inspection rejection metadata is captured before cleanup replacement with no error text',async()=>{
 const original=Object.assign(new TypeError('PRIVATE path/nonce/command/token'),{code:'EACCES',stdout:'PRIVATE output',stderr:'PRIVATE stderr'}),replacement=new Error('cleanup replacement');const events:string[]=[],records:unknown[]=[];
 async function actualCallerFixture(){try{await Promise.reject(original);}catch(error){captureNativeOwnerFailure(value=>{records.push(value);events.push('capture');},'inspect-poll','inspection_rejected',error);events.push('cleanup');throw replacement;}}
 await assert.rejects(actualCallerFixture(),error=>error===replacement);assert.deepEqual(events,['capture','cleanup']);assert.deepEqual(records,[{stage:'inspect-poll',predicate:'inspection_rejected',exceptionClass:'TypeError',errno:'EACCES'}]);assert.equal(JSON.stringify(records).includes('PRIVATE'),false);
});
test('readback and wrapper failures use only the closed stage/predicate/class and bounded numeric code',()=>{
 assert.deepEqual(createNativeOwnerFailureWitness('readback','readback_deadline',new RangeError('discarded')),{stage:'readback',predicate:'readback_deadline',exceptionClass:'RangeError'});
 for(const code of [0,125,255])assert.equal(createNativeOwnerFailureWitness('wrapper-exit','wrapper_ended',Object.assign(Error('discarded'),{code}))?.exitCode,code);
 for(const code of [-1,256,1.5,Infinity,true,'PRIVATE errno']){const value=createNativeOwnerFailureWitness('wrapper-error','wrapper_ended',Object.assign(Error('discarded'),{code}));assert.equal(value?.exitCode,undefined);assert.equal(value?.errno,undefined);}
});
test('error getters, proxies and inherited code are never evaluated or exported',()=>{
 let calls=0;const error=Error('PRIVATE');Object.defineProperty(error,'code',{get(){calls++;throw Error('PRIVATE getter');}});const result=createNativeOwnerFailureWitness('wrapper-stdin','wrapper_stdin_error',error);assert.equal(calls,0);assert.equal(result?.errno,undefined);
 const proxy=new Proxy(error,{get(){calls++;throw Error('PRIVATE');},getOwnPropertyDescriptor(){calls++;throw Error('PRIVATE');},getPrototypeOf(){calls++;throw Error('PRIVATE');}});assert.equal(createNativeOwnerFailureWitness('transport-disconnect','transport_closed',proxy)?.exceptionClass,'Other');assert.equal(calls,0);
 assert.equal(createNativeOwnerFailureWitness('inspect-poll','inspection_rejected',Object.create({code:'EIO'}))?.errno,undefined);
});
test('invalid stage/predicate strings are refused and an optional throwing sink remains inert',()=>{
 assert.equal(createNativeOwnerFailureWitness('PRIVATE' as any,'inspection_rejected',Error('PRIVATE')),undefined);assert.equal(createNativeOwnerFailureWitness('inspect-poll','PRIVATE' as any,Error('PRIVATE')),undefined);
 assert.doesNotThrow(()=>captureNativeOwnerFailure(()=>{throw Error('sink failure');},'inspect-poll','installation_current',Error('PRIVATE')));
 for(const stage of nativeOwnerFailureStages)for(const predicate of nativeOwnerFailurePredicates){const value=createNativeOwnerFailureWitness(stage,predicate,Error('PRIVATE'));assert(value&&Object.isFrozen(value));assert(Object.keys(value).every(k=>['stage','predicate','exceptionClass'].includes(k)));}
});

test('only original closed transport code is retained without coercion or getters',()=>{
 for(const code of nativeOwnerTransportCodes)assert.equal(createNativeOwnerFailureWitness('transport-disconnect','transport_closed',undefined,code)?.transportCode,code);
 for(const code of ['PRIVATE',null,{},new Proxy({},{get(){assert.fail('Getter was invoked');}})])assert.equal(createNativeOwnerFailureWitness('transport-disconnect','transport_closed',undefined,code)?.transportCode,undefined);
 assert.equal(createNativeOwnerFailureWitness('readback','readback_current',Error('PRIVATE'),'closed')?.transportCode,undefined);
});
