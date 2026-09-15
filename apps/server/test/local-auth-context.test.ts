import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database, AssistantProfileRepository } from '@lifestream/storage-sqlite';
import { LocalAuthentication, AuthenticationError, type LocalContext } from '../src/auth/local-auth.ts';
import { SecurityAdministration } from '../src/admin/security-administration.ts';
const secret = () => `synthetic-${randomBytes(24).toString('hex')}`;
const origin = 'http://127.0.0.1:33000';
async function setup(t: { after(callback: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'ls-auth-context-')), database = new Database({ path: join(root, 'database.sqlite') }); database.migrate();
  let now = 1_800_000_000_000;
  const options = { stateDirectory: join(root, 'safety'), installerToken: secret(), now: () => now };
  const auth = new LocalAuthentication(database, options), password = secret();
  const enrolled = await auth.setup('owner', password, options.installerToken, origin), context = auth.context(enrolled.session.token, origin)!;
  t.after(() => { database.close(); rmSync(root, { recursive: true, force: true }); });
  return { database, auth, options, password, token: enrolled.session.token, context, now: () => now, setNow: (value: number) => { now = value; } };
}
const denied = (error: unknown) => error instanceof AuthenticationError && error.status === 401;

test('current authentication rejects mismatched principal, session, origin, authentication time and Owner flag', async t => {
  const f = await setup(t), member = await f.auth.provision(f.context, 'member', secret());
  const variants: Partial<LocalContext>[] = [
    { principalId: member.principalId, owner: false }, { sessionId: randomUUID() },
    { origin: 'http://127.0.0.1:33001' }, { authenticatedAt: f.context.authenticatedAt + 1 }, { owner: false },
    { expiresAt: '2999-01-01T00:00:00Z' }, { expiresAt: 'invalid-clock' }
  ];
  for (const change of variants) {
    assert.throws(() => f.auth.assertCurrent({ ...f.context, ...change }), denied, JSON.stringify(Object.keys(change)));
    assert.throws(() => f.auth.assertCurrent({ ...f.context, ...change }, false), denied);
  }
});

test('a member context cannot become Owner or create Assistant permission by changing fields', async t => {
  const f = await setup(t), password = secret(); await f.auth.provision(f.context, 'member', password);
  const session = await f.auth.signIn('member', password, '', origin, 'loopback'), member = f.auth.context(session.token, origin)!;
  assert.throws(() => f.auth.accounts({ ...member, owner: true }), denied);
  assert.throws(() => f.auth.permitCreator({ ...member, owner: true }, randomUUID()), denied);
  assert.throws(() => f.auth.permitCreator(member, randomUUID()), error => error instanceof AuthenticationError && error.status === 403);
  assert.equal(f.database.connection.prepare('SELECT * FROM local_assistant_permissions').all().length, 0);
});

test('changed context cannot create a grant, and rejected checks never refresh administration activity', async t => {
  const f = await setup(t), assistantId = randomUUID();
  new AssistantProfileRepository(f.database).create({ schemaVersion: '2.0.0', assistantId, profileId: randomUUID(), revision: 1, status: 'draft', createdBy: f.context.principalId, createdAt: new Date(f.now()).toISOString() });
  f.auth.permitCreator(f.context, assistantId); const admin = new SecurityAdministration(f.database, f.auth);
  const before = f.database.connection.prepare('SELECT admin_last_activity FROM local_sessions').all(); f.setNow(f.now() + 1000);
  const changed = { ...f.context, sessionId: randomUUID() };
  assert.throws(() => admin.handleLocal('POST', `/api/authority/v1/assistants/${assistantId}/grants`, changed, { scope: ['synthetic.echo'], durationSeconds: 60, durationMode: 'allowOnce' }), denied);
  assert.throws(() => f.auth.touch(changed), denied);
  assert.equal(f.database.connection.prepare('SELECT * FROM authority_grants').all().length, 0);
  assert.deepEqual(f.database.connection.prepare('SELECT admin_last_activity FROM local_sessions').all(), before);
});

test('non-finite and backwards clocks deny both administration and conversation contexts', async t => {
  const f = await setup(t), start = f.now();
  for (const now of [NaN, Infinity, -Infinity, start - 1]) {
    f.setNow(now);
    for (const administration of [true, false]) {
      assert.equal(f.auth.context(f.token, origin, administration), undefined);
      assert.throws(() => f.auth.assertCurrent(f.context, administration), denied);
    }
  }
});

test('unchanged verified identity survives activity refresh and reopening; logout still works after admin idle expiry', async t => {
  const f = await setup(t); f.setNow(f.now() + 1000); f.auth.touch(f.context);
  assert.ok(f.auth.assertCurrent(f.context));
  const reopened = new LocalAuthentication(f.database, f.options); assert.ok(reopened.assertCurrent(f.context));
  f.setNow(f.now() + 1_800_000); assert.throws(() => reopened.assertCurrent(f.context), denied);
  assert.ok(reopened.assertCurrent(f.context, false)); reopened.logout(f.context);
  assert.equal(reopened.context(f.token, origin, false), undefined);
});


test('rejected context cannot log out a different session or renew CSRF material', async t => {
  const f = await setup(t), changed = { ...f.context, sessionId: randomUUID() };
  assert.throws(() => f.auth.logout(changed), denied);
  assert.throws(() => f.auth.renewCsrf(changed), denied);
  assert.ok(f.auth.context(f.token, origin));
  assert.equal(f.database.connection.prepare('SELECT revoked FROM local_sessions').get()!.revoked, 0);
});

test('clock rollback after recorded activity also rejects the conversation context without imposing an idle lifetime', async t => {
  const f = await setup(t); f.setNow(f.now() + 1000); f.auth.touch(f.context); f.setNow(f.now() - 1);
  assert.equal(f.auth.context(f.token, origin, false), undefined);
  assert.throws(() => f.auth.assertCurrent(f.context, false), denied);
  f.setNow(f.now() + 3_600_000);
  assert.equal(f.auth.context(f.token, origin), undefined);
  assert.ok(f.auth.context(f.token, origin, false));
});

test('issued contexts are immutable and a callback cannot replace a copied context identity during revalidation', async t => {
  const f = await setup(t); assert.equal(Object.isFrozen(f.context), true);
  const copied = { ...f.context };
  const auth = new LocalAuthentication(f.database, { ...f.options, now: () => { copied.sessionId = randomUUID(); return f.now(); } });
  assert.throws(() => auth.assertCurrent(copied), denied);
  assert.ok(f.auth.assertCurrent(f.context));
});
