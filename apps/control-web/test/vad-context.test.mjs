import test from 'node:test';
import assert from 'node:assert/strict';
import {withSileroContext} from '../vad-context.js';
test('Silero history crosses frame boundaries without becoming new capture samples',async()=>{
  const inputs=[];let resets=0,releases=0;
  const model=withSileroContext({process:async frame=>{inputs.push(frame);return {isSpeech:.9};},reset_state:()=>resets++,release:()=>releases++});
  const first=Float32Array.from({length:512},(_,i)=>i);
  assert.equal((await model.process(first)).isSpeech,.9);
  await model.process(new Float32Array(512).fill(7));
  assert.equal(inputs[0].length,576);assert.deepEqual(inputs[0].slice(0,64),new Float32Array(64));
  assert.deepEqual(inputs[1].slice(0,64),first.slice(-64));assert.equal(inputs[1][64],7);
  model.reset_state();await model.process(first);assert.deepEqual(inputs[2].slice(0,64),new Float32Array(64));
  assert.throws(()=>model.process(new Float32Array(576)),/512 new samples/);
  await model.release();assert.equal(resets,1);assert.equal(releases,1);
});
