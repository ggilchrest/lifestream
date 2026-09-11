import test from 'node:test';
import assert from 'node:assert/strict';
import {PcmPacer} from '../src/runtime/pcm-pacer.ts';
test('pacer enforces rate, packet bound, elapsed delivery and abortable backpressure',async()=>{
  const controller=new AbortController(),pacer=new PcmPacer();
  await assert.rejects(pacer.admit(1,0,controller.signal));
  await assert.rejects(pacer.admit(48001,48000,controller.signal));
  const start=performance.now();for(let i=0;i<17;i++)await pacer.admit(4800,48000,controller.signal);
  assert.ok(performance.now()-start>=75,'lookahead must be paced, not dumped');
  const pending=pacer.admit(4800,48000,controller.signal);controller.abort();await assert.rejects(pending);
});
