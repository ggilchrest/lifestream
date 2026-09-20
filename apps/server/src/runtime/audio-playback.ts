/** Endpoint software settlement is separate from synthesis and physical audibility. */
export class AudioPlayback {
  readonly settled: Promise<void>;
  private resolve: () => void = () => {};
  private timer: ReturnType<typeof setTimeout>;
  private emitted = false;
  private produced = false;
  private synthesisCompleted = false;
  private endpointSettled = false;
  private stopped = false;
  private samples = 0;

  readonly trace: string;
  private readonly stop: () => void;
  constructor(trace: string, deadlineAt: string, stop: () => void) {
    this.trace = trace; this.stop = stop;
    this.settled = new Promise(resolve => { this.resolve = resolve; });
    this.timer = setTimeout(() => { this.endpointSettled = true; this.stopped = true; this.stop(); this.finish(); }, Math.max(1, Date.parse(deadlineAt) - Date.now()));
    this.timer.unref?.();
  }
  emittedOutput(samples = 0): void {
    if (this.stopped) throw new Error('Endpoint playback already stopped');
    this.emitted = true;
    this.samples += samples;
  }
  interrupt(): void { if (!this.stopped) { this.stopped = true; this.stop(); } }
  synthesized(): void { this.synthesisCompleted = true; }
  producerSettled(): void { this.produced = true; if (!this.emitted) this.endpointSettled = true; this.finish(); }
  acknowledge(message: unknown): boolean {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    const value = message as Record<string, unknown>;
    if (Object.keys(value).length !== 4 || value.type !== 'playbackSettled' || value.interactionTraceId !== this.trace || !Number.isSafeInteger(value.receivedSamples) || Number(value.receivedSamples) < 0 || Number(value.receivedSamples) > this.samples || !['completed', 'stopped'].includes(String(value.outcome)) || typeof value.outcome !== 'string') return false;
    if (this.endpointSettled) return false;
    if (value.outcome === 'completed' && (!this.synthesisCompleted || this.stopped || !this.samples || value.receivedSamples !== this.samples)) return false;
    this.endpointSettled = true;
    if (value.outcome === 'stopped') this.interrupt();
    this.finish();
    return true;
  }
  private finish(): void {
    if (!this.produced || !this.endpointSettled) return;
    clearTimeout(this.timer); this.resolve();
  }
}
