// Speech probabilities from Silero, never amplitude or ASR text confidence.
export class SpeechGate {
  constructor(sensitivity=50){this.configure(sensitivity);}
  configure(value){this.sensitivity=Math.max(0,Math.min(100,Number(value)||0));this.threshold=.8-.004*this.sensitivity;this.negativeThreshold=this.threshold-.2;this.holdMs=250-this.sensitivity;this.bargeMs=200-this.sensitivity;this.reset();}
  reset(){this.aboveMs=0;}
  update(probability,durationMs,playing=false){this.aboveMs=probability>=this.threshold?this.aboveMs+durationMs:0;return this.aboveMs>=(playing?this.bargeMs:this.holdMs);}
}
