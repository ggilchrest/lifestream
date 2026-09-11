// Real browser and provider path, synthetic input only. No microphone permission.
import assert from 'node:assert/strict';
import {VoiceEvidence} from './voice-evidence.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const evidence=new VoiceEvidence('browser-voice');
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
let record;
await page.exposeFunction('__recordVoiceEvent',event=>evidence.event(record,event));
await page.addInitScript(()=>{
  const originalFetch=window.fetch;
  window.fetch=async(...args)=>{
    const response=await originalFetch(...args);
    if(String(args[0]).endsWith('/api/runtime/v1/tts')&&response.ok){
      window.voiceReceiptDone=(async()=>{const reader=response.clone().body.getReader(),decoder=new TextDecoder();let pending='';try{while(true){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});const lines=pending.split('\n');pending=lines.pop();for(const line of lines)if(line)await window.__recordVoiceEvent(JSON.parse(line));}}finally{reader.releaseLock();}})();
    }
    return response;
  };
  window.playbackEvidence={sources:0,ended:0,maxAheadSeconds:0,firstStartMs:null,maxGapSeconds:0,cursor:null};
  const start=AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start=function(when,...rest){
    const evidence=window.playbackEvidence,now=this.context.currentTime;
    evidence.sources++;evidence.firstStartMs??=performance.now()+(when-now)*1000;
    evidence.maxAheadSeconds=Math.max(evidence.maxAheadSeconds,when+(this.buffer?.duration||0)-now);
    if(evidence.cursor!==null)evidence.maxGapSeconds=Math.max(evidence.maxGapSeconds,when-evidence.cursor);
    evidence.cursor=when+(this.buffer?.duration||0);this.addEventListener('ended',()=>evidence.ended++,{once:true});
    return start.call(this,when,...rest);
  };
});
try{
  await page.goto(process.env.VOICE_TEST_URL||'http://127.0.0.1:3910/control/conversation.html');
  await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Connected');
  if(process.env.VOICE_TEST_PROFILE){await page.locator('#runtime-profile').selectOption(process.env.VOICE_TEST_PROFILE);await page.locator('#apply-profile').click();await page.waitForFunction(profile=>document.querySelector('#active-profile-badge').textContent===profile,process.env.VOICE_TEST_PROFILE,{timeout:15000});}
  const vad=await page.evaluate(async()=>{
    const {SileroV5}=await import('/control/vad-bundle.js');
    ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths='/control/';
    const {withSileroContext}=await import('/control/vad-context.js');
    const model=withSileroContext(await SileroV5.new(ort,async()=>{const r=await fetch('/control/silero_vad_v5.onnx');return r.arrayBuffer();}));
    let maximum=0;const start=performance.now();
    try{for(let i=0;i<100;i++){const {isSpeech}=await model.process(new Float32Array(512));maximum=Math.max(maximum,isSpeech);}}
    finally{await model.release();}
    return {frames:100,maximum,elapsedMs:performance.now()-start,claim:'3.2 seconds digital silence only; not a room-noise corpus'};
  });
  assert.ok(vad.maximum<.4,JSON.stringify(vad));
  record=evidence.startCase('preview',{profile:await page.locator('#runtime-profile').inputValue(),vad});
  const spokenText=process.env.VOICE_TEST_TEXT||'The package will arrive tomorrow. Please leave it beside the front door.';
  await page.locator('#voice-preview-text').fill(spokenText);
  assert.equal(await page.locator('#voice-preview-text').inputValue(),spokenText,'browser must not shorten the test corpus');record.configuration.text=spokenText;
  record.playRequestMs=await page.evaluate(()=>performance.now());
  await page.locator('#tts-test').click();
  await page.waitForFunction(()=>/browser playback finished|TTS failed/.test(document.querySelector('#events').textContent),{},{timeout:190000});
  const status=await page.locator('#events').textContent();
  const playback=await page.evaluate(async()=>{await window.voiceReceiptDone;return window.playbackEvidence;});
  record.playback=playback;record.requestToScheduledStartMs=playback.firstStartMs-record.playRequestMs;
  evidence.finish('inProgress');
  assert.equal(playback.ended,playback.sources);assert.ok(playback.sources>0);assert.ok(playback.maxAheadSeconds<3.5,JSON.stringify(playback));
  assert.match(status,/browser playback finished/);assert.deepEqual(errors,[]);
  if(process.env.VOICE_MIN_AUDIO_SECONDS)assert.ok(record.samples/48000>=Number(process.env.VOICE_MIN_AUDIO_SECONDS),'actual decoded duration is shorter than the declared long case');
  assert.ok(playback.maxGapSeconds<=.25,`browser starvation ${playback.maxGapSeconds.toFixed(3)} seconds exceeds 250 ms`);
  evidence.finish('passed');console.log(JSON.stringify({status,vad,playback,artifacts:evidence.directory,claim:'real provider to headless browser scheduled playback; no physical audibility or live microphone acceptance'}));
}catch(error){evidence.finish('failed',error);console.error(JSON.stringify({error:error.message,errors,artifacts:evidence.directory}));process.exitCode=1;}
finally{await browser.close();}
