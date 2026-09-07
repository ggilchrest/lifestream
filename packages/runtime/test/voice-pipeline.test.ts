import assert from "node:assert/strict";
import { test } from "node:test";
import { FixtureSpeechToTextProvider, FixtureTextToSpeechProvider } from "../../providers-fixture/src/voice/providers.ts";
import { FixturePlaybackSink } from "../../providers-fixture/src/voice/playback.ts";
import { VoicePipeline } from "../src/voice/pipeline.ts";

const format = { encoding: "pcm_s16le" as const, sampleRateHz: 16000 as const, channels: 1 as const };
const audio = async function* () { yield { type: "frame" as const, audioInputId: "a", frame: { frameId: "f", sequence: 0, format, sampleOffset: 0, sampleCount: 10, dataBase64: "AAAA" } }; yield { type: "end" as const, audioInputId: "a", nextSequence: 1, sampleCount: 10 }; };

test("pipeline streams first playback before inference completes", async () => { let inferenceDone = false; const sink = new FixturePlaybackSink(2); const pipeline = new VoicePipeline(new FixtureSpeechToTextProvider(), async function* () { yield "hello"; assert.equal(inferenceDone, false); inferenceDone = true; }, new FixtureTextToSpeechProvider(), sink, (() => { let t = 0; return () => ++t; })()); const result = await pipeline.run({ audio: audio(), format, speechRequest: { deadlineAt: "2026-09-07T00:01:00Z", now: () => "2026-09-07T00:00:00Z" } }); assert.equal(result.status, "succeeded"); assert.ok(result.milestones.findIndex((m) => m.name === "playback.first-sample") < result.milestones.length); assert.equal(sink.played.length, 1); });

test("pipeline disconnect/cancellation closes playback and does not resume", async () => { const controller = new AbortController(); controller.abort(); const sink = new FixturePlaybackSink(1); const result = await new VoicePipeline(new FixtureSpeechToTextProvider(), async function* () { yield "never"; }, new FixtureTextToSpeechProvider(), sink, () => 1).run({ audio: audio(), format, speechRequest: { deadlineAt: "2026-09-07T00:01:00Z", now: () => "2026-09-07T00:00:00Z" }, signal: controller.signal }); assert.equal(result.status, "cancelled"); assert.equal(sink.closed, true); });
