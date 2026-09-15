import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, prepared } from './fixtures/canonical-capability.ts';
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
