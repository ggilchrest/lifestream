import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Database } from '../src/database.ts';
import { loadMigrations } from '../src/migrations/index.ts';
import { AdmissionRepository } from '../src/authority/admission.ts';

const now = '2026-09-15T12:00:00Z';
const input = () => ({ grantId: 'grant', principalId: 'human', assistantId: 'assistant', sessionId: 'session', capabilityId: 'synthetic.echo',
  invocationId: 'invocation', inputDigest: 'a'.repeat(64), now, assertCurrent: () => {} });
const bound = () => ({ ...input(), binding: { endpointId: 'administration', environment: 'synthetic-local', capabilityVersion: '1.0.0',
  providerRoute: 'synthetic-fixture', capabilityDefinitionDigest: 'b'.repeat(64), snapshotId: 'snapshot', snapshotRevision: 1, interactionId: 'interaction',
  authorityContextRef: { providerRef: 'local-human', contextId: 'human', revision: 1 }, executionMode: 'live' as const,
  deadlineAt: '2026-09-15T12:00:30Z' } });
function setup(t: { after(callback: () => void): void }, mode = 'allowOnce') {
  const directory = mkdtempSync(join(tmpdir(), 'ls-governed-binding-'));
  const path = join(directory, 'fixture.sqlite');
  const db = new Database({ path }); db.migrate();
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.connection.prepare('INSERT INTO authority_grants VALUES (?,?,?,?,?,?,?,?)').run('grant', 'human', 'assistant', 'active',
    JSON.stringify(['synthetic.echo', 'synthetic.other']), 2, JSON.stringify({ durationMode: mode, sessionId: 'session', expiresAt: '2026-09-15T13:00:00Z' }), now);
  return { db, path, repository: new AdmissionRepository(db) };
}

test('exact one-use admission retry returns its recorded receipt without consuming twice', t => {
  const { db, repository } = setup(t);
  const first = repository.admitGoverned(input());
  assert.deepEqual(repository.admitGoverned(input()), first);
  assert.equal((db.connection.prepare("SELECT COUNT(*) AS n FROM authority_events WHERE event='consumed'").get() as { n: number }).n, 1);
});

test('same invocation cannot reuse an admission for a different capability in a broad grant', t => {
  const { repository } = setup(t, 'allowPersistent');
  repository.admitGoverned(input());
  assert.throws(() => repository.admitGoverned({ ...input(), capabilityId: 'synthetic.other' }), /binding conflict/);
});

test('an invalid clock cannot bypass grant expiration checks', t => {
  const { repository } = setup(t);
  assert.throws(() => repository.admitGoverned({ ...input(), now: 'invalid-clock' }), /invalid admission/);
});

test('checked binding rejects changed owner, session, capability, input, route, catalog and execution identity', t => {
  const { repository } = setup(t, 'allowPersistent');
  repository.admitGoverned(bound());
  for (const key of ['principalId', 'assistantId', 'sessionId', 'capabilityId', 'inputDigest']) {
    const q = bound(); (q as any)[key] = 'different';
    assert.throws(() => repository.admitGoverned(q), /binding conflict/);
  }
  for (const key of ['endpointId', 'environment', 'capabilityVersion', 'providerRoute', 'snapshotId', 'interactionId', 'snapshotRevision', 'executionMode', 'deadlineAt']) {
    const q = bound(); (q.binding as any)[key] = key === 'snapshotRevision' ? 2 : key === 'executionMode' ? 'replay' : key === 'deadlineAt' ? '2026-09-15T12:00:31Z' : 'different';
    assert.throws(() => repository.admitGoverned(q), /binding conflict/);
  }
  const q = bound(); q.binding.authorityContextRef.revision++;
  assert.throws(() => repository.admitGoverned(q), /binding conflict/);
  assert.throws(() => repository.admitGoverned({ ...bound(), binding: { ...bound().binding, capabilityDefinitionDigest: 'c'.repeat(64) } }), /binding conflict/);
});

test('two independent processes can claim only one initial dispatch', async t => {
  const { path, repository, db } = setup(t);
  const q = bound(); repository.admitGoverned(q);
  const databaseUrl = new URL('../src/database.ts', import.meta.url).href;
  const admissionUrl = new URL('../src/authority/admission.ts', import.meta.url).href;
  const script = `import {Database} from ${JSON.stringify(databaseUrl)}; import {AdmissionRepository} from ${JSON.stringify(admissionUrl)};
    const db=new Database({path:process.argv[1]}); const input=JSON.parse(process.argv[2]); input.assertCurrent=()=>{};
    try { process.stdout.write(JSON.stringify(new AdmissionRepository(db).claimGovernedDispatch(input))); } finally { db.close(); }`;
  const run = () => promisify(execFile)(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, path, JSON.stringify(q)], { timeout: 10000 });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map(result => JSON.parse(result.stdout)).sort(), [false, true]);
  assert.equal((db.connection.prepare('SELECT COUNT(*) AS n FROM governed_dispatch_claims').get() as { n: number }).n, 1);
  assert.equal((db.connection.prepare("SELECT COUNT(*) AS n FROM authority_events WHERE event='dispatch_claimed'").get() as { n: number }).n, 1);
});

test('reopening a repository preserves admission evidence and prevents a second dispatch after a lost response', t => {
  const { path, repository } = setup(t);
  const q = bound(); const first = repository.admitGoverned(q);
  const proof = repository.governedEvidence(q); assert.equal(repository.claimGovernedDispatch(q), true);
  const reopened = new Database({ path }); t.after(() => reopened.close());
  const next = new AdmissionRepository(reopened);
  assert.deepEqual(next.admitGoverned(q), first);
  assert.deepEqual(next.governedEvidence(q), proof);
  assert.equal(next.claimGovernedDispatch(q), false);
  assert.equal(createHash('sha256').update(proof.bytes).digest('hex'), proof.artifact.sha256);
  assert.equal(proof.bytes.byteLength, proof.artifact.byteLength);
  assert.equal(JSON.parse(new TextDecoder().decode(proof.bytes)).checkedIdentity.binding.providerRoute, 'synthetic-fixture');
});

test('grant revocation, deadline and current-owner failure before claim prevent I/O admission', t => {
  const { db, repository } = setup(t);
  const q = bound(); repository.admitGoverned(q);
  assert.throws(() => repository.claimGovernedDispatch({ ...q, now: '2026-09-15T12:01:00Z' }), /not current/);
  assert.throws(() => repository.claimGovernedDispatch({ ...q, assertCurrent: () => { throw new Error('owner changed'); } }), /owner changed/);
  db.connection.prepare("UPDATE authority_grants SET status='revoked',revision=revision+1").run();
  assert.throws(() => repository.claimGovernedDispatch(q), /not current/);
  assert.equal((db.connection.prepare('SELECT COUNT(*) AS n FROM governed_dispatch_claims').get() as { n: number }).n, 0);
  assert.equal(repository.admitGoverned(q).status, 'admitted', 'historical admission remains evidence, not a fresh claim');
});

test('missing historical identity and altered evidence never acquire identity from a new request', t => {
  const { db, repository } = setup(t);
  repository.admit({ invocationId: 'invocation', grantId: 'grant', grantRevision: 2, inputDigest: 'a'.repeat(64), status: 'admitted' });
  assert.throws(() => repository.admitGoverned(bound()), /binding conflict/);
  assert.throws(() => repository.claimGovernedDispatch(bound()), /binding conflict/);
  const q = { ...bound(), invocationId: 'new-invocation' };
  repository.admitGoverned(q);
  db.connection.prepare("UPDATE governed_admission_evidence SET admitted_at='2000-01-01T00:00:00Z'").run();
  assert.throws(() => repository.admitGoverned(q), /evidence invalid/);
  assert.throws(() => repository.governedEvidence(q), /evidence invalid/);
  assert.throws(() => repository.claimGovernedDispatch(q), /evidence invalid/);
});

test('evidence storage failure rolls back admission, grant consumption and audit together', t => {
  const { db, repository } = setup(t);
  db.exec("CREATE TRIGGER fail_evidence BEFORE INSERT ON governed_admission_evidence BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
  assert.throws(() => repository.admitGoverned(bound()), /synthetic storage failure/);
  assert.equal((db.connection.prepare('SELECT status FROM authority_grants').get() as { status: string }).status, 'active');
  for (const table of ['dispatch_admissions', 'authority_events', 'governed_admission_evidence']) {
    assert.equal((db.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  }
});

test('claim audit failure rolls back the claim without recreating a consumed grant', t => {
  const { db, repository } = setup(t); const q = bound(); repository.admitGoverned(q);
  db.exec("CREATE TRIGGER fail_claim_audit BEFORE INSERT ON authority_events WHEN NEW.event='dispatch_claimed' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.throws(() => repository.claimGovernedDispatch(q), /synthetic audit failure/);
  assert.equal((db.connection.prepare('SELECT COUNT(*) AS n FROM governed_dispatch_claims').get() as { n: number }).n, 0);
  assert.equal((db.connection.prepare('SELECT status FROM authority_grants').get() as { status: string }).status, 'consumed');
  db.exec('DROP TRIGGER fail_claim_audit'); assert.equal(repository.claimGovernedDispatch(q), true);
});

test('input mutation during the trusted guard cannot change the recorded checked identity', t => {
  const { repository } = setup(t); const q = bound();
  const original = bound();
  q.assertCurrent = () => { q.binding.providerRoute = 'changed'; q.capabilityId = 'synthetic.other'; };
  repository.admitGoverned(q);
  assert.doesNotThrow(() => repository.governedEvidence(original));
  assert.throws(() => repository.governedEvidence(q), /binding conflict/);
});

test('non-live and expired new bindings do not consume live grants', t => {
  const { db, repository } = setup(t);
  for (const executionMode of ['replay', 'simulation'] as const) assert.throws(() => repository.admitGoverned({ ...bound(), binding: { ...bound().binding, executionMode } }), /not current/);
  assert.throws(() => repository.admitGoverned({ ...bound(), now: '2026-09-15T12:01:00Z' }), /not current/);
  assert.equal((db.connection.prepare('SELECT status FROM authority_grants').get() as { status: string }).status, 'active');
});

test('owner failure at the final transaction check rolls back admission and initial claim', t => {
  const { repository, db } = setup(t); const q = bound(); let checks = 0;
  const assertCurrent = () => { if (++checks === 2) throw new Error('owner changed at commit'); };
  assert.throws(() => repository.admitGoverned({ ...q, assertCurrent }), /owner changed at commit/);
  assert.equal((db.connection.prepare('SELECT status FROM authority_grants').get() as { status: string }).status, 'active');
  repository.admitGoverned(q); checks = 0;
  assert.throws(() => repository.claimGovernedDispatch({ ...q, assertCurrent }), /owner changed at commit/);
  assert.equal((db.connection.prepare('SELECT COUNT(*) AS n FROM governed_dispatch_claims').get() as { n: number }).n, 0);
  assert.equal(repository.claimGovernedDispatch(q), true);
});

test('migration preserves old admission bytes without inventing checked identity', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ls-governed-upgrade-')); const path = join(directory, 'fixture.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const old = new Database({ path, migrations: loadMigrations().filter(migration => migration.id < 27) }); old.migrate();
  new AdmissionRepository(old).admit({ invocationId: 'invocation', grantId: 'grant', grantRevision: 2, inputDigest: 'a'.repeat(64), status: 'admitted' });
  const before = JSON.stringify(old.connection.prepare('SELECT * FROM dispatch_admissions').all()); old.close();
  const upgraded = new Database({ path }); upgraded.migrate(); t.after(() => upgraded.close());
  assert.equal(JSON.stringify(upgraded.connection.prepare('SELECT * FROM dispatch_admissions').all()), before);
  assert.equal(upgraded.connection.prepare('SELECT * FROM governed_admission_evidence').all().length, 0);
  assert.equal(upgraded.connection.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.throws(() => new AdmissionRepository(upgraded).admitGoverned(input()), /binding conflict/);
});
