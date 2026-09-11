// Silero's ONNX interface needs the previous 64 samples before each 512-sample
// 16 kHz frame. The pinned vad-web adapter passes its input through unchanged.
// Match upstream OnnxWrapper's context handling; never count history as new PCM.
export function withSileroContext(model){
  let previous=new Float32Array(64);
  return {
    process(frame){
      if(frame.length!==512)throw new Error('Silero capture requires 512 new samples');
      const input=new Float32Array(576);input.set(previous);input.set(frame,64);
      previous=frame.slice(-64);return model.process(input);
    },
    reset_state(){previous.fill(0);model.reset_state();},
    release(){previous.fill(0);return model.release();}
  };
}
