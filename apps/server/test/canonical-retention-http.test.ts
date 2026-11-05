// Actual public build/host/Auth/DB/catalog owners only. All state is disposable.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, chmodSync, rmSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {FixtureInferenceProvider} from '@lifestream/runtime/inference/fixture';
import {ConversationRetentionOwner} from '../dist/runtime/conversation-retention-owner.js';
import {Database, AssistantProfileRepository, ConversationHistoryRepository, type ConversationHistoryScope} from '@lifestream/storage-sqlite';
import {unifiedDesktopContractPin} from '@lifestream/contracts/unified-desktop-contracts';
import {createLifestreamServer, type ServerOptions} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
import {LocalAuthentication} from '../dist/auth/local-auth.js';
import {AudienceCoordinator} from '../dist/runtime/audience.js';
import {readSessionEndpoint, reviseSessionEndpoint} from '../dist/runtime/session-context.js';
const secret = () => 'Synthetic-' + randomBytes(24).toString('hex');
const pin = unifiedDesktopContractPin('conversation-history');
const route = '/api/runtime/v1/conversations';
type Owner = {cookie: string; csrf: string; principalId: string; sessionId: string; contextRef: string};
type Internals = {database: Database; localAuth: LocalAuthentication; durableConversations: ConversationHistoryRepository; durableConversationRepository?: ConversationHistoryRepository; conversationRetentionOwner?: ConversationRetentionOwner; audience?: AudienceCoordinator; runtimeFences: Set<{sessionId?: string; abort: () => void}>};
async function fixture(retention = true, extra: Partial<ServerOptions> = {}, endpointClass = 'desktopCompanion') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'canonical-retention-http-'));chmodSync(root, 0o700);const mask = process.umask(0o077);let now = Date.now();
  const config = loadProfile('test');config.authority.authentication = 'local-password';config.storage = {databasePath: join(root, 'test.sqlite'), artifactDirectory: join(root, 'artifacts')};
  const installerToken = secret(), password = secret(), app = createLifestreamServer({config, localAuth: {stateDirectory: join(root, 'auth'), installerToken, now: () => now}, ...(retention ? {historyRetention: {mode: 'localUserConsent', retention: 'untilDeletion', journalInitialization: 'initializeEmpty'}, historyStateRoot: root} as Partial<ServerOptions> : {}), ...extra});
  try {await app.start();} catch (error) {process.umask(mask);rmSync(root, {recursive: true, force: true});throw error;}
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (owner: Owner | null, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {method: body === undefined ? 'GET' : 'POST', headers: {origin: base, 'content-type': 'application/json', ...(owner ? {cookie: owner.cookie, 'x-lifestream-csrf': owner.csrf, 'x-lifestream-user-context': owner.contextRef} : {}), ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(10000)});
  const setup = await request(null, '/api/auth/v1/setup', {username: 'synthetic-owner', password, installerToken});assert.equal(setup.status, 201);const {session} = await setup.json();
  const owner: Owner = {cookie: setup.headers.get('set-cookie')!.split(';')[0]!, csrf: session.csrfToken, principalId: session.principalId, sessionId: session.sessionId, contextRef: ''};
  const scopeView = await fetch(base + '/api/auth/v1/user-context', {headers: {origin: base, cookie: owner.cookie}, signal: AbortSignal.timeout(5000)});assert.equal(scopeView.status, 200);owner.contextRef = (await scopeView.json()).contextRef;
  const response = await request(owner, '/api/runtime/v1/session-context', {expectedRevision: 0, mode: 'text', audienceScope: 'authenticatedSession', endpointClass, bindingKey: randomUUID()});assert.equal(response.status, 200);const sessionView = await response.json();
  const internal = app as unknown as Internals, assistantId = randomUUID();
  new AssistantProfileRepository(internal.database).create({schemaVersion: '2.0.0', assistantId, profileId: randomUUID(), revision: 1, status: 'draft', createdBy: owner.principalId, createdAt: new Date().toISOString()});
  const scope = (): ConversationHistoryScope => {const context = internal.localAuth.hostSessionContext(owner.sessionId);return {actorId: context.principalId, effectiveUserId: context.effectiveContext!.effectiveUserId, contextGeneration: context.effectiveContext!.generation, authorityCurrent: () => {try {internal.localAuth.assertCurrent(context, false);return true;} catch {return false;}}};};
  return {root, app, base, owner, sessionView, internal, assistantId, request, scope, time: () => now, advance: (ms: number) => {now += ms;}, close: async () => {await app.shutdown();process.umask(mask);rmSync(root, {recursive: true, force: true});}};
}
const envelope = (operation: string, payload: Record<string, unknown>) => ({producerPin: pin, request: {schemaVersion: '1.0.0', operation, operationId: randomUUID(), ...(['create', 'rename', 'pin', 'unpin', 'archive', 'restore'].includes(operation) ? {idempotencyKey: randomUUID()} : {}), payload}});
async function create(f: Awaited<ReturnType<typeof fixture>>, title = 'New chat') {const response = await f.request(f.owner, route, envelope('create', {assistantId: f.assistantId, title}));assert.equal(response.status, 200, await response.clone().text());return (await response.json()).result;}
function select(f: Awaited<ReturnType<typeof fixture>>, conversationId: string, expectedSessionRevision = f.sessionView.revision) {return f.request(f.owner, route + '/select', {producerPin: pin, conversationId, assistantId: f.assistantId, expectedSessionRevision});}
async function lock(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await f.request(f.owner, '/api/runtime/v1/audience/personal-session');assert.equal(state.status, 200);return state.json();
}
async function unlock(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await lock(f), selected = readSessionEndpoint(f.internal.database, f.owner.sessionId);
  const response = await f.request(f.owner, '/api/runtime/v1/audience/personal-session', {operation: 'unlock', operationId: randomUUID(), declarationId: randomUUID(), expectedAudienceRevision: state.revision, expectedPersonalSessionEpoch: state.personalSessionEpoch, expectedSessionRevision: selected.revision, endpointId: selected.endpoint!.endpointId, expectedEndpointRevision: selected.endpoint!.configurationRevision});assert.equal(response.status, 200);return response.json();
}

const retentionPath = '/api/runtime/v1/conversation-retention';
const proposal = (assistantId: string, enabled: boolean, expectedRevision = 0) => ({schemaVersion: '1.0.0', operation: 'set', assistantId, enabled, expectedRevision, retention: 'untilDeletion', bodyScope: 'textAndTranscripts'});
const policy = (f: Awaited<ReturnType<typeof fixture>>) => f.request(f.owner, retentionPath + '?assistantId=' + f.assistantId);
const apply = (f: Awaited<ReturnType<typeof fixture>>, enabled: boolean, revision = 0) => f.request(f.owner, retentionPath, proposal(f.assistantId, enabled, revision));
function observe(f: Awaited<ReturnType<typeof fixture>>, conversationId: string, text: string, state: 'accepted' | 'completed' = 'completed') {
  f.advance(Math.max(1, Date.now() - f.time() + 1));return f.internal.durableConversations.observe(f.scope(), {entryId: randomUUID(), turnId: randomUUID(), conversationId, speaker: 'human', modality: 'text', state, occurredAt: new Date(f.time()).toISOString(), expectedRevision: 0, text, attribution: 'authenticatedTypedOwner'});
}
async function commandLock(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await (await f.request(f.owner, '/api/runtime/v1/audience/personal-session')).json(), selected = readSessionEndpoint(f.internal.database, f.owner.sessionId);
  const response = await f.request(f.owner, '/api/runtime/v1/audience/personal-session', {operation: 'lock', operationId: randomUUID(), declarationId: randomUUID(), expectedAudienceRevision: state.revision, expectedPersonalSessionEpoch: state.personalSessionEpoch, expectedSessionRevision: selected.revision, endpointId: selected.endpoint!.endpointId, expectedEndpointRevision: selected.endpoint!.configurationRevision});assert.equal(response.status, 200);
}

test('retention GET is passive/default disabled and guarded Daily static wiring leaves original Console unchanged', {timeout: 15000}, async () => {
  const f = await fixture(false);try {
    assert.equal(f.internal.conversationRetentionOwner, undefined);
    const response = await policy(f);assert.equal(response.status, 200);const value = await response.json();assert.equal(value.enabled, false);assert.equal(value.revision, 0);assert.equal(value.mode, 'disabled');
    assert.equal(existsSync(join(f.root, 'auth', 'conversation-retention-policy')), false);assert.equal((await apply(f, true)).status, 503);assert.equal(existsSync(join(f.root, 'auth', 'conversation-retention-policy')), false);
    const daily = await f.request(null, '/daily/');assert.equal(daily.status, 200);const html = await daily.text();assert.match(html, /data-audience-protected="true"/);assert.equal(html, readFileSync(new URL('../../daily-web/index.html', import.meta.url), 'utf8'));assert.equal(daily.headers.get('x-content-type-options'), 'nosniff');
    const control = await f.request(null, '/control/');assert.equal(control.status, 200);assert.equal(await control.text(), readFileSync(new URL('../../control-web/index.html', import.meta.url), 'utf8'));
    const rejected = await new Promise<number>((resolve, reject) => {const request = httpRequest(f.base + '/daily/', {headers: {host: 'invalid.example'}}, response => {response.resume();response.on('end', () => resolve(response.statusCode!));});request.on('error', reject);request.end();});assert.equal(rejected, 403);
  } finally {await f.close();}
});

test('explicit self consent uses CAS/untilDeletion with no backfill and only withdrawal writes payload fences', {timeout: 15000}, async () => {
  const f = await fixture();try {
    const ownerPath = join(f.root, 'auth', 'conversation-retention-policy', 'owner.json'), before = readFileSync(ownerPath);
    const initial = await policy(f);assert.equal(initial.status, 200);assert.equal((await initial.json()).enabled, true);assert.deepEqual(readFileSync(ownerPath), before);
    const created = await create(f);f.advance(Math.max(1, Date.now()-f.time()+1));
    // An observed entry without source text stays unavailable; later approval cannot invent its body.
    const old = f.internal.durableConversations.observe(f.scope(), {entryId: randomUUID(), turnId: randomUUID(), conversationId: created.conversationId, speaker: 'human', modality: 'text', state: 'accepted', occurredAt: new Date(f.time()).toISOString(), expectedRevision: 0, attribution: 'authenticatedTypedOwner'});assert.equal(old.content.state, 'unavailable');
    const grant = await apply(f, true);assert.equal(grant.status, 200);const granted = await grant.json();assert.equal(granted.revision, 1);assert.equal(granted.enabled, true);assert.equal(granted.retention, 'untilDeletion');assert.equal(granted.realDataEnabled, true);assert.equal((await apply(f, true)).status, 409);
    f.advance(1);const updated = f.internal.durableConversations.observe(f.scope(), {entryId: old.entryId, turnId: old.turnId, conversationId: created.conversationId, speaker: 'human', modality: 'text', state: 'completed', occurredAt: new Date(f.time()).toISOString(), expectedRevision: old.revision, text: 'Old text never backfilled', attribution: 'authenticatedTypedOwner'});assert.equal(updated.content.state, 'unavailable');
    const fresh = observe(f, created.conversationId, 'Synthetic newly consented body');assert.equal(fresh.content.state, 'retained');const raw = f.internal.database.connection.prepare('SELECT retained_text,expires_at,retention_mode FROM conversation_timeline WHERE entry_id=?').get(fresh.entryId)!;assert.equal(raw.retained_text, 'Synthetic newly consented body');assert.equal(raw.expires_at, null);assert.equal(raw.retention_mode, 'untilDeletion');
    await commandLock(f);assert.equal((await policy(f)).status, 403);assert.equal(f.internal.database.connection.prepare('SELECT retained_text FROM conversation_timeline WHERE entry_id=?').get(fresh.entryId)!.retained_text, 'Synthetic newly consented body');await unlock(f);
    const withdrawn = await apply(f, false, 1);assert.equal(withdrawn.status, 200);assert.equal((await withdrawn.json()).enabled, false);assert.equal(f.internal.database.connection.prepare('SELECT retained_text FROM conversation_timeline WHERE entry_id=?').get(fresh.entryId)!.retained_text, null);assert.equal(f.internal.durableConversations.privacyInventory().fences.length, 1);
    assert.equal((await apply(f, true, 2)).status, 200);assert.equal(f.internal.durableConversations.page(f.scope(), created.conversationId, 'older', 50).entries.find(entry => entry.entryId === fresh.entryId)!.content.state, 'unavailable');
  } finally {await f.close();}
});

test('aged administration allows actual private desktop self consent while administration stays denied without extension', {timeout: 15000}, async () => {
  const f = await fixture();try {
    await unlock(f);const before = f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.owner.sessionId)!.admin_last_activity;f.advance(31 * 60 * 1000);
    assert.equal((await policy(f)).status, 200);assert.equal((await apply(f, true)).status, 200);assert.equal((await f.request(f.owner, '/api/auth/v1/session')).status, 403);
    const admin = await f.request(f.owner, '/api/admin/v1/assistants', {displayName: 'Denied after admin idle'});assert.equal(admin.status, 403);assert.equal((await admin.json()).code, 'administration_freshness_required');assert.throws(() => f.internal.localAuth.canAdminister(f.internal.localAuth.hostSessionContext(f.owner.sessionId), f.assistantId), (error: any) => error.status === 403 && error.code === 'administration_freshness_required');assert.equal(f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.owner.sessionId)!.admin_last_activity, before);
    await commandLock(f);assert.equal((await apply(f, false, 1)).status, 403);assert.equal(JSON.parse(readFileSync(join(f.root, 'auth', 'conversation-retention-policy', 'owner.json'), 'utf8')).grants[0].enabled, true);
  } finally {await f.close();}
});

test('closed consent/native CSRF/current context and self/private guards deny malformed or foreign changes', {timeout: 15000}, async () => {
  const f = await fixture();try {
    const body = proposal(f.assistantId, true), before = readFileSync(join(f.root, 'auth', 'conversation-retention-policy', 'owner.json'));
    assert.equal((await f.request(f.owner, retentionPath)).status, 422);assert.equal((await f.request(f.owner, retentionPath + '?assistantId=' + f.assistantId + '&assistantId=' + f.assistantId)).status, 422);
    for (const invalid of [{...body, owner: randomUUID()}, {...body, retention: 'untilExpiry'}, {...body, expectedRevision: -1}, {...body, enabled: 'true'}, {...body, bodyScope: 'audio'}]) assert.equal((await f.request(f.owner, retentionPath, invalid)).status, 422);
    assert.equal((await f.request(f.owner, retentionPath + '?ignored=1', body)).status, 422);assert.equal((await f.request(f.owner, retentionPath, body, {origin: 'https://invalid.example'})).status, 403);assert.equal((await f.request(f.owner, retentionPath, body, {'x-lifestream-csrf': 'wrong'})).status, 403);assert.equal((await f.request(f.owner, retentionPath, body, {'x-lifestream-user-context': randomUUID()})).status, 409);
    const account = await f.request(f.owner, '/api/auth/v1/accounts', {username: 'synthetic-member', password: secret()});assert.equal(account.status, 201);const member = await account.json(), context = f.internal.localAuth.hostSessionContext(f.owner.sessionId);
    f.internal.localAuth.effectiveSubjects.execute(context, {schemaVersion: '1.0.0', operation: 'startContext', operationId: randomUUID(), expectedGeneration: context.effectiveContext!.generation, payload: {targetUserId: member.principalId}});
    const current = await fetch(f.base + '/api/auth/v1/user-context', {headers: {origin: f.base, cookie: f.owner.cookie}, signal: AbortSignal.timeout(5000)});f.owner.contextRef = (await current.json()).contextRef;
    assert.equal((await policy(f)).status, 403);assert.equal((await apply(f, true)).status, 403);assert.deepEqual(readFileSync(join(f.root, 'auth', 'conversation-retention-policy', 'owner.json')), before);
  } finally {await f.close();}
});

test('original policy boundary cancels actual selected held reply; unrelated unadopted legacy work completes', {timeout: 15000}, async () => {
  const f = await fixture(), generate = FixtureInferenceProvider.prototype.generate;let release!: () => void;const held = new Promise<void>(resolve => {release = resolve;});
  try {
    const made = await f.request(f.owner, '/api/admin/v1/assistants', {displayName: 'Synthetic held retention reply'});assert.equal(made.status, 201);const assistant = await made.json();f.assistantId = assistant.assistantId;assert.equal((await f.request(f.owner, `/api/admin/v1/assistants/${f.assistantId}/activate`, {profileId: assistant.profile.profileId, expectedActiveRevision: null})).status, 200);
    const created = await create(f);assert.equal((await select(f, created.conversationId)).status, 200);assert.equal((await apply(f, true)).status, 200);const entry = observe(f, created.conversationId, 'Synthetic saved entry');assert.equal(entry.content.state, 'retained');
    const password = secret(), account = await f.request(f.owner, '/api/auth/v1/accounts', {username: 'unrelated-test-member', password});assert.equal(account.status, 201);const signed = await f.request(null, '/api/auth/v1/sign-in', {username: 'unrelated-test-member', password});assert.equal(signed.status, 200);const {session} = await signed.json();
    const other: Owner = {cookie: signed.headers.get('set-cookie')!.split(';')[0]!, csrf: session.csrfToken, principalId: session.principalId, sessionId: session.sessionId, contextRef: ''};const scope = await fetch(f.base + '/api/auth/v1/user-context', {headers: {origin: f.base, cookie: other.cookie}, signal: AbortSignal.timeout(5000)});other.contextRef = (await scope.json()).contextRef;assert.equal((await f.request(other, '/api/runtime/v1/session-context', {expectedRevision: 0, mode: 'text', audienceScope: 'authenticatedSession', endpointClass: 'desktopCompanion', bindingKey: randomUUID()})).status, 200);
    assert.equal((await f.request(f.owner, '/api/auth/v1/permissions', {principalId: other.principalId, assistantId: f.assistantId, administer: true})).status, 200);
    FixtureInferenceProvider.prototype.generate = async function* () {await held;yield {kind: 'text', text: 'OWNED_RETENTION_FIXTURE_REPLY'};yield {kind: 'done'};};
    const own = await f.request(f.owner, '/api/runtime/v1/messages', {assistantId: f.assistantId, userInput: 'Synthetic selected held request'});assert.equal(own.status, 200);const ownText = own.text();const separate = await f.request(other, '/api/runtime/v1/messages', {assistantId: f.assistantId, userInput: 'Synthetic unrelated unadopted request'});assert.equal(separate.status, 200);const separateText = separate.text();
    assert.equal((await apply(f, false, 1)).status, 200);assert.equal(f.internal.database.connection.prepare('SELECT retained_text FROM conversation_timeline WHERE entry_id=?').get(entry.entryId)!.retained_text, null);release();const primary = await ownText, unrelated = await separateText;assert.doesNotMatch(primary, /OWNED_RETENTION_FIXTURE_REPLY|event: interaction.completed/);assert.match(primary, /cancelled|runtime_input_stale/);assert.match(unrelated, /OWNED_RETENTION_FIXTURE_REPLY/);assert.match(unrelated, /event: interaction.completed/);
  } finally {release?.();FixtureInferenceProvider.prototype.generate = generate;await f.close();}
});

test('original owner revision callback refuses stale consent; interrupted withdrawal reports unavailable with policy already denying text', {timeout: 15000}, async () => {
  const f = await fixture();try {
    const owner = f.internal.conversationRetentionOwner!, original = (owner as any).now as () => number;let armed = true;
    (owner as any).now = () => {const value = original();if (armed) {armed = false;owner.set(f.internal.localAuth.hostSessionContext(f.owner.sessionId), f.scope(), proposal(f.assistantId, false), () => true);}return value;};
    try {assert.equal((await apply(f, true)).status, 409);} finally {(owner as any).now = original;}
    const current = await policy(f);assert.equal(current.status, 200);const value = await current.json();assert.equal(value.enabled, false);assert.equal(value.revision, 1);assert.equal((await apply(f, true, 1)).status, 200);
    const created = await create(f), entry = observe(f, created.conversationId, 'Synthetic pending withdrawal');assert.equal(entry.content.state, 'retained');const repository = f.internal.durableConversations, withdraw = repository.withdrawPolicy;
    repository.withdrawPolicy = () => {throw Error('Owned interruption before original withdrawal method');};try {assert.equal((await apply(f, false, 2)).status, 503);} finally {repository.withdrawPolicy = withdraw;}
    assert.equal((await (await policy(f)).json()).enabled, false);assert.equal(repository.page(f.scope(), created.conversationId, 'older', 50).entries[0].content.state, 'unavailable');assert.equal(f.internal.database.connection.prepare('SELECT retained_text FROM conversation_timeline WHERE entry_id=?').get(entry.entryId)!.retained_text, 'Synthetic pending withdrawal');
    assert.equal((await apply(f, false, 3)).status, 200);assert.equal(f.internal.database.connection.prepare('SELECT retained_text FROM conversation_timeline WHERE entry_id=?').get(entry.entryId)!.retained_text, null);assert.ok(repository.privacyInventory().fences.some(fence => fence.entryId === entry.entryId));
  } finally {await f.close();}
});

test('existing fresh-admin self consent on personal phone remains admitted but the new ordinary fallback stays desktop-only', {timeout: 15000}, async () => {
  const f = await fixture(true, {}, 'personalCompanion');try {
    assert.equal(f.sessionView.endpoint.endpointClass, 'personalCompanion');
    assert.equal((await apply(f, true)).status, 200);f.advance(31 * 60 * 1000);
    const read = await policy(f);assert.equal(read.status, 403);assert.equal((await read.json()).code, 'administration_freshness_required');assert.equal((await apply(f, false, 1)).status, 403);
    const state = JSON.parse(readFileSync(join(f.root, 'auth', 'conversation-retention-policy', 'owner.json'), 'utf8'));assert.equal(state.grants[0].enabled, true);assert.equal(state.grants[0].revision, 1);
  } finally {await f.close();}
});
