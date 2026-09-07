import assert from "node:assert/strict"; import { test } from "node:test"; import { applyProposal } from "../src/dreaming/apply.ts";
test("application requires expected revision", () => { const p = { id: "p", kind: "memory", evidenceIds: ["m"] }; assert.equal(applyProposal(p, 1, 1).id, "p"); assert.throws(() => applyProposal(p, 1, 2), /conflict/); });
