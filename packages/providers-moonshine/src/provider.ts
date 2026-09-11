type AudioFormat = { encoding: "pcm_s16le"; sampleRateHz: 16000 | 24000 | 48000; channels: 1 | 2 };
type AudioFrame = { frameId: string; sequence: number; format: AudioFormat; sampleOffset: number; sampleCount: number; dataBase64: string };
type SttInput = { type: "frame"; audioInputId: string; frame: AudioFrame } | { type: "end"; audioInputId: string; nextSequence: number; sampleCount: number };
type SpeechRequest = { deadlineAt: string; now: () => string };
type SttData = { type: "partial" | "committed"; utteranceId: string; text: string; startSample: number; endSample: number; speakerRef: string | null; confidence: number };
type SttEvent = { kind: "data"; sequence: number; payload: SttData } | { kind: "terminal"; sequence: number; outcome: "succeeded" | "rejected" | "cancelled" | "timedOut" | "failed"; inputSamples: number };
type SpeechToTextProvider = { transcribe(request: SpeechRequest, audio: AsyncIterable<SttInput>, signal?: AbortSignal): AsyncIterable<SttEvent> };

type Fetch = typeof globalThis.fetch;
type SidecarEvent = {
  kind?: "data" | "terminal";
  sequence?: number;
  requestId?: string;
  runtimeRevision?: string;
  modelRevision?: string;
  modelArtifactDigest?: string;
  mappingRevision?: string;
  payload?: SttData;
  outcome?: "completed" | "malformedRequest" | "unsupportedRequest" | "deadlineExceeded" | "providerUnavailable" | "retryableProviderFailure";
  inputSamples?: number;
};

export type MoonshineSpeechOptions = {
  baseUrl: string;
  runtimeRevision: string;
  modelRevision: string;
  modelArtifactDigest: string;
  mappingRevision: string;
  fetch?: Fetch;
  maxInputSamples?: number;
};

const FORMAT = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 } as const;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const outcome = (value: SidecarEvent["outcome"]): "succeeded" | "rejected" | "cancelled" | "timedOut" | "failed" => {
  if (value === "completed") return "succeeded";
  if (value === "deadlineExceeded") return "timedOut";
  if (value === "malformedRequest" || value === "unsupportedRequest") return "rejected";
  return "failed";
};

export class MoonshineSpeechProvider implements SpeechToTextProvider {
  private readonly options: MoonshineSpeechOptions;

  constructor(options: MoonshineSpeechOptions) {
    this.options = options;
  }

  async *transcribe(request: SpeechRequest, audio: AsyncIterable<SttInput>, signal?: AbortSignal): AsyncIterable<SttEvent> {
    let inputId: string | undefined;
    let nextSequence = 0;
    let inputSamples = 0;
    let ended = false;
    const chunks: Buffer[] = [];
    try {
      if (Date.parse(request.now()) >= Date.parse(request.deadlineAt)) {
        yield { kind: "terminal", sequence: 0, outcome: "timedOut", inputSamples };
        return;
      }
      if (signal?.aborted) {
        yield { kind: "terminal", sequence: 0, outcome: "cancelled", inputSamples };
        return;
      }
      for await (const item of audio) {
        if (ended) throw new Error("audio data followed end");
        if (signal?.aborted) {
          yield { kind: "terminal", sequence: 0, outcome: "cancelled", inputSamples };
          return;
        }
        if (Date.parse(request.now()) >= Date.parse(request.deadlineAt)) {
          yield { kind: "terminal", sequence: 0, outcome: "timedOut", inputSamples };
          return;
        }
        inputId ??= item.audioInputId;
        if (item.audioInputId !== inputId) throw new Error("audio input identity changed");
        if (item.type === "end") {
          if (ended || item.nextSequence !== nextSequence || item.sampleCount !== inputSamples) throw new Error("audio end count mismatch");
          ended = true;
          continue;
        }
        const frame = item.frame;
        if (frame.sequence !== nextSequence || frame.sampleOffset !== inputSamples || frame.format.encoding !== FORMAT.encoding || frame.format.sampleRateHz !== FORMAT.sampleRateHz || frame.format.channels !== FORMAT.channels || !Number.isInteger(frame.sampleCount) || frame.sampleCount < 1 || frame.sampleCount > 4800 || !BASE64.test(frame.dataBase64)) throw new Error("audio frame invalid");
        const bytes = Buffer.from(frame.dataBase64, "base64");
        if (bytes.length !== frame.sampleCount * 2) throw new Error("audio frame byte count invalid");
        inputSamples += frame.sampleCount;
        if (inputSamples > (this.options.maxInputSamples ?? 480_000)) throw new Error("audio input limit exceeded");
        chunks.push(bytes);
        nextSequence += 1;
      }
      if (!ended || !inputId) throw new Error("audio stream missing end");

      const controller = new AbortController();
      let deadlineExpired = false;
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const remainingMs = Math.max(1, Date.parse(request.deadlineAt) - Date.parse(request.now()));
      const timer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, remainingMs);
      let response: Response;
      let responseText: string;
      try {
        response = await (this.options.fetch ?? globalThis.fetch)(`${this.options.baseUrl.replace(/\/$/u, "")}/v1/stt/transcribe`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/x-ndjson" },
          body: JSON.stringify({
            protocolVersion: "moonshine.loopback.v1",
            requestId: inputId,
            deadlineAt: request.deadlineAt,
            audioInputId: inputId,
            format: FORMAT,
            sampleCount: inputSamples,
            dataBase64: Buffer.concat(chunks).toString("base64")
          }),
          signal: controller.signal
        });
        // The deadline and cancellation cover the body, not only HTTP headers.
        responseText = await response.text();
      } catch {
        yield { kind: "terminal", sequence: 0, outcome: signal?.aborted ? "cancelled" : deadlineExpired ? "timedOut" : "failed", inputSamples };
        return;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.abort();
      }
      if (!response.ok) {
        yield { kind: "terminal", sequence: 0, outcome: "failed", inputSamples };
        return;
      }
      const lines = responseText.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as SidecarEvent);
      if (lines.length < 1 || lines.some((event, index) => event.sequence !== index) || lines.at(-1)?.kind !== "terminal") throw new Error("invalid sidecar lifecycle");
      const terminal = lines.at(-1)!;
      if (terminal.inputSamples !== inputSamples || terminal.requestId !== inputId) throw new Error("sidecar accounting changed");
      if (terminal.outcome === "completed") {
        if (lines.length !== 2 || lines[0]?.kind !== "data" || lines[0].requestId !== inputId) throw new Error("invalid committed transcript");
        const data = lines[0];
        if (data.runtimeRevision !== this.options.runtimeRevision || data.modelRevision !== this.options.modelRevision || data.modelArtifactDigest !== this.options.modelArtifactDigest || data.mappingRevision !== this.options.mappingRevision) throw new Error("sidecar identity changed");
        if (data.payload?.type !== "committed" || typeof data.payload.text !== "string" || data.payload.startSample !== 0 || data.payload.endSample !== inputSamples || data.payload.speakerRef !== null || data.payload.confidence !== 0) throw new Error("invalid committed transcript");
        yield { kind: "data", sequence: 0, payload: data.payload };
        yield { kind: "terminal", sequence: 1, outcome: "succeeded", inputSamples };
        return;
      }
      if (lines.length !== 1) throw new Error("failed sidecar response emitted data");
      yield { kind: "terminal", sequence: 0, outcome: outcome(terminal.outcome), inputSamples };
    } catch {
      yield { kind: "terminal", sequence: 0, outcome: signal?.aborted ? "cancelled" : "failed", inputSamples };
    }
  }
}
