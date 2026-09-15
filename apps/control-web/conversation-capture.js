import {SpeechGate,PRE_ROLL_FRAMES,END_SILENCE_SECONDS} from './speech-gate.js';
const format={encoding:'pcm_s16le',sampleRateHz:16000,channels:1};
const pcm=samples=>{const bytes=new Uint8Array(samples.length*2),view=new DataView(bytes.buffer);for(let i=0;i<samples.length;i++)view.setInt16(i*2,Math.max(-32768,Math.min(32767,Math.round(samples[i]*32767))),true);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);};
export class VoiceFrames {
 constructor({send,inputId,playing,onBegin,onCommit}){Object.assign(this,{send,inputId,playing,onBegin,onCommit});this.gate=new SpeechGate(50);this.reset();}
 reset(){this.gate.reset();this.pre=[];this.pending=new Float32Array(0);this.sequence=0;this.samples=0;this.silence=0;this.speaking=false;}
 configure(value){this.gate.configure(value);this.pre=[];}
 frame(samples){this.send({type:'frame',audioInputId:this.inputId,frame:{frameId:crypto.randomUUID(),sequence:this.sequence++,format,sampleOffset:this.samples,sampleCount:samples.length,dataBase64:pcm(samples)}});this.samples+=samples.length;}
 push(chunk,probability){
  if(!(chunk instanceof Float32Array)||chunk.length!==512||!Number.isFinite(probability)||probability<0||probability>1)throw new Error('Invalid speech detector frame.');
  let input=chunk;
  if(!this.speaking){this.pre.push(chunk);if(this.pre.length>PRE_ROLL_FRAMES)this.pre.shift();if(!this.gate.update(probability,32,this.playing()))return;this.speaking=true;this.onBegin();input=new Float32Array(this.pre.length*512);this.pre.forEach((frame,index)=>input.set(frame,index*512));this.pre=[];this.gate.reset();}
  this.silence=probability>=this.gate.negativeThreshold?0:this.silence+512;
  const pending=new Float32Array(this.pending.length+input.length);pending.set(this.pending);pending.set(input,this.pending.length);this.pending=pending;
  while(this.pending.length>=4800){this.frame(this.pending.slice(0,4800));this.pending=this.pending.slice(4800);}
  if(this.silence/16000>=END_SILENCE_SECONDS||this.samples+this.pending.length>=16000*20){if(this.pending.length)this.frame(this.pending);this.send({type:'commitTurn',audioInputId:this.inputId,nextSequence:this.sequence,sampleCount:this.samples});this.onCommit();this.reset();}
 }
}
let detectorRuntime;
async function loadDetector(){
 if(!globalThis.ort){detectorRuntime??=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/control/ort.wasm.min.js';script.onload=resolve;script.onerror=()=>{detectorRuntime=null;script.remove();reject(new Error('Local speech detector runtime unavailable.'));};document.head.append(script);});await detectorRuntime;}
 return (await import('./vad-stream.js')).VadStream;
}
export class ConversationCapture {
 constructor({output,current,onBegin,onState,onError}){Object.assign(this,{output,current,onBegin,onState,onError});this.generation=0;this.pending=0;this.traces=new Set();}
 get active(){return !!this.stream;}
 get speaking(){return this.frames?.speaking===true;}
 async start(request){
  this.stop(false);const ticket=this.generation;let stream;
  try{
   if(!this.output.connected||!this.current())throw new Error('Current speech output is required before microphone capture.');
   stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,sampleRate:16000,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
   if(ticket!==this.generation||!this.current()){stream.getTracks().forEach(track=>track.stop());throw new Error('Microphone setup cancelled.');}
   this.stream=stream;this.onState('Starting microphone…');const audio=this.audio=new AudioContext({sampleRate:16000});await audio.resume();if(audio.sampleRate!==16000)throw new Error('Native 16 kHz microphone capture is unavailable.');
   const Vad=await loadDetector();if(ticket!==this.generation||!this.current())throw new Error('Microphone setup cancelled.');
   const inputId=this.inputId=crypto.randomUUID(),socket=this.output.socket;
   const frames=this.frames=new VoiceFrames({inputId,send:message=>{if(!this.current()||socket!==this.output.socket||socket.readyState!==WebSocket.OPEN||socket.bufferedAmount>262144)throw new Error('Microphone transport is unavailable or behind.');socket.send(JSON.stringify(message));},playing:()=>!!this.output.turn,onBegin:()=>{if(this.pending>=3)throw new Error('Voice queue is full. Stop and reconnect the microphone.');this.onBegin();this.onState('Listening to your reply…');},onCommit:()=>{this.pending++;this.onState('Processing voice reply…');}});
   const vad=await Vad.create((chunk,probability)=>{if(ticket!==this.generation)return;try{frames.push(chunk,probability);}catch(error){this.fail(error);}},error=>{if(ticket===this.generation)this.fail(error);});
   if(ticket!==this.generation||!this.current()){vad.close();throw new Error('Microphone setup cancelled.');}this.vad=vad;
   await new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);socket.removeEventListener('message',receive);socket.removeEventListener('close',closed);this.cancelStart=null;},finish=error=>{cleanup();error?reject(error):resolve();},closed=()=>finish(new Error('Microphone connection closed.')),receive=event=>{try{const value=JSON.parse(event.data);if(value.type==='accepted'&&value.audioInputId===inputId)finish();if(value.type==='error')finish(new Error(value.problem?.message||'Microphone start rejected.'));}catch(error){finish(error);}},timer=setTimeout(()=>finish(new Error('Microphone start timed out.')),5000);this.cancelStart=closed;socket.addEventListener('message',receive);socket.addEventListener('close',closed);socket.send(JSON.stringify({type:'start',request:{schemaVersion:'1.0.0',requestId:crypto.randomUUID(),correlationId:crypto.randomUUID(),...request,audioInputId:inputId,format}}));});
   if(ticket!==this.generation||!this.current())throw new Error('Microphone setup cancelled.');
   this.source=audio.createMediaStreamSource(stream);this.processor=audio.createScriptProcessor(1024,1,1);this.processor.onaudioprocess=event=>{if(ticket===this.generation)this.vad?.push(new Float32Array(event.inputBuffer.getChannelData(0)));};this.silent=audio.createGain();this.silent.gain.value=0;this.source.connect(this.processor);this.processor.connect(this.silent).connect(audio.destination);
   for(const track of stream.getTracks())track.addEventListener('ended',()=>{if(ticket===this.generation)this.fail(new Error('Microphone disconnected.'));},{once:true});
   this.onState('Microphone on · speak to reply or interrupt');
  }catch(error){stream?.getTracks().forEach(track=>track.stop());if(ticket===this.generation)this.stop();throw error;}
 }
 receive(message){if(message.type==='turnStarted'){if(!this.active||this.pending<1)throw new Error('Unexpected voice turn.');this.traces.add(message.interactionTraceId);return true;}if(message.event?.payload.type==='terminal'&&this.traces.delete(message.event.interactionTraceId)){this.pending=Math.max(0,this.pending-1);return true;}return false;}
 fail(error){this.stop();this.onError(error);}
 stop(closeOutput=true){this.generation++;this.cancelStart?.();this.cancelStart=null;this.vad?.close();this.vad=null;this.frames?.reset();this.frames=null;this.processor?.disconnect();this.processor=null;this.source?.disconnect();this.source=null;this.silent?.disconnect();this.silent=null;this.stream?.getTracks().forEach(track=>track.stop());this.stream=null;void this.audio?.close();this.audio=null;this.pending=0;this.traces.clear();this.inputId=null;if(closeOutput)this.output.close();this.onState('Microphone off');}
}
