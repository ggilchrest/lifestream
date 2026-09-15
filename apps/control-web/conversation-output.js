// Output-only use of the existing runtime audio protocol. This class never opens
// an input stream, sends a start request, recognizes speech or calls a provider.
export class ConversationOutput {
 constructor({onStopped,onComplete,onState}){Object.assign(this,{onStopped,onComplete,onState});this.sources=new Set();this.socket=null;this.audio=null;this.turn=null;this.waiting=false;this.cursor=0;this.generation=0;}
 get connected(){return this.socket?.readyState===WebSocket.OPEN&&this.audio?.state==='running';}
 async connect(){
  this.close();const generation=this.generation;
  this.audio=new AudioContext();await this.audio.resume();
  if(generation!==this.generation)throw new Error('Output setup was cancelled.');
  const socket=this.socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/runtime/v1/audio`);
  socket.addEventListener('message',event=>{if(socket!==this.socket)return;try{this.receive(JSON.parse(event.data));}catch(error){this.stop(error.message);}});
  socket.addEventListener('close',()=>{if(socket===this.socket){this.stop('Speech connection closed. Enable output again to reconnect.');this.socket=null;}});
  this.audio.addEventListener('statechange',()=>{if(generation===this.generation&&this.audio?.state!=='running')this.stop('Browser audio is suspended. Enable speech again to resume.');});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(new Error('Speech connection timed out.'));},5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Speech connection unavailable.'));},{once:true});socket.addEventListener('close',()=>{clearTimeout(timer);reject(new Error('Speech connection closed.'));},{once:true});});
  if(generation!==this.generation||!this.connected)throw new Error('Output setup was cancelled.');
 }
 expect(){if(!this.connected||this.turn)throw new Error('Speech output is unavailable or occupied.');this.waiting=true;}
 receive(message){
  const trace=message.interactionTraceId??message.event?.interactionTraceId;
  if(message.type==='error')throw new Error(message.problem?.message||'Audio transport failed.');
  if(!trace||!this.waiting&&!this.turn)return;
  if(this.turn&&this.turn.trace!==trace)throw new Error('Unexpected concurrent speech output.');
  if(!this.turn){this.turn={trace,frames:[],text:'',samples:0,sequence:0,terminal:false,accepted:false,stopped:false,completed:false};this.turn.timer=setTimeout(()=>this.stop('Speech delivery metadata was not received; output discarded.'),5000);}
  const turn=this.turn;
  if(turn.stopped)return;
  if(message.type==='stopPlayback'){this.stop('Speech stopped by the runtime.');return;}
  if(message.type==='response'){
   const payload=message.event.payload;
   if(payload.type==='textDelta'){if(turn.terminal||typeof payload.text!=='string'||turn.text.length+payload.text.length>8000)throw new Error('Invalid speech text stream.');turn.text+=payload.text;}
   if(payload.type==='terminal'){if(payload.state!=='completed')throw new Error(payload.error?.message||'Speech did not complete.');turn.terminal=true;this.maybeComplete();}
  }
  if(message.type==='audio'){
   if(turn.terminal)throw new Error('Audio arrived after synthesis completion.');
   const frame=message.chunk?.frame;
   if(frame?.format?.encoding!=='pcm_s16le'||frame.format.sampleRateHz!==48000||frame.format.channels!==1||frame.sequence!==turn.sequence||frame.sampleOffset!==turn.samples||!Number.isInteger(frame.sampleCount)||frame.sampleCount<1||frame.sampleCount>4800||turn.samples+frame.sampleCount>48000*60)throw new Error('Invalid speech frame sequence or format.');
   const bytes=Uint8Array.from(atob(frame.dataBase64),c=>c.charCodeAt(0));if(bytes.length!==frame.sampleCount*2)throw new Error('Invalid speech frame length.');
   turn.samples+=frame.sampleCount;turn.sequence++;
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
  const source=audio.createBufferSource();source.buffer=buffer;source.connect(audio.destination);this.cursor=Math.max(this.cursor,audio.currentTime+.25);this.sources.add(source);
  source.addEventListener('ended',()=>{this.sources.delete(source);source.disconnect();if(this.turn===turn)this.maybeComplete();},{once:true});
  source.start(this.cursor);this.cursor+=buffer.duration;this.onState('Playing speech');
 }
 maybeComplete(){const turn=this.turn;if(!turn||turn.stopped||turn.completed||!turn.accepted||!turn.terminal||!turn.samples||this.sources.size)return;turn.completed=true;clearTimeout(turn.timer);this.turn=null;this.onComplete(turn.trace);}
 stop(reason='Stopped locally'){const binding=this.binding;this.binding=null;binding?.reject(new Error(reason));const turn=this.turn;this.waiting=false;if(turn){turn.stopped=true;clearTimeout(turn.timer);if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({type:'interrupt',interactionTraceId:turn.trace,reason}));}for(const source of this.sources){try{source.stop();}catch{}source.disconnect();}this.sources.clear();this.turn=null;this.cursor=this.audio?.currentTime??0;this.onStopped(turn?.trace,reason);}
 close(){this.generation++;this.stop();const socket=this.socket;this.socket=null;socket?.close();const audio=this.audio;this.audio=null;void audio?.close();}
}
