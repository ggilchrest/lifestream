import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { renderChatSurface } from '../chat-surface.js';
import { listSurface, reminderForm } from '../../server/src/runtime/list-surface.ts';

test('trusted A2UI renderer refuses a foreign component catalog', () => {
  const target = {
    replaceChildren() {
      throw Error('unexpected render');
    },
  };
  const foreign = [
    { surfaceUpdate: { surfaceId: 's', components: [] } },
    { beginRendering: { surfaceId: 's', root: 'root', catalogId: 'https://invalid.test/catalog' } },
  ];
  assert.equal(
    renderChatSurface(target, foreign, () => {}),
    false,
  );
});
test(
  'Chrome renders text as text, dispatches revision-bound Done and submits a chosen reminder time',
  { skip: !process.env.PLAYWRIGHT_MODULE },
  async (t) => {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const id = randomUUID(),
      title = '<img src=x onerror=alert(1)>';
    const messages = listSurface('Shopping', [
      {
        id,
        title,
        done: 0,
        revision: 1,
        list: 'Shopping',
        delivery: null,
        cue: null,
        due_at: null,
        trigger_kind: null,
      },
    ]);
    await page.route('http://fixture.test/**', (route) =>
      route.request().url().endsWith('/catalog.js')
        ? route.fulfill({
            path: fileURLToPath(new URL('../chat-surface.js', import.meta.url)),
            contentType: 'text/javascript',
          })
        : route.fulfill({ contentType: 'text/html', body: '<main></main>' }),
    );
    await page.goto('http://fixture.test/');
    await page.evaluate(async (messages) => {
      const { renderChatSurface } = await import('/catalog.js');
      window.show = (surface) =>
        renderChatSurface(document.querySelector('main'), surface, (...args) => {
          window.action = args;
        });
      window.show(messages);
    }, messages);
    assert.equal(await page.locator('img').count(), 0);
    await page.getByRole('button', { name: 'Done' }).click();
    assert.deepEqual(await page.evaluate(() => window.action), ['done', id, 1]);
    await page.evaluate((form) => window.show(form), reminderForm('read a book'));
    await page.getByLabel('Reminder date and time').fill('2027-04-01T16:00');
    await page.getByRole('button', { name: 'Set reminder' }).click();
    assert.match((await page.evaluate(() => window.action))[1], /^Remind me at .*Z to read a book$/);
    await page.getByRole('button', { name: 'Next departure from home' }).click();
    assert.deepEqual(await page.evaluate(() => window.action), [
      'chat',
      'Remind me to read a book next time I leave home',
    ]);
  },
);
