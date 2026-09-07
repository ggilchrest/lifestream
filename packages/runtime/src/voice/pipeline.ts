import type { AudioFormat, AudioFrame, SpeechRequest, SpeechToTextProvider, TextToSpeechProvider } from "./ports.js";

export type VoiceInteractionRequest = { audio: AsyncIterable<unknown>; format: AudioFormat; speechRequest: SpeechRequest; signal?: AbortSignal };
export type PlaybackSink = { play(segmentId: string, frame: AudioFrame): Promise<void>; close(): Promise<void> };
export type VoicePipelineResult = { status: "succeeded" | "cancelled" | "failed"; committedText: string[]; milestones: { name: string; at: number }[]; reason?: string };
export type VoiceInference = (text: string, signal?: AbortSignal) => AsyncIterable<string>;

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
            for await (const audio of this.tts.synthesize(request.speechRequest, "fixture-segment", text, request.format, request.signal)) {
              if (audio.kind === "data") { mark("tts.first-audio"); await this.playback.play(audio.segmentId, audio.frame); mark("playback.first-sample"); }
              else if (audio.outcome !== "succeeded") { await this.playback.close(); return { status: audio.outcome === "cancelled" ? "cancelled" : "failed", committedText, milestones, reason: audio.outcome }; }
            }
          }
        } else if (event.outcome !== "succeeded") { await this.playback.close(); return { status: event.outcome === "cancelled" ? "cancelled" : "failed", committedText, milestones, reason: event.outcome }; }
      }
      await this.playback.close(); return { status: "succeeded", committedText, milestones };
    } catch (error) { await this.playback.close(); return { status: "failed", committedText, milestones, reason: error instanceof Error ? error.message : "voice_pipeline_failed" }; }
  }
}
