import test from 'node:test';
import assert from 'node:assert/strict';
import {createHealthSyncProgress} from '../web/health-sync-progress.js';

const counts = (confirmed, total, phase = 'syncing') => ({phase, confirmed, total});
function screen(storage = new Map()) {
  const panel = {hidden:true}, label = {}, toggle = {};
  const bar = {removeAttribute(key) { delete this[key]; }};
  const snapshots = [];
  const view = createHealthSyncProgress({panel, label, toggle, bar,
    storage: {getItem:key=>storage.get(key), setItem:(key,value)=>storage.set(key,value)},
    snapshot:()=>new Promise(resolve=>snapshots.push(resolve))});
  return {panel, label, bar, toggle, snapshots, ...view};
}

test('shows reading, real counts, then clears the finished batch', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const ui = screen();
  assert.equal(ui.toggle.checked, true);
  ui.setPrivate(true);
  ui.update({phase:'reading'});
  assert.equal(ui.label.textContent, 'Reading health records…');
  assert.equal(ui.bar.value, undefined);
  ui.update(counts(18, 72));
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.label.textContent, 'Health records 18 / 72');
  assert.deepEqual([ui.bar.value, ui.bar.max], [18, 72]);
  ui.update(counts(20, 72, 'finished'));
  t.mock.timers.tick(2000);
  assert.equal(ui.panel.hidden, true);
  ui.update(counts(3, 2));
  assert.equal(ui.panel.hidden, true);
});

test('turning off hides active progress and persists across launches', async () => {
  const storage = new Map(), ui = screen(storage);
  ui.setPrivate(true);
  ui.toggle.checked = false;
  ui.toggle.onchange();
  ui.snapshots[0]({healthSyncProgress:counts(2, 10)});
  await Promise.resolve();
  ui.update(counts(3, 10));
  assert.equal(ui.panel.hidden, true);
  const reopened = screen(storage);
  reopened.setPrivate(true);
  assert.equal(reopened.toggle.checked, false);
  assert.equal(reopened.snapshots.length, 0);
  reopened.toggle.checked = true;
  reopened.toggle.onchange();
  reopened.snapshots[0]({healthSyncProgress:counts(6, 10)});
  await Promise.resolve();
  assert.equal(reopened.label.textContent, 'Health records 6 / 10');
});

test('new events beat older snapshots and leaving a private session clears counts', async () => {
  const ui = screen();
  ui.setPrivate(true);
  ui.update(counts(4, 8));
  ui.snapshots[0]({healthSyncProgress:{phase:'idle'}});
  await Promise.resolve();
  assert.equal(ui.bar.value, 4);
  ui.setPrivate(false);
  ui.update(counts(8, 8));
  assert.equal(ui.label.textContent, '');
  assert.equal(ui.panel.hidden, true);
  ui.setPrivate(true);
  ui.setPrivate(false);
  ui.snapshots[1]({healthSyncProgress:counts(8, 8)});
  await Promise.resolve();
  assert.equal(ui.panel.hidden, true);
});
