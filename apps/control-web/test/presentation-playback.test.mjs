import assert from 'node:assert/strict';
import test from 'node:test';
import {ConversationOutput} from '../conversation-output.js';
test('mouth sampling follows scheduled PCM, becomes silent in a gap and cannot sample a stopped trace',t=>{
 const original=globalThis.WebSocket;globalThis.WebSocket={OPEN:1};t.after(()=>{globalThis.WebSocket=original;});
 const output=new ConversationOutput({onStopped:()=>{},onState:()=>{},onComplete:()=>{}});let stopped=0;
 output.socket={readyState:1,send:()=>{}};output.audio={state:'running',currentTime:0,destination:{},createBuffer:(_channels,n)=>{const samples=new Float32Array(n);return {duration:n/48000,getChannelData:()=>samples};},createBufferSource:()=>({connect(){},disconnect(){},addEventListener(){},start(){},stop(){stopped++;}})};
 output.turn={trace:'synthetic-trace',stopped:false};const samples=new Uint8Array(9600),view=new DataView(samples.buffer);for(let i=0;i<4800;i++)view.setInt16(i*2,16384,true);output.play(samples);assert.equal(output.playbackSample().playing,false);
 output.audio.currentTime=.26;const playing=output.playbackSample();assert.equal(playing.playing,true);assert.equal(playing.trace,'synthetic-trace');assert.ok(Math.abs(playing.amplitude-.5)<.001);assert.ok(playing.sampleOffset>=479&&playing.sampleOffset<=481);
 output.audio.currentTime=.36;assert.equal(output.playbackSample().playing,false);output.play(samples);output.stop();assert.equal(output.playbackSample().playing,false);assert.equal(output.playbackFrames.length,0);assert.ok(stopped>=1);
});
