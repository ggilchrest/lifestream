import assert from "node:assert/strict";
import { test } from "node:test";
import { RelationalInitiativeCoordinator, type RelationalOpportunity } from "../src/initiative/coordinator.ts";

const opportunity: RelationalOpportunity = { opportunityId: "op-1", assistantId: "assistant-1", userId: "user-1", relationshipId: "relationship-1", sessionId: "session-1", endpointId: "endpoint-1", createdAt: 100, expiresAt: 200, origin: "relationalOpportunity", urgency: "low", kind: "arrivalGreeting" };
const eligible = { enabled: true, dispositionEnabled: true, relationshipOptIn: true, authorityAllowed: true, endpointAvailable: true, audienceAllowed: true, audioOwnerAvailable: true, now: 150 };

test("initiative admission is quiet by default and rejects unavailable delivery", () => { const coordinator = new RelationalInitiativeCoordinator(); assert.deepEqual(coordinator.admit(opportunity, { ...eligible, enabled: false }), { admitted: false, reason: "disabled" }); assert.deepEqual(coordinator.admit(opportunity, { ...eligible, audienceAllowed: false }), { admitted: false, reason: "audienceDenied" }); assert.deepEqual(coordinator.admit(opportunity, { ...eligible, audioOwnerAvailable: false }), { admitted: false, reason: "audioBusy" }); });
test("initiative eligibility keeps disposition, opt-in and authority separate", () => { const coordinator = new RelationalInitiativeCoordinator(); assert.deepEqual(coordinator.admit(opportunity, { ...eligible, dispositionEnabled: false }), { admitted: false, reason: "disabled" }); assert.deepEqual(coordinator.admit({ ...opportunity, opportunityId: "opt-out" }, { ...eligible, relationshipOptIn: false }), { admitted: false, reason: "audienceDenied" }); assert.deepEqual(coordinator.admit({ ...opportunity, opportunityId: "unauthorized" }, { ...eligible, authorityAllowed: false }), { admitted: false, reason: "audienceDenied" }); });
test("initiative admission is typed, low urgency, expiry checked and deduplicated", () => { const coordinator = new RelationalInitiativeCoordinator(); const result = coordinator.admit(opportunity, eligible); assert.equal(result.admitted, true); if (result.admitted) assert.equal(result.opportunity.origin, "relationalOpportunity"); assert.deepEqual(coordinator.admit(opportunity, eligible), { admitted: false, reason: "duplicate" }); assert.deepEqual(coordinator.admit({ ...opportunity, opportunityId: "op-2", expiresAt: 150 }, eligible), { admitted: false, reason: "expired" }); });
test("final policy recheck fences an admitted opportunity before delivery", () => { const coordinator = new RelationalInitiativeCoordinator(); coordinator.admit(opportunity, eligible); assert.deepEqual(coordinator.recheck(opportunity.opportunityId, { ...eligible, audienceAllowed: false }), { admitted: false, reason: "audienceDenied" }); assert.deepEqual(coordinator.recheck(opportunity.opportunityId, eligible), { admitted: false, reason: "duplicate" }); });
test("pending opportunities are bounded and preempted by a user turn", () => { const coordinator = new RelationalInitiativeCoordinator(1); assert.equal(coordinator.admit(opportunity, eligible).admitted, true); assert.deepEqual(coordinator.admit({ ...opportunity, opportunityId: "op-2" }, eligible), { admitted: false, reason: "capacity" }); assert.deepEqual(coordinator.preemptForUserTurn(), ["op-1"]); assert.equal(coordinator.has("op-1"), false); assert.equal(coordinator.outcome("op-1"), "cancelled"); assert.deepEqual(coordinator.admit(opportunity, eligible), { admitted: false, reason: "duplicate" }); });
test("admission snapshot restores minimal deduplication state across restart", () => { const first = new RelationalInitiativeCoordinator(); first.admit(opportunity, eligible); const second = new RelationalInitiativeCoordinator(); second.restore(first.snapshot(), 150); assert.deepEqual(second.admit(opportunity, eligible), { admitted: false, reason: "duplicate" }); assert.equal(second.snapshot().admissions.length, 0); assert.equal(second.outcome("op-1"), "cancelled"); });
test("terminal outcomes prevent repeated admission after delivery or decline", () => { const coordinator = new RelationalInitiativeCoordinator(); coordinator.admit(opportunity, eligible); coordinator.recordOutcome("op-1", "delivered"); assert.equal(coordinator.outcome("op-1"), "delivered"); assert.deepEqual(coordinator.admit(opportunity, eligible), { admitted: false, reason: "duplicate" }); });
test("terminal outcomes survive coordinator restart", () => { const first = new RelationalInitiativeCoordinator(); first.admit(opportunity, eligible); first.recordOutcome("op-1", "delivered"); const second = new RelationalInitiativeCoordinator(); second.restore(first.snapshot(), 150); assert.equal(second.outcome("op-1"), "delivered"); assert.deepEqual(second.admit(opportunity, eligible), { admitted: false, reason: "duplicate" }); });
test("delivery completion atomically rechecks policy and records outcome", () => { const coordinator = new RelationalInitiativeCoordinator(); coordinator.admit(opportunity, eligible); assert.deepEqual(coordinator.completeDelivery("op-1", { ...eligible, audioOwnerAvailable: false }, "delivered"), { admitted: false, reason: "audioBusy" }); assert.equal(coordinator.has("op-1"), false); assert.equal(coordinator.outcome("op-1"), "cancelled"); assert.equal(coordinator.admit(opportunity, eligible).admitted, false); assert.equal(coordinator.completeDelivery("op-1", eligible, "delivered").admitted, false); });
test("coordinator consults owner-local persistence for duplicate and outcome state", () => { const records = new Map<string, string | null>(); const persistence = { outcome: (id: string) => records.get(id), record: (item: { opportunityId: string }, outcome: string | null = null) => records.set(item.opportunityId, outcome) }; const first = new RelationalInitiativeCoordinator(8, persistence); first.admit(opportunity, eligible); first.recordOutcome("op-1", "delivered"); const second = new RelationalInitiativeCoordinator(8, persistence); assert.deepEqual(second.admit(opportunity, eligible), { admitted: false, reason: "duplicate" }); });
test("LS-TEST-117: coordinator expires pending admissions after restart", () => { const pending = { ...opportunity, opportunityId: "pending" }; const persistence = { outcome: () => undefined, record: () => undefined, listPending: () => [pending] }; const coordinator = new RelationalInitiativeCoordinator(8, persistence, 150); assert.equal(coordinator.has("pending"), false); assert.equal(coordinator.outcome("pending"), "cancelled"); assert.equal(coordinator.recheck("pending", eligible).admitted, false); });


test("LS-TEST-108/116: absent consent and authority fail closed", () => {
  for (const key of ["dispositionEnabled", "relationshipOptIn", "authorityAllowed"] as const) {
    const incomplete: Partial<typeof eligible> = { ...eligible };
    delete incomplete[key];
    const coordinator = new RelationalInitiativeCoordinator();
    assert.equal(coordinator.admit(opportunity, { enabled: true, endpointAvailable: true, audienceAllowed: true, audioOwnerAvailable: true, now: 150, ...incomplete }).admitted, false);
  }
});

test("LS-TEST-117: failed durable admission cannot leave deliverable in-memory work", () => {
  const coordinator = new RelationalInitiativeCoordinator(8, { outcome: () => undefined, record: () => { throw new Error("storage unavailable"); } });
  assert.deepEqual(coordinator.admit(opportunity, eligible), { admitted: false, reason: "admissionUnavailable" });
  assert.equal(coordinator.has(opportunity.opportunityId), false);
  assert.equal(coordinator.completeDelivery(opportunity.opportunityId, eligible, "delivered").admitted, false);
});

test("LS-TEST-117: persisted pending admission is already a duplicate", () => {
  const coordinator = new RelationalInitiativeCoordinator(8, { outcome: () => null, record: () => { assert.fail("must not rewrite pending admission"); } });
  assert.deepEqual(coordinator.admit(opportunity, eligible), { admitted: false, reason: "duplicate" });
});

test("LS-TEST-117: future and non-finite event clocks do not admit", () => {
  for (const item of [{ ...opportunity, createdAt: 151 }, { ...opportunity, createdAt: NaN }, { ...opportunity, expiresAt: Infinity }]) {
    assert.deepEqual(new RelationalInitiativeCoordinator().admit(item, eligible), { admitted: false, reason: "expired" });
  }
});
