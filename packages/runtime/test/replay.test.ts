import assert from "node:assert/strict";
import { test } from "node:test";
import { createReplayManifest, replayTrace, ReplayBlockedError, type ReplayEvent } from "../src/replay/replay.ts";

const source: ReplayEvent[] = [{ id: "event-1", traceId: "trace-1", sequence: 0, eventType: "interaction.received", payload: { text: "hello" } }];

test("replay creates new event IDs and preserves source links", async () => {
  const manifest = createReplayManifest({ replayId: "replay-1", sourceTraceId: "trace-1", artifactRefs: ["fixture:v1"], providerRefs: ["fixture:inference"] });
  const result = await replayTrace(source, manifest);
  assert.notEqual(result.events[0]?.id, source[0]?.id); assert.deepEqual(result.events[0]?.sourceEventIds, ["event-1"]); assert.equal(result.events[0]?.traceId, "replay-1"); assert.equal(result.comparison.equal, true);
});

test("live provider routes and effect events are rejected", async () => {
  assert.throws(() => createReplayManifest({ replayId: "r", sourceTraceId: "t", artifactRefs: ["a"], providerRefs: ["live:capability"] }), ReplayBlockedError);
  await assert.rejects(() => replayTrace([{ ...source[0]!, liveEffect: true }], createReplayManifest({ replayId: "r", sourceTraceId: "t", artifactRefs: ["a"], providerRefs: ["fixture:x"] })), ReplayBlockedError);
});

test("missing artifacts block replay and pinned fixture output can be compared", async () => {
  assert.throws(() => createReplayManifest({ replayId: "r", sourceTraceId: "t", artifactRefs: [], providerRefs: ["fixture:x"] }), ReplayBlockedError);
  const result = await replayTrace(source, createReplayManifest({ replayId: "r", sourceTraceId: "t", artifactRefs: ["a"], providerRefs: ["fixture:x"] }), { run: async (event) => ({ ...event.payload, replayed: true }) });
  assert.equal(result.comparison.equal, false);
});
