import test from "node:test";
import assert from "node:assert/strict";
import { PwceContextSession } from "../src/context-session.ts";
import { EXPECTED_PWCE_ARTIFACTS, EXPECTED_PWCE_GENERATED_CLIENT_SHA256, EXPECTED_PWCE_PROFILE, PwceGatewayClient } from "../src/client.ts";

const operations = ["context.getPreparedInputs", "context.query", "evidence.get", "events.subscribe", "authority.evaluate", "authority.authorizeDispatch", "authority.getGrants", "capabilities.getSnapshot", "capabilities.invoke", "capabilities.getInvocation", "trace.publish", "health.get"];
function fixture() {
  const now = new Date().toISOString();
  const scope = { worldRef: "world.fixture", executionEnvironmentRef: "replay" as const, authorityContextRef: "authority.fixture", authorityExpiresAt: new Date(Date.now() + 60_000).toISOString(), siteRef: "home.one", principalRef: "agent.one", sessionId: "session.one", environmentId: "lifestream.test", assistantRef: "assistant.one", endpointRef: "endpoint.one", participantRefs: ["participant.one"], audienceRef: "audience.one" };
  const events: Record<string, unknown>[] = [], calls: Record<string, unknown>[] = [];
  let current = true;
  const controls: { intercept?: (request: Record<string, unknown>, response: Record<string, unknown>) => unknown; replayError?: string; stream?: ReadableStream<Uint8Array> } = {};
  const client = new PwceGatewayClient({ baseUrl: "http://fixture", token: "synthetic-session-token", fetchImpl: async (url, init) => {
    if (String(url).endsWith("profile")) return Response.json({ ...EXPECTED_PWCE_PROFILE, schemaStatus: "published", operationCatalog: operations.map(operation => ({ operation })) });
    if (String(url).endsWith("bundle")) return Response.json({ bundleId: EXPECTED_PWCE_PROFILE.bundleId, bundleVersion: EXPECTED_PWCE_PROFILE.bundleVersion, bundleDigest: EXPECTED_PWCE_PROFILE.schemaDigest, artifacts: EXPECTED_PWCE_ARTIFACTS, generatedClient: { path: "src/gateway/generated-client.js", sha256: EXPECTED_PWCE_GENERATED_CLIENT_SHA256 } });
    if (String(url).includes("/events?")) return new Response(controls.stream, { headers: { "Content-Type": "text/event-stream" } });
    const input = JSON.parse(String(init?.body)); calls.push(input);
    const metadata = { profileId: EXPECTED_PWCE_PROFILE.profileId, profileVersion: EXPECTED_PWCE_PROFILE.profileVersion, requestId: input.requestId, correlationId: input.correlationId, worldRef: input.worldRef, executionEnvironmentRef: input.executionEnvironmentRef };
    let response: Record<string, unknown>;
    if (input.operation === "events.subscribe") {
      if (controls.replayError) return Response.json({ error: { code: controls.replayError } }, { status: 401 });
      response = { ...metadata, siteRef: scope.siteRef, principalRef: scope.principalRef, events: events.filter(event => Number(event.cursor) > Number(input.afterCursor)), nextCursor: String(events.length), hasMore: false, resyncRequired: false };
    } else if (input.operation === "evidence.get") response = { ...metadata, status: "unknown", reason: "evidence_not_found" };
    else response = { ...metadata, siteRef: scope.siteRef, sourceRevision: `revision.${events.length}`, revision: `revision.${events.length}`, evaluatedAt: now, invalidationCursor: String(events.length), knowledgeState: "known", inputs: [{ entityRef: "home.one::sensor.flag", property: "state", siteRef: scope.siteRef, knowledgeState: "current", basis: "observed", evidenceRefs: ["observation.one"], value: false, eventTime: now, recordedAt: now, sourceRef: "source.one", freshnessMs: 60_000, freshnessState: "current", revision: 1, limitations: [] }], sources: [], hasMore: false, limitations: [] };
    await controls.intercept?.(input, response);
    return Response.json(response);
  } });
  const addEvent = () => { const cursor = String(events.length + 1); const event = { eventId: `event.${cursor}`, type: "context.invalidated", cursor, sourceRevision: cursor, affectedRef: "home.one::sensor.flag", watch: { siteRefs: ["home.one"], principalRefs: [] }, reason: "observation_accepted", occurredAt: now, correlationId: "correlation.event" }; events.push(event); return event; };
  const session = new PwceContextSession(client, scope, { isCurrent: () => current, maximumAgeMs: 30_000 });
  return { session, calls, controls, addEvent, changeOwner: () => { current = false; } };
}

test("mapped prepared reads reuse cache only after a fresh scoped authority replay check", async () => {
  const f = fixture(); const first = await f.session.getPreparedInputs(), second = await f.session.getPreparedInputs();
  assert.equal(first.value.items[0]?.value, false); assert.equal(second.isCurrent(), true);
  assert.equal(f.calls.filter(call => call.operation === "context.getPreparedInputs").length, 1);
  assert.equal(f.calls.filter(call => call.operation === "events.subscribe").length, 3);
  for (const call of f.calls) { assert.equal(call.audienceRef, "audience.one"); assert.equal(call.executionEnvironmentRef, "replay"); assert.equal(call.authorityContextRef, "authority.fixture"); assert.equal(call.siteRef, "home.one"); }
  f.addEvent(); const refreshed = await f.session.getPreparedInputs();
  assert.equal(first.isCurrent(), false); assert.equal(refreshed.isCurrent(), true);
  assert.equal(f.calls.filter(call => call.operation === "context.getPreparedInputs").length, 2); f.session.close();
});

test("an invalidation during the read rejects its late response without an automatic retry", async () => {
  const f = fixture();
  f.controls.intercept = input => { if (input.operation === "context.getPreparedInputs") { f.addEvent(); delete f.controls.intercept; } };
  await assert.rejects(f.session.getPreparedInputs(), { code: "read_invalidated" });
  assert.equal(f.calls.filter(call => call.operation === "context.getPreparedInputs").length, 1);
  assert.equal(f.session.status().entries, 0);
  assert.equal((await f.session.getPreparedInputs()).isCurrent(), true); f.session.close();
});

test("owner changes and revoked authority cannot return a cached or late scoped result", async () => {
  for (const change of ["owner", "authority"]) {
    const f = fixture(); const first = await f.session.getPreparedInputs();
    if (change === "owner") f.changeOwner(); else f.controls.replayError = "authority_context_invalidated";
    await assert.rejects(f.session.getPreparedInputs()); assert.equal(first.isCurrent(), false); assert.equal(f.session.status().usable, false);
  }
  const f = fixture(); f.controls.intercept = input => { if (input.operation === "context.getPreparedInputs") f.changeOwner(); };
  await assert.rejects(f.session.getPreparedInputs()); assert.equal(f.session.status().entries, 0);
});

test("evidence references are reauthorized on every expansion and never cached as facts", async () => {
  const f = fixture(); const first = await f.session.getEvidence("missing"); const second = await f.session.getEvidence("missing");
  assert.equal(first.value.status, "unknown"); assert.equal(second.isCurrent(), true); assert.equal(f.session.status().entries, 0);
  assert.equal(f.calls.filter(call => call.operation === "evidence.get").length, 2);
  f.addEvent(); await f.session.getPreparedInputs(); assert.equal(first.isCurrent(), false); f.session.close();
});

test("foreign or malformed replay metadata fails closed before any context request", async () => {
  for (const change of [{ principalRef: "other" }, { worldRef: "other" }, { requestId: "other" }, { events: null }, { nextCursor: "invalid" }, { hasMore: true }]) {
    const f = fixture(); f.controls.intercept = (input, response) => { if (input.operation === "events.subscribe") Object.assign(response, change); };
    await assert.rejects(f.session.getPreparedInputs()); assert.equal(f.calls.filter(call => call.operation === "context.getPreparedInputs").length, 0); f.session.close();
  }
});

test("query input cannot replace host authority, operation, site or audience", async () => {
  const f = fixture();
  for (const extra of [{ operation: "capabilities.invoke" }, { authorityContextRef: "other" }, { siteRef: "other" }, { audienceRef: "other" }, { token: "other" }]) await assert.rejects(f.session.queryContext({ mode: "current", ...extra } as any));
  assert.equal(f.calls.length, 0); f.session.close();
});

test("stream invalidations affect the same read cache and ending the stream clears it", async () => {
  const f = fixture(); const lease = await f.session.getPreparedInputs(); const event = f.addEvent();
  let cancelled = false;
  f.controls.stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)); }, cancel() { cancelled = true; } });
  const subscription = f.session.subscribeInvalidations(); assert.deepEqual((await subscription.next()).value, { disposition: "invalidated" }); assert.equal(lease.isCurrent(), false);
  await subscription.return(undefined); assert.equal(cancelled, true); assert.equal(f.session.status().refreshRequired, true); f.session.close();
});

test("cancellation fences an ignored-abort late response without publishing cache data", async () => {
  const f = fixture(); const abort = new AbortController();
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  f.controls.intercept = async input => { if (input.operation === "context.getPreparedInputs") { entered(); await pending; } };
  const result = f.session.getPreparedInputs(abort.signal); await ready; abort.abort(); await assert.rejects(result); release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.session.status().entries, 0); f.session.close();
});
