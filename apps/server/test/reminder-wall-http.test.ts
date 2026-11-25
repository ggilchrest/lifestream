import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLifestreamServer } from '../src/index.ts';
import { loadProfile } from '../src/config/loader.ts';
import { configureReminders } from '../src/composition/reminders.ts';
import {
  EXPECTED_PWCE_ARTIFACTS,
  EXPECTED_PWCE_GENERATED_CLIENT_SHA256,
  EXPECTED_PWCE_PROFILE,
} from '@lifestream/providers-pwce';

test('4 PM through signed-in chat, published PWCE transport, an offline phone and wall renderer receipts', async (t) => {
  const start = Date.parse('2026-11-24T21:59:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const directory = await mkdtemp(join(tmpdir(), 'ls-wall-')),
    config = loadProfile('test');
  config.storage = {
    databasePath: join(directory, 'db.sqlite'),
    artifactDirectory: join(directory, 'artifacts'),
  };
  config.authority.authentication = 'local-password';
  const installerToken = randomUUID(),
    password = randomUUID(),
    localAuth = { stateDirectory: join(directory, 'auth'), installerToken };
  let app = createLifestreamServer({ config, localAuth });
  await app.start();
  t.after(async () => {
    await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const windows: Record<string, string> = {},
    wall: Record<string, string> = {};
  const post = async (headers: Record<string, string>, route: string, body: unknown) => {
    const origin = 'http://127.0.0.1:' + app.address().port;
    const res = await fetch(origin + route, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const data = await res.text();
    assert.equal(res.ok, true, data);
    return { data, headers: res.headers };
  };
  async function signIn(headers: Record<string, string>, setup = false) {
    const reply = await post(headers, '/api/auth/v1/' + (setup ? 'setup' : 'sign-in'), {
      username: 'owner',
      password,
      ...(setup ? { installerToken } : {}),
    });
    headers.cookie = reply.headers.get('set-cookie')!.split(';')[0]!;
    const { session } = JSON.parse(reply.data);
    headers['x-lifestream-csrf'] = session.csrfToken;
    const context = JSON.parse(
      (
        await post(headers, '/api/runtime/v1/session-context', {
          mode: 'text',
          expectedRevision: 0,
          audienceScope: 'authenticatedSession',
        })
      ).data,
    );
    return { owner: session.principalId, endpointId: context.endpoint.endpointId };
  }
  await signIn(windows, true);
  const { assistantId } = JSON.parse(
    (await post(windows, '/api/admin/v1/assistants', { displayName: 'Synthetic Assistant' })).data,
  );
  const { owner, endpointId } = await signIn(wall);
  const port = app.address().port;
  await app.shutdown();
  const site = 'site.fixture',
    person = 'person.one',
    property = 'zone',
    calls: string[] = [];
  const identity = {
    assistantRef: 'assistant.one',
    endpointRef: 'scheduler.one',
    participantRefs: ['participant.one'],
    audienceRef: 'audience.one',
  };
  const operations = [
    'context.getPreparedInputs',
    'context.query',
    'evidence.get',
    'events.subscribe',
    'authority.evaluate',
    'authority.authorizeDispatch',
    'authority.getGrants',
    'capabilities.getSnapshot',
    'capabilities.invoke',
    'capabilities.getInvocation',
    'trace.publish',
    'health.get',
  ];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/profile'))
      return Response.json({
        ...EXPECTED_PWCE_PROFILE,
        schemaStatus: 'published',
        operationCatalog: operations.map((operation) => ({ operation })),
      });
    if (path.endsWith('/bundle'))
      return Response.json({
        bundleId: EXPECTED_PWCE_PROFILE.bundleId,
        bundleVersion: EXPECTED_PWCE_PROFILE.bundleVersion,
        bundleDigest: EXPECTED_PWCE_PROFILE.schemaDigest,
        artifacts: EXPECTED_PWCE_ARTIFACTS,
        generatedClient: {
          path: 'src/gateway/generated-client.js',
          sha256: EXPECTED_PWCE_GENERATED_CLIENT_SHA256,
        },
      });
    const q = JSON.parse(String(init?.body));
    assert.deepEqual(q.participantRefs, identity.participantRefs);
    if (path.endsWith('/authority'))
      return Response.json({
        siteRefs: [site],
        authorityContextRef: 'authority.one',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    calls.push(q.operation);
    const meta = {
      profileId: EXPECTED_PWCE_PROFILE.profileId,
      profileVersion: EXPECTED_PWCE_PROFILE.profileVersion,
      worldRef: q.worldRef,
      executionEnvironmentRef: q.executionEnvironmentRef,
      requestId: q.requestId,
      correlationId: q.correlationId,
      siteRef: site,
    };
    if (q.operation === 'events.subscribe')
      return Response.json({
        ...meta,
        principalRef: 'principal.one',
        events: [],
        nextCursor: '0',
        hasMore: false,
        resyncRequired: false,
      });
    assert.equal(q.operation, 'context.query');
    assert.equal(q.externalEntityId, person);
    assert.equal(q.property, property);
    assert.equal(q.allowStale, false);
    return Response.json({
      ...meta,
      entityRef: site + '::' + person,
      property,
      value: 'zone.fixture',
      knowledgeState: 'current',
      basis: 'observed',
      evidenceRefs: ['observation.one'],
      sourceRevision: 'revision.one',
      invalidationCursor: '0',
      eventTime: new Date().toISOString(),
      evaluatedAt: new Date().toISOString(),
      freshnessState: 'current',
      freshnessMs: 30000,
      limitations: [],
    });
  };
  const profile = {
    ...config,
    providers: { ...config.providers, world: 'pwce' },
    pwceProfile: {
      endpoint: 'http://gateway.invalid',
      worldRef: 'world.one',
      executionEnvironmentRef: 'test' as const,
      siteRefs: [site],
      principalRef: 'principal.one',
      lifestreamEnvironmentId: 'environment.one',
      tokenSecretRef: 'fixture',
      timeoutMs: 2000,
      maximumPromptBytes: 4096,
    },
  };
  const composition = configureReminders(
    {
      displays: [
        { owner, assistantId, endpointId, place: 'shop', personal: false, fallback: false },
        {
          owner,
          assistantId,
          endpointId: randomUUID(),
          place: 'elsewhere',
          personal: true,
          fallback: true,
        },
      ],
      people: [
        { owner, person, property, site, maxAgeMs: 30000, zones: { 'zone.fixture': 'shop' }, identity },
      ],
    },
    profile,
    { fetchImpl, token: 'synthetic-test-token' },
  );
  app = createLifestreamServer({ config, port, localAuth, ...composition });
  await app.start();
  const chat = async (client: Record<string, string>, userInput: string, extra: object = {}) =>
    (
      await post(client, '/api/runtime/v1/messages', {
        assistantId,
        userInput,
        timeZone: 'America/Chicago',
        requestId: randomUUID(),
        ...extra,
      })
    ).data;
  const poll = async (shown?: string) =>
    JSON.parse((await post(wall, '/api/runtime/v1/reminder-display', { assistantId, shown })).data)
      .cards;
  if (process.env.PLAYWRIGHT_MODULE) {
    const { browserWallCheck } = await import('./reminder-wall-browser.mjs');
    await browserWallCheck({
      module: process.env.PLAYWRIGHT_MODULE,
      origin: 'http://127.0.0.1:' + port,
      assistantId,
      windows,
      wall,
      advance: () => t.mock.timers.setTime(start + 60000),
      closeWindows: () => post(windows, '/api/auth/v1/sign-out', {}),
      newWindows: () => signIn(windows),
    });
    assert.ok(calls.includes('context.query'));
    return;
  }
  await chat(windows, 'Remind me at 4 PM to check the glue-up');
  await post(windows, '/api/auth/v1/sign-out', {});
  assert.deepEqual(await poll(), []);
  assert.deepEqual(calls, []);
  t.mock.timers.setTime(start + 60000);
  let cards = await poll();
  for (let i = 0; i < 30 && !cards.length; i++) {
    await delay(100);
    cards = await poll();
  }
  assert.equal(cards.length, 1, 'Gateway calls: ' + JSON.stringify(calls));
  assert.ok(calls.includes('context.query'));
  const [card] = cards;
  assert.equal(card.delivered, false);
  assert.match(JSON.stringify(card.surface), /check the glue-up/);
  const [displayed] = await poll(card.key);
  assert.equal(displayed.key, card.key);
  assert.equal(displayed.delivered, true);
  assert.equal((await poll(card.key)).length, 1);
  const button = card.surface[0].surfaceUpdate.components.find(
    (c: { component: { Button?: { action: { name: string } } } }) =>
      c.component.Button?.action.name === 'done',
  ).component.Button;
  const [item, revision] = button.action.context;
  await chat(wall, 'done ' + item.value.literalString, { itemRevision: revision.value.literalNumber });
  assert.deepEqual(await poll(), []);
  await signIn(windows);
  assert.doesNotMatch(await chat(windows, "What's left?"), /glue-up/);
  assert.match(await chat(windows, 'show my reminders list'), /check the glue-up \(done\)/);
});
