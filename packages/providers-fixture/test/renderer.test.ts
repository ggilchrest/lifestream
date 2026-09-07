import assert from "node:assert/strict";
import { test } from "node:test";
import { FixtureRendererProvider, type RendererState } from "../src/renderer/provider.ts";

const state = (sequence: number, overrides: Partial<RendererState> = {}): RendererState => ({
  schemaVersion: "1.0.0", stateId: `00000000-0000-4000-8000-0000000000${sequence + 30}`,
  sequence, speechState: "silent", activity: "idle", attention: "none", engagement: "available",
  affect: { valence: 0, arousal: 0.2, confidence: 1 }, urgency: "normal", effectiveAt: "2026-09-07T00:00:00Z", ...overrides,
});

test("declares semantic renderer capabilities and applies a fresh state", () => {
  const renderer = new FixtureRendererProvider();
  assert.deepEqual(renderer.getCapabilities().supportedAxes, ["attention", "engagement", "affect", "speechState", "activity", "urgency"]);
  assert.deepEqual(renderer.apply(state(1, { speechState: "speaking", activity: "conversing" }), "2026-09-07T00:00:01Z"), {
    stateId: "00000000-0000-4000-8000-000000000031", sequence: 1, disposition: "applied", degradedAxes: [], appliedAt: "2026-09-07T00:00:01Z", reason: null,
  });
});

test("rejects stale and expired state without replacing the applied state", () => {
  const renderer = new FixtureRendererProvider();
  renderer.apply(state(2), "2026-09-07T00:00:01Z");
  assert.equal(renderer.apply(state(1), "2026-09-07T00:00:02Z").reason, "stale_sequence");
  assert.equal(renderer.apply(state(3, { expiresAt: "2026-09-07T00:00:03Z" }), "2026-09-07T00:00:04Z").reason, "expired_state");
  assert.equal(renderer.current()?.sequence, 2);
});

test("reports a renderer fault as a rejected application", () => {
  const renderer = new FixtureRendererProvider({ crashOnApply: true });
  const result = renderer.apply(state(1), "2026-09-07T00:00:01Z");
  assert.equal(renderer.getCapabilities().readiness, "degraded");
  assert.deepEqual(result, { stateId: "00000000-0000-4000-8000-000000000031", sequence: 1, disposition: "rejected", degradedAxes: [], appliedAt: null, reason: "renderer_fault" });
  assert.equal(renderer.current(), undefined);
});
