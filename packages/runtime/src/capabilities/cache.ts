import type { CapabilityScope, CapabilitySnapshot } from "./ports.js";

function key(scope: CapabilityScope): string {
  return JSON.stringify({
    assistantId: scope.assistantId,
    endpointId: scope.endpointId,
    sessionId: scope.sessionId,
    environment: scope.environment,
    authorityContextRef: scope.authorityContextRef,
  });
}

export class CapabilitySnapshotCache {
  private readonly entries = new Map<string, CapabilitySnapshot>();

  put(snapshot: CapabilitySnapshot): CapabilitySnapshot {
    const copy = structuredClone(snapshot);
    this.entries.set(key(snapshot), copy);
    return structuredClone(copy);
  }

  get(scope: CapabilityScope, now: string): CapabilitySnapshot | undefined {
    const snapshot = this.entries.get(key(scope));
    if (!snapshot || snapshot.expiresAt <= now || !sameAuthority(snapshot, scope)) return undefined;
    return structuredClone(snapshot);
  }

  invalidate(scope?: CapabilityScope): void {
    if (!scope) this.entries.clear();
    else this.entries.delete(key(scope));
  }
}

function sameAuthority(snapshot: CapabilitySnapshot, scope: CapabilityScope): boolean {
  return snapshot.authorityContextRef.providerRef === scope.authorityContextRef.providerRef
    && snapshot.authorityContextRef.contextId === scope.authorityContextRef.contextId
    && snapshot.authorityContextRef.revision === scope.authorityContextRef.revision;
}
