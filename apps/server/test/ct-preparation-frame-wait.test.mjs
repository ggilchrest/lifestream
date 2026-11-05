import test from 'node:test';
import assert from 'node:assert/strict';
import {observeUntilFrameReviewed} from '../../../packages/providers-bizhawk/src/reviewed-live-frame.ts';

test('only explicit new preparation survives the former gameplay counter while the original source remains current',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let mono=0;t.mock.method(performance,'now',()=>mono);
 for(const mode of ['legacy','preparation']){
  mono=0;let qualified=false,calls=0;
  const result=await observeUntilFrameReviewed({observe:async()=>{calls++;return {observationId:'TEST-actual-source-result'};},current:()=>true,signal:new AbortController().signal,maximumRunMs:90000,...(mode==='preparation'?{preparation:'untilCancelled'}:{}),frameOwner:{current:()=>qualified},onWaiting:waiting=>{if(waiting){mono=100000;qualified=true;queueMicrotask(()=>t.mock.timers.tick(1000));}}});
  assert.equal(result?.observationId??null,mode==='preparation'?'TEST-actual-source-result':null);assert.equal(calls,mode==='preparation'?2:1);
 }
});
test('new preparation still stops on original source withdrawal or cancellation without accepting an image',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const cause of ['source','cancel']){
  let current=true,calls=0;const abort=new AbortController();
  const result=await observeUntilFrameReviewed({observe:async()=>{calls++;return {observationId:'TEST-unqualified'};},current:()=>current,signal:abort.signal,maximumRunMs:90000,preparation:'untilCancelled',frameOwner:{current:()=>false},onWaiting:waiting=>{if(waiting){if(cause==='source')current=false;else abort.abort();queueMicrotask(()=>t.mock.timers.tick(1000));}}});
  assert.equal(result,null);assert.equal(calls,1);
 }
});
test('the existing reviewed-scene stop remains authoritative during new preparation',async()=>{
 let waits=0;
 const result=await observeUntilFrameReviewed({observe:async()=>({observationId:'TEST-unknown-scene'}),current:()=>true,signal:new AbortController().signal,maximumRunMs:90000,preparation:'untilCancelled',frameOwner:{current:observation=>!observation,stopOnUnknown:true},onWaiting:waiting=>{if(waiting)waits++;}});
 assert.equal(result,null);assert.equal(waits,0);
});
