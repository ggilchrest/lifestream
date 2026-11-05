// Original public host/owners only. Each fixture owns and removes its Auth/SQLite state.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, chmodSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {Database} from '@lifestream/storage-sqlite';
import {FixtureInferenceProvider} from '@lifestream/runtime/inference/fixture';
import {createLifestreamServer, type ServerOptions} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
import {LocalAuthentication} from '../dist/auth/local-auth.js';
import {AudienceCoordinator, type PersonalSessionRequest} from '../dist/runtime/audience.js';
import {readSessionEndpoint, reviseSessionEndpoint} from '../dist/runtime/session-context.js';
const secret = () => 'Synthetic-' + randomBytes(24).toString('hex');
type Owner = {cookie: string; csrf: string; principalId: string; sessionId: string; contextRef: string};
type Internals = {database: Database; localAuth: LocalAuthentication; audience?: AudienceCoordinator; personalAudienceFallback?: AudienceCoordinator; personalAudienceSessions: Set<string>; runtimeFences: Set<{sessionId?: string; abort: () => void}>};
async function fixture(extra: Partial<ServerOptions> = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'personal-audience-http-'));chmodSync(root, 0o700);const mask = process.umask(0o077);
  let now = Date.now();const config = loadProfile('test');config.authority.authentication = 'local-password';config.storage = {databasePath: join(root, 'test.sqlite'), artifactDirectory: join(root, 'artifacts')};
  const installerToken = secret(), password = secret(), app = createLifestreamServer({config, localAuth: {stateDirectory: join(root, 'auth'), installerToken, now: () => now}, ...extra});
  try {await app.start();} catch (error) {process.umask(mask);rmSync(root, {recursive: true, force: true});throw error;}
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (owner: Owner | null, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {method: body === undefined ? 'GET' : 'POST', headers: {origin: base, 'content-type': 'application/json', ...(owner ? {cookie: owner.cookie, 'x-lifestream-csrf': owner.csrf, 'x-lifestream-user-context': owner.contextRef} : {}), ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(10000)});
  const setup = await request(null, '/api/auth/v1/setup', {username: 'synthetic-owner', password, installerToken});assert.equal(setup.status, 201);const {session} = await setup.json();
  const owner: Owner = {cookie: setup.headers.get('set-cookie')!.split(';')[0]!, csrf: session.csrfToken, principalId: session.principalId, sessionId: session.sessionId, contextRef: ''};
  owner.contextRef = (await (await request(owner, '/api/auth/v1/user-context', undefined, {'x-lifestream-user-context': ''})).json()).contextRef;
  // The bootstrap request has no context reference to impose on the original owner.
  if (!owner.contextRef) {
    const view = await fetch(base + '/api/auth/v1/user-context', {headers: {origin: base, cookie: owner.cookie}, signal: AbortSignal.timeout(5000)});
    assert.equal(view.status, 200);owner.contextRef = (await view.json()).contextRef;
  }
  const apply = async (who: Owner, endpointClass = 'desktopCompanion') => {
    const response = await request(who, '/api/runtime/v1/session-context', {expectedRevision: 0, mode: 'text', audienceScope: 'authenticatedSession', bindingKey: randomUUID(), endpointClass});assert.equal(response.status, 200);return response.json();
  };
  const bind = await apply(owner);
  const another = async () => {
    const response = await request(null, '/api/auth/v1/sign-in', {username: 'synthetic-owner', password});assert.equal(response.status, 200);const {session} = await response.json();
    const next: Owner = {cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: session.csrfToken, principalId: session.principalId, sessionId: session.sessionId, contextRef: ''};
    const view = await fetch(base + '/api/auth/v1/user-context', {headers: {origin: base, cookie: next.cookie}, signal: AbortSignal.timeout(5000)});assert.equal(view.status, 200);next.contextRef = (await view.json()).contextRef;return next;
  };
  const internal = app as unknown as Internals;
  return {root, app, base, owner, bind, internal, request, apply, another, time: () => now, advance: (ms: number) => {now += ms;}, close: async () => {await app.shutdown();process.umask(mask);rmSync(root, {recursive: true, force: true});}};
}
const path = '/api/runtime/v1/audience/personal-session';
async function state(f: Awaited<ReturnType<typeof fixture>>, owner = f.owner) {const response = await f.request(owner, path);assert.equal(response.status, 200);return response.json();}
function command(view: Record<string, any>, selected: Record<string, any>, operation: 'unlock' | 'lock', declarationId = randomUUID()): PersonalSessionRequest {
  return {operation, operationId: randomUUID(), declarationId, expectedAudienceRevision: view.revision, expectedPersonalSessionEpoch: view.personalSessionEpoch, expectedSessionRevision: selected.revision, endpointId: selected.endpoint.endpointId, expectedEndpointRevision: selected.endpoint.configurationRevision};
}
async function action(f: Awaited<ReturnType<typeof fixture>>, body: PersonalSessionRequest, owner = f.owner) {const response = await f.request(owner, path, body);return {status: response.status, value: await response.json()};}

test('new personal route opts in only the genuine actor/session and preserves legacy defaults and command replay', {timeout: 15000}, async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await (await f.request(f.owner, '/api/runtime/v1/audience')).json(), {enforced: false});
    const legacy = await f.another();await f.apply(legacy);
    const before = f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.owner.sessionId)!.admin_last_activity;
    const protectedView = await state(f);assert.equal(protectedView.privateAllowed, false);assert.equal(protectedView.personalSessionState, 'locked');
    assert.equal(f.internal.audience, undefined);assert.ok(f.internal.personalAudienceFallback);
    assert.deepEqual(await (await f.request(legacy, '/api/runtime/v1/audience')).json(), {enforced: false});
    assert.equal((await f.request(legacy, '/api/runtime/v1/audience', {mode: 'solo', seconds: 300})).status, 422);
    const first = command(protectedView, f.bind, 'unlock');const unlocked = await action(f, first);assert.equal(unlocked.status, 200);assert.equal(unlocked.value.privateAllowed, true);
    const lock = command(unlocked.value, f.bind, 'lock', first.declarationId);const locked = await action(f, lock);assert.equal(locked.status, 200);assert.equal(locked.value.privateAllowed, false);
    const second = command(locked.value, f.bind, 'unlock');const next = await action(f, second);assert.equal(next.status, 200);assert.equal(next.value.personalSessionId, second.declarationId);
    const oldLock = await action(f, lock);assert.equal(oldLock.status, 200);assert.equal(oldLock.value.privateAllowed, true);assert.equal(oldLock.value.personalSessionId, second.declarationId);
    const oldUnlock = await action(f, first);assert.equal(oldUnlock.status, 200);assert.equal(oldUnlock.value.personalSessionId, second.declarationId);
    assert.equal((await action(f, {...lock, expectedAudienceRevision: lock.expectedAudienceRevision + 1})).status, 409);
    assert.equal((await action(f, {...command(next.value, f.bind, 'lock'), expectedPersonalSessionEpoch: randomUUID()})).status, 409);
    assert.equal((await state(f)).personalSessionId, second.declarationId);
    assert.equal(f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.owner.sessionId)!.admin_last_activity, before);
    f.advance(31 * 60 * 1000);assert.equal((await state(f)).privateAllowed, true);const agedAdministration=await f.request(f.owner, '/api/auth/v1/session');assert.equal(agedAdministration.status, 403);assert.equal((await agedAdministration.json()).code,'administration_freshness_required');
    const agedLock = await action(f, command(await state(f), f.bind, 'lock', second.declarationId));assert.equal(agedLock.status, 200);assert.equal(agedLock.value.privateAllowed, false);
    assert.equal(f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.owner.sessionId)!.admin_last_activity, before);
  } finally {await f.close();}
});

test('closed body/Origin/CSRF and actual binding, endpoint and effective-self guards deny Unlock while Lock can withdraw only its actual auth owner', {timeout: 15000}, async () => {
  const f = await fixture();
  try {
    const view = await state(f), unlock = command(view, f.bind, 'unlock');
    assert.equal((await f.request(f.owner, path, {...unlock, owner: 'foreign'})).status, 422);
    assert.equal((await f.request(f.owner, path + '?endpointId=' + randomUUID())).status, 422);
    assert.equal((await f.request(f.owner, path, unlock, {origin: 'https://invalid.example'})).status, 403);
    assert.equal((await f.request(f.owner, path, unlock, {'x-lifestream-csrf': 'wrong'})).status, 403);
    assert.equal((await action(f, {...unlock, endpointId: randomUUID()})).status, 403);
    assert.equal((await action(f, {...unlock, expectedSessionRevision: f.bind.revision + 1})).status, 403);
    assert.equal((await f.request(f.owner, path, unlock, {'x-lifestream-user-context': randomUUID()})).status, 409);
    const memberResponse = await f.request(f.owner, '/api/auth/v1/accounts', {username: 'synthetic-member', password: secret()});assert.equal(memberResponse.status, 201);const member = await memberResponse.json();
    const ctx = f.internal.localAuth.hostSessionContext(f.owner.sessionId);
    f.internal.localAuth.effectiveSubjects.execute(ctx, {schemaVersion: '1.0.0', operationId: randomUUID(), operation: 'startContext', expectedGeneration: ctx.effectiveContext!.generation, payload: {targetUserId: member.principalId}});
    const current = await fetch(f.base + '/api/auth/v1/user-context', {headers: {origin: f.base, cookie: f.owner.cookie}, signal: AbortSignal.timeout(5000)});f.owner.contextRef = (await current.json()).contextRef;
    assert.equal((await f.request(f.owner, path)).status, 403);assert.equal((await action(f, unlock)).status, 403);
    assert.equal((await action(f, command(view, f.bind, 'lock', unlock.declarationId))).status, 200);
    assert.equal((await f.request(null, path)).status, 401);
  } finally {await f.close();}
});

test('callback-time real Session revision or config loss cannot publish Unlock; selected endpoint and remembered binding are rechecked', {timeout: 15000}, async () => {
  let callback: (() => void) | undefined;
  const f = await fixture({audiencePrivacy: {sourceIds: [], now: () => {const work = callback;callback = undefined;work?.();return Date.now();}}});
  try {
    const view = await state(f), body = command(view, f.bind, 'unlock');
    callback = () => reviseSessionEndpoint(f.internal.database, f.owner.sessionId, {expectedRevision: f.bind.revision, mode: 'text', audienceScope: 'unknown'}, true, f.owner.principalId);
    const changed = await action(f, body);assert.ok([403, 409].includes(changed.status));
    assert.equal(f.internal.audience!.snapshot({principalId: f.owner.principalId, sessionId: f.owner.sessionId, endpointId: f.bind.endpoint.endpointId}).privateAllowed, false);
    const current = readSessionEndpoint(f.internal.database, f.owner.sessionId);
    reviseSessionEndpoint(f.internal.database, f.owner.sessionId, {expectedRevision: current.revision, mode: 'text', audienceScope: 'authenticatedSession'}, true, f.owner.principalId);
    const rebound = await (await f.request(f.owner, '/api/runtime/v1/session-context')).json();
    const fresh = await state(f);assert.equal((await action(f, command(fresh, rebound, 'unlock'))).status, 200);
    const original = f.app.config;f.app.config = {...original, profile: 'mac-local'};
    assert.equal((await f.request(f.owner, '/api/runtime/v1/audience')).status, 200);
    assert.equal((await (await f.request(f.owner, '/api/runtime/v1/audience')).json()).privateAllowed, false);
    f.app.config = original;assert.equal((await state(f)).privateAllowed, false, 'Config recovery is never automatic Unlock');
  } finally {await f.close();}
});

test('new Lock cancels actual held fixture reply only in its authenticated session; replay preserves a later successor and other session', {timeout: 15000}, async () => {
  const f = await fixture(), originalGenerate = FixtureInferenceProvider.prototype.generate;
  let release!: () => void;const held = new Promise<void>(resolve => {release = resolve;});
  try {
    const firstView = await state(f), first = command(firstView, f.bind, 'unlock');assert.equal((await action(f, first)).status, 200);
    const locked = await action(f, command(await state(f), f.bind, 'lock', first.declarationId));
    const oldLock = command(locked.value, f.bind, 'lock');assert.equal((await action(f, oldLock)).status, 200);
    assert.equal((await action(f, command(await state(f), f.bind, 'unlock'))).status, 200);
    const created = await f.request(f.owner, '/api/admin/v1/assistants', {displayName: 'Synthetic fixture reply'});assert.equal(created.status, 201);const assistant = await created.json();
    assert.equal((await f.request(f.owner, `/api/admin/v1/assistants/${assistant.assistantId}/activate`, {profileId: assistant.profile.profileId, expectedActiveRevision: null})).status, 200);
    const other = await f.another();await f.apply(other);
    FixtureInferenceProvider.prototype.generate = async function* () {await held;yield {kind: 'text', text: 'OWNED_FIXTURE_HELD_REPLY'};yield {kind: 'done'};};
    const primary = await f.request(f.owner, '/api/runtime/v1/messages', {assistantId: assistant.assistantId, userInput: 'Synthetic primary held turn'});assert.equal(primary.status, 200);const primaryText = primary.text();
    const unrelated = await f.request(other, '/api/runtime/v1/messages', {assistantId: assistant.assistantId, userInput: 'Synthetic unrelated held turn'});assert.equal(unrelated.status, 200);const unrelatedText = unrelated.text();
    assert.ok([...f.internal.runtimeFences].some(v => v.sessionId === f.owner.sessionId));
    assert.equal((await action(f, oldLock)).value.privateAllowed, true, 'A recorded Lock cannot withdraw the later Unlock or cancel its work');
    const lock = await action(f, command(await state(f), f.bind, 'lock'));assert.equal(lock.status, 200);assert.equal(lock.value.privateAllowed, false);
    release();const ended = await primaryText, continued = await unrelatedText;
    assert.doesNotMatch(ended, /OWNED_FIXTURE_HELD_REPLY|event: interaction.completed/);assert.match(ended, /cancelled|runtime_input_stale/);
    assert.match(continued, /OWNED_FIXTURE_HELD_REPLY/);assert.match(continued, /event: interaction.completed/);
  } finally {release?.();FixtureInferenceProvider.prototype.generate = originalGenerate;await f.close();}
});

test('bounded metadata exhaustion still confirms tracked old-endpoint Lock, but a new untrackable Lock has no success/protection claim', {timeout: 15000}, async () => {
  const f = await fixture();
  try {
    const view = await state(f), body = command(view, f.bind, 'unlock');assert.equal((await action(f, body)).status, 200);
    const other = await f.another(), otherSelected = await f.apply(other);
    // Controlled capacity metadata only: these entries/keys carry no private declarations or authenticated permission claims.
    const owner = f.internal.personalAudienceFallback!;
    for (let i = 0; i < 999; i++) {owner.snapshot({principalId: randomUUID(), sessionId: randomUUID(), endpointId: randomUUID()});f.internal.personalAudienceSessions.add(JSON.stringify([randomUUID(), randomUUID()]));}
    assert.equal(f.internal.personalAudienceSessions.size, 1000);
    assert.equal((await f.request(f.owner, '/api/runtime/v1/session-context', {expectedRevision: f.bind.revision, mode: 'none', audienceScope: 'unknown'})).status, 200);
    const withdrawn = await action(f, command(view, f.bind, 'lock', body.declarationId));assert.equal(withdrawn.status, 200);assert.equal(withdrawn.value.privateAllowed, false);
    const unconfirmed = await action(f, command(view, otherSelected, 'lock'), other);assert.equal(unconfirmed.status, 429);assert.equal(unconfirmed.value.code, 'personal_session_capacity');assert.equal(Object.hasOwn(unconfirmed.value, 'privateAllowed'), false);
    assert.equal((await f.request(other, path)).status, 429);assert.deepEqual(await (await f.request(other, '/api/runtime/v1/audience')).json(), {enforced: false});
  } finally {await f.close();}
});

test('personal phone uses explicit session intent while desktop audience policy remains unchanged', {timeout: 15000}, async () => {
  const f = await fixture({audiencePrivacy: {sourceIds: []}});
  try {
    const phone = await f.another();const selected = await f.apply(phone, 'personalCompanion');
    const initial = await (await f.request(phone, '/api/runtime/v1/audience')).json();
    const leaseId = randomUUID();let expectedAudienceRevision = initial.revision;
    for (const operation of ['begin', 'renew', 'end'] as const) {const result = await f.request(phone, '/api/runtime/v1/audience/lease', {operation, leaseId, expectedAudienceRevision});assert.equal(result.status, 409);}
    const phoneView=await state(f,phone);assert.equal(phoneView.personalSessionPolicy,'personalDevice');assert.equal(phoneView.privateAllowed,false);const opened=await action(f,command(phoneView,selected,'unlock'),phone);assert.equal(opened.status,200);assert.equal(opened.value.expiresAt,null);assert.equal(opened.value.privateAllowed,true);
    assert.equal((await f.request(phone, '/api/runtime/v1/audience', {mode: 'solo', seconds: 300})).status, 409);
    assert.equal(selected.endpoint.endpointClass, 'personalCompanion');
    const desktop = await state(f);assert.equal(desktop.privateAllowed, false);
    assert.equal((await f.request(f.owner, '/api/runtime/v1/audience', {mode: 'solo', seconds: 300})).status, 409);
  } finally {await f.close();}
});
