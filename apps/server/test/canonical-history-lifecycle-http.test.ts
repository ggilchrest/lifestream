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
type Internals = {database: Database; localAuth: LocalAuthentication; durableConversations: ConversationHistoryRepository; durableConversationRepository?: ConversationHistoryRepository; conversationRetentionOwner?: ConversationRetentionOwner; audience?: AudienceCoordinator; automaticMemory: {enqueue: (...args: any[]) => any}; prepareRuntimeInput: (...args: any[]) => any; runtimeFences: Set<{sessionId?: string; abort: () => void}>};
async function fixture(retention = true, extra: Partial<ServerOptions> = {}, endpointClass = 'desktopCompanion') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'canonical-history-lifecycle-http-'));chmodSync(root, 0o700);const mask = process.umask(0o077);let now = Date.now();
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

async function active(f: Awaited<ReturnType<typeof fixture>>, consent = false, manual = true) {
  const created = await f.request(f.owner, '/api/admin/v1/assistants', {displayName: 'Synthetic selected lifecycle'});assert.equal(created.status, 201);const assistant = await created.json();f.assistantId = assistant.assistantId;
  assert.equal((await f.request(f.owner, `/api/admin/v1/assistants/${f.assistantId}/activate`, {profileId: assistant.profile.profileId, expectedActiveRevision: null})).status, 200);
  const chat = await create(f);assert.equal((await select(f, chat.conversationId)).status, 200);if(manual)await unlock(f);
  if (consent) assert.equal((await apply(f, true)).status, 200);
  return chat.conversationId;
}
async function message(f: Awaited<ReturnType<typeof fixture>>, conversationId: string, userInput = 'Synthetic exact selected input', extra: Record<string, unknown> = {}) {return f.request(f.owner, '/api/runtime/v1/messages', {assistantId: f.assistantId, conversationId, userInput, ...extra});}
async function page(f: Awaited<ReturnType<typeof fixture>>, conversationId: string) {const response = await f.request(f.owner, route, envelope('page', {conversationId, direction: 'older', pageSize: 50}));assert.equal(response.status, 200);return (await response.json()).result.entries;}
const rows = (f: Awaited<ReturnType<typeof fixture>>, conversationId: string) => f.internal.database.connection.prepare('SELECT * FROM conversation_timeline WHERE conversation_id=? ORDER BY ordinal').all(conversationId);
async function waitFor(check: () => unknown) {const end = Date.now() + 2000;while (!check()) {if (Date.now() > end) assert.fail('Owned lifecycle metadata did not become available');await new Promise(resolve => setTimeout(resolve, 10));}}

test('actual selected typed host emits two source-owned lifecycle rows with no default retention or legacy unselected adoption', {timeout: 15000}, async () => {
  const f = await fixture(false), original = FixtureInferenceProvider.prototype.generate;
  try {
    const conversationId = await active(f);
    FixtureInferenceProvider.prototype.generate = async function* () {yield {kind: 'text', text: 'Synthetic native '};yield {kind: 'text', text: 'completed reply'};yield {kind: 'done'};};
    const response = await message(f, conversationId);assert.equal(response.status, 200);const text = await response.text();assert.match(text, /event: interaction.completed/);assert.doesNotMatch(text, /event: interaction.error/);
    const entries = await page(f, conversationId);assert.equal(entries.length, 2);assert.ok(entries.every((entry: any) => entry.state === 'completed' && entry.content.state === 'unavailable' && entry.actorId === f.owner.principalId && entry.effectiveUserId === f.owner.principalId));assert.equal(entries[0].turnId, entries[1].turnId);
    assert.equal(f.internal.database.connection.prepare('SELECT COUNT(*) AS n FROM conversation_timeline WHERE retained_text IS NOT NULL').get()!.n, 0);
    assert.equal((await message(f, randomUUID())).status, 403);assert.equal((await message(f, conversationId, 'Denied', {assistantId: randomUUID()})).status, 403);assert.equal(rows(f, conversationId).length, 2);
    const legacy = await f.request(f.owner, '/api/runtime/v1/messages', {assistantId: f.assistantId, userInput: 'Legacy no saved conversation envelope'});assert.equal(legacy.status, 200);await legacy.text();assert.equal(rows(f, conversationId).length, 2);
  } finally {FixtureInferenceProvider.prototype.generate = original;await f.close();}
});

test('host explicit consent retains the complete 32768 reply while32769 overflow is unavailable, never a completed retained prefix', {timeout: 15000}, async () => {
  const f = await fixture(), original = FixtureInferenceProvider.prototype.generate;
  try {
    const conversationId = await active(f, true);let size = 32768;
    FixtureInferenceProvider.prototype.generate = async function* () {yield {kind: 'text', text: 'a'.repeat(16000)};yield {kind: 'text', text: 'b'.repeat(size - 16000)};yield {kind: 'done'};};
    const first = await message(f, conversationId, 'Synthetic bound full reply');assert.equal(first.status, 200);assert.match(await first.text(), /event: interaction.completed/);
    let entries = await page(f, conversationId), assistant = entries.find((entry: any) => entry.speaker === 'assistant');assert.equal(assistant.state, 'completed');assert.equal(assistant.content.text.length, 32768);
    size = 32769;const second = await message(f, conversationId, 'Synthetic overflow reply');assert.equal(second.status, 200);assert.match(await second.text(), /event: interaction.completed/);
    entries = await page(f, conversationId);assistant = entries.filter((entry: any) => entry.speaker === 'assistant').at(-1);assert.equal(assistant.state, 'completed');assert.equal(assistant.content.state, 'unavailable');assert.equal(rows(f, conversationId).at(-1)!.retained_text, null);
  } finally {FixtureInferenceProvider.prototype.generate = original;await f.close();}
});

test('independent erase fence retires actual held selected output even without a retention owner', {timeout: 15000}, async () => {
  const f = await fixture(false), original = FixtureInferenceProvider.prototype.generate;let release!: () => void;const held = new Promise<void>(resolve => {release = resolve;});
  try {
    const conversationId = await active(f);FixtureInferenceProvider.prototype.generate = async function* () {yield {kind: 'text', text: 'Synthetic partial before erase'};await held;yield {kind: 'text', text: 'PRIVATE_LATE_AFTER_ERASE'};yield {kind: 'done'};};
    const response = await message(f, conversationId);assert.equal(response.status, 200);const body = response.text();await waitFor(() => rows(f, conversationId).some(row => row.speaker === 'assistant' && row.state === 'generating'));
    const entry = rows(f, conversationId).find(row => row.speaker === 'assistant')!;
    const erased = await f.request(f.owner, route + '/erase', {producerPin: pin, conversationId, entryId: entry.entry_id, expectedRevision: entry.revision, operationId: randomUUID(), idempotencyKey: randomUUID()});assert.equal(erased.status, 200);release();const text = await body;assert.doesNotMatch(text, /PRIVATE_LATE_AFTER_ERASE|event: interaction.completed/);assert.match(text, /cancelled|runtime_input_stale/);
    const final = rows(f, conversationId).find(row => row.speaker === 'assistant')!;assert.equal(final.state, 'interrupted');assert.equal(final.content_state, 'redacted');assert.equal(final.retained_text, null);
  } finally {release?.();FixtureInferenceProvider.prototype.generate = original;await f.close();}
});

test('real Lock and signout stop existing lifecycle publication without erasing until-deletion partial text', {timeout: 15000}, async () => {
  for (const operation of ['lock', 'signout']) {
    const f = await fixture(), original = FixtureInferenceProvider.prototype.generate;let release!: () => void;const held = new Promise<void>(resolve => {release = resolve;});
    try {
      const conversationId = await active(f, true);FixtureInferenceProvider.prototype.generate = async function* () {yield {kind: 'text', text: 'Synthetic accepted partial'};await held;yield {kind: 'text', text: 'PRIVATE_LATE_AFTER_WITHDRAWAL'};yield {kind: 'done'};};
      const response = await message(f, conversationId);assert.equal(response.status, 200);const body = response.text();await waitFor(() => rows(f, conversationId).some(row => row.speaker === 'assistant' && row.state === 'generating'));
      if (operation === 'lock') await commandLock(f);else assert.equal((await f.request(f.owner, '/api/auth/v1/sign-out', {})).status, 200);
      release();const text = await body;assert.doesNotMatch(text, /PRIVATE_LATE_AFTER_WITHDRAWAL|event: interaction.completed/);assert.match(text, /cancelled|runtime_input_stale/);const row = rows(f, conversationId).find(row => row.speaker === 'assistant')!;assert.equal(row.state, 'interrupted');assert.equal(row.retained_text, 'Synthetic accepted partial');
    } finally {release?.();FixtureInferenceProvider.prototype.generate = original;await f.close();}
  }
});

test('31minute private self selected turn uses one non-sliding30second source snapshot while original administration remains expired', {timeout: 15000}, async t => {
  const f = await fixture(), original = FixtureInferenceProvider.prototype.generate, prepare = f.internal.prepareRuntimeInput;let captured: any;
  try {
    const conversationId = await active(f, true), activity = f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.owner.sessionId)!.admin_last_activity;
    f.advance(31 * 60 * 1000);t.mock.timers.enable({apis: ['Date'], now: f.time()});f.internal.prepareRuntimeInput = function (...args: any[]) {captured = Reflect.apply(prepare, this, args);return captured;};
    FixtureInferenceProvider.prototype.generate = async function* () {yield {kind: 'text', text: 'Synthetic aged ordinary reply'};yield {kind: 'done'};};
    const first = await message(f, conversationId);assert.equal(first.status, 200, await first.clone().text());assert.match(await first.text(), /event: interaction.completed/);assert.equal(Date.parse(captured.runtimeSelfContext.expiresAt) - Date.parse(captured.runtimeSelfContext.asOf), 30000);
    assert.equal((await f.request(f.owner, '/api/auth/v1/session')).status, 401);assert.throws(() => f.internal.localAuth.canAdminister(f.internal.localAuth.hostSessionContext(f.owner.sessionId), f.assistantId), (error: any) => error.status === 403 && error.code === 'administration_freshness_required');assert.equal(f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.owner.sessionId)!.admin_last_activity, activity);
    FixtureInferenceProvider.prototype.generate = async function* () {yield {kind: 'text', text: 'Synthetic bounded partial'};t.mock.timers.setTime(Date.now() + 30001);yield {kind: 'done'};};
    const second = await message(f, conversationId);assert.equal(second.status, 200);const body = await second.text();assert.match(body, /runtime_input_stale|cancelled/);assert.doesNotMatch(body, /event: interaction.completed/);const deadline = captured.runtimeSelfContext.expiresAt;assert.equal(captured.isCurrent(), false);assert.equal(captured.runtimeSelfContext.expiresAt, deadline);
  } finally {f.internal.prepareRuntimeInput = prepare;FixtureInferenceProvider.prototype.generate = original;await f.close();t.mock.timers.reset();}
});

test('fresh authorized act-as preserves actor/effective attribution and target relationship scope without target memory intake or actor catalog leakage', {timeout: 15000}, async () => {
  const f = await fixture(true,{audiencePrivacy:{sourceIds:[]}}), original = FixtureInferenceProvider.prototype.generate;let restoreMemory: (() => void) | undefined, restoreRetention: (() => void) | undefined;
  try {
    const privacy=await f.request(f.owner,'/api/runtime/v1/audience',{mode:'solo',seconds:300});assert.equal(privacy.status,200);assert.equal((await privacy.json()).privateAllowed,true);
    const actorChat = await active(f, true, false);FixtureInferenceProvider.prototype.generate = async function* () {yield {kind: 'text', text: 'ACTOR_ONLY_PRIVATE_SENTINEL'};yield {kind: 'done'};};const actorReply=await message(f, actorChat);assert.equal(actorReply.status,200);assert.match(await actorReply.text(),/event: interaction.completed/);
    const password = secret(), created = await f.request(f.owner, '/api/auth/v1/accounts', {username: 'synthetic-target', password});assert.equal(created.status, 201);const member = await created.json();assert.equal((await f.request(f.owner, '/api/auth/v1/permissions', {principalId: member.principalId, assistantId: f.assistantId, administer: true})).status, 200);
    const signed = await f.request(null, '/api/auth/v1/sign-in', {username: 'synthetic-target', password});assert.equal(signed.status, 200);const session = (await signed.json()).session, other: Owner = {cookie: signed.headers.get('set-cookie')!.split(';')[0]!, csrf: session.csrfToken, principalId: session.principalId, sessionId: session.sessionId, contextRef: ''};
    const relationResponse = await f.request(other, `/api/admin/v1/assistants/${f.assistantId}/relationships`, {});assert.equal(relationResponse.status, 201);const relationshipId = (await relationResponse.json()).relationship.relationshipId;
    const before = f.internal.localAuth.hostSessionContext(f.owner.sessionId);f.internal.localAuth.effectiveSubjects.execute(before, {schemaVersion: '1.0.0', operation: 'startContext', operationId: randomUUID(), expectedGeneration: before.effectiveContext!.generation, payload: {targetUserId: member.principalId}});
    const current = await fetch(f.base + '/api/auth/v1/user-context', {headers: {origin: f.base, cookie: f.owner.cookie}, signal: AbortSignal.timeout(5000)});f.owner.contextRef = (await current.json()).contextRef;
    assert.equal((await f.request(f.owner, route, envelope('read', {conversationId: actorChat}))).status, 404);
    const targetChat = await create(f, 'Target synthetic conversation');assert.equal((await select(f, targetChat.conversationId, readSessionEndpoint(f.internal.database, f.owner.sessionId).revision)).status, 200);
    const memory = f.internal.automaticMemory, enqueue = memory.enqueue;let intakeCalls = 0;memory.enqueue = (...args: any[]) => {intakeCalls++;return Reflect.apply(enqueue, memory, args);};restoreMemory = () => {memory.enqueue = enqueue;};
    const retention = f.internal.conversationRetentionOwner!, retain = retention.retain, attributions: string[] = [];retention.retain = (source: any, scope: any) => {attributions.push(source.attribution);assert.equal(scope.actorId, f.owner.principalId);assert.equal(scope.effectiveUserId, member.principalId);return Reflect.apply(retain, retention, [source, scope]);};restoreRetention = () => {retention.retain = retain;};
    let request: any;FixtureInferenceProvider.prototype.generate = async function* (input) {request = input;yield {kind: 'text', text: 'Synthetic target-scoped reply'};yield {kind: 'done'};};
    const response = await message(f, targetChat.conversationId, 'Synthetic administrative typed turn', {relationshipId});assert.equal(response.status, 200, await response.clone().text());assert.match(await response.text(), /event: interaction.completed/);assert.doesNotMatch(JSON.stringify(request.sections), /ACTOR_ONLY_PRIVATE_SENTINEL/);assert.equal(intakeCalls, 0);assert.ok(attributions.includes('administrativeTypedActor'));assert.equal(attributions.includes('authenticatedTypedOwner'), false);
    const timeline = await page(f, targetChat.conversationId);assert.equal(timeline.length, 2);assert.ok(timeline.every((entry: any) => entry.actorId === f.owner.principalId && entry.effectiveUserId === member.principalId));assert.equal(timeline.find((entry: any) => entry.speaker === 'human').content.state, 'unavailable');assert.equal((await apply(f, true)).status, 403);
    f.advance(31 * 60 * 1000);assert.equal((await message(f, targetChat.conversationId)).status, 409);assert.equal(rows(f, targetChat.conversationId).length, 2);
  } finally {restoreMemory?.();restoreRetention?.();FixtureInferenceProvider.prototype.generate = original;await f.close();}
});
