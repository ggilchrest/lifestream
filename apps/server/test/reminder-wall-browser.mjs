/** Use the actual conversation component and authenticated host routes with synthetic sessions. */
export async function browserWallCheck({
  module,
  origin,
  assistantId,
  windows,
  wall,
  advance,
  closeWindows,
  newWindows,
}) {
  const { chromium } = await import(module);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  async function openRoom(headers) {
    const context = await browser.newContext({ timezoneId: 'America/Chicago' });
    const cookie = headers.cookie,
      equals = cookie.indexOf('=');
    await context.addCookies([
      { name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: origin },
    ]);
    const page = await context.newPage();
    // This document supplies only the room mount. All modules, reads, writes,
    // display polls, and renderer receipts go to the running fixture host.
    await page.route(origin + '/room-fixture', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<main></main>' }),
    );
    await page.goto(origin + '/room-fixture#conversation');
    await page.evaluate(async (assistantId) => {
      const session = await (await fetch('/api/auth/v1/session')).json();
      window.lifestreamAuth = { mode: 'local-password', ready: Promise.resolve(), session };
      const api = async (path, options) => {
        const r = await fetch(path, {
          ...options,
          headers: { 'content-type': 'application/json', 'x-lifestream-csrf': session.csrfToken },
        });
        if (!r.ok) throw Error('Fixture API ' + r.status);
        return r.json();
      };
      const { installConversationRoom } = await import('/control/conversation-room.js');
      installConversationRoom({
        anchor: document.querySelector('main'),
        api,
        context: () => ({ assistantId, displayName: 'Synthetic Assistant', relationship: null }),
      });
    }, assistantId);
    return page;
  }
  async function say(page, text) {
    await page.locator('#room-message').fill(text);
    await page.locator('#room-send').click();
  }
  try {
    const desktop = await openRoom(windows);
    await say(desktop, 'Remind me at 4 PM to check the glue-up');
    await desktop.getByRole('button', { name: 'Done', exact: true }).waitFor();
    await desktop.context().close();
    await closeWindows();
    const display = await openRoom(wall);
    const area = display.getByRole('region', { name: 'Reminders' });
    if (await area.locator('article').count()) throw Error('Early reminder');
    advance();
    const done = area.getByRole('button', { name: 'Done', exact: true });
    await done.waitFor();
    await display.waitForFunction(
      () => !document.querySelector('section[aria-label="Reminders"] button')?.disabled,
    );
    if (
      (await area.locator('article').count()) !== 1 ||
      !(await area.innerText()).includes('check the glue-up')
    )
      throw Error('Expected one displayed reminder');
    await done.click();
    await display.waitForFunction(
      () => !document.querySelector('section[aria-label="Reminders"] article'),
    );
    await newWindows();
    const fresh = await openRoom(windows);
    await say(fresh, "What's left?");
    await fresh.getByText('No items.', { exact: true }).waitFor();
    await say(fresh, 'Show my reminders list');
    await fresh.getByRole('button', { name: 'Reopen', exact: true }).waitFor();
    if (!(await fresh.locator('#room-turns').innerText()).includes('check the glue-up (done)'))
      throw Error('Completion missing in new session');
  } finally {
    await browser.close();
  }
}
