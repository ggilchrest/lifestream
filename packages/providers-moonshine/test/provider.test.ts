import assert from "node:assert/strict";
import { test } from "node:test";
import { MoonshineSpeechProvider } from "../src/provider.ts";

const format = { encoding: "pcm_s16le" as const, sampleRateHz: 16000 as const, channels: 1 as const };
const audio = async function* () {
  yield { type: "frame" as const, audioInputId: "input-1", frame: { frameId: "frame-1", sequence: 0, format, sampleOffset: 0, sampleCount: 4, dataBase64: "AAAAAAAAAAA=" } };
  yield { type: "end" as const, audioInputId: "input-1", nextSequence: 1, sampleCount: 4 };
};
const request = { deadlineAt: "2026-09-10T00:01:00Z", now: () => "2026-09-10T00:00:00Z" };
const options = { baseUrl: "http://127.0.0.1:8788", runtimeRevision: "mlx-audio@0.5.3", modelRevision: "390624ed33d594443aa4aa221f5b9f283b545b5a", modelArtifactDigest: "sha256:model", mappingRevision: "moonshine-map-1" };

test("Moonshine adapter buffers bounded 16 kHz PCM and maps a committed transcript", async () => {
  const provider = new MoonshineSpeechProvider({
    ...options,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { protocolVersion: string; sampleCount: number; dataBase64: string };
      assert.equal(body.protocolVersion, "moonshine.loopback.v1");
      assert.equal(body.sampleCount, 4);
      assert.equal(Buffer.from(body.dataBase64, "base64").byteLength, 8);
      return new Response([
        JSON.stringify({ kind: "data", sequence: 0, requestId: "input-1", runtimeRevision: options.runtimeRevision, modelRevision: options.modelRevision, modelArtifactDigest: options.modelArtifactDigest, mappingRevision: options.mappingRevision, payload: { type: "committed", utteranceId: "input-1:0", text: "hello", startSample: 0, endSample: 4, speakerRef: null, confidence: 0 } }),
        JSON.stringify({ kind: "terminal", sequence: 1, requestId: "input-1", outcome: "completed", inputSamples: 4 })
      ].join("\n") + "\n", { status: 200 });
    }
  });
  const events = [];
  for await (const event of provider.transcribe(request, audio())) events.push(event);
  assert.deepEqual(events.map((event) => event.kind), ["data", "terminal"]);
  assert.equal(events[0]?.payload.text, "hello");
  assert.equal(events[1]?.outcome, "succeeded");
});

test("Moonshine adapter fences cancellation and fails closed on malformed input or identity drift", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = [];
  for await (const event of new MoonshineSpeechProvider(options).transcribe(request, audio(), controller.signal)) cancelled.push(event);
  assert.equal(cancelled.at(-1)?.outcome, "cancelled");

  const invalid = async function* () {
    yield { type: "frame" as const, audioInputId: "bad", frame: { frameId: "f", sequence: 1, format, sampleOffset: 0, sampleCount: 4, dataBase64: "AAAAAAAAAAA=" } };
  };
  const rejected = [];
  for await (const event of new MoonshineSpeechProvider(options).transcribe(request, invalid())) rejected.push(event);
  assert.equal(rejected.at(-1)?.outcome, "failed");

  const drifted = new MoonshineSpeechProvider({ ...options, fetch: async () => new Response([
    JSON.stringify({ kind: "data", sequence: 0, requestId: "input-1", runtimeRevision: options.runtimeRevision, modelRevision: "changed", modelArtifactDigest: options.modelArtifactDigest, mappingRevision: options.mappingRevision, payload: { type: "committed", utteranceId: "input-1:0", text: "hello", startSample: 0, endSample: 4, speakerRef: null, confidence: 0 } }),
    JSON.stringify({ kind: "terminal", sequence: 1, requestId: "input-1", outcome: "completed", inputSamples: 4 })
  ].join("\n") + "\n", { status: 200 }) });
  const failed = [];
  for await (const event of drifted.transcribe(request, audio())) failed.push(event);
  assert.equal(failed.at(-1)?.outcome, "failed");
});
