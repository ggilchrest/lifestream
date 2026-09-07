import assert from "node:assert/strict";
import { test } from "node:test";
import { FixturePlaybackSink } from "../src/voice/playback.ts";

test("fixture playback enforces a bounded queue and disconnect fence", async () => { const sink = new FixturePlaybackSink(1); const frame = { frameId: "f", sequence: 0, format: { encoding: "pcm_s16le" as const, sampleRateHz: 16000 as const, channels: 1 as const }, sampleOffset: 0, sampleCount: 10, dataBase64: "AAAA" }; await sink.play("s", frame); await assert.rejects(sink.play("s", frame), /full/); await sink.close(); await assert.rejects(sink.play("s", frame), /closed/); });
