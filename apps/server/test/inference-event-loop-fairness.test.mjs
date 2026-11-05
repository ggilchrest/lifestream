import test from 'node:test';
import assert from 'node:assert/strict';
import {streamMessage} from '../src/runtime/inference.ts';
import {SglangInferenceProvider} from '../../../packages/providers-sglang/src/provider.ts';

for(const selectedAdapter of [false,true])for(const mode of ['abort','response-close'])test('buffered typed deltas allow queued '+mode+' before further publication; selected adapter '+selectedAdapter,async t=>{
 const controller=new AbortController(),events=[];let queued=false,delivered=false,closed=false,produced=0;
 const response={destroyed:false,writableEnded:false,writeHead(){},write(value){
  events.push(value);
  if(!queued&&value.startsWith('event: message.delta')){
   queued=true;setImmediate(()=>{delivered=true;if(mode==='response-close')response.destroyed=true;controller.abort();});
  }
 },end(){response.writableEnded=true;}};
 const direct={async *generate(){try{
  for(let i=0;i<128;i++){
   // A decoded provider buffer can supply already-ready deltas while existing
   // per-delta qualification does synchronous work. No external model is used.
   const until=performance.now()+0.25;while(performance.now()<until){/* bounded CPU fixture */}
   produced++;yield {kind:'text',text:'synthetic-'+i+' '};
  }
  yield {kind:'done'};
 }finally{closed=true;}}};
 let provider=direct;
 if(selectedAdapter){
  const wire=Array.from({length:128},(_,i)=>'data: '+JSON.stringify({choices:[{delta:{content:'synthetic-'+i+' '}}]})+'\n\n').join('')+'data: [DONE]\n\n';
  t.mock.method(globalThis,'fetch',async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}}));
  const original=new SglangInferenceProvider({endpoint:'http://synthetic.invalid',model:'synthetic',protocol:'llama.cpp'});
  provider={async *generate(request,context){try{for await(const chunk of original.generate(request,context)){if(chunk.kind==='text')produced++;yield chunk;}}finally{closed=true;}}};
 }
 await streamMessage(response,provider,{userInput:'synthetic fairness test'},'synthetic-session',controller.signal);
 await new Promise(resolve=>setImmediate(resolve));
 assert(delivered);assert(closed);assert(produced<128,'Queued cancellation must be serviced before draining the entire decoded provider buffer');
 assert.equal(events.filter(value=>value.startsWith('event: message.delta')).length,1);
 assert(!events.some(value=>value.startsWith('event: interaction.completed')));
 if(mode==='abort')assert(events.some(value=>value.includes('cancelled')));
});
