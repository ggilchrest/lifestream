import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AudioSession, isSpeechFrame } from "../src/runtime/audio.ts";

const frame = (value: number) => { const bytes = Buffer.alloc(4800 * 2); for (let offset = 0; offset < bytes.length; offset += 2) bytes.writeInt16LE(value, offset); return { frameId: randomUUID(), sequence: 0, format: { encoding: "pcm_s16le" as const, sampleRateHz: 16000 as const, channels: 1 as const }, sampleOffset: 0, sampleCount: 4800, dataBase64: bytes.toString("base64") }; };

test("bounded PCM VAD ignores silence and detects speech", () => { assert.equal(isSpeechFrame(frame(0).dataBase64), false); assert.equal(isSpeechFrame(frame(1200).dataBase64), true); });

test("canonical audio interrupt fences downstream work and playback", async () => {
  const events: Record<string, unknown>[] = [];
  const socket = { readyState: 1, send: (value: string) => events.push(JSON.parse(value)), close: () => undefined };
  let release: (() => void) | undefined;
  const stt = { async *transcribe() { yield { kind: "data" as const, sequence: 0, payload: { type: "committed" as const, utteranceId: randomUUID(), text: "hello", startSample: 0, endSample: 4800, speakerRef: null, confidence: 0 } }; } };
  const inference = { async *generate(_request: unknown, context: { signal: AbortSignal }) { yield { kind: "text" as const, text: "answer" }; await new Promise<void>((resolve) => { release = resolve; context.signal.addEventListener("abort", () => { resolve(); }, { once: true }); }); } };
  const tts = { synthesize: async function* () { yield { kind: "terminal" as const, sequence: 0, segmentId: randomUUID(), outcome: "cancelled" as const, outputSamples: 0, frameCount: 0, disposition: "cancelled" as const, degradedDimensions: [], mappingRevision: "test" }; } };
  const sessionId = randomUUID(); const endpointId = randomUUID(); const audioInputId = randomUUID(); const correlationId = randomUUID(); const session = new AudioSession(socket, { stt: stt as never, inference: inference as never, tts: tts as never }, sessionId);
  await session.message(JSON.stringify({ type: "start", request: { schemaVersion: "1.0.0", requestId: randomUUID(), correlationId, sessionId, expectedSessionRevision: 1, endpointId, audioInputId, format: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 } } }));
  await session.message(JSON.stringify({ type: "frame", audioInputId, frame: frame(0) }));
  const turn = session.message(JSON.stringify({ type: "commitTurn", audioInputId, nextSequence: 1, sampleCount: 4800 }));
  for (let attempt = 0; attempt < 20 && !events.some((event) => event.type === "response"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const response = events.find((event) => event.type === "response") as { event?: { interactionTraceId?: string } } | undefined; const traceId = response?.event?.interactionTraceId;
  assert.ok(traceId);
  await session.message(JSON.stringify({ type: "interrupt", interactionTraceId: traceId, reason: "user resumed speaking" }));
  release?.(); await turn;
  assert.ok(events.some((event) => event.type === "stopPlayback")); assert.equal((events.at(-1) as { event: { payload: { state: string } } }).event.payload.state, "interrupted");
});
