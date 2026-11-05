import test from 'node:test';
import assert from 'node:assert/strict';
import {beginNativeRefreshTiming,createNativeInspectionTiming,captureNativeRefreshTiming} from '../src/native-refresh-timing.ts';

test('inspection phase durations distinguish queue, qualification and engine wait without renewing a completed span',()=>{
 let now=100;const timing=createNativeInspectionTiming(()=>now),first=timing.begin();
 now=107;first.phase('owner-before');now=110;first.phase('engine-read');now=210;first.phase('owner-after');now=219;first.phase('finished');
 assert.deepEqual(timing.snapshot(),{sequence:1,phase:'finished',elapsedMs:119,completedAgeMs:0,queuedMs:7,ownerBeforeMs:3,engineReadMs:100,ownerAfterMs:9});
 now=519;assert.equal(timing.snapshot().elapsedMs,119);assert.equal(timing.snapshot().completedAgeMs,300);
 const next=timing.begin();now=529;next.phase('failed');assert.equal(timing.snapshot().sequence,2);assert.equal(timing.snapshot().elapsedMs,10);
});
test('refresh timing custody rejects extra private content, getters and proxies without reading them',()=>{
 const good=beginNativeRefreshTiming(15000).snapshot();assert.deepEqual(captureNativeRefreshTiming(good),good);
 assert.equal(captureNativeRefreshTiming({...good,prompt:'PRIVATE'}),null);assert.equal(captureNativeRefreshTiming({...good,eventLoopActiveMs:Infinity}),null);
 let reads=0;const getter={...good};Object.defineProperty(getter,'elapsedMs',{get(){reads++;throw Error('PRIVATE');}});
 assert.equal(captureNativeRefreshTiming(getter),null);assert.equal(captureNativeRefreshTiming(new Proxy(good,{ownKeys(){reads++;throw Error('PRIVATE');}})),null);assert.equal(reads,0);
});

test('refresh failure measurements separate an idle pending callback from CPU work and freeze the captured metadata',async()=>{
 const timing=beginNativeRefreshTiming(15000);timing.entered();
 await new Promise(resolve=>setTimeout(resolve,25));
 const saved=timing.snapshot();assert.equal(saved.schemaVersion,'native-client-refresh-timing/1');assert.equal(saved.budgetMs,15000);
 assert(saved.elapsedMs>=15);assert.equal(saved.callbackSettledAfterMs,null);assert(saved.eventLoopIdleMs>=5);
 assert(Object.isFrozen(saved));timing.settled();assert.equal(saved.callbackSettledAfterMs,null);assert(timing.snapshot().callbackSettledAfterMs>=15);
 assert(Object.values(saved).every(value=>value===null||typeof value==='string'||Number.isSafeInteger(value)));
});
