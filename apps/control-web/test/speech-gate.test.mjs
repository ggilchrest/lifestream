import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechGate} from '../speech-gate.js';
import {VadStream} from '../vad-stream.js';
test('idle VAD reset does not discard PCM or reset during weak speech',async()=>{
  let probability=.1,resets=0,frames=0;
  const vad=new VadStream({process:async()=>({isSpeech:probability}),reset_state:()=>resets++,release:async()=>{}},()=>frames++,error=>{throw error;});
  const feed=async count=>{for(let i=0;i<count;i++){vad.push(new Float32Array(512));while(vad.running)await new Promise(resolve=>setImmediate(resolve));}};
  await feed(62);assert.equal(resets,0);await feed(1);assert.equal(resets,1);
  probability=.3;await feed(126);assert.equal(resets,1,'weak continuation must not be treated as resettable idle');
  probability=.1;await feed(63);assert.equal(resets,2);assert.equal(frames,252);vad.close();
});
test('probability gate rejects low confidence and transient positive evidence',()=>{const gate=new SpeechGate(50);for(let i=0;i<30;i++)assert.equal(gate.update(.2,32),false);assert.equal(gate.update(.99,32),false);assert.equal(gate.update(.1,32),false);for(let i=0;i<6;i++)assert.equal(gate.update(.8,32),false);assert.equal(gate.update(.8,32),true);});
test('qualified barge-in has a separate faster onset and configuration resets evidence',()=>{const gate=new SpeechGate(50);for(let i=0;i<4;i++)assert.equal(gate.update(.8,32,true),false);assert.equal(gate.update(.8,32,true),true);gate.configure(0);assert.equal(gate.aboveMs,0);assert.equal(gate.update(.7,1000),false);gate.configure(100);for(let i=0;i<4;i++)assert.equal(gate.update(.5,32),false);assert.equal(gate.update(.5,32),true);});
