import {SileroV5} from './vad-bundle.js';
import {withSileroContext} from './vad-context.js';
export class VadStream {
  static async create(onFrame,onError){
    ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths='/control/';
    const model=await SileroV5.new(ort,async()=>{const response=await fetch('/control/silero_vad_v5.onnx');if(!response.ok)throw new Error('Local speech detector model unavailable');return response.arrayBuffer();});
    return new VadStream(withSileroContext(model),onFrame,onError);
  }
  constructor(model,onFrame,onError){this.model=model;this.onFrame=onFrame;this.onError=onError;this.pending=new Float32Array(0);this.frames=[];this.running=false;this.closed=false;this.idleFrames=0;}
  push(chunk){
    if(this.closed)return;
    const merged=new Float32Array(this.pending.length+chunk.length);merged.set(this.pending);merged.set(chunk,this.pending.length);let offset=0;
    while(offset+512<=merged.length){this.frames.push(merged.slice(offset,offset+512));offset+=512;}this.pending=merged.slice(offset);
    if(this.frames.length>16){this.close();this.onError(new Error('Speech detection fell behind; reconnect microphone'));return;}void this.drain();
  }
  async drain(){
    if(this.running||this.closed)return;this.running=true;
    // Long idle histories plus frame alignment produced a 1.056 s false gap
    // inside a phrase. Reset only after 2.016 s below every selectable speech
    // continuation threshold. Keep consuming/forwarding all capture samples;
    // this is neither microphone muting nor a longer endpoint/barge-in gate.
    try{while(this.frames.length&&!this.closed){const frame=this.frames.shift(),probabilities=await this.model.process(frame);if(!this.closed){this.onFrame(frame,probabilities.isSpeech);this.idleFrames=probabilities.isSpeech<.2?this.idleFrames+1:0;if(this.idleFrames>=63){this.model.reset_state();this.idleFrames=0;}}}}
    catch(error){this.close();this.onError(error);}
    finally{this.running=false;if(this.closed)await this.model.release();}
  }
  close(){if(this.closed)return;this.closed=true;this.frames=[];this.pending=new Float32Array(0);if(!this.running)void this.model.release();}
}
