export type RelationalOpportunity = {
  opportunityId: string;
  assistantId: string;
  userId: string;
  relationshipId: string;
  sessionId: string;
  endpointId: string;
  createdAt: number;
  expiresAt: number;
  origin: "relationalOpportunity";
  urgency: "low";
  kind: "arrivalGreeting" | "casualInvitation" | "relevantQuestion" | "groundedFollowUp";
};

export type InitiativeEligibility = {
  enabled: boolean;
  endpointAvailable: boolean;
  audienceAllowed: boolean;
  audioOwnerAvailable: boolean;
  now: number;
};

export type InitiativeAdmission =
  | { admitted: true; opportunity: RelationalOpportunity }
  | { admitted: false; reason: "disabled" | "endpointUnavailable" | "audienceDenied" | "audioBusy" | "expired" | "duplicate" | "capacity" };
export type InitiativeAdmissionRecord = Pick<RelationalOpportunity, "opportunityId" | "assistantId" | "userId" | "relationshipId" | "sessionId" | "endpointId" | "createdAt" | "expiresAt" | "origin" | "urgency" | "kind">;

/** Bounded, low-urgency admission; generation and delivery remain ordinary runtime operations. */
export class RelationalInitiativeCoordinator {
  private readonly admitted = new Map<string, RelationalOpportunity>();
  private readonly maxPending: number;
  constructor(maxPending = 8) { if (!Number.isInteger(maxPending) || maxPending < 1) throw new Error("invalid initiative capacity"); this.maxPending = maxPending; }

  admit(opportunity: RelationalOpportunity, eligibility: InitiativeEligibility): InitiativeAdmission {
    if (opportunity.origin !== "relationalOpportunity" || opportunity.urgency !== "low") throw new Error("invalid relational opportunity");
    if (this.admitted.has(opportunity.opportunityId)) return { admitted: false, reason: "duplicate" };
    if (this.admitted.size >= this.maxPending) return { admitted: false, reason: "capacity" };
    if (eligibility.now >= opportunity.expiresAt) return { admitted: false, reason: "expired" };
    if (!eligibility.enabled) return { admitted: false, reason: "disabled" };
    if (!eligibility.endpointAvailable) return { admitted: false, reason: "endpointUnavailable" };
    if (!eligibility.audienceAllowed) return { admitted: false, reason: "audienceDenied" };
    if (!eligibility.audioOwnerAvailable) return { admitted: false, reason: "audioBusy" };
    const copy = structuredClone(opportunity);
    this.admitted.set(copy.opportunityId, copy);
    return { admitted: true, opportunity: structuredClone(copy) };
  }

  recheck(opportunityId: string, eligibility: InitiativeEligibility): InitiativeAdmission {
    const opportunity = this.admitted.get(opportunityId);
    if (!opportunity) return { admitted: false, reason: "duplicate" };
    if (eligibility.now >= opportunity.expiresAt) { this.clear(opportunityId); return { admitted: false, reason: "expired" }; }
    if (!eligibility.enabled) { this.clear(opportunityId); return { admitted: false, reason: "disabled" }; }
    if (!eligibility.endpointAvailable) { this.clear(opportunityId); return { admitted: false, reason: "endpointUnavailable" }; }
    if (!eligibility.audienceAllowed) { this.clear(opportunityId); return { admitted: false, reason: "audienceDenied" }; }
    if (!eligibility.audioOwnerAvailable) { this.clear(opportunityId); return { admitted: false, reason: "audioBusy" }; }
    return { admitted: true, opportunity: structuredClone(opportunity) };
  }

  has(opportunityId: string): boolean { return this.admitted.has(opportunityId); }
  clear(opportunityId: string): void { this.admitted.delete(opportunityId); }
  preemptForUserTurn(): string[] { const ids = [...this.admitted.keys()]; this.admitted.clear(); return ids; }
  snapshot(): InitiativeAdmissionRecord[] { return [...this.admitted.values()].map((opportunity) => structuredClone(opportunity)); }
  restore(records: readonly InitiativeAdmissionRecord[], now: number): void {
    if (records.length > this.maxPending) throw new Error("initiative capacity exceeded");
    for (const record of records) {
      if (record.origin !== "relationalOpportunity" || record.urgency !== "low" || now >= record.expiresAt) continue;
      if (this.admitted.has(record.opportunityId)) continue;
      this.admitted.set(record.opportunityId, structuredClone(record));
    }
  }
}
