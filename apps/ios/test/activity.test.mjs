import test from 'node:test';
import assert from 'node:assert/strict';
import {renderActivity} from '../web/activity.js';

function view(t){
 const prior=globalThis.document,nodes=new Map();
 globalThis.document={getElementById(id){if(!nodes.has(id))nodes.set(id,{textContent:'',dataset:{},value:0});return nodes.get(id);}};
 t.after(()=>{if(prior===undefined)delete globalThis.document;else globalThis.document=prior;});
 return id=>nodes.get(id);
}
const baseline={active:true,inputStage:'starting',rawInputBuffers:0,convertedInputBuffers:0,inputFrames:0,captureSampleRate:48000,captureChannels:1,captureEngineRunning:false};

test('capture setup does not claim listening before microphone buffers arrive',t=>{
 const $=view(t);renderActivity(baseline);
 assert.equal($('input-status').textContent,'Starting');assert.equal($('input-light').dataset.state,'waiting');
 assert.match($('audio-detail').textContent,/engine is starting/i);assert.match($('audio-detail').textContent,/0 raw · 0 converted · 0 delivered/);assert.match($('audio-detail').textContent,/48000 Hz · 1 channel/);
 renderActivity({...baseline,captureEngineRunning:true});assert.equal($('input-status').textContent,'Waiting for audio');assert.match($('audio-detail').textContent,/Waiting for microphone buffers/);
});

test('raw capture without conversion has a distinct visible diagnostic',t=>{
 const $=view(t);renderActivity({...baseline,captureEngineRunning:true,rawInputBuffers:9});
 assert.equal($('input-status').textContent,'Waiting for conversion');assert.equal($('input-light').dataset.state,'waiting');
 assert.match($('audio-detail').textContent,/buffers are arriving; waiting for audio conversion/);assert.match($('audio-detail').textContent,/9 raw · 0 converted · 0 delivered/);
});

test('converted buffers and silent delivered audio are not labeled speech',t=>{
 const $=view(t);renderActivity({...baseline,captureEngineRunning:true,rawInputBuffers:9,convertedInputBuffers:8});
 assert.match($('audio-detail').textContent,/waiting for delivery/);assert.notEqual($('input-status').textContent,'Speech detected');
 renderActivity({...baseline,captureEngineRunning:true,rawInputBuffers:10,convertedInputBuffers:9,inputFrames:8,inputStage:'listening',inputLevel:0});
 assert.equal($('input-status').textContent,'Listening');assert.equal($('input-light').dataset.state,'ready');assert.equal($('input-level').value,0);
 assert.match($('audio-detail').textContent,/Silence alone is not speech/);assert.match($('audio-detail').textContent,/10 raw · 9 converted · 8 delivered/);
});

test('errors stay first and preserve stopped capture counts for diagnosis',t=>{
 const $=view(t),lastError='Microphone buffers arrived, but conversion produced no samples.';
 renderActivity({...baseline,active:false,inputStage:'error',rawInputBuffers:12,lastError});
 assert.equal($('input-light').dataset.state,'error');assert.ok($('audio-detail').textContent.startsWith(lastError));assert.match($('audio-detail').textContent,/12 raw · 0 converted · 0 delivered/);
 renderActivity({...baseline,active:false,inputStage:'off',rawInputBuffers:12,convertedInputBuffers:11,inputFrames:10});
 assert.equal($('input-status').textContent,'Off');assert.match($('audio-detail').textContent,/Microphone is off/);assert.match($('audio-detail').textContent,/12 raw · 11 converted · 10 delivered/);
});

test('text-only use keeps microphone off and shows only its own processing state',t=>{
 const $=view(t);renderActivity({}, {busy:true});
 assert.equal($('input-status').textContent,'Off');assert.equal($('backend-status').textContent,'Processing text');assert.equal($('input-level').value,0);assert.doesNotMatch($('audio-detail').textContent,/Buffers:/);
 renderActivity({}, {complete:true});assert.equal($('output-status').textContent,'Text received');assert.equal($('input-status').textContent,'Off');
});

test('absent or invalid diagnostics are not invented as observed buffers',t=>{
 const $=view(t);renderActivity({active:true,inputStage:'starting',rawInputBuffers:-1,convertedInputBuffers:NaN,captureSampleRate:Infinity});
 assert.doesNotMatch($('audio-detail').textContent,/-1|NaN|Infinity|Buffers:/);assert.notEqual($('input-status').textContent,'Listening');
 renderActivity({active:true,inputStage:'capturing',inputFrames:3,inputLevel:0.04});
 assert.equal($('input-status').textContent,'Speech detected');assert.match($('audio-detail').textContent,/3 delivered/);assert.doesNotMatch($('audio-detail').textContent,/0 raw|0 converted/);
});
