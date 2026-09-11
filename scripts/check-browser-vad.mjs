import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {VoiceEvidence} from './voice-evidence.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const pcm=readFileSync(process.env.VOICE_FIXTURE_PCM);if(pcm.length>48000*2*30)throw new Error('Speech fixture exceeds 30 seconds');
const evidence=new VoiceEvidence('browser-vad'),browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage();await page.goto(process.env.VOICE_TEST_URL||'http://127.0.0.1:3910/control/conversation.html');
  const result=await page.evaluate(async({base64,noiseFixture})=>{
    const {SileroV5}=await import('/control/vad-bundle.js'),{SpeechGate,PRE_ROLL_FRAMES}=await import('/control/speech-gate.js');
    ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths='/control/';
    const {withSileroContext}=await import('/control/vad-context.js');
    const model=withSileroContext(await SileroV5.new(ort,async()=>{const r=await fetch('/control/silero_vad_v5.onnx');return r.arrayBuffer();}));
    const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);
    const context=new OfflineAudioContext(1,Math.ceil(bytes.length/6),16000),audio=context.createBuffer(1,bytes.length/2,48000);
    for(let i=0;i<audio.length;i++)audio.getChannelData(0)[i]=view.getInt16(i*2,true)/32768;
    const source=context.createBufferSource();source.buffer=audio;source.connect(context.destination);source.start();const speech=(await context.startRendering()).getChannelData(0);
    const silence=new Float32Array(16000*10),impulses=new Float32Array(silence.length),room=new Float32Array(silence.length);let seed=13;
    for(let i=0;i<room.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;room[i]=(seed/4294967296-.5)*.008;if(i%8000<16)impulses[i]=.1*Math.exp(-(i%8000)/4);}
    const cases=[];
    try{for(const [name,samples] of [['silence',silence],['synthetic-key-impulses',impulses],['synthetic-room-noise',room],[noiseFixture?'provided-noise':'normal-synthetic-speech',speech],[noiseFixture?'quiet-provided-noise':'quiet-synthetic-speech',speech.map(x=>x*.1)]]){
      model.reset_state();const gate=new SpeechGate(50),bargeGate=new SpeechGate(50);let qualified=0,bargeQualified=0,first=null,maximum=0;
      for(let offset=0;offset<samples.length;offset+=512){const frame=new Float32Array(512);frame.set(samples.subarray(offset,offset+512));const {isSpeech}=await model.process(frame);maximum=Math.max(maximum,isSpeech);if(gate.update(isSpeech,32)){qualified++;first??=offset/16;}if(bargeGate.update(isSpeech,32,true))bargeQualified++;}
      const active=samples.findIndex(value=>Math.abs(value)>.0005),retainedStartMs=first===null?null:Math.max(0,first+32-PRE_ROLL_FRAMES*32);
      cases.push({name,qualifiedFrames:qualified,bargeQualifiedFrames:bargeQualified,firstQualifiedMs:first,maximumProbability:maximum,durationSeconds:samples.length/16000,firstActiveMs:active<0?null:active/16,retainedStartMs});
    }}finally{await model.release();}
    return cases;
  },{base64:pcm.toString('base64'),noiseFixture:process.env.VOICE_NOISE_FIXTURE==='1'});
  const record=evidence.startCase('corpus',{source:process.env.VOICE_FIXTURE_PCM,cases:result,claim:'specified provided fixture plus synthetic baselines through real browser Silero; not physical AEC or a universal noise claim'});
  for(const row of result)assert.ok(row.name.includes('speech')?row.qualifiedFrames>0:row.qualifiedFrames===0,JSON.stringify(row));
  for(const row of result.filter(row=>!row.name.includes('speech')))assert.equal(row.bargeQualifiedFrames,0,JSON.stringify(row));
  for(const row of result.filter(row=>row.name.includes('speech')))assert.ok(row.retainedStartMs<=row.firstActiveMs,`fixture onset falls outside retained pre-roll: ${JSON.stringify(row)}`);
  record.outcome='passed';evidence.finish('passed');console.log(JSON.stringify({result,artifacts:evidence.directory}));
}catch(error){evidence.finish('failed',error);console.error(JSON.stringify({error:error.message,artifacts:evidence.directory}));process.exitCode=1;}
finally{await browser.close();}
