export type Readiness = { configured: boolean; available: boolean; fixtureProfile: boolean; decisionResolved: boolean };
export type AuthorityScenarioOutcome = "refreshRequired" | "denyNoFallback" | "quarantined" | "ready" | "blocked";
export function lostInvalidationOutcome(invalidationReceived: boolean, currentRevision: number, knownRevision: number): AuthorityScenarioOutcome { return invalidationReceived && currentRevision === knownRevision ? "ready" : "refreshRequired"; }
export function externalFailureOutcome(externalAvailable: boolean): AuthorityScenarioOutcome { return externalAvailable ? "ready" : "denyNoFallback"; }
export function restoreOutcome(reconciled: boolean): AuthorityScenarioOutcome { return reconciled ? "ready" : "quarantined"; }
export function readinessOutcome(readiness: Readiness): AuthorityScenarioOutcome { return readiness.configured && readiness.available && (readiness.fixtureProfile || readiness.decisionResolved) ? "ready" : "blocked"; }
