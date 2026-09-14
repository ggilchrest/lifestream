import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmarkDiscovery, type DiscoveryEnvironment, type DiscoverySample } from "../src/benchmark.ts";

const environment: DiscoveryEnvironment = { hardware: "synthetic-cpu", os: "synthetic-os", powerMode: "fixed", network: "offline", provider: "fixture-v1", modelRevision: "fixture-model-v1", tokenizer: "utf8-bytes-upper-bound", configurationDigest: "fixture-config", seed: 73, corpusRecords: 100, evidence: "fixture" };
const condition = (extra = 0): DiscoverySample[] => Array.from({ length: 200 }, (_, index) => ({
  pairId: `pair-${index}`, turnCommittedAt: 0, preparedStartedAt: 1,
  selectionStartedAt: 2, selectionCompletedAt: 3, preparedCompletedAt: 4,
  inferenceRequestedAt: 5, firstUsefulTokenAt: 300 + index % 7 + extra,
  firstAudibleSampleAt: 700 + index % 7 + extra,
  bargeInDetectedAt: 1000, audibleStoppedAt: 1100,
  enrichmentTokenUpperBound: extra ? 200 : 0, selectedItems: extra ? 2 : 0,
  cpuPercent: 12, residentMemoryMiB: 30, gpuMemoryMiB: null, providerQueueDepth: 0,
  underruns: 0, duplicateAudioOwners: 0
}));
const runs = () => ({ disabled: condition(), warm: condition(10), background: condition(20), cold: condition(30) });

test("LS-TEST-134/135: 200 paired measurements retain raw evidence, percentiles and reproducible uncertainty", () => {
  const input = runs(); const report = benchmarkDiscovery(environment, input);
  assert.equal(report.status, "passedMeasuredObjectives"); assert.equal(report.sampleCountPerCondition, 200);
  assert.match(report.claimBoundary, /Fixture.*no real provider/);
  assert.equal(report.comparisons.find(item => item.condition === "warm" && item.metric === "firstUsefulToken")?.p95Delta, 10);
  assert.deepEqual(report.comparisons.find(item => item.condition === "warm" && item.metric === "firstUsefulToken")?.uncertainty, { lower: 10, upper: 10, resamples: 500, method: "paired-percentile-bootstrap-95pct-v1" });
  assert.deepEqual(report.raw, input); input.warm[0]!.firstUsefulTokenAt = 999;
  assert.notEqual(report.raw.warm[0]!.firstUsefulTokenAt, 999);
});

test("LS-TEST-135: an equally slow disabled baseline cannot hide failed absolute objectives", () => {
  const input = runs();
  for (const values of Object.values(input)) for (const sample of values) { sample.firstUsefulTokenAt = 1000; sample.firstAudibleSampleAt = 1800; sample.bargeInDetectedAt = 2000; sample.audibleStoppedAt = 2100; }
  const report = benchmarkDiscovery(environment, input);
  assert.equal(report.status, "failedObjectives");
  assert.ok(report.gates.some(gate => gate.condition === "disabled" && gate.metric === "firstUsefulToken" && gate.status === "fail"));
  assert.ok(report.gates.some(gate => gate.condition === "warm" && gate.metric === "added:firstUsefulToken" && gate.status === "pass"));
});

test("LS-TEST-135: missing audible observations stay unverified and never become zeros", () => {
  const input = runs();
  for (const values of Object.values(input)) for (const sample of values) { sample.firstAudibleSampleAt = null; sample.bargeInDetectedAt = null; sample.audibleStoppedAt = null; }
  const report = benchmarkDiscovery(environment, input);
  assert.equal(report.status, "incompleteEvidence"); assert.equal(report.distributions.warm?.firstAudibleSample, null);
  assert.ok(report.gates.some(gate => gate.metric === "added:audibleStop" && gate.status === "unverified"));
});

test("LS-TEST-134/135: reject unpaired, short, invalid and nonmonotonic experiments", () => {
  const input = runs(); input.warm[0]!.pairId = "different";
  assert.throws(() => benchmarkDiscovery(environment, input), /same ordered paired/);
  const short = runs(); short.disabled.pop(); assert.throws(() => benchmarkDiscovery(environment, short), /200/);
  const invalid = runs(); invalid.background[0]!.firstUsefulTokenAt = NaN;
  assert.throws(() => benchmarkDiscovery(environment, invalid), /finite and monotonic/);
  const reversed = runs(); reversed.cold[0]!.selectionCompletedAt = 0;
  assert.throws(() => benchmarkDiscovery(environment, reversed), /monotonic/);
  const incomplete = runs(); incomplete.warm[0]!.audibleStoppedAt = null;
  assert.throws(() => benchmarkDiscovery(environment, incomplete), /barge-in/);
});

test("LS-TEST-134/135: token growth, added latency and playback gaps fail independently", () => {
  const input = runs();
  for (const sample of input.background) { sample.firstUsefulTokenAt += 80; sample.firstAudibleSampleAt! += 100; }
  input.warm[0]!.enrichmentTokenUpperBound = 1025; input.cold[0]!.underruns = 1;
  const report = benchmarkDiscovery(environment, input);
  for (const [condition, metric] of [["background", "added:firstUsefulToken"], ["warm", "enrichmentBounds"], ["cold", "audioContinuity"]]) assert.ok(report.gates.some(gate => gate.condition === condition && gate.metric === metric && gate.status === "fail"));
});
