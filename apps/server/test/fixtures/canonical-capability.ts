import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@lifestream/storage-sqlite';
import { canonicalJson } from '@lifestream/runtime/capabilities/schema-validation';
import type { CapabilityProvider } from '@lifestream/runtime/ports/provider-messages';
import { ConfiguredCapabilitySchemas, encodeCapabilitySchema } from '@lifestream/runtime/capabilities/schema-artifacts';
import { createLifestreamServer } from '../../src/index.ts';
import { loadProfile } from '../../src/config/loader.ts';
export const envelope = (payload: unknown) => ({ schemaVersion: '1.0.0', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), payload });
const secret = () => `Synthetic-${randomBytes(24).toString('hex')}`;
export async function setup(t: { after(callback: () => unknown): void }, configured: boolean | 'startup' = true) {
  const root = mkdtempSync(join(tmpdir(), 'ls-real-preparation-'));
  let now = Date.now(), allowed = true, deriveKind: 'validatedArguments' | 'inputBoundOnly' = 'validatedArguments', variant = 0, calls = 0, wait: Promise<void> | undefined;
  let materialChanged = false, catalogCalls = 0, evaluationCalls = 0, statusCalls = 0;
  let statusMode = 'succeeded', lastStatusRequest: any, statusWait: Promise<void> | undefined, statusEntered: (() => void) | undefined;
  let invokeMode = 'success', governanceMode = 'success', lastInvocation: any, invokeWait: Promise<void> | undefined, invoked: (() => void) | undefined;
  const evidence = Buffer.from('Synthetic provider completion evidence');
  const evidenceRef = { reference: 'urn:synthetic:completion:1', sha256: createHash('sha256').update(evidence).digest('hex'), mediaType: 'application/json', schemaRef: 'urn:synthetic:evidence:1', byteLength: evidence.byteLength };
  let entered: (() => void) | undefined;
  const input = encodeCapabilitySchema('urn:synthetic:echo-input:1', { type: 'object', required: ['target','text'], additionalProperties: false, properties: { target: { enum: ['synthetic:one','synthetic:two'] }, text: { type: 'string', maxLength: 80 } } });
  const output = encodeCapabilitySchema('urn:synthetic:echo-output:1', { type: 'object', required: ['text'], properties: { text: { type: 'string' } }, additionalProperties: false });
  const schemas = new ConfiguredCapabilitySchemas([input, output], () => allowed), snapshots = new Map<string, any>();
  const provider: CapabilityProvider = {
    async getSnapshot(request) {
      catalogCalls++; entered?.(); if (wait) await wait;
      const key = JSON.stringify({ scope: request.scope, variant }); let snapshot = snapshots.get(key);
      if (!snapshot) { snapshot = { schemaVersion: '2.0.0', snapshotId: randomUUID(), revision: 1, assistantId: request.scope.assistantId, endpointId: request.scope.endpointId, sessionId: request.scope.sessionId, environmentId: request.scope.environmentId, authorityContextRef: request.scope.authorityContextRef,
        issuedAt: new Date(Math.min(now, Date.now()) - 100).toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), capabilities: [{ capabilityId: 'synthetic.echo', version: '1.0.0', inputSchemaRef: input.artifact.reference, outputSchemaRef: output.artifact.reference, sideEffectClass: 'reversible', authorization: 'approvalRequired', idempotency: 'required', latencyClass: 'interactive', offlineAvailable: true, simulationSupported: true, providerRouteRef: materialChanged ? 'changed:route' : 'synthetic:echo-route' }] }; snapshots.set(key, snapshot); }
      return { schemaVersion: '1.0.0', operation: request.operation, requestId: request.requestId, correlationId: request.correlationId, providerRef: 'fixture', completedAt: new Date().toISOString(), outcome: { status: 'succeeded', payload: structuredClone(snapshot), error: null } };
    },
    async invoke(request) { calls++; lastInvocation = structuredClone(request); invoked?.(); if (invokeWait) await invokeWait;
      if (invokeMode === 'missing') throw new Error('Synthetic missing reply');
      const completedAt = new Date().toISOString();
      return { schemaVersion: '1.0.0', operation: request.operation, requestId: request.requestId, correlationId: request.correlationId, providerRef: 'fixture', completedAt, outcome: { status: 'succeeded', payload: { type: 'succeeded', invocationId: request.payload.invocationId, output: invokeMode === 'malformed' ? { surprise: true } : { text: (request.payload.input as any).text }, outputSchema: output.artifact, confirmedAt: completedAt, evidenceRef }, error: null } };
    }, async getInvocation(request) {
      statusCalls++; lastStatusRequest = structuredClone(request); const mode = statusMode, wait = statusWait; statusWait = undefined; statusEntered?.(); statusEntered = undefined; if (wait) await wait;
      if (mode === 'missing') throw new Error('Synthetic missing status reply');
      const payload: any = mode === 'confirmedFailure' ? { type: 'failed', invocationId: request.payload.invocationId, error: { code: 'synthetic_failed', message: 'Synthetic confirmed failure', retryable: false, correlationId: request.correlationId, details: [] }, effectState: 'confirmedFailed', evidenceRef } : mode === 'unknown' || mode === 'wrongReceipt' ? { type: 'outcomeUnknown', invocationId: request.payload.invocationId, reason: { code: 'synthetic_unknown', summary: 'Synthetic outcome not yet confirmed' }, receiptRef: mode === 'wrongReceipt' ? { ...lastInvocation.payload.dispatchReceipt, sha256: '0'.repeat(64) } : lastInvocation.payload.dispatchReceipt, reconciliationRef: 'urn:synthetic:status' } :
        { type: 'succeeded', invocationId: mode === 'wrongInvocation' ? randomUUID() : request.payload.invocationId, output: mode === 'malformed' ? { surprise: true } : { text: lastInvocation.payload.input.text }, outputSchema: mode === 'wrongSchema' ? { ...output.artifact, sha256: '0'.repeat(64) } : output.artifact, confirmedAt: new Date().toISOString(), evidenceRef };
      return { schemaVersion: '1.0.0', operation: request.operation, requestId: request.requestId, correlationId: request.correlationId, providerRef: mode === 'wrongProvider' ? 'foreign' : 'fixture', completedAt: new Date().toISOString(), outcome: { status: 'succeeded', payload, error: null } };
    },
    async *subscribeInvalidations() { throw new Error('No subscription in preparation fixture'); }
  };
  const config = loadProfile('test'); config.authority.authentication = 'local-password'; config.storage = { databasePath: join(root, 'data.sqlite'), artifactDirectory: join(root, 'artifacts') };
  const composition = { environmentId: randomUUID(), providerRef: 'fixture', provider, schemas, governance: {
    async evaluate(request: any) {
      evaluationCalls++; const bytes = Buffer.from(JSON.stringify({ invocationId: request.payload.invocationId, inputDigest: request.payload.inputDigest, authority: request.scope.authorityContextRef }));
      const disposition = { decisionId: randomUUID(), providerRef: 'fixture', invocationId: request.payload.invocationId, inputDigest: request.payload.inputDigest,
        scopeDigest: createHash('sha256').update(canonicalJson(request.payload.scope)).digest('hex'), authorityContextRef: request.scope.authorityContextRef,
        disposition: governanceMode === 'denied' ? 'denied' as const : 'authorized' as const, reason: { code: 'synthetic_authorized', summary: 'Synthetic provider decision' }, evaluatedAt: new Date(Math.min(now, Date.now())).toISOString(), expiresAt: new Date(now + 30_000).toISOString(),
        evidenceRef: { reference: `urn:synthetic:decision:${request.payload.invocationId}`, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/json', schemaRef: 'urn:synthetic:evidence:1', byteLength: bytes.length } };
      return { disposition, evidence: governanceMode === 'corrupt' ? Buffer.from('wrong') : bytes };
    },
    assertCurrent() { if (governanceMode === 'stale') throw new Error('Synthetic provider authority changed'); },
    async readEvidence() { return invokeMode === 'corruptEvidence' ? Buffer.from('wrong') : evidence; }
  }, adapters: [{ capabilityId: 'synthetic.echo', version: '1.0.0', providerRouteRef: 'synthetic:echo-route', revision: '1', inputSchema: input.artifact, outputSchema: output.artifact,
    derive(args: unknown) { const value = args as { target: string; text: string }; return { scope: { capabilityId: 'synthetic.echo', capabilityVersion: '1.0.0', operation: 'echo', targetRefs: [value.target], dataScopeRefs: [] }, effectSummary: `Echo ${value.text.length} characters to ${value.target}.`, scopeDerivation: deriveKind }; } }] };
  const installerToken = secret(), localAuth = { stateDirectory: join(root, 'safety'), installerToken, now: () => configured === 'startup' ? Date.now() : now };
  let app = createLifestreamServer({ config, localAuth, ...(configured === 'startup' ? {} : { canonicalCapabilities: configured ? composition : null }) }); await app.start();
  const port = app.address().port, base = `http://127.0.0.1:${port}`, headers: Record<string, string> = { origin: base, 'content-type': 'application/json' };
  const send = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const session = await send('/api/auth/v1/setup', { username: 'owner', password: secret(), installerToken }); assert.equal(session.status, 201, JSON.stringify(session.body));
  headers.cookie = session.cookie!; headers['x-lifestream-csrf'] = session.body.session.csrfToken;
  const assistant = await send('/api/admin/v1/assistants', { displayName: 'Synthetic prepared capability' }); assert.equal(assistant.status, 201);
  const endpoint = await send('/api/runtime/v1/session-context', { expectedRevision: 0, mode: 'text', audienceScope: 'authenticatedSession' }); assert.equal(endpoint.status, 200);
  const db = new Database({ path: config.storage.databasePath });
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const path = `/api/authority/v1/assistants/${assistant.body.assistantId}/tools/synthetic.echo/prepare`;
  const body = () => ({ idempotencyKey: randomUUID(), capabilityVersion: '1.0.0', input: { target: 'synthetic:one', text: 'Some synthetic text' }, requestedClass: 'allowOnce', grantExpiresAt: new Date(now + 90_000).toISOString(), reviewAfter: null, expiresAt: new Date(now + 45_000).toISOString(), untrustedRationale: null });
  const create = async (prepared: any) => { const { environmentId: _environment, sideEffectClass: _effect, ...payload } = prepared.request; return send('/api/authority/v1/requests', envelope(payload)); };
  const approve = async (request: any) => send(`/api/authority/v1/requests/${request.requestId}/approve`, envelope({ requestId: request.requestId, expectedRevision: request.revision, confirmationDigest: request.confirmationDigest, grantClass: request.requestedClass, expiresAt: request.grantExpiresAt, reviewAfter: request.reviewAfter }));
  return { send, db, path, body, create, approve,
    lastInvocation: () => lastInvocation, lastStatusRequest: () => lastStatusRequest,
    statusMode(mode: string) { statusMode = mode; }, counters: () => ({ invoke: calls, catalog: catalogCalls, evaluate: evaluationCalls, status: statusCalls }),
    blockStatus() { let release!: () => void; const started = new Promise<void>(resolve => { statusEntered = resolve; }); statusWait = new Promise<void>(resolve => { release = resolve; }); t.after(() => release()); return { started, release }; },
    invocationMode(mode: string) { invokeMode = mode; }, governanceMode(mode: string) { governanceMode = mode; },
    materialChange() { materialChanged = true; for (const snapshot of snapshots.values()) snapshot.capabilities[0].providerRouteRef = 'changed:route'; },
    blockInvocation() { let release!: () => void; const started = new Promise<void>(resolve => { invoked = resolve; }); invokeWait = new Promise<void>(resolve => { release = resolve; }); return { started, release }; },
    calls: () => calls, headers, composition,
    changeProvider() { config.providers.capability = 'unavailable'; },
    advance(ms: number) { now += ms; }, denySchemas() { allowed = false; }, changeCatalog() { variant++; }, inputBoundOnly() { deriveKind = 'inputBoundOnly'; },
    block() { let release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); wait = new Promise<void>(resolve => { release = resolve; }); return { started, release }; },
    async restart() { await app.shutdown(); app = createLifestreamServer({ config, localAuth, port, ...(configured === 'startup' ? {} : { canonicalCapabilities: configured ? composition : null }) }); await app.start(); }
  };
}
export const prepared = async (f: Awaited<ReturnType<typeof setup>>, body = f.body()) => { const result = await f.send(f.path, body); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.preparation; };

export async function ready(t: Parameters<typeof setup>[0], grantClass = 'allowOnce', shortExpiry: 'request' | 'grant' | null = null) {
  const f = await setup(t), input = { ...f.body(), requestedClass: grantClass };
  const now = Date.parse(input.expiresAt) - 45000;
  if (shortExpiry) input.expiresAt = new Date(now + 1000).toISOString();
  if (shortExpiry === 'grant') input.grantExpiresAt = new Date(now + 1000).toISOString();
  const p = await prepared(f, input);
  const created = await f.create(p); assert.equal(created.status, 201, JSON.stringify(created.body));
  const approved = await f.approve(created.body.result); assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const grant = approved.body.result.grant;
  const path = f.path.replace('synthetic.echo/prepare', `invocations/${p.request.invocationId}`);
  const command = { grantId: grant.grantId, idempotencyKey: input.idempotencyKey };
  const dispatch = () => f.send(path + '/dispatch', command);
  const revoke = () => f.send(`/api/authority/v1/grants/${grant.grantId}/revoke`, envelope({ grantId: grant.grantId, expectedRevision: grant.revision, reason: { code: 'synthetic_revoke', summary: 'Synthetic revocation' } }));
  return { ...f, p, input, grant, path, command, dispatch, revoke };
}
