// Actual public build/host/Auth/DB/catalog owners only. All state is disposable.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, chmodSync, rmSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
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
type Internals = {database: Database; localAuth: LocalAuthentication; durableConversations: ConversationHistoryRepository; durableConversationRepository?: ConversationHistoryRepository; audience?: AudienceCoordinator; runtimeFences: Set<{sessionId?: string; abort: () => void}>};
async function fixture(extra: Partial<ServerOptions> = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'canonical-history-http-'));chmodSync(root, 0o700);const mask = process.umask(0o077);let now = Date.now();
  const config = loadProfile('test');config.authority.authentication = 'local-password';config.storage = {databasePath: join(root, 'test.sqlite'), artifactDirectory: join(root, 'artifacts')};
  const installerToken = secret(), password = secret(), app = createLifestreamServer({config, localAuth: {stateDirectory: join(root, 'auth'), installerToken, now: () => now}, ...extra});
  try {await app.start();} catch (error) {process.umask(mask);rmSync(root, {recursive: true, force: true});throw error;}
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (owner: Owner | null, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {method: body === undefined ? 'GET' : 'POST', headers: {origin: base, 'content-type': 'application/json', ...(owner ? {cookie: owner.cookie, 'x-lifestream-csrf': owner.csrf, 'x-lifestream-user-context': owner.contextRef} : {}), ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(10000)});
  const setup = await request(null, '/api/auth/v1/setup', {username: 'synthetic-owner', password, installerToken});assert.equal(setup.status, 201);const {session} = await setup.json();
  const owner: Owner = {cookie: setup.headers.get('set-cookie')!.split(';')[0]!, csrf: session.csrfToken, principalId: session.principalId, sessionId: session.sessionId, contextRef: ''};
  const scopeView = await fetch(base + '/api/auth/v1/user-context', {headers: {origin: base, cookie: owner.cookie}, signal: AbortSignal.timeout(5000)});assert.equal(scopeView.status, 200);owner.contextRef = (await scopeView.json()).contextRef;
  const response = await request(owner, '/api/runtime/v1/session-context', {expectedRevision: 0, mode: 'text', audienceScope: 'authenticatedSession', endpointClass: 'desktopCompanion', bindingKey: randomUUID()});assert.equal(response.status, 200);const sessionView = await response.json();
  const internal = app as unknown as Internals, assistantId = randomUUID();
  new AssistantProfileRepository(internal.database).create({schemaVersion: '2.0.0', assistantId, profileId: randomUUID(), revision: 1, status: 'draft', createdBy: owner.principalId, createdAt: new Date().toISOString()});
  const scope = (): ConversationHistoryScope => {const context = internal.localAuth.hostSessionContext(owner.sessionId);return {actorId: context.principalId, effectiveUserId: context.effectiveContext!.effectiveUserId, contextGeneration: context.effectiveContext!.generation, authorityCurrent: () => {try {internal.localAuth.assertCurrent(context, false);return true;} catch {return false;}}};};
  return {root, app, base, owner, sessionView, internal, assistantId, request, scope, advance: (ms: number) => {now += ms;}, close: async () => {await app.shutdown();process.umask(mask);rmSync(root, {recursive: true, force: true});}};
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

test('original host catalog/select/page is scoped and additive; Session CAS preserves the exact endpoint and no body is retained by default', {timeout: 15000}, async () => {
  const f = await fixture();try {
    assert.equal(f.internal.durableConversationRepository, undefined);assert.equal(existsSync(join(f.root, 'auth', 'conversation-recovery')), false);
    const untouched = await f.request(f.owner, '/api/runtime/v1/session-context');assert.equal(untouched.status, 200);assert.equal((await untouched.json()).selectedConversation, null);
    const originalConsole = await fetch(f.base + '/api/runtime/v1/session-context', {headers: {origin: f.base, cookie: f.owner.cookie}, signal: AbortSignal.timeout(5000)});assert.equal(originalConsole.status, 200);
    assert.equal(f.internal.durableConversationRepository, undefined);assert.equal(existsSync(join(f.root, 'auth', 'conversation-recovery')), false);
    const created = await create(f), before = readSessionEndpoint(f.internal.database, f.owner.sessionId);
    const selected = await select(f, created.conversationId);assert.equal(selected.status, 200);const result = await selected.json();assert.equal(result.sessionRevision, before.revision + 1);
    assert.deepEqual(readSessionEndpoint(f.internal.database, f.owner.sessionId).endpoint, before.endpoint);
    assert.equal((await select(f, created.conversationId, before.revision)).status, 409);
    const view = await f.request(f.owner, '/api/runtime/v1/session-context');assert.equal(view.status, 200);const projection = await view.json();assert.equal(projection.selectedConversation.conversationId, created.conversationId);assert.equal(projection.conversationId, created.conversationId);
    // Original normal Console request has no context transport and remains admitted at generation zero.
    const consoleView = await fetch(f.base + '/api/runtime/v1/session-context', {headers: {origin: f.base, cookie: f.owner.cookie}, signal: AbortSignal.timeout(5000)});assert.equal(consoleView.status, 200);
    const entry = f.internal.durableConversations.observe(f.scope(), {entryId: randomUUID(), turnId: randomUUID(), conversationId: created.conversationId, speaker: 'human', modality: 'text', state: 'completed', occurredAt: new Date().toISOString(), expectedRevision: 0, text: 'Synthetic no-consent body', attribution: 'authenticatedTypedOwner'});
    assert.equal(entry.content.state, 'unavailable');
    const page = await f.request(f.owner, route, envelope('page', {conversationId: created.conversationId, direction: 'older', pageSize: 50}));assert.equal(page.status, 200);assert.equal((await page.json()).result.entries[0].content.state, 'unavailable');
    const list = await f.request(f.owner, route, envelope('list', {assistantId: f.assistantId, filter: 'recent', pageSize: 50}));assert.equal(list.status, 200);assert.equal((await list.json()).result.conversations[0].conversationId, created.conversationId);
    assert.equal(f.internal.database.connection.prepare('SELECT COUNT(*) AS n FROM conversation_timeline WHERE retained_text IS NOT NULL').get()!.n, 0);
    const busy = {sessionId: f.owner.sessionId, abort: () => {}};f.internal.runtimeFences.add(busy);
    try {assert.equal((await select(f, created.conversationId, result.sessionRevision)).status, 409);} finally {f.internal.runtimeFences.delete(busy);}
  } finally {await f.close();}
});

test('wire producer/schema, bounded JSON, CSRF, Origin, context reference and assistant permission are genuine route boundaries', {timeout: 15000}, async () => {
  const f = await fixture();try {
    const body = envelope('create', {assistantId: f.assistantId, title: 'Synthetic'});
    assert.equal((await f.request(f.owner, route)).status, 405);assert.equal((await f.request(f.owner, route + '?scope=other', body)).status, 422);
    assert.equal((await f.request(f.owner, route, body, {origin: 'https://invalid.example'})).status, 403);
    assert.equal((await f.request(f.owner, route, body, {'x-lifestream-csrf': 'invalid'})).status, 403);
    assert.equal((await f.request(f.owner, route, body, {'x-lifestream-user-context': randomUUID()})).status, 409);
    assert.equal((await f.request(f.owner, route, {...body, actorId: randomUUID()})).status, 422);
    assert.equal((await f.request(f.owner, route, {...body, producerPin: {...pin, digest: '0'.repeat(64)}})).status, 409);
    assert.equal((await f.request(f.owner, route, {...body, request: {...body.request, operation: 'eraseEntry'}})).status, 422);
    assert.equal((await f.request(f.owner, route, envelope('create', {assistantId: randomUUID(), title: 'Foreign'}))).status, 403);
    const oversized = await fetch(f.base + route, {method: 'POST', headers: {origin: f.base, cookie: f.owner.cookie, 'x-lifestream-csrf': f.owner.csrf, 'x-lifestream-user-context': f.owner.contextRef, 'content-type': 'application/json'}, body: JSON.stringify({...body, padding: 'x'.repeat(131072)}), signal: AbortSignal.timeout(5000)});assert.equal(oversized.status, 413);
    const created = await create(f);
    const foreign = {...f.scope(), actorId: randomUUID(), effectiveUserId: randomUUID()};assert.throws(() => f.internal.durableConversations.read(foreign, created.conversationId));
  } finally {await f.close();}
});

test('separate native entry erase uses original revision/idempotency/privacy journal and cannot erase another entry or retained memory', {timeout: 15000}, async () => {
  const f = await fixture();try {
    const created = await create(f), repository = f.internal.durableConversations;
    const observed = repository.observe(f.scope(), {entryId: randomUUID(), turnId: randomUUID(), conversationId: created.conversationId, speaker: 'human', modality: 'text', state: 'completed', occurredAt: new Date().toISOString(), expectedRevision: 0, attribution: 'authenticatedTypedOwner', text: 'Unavailable without consent'});
    const body = {producerPin: pin, conversationId: created.conversationId, entryId: observed.entryId, expectedRevision: observed.revision, operationId: randomUUID(), idempotencyKey: randomUUID()};
    assert.equal((await f.request(f.owner, route + '/erase', {...body, expectedRevision: observed.revision + 1})).status, 409);
    const erased = await f.request(f.owner, route + '/erase', body);assert.equal(erased.status, 200);assert.equal((await erased.json()).result.status, 'completed');
    assert.equal((await f.request(f.owner, route + '/erase', body)).status, 200);
    assert.equal(repository.page(f.scope(), created.conversationId, 'older', 50).entries[0].content.state, 'redacted');assert.equal(repository.privacyCurrent(), true);
    const changed = await f.request(f.owner, route + '/erase', {...body, entryId: randomUUID()});assert.ok([404, 409].includes(changed.status));
    const inventory = repository.privacyInventory();assert.equal(inventory.fences.length, 1);
  } finally {await f.close();}
});

test('real private Lock and journal loss deny all History actions and selected projection; ordinary self works after admin idle without extending freshness', {timeout: 15000}, async () => {
  const f = await fixture();try {
    const created = await create(f), selected = await select(f, created.conversationId);assert.equal(selected.status, 200);
    const initial = f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.owner.sessionId)!.admin_last_activity;
    await lock(f);assert.equal((await f.request(f.owner, route, envelope('read', {conversationId: created.conversationId}))).status, 403);
    assert.equal((await (await f.request(f.owner, '/api/runtime/v1/session-context')).json()).selectedConversation, null);
    await unlock(f);f.advance(31 * 60 * 1000);
    const read = await f.request(f.owner, route, envelope('read', {conversationId: created.conversationId}));assert.equal(read.status, 200);
    assert.equal((await f.request(f.owner, '/api/auth/v1/session')).status, 401);assert.equal(f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.owner.sessionId)!.admin_last_activity, initial);
    const state = readSessionEndpoint(f.internal.database, f.owner.sessionId);reviseSessionEndpoint(f.internal.database, f.owner.sessionId, {expectedRevision: state.revision, mode: 'text', audienceScope: 'unknown'}, true, f.owner.principalId);
    assert.equal((await f.request(f.owner, route, envelope('read', {conversationId: created.conversationId}))).status, 403);
  } finally {await f.close();}
  const g = await fixture();try {
    const created = await create(g);
    // Use the original journal directory inventory rather than assume contents.
    const files = (await import('node:fs')).readdirSync(join(g.root, 'auth', 'conversation-recovery'));assert.ok(files.length > 0);
    const selectedFile = join(g.root, 'auth', 'conversation-recovery', files.find(name => name.includes('head'))!);const old = readFileSync(selectedFile);writeFileSync(selectedFile, '{}', {mode: 0o600});
    try {assert.equal((await g.request(g.owner, route, envelope('read', {conversationId: created.conversationId}))).status, 503);} finally {writeFileSync(selectedFile, old, {mode: 0o600});}
  } finally {await g.close();}
});

test('body-await logout and source callback endpoint drift reject publication without changing Session selection', {timeout: 15000}, async () => {
  let callback: (() => void) | undefined;
  const f = await fixture({audiencePrivacy: {sourceIds: [], now: () => {const work = callback;callback = undefined;work?.();return Date.now();}}});
  try {
    // Original configured coordinator is protected until its original explicit declaration.
    const declare = await f.request(f.owner, '/api/runtime/v1/audience', {mode: 'solo', seconds: 300});assert.equal(declare.status, 200);
    const created = await create(f), before = readSessionEndpoint(f.internal.database, f.owner.sessionId);
    callback = () => reviseSessionEndpoint(f.internal.database, f.owner.sessionId, {expectedRevision: before.revision, mode: 'text', audienceScope: 'unknown'}, true, f.owner.principalId);
    assert.equal((await select(f, created.conversationId)).status, 403);assert.notEqual(f.internal.database.connection.prepare('SELECT conversation_id FROM sessions WHERE id=?').get(f.owner.sessionId)!.conversation_id, created.conversationId);
  } finally {await f.close();}
  const g = await fixture();try {
    const body = JSON.stringify(envelope('create', {assistantId: g.assistantId, title: 'Never committed after logout'}));
    let sent!: () => void;const started = new Promise<void>(resolve => {sent = resolve;});
    const pending = new Promise<number>((resolve, reject) => {const req = httpRequest(g.base + route, {method: 'POST', headers: {origin: g.base, cookie: g.owner.cookie, 'x-lifestream-csrf': g.owner.csrf, 'x-lifestream-user-context': g.owner.contextRef, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}}, res => {res.resume();res.on('end', () => resolve(res.statusCode!));});req.on('error', reject);req.write(body.slice(0, -1));req.flushHeaders();sent();void (async () => {await new Promise(resolve => setTimeout(resolve, 30));const out = await g.request(g.owner, '/api/auth/v1/sign-out', {});assert.equal(out.status, 200);req.end(body.slice(-1));})().catch(reject);});
    await started;assert.equal(await pending, 401);assert.equal(g.internal.database.connection.prepare('SELECT COUNT(*) AS n FROM conversation_catalog').get()!.n, 0);
  } finally {await g.close();}
});

test('actual effective-account switch cannot disclose the actor catalog and expired administration cannot fall back for proxy scope', {timeout: 15000}, async () => {
  const f = await fixture();try {
    const created = await create(f);
    const account = await f.request(f.owner, '/api/auth/v1/accounts', {username: 'synthetic-member', password: secret()});assert.equal(account.status, 201);const member = await account.json();
    const context = f.internal.localAuth.hostSessionContext(f.owner.sessionId);
    f.internal.localAuth.effectiveSubjects.execute(context, {schemaVersion: '1.0.0', operationId: randomUUID(), operation: 'startContext', expectedGeneration: context.effectiveContext!.generation, payload: {targetUserId: member.principalId}});
    const stale = await f.request(f.owner, route, envelope('read', {conversationId: created.conversationId}));assert.equal(stale.status, 409);
    const latest = await fetch(f.base + '/api/auth/v1/user-context', {headers: {origin: f.base, cookie: f.owner.cookie}, signal: AbortSignal.timeout(5000)});assert.equal(latest.status, 200);f.owner.contextRef = (await latest.json()).contextRef;
    const hidden = await f.request(f.owner, route, envelope('read', {conversationId: created.conversationId}));assert.equal(hidden.status, 404);
    const list = await f.request(f.owner, route, envelope('list', {assistantId: f.assistantId, filter: 'recent', pageSize: 50}));assert.equal(list.status, 200);assert.deepEqual((await list.json()).result.conversations, []);
    assert.equal((await (await f.request(f.owner, '/api/runtime/v1/session-context')).json()).selectedConversation, null);
    f.advance(31 * 60 * 1000);
    const agedProxy = await f.request(f.owner, route, envelope('list', {assistantId: f.assistantId, filter: 'recent', pageSize: 50}));assert.equal(agedProxy.status, 409);assert.equal((await agedProxy.json()).code, 'effective_context_changed');
    const retired = f.internal.localAuth.hostSessionContext(f.owner.sessionId);assert.equal(retired.effectiveContext!.effectiveUserId, f.owner.principalId);assert.ok(retired.effectiveContext!.generation > context.effectiveContext!.generation);
  } finally {await f.close();}
});
