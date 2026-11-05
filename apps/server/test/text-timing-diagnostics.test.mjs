import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {streamMessage} from '../src/runtime/inference.ts';
import {SglangInferenceProvider} from '../../../packages/providers-sglang/src/provider.ts';

for(const enabled of [false,true])test('opt-in text timing joins original response abort/provider/terminal and omits private text; enabled '+enabled,async t=>{
 const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;
 if(enabled)process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';else delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;
 t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
 const records=[];t.mock.method(console,'info',value=>records.push(JSON.parse(value)));
 const outer=new AbortController(),response=new EventEmitter();Object.assign(response,{destroyed:false,writableEnded:false,writeHead(){},end(){this.writableEnded=true;}});
 let queued=false;response.write=value=>{if(!queued&&value.startsWith('event: message.delta')){queued=true;setImmediate(()=>{response.destroyed=true;response.emit('close');});}};
 // Same ordering as the original HTTP route: close aborts the original signal.
 response.once('close',()=>{if(!response.writableEnded)outer.abort();});
 const wire=Array.from({length:32},()=> 'data: '+JSON.stringify({id:'chatcmpl-synthetic-owned-response',choices:[{delta:{content:'synthetic text '}}]})+'\n\n').join('')+'data: [DONE]\n\n';
 t.mock.method(globalThis,'fetch',async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}}));
 const provider=new SglangInferenceProvider({endpoint:'http://synthetic.invalid',model:'synthetic',protocol:'llama.cpp'});
 await streamMessage(response,provider,{userInput:'PRIVATE_PROMPT_SENTINEL'},'synthetic-session',outer.signal);
 await provider.drainTransportCleanups();
 assert(outer.signal.aborted);assert.equal(provider.pendingTransportCleanupCount,0);
 if(!enabled){assert.equal(records.length,0);return;}
 const ids=new Set(records.map(value=>value.interactionId));assert.equal(ids.size,1);assert.match([...ids][0],/^[0-9a-f-]{36}$/);
 for(const [event,phase]of [['typed-stream-timing','http-response-close'],['typed-stream-timing','abort-forwarded'],['typed-stream-timing','terminal-observer-return'],['typed-provider-timing','abort-forwarded'],['typed-provider-timing','generation-ended-cancelled'],['typed-provider-timing','transport-released']])assert(records.some(value=>value.event===event&&value.phase===phase),event+'/'+phase);
 assert.equal(records.find(value=>value.phase==='first-provider-frame').completionId,'chatcmpl-synthetic-owned-response');
 assert(records.every(value=>Number.isSafeInteger(value.observedAtMs)&&Number.isSafeInteger(value.elapsedMs)));
 assert(!JSON.stringify(records).includes('PRIVATE_PROMPT_SENTINEL'));assert(!JSON.stringify(records).includes('synthetic.invalid'));
});
test('failed optional text timing logging preserves ordinary completion',async t=>{
 const old=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';
 t.after(()=>{if(old===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=old;});
 t.mock.method(console,'info',()=>{throw Error('diagnostic logger unavailable');});
 let output='';const response={destroyed:false,writableEnded:false,writeHead(){},write(value){output+=value;},end(){this.writableEnded=true;}};
 const provider={async *generate(){yield {kind:'text',text:'synthetic reply'};yield {kind:'done'};}};
 await streamMessage(response,provider,{userInput:'synthetic request'},'synthetic-session',new AbortController().signal);
 assert.match(output,/event: interaction.completed/);assert.match(output,/synthetic reply/);assert(!output.includes('diagnostic logger unavailable'));
});
