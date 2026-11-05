// One producer and one consumer; admission, cancellation and completion are
// explicit. Ordinary streaming may bound pending text by the existing reply
// character budget instead of coupling text delivery to synthesis throughput.
export class SpeechQueue implements AsyncIterable<string> {
  private readonly values: string[] = [];
  private ended = false;
  private error: unknown;
  private wake: (() => void) | undefined;
  private space: (() => void) | undefined;
  private readonly signal: AbortSignal;
  private readonly capacity: number;
  private readonly maximumQueuedCharacters:number;
  private queuedCharacters=0;
  constructor(signal: AbortSignal, policy:number|{maximumQueuedCharacters:number} = 3) {
    this.signal = signal;
    this.capacity = typeof policy==='number'?policy:policy.maximumQueuedCharacters;
    this.maximumQueuedCharacters=typeof policy==='number'?policy*16384:policy.maximumQueuedCharacters;
    if(!Number.isSafeInteger(this.capacity)||this.capacity<1||!Number.isSafeInteger(this.maximumQueuedCharacters)||this.maximumQueuedCharacters<1)throw Error("Invalid speech queue bound");
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }
  private readonly abort = () => this.close(new Error("speech queue cancelled"));
  async put(value: string): Promise<void> {
    if (value.length > 16_384||value.length>this.maximumQueuedCharacters) throw new Error("speech unit limit exceeded");
    while (!this.ended && (this.values.length >= this.capacity||this.queuedCharacters+value.length>this.maximumQueuedCharacters)) await new Promise<void>(resolve => { this.space = resolve; });
    if (this.ended) throw this.error ?? new Error("speech queue closed");
    this.values.push(value);this.queuedCharacters+=value.length; this.wake?.(); this.wake = undefined;
  }
  close(error?: unknown): void {
    if (this.ended && (error===undefined||this.error!==undefined)) return;
    this.ended = true; this.error = error;
    if (error){this.values.length = 0;this.queuedCharacters=0;}
    this.wake?.(); this.space?.(); this.wake = undefined; this.space = undefined;
    if(error||this.values.length===0)this.signal.removeEventListener("abort", this.abort);
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      if (this.error) throw this.error;
      const value = this.values.shift();
      if (value !== undefined) { this.queuedCharacters-=value.length;this.space?.(); this.space = undefined; yield value; continue; }
      if (this.ended){this.signal.removeEventListener("abort",this.abort);return;}
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}
