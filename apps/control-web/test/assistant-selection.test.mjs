import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifestreamServer } from '../../server/src/index.ts';
import { loadProfile } from '../../server/src/config/loader.ts';
import { followWorkspace } from './workspace-navigation.mjs';

test('late automatic selection and earlier clicks cannot replace the latest chosen Assistant', { skip: !process.env.PLAYWRIGHT_MODULE, timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ls-selection-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = loadProfile('test'); config.authority.authentication = 'local-password';
  config.storage = { databasePath: join(root, 'db.sqlite'), artifactDirectory: join(root, 'artifacts') };
  const installerToken = randomBytes(32).toString('hex'), password = randomBytes(32).toString('hex');
  const app = createLifestreamServer({ config, localAuth: { stateDirectory: join(root, 'safety'), installerToken } });
  await app.start(); t.after(() => app.shutdown());
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = followWorkspace(await browser.newPage());
  await page.goto(`http://127.0.0.1:${app.address().port}/control/`);
  await page.locator('#auth-username').fill('owner'); await page.locator('#auth-password').fill(password);
  await page.locator('#auth-installer-token').fill(installerToken); await page.locator('#auth-setup').click();
  await page.waitForFunction(() => !!window.lifestreamAuth.session);
  const ids = await page.evaluate(async () => {
    const create = async displayName => (await (await fetch('/api/admin/v1/assistants', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lifestream-csrf': window.lifestreamAuth.session.csrfToken },
      body: JSON.stringify({ displayName }) })).json()).assistantId;
    await create('First Synthetic'); await create('Second Synthetic');
    return (await (await fetch('/api/admin/v1/assistants')).json()).assistants.map(assistant => ({ id: assistant.assistantId, name: assistant.profiles[0].displayName }));
  });
  const first=ids[0], second=ids[1];
  for (const automatic of [true, false]) {
    let release, entered, fulfilled;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const completed = new Promise(resolve => { fulfilled = resolve; });
    const path = `**/api/admin/v1/assistants/${first.id}`;
    await page.route(path, async route => { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); fulfilled(); });
    try {
      if (automatic) {
        await page.locator('#auth-sign-out').click();await page.waitForFunction(()=>!window.lifestreamAuth.session);
        await page.locator('#auth-username').fill('owner');await page.locator('#auth-password').fill(password);await page.locator('#auth-sign-in').click();
      }
      else await page.locator('#assistant-list').getByRole('button', { name: first.name, exact: true }).click();
      await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Delayed selection request never arrived: '+automatic)), 5000))]);
      await page.locator('#assistant-list').getByRole('button', { name: second.name, exact: true }).click();
      await page.waitForFunction(name => document.querySelector('#editor-title').textContent === name,second.name);
      release(); await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error('Delayed selection response not fulfilled: '+automatic)), 5000))]);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
      assert.equal(await page.locator('#editor-title').textContent(), second.name);
      await page.locator('#relationship-create').click();
      await page.waitForFunction(() => document.querySelector('#relationship-results').textContent.includes('revision 1'));
      const counts = await page.evaluate(async ids => Promise.all(ids.map(async id => (await (await fetch(`/api/admin/v1/assistants/${id}/relationships`)).json()).relationships.length)), ids.map(item=>item.id));
      assert.deepEqual(counts, [0, 1], 'The next operation targets the explicitly selected Assistant');
    } finally { release(); await page.unroute(path); }
  }
});
