import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCurrentReplayDependencies, createLabExperiment, createReplayManifest, replayTrace, runLabComparison, ReplayBlockedError, type ReplayEvent } from "../src/replay/replay.ts";

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

test("Lab requires two isolated representations and excludes held-out scenarios", async () => {
  const experiment = createLabExperiment({ experimentId: "lab-1", sourceRelationshipId: "relationship-1", sourceConfigurationRevision: "configuration-2", representations: ["recordOriented", "conventionOriented"], promptVariants: ["baseline", "candidate"], controlVariants: ["default"], scenarioIds: ["s1", "held-out"], heldOutScenarioIds: ["held-out"], criteria: [{ id: "fit", description: "appropriate communication", weight: 1 }], repeatedRuns: 2, datasetRef: "fixture:dataset-1", sourceSnapshotRef: "fixture:snapshot-1", providerRefs: ["fixture:inference"], compilerVersion: "fixture-compiler-v1", cacheNamespace: "lab-1-cache", grantNamespace: "lab-1-grants" });
  const comparison = await runLabComparison(experiment, ["s1", "held-out"], async (scenarioId, representation, variant, repeat) => ({ output: { scenarioId, representation, variant, repeat }, latencyMs: 1, tokenCount: 3 }));
  assert.equal(comparison.results.length, 12); assert.deepEqual(comparison.heldOutExcluded, ["held-out"]); assert.equal(comparison.variability["recordOriented:candidate"], 2); assert.equal(comparison.limitations.length, 3);
});

test("Lab rejects live providers and underdeclared criteria", () => {
  assert.throws(() => createReplayManifest({ replayId: "lab", sourceTraceId: "t", artifactRefs: ["a"], providerRefs: ["live:inference"] }), ReplayBlockedError);
  assert.throws(() => createLabExperiment({ experimentId: "lab-2", sourceRelationshipId: "r", sourceConfigurationRevision: "c", representations: ["recordOriented", "conventionOriented"], promptVariants: [], controlVariants: [], scenarioIds: ["s"], heldOutScenarioIds: [], criteria: [], repeatedRuns: 2, datasetRef: "d", sourceSnapshotRef: "s", providerRefs: ["fixture:x"], compilerVersion: "v", cacheNamespace: "c", grantNamespace: "g" }), ReplayBlockedError);
});
test("replay dependency currency blocks revoked artifacts", () => { const manifest = createReplayManifest({ replayId: "r-current", sourceTraceId: "t", artifactRefs: ["artifact-1"], providerRefs: ["fixture:x"], revocationRefs: ["source-1"] }); assert.doesNotThrow(() => assertCurrentReplayDependencies(manifest, { currentRefs: ["source-1"], revokedRefs: [] })); assert.throws(() => assertCurrentReplayDependencies(manifest, { currentRefs: ["source-1"], revokedRefs: ["source-1"] }), ReplayBlockedError); });
