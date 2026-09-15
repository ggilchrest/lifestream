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

import {benchmarkDiscoveryLookup,type DiscoveryLookupSample} from '../src/benchmark.ts';
const localEnvironment={hardware:'fixture CPU',os:'fixture OS',powerMode:'fixed',sourceRevision:'fixture-revision',configurationDigest:'fixture-digest',cachePolicy:'declared connection cache',backgroundWork:'declared fixture writer',seed:73,corpusRecords:100 as const};
const localRuns=()=>Object.fromEntries(['disabled','warm','background','cold'].map(condition=>[condition,Array.from({length:200},(_,i):DiscoveryLookupSample=>({pairId:`pair:${i}`,preparedStartedAt:0,selectionStartedAt:1,selectionCompletedAt:2,preparedCompletedAt:3,lookupMs:0.6,innerSelectionMs:0.2,threadCpuMicroseconds:100,residentMemoryMiB:50,selectedItems:condition==='disabled'?0:1,enrichmentTokenUpperBound:condition==='disabled'?0:100,disposition:condition==='disabled'?'disabled':'included',expectedDetailPresent:condition!=='disabled'}))])) as Record<'disabled'|'warm'|'background'|'cold',DiscoveryLookupSample[]>;

test('local lookup report preserves real-stage boundaries and never invents provider or audio evidence',()=>{
 const runs=localRuns(),report=benchmarkDiscoveryLookup(localEnvironment,runs);
 assert.equal(report.status,'passedLocalObjectives');assert.equal(report.qualification,'incompleteEvidence');
 assert.ok(report.unmeasured.includes('first useful token'));assert.match(report.claimBoundary,/not OS-cache-cold/);
 assert.equal(report.sampleCountPerCondition,200);assert.deepEqual(report.raw,runs);runs.warm[0]!.lookupMs=99;assert.equal(report.raw.warm[0]!.lookupMs,0.6);
 assert.deepEqual(report.comparisons[0]!.uncertainty,{lower:0,upper:0,resamples:500,method:'paired-percentile-bootstrap-95pct-v1'});
});

test('one missing contextual detail remains a failure even when p95 passes and deadline fallback is correct',()=>{
 const runs=localRuns();Object.assign(runs.background[0]!,{selectionCompletedAt:30,preparedCompletedAt:31,lookupMs:29,disposition:'deadline',selectedItems:0,enrichmentTokenUpperBound:0,expectedDetailPresent:false});
 const report=benchmarkDiscoveryLookup(localEnvironment,runs);
 assert.equal(report.status,'failedLocalObjectives');assert.equal(report.deadlineMisses.background,1);
 assert.ok(report.gates.some(g=>g.condition==='background'&&g.metric==='selectionLatency'&&g.status==='pass'));
 assert.ok(report.gates.some(g=>g.condition==='background'&&g.metric==='expectedDetail'&&g.status==='fail'&&g.count===1));
 assert.ok(report.gates.some(g=>g.condition==='background'&&g.metric==='boundedFailClosedSelection'&&g.status==='pass'));
 runs.background[0]!.selectedItems=1;assert.ok(benchmarkDiscoveryLookup(localEnvironment,runs).gates.some(g=>g.metric==='boundedFailClosedSelection'&&g.status==='fail'));
});

test('local measurements reject missing pairs, clock reversals and invalid resource values',()=>{
 const short=localRuns();short.disabled.pop();assert.throws(()=>benchmarkDiscoveryLookup(localEnvironment,short),/200/);
 const changed=localRuns();changed.cold[0]!.pairId='changed';assert.throws(()=>benchmarkDiscoveryLookup(localEnvironment,changed),/ordered paired/);
 const invalid=localRuns();invalid.warm[0]!.selectionCompletedAt=NaN;assert.throws(()=>benchmarkDiscoveryLookup(localEnvironment,invalid),/monotonic/);
 const cpu=localRuns();cpu.warm[0]!.threadCpuMicroseconds=-1;assert.throws(()=>benchmarkDiscoveryLookup(localEnvironment,cpu),/resource/);
});
