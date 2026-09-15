import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.js';

export type StoredToolResponse = { status: number; body: Record<string, unknown> };
export type ToolRequestBinding = { idempotencyKey: string; principalId: string; assistantId: string; sessionId: string; requestDigest: string };
export type ToolRequestIdentity = ToolRequestBinding & {
  invocationId: string; interactionId: string; requestId: string; correlationId: string;
  fresh: boolean; ownerToken?: string; response?: StoredToolResponse;
};
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
