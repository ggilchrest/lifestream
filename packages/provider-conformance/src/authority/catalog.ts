import type { AuthorityCaseResult } from "./report.js";
export type AuthorityScenario = { id: string; requirementIds: string[] };
export type ScenarioRunner = (scenario: AuthorityScenario) => AuthorityCaseResult;
export function runAuthorityCatalog(scenarios: AuthorityScenario[], runner: ScenarioRunner): AuthorityCaseResult[] { return scenarios.map((scenario) => runner(scenario)); }
export function assertCompleteAuthorityEvidence(results: AuthorityCaseResult[]): void { if (results.length === 0 || results.some((result) => result.status !== "pass" || !result.evidence)) throw new Error("authority catalog evidence incomplete"); }
