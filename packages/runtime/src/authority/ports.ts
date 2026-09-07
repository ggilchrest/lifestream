export type AuthenticatedHumanContext = { readonly principalId: string; readonly authenticatedAt: string; readonly evidenceRef: string };
export type AuthorityRequest = { assistantId: string; scope: string; inputDigest: string };
export type AuthorityResult = { disposition: "authorized" | "denied" | "approvalRequired"; reason: string };
export interface AuthorityProvider { evaluate(context: AuthenticatedHumanContext, request: AuthorityRequest): AuthorityResult; }
export function validateContext(context: AuthenticatedHumanContext): void { if (!context.principalId || !context.evidenceRef || !context.authenticatedAt.endsWith("Z")) throw new Error("invalid authenticated context"); }
