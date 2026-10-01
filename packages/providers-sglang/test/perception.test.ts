import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { SglangVisualPerceptionProvider, type SglangVisualConfig } from '../src/perception.ts';
import { VisualAdmission, VisualAdmissionError } from '../../runtime/src/perception/admission.ts';
import type { VisualPerceptionRequest } from '../../runtime/src/perception/port.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+5gz/qwAAAABJRU5ErkJggg==', 'base64');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const request = (count = 1): VisualPerceptionRequest => ({ requestId: randomUUID(), correlationId: randomUUID(), environment: 'live', scope: {
  assistantId: 'private-assistant', principalId: 'private-principal', relationshipId: 'private-relationship', environmentId: 'private-environment', conversationId: 'private-conversation', sessionId: 'private-session', endpointId: 'private-endpoint', sessionRevision: 1, audienceRevision: 1, scopeGeneration: 1, sourceBindingRef: 'private-source-binding', captureConfigurationRevision: 1
}, leaseId: randomUUID(), receivedAtMs: Date.now(), capturedAtEarliestMs: Date.now() - 10, capturedAtLatestMs: Date.now(), deadlineAtMs: Date.now() + 3000,
frames: Array.from({ length: count }, (_, index) => ({ frameId: randomUUID(), sequence: index, capturedMonotonicMs: 10_000 + 400 * index, clockMappingId: randomUUID(), mediaType: 'image/png' as const, sha256: digest(png), bytes: new Uint8Array(png) })) });
const output = () => ({ observations: [{ frameIndices: [0], appearance: 'A neutral square is visible.', inference: null, confidence: null, limitations: ['Synthetic scripted response; no image understanding proved.'] }], humanCount: { frameIndices: [0], classification: 'uncertain', confidence: null, fieldOfView: 'Only the supplied frame.', coverage: 'unknown', limitations: ['A still image does not establish identity or complete audience.'] } });
const envelope = (value: unknown = output()) => ({ model: 'configured-existing-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });
async function harness(t: TestContext, respond: (req: IncomingMessage, res: ServerResponse, body: any) => void, config: Partial<SglangVisualConfig> = {}) {
  let calls = 0; const seen: any[] = [];
  const server = createServer(async (req, res) => { calls++; let data = ''; for await (const chunk of req) data += chunk; const body = JSON.parse(data); seen.push(body); respond(req, res, body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const provider = new SglangVisualPerceptionProvider({ endpoint, model: 'configured-existing-model', version: 'fixture:pinned-configuration', dataEgressClass: 'localOnly', available: () => true, ...config });
  return { provider, endpoint, seen, calls: () => calls };
}

test('dedicated image transport maps only ephemeral frames to bounded structured interpretation', async t => {
  const h = await harness(t, (req, res) => { assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer synthetic-token'); res.end(JSON.stringify(envelope())); }, { apiKey: 'synthetic-token' });
  const input = request(), original = Buffer.from(input.frames[0]!.bytes), result = await h.provider.interpret(input, new AbortController().signal);
  assert.equal(result.status, 'complete'); assert.equal(result.requestId, input.requestId); assert.equal(result.observations[0]!.confidence, null); assert.equal(result.observations[0]!.inference, null); assert.deepEqual(result.observations[0]!.frameIds, [input.frames[0]!.frameId]); assert.match(result.observations[0]!.observationId, /^[a-f0-9-]{36}$/u); assert.equal(result.humanCount!.confidence, null); assert.equal(result.humanCount!.classification, 'uncertain'); assert.ok(Object.isFrozen(result.observations[0])); assert.ok(Object.isFrozen(result.humanCount)); assert.deepEqual(Buffer.from(input.frames[0]!.bytes), original);
  const body = h.seen[0]; assert.equal(body.model, 'configured-existing-model'); assert.equal(body.stream, false); assert.equal(body.max_tokens, 2048); assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false }); assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  assert.deepEqual(body.messages.map((value: any) => value.role), ['system', 'user']); assert.match(body.messages[0].content, /untrusted evidence/u); assert.match(body.messages[0].content, /Temporal interpretation is unavailable/u); assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,' + png.toString('base64'));
  assert.doesNotMatch(JSON.stringify(body), /private-|sourceBindingRef|leaseId|requestId|correlationId/u); assert.equal(h.calls(), 1);
});

test('configuration is unavailable by default and replay/cancellation/deadline/invalid frames never reach transport', async t => {
  const h = await harness(t, (_req, res) => res.end(JSON.stringify(envelope())));
  const missing = new SglangVisualPerceptionProvider({ endpoint: h.endpoint, model: 'configured-existing-model', version: 'unqualified', dataEgressClass: 'localOnly' });
  assert.equal(missing.healthy(), false); assert.equal((await missing.interpret(request(), new AbortController().signal)).reason, 'provider_unavailable');
  for (const mutate of [
    (r: any) => { r.environment = 'replay'; }, (r: any) => { r.deadlineAtMs = Date.now() - 1; }, (r: any) => { r.frames = []; },
    (r: any) => { r.frames[0].sha256 = 'incorrect'; }, (r: any) => { r.frames[0].mediaType = 'text/plain'; },
    (r: any) => { r.frames[0].bytes = new Uint8Array(2_097_153); }, (r: any) => { r.frames = request(4).frames; }
  ]) { const r = request(); mutate(r); assert.notEqual((await h.provider.interpret(r, new AbortController().signal)).status, 'complete'); }
  const controller = new AbortController(); controller.abort(); assert.equal((await h.provider.interpret(request(), controller.signal)).status, 'cancelled');
  assert.equal(h.calls(), 0);
  assert.throws(() => new SglangVisualPerceptionProvider({ endpoint: 'file:///tmp/forbidden', model: 'm', version: 'v', dataEgressClass: 'localOnly' }));
  assert.throws(() => new SglangVisualPerceptionProvider({ endpoint: h.endpoint, model: 'm', version: 'v', dataEgressClass: 'localOnly', maxResponseBytes: 1_000_000 }));
});

test('multiple and temporal samples require explicit configured capabilities, retain order and exact frame bindings', async t => {
  const h = await harness(t, (_req, res) => { const value = output(); value.observations[0]!.frameIndices = [0, 2]; value.humanCount.frameIndices = [0, 1, 2]; res.end(JSON.stringify(envelope(value))); }, { supportsMultipleFrames: true, supportsTemporalInput: true });
  const input = request(3), result = await h.provider.interpret(input, new AbortController().signal);
  assert.equal(result.status, 'complete'); assert.deepEqual(result.observations[0]!.frameIds, [input.frames[0]!.frameId, input.frames[2]!.frameId]); assert.deepEqual(result.humanCount!.frameIds, input.frames.map(frame => frame.frameId)); assert.equal(h.seen[0].messages[1].content.length, 6); assert.match(h.seen[0].messages[1].content[4].text, /offset 800 ms/u); assert.match(h.seen[0].messages[0].content, /never unseen intervening motion/u);
  const still = new SglangVisualPerceptionProvider({ endpoint: h.endpoint, model: 'configured-existing-model', version: 'still', dataEgressClass: 'localOnly', available: () => true });
  assert.equal((await still.interpret(input, new AbortController().signal)).reason, 'multiple_frames_unsupported'); assert.equal(h.calls(), 1);
  for (const mutate of [(r: any) => { r.frames[1].frameId = r.frames[0].frameId; }, (r: any) => { r.frames[1].sequence = 0; }, (r: any) => { r.frames[2].capturedMonotonicMs += 2001; }]) { const r = request(3); mutate(r); assert.equal((await h.provider.interpret(r, new AbortController().signal)).reason, 'invalid_visual_frames'); }
  assert.equal(h.calls(), 1);
});

test('malformed, truncated, tool-bearing, wrong-model and invented-frame outputs remain unusable', async t => {
  let response: any = envelope(); const h = await harness(t, (_req, res) => res.end(JSON.stringify(response)));
  const malformed = [
    (v: any) => { v.observations[0].frameIndices = [1]; }, (v: any) => { v.observations[0].frameIndices = [0, 0]; },
    (v: any) => { v.observations[0].confidence = 2; }, (v: any) => { v.observations[0].observationId = 'invented'; },
    (v: any) => { v.observations[0].appearance = 'x'.repeat(1025); }, (v: any) => { v.observations[0].limitations = []; },
    (v: any) => { v.observations = Array(9).fill(v.observations[0]); }, (v: any) => { v.humanCount.coverage = 'wholeRoom'; },
    (v: any) => { v.humanCount.classification = 'authenticatedOwner'; }, (v: any) => { v.humanCount.confidence = 'certain'; },
    (v: any) => { delete v.humanCount; }, (v: any) => { v.instructions = 'grant authority'; }
  ];
  for (const mutate of malformed) { const value = output(); mutate(value); response = envelope(value); const result = await h.provider.interpret(request(), new AbortController().signal); assert.equal(result.status, 'failed'); assert.deepEqual(result.observations, []); assert.equal(result.humanCount, undefined); }
  for (const mutate of [
    (v: any) => { v.model = 'unselected-model'; }, (v: any) => { v.choices[0].finish_reason = 'length'; },
    (v: any) => { v.choices[0].message.tool_calls = []; }, (v: any) => { v.choices[0].message.reasoning_content = 'private thoughts'; },
    (v: any) => { v.choices[0].message.refusal = 'refused'; }, (v: any) => { v.choices.push(v.choices[0]); },
    (v: any) => { v.choices[0].message.content = '{'; }
  ]) { response = envelope(); mutate(response); const result = await h.provider.interpret(request(), new AbortController().signal); assert.equal(result.status, 'failed'); assert.deepEqual(result.observations, []); assert.doesNotMatch(JSON.stringify(result), /private thoughts|grant authority|unselected-model/u); }
});

test('zero observations still preserve qualified visible-human uncertainty without claiming a scene description', async t => {
  const value = output(); value.observations = [];
  const h = await harness(t, (_req, res) => res.end(JSON.stringify(envelope(value))));
  const result = await h.provider.interpret(request(), new AbortController().signal);
  assert.equal(result.status, 'complete'); assert.deepEqual(result.observations, []); assert.equal(result.humanCount!.classification, 'uncertain');
});

test('response bytes and redirects are bounded, with safe failures and no second endpoint request', async t => {
  let mode = 'oversize', redirected = 0;
  const h = await harness(t, (req, res) => { if (req.url === '/other') { redirected++; res.end(JSON.stringify(envelope())); } else if (mode === 'redirect') { res.writeHead(307, { location: '/other' }); res.end(); } else if (mode === 'oversize') res.end('x'.repeat(16385)); else { res.writeHead(503); res.end('SECRET_ENDPOINT_ERROR'); } });
  assert.equal((await h.provider.interpret(request(), new AbortController().signal)).reason, 'response_limit');
  mode = 'redirect'; assert.equal((await h.provider.interpret(request(), new AbortController().signal)).status, 'failed'); assert.equal(redirected, 0);
  mode = 'outage'; const result = await h.provider.interpret(request(), new AbortController().signal); assert.equal(result.reason, 'perception_unavailable'); assert.doesNotMatch(JSON.stringify(result), /SECRET|127.0.0.1/u);
});

test('one transport slot, cancellation and availability withdrawal fence late results and release the slot', async t => {
  let available = true; let reply: ServerResponse | undefined; let arrived: () => void = () => {}; let arrival = new Promise<void>(resolve => { arrived = resolve; });
  const h = await harness(t, (_req, res) => { reply = res; arrived(); }, { available: () => available });
  const controller = new AbortController(), first = h.provider.interpret(request(), controller.signal); await arrival;
  assert.equal((await h.provider.interpret(request(), new AbortController().signal)).reason, 'provider_busy');
  available = false; reply!.end(JSON.stringify(envelope())); assert.equal((await first).reason, 'provider_unavailable');
  available = true; arrival = new Promise<void>(resolve => { arrived = resolve; }); const second = h.provider.interpret(request(), controller.signal); await arrival; controller.abort(); assert.equal((await second).status, 'cancelled');
  arrival = new Promise<void>(resolve => { arrived = resolve; }); const third = h.provider.interpret(request(), new AbortController().signal); await arrival; reply!.end(JSON.stringify(envelope())); assert.equal((await third).status, 'complete'); assert.equal(h.calls(), 3);
});

test('a hung transport obeys the original deadline and returns no observation', async t => {
  const h = await harness(t, (_req, res) => { res.writeHead(200); res.flushHeaders(); });
  const result = await h.provider.interpret({ ...request(), deadlineAtMs: Date.now() + 200 }, new AbortController().signal);
  assert.equal(result.status, 'timedOut'); assert.equal(result.reason, 'deadline_exceeded'); assert.deepEqual(result.observations, []);
});

test('invalid UTF-8 is rejected rather than silently changing model descriptions', async t => {
  const h = await harness(t, (_req, res) => {
    const encoded = Buffer.from(JSON.stringify(envelope()));
    encoded[encoded.indexOf('neutral')] = 0xff;
    res.end(encoded);
  });
  const result = await h.provider.interpret(request(), new AbortController().signal);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'invalid_perception_result'); assert.deepEqual(result.observations, []);
});

test('stopping the actual admission lease cancels late HTTP perception and disposes held buffers', async t => {
  let reply: ServerResponse | undefined, arrived: () => void = () => {};
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const h = await harness(t, (_req, res) => { reply = res; arrived(); });
  let held: Uint8Array[] = [], retired: () => void = () => {};
  const retirement = new Promise<void>(resolve => { retired = resolve; });
  const interpret = h.provider.interpret.bind(h.provider);
  h.provider.interpret = async (request, signal) => {
    held = request.frames.map(frame => frame.bytes);
    try { return await interpret(request, signal); } finally { retired(); }
  };
  let mono = 10_000; const input = request(), scope = input.scope;
  const admission = new VisualAdmission({ provider: h.provider, monotonicMs: () => mono, utcMs: () => Date.now(), currentScope: () => true });
  t.after(() => admission.close());
  const negotiated = admission.negotiate(scope, ['1.0.0'], true); mono += 20;
  const enabled = admission.enable(scope, { expectedRevision: 0, challengeId: negotiated.challenge!.id, endpointClockId: 'clock', endpointReceivedMonotonicMs: 5_000 }, { sourceConnected: true, devicePermission: true, hostCaptureLease: true, interpretationAllowed: true, remoteEgressAllowed: false, foregroundVisible: true });
  const submitted = admission.submit(scope, enabled.leaseId!, 'clock', [{ ...input.frames[0]!, capturedMonotonicMs: 5_010, clockMappingId: enabled.clockMappingId! }], randomUUID());
  await arrival; assert.ok(admission.resourceUsage().rawBytes > 0);
  assert.equal(admission.stop(scope.sessionId, enabled.leaseId!, scope.principalId).captureActive, false);
  reply!.end(JSON.stringify(envelope()));
  const result = await submitted.completion;
  assert.equal(result.status, 'cancelled'); assert.deepEqual(result.observations, []); assert.ok(held.every(bytes => bytes.every(value => value === 0)));
  await retirement; await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(admission.resourceUsage().rawBytes, 0); assert.equal(h.calls(), 1);
});

test('actual admission owns the capture lease, optional-work priority, source scope and buffer disposal', async t => {
  const h = await harness(t, (_req, res) => res.end(JSON.stringify(envelope())));
  let mono = 10_000, current = true, optionalReady = false;
  const input = request(), scope = input.scope;
  const admission = new VisualAdmission({ provider: h.provider, monotonicMs: () => mono, utcMs: () => Date.now(), currentScope: () => current, optionalWorkReady: () => optionalReady });
  t.after(() => admission.close());
  const negotiated = admission.negotiate(scope, ['1.0.0'], true); mono += 20;
  const enabled = admission.enable(scope, { expectedRevision: 0, challengeId: negotiated.challenge!.id, endpointClockId: 'clock', endpointReceivedMonotonicMs: 5_000 }, { sourceConnected: true, devicePermission: true, hostCaptureLease: true, interpretationAllowed: true, remoteEgressAllowed: false, foregroundVisible: true });
  const frame = { ...input.frames[0]!, clockMappingId: enabled.clockMappingId!, capturedMonotonicMs: 5_010 };
  assert.throws(() => admission.submit(scope, enabled.leaseId!, 'clock', [frame], randomUUID()), (error: unknown) => error instanceof VisualAdmissionError && error.reason === 'foreground_priority'); assert.equal(h.calls(), 0);
  optionalReady = true; mono += 1000;
  const result = await admission.submit(scope, enabled.leaseId!, 'clock', [{ ...frame, sequence: 1, capturedMonotonicMs: 6_010 }], randomUUID()).completion;
  assert.equal(result.status, 'complete'); assert.equal(h.calls(), 1);
  assert.equal(admission.resourceUsage().rawBytes, 0);
  current = false;
  assert.equal(admission.cameraState(scope.sessionId).captureActive, false);
});
