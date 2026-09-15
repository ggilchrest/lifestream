import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createContractValidator } from '@lifestream/contracts';
import type { ArtifactRef, CapabilitySnapshotRequest, CapabilitySnapshotResult, CreateAuthorityRequestRequest, capabilitySnapshot_Root } from '@lifestream/contracts/provider-messages';
import type { Database, GrantOwnerBinding, TrustedGrantProposal } from '@lifestream/storage-sqlite';
import type { AuthorityRequest, CapabilityStatusRequest, providerMessages_DefsGovernedDisposition as GovernedDisposition } from '@lifestream/contracts/provider-messages';
import type { ProviderCallContext } from '@lifestream/runtime/ports/provider-messages';
import type { CapabilityProvider } from '@lifestream/runtime/ports/provider-messages';
import { CanonicalProviderBoundary } from '@lifestream/runtime/ports/provider-boundary';
import { CapabilityCall } from '@lifestream/runtime/capabilities/call';
import type { CapabilityCallContext } from '@lifestream/runtime/capabilities/ports';
import type { CapabilitySchemaStore } from '@lifestream/runtime/capabilities/schema-artifacts';
import { resolveCapabilitySchema } from '@lifestream/runtime/capabilities/schema-artifacts';
import { boundedJson, canonicalJson, validateCapabilitySchema } from '@lifestream/runtime/capabilities/schema-validation';
import { AuthenticationError, type LocalAuthentication, type LocalContext } from '../auth/local-auth.ts';
import { readSessionEndpoint } from '../runtime/session-context.ts';
import type { CanonicalAuthorityHost } from './canonical-api.ts';

type BoundScope = CapabilitySnapshotRequest['scope'];
type ProposalPayload = CreateAuthorityRequestRequest['payload'];
type OperationScope = ProposalPayload['scope'];
type Definition = capabilitySnapshot_Root['capabilities'][number];
/** A configured semantic adapter, never supplied in a model or browser request. */
export type CapabilityScopeAdapter = {
  capabilityId: string; version: string; providerRouteRef: string; revision: string;
  inputSchema: ArtifactRef; outputSchema: ArtifactRef;
  derive(input: unknown): { scope: OperationScope; effectSummary: string; scopeDerivation: TrustedGrantProposal['scopeDerivation'] };
};
export type CanonicalCapabilityComposition = {
  environmentId: string; providerRef: string; provider: CapabilityProvider;
  /** A trusted provider adapter must supply actual evidence and a synchronous current-source fence. */
  governance?: {
    evaluate(request: AuthorityRequest, context: ProviderCallContext): Promise<{ disposition: GovernedDisposition; evidence: Uint8Array }>;
    assertCurrent(request: AuthorityRequest, disposition: GovernedDisposition): void;
    readEvidence(reference: ArtifactRef, request: AuthorityRequest | CapabilityStatusRequest, context: ProviderCallContext): Promise<Uint8Array>;
  };
  schemas: CapabilitySchemaStore; adapters: readonly CapabilityScopeAdapter[];
};
export type CapabilityPreparation = {
  principalId: string; idempotencyKey: string; intentDigest: string; providerRef: string; adapterRevision: string;
  scope: BoundScope; hostRevision: string; ownerRevision: string; snapshot: capabilitySnapshot_Root; definition: Definition;
  input: unknown; inputSchema: ArtifactRef; outputSchema: ArtifactRef; proposal: TrustedGrantProposal;
};
const validator = createContractValidator(), common = 'https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/';
const valid = (schema: string, value: unknown) => validator.validate(schema, value).valid;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function unavailable(code = 'capability_preparation_unavailable', status = 503): never { throw new AuthenticationError(status, code); }
const keyFor = (capabilityId: string, version: string) => `${capabilityId}@${version}`;

/** Owns preparation only: it cannot call invoke, issue a grant or claim dispatch. */
export class CanonicalCapabilityPreparation implements CanonicalAuthorityHost {
  readonly environmentId: string;
  private readonly providerRef: string;
  private readonly provider: CapabilityProvider;
  private readonly schemas: CapabilitySchemaStore;
  private readonly adapters = new Map<string, CapabilityScopeAdapter>();
  private readonly database: Database;
  private readonly auth: LocalAuthentication;
  private readonly now: () => number;
  private readonly isSelected: () => boolean;
  constructor(database: Database, auth: LocalAuthentication, composition: CanonicalCapabilityComposition, now: () => number = Date.now, isSelected: () => boolean = () => true) {
    this.database = database; this.auth = auth; this.now = now; this.isSelected = isSelected;
    if (!valid(common + 'UUID', composition.environmentId) || !composition.providerRef || composition.providerRef.length > 500 || composition.adapters.length > 256) throw new Error('Invalid canonical capability composition');
    this.environmentId = composition.environmentId; this.providerRef = composition.providerRef; this.schemas = composition.schemas;
    this.provider = new CanonicalProviderBoundary({ providerRef: this.providerRef }).capability(composition.provider);
    for (const original of composition.adapters) {
      const { derive, ...metadata } = original;
      const adapter = { ...structuredClone(metadata), derive: derive.bind(original) };
      if (!valid(common + 'CapabilityId', adapter.capabilityId) || !valid(common + 'Semver', adapter.version) || !adapter.revision || adapter.revision.length > 128 || !adapter.providerRouteRef || adapter.providerRouteRef.length > 500 ||
        !valid(common + 'ArtifactRef', adapter.inputSchema) || !valid(common + 'ArtifactRef', adapter.outputSchema) || this.adapters.has(keyFor(adapter.capabilityId, adapter.version))) throw new Error('Invalid canonical capability adapter');
      this.adapters.set(keyFor(adapter.capabilityId, adapter.version), adapter);
    }
  }
  static matches(path: string): boolean { return /^\/api\/authority\/v1\/assistants\/[^/]+\/tools\/[^/]+\/prepare$/.test(path); }
  assertCurrent(binding: GrantOwnerBinding, principalId: string): void {
    if (!this.isSelected()) unavailable('capability_provider_changed', 409);
    if (binding.environmentId !== this.environmentId || !binding.sessionId || !Number.isFinite(this.now())) unavailable('authority_scope_changed', 409);
    const session = this.database.connection.prepare('SELECT 1 FROM local_sessions WHERE session_id=? AND principal_id=? AND revoked=0').get(binding.sessionId, principalId);
    const endpoint = readSessionEndpoint(this.database, binding.sessionId).endpoint;
    if (!session || !endpoint || endpoint.endpointId !== binding.endpointId || endpoint.privacyClass !== 'personal' || endpoint.health !== 'healthy' ||
      !this.database.connection.prepare('SELECT 1 FROM local_assistant_permissions WHERE principal_id=? AND assistant_id=? AND administer=1').get(principalId, binding.assistantId)) unavailable('authority_scope_changed', 409);
  }
  private hostRevision(binding: GrantOwnerBinding, principalId: string): string {
    this.assertCurrent(binding, principalId);
    const owner = { assistantId: binding.assistantId, endpointId: binding.endpointId, environmentId: binding.environmentId, sessionId: binding.sessionId };
    return hash({ owner, principalId, endpoint: readSessionEndpoint(this.database, binding.sessionId!), providerRef: this.providerRef });
  }
  private ownerRevision(binding: GrantOwnerBinding, principalId: string, issuingRequestId: string | null = null): string {
    this.assertCurrent(binding, principalId);
    const endpoint = readSessionEndpoint(this.database, binding.sessionId!);
    // The approval transaction may add its own grant. Exclude only that request's
    // issuance from this final comparison; other grant changes still invalidate.
    const grants = this.database.connection.prepare("SELECT grant_id,sha256 FROM canonical_grants WHERE principal_id=? AND assistant_id=? AND (? IS NULL OR COALESCE(json_extract(payload_json,'$.grantRequestId'),'') != ?) ORDER BY grant_id").all(principalId, binding.assistantId, issuingRequestId, issuingRequestId);
    const owner = { assistantId: binding.assistantId, endpointId: binding.endpointId, environmentId: binding.environmentId, sessionId: binding.sessionId };
    return hash({ binding: owner, principalId, endpoint, grants, providerRef: this.providerRef });
  }
  private authorityContext(binding: GrantOwnerBinding, principalId: string, revision: string) {
    const owner = hash({ binding: { assistantId: binding.assistantId, endpointId: binding.endpointId, environmentId: binding.environmentId, sessionId: binding.sessionId }, principalId, providerRef: this.providerRef });
    return this.database.transaction(tx => {
      const existing = tx.get<{ context_id: string; revision: number; source_digest: string }>('SELECT * FROM canonical_preparation_contexts WHERE owner_key=?', owner);
      if (existing?.source_digest === revision) return { providerRef: 'local-human', contextId: existing.context_id, revision: existing.revision };
      if (!existing && (tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM canonical_preparation_contexts')?.count ?? 0) >= 4096) unavailable('capability_preparation_capacity', 429);
      const next = { providerRef: 'local-human', contextId: existing?.context_id ?? randomUUID(), revision: (existing?.revision ?? 0) + 1 };
      tx.run('INSERT INTO canonical_preparation_contexts VALUES (?,?,?,?) ON CONFLICT(owner_key) DO UPDATE SET revision=excluded.revision,source_digest=excluded.source_digest', owner, next.contextId, next.revision, revision);
      return next;
    });
  }
  private read(principalId: string, column: 'idempotency_key' | 'invocation_id', value: string): CapabilityPreparation | undefined {
    const row = this.database.connection.prepare(`SELECT payload_json,sha256 FROM canonical_preparations WHERE principal_id=? AND ${column}=?`).get(principalId, value) as { payload_json: string; sha256: string } | undefined;
    if (!row) return undefined;
    let record: CapabilityPreparation;
    try { record = JSON.parse(row.payload_json) as CapabilityPreparation; if (!boundedJson(record, 524288) || hash(record) !== row.sha256) unavailable(); } catch { return unavailable(); }
    if (record.principalId !== principalId || (column === 'idempotency_key' ? record.idempotencyKey : record.proposal.request.invocationId) !== value) unavailable();
    return record;
  }
  private assertRecord(record: CapabilityPreparation, issuingRequestId: string | null = null): void {
    const request = record.proposal.request;
    if (record.providerRef !== this.providerRef || this.ownerRevision(request, record.principalId, issuingRequestId) !== record.ownerRevision ||
      Date.parse(record.snapshot.issuedAt) > this.now() || Date.parse(record.snapshot.expiresAt) <= this.now() || Date.parse(request.expiresAt) <= this.now() ||
      hash(record.input) !== request.inputDigest || !valid('https://lifestream.dev/contracts/capability-snapshot/2.0.0', record.snapshot)) unavailable('capability_preparation_changed', 409);
    const adapter = this.adapters.get(keyFor(request.scope.capabilityId, request.scope.capabilityVersion));
    if (!adapter || adapter.providerRouteRef !== record.definition.providerRouteRef || adapter.revision !== record.adapterRevision || !isDeepStrictEqual(adapter.inputSchema, record.inputSchema) || !isDeepStrictEqual(adapter.outputSchema, record.outputSchema)) unavailable('capability_preparation_changed', 409);
  }
  private async snapshot(scope: BoundScope, capabilityId: string, call: CapabilityCall): Promise<capabilitySnapshot_Root> {
    const request: CapabilitySnapshotRequest = { schemaVersion: '1.0.0', operation: 'CapabilityProvider.getSnapshot', requestId: call.context.requestId, correlationId: call.context.correlationId,
      deadlineAt: call.context.deadlineAt, cancellationId: randomUUID(), executionMode: 'normal', scope, idempotencyKey: null, payload: { requestedCapabilityIds: capabilityId ? [capabilityId] : [] } };
    const result: CapabilitySnapshotResult = await call.wait(() => this.provider.getSnapshot(request, { signal: call.context.signal, isCurrent: candidate => isDeepStrictEqual(candidate, scope) && call.context.isCurrent() }));
    if (result.outcome.status !== 'succeeded') return unavailable();
    return result.outcome.payload;
  }
  async catalog(assistantId: string, local: LocalContext, inputCall: CapabilityCallContext) {
    const guard = () => { this.auth.assertCurrent(local); if (!this.auth.canAdminister(local, assistantId)) unavailable('assistant_scope_denied', 403); };
    guard(); const endpoint = readSessionEndpoint(this.database, local.sessionId).endpoint;
    if (!endpoint) unavailable('authority_scope_changed', 409);
    const binding = { assistantId, endpointId: endpoint.endpointId, sessionId: local.sessionId, environmentId: this.environmentId };
    const revision = this.ownerRevision(binding, local.principalId);
    const call = new CapabilityCall({ ...inputCall, isCurrent: () => { guard(); return inputCall.isCurrent() && this.ownerRevision(binding, local.principalId) === revision; } });
    try {
      call.check();
      const session = this.database.connection.prepare("SELECT conversation_id,interaction_id FROM sessions WHERE id=? AND status='active'").get(local.sessionId) as { conversation_id: string; interaction_id: string } | undefined;
      if (!session) unavailable('authority_scope_changed', 409);
      const scope: BoundScope = { ...binding, conversationId: session.conversation_id, interactionTraceId: session.interaction_id, authorityContextRef: this.authorityContext(binding, local.principalId, revision) };
      const snapshot = await this.snapshot(scope, '', call), tools = [];
      for (const definition of snapshot.capabilities) {
        const adapter = this.adapters.get(keyFor(definition.capabilityId, definition.version));
        if (!adapter || definition.providerRouteRef !== adapter.providerRouteRef || definition.inputSchemaRef !== adapter.inputSchema.reference || definition.outputSchemaRef !== adapter.outputSchema.reference) unavailable('capability_adapter_unavailable');
        const schemaScope = { assistantId, endpointId: endpoint.endpointId, sessionId: local.sessionId, environment: this.environmentId, authorityContextRef: scope.authorityContextRef! };
        const inputSchema = await resolveCapabilitySchema(adapter.inputSchema, schemaScope, call, this.schemas);
        await resolveCapabilitySchema(adapter.outputSchema, schemaScope, call, this.schemas);
        tools.push({ capabilityId: definition.capabilityId, version: definition.version, sideEffectClass: definition.sideEffectClass, authorization: definition.authorization, inputSchema, inputSchemaRef: adapter.inputSchema, outputSchemaRef: adapter.outputSchema });
      }
      call.check(); return { status: 'available', protocol: 'canonical', providerRef: this.providerRef, environmentId: this.environmentId, expiresAt: snapshot.expiresAt, tools, grantsAuthority: false, dispatchStarted: false };
    } catch (error) { if (error instanceof AuthenticationError) throw error; return unavailable(); } finally { call.close(); }
  }
  /** Inspect retained input for exact Human review; this neither grants nor dispatches. */
  async inspect(assistantId: string, invocationId: string, local: LocalContext, inputCall: CapabilityCallContext) {
    const guard = () => {
      this.auth.assertCurrent(local);
      if (!this.auth.canAdminister(local, assistantId)) unavailable('assistant_scope_denied', 403);
    };
    guard();
    if (!valid(common + 'UUID', assistantId) || !valid(common + 'UUID', invocationId)) unavailable('invalid_preparation_reference', 422);
    const read = () => {
      guard(); const record = this.retainedForResult(invocationId, local.principalId);
      if (record.scope.assistantId !== assistantId || record.scope.sessionId !== local.sessionId) unavailable('authority_not_found', 404);
      return record;
    };
    const record = read();
    const call = new CapabilityCall({ ...inputCall, isCurrent: () => {
      read(); return inputCall.isCurrent();
    } });
    try {
      call.check();
      const scope = { assistantId, endpointId: record.scope.endpointId!, sessionId: local.sessionId,
        environment: record.scope.environmentId, authorityContextRef: record.scope.authorityContextRef! };
      const inputSchema = await resolveCapabilitySchema(record.inputSchema, scope, call, this.schemas);
      if (!await call.wait(() => validateCapabilitySchema(inputSchema, record.input, call.context.signal))) unavailable('capability_input_invalid', 422);
      call.check();
      return { preparation: structuredClone(record.proposal), input: structuredClone(record.input), inputSchema,
        idempotencyKey: record.idempotencyKey, providerRef: record.providerRef, grantsAuthority: false, dispatchStarted: false };
    } catch (error) { if (error instanceof AuthenticationError) throw error; return unavailable(); }
    finally { call.close(); }
  }
  async prepare(assistantId: string, capabilityId: string, local: LocalContext, raw: unknown, inputCall: CapabilityCallContext) {
    const guard = () => { this.auth.assertCurrent(local); if (!this.auth.canAdminister(local, assistantId)) unavailable('assistant_scope_denied', 403); };
    guard();
    if (!boundedJson(raw) || !raw || typeof raw !== 'object' || Array.isArray(raw)) unavailable('invalid_preparation', 422);
    const body = structuredClone(raw) as Record<string, any>;
    const allowed = ['idempotencyKey','capabilityVersion','input','requestedClass','grantExpiresAt','reviewAfter','expiresAt','untrustedRationale'];
    if (Object.keys(body).some(key => !allowed.includes(key)) || !valid(common + 'UUID', body.idempotencyKey) || !valid(common + 'Semver', body.capabilityVersion) || !Object.hasOwn(body, 'input') ||
      !['allowOnce','allowSession','allowPersistent'].includes(body.requestedClass) || !valid(common + 'Time', body.grantExpiresAt) || !valid(common + 'Time', body.expiresAt) ||
      !(body.reviewAfter === null || valid(common + 'Time', body.reviewAfter)) || !(body.untrustedRationale === null || typeof body.untrustedRationale === 'string' && body.untrustedRationale.length <= 4000)) unavailable('invalid_preparation', 422);
    if (inputCall.executionMode !== 'live') unavailable('capability_preparation_mode_unavailable', 409);
    const endpoint = readSessionEndpoint(this.database, local.sessionId).endpoint;
    if (!endpoint) unavailable('authority_scope_changed', 409);
    const binding = { assistantId, endpointId: endpoint.endpointId, sessionId: local.sessionId, environmentId: this.environmentId };
    const currentRevision = this.ownerRevision(binding, local.principalId);
    const current = () => { guard(); return inputCall.isCurrent() && this.ownerRevision(binding, local.principalId) === currentRevision; };
    const call = new CapabilityCall({ ...inputCall, isCurrent: current });
    try {
      call.check(); const intentDigest = hash({ assistantId, capabilityId, binding, body });
      const previous = this.read(local.principalId, 'idempotency_key', body.idempotencyKey);
      if (previous) {
        if (previous.intentDigest !== intentDigest) unavailable('authority_idempotency_conflict', 409);
        await this.verifyRecord(previous, call); return { preparation: structuredClone(previous.proposal), replayed: true };
      }
      const adapter = this.adapters.get(keyFor(capabilityId, body.capabilityVersion)); if (!adapter) unavailable('capability_adapter_unavailable');
      const session = this.database.connection.prepare('SELECT conversation_id,interaction_id FROM sessions WHERE id=? AND status=\'active\'').get(local.sessionId) as { conversation_id: string; interaction_id: string };
      const scope: BoundScope = { ...binding, conversationId: session.conversation_id, interactionTraceId: session.interaction_id, authorityContextRef: this.authorityContext(binding, local.principalId, currentRevision) };
      const snapshot = await this.snapshot(scope, capabilityId, call);
      const definition = snapshot.capabilities.find(value => value.capabilityId === capabilityId && value.version === body.capabilityVersion);
      if (!definition || definition.providerRouteRef !== adapter.providerRouteRef || definition.inputSchemaRef !== adapter.inputSchema.reference || definition.outputSchemaRef !== adapter.outputSchema.reference) unavailable('capability_preparation_changed', 409);
      const schemaScope = { assistantId, endpointId: binding.endpointId, sessionId: binding.sessionId, environment: binding.environmentId, authorityContextRef: scope.authorityContextRef! };
      const schema = await resolveCapabilitySchema(adapter.inputSchema, schemaScope, call, this.schemas);
      if (!await call.wait(() => validateCapabilitySchema(schema, body.input, call.context.signal))) unavailable('capability_input_invalid', 422);
      const outputSchema = await resolveCapabilitySchema(adapter.outputSchema, schemaScope, call, this.schemas);
      if (!await call.wait(() => validateCapabilitySchema(outputSchema, null, call.context.signal, true))) unavailable('capability_output_schema_invalid');
      const derived = adapter.derive(structuredClone(body.input));
      if (!boundedJson(derived) || derived.scope.capabilityId !== capabilityId || derived.scope.capabilityVersion !== body.capabilityVersion) unavailable('capability_scope_invalid');
      const proposal: TrustedGrantProposal = { scopeDerivation: derived.scopeDerivation, request: { ...binding, invocationId: randomUUID(), interactionTraceId: scope.interactionTraceId!, scope: structuredClone(derived.scope), inputDigest: hash(body.input), effectSummary: derived.effectSummary, sideEffectClass: definition.sideEffectClass,
        requestedClass: body.requestedClass, grantExpiresAt: body.grantExpiresAt, reviewAfter: body.reviewAfter, expiresAt: body.expiresAt, untrustedRationale: body.untrustedRationale } };
      const { environmentId: _environment, sideEffectClass: _effect, ...payload } = proposal.request;
      if (!valid('https://lifestream.dev/contracts/runtime-api/1.0.0#/$defs/CreateAuthorityRequestRequest', { schemaVersion: '1.0.0', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: body.idempotencyKey, payload }) ||
        !['validatedArguments','inputBoundOnly'].includes(proposal.scopeDerivation) || (proposal.scopeDerivation === 'inputBoundOnly' && body.requestedClass !== 'allowOnce') ||
        Date.parse(body.expiresAt) <= this.now() || Date.parse(body.expiresAt) > Date.parse(snapshot.expiresAt) || Date.parse(body.grantExpiresAt) <= this.now() ||
        (body.requestedClass === 'allowPersistent' && body.reviewAfter === null) || (body.reviewAfter !== null && (Date.parse(body.reviewAfter) <= this.now() || Date.parse(body.reviewAfter) > Date.parse(body.grantExpiresAt)))) unavailable('invalid_preparation_terms', 422);
      const record: CapabilityPreparation = { principalId: local.principalId, idempotencyKey: body.idempotencyKey, intentDigest, providerRef: this.providerRef, adapterRevision: adapter.revision, scope, hostRevision: this.hostRevision(binding, local.principalId), ownerRevision: currentRevision, snapshot, definition, input: body.input, inputSchema: adapter.inputSchema, outputSchema: adapter.outputSchema, proposal };
      this.assertRecord(record); call.check();
      const saved = this.database.transaction(tx => {
        call.check(); const competing = this.read(local.principalId, 'idempotency_key', body.idempotencyKey);
        if (competing) { if (competing.intentDigest !== intentDigest) unavailable('authority_idempotency_conflict', 409); this.assertRecord(competing); return competing; }
        if ((tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM canonical_preparations')?.count ?? 0) >= 4096) unavailable('capability_preparation_capacity', 429);
        if (!boundedJson(record, 524288)) unavailable('capability_preparation_capacity', 429);
        tx.run('INSERT INTO canonical_preparations VALUES (?,?,?,?,?)', local.principalId, body.idempotencyKey, proposal.request.invocationId, JSON.stringify(record), hash(record)); call.check(); return record;
      });
      return { preparation: structuredClone(saved.proposal), replayed: saved !== record };
    } catch (error) { if (error instanceof AuthenticationError) throw error; return unavailable(); } finally { call.close(); }
  }
  private async verifyRecord(record: CapabilityPreparation, call: CapabilityCall): Promise<void> {
    this.assertRecord(record); call.check();
    const snapshot = await this.snapshot(record.scope, record.proposal.request.scope.capabilityId, call);
    if (!isDeepStrictEqual(snapshot, record.snapshot)) unavailable('capability_preparation_changed', 409);
    const adapter = this.adapters.get(keyFor(record.definition.capabilityId, record.definition.version))!;
    const schemaScope = { assistantId: record.scope.assistantId, endpointId: record.scope.endpointId!, sessionId: record.scope.sessionId!, environment: record.scope.environmentId, authorityContextRef: record.scope.authorityContextRef! };
    const schema = await resolveCapabilitySchema(record.inputSchema, schemaScope, call, this.schemas);
    if (!await call.wait(() => validateCapabilitySchema(schema, record.input, call.context.signal))) unavailable('capability_input_invalid', 422);
    const output = await resolveCapabilitySchema(record.outputSchema, schemaScope, call, this.schemas);
    if (!await call.wait(() => validateCapabilitySchema(output, null, call.context.signal, true))) unavailable('capability_output_schema_invalid');
    const derived = adapter.derive(structuredClone(record.input));
    if (!isDeepStrictEqual(derived.scope, record.proposal.request.scope) || derived.effectSummary !== record.proposal.request.effectSummary || derived.scopeDerivation !== record.proposal.scopeDerivation) unavailable('capability_preparation_changed', 409);
    this.assertRecord(record); call.check();
  }
  retainedForResult(invocationId: string, principalId: string): CapabilityPreparation {
    const record = this.read(principalId, 'invocation_id', invocationId);
    if (!record) return unavailable('authority_not_found', 404);
    if (!record.hostRevision || record.hostRevision !== this.hostRevision(record.proposal.request, principalId)) unavailable('capability_preparation_changed', 409);
    return structuredClone(record);
  }
  /** Refresh authority after grant issuance without changing the approved input or material scope. */
  async refreshForDispatch(invocationId: string, idempotencyKey: string, local: LocalContext, call: CapabilityCall): Promise<CapabilityPreparation> {
    const original = this.read(local.principalId, 'invocation_id', invocationId);
    if (!original) return unavailable('authority_not_found', 404);
    if (original.idempotencyKey !== idempotencyKey) unavailable('authority_idempotency_conflict', 409);
    if (!original.hostRevision || original.hostRevision !== this.hostRevision(original.proposal.request, local.principalId)) unavailable('capability_preparation_changed', 409);
    const record = structuredClone(original);
    record.ownerRevision = this.ownerRevision(record.proposal.request, local.principalId);
    record.scope.authorityContextRef = this.authorityContext(record.proposal.request, local.principalId, record.ownerRevision);
    record.snapshot = await this.snapshot(record.scope, record.definition.capabilityId, call);
    const definition = record.snapshot.capabilities.find(value => value.capabilityId === record.definition.capabilityId && value.version === record.definition.version);
    if (!isDeepStrictEqual(definition, original.definition)) unavailable('capability_preparation_changed', 409);
    // The pending request deadline does not revoke a subsequently approved grant.
    // Preserve the stored terms and validate grant eligibility at final admission.
    const pendingExpiry = record.proposal.request.expiresAt;
    record.proposal.request.expiresAt = record.snapshot.expiresAt;
    try { await this.verifyRecord(record, call); }
    finally { record.proposal.request.expiresAt = pendingExpiry; }
    this.assertDispatchCurrent(record, false); return record;
  }
  assertDispatchCurrent(record: CapabilityPreparation, admitted: boolean): void {
    if (record.hostRevision !== this.hostRevision(record.proposal.request, record.principalId) ||
      (!admitted && this.ownerRevision(record.proposal.request, record.principalId) !== record.ownerRevision) ||
      Date.parse(record.snapshot.issuedAt) > this.now() || Date.parse(record.snapshot.expiresAt) <= this.now() || hash(record.input) !== record.proposal.request.inputDigest) unavailable('capability_preparation_changed', 409);
  }
  assertProposalCurrent(request: TrustedGrantProposal['request'] & { requestId?: string }, principalId: string): void {
    const record = this.read(principalId, 'invocation_id', request.invocationId); if (!record) return unavailable('authority_not_found', 404);
    this.assertRecord(record, request.requestId ?? null);
    for (const key of Object.keys(record.proposal.request)) if (!isDeepStrictEqual(record.proposal.request[key as keyof typeof record.proposal.request], request[key as keyof typeof request])) unavailable('authority_proposal_changed', 409);
  }
  async validateProposal(request: TrustedGrantProposal['request'], principalId: string, inputCall: CapabilityCallContext): Promise<void> {
    const record = this.read(principalId, 'invocation_id', request.invocationId); if (!record) return unavailable('authority_not_found', 404);
    for (const key of Object.keys(record.proposal.request)) if (!isDeepStrictEqual(record.proposal.request[key as keyof typeof record.proposal.request], request[key as keyof typeof request])) unavailable('authority_proposal_changed', 409);
    const call = new CapabilityCall(inputCall);
    try { await this.verifyRecord(record, call); } finally { call.close(); }
  }
  async resolveProposal(payload: ProposalPayload, principalId: string, inputCall: CapabilityCallContext): Promise<TrustedGrantProposal> {
    const record = this.read(principalId, 'invocation_id', payload.invocationId); if (!record) return unavailable('authority_not_found', 404);
    const call = new CapabilityCall(inputCall);
    try { await this.verifyRecord(record, call); return structuredClone(record.proposal); } finally { call.close(); }
  }
}
