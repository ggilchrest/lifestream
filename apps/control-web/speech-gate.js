// Speech probabilities from Silero, never amplitude or ASR text confidence.
// Include model-onset lag as well as qualification: the short "stop" fixture
// qualifies at 384 ms. Fourteen 32-ms frames retain its initial consonants.
export const PRE_ROLL_FRAMES=14;
// After ten minutes of negative input the declared natural-pause fixture has
// a measured 576 ms low-probability gap. Resetting the model does not remove
// that gap. Bridge it without changing the faster barge-in onset or targets.
export const END_SILENCE_SECONDS=.8;
export class SpeechGate {
  constructor(sensitivity=50){this.configure(sensitivity);}
  configure(value){this.sensitivity=Math.max(0,Math.min(100,Number(value)||0));this.threshold=.8-.004*this.sensitivity;this.negativeThreshold=this.threshold-.2;this.holdMs=250-this.sensitivity;this.bargeMs=200-this.sensitivity;this.reset();}
  reset(){this.aboveMs=0;}
  update(probability,durationMs,playing=false){this.aboveMs=probability>=this.threshold?this.aboveMs+durationMs:0;return this.aboveMs>=(playing?this.bargeMs:this.holdMs);}
}
