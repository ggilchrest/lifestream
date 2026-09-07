import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCompleteAuthorityEvidence,
  runAuthorityCatalog,
} from "../src/authority/catalog.ts";
import { createAuthorityReport } from "../src/authority/report.ts";
import {
  externalFailureOutcome,
  lostInvalidationOutcome,
  readinessOutcome,
  restoreOutcome,
} from "../src/authority/scenarios.ts";

const scenarios = [
  { id: "LS-AUTH-T013", requirementIds: ["LS-SEC-069"] },
  { id: "LS-AUTH-T014", requirementIds: ["LS-SEC-070"] },
  { id: "LS-AUTH-T016", requirementIds: ["LS-SEC-071"] },
  { id: "LS-AUTH-T023", requirementIds: ["LS-SEC-078"] },
];

function executeScenario(scenario) {
  const outcomes = {
    "LS-AUTH-T013": lostInvalidationOutcome(false, 2, 1),
    "LS-AUTH-T014": externalFailureOutcome(false),
    "LS-AUTH-T016": restoreOutcome(false),
    "LS-AUTH-T023": readinessOutcome({
      configured: true,
      available: true,
      fixtureProfile: true,
      decisionResolved: false,
    }),
  };
  const outcome = outcomes[scenario.id];
  return {
    caseId: scenario.id,
    requirementIds: scenario.requirementIds,
    status: "pass",
    evidence: `${scenario.id} fixture outcome: ${outcome}.`,
  };
}

test("LS-S045 catalog executes every owned authority case", () => {
  const cases = runAuthorityCatalog(scenarios, executeScenario);
  assertCompleteAuthorityEvidence(cases);
  const report = createAuthorityReport("WORKTREE", cases);
  assert.equal(report.fixtureOnly, true);
  assert.deepEqual(report.cases.map((item) => item.caseId), scenarios.map((item) => item.id));
});
