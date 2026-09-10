import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { InferenceProvider } from "@lifestream/runtime/inference";
import { buildCanonicalPrompt } from "@lifestream/runtime/inference/prompt";
import type { AudioFrame, SpeechToTextProvider, TextToSpeechProvider } from "@lifestream/runtime/voice";
import type { VoxCpmProvider } from "@lifestream/providers-voxcpm";

type AudioRequest = { schemaVersion: "1.0.0"; requestId: string; correlationId: string; sessionId: string; expectedSessionRevision: number; endpointId: string; audioInputId: string; format: AudioFrame["format"] };
type AudioClientMessage = { type: "start"; request: AudioRequest } | { type: "frame"; audioInputId: string; frame: AudioFrame } | { type: "commitTurn"; audioInputId: string; nextSequence: number; sampleCount: number } | { type: "interrupt"; interactionTraceId: string; reason: string } | { type: "stop"; audioInputId: string };
type AudioSocket = Pick<WebSocket, "send" | "close"> & { readyState: number };
const OPEN = 1;
const send = (socket: AudioSocket, message: Record<string, unknown>) => { if (socket.readyState === OPEN) socket.send(JSON.stringify(message)); };
const validUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const response = (socket: AudioSocket, interactionTraceId: string, sequence: number, payload: Record<string, unknown>) => send(socket, { type: "response", event: { schemaVersion: "1.0.0", interactionTraceId, sequence, occurredAt: new Date().toISOString(), payload } });
const problem = (code: string, message: string, correlationId: string, retryable = false) => ({ code, message, retryable, correlationId, details: {} });
export const isSpeechFrame = (dataBase64: string, threshold = 0.015): boolean => { const bytes = Buffer.from(dataBase64, "base64"); if (bytes.length < 2) return false; let energy = 0; for (let offset = 0; offset + 1 < bytes.length; offset += 2) { const sample = bytes.readInt16LE(offset) / 32768; energy += sample * sample; } return Math.sqrt(energy / (bytes.length / 2)) >= threshold; };

export type AudioDependencies = { stt: SpeechToTextProvider; inference: InferenceProvider; tts: VoxCpmProvider };

export class AudioSession {
  private readonly socket: AudioSocket;
  private readonly deps: AudioDependencies;
  private readonly sessionId: string;
  private request?: AudioRequest;
  private frames: AudioFrame[] = [];
  private controller: AbortController | undefined;
  private interactionTraceId: string | undefined;
  private sequence = 0;
  private readonly identity = { assistantId: randomUUID(), environmentId: randomUUID(), conversationId: randomUUID() };

  constructor(socket: AudioSocket, deps: AudioDependencies, sessionId: string) { this.socket = socket; this.deps = deps; this.sessionId = sessionId; }

  close(): void { this.controller?.abort(); this.socket.close(1001, "server shutting down"); }

  async message(raw: string): Promise<void> {
    let message: AudioClientMessage;
    try { message = JSON.parse(raw) as AudioClientMessage; } catch { this.socket.close(1003, "malformed JSON"); return; }
    if (message.type === "start") return this.start(message.request);
    const request = this.request;
    if (!request || ((message.type === "frame" || message.type === "commitTurn" || message.type === "stop") && message.audioInputId !== request.audioInputId)) return send(this.socket, { type: "error", requestId: request?.requestId ?? randomUUID(), problem: problem("audio_input_identity_changed", "audio input identity changed", request?.correlationId ?? randomUUID()) });
    if (message.type === "frame") {
      const expectedSamples = this.sampleCount();
      if (message.frame.sequence !== this.frames.length || message.frame.sampleOffset !== expectedSamples || message.frame.format.encoding !== "pcm_s16le" || message.frame.format.sampleRateHz !== 16000 || message.frame.format.channels !== 1 || message.frame.sampleCount < 1 || message.frame.sampleCount > 4800 || Buffer.from(message.frame.dataBase64, "base64").length !== message.frame.sampleCount * 2) return send(this.socket, { type: "error", requestId: request.requestId, problem: problem("audio_frame_invalid", "audio frame sequence, format, offset, or payload is invalid", request.correlationId) });
      if (this.controller && this.interactionTraceId && isSpeechFrame(message.frame.dataBase64)) { const traceId = this.interactionTraceId; this.controller.abort(); send(this.socket, { type: "stopPlayback", interactionTraceId: traceId, reason: "barge-in speech detected" }); return; }
      this.frames.push(message.frame); return;
    }
    if (message.type === "interrupt") { if (message.interactionTraceId === this.interactionTraceId) { this.controller?.abort(); send(this.socket, { type: "stopPlayback", interactionTraceId: message.interactionTraceId, reason: message.reason }); } return; }
    if (message.type === "stop") { this.controller?.abort(); this.socket.close(1000, "audio session stopped"); return; }
    if (message.nextSequence !== this.frames.length || message.sampleCount !== this.sampleCount()) return send(this.socket, { type: "error", requestId: request.requestId, problem: problem("audio_commit_invalid", "audio commit accounting is invalid", request.correlationId) });
    await this.runTurn();
  }

  private start(request: AudioRequest): void {
    if (this.request || request.sessionId !== this.sessionId || request.schemaVersion !== "1.0.0" || !validUuid(request.requestId) || !validUuid(request.correlationId) || !validUuid(request.sessionId) || !validUuid(request.endpointId) || !validUuid(request.audioInputId) || request.expectedSessionRevision < 0 || request.format.encoding !== "pcm_s16le" || request.format.sampleRateHz !== 16000 || request.format.channels !== 1) return this.socket.close(1008, "invalid audio start");
    this.request = request;
    send(this.socket, { type: "accepted", identity: { ...this.identity, sessionId: request.sessionId, endpointId: request.endpointId, interactionTraceId: request.correlationId }, audioInputId: request.audioInputId });
  }

  private sampleCount(): number { return this.frames.reduce((total, frame) => total + frame.sampleCount, 0); }

  private async runTurn(): Promise<void> {
    const request = this.request!; if (this.controller) return;
    this.controller = new AbortController(); this.interactionTraceId = randomUUID(); this.sequence = 0;
    const traceId = this.interactionTraceId; const deadlineAt = new Date(Date.now() + 30_000).toISOString();
    const frames = this.frames.slice(); const audio = async function* () { for (const frame of frames) yield { type: "frame" as const, audioInputId: request.audioInputId, frame }; yield { type: "end" as const, audioInputId: request.audioInputId, nextSequence: frames.length, sampleCount: frames.reduce((total, frame) => total + frame.sampleCount, 0) }; }();
    try {
      let committed = false;
      for await (const stt of this.deps.stt.transcribe({ deadlineAt, now: () => new Date().toISOString() }, audio, this.controller.signal)) {
        if (stt.kind !== "data" || stt.payload.type !== "committed" || committed) continue;
        committed = true; response(this.socket, traceId, this.sequence++, { type: "textDelta", text: stt.payload.text });
        const prompt = buildCanonicalPrompt({ assistantId: this.identity.assistantId, sessionId: request.sessionId, interactionId: traceId, endpointId: request.endpointId, userInput: stt.payload.text, deadlineAt, executionMode: "live" });
        let answer = "";
        for await (const chunk of this.deps.inference.generate(prompt, { signal: this.controller.signal })) {
          if (chunk.kind === "text" && chunk.text) { answer += chunk.text; response(this.socket, traceId, this.sequence++, { type: "textDelta", text: chunk.text }); }
          if (chunk.kind === "capabilityRequest" && chunk.capability?.effect === "read-only") response(this.socket, traceId, this.sequence++, { type: "capabilityStatus", result: { capabilityName: chunk.capability.name, state: "selected", effect: "read-only", outcome: "notDispatched" } });
          if (chunk.kind === "error") throw new Error(chunk.error?.message ?? "inference failed");
        }
        if (!answer.trim()) throw new Error("inference returned no text");
        if (this.controller.signal.aborted) throw new Error("audio turn interrupted");
        const segmentId = randomUUID(); const decisionId = randomUUID();
        for await (const speech of this.deps.tts.synthesize({ contractVersion: "2.0.0", text: answer, segmentId, format: { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 }, voiceProfile: { voiceRef: "fixture-voice-design", revision: 1 }, decision: { decisionId, revision: 1 }, delivery: { interactionId: traceId, segmentId, decisionId, decisionRevision: 1, deliveryMode: "neutral", urgency: "normal", pace: 0.5, energy: 0.4 }, deadlineAt })) {
          if (this.controller.signal.aborted) throw new Error("audio turn interrupted");
          if (speech.kind === "data") send(this.socket, { type: "audio", interactionTraceId: traceId, chunk: { segmentId: speech.segmentId, frame: speech.frame } });
        }
        if (this.controller.signal.aborted) throw new Error("audio turn interrupted");
        response(this.socket, traceId, this.sequence++, { type: "terminal", state: "completed", finalResponse: null, error: null });
      }
      if (!committed) throw new Error("speech input did not produce a committed transcript");
    } catch (error) {
      const interrupted = this.controller.signal.aborted;
      response(this.socket, traceId, this.sequence++, { type: "terminal", state: interrupted ? "interrupted" : "failed", finalResponse: null, error: problem(interrupted ? "audio_interrupted" : "audio_turn_failed", error instanceof Error ? error.message : "audio turn failed", traceId, !interrupted) });
    } finally { this.controller = undefined; this.frames = []; this.interactionTraceId = undefined; }
  }
}
