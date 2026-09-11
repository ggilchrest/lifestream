import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { InferenceProvider } from "@lifestream/runtime/inference";
import { SpeechSafeSegmenter } from "@lifestream/runtime/voice/segmenter";
import { buildCanonicalPrompt } from "@lifestream/runtime/inference/prompt";
import type { AudioFrame, SpeechToTextProvider } from "@lifestream/runtime/voice";
import type { VoxCpmProvider } from "@lifestream/providers-voxcpm";
import { defaultVoiceSettings, parseVoiceSettings, type VoiceSettings } from "./voice-settings.ts";
import { SpeechQueue } from "./speech-queue.ts";

type AudioRequest = { schemaVersion: "1.0.0"; requestId: string; correlationId: string; sessionId: string; expectedSessionRevision: number; endpointId: string; audioInputId: string; format: AudioFrame["format"]; voiceSettings?: VoiceSettings };
type AudioClientMessage = { type: "start"; request: AudioRequest } | { type: "frame"; audioInputId: string; frame: AudioFrame } | { type: "commitTurn"; audioInputId: string; nextSequence: number; sampleCount: number } | { type: "interrupt"; interactionTraceId: string; reason: string } | { type: "stop"; audioInputId: string };
type AudioSocket = Pick<WebSocket, "send" | "close"> & { readyState: number };
const OPEN = 1;
const send = (socket: AudioSocket, message: Record<string, unknown>) => { if (socket.readyState === OPEN) socket.send(JSON.stringify(message)); };
const validUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const response = (socket: AudioSocket, interactionTraceId: string, sequence: number, payload: Record<string, unknown>) => send(socket, { type: "response", event: { schemaVersion: "1.0.0", interactionTraceId, sequence, occurredAt: new Date().toISOString(), payload } });
const problem = (code: string, message: string, correlationId: string, retryable = false) => ({ code, message, retryable, correlationId, details: {} });
export const hasAudioEnergy = (dataBase64: string, threshold = 0.015): boolean => { const bytes = Buffer.from(dataBase64, "base64"); if (bytes.length < 2) return false; let energy = 0; for (let offset = 0; offset + 1 < bytes.length; offset += 2) { const sample = bytes.readInt16LE(offset) / 32768; energy += sample * sample; } return Math.sqrt(energy / (bytes.length / 2)) >= threshold; };

export const VOICE_TURN_DEADLINE_MS = 180_000;
export const SPEECH_SEGMENT_DEADLINE_MS = 45_000;
export type AudioDependencies = { stt: SpeechToTextProvider; inference: InferenceProvider; tts: VoxCpmProvider };

export class AudioSession {
  private readonly socket: AudioSocket;
  private readonly deps: AudioDependencies;
  private readonly sessionId: string;
  private request: AudioRequest | undefined;
  private frames: AudioFrame[] = [];
  private controller: AbortController | undefined;
  private interactionTraceId: string | undefined;
  private turnQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private pendingTurns = 0;
  private starting = false;
  private voiceSettings: VoiceSettings = { ...defaultVoiceSettings };
  private sequence = 0;
  private readonly identity = { assistantId: randomUUID(), environmentId: randomUUID(), conversationId: randomUUID() };

  constructor(socket: AudioSocket, deps: AudioDependencies, sessionId: string) { this.socket = socket; this.deps = deps; this.sessionId = sessionId; }

  close(): void { this.closed = true; this.frames = []; this.voiceSettings = { ...defaultVoiceSettings }; this.request = undefined; this.controller?.abort(); this.socket.close(1001, "audio session closed"); }

  async message(raw: string): Promise<void> {
    if (this.closed) return;
    let message: AudioClientMessage;
    try { message = JSON.parse(raw) as AudioClientMessage; } catch { this.socket.close(1003, "malformed JSON"); return; }
    if (message.type === "start") return this.start(message.request);
    const request = this.request;
    if (!request || ((message.type === "frame" || message.type === "commitTurn" || message.type === "stop") && message.audioInputId !== request.audioInputId)) return send(this.socket, { type: "error", requestId: request?.requestId ?? randomUUID(), problem: problem("audio_input_identity_changed", "audio input identity changed", request?.correlationId ?? randomUUID()) });
    if (message.type === "frame") {
      const expectedSamples = this.sampleCount();
      if (message.frame.sequence !== this.frames.length || message.frame.sampleOffset !== expectedSamples || message.frame.format.encoding !== "pcm_s16le" || message.frame.format.sampleRateHz !== 16000 || message.frame.format.channels !== 1 || message.frame.sampleCount < 1 || message.frame.sampleCount > 4800 || Buffer.from(message.frame.dataBase64, "base64").length !== message.frame.sampleCount * 2) return send(this.socket, { type: "error", requestId: request.requestId, problem: problem("audio_frame_invalid", "audio frame sequence, format, offset, or payload is invalid", request.correlationId) });
      if (expectedSamples + message.frame.sampleCount > 480_000) { send(this.socket, { type: "error", problem: problem("audio_input_limit", "Utterance exceeds 30 seconds; reconnect voice.", request.correlationId) }); this.close(); return; }
      // Audio energy is not speech. The endpoint sends an explicit interrupt
      // after speech qualification; this route must not bypass that gate.
      this.frames.push(message.frame); return;
    }
    if (message.type === "interrupt") { if (message.interactionTraceId === this.interactionTraceId) { this.controller?.abort(); send(this.socket, { type: "stopPlayback", interactionTraceId: message.interactionTraceId, reason: message.reason }); } return; }
    if (message.type === "stop") { this.close(); return; }
    if (message.type !== "commitTurn") return;
    if (message.nextSequence !== this.frames.length || message.sampleCount !== this.sampleCount()) return send(this.socket, { type: "error", requestId: request.requestId, problem: problem("audio_commit_invalid", "audio commit accounting is invalid", request.correlationId) });
    const frames = this.frames.slice(); this.frames = [];
    if (!frames.length || this.pendingTurns >= 3) { send(this.socket, { type: "error", problem: problem("audio_queue_limit", "Voice queue is full or empty input was committed; reconnect voice.", request.correlationId) }); this.close(); return; }
    this.pendingTurns++;
    this.turnQueue = this.turnQueue.then(() => this.runTurn(frames)).finally(() => { this.pendingTurns--; });
    await this.turnQueue;
  }

  private async start(request: AudioRequest): Promise<void> {
    if (this.starting || this.request || !request || request.sessionId !== this.sessionId || request.schemaVersion !== "1.0.0" || !validUuid(request.requestId) || !validUuid(request.correlationId) || !validUuid(request.sessionId) || !validUuid(request.endpointId) || !validUuid(request.audioInputId) || !Number.isInteger(request.expectedSessionRevision) || request.expectedSessionRevision < 0 || request.format?.encoding !== "pcm_s16le" || request.format.sampleRateHz !== 16000 || request.format.channels !== 1) { this.close(); return; }
    this.starting = true;
    let settings: VoiceSettings;
    try { settings = parseVoiceSettings(request.voiceSettings); }
    catch (error) { send(this.socket, { type: "error", problem: { message: error instanceof Error ? error.message : "Invalid voice settings" } }); this.close(); return; }
    if (settings.description || settings.seed !== 0 || settings.reference) {
      const controls = await this.deps.tts.voiceControls();
      if (this.closed) return;
      if (!controls.description || (settings.reference && !controls.reference)) { send(this.socket, { type: "error", problem: { message: "Requested voice controls are unavailable on this sidecar. Clear them or use a supported profile." } }); this.close(); return; }
    }
    if (this.closed) return;
    this.voiceSettings = settings;
    this.request = request;
    send(this.socket, { type: "accepted", identity: { ...this.identity, sessionId: request.sessionId, endpointId: request.endpointId, interactionTraceId: request.correlationId }, audioInputId: request.audioInputId });
  }

  private sampleCount(): number { return this.frames.reduce((total, frame) => total + frame.sampleCount, 0); }

  private async runTurn(frames: AudioFrame[]): Promise<void> {
    const request = this.request!; if (this.controller || this.closed) return;
    this.controller = new AbortController(); this.interactionTraceId = randomUUID(); this.sequence = 0;
    const traceId = this.interactionTraceId; const deadlineAt = new Date(Date.now() + VOICE_TURN_DEADLINE_MS).toISOString();
    const controller = this.controller;
    let timedOut = false, internalFailure = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, VOICE_TURN_DEADLINE_MS);
    send(this.socket, { type: "turnStarted", interactionTraceId: traceId });
    const audio = async function* () { for (const frame of frames) yield { type: "frame" as const, audioInputId: request.audioInputId, frame }; yield { type: "end" as const, audioInputId: request.audioInputId, nextSequence: frames.length, sampleCount: frames.reduce((total, frame) => total + frame.sampleCount, 0) }; }();
    try {
      let transcript: string | undefined;
      for await (const stt of this.deps.stt.transcribe({ deadlineAt: new Date(Math.min(Date.parse(deadlineAt), Date.now() + 30_000)).toISOString(), now: () => new Date().toISOString() }, audio, this.controller.signal)) {
        if (stt.kind === "terminal" && stt.outcome !== "succeeded") throw new Error(`Speech recognition ${stt.outcome}; check the selected STT service and retry this turn.`);
        if (stt.kind !== "data" || stt.payload.type !== "committed" || transcript !== undefined) continue;
        transcript = stt.payload.text;
        send(this.socket, { type: "transcript", interactionTraceId: traceId, state: "committed", text: stt.payload.text });
      }
      // Finish recognition and its transport/deadline before starting the
      // independently bounded inference/speech phases. Never emit a completed
      // answer and only then discover a failed recognition terminal.
      if (transcript === undefined || !transcript.trim()) throw new Error("speech input did not produce a committed transcript");
      if (controller.signal.aborted) throw new Error("audio turn interrupted");
        const prompt = buildCanonicalPrompt({ assistantId: this.identity.assistantId, sessionId: request.sessionId, interactionId: traceId, endpointId: request.endpointId, userInput: transcript, deadlineAt, executionMode: "live", voiceMode: true });
        let answer = "";
        const segmenter = new SpeechSafeSegmenter(360);
        const queue = new SpeechQueue(controller.signal);
        const pacer = new PcmPacer();
        const decisionId = randomUUID();
        const tts = this.voiceSettings.description || this.voiceSettings.seed !== 0 || this.voiceSettings.reference ? this.deps.tts.withVoiceDesign({ description: this.voiceSettings.description, seed: this.voiceSettings.seed, reference: this.voiceSettings.reference }) : this.deps.tts;
        const voiceSettings=this.voiceSettings;
        const speak = async function* (text: string) {
        const speechDeadlineAt = new Date(Math.min(Date.parse(deadlineAt), Date.now() + SPEECH_SEGMENT_DEADLINE_MS)).toISOString();
        const segmentId = randomUUID();
        let speechSucceeded = false;
        let speechSamples = 0;
        for await (const speech of tts.synthesize({ contractVersion: "2.0.0", text, segmentId, format: { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 }, voiceProfile: { voiceRef: "fixture-voice-design", revision: 1 }, decision: { decisionId, revision: 1 }, delivery: { interactionId: traceId, segmentId, decisionId, decisionRevision: 1, deliveryMode: voiceSettings.deliveryMode, urgency: "normal", pace: voiceSettings.pace, energy: voiceSettings.energy }, deadlineAt: speechDeadlineAt }, controller.signal)) {
          if (controller.signal.aborted) throw new Error("audio turn interrupted");
          if (speech.kind === "data") { speechSamples += speech.frame.sampleCount; yield speech; }
          if (speech.kind === "terminal") {
            if (speech.outcome !== "succeeded") throw new Error(`speech synthesis ${speech.outcome}`);
            speechSucceeded = true;
          }
        }
        if (!speechSucceeded) throw new Error("speech synthesis returned no successful terminal");
        if (!speechSamples) throw new Error("speech synthesis returned no audio");
        if (controller.signal.aborted) throw new Error("audio turn interrupted");

        };
        const generation = (async () => {
        for await (const chunk of this.deps.inference.generate(prompt, { signal: controller.signal })) {
          if (controller.signal.aborted) throw new Error("audio turn interrupted");
          if (chunk.kind === "text" && chunk.text) { answer += chunk.text; if (answer.length > 16_384) throw new Error("voice response text limit exceeded"); response(this.socket, traceId, this.sequence++, { type: "textDelta", text: chunk.text }); for (const segment of segmenter.push(chunk.text)) await queue.put(segment.text); }
          if (chunk.kind === "capabilityRequest" && chunk.capability?.effect === "read-only") response(this.socket, traceId, this.sequence++, { type: "capabilityStatus", result: { capabilityName: chunk.capability.name, state: "selected", effect: "read-only", outcome: "notDispatched" } });
          if (chunk.kind === "error") throw new Error(chunk.error?.message ?? "inference failed");
        }
        if (!answer.trim()) throw new Error("inference returned no text");
        if (controller.signal.aborted) throw new Error("audio turn interrupted");
        for (const segment of segmenter.flush()) await queue.put(segment.text);
        queue.close();
        })().catch(error => { queue.close(error); throw error; });
        // Attach immediately; the consumer may still be producing PCM when
        // inference fails. Keep both activities bounded and settle both.
        void generation.catch(() => {});
        const synthesis=async function*(){for await(const text of queue)yield* speak(text);};
        try { for await (const speech of bufferedStream(synthesis(),controller.signal,64,()=>{if(!controller.signal.aborted){internalFailure=true;controller.abort();}})) {await pacer.admit(speech.frame.sampleCount,speech.frame.format.sampleRateHz,controller.signal);send(this.socket,{type:"audio",interactionTraceId:traceId,chunk:{segmentId:speech.segmentId,frame:speech.frame}});} await generation; }
        catch (error) { internalFailure ||= !controller.signal.aborted; controller.abort(); queue.close(error); await generation.catch(() => {}); throw error; }
        response(this.socket, traceId, this.sequence++, { type: "terminal", state: "completed", finalResponse: null, error: null });
    } catch (error) {
      const interrupted = this.controller.signal.aborted && !timedOut && !internalFailure;
      response(this.socket, traceId, this.sequence++, { type: "terminal", state: interrupted ? "interrupted" : "failed", finalResponse: null, error: problem(interrupted ? "audio_interrupted" : timedOut ? "audio_deadline_exceeded" : "audio_turn_failed", timedOut ? "Voice turn exceeded its 180 second limit; you can try another turn." : error instanceof Error ? error.message : "audio turn failed", traceId, !interrupted) });
    } finally { clearTimeout(timer); this.controller = undefined; this.interactionTraceId = undefined; }
  }
}
import {PcmPacer} from './pcm-pacer.ts';
import {bufferedStream} from './buffered-stream.ts';
