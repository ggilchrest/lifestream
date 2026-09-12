import type { Database } from "./database.js";
export type InitiativeAdmissionRecord = { opportunityId: string; assistantId: string; userId: string; relationshipId: string; sessionId: string; endpointId: string; createdAt: number; expiresAt: number; origin: "relationalOpportunity"; urgency: "low"; kind: "arrivalGreeting" | "casualInvitation" | "relevantQuestion" | "groundedFollowUp" };
export type InitiativeOutcome = "delivered" | "declined" | "cancelled";

export type InitiativeLedgerRecord = InitiativeAdmissionRecord & { outcome: InitiativeOutcome | null; recordedAt: string };
export class InitiativeLedgerRepository {
  private readonly database: Database;
  constructor(database: Database) { this.database = database; }
  record(opportunity: InitiativeAdmissionRecord, outcome: InitiativeOutcome | null = null, recordedAt = new Date().toISOString()): void {
    this.database.transaction((tx) => { tx.run("INSERT INTO relational_initiative_ledger (opportunity_id, assistant_id, user_id, relationship_id, session_id, endpoint_id, origin, urgency, kind, created_at, expires_at, outcome, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(opportunity_id) DO UPDATE SET outcome = excluded.outcome, recorded_at = excluded.recorded_at", opportunity.opportunityId, opportunity.assistantId, opportunity.userId, opportunity.relationshipId, opportunity.sessionId, opportunity.endpointId, opportunity.origin, opportunity.urgency, opportunity.kind, opportunity.createdAt, opportunity.expiresAt, outcome, recordedAt); });
  }
  outcome(opportunityId: string): InitiativeOutcome | null | undefined { const row = this.database.connection.prepare("SELECT outcome FROM relational_initiative_ledger WHERE opportunity_id = ?").get(opportunityId) as { outcome: InitiativeOutcome | null } | undefined; return row === undefined ? undefined : row.outcome; }
  listPending(now: number): InitiativeAdmissionRecord[] { return (this.database.connection.prepare("SELECT opportunity_id AS opportunityId, assistant_id AS assistantId, user_id AS userId, relationship_id AS relationshipId, session_id AS sessionId, endpoint_id AS endpointId, origin, urgency, kind, created_at AS createdAt, expires_at AS expiresAt FROM relational_initiative_ledger WHERE outcome IS NULL AND expires_at > ? ORDER BY created_at, opportunity_id").all(now) as InitiativeAdmissionRecord[]); }
}
