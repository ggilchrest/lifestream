import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifestreamServer } from '../../server/src/index.ts';
import { loadProfile } from '../../server/src/config/loader.ts';
import { followWorkspace } from './workspace-navigation.mjs';

test('human guide download uploads through the real browser file input', { skip: !process.env.PLAYWRIGHT_MODULE, timeout: 90000 }, async t => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const root = await mkdtemp(join(tmpdir(), 'ls-downloaded-file-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = loadProfile('test');
  config.authority.authentication = 'local-password';
  config.storage = { databasePath: join(root, 'state.sqlite'), artifactDirectory: join(root, 'artifacts') };
  const installerToken = randomBytes(32).toString('hex');
  const password = randomBytes(32).toString('hex');
  const app = createLifestreamServer({ config, localAuth: { stateDirectory: join(root, 'safety'), installerToken } });
  await app.start();
  t.after(() => app.shutdown());
  const guideHtml = await readFile(new URL('../../../docs/human-testing-guide.html', import.meta.url));
  const guideFixture = await readFile(new URL('../../../docs/fixtures/synthetic-memory-note.txt', import.meta.url));
  const guideServer = createServer((request, response) => {
    if (request.url === '/human-testing-guide.html') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(guideHtml); return; }
    if (request.url === '/fixtures/synthetic-memory-note.txt') { response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.end(guideFixture); return; }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => guideServer.listen(0, '127.0.0.1', resolve));
  t.after(() => guideServer.close());
  const guidePort = guideServer.address().port;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());

  const guide = await browser.newPage();
  const downloadEvent = guide.waitForEvent('download');
  await guide.goto(`http://127.0.0.1:${guidePort}/human-testing-guide.html`);
  await guide.locator('a[href="fixtures/synthetic-memory-note.txt"]').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'synthetic-memory-note.txt');
  const downloadedPath = join(root, download.suggestedFilename());
  await download.saveAs(downloadedPath);

  const page = followWorkspace(await browser.newPage({ viewport: { width: 1360, height: 960 } }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const api = (path, body) => page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-lifestream-csrf': window.lifestreamAuth.session?.csrfToken || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { path, body });
  const waitText = (selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });

  await page.goto(`http://127.0.0.1:${app.address().port}/control/`);
  await page.locator('#auth-username').fill('owner');
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-installer-token').fill(installerToken);
  await page.locator('#auth-setup').click();
  await page.waitForFunction(() => window.lifestreamAuth.session);
  await page.locator('#new-assistant').click();
  await waitText('#result', 'Assistant created');
  const assistant = (await api('/api/admin/v1/assistants')).body.assistants[0];
  const profile = assistant.profiles[0];
  assert.equal((await api(`/api/admin/v1/assistants/${assistant.assistantId}/activate`, { profileId: profile.profileId, expectedActiveRevision: null })).status, 200);
  const relationshipPath = `/api/admin/v1/assistants/${assistant.assistantId}/relationships`;
  assert.ok([200, 201].includes((await api(relationshipPath, {})).status));
  await page.reload();
  await page.waitForFunction(() => window.lifestreamAuth.session);
  await page.locator('#assistant-list').getByRole('button', { name: profile.displayName, exact: true }).click();
  await waitText('#relationship-results', 'revision 1');

  await page.locator('#builder-files').setInputFiles(downloadedPath);
  await page.locator('#builder-owned').check();
  await page.locator('#builder-inventory').click();
  await waitText('#builder-status', 'inventoried');
  const status = await page.locator('#builder-status').textContent();
  assert.match(status, /synthetic-memory-note\.txt/u);
  assert.doesNotMatch(status, /Selected filename/u);
  assert.deepEqual(errors, []);
});
