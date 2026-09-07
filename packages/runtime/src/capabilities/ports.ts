export type SideEffectClass = "none" | "reversible" | "irreversible" | "unknown";
export type IdempotencyPosture = "idempotent" | "nonIdempotent" | "unsupported";

export type AuthorityContextRef = {
  readonly providerRef: string;
  readonly contextId: string;
  readonly revision: number;
};

export type CapabilityScope = {
  readonly assistantId: string;
  readonly endpointId: string;
  readonly sessionId: string;
  readonly environment: string;
  readonly authorityContextRef: AuthorityContextRef;
};

export type CapabilityDefinition = {
  readonly id: string;
  readonly version: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly sideEffect: SideEffectClass;
  readonly authorization: "none" | "required";
  readonly idempotency: IdempotencyPosture;
  readonly latencyClass: "fast" | "bounded" | "long";
  readonly offlineAvailable: boolean;
  readonly simulationSupported: boolean;
  readonly route: string;
};

export type CapabilitySnapshot = CapabilityScope & {
  readonly snapshotId: string;
  readonly revision: number;
  readonly expiresAt: string;
  readonly capabilities: readonly CapabilityDefinition[];
};

export type CapabilitySnapshotRequest = CapabilityScope & { readonly now: string };

export type CapabilityInvocation = CapabilityScope & {
  readonly invocationId: string;
  readonly interactionId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly input: unknown;
  readonly idempotencyKey?: string;
};

export type CapabilityLifecycle =
  | "authorized"
  | "denied"
  | "approvalRequired"
  | "started"
  | "succeeded"
  | "failed"
  | "outcomeUnknown";

export type CapabilityInvocationResult = {
  readonly invocationId: string;
  readonly lifecycle: CapabilityLifecycle;
  readonly output?: unknown;
  readonly reason?: string;
  readonly receipt?: string;
};

export interface CapabilityProvider {
  getSnapshot(request: CapabilitySnapshotRequest): CapabilitySnapshot;
  invoke(invocation: CapabilityInvocation, capability: CapabilityDefinition): CapabilityInvocationResult;
  getInvocation(invocationId: string): CapabilityInvocationResult | undefined;
}
