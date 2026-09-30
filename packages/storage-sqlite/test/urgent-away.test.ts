import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {Database, type Transaction} from '../src/database.ts';
import {loadMigrations} from '../src/migrations/index.ts';
import {UrgentAttentionRepository} from '../src/urgent-attention.ts';
import {UrgentAwayRepository, type UrgentAwayInput, type UrgentAwayOutcome} from '../src/urgent-away.ts';

const now = '2026-09-24T12:00:00.000Z';
const later = '2026-09-24T12:00:01.000Z';
const scope = {principalId: 'owner', assistantId: 'assistant', endpointId: 'phone'};
const input = (patch: Partial<UrgentAwayInput> = {}): UrgentAwayInput => ({scope, destinationRef: 'private-notice', destinationRevision: 1,
  conditionRef: 'condition:one', conditionRevision: 1, sourceRef: 'source:one', eventClass: 'critical-condition', capabilityId: 'notice.send',
  capabilityVersion: '1.0.0', capabilityRoute: 'synthetic:notice', capabilityScopeDigest: 'a'.repeat(64), invocationId: 'invocation:one',
  inputDigest: 'b'.repeat(64), expiresAt: '2026-09-24T12:01:00.000Z', ...patch});
function fixture(t: TestContext, capacity = 4096) {
  const db = new Database({path: ':memory:'});
  db.migrate();
  t.after(() => db.close());
  return new UrgentAwayRepository(db, capacity);
}
function fileFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'urgent-away-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return join(directory, 'state.sqlite');
}

test('destination binding requires disabled policy before first ownership or route change and preserves unchanged consent', t => {
  const repo = fixture(t), policy = new UrgentAttentionRepository(repo.database);
  const configuration = {rules: [{sourceRef: 'source:one', eventClass: 'critical-condition', enabled: true, bypassQuietHours: true}],
    modality: 'text' as const, quietHours: null, snoozedUntil: null};
  let settings = policy.configure(scope, 0, configuration, now).settings;
  assert.throws(() => repo.bindDestination(scope, 'a'.repeat(64), now), /away_binding_requires_disabled/);
  assert.equal(repo.destinationBinding(scope), undefined);
  settings = policy.configure(scope, settings.revision, {...configuration, rules: configuration.rules.map(rule => ({...rule, enabled: false}))}, now).settings;
  assert.throws(() => repo.bindDestination(scope, 'a'.repeat(64), now), /away_binding_requires_disabled/);
  const disabled = {...configuration, rules: configuration.rules.map(rule => ({...rule, enabled: false, bypassQuietHours: false}))};
  settings = policy.configure(scope, settings.revision, {...disabled, snoozedUntil: input().expiresAt}, now).settings;
  assert.throws(() => repo.bindDestination(scope, 'a'.repeat(64), now), /away_binding_requires_disabled/);
  settings = policy.configure(scope, settings.revision, disabled, now).settings;
  assert.deepEqual(repo.bindDestination(scope, 'a'.repeat(64), now), {bindingDigest: 'a'.repeat(64), boundAt: now});
  settings = policy.configure(scope, settings.revision, configuration, later).settings;
  assert.equal(repo.bindDestination(scope, 'a'.repeat(64), later).boundAt, now);
  assert.deepEqual(policy.settings(scope), settings);
  assert.throws(() => repo.bindDestination(scope, 'b'.repeat(64), later), /away_binding_requires_disabled/);
  settings = policy.configure(scope, settings.revision, disabled, later).settings;
  assert.deepEqual(repo.bindDestination(scope, 'b'.repeat(64), later), {bindingDigest: 'b'.repeat(64), boundAt: later});
  assert.deepEqual(policy.settings(scope), settings);
  const emptyScope = {...scope, endpointId: 'new-endpoint'};
  repo.bindDestination(emptyScope, 'c'.repeat(64), now);
  assert.equal(policy.settings(emptyScope).revision, 0, 'binding alone cannot fabricate a policy revision or consent');
});

test('reservation is scope-bound, immutable, and deduplicated for the lifetime condition episode', t => {
  const repo = fixture(t);
  const first = repo.reserve(input(), now);
  assert.equal(first.created, true);
  assert.equal(first.record.state, 'reserved');
  assert.equal(first.record.attemptedAt, null);
  assert.equal(first.record.acceptedAt, null);
  assert.equal(first.record.acknowledgedAt, null);
  const repeated = repo.reserve(input(), later);
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.record, first.record);
  assert.deepEqual(repo.find(scope, 'private-notice', 'condition:one'), first.record);
  for (const patch of [{conditionRevision: 2}, {destinationRevision: 2}, {capabilityRoute: 'other'}, {capabilityScopeDigest: 'c'.repeat(64)},
    {inputDigest: 'c'.repeat(64)}, {sourceRef: 'other'}, {eventClass: 'other'}, {invocationId: 'other'}]) {
    assert.throws(() => repo.reserve(input(patch), later), /away_binding_conflict/);
  }
  const otherScope = {...scope, principalId: 'other-owner'};
  assert.equal(repo.find(otherScope, 'private-notice', 'condition:one'), undefined);
  assert.throws(() => repo.reserve(input({scope: otherScope}), now), /away_invocation_conflict/);
  const second = repo.reserve(input({scope: otherScope, invocationId: 'invocation:two'}), now);
  assert.notEqual(second.record.id, first.record.id);
  first.record.scope.principalId = 'changed-outside-storage';
  assert.equal(repo.get(first.record.id)?.scope.principalId, 'owner');
});

test('only a committed CAS attempt can precede acceptance; independent connections observe the attempt', t => {
  const path = fileFixture(t);
  const db = new Database({path}); db.migrate();
  const other = new Database({path}); other.migrate();
  t.after(() => { other.close(); db.close(); });
  const repo = new UrgentAwayRepository(db), peer = new UrgentAwayRepository(other);
  const reserved = repo.reserve(input(), now).record;
  assert.throws(() => repo.settle(reserved.id, reserved.revision, {state: 'accepted', reason: 'provider_accepted'}, now), /invalid_away_transition/);
  assert.throws(() => repo.settle(reserved.id, reserved.revision, {state: 'unknown', reason: 'provider_unknown'}, now), /invalid_away_transition/);
  const attempt = repo.markAttempted(reserved.id, reserved.revision, later);
  assert.equal(peer.get(attempt.id)?.state, 'attempted');
  assert.equal(peer.get(attempt.id)?.attemptedAt, later);
  assert.throws(() => peer.markAttempted(reserved.id, reserved.revision, later), /away_revision_conflict/);
  assert.throws(() => peer.markAttempted(attempt.id, attempt.revision, later), /invalid_away_transition/);
  const accepted = peer.settle(attempt.id, attempt.revision, {state: 'accepted', reason: 'provider_accepted', receiptDigest: 'c'.repeat(64)}, later);
  assert.equal(repo.get(attempt.id)?.acceptedAt, later);
  assert.equal(accepted.acknowledgedAt, null);
  assert.throws(() => repo.settle(attempt.id, attempt.revision, {state: 'failed', reason: 'provider_failed'}, later), /away_revision_conflict/);
});

test('journal transactions use durable synchronous mode and restore caller settings after success and failure', t => {
  const repo = fixture(t), db = repo.database;
  db.connection.exec('PRAGMA synchronous=NORMAL');
  const observed: number[] = [];
  const transaction = db.transaction.bind(db);
  db.transaction = <T>(operation: (tx: Transaction) => T): T => {
    observed.push(Number(db.connection.prepare('PRAGMA synchronous').get()!.synchronous));
    return transaction(operation);
  };
  const record = repo.reserve(input(), now).record;
  assert.throws(() => repo.markAttempted(record.id, 99, now), /away_revision_conflict/);
  assert.deepEqual(observed, [2, 2]);
  assert.equal(Number(db.connection.prepare('PRAGMA synchronous').get()!.synchronous), 1);
  assert.equal(repo.get(record.id)?.state, 'reserved');
});

test('an attempted-write failure rolls back the marker and cannot release permission for provider I/O', t => {
  const repo = fixture(t), record = repo.reserve(input(), now).record;
  repo.database.exec("CREATE TRIGGER synthetic_attempt_failure BEFORE UPDATE ON urgent_away_dispatches WHEN NEW.state='attempted' BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;");
  let invoked = false;
  assert.throws(() => {
    repo.markAttempted(record.id, record.revision, later);
    invoked = true;
  }, /synthetic write failure/);
  assert.equal(invoked, false);
  assert.deepEqual(repo.get(record.id), record);
});

test('concurrent workers can release only one durable permission to attempt an effect', async t => {
  const path = fileFixture(t), db = new Database({path}); db.migrate(); t.after(() => db.close());
  const repo = new UrgentAwayRepository(db), record = repo.reserve(input(), now).record;
  const workerSource = `
    import {parentPort,workerData} from 'node:worker_threads';
    import {Database} from ${JSON.stringify(new URL('../src/database.ts', import.meta.url).href)};
    import {UrgentAwayRepository} from ${JSON.stringify(new URL('../src/urgent-away.ts', import.meta.url).href)};
    const db=new Database({path:workerData.path});
    try { const record=new UrgentAwayRepository(db).markAttempted(workerData.id,1,workerData.now); parentPort.postMessage(record.state); }
    catch(error) { parentPort.postMessage(error.code); }
    finally { db.close(); }
  `;
  const run = () => new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerSource)), {workerData: {path, id: record.id, now: later}});
    let result: string;
    worker.once('message', value => { result = value; });
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve(result!) : reject(new Error('Synthetic worker failed')));
  });
  assert.deepEqual((await Promise.all([run(), run()])).sort(), ['attempted', 'away_revision_conflict']);
  assert.equal(repo.get(record.id)?.revision, 2);
});

test('admission denial, approval and pre-dispatch failure never imply an attempted effect', t => {
  const repo = fixture(t);
  const outcomes: UrgentAwayOutcome[] = [{state: 'denied', reason: 'admission_denied'}, {state: 'approvalRequired', reason: 'approval_required'},
    {state: 'failed', reason: 'destination_unavailable'}, {state: 'cancelled', reason: 'condition_changed'}];
  for (const [index, outcome] of outcomes.entries()) {
    const data = input({conditionRef: 'condition:' + index, invocationId: 'invocation:' + index});
    const reserved = repo.reserve(data, now).record;
    const terminal = repo.settle(reserved.id, reserved.revision, outcome, later);
    assert.equal(terminal.state, outcome.state);
    assert.equal(terminal.attemptedAt, null);
    assert.equal(terminal.acceptedAt, null);
    assert.equal(terminal.acknowledgedAt, null);
    assert.equal(repo.reserve(data, later).created, false);
    assert.throws(() => repo.markAttempted(terminal.id, terminal.revision, later), /invalid_away_transition/);
  }
});

test('provider receipt, late retirement and explicit Human acknowledgement preserve distinct truth', t => {
  const repo = fixture(t);
  let record = repo.reserve(input(), now).record;
  record = repo.markAttempted(record.id, record.revision, now);
  record = repo.settle(record.id, record.revision, {state: 'accepted', reason: 'provider_accepted', receiptDigest: 'd'.repeat(64)}, later);
  const acceptedRevision = record.revision;
  assert.equal(record.acknowledgedAt, null);
  assert.throws(() => repo.acknowledge({...scope, principalId: 'other'}, record.id, record.revision, later), /away_dispatch_not_found/);
  record = repo.acknowledge(scope, record.id, record.revision, later);
  assert.equal(record.acknowledgedAt, later);
  assert.throws(() => repo.acknowledge(scope, record.id, record.revision, later), /away_already_acknowledged/);
  assert.throws(() => repo.settle(record.id, acceptedRevision, {state: 'cancelled', reason: 'scope_changed'}, later), /away_revision_conflict/);
  assert.throws(() => repo.settle(record.id, record.revision, {state: 'cancelled', reason: 'scope_changed', receiptDigest: 'e'.repeat(64)}, later), /away_receipt_conflict/);
  record = repo.settle(record.id, record.revision, {state: 'cancelled', reason: 'scope_changed'}, later);
  assert.equal(record.attemptedAt, now);
  assert.equal(record.acceptedAt, later);
  assert.equal(record.receiptDigest, 'd'.repeat(64));
  assert.equal(record.acknowledgedAt, later);
  assert.equal(repo.reserve(input(), later).created, false);
});

test('uncertain admission retains unknown prior dispatch truth without inventing a local attempt', t => {
  const repo = fixture(t), reserved = repo.reserve(input(), now).record;
  assert.throws(() => repo.settle(reserved.id, reserved.revision, {state: 'unknown', reason: 'provider_unknown'}, later), /invalid_away_transition/);
  assert.throws(() => repo.settle(reserved.id, reserved.revision, {state: 'failed', reason: 'admission_uncertain'}, later), /invalid_away_outcome/);
  assert.throws(() => repo.settle(reserved.id, reserved.revision, {state: 'unknown', reason: 'admission_uncertain', receiptDigest: 'c'.repeat(64)}, later), /invalid_away_outcome/);
  const uncertain = repo.settle(reserved.id, reserved.revision, {state: 'unknown', reason: 'admission_uncertain'}, later);
  assert.equal(uncertain.attemptedAt, null);
  assert.equal(uncertain.acceptedAt, null);
  assert.equal(uncertain.acknowledgedAt, null);
  assert.equal(uncertain.receiptDigest, null);
  assert.equal(repo.reserve(input(), later).created, false);
  assert.throws(() => repo.markAttempted(uncertain.id, uncertain.revision, later), /invalid_away_transition/);
  assert.deepEqual(repo.recover(later), []);
  assert.deepEqual(repo.quarantine(later), []);
  let attempted = repo.reserve(input({conditionRef: 'another', invocationId: 'another'}), now).record;
  attempted = repo.markAttempted(attempted.id, attempted.revision, now);
  assert.throws(() => repo.settle(attempted.id, attempted.revision, {state: 'unknown', reason: 'admission_uncertain'}, later), /invalid_away_outcome/);
});

test('restart fences incomplete rows durably and never converts uncertain outcome into resend permission', t => {
  const path = fileFixture(t);
  let db = new Database({path}); db.migrate();
  let repo = new UrgentAwayRepository(db);
  const reserved = repo.reserve(input(), now).record;
  let attempted = repo.reserve(input({conditionRef: 'condition:two', invocationId: 'invocation:two'}), now).record;
  attempted = repo.markAttempted(attempted.id, attempted.revision, now);
  let accepted = repo.reserve(input({conditionRef: 'condition:three', invocationId: 'invocation:three'}), now).record;
  accepted = repo.markAttempted(accepted.id, accepted.revision, now);
  accepted = repo.settle(accepted.id, accepted.revision, {state: 'accepted', reason: 'provider_accepted'}, later);
  db.close(); db = new Database({path}); db.migrate(); t.after(() => db.close()); repo = new UrgentAwayRepository(db);
  assert.equal(repo.recover(later).length, 2);
  assert.equal(repo.get(reserved.id)?.state, 'cancelled');
  assert.equal(repo.get(reserved.id)?.attemptedAt, null);
  const uncertain = repo.get(attempted.id)!;
  assert.equal(uncertain.state, 'unknown');
  assert.equal(uncertain.attemptedAt, now);
  assert.equal(uncertain.reason, 'consumer_restarted');
  assert.deepEqual(repo.get(accepted.id), accepted);
  assert.deepEqual(repo.recover(later), []);
  assert.throws(() => repo.markAttempted(uncertain.id, uncertain.revision, later), /invalid_away_transition/);
  assert.throws(() => repo.settle(uncertain.id, uncertain.revision, {state: 'accepted', reason: 'provider_accepted'}, later), /invalid_away_transition/);
  assert.equal(repo.reserve(input(), later).created, false);
});

test('restore quarantine retains accepted history, rejects pending work and preserves unknown attempts', t => {
  const repo = fixture(t);
  const reserved = repo.reserve(input(), now).record;
  let attempted = repo.reserve(input({conditionRef: 'condition:two', invocationId: 'invocation:two'}), now).record;
  attempted = repo.markAttempted(attempted.id, attempted.revision, later);
  let accepted = repo.reserve(input({conditionRef: 'condition:three', invocationId: 'invocation:three'}), now).record;
  accepted = repo.markAttempted(accepted.id, accepted.revision, now);
  accepted = repo.settle(accepted.id, accepted.revision, {state: 'accepted', reason: 'provider_accepted'}, now);
  const changed = repo.quarantine(now); // A clock rollback cannot reopen startup work.
  assert.equal(changed.length, 2);
  assert.equal(repo.get(reserved.id)?.state, 'cancelled');
  assert.equal(repo.get(attempted.id)?.state, 'unknown');
  assert.equal(repo.get(attempted.id)?.updatedAt, later);
  assert.ok(changed.every(row => row.reason === 'restore_quarantine'));
  assert.deepEqual(repo.get(accepted.id), accepted);
  assert.deepEqual(repo.quarantine(later), []);
});

test('bounded inspection and fail-closed quota never remove older deduplication tombstones', t => {
  const repo = fixture(t, 101);
  for (let i = 0; i < 101; i++) repo.reserve(input({conditionRef: 'condition:' + i, invocationId: 'invocation:' + i}), now);
  assert.equal(repo.inspect(scope).length, 100);
  assert.equal(repo.inspect({...scope, endpointId: 'other'}).length, 0);
  assert.throws(() => repo.reserve(input({conditionRef: 'overflow', invocationId: 'overflow'}), now), /away_capacity_exhausted/);
  assert.equal(repo.database.connection.prepare('SELECT count(*) AS n FROM urgent_away_dispatches').get()!.n, 101);
  assert.equal(repo.reserve(input({conditionRef: 'condition:0', invocationId: 'invocation:0'}), now).created, false);
  assert.ok(repo.find(scope, 'private-notice', 'condition:0'));
});

test('expired reservations and stale clocks cannot be marked as attempted', t => {
  const repo = fixture(t);
  assert.throws(() => repo.reserve(input({expiresAt: now}), now), /away_dispatch_expired/);
  const reserved = repo.reserve(input(), later).record;
  assert.throws(() => repo.markAttempted(reserved.id, reserved.revision, now), /away_clock_regressed/);
  assert.throws(() => repo.markAttempted(reserved.id, reserved.revision, input().expiresAt), /away_dispatch_expired/);
  assert.equal(repo.get(reserved.id)?.attemptedAt, null);
  assert.throws(() => repo.markAttempted(reserved.id, reserved.revision, 'not a timestamp'), /invalid_away_mutation/);
});

test('unknown fields and unbounded payloads are rejected without retaining notice, credentials or provider prose', t => {
  const repo = fixture(t), secret = 'credential-canary-do-not-retain';
  for (const extra of [{text: secret}, {apiKey: secret}, {providerOutput: {token: secret}}, {errors: [secret]}]) {
    assert.throws(() => repo.reserve({...input(), ...extra}, now), /invalid_away_input/);
  }
  for (const patch of [{sourceRef: 'x'.repeat(129)}, {capabilityRoute: 'https://user:password@example.invalid'}, {inputDigest: secret},
    {destinationRevision: 0}, {conditionRevision: 1.5}, {expiresAt: secret}]) assert.throws(() => repo.reserve(input(patch), now), /invalid_away_input/);
  const reserved = repo.reserve(input(), now).record;
  assert.throws(() => repo.settle(reserved.id, reserved.revision, {state: 'failed', reason: secret} as UrgentAwayOutcome, later), /invalid_away_outcome/);
  assert.throws(() => repo.settle(reserved.id, reserved.revision, {...{state: 'failed', reason: 'provider_failed'}, output: secret} as UrgentAwayOutcome, later), /invalid_away_outcome/);
  assert.throws(() => repo.settle(reserved.id, reserved.revision, {state: 'failed', reason: 'provider_failed', receiptDigest: 'c'.repeat(64)}, later), /invalid_away_outcome/);
  const rows = repo.database.connection.prepare('SELECT record_json FROM urgent_away_dispatches').all();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(secret));
});

test('migration 53 preserves earlier schema records and unrelated application data', t => {
  const path = fileFixture(t), migrations = loadMigrations();
  let db = new Database({path, migrations: migrations.filter(m => m.id < 53)});
  const earlier = db.migrate();
  const settings = new UrgentAttentionRepository(db).configure(scope, 0, {
    rules: [{sourceRef: 'source:one', eventClass: 'critical-condition', enabled: true, bypassQuietHours: false}],
    modality: 'text', quietHours: null, snoozedUntil: null,
  }, now).settings;
  db.exec("CREATE TABLE synthetic_preservation (id TEXT PRIMARY KEY,value TEXT); INSERT INTO synthetic_preservation VALUES ('one','unchanged');");
  const before = db.connection.prepare('SELECT * FROM synthetic_preservation').all();
  db.close(); db = new Database({path}); t.after(() => db.close());
  const all = db.migrate();
  assert.deepEqual(all.slice(0, earlier.length), earlier);
  assert.deepEqual(all.slice(earlier.length).map(m => m.id), [53, 54, 55, 56, 57, 58, 59, 60, 61, 62]);
  assert.deepEqual(db.connection.prepare('SELECT * FROM synthetic_preservation').all(), before);
  assert.deepEqual(new UrgentAttentionRepository(db).settings(scope), settings);
  assert.equal(db.connection.prepare('SELECT count(*) AS n FROM urgent_away_dispatches').get()!.n, 0);
});

test('destination-scoped recovery leaves other running workers pending records unchanged',t=>{
 const repo=fixture(t),other={...scope,endpointId:'second-phone'};
 const active=repo.reserve(input(),now).record;
 const interrupted=repo.reserve(input({scope:other,invocationId:'invocation:other'}),now).record;
 assert.deepEqual(repo.recover(later,[]),[]);
 assert.equal(repo.recover(later,[other]).length,1);
 assert.deepEqual(repo.get(active.id),active);
 assert.equal(repo.get(interrupted.id)?.state,'cancelled');
 assert.equal(repo.recover(later,[scope]).length,1);
 assert.equal(repo.get(active.id)?.state,'cancelled');
});
