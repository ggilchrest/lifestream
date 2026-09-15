import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.js';

export type StoredToolResponse = { status: number; body: Record<string, unknown> };
export type ToolRequestBinding = { idempotencyKey: string; principalId: string; assistantId: string; sessionId: string; requestDigest: string };
export type ToolRequestIdentity = ToolRequestBinding & {
  invocationId: string; interactionId: string; requestId: string; correlationId: string;
  fresh: boolean; ownerToken?: string; response?: StoredToolResponse;
};
export type ToolStatusOwner = { invocationId: string; principalId: string; assistantId: string; sessionId: string };
export type ToolRecoveryBinding = {
  providerIdentity: string; capabilityId: string; capabilityVersion: string; providerRoute: string;
  executionMode: 'live' | 'replay' | 'simulation';
  scope: { assistantId: string; sessionId: string; endpointId: string; environment: string;
    authorityContextRef: { providerRef: string; contextId: string; revision: number } };
  outputSchema: { reference: string; sha256: string; mediaType: string; schemaRef: string; byteLength: number } | null;
};
export type ToolStatusRecord = ToolRequestIdentity & { recovery?: ToolRecoveryBinding;
  observation?: { sequence: number; response: StoredToolResponse; observedAt: string } };
const terminal = (value?: StoredToolResponse) => ['succeeded', 'failed', 'denied'].includes(String((value?.body.result as Record<string, unknown> | undefined)?.lifecycle));
type Row = { idempotency_key: string; principal_id: string; assistant_id: string; session_id: string; request_digest: string;
  invocation_id: string; interaction_id: string; request_id: string; correlation_id: string; owner_token: string;
  response_json: string | null; response_sha256: string | null };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const boundedString = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128;
export class ToolInvocationError extends Error {
  readonly code: 'invalid' | 'notFound' | 'conflict' | 'capacity' | 'corrupt';
  constructor(code: ToolInvocationError['code']) { super(`Tool invocation ${code}`); this.code = code; }
}
function binding(input: ToolRequestBinding): ToolRequestBinding {
  if (!input || ![input.idempotencyKey, input.principalId, input.assistantId, input.sessionId].every(boundedString) ||
    typeof input.requestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.requestDigest)) throw new ToolInvocationError('invalid');
  return { idempotencyKey: input.idempotencyKey, principalId: input.principalId, assistantId: input.assistantId, sessionId: input.sessionId, requestDigest: input.requestDigest };
}
function matches(row: Row, checked: ToolRequestBinding): void {
  if (row.principal_id !== checked.principalId) throw new ToolInvocationError('notFound');
  if (row.assistant_id !== checked.assistantId || row.session_id !== checked.sessionId || row.request_digest !== checked.requestDigest) throw new ToolInvocationError('conflict');
}
function response(text: string): StoredToolResponse {
  if (Buffer.byteLength(text) > 131_072) throw new ToolInvocationError('invalid');
  const value = JSON.parse(text) as StoredToolResponse;
  if (!value || !Number.isInteger(value.status) || value.status < 100 || value.status > 599 || !value.body || typeof value.body !== 'object' || Array.isArray(value.body)) throw new ToolInvocationError('invalid');
  return value;
}
function project(row: Row): ToolRequestIdentity {
  const result: ToolRequestIdentity = { idempotencyKey: row.idempotency_key, principalId: row.principal_id, assistantId: row.assistant_id,
    sessionId: row.session_id, requestDigest: row.request_digest, invocationId: row.invocation_id, interactionId: row.interaction_id,
    requestId: row.request_id, correlationId: row.correlation_id, fresh: false };
  if ((row.response_json === null) !== (row.response_sha256 === null)) throw new ToolInvocationError('corrupt');
  if (row.response_json !== null) {
    if (hash(row.response_json) !== row.response_sha256) throw new ToolInvocationError('corrupt');
    try { result.response = response(row.response_json); } catch { throw new ToolInvocationError('corrupt'); }
  }
  return result;
}

/** An HTTP request owns one invocation before any asynchronous provider work.
 * Incomplete records never become permission to allocate a replacement effect. */
export class ToolInvocationRepository {
  private readonly database: Database;
  private readonly maximumRecords: number;
  constructor(database: Database, maximumRecords = 4096) {
    if (!Number.isInteger(maximumRecords) || maximumRecords < 1) throw new ToolInvocationError('invalid');
    this.database = database; this.maximumRecords = maximumRecords;
  }
  begin(input: ToolRequestBinding & { requestId: string; correlationId: string; now: string }, assertCurrent: () => void): ToolRequestIdentity {
    const checked = binding(input), requestId = input.requestId, correlationId = input.correlationId, now = input.now;
    if (![requestId, correlationId].every(boundedString) || typeof now !== 'string' || !now.endsWith('Z') || !Number.isFinite(Date.parse(now))) throw new ToolInvocationError('invalid');
    return this.database.transaction(tx => {
      assertCurrent();
      const existing = tx.get<Row>('SELECT * FROM tool_invocation_requests WHERE idempotency_key=?', checked.idempotencyKey);
      if (existing) { matches(existing, checked); const result = project(existing); assertCurrent(); return result; }
      if (tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM tool_invocation_requests')!.count >= this.maximumRecords) throw new ToolInvocationError('capacity');
      const invocationId = randomUUID(), interactionId = randomUUID(), ownerToken = randomUUID();
      tx.run('INSERT INTO tool_invocation_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)', checked.idempotencyKey, checked.principalId,
        checked.assistantId, checked.sessionId, checked.requestDigest, invocationId, interactionId, requestId, correlationId, ownerToken, now);
      assertCurrent();
      return { ...checked, invocationId, interactionId, requestId, correlationId, ownerToken, fresh: true };
    });
  }
  /** Lookup never creates a request and never exposes another owner's record. */
  lookup(owner: ToolStatusOwner, assertCurrent: () => void): ToolStatusRecord {
    owner = { invocationId: owner.invocationId, principalId: owner.principalId, assistantId: owner.assistantId, sessionId: owner.sessionId };
    if (![owner.invocationId, owner.principalId, owner.assistantId, owner.sessionId].every(boundedString)) throw new ToolInvocationError('invalid');
    return this.database.transaction(tx => {
      assertCurrent();
      const row = tx.get<Row>('SELECT * FROM tool_invocation_requests WHERE invocation_id=? AND principal_id=? AND assistant_id=? AND session_id=?',
        owner.invocationId, owner.principalId, owner.assistantId, owner.sessionId);
      if (!row) throw new ToolInvocationError('notFound');
      const result: ToolStatusRecord = project(row);
      const stored = tx.get<{ binding_json: string; sha256: string }>('SELECT * FROM tool_recovery_bindings WHERE invocation_id=?', owner.invocationId);
      if (stored) {
        if (hash(stored.binding_json) !== stored.sha256) throw new ToolInvocationError('corrupt');
        try { result.recovery = checkedRecovery(JSON.parse(stored.binding_json), row); } catch { throw new ToolInvocationError('corrupt'); }
      }
      const observation = tx.get<{ sequence: number; response_json: string; sha256: string; observed_at: string }>(
        'SELECT * FROM tool_recovery_observations WHERE invocation_id=? ORDER BY sequence DESC LIMIT 1', owner.invocationId);
      if (observation) {
        if (!stored || hash(observation.response_json) !== observation.sha256) throw new ToolInvocationError('corrupt');
        try { result.observation = { sequence: observation.sequence, response: response(observation.response_json), observedAt: observation.observed_at }; }
        catch { throw new ToolInvocationError('corrupt'); }
      }
      assertCurrent(); return result;
    });
  }
  /** Only the original request owner can bind the provider before invoking it. */
  bindRecovery(input: ToolRequestIdentity, recovery: ToolRecoveryBinding, assertCurrent: () => void): void {
    const checked = binding(input), ownerToken = input.ownerToken, invocationId = input.invocationId;
    if (!input.fresh || !boundedString(ownerToken)) throw new ToolInvocationError('conflict');
    const owned = structuredClone(recovery);
    this.database.transaction(tx => {
      assertCurrent();
      const row = tx.get<Row>('SELECT * FROM tool_invocation_requests WHERE idempotency_key=?', checked.idempotencyKey);
      if (!row) throw new ToolInvocationError('notFound');
      matches(row, checked);
      if (row.owner_token !== ownerToken || row.invocation_id !== invocationId) throw new ToolInvocationError('conflict');
      const json = JSON.stringify(checkedRecovery(owned, row));
      const prior = tx.get<{ binding_json: string; sha256: string }>('SELECT * FROM tool_recovery_bindings WHERE invocation_id=?', row.invocation_id);
      if (prior && (prior.sha256 !== hash(prior.binding_json) || prior.binding_json !== json)) throw new ToolInvocationError('conflict');
      if (!prior && row.response_json !== null) throw new ToolInvocationError('conflict');
      if (!prior) tx.run('INSERT INTO tool_recovery_bindings VALUES (?,?,?)', row.invocation_id, json, hash(json));
      assertCurrent();
    });
  }
  /** Append evidence separately; a late uncertain read cannot replace a terminal observation. */
  observe(owner: ToolStatusOwner, result: StoredToolResponse, observedAt: string, assertCurrent: () => void): StoredToolResponse {
    owner = { invocationId: owner.invocationId, principalId: owner.principalId, assistantId: owner.assistantId, sessionId: owner.sessionId };
    const json = JSON.stringify(result), checked = response(json);
    const lifecycle = (checked.body.result as Record<string, unknown> | undefined)?.lifecycle;
    if ((checked.body.result as Record<string, unknown> | undefined)?.invocationId !== owner.invocationId ||
      !['authorized','denied','approvalRequired','started','succeeded','failed','outcomeUnknown'].includes(String(lifecycle)) ||
      !observedAt.endsWith('Z') || !Number.isFinite(Date.parse(observedAt))) throw new ToolInvocationError('invalid');
    // lookup performs its own transaction, so capture and verify immutable ownership first.
    this.lookup(owner, assertCurrent);
    return this.database.transaction(tx => {
      assertCurrent();
      if (!tx.get('SELECT invocation_id FROM tool_recovery_bindings WHERE invocation_id=?', owner.invocationId)) throw new ToolInvocationError('conflict');
      const prior = tx.get<{ sequence: number; response_json: string; sha256: string }>(
        'SELECT * FROM tool_recovery_observations WHERE invocation_id=? ORDER BY sequence DESC LIMIT 1', owner.invocationId);
      if (prior) {
        if (hash(prior.response_json) !== prior.sha256) throw new ToolInvocationError('corrupt');
        const previous = response(prior.response_json);
        if (terminal(previous) || prior.response_json === json) { assertCurrent(); return previous; }
        // Reserve a final slot for confirmation after the bounded uncertain history.
        if (prior.sequence >= 64 && !terminal(checked)) throw new ToolInvocationError('capacity');
      }
      tx.run('INSERT INTO tool_recovery_observations VALUES (?,?,?,?,?)', owner.invocationId, (prior?.sequence ?? 0) + 1, json, hash(json), observedAt);
      assertCurrent(); return checked;
    });
  }
  complete(input: ToolRequestIdentity, result: StoredToolResponse): void {
    const checked = binding(input), ownerToken = input.ownerToken, invocationId = input.invocationId;
    if (!input.fresh || !boundedString(ownerToken)) throw new ToolInvocationError('conflict');
    const json = JSON.stringify(result); response(json);
    this.database.transaction(tx => {
      const row = tx.get<Row>('SELECT * FROM tool_invocation_requests WHERE idempotency_key=?', checked.idempotencyKey);
      if (!row) throw new ToolInvocationError('notFound');
      matches(row, checked);
      if (row.owner_token !== ownerToken || row.invocation_id !== invocationId) throw new ToolInvocationError('conflict');
      if (row.response_json !== null) {
        project(row);
        if (row.response_json !== json) throw new ToolInvocationError('conflict');
        return;
      }
      tx.run('UPDATE tool_invocation_requests SET response_json=?,response_sha256=? WHERE idempotency_key=?', json, hash(json), checked.idempotencyKey);
    });
  }
}

function checkedRecovery(value: ToolRecoveryBinding, row: Row): ToolRecoveryBinding {
  if (!value || Buffer.byteLength(JSON.stringify(value)) > 8192 ||
    ![value.providerIdentity, value.capabilityId, value.capabilityVersion, value.providerRoute,
      value.scope?.endpointId, value.scope?.environment, value.scope?.authorityContextRef?.providerRef,
      value.scope?.authorityContextRef?.contextId].every(boundedString) ||
    !['live','replay','simulation'].includes(value.executionMode) || value.scope.assistantId !== row.assistant_id ||
    value.scope.sessionId !== row.session_id || !Number.isInteger(value.scope.authorityContextRef.revision) || value.scope.authorityContextRef.revision < 1 ||
    value.outputSchema === undefined) throw new ToolInvocationError('invalid');
  return structuredClone(value);
}
