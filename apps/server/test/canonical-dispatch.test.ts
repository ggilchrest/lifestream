import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { ready, prepared } from './fixtures/canonical-capability.ts';
const count = (f: Awaited<ReturnType<typeof ready>>, table: string) => f.db.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

test('canonical HTTP prepare, approve and dispatch preserves original arguments and consumes once with actual receipt evidence', async t => {
  const f = await ready(t), reply = await f.dispatch(); assert.equal(reply.status, 200, JSON.stringify(reply.body)); assert.equal(reply.body.status, 'succeeded', JSON.stringify(reply.body));
  assert.equal(f.calls(), 1); assert.equal(reply.body.decision.grantRevision, 1); assert.equal(reply.body.initialCallClaimed, true);
  const invocation = f.lastInvocation(); assert.deepEqual(invocation.payload.input, f.input.input); assert.equal(invocation.payload.invocationId, f.p.request.invocationId);
  assert.equal(invocation.scope.authorityContextRef.revision, 2); assert.deepEqual(invocation.payload.dispatchReceipt, reply.body.receipt);
  const artifact = f.db.connection.prepare('SELECT payload_json,sha256 FROM canonical_authority_artifacts WHERE reference=?').get(reply.body.receipt.reference)!;
  assert.deepEqual(JSON.parse(artifact.payload_json as string), reply.body.decision); assert.equal(createHash('sha256').update(artifact.payload_json as string).digest('hex'), reply.body.receipt.sha256);
  const detail = await f.send(`/api/authority/v1/grants/${f.grant.grantId}`); assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.result.grant.status, 'consumed'); assert.equal(detail.body.result.grant.revision, 2); assert.equal(detail.body.result.events[1].decisionId, reply.body.decision.decisionId);
  assert.deepEqual(detail.body.result.admittedInvocationIds, [f.p.request.invocationId]);
  const revoke = await f.revoke(); assert.equal(revoke.status, 200); assert.equal(revoke.body.result.grant.status, 'consumed'); assert.deepEqual(revoke.body.result.admittedInvocationIds, [f.p.request.invocationId]);
  const duplicate = await f.dispatch(); assert.equal(duplicate.body.replayed, true); assert.deepEqual(duplicate.body.result, reply.body.result); assert.equal(f.calls(), 1);
  assert.equal((await f.send(f.path + '/dispatch', { ...f.command, idempotencyKey: randomUUID() })).status, 409);
});
test('concurrent identical dispatches have one admission, consumption and initial call', async t => {
  const f = await ready(t), replies = await Promise.all([f.dispatch(), f.dispatch(), f.dispatch()]);
  assert.ok(replies.some(r => r.body.status === 'succeeded'), JSON.stringify(replies));
  assert.equal(f.calls(), 1); assert.equal(count(f, 'canonical_dispatch_admissions'), 1); assert.equal(count(f, 'canonical_dispatch_claims'), 1);
  assert.equal(count(f, 'canonical_grant_events'), 2); const replay = await f.dispatch(); assert.equal(replay.body.status, 'succeeded');
});
test('revocation before admission prevents any provider call', async t => {
  const f = await ready(t); assert.equal((await f.revoke()).status, 200);
  assert.equal((await f.dispatch()).status, 409); assert.equal(f.calls(), 0); assert.equal(count(f, 'canonical_dispatch_admissions'), 0);
});
test('admission before reusable-grant revocation preserves in-flight invocation and original command replay', async t => {
  const f = await ready(t, 'allowSession'), gate = f.blockInvocation(), pending = f.dispatch(); await Promise.race([gate.started, pending.then(reply => { throw new Error('Dispatch ended before provider call: ' + JSON.stringify(reply)); })]);
  const revoke = await f.revoke(); assert.equal(revoke.status, 200, JSON.stringify(revoke.body)); assert.deepEqual(revoke.body.result.admittedInvocationIds, [f.p.request.invocationId]);
  gate.release(); const reply = await pending; assert.equal(reply.body.status, 'succeeded', JSON.stringify(reply.body)); assert.equal(f.calls(), 1);
});
test('receipt transaction failure rolls back consumption and admission before any effect', async t => {
  const f = await ready(t);
  f.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON canonical_authority_artifacts WHEN NEW.reference LIKE 'urn:lifestream:dispatch-receipt:%' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  assert.equal((await f.dispatch()).status, 503); assert.equal(f.calls(), 0); assert.equal(count(f, 'canonical_dispatch_admissions'), 0); assert.equal(count(f, 'canonical_grant_events'), 1);
  assert.equal((await f.send(`/api/authority/v1/grants/${f.grant.grantId}`)).body.result.grant.status, 'active');
});
test('claim failure after admission is unknown and a restart never grants a new initial call', async t => {
  const f = await ready(t);
  f.db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON canonical_dispatch_claims BEGIN SELECT RAISE(ABORT,'synthetic claim failure'); END");
  const first = await f.dispatch(); assert.equal(first.status, 200); assert.equal(first.body.status, 'outcomeUnknown'); assert.equal(first.body.initialCallClaimed, false); assert.equal(f.calls(), 0);
  f.db.exec('DROP TRIGGER fail_claim'); await f.restart(); const second = await f.dispatch(); assert.equal(second.body.status, 'outcomeUnknown'); assert.equal(second.body.replayed, true); assert.equal(f.calls(), 0);
  assert.equal((await f.send(`/api/authority/v1/grants/${f.grant.grantId}`)).body.result.grant.status, 'consumed');
});
for (const mode of ['missing','malformed','corruptEvidence']) test(`provider ${mode} reply stays unknown without refund or automatic retry`, async t => {
  const f = await ready(t); f.invocationMode(mode); const first = await f.dispatch(); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.status, 'outcomeUnknown'); assert.equal(f.calls(), 1);
  await f.restart(); const replay = await f.dispatch(); assert.equal(replay.body.status, 'outcomeUnknown'); assert.equal(f.calls(), 1); assert.equal(count(f, 'canonical_dispatch_results'), 0);
});
for (const mode of ['denied','corrupt','stale']) test(`provider disposition ${mode} cannot admit an effect`, async t => {
  const f = await ready(t); f.governanceMode(mode); assert.equal((await f.dispatch()).status, mode === 'stale' ? 409 : 503); assert.equal(f.calls(), 0); assert.equal(count(f, 'canonical_dispatch_admissions'), 0);
});
test('material catalog changes and forged dispatch fields cannot replace approved terms', async t => {
  const f = await ready(t);
  for (const forged of [{ input: { text: 'different' } }, { authorityContextRef: {} }, { receipt: {} }, { expectedGrantRevision: 1 }]) assert.equal((await f.send(f.path + '/dispatch', { ...f.command, ...forged })).status, 422);
  f.materialChange(); assert.equal((await f.dispatch()).status, 409); assert.equal(f.calls(), 0);
});
test('grant expiry is enforced after request approval; request expiry alone does not revoke the grant', async t => {
  const f = await ready(t, 'allowOnce', 'request'); f.advance(1001); const reply = await f.dispatch(); assert.equal(reply.body.status, 'succeeded', JSON.stringify(reply));
  const g = await ready(t, 'allowOnce', 'grant'); g.advance(1001); assert.equal((await g.dispatch()).status, 409); assert.equal(g.calls(), 0);
});
test('audit failure rolls back the grant and the receipt; result-write failure preserves consumed unknown', async t => {
  const f = await ready(t);
  f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON canonical_authority_artifacts WHEN NEW.reference LIKE 'urn:lifestream:dispatch-audit:%' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.equal((await f.dispatch()).status, 503); assert.equal(f.calls(), 0); assert.equal(count(f, 'canonical_dispatch_admissions'), 0); assert.equal(count(f, 'canonical_grant_events'), 1);
  assert.equal(f.db.connection.prepare("SELECT COUNT(*) AS n FROM canonical_authority_artifacts WHERE reference LIKE 'urn:lifestream:dispatch-receipt:%'").get()!.n, 0);
  f.db.exec('DROP TRIGGER fail_audit'); f.db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON canonical_dispatch_results BEGIN SELECT RAISE(ABORT,'synthetic result failure'); END");
  const first = await f.dispatch(); assert.equal(first.body.status, 'outcomeUnknown'); assert.equal(f.calls(), 1); f.db.exec('DROP TRIGGER fail_result'); await f.restart();
  assert.equal((await f.dispatch()).body.status, 'outcomeUnknown'); assert.equal(f.calls(), 1);
});
test('another retained invocation cannot spend the original invocation-bound one-use grant', async t => {
  const f = await ready(t), secondInput = f.body(), second = await prepared({ ...f, path: f.path.replace(/invocations\/[^/]+$/, 'synthetic.echo/prepare') }, secondInput);
  const path = f.path.replace(f.p.request.invocationId, second.request.invocationId);
  const wrong = await f.send(path + '/dispatch', { grantId: f.grant.grantId, idempotencyKey: secondInput.idempotencyKey });
  assert.equal(wrong.status, 409); assert.equal(f.calls(), 0); assert.equal((await f.dispatch()).body.status, 'succeeded'); assert.equal(f.calls(), 1);
});
test('audience withdrawal during provider preparation blocks admission and after initial call preserves unknown', async t => {
  const f = await ready(t), gate = f.block(), pending = f.dispatch(); await gate.started;
  await f.send('/api/runtime/v1/session-context', { expectedRevision: 1, mode: 'text', audienceScope: 'unknown' }); gate.release();
  assert.ok((await pending).status >= 400); assert.equal(f.calls(), 0); assert.equal(count(f, 'canonical_dispatch_admissions'), 0);
  const g = await ready(t), effect = g.blockInvocation(), inFlight = g.dispatch();
  await Promise.race([effect.started, inFlight.then(reply => { throw new Error(JSON.stringify(reply)); })]);
  await g.send('/api/runtime/v1/session-context', { expectedRevision: 1, mode: 'text', audienceScope: 'unknown' }); effect.release();
  assert.equal((await inFlight).body.status, 'outcomeUnknown'); assert.equal(g.calls(), 1); assert.equal(count(g, 'canonical_dispatch_results'), 0);
  assert.equal((await g.dispatch()).body.status, 'outcomeUnknown'); assert.equal(g.calls(), 1);
});
test('canonical dispatch rejects missing governance, changed provider, old preparations and corrupt receipt custody', async t => {
  const missing = await ready(t); delete (missing.composition as any).governance; await missing.restart();
  assert.equal((await missing.dispatch()).status, 503); assert.equal(missing.calls(), 0);
  const f = await ready(t); assert.equal((await f.send(f.path + '/dispatch', f.command, { 'x-lifestream-csrf': 'wrong' })).status, 403); f.changeProvider(); assert.equal((await f.dispatch()).status, 409); assert.equal(f.calls(), 0);
  const g = await ready(t); const row = g.db.connection.prepare('SELECT payload_json FROM canonical_preparations').get()!; const record = JSON.parse(row.payload_json as string); delete record.hostRevision;
  const { canonicalJson } = await import('@lifestream/runtime/capabilities/schema-validation');
  g.db.connection.prepare('UPDATE canonical_preparations SET payload_json=?,sha256=?').run(JSON.stringify(record), createHash('sha256').update(canonicalJson(record)).digest('hex'));
  assert.equal((await g.dispatch()).status, 409); assert.equal(g.calls(), 0);
  const h = await ready(t); const first = await h.dispatch(); assert.equal(first.body.status, 'succeeded');
  h.db.connection.prepare('UPDATE canonical_authority_artifacts SET payload_json=? WHERE reference=?').run('{}', first.body.receipt.reference);
  assert.equal((await h.dispatch()).status, 503); assert.equal(h.calls(), 1);
});

test('recorded successful output still requires current schema access on GET and replay', async t => {
  const f = await ready(t); assert.equal((await f.dispatch()).body.status, 'succeeded'); f.denySchemas();
  assert.equal((await f.send(f.path)).status, 503); assert.equal((await f.dispatch()).status, 503);
  assert.equal(f.calls(), 1); assert.equal(count(f, 'canonical_dispatch_results'), 1);
});
