import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile } from '../src/config/loader.ts';
import { createLifestreamServer } from '../src/index.ts';

test('saved list across authenticated chat sessions and revision-bound A2UI actions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ls-chat-list-')),
    config = loadProfile('test');
  config.storage = { databasePath: join(root, 'db.sqlite'), artifactDirectory: join(root, 'artifacts') };
  config.authority.authentication = 'local-password';
  const installerToken = randomUUID(),
    password = randomUUID();
  const app = createLifestreamServer({
    config,
    localAuth: { stateDirectory: join(root, 'auth'), installerToken },
  });
  await app.start();
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.address().port;
  const headers: Record<string, string> = { origin: base, 'content-type': 'application/json' };
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  async function login(setup: boolean) {
    const r = await post('/api/auth/v1/' + (setup ? 'setup' : 'sign-in'), {
      username: 'owner',
      password,
      ...(setup ? { installerToken } : {}),
    });
    assert.ok(r.ok, 'login ' + r.status);
    headers.cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    headers['x-lifestream-csrf'] = ((await r.json()) as any).session.csrfToken;
    assert.ok(
      (
        await post('/api/runtime/v1/session-context', {
          expectedRevision: 0,
          mode: 'text',
          audienceScope: 'authenticatedSession',
        })
      ).ok,
    );
  }
  await login(true);
  const assistant = (await (
    await post('/api/admin/v1/assistants', { displayName: 'Synthetic Assistant' })
  ).json()) as any;
  const chat = (userInput: string, extra: object = {}) =>
    post('/api/runtime/v1/messages', {
      assistantId: assistant.assistantId,
      userInput,
      requestId: randomUUID(),
      timeZone: 'America/Chicago',
      ...extra,
    });
  const added = await chat('Add wood glue to my shopping list');
  assert.equal(added.status, 200, await added.clone().text());
  const wire = await added.text(),
    payload = JSON.parse(wire.match(/event: message.surface\ndata: (.*)/)![1]!);
  const control = payload.messages[0].surfaceUpdate.components.find((x: any) => x.component.Button)
    .component.Button;
  const target = control.action.context[0].value.literalString,
    itemRevision = control.action.context[1].value.literalNumber;
  assert.equal((await chat('done ' + target, { executionMode: 'replay' })).status, 403);
  const denied = await post('/api/runtime/v1/session-context', {
    expectedRevision: 1,
    mode: 'text',
    audienceScope: 'unknown',
  });
  assert.ok(denied.ok);
  assert.equal((await chat('Show my shopping list')).status, 403);
  assert.ok(
    (
      await post('/api/runtime/v1/session-context', {
        expectedRevision: 2,
        mode: 'text',
        audienceScope: 'authenticatedSession',
      })
    ).ok,
  );
  assert.equal((await chat('done ' + target, { itemRevision })).status, 200);
  assert.equal((await chat('reopen ' + target, { itemRevision })).status, 409);
  assert.ok((await post('/api/auth/v1/sign-out', {})).ok);
  await login(false);
  assert.match(await (await chat('Show my shopping list')).text(), /wood glue \(done\)/);
  assert.doesNotMatch(await (await chat("What's left?")).text(), /wood glue/);
});
