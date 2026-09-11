import test from 'node:test';
import assert from 'node:assert/strict';
import {bufferedStream} from '../src/runtime/buffered-stream.ts';
test('bounded PCM lookahead overlaps producer with paced consumption without reordering',async()=>{
  let produced=0;const controller=new AbortController();
  async function* input(){for(let i=0;i<20;i++){produced++;yield i;}}
  const stream=bufferedStream(input(),controller.signal,3);assert.equal((await stream.next()).value,0);
  await new Promise(resolve=>setImmediate(resolve));assert.ok(produced<=5);assert.ok(produced>1);
  const output=[0];for await(const value of stream)output.push(value);assert.deepEqual(output,Array.from({length:20},(_,i)=>i));
});
test('cancellation releases a blocked producer and rejects late queued PCM',async()=>{
  const controller=new AbortController();let closed=false;
  async function* input(){try{for(let i=0;i<20;i++)yield i;}finally{closed=true;}}
  const stream=bufferedStream(input(),controller.signal,2);await stream.next();controller.abort();await assert.rejects(stream.next());assert.equal(closed,true);
});
test('consumer failure aborts a source waiting on external input before joining it',async()=>{
  const controller=new AbortController();let closed=false;
  async function* input(){try{yield 1;await new Promise<void>(resolve=>controller.signal.addEventListener('abort',()=>resolve(),{once:true}));}finally{closed=true;}}
  await assert.rejects(async()=>{for await(const value of bufferedStream(input(),controller.signal,2,()=>controller.abort())){assert.equal(value,1);throw new Error('sink failed');}},/sink failed/);
  assert.equal(closed,true);
});
