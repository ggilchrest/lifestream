// Execute after the normal public build; no detached implementation or live state is imported.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, chmodSync, realpathSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database, ConversationHistoryRepository} from '@lifestream/storage-sqlite';
import {admitUnifiedDesktopConsumer} from '@lifestream/contracts/unified-desktop-contracts';
import {createLifestreamServer} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
import {LocalAuthentication, canonicalAuthSessionCustody} from '../dist/auth/local-auth.js';
import {projectShellPreferenceScope, readSessionEndpoint, selectSessionConversation} from '../dist/runtime/session-context.js';
const secret = () => 'Synthetic-' + randomBytes(24).toString('hex');

test('original host account-context reads are current and bounded without changing Console or administration', {timeout: 20000}, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'daily-context-session-'));chmodSync(root, 0o700);
  let now = Date.now();
  const config = loadProfile('test');config.authority.authentication = 'local-password';config.storage = {databasePath: join(root, 'test.sqlite'), artifactDirectory: join(root, 'artifacts')};
  const installerToken = secret(), app = createLifestreamServer({config, localAuth: {stateDirectory: join(root, 'auth'), installerToken, now: () => now}});
  const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    await app.start();
    const base = `http://127.0.0.1:${app.address().port}`;
    let cookie = '', csrf = '';
    const request = (path: string, body?: unknown, extra: Record<string, string> = {}) => fetch(base + path, {method: body === undefined ? 'GET' : 'POST', headers: {origin: base, 'content-type': 'application/json', cookie, 'x-lifestream-csrf': csrf, ...extra}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(5000)});
    assert.equal((await request('/api/auth/v1/user-context')).status, 401);
    const setup = await request('/api/auth/v1/setup', {username: 'synthetic-owner', password: secret(), installerToken});assert.equal(setup.status, 201);
    cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const {session} = await setup.json();csrf = session.csrfToken;
    const ownerCookie = cookie, ownerCsrf = csrf;
    const owner = await (await request('/api/auth/v1/user-context')).json();
    assert.equal(admitUnifiedDesktopConsumer('effective-subject', owner.producerPin).valid, true);
    assert.equal(owner.context.actorId, session.principalId);assert.equal(owner.context.effectiveUserId, session.principalId);
    assert.equal(owner.context.authenticatedSessionId, session.sessionId);assert.equal(owner.context.generation, 0);assert.equal(owner.impersonating, false);
    assert.equal((await request('/api/auth/v1/user-context', undefined, {'x-lifestream-user-context': randomUUID()})).status, 409);
    assert.equal((await request('/api/auth/v1/user-context?targetUserId=' + randomUUID())).status, 422);
    assert.equal((await request('/api/auth/v1/user-context', {operation: 'startContext', targetUserId: randomUUID()})).status, 405);
    assert.equal((await request('/api/auth/v1/user-context/events?transport=shared-v1', undefined, {origin: 'https://invalid.example'})).status, 403);
    assert.equal((await request('/api/auth/v1/session')).status, 200);
    assert.equal((await request('/control/')).status, 200);
    const created = await request('/api/admin/v1/assistants', {displayName: 'Synthetic Console compatibility'});assert.equal(created.status, 201);
    const assistant = await created.json();assert.equal((await request(`/api/admin/v1/assistants/${assistant.assistantId}`)).status, 200);
    const bindingKey = randomUUID();
    assert.equal((await request('/api/runtime/v1/session-context', {expectedRevision: 0, mode: 'text', audienceScope: 'authenticatedSession', bindingKey})).status, 200);
    const selected = await (await request('/api/runtime/v1/session-context')).json();
    assert.equal(admitUnifiedDesktopConsumer('shell-preferences', selected.shellPreferenceScope.producerPin).valid, true);
    assert.deepEqual(selected.shellPreferenceScope.scope, {actorId: session.principalId, effectiveUserId: session.principalId, endpointRef: selected.endpoint.endpointId});
    const endpoint = structuredClone(selected.endpoint);
    // These are the actual constructor-owned test host objects, not substitute auth or DB ports.
    const {localAuth: auth, database} = app as unknown as {localAuth: LocalAuthentication; database: Database};
    assert.ok(canonicalAuthSessionCustody(auth, database));
    const context = auth.hostSessionContext(session.sessionId);
    const scope = {actorId: session.principalId, effectiveUserId: session.principalId, contextGeneration: context.effectiveContext!.generation, authorityCurrent: () => {try {auth.assertCurrent(context, false);return true;} catch {return false;}}};
    const repository = new ConversationHistoryRepository(database);
    assert.equal(auth.canUseAssistant(context, assistant.assistantId), true);
    const conversation = repository.mutate(scope, {schemaVersion: '1.0.0', operation: 'create', operationId: randomUUID(), idempotencyKey: randomUUID(), payload: {assistantId: assistant.assistantId, title: 'Synthetic selected chat'}});
    const revision = selectSessionConversation(database, session.sessionId, conversation.conversationId, selected.revision);
    assert.equal(revision, selected.revision + 1);
    assert.deepEqual(readSessionEndpoint(database, session.sessionId).endpoint, endpoint);
    assert.equal(selectSessionConversation(database, session.sessionId, conversation.conversationId, revision), revision);
    assert.throws(() => selectSessionConversation(database, session.sessionId, randomUUID(), selected.revision), /revision conflict/);
    const afterSelection = await (await request('/api/runtime/v1/session-context')).json();
    assert.deepEqual(afterSelection.endpoint, endpoint);assert.equal(afterSelection.revision, revision);
    assert.equal((await request('/api/auth/v1/user-context', undefined, {'x-lifestream-user-context': owner.contextRef})).status, 200);
    const legacy=await request('/api/auth/v1/user-context/events');assert.equal(legacy.status,204);assert.equal(await legacy.text(),'');
    const stream = await request('/api/auth/v1/user-context/events?transport=shared-v1');assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();streams.push(reader);
    assert.match(Buffer.from((await reader.read()).value!).toString(), /event: effective-context/);
    // The original owner has an actual per-authenticated-session subscription cap.
    const release: Array<() => void> = [];
    try {
      for (let i = 0; i < 15; i++) release.push(auth.effectiveSubjects.subscribe(session.sessionId, () => {}));
      assert.equal((await request('/api/auth/v1/user-context/events?transport=shared-v1')).status, 429);
    } finally {for (const stop of release) stop();}
    const memberPassword = secret();
    const memberResponse = await request('/api/auth/v1/accounts', {username: 'synthetic-member', password: memberPassword});assert.equal(memberResponse.status, 201);
    const member = await memberResponse.json();
    const signedIn = await request('/api/auth/v1/sign-in', {username: 'synthetic-member', password: memberPassword});assert.equal(signedIn.status, 200);
    cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;csrf = (await signedIn.json()).session.csrfToken;
    const memberView = await (await request('/api/auth/v1/user-context')).json();
    assert.equal(memberView.context.actorId, member.principalId);assert.equal(memberView.context.effectiveUserId, member.principalId);
    assert.equal((await request('/api/auth/v1/user-context', undefined, {'x-lifestream-user-context': owner.contextRef})).status, 409);
    assert.equal((await request(`/api/admin/v1/assistants/${assistant.assistantId}`)).status, 403);
    cookie = ownerCookie;csrf = ownerCsrf;
    // Exercise the original host-only context owner; no new switching HTTP route is exposed.
    auth.effectiveSubjects.execute(auth.hostSessionContext(session.sessionId), {schemaVersion: '1.0.0', operationId: randomUUID(), operation: 'startContext', expectedGeneration: owner.context.generation, payload: {targetUserId: member.principalId}});
    const changed = await (await request('/api/auth/v1/user-context')).json();
    assert.equal(changed.context.actorId, session.principalId);assert.equal(changed.context.effectiveUserId, member.principalId);assert.equal(changed.impersonating, true);
    assert.equal((await request('/api/auth/v1/user-context', undefined, {'x-lifestream-user-context': owner.contextRef})).status, 409);
    const masked = await (await request('/api/runtime/v1/session-context')).json();assert.equal(masked.shellPreferenceScope.scope, null, 'Old Console without a context transport must not claim physical actor equals changed effective user');
    const bound = await (await request('/api/runtime/v1/session-context', undefined, {'x-lifestream-user-context': changed.contextRef})).json();
    assert.deepEqual(bound.shellPreferenceScope.scope, {actorId: session.principalId, effectiveUserId: member.principalId, endpointRef: endpoint.endpointId});
    assert.equal(bound.endpoint.endpointId, endpoint.endpointId);
    const foreignBinding = projectShellPreferenceScope(database, auth.hostSessionContext(memberView.context.authenticatedSessionId));assert.equal(foreignBinding.scope, null, 'A different physical actor never inherits the owner endpoint');
    const eventRow = Buffer.from((await reader.read()).value!).toString();assert.match(eventRow, /effective-context/);
    now += 31 * 60 * 1000;
    const ordinary = await request('/api/auth/v1/user-context');assert.equal(ordinary.status, 200);assert.equal((await ordinary.json()).context.effectiveUserId, session.principalId, 'Original owner retires expired act-as to self');
    assert.equal((await request('/api/auth/v1/session')).status, 403, 'Administration stays expired while conversation authentication remains current');
    assert.equal((await request('/api/admin/v1/assistants', {displayName: 'Expired administration'})).status, 403);
    assert.equal((await request('/api/auth/v1/sign-out', {})).status, 200);
    assert.equal((await request('/api/auth/v1/user-context')).status, 401);
    let done = false;while (!done) done = (await reader.read()).done === true;
    const sessionRow = database.connection.prepare("SELECT revision FROM sessions WHERE id=?").get(session.sessionId)!;
    database.connection.prepare("UPDATE sessions SET status='ended' WHERE id=?").run(session.sessionId);
    assert.throws(() => selectSessionConversation(database, session.sessionId, randomUUID(), sessionRow.revision), /revision conflict/);
    assert.equal(projectShellPreferenceScope(database, context, true).scope, null);
  } finally {
    for (const reader of streams) await reader.cancel().catch(() => {});
    await app.shutdown();rmSync(root, {recursive: true, force: true});
  }
  assert.equal(existsSync(root), false);
});
