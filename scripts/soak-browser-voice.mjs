// Opt-in wall-clock browser soak with synthetic capture, never physical input.
import {readFileSync} from 'node:fs';
import {VoiceEvidence} from './voice-evidence.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const evidence=new VoiceEvidence('browser-soak');
const seconds=Number(process.env.VOICE_SOAK_SECONDS||1800),negative=Number(process.env.VOICE_NEGATIVE_SECONDS||600);
if(!process.env.VOICE_FIXTURE_PCM)throw new Error('Provide private synthetic speech PCM (mono 48 kHz)');
const pcm=readFileSync(process.env.VOICE_FIXTURE_PCM);if(pcm.length>48000*2*30)throw new Error('Fixture exceeds 30 seconds');
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.addInitScript(({base64,negative})=>{
    let context,destination,timer,elapsed=0,replyCount=0,lastBarge=-Infinity,lastAudioTrace;
    const metrics=window.voiceSoak={turns:[],inputs:[],interrupts:[],stops:[],connections:0,playback:0,lateScheduled:0};const traces=new Map(),fenced=new Set();
    const NativeSocket=WebSocket;
    window.WebSocket=class extends NativeSocket{
      constructor(...args){super(...args);metrics.connections++;this.addEventListener('message',event=>{
        const message=JSON.parse(event.data),id=message.interactionTraceId||message.event?.interactionTraceId;
        if(message.type==='turnStarted'){const turn={id,startMs:performance.now(),referenceSpeechEndMs:metrics.inputs.at(-1)?.endMs,audioFrames:0};traces.set(id,turn);metrics.turns.push(turn);}
        const turn=traces.get(id);if(!turn)return;
        if(message.type==='transcript'){turn.transcript=message.text;turn.transcriptMs=performance.now();}
        if(message.type==='audio'){lastAudioTrace=id;turn.audioFrames++;turn.firstPcmMs??=performance.now();if(turn.audioFrames===1&&++replyCount%3===0&&performance.now()-lastBarge>45000){lastBarge=performance.now();setTimeout(()=>window.emitSpeech?.(),700);}}
        if(message.event?.payload.type==='textDelta')turn.firstTextMs??=performance.now();
        if(message.event?.payload.type==='terminal'){turn.state=message.event.payload.state;turn.error=message.event.payload.error;turn.endMs=performance.now();}
      });}
      send(value){const message=JSON.parse(value);if(message.type==='interrupt'){metrics.interrupts.push({id:message.interactionTraceId,at:performance.now()});fenced.add(message.interactionTraceId);}return super.send(value);}
    };
    const originalStart=AudioBufferSourceNode.prototype.start,originalStop=AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start=function(...args){if(this.context!==context){metrics.playback++;if(fenced.has(lastAudioTrace))metrics.lateScheduled++;const turn=traces.get(lastAudioTrace);if(turn){const when=args[0]??this.context.currentTime;turn.firstScheduledMs??=performance.now()+(when-this.context.currentTime)*1000;if(turn.cursor!==undefined)turn.maxGapSeconds=Math.max(turn.maxGapSeconds||0,when-turn.cursor);turn.cursor=when+(this.buffer?.duration||0);}}return originalStart.apply(this,args);};
    AudioBufferSourceNode.prototype.stop=function(...args){if(this.context!==context)metrics.stops.push(performance.now());return originalStop.apply(this,args);};
    navigator.mediaDevices.getUserMedia=async()=>{
      if(!context){
        context=new AudioContext();destination=context.createMediaStreamDestination();await context.resume();
        const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer),speech=context.createBuffer(1,bytes.length/2,48000);
        for(let i=0;i<speech.length;i++)speech.getChannelData(0)[i]=view.getInt16(i*2,true)/32768;
        window.emitSpeech=()=>{const s=context.createBufferSource();s.buffer=speech;s.connect(destination);metrics.inputs.push({startMs:performance.now(),endMs:performance.now()+speech.duration*1000});s.start();s.onended=()=>s.disconnect();};
        let seed=41;
        const noise=context.createBuffer(1,context.sampleRate*2,context.sampleRate),data=noise.getChannelData(0);
        for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=(seed/4294967296-.5)*.004;if(i%12000<20)data[i]+=.05*Math.exp(-(i%12000)/5);}
        timer=setInterval(()=>{
          const source=context.createBufferSource();source.buffer=elapsed<negative?noise:speech;source.connect(destination);source.start();source.onended=()=>source.disconnect();
          elapsed+=elapsed<negative?2:60;
          if(elapsed>=negative){clearInterval(timer);timer=setInterval(()=>window.emitSpeech(),60000);}
        },2000);
        window.stopSyntheticCapture=()=>{clearInterval(timer);void context.close();};
      }
      return destination.stream.clone();
    };
  },{base64:pcm.toString('base64'),negative});
  await page.goto(process.env.VOICE_TEST_URL||'http://127.0.0.1:3910/control/conversation.html');
  await page.waitForFunction(()=>document.querySelector('#connection').textContent==='Connected');
  if(process.env.VOICE_TEST_PROFILE){await page.locator('#runtime-profile').selectOption(process.env.VOICE_TEST_PROFILE);await page.locator('#apply-profile').click();await page.waitForFunction(profile=>document.querySelector('#active-profile-badge').textContent===profile,process.env.VOICE_TEST_PROFILE);}
  await page.locator('#connect').click();
  await page.waitForFunction(()=>document.querySelector('#capture').textContent==='Capture: running',null,{timeout:15000});
  const record=evidence.startCase('mixed',{seconds,negative,profile:await page.locator('#runtime-profile').inputValue(),fixture:'private synthesized speech; deterministic low room-noise-like signal and impulses, not physical noise',noPhysicalMicrophone:true});
  const start=performance.now();let lastCount=0,nextReconnect=negative+300;
  while(performance.now()-start<seconds*1000){
    await new Promise(resolve=>setTimeout(resolve,10000));
    const elapsed=(performance.now()-start)/1000;
    const state=await page.evaluate(()=>({capture:document.querySelector('#capture').textContent,events:document.querySelector('#events').textContent,turns:window.voiceSoak.turns.length,heap:performance.memory?.usedJSHeapSize??null,metrics:window.voiceSoak}));
    const {metrics,...observation}=state;record.metrics=metrics;record.observations??=[];record.observations.push({elapsed,...observation});evidence.finish('inProgress');
    if(errors.length||state.capture!=='Capture: running')throw new Error(JSON.stringify({errors,state}));
    const failed=metrics.turns.filter(turn=>turn.state==='failed');if(failed.length)throw new Error(JSON.stringify(failed));
    if(metrics.lateScheduled)throw new Error('Late fenced audio was scheduled');
    if(elapsed<negative&&state.turns)throw new Error('Synthetic negative input produced an authoritative turn');
    if(elapsed>negative+150&&state.turns===lastCount&&state.turns===0)throw new Error('Synthetic speech did not become a turn');
    lastCount=state.turns;
    if(elapsed>=nextReconnect){await page.locator('#stop-capture').click();await page.locator('#connect').click();await page.waitForFunction(()=>document.querySelector('#capture').textContent==='Capture: running',null,{timeout:15000});record.reconnections=(record.reconnections||0)+1;nextReconnect+=300;}
  }
  await page.locator('#stop-capture').click();
  if(!record.metrics.turns.some(turn=>turn.state==='completed'&&turn.audioFrames>0)||!record.metrics.playback||!record.metrics.interrupts.length||!record.reconnections)throw new Error('Missing complete voiced turn, playback, qualified barge-in, or reconnect');
  evidence.finish('passed');console.log(JSON.stringify({outcome:'passed',artifacts:evidence.directory,claim:'specified synthetic mixed browser run only; not physical AEC or perception'}));
}catch(error){evidence.finish('failed',error);console.error(JSON.stringify({error:error.message,artifacts:evidence.directory}));process.exitCode=1;}
finally{await page.evaluate(()=>window.stopSyntheticCapture?.()).catch(()=>{});await browser.close();}
