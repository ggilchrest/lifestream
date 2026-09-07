import assert from "node:assert/strict";
import { test } from "node:test";
import { capture, evaluate, type CaptureManifest } from "../src/harness.ts";

const good: CaptureManifest = { viewport: { width: 1280, height: 720 }, audioFormat: "pcm_s16le/48000/mono", frames: [{ at: 0, speech: "silent", attention: "none" }, { at: 10, speech: "speaking", attention: "participant" }, { at: 20, speech: "silent", attention: "none" }] };

test("deterministic capture and rubric pass without a VLM", () => { const result = evaluate(capture(good)); assert.equal(result.deterministic.passed, true); assert.equal(result.judge.status, "unavailable"); });
test("rubric identifies clipped, stuck-speaking, and wrong-attention evidence", () => { const result = evaluate(capture({ ...good, frames: [{ at: 1, speech: "speaking", attention: "object", clipped: true }] })); assert.deepEqual(result.deterministic.failures, ["clipped frame", "stuck speaking", "attention mismatch"]); });
test("capture orders the fixed timeline and rejects an invalid viewport", () => { assert.deepEqual(capture({ ...good, frames: [...good.frames].reverse() }).frames.map((frame) => frame.at), [0, 10, 20]); assert.throws(() => capture({ ...good, viewport: { width: 0, height: 1 } }), /viewport/); });
