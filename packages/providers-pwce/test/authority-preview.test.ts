import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createContractValidator } from '@lifestream/contracts';
import { canonicalJson } from '@lifestream/runtime/capabilities/schema-validation';
import { PwceAuthorityPreview, pwceLightOperation } from '../src/authority-preview.ts';
import { PWCE_LIGHT_CAPABILITY_ID } from '../src/capability-catalog.ts';
import { PwceTransportError } from '../src/transport.ts';
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const validator = createContractValidator();
function fixture(capacity = 256) {
  const scope = { assistantId: randomUUID(), endpointId: randomUUID(), sessionId: randomUUID(), environmentId: randomUUID(), conversationId: randomUUID(), interactionTraceId: null, authorityContextRef: { providerRef: 'pwce.synthetic', contextId: randomUUID(), revision: 1 } };
  const binding = { authorityContextRef: randomUUID(), principalRef: 'agent.synthetic', siteRefs: ['home.one'], worldRef: 'world.personal.v1', executionEnvironmentRef: 'test', identity: { assistantRef: 'assistant.synthetic', endpointRef: 'endpoint.synthetic', participantRefs: ['participant.synthetic'], audienceRef: 'audience.synthetic' } };
  const prepared = { input: { siteRef: 'home.one', targetEntityId: 'light.synthetic', parameters: { level: 0.5 } }, approval: { required: false, reference: null } };
  const catalogRecord = { scope, binding, snapshot: { snapshotId: randomUUID(), revision: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), capabilities: [{ capabilityId: PWCE_LIGHT_CAPABILITY_ID }] }, executionMode: 'normal', producerSnapshotRef: randomUUID(), producerRevision: 0, producerDigest: 'a'.repeat(64) };
  const state = { current: true, bound: true, revalidations: 0, hook: async (_phase) => {}, response: { outcome: 'allowed', capabilityRef: 'home.light.set_level', effectClass: 'reversible', rationaleCodes: ['explicit_grant_active'], requirements: [], limitations: [] } }, sent = [];
  const catalog = { retained: (id, candidate) => state.bound && id === catalogRecord.snapshot.snapshotId && isSame(candidate, scope) ? structuredClone(catalogRecord) : undefined,
    revalidate: async () => { state.revalidations++; await state.hook('revalidate'); if (!state.bound) throw new PwceTransportError('snapshot_unavailable', 'snapshot unavailable'); return structuredClone(catalogRecord); } };
  const client = { request: async request => { sent.push(structuredClone(request)); await state.hook('request'); return { profileId: 'pwce-agent-gateway.v1', profileVersion: '1.0.0', requestId: request.requestId, correlationId: request.correlationId, worldRef: request.worldRef, executionEnvironmentRef: request.executionEnvironmentRef, ...structuredClone(state.response) }; } };
  const preview = new PwceAuthorityPreview({ providerRef: 'pwce.synthetic', client, catalog, capacity, resolve: async () => { await state.hook('resolve'); return prepared; }, isCurrent: () => state.current });
  const request = () => ({ schemaVersion: '1.0.0', operation: 'AuthorityProvider.evaluate', requestId: randomUUID(), correlationId: randomUUID(), cancellationId: randomUUID(), deadlineAt: new Date(Date.now() + 5000).toISOString(), executionMode: 'normal', scope: structuredClone(scope), idempotencyKey: null, payload: { grantId: null, invocationId: randomUUID(), inputDigest: digest(prepared.input), snapshotId: catalogRecord.snapshot.snapshotId, snapshotRevision: 1, scope: pwceLightOperation(prepared.input, binding.worldRef) } });
  const context = { signal: new AbortController().signal, isCurrent: () => state.current };
  return { preview, prepared, catalogRecord, binding, state, sent, request, context };
}
const isSame = (a,b) => canonicalJson(a) === canonicalJson(b);

test('canonical external preview binds exact input, operation and foreign identities without dispatch', async () => {
  const f = fixture(), request = f.request(), result = await f.preview.evaluate(request, f.context), decision = result.outcome.payload;
  assert.ok(validator.validate('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/AuthorityResult', result).valid);
  assert.equal(decision.authorityKind, 'external'); assert.equal(decision.kind, 'preview'); assert.equal(decision.admittedAt, null); assert.equal(decision.disposition, 'authorized');
  assert.equal(decision.inputDigest, request.payload.inputDigest); assert.equal(decision.scopeDigest, digest(request.payload.scope));
  assert.equal(f.state.revalidations, 2); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].operation, 'authority.evaluate'); assert.equal(f.sent[0].capabilityOperation, 'light.set_level');
  assert.equal(f.sent[0].authorityContextRef, f.binding.authorityContextRef); assert.equal(f.sent[0].snapshotRef, f.catalogRecord.producerSnapshotRef);
  assert.deepEqual(f.sent[0].parameters, f.prepared.input.parameters); assert.deepEqual(f.sent[0].participantRefs, f.binding.identity.participantRefs);
  const evidence = await f.preview.readEvidence(decision.evidenceRef, request, f.context);
  assert.equal(createHash('sha256').update(evidence).digest('hex'), decision.evidenceRef.sha256); assert.equal(evidence.length, decision.evidenceRef.byteLength);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(evidence)).rationaleCodes, ['explicit_grant_active']);
  evidence[0] = 0; assert.notEqual((await f.preview.readEvidence(decision.evidenceRef, request, f.context))[0], 0);
});

test('producer denial and approval requirements remain distinct successful preview observations', async () => {
  for (const [outcome, expected] of [['denied','denied'],['approval_required','approvalRequired']]) {
    const f = fixture(); f.state.response = { outcome, rationaleCodes: ['synthetic_reason'], requirements: outcome === 'approval_required' ? ['runtime_human_approval'] : [], limitations: [] };
    const result = await f.preview.evaluate(f.request(), f.context);
    assert.equal(result.outcome.status, 'succeeded'); assert.equal(result.outcome.payload.disposition, expected); assert.equal(result.outcome.payload.admittedAt, null);
  }
});

test('foreign tuple qualification distinguishes sites and Worlds while validating actual arguments', () => {
  const f = fixture(), one = pwceLightOperation(f.prepared.input, 'world.one'), two = pwceLightOperation(f.prepared.input, 'world.two');
  assert.notDeepEqual(one.targetRefs, two.targetRefs); assert.notDeepEqual(one.dataScopeRefs, two.dataScopeRefs);
  assert.notDeepEqual(one.targetRefs, pwceLightOperation({...f.prepared.input,siteRef:'home.two'},'world.one').targetRefs);
  for (const patch of [{parameters:{level:2}},{parameters:{level:NaN}},{parameters:{level:0.5,extra:true}},{siteRef:'*'},{targetEntityId:''},{extra:true}]) assert.throws(() => pwceLightOperation({...f.prepared.input,...patch},'world.one'), {code:'invalid_input'});
});

test('wrong digest, operation, snapshot revision, mode or local grant never reaches preview I/O', async () => {
  for (const change of [ r=>r.payload.inputDigest='0'.repeat(64), r=>r.payload.scope.targetRefs=['another.target'], r=>r.payload.snapshotRevision=2, r=>r.executionMode='replay', r=>r.payload.grantId=randomUUID() ]) {
    const f = fixture(), request = f.request(); change(request);
    await assert.rejects(f.preview.evaluate(request, f.context)); assert.equal(f.sent.length,0);
  }
  const f = fixture(); f.binding.siteRefs=['home.two'];
  await assert.rejects(f.preview.evaluate(f.request(), f.context), {code:'preparation_mismatch'}); assert.equal(f.sent.length,0);
});

test('mandatory approval cannot be downgraded by a live binding or an inconsistent producer reply', async () => {
  const live = fixture(); live.binding.executionEnvironmentRef='live';
  await assert.rejects(live.preview.evaluate(live.request(),live.context),{code:'preparation_mismatch'}); assert.equal(live.sent.length,0);
  const f = fixture(); f.prepared.approval.required=true;
  await assert.rejects(f.preview.evaluate(f.request(),f.context),{code:'invalid_decision'});
});

test('malformed or scope-mismatched replies do not become external decisions', async () => {
  for (const patch of [{outcome:'succeeded'},{rationaleCodes:[]},{requirements:['unknown']},{extra:true},{capabilityRef:'another.capability'},{effectClass:'none'},{worldRef:'other.world'},{requestId:randomUUID()},{limitations:['x'.repeat(501)]}]) {
    const f=fixture(); Object.assign(f.state.response,patch); await assert.rejects(f.preview.evaluate(f.request(),f.context));
  }
});

test('scope withdrawal after each await prevents a retained preview', async () => {
  for (const phase of ['resolve','revalidate','request']) {
    const f=fixture(); f.state.hook=async current=>{if(current===phase)f.state.current=false;};
    await assert.rejects(f.preview.evaluate(f.request(),f.context),{code:'scope_changed'});
  }
  const f=fixture(); f.state.hook=async phase=>{if(phase==='request')f.state.bound=false;};
  await assert.rejects(f.preview.evaluate(f.request(),f.context),{code:'snapshot_unavailable'});
});

test('evidence reads require matching original identity, metadata and current producer custody', async () => {
  const f=fixture(),request=f.request(),result=await f.preview.evaluate(request,f.context),reference=result.outcome.payload.evidenceRef;
  for(const change of [r=>r.payload.invocationId=randomUUID(),r=>r.scope.sessionId=randomUUID(),r=>r.correlationId=randomUUID(),r=>r.payload.inputDigest='0'.repeat(64)]) {
    const other=structuredClone(request);change(other);await assert.rejects(f.preview.readEvidence(reference,other,f.context),{code:'evidence_unavailable'});
  }
  await assert.rejects(f.preview.readEvidence({...reference,sha256:'0'.repeat(64)},request,f.context),{code:'evidence_unavailable'});
  f.state.bound=false;await assert.rejects(f.preview.readEvidence(reference,request,f.context),{code:'snapshot_unavailable'});
});

test('concurrent requests cannot overfill evidence custody or discard the original decision', async () => {
  const f=fixture(1),requests=[f.request(),f.request()],results=await Promise.allSettled(requests.map(r=>f.preview.evaluate(r,f.context)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const index=results.findIndex(r=>r.status==='fulfilled'),result=results[index].value;
  assert.ok(await f.preview.readEvidence(result.outcome.payload.evidenceRef,requests[index],f.context));
  await assert.rejects(f.preview.evaluate(f.request(),f.context),{code:'decision_capacity'});
});

test('caller mutation cannot replace input or scope after resolution begins', async () => {
  const f=fixture(),request=f.request(),original=structuredClone(request);let release;
  const gate=new Promise(resolve=>{release=resolve;});f.state.hook=async phase=>{if(phase==='resolve')await gate;};
  const pending=f.preview.evaluate(request,f.context);request.scope.sessionId=randomUUID();request.payload.inputDigest='0'.repeat(64);release();
  const result=await pending;assert.equal(result.outcome.payload.inputDigest,original.payload.inputDigest);assert.deepEqual(result.outcome.payload.scope,original.scope);
});

test('cancellation and a resolver ignoring the deadline remain bounded without preview I/O', async () => {
  const f=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(f.preview.evaluate(f.request(),{...f.context,signal:controller.signal}),{code:'cancelled'});
  f.state.hook=async()=>new Promise(()=>{});const request=f.request();request.deadlineAt=new Date(Date.now()+40).toISOString();
  await assert.rejects(f.preview.evaluate(request,f.context),{code:'deadline_exceeded'});assert.equal(f.sent.length,0);
});
