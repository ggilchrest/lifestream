import type { Proposal } from "./proposal-validator.js";
export function runDreaming(analyzer: (input: unknown) => Proposal[], input: unknown): Proposal[] { const proposals = analyzer(input).map((p) => structuredClone(p)); for (const proposal of proposals) { if (!proposal.id || proposal.evidenceIds.length === 0) throw new Error("invalid proposal"); } return proposals; }
