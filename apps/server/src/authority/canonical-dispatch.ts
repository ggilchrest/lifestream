import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createContractValidator } from '@lifestream/contracts';
import type { AuthorityRequest, AuthorityDispatchRequest, CapabilityInvocationRequest, providerMessages_DefsGovernedDisposition as GovernedDisposition } from '@lifestream/contracts/provider-messages';
import { CanonicalGrantRepository, CanonicalGrantError } from '@lifestream/storage-sqlite';
import type { Database, CanonicalHumanContext, CanonicalDispatchView } from '@lifestream/storage-sqlite';
import { evaluateCanonicalGrant } from '@lifestream/runtime/authority/grants';
import { CanonicalProviderBoundary } from '@lifestream/runtime/ports/provider-boundary';
import { CapabilityCall } from '@lifestream/runtime/capabilities/call';
import type { CapabilityCallContext } from '@lifestream/runtime/capabilities/ports';
import { resolveCapabilitySchema } from '@lifestream/runtime/capabilities/schema-artifacts';
import { boundedJson, validateCapabilitySchema } from '@lifestream/runtime/capabilities/schema-validation';
import { AuthenticationError, type LocalAuthentication, type LocalContext } from '../auth/local-auth.ts';
import { CanonicalCapabilityPreparation, type CanonicalCapabilityComposition, type CapabilityPreparation } from './capability-preparation.ts';

const validator = createContractValidator(), common = 'https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/';
const valid = (schema: string, value: unknown) => validator.validate(schema, value).valid;
const unavailable = (code = 'capability_dispatch_unavailable', status = 503): never => { throw new AuthenticationError(status, code); };
/** Protected tool execution. Canonical authorization inputs and receipts are
 * constructed here from retained preparation, never accepted from HTTP JSON. */
export class CanonicalCapabilityDispatch {
  private readonly repository: CanonicalGrantRepository;
  private readonly auth: LocalAuthentication;
  private readonly preparation: CanonicalCapabilityPreparation;
  private readonly composition: CanonicalCapabilityComposition;
  private readonly now: () => number;
  constructor(database: Database, auth: LocalAuthentication, preparation: CanonicalCapabilityPreparation, composition: CanonicalCapabilityComposition, now: () => number = Date.now) {
    this.repository = new CanonicalGrantRepository(database, 'local-human'); this.auth = auth; this.preparation = preparation; this.now = now;
    const governance = composition.governance;
    this.composition = { ...composition, ...(governance ? { governance: { evaluate: governance.evaluate.bind(governance), assertCurrent: governance.assertCurrent.bind(governance), readEvidence: governance.readEvidence.bind(governance) } } : {}) };
  }
  static matches(path: string): boolean { return /^\/api\/authority\/v1\/assistants\/[^/]+\/tools\/invocations\/[^/]+(?:\/dispatch)?$/.test(path); }
  private context(local: LocalContext, assistantId: string): CanonicalHumanContext {
    return { principalId: local.principalId, providerRef: 'local-human', authenticationEvidenceRef: '', now: () => new Date(this.now()).toISOString(),
      assertCurrent: binding => {
        this.auth.assertCurrent(local);
        if (binding.assistantId !== assistantId || !this.auth.canAdminister(local, assistantId) || (binding.sessionId !== null && binding.sessionId !== local.sessionId)) unavailable('authority_not_found', 404);
      } };
  }
  private response(view: CanonicalDispatchView, replayed: boolean) {
    return { status: 200, replayed, body: { invocationId: view.admission.decision.invocationId, replayed, receipt: view.admission.receipt,
      decision: view.admission.decision, initialCallClaimed: view.initialCallClaimed,
      status: view.result?.outcome.status === 'succeeded' && ['succeeded','failed'].includes(view.result.outcome.payload.type) ? view.result.outcome.payload.type : 'outcomeUnknown', result: view.result } };
  }
  private async replayResult(view: CanonicalDispatchView, local: LocalContext, inputCall: CapabilityCallContext) {
    if (view.result?.outcome.status !== 'succeeded' || view.result.outcome.payload.type !== 'succeeded') return this.response(view, true);
    const result = view.result.outcome.payload;
    const current = () => { this.auth.assertCurrent(local); this.preparation.retainedForResult(result.invocationId, local.principalId); return inputCall.isCurrent(); };
    const call = new CapabilityCall({ ...inputCall, isCurrent: current });
    try {
      const record = this.preparation.retainedForResult(result.invocationId, local.principalId), scope = view.admission.request.scope;
      if (!isDeepStrictEqual(record.outputSchema, result.outputSchema)) return unavailable();
      const schema = await resolveCapabilitySchema(record.outputSchema, { assistantId: scope.assistantId, endpointId: scope.endpointId!, sessionId: local.sessionId, environment: scope.environmentId, authorityContextRef: scope.authorityContextRef! }, call, this.composition.schemas);
      if (!await call.wait(() => validateCapabilitySchema(schema, result.output, call.context.signal))) return unavailable();
      call.check(); return this.response(view, true);
    } finally { call.close(); }
  }
  async handle(method: string, path: string, local: LocalContext, raw: unknown, inputCall: CapabilityCallContext) {
    try { return await this.execute(method, path, local, raw, inputCall); }
    catch (error) {
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof CanonicalGrantError) return unavailable(`authority_${error.code}`, error.code === 'conflict' ? 409 : error.code === 'notFound' ? 404 : 503);
      return unavailable();
    }
  }
  private async execute(method: string, path: string, local: LocalContext, raw: unknown, inputCall: CapabilityCallContext) {
    const parts = path.split('/').filter(Boolean), assistantId = parts[4]!, invocationId = parts[7]!;
    if (!valid(common + 'UUID', assistantId) || !valid(common + 'UUID', invocationId)) return unavailable('authority_not_found', 404);
    const context = this.context(local, assistantId);
    this.auth.assertCurrent(local); if (!this.auth.canAdminister(local, assistantId)) return unavailable('authority_not_found', 404);
    if (method === 'GET' && parts.length === 8) {
      const view = this.repository.dispatchView(invocationId, context); if (!view) return unavailable('authority_not_found', 404);
      return this.replayResult(view, local, inputCall);
    }
    if (method !== 'POST' || parts[8] !== 'dispatch') return unavailable('capability_dispatch_method_not_allowed', 405);
    if (!boundedJson(raw) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable('invalid_dispatch', 422);
    const body = structuredClone(raw) as Record<string, unknown>;
    if (Object.keys(body).sort().join(',') !== 'grantId,idempotencyKey' || !valid(common + 'UUID', body.grantId) || !valid(common + 'UUID', body.idempotencyKey)) return unavailable('invalid_dispatch', 422);
    const original = this.repository.dispatchView(invocationId, context);
    if (original) {
      if (original.admission.request.idempotencyKey !== body.idempotencyKey || original.admission.request.payload.grantId !== body.grantId) return unavailable('authority_idempotency_conflict', 409);
      return this.replayResult(original, local, inputCall);
    }
    if (inputCall.executionMode !== 'live' || !this.composition.governance) return unavailable();
    const governance = this.composition.governance;
    let record: CapabilityPreparation | undefined, admitted = false, authorityRequest: AuthorityRequest | undefined, disposition: GovernedDisposition | undefined;
    const current = () => {
      this.auth.assertCurrent(local);
      if (!inputCall.isCurrent()) return false;
      if (record) this.preparation.assertDispatchCurrent(record, admitted);
      if (authorityRequest && disposition) governance.assertCurrent(structuredClone(authorityRequest), structuredClone(disposition));
      return true;
    };
    const call = new CapabilityCall({ ...inputCall, isCurrent: current });
    try {
      record = await this.preparation.refreshForDispatch(invocationId, body.idempotencyKey as string, local, call);
      if (record.scope.assistantId !== assistantId || record.scope.sessionId !== local.sessionId) return unavailable('authority_not_found', 404);
      const grant = this.repository.inspectGrant(body.grantId as string, context);
      authorityRequest = { schemaVersion: '1.0.0', operation: 'AuthorityProvider.evaluate', requestId: call.context.requestId, correlationId: call.context.correlationId,
        deadlineAt: call.context.deadlineAt, cancellationId: randomUUID(), executionMode: 'normal', scope: record.scope, idempotencyKey: record.idempotencyKey,
        payload: { grantId: grant.grantId, invocationId, scope: record.proposal.request.scope, inputDigest: record.proposal.request.inputDigest, snapshotId: record.snapshot.snapshotId, snapshotRevision: record.snapshot.revision } };
      const governed = await call.wait(() => governance.evaluate(structuredClone(authorityRequest!), { signal: call.context.signal, isCurrent: scope => isDeepStrictEqual(scope, record!.scope) && current() }));
      if (!boundedJson(governed.disposition) || !valid('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/GovernedDisposition', governed.disposition) || governed.disposition.providerRef !== this.composition.providerRef || !(governed.evidence instanceof Uint8Array)) return unavailable();
      disposition = structuredClone(governed.disposition);
      const request: AuthorityDispatchRequest = { ...authorityRequest, operation: 'AuthorityProvider.authorizeDispatch', idempotencyKey: record.idempotencyKey,
        payload: { ...authorityRequest.payload, expectedGrantRevision: grant.revision, requiredProviderDisposition: disposition } };
      const result = this.repository.authorizeDispatch(request, governed.evidence, context,
        selected => evaluateCanonicalGrant(selected, authorityRequest!, { principalId: local.principalId, sessionId: local.sessionId, now: context.now(), authorityContextRef: record!.scope.authorityContextRef!, assertCurrent: () => call.check() }),
        () => call.check());
      if (result.replayed) return this.replayResult(this.repository.dispatchView(invocationId, context)!, local, inputCall);
      admitted = true;
      const invocation: CapabilityInvocationRequest = { ...request, scope: { ...record.scope, authorityContextRef: record.scope.authorityContextRef!, sessionId: local.sessionId, endpointId: record.scope.endpointId!, interactionTraceId: record.scope.interactionTraceId! }, operation: 'CapabilityProvider.invoke', payload: {
        invocationId, capabilityId: record.definition.capabilityId, capabilityVersion: record.definition.version, snapshotId: record.snapshot.snapshotId, snapshotRevision: record.snapshot.revision,
        operationScope: record.proposal.request.scope, input: record.input as CapabilityInvocationRequest['payload']['input'], inputSchema: record.inputSchema, inputDigest: record.proposal.request.inputDigest, dispatchReceipt: result.admission.receipt } };
      const provider = new CanonicalProviderBoundary({ providerRef: this.composition.providerRef, admitInvocation: async candidate => {
        if (!isDeepStrictEqual(candidate, invocation)) return false;
        return this.repository.claimInitialDispatch(invocationId, result.admission.receipt, context, () => call.check());
      } }).capability(this.composition.provider);
      try {
        const outcome = await call.wait(() => provider.invoke(invocation, { signal: call.context.signal, isCurrent: scope => isDeepStrictEqual(scope, record!.scope) && current() }));
        if (outcome.outcome.status === 'succeeded' && outcome.outcome.payload.type === 'succeeded') {
          if (!isDeepStrictEqual(outcome.outcome.payload.outputSchema, record.outputSchema)) return unavailable();
          const schema = await resolveCapabilitySchema(record.outputSchema, { assistantId, endpointId: record.scope.endpointId!, sessionId: local.sessionId, environment: record.scope.environmentId, authorityContextRef: record.scope.authorityContextRef! }, call, this.composition.schemas);
          if (!await call.wait(() => validateCapabilitySchema(schema, outcome.outcome.status === 'succeeded' && outcome.outcome.payload.type === 'succeeded' ? outcome.outcome.payload.output : null, call.context.signal))) return unavailable();
        }
        const status = outcome.outcome.status === 'succeeded' ? outcome.outcome.payload : null;
        const evidenceRef = status && 'evidenceRef' in status ? status.evidenceRef : null;
        const evidence = evidenceRef ? await call.wait(() => governance.readEvidence(evidenceRef, structuredClone(authorityRequest!), { signal: call.context.signal, isCurrent: scope => isDeepStrictEqual(scope, record!.scope) && current() })) : null;
        this.repository.recordDispatchResult(invocationId, outcome, evidence, context);
      } catch {
        // Admission is durable. Missing, cancelled or malformed replies never refund
        // a grant and never grant permission for another initial provider call.
      }
      return this.response(this.repository.dispatchView(invocationId, context)!, false);
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof CanonicalGrantError) return unavailable(`authority_${error.code}`, error.code === 'conflict' ? 409 : error.code === 'notFound' ? 404 : 503);
      return unavailable();
    } finally { call.close(); }
  }
}
