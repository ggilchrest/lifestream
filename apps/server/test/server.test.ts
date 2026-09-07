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
  assert.equal((await fetch(`${base}/control/`)).status, 200);
  assert.equal((await fetch(`${base}/api/authority/v1/requests`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/api/authority/v1/requests`, { method: "POST", headers: { "x-lifestream-fixture-session": "s1", "x-lifestream-fixture-principal": "human", origin: base }, body: "{}" })).status, 202);
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
  assert.throws(() => loadConfig({ defaults: { ...config("."), profile: "production" as never }, profile: {}, environment: {}, cli: {} }), /profile must be test or local-dev/);
  void work.catch(() => undefined);
});
