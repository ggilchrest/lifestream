import type { DispatchReceipt } from "../authority/authorize-dispatch.js";
import type {
  CapabilityDefinition,
  CapabilityInvocation,
  CapabilityInvocationResult,
  CapabilityProvider,
  CapabilityScope,
  CapabilitySnapshot,
} from "./ports.js";
class CapabilitySnapshotCache {
  private readonly entries = new Map<string, CapabilitySnapshot>();
  put(snapshot: CapabilitySnapshot): CapabilitySnapshot { const copy = structuredClone(snapshot); this.entries.set(scopeKey(snapshot), copy); return structuredClone(copy); }
  get(scope: CapabilityScope, now: string): CapabilitySnapshot | undefined { const snapshot = this.entries.get(scopeKey(scope)); return snapshot && snapshot.expiresAt > now && sameAuthority(snapshot, scope) ? structuredClone(snapshot) : undefined; }
  invalidate(scope?: CapabilityScope): void { if (scope) this.entries.delete(scopeKey(scope)); else this.entries.clear(); }
}

function scopeKey(scope: CapabilityScope): string { return JSON.stringify({ assistantId: scope.assistantId, endpointId: scope.endpointId, sessionId: scope.sessionId, environment: scope.environment, authorityContextRef: scope.authorityContextRef }); }
function sameAuthority(snapshot: CapabilitySnapshot, scope: CapabilityScope): boolean { return snapshot.authorityContextRef.providerRef === scope.authorityContextRef.providerRef && snapshot.authorityContextRef.contextId === scope.authorityContextRef.contextId && snapshot.authorityContextRef.revision === scope.authorityContextRef.revision; }

export type AuthorityDispatcher = (invocation: CapabilityInvocation, capability: CapabilityDefinition) => DispatchReceipt | undefined;

export class CapabilityResolver {
  private readonly provider: CapabilityProvider;
  private readonly cache: CapabilitySnapshotCache;
  private readonly dispatch: AuthorityDispatcher;
  private readonly now: () => string;

  constructor(
    provider: CapabilityProvider,
    cache = new CapabilitySnapshotCache(),
    dispatch: AuthorityDispatcher = () => undefined,
    now: () => string = () => new Date().toISOString(),
  ) { this.provider = provider; this.cache = cache; this.dispatch = dispatch; this.now = now; }

  snapshot(scope: CapabilityScope): CapabilitySnapshot {
    const current = this.provider.getSnapshot({ ...scope, now: this.now() });
    return this.cache.put(current);
  }

  invalidate(scope?: CapabilityScope): void { this.cache.invalidate(scope); }

  invoke(invocation: CapabilityInvocation): CapabilityInvocationResult {
    const snapshot = this.cache.get(invocation, this.now());
    if (!snapshot || snapshot.snapshotId !== invocation.snapshotId || snapshot.revision !== invocation.snapshotRevision) {
      return this.result(invocation, "denied", "capability_snapshot_stale_or_unbound");
    }
    const capability = snapshot.capabilities.find((item) => item.id === invocation.capabilityId && item.version === invocation.capabilityVersion);
    if (!capability || !validInput(capability.inputSchema, invocation.input)) return this.result(invocation, "denied", "capability_or_arguments_invalid");
    if (capability.sideEffect !== "none" || capability.authorization === "required") {
      const receipt = this.dispatch(invocation, capability);
      if (!receipt) return this.result(invocation, "approvalRequired", "current_authority_decision_required");
      if (receipt.invocationId !== invocation.invocationId || receipt.status !== "admitted") {
        return this.result(invocation, "denied", `dispatch ${receipt.status}`);
      }
    }
    const prior = this.provider.getInvocation(invocation.invocationId);
    if (prior) return prior;
    return this.provider.invoke(structuredClone(invocation), capability);
  }

  getInvocation(invocationId: string): CapabilityInvocationResult | undefined { return this.provider.getInvocation(invocationId); }

  private result(invocation: CapabilityInvocation, lifecycle: CapabilityInvocationResult["lifecycle"], reason: string): CapabilityInvocationResult {
    return { invocationId: invocation.invocationId, lifecycle, reason };
  }
}

function validInput(schema: Record<string, unknown>, input: unknown): boolean {
  if (schema.type === "object" && (input === null || typeof input !== "object" || Array.isArray(input))) return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return required.length === 0;
  return required.every((name) => typeof name === "string" && Object.prototype.hasOwnProperty.call(input, name));
}
