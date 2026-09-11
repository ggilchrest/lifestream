import type { Proposal } from "./proposal-validator.js";
export function runDreaming(analyzer: (input: unknown) => Proposal[], input: unknown): Proposal[] { const proposals = analyzer(input).map((p) => structuredClone(p)); for (const proposal of proposals) { if (!proposal.id || proposal.evidenceIds.length === 0) throw new Error("invalid proposal"); } return proposals; }

export type InsightLens = "evidenceQuality" | "communicationFit" | "contextUse" | "structureCompression" | "trainingOpportunity";
export type InsightRecord = { id: string; content: string; sourceFamily: string; status: "approved" | "pending" | "rejected"; independentEvidence?: boolean };
export type InsightProposal = { id: string; kind: "insight"; lens: InsightLens; observation: string; supportEvidenceIds: string[]; counterEvidenceIds: string[]; relationshipScope: string; uncertainty: string; intervention: string; benefit: string; cost: string; risk: string; validationScenario: string; inverse: string; status: "proposed" | "rejected" };
export type FeedbackKind = "reaffirmation" | "correction" | "helpfulness" | "style" | "salience";
export type FeedbackEvent = { id: string; targetId: string; kind: FeedbackKind; attributedBy: string; sourceFamily?: string; value?: string; affects: "evidence" | "communication" | "salience"; independentSupport: boolean };

const insightLenses: InsightLens[] = ["evidenceQuality", "communicationFit", "contextUse", "structureCompression", "trainingOpportunity"];
const lensText: Record<InsightLens, { observation: string; intervention: string; benefit: string; cost: string; risk: string; validationScenario: string }> = {
  evidenceQuality: { observation: "Review support and counterevidence by source family; repeated derivatives do not add independent support.", intervention: "Keep source-family identity visible and route unresolved contradictions to review.", benefit: "More honest evidence boundaries.", cost: "Less automatic consolidation.", risk: "A sparse source may remain unresolved.", validationScenario: "Approve one source-grounded record and reject a derivative-only reinforcement." },
  communicationFit: { observation: "Separate explicit communication feedback from factual support and relationship authority.", intervention: "Apply helpfulness or style feedback only to its declared communication field.", benefit: "Clearer communication adaptation.", cost: "Feedback cannot validate unrelated facts.", risk: "A subjective preference may be overgeneralized.", validationScenario: "Compare an explicitly attributed style preference without changing evidence support." },
  contextUse: { observation: "Inspect approved, omitted and repeatedly retrieved context without treating retrieval as reinforcement.", intervention: "Adjust salience metadata only through an explicit attributed event.", benefit: "More inspectable context selection.", cost: "Requires deliberate review.", risk: "Salience can still be mistaken for truth if labels are hidden.", validationScenario: "Repeat retrieval and verify support is unchanged before an explicit salience event." },
  structureCompression: { observation: "Check whether compression preserves corrections, contradictions and source-family coverage.", intervention: "Retain source links and restore omitted details through a reversible proposal.", benefit: "Less information loss in summaries.", cost: "Larger prepared context.", risk: "Compression may still omit a low-salience correction.", validationScenario: "Use a seeded correction and contradiction in a bounded summary comparison." },
  trainingOpportunity: { observation: "Identify a bounded training opportunity without treating generated text or engagement as a learned-quality signal.", intervention: "Create a review-only opportunity with explicit data scope, consent and held-out validation.", benefit: "Safer experiment planning.", cost: "No immediate behavior change.", risk: "Training may be infeasible or overbroad.", validationScenario: "Reject an opportunity lacking consent or held-out validation and verify no active state changes." }
};

export function buildInsightProposals(records: InsightRecord[], relationshipScope: string): InsightProposal[] {
  const approved = records.filter((record) => record.status === "approved");
  const families = new Map<string, number>();
  for (const record of approved) families.set(record.sourceFamily, (families.get(record.sourceFamily) ?? 0) + 1);
  const supportEvidenceIds = approved.filter((record) => record.independentEvidence !== false).map((record) => record.id);
  const counterEvidenceIds = approved.filter((record) => (families.get(record.sourceFamily) ?? 0) > 1 && record.independentEvidence === false).map((record) => record.id);
  return insightLenses.map((lens) => { const copy = lensText[lens]; const insufficient = supportEvidenceIds.length < 2; return { id: `insight-${lens}`, kind: "insight", lens, observation: copy.observation, supportEvidenceIds: [...supportEvidenceIds], counterEvidenceIds: [...counterEvidenceIds], relationshipScope, uncertainty: insufficient ? "insufficient independent evidence" : "bounded fixture evidence only", intervention: copy.intervention, benefit: copy.benefit, cost: copy.cost, risk: copy.risk, validationScenario: copy.validationScenario, inverse: "Rejecting this proposal leaves active relationship configuration and evidence unchanged.", status: "proposed" }; });
}

export function classifyFeedback(input: Omit<FeedbackEvent, "id" | "affects" | "independentSupport"> & { id?: string }): FeedbackEvent {
  const affects = input.kind === "reaffirmation" || input.kind === "correction" ? "evidence" : input.kind === "salience" ? "salience" : "communication";
  return { id: input.id ?? "feedback", targetId: input.targetId, kind: input.kind, attributedBy: input.attributedBy, ...(input.sourceFamily ? { sourceFamily: input.sourceFamily } : {}), ...(input.value ? { value: input.value } : {}), affects, independentSupport: input.kind === "reaffirmation" || input.kind === "correction" };
}
