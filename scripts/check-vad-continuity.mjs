// Real pinned browser VAD, accelerated audio-time diagnostic (not wall-clock soak).
import {readFileSync} from 'node:fs';
import {VoiceEvidence} from './voice-evidence.mjs';
import assert from 'node:assert/strict';
import {END_SILENCE_SECONDS} from '../apps/control-web/speech-gate.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const pcm=readFileSync(process.env.VOICE_FIXTURE_PCM);if(pcm.length>48000*2*30)throw new Error('Fixture too long');
const evidence=new VoiceEvidence('vad-continuity');
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:3910/control/conversation.html');
  const cases=await page.evaluate(async base64=>{
    const {SileroV5}=await import('/control/vad-bundle.js'),{withSileroContext}=await import('/control/vad-context.js');
    ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths='/control/';const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);
    const context=new OfflineAudioContext(1,bytes.length/6,16000),audio=context.createBuffer(1,bytes.length/2,48000);
    for(let i=0;i<audio.length;i++)audio.getChannelData(0)[i]=view.getInt16(i*2,true)/32768;
    const source=context.createBufferSource();source.buffer=audio;source.connect(context.destination);source.start();const speech=(await context.startRendering()).getChannelData(0),out=[];
    const raw=await SileroV5.new(ort,async()=>{const r=await fetch('/control/silero_vad_v5.onnx');return r.arrayBuffer();}),model=withSileroContext(raw);let seed=41;
    try{
      for(const resetAfterIdle of [false,true]){
        model.reset_state();let low=0,resets=0;
        for(let i=0;i<18750;i++){const frame=new Float32Array(512);for(let j=0;j<512;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;frame[j]=(seed/4294967296-.5)*.004;}const {isSpeech}=await model.process(frame);low=isSpeech<.4?low+1:0;if(resetAfterIdle&&low>=63){model.reset_state();low=0;resets++;}}
        const repetitions=[];
        for(let repeat=0;repeat<3;repeat++){
          const probabilities=[];
          for(let offset=0;offset<speech.length;offset+=512){const frame=new Float32Array(512);frame.set(speech.subarray(offset,offset+512));probabilities.push((await model.process(frame)).isSpeech);}
          repetitions.push(probabilities);
          for(let i=0;i<1875;i++){const {isSpeech}=await model.process(new Float32Array(512));low=isSpeech<.4?low+1:0;if(resetAfterIdle&&low>=63){model.reset_state();low=0;resets++;}}
        }
        out.push({resetAfterIdle,resets,repetitions});
      }
    }finally{await model.release();}return out;
  },pcm.toString('base64'));
  const record=evidence.startCase('history',{source:process.env.VOICE_FIXTURE_PCM,negativeAudioSeconds:600,betweenUtterancesSeconds:60,accelerated:true,cases});record.outcome='measured';evidence.finish('measured');
  const summary=cases.map(c=>({...c,repetitions:c.repetitions.map(p=>{let run=0,maxInternalLowMs=0;const last=p.findLastIndex(x=>x>=.4),first=p.findIndex(x=>x>=.6);for(const x of p.slice(first,last+1)){run=x<.4?run+32:0;maxInternalLowMs=Math.max(maxInternalLowMs,run);}return {firstAboveMs:first*32,lastAboveMs:last*32,maxInternalLowMs,maximum:Math.max(...p)};})}));
  console.log(JSON.stringify({artifacts:evidence.directory,summary}));
  if(process.env.VOICE_ASSERT_CONTINUITY==='1')for(const row of summary)for(const utterance of row.repetitions)assert.ok(utterance.maxInternalLowMs<END_SILENCE_SECONDS*1000,'Current endpoint must preserve the declared pause after extended negative input');
}catch(error){evidence.finish('failed',error);throw error;}finally{await browser.close();}
