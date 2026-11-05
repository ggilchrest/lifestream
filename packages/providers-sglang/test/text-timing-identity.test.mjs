import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCanonicalPrompt} from '../../runtime/src/inference/prompt.ts';
import {SglangInferenceProvider} from '../src/provider.ts';

test('provider traces closed finish categories without retaining arbitrary provider fields',async t=>{
 const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';
 t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
 const logs=[];t.mock.method(console,'info',value=>logs.push(JSON.parse(value)));
 for(const finish of ['length','stop','PRIVATE_FINISH_SENTINEL']){
  logs.length=0;
  const request=buildCanonicalPrompt({assistantId:'synthetic',sessionId:'synthetic',interactionId:'4ebce228-fae0-4bc7-96aa-2d72f69844ae',userInput:'PRIVATE_PROMPT_SENTINEL',deadlineAt:new Date(Date.now()+30000).toISOString()});
  t.mock.method(globalThis,'fetch',async()=>new Response('data: '+JSON.stringify({id:'chatcmpl-synthetic',choices:[{finish_reason:finish}]})+'\n\ndata: [DONE]\n\n'));
  const provider=new SglangInferenceProvider({endpoint:'http://synthetic.invalid',model:'synthetic'}),chunks=[];
  for await(const chunk of provider.generate(request,{signal:new AbortController().signal}))chunks.push(chunk);
  assert.deepEqual(chunks.map(c=>c.kind),[finish==='length'?'error':'done']);assert.equal(provider.transportReservations,0);
  assert.ok(logs.some(v=>v.phase==='provider-finish-'+(finish==='length'?'length':finish==='stop'?'stop':'other')));
  assert.equal(logs.some(v=>v.phase==='provider-terminal-done'),finish!=='length');assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|synthetic.invalid/);
 }
});

for(const enabled of [false,true])for(const mode of ['missing','nonUUID','scopeGetter','identityGetter','scopeProxy','requestProxy'])test('optional provider timing preserves '+mode+' request and reservations; enabled '+enabled,async t=>{
 const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;if(enabled)process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';else delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;
 t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
 const logs=[];let reads=0;let request={...buildCanonicalPrompt({assistantId:'synthetic',sessionId:'synthetic',interactionId:'PRIVATE_DIAGNOSTIC_SENTINEL',userInput:'PRIVATE_PROMPT_SENTINEL',deadlineAt:new Date(Date.now()+30000).toISOString()})};
 if(mode==='missing')delete request.scope;
 if(mode==='scopeGetter')Object.defineProperty(request,'scope',{get(){reads++;throw Error('PRIVATE');}});
 if(mode==='identityGetter')request.scope={get interactionId(){reads++;throw Error('PRIVATE');}};
 if(mode==='scopeProxy')request.scope=new Proxy({},{ownKeys(){reads++;throw Error('PRIVATE');},get(){reads++;throw Error('PRIVATE');},getOwnPropertyDescriptor(){reads++;throw Error('PRIVATE');}});
 if(mode==='requestProxy')request=new Proxy(request,{get(target,key,receiver){if(key==='scope'){reads++;throw Error('PRIVATE');}return Reflect.get(target,key,receiver);},getOwnPropertyDescriptor(target,key){if(key==='scope'){reads++;throw Error('PRIVATE');}return Reflect.getOwnPropertyDescriptor(target,key);}});
 t.mock.method(console,'info',value=>logs.push(value));
 t.mock.method(globalThis,'fetch',async()=>new Response('data: {"id":"chatcmpl-synthetic","choices":[{"delta":{"content":"synthetic"}}]}\n\ndata: [DONE]\n\n'));
 const provider=new SglangInferenceProvider({endpoint:'http://synthetic.invalid',model:'synthetic'}),chunks=[];
 for await(const chunk of provider.generate(request,{signal:new AbortController().signal}))chunks.push(chunk);
 assert.deepEqual(chunks.map(value=>value.kind),['text','done']);assert.equal(reads,0);assert.equal(logs.length,0);assert.equal(provider.transportReservations,0);assert.equal(provider.pendingTransportCleanupCount,0);
});

test('request and stream metadata are optional and a throwing observer cannot alter text or cleanup',async t=>{
 const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;
 t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
 for(const enabled of [false,true]){
  if(enabled)process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';else delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;
  let reports=0;t.mock.method(console,'info',()=>{reports++;throw Error('PRIVATE_OBSERVER');});
  t.mock.method(globalThis,'fetch',async()=>new Response('data: {"id":"chatcmpl-synthetic","choices":[{"delta":{"content":"synthetic","reasoning_content":"PRIVATE_REASONING","refusal":"PRIVATE_REFUSAL"}}]}\n\ndata: [DONE]\n\n'));
  const request=buildCanonicalPrompt({assistantId:'synthetic',sessionId:'synthetic',interactionId:'4ebce228-fae0-4bc7-96aa-2d72f69844ae',userInput:'PRIVATE_PROMPT',deadlineAt:new Date(Date.now()+30000).toISOString()});
  assert.equal(request.responseFormat,undefined);
  const provider=new SglangInferenceProvider({endpoint:'http://synthetic.invalid',model:'synthetic'}),chunks=[];
  for await(const chunk of provider.generate(request,{signal:new AbortController().signal}))chunks.push(chunk);
  assert.deepEqual(chunks,[{kind:'text',text:'synthetic'},{kind:'done'}]);assert.equal(provider.transportReservations,0);assert.equal(provider.pendingTransportCleanupCount,0);assert.equal(reports>0,enabled);
 }
});
