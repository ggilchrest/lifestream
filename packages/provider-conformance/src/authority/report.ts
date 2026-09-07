export type AuthorityCaseResult = { caseId: string; requirementIds: string[]; status: "pass" | "fail" | "notRun"; evidence: string };
export type AuthorityConformanceReport = { profile: "test" | "local"; revision: string; fixtureOnly: true; cases: AuthorityCaseResult[] };
export function createAuthorityReport(revision: string, cases: AuthorityCaseResult[] = []): AuthorityConformanceReport { return { profile: "test", revision, fixtureOnly: true, cases: cases.map((c) => ({ ...c, requirementIds: [...c.requirementIds] })) }; }
