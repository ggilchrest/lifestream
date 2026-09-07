import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionHandoffService } from "../src/endpoints/handoff.ts";

const seed = { leaseId: "lease-1", sessionId: "session-1", ownerEndpointId: "endpoint-a", revision: 1, expiresAt: "2026-09-07T00:01:00Z", fencingToken: 1 };
const request = (overrides = {}) => ({ handoffId: "handoff-1", sessionId: "session-1", sourceEndpointId: "endpoint-a", destinationEndpointId: "endpoint-b", expectedLeaseRevision: 1, initiatorRef: "human", authorized: true, destinationAvailable: true, privacyCompatible: true, occurredAt: "2026-09-07T00:00:00Z", ...overrides });

test("handoff transfers the single audio owner and fences the source", () => { const service = new SessionHandoffService(); service.seedLease(seed); const result = service.handoff(request()); assert.equal(result.outcome, "completed"); assert.equal(service.currentLease(seed.sessionId)?.ownerEndpointId, "endpoint-b"); assert.equal(service.activeOwnerCount(seed.sessionId), 1); assert.equal(result.newLease?.fencingToken, 2); assert.deepEqual(service.handoff(request()), result); });
test("failed, stale, unauthorized, or privacy-downgrade handoffs preserve the source", () => { for (const overrides of [{ expectedLeaseRevision: 2 }, { authorized: false }, { destinationAvailable: false }, { privacyCompatible: false }]) { const service = new SessionHandoffService(); service.seedLease(seed); assert.equal(service.handoff(request(overrides)).outcome, "failed"); assert.equal(service.currentLease(seed.sessionId)?.ownerEndpointId, "endpoint-a"); } });
