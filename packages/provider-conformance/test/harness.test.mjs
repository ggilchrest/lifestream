import assert from "node:assert/strict";
import { test } from "node:test";
import { assertConformance, runConformance } from "../src/harness.ts";

const manifest = { schemaVersion:"1.0.0", providerRef:"fixture", adapterVersion:"1.0.0", ports:["FixtureProvider"], contractProfile:"lifestream.ports.v1", supportedSchemas:[{schemaId:"schema",sha256:"a".repeat(64)}], streaming:false, dataEgress:"none", health:"healthy", latencyClass:"instant" };
const adapter = { manifest, capabilities:()=>["bounded"], async invoke(request) { if (request.signal.aborted) return {status:"cancelled"}; if (request.deadlineAt === "2026-09-07T00:00:00Z") return {status:"timedOut"}; if (request.idempotencyKey === "replay-case" && this.replayed) return {status:"succeeded", idempotent:true}; if (request.idempotencyKey === "replay-case") this.replayed=true; return {status:"succeeded"}; } };

test("fixture adapter passes the reusable conformance suite", async () => { const report = await runConformance(adapter); assertConformance(report); assert.equal(report.fixtureOnly, true); assert.equal(report.cases.length, 8); });
test("deliberately broken adapter fails expected conformance cases", async () => { const broken = { ...adapter, async invoke() { return {status:"succeeded", error:"token leaked"}; } }; const report = await runConformance(broken); assert.equal(report.cases.find((item)=>item.caseId === "LS-CONF-deadline").status, "fail"); assert.equal(report.cases.find((item)=>item.caseId === "LS-CONF-cancellation").status, "fail"); assert.equal(report.cases.find((item)=>item.caseId === "LS-CONF-redaction").status, "fail"); assert.throws(()=>assertConformance(report), /conformance failed/); });
