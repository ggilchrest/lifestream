import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmark, percentile, type BenchmarkManifest, type MilestoneSample } from "../src/benchmark.ts";

const manifest: BenchmarkManifest = { hardware: "fixture-cpu", os: "fixture-os", powerMode: "balanced", network: "offline", provider: "fixture-v1", warm: true, sampleCount: 20, concurrency: 1 };
const samples: MilestoneSample[] = Array.from({ length: 20 }, (_, index) => ({ acknowledged: index + 1, firstAudio: index + 3, result: index + 8 }));

test("benchmark records environment and separates acknowledgment, first audio, and result percentiles", () => { const report = benchmark(manifest, samples); assert.equal(report.sampleCount, 20); assert.equal(report.p50.firstAudio, 12); assert.equal(report.p95.result, 26); assert.equal(report.manifest.provider, "fixture-v1"); });
test("percentile handles known synthetic values", () => { assert.equal(percentile([1, 4, 2, 3], 50), 2); assert.equal(percentile([1, 4, 2, 3], 95), 4); });
test("benchmark rejects missing milestone, non-monotonic clocks, and undersized p95 samples", () => { assert.throws(() => benchmark({ ...manifest, sampleCount: 2 }, samples.slice(0, 2)), /20/); assert.throws(() => benchmark(manifest, samples.map((sample, index) => index === 0 ? { ...sample, firstAudio: 0 } : sample)), /monotonic/); assert.throws(() => benchmark({ ...manifest, provider: "" }, samples), /environment/); });
