export type BenchmarkManifest = { hardware: string; os: string; powerMode: string; network: string; provider: string; warm: boolean; sampleCount: number; concurrency: number };
export type MilestoneSample = { acknowledged: number; firstAudio: number; result: number };
export type LatencyReport = { manifest: BenchmarkManifest; sampleCount: number; p50: MilestoneSample; p95: MilestoneSample };

export function percentile(values: number[], percentileValue: 50 | 95): number {
  if (values.length === 0) throw new Error("at least one sample is required");
  const ordered = [...values].sort((a, b) => a - b); const rank = Math.ceil((percentileValue / 100) * ordered.length) - 1; const value = ordered[rank];
  if (value === undefined) throw new Error("percentile sample is missing"); return value;
}

export function benchmark(manifest: BenchmarkManifest, samples: MilestoneSample[]): LatencyReport {
  if (!manifest.hardware || !manifest.os || !manifest.powerMode || !manifest.network || !manifest.provider) throw new Error("complete benchmark environment is required");
  if (samples.length < 20 || manifest.sampleCount !== samples.length) throw new Error("at least 20 declared samples are required for p95");
  for (const sample of samples) { if (sample.acknowledged < 0 || sample.firstAudio < sample.acknowledged || sample.result < sample.firstAudio) throw new Error("milestones must be monotonic"); }
  const project = (key: keyof MilestoneSample) => samples.map((sample) => sample[key]);
  return { manifest: structuredClone(manifest), sampleCount: samples.length, p50: { acknowledged: percentile(project("acknowledged"), 50), firstAudio: percentile(project("firstAudio"), 50), result: percentile(project("result"), 50) }, p95: { acknowledged: percentile(project("acknowledged"), 95), firstAudio: percentile(project("firstAudio"), 95), result: percentile(project("result"), 95) } };
}

export type DiscoveryCondition = "disabled" | "warm" | "background" | "cold";
export type DiscoveryEnvironment = {
  hardware: string; os: string; powerMode: string; network: string; provider: string;
  modelRevision: string; tokenizer: string; configurationDigest: string; seed: number;
  corpusRecords: 100 | 10000 | 100000;
  evidence: "fixture" | "developmentBrowser" | "physical";
};
export type DiscoverySample = {
  pairId: string;
  turnCommittedAt: number;
  preparedStartedAt: number; preparedCompletedAt: number;
  selectionStartedAt: number; selectionCompletedAt: number;
  inferenceRequestedAt: number; firstUsefulTokenAt: number;
  firstAudibleSampleAt: number | null;
  bargeInDetectedAt: number | null; audibleStoppedAt: number | null;
  enrichmentTokenUpperBound: number; selectedItems: number;
  cpuPercent: number; residentMemoryMiB: number; gpuMemoryMiB: number | null;
  providerQueueDepth: number; underruns: number; duplicateAudioOwners: number;
};
const discoveryMetrics = ["prepared", "selection", "firstUsefulToken", "firstAudibleSample", "audibleStop"] as const;
type DiscoveryMetric = typeof discoveryMetrics[number];
type Distribution = { count: number; p50: number; p95: number; minimum: number; maximum: number };
const distribution = (values: number[]): Distribution | null => values.length ? ({ count: values.length, p50: percentile(values, 50), p95: percentile(values, 95), minimum: Math.min(...values), maximum: Math.max(...values) }) : null;
const metricValue = (sample: DiscoverySample, metric: DiscoveryMetric): number | null => {
  switch (metric) {
    case "prepared": return sample.preparedCompletedAt - sample.preparedStartedAt;
    case "selection": return sample.selectionCompletedAt - sample.selectionStartedAt;
    case "firstUsefulToken": return sample.firstUsefulTokenAt - sample.turnCommittedAt;
    case "firstAudibleSample": return sample.firstAudibleSampleAt === null ? null : sample.firstAudibleSampleAt - sample.turnCommittedAt;
    case "audibleStop": return sample.bargeInDetectedAt === null || sample.audibleStoppedAt === null ? null : sample.audibleStoppedAt - sample.bargeInDetectedAt;
  }
};

/** Seeded paired bootstrap of the difference in p95s, for offline uncertainty reporting. */
function pairedP95Interval(pairs: readonly (readonly [number, number])[], seed: number): { lower: number; upper: number; resamples: 500; method: string } {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const differences: number[] = [];
  for (let run = 0; run < 500; run++) {
    const baseline: number[] = [], enabled: number[] = [];
    for (let index = 0; index < pairs.length; index++) { const pair = pairs[Math.floor(random() * pairs.length)]!; baseline.push(pair[0]); enabled.push(pair[1]); }
    differences.push(percentile(enabled, 95) - percentile(baseline, 95));
  }
  differences.sort((a, b) => a - b);
  return { lower: differences[12]!, upper: differences[487]!, resamples: 500, method: "paired-percentile-bootstrap-95pct-v1" };
}

/** This evaluates supplied measurements; it does not turn fixture clocks into physical evidence. */
export function benchmarkDiscovery(environment: DiscoveryEnvironment, runs: Record<DiscoveryCondition, readonly DiscoverySample[]>) {
  for (const field of ["hardware", "os", "powerMode", "network", "provider", "modelRevision", "tokenizer", "configurationDigest"] as const) if (!environment[field]?.trim()) throw new Error("complete pinned discovery environment required");
  if (!Number.isSafeInteger(environment.seed) || ![100, 10000, 100000].includes(environment.corpusRecords)) throw new Error("invalid discovery experiment boundary");
  const conditions = ["disabled", "warm", "background", "cold"] as const;
  const expectedIds = runs.disabled.map(sample => sample.pairId);
  if (expectedIds.length < 200 || new Set(expectedIds).size !== expectedIds.length || expectedIds.some(id => !id)) throw new Error("at least 200 unique paired turns required");
  const gates: { condition: DiscoveryCondition; metric: string; status: "pass" | "fail" | "unverified"; detail: string }[] = [];
  const reports: Partial<Record<DiscoveryCondition, Record<DiscoveryMetric, Distribution | null>>> = {};
  const limits: Record<DiscoveryMetric, readonly [number, number]> = { prepared: [15, 40], selection: [5, 10], firstUsefulToken: [450, 800], firstAudibleSample: [900, 1500], audibleStop: [150, 250] };
  for (const condition of conditions) {
    const samples = runs[condition];
    if (samples.length !== expectedIds.length || samples.some((sample, index) => sample.pairId !== expectedIds[index])) throw new Error("conditions must use the same ordered paired turns");
    for (const sample of samples) {
      const ordered = [sample.turnCommittedAt, sample.preparedStartedAt, sample.selectionStartedAt, sample.selectionCompletedAt, sample.preparedCompletedAt, sample.inferenceRequestedAt, sample.firstUsefulTokenAt];
      if (ordered.some((value, index) => !Number.isFinite(value) || value < 0 || index > 0 && value < ordered[index - 1]!)) throw new Error("discovery milestones must be finite and monotonic");
      if (sample.firstAudibleSampleAt !== null && (!Number.isFinite(sample.firstAudibleSampleAt) || sample.firstAudibleSampleAt < sample.firstUsefulTokenAt)) throw new Error("invalid audible milestone");
      if ((sample.bargeInDetectedAt === null) !== (sample.audibleStoppedAt === null)
          || sample.bargeInDetectedAt !== null && (!Number.isFinite(sample.bargeInDetectedAt) || sample.firstAudibleSampleAt === null || sample.bargeInDetectedAt < sample.firstAudibleSampleAt || !Number.isFinite(sample.audibleStoppedAt) || sample.audibleStoppedAt! < sample.bargeInDetectedAt)) throw new Error("invalid barge-in milestones");
      for (const field of ["enrichmentTokenUpperBound", "selectedItems", "residentMemoryMiB", "providerQueueDepth", "underruns", "duplicateAudioOwners", "cpuPercent"] as const) if (!Number.isFinite(sample[field]) || sample[field] < 0) throw new Error("invalid resource measurement");
      if (sample.gpuMemoryMiB !== null && (!Number.isFinite(sample.gpuMemoryMiB) || sample.gpuMemoryMiB < 0)) throw new Error("invalid GPU measurement");
      if (![sample.enrichmentTokenUpperBound,sample.selectedItems,sample.providerQueueDepth,sample.underruns,sample.duplicateAudioOwners].every(Number.isInteger)) throw new Error("resource counts must be integers");
    }
    const report = {} as Record<DiscoveryMetric, Distribution | null>;
    for (const metric of discoveryMetrics) {
      const values = samples.map(sample => metricValue(sample, metric)).filter((value): value is number => value !== null);
      const summary = distribution(values); report[metric] = summary;
      const complete = values.length === samples.length;
      gates.push({ condition, metric, status: !complete || !summary ? "unverified" : summary.p50 <= limits[metric][0] && summary.p95 <= limits[metric][1] ? "pass" : "fail", detail: `${values.length}/${samples.length} observed; absolute p50/p95 limits ${limits[metric].join("/")} ms` });
    }
    reports[condition] = report;
    const bounds = samples.every(sample => sample.enrichmentTokenUpperBound <= 1024 && sample.selectedItems <= 8 && (condition !== "disabled" || sample.enrichmentTokenUpperBound === 0 && sample.selectedItems === 0));
    gates.push({ condition, metric: "enrichmentBounds", status: bounds ? "pass" : "fail", detail: "Hard maxima 1024 token upper bound / 8 items; disabled contributes zero" });
    gates.push({ condition, metric: "audioContinuity", status: samples.some(sample => sample.firstAudibleSampleAt === null) ? "unverified" : samples.some(sample => sample.underruns > 0 || sample.duplicateAudioOwners > 0) ? "fail" : "pass", detail: "No underruns or duplicate audio owners; missing audible milestones remain unverified" });
  }
  const comparisons: { condition: DiscoveryCondition; metric: DiscoveryMetric; p95Delta: number; pairedDelta: Distribution; uncertainty: ReturnType<typeof pairedP95Interval> }[] = [];
  const addedLimits: Partial<Record<DiscoveryMetric, number>> = { firstUsefulToken: 50, firstAudibleSample: 75, audibleStop: 10 };
  for (const condition of ["warm", "background", "cold"] as const) {
    for (const metric of discoveryMetrics) {
      const pairs = runs.disabled.map((sample, index) => [metricValue(sample, metric), metricValue(runs[condition][index]!, metric)] as const);
      if (pairs.some(pair => pair[0] === null || pair[1] === null)) { if (metric in addedLimits) gates.push({ condition, metric: `added:${metric}`, status: "unverified", detail: "missing paired milestones" }); continue; }
      const completePairs = pairs as (readonly [number,number])[];
      const p95Delta = reports[condition]![metric]!.p95 - reports.disabled![metric]!.p95;
      const uncertainty = pairedP95Interval(completePairs, environment.seed);
      comparisons.push({ condition, metric, p95Delta, pairedDelta: distribution(completePairs.map(pair => pair[1] - pair[0]))!, uncertainty });
      const limit = addedLimits[metric];
      if (limit !== undefined) gates.push({ condition, metric: `added:${metric}`, status: p95Delta > limit ? "fail" : uncertainty.upper > limit ? "unverified" : "pass", detail: `added p95 <=${limit} ms; upper bootstrap bound ${uncertainty.upper} ms` });
    }
  }
  return { environment: structuredClone(environment), sampleCountPerCondition: expectedIds.length, percentileMethod: "nearest-rank", gates, distributions: reports, comparisons, raw: structuredClone(runs), status: gates.some(gate => gate.status === "fail") ? "failedObjectives" : gates.some(gate => gate.status === "unverified") ? "incompleteEvidence" : "passedMeasuredObjectives", claimBoundary: environment.evidence === "fixture" ? "Fixture measurements only; no real provider, physical or Human acceptance" : "Named environment measurements only; Human acceptance remains separate" };
}
