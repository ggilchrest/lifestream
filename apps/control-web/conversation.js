import {VadStream} from './vad-stream.js';
let vadStream=null,captureContext=null;
import {SpeechGate,PRE_ROLL_FRAMES,END_SILENCE_SECONDS} from './speech-gate.js';
const speechGate=new SpeechGate(50);let voicePreRoll=[];
const fixtureHeaders={"content-type":"application/json","x-lifestream-fixture-session":"browser-conversation","x-lifestream-fixture-principal":"human"};
const $=id=>document.getElementById(id);let stream=null,audioContext=null,analyser=null,captureProcessor=null,captureChunks=[],levelFrame=0,requestController=null,ttsCursor=0,audioSocket=null,voiceSessionId=null,voiceInputId=null,voiceSequence=0,voiceOffset=0,voicePending=new Float32Array(0),voiceSpeaking=false,voiceSilenceFrames=0,voiceTurnInFlight=false,voicePendingTurns=0,bargeInSent=false,activeTraceId=null,voiceAnswer=null,activeVoiceTurn=null,voiceTurns=new Map(),activeProfile="unavailable",playingSources=new Set(),playbackTraceId=null,ttsTestRunning=false;const interruptedTraces=new Set();
const uuid=()=>crypto.randomUUID();
let cueTimer=null,cueSource=null;
function clearCue(){clearTimeout(cueTimer);cueTimer=null;if(cueSource){try{cueSource.stop()}catch{}cueSource.disconnect();cueSource=null;}}
function scheduleCue(traceId){clearCue();if(!$("delay-cue").checked)return;cueTimer=setTimeout(()=>{if(activeTraceId!==traceId||interruptedTraces.has(traceId)||playingSources.size||audioContext?.state!=="running")return;const source=audioContext.createOscillator(),gain=audioContext.createGain();source.frequency.value=440;gain.gain.setValueAtTime(.018,audioContext.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audioContext.currentTime+.08);source.connect(gain).connect(audioContext.destination);source.start();source.stop(audioContext.currentTime+.08);cueSource=source;source.onended=()=>{source.disconnect();gain.disconnect();if(cueSource===source)cueSource=null;};},900);}
$("delay-cue").addEventListener("change",clearCue);
let activeVoiceSettings={description:"",seed:0,deliveryMode:"neutral",pace:.5,energy:.4,reference:null},ttsTestController=null,referenceAudio=null,referenceGeneration=0,referenceSupported=false;
const voiceDrafts=new Map();
function readVoiceSettings(){
  const voice={description:$("voice-description").disabled?"":$("voice-description").value.trim(),seed:$("voice-seed").disabled?0:Number($("voice-seed").value),deliveryMode:$("voice-tone").value,pace:Number($("voice-pace").value),energy:Number($("voice-energy").value)};
  if(voice.description.length>300||/[()\r\n]/u.test(voice.description)||!Number.isInteger(voice.seed)||voice.seed<0||voice.seed>2147483647)throw new Error("Use a description without parentheses or line breaks, and a whole-number seed.");
  if(referenceAudio&&referenceSupported){if(!$("voice-reference-consent").checked)throw new Error("Confirm permission to use the reference voice before preview or apply.");voice.reference={...referenceAudio,transcript:$("voice-reference-transcript").value.trim(),consent:true};}else voice.reference=null;
  return voice;
}
function renderProviders(providers,profile){
  $("provider-status-title").textContent=`Readiness check: ${profile}`;
  $("provider-status").replaceChildren(...["inference","stt","tts"].map(name=>{const item=document.createElement("li"),provider=providers?.[name];item.textContent=`${name.toUpperCase()}: ${provider?.status||"unknown"}${provider?.reason?` — ${provider.reason}`:""}`;return item;}));
}
async function checkSelectedProfile(){
  $("check-profile").disabled=true;setStatus("events","Events: checking selected profile…");
  try{const selected=$("runtime-profile").value,response=await fetch("/api/runtime/v1/profile",{method:"POST",headers:fixtureHeaders,body:JSON.stringify({profile:selected,action:"check"}),signal:AbortSignal.timeout(10000)}),body=await response.json();renderProviders(body.providers,selected);if(!response.ok)throw new Error(body.message||"Profile check failed");setStatus("events",`Events: ${selected} ${body.ready?"ready to apply":"not ready; see service details"}`,body.ready?"":"error");}
  catch(error){setStatus("events",`Events: ${error.message}`,"error");}finally{$("check-profile").disabled=false;}
}
async function refreshVoiceOptions(){
  ++referenceGeneration;$("voice-reference-file").value="";$("voice-preset").value="";
  try{
    const response=await fetch("/api/runtime/v1/voice-options",{cache:"no-store",signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error("Voice capability check failed");
    const options=await response.json(),supported=options.descriptionSupported===true;referenceSupported=options.referenceSupported===true;for(const id of ["voice-reference-file","voice-reference-transcript","voice-reference-consent"])$(id).disabled=!referenceSupported;setStatus("reference-status",referenceSupported?"Reference cloning available: choose a 2–20 second clip. It is sent only when you preview or start an applied live session. Clear/reload releases it; no training or permanent save.":"Reference cloning is unavailable on this installed sidecar. No clip will be sent. Tone, pace and energy remain available.");
    for(const id of ["voice-description","voice-seed","voice-preset"])$(id).disabled=!supported;
    const draft=voiceDrafts.get(activeProfile)||{description:"",seed:0,deliveryMode:"neutral",pace:.5,energy:.4,reference:null};referenceAudio=referenceSupported?draft.reference:null;$("voice-reference-transcript").value=referenceAudio?.transcript||"";$("voice-reference-consent").checked=referenceAudio?.consent===true;
    $("voice-description").value=draft.description;$("voice-seed").value=draft.seed;$("voice-tone").value=draft.deliveryMode;$("voice-pace").value=draft.pace;$("voice-energy").value=draft.energy;
    activeVoiceSettings={...draft,description:supported?draft.description:"",seed:supported?draft.seed:0,reference:referenceSupported?draft.reference:null};
    setStatus("voice-capabilities",supported?"Description and repeatable seed supported. Tone, pace and energy are conditioning requests, not guarantees. A fixed seed is not a speaker lock.":"This sidecar supports tone, pace and energy. Description and seed are unavailable on its installed version; no fixed reference speaker is configured.");
    setStatus("voice-service-class",activeProfile==="mac-local"?"Mac-local uses sentence-batch speech generation. Long replies can pause; interactive-speed acceptance is not claimed.":"ai5090 uses incremental RTX 3080 speech generation after setup. Cold startup and response setup can be slow; readiness does not certify conversational latency.");
    setStatus("voice-settings-status",`Applied for ${activeProfile}: ${activeVoiceSettings.deliveryMode} tone. Session-test settings only.`);
  }catch(error){referenceSupported=false;referenceAudio=null;activeVoiceSettings={...activeVoiceSettings,description:"",seed:0,reference:null};for(const id of ["voice-description","voice-seed","voice-preset","voice-reference-file","voice-reference-transcript","voice-reference-consent"])$(id).disabled=true;setStatus("voice-capabilities",error.message,"error");setStatus("reference-status","Reference capability unavailable; no clip will be sent.","error");}
}
async function selectReference(){
  const generation=++referenceGeneration,file=$("voice-reference-file").files?.[0];
  referenceAudio=null;$("voice-reference-consent").checked=false;
  if(!file)return;
  try{
    if(file.size>10*1024*1024)throw new Error("Choose an audio file no larger than 10 MB.");
    setStatus("reference-status","Decoding reference locally; nothing has been sent.");
    const context=new OfflineAudioContext(1,1,16000),decoded=await context.decodeAudioData(await file.arrayBuffer());
    if(decoded.duration<2||decoded.duration>20)throw new Error("Choose a clip between 2 and 20 seconds.");
    const render=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000),source=render.createBufferSource();source.buffer=decoded;source.connect(render.destination);source.start();
    const pcm=(await render.startRendering()).getChannelData(0);
    if(generation!==referenceGeneration)return;
    referenceAudio={dataBase64:pcmBase64(pcm),sampleRateHz:16000};
    setStatus("reference-status",`Ready: ${file.name} · ${decoded.duration.toFixed(1)} s · mono 16 kHz. Confirm permission, then preview. Not uploaded yet.`);
  }catch(error){if(generation===referenceGeneration){referenceAudio=null;$("voice-reference-file").value="";setStatus("reference-status",error.message,"error");}}
}
function clearReference(){
  ++referenceGeneration;ttsTestController?.abort();stopCapture();referenceAudio=null;activeVoiceSettings.reference=null;
  for(const draft of voiceDrafts.values())draft.reference=null;
  $("voice-reference-file").value="";$("voice-reference-transcript").value="";$("voice-reference-consent").checked=false;
  setStatus("reference-status","Reference cleared from this page and the active voice session. No permanent voice was saved.");
}
$("voice-reference-file").addEventListener("change",selectReference);
$("clear-reference").addEventListener("click",clearReference);
$("voice-reference-consent").addEventListener("change",()=>{if(!$("voice-reference-consent").checked){ttsTestController?.abort();stopCapture();activeVoiceSettings.reference=null;for(const draft of voiceDrafts.values())draft.reference=null;}});
$("check-profile").addEventListener("click",checkSelectedProfile);
$("voice-preset").addEventListener("change",()=>{if($("voice-preset").value)$("voice-description").value=$("voice-preset").value;});
$("preview-voice").addEventListener("click",()=>ttsTest().catch(error=>setStatus("events",`Events: TTS failed — ${error.message}`,"error")));
$("voice-settings-form").addEventListener("submit",event=>{event.preventDefault();try{const voice=readVoiceSettings();ttsTestController?.abort();stopCapture();activeVoiceSettings=voice;voiceDrafts.set(activeProfile,{...voice});setStatus("voice-settings-status","Applied to the next live connection. Click Start microphone; current playback/capture was stopped.");}catch(error){setStatus("voice-settings-status",error.message,"error");}});

$("connect").textContent="Start microphone";
$("voice-note").textContent="The browser owns microphone capture and playback. The configured runtime provides inference, STT, and TTS when their selected providers are ready; this remains a bounded development voice surface.";
const setStatus=(id,text,kind="")=>{$(id).textContent=text;$(id).dataset.kind=kind;if(id==="events"&&text.startsWith("Events: TTS")){$("voice-settings-status").textContent=text.slice(8);$("voice-settings-status").dataset.kind=kind;}};
$("voice-sensitivity").addEventListener("input",()=>{speechGate.configure($("voice-sensitivity").value);voicePreRoll=[];setStatus("sensitivity-status",`${speechGate.sensitivity}% sensitivity · ${Math.round(speechGate.holdMs)} ms sustained onset. Silero speech probability; left is more conservative, right admits weaker evidence. Applies immediately.`);});
const inferenceLabel=body=>{const provider=body.providers?.inference,model=body.inference?.model||provider?.model||provider?.revision||"unknown model";return `${provider?.fixture?"fixture":"real"} ${provider?.implementation||"inference"} · ${model}`};
async function refreshBackend(){try{const response=await fetch("/health",{cache:"no-store"}),body=await response.json(),ready=response.ok&&body.status==="ready";if(typeof body.profile==="string"&&body.profile){activeProfile=body.profile;$("runtime-profile").value=activeProfile;$("active-profile-badge").textContent=activeProfile;setStatus("profile-status",`Active: ${activeProfile} · ${inferenceLabel(body)}`,ready?"":"error")}else setStatus("profile-status","Active profile unavailable","error");setStatus("connection",ready?"Connected":"Backend degraded",ready?"ready":"error");if(!ready)setStatus("events",`Backend: ${body.status||"unavailable"} — inference or voice services may be unavailable`,"error");renderProviders(body.providers,activeProfile);return ready}catch(error){setStatus("connection","Backend unreachable","error");setStatus("profile-status","Active profile unavailable — backend is not reachable","error");setStatus("events",`Backend: ${error.message||"health check failed"}`,"error");return false}}
const retryBackend=document.createElement("button");retryBackend.type="button";retryBackend.className="secondary";retryBackend.textContent="Retry backend connection";$("connection").after(retryBackend);retryBackend.addEventListener("click",refreshBackend);
async function applyProfile(){const requested=$("runtime-profile").value;$("apply-profile").disabled=true;ttsTestController?.abort();requestController?.abort();stopCapture();setStatus("profile-status",`Checking ${requested} providers…`);try{const response=await fetch("/api/runtime/v1/profile",{method:"POST",headers:fixtureHeaders,body:JSON.stringify({profile:requested})}),body=await response.json();renderProviders(body.providers,requested);if(!response.ok){$("runtime-profile").value=activeProfile;const unavailable=Object.values(body.providers||{}).filter(provider=>provider.required&&provider.status!=="healthy").map(provider=>provider.id).join(", ");throw new Error(body.message||`${requested} unavailable${unavailable?`: ${unavailable}`:""}`)}await refreshBackend();await refreshVoiceOptions();setStatus("events",`Events: switched to ${requested} — click Start microphone for a new voice session`)}catch(error){setStatus("profile-status",`Active: ${activeProfile} · requested profile was not applied`,"error");setStatus("events",`Events: profile switch failed — ${error.message||"unknown error"}`,"error")}finally{$("apply-profile").disabled=false}}
const trimHistory=node=>{while(node.children.length>100)node.firstElementChild.remove();};
const rememberTurn=(id,node)=>{voiceTurns.set(id,node);while(voiceTurns.size>64)voiceTurns.delete(voiceTurns.keys().next().value);};
const addMessage=(role,text)=>{const node=document.createElement("article");node.className=`message ${role}`;node.innerHTML=`<strong>${role==="user"?"You":"Assistant"}</strong><pre></pre>`;node.querySelector("pre").textContent=text;$("messages").append(node);trimHistory($("messages"));node.scrollIntoView({block:"end"});return node.querySelector("pre")};
async function refreshDevices(){if(!navigator.mediaDevices?.enumerateDevices)return;const devices=await navigator.mediaDevices.enumerateDevices();$("microphone").replaceChildren(...devices.filter(device=>device.kind==="audioinput").map((device,index)=>{const option=document.createElement("option");option.value=device.deviceId;option.textContent=device.label||`Microphone ${index+1}`;return option}))}
function meter(){if(!analyser)return;const data=new Uint8Array(analyser.frequencyBinCount);analyser.getByteTimeDomainData(data);const rms=Math.sqrt(data.reduce((sum,value)=>sum+(value-128)**2,0)/data.length)/128;$("level").style.width=`${Math.min(100,Math.round(rms*220))}%`;levelFrame=requestAnimationFrame(meter)}
async function connect(){if(!window.isSecureContext){setStatus("permission","Microphone requires a trustworthy localhost origin.","error");return}if(!navigator.mediaDevices?.getUserMedia){setStatus("permission","This browser does not expose getUserMedia.","error");return}try{stream=await navigator.mediaDevices.getUserMedia({audio:{...($("microphone").value?{deviceId:{exact:$("microphone").value}}:{}),channelCount:1,sampleRate:16000,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});captureChunks=[];audioContext??=new AudioContext();await audioContext.resume();captureContext=new AudioContext({sampleRate:16000});if(captureContext.sampleRate!==16000)throw new Error("16 kHz capture context unavailable");await captureContext.resume();vadStream=await VadStream.create(captureVoiceChunk,error=>{stopCapture();setStatus("events",`Speech detection unavailable: ${error.message}`,"error");});await openVoiceSocket();const track=stream.getAudioTracks()[0],settings=track.getSettings();setStatus("permission",`Microphone permission: granted (${settings.sampleRate||"browser"} Hz → native 16 kHz; AEC ${settings.echoCancellation??"unknown"}, noise suppression ${settings.noiseSuppression??"unknown"}, gain control ${settings.autoGainControl??"unknown"})`);setStatus("capture","Capture: running");$("connect").disabled=true;$("stop-capture").disabled=false;$("mute").disabled=false;const source=captureContext.createMediaStreamSource(stream);analyser=captureContext.createAnalyser();analyser.fftSize=512;source.connect(analyser);captureProcessor=captureContext.createScriptProcessor(1024,1,1);captureProcessor.onaudioprocess=event=>{if(stream){const chunk=new Float32Array(event.inputBuffer.getChannelData(0));captureChunks.push(chunk);if(captureChunks.length>Math.ceil(16000*30/1024))captureChunks.shift();vadStream?.push(chunk)}};source.connect(captureProcessor);const silent=captureContext.createGain();silent.gain.value=0;captureProcessor.connect(silent).connect(captureContext.destination);cancelAnimationFrame(levelFrame);meter();await refreshDevices()}catch(error){audioSocket?.close();stopCapture();setStatus("permission",`Voice connection failed: ${error.name||"failed"} — ${error.message||"request failed"}`,"error")}}
function stopCapture(){vadStream?.close();vadStream=null;void captureContext?.close();captureContext=null;captureChunks=[];interruptedTraces.clear();speechGate.reset();voicePreRoll=[];if(audioSocket?.readyState===WebSocket.OPEN&&voiceInputId)audioSocket.send(JSON.stringify({type:"stop",audioInputId:voiceInputId}));audioSocket?.close();audioSocket=null;stopPlayback();stream?.getTracks().forEach(track=>track.stop());captureProcessor?.disconnect();captureProcessor=null;stream=null;analyser=null;voiceSpeaking=false;voiceTurnInFlight=false;voicePendingTurns=0;activeTraceId=null;bargeInSent=false;voiceTurns.clear();voiceAnswer=null;activeVoiceTurn=null;cancelAnimationFrame(levelFrame);$("level").style.width="0";setStatus("capture","Capture: stopped");setVoiceState("ready");$("connect").disabled=false;$("stop-capture").disabled=true;$("mute").disabled=true}
async function speakerTest(){audioContext??=new AudioContext();await audioContext.resume();const oscillator=audioContext.createOscillator(),gain=audioContext.createGain();gain.gain.value=.04;oscillator.frequency.value=660;oscillator.connect(gain).connect(audioContext.destination);oscillator.start();oscillator.stop(audioContext.currentTime+.18);setStatus("events","Events: local speaker test played")}
const pcmToBuffer=(base64,sampleRate)=>{const bytes=Uint8Array.from(atob(base64),character=>character.charCodeAt(0)),view=new DataView(bytes.buffer),buffer=audioContext.createBuffer(1,bytes.byteLength/2,sampleRate),channel=buffer.getChannelData(0);for(let index=0;index<channel.length;index++)channel[index]=view.getInt16(index*2,true)/32768;return buffer};
const pcmBase64=samples=>{const bytes=new Uint8Array(samples.length*2),view=new DataView(bytes.buffer);for(let index=0;index<samples.length;index++)view.setInt16(index*2,Math.max(-32768,Math.min(32767,Math.round(samples[index]*32767))),true);let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary)};
const resample16k=(samples,inputRate)=>{if(inputRate===16000)return samples;const output=new Float32Array(Math.floor(samples.length*16000/inputRate));for(let index=0;index<output.length;index++)output[index]=samples[Math.min(samples.length-1,Math.floor(index*inputRate/16000))];return output};
const stopPlayback=()=>{clearCue();for(const source of playingSources){try{source.stop()}catch{}source.disconnect()}playingSources.clear();ttsCursor=audioContext?.currentTime||0};
const playVoiceChunk=chunk=>{clearCue();
  if(!audioContext)throw new Error("Audio output is not initialized");
  if(audioContext.state!=="running")throw new Error("Audio output is suspended; click Speaker test to resume");
  if(ttsCursor-audioContext.currentTime>3)throw new Error("Browser audio lookahead exceeded 3 seconds; stop and retry");
  const buffer=pcmToBuffer(chunk.frame.dataBase64,chunk.frame.format.sampleRateHz),source=audioContext.createBufferSource();
  source.buffer=buffer;source.connect(audioContext.destination);
  ttsCursor=Math.max(ttsCursor,audioContext.currentTime+.25);source.start(ttsCursor);ttsCursor+=buffer.duration;
  playingSources.add(source);setStatus("events",`Events: playing speech (${playingSources.size} audio chunks queued)`);
  source.addEventListener("ended",()=>{
    playingSources.delete(source);source.disconnect();
    if(!playingSources.size){playbackTraceId=null;if(stream&&!voiceTurnInFlight)setVoiceState("listening");}
  },{once:true});
};
const transcriptTurn=(role,text,state="live")=>{const empty=$("transcript-empty");empty?.remove();const node=document.createElement("li");node.className=`voice-turn ${role}`;node.dataset.state=state;node.innerHTML=`<div class="turn-meta"><strong>${role==="user"?"You":"Assistant"}</strong><span class="turn-state"></span></div><div class="turn-text"></div>`;node.querySelector(".turn-text").textContent=text;$("voice-transcript").append(node);trimHistory($("voice-transcript"));node.scrollIntoView({block:"end"});return node};
const setVoiceState=(text,kind="")=>{
  setStatus("voice-state",`Voice state: ${text}`,kind);
  $("barge-in").textContent=stream?"Barge-in enabled":"Microphone off";
  $("barge-in").dataset.kind=kind;
};
const voiceMessage=message=>{
  if(message.type==="accepted"){voiceInputId=message.audioInputId;setStatus("events","Events: live audio transport connected");setVoiceState("listening");}
  if(message.type==="turnStarted"){activeTraceId=message.interactionTraceId;bargeInSent=false;setVoiceState("transcribing");}
  if(message.type==="error"){setStatus("events",`Events: voice error — ${message.problem?.message||"transport rejected audio"}`,"error");setVoiceState("error","error");return;}
  if(message.type==="audio"){
    if(interruptedTraces.has(message.interactionTraceId))return;
    try{playbackTraceId=message.interactionTraceId;playVoiceChunk(message.chunk);setVoiceState("speaking");}catch(error){audioSocket?.send(JSON.stringify({type:"interrupt",interactionTraceId:message.interactionTraceId,reason:"playback failure"}));interruptedTraces.add(message.interactionTraceId);if(interruptedTraces.size>128)interruptedTraces.delete(interruptedTraces.values().next().value);stopPlayback();setVoiceState("unavailable","error");setStatus("events",error.message,"error");}
  }
  if(message.type==="stopPlayback"){
    interruptedTraces.add(message.interactionTraceId);if(interruptedTraces.size>128)interruptedTraces.delete(interruptedTraces.values().next().value);stopPlayback();
    const turn=voiceTurns.get(message.interactionTraceId);
    if(turn&&!turn.classList.contains("user")){turn.dataset.state="interrupted";turn.querySelector(".turn-state").textContent="interrupted";}
    setVoiceState("listening");setStatus("events",`Events: playback stopped — ${message.reason||"interrupted"}`);
  }
  if(message.type==="transcript"){scheduleCue(message.interactionTraceId);
    activeVoiceTurn=transcriptTurn("user",message.text,"committed");rememberTurn(message.interactionTraceId,activeVoiceTurn);
    activeVoiceTurn.querySelector(".turn-state").textContent="heard";setVoiceState("thinking");
  }
  if(message.type==="response"){
    const traceId=message.event.interactionTraceId,payload=message.event.payload;
    if(payload.type==="textDelta"&&!interruptedTraces.has(traceId)){
      voiceAnswer??=addMessage("assistant","");voiceAnswer.textContent+=payload.text;
      let turn=voiceTurns.get(traceId);if(!turn||turn.classList.contains("user")){turn=transcriptTurn("assistant","");rememberTurn(traceId,turn);}
      activeVoiceTurn=turn;turn.querySelector(".turn-text").textContent+=payload.text;turn.querySelector(".turn-state").textContent="responding";
      if(!playingSources.size)setVoiceState("generating speech");
    }
    if(payload.type==="terminal"){clearCue();
      voicePendingTurns=Math.max(0,voicePendingTurns-1);voiceTurnInFlight=voicePendingTurns>0;
      const turn=voiceTurns.get(traceId);if(turn&&!turn.classList.contains("user")){turn.dataset.state=payload.state;turn.querySelector(".turn-state").textContent=payload.state;}
      activeTraceId=null;voiceAnswer=null;activeVoiceTurn=null;bargeInSent=false;
      const failed=payload.state!=="completed"&&payload.state!=="interrupted";
      if(failed){interruptedTraces.add(traceId);if(interruptedTraces.size>128)interruptedTraces.delete(interruptedTraces.values().next().value);stopPlayback();}
      setVoiceState(playingSources.size?"speaking":voiceTurnInFlight?"queued":stream?"listening":"ready",failed?"error":"");
      setStatus("events",`Events: voice ${payload.state}${failed?` — ${payload.error?.message||"speech provider failed"}`:""}`,failed?"error":"");
    }
  }
};
const openVoiceSocket=()=>new Promise((resolve,reject)=>{if(!window.WebSocket){reject(new Error("WebSocket is unavailable"));return}voiceSessionId=uuid();voiceInputId=uuid();voiceSequence=0;voiceOffset=0;voicePending=new Float32Array(0);voicePendingTurns=0;bargeInSent=false;const protocol=location.protocol==="https:"?"wss:":"ws:";const socket=audioSocket=new WebSocket(`${protocol}//${location.host}/api/runtime/v1/audio?fixtureSession=${voiceSessionId}&fixturePrincipal=human`);const timer=setTimeout(()=>{audioSocket?.close();reject(new Error("audio transport connection timed out"))},5000);audioSocket.addEventListener("open",()=>{audioSocket.send(JSON.stringify({type:"start",request:{schemaVersion:"1.0.0",requestId:uuid(),correlationId:uuid(),sessionId:voiceSessionId,expectedSessionRevision:1,endpointId:uuid(),audioInputId:voiceInputId,format:{encoding:"pcm_s16le",sampleRateHz:16000,channels:1},voiceSettings:{...activeVoiceSettings}}}));},{once:true});audioSocket.addEventListener("message",event=>{try{if(audioSocket===socket){const message=JSON.parse(event.data);voiceMessage(message);if(message.type==="accepted"){clearTimeout(timer);resolve();}if(message.type==="error")reject(new Error(message.problem?.message||"Voice connection rejected"));}}catch(error){setStatus("events",`Events: malformed audio event — ${error.message}`,"error")}});audioSocket.addEventListener("error",()=>{clearTimeout(timer);reject(new Error("audio transport failed"))});audioSocket.addEventListener("close",()=>{if(audioSocket===socket){stopCapture();setStatus("events","Events: voice disconnected — click Start microphone to reconnect","error")}})});
const sendVoiceFrame=samples=>{if(!audioSocket||audioSocket.readyState!==WebSocket.OPEN||!samples.length)return;audioSocket.send(JSON.stringify({type:"frame",audioInputId:voiceInputId,frame:{frameId:`${voiceInputId}:${voiceSequence}`,sequence:voiceSequence,format:{encoding:"pcm_s16le",sampleRateHz:16000,channels:1},sampleOffset:voiceOffset,sampleCount:samples.length,dataBase64:pcmBase64(samples)}}));voiceSequence++;voiceOffset+=samples.length};
const commitVoiceTurn=()=>{if(!voiceSpeaking||!audioSocket||audioSocket.readyState!==WebSocket.OPEN||voiceSequence===0)return;if(voicePending.length){sendVoiceFrame(voicePending);voicePending=new Float32Array(0)}audioSocket.send(JSON.stringify({type:"commitTurn",audioInputId:voiceInputId,nextSequence:voiceSequence,sampleCount:voiceOffset}));voicePendingTurns++;voiceSpeaking=false;voiceSilenceFrames=0;voiceTurnInFlight=true;voiceSequence=0;voiceOffset=0;bargeInSent=false;setVoiceState(voicePendingTurns>1?"queued":"thinking")};
const captureVoiceChunk=(chunk,probability)=>{
  if(ttsTestRunning)return;
  const inputRate=16000;
  let input=chunk;
  if(!voiceSpeaking){
    voicePreRoll.push(chunk);while(voicePreRoll.length>PRE_ROLL_FRAMES)voicePreRoll.shift();
    if(!speechGate.update(probability,chunk.length/inputRate*1000,playingSources.size>0))return;
    input=new Float32Array(voicePreRoll.reduce((sum,c)=>sum+c.length,0));let offset=0;for(const c of voicePreRoll){input.set(c,offset);offset+=c.length;}voicePreRoll=[];speechGate.reset();
    if((activeTraceId||playingSources.size)&&!bargeInSent){const interrupted=activeTraceId||playbackTraceId;if(interrupted){interruptedTraces.add(interrupted);if(interruptedTraces.size>128)interruptedTraces.delete(interruptedTraces.values().next().value);audioSocket?.send(JSON.stringify({type:"interrupt",interactionTraceId:interrupted,reason:"barge-in speech detected"}));}stopPlayback();bargeInSent=true;setVoiceState("barge-in captured");}
    voiceSpeaking=true;voiceSilenceFrames=0;
  }
  if(probability>=speechGate.negativeThreshold)voiceSilenceFrames=0;else voiceSilenceFrames++;
  const converted=resample16k(input,inputRate),merged=new Float32Array(voicePending.length+converted.length);merged.set(voicePending);merged.set(converted,voicePending.length);voicePending=merged;
  while(voicePending.length>=4800){sendVoiceFrame(voicePending.slice(0,4800));voicePending=voicePending.slice(4800);}
  if(voiceSilenceFrames*chunk.length/inputRate>=END_SILENCE_SECONDS||voiceOffset+voicePending.length>=16000*20){commitVoiceTurn();speechGate.reset();voicePreRoll=[];}
};
async function ttsTest(){
  if(ttsTestRunning)return;
  const voiceSettings=readVoiceSettings();ttsTestRunning=true;ttsTestController=new AbortController();$("tts-test").disabled=true;$("preview-voice").disabled=true;
  const track=stream?.getAudioTracks()[0],wasEnabled=track?.enabled;
  if(track)track.enabled=false;
  let reader;
  try{
    audioContext??=new AudioContext();await audioContext.resume();stopPlayback();
    if(activeTraceId)audioSocket?.send(JSON.stringify({type:"interrupt",interactionTraceId:activeTraceId,reason:"standalone TTS test"}));
    setStatus("events","Events: generating test speech…");
    const response=await fetch("/api/runtime/v1/tts",{method:"POST",headers:fixtureHeaders,signal:AbortSignal.any([AbortSignal.timeout(190000),ttsTestController.signal]),body:JSON.stringify({text:$("voice-preview-text").value.trim()||"This is a live Assistant text to speech test.",voiceSettings})});
    if(!response.ok){const problem=await response.json();throw new Error(problem.message||`TTS unavailable (${response.status})`)}
    reader=response.body.getReader();
    const decoder=new TextDecoder();let buffer="",frames=0,terminal=null;
    while(true){
      const {done,value}=await reader.read();if(done)break;
      buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop()||"";
      for(const line of lines){
        if(!line.trim())continue;const event=JSON.parse(line);
        if(event.kind==="preAudio")setStatus("events","Events: TTS pre-audio received");
        if(event.kind==="data"){playVoiceChunk({frame:event.frame});frames++}
        if(event.kind==="terminal")terminal=event;
      }
    }
    if(terminal?.outcome!=="succeeded"||!frames)throw new Error(`TTS ${terminal?.outcome||"missing terminal"} (${frames} frames)`);
    setStatus("events",`Events: TTS succeeded (${frames} frames) — playing`);
    // Keep the mic gated until actual scheduled playback ends, not HTTP EOF.
    let playbackTimer;
    try{await Promise.race([
      Promise.all([...playingSources].map(source=>new Promise(resolve=>source.addEventListener("ended",resolve,{once:true})))),
      new Promise((_,reject)=>{playbackTimer=setTimeout(()=>reject(new Error("Browser playback did not finish; check audio output and retry")),Math.min(185000,Math.max(5000,(ttsCursor-audioContext.currentTime)*1000+5000)));})
    ]);}finally{clearTimeout(playbackTimer);}
    setStatus("events",`Events: TTS succeeded (${frames} frames) — browser playback finished`);
  }catch(error){stopPlayback();throw error;
  }finally{
    if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}
    ttsTestRunning=false;ttsTestController=null;$("tts-test").disabled=false;$("preview-voice").disabled=false;if(track)track.enabled=wasEnabled;
  }
}
async function sttTest(){if(!captureChunks.length){setStatus("events","Events: capture microphone audio before running STT.","error");return}const inputRate=16000,total=captureChunks.reduce((sum,chunk)=>sum+chunk.length,0),raw=new Float32Array(total);let offset=0;for(const chunk of captureChunks){raw.set(chunk,offset);offset+=chunk.length}const samples=resample16k(raw,inputRate).slice(-480000),audioInputId=`browser-${Date.now()}`,frames=[];for(let offset=0,sequence=0;offset<samples.length;offset+=4800,sequence++){const chunk=samples.slice(offset,offset+4800);frames.push({frameId:`${audioInputId}:${sequence}`,sequence,format:{encoding:"pcm_s16le",sampleRateHz:16000,channels:1},sampleOffset:offset,sampleCount:chunk.length,dataBase64:pcmBase64(chunk)})}const response=await fetch("/api/runtime/v1/stt",{method:"POST",headers:fixtureHeaders,body:JSON.stringify({audioInputId,frames})});if(!response.ok){setStatus("events",`Events: STT unavailable (${response.status})`,"error");return}const events=(await response.text()).trim().split("\n").filter(Boolean).map(JSON.parse),data=events.find(event=>event.kind==="data"&&event.payload?.type==="committed"),terminal=events.find(event=>event.kind==="terminal");if(data?.payload?.text){addMessage("user",data.payload.text);setStatus("events",`Events: STT ${terminal?.outcome||"completed"} — committed transcript received`)}else setStatus("events",`Events: STT ${terminal?.outcome||"failed"}`,terminal?.outcome==="succeeded"?"":"error")}
async function sendMessage(event){event.preventDefault();const prompt=$("prompt").value.trim();if(!prompt)return;addMessage("user",prompt);$("prompt").value="";const answer=addMessage("assistant","");requestController=new AbortController();$("send").disabled=true;$("stop-response").disabled=false;try{const response=await fetch("/api/runtime/v1/messages",{method:"POST",headers:fixtureHeaders,body:JSON.stringify({userInput:prompt,readOnlyCapability:{name:"capability.read-only.status",input:{scope:"assistant-neutral"}}}),signal:requestController.signal});if(!response.ok)throw new Error(`Runtime returned ${response.status}`);setStatus("connection","Connected","ready");const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="";while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const frames=buffer.split("\n\n");buffer=frames.pop()||"";for(const frame of frames){const eventName=frame.match(/^event: (.+)$/m)?.[1],data=frame.match(/^data: (.+)$/m)?.[1];if(!data)continue;const payload=JSON.parse(data);if(eventName==="message.delta")answer.textContent+=payload.text||"";if(eventName==="input.manifest")setStatus("events",`Events: manifest (${payload.sections?.length||9} sections)`);if(eventName==="capability.read-only")setStatus("events","Events: harmless read-only capability selected");if(eventName==="interaction.completed"){const provider=payload.provider||{};setStatus("events",`Events: completed (${provider.profile||activeProfile} · ${provider.model||provider.implementation||"unknown"} · ${provider.fixture?"fixture":"real"})`) }if(eventName==="interaction.error")setStatus("events",`Events: runtime error — ${payload.message||"unknown error"}`,"error")}}}catch(error){if(error.name!=="AbortError")setStatus("events",`Events: ${error.message}`,"error")}finally{requestController=null;$("send").disabled=false;$("stop-response").disabled=true}}
$("connect").addEventListener("click",connect);$("stop-capture").addEventListener("click",stopCapture);$("mute").addEventListener("click",()=>{const track=stream?.getAudioTracks()[0];if(!track)return;track.enabled=!track.enabled;$("mute").textContent=track.enabled?"Mute microphone":"Unmute microphone";setStatus("capture",`Capture: ${track.enabled?"running":"muted"}`)});$("speaker-test").addEventListener("click",speakerTest);$("tts-test").addEventListener("click",()=>ttsTest().catch(error=>setStatus("events",`Events: TTS failed — ${error.message||"unknown error"}`,"error")));$("stt-test").addEventListener("click",()=>sttTest().catch(error=>setStatus("events",`Events: STT failed — ${error.message||"unknown error"}`,"error")));$("apply-profile").addEventListener("click",applyProfile);$("message-form").addEventListener("submit",sendMessage);$("stop-response").addEventListener("click",()=>requestController?.abort());refreshDevices();refreshBackend().then(refreshVoiceOptions);
