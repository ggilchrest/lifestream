type AuthenticatedHumanContext = { readonly principalId: string; readonly authenticatedAt: string; readonly evidenceRef: string };
export class FixtureAuthenticationProvider { authenticate(principalId: string, evidenceRef = "fixture"): AuthenticatedHumanContext { return Object.freeze({ principalId, evidenceRef, authenticatedAt: "2026-09-06T00:00:00Z" }); } }
