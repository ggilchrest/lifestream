// Real Web Audio/Silero capture seam with a recording-only fixture socket.
// Does not exercise inference, TTS, a physical microphone or full conversation.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {VoiceEvidence} from './voice-evidence.mjs';
const pcm=readFileSync(process.env.VOICE_FIXTURE_PCM);assert.ok(pcm.length<=48000*2*30);
const repeats=Number(process.env.VOICE_CAPTURE_REPEATS||1);assert.ok(Number.isInteger(repeats)&&repeats>0&&repeats<=10);
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const evidence=new VoiceEvidence('browser-capture');
try{
  const page=await browser.newPage();
  await page.addInitScript(base64=>{
    let context,destination,buffer;window.capturedTurns=[];window.captureTrace=[];
    class CaptureSocket extends EventTarget{
      static OPEN=1;static CLOSED=3;
      constructor(){super();this.readyState=0;this.frames=[];queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
      emit(message){queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(message)})));}
      send(value){const m=JSON.parse(value);if(m.type==='start')this.emit({type:'accepted',audioInputId:m.request.audioInputId});if(m.type==='frame')this.frames.push(m.frame);if(m.type==='commitTurn'){window.capturedTurns.push(this.frames);window.captureTrace.push({at:performance.now(),samples:m.sampleCount});this.frames=[];this.emit({type:'response',event:{interactionTraceId:crypto.randomUUID(),payload:{type:'terminal',state:'completed'}}});}}
      close(){if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>this.dispatchEvent(new Event('close')));}
    }
    window.WebSocket=CaptureSocket;
    navigator.mediaDevices.getUserMedia=async()=>{
      context=new AudioContext();destination=context.createMediaStreamDestination();await context.resume();
      const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);buffer=context.createBuffer(1,bytes.length/2,48000);
      for(let i=0;i<buffer.length;i++)buffer.getChannelData(0)[i]=view.getInt16(i*2,true)/32768;
      window.emitCapture=()=>{const source=context.createBufferSource();source.buffer=buffer;source.connect(destination);window.inputStarted=performance.now();source.start();source.onended=()=>source.disconnect();};
      window.closeCaptureFixture=()=>context.close();return destination.stream;
    };
  },pcm.toString('base64'));
  await page.goto(process.env.VOICE_TEST_URL||'http://127.0.0.1:3910/control/conversation.html');
  await page.evaluate(async()=>{const {VadStream}=await import('/control/vad-stream.js'),create=VadStream.create;window.vadTrace=[];VadStream.create=async(onFrame,onError)=>create.call(VadStream,(frame,p)=>{window.vadTrace.push({at:performance.now(),p});onFrame(frame,p);},onError);});
  await page.locator('#connect').click();await page.waitForFunction(()=>document.querySelector('#capture').textContent==='Capture: running');
  const inputStarts=[];
  for(let i=0;i<repeats;i++){inputStarts.push(await page.evaluate(()=>{window.emitCapture();return window.inputStarted;}));await new Promise(resolve=>setTimeout(resolve,pcm.length/96+1800));}
  const result=await page.evaluate(()=>({turns:window.capturedTurns,timing:window.captureTrace,inputStarted:window.inputStarted,vad:window.vadTrace,events:document.querySelector('#events').textContent}));
  const diagnostic=evidence.startCase('capture-diagnostic',{inputStarts,repeats,vad:result.vad});diagnostic.outcome='measured';
  for(const [index,frames] of result.turns.entries()){const record=evidence.startCase(`turn-${index}`,{format:'mono 16 kHz s16le',input:process.env.VOICE_FIXTURE_PCM,timing:result.timing[index],inputStarted:result.inputStarted});for(const frame of frames)evidence.event(record,{kind:'data',frame});record.outcome='captured';}
  evidence.finish('measured');console.log(JSON.stringify({turns:result.turns.map(frames=>frames.reduce((n,f)=>n+f.sampleCount,0)),timing:result.timing,inputStarts,events:result.events,artifacts:evidence.directory}));
  if(process.env.VOICE_EXPECT_SINGLE_TURN==='1'){assert.equal(result.turns.length,repeats,'Each fixture must produce exactly one committed turn');for(let i=0;i<repeats;i++){assert.ok(result.timing[i].at>=inputStarts[i]+pcm.length/96-200,'Must retain the end of each phrase');assert.ok(result.timing[i].at<inputStarts[i]+pcm.length/96+1800,'Must commit each phrase before the next input');}}
  await page.locator('#stop-capture').click();await page.evaluate(()=>window.closeCaptureFixture());
}catch(error){evidence.finish('failed',error);throw error;}finally{await browser.close();}
