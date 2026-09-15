import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createContractValidator } from '@lifestream/contracts';
import { PwceCapabilityCatalog, PWCE_LIGHT_CAPABILITY_ID } from '../src/capability-catalog.ts';
import { EXPECTED_PWCE_CAPABILITY_BUNDLE as bundle } from '../src/capability-bundle.ts';
import { PwceGatewayClient, EXPECTED_PWCE_PROFILE, EXPECTED_PWCE_ARTIFACTS, EXPECTED_PWCE_GENERATED_CLIENT_SHA256 } from '../src/client.ts';
const validator = createContractValidator(), descriptor = bundle.capabilities[0];
function fixture(capacity = 256) {
  const scope = { assistantId: randomUUID(), endpointId: randomUUID(), sessionId: randomUUID(), environmentId: randomUUID(), conversationId: randomUUID(), interactionTraceId: null, authorityContextRef: { providerRef: 'pwce.synthetic', contextId: randomUUID(), revision: 1 } };
  const binding = { authorityContextRef: randomUUID(), principalRef: 'agent.synthetic', siteRefs: ['home.one'], worldRef: 'world.personal.v1', executionEnvironmentRef: 'test', identity: { assistantRef: 'assistant.synthetic', endpointRef: 'endpoint.synthetic', participantRefs: ['participant.synthetic'], audienceRef: 'audience.synthetic' } };
  const body = { snapshotRef: randomUUID(), principalRef: binding.principalRef, siteRefs: binding.siteRefs, sourceRevision: 0, invalidationSequence: 0, issuedAt: new Date(Date.now() - 100).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilities: [{ ...descriptor, available: true, authorization: 'grant_required' }], availability: 'configured', limitations: [] };
  const sent = [], state = { localCurrent: true, boundCurrent: true, schemaReads: 0, hook: async (_phase) => {} };
  const client = {
    capabilityContracts: async () => { await state.hook('contracts'); return bundle; },
    request: async request => { sent.push(structuredClone(request)); await state.hook('snapshot'); return { profileId: 'pwce-agent-gateway.v1', profileVersion: '1.0.0', requestId: request.requestId, correlationId: request.correlationId, worldRef: request.worldRef, executionEnvironmentRef: request.executionEnvironmentRef, ...structuredClone(body) }; },
    capabilitySchema: async () => { state.schemaReads++; await state.hook('schema'); return new Uint8Array([1,2,3]); }
  };
  const catalog = new PwceCapabilityCatalog({ providerRef: 'pwce.synthetic', client, capacity, resolve: async () => { await state.hook('resolve'); return binding; }, isCurrent: () => state.boundCurrent });
  const request = () => ({ schemaVersion: '1.0.0', operation: 'CapabilityProvider.getSnapshot', requestId: randomUUID(), correlationId: randomUUID(), deadlineAt: new Date(Date.now() + 5000).toISOString(), cancellationId: randomUUID(), executionMode: 'normal', scope: structuredClone(scope), idempotencyKey: null, payload: { requestedCapabilityIds: [] } });
  const context = { signal: new AbortController().signal, isCurrent: () => state.localCurrent };
  const schemaScope = { assistantId: scope.assistantId, endpointId: scope.endpointId, sessionId: scope.sessionId, environment: scope.environmentId, authorityContextRef: scope.authorityContextRef };
  const schemaContext = () => ({ requestId: randomUUID(), correlationId: randomUUID(), deadlineAt: new Date(Date.now() + 5000).toISOString(), executionMode: 'live', signal: context.signal, isCurrent: () => state.localCurrent });
  return { catalog, scope, binding, body, sent, state, request, context, schemaScope, schemaContext };
}

test('projects a valid canonical catalog while preserving actual producer identity and revision zero', async () => {
  const f = fixture(), request = f.request(), result = await f.catalog.getSnapshot(request, f.context);
  assert.ok(validator.validate('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/CapabilitySnapshotResult', result).valid);
  const snapshot = result.outcome.payload, retained = f.catalog.retained(snapshot.snapshotId, f.scope);
  assert.equal(snapshot.capabilities[0].capabilityId, PWCE_LIGHT_CAPABILITY_ID);
  assert.equal(snapshot.capabilities[0].authorization, 'invokeDecision');
  assert.equal(snapshot.capabilities[0].providerRouteRef, 'pwce:home.light.set_level');
  assert.equal(retained.producerSnapshotRef, f.body.snapshotRef); assert.equal(retained.producerRevision, 0);
  assert.equal(snapshot.revision, 1); assert.notEqual(snapshot.snapshotId, f.body.snapshotRef);
  assert.equal(f.sent[0].authorityContextRef, f.binding.authorityContextRef);
  assert.deepEqual(f.sent[0].participantRefs, f.binding.identity.participantRefs);
  snapshot.capabilities.length = 0; retained.binding.siteRefs.length = 0;
  assert.equal(f.catalog.retained(snapshot.snapshotId, f.scope).snapshot.capabilities.length, 1);
  assert.deepEqual(f.catalog.retained(snapshot.snapshotId, f.scope).binding.siteRefs, ['home.one']);
});

test('repeated and filtered projections have stable, distinct identities and cannot cross sessions', async () => {
  const f = fixture(), full = (await f.catalog.getSnapshot(f.request(), f.context)).outcome.payload;
  assert.equal((await f.catalog.getSnapshot(f.request(), f.context)).outcome.payload.snapshotId, full.snapshotId);
  const request = f.request(); request.payload.requestedCapabilityIds = ['other.synthetic'];
  const filtered = (await f.catalog.getSnapshot(request, f.context)).outcome.payload;
  assert.notEqual(filtered.snapshotId, full.snapshotId); assert.deepEqual(filtered.capabilities, []);
  assert.equal(f.catalog.retained(full.snapshotId, { ...f.scope, sessionId: randomUUID() }), undefined);
  f.state.boundCurrent = false; assert.equal(f.catalog.retained(full.snapshotId, f.scope), undefined);
});

test('unsupported, unscoped or malformed producer definitions never become local capabilities', async () => {
  for (const patch of [ { capabilities: [{ ...descriptor, available: true, authorization: 'none' }] }, { capabilities: [{ ...descriptor, available: true, authorization: 'grant_required', unknown: true }] }, { principalRef: 'other' }, { siteRefs: ['home.two'] }, { sourceRevision: -1 }, { invalidationSequence: 1 }, { snapshotRef: 'not-a-uuid' }, { expiresAt: new Date(0).toISOString() }, { extra: true } ]) {
    const f = fixture(); Object.assign(f.body, patch);
    await assert.rejects(f.catalog.getSnapshot(f.request(), f.context));
    assert.equal(f.state.schemaReads, 0);
  }
  const absent = fixture(); absent.body.availability = 'none'; absent.body.capabilities = [];
  assert.deepEqual((await absent.catalog.getSnapshot(absent.request(), absent.context)).outcome.payload.capabilities, []);
});

test('changed bytes under an existing producer snapshot poison custody without falling back to old success', async () => {
  const f = fixture(), snapshot = (await f.catalog.getSnapshot(f.request(), f.context)).outcome.payload;
  f.body.limitations = ['Changed retained record'];
  await assert.rejects(f.catalog.getSnapshot(f.request(), f.context), { code: 'snapshot_identity_changed' });
  f.body.limitations = [];
  await assert.rejects(f.catalog.getSnapshot(f.request(), f.context), { code: 'snapshot_identity_changed' });
  assert.equal(f.catalog.retained(snapshot.snapshotId, f.scope), undefined);
  await assert.rejects(f.catalog.schemas.read(descriptor.inputSchemaArtifact, f.schemaScope, f.schemaContext()), { code: 'snapshot_identity_changed' });
});

test('live, replay and simulation bindings remain distinct before any producer read', async () => {
  for (const [mode, environment] of [['normal','replay'],['normal','simulation'],['normal','dry-run'],['replay','test'],['simulation','live']]) {
    const f = fixture(), request = f.request(); request.executionMode = mode; f.binding.executionEnvironmentRef = environment;
    await assert.rejects(f.catalog.getSnapshot(request, f.context), { code: 'execution_mode_mismatch' }); assert.equal(f.sent.length, 0);
  }
  const f = fixture(); await f.catalog.getSnapshot(f.request(), f.context);
  assert.equal(await f.catalog.schemas.read(descriptor.inputSchemaArtifact, f.schemaScope, { ...f.schemaContext(), executionMode: 'replay' }), undefined);
});

test('scope withdrawal at every asynchronous catalog boundary prevents retention', async () => {
  for (const phase of ['resolve','contracts','snapshot']) {
    const f = fixture(); f.state.hook = async current => { if (current === phase) f.state.boundCurrent = false; };
    await assert.rejects(f.catalog.getSnapshot(f.request(), f.context), { code: 'scope_changed' });
    f.state.boundCurrent = true;
    assert.equal(await f.catalog.schemas.read(descriptor.inputSchemaArtifact, f.schemaScope, f.schemaContext()), undefined);
  }
});

test('caller mutation during resolution cannot replace the admitted local scope or requested filter', async () => {
  const f = fixture(), request = f.request();
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.state.hook = async phase => { if (phase === 'resolve') await gate; };
  const original = structuredClone(request), pending = f.catalog.getSnapshot(request, f.context);
  request.scope.sessionId = randomUUID(); request.payload.requestedCapabilityIds = ['other.synthetic']; release();
  const result = await pending;
  assert.equal(result.outcome.payload.sessionId, original.scope.sessionId);
  assert.equal(result.outcome.payload.capabilities.length, 1);
});

test('malformed local requests and host bindings stop before contacting the producer', async () => {
  for (const patch of [{ authorityContextRef: 'not-a-context' }, { siteRefs: ['home.one','home.one'] }, { principalRef: null }, { extra: true }, { identity: { assistantRef: null } }]) {
    const f = fixture(); Object.assign(f.binding, patch);
    await assert.rejects(f.catalog.getSnapshot(f.request(), f.context), { code: 'invalid_binding' }); assert.equal(f.sent.length, 0);
  }
  const f = fixture(), request = f.request(); request.payload.requestedCapabilityIds = ['contains_underscore'];
  await assert.rejects(f.catalog.getSnapshot(request, f.context), { code: 'invalid_request' }); assert.equal(f.sent.length, 0);
});

test('schema reads revalidate the original snapshot and reject unknown references or wrong owners', async () => {
  const f = fixture(); await f.catalog.getSnapshot(f.request(), f.context);
  const bytes = await f.catalog.schemas.read(descriptor.inputSchemaArtifact, f.schemaScope, f.schemaContext());
  assert.deepEqual(bytes, new Uint8Array([1,2,3])); assert.equal(f.sent.at(-1).snapshotRef, f.body.snapshotRef);
  const reads = f.sent.length;
  assert.equal(await f.catalog.schemas.read({ ...descriptor.inputSchemaArtifact, reference: 'https://untrusted.invalid/schema' }, f.schemaScope, f.schemaContext()), undefined);
  assert.equal(await f.catalog.schemas.read(descriptor.inputSchemaArtifact, { ...f.schemaScope, sessionId: randomUUID() }, f.schemaContext()), undefined);
  assert.equal(f.sent.length, reads);
});

test('changed snapshot or scope during schema access cannot release bytes', async () => {
  const changed = fixture(); await changed.catalog.getSnapshot(changed.request(), changed.context); changed.body.limitations = ['changed'];
  await assert.rejects(changed.catalog.schemas.read(descriptor.inputSchemaArtifact, changed.schemaScope, changed.schemaContext()), { code: 'snapshot_identity_changed' });
  assert.equal(changed.state.schemaReads, 0);
  for (const phase of ['snapshot','schema']) {
    const f = fixture(); await f.catalog.getSnapshot(f.request(), f.context);
    f.state.hook = async current => { if (current === phase) f.state.localCurrent = false; };
    await assert.rejects(f.catalog.schemas.read(descriptor.inputSchemaArtifact, f.schemaScope, f.schemaContext()), { code: 'scope_changed' });
  }
});

test('bounded capacity preserves original projections and rejects additional entries', async () => {
  const f = fixture(1), snapshot = (await f.catalog.getSnapshot(f.request(), f.context)).outcome.payload;
  const filtered = f.request(); filtered.payload.requestedCapabilityIds = ['other.synthetic'];
  await assert.rejects(f.catalog.getSnapshot(filtered, f.context), { code: 'catalog_capacity' });
  assert.ok(f.catalog.retained(snapshot.snapshotId, f.scope));
  f.body.snapshotRef = randomUUID();
  await assert.rejects(f.catalog.getSnapshot(f.request(), f.context), { code: 'catalog_capacity' });
});

test('explicit revalidation preserves the original snapshot and rejects changed revision, mode or source bytes', async () => {
  const f = fixture(), first = (await f.catalog.getSnapshot(f.request(), f.context)).outcome.payload;
  const request = { ...f.request(), payload: { snapshotId: first.snapshotId, snapshotRevision: first.revision } };
  const original = await f.catalog.revalidate(request, f.context);
  assert.equal(original.producerSnapshotRef, f.body.snapshotRef); assert.equal(f.sent.at(-1).snapshotRef, f.body.snapshotRef);
  const count = f.sent.length;
  await assert.rejects(f.catalog.revalidate({ ...request, payload: { ...request.payload, snapshotRevision: 2 } }, f.context), {code:'snapshot_unavailable'});
  await assert.rejects(f.catalog.revalidate({ ...request, executionMode: 'replay' }, f.context), {code:'snapshot_unavailable'});
  assert.equal(f.sent.length, count);
  f.body.limitations = ['Changed source'];
  await assert.rejects(f.catalog.revalidate(request, f.context), {code:'snapshot_identity_changed'});
  f.body.limitations = [];
  await assert.rejects(f.catalog.revalidate(request, f.context), {code:'snapshot_unavailable'});
});

test('cancellation, invalid deadlines and a resolver ignoring cancellation stay bounded', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.catalog.getSnapshot(f.request(), { ...f.context, signal: controller.signal }), { code: 'cancelled' });
  for (const offset of [-1000, 60_000]) {
    const request = f.request(); request.deadlineAt = new Date(Date.now() + offset).toISOString();
    await assert.rejects(f.catalog.getSnapshot(request, f.context));
  }
  f.state.hook = async () => new Promise(() => {});
  const request = f.request(); request.deadlineAt = new Date(Date.now() + 40).toISOString();
  await assert.rejects(f.catalog.getSnapshot(request, f.context), { code: 'deadline_exceeded' }); assert.equal(f.sent.length, 0);
});

function transport(overrides = {}) {
  const sent = [], operations = ['context.getPreparedInputs','context.query','evidence.get','events.subscribe','authority.evaluate','authority.authorizeDispatch','authority.getGrants','capabilities.getSnapshot','capabilities.invoke','capabilities.getInvocation','trace.publish','health.get'];
  const client = new PwceGatewayClient({ baseUrl: 'http://synthetic.invalid', token: 'synthetic-agent', fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname; sent.push({path,init});
    const result = path.endsWith('/profile') ? { ...EXPECTED_PWCE_PROFILE, schemaStatus: 'published', operationCatalog: operations.map(operation => ({operation})) } : path.endsWith('/bundle') ? { bundleId: EXPECTED_PWCE_PROFILE.bundleId, bundleVersion: EXPECTED_PWCE_PROFILE.bundleVersion, bundleDigest: EXPECTED_PWCE_PROFILE.schemaDigest, artifacts: EXPECTED_PWCE_ARTIFACTS, generatedClient: { path: 'src/gateway/generated-client.js', sha256: EXPECTED_PWCE_GENERATED_CLIENT_SHA256 } } : path.endsWith('/capability-contracts') ? overrides.bundle ?? bundle : overrides.artifact ?? { artifact: descriptor.inputSchemaArtifact, schemaJson: '{}' };
    return new Response(JSON.stringify(result));
  } });
  return {client,sent};
}

test('schema transport rejects changed published contracts before fetching bytes', async () => {
  const f = transport({bundle: {...bundle, bundleDigest:'0'.repeat(64)}});
  await assert.rejects(f.client.capabilitySchema(descriptor.inputSchemaArtifact), /incompatible/);
  assert.equal(f.sent.some(value => value.path.endsWith(descriptor.inputSchemaArtifact.sha256)), false);
  const unknown = transport();
  await assert.rejects(unknown.client.capabilitySchema({...descriptor.inputSchemaArtifact, reference:'https://other.invalid'}), /not pinned/);
  assert.equal(unknown.sent.length, 0);
});

test('schema transport rejects tampered bytes or artifact metadata and never sends dispatcher credentials', async () => {
  for (const artifact of [ { artifact: descriptor.inputSchemaArtifact, schemaJson: '{}' }, { artifact: { ...descriptor.inputSchemaArtifact, byteLength: 2 }, schemaJson: '{}' }, { artifact: descriptor.inputSchemaArtifact, schemaJson: '{}', extra: true } ]) {
    const f = transport({artifact}); await assert.rejects(f.client.capabilitySchema(descriptor.inputSchemaArtifact), /differ|incompatible/);
    for (const {init} of f.sent) { assert.equal(new Headers(init.headers).get('x-pwce-dispatcher-token'), null); assert.equal(init.redirect, 'error'); }
  }
});
