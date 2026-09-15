import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ready } from './fixtures/canonical-capability.ts';
async function uncertain(t: Parameters<typeof ready>[0]) {
  const f = await ready(t); f.invocationMode('missing'); const first = await f.dispatch();
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.status, 'outcomeUnknown');
  return { ...f, first, reconcile: () => f.send(f.path + '/reconcile', {}) };
}
const rows = (f: Awaited<ReturnType<typeof uncertain>>) => f.db.connection.prepare('SELECT * FROM canonical_dispatch_observations ORDER BY sequence').all();

test('canonical status recovers a missing reply using original invocation, key and scope without re-admission', async t => {
  const f = await uncertain(t), before = f.counters(), original = f.lastInvocation(); const reply = await f.reconcile();
  assert.equal(reply.status, 200, JSON.stringify(reply.body)); assert.equal(reply.body.status, 'succeeded'); assert.equal(reply.body.originalStatus, 'outcomeUnknown'); assert.equal(reply.body.result, null);
  assert.equal(reply.body.latestObservation.result.operation, 'CapabilityProvider.getInvocation'); assert.deepEqual(reply.body.latestObservation.result.outcome.payload.output, { text: f.input.input.text });
  assert.equal(reply.body.observationCount, 1); assert.deepEqual(f.counters(), { ...before, status: 1 });
  assert.deepEqual(f.lastStatusRequest().scope, original.scope); assert.equal(f.lastStatusRequest().idempotencyKey, original.idempotencyKey); assert.equal(f.lastStatusRequest().payload.invocationId, original.payload.invocationId);
  assert.deepEqual(reply.body.receipt, f.first.body.receipt); assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM canonical_dispatch_results').get()!.n, 0);
  assert.equal((await f.send(f.path)).body.status, 'succeeded'); assert.equal((await f.dispatch()).body.status, 'outcomeUnknown'); assert.equal((await f.reconcile()).body.observationCount, 1); assert.deepEqual(f.counters(), { ...before, status: 1 });
  const event = JSON.parse(f.db.connection.prepare('SELECT payload_json FROM canonical_grant_events ORDER BY rowid DESC LIMIT 1').get()!.payload_json as string); assert.equal(event.type, 'consumed');
});
test('unknown observations remain append-only; terminal status survives actual server restart', async t => {
  const f = await uncertain(t); f.statusMode('unknown'); const first = await f.reconcile(); assert.equal(first.body.status, 'outcomeUnknown'); assert.equal(first.body.observationCount, 1);
  const stored = rows(f)[0]!; await f.restart(); f.statusMode('succeeded'); const confirmed = await f.reconcile(); assert.equal(confirmed.body.status, 'succeeded'); assert.equal(confirmed.body.observationCount, 2); assert.deepEqual(rows(f)[0], stored);
  await f.restart(); const counts = f.counters(); assert.equal((await f.send(f.path)).body.status, 'succeeded'); assert.equal((await f.reconcile()).body.status, 'succeeded'); assert.deepEqual(f.counters(), counts); assert.equal(f.calls(), 1);
});
test('late concurrent unknown cannot replace a confirmed observation', async t => {
  const f = await uncertain(t); f.statusMode('unknown'); const gate = f.blockStatus(), pending = f.reconcile(); await gate.started;
  f.statusMode('succeeded'); const confirmed = await f.reconcile(); assert.equal(confirmed.body.status, 'succeeded'); gate.release(); const late = await pending;
  assert.equal(late.body.status, 'succeeded'); assert.equal(rows(f).length, 1); assert.equal((await f.send(f.path)).body.latestObservation.result.requestId, confirmed.body.latestObservation.result.requestId); assert.equal(f.calls(), 1);
});
test('observation persistence failure withholds confirmation without changing initial history or repeating the action', async t => {
  const f = await uncertain(t);
  f.db.exec("CREATE TRIGGER fail_observation BEFORE INSERT ON canonical_dispatch_observations BEGIN SELECT RAISE(ABORT,'synthetic status write failure'); END");
  assert.equal((await f.reconcile()).status, 503); assert.equal(rows(f).length, 0); assert.equal((await f.send(f.path)).body.status, 'outcomeUnknown'); assert.equal(f.calls(), 1);
  f.db.exec('DROP TRIGGER fail_observation'); assert.equal((await f.reconcile()).body.status, 'succeeded'); assert.equal(f.counters().status, 2); assert.equal(f.calls(), 1);
});
for (const mode of ['missing','malformed','wrongInvocation','wrongSchema','wrongProvider','wrongReceipt']) test(`canonical reconciliation rejects ${mode} without storing or disclosing a confirmation`, async t => {
  const f = await uncertain(t); f.statusMode(mode); const result = await f.reconcile(); assert.equal(result.status, mode === 'wrongReceipt' ? 409 : 503, JSON.stringify(result)); assert.equal(rows(f).length, 0); assert.equal(f.calls(), 1);
});
test('current schema access is checked before provider query, after its await, and on recorded reads', async t => {
  const f = await uncertain(t); f.denySchemas(); assert.equal((await f.reconcile()).status, 503); assert.equal(f.counters().status, 0);
  const g = await uncertain(t), gate = g.blockStatus(), pending = g.reconcile(); await gate.started; g.denySchemas(); gate.release(); assert.equal((await pending).status, 503); assert.equal(rows(g).length, 0);
  const h = await uncertain(t); assert.equal((await h.reconcile()).body.status, 'succeeded'); h.denySchemas(); assert.equal((await h.send(h.path)).status, 503); assert.equal(rows(h).length, 1);
});
test('provider changes and audience withdrawal cannot query or retain late scoped status', async t => {
  const f = await uncertain(t); f.changeProvider(); assert.equal((await f.reconcile()).status, 409); assert.equal(f.counters().status, 0);
  const g = await uncertain(t), gate = g.blockStatus(), pending = g.reconcile(); await gate.started;
  await g.send('/api/runtime/v1/session-context', { expectedRevision: 1, mode: 'text', audienceScope: 'unknown' }); gate.release(); assert.equal((await pending).status, 503); assert.equal(rows(g).length, 0); assert.equal(g.calls(), 1);
});
test('status observation and provider-evidence corruption fail closed without erasing history', async t => {
  const f = await uncertain(t); f.invocationMode('corruptEvidence'); assert.equal((await f.reconcile()).status, 503); assert.equal(rows(f).length, 0);
  const g = await uncertain(t); assert.equal((await g.reconcile()).body.status, 'succeeded'); g.db.connection.prepare('UPDATE canonical_dispatch_observations SET payload_json=?').run('{}');
  assert.equal((await g.send(g.path)).status, 503); assert.equal((await g.reconcile()).status, 503); assert.equal(g.calls(), 1);
});
test('bounded observations reserve room for confirmation after sixteen uncertain replies', async t => {
  const f = await uncertain(t); f.statusMode('unknown');
  for (let i = 1; i <= 16; i++) { const reply = await f.reconcile(); assert.equal(reply.status, 200, JSON.stringify(reply)); assert.equal(reply.body.observationCount, i); }
  assert.equal((await f.reconcile()).status, 429); assert.equal(rows(f).length, 16);
  f.statusMode('succeeded'); assert.equal((await f.reconcile()).body.observationCount, 17); assert.equal((await f.send(f.path)).body.status, 'succeeded'); assert.equal(f.calls(), 1);
});
test('reconciliation cannot provide replacement identity or claim an admitted but unstarted invocation', async t => {
  const f = await uncertain(t); assert.equal((await f.send(f.path + '/reconcile', { invocationId: randomUUID() })).status, 422);
  assert.equal((await f.send(f.path + '/reconcile', {}, { 'x-lifestream-csrf': 'wrong' })).status, 403); assert.equal(f.counters().status, 0);
  const g = await ready(t); g.db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON canonical_dispatch_claims BEGIN SELECT RAISE(ABORT,'synthetic claim failure'); END");
  assert.equal((await g.dispatch()).body.initialCallClaimed, false); const reply = await g.send(g.path + '/reconcile', {});
  assert.equal(reply.body.status, 'outcomeUnknown'); assert.equal(g.counters().status, 0); assert.equal(g.calls(), 0);
});

test('confirmed provider failure is terminal and does not become a new action attempt', async t => {
  const f = await uncertain(t); f.statusMode('confirmedFailure'); const reply = await f.reconcile();
  assert.equal(reply.body.status, 'failed', JSON.stringify(reply)); assert.equal(reply.body.replayed, false); assert.equal(reply.body.latestObservation.result.outcome.payload.effectState, 'confirmedFailed');
  f.statusMode('succeeded'); const before = f.counters(); assert.equal((await f.reconcile()).body.status, 'failed'); assert.deepEqual(f.counters(), before); assert.equal(f.calls(), 1);
});
test('provider status deadline is finite and a late reply cannot append an observation', async t => {
  const f = await uncertain(t), gate = f.blockStatus(), started = Date.now(), pending = f.reconcile(); await gate.started;
  const result = await pending; assert.equal(result.status, 503); assert.ok(Date.now() - started < 7000); assert.equal(rows(f).length, 0);
  gate.release(); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(rows(f).length, 0); assert.equal(f.calls(), 1);
  assert.equal((await f.reconcile()).body.status, 'succeeded'); assert.equal(f.calls(), 1);
});

test('stored uncertain and failed provider details retain the same current access boundary as successful output', async t => {
  for (const mode of ['unknown','confirmedFailure']) {
    const f = await uncertain(t); f.statusMode(mode); assert.equal((await f.reconcile()).status, 200); f.denySchemas();
    assert.equal((await f.send(f.path)).status, 503); assert.equal(rows(f).length, 1); assert.equal(f.calls(), 1);
  }
});
