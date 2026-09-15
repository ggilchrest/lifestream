import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../src/database.ts';
import { ToolInvocationRepository, ToolInvocationError } from '../src/tool-invocations.ts';

const request = () => ({ idempotencyKey: 'synthetic-key', principalId: 'human', assistantId: 'assistant', sessionId: 'session',
  requestDigest: 'a'.repeat(64), requestId: 'request', correlationId: 'correlation', now: '2026-09-15T12:00:00Z' });
function setup(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'ls-tool-ledger-')), path = join(directory, 'db.sqlite');
  const db = new Database({ path }); db.migrate(); t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, path, repository: new ToolInvocationRepository(db) };
}
const error = (code: ToolInvocationError['code']) => (value: unknown) => value instanceof ToolInvocationError && value.code === code;
test('one immutable identity and first verified response survive a new database owner', t => {
  const { repository, path } = setup(t); const input = request(), original = repository.begin(input, () => {});
  assert.ok(original.fresh && original.ownerToken);
  repository.complete(original, { status: 200, body: { invocationId: original.invocationId, result: 'synthetic' } });
  const db = new Database({ path }); t.after(() => db.close());
  const retry = new ToolInvocationRepository(db).begin({ ...input, requestId: 'new-request', correlationId: 'new-correlation' }, () => {});
  assert.equal(retry.fresh, false); assert.equal(retry.ownerToken, undefined); assert.equal(retry.invocationId, original.invocationId);
  assert.equal(retry.requestId, original.requestId); assert.equal(retry.correlationId, original.correlationId);
  assert.deepEqual(retry.response, { status: 200, body: { invocationId: original.invocationId, result: 'synthetic' } });
});
test('two database owners allocate only one invocation even while the first result is missing', t => {
  const { repository, path } = setup(t); const db = new Database({ path }); t.after(() => db.close());
  const other = new ToolInvocationRepository(db), first = repository.begin(request(), () => {}), duplicate = other.begin(request(), () => {});
  assert.equal(duplicate.fresh, false); assert.equal(duplicate.invocationId, first.invocationId); assert.equal(duplicate.response, undefined);
  assert.throws(() => other.complete(duplicate, { status: 200, body: {} }), error('conflict'));
});
test('changed content and scope conflict while cross-Human lookup is non-disclosing', t => {
  const { repository } = setup(t); repository.begin(request(), () => {});
  for (const [field, value] of [['requestDigest', 'b'.repeat(64)], ['assistantId', 'other'], ['sessionId', 'other']]) {
    assert.throws(() => repository.begin({ ...request(), [field!]: value }, () => {}), error('conflict'));
  }
  assert.throws(() => repository.begin({ ...request(), principalId: 'other' }, () => {}), error('notFound'));
});
test('a stale finisher cannot overwrite the recorded outcome or claim another request', t => {
  const { repository } = setup(t); const first = repository.begin(request(), () => {}), result = { status: 202, body: { status: 'unknown' } };
  repository.complete(first, result); repository.complete(first, result);
  assert.throws(() => repository.complete(first, { status: 200, body: { status: 'succeeded' } }), error('conflict'));
  const next = repository.begin({ ...request(), idempotencyKey: 'another' }, () => {});
  assert.throws(() => repository.complete({ ...next, ownerToken: first.ownerToken! }, result), error('conflict'));
});
test('capacity refuses new identities without evicting old requests or outputs', t => {
  const { db } = setup(t); const repository = new ToolInvocationRepository(db, 1);
  const first = repository.begin(request(), () => {});
  assert.throws(() => repository.begin({ ...request(), idempotencyKey: 'another' }, () => {}), error('capacity'));
  assert.equal(repository.begin(request(), () => {}).invocationId, first.invocationId);
});
test('owner check failure rolls back allocation and result-write failure retains the original uncertain identity', t => {
  const { repository, db } = setup(t); let checks = 0;
  assert.throws(() => repository.begin(request(), () => { if (++checks === 2) throw new Error('owner changed'); }), /owner changed/);
  assert.equal(db.connection.prepare('SELECT * FROM tool_invocation_requests').all().length, 0);
  const first = repository.begin(request(), () => {});
  db.exec("CREATE TRIGGER fail_result BEFORE UPDATE ON tool_invocation_requests BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(() => repository.complete(first, { status: 200, body: {} }), /synthetic failure/);
  const retry = repository.begin(request(), () => {}); assert.equal(retry.invocationId, first.invocationId); assert.equal(retry.response, undefined); assert.equal(retry.fresh, false);
});
test('tampered stored results and oversized writes fail without becoming new invocations', t => {
  const { repository, db } = setup(t); const first = repository.begin(request(), () => {});
  assert.throws(() => repository.complete(first, { status: 200, body: { output: 'x'.repeat(131073) } }), error('invalid'));
  repository.complete(first, { status: 200, body: { result: 'synthetic' } });
  db.connection.prepare("UPDATE tool_invocation_requests SET response_json=?").run(JSON.stringify({ status: 200, body: { result: 'changed' } }));
  assert.throws(() => repository.begin(request(), () => {}), error('corrupt'));
  assert.equal(db.connection.prepare('SELECT * FROM tool_invocation_requests').all().length, 1);
});

function recovery() {
  return { providerIdentity: 'synthetic-installation', capabilityId: 'synthetic.echo', capabilityVersion: '1.0.0', providerRoute: 'synthetic-route',
    executionMode: 'live' as const, scope: { assistantId: 'assistant', sessionId: 'session', endpointId: 'endpoint', environment: 'environment',
      authorityContextRef: { providerRef: 'local-human', contextId: 'human', revision: 1 } }, outputSchema: null };
}
const observation = (invocationId: string, lifecycle = 'outcomeUnknown', reason = 'synthetic') => ({ status: 202, body: { result: { invocationId, lifecycle, reason } } });

test('recovery binding is owned, immutable and non-disclosing across Human, Assistant and session scope', t => {
  const { repository } = setup(t), first = repository.begin(request(), () => {});
  const duplicate = repository.begin(request(), () => {});
  assert.throws(() => repository.bindRecovery(duplicate, recovery(), () => {}), error('conflict'));
  repository.bindRecovery(first, recovery(), () => {});
  assert.throws(() => repository.bindRecovery(first, { ...recovery(), providerIdentity: 'replacement' }, () => {}), error('conflict'));
  for (const field of ['principalId','assistantId','sessionId']) assert.throws(() => repository.lookup({ ...first, [field]: 'other' }, () => {}), error('notFound'));
  const stored = repository.lookup(first, () => {}); assert.deepEqual(stored.recovery, recovery()); assert.equal(stored.ownerToken, undefined);
});

test('recovery observations survive database reopening and never regress a terminal result', t => {
  const { repository, path, db } = setup(t), first = repository.begin(request(), () => {});
  repository.bindRecovery(first, recovery(), () => {}); repository.complete(first, { status: 503, body: { code: 'lost_reply' } });
  const before = db.connection.prepare('SELECT * FROM tool_invocation_requests').all();
  repository.observe(first, observation(first.invocationId), request().now, () => {});
  repository.observe(first, observation(first.invocationId), request().now, () => {});
  const otherDb = new Database({ path }); t.after(() => otherDb.close()); const other = new ToolInvocationRepository(otherDb);
  const confirmed = observation(first.invocationId, 'succeeded');
  other.observe(first, confirmed, request().now, () => {});
  assert.deepEqual(repository.observe(first, observation(first.invocationId), request().now, () => {}), confirmed);
  assert.equal(repository.lookup(first, () => {}).observation?.sequence, 2);
  assert.deepEqual(db.connection.prepare('SELECT * FROM tool_invocation_requests').all(), before);
});

test('recovery storage failure or changed owner rolls back evidence while retaining the original identity', t => {
  const { repository, db } = setup(t), first = repository.begin(request(), () => {});
  let checks = 0;
  assert.throws(() => repository.bindRecovery(first, recovery(), () => { if (++checks === 2) throw new Error('owner changed'); }), /owner changed/);
  assert.equal(repository.lookup(first, () => {}).recovery, undefined);
  repository.bindRecovery(first, recovery(), () => {});
  db.exec("CREATE TRIGGER fail_observation BEFORE INSERT ON tool_recovery_observations BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(() => repository.observe(first, observation(first.invocationId), request().now, () => {}), /synthetic failure/);
  assert.equal(repository.lookup(first, () => {}).observation, undefined);
  assert.equal(repository.begin(request(), () => {}).invocationId, first.invocationId);
});

test('tampered recovery binding or observation is unavailable without erasing history', t => {
  const { repository, db } = setup(t), first = repository.begin(request(), () => {});
  repository.bindRecovery(first, recovery(), () => {});
  const original = (db.connection.prepare('SELECT binding_json FROM tool_recovery_bindings').get() as any).binding_json;
  db.connection.prepare('UPDATE tool_recovery_bindings SET binding_json=?').run('{}');
  assert.throws(() => repository.lookup(first, () => {}), error('corrupt'));
  db.connection.prepare('UPDATE tool_recovery_bindings SET binding_json=?').run(original);
  repository.observe(first, observation(first.invocationId), request().now, () => {});
  db.connection.prepare('UPDATE tool_recovery_observations SET response_json=?').run('{}');
  assert.throws(() => repository.lookup(first, () => {}), error('corrupt'));
  assert.equal(db.connection.prepare('SELECT * FROM tool_recovery_observations').all().length, 1);
});

test('recovery observation storage is bounded and a duplicate read consumes no additional space', t => {
  const { repository, db } = setup(t), first = repository.begin(request(), () => {}); repository.bindRecovery(first, recovery(), () => {});
  for (let i = 0; i < 64; i++) repository.observe(first, observation(first.invocationId, 'outcomeUnknown', String(i)), request().now, () => {});
  repository.observe(first, observation(first.invocationId, 'outcomeUnknown', '63'), request().now, () => {});
  assert.throws(() => repository.observe(first, observation(first.invocationId, 'started'), request().now, () => {}), error('capacity'));
  assert.equal(db.connection.prepare('SELECT * FROM tool_recovery_observations').all().length, 64);
  repository.observe(first, observation(first.invocationId, 'succeeded'), request().now, () => {});
  assert.equal(repository.lookup(first, () => {}).observation?.sequence, 65);
});


test('completed historical requests cannot acquire a new recovery binding even from their former owner', t => {
  const { repository } = setup(t), first = repository.begin(request(), () => {});
  repository.complete(first, { status: 503, body: { code: 'historical_unknown' } });
  assert.throws(() => repository.bindRecovery(first, recovery(), () => {}), error('conflict'));
  assert.equal(repository.lookup(first, () => {}).recovery, undefined);
});
