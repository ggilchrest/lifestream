// One producer and one consumer; admission, cancellation and completion are
// explicit. Inference may run ahead by at most three semantic speech units.
export class SpeechQueue implements AsyncIterable<string> {
  private readonly values: string[] = [];
  private ended = false;
  private error: unknown;
  private wake: (() => void) | undefined;
  private space: (() => void) | undefined;
  private readonly signal: AbortSignal;
  private readonly capacity: number;
  constructor(signal: AbortSignal, capacity = 3) {
    this.signal = signal;
    this.capacity = capacity;
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }
  private readonly abort = () => this.close(new Error("speech queue cancelled"));
  async put(value: string): Promise<void> {
    if (value.length > 16_384) throw new Error("speech unit limit exceeded");
    while (!this.ended && this.values.length >= this.capacity) await new Promise<void>(resolve => { this.space = resolve; });
    if (this.ended) throw this.error ?? new Error("speech queue closed");
    this.values.push(value); this.wake?.(); this.wake = undefined;
  }
  close(error?: unknown): void {
    if (this.ended) return;
    this.ended = true; this.error = error;
    if (error) this.values.length = 0;
    this.wake?.(); this.space?.(); this.wake = undefined; this.space = undefined;
    this.signal.removeEventListener("abort", this.abort);
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      if (this.error) throw this.error;
      const value = this.values.shift();
      if (value !== undefined) { this.space?.(); this.space = undefined; yield value; continue; }
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}
