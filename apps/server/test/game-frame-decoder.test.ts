import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {crc32, deflateSync} from 'node:zlib';
import {SglangGameFrameProvider} from '../../../packages/providers-sglang/src/game-frame.ts';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import {createSglangGameFrameDecoder} from '../src/runtime/game-frame-decoder.ts';
import {createGameObservationReader} from '../src/runtime/game-frame-interpretation.ts';
import type {GameHostJoin} from '../src/runtime/game-host-port.ts';

function png() {
  const chunk = (name: string, data: Buffer) => {const head = Buffer.alloc(8), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); head.write(name, 4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]);};
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0,23,41,87]))), chunk('IEND', Buffer.alloc(0))]);
}
function fixture(onReceipt?: () => void) {
  const observation = structuredClone(gameCampaignFixture().input.observation), bytes = png(), shot = observation.screenshots[0]!;
  shot.sha256 = createHash('sha256').update(bytes).digest('hex'); shot.byteLength = bytes.length; shot.width = 1; shot.height = 1;
  let current = true, owned: Buffer | undefined, observes = 0;
  const provider = new SglangGameFrameProvider({endpoint: 'http://127.0.0.1:8181', model: 'fixture-vision', version: 'fixture-revision', loadedProjectorSha256: 'a'.repeat(64), dataEgressClass: 'localOnly',
    capability: () => ({vision: true, model: 'fixture-vision', modelRevision: 'fixture-revision', loadedProjectorSha256: 'a'.repeat(64)}), available: () => current});
  const receipts: {observationId: string; screenshotSha256: string; completionRef: string}[] = [];
  const decoder = createSglangGameFrameDecoder({provider, configurationRef: 'fixture:frame-vision', decoderRevision: '1.0.0', manifestDigest: 'b'.repeat(64), current: () => current,
    onReceipt: (observation, receipt) => {receipts.push({observationId: observation.observationId, screenshotSha256: receipt.screenshotSha256, completionRef: receipt.completionRef});onReceipt?.();}});
  const join = {scope: observation.scope, runtime: {isCurrent: () => current}, adapter: {observe: async (request: any) => {observes++; return {schemaVersion: '1.0.0', operation: request.operation, requestId: request.requestId, correlationId: request.correlationId, providerRef: 'fixture:native', completedAt: new Date().toISOString(), outcome: {status: 'succeeded', payload: {observation: structuredClone(observation), reconciledAction: null}, error: null}};}}} as unknown as GameHostJoin;
  const accounting = {admitOnce: () => true, settleUsage: (usage: any) => usage.inputTokens === 321 && usage.outputTokens === 47 && usage.providerRevision === 'fixture-revision' && /^game-frame-completion:[a-f0-9]{64}$/u.test(usage.completionRef)};
  const run = async (work: any) => {if (!work.current() || !work.admitOnce()) return {state: 'cancelled'}; let value: any; for (const step of work.steps) value = await step(new AbortController().signal); return {state: work.publish(value) ? 'published' : 'cancelled'};};
  const read = createGameObservationReader({decoder, inference: {maximumInputTokens: 8192, maximumOutputTokens: 192, providerRevision: 'fixture-revision', run}, sourceCurrent: () => current, pinsDigestFor: () => observation.pinsDigest, readFrame: async () => {owned = Buffer.from(bytes); return owned;}, maximumDurationMs: 1000, maximumBytes: 1024, maximumLongEdge: 256, maximumObservationAgeMs: 10000});
  const reader = (join: GameHostJoin, signal: AbortSignal) => read(join, signal, null, accounting);
  return {observation, bytes, decoder, join, reader, receipts, owned: () => owned, observes: () => observes, withdraw: () => {current = false;}};
}
const output = () => ({model: 'fixture-vision', choices: [{finish_reason: 'stop', message: {role: 'assistant', content: JSON.stringify({observations: [{appearance: 'An unfamiliar floating platform and two figures are visible.', visibleText: 'Go now? [blurred]', uncertainty: 'Small sprites and text are ambiguous.', limitations: ['Scripted fixture output; no real visual competence established.']}]})}}], usage: {prompt_tokens: 321, completion_tokens: 47}});

test('original observation reader accepts only untrusted source-linked novel appearance/OCR, never VLM state or authority', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => {calls++; return Response.json(output());});
  const f = fixture(), result = await f.reader(f.join, new AbortController().signal);
  assert.ok(result); assert.equal(calls, 1); assert.deepEqual(result.visibleState, []); assert.equal(result.facts.length, 1);
  const fact = result.facts[0]!;
  assert.equal(fact.extractionKind, 'screenPixels'); assert.equal(fact.extractorRef, 'fixture:frame-vision'); assert.equal(fact.untrusted, true);
  assert.equal(fact.epistemicKind, 'visibleFeature'); assert.deepEqual(fact.sourceScreenshotIds, [f.observation.screenshots[0]!.screenshotId]);
  assert.match(fact.description, /unfamiliar floating platform/u); assert.match(fact.description, /untrusted OCR/u);
  assert.match(fact.limitations.join(' '), /model=fixture-vision; revision=fixture-revision; projector=aaaaaaaa/u);
  assert.equal(result.providerConfigurationRef, 'fixture:frame-vision'); assert.ok(f.owned()!.every(byte => byte === 0));
  assert.deepEqual(f.decoder.allowedVisibleFieldIds, []); assert.equal(f.decoder.capability.kind, 'gameVision');
  assert.equal(f.receipts.length, 1);assert.equal(f.receipts[0]!.observationId, f.observation.observationId);assert.equal(f.receipts[0]!.screenshotSha256, f.observation.screenshots[0]!.sha256);assert.match(f.receipts[0]!.completionRef, /^game-frame-completion:[a-f0-9]{64}$/u);
});

test('trusted receipt callback exception refuses fact publication without a fabricated replacement receipt',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json(output()));
  const f=fixture(()=>{throw Error('fixture receipt sink failed');});
  assert.equal(await f.reader(f.join,new AbortController().signal),null);assert.equal(f.receipts.length,1);assert.ok(f.owned()!.every(byte=>byte===0));
});

test('reader rejects foreign scope/stale pixels and withdrawn source before or after VLM work', async t => {
  let calls = 0, afterResponse: () => void = () => {};
  t.mock.method(globalThis, 'fetch', async () => {calls++; afterResponse(); return Response.json(output());});
  const withdrawn = fixture(); withdrawn.withdraw(); assert.equal(await withdrawn.reader(withdrawn.join, new AbortController().signal), null); assert.equal(withdrawn.observes(), 0);
  const stale = fixture(); stale.observation.screenshots[0]!.expiresAt = new Date(0).toISOString(); assert.equal(await stale.reader(stale.join, new AbortController().signal), null); assert.equal(calls, 0);
  const foreign = fixture(); foreign.observation.scope = {...foreign.observation.scope, runId: randomUUID()}; assert.equal(await foreign.reader(foreign.join, new AbortController().signal), null); assert.equal(calls, 0);
  const late = fixture(); afterResponse = late.withdraw;
  assert.equal(await late.reader(late.join, new AbortController().signal), null); assert.equal(calls, 1); assert.ok(late.owned()!.every(byte => byte === 0));
});

test('unknown visual content returns no facts, and unsolicited VLM typed-state/safety data is refused', async t => {
  let content: unknown = {observations: []};
  t.mock.method(globalThis, 'fetch', async () => {const response = output(); response.choices[0]!.message.content = JSON.stringify(content); return Response.json(response);});
  const f = fixture(), empty = await f.reader(f.join, new AbortController().signal); assert.ok(empty); assert.deepEqual(empty.facts, []); assert.deepEqual(empty.visibleState, []);
  for (const data of [{observations: [], visibleState: [{fieldId: 'ct.ui.player.x', value: 7}]}, {observations: [], ordinaryGameplay: true}]) {
    content = data; const next = fixture(); assert.equal(await next.reader(next.join, new AbortController().signal), null); assert.ok(next.owned()!.every(byte => byte === 0));
  }
});
