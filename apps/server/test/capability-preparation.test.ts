import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@lifestream/storage-sqlite';
import type { CapabilityProvider } from '@lifestream/runtime/ports/provider-messages';
import { ConfiguredCapabilitySchemas, encodeCapabilitySchema } from '@lifestream/runtime/capabilities/schema-artifacts';
import { createLifestreamServer } from '../src/index.ts';
import { loadProfile } from '../src/config/loader.ts';
const envelope = (payload: unknown) => ({ schemaVersion: '1.0.0', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), payload });
const secret = () => `Synthetic-${randomBytes(24).toString('hex')}`;
async function setup(t: { after(callback: () => unknown): void }, configured = true) {
  const root = mkdtempSync(join(tmpdir(), 'ls-real-preparation-'));
  let now = Date.now(), allowed = true, deriveKind: 'validatedArguments' | 'inputBoundOnly' = 'validatedArguments', variant = 0, calls = 0, wait: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  const input = encodeCapabilitySchema('urn:synthetic:echo-input:1', { type: 'object', required: ['target','text'], additionalProperties: false, properties: { target: { enum: ['synthetic:one','synthetic:two'] }, text: { type: 'string', maxLength: 80 } } });
  const output = encodeCapabilitySchema('urn:synthetic:echo-output:1', { type: 'object', required: ['text'], properties: { text: { type: 'string' } }, additionalProperties: false });
  const schemas = new ConfiguredCapabilitySchemas([input, output], () => allowed), snapshots = new Map<string, any>();
  const provider: CapabilityProvider = {
    async getSnapshot(request) {
      entered?.(); if (wait) await wait;
      const key = JSON.stringify({ scope: request.scope, variant }); let snapshot = snapshots.get(key);
      if (!snapshot) { snapshot = { schemaVersion: '2.0.0', snapshotId: randomUUID(), revision: 1, assistantId: request.scope.assistantId, endpointId: request.scope.endpointId, sessionId: request.scope.sessionId, environmentId: request.scope.environmentId, authorityContextRef: request.scope.authorityContextRef,
        issuedAt: new Date(now - 100).toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), capabilities: [{ capabilityId: 'synthetic.echo', version: '1.0.0', inputSchemaRef: input.artifact.reference, outputSchemaRef: output.artifact.reference, sideEffectClass: 'reversible', authorization: 'approvalRequired', idempotency: 'required', latencyClass: 'interactive', offlineAvailable: true, simulationSupported: true, providerRouteRef: 'synthetic:echo-route' }] }; snapshots.set(key, snapshot); }
      return { schemaVersion: '1.0.0', operation: request.operation, requestId: request.requestId, correlationId: request.correlationId, providerRef: 'fixture', completedAt: new Date().toISOString(), outcome: { status: 'succeeded', payload: structuredClone(snapshot), error: null } };
    },
    async invoke() { calls++; throw new Error('Preparation must never invoke'); }, async getInvocation() { throw new Error('No invocation started'); },
    async *subscribeInvalidations() { throw new Error('No subscription in preparation fixture'); }
  };
  const config = loadProfile('test'); config.authority.authentication = 'local-password'; config.storage = { databasePath: join(root, 'data.sqlite'), artifactDirectory: join(root, 'artifacts') };
  const composition = { environmentId: randomUUID(), providerRef: 'fixture', provider, schemas, adapters: [{ capabilityId: 'synthetic.echo', version: '1.0.0', providerRouteRef: 'synthetic:echo-route', revision: '1', inputSchema: input.artifact, outputSchema: output.artifact,
    derive(args: unknown) { const value = args as { target: string; text: string }; return { scope: { capabilityId: 'synthetic.echo', capabilityVersion: '1.0.0', operation: 'echo', targetRefs: [value.target], dataScopeRefs: [] }, effectSummary: `Echo ${value.text.length} characters to ${value.target}.`, scopeDerivation: deriveKind }; } }] };
  const installerToken = secret(), localAuth = { stateDirectory: join(root, 'safety'), installerToken, now: () => now };
  let app = createLifestreamServer({ config, localAuth, ...(configured ? { canonicalCapabilities: composition } : {}) }); await app.start();
  const port = app.address().port, base = `http://127.0.0.1:${port}`, headers: Record<string, string> = { origin: base, 'content-type': 'application/json' };
  const send = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const session = await send('/api/auth/v1/setup', { username: 'owner', password: secret(), installerToken }); assert.equal(session.status, 201, JSON.stringify(session.body));
  headers.cookie = session.cookie!; headers['x-lifestream-csrf'] = session.body.session.csrfToken;
  const assistant = await send('/api/admin/v1/assistants', { displayName: 'Synthetic prepared capability' }); assert.equal(assistant.status, 201);
  const endpoint = await send('/api/runtime/v1/session-context', { expectedRevision: 0, mode: 'text', audienceScope: 'authenticatedSession' }); assert.equal(endpoint.status, 200);
  const db = new Database({ path: config.storage.databasePath });
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const path = `/api/authority/v1/assistants/${assistant.body.assistantId}/tools/synthetic.echo/prepare`;
  const body = () => ({ idempotencyKey: randomUUID(), capabilityVersion: '1.0.0', input: { target: 'synthetic:one', text: 'Some synthetic text' }, requestedClass: 'allowOnce', grantExpiresAt: new Date(now + 90_000).toISOString(), reviewAfter: null, expiresAt: new Date(now + 45_000).toISOString(), untrustedRationale: null });
  const create = async (prepared: any) => { const { environmentId: _environment, sideEffectClass: _effect, ...payload } = prepared.request; return send('/api/authority/v1/requests', envelope(payload)); };
  const approve = async (request: any) => send(`/api/authority/v1/requests/${request.requestId}/approve`, envelope({ requestId: request.requestId, expectedRevision: request.revision, confirmationDigest: request.confirmationDigest, grantClass: request.requestedClass, expiresAt: request.grantExpiresAt, reviewAfter: request.reviewAfter }));
  return { send, db, path, body, create, approve, calls: () => calls, headers, composition,
    changeProvider() { config.providers.capability = 'unavailable'; },
    advance(ms: number) { now += ms; }, denySchemas() { allowed = false; }, changeCatalog() { variant++; }, inputBoundOnly() { deriveKind = 'inputBoundOnly'; },
    block() { let release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); wait = new Promise<void>(resolve => { release = resolve; }); return { started, release }; },
    async restart() { await app.shutdown(); app = createLifestreamServer({ config, localAuth, port, ...(configured ? { canonicalCapabilities: composition } : {}) }); await app.start(); }
  };
}
const prepared = async (f: Awaited<ReturnType<typeof setup>>, body = f.body()) => { const result = await f.send(f.path, body); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.preparation; };

test('authenticated preparation validates real arguments and supplies the canonical request and approval', async t => {
  const f = await setup(t), p = await prepared(f);
  assert.deepEqual(p.request.scope.targetRefs, ['synthetic:one']); assert.equal(p.request.effectSummary, 'Echo 19 characters to synthetic:one.'); assert.equal(f.calls(), 0);
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_grants').get()!.count, 0);
  const created = await f.create(p); assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body.result.state, 'pending');
  const approved = await f.approve(created.body.result); assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.result.grant.status, 'active'); assert.equal(f.calls(), 0);
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_preparations').get()!.count, 1);
});
test('forged authority fields and schema-invalid inputs cannot become prepared invocations', async t => {
  const f = await setup(t);
  for (const extra of [{ endpointId: randomUUID() }, { scope: {} }, { effectSummary: 'Harmless' }, { inputDigest: '0'.repeat(64) }, { input: { target: 'synthetic:foreign', text: 'x' } }, { input: { target: 'synthetic:one', text: 'x', extra: true } }]) {
    const result = await f.send(f.path, { ...f.body(), ...extra }); assert.equal(result.status, 422, JSON.stringify(result.body));
  }
  assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_preparations').get()!.count, 0); assert.equal(f.calls(), 0);
});
test('identical and concurrent preparations retain one invocation; changed input conflicts', async t => {
  const f = await setup(t), body = f.body(); const results = await Promise.all([f.send(f.path, body), f.send(f.path, body)]);
  assert.ok(results.every(r => [200,201].includes(r.status)), JSON.stringify(results)); assert.equal(results[0]!.body.preparation.request.invocationId, results[1]!.body.preparation.request.invocationId);
  assert.equal((await f.send(f.path, body)).body.replayed, true);
  assert.equal((await f.send(f.path, { ...body, input: { target: 'synthetic:two', text: 'changed' } })).status, 409); assert.equal(f.calls(), 0);
});
test('changed catalog before approval prevents grant issuance', async t => {
  const f = await setup(t), p = await prepared(f), request = (await f.create(p)).body.result; f.changeCatalog();
  assert.equal((await f.approve(request)).status, 503); assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_grants').get()!.count, 0); assert.equal(f.calls(), 0);
});
test('schema access is required at preparation and again at approval', async t => {
  const f = await setup(t), p = await prepared(f), request = (await f.create(p)).body.result; f.denySchemas();
  assert.equal((await f.approve(request)).status, 503); assert.equal((await f.send(f.path, f.body())).status, 503); assert.equal(f.calls(), 0);
});
test('audience withdrawal during provider lookup prevents storing late preparation', async t => {
  const f = await setup(t), gate = f.block(); const pending = f.send(f.path, f.body()); await gate.started;
  assert.equal((await f.send('/api/runtime/v1/session-context', { expectedRevision: 1, mode: 'text', audienceScope: 'unknown' })).status, 200); gate.release();
  assert.notEqual((await pending).status, 201); assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_preparations').get()!.count, 0); assert.equal(f.calls(), 0);
});
test('expired preparations and corrupt retained bytes cannot produce requests', async t => {
  const f = await setup(t), p = await prepared(f);
  f.db.connection.prepare('UPDATE canonical_preparations SET payload_json=?').run('{}'); assert.equal((await f.create(p)).status, 503);
  const q = await prepared(f); f.advance(45_001); assert.equal((await f.create(q)).status, 503); assert.equal(f.calls(), 0);
});
test('input-bound adapters reject reusable terms and missing composition stays unavailable', async t => {
  const f = await setup(t); f.inputBoundOnly(); assert.equal((await f.send(f.path, { ...f.body(), requestedClass: 'allowSession' })).status, 422);
  assert.equal((await f.send(f.path, f.body())).status, 201);
  const missing = await setup(t, false); assert.equal((await missing.send(missing.path, missing.body())).status, 503);
});
test('restart preserves original preparation and request identity without dispatch', async t => {
  const f = await setup(t), body = f.body(), p = await prepared(f, body); await f.restart();
  const repeat = await f.send(f.path, body); assert.equal(repeat.status, 200, JSON.stringify(repeat.body)); assert.equal(repeat.body.preparation.request.invocationId, p.request.invocationId);
  const request = await f.create(p); assert.equal(request.status, 201, JSON.stringify(request.body)); assert.equal((await f.approve(request.body.result)).status, 200); assert.equal(f.calls(), 0);
});
test('CSRF and owner permissions protect preparation; a failed insert creates no invocation or grant', async t => {
  const f = await setup(t);
  assert.equal((await f.send(f.path, f.body(), { cookie: '' })).status, 401); assert.equal((await f.send(f.path, f.body(), { 'x-lifestream-csrf': 'wrong' })).status, 403);
  assert.equal((await f.send(f.path.replace(/assistants\/[^/]+/, 'assistants/' + randomUUID()), f.body())).status, 403);
  f.db.exec("CREATE TRIGGER preparation_failure BEFORE INSERT ON canonical_preparations BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");
  assert.equal((await f.send(f.path, f.body())).status, 503); assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_preparations').get()!.count, 0); assert.equal(f.calls(), 0);
});

test('changing the selected provider invalidates retained and in-flight local preparation', async t => {
  const f = await setup(t), p = await prepared(f); f.changeProvider();
  assert.equal((await f.create(p)).status, 503); assert.equal((await f.send(f.path, f.body())).status, 409); assert.equal(f.calls(), 0);
  const waiting = await setup(t), gate = waiting.block(), pending = waiting.send(waiting.path, waiting.body()); await gate.started; waiting.changeProvider(); gate.release();
  assert.notEqual((await pending).status, 201); assert.equal(waiting.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_preparations').get()!.count, 0);
});
