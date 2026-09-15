import { createHash } from 'node:crypto';
import { createContractValidator } from '@lifestream/contracts';
import type * as M from '@lifestream/contracts/provider-messages';
import type { AuthorityProvider, CapabilityProvider, ProviderCallContext } from './provider-messages.js';
import { boundedJson, canonicalJson } from '../capabilities/schema-validation.ts';

type Request = M.CapabilitySnapshotRequest | M.CapabilityInvocationRequest | M.CapabilityStatusRequest |
  M.AuthorityRequest | M.AuthorityDispatchRequest | M.GrantQueryRequest;
type Result = M.CapabilitySnapshotResult | M.CapabilityInvocationResult | M.CapabilityStatusResult |
  M.AuthorityResult | M.AuthorityDispatchResult | M.GrantQueryResult;
type StreamRequest = M.CapabilityInvalidationRequest | M.AuthorityInvalidationRequest;
type Event = M.CapabilityInvalidationEvent | M.AuthorityInvalidationEvent;
type Outcome = Result['outcome'] | Extract<Event, { kind: 'terminal' }>['outcome'];
const schemaBase = 'https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/';
const definitions = {
  'CapabilityProvider.getSnapshot': ['CapabilitySnapshotRequest', 'CapabilitySnapshotResult'],
  'CapabilityProvider.invoke': ['CapabilityInvocationRequest', 'CapabilityInvocationResult'],
  'CapabilityProvider.getInvocation': ['CapabilityStatusRequest', 'CapabilityStatusResult'],
  'AuthorityProvider.evaluate': ['AuthorityRequest', 'AuthorityResult'],
  'AuthorityProvider.authorizeDispatch': ['AuthorityDispatchRequest', 'AuthorityDispatchResult'],
  'AuthorityProvider.getGrants': ['GrantQueryRequest', 'GrantQueryResult'],
  'CapabilityProvider.subscribeInvalidations': ['CapabilityInvalidationRequest', 'CapabilityInvalidationEvent'],
  'AuthorityProvider.subscribeInvalidations': ['AuthorityInvalidationRequest', 'AuthorityInvalidationEvent']
} as const;
const validator = createContractValidator();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export class ProviderBoundaryError extends Error {
  readonly code: 'invalidRequest' | 'invalidResponse' | 'timedOut' | 'cancelled' | 'scopeChanged' | 'unavailable' | 'admissionRequired';
  /** Local failure after calling an effect-bearing method is never proof of rollback. */
  readonly effectMayHaveStarted: boolean;
  constructor(code: ProviderBoundaryError['code'], effectMayHaveStarted = false) {
    super(`Provider boundary ${code}`);
    this.code = code;
    this.effectMayHaveStarted = effectMayHaveStarted;
  }
}
function requireTrue(condition: unknown, code: ProviderBoundaryError['code'] = 'invalidResponse'): asserts condition {
  if (!condition) throw new ProviderBoundaryError(code);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function message<T>(value: T, definition: string, request = false): T {
  const code = request ? 'invalidRequest' : 'invalidResponse';
  requireTrue(boundedJson(value, 1_048_576), code);
  const copy = structuredClone(value);
  requireTrue(validator.validate(schemaBase + definition, copy).valid, code);
  return freeze(copy);
}

/** Admission checks are trusted host functions, not fields that a browser can set.
 * They must resolve the pinned catalog/input/evidence and current policy. The
 * envelope validator deliberately cannot grant authority from an ArtifactRef.
 */
export interface ProviderBoundaryOptions {
  providerRef: string;
  maxDurationMs?: number;
  principalId?: string;
  admitInvocation?: (request: M.CapabilityInvocationRequest, context: ProviderCallContext) => Promise<boolean>;
  admitDispatch?: (request: M.AuthorityDispatchRequest, context: ProviderCallContext) => Promise<boolean>;
}

class Call {
  readonly context: ProviderCallContext;
  readonly request: Request | StreamRequest;
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private deadline: number;
  private monotonicDeadline: number;
  constructor(request: Request | StreamRequest, context: ProviderCallContext, maxDurationMs: number) {
    this.request = request;
    this.deadline = Date.parse(request.deadlineAt);
    const remaining = this.deadline - Date.now();
    requireTrue(Number.isFinite(remaining) && remaining <= maxDurationMs, 'invalidRequest');
    this.monotonicDeadline = performance.now() + Math.max(0, remaining);
    this.context = Object.freeze({ signal: AbortSignal.any([context.signal, this.controller.signal]), isCurrent: context.isCurrent });
    this.timer = setTimeout(() => this.controller.abort(), Math.max(1, remaining));
  }
  check(): void {
    requireTrue(Date.now() < this.deadline && performance.now() < this.monotonicDeadline, 'timedOut');
    requireTrue(!this.context.signal.aborted, 'cancelled');
    let current = false;
    try { current = this.context.isCurrent(this.request.scope); } catch { /* fail closed */ }
    requireTrue(current, 'scopeChanged');
  }
  async wait<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    let abort = () => {};
    try {
      const value = await Promise.race([
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new ProviderBoundaryError(this.controller.signal.aborted ? 'timedOut' : 'cancelled'));
          this.context.signal.addEventListener('abort', abort, { once: true });
          if (this.context.signal.aborted) abort();
        }),
        Promise.resolve().then(() => { this.check(); return action(); })
      ]);
      this.check();
      return value;
    } finally { this.context.signal.removeEventListener('abort', abort); }
  }
  close(): void { clearTimeout(this.timer); this.controller.abort(); }
}

function problem(outcome: Outcome, correlationId: string): void {
  if (outcome.status === 'succeeded') return;
  requireTrue(outcome.error.correlationId === correlationId);
  requireTrue(!outcome.error.retryable || outcome.status === 'retryableFailure');
}
function fieldsMatch(value: object, source: object, fields: string[]): void {
  for (const field of fields) requireTrue(same((value as Record<string, unknown>)[field], (source as Record<string, unknown>)[field]));
}
function resultBinding(request: Request, result: Result, options: Readonly<ProviderBoundaryOptions>): void {
  fieldsMatch(result, request, ['operation', 'requestId', 'correlationId']);
  requireTrue(result.providerRef === options.providerRef);
  requireTrue(Date.parse(result.completedAt) <= Math.min(Date.now(), Date.parse(request.deadlineAt)));
  problem(result.outcome, request.correlationId);
  if (result.outcome.status !== 'succeeded') return;
  // Narrow both discriminators. Schema validation already fixed the method's
  // exact payload union; none of these checks interprets transport as approval.
  if (request.operation === 'CapabilityProvider.getSnapshot' && result.operation === request.operation) {
    const value = result.outcome.payload;
    fieldsMatch(value, request.scope, ['assistantId', 'environmentId', 'endpointId', 'sessionId', 'authorityContextRef']);
    requireTrue(Date.parse(value.issuedAt) <= Date.now() && Date.parse(value.expiresAt) > Date.now());
    const keys = value.capabilities.map(capability => `${capability.capabilityId}@${capability.version}`);
    requireTrue(new Set(keys).size === keys.length);
  } else if ((request.operation === 'CapabilityProvider.invoke' || request.operation === 'CapabilityProvider.getInvocation') &&
    (result.operation === 'CapabilityProvider.invoke' || result.operation === 'CapabilityProvider.getInvocation')) {
    const value = result.outcome.payload;
    requireTrue(value.invocationId === request.payload.invocationId);
    if (value.type === 'failed') requireTrue(value.error.correlationId === request.correlationId && !value.error.retryable);
    if (value.type === 'succeeded') requireTrue(Date.parse(value.confirmedAt) <= Date.parse(result.completedAt));
    if (value.type === 'started') requireTrue(Date.parse(value.startedAt) <= Date.parse(result.completedAt));
  } else if ((request.operation === 'AuthorityProvider.evaluate' || request.operation === 'AuthorityProvider.authorizeDispatch') &&
    (result.operation === 'AuthorityProvider.evaluate' || result.operation === 'AuthorityProvider.authorizeDispatch')) {
    const value = result.outcome.payload;
    fieldsMatch(value, request, ['correlationId', 'executionMode']);
    fieldsMatch(value, request.payload, ['invocationId', 'inputDigest', 'snapshotId', 'snapshotRevision']);
    requireTrue(same(value.authorityContextRef, request.scope.authorityContextRef));
    requireTrue(value.scopeDigest === digest(request.payload.scope));
    requireTrue(Date.parse(value.evaluatedAt) <= Date.parse(result.completedAt));
    if (value.admittedAt !== null) requireTrue(Date.parse(value.admittedAt) <= Date.parse(result.completedAt));
    if (value.schemaVersion === '1.0.0') {
      requireTrue(value.providerRef === options.providerRef && same(value.scope, request.scope));
      requireTrue(Date.parse(value.expiresAt) > Date.now());
    } else {
      requireTrue(options.principalId !== undefined && value.principalId === options.principalId);
      fieldsMatch(value, request.scope, ['assistantId', 'environmentId', 'endpointId']);
      requireTrue(value.grantId === request.payload.grantId);
      if (request.operation === 'AuthorityProvider.authorizeDispatch' && value.disposition === 'authorized') {
        requireTrue(value.grantRevision === request.payload.expectedGrantRevision);
      }
    }
  } else if (request.operation === 'AuthorityProvider.getGrants' && result.operation === request.operation) {
    const value = result.outcome.payload;
    requireTrue(value.sourceRevision.providerRef === options.providerRef);
    requireTrue(value.grants.length <= request.payload.page.limit);
    requireTrue(new Set(value.grants.map(item => item.grant.grantId)).size === value.grants.length);
    for (const item of value.grants) {
      requireTrue(options.principalId !== undefined && item.grant.principalId === options.principalId);
      fieldsMatch(item.grant, request.scope, ['assistantId', 'environmentId', 'endpointId']);
      requireTrue(item.grant.authorityProviderRef === options.providerRef);
      requireTrue(item.grant.sessionId === null || item.grant.sessionId === request.scope.sessionId);
      requireTrue(!request.payload.states.length || request.payload.states.includes(item.grant.status));
      if (item.eligible) requireTrue(item.grant.status === 'active' && Date.parse(item.grant.issuedAt) <= Date.now() &&
        Date.parse(item.grant.expiresAt) > Date.now() && (item.grant.reviewAfter === null || Date.parse(item.grant.reviewAfter) > Date.now()));
    }
  }
}

export class CanonicalProviderBoundary {
  private readonly options: Readonly<ProviderBoundaryOptions>;
  constructor(options: ProviderBoundaryOptions) {
    const maxDurationMs = options.maxDurationMs ?? 30_000;
    requireTrue(typeof options.providerRef === 'string' && options.providerRef.length > 0 && options.providerRef.length <= 500, 'invalidRequest');
    requireTrue(Number.isInteger(maxDurationMs) && maxDurationMs > 0 && maxDurationMs <= 2_147_483_647, 'invalidRequest');
    this.options = Object.freeze({ ...options, maxDurationMs });
  }
  private async unary<Q extends Request, R extends Result>(operation: Q['operation'], input: Q, context: ProviderCallContext,
    action: (request: Q, context: ProviderCallContext) => Promise<R>): Promise<R> {
    const request = message(input, definitions[operation][0], true);
    const call = new Call(request, context, this.options.maxDurationMs!);
    let effectMayHaveStarted = false;
    try {
      call.check();
      if (request.operation.startsWith('AuthorityProvider.')) {
        requireTrue(request.scope.authorityContextRef?.providerRef === this.options.providerRef, 'invalidRequest');
      }
      if (request.operation === 'CapabilityProvider.invoke') {
        requireTrue(request.payload.capabilityId === request.payload.operationScope.capabilityId &&
          request.payload.capabilityVersion === request.payload.operationScope.capabilityVersion &&
          request.payload.inputDigest === digest(request.payload.input), 'invalidRequest');
        const admit = this.options.admitInvocation;
        requireTrue(admit, 'admissionRequired');
        requireTrue(await call.wait(() => admit(request, call.context)), 'admissionRequired');
      }
      if (request.operation === 'AuthorityProvider.authorizeDispatch') {
        const disposition = request.payload.requiredProviderDisposition;
        requireTrue(disposition.invocationId === request.payload.invocationId && disposition.inputDigest === request.payload.inputDigest &&
          disposition.scopeDigest === digest(request.payload.scope) && same(disposition.authorityContextRef, request.scope.authorityContextRef), 'invalidRequest');
        requireTrue(disposition.disposition === 'authorized' && Date.parse(disposition.evaluatedAt) <= Date.now() &&
          Date.parse(disposition.expiresAt) > Date.now(), 'admissionRequired');
        const admit = this.options.admitDispatch;
        requireTrue(admit, 'admissionRequired');
        requireTrue(await call.wait(() => admit(request, call.context)), 'admissionRequired');
      }
      const raw = await call.wait(() => {
        effectMayHaveStarted = request.operation === 'CapabilityProvider.invoke' || request.operation === 'AuthorityProvider.authorizeDispatch';
        return action(request, call.context);
      });
      const result = message(raw, definitions[operation][1]);
      resultBinding(request, result, this.options);
      call.check();
      return result;
    } catch (error) {
      throw new ProviderBoundaryError(error instanceof ProviderBoundaryError ? error.code : 'unavailable', effectMayHaveStarted);
    } finally { call.close(); }
  }
  private async *stream<Q extends StreamRequest, E extends Event>(operation: Q['operation'], input: Q, context: ProviderCallContext,
    action: (request: Q, context: ProviderCallContext) => AsyncIterable<E>): AsyncGenerator<E> {
    const request = message(input, definitions[operation][0], true);
    const call = new Call(request, context, this.options.maxDurationMs!);
    let iterator: AsyncIterator<E> | undefined;
    try {
      call.check();
      requireTrue(request.payload.providerRef === this.options.providerRef, 'invalidRequest');
      if (request.operation === 'AuthorityProvider.subscribeInvalidations') {
        requireTrue(request.scope.authorityContextRef?.providerRef === this.options.providerRef, 'invalidRequest');
      }
      requireTrue(request.payload.sourceRevision === null || request.payload.sourceRevision.providerRef === this.options.providerRef, 'invalidRequest');
      iterator = action(request, call.context)[Symbol.asyncIterator]();
      let sequence = 0, streamId: string | undefined;
      while (true) {
        const next = await call.wait(() => iterator!.next());
        requireTrue(!next.done); // EOF without a terminal is a failed stream.
        const event = message(next.value, definitions[operation][1]);
        fieldsMatch(event, request, ['operation', 'requestId', 'correlationId']);
        requireTrue(event.providerRef === this.options.providerRef && event.sequence === sequence++);
        streamId ??= event.streamId;
        requireTrue(event.streamId === streamId && Date.parse(event.occurredAt) <= Math.min(Date.now(), Date.parse(request.deadlineAt)));
        if (event.kind === 'data') {
          requireTrue(same(event.payload.scope, request.scope));
          requireTrue(event.payload.occurredAt === event.occurredAt);
          if ('authorityContextRef' in event.payload) {
            requireTrue(event.payload.providerRef === this.options.providerRef && same(event.payload.authorityContextRef, request.scope.authorityContextRef));
          }
          call.check();
          yield event;
        } else {
          problem(event.outcome, request.correlationId);
          if (event.outcome.status === 'succeeded') {
            // lastSequence names the last data frame, or zero for an empty stream.
            requireTrue(event.outcome.payload.lastSequence === Math.max(0, event.sequence - 1));
            requireTrue(event.outcome.payload.sourceRevision === null || event.outcome.payload.sourceRevision.providerRef === this.options.providerRef);
          }
          // Withhold terminal success until EOF proves there is no second
          // terminal or late data. This wait uses the same finite deadline.
          requireTrue((await call.wait(() => iterator!.next())).done);
          call.check();
          yield event;
          return;
        }
      }
    } catch (error) {
      throw new ProviderBoundaryError(error instanceof ProviderBoundaryError ? error.code : 'unavailable');
    } finally {
      call.close();
      // A broken provider's return() must not keep cancellation waiting forever.
      try { if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* already closed */ }
    }
  }
  capability(provider: CapabilityProvider): CapabilityProvider {
    return {
      getSnapshot: (q, c) => this.unary('CapabilityProvider.getSnapshot', q, c, (r, context) => provider.getSnapshot(r, context)),
      invoke: (q, c) => this.unary('CapabilityProvider.invoke', q, c, (r, context) => provider.invoke(r, context)),
      getInvocation: (q, c) => this.unary('CapabilityProvider.getInvocation', q, c, (r, context) => provider.getInvocation(r, context)),
      subscribeInvalidations: (q, c) => this.stream('CapabilityProvider.subscribeInvalidations', q, c, (r, context) => provider.subscribeInvalidations(r, context))
    };
  }
  authority(provider: AuthorityProvider): AuthorityProvider {
    return {
      evaluate: (q, c) => this.unary('AuthorityProvider.evaluate', q, c, (r, context) => provider.evaluate(r, context)),
      authorizeDispatch: (q, c) => this.unary('AuthorityProvider.authorizeDispatch', q, c, (r, context) => provider.authorizeDispatch(r, context)),
      getGrants: (q, c) => this.unary('AuthorityProvider.getGrants', q, c, (r, context) => provider.getGrants(r, context)),
      subscribeInvalidations: (q, c) => this.stream('AuthorityProvider.subscribeInvalidations', q, c, (r, context) => provider.subscribeInvalidations(r, context))
    };
  }
}
