import { createHash } from 'node:crypto';
import type { Database } from "../database.js";
export type Admission = { invocationId: string; grantId: string; grantRevision: number; inputDigest: string; status: "admitted" | "consumed" | "unknown" };
/** Checked host facts for the current internal resolver. This is not a
 * canonical HumanAuthorityDecision or permission derived from client metadata. */
export type GovernedDispatchBinding = {
  endpointId: string; environment: string; capabilityVersion: string; providerRoute: string; capabilityDefinitionDigest: string;
  snapshotId: string; snapshotRevision: number; interactionId: string;
  authorityContextRef: { providerRef: string; contextId: string; revision: number };
  executionMode: 'live' | 'replay' | 'simulation'; deadlineAt: string;
};
export type GovernedAdmissionInput = {
  grantId: string; principalId: string; assistantId: string; sessionId: string; capabilityId: string;
  invocationId: string; inputDigest: string; now: string; assertCurrent: () => void; binding?: GovernedDispatchBinding;
};
type Identity = Pick<GovernedAdmissionInput, 'grantId' | 'principalId' | 'assistantId' | 'sessionId' | 'capabilityId' | 'invocationId' | 'inputDigest'> & { binding: GovernedDispatchBinding | null };
type EvidenceRow = { identity_json: string; admission_json: string; admitted_at: string; sha256: string };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
function identity(input: GovernedAdmissionInput): Identity {
  const names = ['grantId', 'principalId', 'assistantId', 'sessionId', 'capabilityId', 'invocationId', 'inputDigest'] as const;
  if (!input || names.some(name => typeof input[name] !== 'string' || input[name].length < 1 || input[name].length > 500) ||
    typeof input.assertCurrent !== 'function' || typeof input.now !== 'string' || !input.now.endsWith('Z') || !Number.isFinite(Date.parse(input.now))) throw new Error('invalid admission');
  let binding: GovernedDispatchBinding | null = null;
  if (input.binding !== undefined) {
    const b = input.binding;
    if (!b || ['endpointId', 'environment', 'capabilityVersion', 'providerRoute', 'snapshotId', 'interactionId'].some(name => {
      const value = b[name as keyof GovernedDispatchBinding]; return typeof value !== 'string' || value.length < 1 || value.length > 500;
    }) || typeof b.capabilityDefinitionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(b.capabilityDefinitionDigest) ||
      !Number.isInteger(b.snapshotRevision) || b.snapshotRevision < 0 || !['live', 'replay', 'simulation'].includes(b.executionMode) ||
      typeof b.deadlineAt !== 'string' || !b.deadlineAt.endsWith('Z') || !Number.isFinite(Date.parse(b.deadlineAt)) || !b.authorityContextRef ||
      !Number.isInteger(b.authorityContextRef.revision) || b.authorityContextRef.revision < 0 ||
      [b.authorityContextRef.providerRef, b.authorityContextRef.contextId].some(value => typeof value !== 'string' || !value || value.length > 500)) throw new Error('invalid admission binding');
    binding = { endpointId: b.endpointId, environment: b.environment, capabilityVersion: b.capabilityVersion, providerRoute: b.providerRoute, capabilityDefinitionDigest: b.capabilityDefinitionDigest,
      snapshotId: b.snapshotId, snapshotRevision: b.snapshotRevision, interactionId: b.interactionId,
      authorityContextRef: { providerRef: b.authorityContextRef.providerRef, contextId: b.authorityContextRef.contextId, revision: b.authorityContextRef.revision },
      executionMode: b.executionMode, deadlineAt: b.deadlineAt };
  }
  return { grantId: input.grantId, principalId: input.principalId, assistantId: input.assistantId, sessionId: input.sessionId,
    capabilityId: input.capabilityId, invocationId: input.invocationId, inputDigest: input.inputDigest, binding };
}
function evidenceBytes(row: Pick<EvidenceRow, 'identity_json' | 'admission_json' | 'admitted_at'>): string {
  return JSON.stringify({ schemaVersion: '1.0.0', checkedIdentity: JSON.parse(row.identity_json), admission: JSON.parse(row.admission_json), admittedAt: row.admitted_at });
}
function verifyEvidence(row: EvidenceRow | undefined, checked: Identity): EvidenceRow {
  if (!row || row.identity_json !== JSON.stringify(checked)) throw new Error('invocation binding conflict');
  if (sha256(evidenceBytes(row)) !== row.sha256) throw new Error('admission evidence invalid');
  return row;
}
export class AdmissionRepository {
  private readonly admissions = new Map<string, Admission>(); private readonly database: Database | undefined;
  constructor(database?: Database) { this.database = database; if (database) database.exec("CREATE TABLE IF NOT EXISTS dispatch_admissions (invocation_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, grant_revision INTEGER NOT NULL, input_digest TEXT NOT NULL, status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS authority_grants (id TEXT PRIMARY KEY, status TEXT NOT NULL, revision INTEGER NOT NULL)"); }
  admit(admission: Admission): Admission { if (this.database) return this.database.transaction((tx) => { const prior = tx.get<Admission>("SELECT invocation_id AS invocationId, grant_id AS grantId, grant_revision AS grantRevision, input_digest AS inputDigest, status FROM dispatch_admissions WHERE invocation_id = ?", admission.invocationId); if (prior) return prior; tx.run("INSERT INTO dispatch_admissions VALUES (?, ?, ?, ?, ?)", admission.invocationId, admission.grantId, admission.grantRevision, admission.inputDigest, admission.status); return admission; }); const prior = this.admissions.get(admission.invocationId); if (prior) return structuredClone(prior); this.admissions.set(admission.invocationId, structuredClone(admission)); return structuredClone(admission); }
  updateStatus(invocationId: string, status: Admission["status"]): Admission { const current = this.get(invocationId); if (!current) throw new Error("unknown invocation"); const next = { ...current, status }; if (this.database) this.database.transaction((tx) => tx.run("UPDATE dispatch_admissions SET status = ? WHERE invocation_id = ?", status, invocationId)); else this.admissions.set(invocationId, next); return next; }
  admitOneUse(grantId: string, grantRevision: number, invocationId: string, inputDigest: string): Admission { if (!this.database) return this.admit({ invocationId, grantId, grantRevision, inputDigest, status: "admitted" }); return this.database.transaction((tx) => { const prior = tx.get<Admission>("SELECT invocation_id AS invocationId, grant_id AS grantId, grant_revision AS grantRevision, input_digest AS inputDigest, status FROM dispatch_admissions WHERE invocation_id = ?", invocationId); if (prior) return prior; const grant = tx.get<{ revision: number; status: string }>("SELECT revision, status FROM authority_grants WHERE id = ?", grantId); if (!grant || grant.revision !== grantRevision || grant.status !== "active") throw new Error("grant is not admissible"); tx.run("UPDATE authority_grants SET status = 'consumed', revision = revision + 1 WHERE id = ? AND revision = ? AND status = 'active'", grantId, grantRevision); tx.run("INSERT INTO dispatch_admissions VALUES (?, ?, ?, ?, ?)", invocationId, grantId, grantRevision, inputDigest, "admitted"); return { invocationId, grantId, grantRevision, inputDigest, status: "admitted" }; }); }
  admitGoverned(input: GovernedAdmissionInput): Admission {
    if (!this.database) throw new Error("durable authority admission requires storage");
    const checked = identity(input), identityJson = JSON.stringify(checked), at = input.now, assertCurrent = input.assertCurrent;
    return this.database.transaction(tx => {
      assertCurrent();
      const prior = tx.get<Admission>("SELECT invocation_id AS invocationId,grant_id AS grantId,grant_revision AS grantRevision,input_digest AS inputDigest,status FROM dispatch_admissions WHERE invocation_id=?", checked.invocationId);
      if (prior) {
        const row = verifyEvidence(tx.get<EvidenceRow>("SELECT * FROM governed_admission_evidence WHERE invocation_id=?", checked.invocationId), checked);
        const original = JSON.parse(row.admission_json) as Admission;
        if (original.invocationId !== prior.invocationId || original.grantId !== prior.grantId || original.grantRevision !== prior.grantRevision || original.inputDigest !== prior.inputDigest) throw new Error('admission evidence invalid');
        assertCurrent();
        // Returning an immutable admission is status recovery, never a new I/O claim.
        return { ...prior };
      }
      if (checked.binding && (checked.binding.executionMode !== 'live' || Date.parse(checked.binding.deadlineAt) <= Date.parse(at))) throw new Error('dispatch binding is not current');
      const grant = tx.get<{revision:number;status:string;principal_id:string;assistant_id:string;scope_json:string;terms_json:string}>("SELECT * FROM authority_grants WHERE id=?", checked.grantId);
      if (!grant || grant.principal_id !== checked.principalId || grant.assistant_id !== checked.assistantId || grant.status !== "active" || !(JSON.parse(grant.scope_json) as string[]).includes(checked.capabilityId)) throw new Error("grant is not admissible");
      const terms = JSON.parse(grant.terms_json) as {durationMode:string;expiresAt:string;sessionId:string};
      if (!Number.isFinite(Date.parse(terms.expiresAt)) || Date.parse(terms.expiresAt) <= Date.parse(at) || !["allowOnce","allowSession","allowPersistent"].includes(terms.durationMode) || (terms.durationMode !== "allowPersistent" && terms.sessionId !== checked.sessionId)) throw new Error("grant terms are not current");
      if (terms.durationMode === "allowOnce") {
        tx.run("UPDATE authority_grants SET status='consumed',revision=revision+1 WHERE id=? AND revision=? AND status='active'", checked.grantId, grant.revision);
        if (tx.get<{changes:number}>("SELECT changes() AS changes")?.changes !== 1) throw new Error("grant consumption conflict");
        tx.run("INSERT INTO authority_events (grant_id,event,actor,occurred_at) VALUES (?,?,?,?)", checked.grantId, "consumed", checked.principalId, at);
      }
      const admission: Admission = { invocationId: checked.invocationId, grantId: checked.grantId, grantRevision: grant.revision, inputDigest: checked.inputDigest, status: "admitted" };
      const row = { identity_json: identityJson, admission_json: JSON.stringify(admission), admitted_at: at };
      tx.run("INSERT INTO dispatch_admissions VALUES (?,?,?,?,?)", admission.invocationId, admission.grantId, admission.grantRevision, admission.inputDigest, admission.status);
      tx.run("INSERT INTO governed_admission_evidence VALUES (?,?,?,?,?)", checked.invocationId, identityJson, row.admission_json, at, sha256(evidenceBytes(row)));
      tx.run("INSERT INTO authority_events (grant_id,event,actor,occurred_at) VALUES (?,?,?,?)", checked.grantId, "dispatch_admitted", checked.principalId, at);
      assertCurrent();
      return admission;
    });
  }
  /** Exactly one initial I/O claim, durable across repository owners and restart.
   * A false return means reconcile the original invocation; do not dispatch. */
  claimGovernedDispatch(input: GovernedAdmissionInput): boolean {
    if (!this.database) throw new Error('durable authority admission requires storage');
    const checked = identity(input), at = input.now, assertCurrent = input.assertCurrent;
    if (!checked.binding) throw new Error('dispatch binding required');
    return this.database.transaction(tx => {
      assertCurrent();
      const row = verifyEvidence(tx.get<EvidenceRow>('SELECT * FROM governed_admission_evidence WHERE invocation_id=?', checked.invocationId), checked);
      if (tx.get('SELECT invocation_id FROM governed_dispatch_claims WHERE invocation_id=?', checked.invocationId)) return false;
      const admission = JSON.parse(row.admission_json) as Admission;
      const grant = tx.get<{ revision:number; status:string; principal_id:string; assistant_id:string; scope_json:string; terms_json:string }>('SELECT * FROM authority_grants WHERE id=?', checked.grantId);
      const terms = grant && JSON.parse(grant.terms_json) as { durationMode:string; expiresAt:string; sessionId:string } | undefined;
      const expectedStatus = terms?.durationMode === 'allowOnce' ? 'consumed' : 'active';
      const expectedRevision = admission.grantRevision + (terms?.durationMode === 'allowOnce' ? 1 : 0);
      if (!grant || !terms || grant.status !== expectedStatus || grant.revision !== expectedRevision || grant.principal_id !== checked.principalId ||
        grant.assistant_id !== checked.assistantId || !(JSON.parse(grant.scope_json) as string[]).includes(checked.capabilityId) ||
        !Number.isFinite(Date.parse(terms.expiresAt)) || Date.parse(terms.expiresAt) <= Date.parse(at) ||
        (terms.durationMode !== 'allowPersistent' && terms.sessionId !== checked.sessionId) || checked.binding!.executionMode !== 'live' ||
        Date.parse(checked.binding!.deadlineAt) <= Date.parse(at)) throw new Error('dispatch binding is not current');
      const recorded = tx.get<Admission>('SELECT invocation_id AS invocationId,grant_id AS grantId,grant_revision AS grantRevision,input_digest AS inputDigest,status FROM dispatch_admissions WHERE invocation_id=?', checked.invocationId);
      if (recorded?.status !== 'admitted' || recorded.grantId !== admission.grantId || recorded.grantRevision !== admission.grantRevision ||
        recorded.inputDigest !== admission.inputDigest) throw new Error('dispatch admission unavailable');
      tx.run('INSERT INTO governed_dispatch_claims VALUES (?,?)', checked.invocationId, at);
      tx.run('INSERT INTO authority_events (grant_id,event,actor,occurred_at) VALUES (?,?,?,?)', checked.grantId, 'dispatch_claimed', checked.principalId, at);
      assertCurrent();
      return true;
    });
  }
  governedEvidence(input: GovernedAdmissionInput): { artifact: { reference:string; sha256:string; mediaType:string; schemaRef:string; byteLength:number }; bytes: Uint8Array } {
    if (!this.database) throw new Error('durable authority admission requires storage');
    const checked = identity(input), assertCurrent = input.assertCurrent;
    assertCurrent();
    const row = verifyEvidence(this.database.connection.prepare('SELECT * FROM governed_admission_evidence WHERE invocation_id=?').get(checked.invocationId) as EvidenceRow | undefined, checked);
    const bytes = new TextEncoder().encode(evidenceBytes(row));
    assertCurrent();
    return { artifact: { reference: `urn:lifestream:governed-admission:${encodeURIComponent(checked.invocationId)}`, sha256: row.sha256,
      mediaType: 'application/json', schemaRef: 'urn:lifestream:internal:governed-admission:1', byteLength: bytes.byteLength }, bytes };
  }

  get(invocationId: string): Admission | undefined { if (this.database) { const row = this.database.connection.prepare("SELECT invocation_id AS invocationId, grant_id AS grantId, grant_revision AS grantRevision, input_digest AS inputDigest, status FROM dispatch_admissions WHERE invocation_id = ?").get(invocationId) as Admission | undefined; return row && structuredClone(row); } const a = this.admissions.get(invocationId); return a && structuredClone(a); }
}
