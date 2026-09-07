import assert from "node:assert/strict";
import { test } from "node:test";
import { FixturePlaybackSink } from "../src/voice/playback.ts";

test("fenced playback rejects late audio", async () => { const sink = new FixturePlaybackSink(2); const frame = { frameId: "f", sequence: 0, format: { encoding: "pcm_s16le" as const, sampleRateHz: 16000 as const, channels: 1 as const }, sampleOffset: 0, sampleCount: 10, dataBase64: "AAAA" }; const oldFence = 0; const newFence = sink.fence(); await assert.rejects(sink.play("s", frame, oldFence), /stale/); await sink.play("s", frame, newFence); assert.equal(sink.played.length, 1); });
