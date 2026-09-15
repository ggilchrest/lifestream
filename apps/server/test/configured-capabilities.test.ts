import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixtureCapabilities } from '../src/composition/fixture-capabilities.ts';
import { CanonicalProviderBoundary } from '@lifestream/runtime/ports/provider-boundary';
import type { CapabilityInvalidationRequest } from '@lifestream/contracts/provider-messages';
import { setup, prepared } from './fixtures/canonical-capability.ts';

const authorize = async (f: Awaited<ReturnType<typeof setup>>) => {
  const body = f.body(), preparation = await prepared(f, body), created = await f.create(preparation);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const approved = await f.approve(created.body.result); assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { preparation, grant: approved.body.result.grant, key: body.idempotencyKey };
};
const toolsPath = (f: Awaited<ReturnType<typeof setup>>) => f.path.replace('/synthetic.echo/prepare', '');

test('selected fixture startup exposes a scoped canonical catalog without injection or dispatch', async t => {
  const f = await setup(t, 'startup'), result = await f.send(toolsPath(f));
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.protocol, 'canonical');
  assert.equal(result.body.providerRef, 'fixture'); assert.equal(result.body.tools[0].capabilityId, 'synthetic.echo');
  assert.deepEqual(result.body.tools[0].inputSchema.properties.target.enum, ['synthetic:one','synthetic:two']);
  assert.equal(result.body.grantsAuthority, false); assert.equal(result.body.dispatchStarted, false);
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_dispatch_admissions').get()!.count, 0);
  assert.equal((await f.send(toolsPath(f), undefined, { cookie: '' })).status, 401);
  assert.equal((await f.send(toolsPath(f).replace(/assistants\/[^/]+/, 'assistants/' + randomUUID()))).status, 403);
});

test('configured fixture traverses preparation, actual Human grant, final admission and durable result', async t => {
  const f = await setup(t, 'startup'), { preparation, grant, key } = await authorize(f);
  const path = toolsPath(f) + `/invocations/${preparation.request.invocationId}`;
  const command = { grantId: grant.grantId, idempotencyKey: key };
  const dispatched = await f.send(path + '/dispatch', command);
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body)); assert.equal(dispatched.body.status, 'succeeded');
  assert.deepEqual(dispatched.body.result.outcome.payload.output, { text: 'Some synthetic text', fixture: true });
  const repeated = await f.send(path + '/dispatch', command);
  assert.equal(repeated.status, 200); assert.equal(repeated.body.replayed, true);
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_dispatch_claims').get()!.count, 1);
  await f.restart();
  const retained = await f.send(path); assert.equal(retained.status, 200, JSON.stringify(retained.body));
  assert.equal(retained.body.status, 'succeeded'); assert.deepEqual(retained.body.result, dispatched.body.result);
  assert.equal((await f.send(path + '/dispatch', command)).body.replayed, true);
});

test('configured catalog and prepared environment survive restart but another deployment is distinct', async t => {
  const f = await setup(t, 'startup'), original = await f.send(toolsPath(f)), input = f.body(), p = await prepared(f, input);
  await f.restart(); const next = await f.send(toolsPath(f));
  assert.equal(next.body.environmentId, original.body.environmentId);
  const repeated = await f.send(f.path, input); assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.preparation.request.invocationId, p.request.invocationId);
  const other = await setup(t, 'startup'); assert.notEqual((await other.send(toolsPath(other))).body.environmentId, original.body.environmentId);
});

test('configured fixture rejects unsupported arguments and audience withdrawal', async t => {
  const f = await setup(t, 'startup');
  for (const input of [{ target: 'light.real', text: 'test' }, { target: 'synthetic:one', text: 'x'.repeat(81) }, { target: 'synthetic:one', text: 'test', host: 'untrusted' }]) assert.equal((await f.send(f.path, { ...f.body(), input })).status, 422);
  assert.equal((await f.send('/api/runtime/v1/session-context', { expectedRevision: 1, mode: 'text', audienceScope: 'unknown' })).status, 200);
  assert.notEqual((await f.send(toolsPath(f))).status, 200);
  assert.notEqual((await f.send(f.path, f.body())).status, 201);
});

test('changing selected provider fences the configured fixture catalog and preparation', async t => {
  const f = await setup(t, 'startup'); f.changeProvider();
  assert.notEqual((await f.send(toolsPath(f))).status, 200);
  assert.notEqual((await f.send(f.path, f.body())).status, 201);
});

test('configured fixture catalog reuses one current snapshot and rejects damaged custody', async t => {
  const f = await setup(t, 'startup');
  const first = await f.send(toolsPath(f)); assert.equal(first.status, 200);
  assert.equal((await f.send(toolsPath(f))).status, 200);
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM fixture_capability_snapshots').get()!.count, 1);
  f.db.connection.prepare("UPDATE fixture_capability_snapshots SET payload_json='{}'").run();
  assert.notEqual((await f.send(toolsPath(f))).status, 200);
  assert.notEqual((await f.send(f.path, f.body())).status, 201);
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_dispatch_admissions').get()!.count, 0);
});

test('configured fixture cannot dispatch a prepared request without its actual Human grant', async t => {
  const f = await setup(t, 'startup'), body = f.body(), preparation = await prepared(f, body);
  const path = toolsPath(f) + `/invocations/${preparation.request.invocationId}/dispatch`;
  assert.notEqual((await f.send(path, { grantId: randomUUID(), idempotencyKey: body.idempotencyKey })).status, 200);
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_dispatch_claims').get()!.count, 0);
});

test('configured fixture preserves the schema character limit for Unicode input', async t => {
  const f = await setup(t, 'startup'), body = { ...f.body(), input: { target: 'synthetic:two', text: '🦊'.repeat(80) } };
  const preparation = await prepared(f, body), created = await f.create(preparation);
  assert.equal(created.status, 201); const approved = await f.approve(created.body.result); assert.equal(approved.status, 200);
  const result = await f.send(toolsPath(f) + `/invocations/${preparation.request.invocationId}/dispatch`, { grantId: approved.body.result.grant.grantId, idempotencyKey: body.idempotencyKey });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.status, 'succeeded');
  assert.equal(result.body.result.outcome.payload.output.text, body.input.text);
});


test('configured static fixture emits a scoped gap and a valid finite terminal without pretending to resume history', async t => {
  const f = await setup(t, 'startup'); await prepared(f);
  const record = JSON.parse(f.db.connection.prepare('SELECT payload_json FROM canonical_preparations').get()!.payload_json as string);
  const composition = createFixtureCapabilities(f.db, () => true), controller = new AbortController();
  const request: CapabilityInvalidationRequest = { schemaVersion: '1.0.0', operation: 'CapabilityProvider.subscribeInvalidations', requestId: randomUUID(), correlationId: randomUUID(), cancellationId: randomUUID(), executionMode: 'normal', scope: record.scope, idempotencyKey: null, deadlineAt: new Date(Date.now() + 5000).toISOString(), payload: { providerRef: 'fixture', afterSequence: 15, sourceRevision: null } };
  const stream = new CanonicalProviderBoundary({ providerRef: 'fixture' }).capability(composition.provider).subscribeInvalidations(request, { signal: controller.signal, isCurrent: () => true });
  const events = []; for await (const event of stream) events.push(event);
  assert.equal(events.length, 2); assert.equal(events[0]!.kind, 'data');
  if (events[0]!.kind === 'data') { assert.equal(events[0]!.payload.reason, 'gap'); assert.deepEqual(events[0]!.payload.scope, record.scope); }
  assert.equal(events[1]!.kind, 'terminal');
  if (events[1]!.kind === 'terminal') assert.equal(events[1]!.outcome.status, 'succeeded');
});


test('prepared action inspection preserves exact input and retry key through approval and restart without dispatch', async t => {
  const f = await setup(t, 'startup'), input = f.body(), p = await prepared(f, input);
  const path = toolsPath(f) + `/invocations/${p.request.invocationId}/preparation`;
  const inspect = async () => {
    const r = await f.send(path); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.preparation, p); assert.deepEqual(r.body.input, input.input);
    assert.equal(r.body.idempotencyKey, input.idempotencyKey); assert.equal(r.body.grantsAuthority, false);
    assert.equal(r.body.dispatchStarted, false); assert.equal(r.body.inputSchema.type, 'object');
    assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_dispatch_claims').get()!.count, 0);
    return r.body;
  };
  await inspect(); const created = await f.create(p); await f.approve(created.body.result);
  await f.restart(); await inspect();
  assert.equal((await f.send(path, undefined, { cookie: '' })).status, 401);
  assert.equal((await f.send(path + '?input=override')).status, 422);
  assert.equal((await f.send(path, {})).status, 405);
  assert.equal((await f.send(path.replace(p.request.invocationId, randomUUID()))).status, 404);
  assert.equal((await f.send(path.replace(p.request.assistantId, randomUUID()))).status, 403);
  await f.send('/api/runtime/v1/session-context', { expectedRevision: 1, mode: 'text', audienceScope: 'unknown' });
  assert.notEqual((await f.send(path)).status, 200);
});

test('prepared action inspection refuses withdrawn schema access and provider changes', async t => {
  const f = await setup(t), p = await prepared(f);
  const path = toolsPath(f) + `/invocations/${p.request.invocationId}/preparation`;
  assert.equal((await f.send(path)).status, 200); f.denySchemas();
  assert.notEqual((await f.send(path)).status, 200);
  const other = await setup(t, 'startup'), q = await prepared(other); other.changeProvider();
  assert.notEqual((await other.send(toolsPath(other) + `/invocations/${q.request.invocationId}/preparation`)).status, 200);
});


test('prepared arguments belong to their original session even for a second login by the same Owner', async t => {
  const f = await setup(t, 'startup'), p = await prepared(f), path = toolsPath(f) + `/invocations/${p.request.invocationId}/preparation`;
  const second = await f.signInAgain(); assert.equal(second.status, 200);
  const headers = { cookie: second.cookie!, 'x-lifestream-csrf': second.body.session.csrfToken };
  assert.equal((await f.send('/api/runtime/v1/session-context', { expectedRevision: 0, mode: 'text', audienceScope: 'authenticatedSession' }, headers)).status, 200);
  assert.equal((await f.send(path, undefined, headers)).status, 404);
  assert.equal((await f.send(path)).status, 200);
});
