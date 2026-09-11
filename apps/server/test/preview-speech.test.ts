import test from "node:test";
import assert from "node:assert/strict";
import { VoxCpmProvider } from "@lifestream/providers-voxcpm";
import { synthesizePreview } from "../src/runtime/preview-speech.ts";
const request = () => ({ contractVersion: "2.0.0" as const, text: "First sentence. Second sentence. Third sentence.", segmentId: "preview", format: { encoding: "pcm_s16le" as const, sampleRateHz: 48000 as const, channels: 1 as const }, voiceProfile: { voiceRef: "fixture-voice-design", revision: 1 }, decision: { decisionId: "decision", revision: 1 }, delivery: { interactionId: "interaction", segmentId: "preview", decisionId: "decision", decisionRevision: 1, deliveryMode: "neutral", urgency: "normal", pace: .5, energy: .4 }, deadlineAt: new Date(Date.now() + 60000).toISOString() });
function provider(failAt = -1) {
  const texts: string[] = [];
  const tts = new VoxCpmProvider({ baseUrl: "http://fixture.invalid", runtimeRevision: "runtime", modelRevision: "model", mappingRevision: "map", voiceBundleKey: "fixture-voice-design", voiceBundleRevision: 1, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); texts.push(body.text);
    assert.ok(Date.parse(body.deadlineAt) <= Date.now() + 45000);
    const events = [{ kind: "preAudio", sequence: 0, requestId: body.requestId, correlationId: body.correlationId, voiceBundleRevision: 1, requestedDelivery: body.delivery, appliedDelivery: body.delivery, degradedDimensions: [], mappingRevision: "map", effectiveSynthesis: {}, format: body.format, runtimeRevision: "runtime", modelRevision: "model" }, { kind: "data", sequence: 1, sampleOffset: 0, sampleCount: 2, dataBase64: "AAABAA==", format: body.format }, { kind: "terminal", sequence: 2, outcome: texts.length === failAt ? "deadlineExceeded" : "completed", outputSamples: 2, frameCount: 1 }];
    return new Response(events.map(e => JSON.stringify(e)).join("\n") + "\n");
  } });
  return { tts, texts };
}
test("preview segments long text and exposes one ordered aggregate terminal", async () => {
  const { tts, texts } = provider(), events = [];
  for await (const event of synthesizePreview(tts, request())) events.push(event);
  assert.deepEqual(texts, ["First sentence.", "Second sentence.", "Third sentence."]);
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i));
  assert.deepEqual(events.filter(e => e.kind === "data").map(e => e.frame.sampleOffset), [0, 2, 4]);
  assert.equal(events.filter(e => e.kind === "terminal").length, 1);
  assert.equal(events.at(-1)?.kind === "terminal" && events.at(-1)?.outcome, "succeeded");
});
test("preview stops at a failed segment and preserves the overall deadline", async () => {
  const { tts, texts } = provider(2), events = [];
  for await (const event of synthesizePreview(tts, request())) events.push(event);
  assert.equal(texts.length, 2); assert.equal(events.at(-1)?.kind === "terminal" && events.at(-1)?.outcome, "timedOut");
  const expired = { ...request(), deadlineAt: new Date(0).toISOString() };
  for await (const event of synthesizePreview(tts, expired)) assert.equal(event.kind === "terminal" && event.outcome, "timedOut");
  assert.equal(texts.length, 2);
});
