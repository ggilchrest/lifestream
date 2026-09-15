import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database, type TrustedGrantProposal } from '@lifestream/storage-sqlite';
import { createContractValidator } from '@lifestream/contracts';
import { capabilityInputDigest } from '@lifestream/runtime/capabilities/resolver';
import { createLifestreamServer } from '../src/index.ts';
import { loadProfile } from '../src/config/loader.ts';
const secret = () => `synthetic-${randomBytes(24).toString('hex')}`;
const envelope = (payload: unknown) => ({ schemaVersion: '1.0.0', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), payload });
const validator = createContractValidator(), api = 'https://lifestream.dev/contracts/runtime-api/1.0.0#/$defs/';
async function setup(t: { after(callback: () => unknown): void }, configured = true, external = false) {
  const root = mkdtempSync(join(tmpdir(), 'ls-canonical-api-')); let now = Date.now(), allowed = true, resolutions = 0;
  const config = loadProfile('test'); config.authority.authentication = 'local-password'; if (external) config.authority.provider = 'pwce'; config.storage = { databasePath: join(root, 'db.sqlite'), artifactDirectory: join(root, 'artifacts') };
  const environmentId = randomUUID(), installerToken = secret(), plans = new Map<string, TrustedGrantProposal>();
  let wait: Promise<void> | undefined;
  const host = { environmentId, assertCurrent() { if (!allowed) throw new Error('synthetic host scope withdrawn'); }, async resolveProposal(payload: any) { resolutions++; if (wait) await wait; if (!allowed) throw new Error('synthetic host unavailable'); const proposal = plans.get(payload.invocationId); if (!proposal) throw new Error('No validated invocation'); return structuredClone(proposal); } };
  const app = createLifestreamServer({ config, localAuth: { stateDirectory: join(root, 'safety'), installerToken, now: () => now }, ...(configured ? { canonicalAuthority: host } : {}) });
  await app.start(); const base = `http://127.0.0.1:${app.address().port}`, headers: Record<string, string> = { origin: base, 'content-type': 'application/json' };
  const send = async (path: string, body?: unknown, extra: Record<string, string> = {}, method?: string) => {
    const response = await fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = await send('/api/auth/v1/setup', { username: 'owner', password: secret(), installerToken }); headers.cookie = login.cookie!; headers['x-lifestream-csrf'] = login.body.session.csrfToken;
  const session = login.body.session;
  const assistant = await send('/api/admin/v1/assistants', { displayName: 'Synthetic canonical grants' }); assert.equal(assistant.status, 201);
  const endpoint = await send('/api/runtime/v1/session-context', { expectedRevision: 0, mode: 'text', audienceScope: 'authenticatedSession' }); assert.equal(endpoint.status, 200);
  const db = new Database({ path: config.storage.databasePath });
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const prepare = (kind: 'allowOnce' | 'allowSession' | 'allowPersistent' = 'allowOnce') => {
    const args = { text: 'Synthetic text for an explicit test target.' };
    const request: TrustedGrantProposal['request'] = { assistantId: assistant.body.assistantId, endpointId: endpoint.body.endpoint.endpointId, environmentId, sessionId: session.sessionId,
      invocationId: randomUUID(), interactionTraceId: randomUUID(), scope: { capabilityId: 'synthetic.echo', capabilityVersion: '1.0.0', operation: 'echo', targetRefs: ['synthetic:target:one'], dataScopeRefs: [] },
      inputDigest: capabilityInputDigest(args), effectSummary: 'Echo synthetic text to synthetic target one.', sideEffectClass: 'reversible', requestedClass: kind,
      grantExpiresAt: new Date(now + 60_000).toISOString(), reviewAfter: kind === 'allowPersistent' ? new Date(now + 30_000).toISOString() : null,
      expiresAt: new Date(now + 45_000).toISOString(), untrustedRationale: null };
    const proposal = { request, scopeDerivation: 'validatedArguments' as const }; plans.set(request.invocationId, proposal);
    const { environmentId: _environment, sideEffectClass: _effect, ...payload } = request;
    return envelope(payload);
  };
  return { send, prepare, db, base, headers, session, assistantId: assistant.body.assistantId, plans,
    setAllowed: (value: boolean) => { allowed = value; }, setWait: (value: Promise<void>) => { wait = value; }, resolutions: () => resolutions, advance: (ms: number) => { now += ms; } };
}
const approveBody = (request: any) => envelope({ requestId: request.requestId, expectedRevision: request.revision, confirmationDigest: request.confirmationDigest, grantClass: request.requestedClass, expiresAt: request.grantExpiresAt, reviewAfter: request.reviewAfter });
const check = (name: string, result: { status: number; body: unknown }, expected: number) => { assert.equal(result.status, expected, JSON.stringify(result.body)); const validation = validator.validate(api + name + 'Response', result.body); assert.ok(validation.valid, JSON.stringify(validation.errors)); };

test('all nine canonical grant routes run through actual local authentication and stored audit evidence', async t => {
  const f = await setup(t), created = await f.send('/api/authority/v1/requests', f.prepare()); check('CreateAuthorityRequest', created, 201);
  const request = created.body.result; assert.equal(request.state, 'pending'); assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 0);
  check('GetAuthorityRequest', await f.send(`/api/authority/v1/requests/${request.requestId}`), 200);
  const listing = await f.send(`/api/authority/v1/requests?assistantId=${f.assistantId}`); check('ListAuthorityRequests', listing, 200); assert.equal(listing.body.result.requests.length, 1);
  const approved = await f.send(`/api/authority/v1/requests/${request.requestId}/approve`, approveBody(request)); check('ApproveAuthorityRequest', approved, 200);
  const grant = approved.body.result.grant, auditRef = approved.body.result.auditRef;
  const audit = f.db.connection.prepare('SELECT * FROM canonical_authority_artifacts WHERE reference=?').get(auditRef.reference) as any;
  assert.equal(createHash('sha256').update(audit.payload_json).digest('hex'), auditRef.sha256); assert.equal(Buffer.byteLength(audit.payload_json), auditRef.byteLength);
  const auditData = JSON.parse(audit.payload_json); assert.equal(auditData.disposition, 'approved'); assert.equal(auditData.principalId, f.session.principalId);
  const snapshot = f.db.connection.prepare('SELECT * FROM canonical_authority_artifacts WHERE reference=?').get(auditData.recordRef.reference) as any; assert.equal(snapshot.sha256, auditData.recordRef.sha256);
  const proof = f.db.connection.prepare('SELECT payload_json FROM canonical_authority_artifacts WHERE reference=?').get(grant.authenticationEvidenceRef) as any;
  const authentication = JSON.parse(proof.payload_json); assert.equal(authentication.principalId, f.session.principalId); assert.equal(authentication.sessionId, f.session.sessionId); assert.equal(authentication.providerRef, 'local-password'); assert.equal('tokenHash' in authentication, false);
  const grants = await f.send(`/api/authority/v1/grants?assistantId=${f.assistantId}`); check('ListAuthorityGrants', grants, 200); assert.equal(grants.body.result.grants[0].eligible, true);
  const detail = await f.send(`/api/authority/v1/grants/${grant.grantId}`); check('GetAuthorityGrant', detail, 200); assert.equal(detail.body.result.events[0].type, 'issued'); assert.deepEqual(detail.body.result.admittedInvocationIds, []);
  const revoked = await f.send(`/api/authority/v1/grants/${grant.grantId}/revoke`, envelope({ grantId: grant.grantId, expectedRevision: 1, reason: { code: 'human_revoked', summary: 'Synthetic revocation reason.' } })); check('RevokeAuthorityGrant', revoked, 200); assert.equal(revoked.body.result.grant.status, 'revoked');
  const revocationAudit = f.db.connection.prepare('SELECT payload_json FROM canonical_authority_artifacts WHERE reference=?').get(revoked.body.result.auditRef.reference) as any; assert.equal(JSON.parse(revocationAudit.payload_json).reason.code, 'human_revoked');
  for (const decision of ['deny','cancel']) {
    const pending = (await f.send('/api/authority/v1/requests', f.prepare())).body.result;
    const result = await f.send(`/api/authority/v1/requests/${pending.requestId}/${decision}`, envelope({ requestId: pending.requestId, expectedRevision: 1, confirmationDigest: pending.confirmationDigest, reason: { code: 'human_review', summary: 'Synthetic review.' } }));
    check(decision === 'deny' ? 'DenyAuthorityRequest' : 'CancelAuthorityRequest', result, 200); assert.equal(result.body.result.grant, null);
  }
});

test('canonical transport rejects forged terms, stale confirmation, path mismatch and unsafe mutations', async t => {
  const f = await setup(t), payload = f.prepare();
  const forged = structuredClone(payload) as any; forged.payload.principalId = randomUUID(); check('CreateAuthorityRequest', await f.send('/api/authority/v1/requests', forged), 422);
  const widened = structuredClone(payload) as any; widened.payload.scope.targetRefs.push('synthetic:unreviewed'); check('CreateAuthorityRequest', await f.send('/api/authority/v1/requests', widened), 409);
  const pending = (await f.send('/api/authority/v1/requests', payload)).body.result, body = approveBody(pending);
  const stale = structuredClone(body) as any; stale.payload.confirmationDigest = '0'.repeat(64); check('ApproveAuthorityRequest', await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, stale), 409);
  check('ApproveAuthorityRequest', await f.send(`/api/authority/v1/requests/${randomUUID()}/approve`, body), 422);
  check('ApproveAuthorityRequest', await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, body, { 'x-lifestream-csrf': 'wrong' }), 403);
  check('ApproveAuthorityRequest', await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, body, { origin: 'https://untrusted.invalid' }), 403);
  check('ListAuthorityRequests', await f.send(`/api/authority/v1/requests?assistantId=${f.assistantId}`, undefined, { cookie: '' }), 401);
  assert.equal((await f.send('/api/authority/v1/grants', envelope({}))).status, 405);
  assert.equal((await f.send(`/api/authority/v1/grants/${randomUUID()}/dispatch`, envelope({}))).status, 405);
  assert.equal((await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, undefined)).status, 405);
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 0);
});

test('canonical idempotency returns original approval after revocation and changed host availability without new proposals', async t => {
  const f = await setup(t), input = f.prepare(), created = await f.send('/api/authority/v1/requests', input), pending = created.body.result;
  const body = approveBody(pending), first = await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, body); check('ApproveAuthorityRequest', first, 200);
  await f.send(`/api/authority/v1/grants/${first.body.result.grant.grantId}/revoke`, envelope({ grantId: first.body.result.grant.grantId, expectedRevision: 1, reason: { code: 'review_done', summary: 'Synthetic review done.' } }));
  f.setAllowed(false);
  const replay = await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, { ...body, requestId: randomUUID(), correlationId: randomUUID() }); check('ApproveAuthorityRequest', replay, 200); assert.deepEqual(replay.body.result, first.body.result);
  const duplicate = await f.send('/api/authority/v1/requests', input); check('CreateAuthorityRequest', duplicate, 201); assert.deepEqual(duplicate.body.result, pending); assert.equal(f.resolutions(), 1);
  const changed = structuredClone(body) as any; changed.payload.expectedRevision++; const conflict = await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, changed); check('ApproveAuthorityRequest', conflict, 409); assert.equal(conflict.body.error.code, 'authority_idempotency_conflict');
  assert.equal(f.db.connection.prepare("SELECT COUNT(*) AS count FROM canonical_grants WHERE json_extract(payload_json,'$.status')='revoked'").get()!.count, 1);
});

test('audit insertion failure rolls back approval, proof, grant, request decision and retry completion', async t => {
  const f = await setup(t), pending = (await f.send('/api/authority/v1/requests', f.prepare())).body.result, input = approveBody(pending);
  const count = f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_authority_artifacts').get()!.count;
  f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON canonical_authority_artifacts WHEN NEW.schema_ref='urn:lifestream:local-authority-audit:1' BEGIN SELECT RAISE(ABORT,'synthetic audit write failure'); END");
  check('ApproveAuthorityRequest', await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, input), 503);
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 0); assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_authority_artifacts').get()!.count, count);
  assert.equal((await f.send(`/api/authority/v1/requests/${pending.requestId}`)).body.result.state, 'pending');
  f.db.exec('DROP TRIGGER fail_audit'); check('ApproveAuthorityRequest', await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, input), 200);
});

test('bounded canonical pagination rejects changed filters, duplicate query keys and stale snapshots', async t => {
  const f = await setup(t); for (let n = 0; n < 3; n++) await f.send('/api/authority/v1/requests', f.prepare());
  const url = `/api/authority/v1/requests?assistantId=${f.assistantId}&limit=1`;
  const first = await f.send(url); check('ListAuthorityRequests', first, 200); assert.equal(first.body.result.requests.length, 1);
  const cursor = encodeURIComponent(first.body.result.nextCursor), next = await f.send(url + '&cursor=' + cursor); check('ListAuthorityRequests', next, 200); assert.notEqual(first.body.result.requests[0].requestId, next.body.result.requests[0].requestId);
  check('ListAuthorityRequests', await f.send(url + '&states=pending&cursor=' + cursor), 409);
  for (const query of ['&limit=2', '&unexpected=true']) check('ListAuthorityRequests', await f.send(url + query), 422);
  check('ListAuthorityRequests', await f.send(`/api/authority/v1/requests?assistantId=${f.assistantId}&limit=101`), 422);
  await f.send('/api/authority/v1/requests', f.prepare()); check('ListAuthorityRequests', await f.send(url + '&cursor=' + cursor), 409);
  const requestId = randomUUID(), correlationId = randomUUID(); const identified = await f.send(url, undefined, { 'x-request-id': requestId, 'x-correlation-id': correlationId }); assert.equal(identified.body.requestId, requestId); assert.equal(identified.body.correlationId, correlationId);
});

test('cross-Human reads and decisions disclose no canonical request or grant', async t => {
  const f = await setup(t), pending = (await f.send('/api/authority/v1/requests', f.prepare())).body.result;
  const password = secret(), member = await f.send('/api/auth/v1/accounts', { username: 'member', password });
  await f.send('/api/auth/v1/permissions', { principalId: member.body.principalId, assistantId: f.assistantId, administer: true });
  const login = await f.send('/api/auth/v1/sign-in', { username: 'member', password }), headers = { cookie: login.cookie!, 'x-lifestream-csrf': login.body.session.csrfToken };
  const hidden = await f.send(`/api/authority/v1/requests/${pending.requestId}`, undefined, headers); check('GetAuthorityRequest', hidden, 404); assert.equal(hidden.body.result, null);
  check('ApproveAuthorityRequest', await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, approveBody(pending), headers), 404);
  const listing = await f.send(`/api/authority/v1/requests?assistantId=${f.assistantId}`, undefined, headers); check('ListAuthorityRequests', listing, 200); assert.deepEqual(listing.body.result.requests, []);
});

test('scope withdrawal and idle expiry while trusted proposal resolution waits cannot create a request', async t => {
  for (const action of ['scope', 'idle']) {
    const f = await setup(t), input = f.prepare(); let release!: () => void; f.setWait(new Promise<void>(resolve => { release = resolve; }));
    const pending = f.send('/api/authority/v1/requests', input);
    while (!f.resolutions()) await new Promise(resolve => setTimeout(resolve, 5));
    if (action === 'scope') f.setAllowed(false); else f.advance(1_800_000);
    release(); const result = await pending; assert.ok(result.status === 401 || result.status === 503); assert.equal(result.body.status, 'failed');
    assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grant_requests').all().length, 0);
  }
});

test('missing trusted composition cannot turn submitted fields into a validated invocation', async t => {
  const f = await setup(t, false); check('CreateAuthorityRequest', await f.send('/api/authority/v1/requests', f.prepare()), 503);
  const listing = await f.send(`/api/authority/v1/requests?assistantId=${f.assistantId}`); check('ListAuthorityRequests', listing, 200); assert.deepEqual(listing.body.result.requests, []);
});

test('canonical GETs preserve stored state while review and expiry boundaries deny eligibility', async t => {
  const f = await setup(t), pending = (await f.send('/api/authority/v1/requests', f.prepare('allowPersistent'))).body.result;
  const approved = await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, approveBody(pending)); check('ApproveAuthorityRequest', approved, 200);
  const grant = approved.body.result.grant;
  const before = f.db.connection.prepare('SELECT payload_json,sha256 FROM canonical_grants').all();
  f.advance(30_000); const reviewed = await f.send(`/api/authority/v1/grants/${grant.grantId}`); check('GetAuthorityGrant', reviewed, 200); assert.equal(reviewed.body.result.eligible, false); assert.equal(reviewed.body.result.reason.code, 'authority_review_due');
  f.advance(30_000); const expired = await f.send(`/api/authority/v1/grants/${grant.grantId}`); assert.equal(expired.body.result.reason.code, 'authority_grant_expired');
  assert.deepEqual(f.db.connection.prepare('SELECT payload_json,sha256 FROM canonical_grants').all(), before);
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grant_events').all().length, 1);
});

test('corrupt record or authentication evidence cannot be released as a successful approval replay', async t => {
  for (const target of ['record', 'proof']) {
    const f = await setup(t), pending = (await f.send('/api/authority/v1/requests', f.prepare())).body.result, body = approveBody(pending);
    const approved = await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, body); check('ApproveAuthorityRequest', approved, 200);
    const audit = JSON.parse((f.db.connection.prepare('SELECT payload_json FROM canonical_authority_artifacts WHERE reference=?').get(approved.body.result.auditRef.reference) as any).payload_json);
    const reference = target === 'record' ? audit.recordRef.reference : approved.body.result.grant.authenticationEvidenceRef;
    f.db.connection.prepare("UPDATE canonical_authority_artifacts SET payload_json='{}' WHERE reference=?").run(reference);
    check('ApproveAuthorityRequest', await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, body), 503);
    assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 1);
  }
});

test('endpoint change and unsupported reusable scope cannot issue new canonical grants', async t => {
  const f = await setup(t), input = f.prepare('allowSession'); f.plans.get((input.payload as any).invocationId)!.scopeDerivation = 'inputBoundOnly';
  check('CreateAuthorityRequest', await f.send('/api/authority/v1/requests', input), 422);
  const pending = (await f.send('/api/authority/v1/requests', f.prepare())).body.result;
  await f.send('/api/runtime/v1/session-context', { expectedRevision: 1, mode: 'none', audienceScope: 'unknown' });
  check('ApproveAuthorityRequest', await f.send(`/api/authority/v1/requests/${pending.requestId}/approve`, approveBody(pending)), 409);
  assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grants').all().length, 0);
});


test('PWCE governance never falls back to the configured local canonical grant host', async t => {
  const f = await setup(t, true, true), requestId = randomUUID(), correlationId = randomUUID();
  const input = f.prepare();
  const result = await f.send('/api/authority/v1/requests', input, { 'x-request-id': requestId, 'x-correlation-id': correlationId });
  check('CreateAuthorityRequest', result, 503); assert.equal(result.body.error.code, 'pwce_authority_unavailable');
  assert.equal(result.body.requestId, input.requestId); assert.equal(result.body.correlationId, input.correlationId);
  assert.equal(f.resolutions(), 0); assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grant_requests').all().length, 0);
});

test('canonical JSON transport rejects duplicate escaped keys, malformed UTF-8 and oversized input', async t => {
  const f = await setup(t);
  for (const raw of ['{"requestId":"one","requestId":"two"}', '{"requestId":"one","request\\u0049d":"two"}', '{"payload":{"scope":1,"scope":2}}', '{', Buffer.from([0xff])]) {
    const response = await fetch(f.base + '/api/authority/v1/requests', { method: 'POST', headers: f.headers, body: raw });
    const result = { status: response.status, body: await response.json() }; check('CreateAuthorityRequest', result, 400);
  }
  const response = await fetch(f.base + '/api/authority/v1/requests', { method: 'POST', headers: f.headers, body: JSON.stringify({ text: 'x'.repeat(131072) }) });
  check('CreateAuthorityRequest', { status: response.status, body: await response.json() }, 413);
  assert.equal(f.resolutions(), 0); assert.equal(f.db.connection.prepare('SELECT * FROM canonical_grant_requests').all().length, 0);
});
