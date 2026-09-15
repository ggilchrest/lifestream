import { createHash, randomUUID } from 'node:crypto';
import { createContractValidator } from '@lifestream/contracts';
import type { GrantRequest, GrantLifecycleEvent, ArtifactRef, SourceRevision, humanAuthorityGrant_Root as CanonicalGrant } from '@lifestream/contracts/provider-messages';
import type { AuthorityDispatchRequest, humanAuthorityDecision_Root as DispatchDecision, CapabilityInvocationResult, CapabilityStatusRequest, CapabilityStatusResult } from '@lifestream/contracts/provider-messages';
import { isDeepStrictEqual } from 'node:util';
import type { Database, Transaction } from '../database.js';
export type { CanonicalGrant, GrantRequest, GrantLifecycleEvent };
const providerSchema = 'https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/';
const grantSchema = 'https://lifestream.dev/contracts/human-authority-grant/1.0.0';
const common = 'https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/';
const validator = createContractValidator();
export type AuthorityCommand = { requestId: string; correlationId: string; idempotencyKey: string; intent?: unknown };
export type GrantOwnerBinding = { assistantId: string; endpointId: string; environmentId: string; sessionId: string | null };
/** Supplied only by the authenticated host, never deserialized from an API body. */
export type CanonicalHumanContext = {
  principalId: string; providerRef: string; authenticationEvidenceRef: string;
  now(): string; assertCurrent(binding: GrantOwnerBinding): void;
  assertAssistant?(assistantId: string): void;
  authenticationEvidence?: { data: string; schemaRef: string };
};
/** The capability adapter supplies validated scope/digest and deterministic display text. */
export type TrustedGrantProposal = {
  request: Omit<GrantRequest, 'schemaVersion' | 'requestId' | 'revision' | 'principalId' | 'authorityProviderRef' | 'confirmationDigest' | 'state' | 'grantId' | 'createdAt'>;
  scopeDerivation: 'validatedArguments' | 'inputBoundOnly';
};
export type AuthorityMutation = { request: GrantRequest | null; grant: CanonicalGrant | null; events: GrantLifecycleEvent[]; auditRef?: ArtifactRef; sourceRevision?: SourceRevision; admittedInvocationIds?: string[] };
export class CanonicalGrantError extends Error {
  readonly code: 'invalid' | 'notFound' | 'conflict' | 'expired' | 'unavailable' | 'capacity' | 'scopeDerivationRequired';
  constructor(code: CanonicalGrantError['code']) { super(`Canonical authority ${code}`); this.code = code; }
}
const fail = (code: CanonicalGrantError['code']): never => { throw new CanonicalGrantError(code); };
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function check<T>(schema: string, value: T): T {
  if (!validator.validate(schema, value).valid || Buffer.byteLength(JSON.stringify(value)) > 131072) fail('invalid');
  return structuredClone(value);
}
function clock(context: CanonicalHumanContext): string { return check(common + 'Time', context.now()); }
function confirmation(request: GrantRequest): string {
  const fields = ['requestId','revision','principalId','assistantId','endpointId','environmentId','authorityProviderRef','scope','inputDigest','invocationId','sessionId','requestedClass','grantExpiresAt','reviewAfter','expiresAt'] as const;
  return hash(canonical(Object.fromEntries(fields.map(key => [key, request[key]]))));
}
function dates(request: GrantRequest, now: string): void {
  if (Date.parse(request.createdAt) > Date.parse(now)) fail('unavailable');
  if (Date.parse(request.expiresAt) <= Date.parse(now) || Date.parse(request.grantExpiresAt) <= Date.parse(now) ||
    (request.reviewAfter !== null && (Date.parse(request.reviewAfter) <= Date.parse(now) || Date.parse(request.reviewAfter) > Date.parse(request.grantExpiresAt)))) fail('expired');
}
type Row = { payload_json: string; sha256: string };
function stored<T>(row: Row | undefined, schema: string): T {
  if (!row) return fail('notFound');
  if (hash(row.payload_json) !== row.sha256) fail('unavailable');
  try { return check(schema, JSON.parse(row.payload_json)) as T; } catch { return fail('unavailable'); }
}

export type CanonicalAdmission = {
  request: AuthorityDispatchRequest; principalId: string; providerEvidenceBase64: string;
  decision: DispatchDecision; receipt: ArtifactRef; auditRef: ArtifactRef;
};
export type CanonicalDispatchObservation = { sequence: number; observedAt: string; request: CapabilityStatusRequest; result: CapabilityStatusResult; evidenceBase64: string | null };
export type CanonicalDispatchView = { admission: CanonicalAdmission; initialCallClaimed: boolean; result: CapabilityInvocationResult | null; observations: CanonicalDispatchObservation[] };
export function canonicalDispatchTerminal(result: CapabilityInvocationResult | CapabilityStatusResult | null): boolean {
  return result?.outcome.status === 'succeeded' && ['succeeded','failed'].includes(result.outcome.payload.type);
}

/** Canonical request approval and immutable grant lifecycle. Legacy coarse grants
 * remain separate historical records; none acquire missing scope by migration. */
export class CanonicalGrantRepository {
  private readonly database: Database;
  private readonly providerRef: string;
  constructor(database: Database, providerRef: string) {
    if (!providerRef || providerRef.length > 500) fail('invalid'); this.database = database; this.providerRef = providerRef;
  }
  private guard(context: CanonicalHumanContext, value: GrantOwnerBinding & { principalId: string; authorityProviderRef: string }): void {
    check(common + 'UUID', context.principalId); clock(context);
    if (context.providerRef !== this.providerRef || value.authorityProviderRef !== this.providerRef || value.principalId !== context.principalId) fail('notFound');
    context.assertCurrent({ assistantId: value.assistantId, endpointId: value.endpointId, environmentId: value.environmentId, sessionId: value.sessionId });
    if (context.providerRef !== this.providerRef || value.principalId !== context.principalId) fail('notFound');
  }
  private request(tx: Transaction, id: string, context: CanonicalHumanContext): GrantRequest {
    check(common + 'UUID', id);
    const request = stored<GrantRequest>(tx.get<Row>('SELECT * FROM canonical_grant_requests WHERE request_id=? AND principal_id=?', id, context.principalId), providerSchema + 'GrantRequest');
    if (request.requestId !== id) fail('unavailable');
    this.guard(context, request); return request;
  }
  private grant(tx: Transaction, id: string, context: CanonicalHumanContext): CanonicalGrant {
    check(common + 'UUID', id);
    const grant = stored<CanonicalGrant>(tx.get<Row>('SELECT * FROM canonical_grants WHERE grant_id=? AND principal_id=?', id, context.principalId), grantSchema);
    if (grant.grantId !== id) fail('unavailable');
    this.guard(context, grant); return grant;
  }
  private saveRequest(tx: Transaction, request: GrantRequest): void {
    check(providerSchema + 'GrantRequest', request); const json = JSON.stringify(request);
    tx.run('INSERT INTO canonical_grant_requests VALUES (?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET payload_json=excluded.payload_json,sha256=excluded.sha256', request.requestId, request.principalId, request.assistantId, json, hash(json));
    tx.run('INSERT INTO canonical_grant_request_history VALUES (?,?,?,?)', request.requestId, request.revision, json, hash(json));
  }
  private saveGrant(tx: Transaction, grant: CanonicalGrant, event: GrantLifecycleEvent): void {
    check(grantSchema, grant); check(providerSchema + 'GrantLifecycleEvent', event);
    const json = JSON.stringify(grant), eventJson = JSON.stringify(event);
    tx.run('INSERT INTO canonical_grants VALUES (?,?,?,?,?) ON CONFLICT(grant_id) DO UPDATE SET payload_json=excluded.payload_json,sha256=excluded.sha256', grant.grantId, grant.principalId, grant.assistantId, json, hash(json));
    tx.run('INSERT INTO canonical_grant_events VALUES (?,?,?,?)', event.eventId, grant.grantId, eventJson, hash(eventJson));
  }
  private event(grant: CanonicalGrant, type: GrantLifecycleEvent['type'], command: AuthorityCommand, context: CanonicalHumanContext, now: string): GrantLifecycleEvent {
    return { schemaVersion: '1.0.0', eventId: randomUUID(), grantId: grant.grantId, oldRevision: grant.revision - 1, newRevision: grant.revision,
      type, occurredAt: now, actorRef: context.principalId, reasonCode: `authority_grant_${type}`, correlationId: command.correlationId,
      invocationId: null, decisionId: null, approvalRequestId: type === 'issued' ? grant.grantRequestId : null,
      authenticationEvidenceRef: type === 'issued' ? grant.authenticationEvidenceRef : null };
  }
  private mutate(operation: string, input: unknown, command: AuthorityCommand, context: CanonicalHumanContext,
    apply: (tx: Transaction) => AuthorityMutation, finalCheck?: (result: AuthorityMutation) => void): AuthorityMutation {
    command = structuredClone(command);
    for (const value of [command.requestId, command.correlationId, command.idempotencyKey, context.principalId]) check(common + 'UUID', value);
    const inputDigest = hash(canonical(command.intent ?? input)), principalId = context.principalId;
    return this.database.transaction(tx => {
      clock(context);
      if (context.providerRef !== this.providerRef || context.principalId !== principalId) fail('notFound');
      const previous = tx.get<{ principal_id: string; operation: string; input_digest: string; response_json: string; sha256: string }>('SELECT * FROM canonical_authority_commands WHERE idempotency_key=?', command.idempotencyKey);
      if (previous) {
        if (previous.principal_id !== principalId) fail('notFound');
        if (previous.operation !== operation || previous.input_digest !== inputDigest) fail('conflict');
        if (hash(previous.response_json) !== previous.sha256) fail('unavailable');
        const result = JSON.parse(previous.response_json) as AuthorityMutation;
        if (result.request) this.guard(context, check(providerSchema + 'GrantRequest', result.request));
        if (result.grant) this.guard(context, check(grantSchema, result.grant));
        if (!Array.isArray(result.events)) fail('unavailable');
        for (const event of result.events) {
          check(providerSchema + 'GrantLifecycleEvent', event);
          if (!result.grant || event.grantId !== result.grant.grantId || event.newRevision > result.grant.revision) fail('unavailable');
        }
        return structuredClone(result);
      }
      if (tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM canonical_authority_commands')!.count >= 16384) fail('capacity');
      const result = apply(tx);
      if (result.request) this.guard(context, result.request);
      if (result.grant) this.guard(context, result.grant);
      finalCheck?.(result);
      const subject = result.request ?? result.grant;
      if (!subject) fail('unavailable');
      const schema = result.request ? providerSchema + 'GrantRequest' : grantSchema;
      const recordRef = this.saveArtifact(tx, `urn:lifestream:authority-record:${command.idempotencyKey}`, subject!, schema, JSON.stringify(subject));
      const intent = command.intent as { payload?: { reason?: { code: string; summary: string } } } | undefined;
      const reason = check(common + 'Reason', intent?.payload?.reason ?? { code: `authority_${operation}`, summary: `Recorded authority operation ${operation}` });
      const audit = { schemaVersion: '1.0.0', operation, requestId: command.requestId, correlationId: command.correlationId,
        principalId, assistantId: subject!.assistantId, commandDigest: inputDigest, occurredAt: clock(context),
        grantRequestId: result.request?.requestId ?? result.grant?.grantRequestId ?? null, grantId: result.grant?.grantId ?? null,
        revision: subject!.revision, disposition: result.request?.state ?? result.grant!.status, reason, recordRef,
        lifecycleEventIds: result.events.map(event => event.eventId) };
      result.auditRef = this.saveArtifact(tx, `urn:lifestream:authority-audit:${command.idempotencyKey}`, subject!, 'urn:lifestream:local-authority-audit:1', JSON.stringify(audit));
      result.sourceRevision = this.revision(tx, subject!.principalId, subject!.assistantId);
      result.admittedInvocationIds = result.grant ? this.admittedIds(tx, result.grant.grantId) : [];
      this.guard(context, subject!); finalCheck?.(result);
      const json = JSON.stringify(result); if (Buffer.byteLength(json) > 524288) fail('capacity');
      tx.run('INSERT INTO canonical_authority_commands VALUES (?,?,?,?,?,?)', command.idempotencyKey, principalId, operation, inputDigest, json, hash(json));
      return structuredClone(result);
    });
  }
  private revision(tx: Transaction, principalId: string, assistantId: string): SourceRevision {
    const requests = tx.all<{ request_id: string; sha256: string }>('SELECT request_id,sha256 FROM canonical_grant_requests WHERE principal_id=? AND assistant_id=? ORDER BY request_id', principalId, assistantId);
    const grants = tx.all<{ grant_id: string; sha256: string }>('SELECT grant_id,sha256 FROM canonical_grants WHERE principal_id=? AND assistant_id=? ORDER BY grant_id', principalId, assistantId);
    const admissions = tx.all<{ invocation_id: string; sha256: string }>('SELECT invocation_id,sha256 FROM canonical_dispatch_admissions WHERE principal_id=? AND assistant_id=? ORDER BY invocation_id', principalId, assistantId);
    return { providerRef: this.providerRef, revision: hash(JSON.stringify({ requests, grants, admissions })), highWaterMark: null };
  }
  sourceRevision(assistantId: string, context: CanonicalHumanContext): SourceRevision {
    check(common + 'UUID', assistantId); clock(context);
    if (context.providerRef !== this.providerRef || !context.assertAssistant) fail('unavailable');
    context.assertAssistant!(assistantId);
    return this.database.transaction(tx => { const result = this.revision(tx, context.principalId, assistantId); context.assertAssistant!(assistantId); return result; });
  }
  private saveArtifact(tx: Transaction, reference: string, binding: GrantOwnerBinding & { principalId: string; authorityProviderRef: string }, schemaRef: string, bytes: string): ArtifactRef {
    if (Buffer.byteLength(bytes) > 131072 || !schemaRef || schemaRef.length > 500) fail('capacity');
    const owner = { principalId: binding.principalId, assistantId: binding.assistantId, endpointId: binding.endpointId, environmentId: binding.environmentId, sessionId: binding.sessionId, authorityProviderRef: binding.authorityProviderRef };
    const artifact: ArtifactRef = { reference, sha256: hash(bytes), mediaType: 'application/json', schemaRef, byteLength: Buffer.byteLength(bytes) };
    check(common + 'ArtifactRef', artifact);
    tx.run('INSERT INTO canonical_authority_artifacts VALUES (?,?,?,?,?,?,?)', reference, binding.principalId, binding.assistantId, JSON.stringify(owner), schemaRef, bytes, artifact.sha256);
    return artifact;
  }
  private readArtifact(tx: Transaction, reference: string, context: CanonicalHumanContext): { artifact: ArtifactRef; bytes: Uint8Array } {
      const row = tx.get<{ binding_json: string; schema_ref: string; payload_json: string; sha256: string }>('SELECT * FROM canonical_authority_artifacts WHERE reference=? AND principal_id=?', reference, context.principalId);
      if (!row) return fail('notFound');
      if (hash(row.payload_json) !== row.sha256) fail('unavailable');
      this.guard(context, JSON.parse(row.binding_json));
      return { artifact: { reference, sha256: row.sha256, mediaType: 'application/json', schemaRef: row.schema_ref, byteLength: Buffer.byteLength(row.payload_json) }, bytes: new Uint8Array(Buffer.from(row.payload_json)) };
  }
  artifact(reference: string, context: CanonicalHumanContext): { artifact: ArtifactRef; bytes: Uint8Array } {
    return this.database.transaction(tx => this.readArtifact(tx, reference, context));
  }
  /** Identical transport intent can replay without consulting a changed capability catalog. */
  replay(operation: string, intent: unknown, command: AuthorityCommand, context: CanonicalHumanContext): AuthorityMutation | undefined {
    check(common + 'UUID', command.idempotencyKey); clock(context);
    const row = this.database.connection.prepare('SELECT 1 FROM canonical_authority_commands WHERE idempotency_key=?').get(command.idempotencyKey);
    if (!row) return undefined;
    return this.mutate(operation, intent, { ...command, intent }, context, () => fail('unavailable'));
  }
  list(kind: 'requests' | 'grants', assistantId: string, states: string[], page: { limit: number; cursor: string | null }, context: CanonicalHumanContext): { records: Array<GrantRequest | CanonicalGrant>; sourceRevision: SourceRevision; nextCursor: string | null } {
    check(common + 'UUID', assistantId); check(common + 'Page', page); clock(context);
    const allowed = kind === 'requests' ? ['pending','approved','denied','cancelled','expired'] : ['active','consumed','revoked','expired'];
    if (!Array.isArray(states) || states.length > allowed.length || states.some(state => !allowed.includes(state)) || !context.assertAssistant || context.providerRef !== this.providerRef) fail('invalid');
    states = [...new Set(states)].sort(); page = structuredClone(page); const principal = context.principalId;
    context.assertAssistant!(assistantId);
    return this.database.transaction(tx => {
      const sourceRevision = this.revision(tx, principal, assistantId);
      const query = hash(canonical({ principal, assistantId, kind, states, limit: page.limit })); let after = '';
      if (page.cursor !== null) {
        try { const cursor = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8'));
          if (Object.keys(cursor).sort().join(',') !== 'after,query,revision' || cursor.query !== query || cursor.revision !== sourceRevision.revision || !validator.validate(common + 'UUID', cursor.after).valid) fail('conflict');
          after = cursor.after;
        } catch { fail('conflict'); }
      }
      const table = kind === 'requests' ? 'canonical_grant_requests' : 'canonical_grants', id = kind === 'requests' ? 'request_id' : 'grant_id', state = kind === 'requests' ? 'state' : 'status';
      const filter = states.length ? ` AND json_extract(payload_json,'$.${state}') IN (${states.map(() => '?').join(',')})` : '';
      const rows = tx.all<Row & { record_id: string }>(`SELECT ${id} AS record_id,payload_json,sha256 FROM ${table} WHERE principal_id=? AND assistant_id=? AND ${id}>?${filter} ORDER BY ${id} LIMIT ?`, principal, assistantId, after, ...states, page.limit + 1);
      const selected = rows.slice(0, page.limit);
      const records = selected.map(row => {
        const record = stored<GrantRequest | CanonicalGrant>(row, kind === 'requests' ? providerSchema + 'GrantRequest' : grantSchema);
        if (('requestId' in record ? record.requestId : record.grantId) !== row.record_id || record.assistantId !== assistantId) fail('unavailable');
        this.guard(context, record); return record;
      });
      context.assertAssistant!(assistantId); if (context.principalId !== principal) fail('notFound');
      return { records, sourceRevision, nextCursor: rows.length > page.limit ? Buffer.from(JSON.stringify({ after: selected.at(-1)!.record_id, query, revision: sourceRevision.revision })).toString('base64url') : null };
    });
  }
  createRequest(proposal: TrustedGrantProposal, command: AuthorityCommand, context: CanonicalHumanContext): AuthorityMutation {
    proposal = structuredClone(proposal); command = structuredClone(command);
    if (!['validatedArguments','inputBoundOnly'].includes(proposal.scopeDerivation)) fail('invalid');
    if (proposal.scopeDerivation === 'inputBoundOnly' && proposal.request.requestedClass !== 'allowOnce') fail('scopeDerivationRequired');
    return this.mutate('createRequest', proposal, command, context, tx => {
      if (tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM canonical_grant_requests')!.count >= 4096) fail('capacity');
      const request: GrantRequest = { ...proposal.request, schemaVersion: '1.0.0', requestId: randomUUID(), revision: 1,
        principalId: context.principalId, authorityProviderRef: this.providerRef, confirmationDigest: '0'.repeat(64), state: 'pending', grantId: null, createdAt: clock(context) };
      check(providerSchema + 'GrantRequest', request); this.guard(context, request); dates(request, clock(context)); request.confirmationDigest = confirmation(request);
      this.saveRequest(tx, request); return { request, grant: null, events: [] };
    }, result => dates(result.request!, clock(context)));
  }
  approveRequest(input: { requestId: string; expectedRevision: number; confirmationDigest: string; grantClass: CanonicalGrant['grantClass']; expiresAt: string; reviewAfter: string | null }, command: AuthorityCommand, context: CanonicalHumanContext): AuthorityMutation {
    input = structuredClone(input); command = structuredClone(command);
    return this.mutate('approveRequest', input, command, context, tx => {
      const request = this.request(tx, input.requestId, context), now = clock(context);
      if (request.state !== 'pending' || request.revision !== input.expectedRevision || request.confirmationDigest !== confirmation(request) || request.confirmationDigest !== input.confirmationDigest ||
        request.requestedClass !== input.grantClass || request.grantExpiresAt !== input.expiresAt || request.reviewAfter !== input.reviewAfter) fail('conflict');
      dates(request, now); check(grantSchema + '#/$defs/scopeRef', context.authenticationEvidenceRef);
      const grant: CanonicalGrant = { schemaVersion: '1.0.0', grantId: randomUUID(), revision: 1, status: 'active', grantClass: request.requestedClass,
        principalId: context.principalId, assistantId: request.assistantId, endpointId: request.endpointId, environmentId: request.environmentId,
        authorityProviderRef: this.providerRef, scope: request.scope, sessionId: request.requestedClass === 'allowPersistent' ? null : request.sessionId,
        invocationId: request.requestedClass === 'allowOnce' ? request.invocationId : null, inputDigest: request.requestedClass === 'allowOnce' ? request.inputDigest : null,
        issuedAt: now, expiresAt: request.grantExpiresAt, reviewAfter: request.reviewAfter, issuedBy: context.principalId,
        grantRequestId: request.requestId, authenticationEvidenceRef: context.authenticationEvidenceRef, consumedDecisionId: null };
      const event = this.event(grant, 'issued', command, context, now), decided: GrantRequest = { ...request, state: 'approved', revision: request.revision + 1, grantId: grant.grantId };
      if (context.authenticationEvidence) this.saveArtifact(tx, grant.authenticationEvidenceRef, grant, context.authenticationEvidence.schemaRef, context.authenticationEvidence.data);
      this.saveGrant(tx, grant, event); this.saveRequest(tx, decided); return { request: decided, grant, events: [event] };
    }, result => dates(result.request!, clock(context)));
  }
  decideRequest(input: { requestId: string; expectedRevision: number; decision: 'denied' | 'cancelled'; confirmationDigest?: string; reason?: { code: string; summary: string } }, command: AuthorityCommand, context: CanonicalHumanContext): AuthorityMutation {
    input = structuredClone(input); command = structuredClone(command);
    if (!['denied','cancelled'].includes(input.decision)) fail('invalid');
    return this.mutate('decideRequest', input, command, context, tx => {
      const request = this.request(tx, input.requestId, context);
      if (request.state !== 'pending' || request.revision !== input.expectedRevision || (input.confirmationDigest !== undefined && (input.confirmationDigest !== request.confirmationDigest || request.confirmationDigest !== confirmation(request)))) fail('conflict');
      if (Date.parse(request.expiresAt) <= Date.parse(clock(context))) fail('expired');
      const next = { ...request, state: input.decision, revision: request.revision + 1 }; this.saveRequest(tx, next); return { request: next, grant: null, events: [] };
    });
  }
  inspectRequest(id: string, context: CanonicalHumanContext): GrantRequest {
    return this.database.transaction(tx => this.request(tx, id, context));
  }
  inspectGrant(id: string, context: CanonicalHumanContext): CanonicalGrant {
    return this.database.transaction(tx => this.grant(tx, id, context));
  }
  getRequest(id: string, context: CanonicalHumanContext): GrantRequest {
    return this.database.transaction(tx => {
      let request = this.request(tx, id, context);
      if (request.state === 'pending' && Date.parse(request.expiresAt) <= Date.parse(clock(context))) {
        request = { ...request, state: 'expired', revision: request.revision + 1 }; this.saveRequest(tx, request);
      }
      if (request.requestId !== id) fail('unavailable');
    this.guard(context, request); return request;
    });
  }
  private currentGrant(tx: Transaction, id: string, context: CanonicalHumanContext): CanonicalGrant {
    let grant = this.grant(tx, id, context);
    if (grant.status === 'active' && Date.parse(grant.expiresAt) <= Date.parse(clock(context))) {
      grant = { ...grant, status: 'expired', revision: grant.revision + 1 };
      this.saveGrant(tx, grant, this.event(grant, 'expired', { requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID() }, context, clock(context)));
    }
    return grant;
  }
  getGrant(id: string, context: CanonicalHumanContext): CanonicalGrant {
    return this.database.transaction(tx => { const grant = this.currentGrant(tx, id, context); this.guard(context, grant); return grant; });
  }
  revokeGrant(input: { grantId: string; expectedRevision: number; reason?: { code: string; summary: string } }, command: AuthorityCommand, context: CanonicalHumanContext): AuthorityMutation {
    input = structuredClone(input); command = structuredClone(command);
    return this.mutate('revokeGrant', input, command, context, tx => {
      const grant = this.currentGrant(tx, input.grantId, context);
      if (grant.status !== 'active') return { request: null, grant, events: [] };
      if (grant.revision !== input.expectedRevision) fail('conflict');
      const next: CanonicalGrant = { ...grant, status: 'revoked', revision: grant.revision + 1 }, event = this.event(next, 'revoked', command, context, clock(context));
      this.saveGrant(tx, next, event); return { request: null, grant: next, events: [event] };
    });
  }
  events(id: string, context: CanonicalHumanContext): GrantLifecycleEvent[] {
    return this.database.transaction(tx => { const grant = this.grant(tx, id, context);
      const events = tx.all<Row>('SELECT * FROM canonical_grant_events WHERE grant_id=? ORDER BY rowid', id).map(row => stored<GrantLifecycleEvent>(row, providerSchema + 'GrantLifecycleEvent'));
      for (const [index, event] of events.entries()) {
        if (event.grantId !== id || event.oldRevision !== index || event.newRevision !== index + 1 ||
          (index === 0 ? event.type !== 'issued' : event.type === 'issued')) fail('unavailable');
      }
      const last = events.at(-1);
      if (!last || last.newRevision !== grant.revision || (last.type === 'issued' ? grant.status !== 'active' : last.type !== grant.status)) fail('unavailable');
      this.guard(context, grant); return events; });
  }
  private admittedIds(tx: Transaction, grantId: string): string[] {
    return tx.all<{ invocation_id: string }>('SELECT invocation_id FROM canonical_dispatch_admissions WHERE grant_id=? ORDER BY invocation_id', grantId).map(row => row.invocation_id);
  }
  admittedInvocationIds(grantId: string, context: CanonicalHumanContext): string[] {
    return this.database.transaction(tx => { this.grant(tx, grantId, context); return this.admittedIds(tx, grantId); });
  }
  private readAdmission(tx: Transaction, invocationId: string, context: CanonicalHumanContext): CanonicalAdmission | undefined {
    check(common + 'UUID', invocationId);
    const row = tx.get<Row>('SELECT payload_json,sha256 FROM canonical_dispatch_admissions WHERE invocation_id=? AND principal_id=?', invocationId, context.principalId);
    if (!row) return undefined;
    if (hash(row.payload_json) !== row.sha256 || Buffer.byteLength(row.payload_json) > 524288) fail('unavailable');
    const value = JSON.parse(row.payload_json) as CanonicalAdmission;
    check(providerSchema + 'AuthorityDispatchRequest', value.request); check('https://lifestream.dev/contracts/human-authority-decision/2.0.0', value.decision);
    if (value.principalId !== context.principalId || value.request.payload.invocationId !== invocationId || value.decision.invocationId !== invocationId) fail('unavailable');
    this.guard(context, { ...value.request.scope, endpointId: value.request.scope.endpointId!, sessionId: value.request.scope.sessionId!, principalId: value.principalId, authorityProviderRef: this.providerRef });
    const receipt = this.readArtifact(tx, value.receipt.reference, context), audit = this.readArtifact(tx, value.auditRef.reference, context);
    if (!isDeepStrictEqual(receipt.artifact, value.receipt) || !isDeepStrictEqual(JSON.parse(Buffer.from(receipt.bytes).toString()), value.decision) || !isDeepStrictEqual(audit.artifact, value.auditRef)) fail('unavailable');
    this.disposition(value.request, Buffer.from(value.providerEvidenceBase64, 'base64'));
    return value;
  }
  dispatchView(invocationId: string, context: CanonicalHumanContext): CanonicalDispatchView | undefined {
    return this.database.transaction(tx => {
      const admission = this.readAdmission(tx, invocationId, context); if (!admission) return undefined;
      const row = tx.get<Row>('SELECT payload_json,sha256 FROM canonical_dispatch_results WHERE invocation_id=?', invocationId);
      const result = row ? stored<CapabilityInvocationResult>(row, providerSchema + 'CapabilityInvocationResult') : null;
      if (result?.outcome.status === 'succeeded' && 'evidenceRef' in result.outcome.payload && result.outcome.payload.evidenceRef) {
        const bytes = tx.get<{ evidence_base64: string | null }>('SELECT evidence_base64 FROM canonical_dispatch_results WHERE invocation_id=?', invocationId)?.evidence_base64;
        const ref = result.outcome.payload.evidenceRef, evidence = bytes === null || bytes === undefined ? null : Buffer.from(bytes, 'base64');
        if (!evidence || evidence.byteLength !== ref.byteLength || createHash('sha256').update(evidence).digest('hex') !== ref.sha256) fail('unavailable');
      }
      return { admission, result, observations: this.readObservations(tx, admission), initialCallClaimed: !!tx.get('SELECT 1 FROM canonical_dispatch_claims WHERE invocation_id=?', invocationId) };
    });
  }
  private disposition(request: AuthorityDispatchRequest, evidence: Uint8Array, now?: string): void {
    const d = request.payload.requiredProviderDisposition, ref = d.evidenceRef;
    if (evidence.byteLength > 131072 || ref.byteLength !== evidence.byteLength || createHash('sha256').update(evidence).digest('hex') !== ref.sha256 ||
      d.invocationId !== request.payload.invocationId || d.inputDigest !== request.payload.inputDigest || d.scopeDigest !== hash(canonical(request.payload.scope)) ||
      !isDeepStrictEqual(d.authorityContextRef, request.scope.authorityContextRef) || d.disposition !== 'authorized' || Date.parse(d.expiresAt) <= Date.parse(d.evaluatedAt) ||
      (now !== undefined && (Date.parse(d.evaluatedAt) > Date.parse(now) || Date.parse(d.expiresAt) <= Date.parse(now)))) fail('unavailable');
  }
  /** Serializes with revoke. The eligibility callback is trusted host logic and
   * receives a detached current grant; callers cannot provide a receipt or decision. */
  authorizeDispatch(request: AuthorityDispatchRequest, evidence: Uint8Array, context: CanonicalHumanContext,
    evaluate: (grant: CanonicalGrant) => { disposition: DispatchDecision['disposition']; reasonCode: DispatchDecision['reasonCode'] },
    assertAdmissionCurrent: () => void): { admission: CanonicalAdmission; replayed: boolean } {
    request = check(providerSchema + 'AuthorityDispatchRequest', request); evidence = Uint8Array.from(evidence);
    return this.database.transaction(tx => {
      const prior = this.readAdmission(tx, request.payload.invocationId, context);
      if (prior) {
        // Fresh transport IDs/catalog revisions are not permission to change original intent.
        if (prior.request.idempotencyKey !== request.idempotencyKey || prior.request.payload.grantId !== request.payload.grantId ||
          prior.request.payload.inputDigest !== request.payload.inputDigest || !isDeepStrictEqual(prior.request.payload.scope, request.payload.scope)) fail('conflict');
        return { admission: prior, replayed: true };
      }
      if (tx.get('SELECT 1 FROM canonical_dispatch_admissions WHERE idempotency_key=?', request.idempotencyKey)) fail('conflict');
      if ((tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM canonical_dispatch_admissions')?.count ?? 0) >= 4096) fail('capacity');
      if (request.payload.grantId === null || request.executionMode !== 'normal') fail('invalid');
      const grant = this.grant(tx, request.payload.grantId!, context), now = clock(context);
      if (grant.revision !== request.payload.expectedGrantRevision || Date.parse(request.deadlineAt) <= Date.parse(now)) fail('conflict');
      this.disposition(request, evidence, now);
      const proof = this.readArtifact(tx, grant.authenticationEvidenceRef, context), authentication = JSON.parse(Buffer.from(proof.bytes).toString());
      if (proof.artifact.schemaRef !== 'urn:lifestream:local-authentication-proof:1' || authentication.providerRef !== 'local-password' ||
        authentication.principalId !== grant.principalId || authentication.assistantId !== grant.assistantId ||
        !validator.validate(common + 'UUID', authentication.sessionId).valid || !validator.validate(common + 'Time', authentication.authenticatedAt).valid ||
        !validator.validate(common + 'Time', authentication.verifiedAt).valid || Date.parse(authentication.authenticatedAt) > Date.parse(authentication.verifiedAt) ||
        Date.parse(authentication.verifiedAt) > Date.parse(grant.issuedAt) || (grant.sessionId !== null && authentication.sessionId !== grant.sessionId)) fail('unavailable');
      const eligible = evaluate(structuredClone(grant));
      if (eligible.disposition !== 'authorized' || eligible.reasonCode !== 'authority_authorized') fail('conflict');
      this.guard(context, grant); assertAdmissionCurrent();
      const decision: DispatchDecision = { schemaVersion: '2.0.0', decisionId: randomUUID(), kind: 'dispatch', ...eligible,
        correlationId: request.correlationId, invocationId: request.payload.invocationId, principalId: context.principalId, assistantId: request.scope.assistantId,
        endpointId: request.scope.endpointId!, environmentId: request.scope.environmentId, executionMode: request.executionMode, grantId: grant.grantId, grantRevision: grant.revision,
        snapshotId: request.payload.snapshotId, snapshotRevision: request.payload.snapshotRevision, authorityContextRef: request.scope.authorityContextRef!,
        inputDigest: request.payload.inputDigest, scopeDigest: hash(canonical(request.payload.scope)), evaluatedAt: now, admittedAt: now };
      check('https://lifestream.dev/contracts/human-authority-decision/2.0.0', decision);
      let event: GrantLifecycleEvent | null = null;
      if (grant.grantClass === 'allowOnce') {
        const consumed = { ...grant, revision: grant.revision + 1, status: 'consumed' as const, consumedDecisionId: decision.decisionId };
        event = { ...this.event(consumed, 'consumed', request, context, now), invocationId: request.payload.invocationId, decisionId: decision.decisionId };
        this.saveGrant(tx, consumed, event);
      }
      const receipt = this.saveArtifact(tx, `urn:lifestream:dispatch-receipt:${decision.decisionId}`, grant, 'https://lifestream.dev/contracts/human-authority-decision/2.0.0', JSON.stringify(decision));
      const auditRef = this.saveArtifact(tx, `urn:lifestream:dispatch-audit:${decision.decisionId}`, grant, 'urn:lifestream:dispatch-audit:1', JSON.stringify({ decisionId: decision.decisionId, receipt, providerDisposition: request.payload.requiredProviderDisposition, lifecycleEventId: event?.eventId ?? null, idempotencyKey: request.idempotencyKey }));
      const admission: CanonicalAdmission = { request, principalId: context.principalId, providerEvidenceBase64: Buffer.from(evidence).toString('base64'), decision, receipt, auditRef };
      const json = JSON.stringify(admission); if (Buffer.byteLength(json) > 524288) fail('capacity');
      tx.run('INSERT INTO canonical_dispatch_admissions VALUES (?,?,?,?,?,?,?)', request.payload.invocationId, context.principalId, request.scope.assistantId, grant.grantId, request.idempotencyKey, json, hash(json));
      this.guard(context, grant); return { admission: structuredClone(admission), replayed: false };
    });
  }
  /** At most one initial provider call. Reading or replaying a receipt cannot claim it again. */
  claimInitialDispatch(invocationId: string, receipt: ArtifactRef, context: CanonicalHumanContext, assertCurrent: () => void): boolean {
    return this.database.transaction(tx => {
      const admission = this.readAdmission(tx, invocationId, context); if (!admission || !isDeepStrictEqual(receipt, admission.receipt)) fail('notFound');
      if (tx.get('SELECT 1 FROM canonical_dispatch_claims WHERE invocation_id=?', invocationId)) return false;
      assertCurrent();
      tx.run('INSERT INTO canonical_dispatch_claims VALUES (?,?)', invocationId, clock(context)); return true;
    });
  }
  recordDispatchResult(invocationId: string, result: CapabilityInvocationResult, evidence: Uint8Array | null, context: CanonicalHumanContext): void {
    result = check(providerSchema + 'CapabilityInvocationResult', result);
    this.database.transaction(tx => {
      const admission = this.readAdmission(tx, invocationId, context);
      if (!admission || !tx.get('SELECT 1 FROM canonical_dispatch_claims WHERE invocation_id=?', invocationId)) return fail('notFound');
      if (result.providerRef !== admission.request.payload.requiredProviderDisposition.providerRef || result.requestId !== admission.request.requestId || result.correlationId !== admission.request.correlationId ||
        (result.outcome.status === 'succeeded' && result.outcome.payload.invocationId !== invocationId)) fail('conflict');
      const status = result.outcome.status === 'succeeded' ? result.outcome.payload : null;
      const evidenceRef = status && 'evidenceRef' in status ? status.evidenceRef : null;
      if (evidenceRef && (!evidence || evidence.byteLength > 131072 || evidenceRef.byteLength !== evidence.byteLength || createHash('sha256').update(evidence).digest('hex') !== evidenceRef.sha256)) fail('unavailable');
      if (status && 'receiptRef' in status && !isDeepStrictEqual(status.receiptRef, admission.receipt)) fail('conflict');
      const json = JSON.stringify(result), prior = tx.get<Row>('SELECT payload_json,sha256 FROM canonical_dispatch_results WHERE invocation_id=?', invocationId);
      if (prior) { if (prior.sha256 !== hash(json) || hash(prior.payload_json) !== prior.sha256) fail('conflict'); return; }
      tx.run('INSERT INTO canonical_dispatch_results VALUES (?,?,?,?)', invocationId, json, hash(json), evidence ? Buffer.from(evidence).toString('base64') : null);
    });
  }

  private observationBinding(admission: CanonicalAdmission, request: CapabilityStatusRequest, result: CapabilityStatusResult, evidence: Uint8Array | null): void {
    check(providerSchema + 'CapabilityStatusRequest', request); check(providerSchema + 'CapabilityStatusResult', result);
    if (request.payload.invocationId !== admission.request.payload.invocationId || request.idempotencyKey !== admission.request.idempotencyKey ||
      request.executionMode !== admission.request.executionMode || !isDeepStrictEqual(request.scope, admission.request.scope) ||
      result.providerRef !== admission.request.payload.requiredProviderDisposition.providerRef || result.requestId !== request.requestId || result.correlationId !== request.correlationId) fail('conflict');
    const status = result.outcome.status === 'succeeded' ? result.outcome.payload : null;
    if (status && status.invocationId !== request.payload.invocationId) fail('conflict');
    const ref = status && 'evidenceRef' in status ? status.evidenceRef : null;
    if (ref && (!evidence || evidence.byteLength > 131072 || evidence.byteLength !== ref.byteLength || createHash('sha256').update(evidence).digest('hex') !== ref.sha256)) fail('unavailable');
    if (status && 'receiptRef' in status && !isDeepStrictEqual(status.receiptRef, admission.receipt)) fail('conflict');
  }
  private readObservations(tx: Transaction, admission: CanonicalAdmission): CanonicalDispatchObservation[] {
    const rows = tx.all<Row>('SELECT payload_json,sha256 FROM canonical_dispatch_observations WHERE invocation_id=? ORDER BY sequence', admission.decision.invocationId);
    if (rows.length > 17) fail('unavailable');
    return rows.map((row, index) => {
      if (Buffer.byteLength(row.payload_json) > 524288 || hash(row.payload_json) !== row.sha256) fail('unavailable');
      const observation = JSON.parse(row.payload_json) as CanonicalDispatchObservation;
      if (observation.sequence !== index + 1 || !validator.validate(common + 'Time', observation.observedAt).valid ||
        !(observation.evidenceBase64 === null || typeof observation.evidenceBase64 === 'string')) fail('unavailable');
      this.observationBinding(admission, observation.request, observation.result, observation.evidenceBase64 === null ? null : Buffer.from(observation.evidenceBase64, 'base64'));
      return observation;
    });
  }
  /** A read-only provider observation cannot change the original admission,
   * claim, consumption or initial reply. The first confirmed terminal wins. */
  observeDispatch(request: CapabilityStatusRequest, result: CapabilityStatusResult, evidence: Uint8Array | null, context: CanonicalHumanContext, assertCurrent: () => void): boolean {
    request = check(providerSchema + 'CapabilityStatusRequest', request); result = check(providerSchema + 'CapabilityStatusResult', result); evidence = evidence && Uint8Array.from(evidence);
    return this.database.transaction(tx => {
      const admission = this.readAdmission(tx, request.payload.invocationId, context);
      if (!admission || !tx.get('SELECT 1 FROM canonical_dispatch_claims WHERE invocation_id=?', request.payload.invocationId)) return fail('notFound');
      this.observationBinding(admission, request, result, evidence); assertCurrent();
      const observations = this.readObservations(tx, admission), original = tx.get<Row>('SELECT payload_json,sha256 FROM canonical_dispatch_results WHERE invocation_id=?', request.payload.invocationId);
      if ((original && canonicalDispatchTerminal(stored<CapabilityInvocationResult>(original, providerSchema + 'CapabilityInvocationResult'))) || observations.some(value => canonicalDispatchTerminal(value.result))) return false;
      const prior = observations.find(value => value.request.requestId === request.requestId);
      if (prior) { if (!isDeepStrictEqual(prior.request, request) || !isDeepStrictEqual(prior.result, result)) fail('conflict'); return false; }
      // Reserve the seventeenth slot for eventual confirmation. Polls remain
      // bounded by their call deadline; an unrecordable reply is never released.
      if (observations.length >= (canonicalDispatchTerminal(result) ? 17 : 16)) fail('capacity');
      const observation: CanonicalDispatchObservation = { sequence: observations.length + 1, observedAt: clock(context), request, result, evidenceBase64: evidence ? Buffer.from(evidence).toString('base64') : null };
      const json = JSON.stringify(observation); if (Buffer.byteLength(json) > 524288) fail('capacity');
      tx.run('INSERT INTO canonical_dispatch_observations VALUES (?,?,?,?,?)', request.payload.invocationId, observation.sequence, request.requestId, json, hash(json)); assertCurrent(); return true;
    });
  }

}
