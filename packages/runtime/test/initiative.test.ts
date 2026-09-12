import assert from "node:assert/strict";
import { test } from "node:test";
import { RelationalInitiativeCoordinator, type RelationalOpportunity } from "../src/initiative/coordinator.ts";

const opportunity: RelationalOpportunity = { opportunityId: "op-1", assistantId: "assistant-1", userId: "user-1", relationshipId: "relationship-1", sessionId: "session-1", endpointId: "endpoint-1", createdAt: 100, expiresAt: 200, origin: "relationalOpportunity", urgency: "low", kind: "arrivalGreeting" };
const eligible = { enabled: true, endpointAvailable: true, audienceAllowed: true, audioOwnerAvailable: true, now: 150 };

test("initiative admission is quiet by default and rejects unavailable delivery", () => { const coordinator = new RelationalInitiativeCoordinator(); assert.deepEqual(coordinator.admit(opportunity, { ...eligible, enabled: false }), { admitted: false, reason: "disabled" }); assert.deepEqual(coordinator.admit(opportunity, { ...eligible, audienceAllowed: false }), { admitted: false, reason: "audienceDenied" }); assert.deepEqual(coordinator.admit(opportunity, { ...eligible, audioOwnerAvailable: false }), { admitted: false, reason: "audioBusy" }); });
test("initiative admission is typed, low urgency, expiry checked and deduplicated", () => { const coordinator = new RelationalInitiativeCoordinator(); const result = coordinator.admit(opportunity, eligible); assert.equal(result.admitted, true); if (result.admitted) assert.equal(result.opportunity.origin, "relationalOpportunity"); assert.deepEqual(coordinator.admit(opportunity, eligible), { admitted: false, reason: "duplicate" }); assert.deepEqual(coordinator.admit({ ...opportunity, opportunityId: "op-2", expiresAt: 150 }, eligible), { admitted: false, reason: "expired" }); });
