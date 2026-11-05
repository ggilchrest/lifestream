// Normal public build outputs and original classes only; all state belongs to this test.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {mkdtempSync, realpathSync, chmodSync, mkdirSync, rmSync, existsSync, readFileSync, unlinkSync, writeFileSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {Database, AssistantProfileRepository, ConversationHistoryRepository} from '@lifestream/storage-sqlite';
import {createLifestreamServer, type ServerOptions} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
import {LocalAuthentication, canonicalAuthSessionCustody} from '../dist/auth/local-auth.js';
import {AudienceCoordinator} from '../dist/runtime/audience.js';
import {ConversationRetentionOwner, HistoryRetentionError} from '../dist/runtime/conversation-retention-owner.js';
const secret = () => 'Synthetic-' + randomBytes(24).toString('hex');
const enabled = {mode: 'localUserConsent', retention: 'untilDeletion', journalInitialization: 'initializeEmpty'} as const;
type Owners = {database: Database; localAuth: LocalAuthentication; durableConversations: ConversationHistoryRepository; conversationRetentionOwner?: ConversationRetentionOwner};
function fixture(root: string, extra: Partial<ServerOptions> = {}): ServerOptions {
  const config = loadProfile('test');config.authority.authentication = 'local-password';config.storage = {databasePath: join(root, 'test.sqlite'), artifactDirectory: join(root, 'artifacts')};
  return {config, localAuth: {stateDirectory: join(root, 'auth'), installerToken: secret()}, ...extra};
}
function ownRoot() {const root = mkdtempSync(join(realpathSync(tmpdir()), 'history-host-composition-'));chmodSync(root, 0o700);return root;}
async function account(app: ReturnType<typeof createLifestreamServer>, options: ServerOptions, origin: string) {
  const owners = app as unknown as Owners;
  const enrolled = await owners.localAuth.setup('synthetic-owner', secret(), options.localAuth!.installerToken!, origin);
  const context = owners.localAuth.hostSessionContext(enrolled.session.sessionId), assistantId = randomUUID();
  new AssistantProfileRepository(owners.database).create({schemaVersion: '2.0.0', assistantId, profileId: randomUUID(), revision: 1, status: 'draft', createdBy: context.principalId, createdAt: new Date().toISOString()});
  const scope = {actorId: context.principalId, effectiveUserId: context.principalId, contextGeneration: context.effectiveContext!.generation, authorityCurrent: () => {try {owners.localAuth.assertCurrent(context, false);return true;} catch {return false;}}};
  assert.ok(owners.localAuth.canUseAssistant(context, assistantId));
  return {owners, context, assistantId, scope};
}
function noBody(owners: Owners, scope: Parameters<ConversationHistoryRepository['page']>[0], assistantId: string, metadataOnly = false) {
  const repository = owners.durableConversations;
  const created = repository.mutate(scope, {schemaVersion: '1.0.0', operation: 'create', operationId: randomUUID(), idempotencyKey: randomUUID(), payload: {assistantId, title: 'Synthetic owned chat'}});
  const entry = repository.observe(scope, {entryId: randomUUID(), turnId: randomUUID(), conversationId: created.conversationId, speaker: 'human', modality: 'text', state: 'completed', occurredAt: new Date().toISOString(), ...(metadataOnly ? {} : {text: 'Synthetic text without a consent grant'}), expectedRevision: 0, attribution: 'authenticatedTypedOwner'});
  assert.equal(entry.content.state, 'unavailable');
  assert.equal(owners.database.connection.prepare("SELECT COUNT(*) AS n FROM conversation_timeline WHERE retained_text IS NOT NULL").get()!.n, 0);
}

test('original host defaults to no body retention and closes exact policy/auth/repository custody on shutdown', {timeout: 10000}, async () => {
  const root = ownRoot(), oldMask = process.umask(0o077), options = fixture(root), app = createLifestreamServer(options);
  try {
    await app.start();
    const {owners, scope, assistantId} = await account(app, options, `http://127.0.0.1:${app.address().port}`);
    assert.equal(owners.conversationRetentionOwner, undefined);
    assert.ok(canonicalAuthSessionCustody(owners.localAuth, owners.database));
    noBody(owners, scope, assistantId);
    const repository = owners.durableConversations;
    assert.equal(repository.privacyCurrent(), true);
    assert.equal(existsSync(join(root, 'auth', 'conversation-retention-policy')), false);
    await app.shutdown();
    assert.equal(repository.privacyCurrent(), false);
    assert.equal(canonicalAuthSessionCustody(owners.localAuth, owners.database), null);
    assert.throws(() => repository.privacyInventory());
  } finally {await app.shutdown();process.umask(oldMask);rmSync(root, {recursive: true, force: true});}
});

test('explicit original local-consent host starts with zero grants and reopens both independent journals without reconstruction', {timeout: 10000}, async () => {
  const root = ownRoot(), oldMask = process.umask(0o077), options = fixture(root, {historyRetention: enabled, historyStateRoot: root});
  let app = createLifestreamServer(options);
  try {
    const initialized = app as unknown as Owners;
    assert.ok(initialized.conversationRetentionOwner);
    assert.equal(initialized.durableConversations.privacyCurrent(), true);
    await app.start();
    const {owners, context, scope, assistantId} = await account(app, options, `http://127.0.0.1:${app.address().port}`);
    assert.equal(owners.conversationRetentionOwner!.inspect(scope, assistantId).revision, 0);
    assert.equal(owners.conversationRetentionOwner!.inspect(scope, assistantId).enabled, true);
    noBody(owners, scope, assistantId, true);
    const policy = owners.conversationRetentionOwner!, repository = owners.durableConversations;
    const digest = (name: string) => createHash('sha256').update(readFileSync(join(root, 'auth', name))).digest('hex');
    const policyHash = digest('conversation-retention-policy/owner.json'), journalHash = digest('conversation-recovery/journal.json');
    await app.shutdown();
    assert.equal(canonicalAuthSessionCustody(owners.localAuth, owners.database), null);assert.equal(repository.privacyCurrent(), false);assert.throws(() => policy.inspect(scope, assistantId));
    const reopen = fixture(root, {historyRetention: {...enabled, journalInitialization: 'requireExisting'}, historyStateRoot: root});
    app = createLifestreamServer(reopen);await app.start();
    const reopened = app as unknown as Owners;
    assert.ok(reopened.conversationRetentionOwner);assert.equal(reopened.durableConversations.privacyCurrent(), true);
    assert.equal(digest('conversation-retention-policy/owner.json'), policyHash);assert.equal(digest('conversation-recovery/journal.json'), journalHash);
    const readContext = reopened.localAuth.hostSessionContext(context.sessionId), readScope = {...scope, authorityCurrent: () => {try {reopened.localAuth.assertCurrent(readContext, false);return true;} catch {return false;}}};
    assert.equal(reopened.conversationRetentionOwner!.inspect(readScope, assistantId).revision, 0);
    await app.shutdown();
    unlinkSync(join(root, 'auth', 'conversation-recovery', 'journal.json'));
    assert.throws(() => createLifestreamServer(reopen), e => e instanceof HistoryRetentionError && e.code === 'unavailable');
    assert.equal(existsSync(join(root, 'auth', 'conversation-recovery', 'journal.json')), false);
    assert.equal(digest('conversation-retention-policy/owner.json'), policyHash);
  } finally {await app.shutdown();process.umask(oldMask);rmSync(root, {recursive: true, force: true});}
});

test('mismatched root/auth/DB custody and missing policy close the refused constructor audience and DB without touching an unrelated listener', async () => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  try {
  for (const failure of ['root', 'auth', 'database-path', 'database-mode', 'symlink', 'missing-policy'] as const) {
    const root = ownRoot(), oldMask = process.umask(0o077);
    let sourceCallback: (() => void) | undefined, sourceSubscribed = 0, sourceUnsubscribed = 0;
    const audiencePrivacy = {sourceIds: [], subscribeInvalidation: (callback: () => void) => {sourceCallback = callback;sourceSubscribed++;return () => {sourceCallback = undefined;sourceUnsubscribed++;};}};
    let options = fixture(root, {historyRetention: enabled, historyStateRoot: root, audiencePrivacy});
    if (failure === 'root') options.historyStateRoot = join(root, 'different-root');
    if (failure === 'auth') options.localAuth = {...options.localAuth!, stateDirectory: join(root, 'nested', 'auth')};
    if (failure === 'database-path') {mkdirSync(join(root, 'nested'), {mode: 0o700});options.config.storage.databasePath = join(root, 'nested', 'test.sqlite');}
    if (failure === 'database-mode') {writeFileSync(options.config.storage.databasePath, '');chmodSync(options.config.storage.databasePath, 0o644);}
    if (failure === 'symlink') {mkdirSync(join(root, 'actual'), {mode: 0o700});symlinkSync(join(root, 'actual'), join(root, 'alias'));options = fixture(join(root, 'alias'), {historyRetention: enabled, historyStateRoot: join(root, 'alias'), audiencePrivacy});}
    if (failure === 'missing-policy') options.historyRetention = {...enabled, journalInitialization: 'requireExisting'};
    // A narrow close observer delegates to the real SQLite class and never replaces admission.
    const close = Database.prototype.close, closeAudience = AudienceCoordinator.prototype.close;let closed = 0, audienceClosed = 0;
    AudienceCoordinator.prototype.close = function () {audienceClosed++;const timer = (this as unknown as {timer: {_destroyed: boolean}}).timer;closeAudience.call(this);assert.equal(timer._destroyed, true, 'The real original audience close clears its actual Node interval');};
    Database.prototype.close = function () {if (this.path === options.config.storage.databasePath) closed++;return close.call(this);};
    try {
      assert.throws(() => createLifestreamServer(options), e => e instanceof HistoryRetentionError);
      assert.equal(closed, 1, failure);assert.equal(audienceClosed, 1, failure);
      assert.equal(sourceSubscribed, 1);assert.equal(sourceUnsubscribed, 1);assert.equal(sourceCallback, undefined);assert.equal(listener.listening, true);
      assert.equal(existsSync(join(options.localAuth!.stateDirectory, 'conversation-retention-policy', 'owner.json')), false);
      assert.equal(existsSync(join(options.localAuth!.stateDirectory, 'conversation-recovery', 'journal.json')), false);
    } finally {Database.prototype.close = close;AudienceCoordinator.prototype.close = closeAudience;process.umask(oldMask);rmSync(root, {recursive: true, force: true});}
  }
  } finally {await new Promise<void>(resolve => listener.close(() => resolve()));}
});

test('failed original startup closes its own consent/auth/repository and never closes an unrelated listener', {timeout: 10000}, async () => {
  const root = ownRoot(), oldMask = process.umask(0o077), listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as {port: number}).port;
  const options = fixture(root, {historyRetention: enabled, historyStateRoot: root, port}), app = createLifestreamServer(options);
  try {
    const {owners, scope, assistantId} = await account(app, options, `http://127.0.0.1:${port}`), policy = owners.conversationRetentionOwner!, repository = owners.durableConversations;
    await assert.rejects(app.start(), e => (e as NodeJS.ErrnoException).code === 'EADDRINUSE');
    assert.equal(listener.listening, true);
    assert.equal(canonicalAuthSessionCustody(owners.localAuth, owners.database), null);assert.equal(repository.privacyCurrent(), false);assert.throws(() => policy.inspect(scope, assistantId));
  } finally {await app.shutdown();await new Promise<void>(resolve => listener.close(() => resolve()));process.umask(oldMask);rmSync(root, {recursive: true, force: true});}
});

test('original fixture profile replacement retires the old lazy repository without enabling retention', {timeout: 10000}, async () => {
  const root = ownRoot(), oldMask = process.umask(0o077), config = loadProfile('test');
  config.storage = {databasePath: join(root, 'before.sqlite'), artifactDirectory: join(root, 'before-artifacts')};
  const candidate = loadProfile('test');candidate.profile = 'mac-local';candidate.storage = {databasePath: join(root, 'after.sqlite'), artifactDirectory: join(root, 'after-artifacts')};
  const app = createLifestreamServer({config, profileLoader: () => candidate});
  try {
    await app.start();const before = app as unknown as Owners, oldDatabase = before.database, oldRepository = before.durableConversations;
    assert.equal(oldRepository.privacyCurrent(), false);
    const base = `http://127.0.0.1:${app.address().port}`;
    const result = await fetch(base + '/api/runtime/v1/profile', {method: 'POST', headers: {origin: base, 'content-type': 'application/json', 'x-lifestream-fixture-session': 'isolated-host-test', 'x-lifestream-fixture-principal': 'synthetic-owner'}, body: JSON.stringify({profile: 'mac-local'}), signal: AbortSignal.timeout(5000)});
    assert.equal(result.status, 200);assert.equal((await result.json()).switched, true);
    const after = app as unknown as Owners;assert.notEqual(after.database, oldDatabase);assert.notEqual(after.durableConversations, oldRepository);assert.equal(after.conversationRetentionOwner, undefined);
    assert.throws(() => oldRepository.privacyInventory());assert.equal(oldRepository.privacyCurrent(), false);
  } finally {await app.shutdown();process.umask(oldMask);rmSync(root, {recursive: true, force: true});}
});
