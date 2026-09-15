import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { EXPECTED_PWCE_ARTIFACTS, EXPECTED_PWCE_GENERATED_CLIENT_SHA256, EXPECTED_PWCE_PROFILE, PwceGatewayClient } from "../src/client.ts";
import { PWCE_MAX_TRANSPORT_BYTES as maxBytes, PwceTransportError } from "../src/transport.ts";

const operations = ["context.getPreparedInputs", "context.query", "evidence.get", "events.subscribe", "authority.evaluate", "authority.authorizeDispatch", "authority.getGrants", "capabilities.getSnapshot", "capabilities.invoke", "capabilities.getInvocation", "trace.publish", "health.get"];
const profile = { ...EXPECTED_PWCE_PROFILE, schemaStatus: "published", operationCatalog: operations.map(operation => ({ operation })) };
const bundle = { bundleId: profile.bundleId, bundleVersion: profile.bundleVersion, bundleDigest: profile.schemaDigest, artifacts: EXPECTED_PWCE_ARTIFACTS, generatedClient: { path: "src/gateway/generated-client.js", sha256: EXPECTED_PWCE_GENERATED_CLIENT_SHA256 } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const options = { baseUrl: "http://fixture", token: "synthetic-secret-for-transport-tests" };
function client(operation: typeof fetch, extra = {}) {
  return new PwceGatewayClient({ ...options, ...extra, fetchImpl: (url, init) => String(url).endsWith("profile") ? Promise.resolve(json(profile)) : String(url).endsWith("bundle") ? Promise.resolve(json(bundle)) : operation(url, init) });
}
function code(expected: string, status?: number, source = "local") {
  return (error: unknown) => {
    assert.ok(error instanceof PwceTransportError);
    assert.equal(error.code, expected);
    assert.equal(error.status, status);
    assert.equal(error.source, source);
    assert.ok(!error.message.includes(options.token));
    return true;
  };
}
const encoder = new TextEncoder();
function stream(chunks: Uint8Array[], close = true) {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (close) controller.close(); },
    cancel() { cancellations++; },
  });
  return { body, cancelled: () => cancellations };
}
const sse = (body: ReadableStream<Uint8Array>) => new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
async function collect(gateway: PwceGatewayClient, signal?: AbortSignal) {
  const result = [];
  for await (const event of gateway.subscribeInvalidations("authority.fixture", "site.fixture", { ...(signal ? { signal } : {}) })) result.push(event);
  return result;
}

test("rejects invalid host transport bounds and credential-bearing or non-HTTP base URLs", () => {
  for (const requestTimeoutMs of [0, -1, 30_001, NaN, Infinity, 1.5]) assert.throws(() => new PwceGatewayClient({ ...options, requestTimeoutMs }), code("invalid_configuration"));
  for (const streamLifetimeMs of [0, -1, 60_001, NaN, Infinity, 1.5]) assert.throws(() => new PwceGatewayClient({ ...options, streamLifetimeMs }), code("invalid_configuration"));
  for (const baseUrl of ["file:///tmp/fixture", "http://user:secret@fixture", "http://fixture?token=x", "http://fixture#token", "not a URL"]) assert.throws(() => new PwceGatewayClient({ ...options, baseUrl }), /URL is invalid/);
});

test("request byte cap includes multibyte UTF-8 and runs before any negotiation", async () => {
  let calls = 0;
  const gateway = new PwceGatewayClient({ ...options, fetchImpl: async () => { calls++; return json({}); } });
  await assert.rejects(gateway.request({ operation: "health.get", text: "é".repeat(maxBytes / 2) }), code("limit_exceeded"));
  await assert.rejects(gateway.authority(["x".repeat(maxBytes)]), code("limit_exceeded"));
  await assert.rejects(gateway.request({ operation: "health.get", value: 1n }), code("invalid_request"));
  assert.equal(calls, 0);
});

test("bounded JSON accepts exactly 1 MiB, rejects declared and chunked overflow and cancels readers", async () => {
  const exact = JSON.stringify({ status: "x".repeat(maxBytes - 13) });
  assert.equal(Buffer.byteLength(exact), maxBytes);
  const received = await client(async () => new Response(exact)).health("authority.fixture");
  assert.equal(received.status.length, maxBytes - 13);
  for (const mode of ["declared", "one-chunk", "many-chunks"]) {
    const chunks = mode === "declared" ? [] : mode === "one-chunk" ? [new Uint8Array(maxBytes + 1)] : [new Uint8Array(maxBytes / 2), new Uint8Array(maxBytes / 2), new Uint8Array(1)];
    const source = stream(chunks, false);
    const gateway = client(async () => new Response(source.body, { headers: mode === "declared" ? { "Content-Length": String(maxBytes + 1) } : {} }));
    await assert.rejects(gateway.health("authority.fixture"), code("limit_exceeded"));
    assert.equal(source.cancelled(), 1, mode);
    assert.equal(source.body.locked, false, mode);
  }
});

test("malformed JSON, UTF-8 and non-object envelopes are rejected", async () => {
  for (const value of ["null", "[]", "42", '"text"', "{", "", new Uint8Array([123, 34, 255, 34, 58, 49, 125])]) {
    await assert.rejects(client(async () => new Response(value)).health("authority.fixture"), code("malformed_response"));
  }
});

test("preserves producer denial code and HTTP status without echoing response prose", async () => {
  for (const denied of ["trusted_dispatch_only", "authority_context_expired"]) {
    const gateway = client(async () => json({ error: { code: denied, message: options.token } }, 403));
    await assert.rejects(gateway.authorizeDispatch("authority.fixture", {}), code(denied, 403, "provider"));
  }
  await assert.rejects(client(async () => json({ error: { code: "INVALID "+options.token } }, 401)).health("authority.fixture"), code("http_error", 401, "provider"));
});

test("one default deadline covers negotiation and the operation, without a fresh operation budget", async t => {
  t.mock.method(performance, "now", () => 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: (response: Response) => void;
  let operationSignal: AbortSignal | undefined;
  let operationCalls = 0;
  const gateway = new PwceGatewayClient({ ...options, fetchImpl: async (url, init) => {
    if (String(url).endsWith("profile")) return new Promise(resolve => { release = resolve; });
    if (String(url).endsWith("bundle")) return json(bundle);
    operationCalls++; operationSignal = init?.signal as AbortSignal;
    return new Promise(() => undefined);
  } });
  const pending = gateway.health("authority.fixture");
  const rejected = assert.rejects(pending, code("deadline_exceeded"));
  await turn();
  t.mock.timers.tick(4000);
  release(json(profile));
  await turn();
  assert.equal(operationCalls, 1);
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(operationSignal?.aborted, true);
});

test("negotiation timeout sends no operation and cancels a late transport response", async t => {
  t.mock.method(performance, "now", () => 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: (response: Response) => void;
  const paths: string[] = [];
  const late = stream([], false);
  const gateway = new PwceGatewayClient({ ...options, requestTimeoutMs: 100, fetchImpl: async url => {
    paths.push(String(url));
    return String(url).endsWith("profile") ? new Promise(resolve => { release = resolve; }) : json(bundle);
  } });
  const rejected = assert.rejects(gateway.health("authority.fixture"), code("deadline_exceeded"));
  await turn(); t.mock.timers.tick(100); await rejected;
  release(new Response(late.body)); await turn();
  assert.equal(paths.length, 2);
  assert.equal(late.cancelled(), 1);
});

test("JSON body stall ends at deadline and cancels the reader even if source cancellation never settles", async t => {
  t.mock.method(performance, "now", () => 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancellations++; return new Promise(() => undefined); } });
  const rejected = assert.rejects(client(async () => new Response(body), { requestTimeoutMs: 100 }).health("authority.fixture"), code("deadline_exceeded"));
  await turn(); t.mock.timers.tick(100); await rejected;
  assert.equal(cancellations, 1);
  assert.equal(body.locked, false);
});

test("caller cancellation is prompt, uses safe local reason and never cancels its parent", async () => {
  const controller = new AbortController();
  const source = stream([], false);
  const rejected = assert.rejects(client(async () => new Response(source.body)).health("authority.fixture", controller.signal), code("cancelled"));
  await turn(); controller.abort(new Error(options.token)); await rejected;
  assert.equal(source.cancelled(), 1);
  assert.equal(source.body.locked, false);
  let calls = 0;
  await assert.rejects(client(async () => { calls++; return json({}); }).health("authority.fixture", controller.signal), code("cancelled"));
  assert.equal(calls, 0);
  const healthy = new AbortController();
  await client(async () => json({ status: "known" })).health("authority.fixture", healthy.signal);
  assert.equal(healthy.signal.aborted, false);
});

test("all fetches reject redirects and transport failures cannot leak URLs or tokens", async () => {
  const redirects: unknown[] = [];
  const gateway = new PwceGatewayClient({ ...options, fetchImpl: async (url, init) => {
    redirects.push(init?.redirect);
    if (String(url).endsWith("profile")) return json(profile);
    if (String(url).endsWith("bundle")) return json(bundle);
    throw new Error(`redirect to http://private.example/${options.token}`);
  } });
  await assert.rejects(gateway.health("authority.fixture"), code("unavailable"));
  assert.deepEqual(redirects, ["error", "error", "error"]);
});

test("SSE preserves split UTF-8, CRLF, multiline data and independent frame identifiers", async () => {
  const payload = encoder.encode('id: 9\r\nevent: context.invalidated\r\ndata: café ☕\r\ndata: second line\r\n\r\n: keepalive\r\n\r\nevent: resync.required\ndata: {}\n\n');
  const chunks = Array.from(payload, byte => new Uint8Array([byte]));
  const received = await collect(client(async () => sse(stream(chunks).body)));
  assert.deepEqual(received, [{ id: "9", event: "context.invalidated", data: "café ☕\nsecond line" }, { id: null, event: "resync.required", data: "{}" }]);
});

test("SSE counts the whole multiline frame across chunks and bounds giant unterminated lines", async () => {
  for (const chunks of [
    Array.from({ length: 65 }, () => encoder.encode(`data: ${"x".repeat(16_378)}\n`)),
    [encoder.encode(`data: ${"x".repeat(maxBytes)}`)],
    Array.from({ length: 65 }, () => encoder.encode(`: ${"x".repeat(16_381)}\n`)),
  ]) {
    const source = stream(chunks, false);
    await assert.rejects(collect(client(async () => sse(source.body))), code("limit_exceeded"));
    assert.equal(source.cancelled(), 1);
    assert.equal(source.body.locked, false);
  }
});

test("SSE frame cap resets per complete frame and accepts exactly 1 MiB", async () => {
  const frame = `data: ${"x".repeat(maxBytes - 8)}\n\n`;
  assert.equal(Buffer.byteLength(frame), maxBytes);
  const received = await collect(client(async () => sse(stream([encoder.encode(frame + frame)]).body)));
  assert.equal(received.length, 2);
  assert.equal(received[0]?.data.length, maxBytes - 8);
});

test("SSE content type, truncated frames and malformed UTF-8 fail without emitting incomplete events", async () => {
  const wrong = stream([], false);
  await assert.rejects(collect(client(async () => new Response(wrong.body))), code("malformed_response"));
  assert.equal(wrong.cancelled(), 1);
  for (const payload of [encoder.encode("data: unfinished\n"), encoder.encode("data: unfinished"), new Uint8Array([100, 97, 116, 97, 58, 255, 10, 10])]) {
    await assert.rejects(collect(client(async () => sse(stream([payload]).body))), code("malformed_response"));
  }
});

test("ending a subscription cancels and unlocks the source", async () => {
  const source = stream([encoder.encode("data: first\n\ndata: next\n\n")], false);
  let received = 0;
  for await (const event of client(async () => sse(source.body)).subscribeInvalidations("authority.fixture", "site.fixture")) { assert.equal(event.data, "first"); received++; break; }
  assert.equal(received, 1);
  assert.equal(source.cancelled(), 1);
  assert.equal(source.body.locked, false);
});

test("cancellation while a subscription is suspended cancels the source and rejects buffered next events", async () => {
  const source = stream([encoder.encode("data: first\n\ndata: next\n\n")], false);
  const controller = new AbortController();
  const subscription = client(async () => sse(source.body)).subscribeInvalidations("authority.fixture", "site.fixture", { signal: controller.signal });
  assert.equal((await subscription.next()).value?.data, "first");
  controller.abort();
  assert.equal(source.cancelled(), 1);
  assert.equal(source.body.locked, false, "abort releases the reader while the consumer is suspended");
  await assert.rejects(subscription.next(), code("cancelled"));
  assert.equal(source.body.locked, false);
});

test("SSE stream lifetime remains finite after headers, without retry or automatic reconnect", async t => {
  t.mock.method(performance, "now", () => 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const source = stream([], false);
  const rejected = assert.rejects(collect(client(async () => { calls++; return sse(source.body); })), code("deadline_exceeded"));
  await turn(); t.mock.timers.tick(35_000); await rejected;
  assert.equal(calls, 1);
  assert.equal(source.cancelled(), 1);
  assert.equal(source.body.locked, false);
});

test("SSE headers use the ordinary deadline and preserve authoritative error status", async t => {
  t.mock.method(performance, "now", () => 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(collect(client(async () => new Promise(() => undefined), { requestTimeoutMs: 100, streamLifetimeMs: 500 })), code("deadline_exceeded"));
  await turn(); t.mock.timers.tick(100); await rejected;
  await assert.rejects(collect(client(async () => json({ error: { code: "authority_context_expired" } }, 403))), code("authority_context_expired", 403, "provider"));
});

test("actual HTTP transport rejects redirects and oversized bodies and closes cancelled SSE sockets", { timeout: 10_000 }, async t => {
  let mode = "redirect";
  let followed = 0;
  let streamClosed!: () => void;
  const closed = new Promise<void>(resolve => { streamClosed = resolve; });
  const server = createServer((request, response) => {
    if (request.url?.endsWith("profile")) { response.end(JSON.stringify(profile)); return; }
    if (request.url?.endsWith("bundle")) { response.end(JSON.stringify(bundle)); return; }
    if (request.url === "/forbidden") { followed++; response.end("{}"); return; }
    if (mode === "redirect") { response.writeHead(302, { Location: "/forbidden" }); response.end(); return; }
    if (mode === "oversized") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(`{"status":"${"x".repeat(maxBytes)}"}`); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("id: 1\ndata: first\n\n");
    response.on("close", streamClosed);
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const gateway = new PwceGatewayClient({ ...options, baseUrl: `http://127.0.0.1:${address.port}` });
  await assert.rejects(gateway.health("authority.fixture"), code("unavailable"));
  assert.equal(followed, 0);
  mode = "oversized";
  await assert.rejects(gateway.health("authority.fixture"), code("limit_exceeded"));
  mode = "events";
  for await (const event of gateway.subscribeInvalidations("authority.fixture", "site.fixture")) { assert.equal(event.data, "first"); break; }
  await closed;
});

test("late synchronous completion fails the monotonic deadline before its timer is serviced", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const gateway = client(async () => { now = 5000; return json({ status: "known" }); });
  await assert.rejects(gateway.health("authority.fixture"), code("deadline_exceeded"));
});
