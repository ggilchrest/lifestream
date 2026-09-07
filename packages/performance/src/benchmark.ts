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
