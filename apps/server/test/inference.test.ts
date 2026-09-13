import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { InferenceChunk, InferenceProvider } from "@lifestream/runtime/inference";
import { streamMessage } from "../src/runtime/inference.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureInferenceProvider } from "@lifestream/runtime/inference/fixture";
import { createLifestreamServer } from "../src/index.ts";
import { loadProfile } from "../src/config/loader.ts";
import type { InferenceRequest } from "@lifestream/runtime/inference";

test("actual typed runtime uses active profile and host modality truth, ignoring client claims", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-self-context-")); t.after(() => rm(root, { recursive: true, force: true }));
  const selected = loadProfile("test"); const app = createLifestreamServer({ config: { ...selected, storage: { databasePath: join(root, "data.sqlite"), artifactDirectory: join(root, "artifacts") } } }); await app.start(); t.after(() => app.shutdown());
  const base = `http://127.0.0.1:${app.address().port}`; const headers = { "content-type": "application/json", "x-lifestream-fixture-session": "s071", "x-lifestream-fixture-principal": "synthetic-owner", origin: base };
  const post = async (path: string, body: unknown) => (await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;
  const created = await post("/api/admin/v1/assistants", { displayName: "Synthetic Active", corePersona: { identityStatement: "A synthetic testing Assistant." } });
  await post(`/api/admin/v1/assistants/${created.assistantId}/activate`, { profileId: created.profile.profileId, expectedActiveRevision: null });
  const original = FixtureInferenceProvider.prototype.generate; let captured: InferenceRequest | undefined;
  FixtureInferenceProvider.prototype.generate = async function* (request, context) { captured = request; yield* original.call(this, request, context); }; t.after(() => { FixtureInferenceProvider.prototype.generate = original; });
  const response = await fetch(base + "/api/runtime/v1/messages", { method: "POST", headers, body: JSON.stringify({ assistantId: created.assistantId, userInput: "hello", endpointId: "client-claimed-endpoint", runtimeSelfContext: { microphone: "active", authority: "owner" }, profileProjection: { corePersona: "CLIENT_OVERRIDE" } }) }); assert.equal(response.status, 200); await response.text();
  assert.ok(captured); assert.equal(captured.scope.endpointId, null); const state = captured.sections.find((section) => section.kind === "interactionState")!; assert.match(state.content, /input.microphone=inactive/u); assert.match(state.content, /output.speechGeneration=unavailable/u); assert.match(state.content, /output.speechDelivery=notObserved/u); assert.match(state.sourceRevision, /^[a-f0-9]{64}$/u);
  const core = captured.sections.find((section) => section.kind === "corePersona")!; assert.match(core.content, /Synthetic Active/u); assert.doesNotMatch(core.content, /CLIENT_OVERRIDE/u); assert.equal(core.sourceRef, `assistant-profile:${created.profile.profileId}`); assert.match(core.sourceRevision, /^1:adaptations:/u);
});

test("profile activation fences an already generating typed reply before late output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-self-fence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const selected = loadProfile("test"); const app = createLifestreamServer({ config: { ...selected, storage: { databasePath: join(root, "data.sqlite"), artifactDirectory: join(root, "artifacts") } } }); await app.start(); t.after(() => app.shutdown());
  const base = `http://127.0.0.1:${app.address().port}`; const headers = { "content-type": "application/json", "x-lifestream-fixture-session": "s071", "x-lifestream-fixture-principal": "synthetic-owner", origin: base };
  const post = async (path: string, body: unknown) => (await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;
  const created = await post("/api/admin/v1/assistants", { displayName: "Synthetic Before" }); const path = `/api/admin/v1/assistants/${created.assistantId}`;
  await post(path + "/activate", { profileId: created.profile.profileId, expectedActiveRevision: null });
  const original = FixtureInferenceProvider.prototype.generate; let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  FixtureInferenceProvider.prototype.generate = async function* () { await held; yield { kind: "text", text: "STALE_PRIVATE_OUTPUT" }; yield { kind: "done" }; }; t.after(() => { FixtureInferenceProvider.prototype.generate = original; });
  const response = await fetch(base + "/api/runtime/v1/messages", { method: "POST", headers, body: JSON.stringify({ assistantId: created.assistantId, userInput: "hello" }) }); const output = response.text();
  const revision = await post(path + "/revisions", { displayName: "Synthetic After", expectedRevision: 1 }); await post(path + "/activate", { profileId: revision.profile.profileId, expectedActiveRevision: 1 }); release();
  const text = await output; assert.doesNotMatch(text, /STALE_PRIVATE_OUTPUT/u); assert.match(text, /runtime_input_stale/u); assert.doesNotMatch(text, /event: interaction.completed/u);
});

test("typed stream admits one terminal and rejects missing or thrown provider completion", async (t) => {
  for (const mode of ["duplicate", "missing", "throw"] as const) {
    const provider: InferenceProvider = { async *generate(): AsyncIterable<InferenceChunk> { yield { kind: "text", text: "synthetic" }; if (mode === "throw") throw new Error("private provider diagnostics must not escape"); if (mode === "duplicate") { yield { kind: "done" }; yield { kind: "text", text: "late" }; yield { kind: "done" }; } } };
    const server = createServer((_request, response) => { void streamMessage(response, provider, { userInput: "synthetic" }, "session", new AbortController().signal); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`); const body = await response.text();
    assert.equal([...body.matchAll(/event: interaction\.(?:completed|error)/gu)].length, 1); assert.doesNotMatch(body, /private provider diagnostics|"late"/u);
    assert.match(body, mode === "duplicate" ? /event: interaction\.completed/u : /event: interaction\.error/u);
  }
});
