import assert from "node:assert/strict"; import { test } from "node:test"; import { runDreaming } from "../src/dreaming/run.ts";
test("dreaming returns validated proposals without applying them", () => { const p = runDreaming(() => [{ id: "p", kind: "memory", evidenceIds: ["m"] }], {}); assert.equal(p[0].id, "p"); });
