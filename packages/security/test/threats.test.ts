import assert from "node:assert/strict";
import { test } from "node:test";
import { redactError, runSecuritySuite } from "../src/threats.ts";

test("fixture threat suite passes safe inputs and covers all required cases", () => { const report = runSecuritySuite({ artifacts: [{ event: "safe", payload: "bounded" }] }); assert.equal(report.passed, true); assert.deepEqual(report.cases.map((item) => item.caseId), ["self-grant", "forged-revocation", "live-replay", "ambient-privacy", "secret-scan"]); });
test("security suite fails closed for attacks and secret-like artifacts", () => { const report = runSecuritySuite({ selfGrantAttempt: true, forgedRevocation: true, liveReplay: true, ambientSensitiveDisclosure: true, artifacts: [{ authorization: "Bearer abc.def" }] }); assert.equal(report.passed, false); assert.ok(report.cases.every((item) => item.status === "fail")); });
test("error redaction removes credential-like values", () => { assert.equal(redactError("Bearer abc password=hunter2"), "Bearer [REDACTED] password=[REDACTED]"); });
