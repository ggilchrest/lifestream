import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn, setTimeout as delay} from 'node:timers/promises';
import {SglangInferenceProvider} from '../src/provider.ts';
import {buildCanonicalPrompt} from '../../runtime/src/inference/prompt.ts';

const provider = () => new SglangInferenceProvider({endpoint:'http://127.0.0.1:1',model:'synthetic-cleanup'});
const request = () => buildCanonicalPrompt({assistantId:'synthetic',sessionId:'synthetic',interactionId:'synthetic',userInput:'Synthetic transport fixture only.',deadlineAt:new Date(Date.now()+30000).toISOString()});
const event = (text:string) => 'data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n';

function fixture(bytes:string) {
  let release!:()=>void;
  let cancelled=0;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const stream=new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(bytes)); },
    cancel() { cancelled++; return held; },
  });
  return {response:new Response(stream,{status:200}),release,held,cancelled:()=>cancelled};
}

test('caller cancellation fences buffered text and done while slow transport cleanup stays owned',async t=>{
  const transport=fixture(event('first')+event('must be fenced')+'data: [DONE]\n\n');
  t.mock.method(globalThis,'fetch',async()=>transport.response);
  const p=provider(),abort=new AbortController(),iterator=p.generate(request(),{signal:abort.signal})[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind,'text');
  const began=performance.now();abort.abort('synthetic P0');
  const terminal=await iterator.next();
  assert.equal(terminal.value?.error?.code,'cancelled');
  assert.equal((await iterator.next()).done,true);
  const callerMs=performance.now()-began;
  assert.ok(callerMs<10,`caller ${callerMs}ms exceeds unchanged10ms bound`);
  assert.equal(p.pendingTransportCleanupCount,1);
  let drained=false;const draining=p.drainTransportCleanups().then(()=>{drained=true;});
  await delay(40);assert.equal(drained,false);assert.equal(transport.cancelled(),1);
  transport.release();await draining;assert.equal(p.pendingTransportCleanupCount,0);
});

test('normal completion still waits for transport cleanup rather than claiming early settlement',async t=>{
  const transport=fixture('data: [DONE]\n\n');t.mock.method(globalThis,'fetch',async()=>transport.response);
  const p=provider(),iterator=p.generate(request(),{signal:new AbortController().signal})[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind,'done');
  let settled=false;const completion=iterator.next().then(value=>{settled=true;return value;});
  await delay(25);assert.equal(settled,false);assert.equal(p.pendingTransportCleanupCount,0);
  transport.release();assert.equal((await completion).done,true);
});

test('owned cleanup reservations are bounded and capacity exhaustion cannot start another request',async t=>{
  const transports:ReturnType<typeof fixture>[]=[];let fetches=0;
  t.mock.method(globalThis,'fetch',async()=>{fetches++;const transport=fixture(event('first')+event('fenced'));transports.push(transport);return transport.response;});
  const p=provider();
  for(let i=0;i<64;i++) {
    const abort=new AbortController(),iterator=p.generate(request(),{signal:abort.signal})[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.kind,'text');abort.abort();
    assert.equal((await iterator.next()).value?.error?.code,'cancelled');assert.equal((await iterator.next()).done,true);
  }
  assert.equal(p.pendingTransportCleanupCount,64);
  const rejected=[];for await(const chunk of p.generate(request(),{signal:new AbortController().signal}))rejected.push(chunk);
  assert.equal(rejected[0]?.error?.code,'inference_unavailable');assert.equal(fetches,64);
  await nextTurn();transports.forEach(transport=>transport.release());await p.drainTransportCleanups();
  assert.equal(p.pendingTransportCleanupCount,0);
  const normal=fixture('data: [DONE]\n\n');normal.release();t.mock.method(globalThis,'fetch',async()=>normal.response);
  const recovered=[];for await(const chunk of p.generate(request(),{signal:new AbortController().signal}))recovered.push(chunk);
  assert.deepEqual(recovered.map(chunk=>chunk.kind),['done']);
});

test('late fetch success after caller abort cannot emit buffered data or completion',async t=>{
  const abort=new AbortController();let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const transport=fixture(event('withheld')+'data: [DONE]\n\n');transport.release();
  t.mock.method(globalThis,'fetch',async()=>{await held;return transport.response;});
  const p=provider(),output=[];const consume=(async()=>{for await(const chunk of p.generate(request(),{signal:abort.signal}))output.push(chunk);})();
  abort.abort();release();await consume;
  assert.deepEqual(output.map(chunk=>chunk.error?.code),['cancelled']);
  assert.equal(p.pendingTransportCleanupCount,1);await p.drainTransportCleanups();
  assert.equal(transport.cancelled(),1);assert.equal(p.pendingTransportCleanupCount,0);
});
