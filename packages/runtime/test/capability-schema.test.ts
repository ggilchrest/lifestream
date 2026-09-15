import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapabilityResolver } from '../src/capabilities/resolver.ts';
import { CapabilitySnapshotCache } from '../src/capabilities/cache.ts';
import { boundedJson, validateCapabilitySchema } from '../src/capabilities/schema-validation.ts';
import { FixtureCapabilityProvider } from '../../providers-fixture/src/capability/provider.ts';
import type { CapabilityCallContext, CapabilityDefinition, CapabilityInvocation } from '../src/capabilities/ports.ts';
const call = (): CapabilityCallContext => ({ requestId: 'request', correlationId: 'correlation', deadlineAt: new Date(Date.now() + 5000).toISOString(), executionMode: 'live', signal: new AbortController().signal, isCurrent: () => true });
const scope = { assistantId: 'assistant', endpointId: 'endpoint', sessionId: 'session', environment: 'test', authorityContextRef: { providerRef: 'fixture', contextId: '00000000-0000-4000-8000-000000000001', revision: 1 } };
const inputSchema = { type: 'object', additionalProperties: false, required: ['level', 'labels'], properties: { level: { type: 'number', minimum: 0, maximum: 1 }, labels: { type: 'array', maxItems: 2, uniqueItems: true, items: { type: 'string', enum: ['first', 'second'] } } } };
const definition: CapabilityDefinition = { id: 'fixture.action', version: '1.0.0', inputSchema, outputSchema: { type: 'object', additionalProperties: false, required: ['fixture'], properties: { fixture: { const: true } } }, sideEffect: 'reversible', authorization: 'required', idempotency: 'idempotent', latencyClass: 'fast', offlineAvailable: false, simulationSupported: false, route: 'fixture' };
const invocation = (input: unknown, id = 'invocation'): CapabilityInvocation => ({ ...scope, invocationId: id, interactionId: 'interaction', capabilityId: definition.id, capabilityVersion: definition.version, snapshotId: '00000000-0000-4000-8000-000000000017', snapshotRevision: 1, idempotencyKey: id, input });
function setup(capability = definition) {
  const provider = new FixtureCapabilityProvider([capability]);
  let admissions = 0;
  const resolver = new CapabilityResolver(provider, new CapabilitySnapshotCache(), async request => { admissions++; return { invocationId: request.invocationId, status: 'admitted', grantRevision: 1 }; });
  return { provider, resolver, admissions: () => admissions };
}

test('schema-invalid arguments never consume admission or reach a capability target', async () => {
  const e = setup();
  await e.resolver.snapshot(scope, call());
  const invalid = [null, {}, { level: '0.5', labels: [] }, { level: -1, labels: [] }, { level: 2, labels: [] }, { level: 0.5, labels: ['other'] }, { level: 0.5, labels: ['first', 'first'] }, { level: 0.5, labels: ['first', 'second', 'first'] }, { level: 0.5, labels: [], extra: true }];
  for (const [index, value] of invalid.entries()) assert.equal((await e.resolver.invoke(invocation(value, `invalid-${index}`), call())).lifecycle, 'denied');
  assert.equal(e.admissions(), 0);
  assert.equal(e.provider.invocationCount('invalid-0'), 0);
  const input = { level: 0.5, labels: ['first'] };
  assert.equal((await e.resolver.invoke(invocation(input), call())).lifecycle, 'succeeded');
  assert.deepEqual(input, { level: 0.5, labels: ['first'] });
  assert.equal(e.admissions(), 1);
});

test('lossy or oversized JSON inputs are rejected without coercion or hashing collisions', async () => {
  const e = setup();
  await e.resolver.snapshot(scope, call());
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'level', { enumerable: true, get() { getterCalls++; return 0.5; } });
  for (const [index, value] of [undefined, NaN, Infinity, 1n, cyclic, accessor, new Date(), { level: 0.5, labels: [], discarded: undefined }, 'x'.repeat(65_537), Array(3)].entries()) {
    assert.equal((await e.resolver.invoke(invocation(value, `lossy-${index}`), call())).lifecycle, 'denied');
  }
  assert.equal(getterCalls, 0);
  assert.equal(e.admissions(), 0);
});

test('schema references, nested arrays, formats and alternatives are actually validated', async () => {
  const signal = new AbortController().signal;
  const schema = { type: 'object', additionalProperties: false, required: ['items', 'mode', 'requestId'], $defs: { positive: { type: 'integer', minimum: 1 } }, properties: { items: { type: 'array', minItems: 1, items: { $ref: '#/$defs/positive' } }, mode: { oneOf: [{ const: 'first' }, { const: 'second' }] }, requestId: { type: 'string', format: 'uuid' } } };
  const value = { items: [1, 2], mode: 'first', requestId: scope.authorityContextRef.contextId };
  assert.equal(await validateCapabilitySchema(schema, value, signal), true);
  for (const changed of [{ items: [0] }, { items: [1.5] }, { items: [] }, { mode: 'third' }, { requestId: 'not-a-uuid' }]) assert.equal(await validateCapabilitySchema(schema, { ...value, ...changed }, signal), false);
});

test('malformed or unresolved schemas cannot enter a discovered snapshot', async () => {
  for (const schema of [{ type: 'made-up' }, { type: 'object', unknownKeyword: true }, { $ref: 'https://unconfigured.invalid/schema.json' }, { $async: true, type: 'object' }]) {
    const e = setup({ ...definition, inputSchema: schema });
    await assert.rejects(() => e.resolver.snapshot(scope, call()), /invalidResponse/);
    assert.equal((await e.resolver.invoke(invocation({ level: 0.5, labels: [] }), call())).lifecycle, 'denied');
    assert.equal(e.admissions(), 0);
  }
});

test('malformed successful output stays unknown and cannot cause a repeated effect', async () => {
  const e = setup();
  let count = 0;
  e.provider.invoke = async request => { count++; return { invocationId: request.invocationId, lifecycle: 'succeeded', output: { fixture: false, privateDetail: 'DO_NOT_DISCLOSE' } }; };
  await e.resolver.snapshot(scope, call());
  const request = invocation({ level: 0.5, labels: [] });
  const result = await e.resolver.invoke(request, call());
  assert.equal(result.lifecycle, 'outcomeUnknown');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_DISCLOSE/);
  assert.equal((await e.resolver.invoke(request, call())).lifecycle, 'outcomeUnknown');
  assert.equal(count, 1);
  assert.equal(e.admissions(), 1);
});

test('status lookup validates the original output schema and withholds malformed stored data', async () => {
  const e = setup(), request = invocation({ level: 0.5, labels: [] });
  await e.resolver.snapshot(scope, call());
  await e.resolver.invoke(request, call());
  const status = { ...scope, invocationId: request.invocationId };
  assert.equal((await e.resolver.getInvocation(status, call()))?.lifecycle, 'succeeded');
  e.provider.getInvocation = async () => ({ invocationId: request.invocationId, lifecycle: 'succeeded', output: { fixture: 'wrong' } });
  await assert.rejects(() => e.resolver.getInvocation(status, call()), /invalidResponse/);
  assert.equal((await e.resolver.invoke(request, call())).lifecycle, 'outcomeUnknown');
  assert.equal(e.admissions(), 1);
});

test('object key order does not change normalized invocation identity', async () => {
  const e = setup();
  await e.resolver.snapshot(scope, call());
  assert.equal((await e.resolver.invoke(invocation({ level: 0.5, labels: ['first'] }), call())).lifecycle, 'succeeded');
  assert.equal((await e.resolver.invoke(invocation({ labels: ['first'], level: 0.5 }), call())).lifecycle, 'succeeded');
  assert.equal(e.admissions(), 1);
  assert.equal(e.provider.invocationCount('invocation'), 1);
});

test('invalid result fields and unknown status output cannot escape the declared result boundary', async () => {
  const e = setup();
  e.provider.invoke = async request => ({ invocationId: request.invocationId, lifecycle: 'outcomeUnknown', output: { privateDetail: 'DO_NOT_DISCLOSE' } });
  await e.resolver.snapshot(scope, call());
  const result = await e.resolver.invoke(invocation({ level: 0.5, labels: [] }), call());
  assert.equal(result.lifecycle, 'outcomeUnknown');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_DISCLOSE/);
});

test('caller cancellation interrupts schema work and a later validator request can recover', async () => {
  const controller = new AbortController();
  const result = validateCapabilitySchema({ type: 'string', pattern: '^(a+)+$' }, 'a'.repeat(100) + '!', controller.signal);
  setTimeout(() => controller.abort(), 50);
  assert.equal(await result, false);
  assert.equal(await validateCapabilitySchema({ type: 'number' }, 1, new AbortController().signal), true);
});

test('pathological schema execution is bounded without blocking the conversation event loop', async () => {
  let heartbeat = false;
  const signal = new AbortController().signal;
  const result = validateCapabilitySchema({ type: 'string', pattern: '^(a+)+$' }, 'a'.repeat(100) + '!', signal);
  const timer = setTimeout(() => { heartbeat = true; }, 30);
  try { assert.equal(await result, false); assert.equal(heartbeat, true); }
  finally { clearTimeout(timer); }
  assert.equal(await validateCapabilitySchema({ type: 'boolean' }, false, signal), true);
});

test('JSON bounds preserve false, null and shared data while rejecting cycles and excess depth', () => {
  const shared = { value: false };
  assert.equal(boundedJson({ first: shared, second: shared, none: null }), true);
  let deep: unknown = null;
  for (let index = 0; index < 40; index++) deep = { child: deep };
  assert.equal(boundedJson(deep), false);
  const sparse = Object.assign(Array(1), { extra: true });
  assert.equal(boundedJson(sparse), false);
});

test('failed refreshed schema discovery cannot fall back to a previous valid snapshot', async () => {
  const e = setup();
  await e.resolver.snapshot(scope, call());
  const original = e.provider.getSnapshot.bind(e.provider);
  e.provider.getSnapshot = async (request, context) => ({ ...await original(request, context), capabilities: [{ ...definition, inputSchema: { type: 'invalid-type' } }] });
  await assert.rejects(() => e.resolver.snapshot(scope, call()), /invalidResponse/);
  assert.equal((await e.resolver.invoke(invocation({ level: 0.5, labels: [] }), call())).lifecycle, 'denied');
  assert.equal(e.admissions(), 0);
});
