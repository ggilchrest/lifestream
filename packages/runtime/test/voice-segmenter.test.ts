import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateLatency } from "../src/performance/metrics.ts";
import { SpeechSafeSegmenter } from "../src/voice/segmenter.ts";

test("segmenter waits for semantic boundary and strips control markup", () => { const segmenter = new SpeechSafeSegmenter(); assert.deepEqual(segmenter.push("Hello [[CAPABILITY_SUCCESS]]"), []); assert.deepEqual(segmenter.push(" world."), [{ segmentId: "segment-0", sequence: 0, text: "Hello world." }]); });
test("segmenter flushes and cancellation fences late text", () => { const segmenter = new SpeechSafeSegmenter(10); assert.equal(segmenter.push("one two three").length, 1); segmenter.cancel(); assert.deepEqual(segmenter.push("late."), []); assert.deepEqual(segmenter.flush(), []); });
test("latency metrics use actual playback sample and one clock", () => { const milestones = [{ name: "turn.commit", clockId: "virtual", reading: 10 }, { name: "inference.first-token", clockId: "virtual", reading: 20 }, { name: "segment.first", clockId: "virtual", reading: 25 }, { name: "tts.first-audio", clockId: "virtual", reading: 30 }, { name: "playback.first-sample", clockId: "virtual", reading: 40 }]; assert.deepEqual(calculateLatency(milestones), { ttft: 10, ttfsw: 30, firstSegment: 15 }); assert.throws(() => calculateLatency([...milestones, { name: "x", clockId: "wall", reading: 1 }]), /clock/); });
