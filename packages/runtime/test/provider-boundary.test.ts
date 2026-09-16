import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type * as M from '../../contracts/src/provider-messages.ts';
import type { AuthorityProvider, CapabilityProvider, ProviderCallContext } from '../src/ports/provider-messages.ts';
import { CanonicalProviderBoundary, ProviderBoundaryError } from '../src/ports/provider-boundary.ts';
import { canonicalJson } from '../src/capabilities/schema-validation.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const reason = { code: 'synthetic', summary: 'Synthetic fixture decision' };
const now = () => new Date().toISOString();
const future = (ms = 5000) => new Date(Date.now() + ms).toISOString();
const ref: M.ArtifactRef = { reference: 'urn:fixture:proof', sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'application/json', schemaRef: 'urn:fixture:proof-schema:1' };
const scope: M.CallScope = { assistantId: id(1), environmentId: id(2), conversationId: null, sessionId: id(3), endpointId: id(4),
  authorityContextRef: { providerRef: 'fixture.authority', contextId: id(5), revision: 1 }, interactionTraceId: id(6) };
const operationScope = { capabilityId: 'fixture.echo', capabilityVersion: '1.0.0', operation: 'echo', targetRefs: ['urn:fixture:target'], dataScopeRefs: [] };
const base = () => ({ schemaVersion: '1.0.0', requestId: id(10), correlationId: id(11), cancellationId: id(12), deadlineAt: future(), executionMode: 'simulation', scope: structuredClone(scope), idempotencyKey: null });
const snapshotRequest = () => ({ ...base(), operation: 'CapabilityProvider.getSnapshot', payload: { requestedCapabilityIds: [] } }) as M.CapabilitySnapshotRequest;
const invocationRequest = () => ({ ...base(), operation: 'CapabilityProvider.invoke', idempotencyKey: id(13), payload: {
  invocationId: id(14), capabilityId: 'fixture.echo', capabilityVersion: '1.0.0', snapshotId: id(15), snapshotRevision: 1,
  operationScope, input: { text: 'synthetic' }, inputSchema: ref, inputDigest: hash({ text: 'synthetic' }), dispatchReceipt: ref
} }) as M.CapabilityInvocationRequest;
const statusRequest = () => ({ ...base(), operation: 'CapabilityProvider.getInvocation', payload: { invocationId: id(14) } }) as M.CapabilityStatusRequest;
const authorityRequest = () => ({ ...base(), operation: 'AuthorityProvider.evaluate', payload: { grantId: null, invocationId: id(14), scope: operationScope,
  inputDigest: hash({ text: 'synthetic' }), snapshotId: id(15), snapshotRevision: 1 } }) as M.AuthorityRequest;
const dispatchRequest = () => ({ ...authorityRequest(), operation: 'AuthorityProvider.authorizeDispatch', idempotencyKey: id(13),
  payload: { ...authorityRequest().payload, expectedGrantRevision: 1, requiredProviderDisposition: {
    decisionId: id(16), providerRef: 'fixture.capability', invocationId: id(14), inputDigest: hash({ text: 'synthetic' }), scopeDigest: hash(operationScope),
    authorityContextRef: scope.authorityContextRef, disposition: 'authorized', reason, evaluatedAt: now(), expiresAt: future(), evidenceRef: ref
  } } }) as M.AuthorityDispatchRequest;
const grantsRequest = () => ({ ...base(), operation: 'AuthorityProvider.getGrants', payload: { states: [], page: { limit: 10, cursor: null } } }) as M.GrantQueryRequest;
const streamRequest = (authority = false) => ({ ...base(), operation: authority ? 'AuthorityProvider.subscribeInvalidations' : 'CapabilityProvider.subscribeInvalidations',
  payload: { providerRef: authority ? 'fixture.authority' : 'fixture.capability', afterSequence: 42, sourceRevision: null }
}) as M.CapabilityInvalidationRequest | M.AuthorityInvalidationRequest;
const context = (): ProviderCallContext => ({ signal: new AbortController().signal, isCurrent: candidate => canonicalJson(candidate) === canonicalJson(scope) });
const reply = (q: { operation: string; requestId: string; correlationId: string }, payload: unknown, providerRef = 'fixture.capability') => ({
  schemaVersion: '1.0.0', operation: q.operation, requestId: q.requestId, correlationId: q.correlationId, providerRef, completedAt: now(),
  outcome: { status: 'succeeded', payload, error: null }
});
const snapshot = (q: M.CapabilitySnapshotRequest) => reply(q, { schemaVersion: '2.0.0', snapshotId: id(15), revision: 1,
  assistantId: scope.assistantId, environmentId: scope.environmentId, endpointId: scope.endpointId, sessionId: scope.sessionId,
  authorityContextRef: structuredClone(scope.authorityContextRef), issuedAt: now(), expiresAt: future(), capabilities: [] }) as M.CapabilitySnapshotResult;
const status = (q: M.CapabilityInvocationRequest | M.CapabilityStatusRequest) => reply(q, { type: 'succeeded', invocationId: q.payload.invocationId,
  output: { text: 'synthetic' }, outputSchema: ref, confirmedAt: now(), evidenceRef: ref }) as M.CapabilityInvocationResult & M.CapabilityStatusResult;
const authority = (q: M.AuthorityRequest | M.AuthorityDispatchRequest, disposition = 'denied') => reply(q, {
  schemaVersion: '1.0.0', authorityKind: 'external', decisionId: id(16), kind: q.operation === 'AuthorityProvider.evaluate' ? 'preview' : 'dispatch',
  providerRef: 'fixture.authority', invocationId: q.payload.invocationId, inputDigest: q.payload.inputDigest, scopeDigest: hash(q.payload.scope),
  authorityContextRef: q.scope.authorityContextRef, executionMode: q.executionMode, disposition, reason,
  evaluatedAt: now(), admittedAt: q.operation === 'AuthorityProvider.authorizeDispatch' && disposition === 'authorized' ? now() : null,
  expiresAt: future(), evidenceRef: ref, scope: q.scope, correlationId: q.correlationId, snapshotId: q.payload.snapshotId, snapshotRevision: q.payload.snapshotRevision
}, 'fixture.authority') as M.AuthorityResult & M.AuthorityDispatchResult;
const frames = (q: M.CapabilityInvalidationRequest | M.AuthorityInvalidationRequest) => {
  const time = now();
  const envelope = { schemaVersion: '1.0.0', operation: q.operation, requestId: q.requestId, correlationId: q.correlationId,
    providerRef: q.payload.providerRef, streamId: id(17), occurredAt: time };
  const payload = q.operation.startsWith('Authority') ? { eventId: id(18), scope: q.scope, providerRef: q.payload.providerRef,
    authorityContextRef: q.scope.authorityContextRef, reason: 'revoked', occurredAt: time } : {
    eventId: id(18), scope: q.scope, snapshotIds: [id(15)], capabilityIds: ['fixture.echo'], reason: 'gap', occurredAt: time };
  return [{ ...envelope, sequence: 0, kind: 'data', payload }, { ...envelope, sequence: 1, kind: 'terminal', outcome: {
    status: 'succeeded', payload: { lastSequence: 0, sourceRevision: { providerRef: q.payload.providerRef, revision: '2', highWaterMark: null } }, error: null
  } }] as Array<M.CapabilityInvalidationEvent & M.AuthorityInvalidationEvent>;
};
async function* stream<T>(items: T[]): AsyncGenerator<T> { yield* items; }
const capabilityProvider = (overrides: Partial<CapabilityProvider> = {}): CapabilityProvider => ({
  getSnapshot: async q => snapshot(q), invoke: async q => status(q), getInvocation: async q => status(q),
  subscribeInvalidations: q => stream(frames(q)), ...overrides
});
const authorityProvider = (overrides: Partial<AuthorityProvider> = {}): AuthorityProvider => ({
  evaluate: async q => authority(q), authorizeDispatch: async q => authority(q, 'authorized'),
  getGrants: async q => reply(q, { grants: [], sourceRevision: { providerRef: 'fixture.authority', revision: '1', highWaterMark: null }, nextCursor: null }, 'fixture.authority') as M.GrantQueryResult,
  subscribeInvalidations: q => stream(frames(q)), ...overrides
});
const collect = async <T>(source: AsyncIterable<T>) => { const result: T[] = []; for await (const value of source) result.push(value); return result; };
const failure = (code: ProviderBoundaryError['code'], effect = false) => (error: unknown) => error instanceof ProviderBoundaryError && error.code === code && error.effectMayHaveStarted === effect;

test('all eight canonical methods preserve denial, confirmed result, grants and explicit stream completion', async () => {
  const capability = new CanonicalProviderBoundary({ providerRef: 'fixture.capability', admitInvocation: async () => true }).capability(capabilityProvider());
  const auth = new CanonicalProviderBoundary({ providerRef: 'fixture.authority', admitDispatch: async () => true }).authority(authorityProvider());
  assert.equal((await capability.getSnapshot(snapshotRequest(), context())).outcome.status, 'succeeded');
  assert.equal((await capability.invoke(invocationRequest(), context())).outcome.status, 'succeeded');
  assert.equal((await capability.getInvocation(statusRequest(), context())).outcome.status, 'succeeded');
  assert.equal((await auth.evaluate(authorityRequest(), context())).outcome.payload?.disposition, 'denied');
  assert.equal((await auth.authorizeDispatch(dispatchRequest(), context())).outcome.payload?.kind, 'dispatch');
  assert.equal((await auth.getGrants(grantsRequest(), context())).outcome.payload?.grants.length, 0);
  assert.equal((await collect(capability.subscribeInvalidations(streamRequest() as M.CapabilityInvalidationRequest, context()))).length, 2);
  assert.equal((await collect(auth.subscribeInvalidations(streamRequest(true) as M.AuthorityInvalidationRequest, context()))).length, 2);
});

test('wrong operation, unknown fields, missing required nullable fields and lossy JSON fail before provider entry', async () => {
  let calls = 0;
  const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability' }).capability(capabilityProvider({ getSnapshot: async q => { calls++; return snapshot(q); } }));
  for (const modify of [
    q => { q.operation = 'CapabilityProvider.invoke'; }, q => { q.unknown = true; }, q => { delete q.scope.conversationId; },
    q => { q.scope.assistantId = 'not-a-uuid'; }, q => { q.executionMode = 'live'; }, q => { q.scope.authorityContextRef = null; },
    q => { q.payload.requestedCapabilityIds = [undefined]; }, q => { Object.defineProperty(q.payload, 'bad', { get() { throw Error('must not run'); }, enumerable: true }); }
  ] as Array<(q: any) => void>) {
    const q = snapshotRequest(); modify(q);
    await assert.rejects(provider.getSnapshot(q, context()), failure('invalidRequest'));
  }
  assert.equal(calls, 0);
});

test('schema-valid wrong provider/request/correlation/scope and expired snapshots are rejected', async () => {
  for (const modify of [
    r => { r.providerRef = 'another'; }, r => { r.requestId = id(999); }, r => { r.correlationId = id(999); },
    r => { r.outcome.payload.assistantId = id(999); }, r => { r.outcome.payload.environmentId = id(999); },
    r => { r.outcome.payload.endpointId = id(999); }, r => { r.outcome.payload.sessionId = id(999); },
    r => { r.outcome.payload.authorityContextRef.revision++; }, r => { r.outcome.payload.expiresAt = '2000-01-01T00:00:00Z'; },
    r => { r.completedAt = future(60000); }
  ] as Array<(r: any) => void>) {
    const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability' }).capability(capabilityProvider({ getSnapshot: async q => {
      const result = snapshot(q); modify(result); return result;
    } }));
    await assert.rejects(provider.getSnapshot(snapshotRequest(), context()), failure('invalidResponse'));
  }
});

test('request and result snapshots cannot be mutated by callers or providers across awaits', async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const q = snapshotRequest();
  const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability' }).capability(capabilityProvider({ getSnapshot: async (request, call) => {
    assert.ok(Object.isFrozen(request.scope)); assert.ok(Object.isFrozen(call));
    assert.throws(() => { call.isCurrent = () => false; }, TypeError);
    entered(); await pending; return snapshot(request);
  } }));
  const resultPromise = provider.getSnapshot(q, context()); await ready; q.requestId = id(999); release();
  const result = await resultPromise;
  assert.equal(result.requestId, id(10)); assert.ok(Object.isFrozen(result.outcome.payload));
});

test('protected invocation requires trusted admission, matching input digest and capability identity', async () => {
  let invokes = 0;
  const raw = capabilityProvider({ invoke: async q => { invokes++; return status(q); } });
  for (const options of [{ providerRef: 'fixture.capability' }, { providerRef: 'fixture.capability', admitInvocation: async () => false }]) {
    await assert.rejects(new CanonicalProviderBoundary(options).capability(raw).invoke(invocationRequest(), context()), failure('admissionRequired'));
  }
  const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability', admitInvocation: async () => true }).capability(raw);
  for (const modify of [q => { q.payload.inputDigest = 'b'.repeat(64); }, q => { q.payload.capabilityVersion = '2.0.0'; }, q => { q.idempotencyKey = null; } ] as Array<(q: any) => void>) {
    const q = invocationRequest(); modify(q); await assert.rejects(provider.invoke(q, context()), failure('invalidRequest'));
  }
  assert.equal(invokes, 0);
  await assert.rejects(new CanonicalProviderBoundary({ providerRef: 'fixture.authority' }).authority(authorityProvider()).authorizeDispatch(dispatchRequest(), context()), failure('admissionRequired'));
});

test('cancellation or owner change while admission is pending prevents dispatch', async () => {
  for (const cancel of [false, true]) {
    let current = true, invokes = 0;
    const controller = new AbortController();
    const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability', admitInvocation: async () => {
      await Promise.resolve(); if (cancel) controller.abort(); else current = false; return true;
    } }).capability(capabilityProvider({ invoke: async q => { invokes++; return status(q); } }));
    await assert.rejects(provider.invoke(invocationRequest(), { signal: controller.signal, isCurrent: () => current }), failure(cancel ? 'cancelled' : 'scopeChanged'));
    assert.equal(invokes, 0);
  }
});

test('ignored cancellation and late provider response stay bounded, unknown after invoke, with no retry', async () => {
  let invokes = 0;
  let finish!: (r: M.CapabilityInvocationResult) => void;
  const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability', admitInvocation: async () => true }).capability(capabilityProvider({ invoke: async () => {
    invokes++; return new Promise(resolve => { finish = resolve; });
  } }));
  const q = invocationRequest(); q.deadlineAt = future(40);
  await assert.rejects(provider.invoke(q, context()), failure('timedOut', true));
  finish(status(q)); await Promise.resolve(); assert.equal(invokes, 1);
});

test('a result arriving after owner change is fenced, including status lookup', async () => {
  let current = true;
  const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability' }).capability(capabilityProvider({ getInvocation: async q => {
    await Promise.resolve(); current = false; return status(q);
  } }));
  await assert.rejects(provider.getInvocation(statusRequest(), { signal: new AbortController().signal, isCurrent: () => current }), failure('scopeChanged'));
});

test('capability success requires declared evidence/schema and original invocation identity', async () => {
  for (const modify of [r => { delete r.outcome.payload.evidenceRef; }, r => { r.outcome.payload.outputSchema.sha256 = 'bad'; },
    r => { r.outcome.payload.invocationId = id(999); }, r => { r.outcome.payload.confirmedAt = future(60000); }] as Array<(r: any) => void>) {
    const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability' }).capability(capabilityProvider({ getInvocation: async q => {
      const result = structuredClone(status(q)); modify(result); return result;
    } }));
    await assert.rejects(provider.getInvocation(statusRequest(), context()), failure('invalidResponse'));
  }
});

test('only retryableFailure may request retry, and a valid retryable failure is returned without retrying', async () => {
  let calls = 0;
  for (const [statusName, correlationId, valid] of [['failed', id(11), false], ['retryableFailure', id(999), false], ['retryableFailure', id(11), true]] as const) {
    const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability' }).capability(capabilityProvider({ getSnapshot: async q => {
      calls++;
      return { ...snapshot(q), outcome: { status: statusName, payload: null, error: { code: 'fixture.unavailable', message: 'Synthetic unavailable', retryable: true, correlationId, details: [] } } };
    } }));
    if (valid) assert.equal((await provider.getSnapshot(snapshotRequest(), context())).outcome.status, 'retryableFailure');
    else await assert.rejects(provider.getSnapshot(snapshotRequest(), context()), failure('invalidResponse'));
  }
  assert.equal(calls, 3);
});

test('authority preview, admission, scope, snapshot, correlation and immutable evidence bindings fail closed', async () => {
  for (const modify of [r => { r.outcome.payload.kind = 'dispatch'; }, r => { r.outcome.payload.scopeDigest = 'b'.repeat(64); },
    r => { r.outcome.payload.snapshotRevision++; }, r => { r.outcome.payload.correlationId = id(999); },
    r => { r.outcome.payload.scope.sessionId = id(999); }, r => { r.outcome.payload.executionMode = 'normal'; },
    r => { r.outcome.payload.providerRef = 'wrong'; }, r => { r.outcome.payload.expiresAt = '2000-01-01T00:00:00Z'; },
    r => { delete r.outcome.payload.evidenceRef.sha256; }] as Array<(r: any) => void>) {
    const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.authority' }).authority(authorityProvider({ evaluate: async q => {
      const result = structuredClone(authority(q)); modify(result); return result;
    } }));
    await assert.rejects(provider.evaluate(authorityRequest(), context()), failure('invalidResponse'));
  }
});

test('both invalidation families reject gaps, duplicate frames, changed identity/scope, missing terminal and data after terminal', async () => {
  for (const authority of [false, true]) for (const modify of [
    values => { values[0].sequence = 1; }, values => { values[1].sequence = 0; }, values => { values[1].streamId = id(999); },
    values => { values[1].requestId = id(999); }, values => { values[1].providerRef = 'wrong'; },
    values => { values[0].payload.scope.environmentId = id(999); }, values => { values.pop(); },
    values => { values.push(structuredClone(values[0])); }, values => { values.push(structuredClone(values[1])); },
    values => { values[1].outcome.payload.sourceRevision.providerRef = 'wrong'; }
  ] as Array<(values: any[]) => void>) {
    const q = streamRequest(authority);
    const values = structuredClone(frames(q)); modify(values);
    const boundary = new CanonicalProviderBoundary({ providerRef: q.payload.providerRef });
    const result = authority ? boundary.authority(authorityProvider({ subscribeInvalidations: () => stream(values) })).subscribeInvalidations(q as M.AuthorityInvalidationRequest, context()) :
      boundary.capability(capabilityProvider({ subscribeInvalidations: () => stream(values) })).subscribeInvalidations(q as M.CapabilityInvalidationRequest, context());
    await assert.rejects(collect(result), failure('invalidResponse'));
  }
});

test('terminal is withheld when the provider hangs instead of closing; cancellation reaches provider cleanup', async () => {
  let seenSignal!: AbortSignal;
  const q = streamRequest() as M.CapabilityInvalidationRequest; q.deadlineAt = future(40);
  const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability' }).capability(capabilityProvider({ subscribeInvalidations: (_request, call) => {
    seenSignal = call.signal; const values = frames(q); let index = 0;
    return { [Symbol.asyncIterator]() { return { next: async () => index < 2 ? { done: false, value: values[index++]! } : new Promise(() => {}), return: async () => new Promise(() => {}) }; } };
  } }));
  const delivered = [];
  await assert.rejects(async () => { for await (const event of provider.subscribeInvalidations(q, context())) delivered.push(event); }, failure('timedOut'));
  assert.equal(delivered.length, 1); assert.ok(seenSignal.aborted);
});

test('stream scope is checked again when a consumer resumes after yielding a data frame', async () => {
  let current = true;
  const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability' }).capability(capabilityProvider());
  const iterator = provider.subscribeInvalidations(streamRequest() as M.CapabilityInvalidationRequest, { signal: new AbortController().signal, isCurrent: () => current })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.kind, 'data'); current = false;
  await assert.rejects(iterator.next(), failure('scopeChanged'));
});

test('dispatch cannot use stale, denied or differently bound governing evidence even with a permissive host hook', async () => {
  let calls = 0;
  const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.authority', admitDispatch: async () => true }).authority(authorityProvider({
    authorizeDispatch: async q => { calls++; return authority(q, 'authorized'); }
  }));
  for (const [field, value, code] of [
    ['invocationId', id(999), 'invalidRequest'], ['inputDigest', 'b'.repeat(64), 'invalidRequest'],
    ['scopeDigest', 'b'.repeat(64), 'invalidRequest'], ['disposition', 'denied', 'admissionRequired'],
    ['expiresAt', '2000-01-01T00:00:00Z', 'admissionRequired']
  ] as const) {
    const q = dispatchRequest(); (q.payload.requiredProviderDisposition as any)[field] = value;
    await assert.rejects(provider.authorizeDispatch(q, context()), failure(code));
  }
  assert.equal(calls, 0);
});

test('local Human decisions remain a separate variant bound to authenticated principal and checked grant revision', async () => {
  const q = dispatchRequest(); q.payload.grantId = id(21);
  const local = () => reply(q, { schemaVersion: '2.0.0', decisionId: id(22), kind: 'dispatch', disposition: 'authorized', reasonCode: 'authority_authorized',
    correlationId: q.correlationId, invocationId: q.payload.invocationId, principalId: id(20), assistantId: scope.assistantId, endpointId: scope.endpointId,
    environmentId: scope.environmentId, executionMode: q.executionMode, grantId: id(21), grantRevision: 1, snapshotId: q.payload.snapshotId,
    snapshotRevision: q.payload.snapshotRevision, authorityContextRef: scope.authorityContextRef, inputDigest: q.payload.inputDigest,
    scopeDigest: hash(q.payload.scope), evaluatedAt: now(), admittedAt: now()
  }, 'fixture.authority') as M.AuthorityDispatchResult;
  const provider = (principalId?: string, grantRevision = 1) => new CanonicalProviderBoundary({ providerRef: 'fixture.authority',
    ...(principalId ? { principalId } : {}), admitDispatch: async () => true }).authority(authorityProvider({ authorizeDispatch: async () => {
      const result = local(); (result.outcome.payload as any).grantRevision = grantRevision; return result;
    } }));
  assert.equal((await provider(id(20)).authorizeDispatch(q, context())).outcome.payload?.schemaVersion, '2.0.0');
  await assert.rejects(provider().authorizeDispatch(q, context()), failure('invalidResponse', true));
  await assert.rejects(provider(id(999)).authorizeDispatch(q, context()), failure('invalidResponse', true));
  await assert.rejects(provider(id(20), 2).authorizeDispatch(q, context()), failure('invalidResponse', true));
});

test('grant queries cannot return another Human, endpoint, session, environment or authority provider', async () => {
  const grant = () => ({ schemaVersion: '1.0.0', grantId: id(21), revision: 1, status: 'active', grantClass: 'allowSession', principalId: id(20),
    assistantId: scope.assistantId, endpointId: scope.endpointId, environmentId: scope.environmentId, authorityProviderRef: 'fixture.authority',
    scope: operationScope, sessionId: scope.sessionId, invocationId: null, inputDigest: null, issuedAt: now(), expiresAt: future(), reviewAfter: null,
    issuedBy: id(20), grantRequestId: id(23), authenticationEvidenceRef: 'urn:fixture:authentication', consumedDecisionId: null });
  for (const field of [null, 'principalId', 'assistantId', 'endpointId', 'sessionId', 'environmentId', 'authorityProviderRef', 'expiresAt', 'duplicate', 'limit']) {
    const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.authority', principalId: id(20) }).authority(authorityProvider({ getGrants: async q => {
      const item = grant();
      if (field && !['duplicate', 'limit'].includes(field)) (item as any)[field] = field === 'authorityProviderRef' ? 'other.authority' : field === 'expiresAt' ? '2000-01-01T00:00:00Z' : id(999);
      const grants = Array.from({ length: field === 'limit' ? 11 : field === 'duplicate' ? 2 : 1 }, (_value, index) => ({
        grant: { ...item, grantId: field === 'limit' ? id(100 + index) : item.grantId }, eligible: true, reason
      }));
      return reply(q, { grants, sourceRevision: { providerRef: 'fixture.authority', revision: '1', highWaterMark: null }, nextCursor: null }, 'fixture.authority') as M.GrantQueryResult;
    } }));
    if (field) await assert.rejects(provider.getGrants(grantsRequest(), context()), failure('invalidResponse'));
    else assert.equal((await provider.getGrants(grantsRequest(), context())).outcome.payload?.grants.length, 1);
  }
});

test('unknown capability outcomes and typed stream failures preserve evidence without retry or fabricated success', async () => {
  let invokes = 0;
  const provider = new CanonicalProviderBoundary({ providerRef: 'fixture.capability' }).capability(capabilityProvider({
    invoke: async q => { invokes++; return status(q); },
    getInvocation: async q => reply(q, { type: 'outcomeUnknown', invocationId: q.payload.invocationId, reason, receiptRef: ref,
      reconciliationRef: 'urn:fixture:reconcile' }) as M.CapabilityStatusResult,
    subscribeInvalidations: q => stream([{ ...frames(q)[1]!, sequence: 0, outcome: { status: 'failed', payload: null, error: {
      code: 'fixture.gap', message: 'Synthetic gap', retryable: false, correlationId: q.correlationId, details: []
    } } } as M.CapabilityInvalidationEvent])
  }));
  assert.equal((await provider.getInvocation(statusRequest(), context())).outcome.payload?.type, 'outcomeUnknown');
  const events = await collect(provider.subscribeInvalidations(streamRequest() as M.CapabilityInvalidationRequest, context()));
  assert.equal((events[0] as Extract<M.CapabilityInvalidationEvent, { kind: 'terminal' }>).outcome.status, 'failed');
  assert.equal(invokes, 0);
});

test('external permission summaries preserve current scope and cannot imply local lifecycle pages or mixed grants',async()=>{
 for(const change of [null,(v,q)=>v.externalSummary.executionEnvironmentRef='live',(v,q)=>v.externalSummary.scope.sessionId=id(999),(v,q)=>v.externalSummary.providerRef='other',(v,q)=>v.externalSummary.expiresAt='2000-01-01T00:00:00Z',(v,q)=>v.nextCursor='invented',(v,q)=>v.grants=[{}],(v,q)=>q.payload.states=['revoked'],(v,q)=>q.payload.page.cursor='invented']){
  const q=grantsRequest();
  const value={grants:[],nextCursor:null,sourceRevision:{providerRef:'fixture.authority',revision:'external-permission-generation',highWaterMark:null},externalSummary:{authorityKind:'externalSummary',providerRef:'fixture.authority',scope:structuredClone(q.scope),worldRef:'foreign.world',executionEnvironmentRef:'simulation',principalRef:'foreign.principal',siteRefs:['foreign.site'],capabilityRefs:['foreign.capability'],expiresAt:q.deadlineAt,evidenceRef:ref,limitations:['This is a current summary, not grant history.']}};
  change?.(value,q);
  const provider=new CanonicalProviderBoundary({providerRef:'fixture.authority'}).authority(authorityProvider({getGrants:async request=>reply(request,value,'fixture.authority') as M.GrantQueryResult}));
  if(change)await assert.rejects(provider.getGrants(q,context()),failure('invalidResponse'));else assert.equal((await provider.getGrants(q,context())).outcome.payload?.externalSummary?.principalRef,'foreign.principal');
 }
});
