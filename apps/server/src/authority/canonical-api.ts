import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createContractValidator } from '@lifestream/contracts';
import type { CreateAuthorityRequestRequest, GrantRequest, SourceRevision } from '@lifestream/contracts/provider-messages';
import { CanonicalGrantRepository, CanonicalGrantError } from '@lifestream/storage-sqlite';
import type { Database, CanonicalHumanContext, CanonicalGrant, TrustedGrantProposal, AuthorityMutation, GrantOwnerBinding } from '@lifestream/storage-sqlite';
import { CapabilityCall } from '@lifestream/runtime/capabilities/call';
import type { CapabilityCallContext } from '@lifestream/runtime/capabilities/ports';
import { AuthenticationError, type LocalAuthentication, type LocalContext } from '../auth/local-auth.ts';
import { readSessionEndpoint } from '../runtime/session-context.ts';

type ProposalInput = CreateAuthorityRequestRequest['payload'];
/** Trusted composition input, never populated from HTTP JSON. The resolver must
 * retrieve and validate the original invocation's arguments and material scope. */
export type CanonicalAuthorityHost = {
  environmentId: string;
  assertCurrent(binding: GrantOwnerBinding, principalId: string): void;
  resolveProposal(payload: ProposalInput, principalId: string, call: CapabilityCallContext): Promise<TrustedGrantProposal>;
};
type Reply = { status: number; body: Record<string, unknown>; replayed?: boolean };
const api = 'https://lifestream.dev/contracts/runtime-api/1.0.0#/$defs/';
const common = 'https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/';
const validator = createContractValidator();
const valid = (schema: string, value: unknown) => validator.validate(schema, value).valid;
const unavailable = () => new AuthenticationError(503, 'authority_unavailable');
const routes = [
  ['GET', /^\/api\/authority\/v1\/requests$/, 'ListAuthorityRequests', 200],
  ['GET', /^\/api\/authority\/v1\/requests\/([^/]+)$/, 'GetAuthorityRequest', 200],
  ['POST', /^\/api\/authority\/v1\/requests$/, 'CreateAuthorityRequest', 201],
  ['POST', /^\/api\/authority\/v1\/requests\/([^/]+)\/approve$/, 'ApproveAuthorityRequest', 200],
  ['POST', /^\/api\/authority\/v1\/requests\/([^/]+)\/deny$/, 'DenyAuthorityRequest', 200],
  ['POST', /^\/api\/authority\/v1\/requests\/([^/]+)\/cancel$/, 'CancelAuthorityRequest', 200],
  ['GET', /^\/api\/authority\/v1\/grants$/, 'ListAuthorityGrants', 200],
  ['GET', /^\/api\/authority\/v1\/grants\/([^/]+)$/, 'GetAuthorityGrant', 200],
  ['POST', /^\/api\/authority\/v1\/grants\/([^/]+)\/revoke$/, 'RevokeAuthorityGrant', 200]
] as const;
/** The canonical wire decoder rejects duplicate keys and invalid UTF-8 before schema validation. */
export async function readCanonicalAuthorityBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
    if (size > 131072) { request.resume(); throw new AuthenticationError(413, 'authority_request_too_large'); }
    chunks.push(bytes);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), value: unknown = JSON.parse(text);
    const stack: Array<{ object: boolean; key: boolean; keys: Set<string> }> = []; let tokens = 0;
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
      if (++tokens > 8192) throw new Error('bounded JSON');
      const token = match[0], top = stack.at(-1);
      if (token === '{' || token === '[') { if (stack.length >= 32) throw new Error('bounded JSON'); stack.push({ object: token === '{', key: token === '{', keys: new Set() }); }
      else if (token === '}' || token === ']') stack.pop();
      else if (token === ',' && top?.object) top.key = true;
      else if (token.startsWith('"') && top?.object && top.key) { const key = JSON.parse(token) as string; if (top.keys.has(key)) throw new Error('duplicate JSON key'); top.keys.add(key); top.key = false; }
    }
    return value;
  } catch { throw new AuthenticationError(400, 'authority_invalid_json'); }
}
export function canonicalAuthorityFailure(error: unknown, headers: { requestId?: string | undefined; correlationId?: string | undefined }): Reply {
  const requestId = valid(common + 'UUID', headers.requestId) ? headers.requestId! : randomUUID();
  const correlationId = valid(common + 'UUID', headers.correlationId) ? headers.correlationId! : randomUUID();
  const status = error instanceof AuthenticationError ? error.status : 503;
  const code = error instanceof AuthenticationError ? error.code : 'authority_unavailable';
  return { status, body: { schemaVersion: '1.0.0', requestId, correlationId, status: 'failed', sourceRevision: null, result: null,
    error: { code, message: code.replaceAll('_', ' '), retryable: status === 503, correlationId, details: [] } } };
}
export class CanonicalAuthorityApi {
  private readonly database: Database;
  private readonly auth: LocalAuthentication;
  private readonly repository: CanonicalGrantRepository;
  private readonly host: CanonicalAuthorityHost | undefined;
  private readonly now: () => number;
  constructor(database: Database, auth: LocalAuthentication, host?: CanonicalAuthorityHost, now: () => number = Date.now) {
    if (host && !valid(common + 'UUID', host.environmentId)) throw new Error('Canonical authority requires a configured environment UUID');
    this.database = database; this.auth = auth; this.repository = new CanonicalGrantRepository(database, 'local-human');
    this.host = host && { environmentId: host.environmentId, assertCurrent: host.assertCurrent.bind(host), resolveProposal: host.resolveProposal.bind(host) }; this.now = now;
  }
  static matches(path: string): boolean { return /^\/api\/authority\/v1\/(?:requests|grants)(?:\/|$)/.test(path); }
  private context(local: LocalContext, call: CapabilityCall): CanonicalHumanContext {
    const assertAssistant = (assistantId: string) => { call.check(); this.auth.assertCurrent(local); if (!this.auth.canAdminister(local, assistantId)) throw new AuthenticationError(404, 'authority_not_found'); };
    return { principalId: local.principalId, providerRef: 'local-human', authenticationEvidenceRef: `urn:lifestream:authentication:${randomUUID()}`,
      now: () => new Date(this.now()).toISOString(), assertAssistant,
      assertCurrent: binding => {
        assertAssistant(binding.assistantId);
        if (binding.sessionId !== null && !this.database.connection.prepare('SELECT 1 FROM local_sessions WHERE session_id=? AND principal_id=?').get(binding.sessionId, local.principalId)) throw new AuthenticationError(404, 'authority_not_found');
      } };
  }
  private issuable(binding: GrantOwnerBinding, local: LocalContext): void {
    const endpoint = readSessionEndpoint(this.database, local.sessionId).endpoint;
    if (!this.host) throw unavailable();
    if (binding.environmentId !== this.host.environmentId || binding.sessionId !== local.sessionId || !endpoint || endpoint.endpointId !== binding.endpointId) throw new AuthenticationError(409, 'authority_scope_changed');
    this.host.assertCurrent(structuredClone(binding), local.principalId);
  }
  private grantView(grant: CanonicalGrant, local: LocalContext, context: CanonicalHumanContext) {
    let code = 'authority_authorized'; const now = this.now();
    if (!Number.isFinite(now)) code = 'authority_unavailable';
    else if (grant.status !== 'active') code = `authority_grant_${grant.status}`;
    else if (Date.parse(grant.issuedAt) > now) code = 'authority_unavailable';
    else if (Date.parse(grant.expiresAt) <= now) code = 'authority_grant_expired';
    else if (grant.reviewAfter !== null && Date.parse(grant.reviewAfter) <= now) code = 'authority_review_due';
    else if (grant.sessionId !== null && grant.sessionId !== local.sessionId) code = 'authority_session_inactive';
    else { try { this.issuable({ ...grant, sessionId: local.sessionId }, local); this.proof(grant, context); } catch { code = 'authority_scope_mismatch'; } }
    return { grant, eligible: code === 'authority_authorized', reason: { code, summary: code === 'authority_authorized' ? 'Current grant terms are eligible; execution still requires final authorization.' : code.replaceAll('_', ' ') } };
  }
  private proof(grant: CanonicalGrant, context: CanonicalHumanContext): void {
    const artifact = this.repository.artifact(grant.authenticationEvidenceRef, context);
    const proof = JSON.parse(new TextDecoder().decode(artifact.bytes));
    if (artifact.artifact.schemaRef !== 'urn:lifestream:local-authentication-proof:1' || proof.providerRef !== 'local-password' ||
      proof.principalId !== grant.principalId || proof.assistantId !== grant.assistantId || !valid(common + 'UUID', proof.sessionId) ||
      !valid(common + 'Time', proof.authenticatedAt) || !valid(common + 'Time', proof.verifiedAt) ||
      Date.parse(proof.authenticatedAt) > Date.parse(proof.verifiedAt) || Date.parse(proof.verifiedAt) > Date.parse(grant.issuedAt) ||
      (grant.sessionId !== null && proof.sessionId !== grant.sessionId)) throw unavailable();
  }
  async handle(method: string, rawUrl: string, local: LocalContext, rawBody: unknown, requestHeaders: { requestId?: string | undefined; correlationId?: string | undefined }, inputCall: CapabilityCallContext): Promise<Reply> {
    let requestId = randomUUID() as string, correlationId = randomUUID() as string, responseType: string | undefined;
    let call: CapabilityCall | undefined;
    try {
      const url = new URL(rawUrl, 'http://lifestream.invalid');
      const route = routes.find(([verb, pattern]) => verb === method && pattern.test(url.pathname));
      if (!route) throw new AuthenticationError(405, 'authority_method_not_allowed');
      const [, pattern, operation, status] = route, id = pattern.exec(url.pathname)?.[1]; responseType = operation + 'Response';
      let normalized: Record<string, any>;
      if (method === 'GET') {
        requestId = requestHeaders.requestId ?? requestId; correlationId = requestHeaders.correlationId ?? correlationId;
        const list = operation.startsWith('List'), allowed = list ? ['assistantId','states','limit','cursor'] : operation === 'GetAuthorityGrant' ? ['cursor'] : [];
        for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new AuthenticationError(422, 'authority_invalid_query');
        const payload = list ? { assistantId: url.searchParams.get('assistantId'), states: url.searchParams.has('states') ? url.searchParams.get('states')!.split(',') : [], page: { limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50, cursor: url.searchParams.get('cursor') } } : operation === 'GetAuthorityGrant' ? { grantId: id, cursor: url.searchParams.get('cursor') } : { requestId: id };
        normalized = { schemaVersion: '1.0.0', requestId, correlationId, idempotencyKey: null, payload };
      } else {
        if (url.searchParams.size) throw new AuthenticationError(422, 'authority_invalid_query');
        normalized = structuredClone(rawBody) as Record<string, any>;
        if (valid(common + 'UUID', normalized?.requestId)) requestId = normalized.requestId;
        if (valid(common + 'UUID', normalized?.correlationId)) correlationId = normalized.correlationId;
      }
      if (!valid(api + operation + 'Request', normalized)) throw new AuthenticationError(422, 'authority_invalid_request');
      if (id !== undefined && id !== (normalized.payload.grantId ?? normalized.payload.requestId)) throw new AuthenticationError(422, 'authority_path_mismatch');
      this.auth.assertCurrent(local); call = new CapabilityCall(inputCall); call.check();
      const context = this.context(local, call), payload = normalized.payload;
      let result: unknown, revision: SourceRevision, replayed = false;
      if (operation.startsWith('List')) {
        const kind = operation === 'ListAuthorityRequests' ? 'requests' : 'grants';
        const listing = this.repository.list(kind, payload.assistantId, payload.states, payload.page, context);
        revision = listing.sourceRevision;
        result = kind === 'requests' ? { requests: listing.records, sourceRevision: revision, nextCursor: listing.nextCursor } : { grants: (listing.records as CanonicalGrant[]).map(grant => this.grantView(grant, local, context)), sourceRevision: revision, nextCursor: listing.nextCursor };
      } else if (operation === 'GetAuthorityRequest') {
        result = this.repository.inspectRequest(payload.requestId, context); revision = this.repository.sourceRevision((result as GrantRequest).assistantId, context);
      } else if (operation === 'GetAuthorityGrant') {
        if (payload.cursor !== null) throw new AuthenticationError(409, 'authority_cursor_conflict');
        const grant = this.repository.inspectGrant(payload.grantId, context); revision = this.repository.sourceRevision(grant.assistantId, context);
        result = { ...this.grantView(grant, local, context), sourceRevision: revision, events: this.repository.events(grant.grantId, context), nextCursor: null, admittedInvocationIds: [] };
      } else {
        const internalOperation = operation === 'CreateAuthorityRequest' ? 'createRequest' : operation === 'ApproveAuthorityRequest' ? 'approveRequest' : operation === 'RevokeAuthorityGrant' ? 'revokeGrant' : 'decideRequest';
        const intent = { operation, payload }, command = { requestId, correlationId, idempotencyKey: normalized.idempotencyKey as string, intent };
        let mutation: AuthorityMutation | undefined;
        try { mutation = this.repository.replay(internalOperation, intent, command, context); }
        catch (error) { if (error instanceof CanonicalGrantError && error.code === 'conflict') throw new AuthenticationError(409, 'authority_idempotency_conflict'); throw error; }
        replayed = !!mutation;
        if (!mutation) {
          if (operation === 'CreateAuthorityRequest') {
            if (!this.host) throw unavailable(); context.assertAssistant!(payload.assistantId);
            const proposal = structuredClone(await call.wait(() => this.host!.resolveProposal(structuredClone(payload), local.principalId, call!.context)));
            for (const key of Object.keys(payload)) if (!isDeepStrictEqual(payload[key], proposal.request[key as keyof typeof proposal.request])) throw new AuthenticationError(409, 'authority_proposal_changed');
            this.issuable(proposal.request, local);
            const guard = context.assertCurrent; context.assertCurrent = binding => { guard(binding); this.issuable(binding, local); };
            mutation = this.repository.createRequest(proposal, command, context);
          } else if (operation === 'ApproveAuthorityRequest') {
            const pending = this.repository.inspectRequest(payload.requestId, context); this.issuable(pending, local);
            context.authenticationEvidence = { schemaRef: 'urn:lifestream:local-authentication-proof:1', data: JSON.stringify({ principalId: local.principalId, sessionId: local.sessionId, origin: local.origin, authenticatedAt: new Date(local.authenticatedAt).toISOString(), verifiedAt: context.now(), assistantId: pending.assistantId, providerRef: 'local-password' }) };
            const guard = context.assertCurrent; context.assertCurrent = binding => { guard(binding); this.issuable({ ...binding, sessionId: pending.sessionId }, local); };
            mutation = this.repository.approveRequest(payload, command, context);
          } else if (operation === 'RevokeAuthorityGrant') mutation = this.repository.revokeGrant(payload, command, context);
          else mutation = this.repository.decideRequest({ ...payload, decision: operation === 'DenyAuthorityRequest' ? 'denied' : 'cancelled' }, command, context);
        }
        if (!mutation.sourceRevision || !mutation.auditRef) throw unavailable();
        const audit = this.repository.artifact(mutation.auditRef.reference, context);
        if (!isDeepStrictEqual(audit.artifact, mutation.auditRef)) throw unavailable();
        const auditData = JSON.parse(new TextDecoder().decode(audit.bytes));
        if (!valid(common + 'ArtifactRef', auditData.recordRef)) throw unavailable();
        const snapshot = this.repository.artifact(auditData.recordRef.reference, context);
        if (!isDeepStrictEqual(snapshot.artifact, auditData.recordRef) || !isDeepStrictEqual(JSON.parse(new TextDecoder().decode(snapshot.bytes)), mutation.request ?? mutation.grant)) throw unavailable();
        if (operation === 'ApproveAuthorityRequest') this.proof(mutation.grant!, context);
        revision = mutation.sourceRevision;
        result = operation === 'CreateAuthorityRequest' ? mutation.request : { request: mutation.request, grant: mutation.grant, sourceRevision: revision, auditRef: mutation.auditRef, admittedInvocationIds: [] };
      }
      call.check(); this.auth.assertCurrent(local);
      const body = { schemaVersion: '1.0.0', requestId, correlationId, status: 'succeeded', sourceRevision: revision, result, error: null };
      if (!valid(api + responseType, body)) throw unavailable();
      return { status, body, ...(replayed ? { replayed: true } : {}) };
    } catch (error) {
      const status = error instanceof AuthenticationError ? error.status : error instanceof CanonicalGrantError ? ({ invalid: 422, notFound: 404, conflict: 409, expired: 409, unavailable: 503, capacity: 429, scopeDerivationRequired: 422 } as const)[error.code] : 503;
      const code = error instanceof AuthenticationError ? error.code : error instanceof CanonicalGrantError ? `authority_${error.code.replace(/[A-Z]/g, char => '_' + char.toLowerCase())}` : 'authority_unavailable';
      if (!valid(common + 'UUID', requestId)) requestId = randomUUID(); if (!valid(common + 'UUID', correlationId)) correlationId = randomUUID();
      return { status, body: { schemaVersion: '1.0.0', requestId, correlationId, status: 'failed', sourceRevision: null, result: null, error: { code, message: code.replaceAll('_', ' '), retryable: status === 503, correlationId, details: [] } } };
    } finally { call?.close(); }
  }
}
