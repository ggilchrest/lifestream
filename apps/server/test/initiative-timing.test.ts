import assert from 'node:assert/strict';
import test from 'node:test';
import {InitiativeTiming,waitForInitiativeTiming} from '../src/runtime/initiative-timing.ts';

test('timing feedback is explicit, owner-bound, one-use and limited by reviewed adaptation settings',()=>{
 let now=1000;const timing=new InitiativeTiming(()=>now),enabled={enabled:true,maximumDeferralSeconds:60};assert.equal(timing.peek('session','revision',enabled),undefined);
 timing.note('session','revision','dismissal');assert.equal(timing.peek('other','revision',enabled),undefined);for(const settings of [{...enabled,enabled:false},{...enabled,maximumDeferralSeconds:0},{...enabled,maximumDeferralSeconds:61},{...enabled,maximumDeferralSeconds:0.5}])assert.equal(timing.peek('session','revision',settings),undefined);
 assert.deepEqual(timing.take('session','revision',enabled),{delayMs:60000,sourceRef:'timing-plan:dismissal:60'});assert.equal(timing.take('session','revision',enabled),undefined);
 timing.note('session','revision','dismissal');assert.equal(timing.peek('session','changed',enabled),undefined);assert.equal(timing.peek('session','revision',enabled),undefined);
 timing.note('session','revision','dismissal');now--;assert.equal(timing.peek('session','revision',enabled),undefined);timing.note('session','revision','dismissal');now+=86400000;timing.prune();assert.equal(timing.peek('session','revision',enabled),undefined);
 timing.note('session','revision','dismissal');timing.clear('session');assert.equal(timing.peek('session','revision',enabled),undefined);
 for(let n=0;n<257;n++)timing.note(String(n),'revision','dismissal');assert.ok(timing.peek('255','revision',enabled));assert.equal(timing.peek('256','revision',enabled),undefined);timing.clear();assert.equal(timing.peek('255','revision',enabled),undefined);
});

test('timing wait honors its bounded delay and cancellation without leaving a delayed continuation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let completed=false;const signal=new AbortController();const pending=waitForInitiativeTiming(1000,signal.signal).then(()=>{completed=true;});t.mock.timers.tick(999);await Promise.resolve();assert.equal(completed,false);t.mock.timers.tick(1);await pending;assert.equal(completed,true);
 const cancelled=new AbortController(),waiting=waitForInitiativeTiming(60000,cancelled.signal),rejection=assert.rejects(waiting,/cancelled/);cancelled.abort();await rejection;t.mock.timers.tick(60000);await assert.rejects(waitForInitiativeTiming(10,cancelled.signal),/cancelled/);await assert.rejects(waitForInitiativeTiming(60001,new AbortController().signal),/Invalid/);
});
