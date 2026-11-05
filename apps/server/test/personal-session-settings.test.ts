import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, chmodSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createLifestreamServer} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
import type {Database} from '@lifestream/storage-sqlite';
import {FixtureInferenceProvider} from '@lifestream/runtime/inference/fixture';
import {reviseSessionEndpoint} from '../dist/runtime/session-context.js';

async function fixture(audienceNow?: () => number) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'personal-settings-'));chmodSync(root, 0o700);
  const previousMask = process.umask(0o077), config = loadProfile('test');
  config.authority.authentication = 'local-password';config.storage = {databasePath: join(root, 'test.sqlite'), artifactDirectory: join(root, 'artifacts')};
  // Genuine configured speech adapters with owned synthetic readiness only.
  // No capture, media request or physical-device claim is involved in a mode CAS.
  const transport = createServer((request, response) => {
    const body = request.url === '/health' ? {status: 'ok', version: 'owned-settings-test'} : request.url === '/readyz' ? {runtimeRevision: 'owned-settings-test', modelRevision: 'owned-settings-test', mappingRevision: 'owned-settings-test'} : {};
    response.writeHead(200, {'content-type': 'application/json'});response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => transport.listen(0, '127.0.0.1', resolve));
  const address = transport.address();assert.ok(address && typeof address === 'object');const endpoint = `http://127.0.0.1:${address.port}`;
  config.providers.stt = 'nemo-speech';config.providers.tts = 'voxcpm';
  config.sttProfile = {runtime: 'owned-settings-test', runtimeVersion: 'owned-settings-test', model: 'synthetic-no-media', modelRevision: 'owned-settings-test', endpoint, modelArtifactDigest: '0'.repeat(64), mappingRevision: 'owned-settings-test', language: 'en', developmentOnly: true};
  config.ttsProfile = {runtime: 'owned-settings-test', runtimeVersion: 'owned-settings-test', model: 'synthetic-no-media', modelRevision: 'owned-settings-test', quantization: 'test', endpoint, voiceBundleKey: 'synthetic-no-media', voiceBundleRevision: 1, mappingRevision: 'owned-settings-test', developmentOnly: true};
  const installerToken = randomBytes(24).toString('hex'), password = randomBytes(24).toString('hex');
  const app = createLifestreamServer({config, localAuth: {stateDirectory: join(root, 'auth'), installerToken}, ...(audienceNow ? {audiencePrivacy: {sourceIds: [], now: audienceNow}} : {})});
  try {
  await app.start();const base = `http://127.0.0.1:${app.address().port}`;
  const headers: Record<string, string> = {origin: base, 'content-type': 'application/json'};
  const request = (path: string, body?: unknown) => fetch(base + path, {method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(5000)});
  const setup = await request('/api/auth/v1/setup', {username: 'synthetic-settings', password, installerToken});assert.equal(setup.status, 201);
  const {session} = await setup.json();headers.cookie = setup.headers.get('set-cookie')!.split(';')[0]!;headers['x-lifestream-csrf'] = session.csrfToken;
  const context = await request('/api/auth/v1/user-context');assert.equal(context.status, 200);headers['x-lifestream-user-context'] = (await context.json()).contextRef;
  const bindingKey = randomUUID();
  const selected = await request('/api/runtime/v1/session-context', {expectedRevision: 0, mode: 'text', audienceScope: 'authenticatedSession', bindingKey, endpointClass: 'desktopCompanion'});assert.equal(selected.status, 200);
  const initial = await selected.json();
  const privacy = async () => {const result = await request('/api/runtime/v1/audience/personal-session');assert.equal(result.status, 200);return result.json();};
  const command = (value: any, endpoint: any, operation: 'lock' | 'unlock') => ({operation, operationId: randomUUID(), declarationId: randomUUID(), expectedAudienceRevision: value.revision, expectedPersonalSessionEpoch: value.personalSessionEpoch, expectedSessionRevision: endpoint.revision, endpointId: endpoint.endpoint.endpointId, expectedEndpointRevision: endpoint.endpoint.configurationRevision});
  const unlock = await request('/api/runtime/v1/audience/personal-session', command(await privacy(), initial, 'unlock'));assert.equal(unlock.status, 200);const declaration = await unlock.json();assert.equal(declaration.privateAllowed, true);
  return {app, request, privacy, command, initial, declaration, bindingKey, sessionId: session.sessionId as string, principalId: session.principalId as string, database: (app as unknown as {database: Database}).database,
    close: async () => {await app.shutdown();await new Promise<void>(resolve => transport.close(() => resolve()));process.umask(previousMask);rmSync(root, {recursive: true, force: true});}};
  } catch (error) {await app.shutdown();await new Promise<void>(resolve => transport.close(() => resolve()));process.umask(previousMask);rmSync(root, {recursive: true, force: true});throw error;}
}

test('same-owner ordinary text/audio Save preserves the original explicit declaration while strict stale Unlock admission stays fenced', async () => {
  const f = await fixture();try {
    let selected = f.initial;
    for (const mode of ['audio', 'text', 'audio']) {
      const result = await f.request('/api/runtime/v1/session-context', {expectedRevision: selected.revision, mode, audienceScope: 'authenticatedSession', bindingKey: f.bindingKey});assert.equal(result.status, 200);selected = await result.json();
      const value = await f.privacy();assert.equal(value.privateAllowed, true, 'An ordinary modality save must not create an extra Lock/Unlock step');assert.equal(value.personalSessionId, f.declaration.personalSessionId);assert.equal(value.personalSessionEpoch, f.declaration.personalSessionEpoch);assert.equal(value.revision, f.declaration.revision);
      assert.equal(selected.endpoint.endpointId, f.initial.endpoint.endpointId);
    }
    const stale = await f.request('/api/runtime/v1/audience/personal-session', f.command(await f.privacy(), f.initial, 'unlock'));assert.notEqual(stale.status, 200);
    assert.equal((await f.privacy()).personalSessionId, f.declaration.personalSessionId);
    const locked = await f.request('/api/runtime/v1/audience/personal-session', f.command(await f.privacy(), selected, 'lock'));assert.equal(locked.status, 200);assert.equal((await locked.json()).privateAllowed, false);
  } finally {await f.close();}
});

test('reviewed Session definition mode apply preserves intent, but explicit withholding cannot revive when restored before a later audience read', async () => {
  const f = await fixture();try {
    const definition = {schemaVersion: '1.0.0', mode: 'audio', audienceScope: 'authenticatedSession'};
    const preview = await f.request('/api/runtime/v1/session-definition', {operation: 'preview', expectedRevision: f.initial.revision, definition});assert.equal(preview.status, 200);const review = await preview.json();
    const apply = await f.request('/api/runtime/v1/session-definition', {operation: 'apply', expectedRevision: f.initial.revision, definition, reviewDigest: review.reviewDigest});assert.equal(apply.status, 200);
    assert.equal((await f.privacy()).personalSessionId, f.declaration.personalSessionId);assert.equal((await f.privacy()).privateAllowed, true);
    const selected = await (await f.request('/api/runtime/v1/session-context')).json();
    const withheld = await f.request('/api/runtime/v1/session-context', {expectedRevision: selected.revision, mode: 'audio', audienceScope: 'unknown'});assert.equal(withheld.status, 200);const after = await withheld.json();
    const restored = await f.request('/api/runtime/v1/session-context', {expectedRevision: after.revision, mode: 'text', audienceScope: 'authenticatedSession'});assert.equal(restored.status, 200);
    const value = await f.privacy();assert.equal(value.privateAllowed, false);assert.equal(value.personalSessionId, null);
  } finally {await f.close();}
});

test('a non-modality endpoint profile change retires the declaration permanently even when restored', async () => {
  const f = await fixture();try {
    const id = f.initial.endpoint.endpointId;
    const row = f.database.connection.prepare('SELECT profile_json FROM interaction_endpoints WHERE endpoint_id=?').get(id)!;
    const original = String(row.profile_json), changed = {...JSON.parse(original), locationRef: randomUUID()};
    f.database.connection.prepare('UPDATE interaction_endpoints SET profile_json=? WHERE endpoint_id=?').run(JSON.stringify(changed), id);
    assert.equal((await f.privacy()).privateAllowed, false);
    f.database.connection.prepare('UPDATE interaction_endpoints SET profile_json=? WHERE endpoint_id=?').run(original, id);
    assert.equal((await f.privacy()).privateAllowed, false);assert.equal((await f.privacy()).personalSessionId, null);
  } finally {await f.close();}
});

test('detaching and immediately rebinding the old endpoint cannot skip the original withdrawal', async () => {
  const f = await fixture();try {
    const detached = await f.request('/api/runtime/v1/session-context', {expectedRevision: f.initial.revision, mode: 'none', audienceScope: 'unknown'});assert.equal(detached.status, 200);const next = await detached.json();
    const rebound = await f.request('/api/runtime/v1/session-context', {expectedRevision: next.revision, mode: 'text', audienceScope: 'authenticatedSession', bindingKey: f.bindingKey});assert.equal(rebound.status, 200);assert.equal((await rebound.json()).endpoint.endpointId, f.initial.endpoint.endpointId);
    const value = await f.privacy();assert.equal(value.privateAllowed, false);assert.equal(value.personalSessionId, null);
  } finally {await f.close();}
});

test('a mode change still retires an already prepared reply without withdrawing the explicit private declaration', async () => {
  const f = await fixture(), generate = FixtureInferenceProvider.prototype.generate;
  let release!: () => void;const held = new Promise<void>(resolve => {release = resolve;});
  try {
    const created = await f.request('/api/admin/v1/assistants', {displayName: 'Synthetic mode-change fixture'});assert.equal(created.status, 201);const assistant = await created.json();
    const activated = await f.request(`/api/admin/v1/assistants/${assistant.assistantId}/activate`, {profileId: assistant.profile.profileId, expectedActiveRevision: null});assert.equal(activated.status, 200);
    FixtureInferenceProvider.prototype.generate = async function* () {await held;yield {kind: 'text', text: 'SYNTHETIC_STALE_MODE_REPLY'};yield {kind: 'done'};};
    const reply = await f.request('/api/runtime/v1/messages', {assistantId: assistant.assistantId, userInput: 'Synthetic prepared reply before mode change'});assert.equal(reply.status, 200);const text = reply.text();
    const changed = await f.request('/api/runtime/v1/session-context', {expectedRevision: f.initial.revision, mode: 'audio', audienceScope: 'authenticatedSession'});assert.equal(changed.status, 200);
    const value = await f.privacy();assert.equal(value.privateAllowed, true);assert.equal(value.personalSessionId, f.declaration.personalSessionId);
    release();const result = await text;assert.doesNotMatch(result, /SYNTHETIC_STALE_MODE_REPLY|event: interaction.completed/);assert.match(result, /runtime_input_stale|cancelled/);
  } finally {release?.();FixtureInferenceProvider.prototype.generate = generate;await f.close();}
});

test('a modality change during original Unlock admission still rejects that stale command', async () => {
  let callback: (() => void) | undefined;
  const f = await fixture(() => {const work = callback;callback = undefined;work?.();return Date.now();});
  try {
    const locked = await f.request('/api/runtime/v1/audience/personal-session', f.command(await f.privacy(), f.initial, 'lock'));assert.equal(locked.status, 200);const view = await locked.json();
    callback = () => reviseSessionEndpoint(f.database, f.sessionId, {expectedRevision: f.initial.revision, mode: 'audio', audienceScope: 'authenticatedSession'}, true, f.principalId);
    const result = await f.request('/api/runtime/v1/audience/personal-session', f.command(view, f.initial, 'unlock'));assert.ok([403, 409].includes(result.status));
    const value = await f.privacy();assert.equal(value.privateAllowed, false);assert.equal(value.personalSessionId, null);
  } finally {await f.close();}
});
