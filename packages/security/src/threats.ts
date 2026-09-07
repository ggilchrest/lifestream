export type SecurityCase = "self-grant" | "forged-revocation" | "live-replay" | "ambient-privacy" | "secret-scan";
export type SecurityTestReport = { cases: Array<{ caseId: SecurityCase; status: "pass" | "fail"; detail: string }>; passed: boolean };
export type ThreatInput = { selfGrantAttempt?: boolean; forgedRevocation?: boolean; liveReplay?: boolean; ambientSensitiveDisclosure?: boolean; artifacts: unknown[] };

const SECRET = /(?:sk-[A-Za-z0-9]{12,}|Bearer\s+[A-Za-z0-9._-]+|password\s*[:=]\s*\S+|private[_-]?key\s*[:=]\s*\S+)/i;
function hasSecret(value: unknown): boolean { if (typeof value === "string") return SECRET.test(value); if (Array.isArray(value)) return value.some(hasSecret); if (value && typeof value === "object") return Object.entries(value).some(([key, child]) => SECRET.test(key) || hasSecret(child)); return false; }

export function redactError(error: unknown): string { return String(error).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/(password|private[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]"); }

export function runSecuritySuite(input: ThreatInput): SecurityTestReport {
  const cases = [
    { caseId: "self-grant" as const, failed: input.selfGrantAttempt === true, detail: "self-grant attempt is rejected" },
    { caseId: "forged-revocation" as const, failed: input.forgedRevocation === true, detail: "forged revocation is rejected" },
    { caseId: "live-replay" as const, failed: input.liveReplay === true, detail: "live replay route is rejected" },
    { caseId: "ambient-privacy" as const, failed: input.ambientSensitiveDisclosure === true, detail: "ambient sensitive disclosure is withheld" },
    { caseId: "secret-scan" as const, failed: input.artifacts.some(hasSecret), detail: "artifacts contain no credential-like material" },
  ].map(({ caseId, failed, detail }) => ({ caseId, status: failed ? "fail" as const : "pass" as const, detail }));
  return { cases, passed: cases.every((item) => item.status === "pass") };
}
