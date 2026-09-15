import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLifestreamServer } from '../src/index.ts';
import { loadProfile } from '../src/config/loader.ts';
import { FixtureCapabilityProvider } from '../../../packages/providers-fixture/src/capability/provider.ts';
import { Database } from '@lifestream/storage-sqlite';
import type { CapabilityDefinition } from '../../../packages/runtime/src/capabilities/ports.ts';

const capability: CapabilityDefinition = { id: 'synthetic.echo', version: '1.0.0', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  outputSchema: { type: 'object' }, sideEffect: 'reversible', authorization: 'required', idempotency: 'idempotent', latencyClass: 'fast',
  offlineAvailable: true, simulationSupported: true, route: 'synthetic-fixture' };
async function setup(t: { after(callback: () => unknown): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'ls-tool-retry-'));
  const config = loadProfile('test'); config.authority.authentication = 'local-password';
  config.storage = { databasePath: join(directory, 'db.sqlite'), artifactDirectory: join(directory, 'artifacts') };
  let schemaAccess = true;
  const installerToken = randomBytes(24).toString('hex'), schemas = FixtureCapabilityProvider.schemaArtifacts([capability], () => schemaAccess);
  const provider = new FixtureCapabilityProvider([capability], schemas);
  const options = { config, capabilityProvider: provider, capabilitySchemas: schemas, localAuth: { stateDirectory: join(directory, 'safety'), installerToken } };
  const app = createLifestreamServer(options); await app.start();
  t.after(async () => { await app.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`, headers: Record<string, string> = { origin: base, 'content-type': 'application/json' };
  const request = (path: string, body?: unknown) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const enrolled = await request('/api/auth/v1/setup', { username: 'owner', password: randomBytes(24).toString('hex'), installerToken });
  headers.cookie = enrolled.headers.get('set-cookie')!.split(';')[0]!;
  headers['x-lifestream-csrf'] = ((await enrolled.json()) as any).session.csrfToken;
  const assistant = await (await request('/api/admin/v1/assistants', { displayName: 'Synthetic retry test' })).json() as any;
  const path = `/api/authority/v1/assistants/${assistant.assistantId}`;
  const grant = (await (await request(path + '/grants', { scope: [capability.id], durationMode: 'allowPersistent', durationSeconds: 3600 })).json() as any).grant;
  assert.equal((await request(path + `/grants/${grant.id}/decision`, { expectedRevision: 1, decision: 'active' })).status, 200);
  return { app, provider, request, path, grantId: grant.id, options, headers, directory, setSchemaAccess: (allowed: boolean) => { schemaAccess = allowed; } };
}

test('same authenticated HTTP key and input replay the original invocation without a second effect', async t => {
  const f = await setup(t); let effects = 0; const invoke = f.provider.invoke.bind(f.provider);
  f.provider.invoke = async (...args) => { effects++; return invoke(...args); };
  const payload = { idempotencyKey: randomUUID(), grantId: f.grantId, input: { text: 'synthetic' } };
  const first = await f.request(f.path + `/tools/${capability.id}/invoke`, payload); assert.equal(first.status, 200); const original = await first.json();
  const retry = await f.request(f.path + `/tools/${capability.id}/invoke`, payload); assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), original);
  assert.equal(effects, 1);
});

test('concurrent retry observes the original uncertain request while discovery is pending, then replays completion', async t => {
  const f = await setup(t); let release!: () => void, entered!: () => void, discoveries = 0, effects = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const snapshot = f.provider.getSnapshot.bind(f.provider), invoke = f.provider.invoke.bind(f.provider);
  f.provider.getSnapshot = async (...args) => { discoveries++; entered(); await waiting; return snapshot(...args); };
  f.provider.invoke = async (...args) => { effects++; return invoke(...args); };
  const payload = { idempotencyKey: randomUUID(), grantId: f.grantId, input: { text: 'synthetic' } }, path = f.path + `/tools/${capability.id}/invoke`;
  const pending = f.request(path, payload); await started;
  const duplicate = await f.request(path, payload); assert.equal(duplicate.status, 202); const uncertain = await duplicate.json() as any;
  assert.equal(uncertain.result.lifecycle, 'outcomeUnknown'); assert.equal(discoveries, 1); assert.equal(effects, 0);
  release(); const completed = await pending; assert.equal(completed.status, 200); const original = await completed.json() as any;
  assert.equal(uncertain.invocationId, original.invocationId);
  assert.deepEqual(await (await f.request(path, payload)).json(), original); assert.equal(effects, 1); assert.equal(discoveries, 1);
});

test('missing keys, unknown fields and changed input or capability fail before another provider call', async t => {
  const f = await setup(t); let discoveries = 0; const snapshot = f.provider.getSnapshot.bind(f.provider);
  f.provider.getSnapshot = async (...args) => { discoveries++; return snapshot(...args); };
  const path = f.path + `/tools/${capability.id}/invoke`, payload = { idempotencyKey: randomUUID(), grantId: f.grantId, input: { text: 'synthetic' } };
  assert.equal((await f.request(path, { grantId: f.grantId, input: payload.input })).status, 422);
  assert.equal((await f.request(path, { ...payload, invocationId: randomUUID() })).status, 422);
  assert.equal(discoveries, 0);
  assert.equal((await f.request(path, payload)).status, 200);
  assert.equal((await f.request(path, { ...payload, input: { text: 'changed' } })).status, 409);
  assert.equal((await f.request(f.path + '/tools/synthetic.other/invoke', payload)).status, 409);
  assert.equal(discoveries, 1);
});

test('completed HTTP outcome survives actual server restart without rediscovery or provider result memory', async t => {
  const f = await setup(t), path = f.path + `/tools/${capability.id}/invoke`;
  const payload = { idempotencyKey: randomUUID(), grantId: f.grantId, input: { text: 'synthetic' } };
  const first = await f.request(path, payload); assert.equal(first.status, 200); const original = await first.json();
  const port = f.app.address().port; await f.app.shutdown();
  const emptyProvider = new FixtureCapabilityProvider([capability], f.options.capabilitySchemas);
  emptyProvider.getSnapshot = async () => { throw new Error('retry must not discover'); };
  emptyProvider.invoke = async () => { throw new Error('retry must not invoke'); };
  const restarted = createLifestreamServer({ ...f.options, port, capabilityProvider: emptyProvider }); await restarted.start();
  try { const retry = await f.request(path, payload); assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), original); }
  finally { await restarted.shutdown(); }
});

test('failed result persistence retains the original invocation without dispatching on retry', async t => {
  const f = await setup(t), db = new Database({ path: f.options.config.storage.databasePath }); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_http_result BEFORE UPDATE ON tool_invocation_requests BEGIN SELECT RAISE(ABORT,'synthetic result storage failure'); END");
  let effects = 0; const invoke = f.provider.invoke.bind(f.provider);
  f.provider.invoke = async (...args) => { effects++; return invoke(...args); };
  const path = f.path + `/tools/${capability.id}/invoke`, payload = { idempotencyKey: randomUUID(), grantId: f.grantId, input: { text: 'synthetic' } };
  const first = await f.request(path, payload); assert.equal(first.status, 503); const original = await first.json() as any;
  const retry = await f.request(path, payload); assert.equal(retry.status, 202); const uncertain = await retry.json() as any;
  assert.equal(uncertain.invocationId, original.invocationId); assert.equal(uncertain.result.lifecycle, 'outcomeUnknown'); assert.equal(effects, 1);
});

test('current Assistant permission is required even to replay a previously successful response', async t => {
  const f = await setup(t), payload = { idempotencyKey: randomUUID(), grantId: f.grantId, input: { text: 'synthetic' } };
  const path = f.path + `/tools/${capability.id}/invoke`;
  assert.equal((await f.request(path, payload)).status, 200);
  const db = new Database({ path: f.options.config.storage.databasePath }); t.after(() => db.close());
  db.connection.prepare('UPDATE local_assistant_permissions SET administer=0').run();
  const retry = await f.request(path, payload); assert.equal(retry.status, 403); assert.equal((await retry.json() as any).result, undefined);
});

test('recorded output is withheld when schema access is revoked, without erasing the original outcome or repeating I/O', async t => {
  const f = await setup(t); let effects = 0; const invoke = f.provider.invoke.bind(f.provider);
  f.provider.invoke = async (...args) => { effects++; return invoke(...args); };
  const path = f.path + `/tools/${capability.id}/invoke`, payload = { idempotencyKey: randomUUID(), grantId: f.grantId, input: { text: 'synthetic' } };
  const first = await f.request(path, payload); assert.equal(first.status, 200); const original = await first.json();
  f.setSchemaAccess(false);
  const unavailable = await f.request(path, payload); assert.equal(unavailable.status, 503); assert.equal((await unavailable.json() as any).result, undefined);
  f.setSchemaAccess(true);
  const restored = await f.request(path, payload); assert.equal(restored.status, 200); assert.deepEqual(await restored.json(), original);
  assert.equal(effects, 1);
});
