export type AudioFormat = { encoding: "pcm_s16le"; sampleRateHz: 16000 | 24000 | 48000; channels: 1 | 2 };
export type AudioFrame = { frameId: string; sequence: number; format: AudioFormat; sampleOffset: number; sampleCount: number; dataBase64: string };
export type SttInput = { type: "frame"; audioInputId: string; frame: AudioFrame } | { type: "end"; audioInputId: string; nextSequence: number; sampleCount: number };
export type SttData = { type: "partial" | "committed"; utteranceId: string; text: string; startSample: number; endSample: number; speakerRef: string | null; confidence: number };
export type SttEvent = { kind: "data"; sequence: number; payload: SttData } | { kind: "terminal"; sequence: number; outcome: "succeeded" | "rejected" | "cancelled" | "timedOut" | "failed"; inputSamples: number };
export type VoiceProfileRef = { voiceRef: string; revision: number };
export type ExpressiveSemanticDecision = { decisionId: string; revision: number; valence: number; arousal: number; urgency: "low" | "normal" | "high" | "critical"; deliveryMode: "neutral" | "explanation" | "reassurance" | "concern" | "celebration" | "warning" | "emergency"; pace: number; energy: number };
export type SpeechDeliveryIntent = { interactionId: string; segmentId: string; decisionId: string; decisionRevision: number; deliveryMode: ExpressiveSemanticDecision["deliveryMode"]; urgency: ExpressiveSemanticDecision["urgency"]; pace: number; energy: number };
export type ExpressiveDimension = "affect" | "urgency" | "deliveryMode" | "pace" | "energy";
export type DeliveryDisposition = "fullyApplied" | "partiallyApplied" | "unsupported" | "policyOverridden" | "providerFailure" | "cancelled" | "timedOut";
export type TtsRequest = SpeechRequest & { text: string; segmentId: string; format: AudioFormat; voiceProfile: VoiceProfileRef; decision: ExpressiveSemanticDecision; delivery: SpeechDeliveryIntent; maxOutputSamples?: number };
export type TtsEvent = { kind: "data"; sequence: number; segmentId: string; frame: AudioFrame; mappingRevision: string } | { kind: "terminal"; sequence: number; segmentId: string; outcome: "succeeded" | "cancelled" | "timedOut" | "failed"; outputSamples: number; frameCount: number; disposition: DeliveryDisposition; degradedDimensions: ExpressiveDimension[]; mappingRevision: string };
export type SpeechRequest = { deadlineAt: string; now: () => string };
export interface SpeechToTextProvider { transcribe(request: SpeechRequest, audio: AsyncIterable<SttInput>, signal?: AbortSignal): AsyncIterable<SttEvent>; }
export interface TextToSpeechProvider { synthesize(request: TtsRequest, signal?: AbortSignal): AsyncIterable<TtsEvent>; }

export function validateTtsRequest(request: TtsRequest): void {
  if (!request.text.trim() || !request.segmentId || !request.delivery.interactionId || !request.voiceProfile.voiceRef || !Number.isInteger(request.voiceProfile.revision) || request.voiceProfile.revision < 0) throw new Error("tts request identity invalid");
  const d = request.decision;
  if (!d.decisionId || !Number.isInteger(d.revision) || d.revision < 0 || d.valence < -1 || d.valence > 1 || d.arousal < 0 || d.arousal > 1 || d.pace < 0 || d.pace > 1 || d.energy < 0 || d.energy > 1) throw new Error("tts expressive decision invalid");
  if (request.delivery.decisionId !== d.decisionId || request.delivery.decisionRevision !== d.revision || request.delivery.segmentId !== request.segmentId || request.delivery.urgency !== d.urgency || request.delivery.deliveryMode !== d.deliveryMode || request.delivery.pace !== d.pace || request.delivery.energy !== d.energy) throw new Error("tts delivery correlation invalid");
  if (request.maxOutputSamples !== undefined && (!Number.isInteger(request.maxOutputSamples) || request.maxOutputSamples < 1)) throw new Error("tts output limit invalid");
}

export function validateAudioFrame(frame: AudioFrame, expected: AudioFormat): void {
  if (frame.format.encoding !== expected.encoding || frame.format.sampleRateHz !== expected.sampleRateHz || frame.format.channels !== expected.channels) throw new Error("audio format mismatch");
  if (!Number.isInteger(frame.sequence) || frame.sequence < 0 || !Number.isInteger(frame.sampleOffset) || frame.sampleOffset < 0 || !Number.isInteger(frame.sampleCount) || frame.sampleCount < 1 || frame.sampleCount > 4800 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.dataBase64) || frame.dataBase64.length < 4) throw new Error("audio frame invalid");
}

export async function validateSttInput(input: AsyncIterable<SttInput>, expected: AudioFormat): Promise<{ frames: number; samples: number }> {
  let nextSequence = 0; let samples = 0; let ended = false; let audioInputId: string | undefined;
  for await (const item of input) {
    if (ended || !audioInputId) audioInputId ??= item.audioInputId;
    if (item.audioInputId !== audioInputId) throw new Error("audio input identity changed");
    if (item.type === "frame") { if (item.frame.sequence !== nextSequence) throw new Error("audio sequence gap"); validateAudioFrame(item.frame, expected); samples += item.frame.sampleCount; nextSequence += 1; }
    else { if (item.nextSequence !== nextSequence || item.sampleCount !== samples) throw new Error("audio end count mismatch"); ended = true; }
  }
  if (!ended) throw new Error("audio stream missing end");
  return { frames: nextSequence, samples };
}

export function validateTerminalSequence(events: readonly (SttEvent | TtsEvent)[]): void {
  if (events.length === 0 || events.at(-1)?.kind !== "terminal") throw new Error("audio stream missing terminal");
  events.forEach((event, index) => { if (event.sequence !== index) throw new Error("audio event sequence invalid"); });
}
