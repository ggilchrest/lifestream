import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../packages/storage-sqlite/src/database.ts';
import { listCommand, executeList } from '../src/runtime/personal-lists.ts';
import { ReminderHost } from '../src/runtime/reminder-host.ts';
import { listSurface } from '../src/runtime/list-surface.ts';

test('host restores a Windows reminder, retries a lost wall receipt, and acknowledges one display', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ls-list-')),
    path = join(dir, 'fixture.sqlite');
  let db = new Database({ path });
  db.migrate();
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let now = Date.parse('2026-11-24T21:59:00Z'),
    place = 'shop',
    fresh = true;
  const chat = (text: string, key: string = randomUUID(), owner = 'user') =>
    executeList(db, owner, listCommand(text)!, key, 'America/Chicago', now);
  const glue = chat('Add wood glue to my shopping list', 'one').items[0]!;
  assert.equal(chat('Add wood glue to my shopping list', 'one').items.length, 1);
  assert.equal(chat('Show my shopping list', undefined, 'other').items.length, 0);
  const controls = listSurface('shopping', [glue]);
  assert.match(JSON.stringify(controls), /"Button"/);
  chat('mark wood glue done');
  const reminder = chat('Remind me at 4 PM to check the glue-up').items[0]!;
  const displays = new Set<string>();
  let attempts = 0,
    privateDisplay = true;
  const host = () =>
    new ReminderHost(db, {
      now: () => now,
      presence: async (owner) =>
        owner === 'user'
          ? { place, home: place === 'home' ? 'home' : 'away', observed: now, current: () => fresh }
          : undefined,
      endpoints: () => [
        {
          id: 'wall',
          place: 'shop',
          personal: false,
          fallback: privateDisplay === false,
          disclosure: () => (privateDisplay ? 'private' : 'generic'),
          present: async (key, surface, current) => {
            assert.ok(current());
            assert.equal(JSON.stringify(surface).includes('glue-up'), privateDisplay);
            displays.add(key);
            return ++attempts !== 1;
          },
        },
      ],
    });
  let scheduler = host();
  await scheduler.tick();
  assert.equal(attempts, 0);
  now += 60000;
  fresh = false;
  await scheduler.tick();
  assert.equal(attempts, 0);
  fresh = true;
  await scheduler.tick();
  assert.equal(chat('show my reminders list').items[0]!.delivery, 'pending');
  scheduler.close();
  db.close();
  db = new Database({ path });
  db.migrate();
  scheduler = host();
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(attempts, 2);
  assert.equal(displays.size, 1);
  assert.equal(chat('show my reminders list').items[0]!.delivery, 'delivered');
  chat('done ' + reminder.id);
  assert.equal(chat('show my reminders list').items[0]!.delivery, 'acknowledged');
  assert.deepEqual(chat("What's left?").items, []);
  const parcel = chat('remind me to visit the post office').items.at(-1)!;
  place = 'home';
  await scheduler.tick();
  fresh = false;
  now += 60000;
  await scheduler.tick();
  assert.equal(attempts, 2);
  fresh = true;
  place = 'shop';
  privateDisplay = false;
  await scheduler.tick();
  assert.equal(attempts, 3);
  chat('snooze ' + parcel.id + ' for 10 minutes');
  now += 60000;
  await scheduler.tick();
  assert.equal(attempts, 3);
  chat('reschedule ' + parcel.id + ' to 6 PM');
  chat('cancel ' + parcel.id);
  now += 86400000;
  await scheduler.tick();
  assert.equal(attempts, 3);
  scheduler.close();
});

test('edit retries, reopening, cue corrections, invalid times and pagination preserve saved state', (t) => {
  const db = new Database({ path: ':memory:' });
  db.migrate();
  t.after(() => db.close());
  const now = Date.parse('2026-11-24T18:00:00Z');
  const run = (text: string, key: string = randomUUID()) =>
    executeList(db, 'owner', listCommand(text)!, key, 'America/Chicago', now);
  run('Create a supplies list');
  run('Add hinges to my supplies list');
  run('Edit hinges to brass hinges', 'edit');
  assert.equal(run('Edit hinges to brass hinges', 'edit').items[0]!.title, 'brass hinges');
  assert.throws(() => run('Add screws to my supplies list', 'edit'), /conflict/);
  const job = run('Remind me to check glue tomorrow at 4 PM').items[0]!;
  for (const text of [
    'Remind me to check glue at 4 PM when I am in the shop',
    'Remind me to check glue next time I am in the shop at 4 PM',
  ]) {
    assert.deepEqual(listCommand(text), { kind: 'remind', clock: '4 PM', title: 'check glue' });
  }
  assert.equal(job.due_at, Date.parse('2026-11-25T22:00:00Z'));
  assert.throws(() => run('Remind me to check glue at not-a-time'), /time/);
  assert.equal(run('Reschedule ' + job.id + ' to next time in the garage').items[0]!.cue, 'garage');
  run('done ' + job.id);
  assert.equal(run('reopen ' + job.id).items[0]!.delivery, 'inactive');
  assert.equal(run("What's left on my reminders list?").items[0]!.id, job.id);
  for (let i = 0; i < 21; i++) run('Add pack ' + i + ' to my supplies list');
  const page = run('Show my supplies list');
  assert.equal(page.items.length, 20);
  assert.equal(run(page.next!).items.length, 2);
});
