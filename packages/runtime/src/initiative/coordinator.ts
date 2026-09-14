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
  dispositionEnabled?: boolean;
  relationshipOptIn?: boolean;
  authorityAllowed?: boolean;
  endpointAvailable: boolean;
  audienceAllowed: boolean;
  audioOwnerAvailable: boolean;
  now: number;
};

export type InitiativeAdmission =
  | { admitted: true; opportunity: RelationalOpportunity }
  | { admitted: false; reason: "disabled" | "endpointUnavailable" | "audienceDenied" | "audioBusy" | "expired" | "duplicate" | "capacity" | "admissionUnavailable" };
export type InitiativeAdmissionRecord = Pick<RelationalOpportunity, "opportunityId" | "assistantId" | "userId" | "relationshipId" | "sessionId" | "endpointId" | "createdAt" | "expiresAt" | "origin" | "urgency" | "kind">;
export type InitiativeOutcome = "delivered" | "declined" | "cancelled";
export type InitiativeSnapshot = { admissions: InitiativeAdmissionRecord[]; outcomes: { opportunityId: string; outcome: InitiativeOutcome }[] };
export type InitiativePersistence = { outcome(opportunityId: string): InitiativeOutcome | null | undefined; record(opportunity: InitiativeAdmissionRecord, outcome?: InitiativeOutcome | null): void; listPending?(now: number): InitiativeAdmissionRecord[] };

/** Bounded, low-urgency admission; generation and delivery remain ordinary runtime operations. */
export class RelationalInitiativeCoordinator {
  private readonly admitted = new Map<string, RelationalOpportunity>();
  private readonly outcomes = new Map<string, InitiativeOutcome>();
  private readonly maxPending: number;
  private readonly persistence: InitiativePersistence | undefined;
  constructor(maxPending = 8, persistence?: InitiativePersistence, now = Date.now()) { if (!Number.isInteger(maxPending) || maxPending < 1) throw new Error("invalid initiative capacity"); this.maxPending = maxPending; this.persistence = persistence; this.restore({ admissions: persistence?.listPending?.(now) ?? [], outcomes: [] }, now); }

  admit(opportunity: RelationalOpportunity, eligibility: InitiativeEligibility): InitiativeAdmission {
    if (opportunity.origin !== "relationalOpportunity" || opportunity.urgency !== "low") throw new Error("invalid relational opportunity");
    if (this.admitted.has(opportunity.opportunityId) || this.outcomes.has(opportunity.opportunityId) || this.persistence?.outcome(opportunity.opportunityId) !== undefined) return { admitted: false, reason: "duplicate" };
    if (this.admitted.size >= this.maxPending) return { admitted: false, reason: "capacity" };
    if (!Number.isFinite(eligibility.now) || !Number.isFinite(opportunity.createdAt) || !Number.isFinite(opportunity.expiresAt) || eligibility.now < opportunity.createdAt || eligibility.now >= opportunity.expiresAt) return { admitted: false, reason: "expired" };
    if (!eligibility.enabled || eligibility.dispositionEnabled !== true) return { admitted: false, reason: "disabled" };
    if (eligibility.relationshipOptIn !== true || eligibility.authorityAllowed !== true) return { admitted: false, reason: "audienceDenied" };
    if (!eligibility.endpointAvailable) return { admitted: false, reason: "endpointUnavailable" };
    if (!eligibility.audienceAllowed) return { admitted: false, reason: "audienceDenied" };
    if (!eligibility.audioOwnerAvailable) return { admitted: false, reason: "audioBusy" };
    const copy = structuredClone(opportunity);
    try { this.persistence?.record(copy); } catch { return { admitted: false, reason: "admissionUnavailable" }; }
    this.admitted.set(copy.opportunityId, copy);
    return { admitted: true, opportunity: structuredClone(copy) };
  }

  recheck(opportunityId: string, eligibility: InitiativeEligibility): InitiativeAdmission {
    const opportunity = this.admitted.get(opportunityId);
    if (!opportunity) return { admitted: false, reason: "duplicate" };
    if (!Number.isFinite(eligibility.now) || !Number.isFinite(opportunity.createdAt) || !Number.isFinite(opportunity.expiresAt) || eligibility.now < opportunity.createdAt || eligibility.now >= opportunity.expiresAt) { this.clear(opportunityId); return { admitted: false, reason: "expired" }; }
    if (!eligibility.enabled || eligibility.dispositionEnabled !== true) { this.clear(opportunityId); return { admitted: false, reason: "disabled" }; }
    if (eligibility.relationshipOptIn !== true || eligibility.authorityAllowed !== true) { this.clear(opportunityId); return { admitted: false, reason: "audienceDenied" }; }
    if (!eligibility.endpointAvailable) { this.clear(opportunityId); return { admitted: false, reason: "endpointUnavailable" }; }
    if (!eligibility.audienceAllowed) { this.clear(opportunityId); return { admitted: false, reason: "audienceDenied" }; }
    if (!eligibility.audioOwnerAvailable) { this.clear(opportunityId); return { admitted: false, reason: "audioBusy" }; }
    return { admitted: true, opportunity: structuredClone(opportunity) };
  }

  completeDelivery(opportunityId: string, eligibility: InitiativeEligibility, outcome: InitiativeOutcome): InitiativeAdmission {
    const checked = this.recheck(opportunityId, eligibility);
    if (!checked.admitted) return checked;
    this.recordOutcome(opportunityId, outcome);
    return checked;
  }

  has(opportunityId: string): boolean { return this.admitted.has(opportunityId); }
  clear(opportunityId: string): void { if (this.admitted.has(opportunityId)) this.recordOutcome(opportunityId, "cancelled"); }
  recordOutcome(opportunityId: string, outcome: InitiativeOutcome): void { const opportunity = this.admitted.get(opportunityId); if (!opportunity) throw new Error("unknown initiative opportunity"); this.admitted.delete(opportunityId); this.outcomes.set(opportunityId, outcome); this.persistence?.record(opportunity, outcome); }
  preemptForUserTurn(): string[] { const ids = [...this.admitted.keys()]; for (const id of ids) this.recordOutcome(id, "cancelled"); return ids; }
  snapshot(): InitiativeSnapshot { return { admissions: [...this.admitted.values()].map((opportunity) => structuredClone(opportunity)), outcomes: [...this.outcomes.entries()].map(([opportunityId, outcome]) => ({ opportunityId, outcome })) }; }
  outcome(opportunityId: string): InitiativeOutcome | undefined { return this.outcomes.get(opportunityId); }
  restore(snapshot: InitiativeSnapshot, _now: number): void {
    if (snapshot.admissions.length > this.maxPending) throw new Error("initiative capacity exceeded");
    for (const { opportunityId, outcome } of snapshot.outcomes) this.outcomes.set(opportunityId, outcome);
    for (const record of snapshot.admissions) {
      if (record.origin !== "relationalOpportunity" || record.urgency !== "low") throw new Error("invalid restored opportunity");
      if (this.outcomes.has(record.opportunityId)) continue;
      // Recovery preserves deduplication, never a backlog of pending social output.
      this.outcomes.set(record.opportunityId, "cancelled");
      this.persistence?.record(record, "cancelled");
    }
  }
}
