import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {createHash} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import {SglangGameFrameProvider, type SglangGameFrameConfig, type GameFrameInterpretationRequest} from '../src/game-frame.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+5gz/qwAAAABJRU5ErkJggg==', 'base64');
const projector = 'a'.repeat(64);
const output = () => ({observations: [{appearance: 'A violet airship hangs above a striped plaza.', visibleText: 'NORTH GATE?', uncertainty: 'The last glyph is blurred.', limitations: ['One still image; no unseen motion.']}]});
const envelope = (data: unknown = output()) => ({model: 'fixture-vision', choices: [{finish_reason: 'stop', message: {role: 'assistant', content: JSON.stringify(data)}}], usage: {prompt_tokens: 321, completion_tokens: 47}});
const input = (): GameFrameInterpretationRequest => ({purpose: 'simulatedGame/gameFramebuffer', bytes: Buffer.from(png), deadlineAtMs: Date.now() + 3000,
  screenshot: {sha256: createHash('sha256').update(png).digest('hex'), byteLength: png.length, width: 1, height: 1, capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5000).toISOString()}, isCurrent: () => true});
const config = (extra: Partial<SglangGameFrameConfig> = {}): SglangGameFrameConfig => ({endpoint: 'http://127.0.0.1:8181', model: 'fixture-vision', version: 'fixture-revision', loadedProjectorSha256: projector,
  dataEgressClass: 'localOnly', capability: () => ({vision: true, model: 'fixture-vision', modelRevision: 'fixture-revision', loadedProjectorSha256: projector}), available: () => true, ...extra});
function fetchStub(t: TestContext, impl: typeof fetch) {t.mock.method(globalThis, 'fetch', impl);}

test('novel framebuffer uses isolated image_url JSON transport and host-authored model provenance', async t => {
  let body: any, init: RequestInit | undefined;
  fetchStub(t, async (url, options) => {assert.equal(url, 'http://127.0.0.1:8181/v1/chat/completions'); init = options; body = JSON.parse(options!.body as string); return Response.json(envelope());});
  const request = input(), result = await new SglangGameFrameProvider(config()).interpret(request, new AbortController().signal);
  assert.ok(result); assert.deepEqual(result.observations, output().observations);
  assert.deepEqual(result.provenance, {model: 'fixture-vision', modelRevision: 'fixture-revision', loadedProjectorSha256: projector});
  assert.equal(result.usageReceipt.inputTokens, 321); assert.equal(result.usageReceipt.outputTokens, 47);
  assert.equal(result.usageReceipt.requestSha256, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
  assert.equal(result.usageReceipt.responseSha256, createHash('sha256').update(JSON.stringify(envelope())).digest('hex'));
  assert.equal(result.usageReceipt.screenshotSha256, request.screenshot.sha256); assert.match(result.usageReceipt.completionRef, /^game-frame-completion:[a-f0-9]{64}$/u);
  assert.equal(body.messages.length, 2); assert.equal(body.messages[1].content.length, 1); assert.equal(body.messages[1].content[0].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.stream, false); assert.equal(init!.redirect, 'error');
  assert.equal(body.max_tokens, 192); assert.equal(body.response_format.json_schema.schema.properties.observations.maxItems, 2);
  assert.doesNotMatch(JSON.stringify(body), /leaseId|principalId|conversationId|sessionId|cameraScope|humanCount|corePersona|preparedMemory/u);
  assert.deepEqual(request.bytes, png); assert.ok(Object.isFrozen(result.observations[0]));
});

test('short output token budget accepts only 32..256 and sends the configured finite bound', async t => {
  let tokens: unknown;
  fetchStub(t, async (_url, options) => {const body = JSON.parse(options!.body as string); tokens = body.max_tokens; return Response.json({...envelope(), model: body.model, usage: {prompt_tokens: 321, completion_tokens: Math.min(47, body.max_tokens)}});});
  for (const maximumOutputTokens of [32, 256]) {
    assert.ok(await new SglangGameFrameProvider(config({maximumOutputTokens})).interpret(input(), new AbortController().signal));
    assert.equal(tokens, maximumOutputTokens);
  }
  for (const maximumOutputTokens of [0, 31, 257, 2048, 32.5, NaN]) assert.throws(() => new SglangGameFrameProvider(config({maximumOutputTokens})));
  const fullServedModelId = '/srv/fixture/models/' + 'model-revision-'.repeat(8) + 'vision.gguf';
  assert.ok(Buffer.byteLength(fullServedModelId) > 128);
  const result = await new SglangGameFrameProvider(config({model: fullServedModelId, capability: () => ({vision: true, model: fullServedModelId, modelRevision: 'fixture-revision', loadedProjectorSha256: projector})})).interpret(input(), new AbortController().signal);
  assert.equal(result?.provenance.model, fullServedModelId);
});

test('actual usage is required, bounded, and never replaced by reserved token caps', async t => {
  let usage: unknown;
  fetchStub(t, async () => Response.json({...envelope(), usage}));
  for (const value of [undefined, {}, {prompt_tokens: -1, completion_tokens: 5}, {prompt_tokens: 8193, completion_tokens: 5},
    {prompt_tokens: 10, completion_tokens: 193}, {prompt_tokens: 1.5, completion_tokens: 5}, {prompt_tokens: 2, completion_tokens: '5'}]) {
    usage = value; assert.equal(await new SglangGameFrameProvider(config()).interpret(input(), new AbortController().signal), null);
  }
  usage = {prompt_tokens: 0, completion_tokens: 0};
  const zero = await new SglangGameFrameProvider(config()).interpret(input(), new AbortController().signal);
  assert.equal(zero?.usageReceipt.inputTokens, 0); assert.equal(zero?.usageReceipt.outputTokens, 0);
  assert.throws(() => new SglangGameFrameProvider(config({maximumInputTokens: 8193})));
});

test('only actual matching vision/projector/model/revision plus resource availability admits a call', async t => {
  let calls = 0; fetchStub(t, async () => {calls++; return Response.json(envelope());});
  for (const capability of [null, {vision: false}, {vision: true, model: 'fixture-vision', modelRevision: 'fixture-revision', loadedProjectorSha256: 'b'.repeat(64)},
    {vision: true, model: 'other', modelRevision: 'fixture-revision', loadedProjectorSha256: projector},
    {vision: true, model: 'fixture-vision', modelRevision: 'other', loadedProjectorSha256: projector}]) {
    const provider = new SglangGameFrameProvider(config({capability: () => capability as any}));
    assert.equal(await provider.interpret(input(), new AbortController().signal), null);
  }
  assert.equal(await new SglangGameFrameProvider(config({available: () => false})).interpret(input(), new AbortController().signal), null);
  assert.equal(calls, 0);
  assert.throws(() => new SglangGameFrameProvider(config({endpoint: 'http://remote.invalid', dataEgressClass: 'localOnly'})));
  const assigned = Object.values(networkInterfaces()).flatMap(rows => rows ?? []).filter(row => row.family === 'IPv4');
  for (const row of assigned) assert.doesNotThrow(() => new SglangGameFrameProvider(config({endpoint: `http://${row.address}:30000`}))); // Configuration only: no network call.
  const addresses = new Set(assigned.map(row => row.address));
  const foreignLan = ['192.168.254.254', '192.168.253.254'].find(address => !addresses.has(address))!;
  assert.throws(() => new SglangGameFrameProvider(config({endpoint: `http://${foreignLan}:30000`}))); // A different LAN host is not localOnly.
});

test('wrong pixel hash, dimensions, stale/future frame, wrong purpose and input bound fail before fetch', async t => {
  let calls = 0; fetchStub(t, async () => {calls++; return Response.json(envelope());});
  for (const mutate of [(v: any) => {v.screenshot.sha256 = 'b'.repeat(64);}, (v: any) => {v.screenshot.width = 2;},
    (v: any) => {v.screenshot.expiresAt = new Date(0).toISOString();}, (v: any) => {v.screenshot.capturedAt = new Date(Date.now() + 10000).toISOString();},
    (v: any) => {v.screenshot.capturedAt = new Date(Date.now() - 181000).toISOString();}, (v: any) => {v.purpose = 'camera';}, (v: any) => {v.bytes = Buffer.alloc(1025);},
    (v: any) => {v.isCurrent = () => false;}]) {
    const request = input(); mutate(request);
    assert.equal(await new SglangGameFrameProvider(config({maximumFrameBytes: 1024})).interpret(request, new AbortController().signal), null);
  }
  assert.equal(calls, 0);
});

test('long cold generation fits configured sanity watchdog but never extends actual image or request expiry', async t => {
  const baseWall=Date.now(),baseMono=performance.now();let elapsed=0,completionAt=46000;
  t.mock.method(Date,'now',()=>baseWall+elapsed);t.mock.method(performance,'now',()=>baseMono+elapsed);
  fetchStub(t,async()=>{elapsed=completionAt;return Response.json(envelope());});
  const request=()=>{const value=input();return {...value,deadlineAtMs:baseWall+90000,screenshot:{...value.screenshot,capturedAt:new Date(baseWall).toISOString(),expiresAt:new Date(baseWall+90000).toISOString()}};};
  assert.ok(await new SglangGameFrameProvider(config({maximumDurationMs:60000})).interpret(request(),new AbortController().signal));
  elapsed=0;assert.ok(await new SglangGameFrameProvider(config()).interpret(request(),new AbortController().signal)); // default60s sanity watchdog, not a performance claim
  elapsed=0;assert.equal(await new SglangGameFrameProvider(config({maximumDurationMs:30000})).interpret(request(),new AbortController().signal),null);
  elapsed=0;const expired=request();expired.screenshot.expiresAt=new Date(baseWall+45000).toISOString();assert.equal(await new SglangGameFrameProvider(config({maximumDurationMs:60000})).interpret(expired,new AbortController().signal),null);
  elapsed=0;const lease=request();lease.deadlineAtMs=baseWall+45000;assert.equal(await new SglangGameFrameProvider(config({maximumDurationMs:60000})).interpret(lease,new AbortController().signal),null);
  elapsed=0;completionAt=90001;assert.equal(await new SglangGameFrameProvider(config({maximumDurationMs:60000})).interpret(request(),new AbortController().signal),null);
  assert.throws(()=>new SglangGameFrameProvider(config({maximumDurationMs:120001})));assert.throws(()=>new SglangGameFrameProvider(config({maximumObservationAgeMs:300001})));
});

test('closed data rejects tools, hidden reasoning, authority fields, wrong model, truncation and byte overflow', async t => {
  let response: any; fetchStub(t, async () => typeof response === 'string' ? new Response(response) : Response.json(response));
  for (const mutate of [(v: any) => {v.model = 'other';}, (v: any) => {v.choices[0].finish_reason = 'length';},
    (v: any) => {v.choices[0].message.reasoning_content = 'SECRET';}, (v: any) => {v.choices[0].message.tool_calls = [];},
    (v: any) => {v.choices[0].message.content = JSON.stringify({...output(), ordinaryGameplay: true});},
    (v: any) => {v.choices[0].message.content = JSON.stringify({observations: [{...output().observations[0], coordinates: [1, 2]}]});},
    (v: any) => {v.choices[0].message.content = '{';}]) {
    response = envelope(); mutate(response);
    assert.equal(await new SglangGameFrameProvider(config()).interpret(input(), new AbortController().signal), null);
  }
  response = 'x'.repeat(16385);
  assert.equal(await new SglangGameFrameProvider(config()).interpret(input(), new AbortController().signal), null);
});

test('one serial slot, ignored-signal deadline, cancellation and capability withdrawal discard late data', async t => {
  let finish: ((response: Response) => void) | undefined, calls = 0;
  fetchStub(t, () => {calls++; return new Promise(resolve => {finish = resolve;});});
  const provider = new SglangGameFrameProvider(config({maximumDurationMs: 20})), request = input();
  const first = provider.interpret(request, new AbortController().signal);
  assert.equal(await provider.interpret(input(), new AbortController().signal), null); assert.equal(calls, 1);
  assert.equal(await first, null); assert.equal(await provider.interpret(input(), new AbortController().signal), null); assert.equal(calls, 1);
  finish!(Response.json(envelope())); await new Promise(resolve => setImmediate(resolve));
  const cancelled = new AbortController(), second = provider.interpret(input(), cancelled.signal); cancelled.abort(); assert.equal(await second, null); finish!(Response.json(envelope()));
  let available = true;
  const other = new SglangGameFrameProvider(config({available: () => available})), pending = other.interpret(input(), new AbortController().signal);
  available = false; finish!(Response.json(envelope())); assert.equal(await pending, null);
});

test('source/pixel mutation and a stalled body cannot escape freshness or cancellation', async t => {
  let finish: ((response: Response) => void) | undefined;
  fetchStub(t, () => new Promise(resolve => {finish = resolve;}));
  const provider = new SglangGameFrameProvider(config()), request = input(), pending = provider.interpret(request, new AbortController().signal);
  request.bytes[0] = 0; finish!(Response.json(envelope())); assert.equal(await pending, null);
  const controller = new AbortController(), next = provider.interpret(input(), controller.signal);
  finish!(new Response(new ReadableStream({start() {/* Deliberately no bytes or close. */}})));
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); assert.equal(await next, null);
});

test('refusal metadata records actual finish reason without inferring truncation from token count',async t=>{
 let finish='length';const refusals:any[]=[];
 fetchStub(t,async()=>Response.json({...envelope(),choices:[{finish_reason:finish,message:{role:'assistant',content:JSON.stringify(output())}}],usage:{prompt_tokens:321,completion_tokens:192}}));
 const request={...input(),onRefusal:(value:any)=>refusals.push(value)};
 assert.equal(await new SglangGameFrameProvider(config()).interpret(request,new AbortController().signal),null);
 assert.equal(refusals.length,1);assert.equal(refusals[0].reason,'response_finish');assert.equal(refusals[0].finishReason,'length');assert.equal(refusals[0].outputTokens,192);assert.match(refusals[0].responseSha256,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(refusals),/violet|NORTH|base64|image_url|fixture-vision/);
 finish='stop';refusals.length=0;assert.ok(await new SglangGameFrameProvider(config()).interpret(request,new AbortController().signal));assert.equal(refusals.length,0,'192 actual tokens with a valid stop remains accepted');
});
test('refusal metadata distinguishes invalid content, transport failure and observed usage without leaking text',async t=>{
 const cases=[{reason:'content_json',response:{...envelope(),choices:[{finish_reason:'stop',message:{role:'assistant',content:'PRIVATE BROKEN JSON'}}]}},{reason:'response_usage',response:{...envelope(),usage:{prompt_tokens:321,completion_tokens:193}}},{reason:'response_finish',response:{...envelope(),choices:[{finish_reason:'PRIVATE UNKNOWN',message:{role:'assistant',content:'PRIVATE'}}]}}];
 for(const c of cases){
  const failures:any[]=[];fetchStub(t,async()=>Response.json(c.response));
  const result=await new SglangGameFrameProvider(config()).interpret({...input(),onRefusal:(v:any)=>{failures.push(v);throw Error('PRIVATE SINK');}},new AbortController().signal);
  assert.equal(result,null);assert.equal(failures.length,1);assert.equal(failures[0].reason,c.reason);assert.doesNotMatch(JSON.stringify(failures),/PRIVATE/);
  if(c.reason==='response_finish')assert.equal(failures[0].finishReason,'other');
 }
 const failures:any[]=[];fetchStub(t,async()=>{throw Error('PRIVATE TRANSPORT');});
 assert.equal(await new SglangGameFrameProvider(config()).interpret({...input(),onRefusal:(v:any)=>failures.push(v)},new AbortController().signal),null);assert.equal(failures[0].reason,'transport_unavailable');
});

test('refusal metadata identifies each message and observation predicate without retaining the offending value',async t=>{
 const cases:[string,(value:any)=>void][]=[
 ['response_message_role',v=>{v.choices[0].message.role='PRIVATE';}],['response_content_type',v=>{v.choices[0].message.content={private:'PRIVATE'};}],
 ['response_content_bounds',v=>{v.choices[0].message.content='x'.repeat(16385);}],['response_tool_calls',v=>{v.choices[0].message.tool_calls=['PRIVATE'];}],
 ['response_function_call',v=>{v.choices[0].message.function_call='PRIVATE';}],['response_refusal',v=>{v.choices[0].message.refusal='PRIVATE';}],
 ['response_reasoning_content',v=>{v.choices[0].message.reasoning_content='PRIVATE';}],
 ...(['observation_record','observation_appearance','observation_visible_text','observation_uncertainty','observation_limitations'] as const).map(reason=>[reason,(v:any)=>{
  const data=output();if(reason==='observation_record')(data.observations[0] as any).private='PRIVATE';
  if(reason==='observation_appearance')data.observations[0]!.appearance='';
  if(reason==='observation_visible_text')(data.observations[0] as any).visibleText={private:'PRIVATE'};
  if(reason==='observation_uncertainty')data.observations[0]!.uncertainty='';
  if(reason==='observation_limitations')data.observations[0]!.limitations=[];
  v.choices[0].message.content=JSON.stringify(data);
 }] as [string,(value:any)=>void])];
 for(const [reason,mutate]of cases){const response=envelope();mutate(response);fetchStub(t,async()=>Response.json(response));const values:any[]=[];
  assert.equal(await new SglangGameFrameProvider(config({maximumResponseBytes:32768})).interpret({...input(),onRefusal:value=>values.push(value)},new AbortController().signal),null);
  assert.equal(values.length,1);assert.equal(values[0].reason,reason);assert.doesNotMatch(JSON.stringify(values),/PRIVATE/);
 }
});
test('content parse exception and failed response currency preserve original current call counts',async t=>{
 let checks=0;const failures:any[]=[];const response=envelope();response.choices[0]!.message.content='{';
 fetchStub(t,async()=>Response.json(response));
 assert.equal(await new SglangGameFrameProvider(config()).interpret({...input(),isCurrent:()=>{checks++;return true;},onRefusal:value=>failures.push(value)},new AbortController().signal),null);
 assert.equal(checks,5,'input, pre-fetch, response, body chunk and body end; no post-parse check after throw');assert.equal(failures[0].reason,'content_json');
 checks=0;failures.length=0;fetchStub(t,async()=>Response.json(envelope()));
 assert.equal(await new SglangGameFrameProvider(config()).interpret({...input(),isCurrent:()=>++checks<3,onRefusal:value=>failures.push(value)},new AbortController().signal),null);
 assert.equal(checks,3,'failed response currency evaluated once');assert.equal(failures[0].reason,'source_current');
});
