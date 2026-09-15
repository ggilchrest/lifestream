import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContractValidator } from '@lifestream/contracts';
import { Database } from '../src/database.ts';
import { CanonicalGrantRepository, CanonicalGrantError, type CanonicalHumanContext, type TrustedGrantProposal } from '../src/authority/canonical-grants.ts';
import { evaluateCanonicalGrant } from '../../runtime/src/authority/grants.ts';
import type { AuthorityRequest } from '@lifestream/contracts/provider-messages';
const command = () => ({ requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID() });
const error = (code: CanonicalGrantError['code']) => (e: unknown) => e instanceof CanonicalGrantError && e.code === code;
function setup(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'ls-canonical-grants-')), path = join(directory, 'db.sqlite');
  const db = new Database({ path }); db.migrate(); t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const principalId = randomUUID(), assistantId = randomUUID(), endpointId = randomUUID(), environmentId = randomUUID(), sessionId = randomUUID();
  let now = '2026-09-15T12:00:00Z', allowed = true;
  const context: CanonicalHumanContext = { principalId, providerRef: 'local-human', authenticationEvidenceRef: `urn:lifestream:synthetic-authentication:${sessionId}`,
    now: () => now, assertCurrent(binding) { if (!allowed || binding.assistantId !== assistantId || binding.endpointId !== endpointId || binding.environmentId !== environmentId || binding.sessionId !== null && binding.sessionId !== sessionId) throw new Error('synthetic current scope denied'); } };
  const proposal: TrustedGrantProposal = { scopeDerivation: 'validatedArguments', request: { assistantId, endpointId, environmentId, sessionId,
    invocationId: randomUUID(), interactionTraceId: randomUUID(), scope: { capabilityId: 'synthetic.echo', capabilityVersion: '1.0.0', operation: 'echo', targetRefs: ['target:one','target:two'], dataScopeRefs: ['data:one'] },
    inputDigest: 'a'.repeat(64), effectSummary: 'Echo synthetic text to the selected synthetic targets.', sideEffectClass: 'reversible',
    requestedClass: 'allowOnce', grantExpiresAt: '2026-09-15T12:10:00Z', reviewAfter: null, expiresAt: '2026-09-15T12:05:00Z', untrustedRationale: null } };
  return { db, path, context, proposal, repository: new CanonicalGrantRepository(db, 'local-human'), setNow: (value: string) => { now = value; }, setAllowed: (value: boolean) => { allowed = value; } };
}
function pending(f: ReturnType<typeof setup>) { return f.repository.createRequest(f.proposal, command(), f.context).request!; }
function approval(request: ReturnType<typeof pending>) { return { requestId: request.requestId, expectedRevision: request.revision, confirmationDigest: request.confirmationDigest,
  grantClass: request.requestedClass, expiresAt: request.grantExpiresAt, reviewAfter: request.reviewAfter }; }
function issued(f: ReturnType<typeof setup>) { const request = pending(f); return f.repository.approveRequest(approval(request), command(), f.context).grant!; }

test('canonical pending request and approval commit one precise grant and preserve the original request snapshot', t => {
  const f = setup(t), request = pending(f), validator = createContractValidator();
  assert.ok(validator.validate('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/GrantRequest', request).valid);
  assert.equal(request.state, 'pending'); assert.equal(request.grantId, null);
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 0);
  const result = f.repository.approveRequest(approval(request), command(), f.context);
  assert.ok(validator.validate('https://lifestream.dev/contracts/human-authority-grant/1.0.0', result.grant).valid);
  assert.equal(result.request!.state, 'approved'); assert.equal(result.grant!.grantRequestId, request.requestId);
  assert.deepEqual(result.grant!.scope, request.scope); assert.equal(result.grant!.inputDigest, request.inputDigest);
  assert.equal(result.grant!.issuedBy, f.context.principalId);
  const history = f.db.connection.prepare('SELECT payload_json FROM canonical_grant_request_history ORDER BY revision').all() as any[];
  assert.deepEqual(JSON.parse(history[0].payload_json), request); assert.equal(history.length, 2);
  assert.equal(result.events[0]!.oldRevision, 0); assert.equal(result.events[0]!.newRevision, 1);
});

test('same-key approvals replay after revoke and reopen without issuing or reviving a grant', t => {
  const f = setup(t), request = pending(f), key = command(), input = approval(request), original = f.repository.approveRequest(input, key, f.context);
  f.repository.revokeGrant({ grantId: original.grant!.grantId, expectedRevision: 1 }, command(), f.context);
  const db = new Database({ path: f.path }); t.after(() => db.close()); const other = new CanonicalGrantRepository(db, 'local-human');
  assert.deepEqual(other.approveRequest(input, { ...key, requestId: randomUUID(), correlationId: randomUUID() }, f.context), original);
  assert.equal(other.getGrant(original.grant!.grantId, f.context).status, 'revoked'); assert.equal(other.events(original.grant!.grantId, f.context).length, 2);
  assert.throws(() => other.approveRequest({ ...input, expiresAt: '2026-09-15T12:09:00Z' }, key, f.context), error('conflict'));
});

test('stale revision, confirmation, class or duration cannot issue a grant', t => {
  const f = setup(t), request = pending(f), base = approval(request);
  for (const changed of [{ expectedRevision: 9 }, { confirmationDigest: 'b'.repeat(64) }, { grantClass: 'allowSession' as const }, { expiresAt: '2026-09-15T12:11:00Z' }, { reviewAfter: '2026-09-15T12:09:00Z' }]) {
    assert.throws(() => f.repository.approveRequest({ ...base, ...changed }, command(), f.context), error('conflict'));
  }
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 0); assert.equal(f.repository.getRequest(request.requestId, f.context).state, 'pending');
});

test('authentication scope and governing provider are checked on reads, decisions and recorded-command replay', t => {
  const f = setup(t), key = command(), request = f.repository.createRequest(f.proposal, key, f.context).request!;
  const other = { ...f.context, principalId: randomUUID() };
  assert.throws(() => f.repository.getRequest(request.requestId, other), error('notFound'));
  assert.throws(() => f.repository.createRequest(f.proposal, key, other), error('notFound'));
  assert.throws(() => new CanonicalGrantRepository(f.db, 'external-provider').getRequest(request.requestId, f.context), error('notFound'));
  f.setAllowed(false);
  assert.throws(() => f.repository.createRequest(f.proposal, key, f.context), /scope denied/);
  assert.throws(() => f.repository.approveRequest(approval(request), command(), f.context), /scope denied/);
});

test('failed issuance event write rolls back grant, request decision and idempotency completion', t => {
  const f = setup(t), request = pending(f), key = command();
  f.db.exec("CREATE TRIGGER fail_issue BEFORE INSERT ON canonical_grant_events BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END");
  assert.throws(() => f.repository.approveRequest(approval(request), key, f.context), /synthetic event failure/);
  assert.equal(f.repository.getRequest(request.requestId, f.context).state, 'pending'); assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 0);
  f.db.exec('DROP TRIGGER fail_issue'); assert.equal(f.repository.approveRequest(approval(request), key, f.context).grant!.status, 'active');
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 1);
});

test('expiry during the final authenticated approval guard rolls back issuance', t => {
  const f = setup(t), request = pending(f); let checks = 0; const current = f.context.assertCurrent;
  f.context.assertCurrent = scope => { current(scope); if (++checks === 3) f.setNow(request.expiresAt); };
  assert.throws(() => f.repository.approveRequest(approval(request), command(), f.context), error('expired'));
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 0);
});

test('a caller mutation during ownership checks cannot widen the stored proposal', t => {
  const f = setup(t), expected = structuredClone(f.proposal.request.scope), current = f.context.assertCurrent;
  f.context.assertCurrent = scope => { current(scope); f.proposal.request.scope.targetRefs.push('target:unreviewed'); };
  const request = pending(f); assert.deepEqual(request.scope, expected);
});

test('request expiry, terminal decisions and grant expiry preserve their lifecycle history', t => {
  const f = setup(t), request = pending(f); f.setNow(request.expiresAt);
  assert.equal(f.repository.getRequest(request.requestId, f.context).state, 'expired');
  assert.throws(() => f.repository.approveRequest(approval(request), command(), f.context), error('conflict'));
  f.setNow('2026-09-15T12:00:00Z'); const grant = issued(f); f.setNow(grant.expiresAt);
  const expired = f.repository.getGrant(grant.grantId, f.context); assert.equal(expired.status, 'expired'); assert.equal(expired.revision, 2);
  assert.equal(f.repository.getGrant(grant.grantId, f.context).revision, 2);
  const revoked = f.repository.revokeGrant({ grantId: grant.grantId, expectedRevision: 1 }, command(), f.context);
  assert.equal(revoked.grant!.status, 'expired'); assert.deepEqual(f.repository.events(grant.grantId, f.context).map(event => event.type), ['issued','expired']);
});

test('denial and cancellation are terminal and never create grants', t => {
  const f = setup(t);
  for (const decision of ['denied','cancelled'] as const) {
    const request = pending(f); const result = f.repository.decideRequest({ requestId: request.requestId, expectedRevision: 1, decision }, command(), f.context);
    assert.equal(result.request!.state, decision); assert.equal(result.grant, null);
    assert.throws(() => f.repository.approveRequest(approval(request), command(), f.context), error('conflict'));
  }
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 0);
});

test('canonical storage does not upgrade legacy grants or allow broader grants without trusted argument-scope derivation', t => {
  const f = setup(t);
  f.db.connection.prepare('INSERT INTO authority_grants VALUES (?,?,?,?,?,?,?,?)').run('legacy', f.context.principalId, f.proposal.request.assistantId, 'active', '["synthetic.echo"]', 1, '{}', f.context.now());
  const before = f.db.connection.prepare('SELECT * FROM authority_grants').all();
  f.proposal.scopeDerivation = 'inputBoundOnly'; f.proposal.request.requestedClass = 'allowSession';
  assert.throws(() => pending(f), error('scopeDerivationRequired'));
  f.proposal.request.requestedClass = 'allowOnce'; issued(f);
  assert.deepEqual(f.db.connection.prepare('SELECT * FROM authority_grants').all(), before);
});

test('corrupt canonical records and audit bytes are withheld', t => {
  const f = setup(t), request = pending(f), grant = f.repository.approveRequest(approval(request), command(), f.context).grant!;
  f.db.connection.prepare("UPDATE canonical_grants SET payload_json='{}'").run(); assert.throws(() => f.repository.getGrant(grant.grantId, f.context), error('unavailable'));
  const bytes = JSON.stringify(grant); f.db.connection.prepare('UPDATE canonical_grants SET payload_json=?,sha256=?').run(bytes, createHash('sha256').update(bytes).digest('hex'));
  f.db.connection.prepare("UPDATE canonical_grant_events SET payload_json='{}'").run(); assert.throws(() => f.repository.events(grant.grantId, f.context), error('unavailable'));
});

function evaluation(f: ReturnType<typeof setup>, grant: ReturnType<typeof issued>) {
  const authorityContextRef = { providerRef: 'local-human', contextId: randomUUID(), revision: 1 };
  const request: AuthorityRequest = { schemaVersion: '1.0.0', operation: 'AuthorityProvider.evaluate', requestId: randomUUID(), correlationId: randomUUID(),
    deadlineAt: '2026-09-15T12:02:00Z', cancellationId: randomUUID(), executionMode: 'normal', idempotencyKey: null,
    scope: { assistantId: grant.assistantId, environmentId: grant.environmentId, conversationId: null, sessionId: f.proposal.request.sessionId,
      endpointId: grant.endpointId, interactionTraceId: f.proposal.request.interactionTraceId, authorityContextRef },
    payload: { grantId: grant.grantId, invocationId: f.proposal.request.invocationId, scope: structuredClone(grant.scope), inputDigest: f.proposal.request.inputDigest, snapshotId: randomUUID(), snapshotRevision: 1 } };
  const context = { principalId: f.context.principalId, sessionId: f.proposal.request.sessionId, now: f.context.now(), authorityContextRef, assertCurrent() {} };
  return { request, context };
}

test('canonical eligibility enforces exact owner, endpoint, environment, operation, version and explicit target/data subsets', t => {
  const f = setup(t), grant = issued(f), { request, context } = evaluation(f, grant);
  const check = (candidate = request) => evaluateCanonicalGrant(grant, candidate, context);
  assert.equal(check().disposition, 'authorized'); request.payload.scope.targetRefs = ['target:one']; request.payload.scope.dataScopeRefs = [];
  assert.equal(check().disposition, 'authorized');
  for (const [field, value] of [['capabilityId','synthetic.other'],['capabilityVersion','1.1.0'],['operation','other'],['targetRefs',['target:foreign']],['dataScopeRefs',['data:foreign']]] as const) {
    const changed = structuredClone(request); (changed.payload.scope as any)[field] = value; assert.equal(check(changed).disposition, 'denied');
  }
  for (const field of ['assistantId','endpointId','environmentId'] as const) { const changed = structuredClone(request); changed.scope[field] = randomUUID(); assert.equal(check(changed).disposition, 'denied'); }
  assert.equal(evaluateCanonicalGrant(grant, request, { ...context, principalId: randomUUID() }).disposition, 'denied');
  assert.equal(evaluateCanonicalGrant({ ...grant, scope: { ...grant.scope, dataScopeRefs: [] } }, { ...request, payload: { ...request.payload, scope: { ...request.payload.scope, dataScopeRefs: ['data:one'] } } }, context).disposition, 'denied');
});

test('canonical eligibility binds one-use arguments and session; no fallback grant or replay authorization exists', t => {
  const f = setup(t), grant = issued(f), { request, context } = evaluation(f, grant);
  for (const change of [{ invocationId: randomUUID() }, { inputDigest: 'b'.repeat(64) }, { grantId: randomUUID() }]) {
    assert.equal(evaluateCanonicalGrant(grant, { ...request, payload: { ...request.payload, ...change } }, context).disposition, 'denied');
  }
  assert.equal(evaluateCanonicalGrant(grant, { ...request, executionMode: 'replay' }, context).reasonCode, 'authority_replay_mismatch');
  assert.equal(evaluateCanonicalGrant(grant, request, { ...context, sessionId: randomUUID() }).reasonCode, 'authority_session_inactive');
  assert.equal(evaluateCanonicalGrant(undefined, request, context).disposition, 'denied');
  assert.equal(evaluateCanonicalGrant(undefined, { ...request, payload: { ...request.payload, grantId: null } }, context).disposition, 'approvalRequired');
});

test('session and persistent grants retain class-specific bindings and enforce review/expiry at exact boundaries', t => {
  const f = setup(t); f.proposal.request.requestedClass = 'allowSession'; const session = issued(f);
  assert.equal(session.invocationId, null); assert.equal(session.inputDigest, null); assert.equal(session.reviewAfter, null);
  f.proposal.request.requestedClass = 'allowPersistent'; f.proposal.request.reviewAfter = '2026-09-15T12:01:00Z'; const persistent = issued(f);
  assert.equal(persistent.sessionId, null); const { request, context } = evaluation(f, persistent);
  assert.equal(evaluateCanonicalGrant(persistent, request, context).disposition, 'authorized');
  assert.equal(evaluateCanonicalGrant(persistent, request, { ...context, now: persistent.reviewAfter! }).reasonCode, 'authority_review_due');
  assert.equal(evaluateCanonicalGrant(persistent, { ...request, deadlineAt: '2026-09-15T12:11:00Z' }, { ...context, now: persistent.expiresAt }).reasonCode, 'authority_grant_expired');
  assert.equal(evaluateCanonicalGrant(persistent, request, { ...context, now: 'invalid-clock' }).disposition, 'denied');
  f.repository.revokeGrant({ grantId: persistent.grantId, expectedRevision: 1 }, command(), f.context);
  assert.equal(evaluateCanonicalGrant(f.repository.getGrant(persistent.grantId, f.context), request, context).reasonCode, 'authority_grant_revoked');
});

test('evaluation isolates callback arguments and rejects authentication changes during either current-state check', t => {
  const f = setup(t), grant = issued(f);
  for (const phase of [1, 2]) {
    const { request, context } = evaluation(f, grant); let checks = 0;
    context.assertCurrent = () => { if (++checks === phase) context.authorityContextRef.revision++; };
    assert.equal(evaluateCanonicalGrant(grant, request, context).reasonCode, 'authority_stale_context');
  }
  const { request, context } = evaluation(f, grant); request.scope.endpointId = randomUUID();
  assert.equal(evaluateCanonicalGrant(grant, request, { ...context, assertCurrent(scope) { scope.endpointId = grant.endpointId; } }).reasonCode, 'authority_scope_mismatch');
  assert.notEqual(request.scope.endpointId, grant.endpointId);
});

test('valid bytes cannot be transplanted to another record ID or lifecycle history', t => {
  const f = setup(t), first = pending(f), second = pending(f);
  const row = f.db.connection.prepare('SELECT payload_json,sha256 FROM canonical_grant_requests WHERE request_id=?').get(second.requestId) as any;
  f.db.connection.prepare('UPDATE canonical_grant_requests SET payload_json=?,sha256=? WHERE request_id=?').run(row.payload_json, row.sha256, first.requestId);
  assert.throws(() => f.repository.getRequest(first.requestId, f.context), error('unavailable'));
  const one = issued(f), two = issued(f);
  const event = f.db.connection.prepare('SELECT payload_json,sha256 FROM canonical_grant_events WHERE grant_id=?').get(two.grantId) as any;
  f.db.connection.prepare('UPDATE canonical_grant_events SET payload_json=?,sha256=? WHERE grant_id=?').run(event.payload_json, event.sha256, one.grantId);
  assert.throws(() => f.repository.events(one.grantId, f.context), error('unavailable'));
  const replacement = JSON.stringify(two);
  f.db.connection.prepare('UPDATE canonical_grants SET payload_json=?,sha256=? WHERE grant_id=?').run(replacement, createHash('sha256').update(replacement).digest('hex'), one.grantId);
  assert.throws(() => f.repository.getGrant(one.grantId, f.context), error('unavailable'));
});

test('competing approvals and denial commit exactly one terminal request decision', async t => {
  const { Worker } = await import('node:worker_threads');
  const f = setup(t), request = pending(f), start = new SharedArrayBuffer(4), barrier = new Int32Array(start);
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { Database } = await import(workerData.databaseModule);
      const { CanonicalGrantRepository } = await import(workerData.grantModule);
      const db = new Database({ path: workerData.path });
      const context = { ...workerData.context, now: () => workerData.now, assertCurrent() {} };
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.start), 0, 0);
      try { const result = new CanonicalGrantRepository(db, 'local-human')[workerData.method](workerData.input, workerData.command, context);
        parentPort.postMessage({ state: result.request.state, grantId: result.grant?.grantId ?? null });
      } catch (error) { parentPort.postMessage({ code: error.code }); }
      finally { db.close(); }
    })().catch(error => { throw error; });`;
  const workers = [0, 1, 2].map(index => new Worker(source, { eval: true, workerData: {
    databaseModule: new URL('../src/database.ts', import.meta.url).href,
    grantModule: new URL('../src/authority/canonical-grants.ts', import.meta.url).href,
    path: f.path, context: { principalId: f.context.principalId, providerRef: f.context.providerRef, authenticationEvidenceRef: f.context.authenticationEvidenceRef },
    now: f.context.now(), method: index === 2 ? 'decideRequest' : 'approveRequest',
    input: index === 2 ? { requestId: request.requestId, expectedRevision: 1, decision: 'denied' } : approval(request), command: command(), start
  } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  let ready = 0;
  const results = await Promise.all(workers.map(worker => new Promise<any>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('exit', code => { if (code !== 0) reject(new Error(`Approval worker exited ${code}`)); });
    worker.on('message', message => { if (message.ready) { if (++ready === 3) { Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0); } } else resolve(message); });
  })));
  const winners = results.filter(result => result.state);
  assert.equal(winners.length, 1);
  assert.equal(results.filter(result => result.code === 'conflict').length, 2);
  const grantCount = winners[0].state === 'approved' ? 1 : 0;
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, grantCount);
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grant_events').all().length, grantCount);
  assert.equal(f.repository.getRequest(request.requestId, f.context).state, winners[0].state);
});


test('backwards or unavailable trusted time cannot approve a pending request', t => {
  const f = setup(t), request = pending(f);
  f.setNow('2026-09-15T11:59:59Z');
  assert.throws(() => f.repository.approveRequest(approval(request), command(), f.context), error('unavailable'));
  f.setNow('invalid-clock');
  assert.throws(() => f.repository.approveRequest(approval(request), command(), f.context), error('invalid'));
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 0);
});

test('denial and revocation retries preserve recorded decisions and reject changed content', t => {
  const f = setup(t), request = pending(f), denialKey = command();
  const input = { requestId: request.requestId, expectedRevision: 1, decision: 'denied' as const };
  const denied = f.repository.decideRequest(input, denialKey, f.context);
  assert.deepEqual(f.repository.decideRequest(input, denialKey, f.context), denied);
  assert.throws(() => f.repository.decideRequest({ ...input, decision: 'cancelled' }, denialKey, f.context), error('conflict'));
  const grant = issued(f), revokeKey = command(), revokeInput = { grantId: grant.grantId, expectedRevision: 1 };
  const revoked = f.repository.revokeGrant(revokeInput, revokeKey, f.context);
  assert.deepEqual(f.repository.revokeGrant(revokeInput, revokeKey, f.context), revoked);
  assert.throws(() => f.repository.revokeGrant({ ...revokeInput, expectedRevision: 2 }, revokeKey, f.context), error('conflict'));
  assert.equal(f.repository.events(grant.grantId, f.context).length, 2);
});
