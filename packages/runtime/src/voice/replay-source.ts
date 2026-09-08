import { readFile } from "node:fs/promises";
import type { AudioFormat, SttInput } from "./ports.ts";

export type ReplaySourceType = "realtimePcmReplay";
export type ReplayAudioMetadata = {
  sourceType: ReplaySourceType;
  fixtureRef: string;
  endpointId: string;
  sessionId: string;
  interactionId: string;
  audioInputId: string;
  frameTimestampMs: number;
};
export type ReplayAudioInput = SttInput & { metadata: ReplayAudioMetadata };
export type ReplayTraceEvent = {
  phase: "started" | "frame" | "ended" | "stopped" | "committed" | "disconnected" | "failed";
  sourceType: ReplaySourceType;
  fixtureRef: string;
  endpointId: string;
  sessionId: string;
  interactionId: string;
  audioInputId: string;
  sequence?: number;
  sampleOffset?: number;
  sampleCount?: number;
  atMs: number;
  reason?: string;
};

type ReplayOptions = {
  fixturePath: string;
  fixtureRef: string;
  format: AudioFormat;
  endpointId: string;
  sessionId: string;
  interactionId: string;
  audioInputId: string;
  frameSamples?: number;
  deadlineAt?: number | string;
  pace?: boolean;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onTrace?: (event: ReplayTraceEvent) => void;
};

export class ReplaySourceError extends Error {
  constructor(message: string) { super(message); this.name = "ReplaySourceError"; }
}

export class RealtimePcmReplaySource {
  readonly sourceType: ReplaySourceType = "realtimePcmReplay";
  private readonly options: ReplayOptions & { frameSamples: number; pace: boolean; now: () => number; sleep: (milliseconds: number, signal: AbortSignal) => Promise<void> };
  private readonly controller = new AbortController();

  constructor(options: ReplayOptions) {
    if (!options.fixturePath || !options.fixtureRef || !options.endpointId || !options.sessionId || !options.interactionId || !options.audioInputId) throw new ReplaySourceError("replay identity is incomplete");
    if (options.format.channels !== 1 || options.format.sampleRateHz !== 16000 || options.format.encoding !== "pcm_s16le") throw new ReplaySourceError("replay source requires normalized pcm_s16le mono 16 kHz");
    const frameSamples = options.frameSamples ?? 1600;
    if (!Number.isInteger(frameSamples) || frameSamples < 1 || frameSamples > 4800) throw new ReplaySourceError("replay frame size must be between 1 and 4800 samples");
    this.options = { ...options, frameSamples, pace: options.pace ?? true, now: options.now ?? (() => Date.now()), sleep: options.sleep ?? defaultSleep };
  }

  stop(reason = "stopped"): void { this.trace({ phase: "stopped", atMs: this.options.now(), reason }); this.controller.abort(reason); }
  commit(reason = "committed"): void { this.trace({ phase: "committed", atMs: this.options.now(), reason }); this.controller.abort(reason); }
  disconnect(reason = "source_disconnected"): void { this.trace({ phase: "disconnected", atMs: this.options.now(), reason }); this.controller.abort(reason); }

  async *stream(signal?: AbortSignal): AsyncGenerator<ReplayAudioInput> {
    const combined = combineSignals(this.controller.signal, signal);
    const bytes = await readFile(this.options.fixturePath);
    const pcm = parsePcm(bytes, this.options.format);
    const frameBytes = this.options.frameSamples * 2 * this.options.format.channels;
    let sequence = 0;
    let sampleOffset = 0;
    const startedAt = this.options.now();
    this.trace({ phase: "started", atMs: startedAt });
    try {
      for (let byteOffset = 0; byteOffset < pcm.length; byteOffset += frameBytes) {
        throwIfAborted(combined.signal);
        if (this.options.deadlineAt !== undefined && this.options.now() >= deadlineMs(this.options.deadlineAt)) throw new DOMException("replay deadline exceeded", "AbortError");
        const chunk = pcm.subarray(byteOffset, Math.min(byteOffset + frameBytes, pcm.length));
        if (chunk.length === 0 || chunk.length % 2 !== 0) throw new ReplaySourceError("PCM fixture contains a partial sample");
        const sampleCount = chunk.length / 2 / this.options.format.channels;
        const frameTimestampMs = startedAt + (sampleOffset / this.options.format.sampleRateHz) * 1000;
        const metadata = this.metadata(frameTimestampMs);
        const item: ReplayAudioInput = { type: "frame", audioInputId: this.options.audioInputId, frame: { frameId: `${this.options.audioInputId}:frame:${sequence}`, sequence, format: this.options.format, sampleOffset, sampleCount, dataBase64: Buffer.from(chunk).toString("base64") }, metadata };
        this.trace({ phase: "frame", sequence, sampleOffset, sampleCount, atMs: frameTimestampMs });
        yield item;
        sequence += 1;
        sampleOffset += sampleCount;
        if (this.options.pace && byteOffset + frameBytes < pcm.length) await this.options.sleep((sampleOffset / this.options.format.sampleRateHz) * 1000 - (this.options.now() - startedAt), combined.signal);
      }
      throwIfAborted(combined.signal);
      const end: ReplayAudioInput = { type: "end", audioInputId: this.options.audioInputId, nextSequence: sequence, sampleCount: sampleOffset, metadata: this.metadata(startedAt + (sampleOffset / this.options.format.sampleRateHz) * 1000) };
      this.trace({ phase: "ended", sequence, sampleOffset, sampleCount: sampleOffset, atMs: end.metadata.frameTimestampMs });
      yield end;
    } catch (error) {
      if (isAbortError(error) || combined.signal.aborted) { if (!this.controller.signal.aborted) this.trace({ phase: "stopped", atMs: this.options.now(), reason: abortReason(combined.signal) }); return; }
      this.trace({ phase: "failed", atMs: this.options.now(), reason: error instanceof Error ? error.message : "replay_failed" });
      throw error;
    } finally { combined.dispose(); }
  }

  private metadata(frameTimestampMs: number): ReplayAudioMetadata { return { sourceType: this.sourceType, fixtureRef: this.options.fixtureRef, endpointId: this.options.endpointId, sessionId: this.options.sessionId, interactionId: this.options.interactionId, audioInputId: this.options.audioInputId, frameTimestampMs }; }
  private trace(event: Omit<ReplayTraceEvent, "sourceType" | "fixtureRef" | "endpointId" | "sessionId" | "interactionId" | "audioInputId">): void { this.options.onTrace?.({ ...event, sourceType: this.sourceType, fixtureRef: this.options.fixtureRef, endpointId: this.options.endpointId, sessionId: this.options.sessionId, interactionId: this.options.interactionId, audioInputId: this.options.audioInputId }); }
}

function parsePcm(bytes: Buffer, expected: AudioFormat): Buffer {
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") {
    let offset = 12; let format: { channels?: number; sampleRate?: number; bits?: number } = {}; let data: Buffer | undefined;
    while (offset + 8 <= bytes.length) { const id = bytes.subarray(offset, offset + 4).toString("ascii"); const size = bytes.readUInt32LE(offset + 4); const end = offset + 8 + size; if (end > bytes.length) throw new ReplaySourceError("WAV chunk exceeds fixture"); if (id === "fmt ") { if (size < 16) throw new ReplaySourceError("WAV fmt chunk is incomplete"); format = { channels: bytes.readUInt16LE(offset + 10), sampleRate: bytes.readUInt32LE(offset + 12), bits: bytes.readUInt16LE(offset + 22) }; } else if (id === "data") data = bytes.subarray(offset + 8, end); offset = end + (size % 2); }
    if (!format.channels || !format.sampleRate || !format.bits || !data || format.channels !== expected.channels || format.sampleRate !== expected.sampleRateHz || format.bits !== 16) throw new ReplaySourceError("WAV fixture is not normalized pcm_s16le");
    return data;
  }
  if (bytes.length === 0 || bytes.length % (2 * expected.channels) !== 0) throw new ReplaySourceError("raw PCM fixture has an invalid sample boundary");
  return bytes;
}

function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw new DOMException(abortReason(signal), "AbortError"); }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }
function abortReason(signal: AbortSignal): string { return typeof signal.reason === "string" ? signal.reason : "replay_aborted"; }
function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> { if (milliseconds <= 0) return Promise.resolve(); return new Promise((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException(abortReason(signal), "AbortError")); }, { once: true }); }); }
function deadlineMs(value: number | string): number { const result = typeof value === "number" ? value : Date.parse(value); if (!Number.isFinite(result)) throw new ReplaySourceError("replay deadline is invalid"); return result; }
function combineSignals(first: AbortSignal, second?: AbortSignal): { signal: AbortSignal; dispose: () => void } { if (!second) return { signal: first, dispose: () => undefined }; const controller = new AbortController(); const abort = (signal: AbortSignal) => controller.abort(signal.reason); if (first.aborted) abort(first); else if (second.aborted) abort(second); else { first.addEventListener("abort", () => abort(first), { once: true }); second.addEventListener("abort", () => abort(second), { once: true }); } return { signal: controller.signal, dispose: () => undefined }; }
