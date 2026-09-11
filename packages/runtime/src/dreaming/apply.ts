import type { Proposal } from "./proposal-validator.js";
const checkConflict = (expectedRevision: number, actualRevision: number): void => { if (expectedRevision !== actualRevision) throw new Error("proposal conflict"); };
export function applyProposal(proposal: Proposal, expectedRevision: number, actualRevision: number): Proposal { checkConflict(expectedRevision, actualRevision); return structuredClone(proposal); }
export function rejectInsightProposal<T extends { status: string }>(proposal: T, expectedStatus: string): T { if (proposal.status !== expectedStatus) throw new Error("proposal conflict"); return { ...structuredClone(proposal), status: "rejected" } as T; }
