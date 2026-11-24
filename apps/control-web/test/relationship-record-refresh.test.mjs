import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installRelationshipAdministration } from '../relationship-admin.js';

// Only the Record Explorer's existing DOM hooks and GET transport are doubled.
// These tests exercise its real async handlers, not browser layout or backend auth.
function fixture(t) {
  const ids = [
    'record-scope', 'record-overview', 'record-filter', 'record-search',
    'record-status', 'records-refresh', 'records-export', 'record-category',
    'record-lane', 'record-event', 'record-sensitivity', 'record-content',
    'record-declare', 'record-list', 'record-operation-panel',
    'record-operation-title', 'record-operation-subject', 'record-operation-id',
    'record-operation-text-label', 'record-operation-field-name',
    'record-operation-text', 'record-conflict-label', 'record-conflict',
    'record-other-label', 'record-other', 'record-operation-help',
    'record-operation-apply', 'record-operation-cancel',
  ];
  const nodes = new Map(ids.map(id => [id, {
    value: '', innerHTML: '', textContent: '', open: false, hidden: false,
    replaceChildren() { this.innerHTML = ''; this.textContent = ''; },
    close() { this.open = false; },
    addEventListener() {},
  }]));
  nodes.get('record-filter').value = 'all';
  nodes.get('record-status').value = 'all';
  const section = {
    querySelector(selector) {
      const node = nodes.get(selector.slice(1));
      assert.ok(node, `Unexpected DOM hook: ${selector}`);
      return node;
    },
  };
  const listeners = new Map();
  const prior = Object.fromEntries(['document', 'window'].map(name =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  globalThis.document = { createElement(tag) { assert.equal(tag, 'section'); return section; } };
  globalThis.window = { addEventListener(name, fn) { listeners.set(name, fn); } };
  t.after(() => {
    for (const name of ['document', 'window']) {
      if (prior[name]) Object.defineProperty(globalThis, name, prior[name]);
      else delete globalThis[name];
    }
  });
  let scope = { assistantId: 'synthetic-assistant', relationship: {
    relationshipId: 'synthetic-relationship', userId: 'synthetic-user', revision: 1,
  } };
  const requests = [], messages = [];
  installRelationshipAdministration({
    anchor: { after(value) { assert.equal(value, section); } },
    api(path, options) {
      assert.equal(options, undefined, 'No mutation or export belongs in this fixture');
      assert.match(path, /^\/api\/admin\/v1\/assistants\/[^/]+\/relationships\/[^/]+\/records$/u);
      return new Promise((resolve, reject) => requests.push({ path, resolve, reject }));
    },
    context: () => scope,
    show: (...args) => messages.push(args),
    refreshRelationship() { assert.fail('No mutation refresh belongs in this fixture'); },
  });
  return {
    requests, messages,
    get: id => nodes.get(id),
    refresh: () => nodes.get('records-refresh').onclick(),
    setScope: value => { scope = value; },
    dispatch: type => listeners.get(type)({ type }),
    view: () => ({
      scope: nodes.get('record-scope').textContent,
      records: nodes.get('record-list').innerHTML,
      overview: nodes.get('record-overview').innerHTML,
    }),
  };
}

function records(revision, content, userId = 'synthetic-user') {
  return {
    relationship: { userId, revision, candidates: [{
      candidateId: 'synthetic-record', revision, content,
      category: 'declaration', status: 'approved', uncertainty: 'high',
      source: 'synthetic declaration', sourceFamily: 'synthetic',
    }] },
    overview: {
      activeRecords: 1, pendingReview: 0, retainedConflicts: 0, sourceFamilies: 1,
      coverage: 'Synthetic fixture', verifiedEventsLimitation: 'Synthetic fixture only.',
      latestRecordAt: null, highUncertainty: 1,
    },
  };
}

async function seed(f) {
  const pending = f.refresh();
  f.requests.at(-1).resolve(records(1, 'Previously displayed record'));
  await pending;
  return f.view();
}

const options = { concurrency: false, timeout: 2000 };

test('a late older response cannot replace the newest records or revision', options, async t => {
  const f = fixture(t), older = f.refresh(), newer = f.refresh();
  f.requests[1].resolve(records(9, 'Newest record'));
  await newer;
  f.requests[0].resolve(records(8, 'Obsolete record'));
  await older;
  // Search reuses the retained relationship, so it must retain the new state too.
  f.get('record-search').oninput();
  assert.match(f.view().scope, /Revision 9/u);
  assert.match(f.view().records, /Newest record/u);
  assert.doesNotMatch(f.view().records, /Obsolete record/u);
  assert.deepEqual(f.messages, []);
});

test('an older response is withheld while the latest refresh is still pending', options, async t => {
  const f = fixture(t), prior = await seed(f);
  const older = f.refresh(), newer = f.refresh();
  f.requests[1].resolve(records(8, 'Obsolete intermediate record'));
  await older;
  const whilePending = f.view();
  f.requests[2].resolve(records(9, 'Newest record'));
  await newer;
  assert.deepEqual(whilePending, prior);
  assert.match(f.view().scope, /Revision 9/u);
});

test('an obsolete refresh error does not replace a successful refresh with an alert', options, async t => {
  const f = fixture(t), older = f.refresh(), newer = f.refresh();
  f.requests[1].resolve(records(9, 'Newest record'));
  await newer;
  f.requests[0].reject(new Error('Obsolete refresh failed'));
  await older;
  assert.deepEqual(f.messages, []);
  assert.match(f.view().records, /Newest record/u);
});

test('the latest failure is reported and a superseded response cannot overwrite the prior view', options, async t => {
  const f = fixture(t), prior = await seed(f);
  const older = f.refresh(), newer = f.refresh();
  f.requests[2].reject(new Error('Current refresh failed'));
  await newer;
  f.requests[1].resolve(records(8, 'Obsolete record'));
  await older;
  assert.deepEqual(f.messages, [['Current refresh failed', true]]);
  assert.deepEqual(f.view(), prior);
  const retry = f.refresh();
  f.requests[3].resolve(records(10, 'Successful retry'));
  await retry;
  assert.match(f.view().scope, /Revision 10/u);
  assert.match(f.view().records, /Successful retry/u);
});

test('auth and Assistant changes clear the old view and fence pending responses', options, async t => {
  const f = fixture(t);
  await seed(f);
  for (const type of ['lifestream-auth', 'lifestream-assistant']) {
    const older = f.refresh(), oldRequest = f.requests.at(-1);
    f.setScope({ assistantId: `next-${type}`, relationship: {
      relationshipId: `next-${type}`, userId: 'next-user', revision: 1,
    } });
    f.dispatch(type);
    const cleared = f.view();
    const newer = f.refresh();
    f.requests.at(-1).resolve(records(2, 'New scope record', 'next-user'));
    await newer;
    oldRequest.resolve(records(99, 'Old scope record'));
    await older;
    assert.equal(cleared.records, '');
    assert.equal(cleared.overview, '');
    assert.equal(cleared.scope, 'Select an Assistant and your relationship.');
    assert.match(f.view().scope, /next-user · Revision 2/u);
    assert.doesNotMatch(f.view().records, /Old scope record/u);
    assert.deepEqual(f.messages, []);
  }
});

test('relationship selection still refreshes automatically without resurfacing the old scope', options, async t => {
  const f = fixture(t), older = f.refresh();
  f.setScope({ assistantId: 'next-assistant', relationship: {
    relationshipId: 'next-relationship', userId: 'next-user', revision: 1,
  } });
  f.dispatch('lifestream-relationship');
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].path,
    '/api/admin/v1/assistants/next-assistant/relationships/next-relationship/records');
  f.requests[1].resolve(records(2, 'New relationship record', 'next-user'));
  f.requests[0].resolve(records(99, 'Old relationship record'));
  await older;
  assert.match(f.view().scope, /next-user · Revision 2/u);
  assert.match(f.view().records, /New relationship record/u);
  assert.doesNotMatch(f.view().records, /Old relationship record/u);
  assert.deepEqual(f.messages, []);
});
