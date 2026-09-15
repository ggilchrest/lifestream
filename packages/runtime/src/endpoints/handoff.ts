export type AudioOwnershipLease = { leaseId: string; sessionId: string; ownerEndpointId: string; revision: number; expiresAt: string; fencingToken: number };
export type HandoffRequest = { handoffId: string; sessionId: string; sourceEndpointId: string; destinationEndpointId: string; expectedLeaseRevision: number; initiatorRef: string; authorized: boolean; destinationAvailable: boolean; privacyCompatible: boolean; occurredAt: string };
export type HandoffRecord = { handoffId: string; sessionId: string; sourceEndpointId: string; destinationEndpointId: string; authorization: "authorized" | "denied"; oldLeaseId: string | null; newLease: AudioOwnershipLease | null; outcome: "completed" | "failed"; reason: string };

export class SessionHandoffService {
  private readonly leases = new Map<string, AudioOwnershipLease>();
  private readonly records = new Map<string, HandoffRecord>();
  private readonly fences = new Map<string,number>();

  /** Host-only output admission. A stale release cannot remove a successor owner. */
  acquire(sessionId:string,ownerEndpointId:string,leaseId:string,expiresAt:string,now=Date.now()):AudioOwnershipLease {
    const expiry=Date.parse(expiresAt);
    if(!sessionId||!ownerEndpointId||!leaseId||!Number.isFinite(now)||!Number.isFinite(expiry)||expiry<=now)throw new Error("invalid audio lease");
    const current=this.leases.get(sessionId);
    if(current&&Date.parse(current.expiresAt)>now)throw new Error("audio output already owned");
    const fencingToken=Math.max(this.fences.get(sessionId)??0,current?.fencingToken??0)+1;
    const lease={leaseId,sessionId,ownerEndpointId,revision:fencingToken,expiresAt,fencingToken};
    this.fences.set(sessionId,fencingToken);this.leases.set(sessionId,lease);return structuredClone(lease);
  }
  owns(lease:AudioOwnershipLease,now=Date.now()):boolean {
    const current=this.leases.get(lease.sessionId);return Number.isFinite(now)&&Date.parse(lease.expiresAt)>now&&!!current&&current.expiresAt===lease.expiresAt&&Date.parse(current.expiresAt)>now&&current.leaseId===lease.leaseId&&current.ownerEndpointId===lease.ownerEndpointId&&current.revision===lease.revision&&current.fencingToken===lease.fencingToken;
  }
  release(lease:AudioOwnershipLease):boolean {
    const current=this.leases.get(lease.sessionId);if(!current||current.leaseId!==lease.leaseId||current.revision!==lease.revision||current.fencingToken!==lease.fencingToken||current.ownerEndpointId!==lease.ownerEndpointId)return false;
    this.fences.set(lease.sessionId,Math.max(this.fences.get(lease.sessionId)??0,current.fencingToken));return this.leases.delete(lease.sessionId);
  }

  seedLease(lease: AudioOwnershipLease): AudioOwnershipLease { if (this.leases.has(lease.sessionId)) throw new Error("session already has audio owner"); if(!Number.isSafeInteger(lease.fencingToken)||lease.fencingToken<1||lease.fencingToken<=(this.fences.get(lease.sessionId)??0)||!Number.isFinite(Date.parse(lease.expiresAt)))throw new Error("stale or invalid audio lease seed"); this.fences.set(lease.sessionId,lease.fencingToken); this.leases.set(lease.sessionId, structuredClone(lease)); return structuredClone(lease); }
  handoff(request: HandoffRequest): HandoffRecord { const duplicate = this.records.get(request.handoffId); if (duplicate) return structuredClone(duplicate); const current = this.leases.get(request.sessionId); const fail = (reason: string): HandoffRecord => { const record = { handoffId: request.handoffId, sessionId: request.sessionId, sourceEndpointId: request.sourceEndpointId, destinationEndpointId: request.destinationEndpointId, authorization: request.authorized ? "authorized" as const : "denied" as const, oldLeaseId: current?.leaseId ?? null, newLease: null, outcome: "failed" as const, reason }; this.records.set(request.handoffId, record); return structuredClone(record); }; if (!current || current.ownerEndpointId !== request.sourceEndpointId || current.revision !== request.expectedLeaseRevision) return fail("stale_lease"); if (!Number.isFinite(Date.parse(request.occurredAt)) || Date.parse(current.expiresAt) <= Date.parse(request.occurredAt)) return fail("lease_expired"); if (!request.authorized) return fail("handoff_not_authorized"); if (!request.destinationAvailable) return fail("destination_unavailable"); if (!request.privacyCompatible) return fail("privacy_downgrade"); const next: AudioOwnershipLease = { leaseId: request.handoffId, sessionId: request.sessionId, ownerEndpointId: request.destinationEndpointId, revision: current.revision + 1, expiresAt: current.expiresAt, fencingToken: current.fencingToken + 1 }; const record = { handoffId: request.handoffId, sessionId: request.sessionId, sourceEndpointId: request.sourceEndpointId, destinationEndpointId: request.destinationEndpointId, authorization: "authorized" as const, oldLeaseId: current.leaseId, newLease: next, outcome: "completed" as const, reason: "handoff_completed" }; this.leases.set(request.sessionId, structuredClone(next)); this.records.set(request.handoffId, record); return structuredClone(record); }
  currentLease(sessionId: string): AudioOwnershipLease | undefined { const lease = this.leases.get(sessionId); return lease && structuredClone(lease); }
  activeOwnerCount(sessionId: string): number { return this.leases.has(sessionId) ? 1 : 0; }
}
