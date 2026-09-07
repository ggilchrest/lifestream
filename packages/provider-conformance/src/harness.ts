export type ProviderManifest = {
  readonly schemaVersion: "1.0.0";
  readonly providerRef: string;
  readonly adapterVersion: string;
  readonly ports: readonly string[];
  readonly contractProfile: "lifestream.ports.v1";
  readonly supportedSchemas: readonly { readonly schemaId: string; readonly sha256: string }[];
  readonly streaming: boolean;
  readonly dataEgress: "none" | "local" | "configuredRemote";
  readonly health: "healthy" | "degraded" | "unavailable";
  readonly latencyClass: "instant" | "interactive" | "slow" | "background";
};

export type ConformanceAdapter = {
  readonly manifest: ProviderManifest;
  readonly capabilities: () => readonly string[];
  readonly invoke: (request: { readonly deadlineAt: string; readonly signal: AbortSignal; readonly idempotencyKey: string; readonly payload: unknown }) => Promise<{ readonly status: "succeeded" | "rejected" | "cancelled" | "timedOut" | "failed"; readonly error?: string; readonly idempotent?: boolean }>;
};

export type ConformanceCase = { readonly caseId: string; readonly status: "pass" | "fail"; readonly evidence: string };
export type ConformanceReport = { readonly schemaVersion: "1.0.0"; readonly profile: "lifestream.ports.v1"; readonly providerRef: string; readonly fixtureOnly: true; readonly cases: readonly ConformanceCase[] };

const cases = ["manifest", "capabilities", "deadline", "cancellation", "limits", "redaction", "replay", "data-egress"] as const;
const id = (name: typeof cases[number]) => `LS-CONF-${name}`;
const pass = (name: typeof cases[number], evidence: string): ConformanceCase => ({ caseId: id(name), status: "pass", evidence });
const fail = (name: typeof cases[number], evidence: string): ConformanceCase => ({ caseId: id(name), status: "fail", evidence });

export async function runConformance(adapter: ConformanceAdapter, now = "2026-09-07T00:00:00Z"): Promise<ConformanceReport> {
  const results: ConformanceCase[] = [];
  const manifest = adapter.manifest;
  const manifestValid = manifest.schemaVersion === "1.0.0" && manifest.contractProfile === "lifestream.ports.v1" && manifest.providerRef.length > 0 && manifest.ports.length > 0 && manifest.supportedSchemas.length > 0;
  results.push(manifestValid ? pass("manifest", "Provider manifest declares profile, ports, schemas, health, egress, and latency.") : fail("manifest", "Provider manifest is incomplete."));
  results.push(adapter.capabilities().length > 0 && adapter.manifest.ports.length > 0 ? pass("capabilities", "Provider advertises at least one capability for its declared port.") : fail("capabilities", "No capability declaration was available."));

  const expired = await adapter.invoke({ deadlineAt: now, signal: new AbortController().signal, idempotencyKey: "deadline-case", payload: { bounded: true } });
  results.push(expired.status === "timedOut" ? pass("deadline", "Expired deadline produces a typed timeout.") : fail("deadline", `Expired deadline returned ${expired.status}.`));
  const cancellation = new AbortController(); cancellation.abort();
  const cancelled = await adapter.invoke({ deadlineAt: "2026-09-07T00:01:00Z", signal: cancellation.signal, idempotencyKey: "cancel-case", payload: { bounded: true } });
  results.push(cancelled.status === "cancelled" ? pass("cancellation", "Aborted context produces a typed cancellation.") : fail("cancellation", `Aborted context returned ${cancelled.status}.`));
  const limited = await adapter.invoke({ deadlineAt: "2026-09-07T00:01:00Z", signal: new AbortController().signal, idempotencyKey: "limit-case", payload: { bounded: true, itemCount: 2 } });
  results.push(limited.status !== "failed" ? pass("limits", "Fixture invocation remains bounded and returns a typed status.") : fail("limits", "Bounded invocation failed without a typed contract status."));
  results.push(limited.error === undefined || !/secret|token|password/i.test(limited.error) ? pass("redaction", "Provider error surface contains no credential-like values.") : fail("redaction", "Provider error exposed credential-like content."));
  const replay = await adapter.invoke({ deadlineAt: "2026-09-07T00:01:00Z", signal: new AbortController().signal, idempotencyKey: "replay-case", payload: { bounded: true } });
  const replayAgain = await adapter.invoke({ deadlineAt: "2026-09-07T00:01:00Z", signal: new AbortController().signal, idempotencyKey: "replay-case", payload: { bounded: true } });
  results.push(replay.status === replayAgain.status && replayAgain.idempotent === true ? pass("replay", "Identical idempotency key and content replay the recorded outcome.") : fail("replay", "Replay did not identify an idempotent recorded outcome."));
  results.push(["none", "local", "configuredRemote"].includes(manifest.dataEgress) ? pass("data-egress", `Manifest declares data egress as ${manifest.dataEgress}.`) : fail("data-egress", "Data egress is not declared."));
  return { schemaVersion: "1.0.0", profile: "lifestream.ports.v1", providerRef: manifest.providerRef, fixtureOnly: true, cases: results };
}

export function assertConformance(report: ConformanceReport): void {
  if (report.cases.length !== cases.length || report.cases.some((item) => item.status !== "pass")) throw new Error("provider conformance failed");
}
