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
  const options = { config, capabilityProvider: provider, capabilitySchemas: schemas, capabilityProviderIdentity: 'synthetic-fixture-installation-1', localAuth: { stateDirectory: join(directory, 'safety'), installerToken } };
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
  const recovered = await f.request(f.path + `/tools/invocations/${original.invocationId}`); assert.equal(recovered.status, 200);
  assert.equal((await recovered.json() as any).result.lifecycle, 'succeeded'); assert.equal(effects, 1);
  assert.equal((db.connection.prepare('SELECT response_json FROM tool_invocation_requests').get() as any).response_json, null);
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

async function loseReply(t: { after(callback: () => unknown): void }) {
  const f = await setup(t), invoke = f.provider.invoke.bind(f.provider);
  let effects = 0;
  f.provider.invoke = async (...args) => { effects++; await invoke(...args); throw new Error('synthetic lost reply after effect'); };
  const payload = { idempotencyKey: randomUUID(), grantId: f.grantId, input: { text: 'synthetic lost reply' } };
  const invokePath = f.path + `/tools/${capability.id}/invoke`;
  const initial = await f.request(invokePath, payload); assert.equal(initial.status, 403);
  const original = await initial.json() as any; assert.equal(original.result.lifecycle, 'outcomeUnknown');
  const statusPath = f.path + `/tools/invocations/${original.invocationId}`;
  f.provider.getSnapshot = async () => { throw new Error('status must not discover'); };
  f.provider.invoke = async () => { effects++; throw new Error('status must not invoke'); };
  return { ...f, payload, invokePath, original, statusPath, effects: () => effects };
}

test('status recovers a lost reply from the original provider without rediscovery, dispatch or rewriting the original HTTP reply', async t => {
  const f = await loseReply(t), db = new Database({ path: f.options.config.storage.databasePath }); t.after(() => db.close());
  const before = db.connection.prepare('SELECT * FROM tool_invocation_requests').all();
  const events = db.connection.prepare('SELECT * FROM authority_events').all();
  const recovered = await f.request(f.statusPath); assert.equal(recovered.status, 200); const body = await recovered.json() as any;
  assert.equal(body.invocationId, f.original.invocationId); assert.equal(body.result.lifecycle, 'succeeded');
  assert.equal(body.requestId, f.original.requestId); assert.equal(body.correlationId, f.original.correlationId);
  assert.equal(f.effects(), 1); assert.deepEqual(db.connection.prepare('SELECT * FROM tool_invocation_requests').all(), before);
  assert.deepEqual(db.connection.prepare('SELECT * FROM authority_events').all(), events);
  assert.equal(db.connection.prepare('SELECT * FROM tool_recovery_observations').all().length, 1);
  // The original POST is historical; the dedicated status resource carries later evidence.
  assert.deepEqual(await (await f.request(f.invokePath, f.payload)).json(), f.original);
  const port = f.app.address().port; await f.app.shutdown();
  const empty = new FixtureCapabilityProvider([capability], f.options.capabilitySchemas);
  empty.getInvocation = async () => { throw new Error('confirmed status is durable'); };
  const restarted = createLifestreamServer({ ...f.options, port, capabilityProvider: empty }); await restarted.start();
  try { assert.deepEqual(await (await f.request(f.statusPath)).json(), body); } finally { await restarted.shutdown(); }
});

test('missing provider outcome stays uncertain and a later confirmation is recorded without replacing earlier observations', async t => {
  const f = await loseReply(t), get = f.provider.getInvocation.bind(f.provider);
  f.provider.getInvocation = async () => undefined;
  const unknown = await f.request(f.statusPath); assert.equal(unknown.status, 202); assert.equal((await unknown.json() as any).result.lifecycle, 'outcomeUnknown');
  const repeat = await f.request(f.statusPath); assert.equal(repeat.status, 202);
  f.provider.getInvocation = get;
  const success = await f.request(f.statusPath); assert.equal(success.status, 200); assert.equal(f.effects(), 1);
  const db = new Database({ path: f.options.config.storage.databasePath }); t.after(() => db.close());
  const rows = db.connection.prepare('SELECT response_json FROM tool_recovery_observations ORDER BY sequence').all() as any[];
  assert.deepEqual(rows.map(row => JSON.parse(row.response_json).body.result.lifecycle), ['outcomeUnknown','succeeded']);
});

test('status refuses another configured provider identity after restart before contacting it', async t => {
  const f = await loseReply(t), port = f.app.address().port; await f.app.shutdown(); let reads = 0;
  const replacement = new FixtureCapabilityProvider([capability], f.options.capabilitySchemas);
  replacement.getInvocation = async () => { reads++; return undefined; };
  const restarted = createLifestreamServer({ ...f.options, port, capabilityProvider: replacement, capabilityProviderIdentity: 'different-installation' }); await restarted.start();
  try { assert.equal((await f.request(f.statusPath)).status, 503); assert.equal(reads, 0); } finally { await restarted.shutdown(); }
});

test('status rejects cross-session lookup and rechecks Assistant access after the provider await', async t => {
  const f = await loseReply(t), db = new Database({ path: f.options.config.storage.databasePath }); t.after(() => db.close());
  db.connection.prepare("UPDATE tool_invocation_requests SET session_id='other-session'").run();
  assert.equal((await f.request(f.statusPath)).status, 404);
  const binding = JSON.parse((db.connection.prepare('SELECT binding_json FROM tool_recovery_bindings').get() as any).binding_json);
  db.connection.prepare('UPDATE tool_invocation_requests SET session_id=?').run(binding.scope.sessionId);
  const get = f.provider.getInvocation.bind(f.provider);
  f.provider.getInvocation = async (...args) => { const result = await get(...args); db.connection.prepare('UPDATE local_assistant_permissions SET administer=0').run(); return result; };
  const denied = await f.request(f.statusPath); assert.equal(denied.status, 403); assert.equal((await denied.json() as any).result, undefined);
  assert.equal(db.connection.prepare('SELECT * FROM tool_recovery_observations').all().length, 0);
});

test('status withholds revoked schemas and mismatched original schema references', async t => {
  const f = await loseReply(t), get = f.provider.getInvocation.bind(f.provider);
  f.setSchemaAccess(false); assert.equal((await f.request(f.statusPath)).status, 503);
  f.setSchemaAccess(true);
  // This is another valid authorized schema, but it is not this invocation's output contract.
  const inputRef = f.options.capabilitySchemas.metadata('urn:lifestream:fixture-schema:synthetic.echo:1.0.0:input')!;
  f.provider.getInvocation = async (...args) => ({ ...(await get(...args))!, outputSchema: inputRef, output: { text: 'valid under the wrong contract' } });
  const wrong = await f.request(f.statusPath); assert.equal(wrong.status, 503); assert.equal((await wrong.json() as any).result, undefined);
  f.provider.getInvocation = get; const valid = await f.request(f.statusPath); assert.equal(valid.status, 200);
  f.setSchemaAccess(false); assert.equal((await f.request(f.statusPath)).status, 503); assert.equal(f.effects(), 1);
});

test('late concurrent unknown status cannot replace a confirmed result', async t => {
  const f = await loseReply(t), get = f.provider.getInvocation.bind(f.provider);
  let release!: () => void, entered!: () => void, reads = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.provider.getInvocation = async (...args) => { if (++reads === 1) { entered(); await waiting; return undefined; } return get(...args); };
  const pending = f.request(f.statusPath); await started;
  const confirmed = await f.request(f.statusPath); assert.equal(confirmed.status, 200); const expected = await confirmed.json();
  release(); const late = await pending; assert.equal(late.status, 200); assert.deepEqual(await late.json(), expected); assert.equal(f.effects(), 1);
});

test('status persistence failure withholds the reply and allows a read-only retry', async t => {
  const f = await loseReply(t), db = new Database({ path: f.options.config.storage.databasePath }); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_status BEFORE INSERT ON tool_recovery_observations BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
  const failure = await f.request(f.statusPath); assert.equal(failure.status, 503); assert.equal((await failure.json() as any).result, undefined);
  assert.equal(db.connection.prepare('SELECT * FROM tool_recovery_observations').all().length, 0);
  db.exec('DROP TRIGGER fail_status'); assert.equal((await f.request(f.statusPath)).status, 200); assert.equal(f.effects(), 1);
});

test('status without original provider binding is unavailable and cannot rediscover historical scope', async t => {
  const f = await loseReply(t), db = new Database({ path: f.options.config.storage.databasePath }); t.after(() => db.close());
  db.exec('DELETE FROM tool_recovery_bindings'); let reads = 0;
  f.provider.getInvocation = async () => { reads++; return undefined; };
  assert.equal((await f.request(f.statusPath)).status, 503); assert.equal(reads, 0);
  assert.equal((await f.request(f.path + `/tools/invocations/${randomUUID()}`)).status, 404);
});

test('uncertain invocation can recover after server restart using only its original binding and provider status', async t => {
  const f = await loseReply(t), port = f.app.address().port; await f.app.shutdown();
  const restarted = createLifestreamServer({ ...f.options, port }); await restarted.start();
  try { const result = await f.request(f.statusPath); assert.equal(result.status, 200); assert.equal((await result.json() as any).invocationId, f.original.invocationId); assert.equal(f.effects(), 1); }
  finally { await restarted.shutdown(); }
});

test('a stalled provider status reaches the HTTP deadline without output, evidence or another dispatch', async t => {
  const f = await loseReply(t); let signal: AbortSignal | undefined;
  f.provider.getInvocation = async (_request, call) => { signal = call.signal; return new Promise(() => {}); };
  const start = Date.now(), result = await f.request(f.statusPath);
  assert.equal(result.status, 503); assert.ok(Date.now() - start < 8000); assert.equal(signal?.aborted, true);
  assert.equal((await result.json() as any).result, undefined); assert.equal(f.effects(), 1);
  const db = new Database({ path: f.options.config.storage.databasePath }); t.after(() => db.close());
  assert.equal(db.connection.prepare('SELECT * FROM tool_recovery_observations').all().length, 0);
});

test('status rejects a different invocation identity and never treats that response as original confirmation', async t => {
  const f = await loseReply(t), get = f.provider.getInvocation.bind(f.provider);
  f.provider.getInvocation = async (...args) => ({ ...(await get(...args))!, invocationId: randomUUID() });
  const result = await f.request(f.statusPath); assert.equal(result.status, 503); assert.equal((await result.json() as any).result, undefined);
  const db = new Database({ path: f.options.config.storage.databasePath }); t.after(() => db.close());
  assert.equal(db.connection.prepare('SELECT * FROM tool_recovery_observations').all().length, 0); assert.equal(f.effects(), 1);
});
