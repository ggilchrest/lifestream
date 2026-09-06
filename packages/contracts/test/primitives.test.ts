import assert from "node:assert/strict";
import test from "node:test";
import { FixedClock } from "../src/primitives/clock.ts";
import { createDeadline } from "../src/primitives/deadline.ts";
import { LifestreamError } from "../src/primitives/error.ts";
import { isOpaqueUuid } from "../src/primitives/identity.ts";

test("deterministic primitives preserve injected values and safe errors", () => {
  assert.equal(new FixedClock("2026-01-01T00:00:00.000Z").now(), "2026-01-01T00:00:00.000Z");
  const deadline = createDeadline(100, 1000);
  assert.equal(deadline.remainingMs(1050), 50);
  assert.equal(deadline.expired(1100), true);
  assert.equal(isOpaqueUuid("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isOpaqueUuid("admin-550e8400-e29b-41d4-a716-446655440000"), false);
  const error = new LifestreamError("failed", "safe", true, "550e8400-e29b-41d4-a716-446655440000");
  assert.deepEqual(error.toStatus(), { code: "failed", message: "safe", retryable: true, correlationId: "550e8400-e29b-41d4-a716-446655440000" });
});
