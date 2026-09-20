// Output-only use of the existing runtime audio protocol. This class never opens
// an input stream, sends a start request, recognizes speech or calls a provider.
// Give startup a small scheduling cushion. Once queued, preserve the PCM clock;
// arrival jitter must not reinsert a startup delay between contiguous frames.
const START_LEAD_SECONDS=.08, RECOVERY_LEAD_SECONDS=.02;
export class ConversationOutput {
 constructor({onStopped,onComplete,onState,onMessage,onReplyText,onReplyComplete,onReplyAudio,onClosed,onError}){Object.assign(this,{onStopped,onComplete,onState,onMessage,onReplyText,onReplyComplete,onReplyAudio,onClosed,onError});this.retired=new Set();this.sources=new Set();this.socket=null;this.audio=null;this.turn=null;this.waiting=false;this.cursor=0;this.generation=0;this.playbackFrames=[];this.playbackScheduledSamples=0;}
 get connected(){return this.socket?.readyState===WebSocket.OPEN&&this.audio?.state==='running';}
 async connect(){
  this.close();const generation=this.generation;
  this.audio=new AudioContext();await this.audio.resume();
  if(generation!==this.generation)throw new Error('Output setup was cancelled.');
  const socket=this.socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/runtime/v1/audio`);
  socket.addEventListener('message',event=>{if(socket!==this.socket)return;try{this.receive(JSON.parse(event.data));}catch(error){this.stop(error.message);this.onError?.(error);}});
  socket.addEventListener('close',()=>{if(socket===this.socket){this.stop('Speech connection closed. Enable output again to reconnect.');this.socket=null;this.onClosed?.();}});
  this.audio.addEventListener('statechange',()=>{if(generation===this.generation&&this.audio?.state!=='running')this.stop('Browser audio is suspended. Enable speech again to resume.');});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(new Error('Speech connection timed out.'));},5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Speech connection unavailable.'));},{once:true});socket.addEventListener('close',()=>{clearTimeout(timer);reject(new Error('Speech connection closed.'));},{once:true});});
  if(generation!==this.generation||!this.connected)throw new Error('Output setup was cancelled.');
 }
 expect(){if(!this.connected||this.turn)throw new Error('Speech output is unavailable or occupied.');this.waiting=true;}
 retire(trace){if(trace){this.retired.add(trace);if(this.retired.size>64)this.retired.delete(this.retired.values().next().value);}}
 beginReply(trace){if(this.retired.has(trace)||!this.connected)throw new Error('Voice reply is stale.');this.stop('Interrupted by a voice reply.');this.turn={trace,reply:true,frames:[],text:'',samples:0,sequence:0,terminal:false,accepted:true,stopped:false,completed:false,segments:new Set(),segment:null,segmentSamples:0};this.turn.timer=setTimeout(()=>this.stop('Voice reply playback expired.'),180000);}
 receive(message){
  if(this.onMessage?.(message)===true)return;
  const trace=message.interactionTraceId??message.event?.interactionTraceId;
  if(message.type==='error')throw new Error(message.problem?.message||'Audio transport failed.');
  if(!trace||this.retired.has(trace)||!this.waiting&&!this.turn)return;
  if(this.turn&&this.turn.trace!==trace)throw new Error('Unexpected concurrent speech output.');
  if(!this.turn){this.turn={trace,frames:[],text:'',samples:0,sequence:0,terminal:false,accepted:false,stopped:false,completed:false};this.turn.timer=setTimeout(()=>this.stop('Speech delivery metadata was not received; output discarded.'),5000);}
  const turn=this.turn;
  if(turn.stopped)return;
  if(message.type==='stopPlayback'){this.stop('Speech stopped by the runtime.');return;}
  if(message.type==='response'){
   const payload=message.event.payload;
   if(payload.type==='textDelta'){if(turn.terminal||typeof payload.text!=='string'||turn.text.length+payload.text.length>(turn.reply?64000:8000))throw new Error('Invalid speech text stream.');turn.text+=payload.text;if(turn.reply)this.onReplyText?.(trace,turn.text);}
   if(payload.type==='terminal'){if(turn.terminal||payload.state!=='completed')throw new Error(payload.error?.message||'Speech did not complete.');turn.terminal=true;this.maybeComplete();}
  }
  if(message.type==='acknowledgment'){try{if(turn.reply)this.acknowledgments?.play(trace,message.catalog,{responseReady:turn.samples>0});}catch{this.acknowledgments?.stop();}return;}
  if(message.type==='audio'){
   this.acknowledgments?.stop();
   if(turn.terminal)throw new Error('Audio arrived after synthesis completion.');
   const frame=message.chunk?.frame;
   if(turn.reply&&message.chunk?.segmentId!==turn.segment){const segment=message.chunk?.segmentId;if(typeof segment!=='string'||!segment||segment.length>200||turn.segments.has(segment)||turn.segments.size>=128)throw new Error('Invalid voice speech segment.');turn.segments.add(segment);turn.segment=segment;turn.sequence=0;turn.segmentSamples=0;}
   if(frame?.format?.encoding!=='pcm_s16le'||frame.format.sampleRateHz!==48000||frame.format.channels!==1||frame.sequence!==turn.sequence||frame.sampleOffset!==(turn.reply?turn.segmentSamples:turn.samples)||!Number.isInteger(frame.sampleCount)||frame.sampleCount<1||frame.sampleCount>4800||turn.samples+frame.sampleCount>48000*(turn.reply?180:60))throw new Error('Invalid speech frame sequence or format.');
   const bytes=Uint8Array.from(atob(frame.dataBase64),c=>c.charCodeAt(0));if(bytes.length!==frame.sampleCount*2)throw new Error('Invalid speech frame length.');
   turn.samples+=frame.sampleCount;turn.sequence++;if(turn.reply)turn.segmentSamples+=frame.sampleCount;
   if(turn.accepted)this.play(bytes);else{if(turn.frames.length>=64)throw new Error('Speech metadata buffer exceeded its limit.');turn.frames.push(bytes);}
  }
  this.bind();
 }
 accept(delivery){
  if(!this.connected||Date.parse(delivery.expiresAt)<=Date.now())return Promise.reject(new Error('Speech output is stale.'));
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.stop('Speech stream did not match its receipt.');},5000);this.binding={delivery,resolve:()=>{clearTimeout(timer);resolve();},reject:error=>{clearTimeout(timer);reject(error);}};this.bind();});
 }
 bind(){
  if(!this.binding||!this.turn)return;const {delivery,resolve,reject}=this.binding;
  if(this.turn.trace===delivery.interactionId&&delivery.text.startsWith(this.turn.text)&&this.turn.text!==delivery.text)return;
  this.binding=null;try{
  const turn=this.turn;if(!this.connected||!turn||turn.stopped||turn.trace!==delivery.interactionId||turn.text!==delivery.text||Date.parse(delivery.expiresAt)<=Date.now())throw new Error('Speech receipt does not match current output.');
  clearTimeout(turn.timer);turn.accepted=true;this.waiting=false;
  turn.timer=setTimeout(()=>this.stop('Speech playback expired before a completion receipt.'),Math.max(1,Date.parse(delivery.expiresAt)-Date.now()));
  for(const bytes of turn.frames)this.play(bytes);turn.frames=[];this.maybeComplete();resolve();
  }catch(error){reject(error);this.stop(error.message);}
 }
 play(bytes){
  if(!this.connected||!this.turn||this.turn.stopped)throw new Error('Speech output is unavailable.');
  const turn=this.turn,audio=this.audio;if(this.cursor-audio.currentTime>3)throw new Error('Speech playback exceeded its bounded lookahead.');
  const buffer=audio.createBuffer(1,bytes.length/2,48000),view=new DataView(bytes.buffer),channel=buffer.getChannelData(0);
  for(let i=0;i<channel.length;i++)channel[i]=view.getInt16(i*2,true)/32768;
  const source=audio.createBufferSource();source.buffer=buffer;source.connect(audio.destination);this.cursor=Math.max(this.cursor,audio.currentTime+(this.playbackScheduledSamples===0?START_LEAD_SECONDS:RECOVERY_LEAD_SECONDS));this.sources.add(source);
  source.addEventListener('ended',()=>{this.sources.delete(source);source.disconnect();if(this.turn===turn)this.maybeComplete();},{once:true});
  this.playbackFrames=this.playbackFrames.filter(frame=>frame.end>audio.currentTime);this.playbackFrames.push({offset:this.playbackScheduledSamples,start:this.cursor,end:this.cursor+buffer.duration,samples:buffer.getChannelData(0),trace:turn.trace,rate:48000});this.playbackScheduledSamples+=bytes.length/2;
  source.start(this.cursor);if(turn.reply&&!turn.firstScheduledAudio){turn.firstScheduledAudio=true;this.onReplyAudio?.({kind:'actual-response-audio',trace:turn.trace,segmentId:turn.segment,audioTime:this.cursor,observedAt:performance.now()});}this.cursor+=buffer.duration;this.onState('Playing speech');
 }
 maybeComplete(){const turn=this.turn;if(!turn||turn.stopped||turn.completed||!turn.accepted||!turn.terminal||!turn.samples||this.sources.size)return;turn.completed=true;clearTimeout(turn.timer);this.turn=null;this.retire(turn.trace);if(turn.reply)this.onReplyComplete?.(turn.trace);else this.onComplete(turn.trace);}
 playbackSample(){const audio=this.audio,turn=this.turn;if(!audio||!turn||audio.state!=='running')return {playing:false,amplitude:0};if(!turn.samples&&this.acknowledgments?.playing)return this.acknowledgments.sample();const now=audio.currentTime;this.playbackFrames=this.playbackFrames.filter(frame=>frame.end>now);const frame=this.playbackFrames.find(frame=>frame.trace===turn.trace&&frame.start<=now&&now<frame.end);if(!frame)return {playing:false,amplitude:0};const start=Math.max(0,Math.floor((now-frame.start)*frame.rate)),end=Math.min(frame.samples.length,start+480);let energy=0;for(let i=start;i<end;i++)energy+=frame.samples[i]**2;return {playing:true,amplitude:Math.sqrt(energy/Math.max(1,end-start)),trace:turn.trace,sampleOffset:frame.offset+start,clock:'AudioContext.currentTime'};}
 stop(reason='Stopped locally'){this.acknowledgments?.stop();this.playbackFrames=[];this.playbackScheduledSamples=0;const binding=this.binding;this.binding=null;binding?.reject(new Error(reason));const turn=this.turn;this.waiting=false;if(turn){this.retire(turn.trace);turn.stopped=true;clearTimeout(turn.timer);if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({type:'interrupt',interactionTraceId:turn.trace,reason}));}for(const source of this.sources){try{source.stop();}catch{}source.disconnect();}this.sources.clear();this.turn=null;this.cursor=this.audio?.currentTime??0;this.onStopped(turn?.trace,reason);}
 close(){this.acknowledgments?.clear();this.generation++;this.stop();const socket=this.socket;this.socket=null;socket?.close();const audio=this.audio;this.audio=null;void audio?.close();this.onClosed?.();}
}
