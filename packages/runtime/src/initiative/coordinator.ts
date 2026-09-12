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
  | { admitted: false; reason: "disabled" | "endpointUnavailable" | "audienceDenied" | "audioBusy" | "expired" | "duplicate" };

/** Bounded, low-urgency admission; generation and delivery remain ordinary runtime operations. */
export class RelationalInitiativeCoordinator {
  private readonly admitted = new Map<string, RelationalOpportunity>();

  admit(opportunity: RelationalOpportunity, eligibility: InitiativeEligibility): InitiativeAdmission {
    if (opportunity.origin !== "relationalOpportunity" || opportunity.urgency !== "low") throw new Error("invalid relational opportunity");
    if (this.admitted.has(opportunity.opportunityId)) return { admitted: false, reason: "duplicate" };
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
}
