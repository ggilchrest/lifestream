import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../capability-permissions.js', import.meta.url), 'utf8');
const now = Date.parse('2026-11-16T12:00:00Z');

// Fixture-local DOM hooks and a GET-only deferred transport. The real browser
// module runs unchanged; no authority, preparation or dispatch owner is loaded.
class Element {
  constructor(tag = 'div', text = '') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
    this.value = ''; this.hidden = false; this.disabled = false; this.isConnected = true;
    this.attributes = {}; this.textContent = text;
    this.classList = { add() {}, remove() {} };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return [this.text, ...this.children.map(child => child instanceof Element ? child.textContent : String(child))].filter(Boolean).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  focus() {}
}

function fixture() {
  const ids = ['cap-status', 'cap-disclosure', 'security-context', 'session-audience',
    'cap-requests', 'cap-grants', 'cap-requests-more', 'cap-grants-more',
    'cap-request-detail', 'cap-grant-detail', 'cap-requests-state', 'cap-grants-state',
    'cap-grants-class', 'cap-grants-refresh', 'cap-requests-refresh', 'cap-grant-filters',
    'cap-select', 'cap-arguments', 'cap-provider', 'cap-form', 'cap-prepare',
    'cap-prepare-retry', 'cap-class', 'cap-review-label', 'cap-local-permission',
    'cap-refresh', 'cap-duration', 'cap-review'];
  const nodes = new Map(ids.map(id => [id, new Element()]));
  const views = ['prepare', 'requests', 'grants'].map(key => {
    const node = new Element('button'); node.dataset.capView = key; return node;
  });
  const panels = ['prepare', 'requests', 'grants'].map(key => {
    const node = new Element(); node.dataset.capPanel = key; return node;
  });
  const get = id => { assert.ok(nodes.has(id), `Unexpected DOM hook: ${id}`); return nodes.get(id); };
  const listeners = new Map(), requests = [], timers = new Map();
  let epoch = 0, assistant = 'synthetic-assistant';
  const el = (tag, text, cls) => { const node = new Element(tag, text ?? ''); node.className = cls || ''; return node; };
  const security = {
    epoch: () => epoch, assistant: () => assistant,
    base: () => `/api/authority/v1/assistants/${assistant}`,
    el,
    fields: values => el('dl', Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(' ')),
    table: (headers, rows) => {
      const node = el('table'); node.append(el('thead', headers.join(' ')));
      for (const row of rows) { const tr = el('tr'); tr.append(...row); node.append(tr); }
      return node;
    },
    async request(path, body) {
      assert.equal(body, undefined, 'No mutation or dispatch belongs in this fixture');
      assert.match(path, /^\/api\/authority\/v1\/(requests|grants)\?/u);
      const ticket = epoch;
      const result = await new Promise((resolve, reject) => requests.push({ path, resolve, reject }));
      // Retain the original security owner's post-response epoch behavior.
      if (ticket !== epoch) throw new Error('Context changed. Previous response discarded.');
      return result;
    },
  };
  runInNewContext(source, {
    document: {
      getElementById: get,
      querySelectorAll(selector) {
        if (selector === '[data-cap-view]') return views;
        if (selector === '[data-cap-panel]') return panels;
        assert.fail(`Unexpected selector: ${selector}`);
      },
      querySelector(selector) {
        assert.equal(selector, '[data-cap-view=grants]'); return views[2];
      },
    },
    window: { lifestreamSecurity: security, lifestreamPwceActions: new Proxy({}, {
      get() { assert.fail('No PWCE action implementation belongs in this fixture'); },
    }), addEventListener(name, fn) { listeners.set(name, fn); } },
    Option: class extends Element { constructor(text, value) { super('option', text); this.value = value; } },
    Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID() { assert.fail('No authority command belongs in this fixture'); } },
    setTimeout(fn, delay) { const id = timers.size + 1; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, { filename: 'capability-permissions.js' });
  return {
    get, requests, timers,
    refresh: kind => get(`cap-${kind}-refresh`).onclick(),
    more: kind => get(`cap-${kind}-more`).onclick(),
    filter(kind, state) { get(`cap-${kind}-state`).value = state; return get(`cap-${kind}-state`).onchange(); },
    status: () => get('cap-status').textContent,
    text: kind => get(`cap-${kind}`).textContent,
    changeContext() { epoch++; assistant = 'next-synthetic-assistant'; listeners.get('lifestream-security-context')(); },
  };
}

function record(kind, id, grantClass = 'allowOnce') {
  const common = { scope: { capabilityId: 'synthetic.read' }, revision: 1,
    expiresAt: '2026-11-16T13:00:00Z', grantExpiresAt: '2026-11-16T13:00:00Z' };
  return kind === 'requests'
    ? { ...common, requestId: id, requestedClass: grantClass, state: 'pending' }
    : { grant: { ...common, grantId: id, grantClass, status: 'active' }, eligible: false, reason: { summary: 'Synthetic observation only' } };
}
const page = (kind, ids, nextCursor = null) => ({ result: { [kind]: ids.map(id => record(kind, id)), nextCursor } });

for (const kind of ['requests', 'grants']) {
  test(`${kind}: an obsolete failure cannot overwrite the newest successful refresh`, async () => {
    const f = fixture(), older = f.refresh(kind), newer = f.refresh(kind);
    f.requests[1].resolve(page(kind, ['newest-record'])); await newer;
    const status = f.status(), text = f.text(kind);
    f.requests[0].reject(new Error('Obsolete list error')); await older;
    assert.equal(f.status(), status);
    assert.equal(f.text(kind), text);
    assert.match(f.text(kind), /newest-record/u);
  });

  test(`${kind}: an obsolete success cannot hide the latest refresh failure`, async () => {
    const f = fixture(), older = f.refresh(kind), newer = f.refresh(kind);
    f.requests[1].reject(new Error('Latest list error')); await newer;
    const text = f.text(kind);
    f.requests[0].resolve(page(kind, ['obsolete-record'])); await older;
    assert.equal(f.status(), 'Latest list error');
    assert.equal(f.text(kind), text);
    assert.doesNotMatch(f.text(kind), /obsolete-record/u);
  });
}

test('a superseded refresh does not announce success while the latest filter request is pending', async () => {
  const f = fixture(); f.get('cap-status').textContent = 'Current review message';
  const older = f.refresh('requests'), newer = f.filter('requests', 'denied');
  f.requests[0].resolve(page('requests', ['obsolete-record'])); await older;
  const whilePending = f.status();
  f.requests[1].resolve(page('requests', ['current-denied-record'])); await newer;
  assert.equal(whilePending, 'Current review message');
  assert.equal(f.status(), 'Current review message');
  assert.match(f.text('requests'), /current-denied-record/u);
  assert.doesNotMatch(f.text('requests'), /obsolete-record/u);
});

test('latest refresh, pagination and state/class filters retain their existing behavior', async () => {
  for (const kind of ['requests', 'grants']) {
    const f = fixture(), first = f.refresh(kind);
    f.requests[0].resolve(page(kind, ['first-record'], 'cursor+one')); await first;
    assert.match(f.status(), new RegExp(`^Current ${kind} loaded\\.`));
    assert.equal(f.get(`cap-${kind}-more`).hidden, false);
    const next = f.more(kind);
    const query = new URL(f.requests[1].path, 'https://synthetic.invalid').searchParams;
    assert.equal(query.get('assistantId'), 'synthetic-assistant');
    assert.equal(query.get('limit'), '20'); assert.equal(query.get('cursor'), 'cursor+one');
    f.requests[1].resolve(page(kind, ['second-record'])); await next;
    assert.match(f.text(kind), /first-record/u); assert.match(f.text(kind), /second-record/u);
    assert.equal(f.get(`cap-${kind}-more`).hidden, true);
    const filtered = f.filter(kind, 'revoked');
    const filteredQuery = new URL(f.requests[2].path, 'https://synthetic.invalid').searchParams;
    assert.equal(filteredQuery.get('states'), 'revoked'); assert.equal(filteredQuery.has('cursor'), false);
    f.requests[2].resolve(page(kind, ['filtered-record'])); await filtered;
    assert.match(f.text(kind), /filtered-record/u); assert.doesNotMatch(f.text(kind), /first-record|second-record/u);
    if (kind === 'grants') {
      f.get('cap-grants-class').value = 'allowPersistent'; f.get('cap-grants-class').onchange();
      assert.doesNotMatch(f.text(kind), /filtered-record/u);
      f.get('cap-grants-class').value = ''; f.get('cap-grants-class').onchange();
      assert.match(f.text(kind), /filtered-record/u);
      assert.equal(f.requests.length, 3, 'Client class filtering must not request or issue authority');
    }
  }
});

test('a current grant-summary failure withholds old permission observations and a later retry succeeds', async () => {
  const f = fixture(), first = f.refresh('grants');
  f.requests[0].resolve({ result: { grants: [], nextCursor: null, sourceRevision: { revision: 'synthetic-revision' }, externalSummary: {
    providerRef: 'pwce', worldRef: 'synthetic-world', executionEnvironmentRef: 'synthetic-environment', principalRef: 'synthetic-principal',
    expiresAt: '2026-11-16T13:00:00Z', siteRefs: ['synthetic-site'], capabilityRefs: ['synthetic.read'], limitations: ['Synthetic observation only'],
    scope: { assistantId: 'synthetic-assistant' }, evidenceRef: { reference: 'synthetic:evidence' },
  } } }); await first;
  assert.equal(f.status(), 'PWCE permission summary loaded. Approval and action results remain separate.');
  assert.match(f.text('grants'), /does not approve an action/u);
  assert.equal(f.get('cap-grants-more').hidden, true);
  const failed = f.refresh('grants');
  assert.equal(f.text('grants'), 'Reading permissions…');
  f.requests[1].reject(new Error('Current summary unavailable')); await failed;
  assert.equal(f.status(), 'Current summary unavailable');
  assert.equal(f.text('grants'), 'No current permission summary is available. Refresh permissions to try again.');
  assert.doesNotMatch(f.text('grants'), /synthetic-site|synthetic-principal/u);
  const retry = f.refresh('grants'); f.requests[2].resolve(page('grants', ['retried-record'])); await retry;
  assert.match(f.text('grants'), /retried-record/u); assert.match(f.status(), /^Current grants loaded\./u);
});

test('security context changes clear private lists and suppress pending responses and errors', async () => {
  for (const kind of ['requests', 'grants']) for (const failure of [false, true]) {
    const f = fixture(), first = f.refresh(kind);
    f.requests[0].resolve(page(kind, ['previous-subject-record'])); await first;
    const pending = f.refresh(kind); f.changeContext(); const clearedStatus = f.status();
    if (failure) f.requests[1].reject(new Error('Old subject error'));
    else f.requests[1].resolve(page(kind, ['old-subject-response']));
    await pending;
    assert.equal(f.text('requests'), ''); assert.equal(f.text('grants'), '');
    assert.equal(f.get('cap-request-detail').textContent, ''); assert.equal(f.get('cap-grant-detail').textContent, '');
    assert.equal(f.get('cap-prepare').disabled, true);
    assert.equal(f.status(), clearedStatus);
    const current = f.refresh(kind);
    assert.equal(new URL(f.requests[2].path, 'https://synthetic.invalid').searchParams.get('assistantId'), 'next-synthetic-assistant');
    f.requests[2].resolve(page(kind, ['new-subject-record'])); await current;
    assert.match(f.text(kind), /new-subject-record/u);
    assert.doesNotMatch(f.text(kind), /previous-subject|old-subject/u);
  }
});
