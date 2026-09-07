type CapabilityDefinition = { readonly id: string; readonly version: string; readonly inputSchema: Record<string, unknown>; readonly outputSchema: Record<string, unknown>; readonly sideEffect: "none" | "reversible" | "irreversible" | "unknown"; readonly authorization: "none" | "required"; readonly idempotency: "idempotent" | "nonIdempotent" | "unsupported"; readonly latencyClass: "fast" | "bounded" | "long"; readonly offlineAvailable: boolean; readonly simulationSupported: boolean; readonly route: string };
type AuthorityContextRef = { readonly providerRef: string; readonly contextId: string; readonly revision: number };
type CapabilitySnapshotRequest = { readonly assistantId: string; readonly endpointId: string; readonly sessionId: string; readonly environment: string; readonly authorityContextRef: AuthorityContextRef; readonly now: string };
type CapabilityInvocation = CapabilitySnapshotRequest & { readonly invocationId: string; readonly interactionId: string; readonly capabilityId: string; readonly capabilityVersion: string; readonly snapshotId: string; readonly snapshotRevision: number; readonly input: unknown; readonly idempotencyKey?: string };
type CapabilityInvocationResult = { readonly invocationId: string; readonly lifecycle: "authorized" | "denied" | "approvalRequired" | "started" | "succeeded" | "failed" | "outcomeUnknown"; readonly output?: unknown; readonly reason?: string; readonly receipt?: string };
type CapabilitySnapshot = Omit<CapabilitySnapshotRequest, "now"> & { readonly snapshotId: string; readonly revision: number; readonly expiresAt: string; readonly capabilities: readonly CapabilityDefinition[] };
type CapabilityProvider = { getSnapshot(request: CapabilitySnapshotRequest): CapabilitySnapshot; invoke(invocation: CapabilityInvocation, capability: CapabilityDefinition): CapabilityInvocationResult; getInvocation(invocationId: string): CapabilityInvocationResult | undefined };

export class FixtureCapabilityProvider implements CapabilityProvider {
  private readonly results = new Map<string, CapabilityInvocationResult>();
  private readonly calls = new Map<string, number>();
  private readonly definitions: readonly CapabilityDefinition[];

  constructor(definitions: readonly CapabilityDefinition[] = []) { this.definitions = definitions; }

  getSnapshot(request: CapabilitySnapshotRequest): CapabilitySnapshot {
    return Object.freeze({
      ...request,
      snapshotId: "00000000-0000-4000-8000-000000000017",
      revision: request.authorityContextRef.revision,
      expiresAt: new Date(Date.parse(request.now) + 60_000).toISOString(),
      capabilities: this.definitions.map((definition) => structuredClone(definition)),
    });
  }

  invoke(invocation: CapabilityInvocation, capability: CapabilityDefinition): CapabilityInvocationResult {
    const calls = (this.calls.get(invocation.invocationId) ?? 0) + 1;
    this.calls.set(invocation.invocationId, calls);
    if (this.results.has(invocation.invocationId)) return structuredClone(this.results.get(invocation.invocationId)!);
    const lifecycle: CapabilityInvocationResult = capability.idempotency === "unsupported"
      ? { invocationId: invocation.invocationId, lifecycle: "outcomeUnknown", reason: "fixture_outcome_unknown" }
      : { invocationId: invocation.invocationId, lifecycle: "succeeded", output: { fixture: true } };
    this.results.set(invocation.invocationId, lifecycle);
    return structuredClone(lifecycle);
  }

  getInvocation(invocationId: string): CapabilityInvocationResult | undefined {
    const result = this.results.get(invocationId);
    return result && structuredClone(result);
  }

  invocationCount(invocationId: string): number { return this.calls.get(invocationId) ?? 0; }
}
