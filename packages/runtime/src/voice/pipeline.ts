import type { AudioFormat, AudioFrame, ExpressiveSemanticDecision, SpeechRequest, SpeechToTextProvider, TextToSpeechProvider, TtsRequest, VoiceProfileRef } from "./ports.js";
import type { TraceOutbox } from "../observability/outbox.ts";

export type VoiceInteractionRequest = { audio: AsyncIterable<unknown>; format: AudioFormat; speechRequest: SpeechRequest; interactionId?: string; expressionDecision?: ExpressiveSemanticDecision; trace?: TraceOutbox; signal?: AbortSignal };
export type PlaybackSink = { play(segmentId: string, frame: AudioFrame): Promise<void>; close(): Promise<void> };
export type VoicePipelineResult = { status: "succeeded" | "cancelled" | "failed"; committedText: string[]; milestones: { name: string; at: number }[]; reason?: string };
export type VoiceInference = (text: string, signal?: AbortSignal) => AsyncIterable<string>;
const defaultVoice: VoiceProfileRef = { voiceRef: "fixture-voice", revision: 1 };
const defaultDecision = (interactionId: string): ExpressiveSemanticDecision => ({ decisionId: `${interactionId}-decision`, revision: 1, valence: 0, arousal: 0.35, urgency: "normal", deliveryMode: "neutral", pace: 0.5, energy: 0.4 });
const safeSegments = (text: string): { segmentId: string; sequence: number; text: string }[] => text.replace(/\[\[[\s\S]*?\]\]|<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim() ? [{ segmentId: "segment-0", sequence: 0, text: text.replace(/\[\[[\s\S]*?\]\]|<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim() }] : [];

export class VoicePipeline {
  private readonly stt: SpeechToTextProvider; private readonly inference: VoiceInference; private readonly tts: TextToSpeechProvider; private readonly playback: PlaybackSink; private readonly now: () => number;
  constructor(stt: SpeechToTextProvider, inference: VoiceInference, tts: TextToSpeechProvider, playback: PlaybackSink, now: () => number = () => Date.now()) { this.stt = stt; this.inference = inference; this.tts = tts; this.playback = playback; this.now = now; }

  async run(request: VoiceInteractionRequest): Promise<VoicePipelineResult> {
    const milestones: { name: string; at: number }[] = []; const committedText: string[] = [];
    const mark = (name: string) => milestones.push({ name, at: this.now() });
    mark("stt.request");
    try {
      for await (const event of this.stt.transcribe(request.speechRequest, request.audio as AsyncIterable<never>, request.signal)) {
        if (event.kind === "data") {
          if (event.payload.type !== "committed") continue;
          committedText.push(event.payload.text); mark("stt.commit");
          for await (const text of this.inference(event.payload.text, request.signal)) {
            mark("inference.first-token");
            const interactionId = request.interactionId ?? "fixture-interaction";
            const decision = request.expressionDecision ?? defaultDecision(interactionId);
            const segments = safeSegments(text);
            for (const segment of segments) {
              const ttsRequest: TtsRequest = { ...request.speechRequest, contractVersion: "2.0.0", text: segment.text, segmentId: segment.segmentId, format: request.format, voiceProfile: defaultVoice, decision, delivery: { interactionId, segmentId: segment.segmentId, decisionId: decision.decisionId, decisionRevision: decision.revision, deliveryMode: decision.deliveryMode, urgency: decision.urgency, pace: decision.pace, energy: decision.energy } };
              request.trace?.append({ id: `${interactionId}:${segment.segmentId}:request`, traceId: interactionId, sequence: segment.sequence * 10, payload: { event: "speech.delivery.requested", segmentId: segment.segmentId, decisionId: decision.decisionId, decisionRevision: decision.revision, deliveryMode: decision.deliveryMode, urgency: decision.urgency } });
              for await (const audio of this.tts.synthesize(ttsRequest, request.signal)) {
              if (audio.kind === "preAudio") { request.trace?.append({ id: `${interactionId}:${segment.segmentId}:preAudio`, traceId: interactionId, sequence: segment.sequence * 10 + 1, payload: { event: "speech.delivery.applied", segmentId: audio.segmentId, decisionId: audio.decisionId, decisionRevision: audio.decisionRevision, disposition: audio.disposition, degradedDimensions: audio.degradedDimensions, mappingRevision: audio.mappingRevision } }); }
              if (audio.kind === "data") { mark("tts.first-audio"); await this.playback.play(audio.segmentId, audio.frame); mark("playback.first-sample"); }
              else if (audio.kind === "terminal" && audio.outcome !== "succeeded") { await this.playback.close(); return { status: audio.outcome === "cancelled" ? "cancelled" : "failed", committedText, milestones, reason: audio.outcome }; }
              }
            }
          }
        } else if (event.outcome !== "succeeded") { await this.playback.close(); return { status: event.outcome === "cancelled" ? "cancelled" : "failed", committedText, milestones, reason: event.outcome }; }
      }
      await this.playback.close(); return { status: "succeeded", committedText, milestones };
    } catch (error) { await this.playback.close(); return { status: "failed", committedText, milestones, reason: error instanceof Error ? error.message : "voice_pipeline_failed" }; }
  }
}
