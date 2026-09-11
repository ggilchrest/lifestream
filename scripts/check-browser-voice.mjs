// Real browser and provider path, synthetic input only. No microphone permission.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VoiceEvidence} from './voice-evidence.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const evidence=new VoiceEvidence('browser-voice');
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
const fixtureTransport=process.env.VOICE_FIXTURE_TRANSPORT==='1';
if(fixtureTransport){
  const pcm=readFileSync(process.env.VOICE_FIXTURE_PCM);assert.ok(pcm.length>96000&&pcm.length<=48000*2*20&&pcm.length%2===0);
  await page.addInitScript(({base64})=>{
    const original=window.fetch,bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    window.fetch=async(input,options={})=>{
      if(!String(input).endsWith('/api/runtime/v1/tts'))return original(input,options);
      let timer,stopped=false;
      const body=new ReadableStream({
        start(controller){
          const encoder=new TextEncoder();let offset=0,sequence=0;
          const emit=event=>controller.enqueue(encoder.encode(JSON.stringify(event)+'\n'));
          const abort=()=>{if(stopped)return;stopped=true;clearTimeout(timer);controller.error(new DOMException('Fixture transport cancelled','AbortError'));};
          if(options.signal?.aborted){abort();return;}options.signal?.addEventListener('abort',abort,{once:true});
          const next=()=>{
            if(stopped)return;
            if(offset===bytes.length){emit({kind:'terminal',sequence,outcome:'succeeded',outputSamples:offset/2,frameCount:sequence});stopped=true;options.signal?.removeEventListener('abort',abort);controller.close();return;}
            const chunk=bytes.slice(offset,offset+7680);
            emit({kind:'data',sequence,frame:{format:{encoding:'pcm_s16le',sampleRateHz:48000,channels:1},sampleCount:chunk.length/2,sampleOffset:offset/2,dataBase64:btoa(String.fromCharCode(...chunk))}});
            offset+=chunk.length;timer=setTimeout(next,[70,90,60,100][sequence++%4]);
          };next();
        },
        cancel(){stopped=true;clearTimeout(timer);}
      });
      return new Response(body,{status:200,headers:{'content-type':'application/x-ndjson'}});
    };
  },{base64:pcm.toString('base64')});
}
let record;
await page.exposeFunction('__recordVoiceEvent',event=>evidence.event(record,event));
await page.addInitScript(()=>{
  const originalFetch=window.fetch;
  window.fetch=async(...args)=>{
    const response=await originalFetch(...args);
    if(String(args[0]).endsWith('/api/runtime/v1/tts')&&response.ok){
      window.voiceReceiptDone=(async()=>{const reader=response.clone().body.getReader(),decoder=new TextDecoder();let pending='';try{while(true){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});const lines=pending.split('\n');pending=lines.pop();for(const line of lines)if(line)await window.__recordVoiceEvent(JSON.parse(line));}}finally{reader.releaseLock();}})();
      void window.voiceReceiptDone.catch(()=>{}); // observed below, including intentional cancellation
    }
    return response;
  };
  window.playbackEvidence={sources:0,ended:0,stops:[],maxAheadSeconds:0,firstStartMs:null,maxGapSeconds:0,cursor:null};
  const stop=AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop=function(...args){window.playbackEvidence.stops.push(performance.now());return stop.apply(this,args);};
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
  record=evidence.startCase('preview',{profile:await page.locator('#runtime-profile').inputValue(),vad,fixtureTransport,...(fixtureTransport?{fixtureSource:process.env.VOICE_FIXTURE_PCM,transportJitterMs:[70,90,60,100]}:{})});
  const spokenText=process.env.VOICE_TEST_TEXT||'The package will arrive tomorrow. Please leave it beside the front door.';
  await page.locator('#voice-preview-text').fill(spokenText);
  assert.equal(await page.locator('#voice-preview-text').inputValue(),spokenText,'browser must not shorten the test corpus');record.configuration.text=spokenText;
  record.playRequestMs=await page.evaluate(()=>performance.now());
  await page.locator('#tts-test').click();
  if(process.env.VOICE_CANCEL_AFTER_SECONDS){
    const after=Number(process.env.VOICE_CANCEL_AFTER_SECONDS);assert.ok(after>=1&&after<=90);
    await page.waitForFunction(after=>window.playbackEvidence.firstStartMs!==null&&performance.now()-window.playbackEvidence.firstStartMs>=after*1000,after,{timeout:150000});
    assert.match(await page.locator('#events').textContent(),/playing|generating/,'request must still be active at the late cancellation');
    const fence=await page.evaluate(()=>{const at=performance.now();document.querySelector('#voice-settings-form').requestSubmit();return {at,sources:window.playbackEvidence.sources};});
    await page.waitForFunction(()=>!document.querySelector('#tts-test').disabled);
    await page.evaluate(async()=>{await window.voiceReceiptDone.catch(()=>{});});
    await new Promise(resolve=>setTimeout(resolve,500));
    const stopped=await page.evaluate(()=>window.playbackEvidence);
    record.playback=stopped;record.cancelAfterSeconds=after;record.fence=fence;record.outcome='cancelled';
    assert.ok(record.samples/48000>=after,'late cancellation must follow the declared amount of real speech, not a long stall');
    assert.equal(stopped.sources,fence.sources,'no old audio may be scheduled after the render fence');
    const stops=stopped.stops.filter(at=>at>=fence.at);assert.ok(stops.length,'queued browser sources must be stopped');
    record.cancelToLastStopMs=Math.max(...stops)-fence.at;assert.ok(record.cancelToLastStopMs<=250);
    // Same page/profile, fresh request after cancellation; no model restart.
    record=evidence.startCase('recovery',{profile:await page.locator('#runtime-profile').inputValue(),text:'The voice is ready for another turn.',fixtureTransport,...(fixtureTransport?{fixtureSource:process.env.VOICE_FIXTURE_PCM,fixtureOverridesText:true}:{})});
    await page.evaluate(()=>{window.playbackEvidence={sources:0,ended:0,stops:[],maxAheadSeconds:0,firstStartMs:null,maxGapSeconds:0,cursor:null};});
    await page.locator('#voice-preview-text').fill(record.configuration.text);
    record.playRequestMs=await page.evaluate(()=>performance.now());
    await page.locator('#tts-test').click();
  }
  await page.waitForFunction(()=>/browser playback finished|TTS failed/.test(document.querySelector('#events').textContent),{},{timeout:190000});
  const status=await page.locator('#events').textContent();
  const playback=await page.evaluate(async()=>{await window.voiceReceiptDone;return window.playbackEvidence;});
  record.playback=playback;record.requestToScheduledStartMs=playback.firstStartMs-record.playRequestMs;
  evidence.finish('inProgress');
  assert.equal(playback.ended,playback.sources);assert.ok(playback.sources>0);assert.ok(playback.maxAheadSeconds<3.5,JSON.stringify(playback));
  assert.match(status,/browser playback finished/);assert.deepEqual(errors,[]);
  if(process.env.VOICE_MIN_AUDIO_SECONDS&&!process.env.VOICE_CANCEL_AFTER_SECONDS)assert.ok(record.samples/48000>=Number(process.env.VOICE_MIN_AUDIO_SECONDS),'actual decoded duration is shorter than the declared long case');
  assert.ok(playback.maxGapSeconds<=.25,`browser starvation ${playback.maxGapSeconds.toFixed(3)} seconds exceeds 250 ms`);
  evidence.finish('passed');console.log(JSON.stringify({status,vad,playback,artifacts:evidence.directory,claim:fixtureTransport?'Known private PCM through deterministic jitter and actual browser scheduling; fixture transport, not provider acceptance':'real provider to headless browser scheduled playback; no physical audibility or live microphone acceptance'}));
}catch(error){evidence.finish('failed',error);console.error(JSON.stringify({error:error.message,errors,artifacts:evidence.directory}));process.exitCode=1;}
finally{await browser.close();}
