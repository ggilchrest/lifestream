import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilityResolver } from "../src/capabilities/resolver.ts";
import { CapabilitySnapshotCache } from "../src/capabilities/cache.ts";
import { FixtureCapabilityProvider } from "../../providers-fixture/src/capability/provider.ts";
import type { CapabilityDefinition, CapabilityInvocation } from "../src/capabilities/ports.ts";

const authorityContextRef = { providerRef: "fixture-authority", contextId: "00000000-0000-4000-8000-000000000001", revision: 1 };
const scope = { assistantId: "assistant", endpointId: "endpoint", sessionId: "session", environment: "test", authorityContextRef };
const capability: CapabilityDefinition = { id: "notify", version: "1", inputSchema: { type: "object", required: ["message"] }, outputSchema: { type: "object" }, sideEffect: "irreversible", authorization: "required", idempotency: "idempotent", latencyClass: "fast", offlineAvailable: false, simulationSupported: true, route: "fixture.notify" };
const invocation = (input: unknown = { message: "hello" }): CapabilityInvocation => ({ ...scope, invocationId: "invocation", interactionId: "interaction", capabilityId: "notify", capabilityVersion: "1", snapshotId: "00000000-0000-4000-8000-000000000017", snapshotRevision: 1, input, idempotencyKey: "key" });

test("capability snapshot binds complete scope and current authority admission", () => {
  const provider = new FixtureCapabilityProvider([capability]);
  const resolver = new CapabilityResolver(provider, new CapabilitySnapshotCache(), (request) => ({ invocationId: request.invocationId, status: "admitted", grantRevision: 1 }), () => "2026-09-07T00:00:00.000Z");
  resolver.snapshot(scope);
  assert.equal(resolver.invoke(invocation()).lifecycle, "succeeded");
  assert.equal(provider.invocationCount("invocation"), 1);
  assert.equal(resolver.invoke({ ...invocation(), input: {} }).lifecycle, "denied");
  assert.equal(provider.invocationCount("invocation"), 1);
});

test("missing authority admission, changed authority, expiry, and unknown outcomes fail closed", () => {
  const unknown: CapabilityDefinition = { ...capability, id: "unknown", idempotency: "unsupported" };
  const provider = new FixtureCapabilityProvider([unknown]);
  const resolver = new CapabilityResolver(provider, new CapabilitySnapshotCache(), () => undefined, () => "2026-09-07T00:00:00.000Z");
  resolver.snapshot(scope);
  assert.equal(resolver.invoke({ ...invocation(), capabilityId: "unknown" }).lifecycle, "approvalRequired");
  resolver.invalidate(scope);
  assert.equal(resolver.invoke({ ...invocation(), capabilityId: "unknown" }).lifecycle, "denied");
  assert.equal(resolver.getInvocation("missing"), undefined);
});

test("a changed session cannot reuse a cached snapshot", () => {
  const provider = new FixtureCapabilityProvider([capability]);
  const resolver = new CapabilityResolver(provider, new CapabilitySnapshotCache(), (request) => ({ invocationId: request.invocationId, status: "admitted", grantRevision: 1 }), () => "2026-09-07T00:00:00.000Z");
  resolver.snapshot(scope);
  assert.equal(resolver.invoke({ ...invocation(), sessionId: "different-session" }).lifecycle, "denied");
});

test("an admitted unsupported capability reports unknown and is not invoked twice", () => {
  const unsupported: CapabilityDefinition = { ...capability, id: "unknown", idempotency: "unsupported" };
  const provider = new FixtureCapabilityProvider([unsupported]);
  const resolver = new CapabilityResolver(provider, new CapabilitySnapshotCache(), (request) => ({ invocationId: request.invocationId, status: "admitted", grantRevision: 1 }), () => "2026-09-07T00:00:00.000Z");
  resolver.snapshot(scope);
  const request = { ...invocation(), capabilityId: "unknown", invocationId: "unknown-invocation" };
  assert.equal(resolver.invoke(request).lifecycle, "outcomeUnknown");
  assert.equal(resolver.invoke(request).lifecycle, "outcomeUnknown");
  assert.equal(provider.invocationCount(request.invocationId), 1);
});
