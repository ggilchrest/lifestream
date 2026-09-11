import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInsightProposals, classifyFeedback } from "../src/dreaming/run.ts";
import { validateInsightProposal } from "../src/dreaming/proposal-validator.ts";
import { rejectInsightProposal } from "../src/dreaming/apply.ts";

test("insight lenses preserve source families and disclose insufficient evidence", () => {
  const proposals = buildInsightProposals([{ id: "source-a", content: "A", sourceFamily: "conversation-1", status: "approved" }, { id: "derivative-a", content: "A2", sourceFamily: "conversation-1", status: "approved", independentEvidence: false }], "relationship-1");
  assert.equal(proposals.length, 5);
  assert.equal(proposals[0].uncertainty, "insufficient independent evidence");
  assert.deepEqual(proposals[0].counterEvidenceIds, ["derivative-a"]);
  validateInsightProposal(proposals[0]);
});

test("feedback lanes do not promote retrieval, style or salience to evidence", () => {
  assert.equal(classifyFeedback({ targetId: "m", kind: "reaffirmation", attributedBy: "human", sourceFamily: "direct" }).affects, "evidence");
  assert.equal(classifyFeedback({ targetId: "m", kind: "helpfulness", attributedBy: "human", value: "useful" }).independentSupport, false);
  assert.equal(classifyFeedback({ targetId: "m", kind: "style", attributedBy: "human" }).affects, "communication");
  assert.equal(classifyFeedback({ targetId: "m", kind: "salience", attributedBy: "human" }).affects, "salience");
});

test("rejecting an insight is a non-mutating review transition", () => {
  const proposal = { id: "i", status: "proposed" };
  const rejected = rejectInsightProposal(proposal, "proposed");
  assert.equal(rejected.status, "rejected");
  assert.equal(proposal.status, "proposed");
  assert.throws(() => rejectInsightProposal(rejected, "proposed"), /conflict/);
});
