import assert from 'node:assert/strict';
import test from 'node:test';
import {ConversationOutput} from '../conversation-output.js';

function output(t){
 const original=globalThis.WebSocket;globalThis.WebSocket={OPEN:1};t.after(()=>{globalThis.WebSocket=original;});
 const starts=[],sources=[],sent=[];
 const value=new ConversationOutput({onStopped(){},onState(){},onComplete(){}});
 value.socket={readyState:1,send:raw=>sent.push(JSON.parse(raw))};
 value.audio={state:'running',currentTime:1,destination:{},createBuffer:(_channels,n)=>{const samples=new Float32Array(n);return {duration:n/48000,getChannelData:()=>samples};},createBufferSource:()=>{const source={connect(){},disconnect(){},addEventListener(){},start(at){starts.push(at);},stop(){source.stopped=true;}};sources.push(source);return source;}};
 value.turn={trace:'synthetic-playback',stopped:false};
 return {value,starts,sources,sent,frame:new Uint8Array(9600)};
}

test('first playback starts within 80 ms and arrival jitter does not add gaps to queued PCM',t=>{
 const {value,starts,frame}=output(t);value.play(frame);
 assert.ok(starts[0]-1<=.080001);
 value.audio.currentTime=1.06;value.play(frame);
 value.audio.currentTime=1.19;value.play(frame);
 assert.ok(Math.abs(starts[1]-(starts[0]+.1))<1e-9);
 assert.ok(Math.abs(starts[2]-(starts[1]+.1))<1e-9);
 value.stop();
});

test('an exhausted buffer recovers within 20 ms, reports silence in the gap, and Stop fences every queued source',t=>{
 const {value,starts,sources,sent,frame}=output(t);value.play(frame);
 value.audio.currentTime=1.3;assert.equal(value.playbackSample().playing,false);value.play(frame);
 assert.ok(Math.abs(starts[1]-1.32)<1e-9);
 assert.equal(value.playbackSample().playing,false);
 value.audio.currentTime=1.33;assert.equal(value.playbackSample().playing,true);
 value.stop('privacy changed');assert.ok(sources.every(source=>source.stopped));assert.equal(value.playbackSample().playing,false);
 assert.equal(sent.at(-1).type,'interrupt');assert.equal(value.playbackFrames.length,0);
 assert.throws(()=>value.play(frame),/unavailable/);
});
