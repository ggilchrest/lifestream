type TtsRequest = { contractVersion: "2.0.0"; text: string; segmentId: string; format: { encoding: "pcm_s16le"; sampleRateHz: 16000 | 24000 | 48000; channels: 1 | 2 }; voiceProfile: { voiceRef: string; revision: number }; decision: { decisionId: string; revision: number }; delivery: { interactionId: string; segmentId: string; decisionId: string; decisionRevision: number }; deadlineAt: string; maxOutputSamples?: number };
type TtsEvent = { kind: "preAudio"; sequence: number; segmentId: string; decisionId: string; decisionRevision: number; delivery: Record<string, unknown>; disposition: "fullyApplied" | "partiallyApplied"; degradedDimensions: string[]; mappingRevision: string } | { kind: "data"; sequence: number; segmentId: string; frame: { frameId: string; sequence: number; format: TtsRequest["format"]; sampleOffset: number; sampleCount: number; dataBase64: string }; mappingRevision: string } | { kind: "terminal"; sequence: number; segmentId: string; outcome: "succeeded" | "cancelled" | "timedOut" | "failed"; outputSamples: number; frameCount: number; disposition: "fullyApplied" | "partiallyApplied" | "providerFailure" | "cancelled" | "timedOut"; degradedDimensions: string[]; mappingRevision: string };
type TtsCapabilities = { contractVersion: "2.0.0"; supportedDimensions: readonly string[]; degradableDimensions: readonly string[]; supportsStreaming: true; maxOutputSamples: number };
interface TextToSpeechProvider { capabilities(): TtsCapabilities; synthesize(request: TtsRequest, signal?: AbortSignal): AsyncIterable<TtsEvent>; }
const PROTOCOL_VERSION = "voxcpm.loopback.v1" as const;
type ProtocolRequest = { protocolVersion: typeof PROTOCOL_VERSION; requestId: string; correlationId: string; interactionId: string; deadlineAt: string; voiceBundleKey: string; voiceBundleRevision: number; text: string; delivery: Record<string, unknown>; format: { encoding: "pcm_s16le"; sampleRateHz: 48000; channels: 1 } };
type ProtocolEvent = { kind: "preAudio"; sequence: 0; requestId: string; correlationId: string; voiceBundleRevision: number; requestedDelivery: Record<string, unknown>; appliedDelivery: Record<string, unknown>; degradedDimensions: string[]; mappingRevision: string; effectiveSynthesis: Record<string, unknown>; format: ProtocolRequest["format"]; runtimeRevision: string; modelRevision: string } | { kind: "data"; sequence: number; sampleOffset: number; sampleCount: number; dataBase64: string; format: ProtocolRequest["format"] } | { kind: "terminal"; sequence: number; outcome: "completed" | "cancelled" | "deadlineExceeded" | "retryableProviderFailure" | "nonRetryableProviderFailure" | "malformedRequest" | "unsupportedRequest" | "providerUnavailable"; outputSamples: number; frameCount: number };
async function* readProtocolEvents(body: ReadableStream<Uint8Array>): AsyncIterable<ProtocolEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      if (buffer.length > 65_536) throw new Error("protocol line buffer exceeded");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) yield JSON.parse(line) as ProtocolEvent;
      if (done) {
        if (buffer.trim()) yield JSON.parse(buffer) as ProtocolEvent;
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type VoxCpmOptions = { baseUrl: string; voiceBundleKey: string; voiceBundleRevision: number; runtimeRevision: string; modelRevision: string; mappingRevision: string; fetch?: typeof globalThis.fetch };
export class VoxCpmProvider implements TextToSpeechProvider {
  private readonly options: VoxCpmOptions; private readonly requestFetch: typeof globalThis.fetch;
  constructor(options: VoxCpmOptions) { this.options = options; this.requestFetch = options.fetch ?? globalThis.fetch; }
  capabilities(): TtsCapabilities { return { contractVersion: "2.0.0", supportedDimensions: ["affect", "urgency", "deliveryMode", "pace", "energy"], degradableDimensions: ["affect", "pace", "energy"], supportsStreaming: true, maxOutputSamples: 48000 }; }
  async *synthesize(request: TtsRequest, signal?: AbortSignal): AsyncIterable<TtsEvent> {
    if (request.format.sampleRateHz !== 48000 || request.format.channels !== 1) { yield { kind: "terminal", sequence: 0, segmentId: request.segmentId, outcome: "failed", outputSamples: 0, frameCount: 0, disposition: "providerFailure", degradedDimensions: [], mappingRevision: this.options.mappingRevision }; return; }
    const body: ProtocolRequest = { protocolVersion: PROTOCOL_VERSION, requestId: `${request.delivery.interactionId}:${request.segmentId}`, correlationId: request.decision.decisionId, interactionId: request.delivery.interactionId, deadlineAt: request.deadlineAt, voiceBundleKey: this.options.voiceBundleKey, voiceBundleRevision: this.options.voiceBundleRevision, text: request.text, delivery: request.delivery, format: { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 } };
    let response: Response;
    try { response = await this.requestFetch(`${this.options.baseUrl}/v1/tts/synthesize`, { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) }); } catch { yield { kind: "terminal", sequence: 0, segmentId: request.segmentId, outcome: signal?.aborted ? "cancelled" : "failed", outputSamples: 0, frameCount: 0, disposition: signal?.aborted ? "cancelled" : "providerFailure", degradedDimensions: [], mappingRevision: this.options.mappingRevision }; return; }
    if (!response.ok || !response.body) { yield { kind: "terminal", sequence: 0, segmentId: request.segmentId, outcome: "failed", outputSamples: 0, frameCount: 0, disposition: "providerFailure", degradedDimensions: [], mappingRevision: this.options.mappingRevision }; return; }
    let sequence = 0;
    let sawPreAudio = false;
    let sawTerminal = false;
    let outputSamples = 0;
    let frameCount = 0;
    try {
      for await (const event of readProtocolEvents(response.body)) {
        if (sawTerminal || event.sequence !== sequence) throw new Error("protocol sequence invalid");
        if (!sawPreAudio && event.kind !== "preAudio") throw new Error("protocol lifecycle invalid");
        if (event.kind === "preAudio") {
          if (sawPreAudio) throw new Error("duplicate preAudio event");
          if (event.requestId !== body.requestId || event.correlationId !== body.correlationId || event.voiceBundleRevision !== body.voiceBundleRevision || event.mappingRevision !== this.options.mappingRevision) throw new Error("protocol correlation mismatch");
          if (event.format.encoding !== body.format.encoding || event.format.sampleRateHz !== body.format.sampleRateHz || event.format.channels !== body.format.channels) throw new Error("protocol format mismatch");
          sawPreAudio = true;
        }
        if (event.kind === "data") {
          if (event.format.encoding !== body.format.encoding || event.format.sampleRateHz !== body.format.sampleRateHz || event.format.channels !== body.format.channels || !Number.isInteger(event.sampleCount) || event.sampleCount < 1 || event.sampleCount > 4800 || !Number.isInteger(event.sampleOffset) || event.sampleOffset < 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.dataBase64) || event.dataBase64.length < 4) throw new Error("protocol audio chunk invalid");
          outputSamples += event.sampleCount;
          frameCount += 1;
          if (outputSamples > (request.maxOutputSamples ?? this.capabilities().maxOutputSamples)) throw new Error("protocol output limit exceeded");
        }
        if (event.kind === "terminal" && (!Number.isInteger(event.outputSamples) || event.outputSamples < 0 || !Number.isInteger(event.frameCount) || event.frameCount < 0 || event.outputSamples !== outputSamples || event.frameCount !== frameCount || event.outputSamples > (request.maxOutputSamples ?? this.capabilities().maxOutputSamples))) throw new Error("protocol terminal counts invalid");
        yield this.mapEvent(event, request);
        sequence += 1;
        sawTerminal = event.kind === "terminal";
      }
      if (!sawPreAudio || !sawTerminal) throw new Error("protocol lifecycle invalid");
    } catch {
      if (sawTerminal) return;
      yield { kind: "terminal", sequence, segmentId: request.segmentId, outcome: signal?.aborted ? "cancelled" : "failed", outputSamples: 0, frameCount: 0, disposition: signal?.aborted ? "cancelled" : "providerFailure", degradedDimensions: [], mappingRevision: this.options.mappingRevision };
    }
  }
  private mapEvent(event: ProtocolEvent, request: TtsRequest): TtsEvent { if (event.kind === "preAudio") return { kind: "preAudio", sequence: 0, segmentId: request.segmentId, decisionId: request.decision.decisionId, decisionRevision: request.decision.revision, delivery: structuredClone(request.delivery), disposition: event.degradedDimensions.length ? "partiallyApplied" : "fullyApplied", degradedDimensions: event.degradedDimensions as never[], mappingRevision: event.mappingRevision }; if (event.kind === "data") return { kind: "data", sequence: event.sequence, segmentId: request.segmentId, frame: { frameId: `${request.segmentId}:${event.sequence}`, sequence: event.sequence - 1, format: request.format, sampleOffset: event.sampleOffset, sampleCount: event.sampleCount, dataBase64: event.dataBase64 }, mappingRevision: this.options.mappingRevision }; return { kind: "terminal", sequence: event.sequence, segmentId: request.segmentId, outcome: event.outcome === "completed" ? "succeeded" : event.outcome === "cancelled" ? "cancelled" : event.outcome === "deadlineExceeded" ? "timedOut" : "failed", outputSamples: event.outputSamples, frameCount: event.frameCount, disposition: event.outcome === "completed" ? "fullyApplied" : event.outcome === "cancelled" ? "cancelled" : event.outcome === "deadlineExceeded" ? "timedOut" : "providerFailure", degradedDimensions: [], mappingRevision: this.options.mappingRevision }; }
}
