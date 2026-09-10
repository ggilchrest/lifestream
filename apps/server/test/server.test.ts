import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLifestreamServer } from "../src/index.ts";
import { loadConfig } from "../src/config/loader.ts";

const config = (root: string) => loadConfig({ defaults: { profile: "test", providers: { inference: "fixture", memory: "fixture", stt: "fixture", tts: "fixture", world: "fixture", capability: "fixture", renderer: "fixture", clock: "fixture" }, storage: { databasePath: join(root, "data", "state.sqlite"), artifactDirectory: join(root, "artifacts") }, authority: { provider: "fixture", authentication: "fixture" }, secretRefs: {} }, profile: {}, environment: {}, cli: {} });

test("fixture package exposes distinct health states, UI, and authenticated authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-server-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const app = createLifestreamServer({ config: config(root) });
  await app.start();
  t.after(() => app.shutdown());
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  assert.equal((await fetch(`${base}/health/ready`)).status, 200);
  const health = await (await fetch(`${base}/health/ready`)).json() as { migrations: { ids: number[] }; providers: Record<string, { implementation: string; fixture: boolean }> };
  assert.deepEqual(health.migrations.ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]);
  assert.equal(health.providers.inference.implementation, "@lifestream/providers-fixture");
  assert.equal(health.providers.inference.fixture, true);
  const conversation = await fetch(`${base}/control/conversation.html`);
  assert.equal(conversation.status, 200);
  assert.equal(conversation.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal((await fetch(`${base}/api/authority/v1/requests`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/api/runtime/v1/tts`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/api/runtime/v1/stt`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/api/authority/v1/requests`, { method: "POST", headers: { "x-lifestream-fixture-session": "s1", "x-lifestream-fixture-principal": "human", origin: base }, body: "{}" })).status, 202);
});

test("fixture Assistant administration persists revisions and requires authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-admin-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const app = createLifestreamServer({ config: config(root) }); await app.start(); t.after(() => app.shutdown());
  const base = `http://127.0.0.1:${app.address().port}`; const auth = { "content-type": "application/json", "x-lifestream-fixture-session": "s1", "x-lifestream-fixture-principal": "human", origin: base };
  assert.equal((await fetch(`${base}/api/admin/v1/assistants`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const createdResponse = await fetch(`${base}/api/admin/v1/assistants`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "Example Assistant" }) }); assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { assistantId: string; profile: { profileId: string } };
  const revisionResponse = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/revisions`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "Updated Assistant" }) }); assert.equal(revisionResponse.status, 201);
  const revision = await revisionResponse.json() as { profile: { profileId: string; revision: number } }; assert.equal(revision.profile.revision, 2);
  const activatedResponse = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/activate`, { method: "POST", headers: auth, body: JSON.stringify({ profileId: revision.profile.profileId, expectedActiveRevision: null }) }); assert.equal(activatedResponse.status, 200);
  const exported = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/export`, { headers: auth })).json() as { profiles: unknown[] }; assert.equal(exported.profiles.length, 2);
});

test("typed-text runtime streams a canonical manifest and fixture response", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-runtime-")); t.after(async () => rm(root, { recursive: true, force: true }));
  const app = createLifestreamServer({ config: config(root) }); await app.start(); t.after(() => app.shutdown()); const base = `http://127.0.0.1:${app.address().port}`;
  const response = await fetch(`${base}/api/runtime/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-lifestream-fixture-session": "session-1", "x-lifestream-fixture-principal": "human", origin: base }, body: JSON.stringify({ userInput: "hello", readOnlyCapability: { name: "capability.read-only.status", input: { scope: "assistant-neutral" } } }) });
  assert.equal(response.status, 200); const body = await response.text(); assert.match(body, /event: input\.manifest/); assert.match(body, /"schemaVersion":"1\.0\.0"/); assert.match(body, /event: capability\.read-only/); assert.match(body, /capability\.read-only\.status/); assert.match(body, /Fixture response: hello/); assert.match(body, /event: interaction\.completed/);
});

test("restart recreates persistent paths and readiness", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-server-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const first = createLifestreamServer({ config: config(root) });
  await first.start();
  await first.shutdown();
  const second = createLifestreamServer({ config: config(root) });
  await second.start();
  t.after(() => second.shutdown());
  assert.equal((await fetch(`http://127.0.0.1:${second.address().port}/health/ready`)).status, 200);
});

test("shutdown drains only until its deadline and production is not a fixture profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-server-"));
  const app = createLifestreamServer({ config: config(root), shutdownDeadlineMs: 10 });
  await app.start();
  const work = app.runBoundedWork(new Promise<void>(() => {}));
  const started = Date.now();
  await app.shutdown();
  assert.ok(Date.now() - started < 500);
  assert.equal(app.health.status, "stopped");
  await rm(root, { recursive: true, force: true });
  assert.throws(() => loadConfig({ defaults: { ...config("."), profile: "production" as never }, profile: {}, environment: {}, cli: {} }), /profile must be test, local-dev, ai5090, or mac-local/);
  void work.catch(() => undefined);
});
