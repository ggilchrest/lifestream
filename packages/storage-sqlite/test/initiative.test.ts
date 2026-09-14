import assert from "node:assert/strict";
import { test } from "node:test";
import { Database } from "../src/database.ts";
import { InitiativeLedgerRepository } from "../src/initiative.ts";

test("initiative ledger persists outcomes and excludes expired pending records", () => { const database = new Database({ path: ":memory:" }); database.migrate(); const ledger = new InitiativeLedgerRepository(database); const opportunity = { opportunityId: "op-1", assistantId: "a", userId: "u", relationshipId: "r", sessionId: "s", endpointId: "e", origin: "relationalOpportunity" as const, urgency: "low" as const, kind: "arrivalGreeting" as const, createdAt: 100, expiresAt: 200 }; ledger.record(opportunity); assert.equal(ledger.listPending(150).length, 1); assert.equal(ledger.outcome("op-1"), null); ledger.record(opportunity, "delivered"); assert.equal(ledger.outcome("op-1"), "delivered"); ledger.record({ ...opportunity, opportunityId: "op-2", expiresAt: 120 }); ledger.record({ ...opportunity, opportunityId: "op-2", expiresAt: 120 }, "cancelled"); assert.equal(ledger.outcome("op-2"), "cancelled"); assert.equal(ledger.listPending(150).length, 0); database.close(); });


test("LS-TEST-117/118: admission is unique, scoped and terminal across ledger clients", () => {
  const database = new Database({ path: ":memory:" }); database.migrate();
  try {
    const first = new InitiativeLedgerRepository(database), second = new InitiativeLedgerRepository(database);
    const item = { opportunityId: "unique", assistantId: "a", userId: "u", relationshipId: "r", sessionId: "s", endpointId: "e", origin: "relationalOpportunity" as const, urgency: "low" as const, kind: "arrivalGreeting" as const, createdAt: 100, expiresAt: 200 };
    first.record(item);
    assert.throws(() => second.record(item));
    assert.throws(() => second.record({ ...item, userId: "another" }, "delivered"), /scope mismatch/u);
    assert.equal(first.outcome(item.opportunityId), null);
    first.record(item, "delivered");
    second.record(item, "delivered");
    assert.throws(() => second.record(item, "cancelled"), /terminal/u);
    assert.throws(() => second.record(item));
    assert.equal(first.outcome(item.opportunityId), "delivered");
    assert.throws(() => second.record({ ...item, opportunityId: "unknown" }, "delivered"), /unknown/u);
  } finally { database.close(); }
});
