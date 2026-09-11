import { createHash } from "node:crypto";
const PROTOCOL_VERSION = "voxcpm.loopback.v1" as const;
type ProtocolRequest = { protocolVersion: typeof PROTOCOL_VERSION; requestId: string; correlationId: string; interactionId: string; deadlineAt: string; voiceBundleKey: string; voiceBundleRevision: number; text: string; delivery: Record<string, unknown>; format: { encoding: "pcm_s16le"; sampleRateHz: 48000; channels: 1 } };
type ProtocolEvent = { kind: "preAudio"; sequence: 0; requestId: string; correlationId: string; voiceBundleRevision: number; requestedDelivery: Record<string, unknown>; appliedDelivery: Record<string, unknown>; degradedDimensions: string[]; mappingRevision: string; effectiveSynthesis: Record<string, unknown>; format: ProtocolRequest["format"]; runtimeRevision: string; modelRevision: string } | { kind: "data"; sequence: number; sampleOffset: number; sampleCount: number; dataBase64: string; format: ProtocolRequest["format"] } | { kind: "terminal"; sequence: number; outcome: "completed" | "cancelled" | "deadlineExceeded" | "retryableProviderFailure" | "nonRetryableProviderFailure" | "malformedRequest" | "unsupportedRequest" | "providerUnavailable"; outputSamples: number; frameCount: number; errorCode?: string };

type Delivery = { interactionId: string; segmentId: string; decisionId: string; decisionRevision: number; deliveryMode: string; urgency: string; pace: number; energy: number };
type TtsRequest = { contractVersion: "2.0.0"; text: string; segmentId: string; format: { encoding: "pcm_s16le"; sampleRateHz: 16000 | 24000 | 48000; channels: 1 | 2 }; voiceProfile: { voiceRef: string; revision: number }; decision: { decisionId: string; revision: number }; delivery: Delivery; deadlineAt: string };
type TtsEvent = { kind: "preAudio"; sequence: number; segmentId: string; decisionId: string; decisionRevision: number; delivery: Record<string, unknown>; disposition: "fullyApplied" | "partiallyApplied"; degradedDimensions: string[]; mappingRevision: string } | { kind: "data"; sequence: number; segmentId: string; frame: { frameId: string; sequence: number; format: TtsRequest["format"]; sampleOffset: number; sampleCount: number; dataBase64: string }; mappingRevision: string } | { kind: "terminal"; sequence: number; segmentId: string; outcome: "succeeded" | "cancelled" | "timedOut" | "failed"; outputSamples: number; frameCount: number; disposition: "fullyApplied" | "partiallyApplied" | "providerFailure" | "cancelled" | "timedOut"; degradedDimensions: string[]; mappingRevision: string };
type TtsCapabilities = { contractVersion: "2.0.0"; supportedDimensions: readonly string[]; degradableDimensions: readonly string[]; supportsStreaming: true; maxOutputSamples: number };
interface TextToSpeechProvider { capabilities(): TtsCapabilities; synthesize(request: TtsRequest, signal?: AbortSignal): AsyncIterable<TtsEvent>; }

type VoiceReference = { dataBase64: string; sampleRateHz: 16000; transcript: string };
type VoiceDesign = { description: string; seed: number; reference?: VoiceReference | null };
export type VoxCpmOptions = { baseUrl: string; voiceBundleKey: string; voiceBundleRevision: number; runtimeRevision: string; modelRevision: string; mappingRevision: string; voiceDesign?: VoiceDesign; fetch?: typeof globalThis.fetch; onDiagnostic?: (event: { requestId: string; code: string }) => void };

export class VoxCpmProvider implements TextToSpeechProvider {
  private readonly options: VoxCpmOptions;
  private readonly requestFetch: typeof globalThis.fetch;
  private controls: { description: boolean; reference: boolean } | undefined;
  constructor(options: VoxCpmOptions) { this.options = options; this.requestFetch = options.fetch ?? globalThis.fetch; }
  withVoiceDesign(voiceDesign: VoiceDesign): VoxCpmProvider { const provider = new VoxCpmProvider({ ...this.options, voiceDesign }); provider.controls = this.controls; return provider; }
  async voiceControls(): Promise<{ description: boolean; reference: boolean }> {
    if (this.controls) return { ...this.controls };
    try { const response = await this.requestFetch(`${this.options.baseUrl}/v1/capabilities`, { signal: AbortSignal.timeout(2000) }); const body = await response.json() as { voiceDesignControl?: string; voiceReferenceControl?: string }; if (response.ok) this.controls = { description: body.voiceDesignControl === "voxcpm.voice-design.v1", reference: body.voiceReferenceControl === "voxcpm.voice-reference.v1" }; return this.controls ? { ...this.controls } : { description: false, reference: false }; } catch { return { description: false, reference: false }; }
  }
  async supportsVoiceDesign(): Promise<boolean> { return (await this.voiceControls()).description; }
  capabilities(): TtsCapabilities { return { contractVersion: "2.0.0", supportedDimensions: ["urgency", "deliveryMode", "pace", "energy"], degradableDimensions: ["affect", "urgency", "deliveryMode", "pace", "energy"], supportsStreaming: true, maxOutputSamples: 48_000 * 60 }; }

  async *synthesize(request: TtsRequest, signal?: AbortSignal): AsyncIterable<TtsEvent> {
    const body: ProtocolRequest = { protocolVersion: PROTOCOL_VERSION, requestId: `${request.delivery.interactionId}:${request.segmentId}`, correlationId: request.decision.decisionId, interactionId: request.delivery.interactionId, deadlineAt: request.deadlineAt, voiceBundleKey: this.options.voiceBundleKey, voiceBundleRevision: this.options.voiceBundleRevision, text: request.text, delivery: request.delivery, format: { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 } };
    let nextSequence = 0, nextOffset = 0, frames = 0;
    let degraded: string[] = [];
    let disposition: "fullyApplied" | "partiallyApplied" = "fullyApplied";
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const remainingMs = Date.parse(request.deadlineAt) - Date.now();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, remainingMs));
    try {
      if (remainingMs <= 0) { timedOut = true; throw new Error("speech deadline expired"); }
      const design = this.options.voiceDesign, reference = design?.reference;
      const referenceDigest = reference ? createHash("sha256").update(Buffer.from(reference.dataBase64, "base64")).digest("hex") : null;
      const response = await this.requestFetch(`${this.options.baseUrl}/v1/tts/synthesize`, { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ ...body, ...(design ? { voiceDesign: { version: "voxcpm.voice-design.v1", description: design.description, seed: design.seed } } : {}), ...(reference ? { voiceReference: { version: "voxcpm.voice-reference.v1", sampleRateHz: reference.sampleRateHz, dataBase64: reference.dataBase64, transcript: reference.transcript } } : {}) }), signal: controller.signal });
      reader = response.body?.getReader();
      if (!response.ok || !response.body) throw new Error(`provider HTTP ${response.status}`);
      const decoder = new TextDecoder();
      let buffer = "", terminalSeen = false, preAudioSeen = false;
      while (!terminalSeen) {
        const { value, done } = await reader!.read();
        if (controller.signal.aborted) throw new Error("speech request aborted");
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = done ? "" : (lines.pop() ?? "");
        for (const raw of lines) {
          if (!raw.trim()) continue;
          const event = JSON.parse(raw) as ProtocolEvent;
          if (event.sequence !== nextSequence++) throw new Error("protocol sequence invalid");
          if (event.kind === "preAudio") {
            if (preAudioSeen || event.sequence !== 0 || event.requestId !== body.requestId || event.correlationId !== body.correlationId || event.voiceBundleRevision !== body.voiceBundleRevision) throw new Error("protocol identity invalid");
            if (event.runtimeRevision !== this.options.runtimeRevision || event.modelRevision !== this.options.modelRevision || event.mappingRevision !== this.options.mappingRevision) throw new Error("protocol revision invalid");
            if (this.options.voiceDesign && (event.effectiveSynthesis.voiceDescription !== this.options.voiceDesign.description || event.effectiveSynthesis.seed !== this.options.voiceDesign.seed)) throw new Error("provider did not apply voice design settings");
            if (referenceDigest && event.effectiveSynthesis.referenceDigest !== referenceDigest) throw new Error("provider did not apply the reference audio");
            if (reference && event.effectiveSynthesis.conditioningMode !== (reference.transcript ? "continuation" : "reference")) throw new Error("provider did not apply the reference conditioning mode");
            preAudioSeen = true;
            degraded = [...event.degradedDimensions];
            disposition = degraded.length ? "partiallyApplied" : "fullyApplied";
          } else if (event.kind === "data") {
            if (!preAudioSeen || event.sequence === 0 || event.sampleOffset !== nextOffset || event.sampleCount < 1 || event.sampleCount > 4800) throw new Error("protocol audio ordering invalid");
            if (Buffer.from(event.dataBase64, "base64").byteLength !== event.sampleCount * 2) throw new Error("protocol PCM length invalid");
            nextOffset += event.sampleCount; frames += 1;
          } else {
            const terminalOnly = event.sequence === 0 && event.outcome !== "completed" && event.outputSamples === 0 && event.frameCount === 0;
            if ((!preAudioSeen && !terminalOnly) || event.outputSamples !== nextOffset || event.frameCount !== frames) throw new Error("protocol terminal counts invalid");
            terminalSeen = true;
            if (event.outcome !== "completed") this.options.onDiagnostic?.({ requestId: body.requestId, code: `remote:${event.outcome}` });
          }
          yield this.mapEvent(event, request, disposition, degraded);
          if (terminalSeen) break;
        }
        if (done && !terminalSeen) throw new Error("protocol lifecycle invalid");
      }
    } catch (error) {
      // Only adapter-authored diagnostics; never log request text, audio, keys,
      // remote exception strings, or arbitrary fetch error messages.
      const message = error instanceof Error ? error.message : "";
      const code = /^(protocol (sequence|identity|revision|audio ordering|PCM length|terminal counts|lifecycle) invalid|provider HTTP \d{3}|provider did not apply (voice design settings|the reference audio|the reference conditioning mode)|speech deadline expired|speech request aborted)$/u.test(message) ? message : "transport_or_parse_failure";
      if (!signal?.aborted) this.options.onDiagnostic?.({ requestId: body.requestId, code });
      yield { kind: "terminal", sequence: nextSequence, segmentId: request.segmentId, outcome: signal?.aborted ? "cancelled" : timedOut ? "timedOut" : "failed", outputSamples: nextOffset, frameCount: frames, disposition: signal?.aborted ? "cancelled" : timedOut ? "timedOut" : "providerFailure", degradedDimensions: degraded, mappingRevision: this.options.mappingRevision };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
      if (reader) { try { await reader.cancel(); } catch { /* Transport may already be closed. */ } finally { reader.releaseLock(); } }
    }
  }

  private mapEvent(event: ProtocolEvent, request: TtsRequest, disposition: "fullyApplied" | "partiallyApplied", degraded: string[]): TtsEvent {
    if (event.kind === "preAudio") return { kind: "preAudio", sequence: event.sequence, segmentId: request.segmentId, decisionId: request.decision.decisionId, decisionRevision: request.decision.revision, delivery: structuredClone(event.appliedDelivery), disposition, degradedDimensions: [...event.degradedDimensions], mappingRevision: event.mappingRevision };
    if (event.kind === "data") return { kind: "data", sequence: event.sequence, segmentId: request.segmentId, frame: { frameId: `${request.segmentId}:${event.sequence}`, sequence: event.sequence - 1, format: request.format, sampleOffset: event.sampleOffset, sampleCount: event.sampleCount, dataBase64: event.dataBase64 }, mappingRevision: this.options.mappingRevision };
    const outcome = event.outcome === "completed" ? "succeeded" : event.outcome === "cancelled" ? "cancelled" : event.outcome === "deadlineExceeded" ? "timedOut" : "failed";
    return { kind: "terminal", sequence: event.sequence, segmentId: request.segmentId, outcome, outputSamples: event.outputSamples, frameCount: event.frameCount, disposition: outcome === "succeeded" ? disposition : outcome === "cancelled" ? "cancelled" : outcome === "timedOut" ? "timedOut" : "providerFailure", degradedDimensions: [...degraded], mappingRevision: this.options.mappingRevision };
  }
}
