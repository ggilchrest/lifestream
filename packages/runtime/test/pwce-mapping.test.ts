import assert from "node:assert/strict"; import { test } from "node:test"; import { mapPwceSlice } from "../src/context/pwce-mapping.ts";
const base = { worldRef: "world", environmentRef: "pwce-env", siteRefs: ["site"], authorityContextRef: "authority", sourceRevision: "7", asOf: "2026-09-07T00:00:00Z", limitations: [] as string[] };
test("maps qualified PWCE context without flattening knowledge state or references", () => { const result = mapPwceSlice({ ...base, items: [{ itemRef: "obs-1", property: "temperature", value: 21, knowledgeState: "stale", basis: "observed", sourceRevision: "7", evidenceRefs: ["evidence-1"], limitations: ["stale"] }] }); assert.equal(result.profileId, "lifestream-pwce.v1"); assert.equal(result.items[0]?.knowledgeState, "stale"); assert.deepEqual(result.items[0]?.evidenceRefs, ["evidence-1"]); });
test("rejects an unbound slice instead of inventing authority or source identity", () => { assert.throws(() => mapPwceSlice({ ...base, authorityContextRef: "", items: [] }), /binding/); });

import { mapPwceContextResponse, mapPwceEvidenceResponse, PwceMappingError } from '../src/context/pwce-mapping.ts';
const when = '2026-09-15T00:00:00Z';
const request = { worldRef: 'world.fixture', executionEnvironmentRef: 'replay' as const, siteRefs: ['home.one'], authorityContextRef: 'authority.fixture', authorityExpiresAt: '2026-09-15T00:05:00Z', requestId: 'request.fixture', correlationId: 'correlation.fixture', now: Date.parse(when), subjectRef: 'home.one::sensor.flag', property: 'state' };
const wire = { profileId: 'pwce-agent-gateway.v1', profileVersion: '1.0.0', worldRef: request.worldRef, executionEnvironmentRef: request.executionEnvironmentRef, requestId: request.requestId, correlationId: request.correlationId, siteRef: 'home.one', entityRef: request.subjectRef, property: request.property, sourceRevision: 'material.fixture', evaluatedAt: when, invalidationCursor: '12', knowledgeState: 'current', basis: 'observed', evidenceRefs: ['observation.fixture'], limitations: [], value: false, eventTime: when, recordedAt: when, sourceRef: 'source.fixture', freshnessMs: 1000, freshnessState: 'current', quality: 'nominal', revision: 2 };
function error(code: string) { return (failure: unknown) => failure instanceof PwceMappingError && failure.code === code; }

test('actual response mapping binds request identity and preserves false, missing and null distinctly', () => {
  for (const value of [false, null, 0, '']) {
    const result = mapPwceContextResponse({ ...wire, value }, { ...request, mode: 'current' });
    assert.equal(result.items[0]?.value, value); assert.equal(Object.hasOwn(result.items[0]!, 'value'), true);
    assert.equal(result.environmentRef, 'replay'); assert.equal(result.authorityContextRef, request.authorityContextRef);
    assert.equal(result.items[0]?.projectionRevision, '2'); assert.equal(result.sourceRevision, 'material.fixture');
  }
  const withheld = { ...wire, knowledgeState: 'stale', freshnessAccepted: false } as Record<string, unknown>; delete withheld.value;
  const result = mapPwceContextResponse(withheld, { ...request, mode: 'current' });
  assert.equal(Object.hasOwn(result.items[0]!, 'value'), false); assert.equal(result.items[0]?.freshnessAccepted, false);
});

test('all qualified knowledge states survive without becoming a boolean or current fact', () => {
  for (const state of ['current', 'stale', 'unknown', 'unavailable', 'notDetected']) {
    const result = mapPwceContextResponse({ ...wire, knowledgeState: state }, { ...request, mode: 'current' });
    assert.equal(result.items[0]?.knowledgeState, state);
  }
  assert.throws(() => mapPwceContextResponse({ ...wire, knowledgeState: 'known' }, { ...request, mode: 'current' }), error('invalid_response'));
});

test('prepared inputs retain old conflicts, evidence, timestamps and source qualification', () => {
  const contradictions = [{ observationRef: 'observation.fixture', sourceRef: 'source.fixture', eventTime: when, value: false }, { observationRef: 'observation.other', sourceRef: 'source.other', eventTime: when, value: true }];
  const raw = { ...wire, revision: wire.sourceRevision, inputs: [{ ...wire, knowledgeState: 'conflicted', freshnessState: 'stale', ageMs: 10000, contradictions, evidenceRefs: contradictions.map(item => item.observationRef) }], sources: [{ sourceRef: 'source.fixture', status: 'offline', lastStatusReason: 'disconnected', lastEventTime: when }] };
  const result = mapPwceContextResponse(raw, { ...request, mode: 'prepared' });
  assert.equal(result.items[0]?.knowledgeState, 'conflicted'); assert.equal(result.items[0]?.freshnessState, 'stale');
  assert.equal(result.items[0]?.recordedAt, when); assert.equal(result.items[0]?.ageMs, 10000);
  assert.deepEqual(result.items[0]?.contradictions?.map(item => item.value), [false, true]);
  assert.equal(result.sources[0]?.status, 'offline'); assert.equal(result.invalidationCursor, '12');
  raw.inputs[0]!.contradictions[0]!.value = true; assert.equal(result.items[0]?.contradictions?.[0]?.value, false);
});

test('scope mismatches fail closed even for empty or unknown results', () => {
  for (const [field, value] of Object.entries({ profileId: 'other', profileVersion: '2.0.0', worldRef: 'world.other', executionEnvironmentRef: 'live', requestId: 'request.other', correlationId: 'correlation.other', authorityContextRef: 'authority.other', entityRef: 'home.one::other', property: 'other', siteRef: 'home.two' })) {
    assert.throws(() => mapPwceContextResponse({ ...wire, [field]: value }, { ...request, mode: 'current' }), error('scope_mismatch'), field);
  }
  assert.throws(() => mapPwceContextResponse({ ...wire, observations: [], entityRef: 'home.one::other', knowledgeState: 'unknown' }, { ...request, mode: 'history' }), error('scope_mismatch'));
  assert.throws(() => mapPwceContextResponse(wire, { ...request, mode: 'current', authorityExpiresAt: when }), error('authority_expired'));
});

test('multiple sites stay separate and nested foreign sites cannot hide behind an allowed envelope', () => {
  const items = [{ ...wire, siteRef: 'home.one' }, { ...wire, siteRef: 'home.two', entityRef: 'home.two::sensor.flag' }];
  const raw: Record<string, unknown> = { ...wire, items, siteRefs: ['home.one', 'home.two'] }; delete raw.siteRef; delete raw.entityRef;
  const scoped = { ...request, siteRefs: ['home.one', 'home.two'], subjectsBySite: { 'home.one': request.subjectRef, 'home.two': 'home.two::sensor.flag' }, mode: 'current' as const };
  const result = mapPwceContextResponse(raw, scoped);
  assert.deepEqual(result.items.map(item => item.siteRef), ['home.one', 'home.two']);
  assert.notEqual(result.items[0]?.subjectRef, result.items[1]?.subjectRef);
  items[1]!.siteRef = 'home.foreign';
  assert.throws(() => mapPwceContextResponse(raw, scoped), error('scope_mismatch'));
});

test('history and entity search stay separate from current world facts', () => {
  const observation = { observationRef: 'observation.fixture', value: false, eventTime: when, recordedAt: when, sourceRef: 'source.fixture', quality: 'nominal', freshnessMs: 1000 };
  const history = mapPwceContextResponse({ ...wire, observations: [observation], hasMore: true, nextCursor: 'opaque-cursor' }, { ...request, mode: 'history' });
  assert.equal(history.items.length, 0); assert.equal(history.history[0]?.knowledgeState, 'unknown');
  assert.equal(history.history[0]?.itemRef, observation.observationRef); assert.equal(history.history[0]?.value, false);
  assert.equal(history.nextCursor, 'opaque-cursor'); assert.equal(history.hasMore, true);
  const search = mapPwceContextResponse({ ...wire, matches: [{ entityRef: request.subjectRef, siteRef: 'home.one', displayName: 'Synthetic flag' }] }, { ...request, mode: 'search' });
  assert.equal(search.items.length, 0); assert.equal(search.matches[0]?.subjectRef, request.subjectRef);
});

test('as-of keeps the selected boundary distinct from its independent history page', () => {
  const selected = { observationRef: 'observation.fixture', value: false, eventTime: when, recordedAt: when, sourceRef: 'source.fixture' };
  const earlier = { ...selected, observationRef: 'observation.earlier', value: true, eventTime: '2026-09-14T00:00:00Z' };
  const result = mapPwceContextResponse({ ...wire, asOf: when, selected, observations: [earlier] }, { ...request, mode: 'asOf', asOf: when });
  assert.equal(result.items[0]?.value, false); assert.equal(result.history[0]?.value, true); assert.equal(result.queryMode, 'asOf'); assert.equal(result.asOf, when);
  assert.throws(() => mapPwceContextResponse({ ...wire, asOf: when, selected, observations: [] }, { ...request, mode: 'asOf', asOf: '2026-09-14T00:00:00Z' }), error('scope_mismatch'));
  assert.throws(() => mapPwceContextResponse({ ...wire, asOf: when, selected, knowledgeState: 'conflicted', observations: [] }, { ...request, mode: 'asOf', asOf: when }), error('invalid_response'));
});

test('malformed qualification, pagination and item or byte overflow cannot silently drop evidence', () => {
  for (const value of [{ ...wire, basis: 'guessed' }, { ...wire, eventTime: 'yesterday' }, { ...wire, eventTime: '2026-02-30T00:00:00Z' }, { ...wire, eventTime: '2026-09-15T00:00:00' }, { ...wire, confidence: 2 }, { ...wire, knowledgeState: 'conflicted', contradictions: [] }, { ...wire, invalidationCursor: 'broken' }, { ...wire, mediaRefs: ['unselected-media'] }]) {
    assert.throws(() => mapPwceContextResponse(value, { ...request, mode: 'current' }), error('invalid_response'));
  }
  const missingValue = { ...wire } as Record<string, unknown>; delete missingValue.value;
  assert.throws(() => mapPwceContextResponse(missingValue, { ...request, mode: 'current' }), error('invalid_response'));
  assert.throws(() => mapPwceContextResponse(wire, { ...request, mode: 'current', maxBytes: Buffer.byteLength(JSON.stringify(wire)) }), error('limit_exceeded'));
  assert.throws(() => mapPwceContextResponse({ ...wire, observations: [], hasMore: true }, { ...request, mode: 'history' }), error('invalid_response'));
  assert.throws(() => mapPwceContextResponse({ ...wire, revision: wire.sourceRevision, inputs: [wire, wire], sources: [] }, { ...request, mode: 'prepared', maxItems: 1 }), error('limit_exceeded'));
  assert.throws(() => mapPwceContextResponse({ ...wire, value: 'é'.repeat(131072) }, { ...request, mode: 'current' }), error('limit_exceeded'));
});

test('evidence mapping binds the exact requested reference and scope without claiming current state or verified integrity', () => {
  const integrity = { schemeId: 'sha256-jcs-v1', schemeVersion: '1.0.0', covers: 'envelope_without_integrity_value', value: 'synthetic-hash' };
  const record = { recordId: 'observation.fixture', recordKind: 'observation', sourceId: 'source.fixture', eventTime: when, recordedAt: when, integrity, payload: { siteRef: 'home.one', entityRef: request.subjectRef, property: 'state', value: false, quality: 'nominal', freshnessMs: 1000 } };
  const raw = { ...wire, status: 'known', evidence: record, integrity, transformationRefs: ['normalize.fixture'], dataClassification: 'private' };
  const scoped = { ...request, evidenceRef: record.recordId };
  const result = mapPwceEvidenceResponse(raw, scoped);
  assert.equal(result.evidenceRef, record.recordId); assert.equal(result.item?.value, false); assert.equal(result.item?.knowledgeState, 'unknown');
  assert.equal(result.integrityStatus, 'producerReported'); assert.equal(result.item?.sourceRevisionKind, 'evidenceIntegrity');
  assert.deepEqual(result.transformationRefs, ['normalize.fixture']); assert.equal(result.dataClassification, 'private');
  assert.throws(() => mapPwceEvidenceResponse(raw, { ...scoped, evidenceRef: 'other' }), error('scope_mismatch'));
  assert.throws(() => mapPwceEvidenceResponse({ ...raw, evidence: { ...record, payload: { ...record.payload, siteRef: 'home.two' } } }, scoped), error('scope_mismatch'));
  const missing = mapPwceEvidenceResponse({ ...wire, status: 'unknown' }, scoped); assert.equal(missing.item, undefined);
});

test('legacy typed projection helper snapshots nested values instead of sharing mutable records', () => {
  const input = { ...base, items: [{ itemRef: 'fixture', property: 'state', value: { samples: [1] }, knowledgeState: 'current' as const, basis: 'observed' as const, sourceRevision: '7', evidenceRefs: [], limitations: [] }] };
  const result = mapPwceSlice(input); input.items[0]!.value.samples.push(2);
  assert.deepEqual(result.items[0]?.value, { samples: [1] });
});
