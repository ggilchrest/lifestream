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
  private readonly entries = new Map<string, {snapshot:CapabilitySnapshot; monotonicExpires:number}>();

  put(snapshot: CapabilitySnapshot, now = new Date().toISOString()): CapabilitySnapshot {
    const copy = structuredClone(snapshot);
    this.entries.set(key(snapshot), {snapshot:copy,monotonicExpires:performance.now()+Math.max(0,Date.parse(snapshot.expiresAt)-Date.parse(now))});
    return structuredClone(copy);
  }

  get(scope: CapabilityScope, now: string): CapabilitySnapshot | undefined {
    const entry = this.entries.get(key(scope)),snapshot=entry?.snapshot;
    if (!snapshot || !entry || !Number.isFinite(Date.parse(now)) || Date.parse(snapshot.expiresAt) <= Date.parse(now) || performance.now() >= entry.monotonicExpires || !sameAuthority(snapshot, scope)) return undefined;
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
