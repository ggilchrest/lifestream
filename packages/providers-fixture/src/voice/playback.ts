type AudioFrame = { frameId: string; sequence: number; format: { encoding: "pcm_s16le"; sampleRateHz: 16000 | 24000 | 48000; channels: 1 | 2 }; sampleOffset: number; sampleCount: number; dataBase64: string };

export class FixturePlaybackSink {
  readonly played: { segmentId: string; frame: AudioFrame }[] = [];
  closed = false;
  private fenceToken = 0;
  private readonly maxQueue: number;
  constructor(maxQueue: number) { this.maxQueue = maxQueue; }
  async play(segmentId: string, frame: AudioFrame, fenceToken = this.fenceToken): Promise<void> { if (this.closed) throw new Error("playback closed"); if (fenceToken !== this.fenceToken) throw new Error("stale playback fence"); if (this.played.length >= this.maxQueue) throw new Error("playback queue full"); this.played.push({ segmentId, frame: structuredClone(frame) }); }
  fence(): number { this.fenceToken += 1; return this.fenceToken; }
  async close(): Promise<void> { this.closed = true; }
}
