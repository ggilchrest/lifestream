import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLifestreamServer } from "../src/index.ts";
import { loadConfig } from "../src/config/loader.ts";
import { ProviderRegistry } from "../src/composition/providers.ts";

const config = (root: string) => loadConfig({ defaults: { profile: "test", providers: { inference: "fixture", memory: "fixture", stt: "fixture", tts: "fixture", world: "fixture", capability: "fixture", renderer: "fixture", clock: "fixture" }, storage: { databasePath: join(root, "data", "state.sqlite"), artifactDirectory: join(root, "artifacts") }, authority: { provider: "fixture", authentication: "fixture" }, secretRefs: {} }, profile: {}, environment: {}, cli: {} });

test('readiness refreshes after a provider outage and recovery; liveness does not probe', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lifestream-fresh-health-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  let available = true, calls = 0;
  t.mock.method(ProviderRegistry.prototype, 'probe', async function(this: ProviderRegistry) {
    calls++;
    this.providers.inference = {...this.providers.inference, required:true, status:available?'healthy':'unavailable'};
  });
  const app = createLifestreamServer({config:config(root)}); await app.start(); t.after(() => app.shutdown());
  const base = `http://127.0.0.1:${app.address().port}`;
  available = false;
  const before = calls; assert.equal((await fetch(`${base}/health/live`)).status, 200); assert.equal(calls, before);
  const down = await fetch(`${base}/health`); assert.equal(down.status, 503); assert.equal((await down.json() as any).providers.inference.status, 'unavailable');
  available = true;
  const up = await fetch(`${base}/health/ready`); assert.equal(up.status, 200); assert.equal((await up.json() as any).status, 'ready');
});

test("relationship configuration reset and rollback create reviewable drafts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-relationship-reset-")); t.after(async () => rm(root, { recursive: true, force: true }));
  const app = createLifestreamServer({ config: config(root) }); await app.start(); t.after(() => app.shutdown()); const base = `http://127.0.0.1:${app.address().port}`; const auth = { "content-type": "application/json", "x-lifestream-fixture-session": "relationship-reset", "x-lifestream-fixture-principal": "human", origin: base };
  const created = await (await fetch(`${base}/api/admin/v1/assistants`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "Reset Fixture" }) })).json() as { assistantId: string };
  const relationship = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/relationships`, { method: "POST", headers: auth, body: JSON.stringify({ userId: "human" }) })).json() as { relationship: { relationshipId: string } };
  const path = `${base}/api/admin/v1/assistants/${created.assistantId}/relationships/${relationship.relationship.relationshipId}`;
  const first = await (await fetch(`${path}/configurations`, { method: "POST", headers: auth, body: JSON.stringify({ preset: "balanced" }) })).json() as { configuration: { configurationId: string; revision: number } };
  await fetch(`${path}/configurations/${first.configuration.configurationId}/activate`, { method: "POST", headers: auth, body: JSON.stringify({ expectedRevision: first.configuration.revision }) });
  const second = await (await fetch(`${path}/configurations`, { method: "POST", headers: auth, body: JSON.stringify({ preset: "coaching" }) })).json() as { configuration: { configurationId: string; revision: number } };
  await fetch(`${path}/configurations/${second.configuration.configurationId}/activate`, { method: "POST", headers: auth, body: JSON.stringify({ expectedRevision: second.configuration.revision }) });
  const rollback = await fetch(`${path}/configurations/${first.configuration.configurationId}/rollback`, { method: "POST", headers: auth, body: JSON.stringify({ expectedRevision: first.configuration.revision }) }); assert.equal(rollback.status, 201); const rollbackBody = await rollback.json() as { rollbackOf: string; previewOnly: boolean; configuration: { status: string; preset: string } }; assert.equal(rollbackBody.rollbackOf, first.configuration.configurationId); assert.equal(rollbackBody.previewOnly, true); assert.equal(rollbackBody.configuration.status, "draft"); assert.equal(rollbackBody.configuration.preset, "balanced");
  const reset = await fetch(`${path}/configurations`, { method: "POST", headers: auth, body: JSON.stringify({ action: "reset" }) }); assert.equal(reset.status, 201); const resetBody = await reset.json() as { resetTo: string; configuration: { status: string; preset: string } }; assert.equal(resetBody.resetTo, second.configuration.configurationId); assert.equal(resetBody.configuration.status, "draft"); assert.equal(resetBody.configuration.preset, "coaching");
});

test("relationship configuration and effective-context inspection stay scoped and revision checked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-relationship-config-")); t.after(async () => rm(root, { recursive: true, force: true }));
  const app = createLifestreamServer({ config: config(root) }); await app.start(); t.after(() => app.shutdown()); const base = `http://127.0.0.1:${app.address().port}`; const auth = { "content-type": "application/json", "x-lifestream-fixture-session": "relationship-config", "x-lifestream-fixture-principal": "human", origin: base };
  const created = await (await fetch(`${base}/api/admin/v1/assistants`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "Configuration Fixture" }) })).json() as { assistantId: string };
  const relationship = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/relationships`, { method: "POST", headers: auth, body: JSON.stringify({ userId: "human" }) })).json() as { relationship: { relationshipId: string } };
  const path = `${base}/api/admin/v1/assistants/${created.assistantId}/relationships/${relationship.relationship.relationshipId}`;
  const draftResponse = await fetch(`${path}/configurations`, { method: "POST", headers: auth, body: JSON.stringify({ preset: "concise", controls: { verbosity: 0.15 } }) }); assert.equal(draftResponse.status, 201); const draft = await draftResponse.json() as { configuration: { configurationId: string; revision: number; status: string; controls: Record<string, number> } }; assert.equal(draft.configuration.status, "draft"); assert.equal(draft.configuration.controls.verbosity, 0.15);
  const inspector = await (await fetch(`${path}/effective-context`, { headers: auth })).json() as { activeConfiguration: unknown; limitations: string[] }; assert.equal(inspector.activeConfiguration, null); assert.ok(inspector.limitations.some((item) => item.includes("not causal proof")));
  assert.equal((await fetch(`${path}/configurations/${draft.configuration.configurationId}/activate`, { method: "POST", headers: auth, body: JSON.stringify({ expectedRevision: draft.configuration.revision - 1 }) })).status, 409);
  assert.equal((await fetch(`${path}/configurations/${draft.configuration.configurationId}/activate`, { method: "POST", headers: auth, body: JSON.stringify({ expectedRevision: draft.configuration.revision }) })).status, 200);
  const active = await (await fetch(`${path}/effective-context`, { headers: auth })).json() as { activeConfiguration: { preset: string } }; assert.equal(active.activeConfiguration.preset, "concise");
});

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
  assert.deepEqual(health.migrations.ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15]);
  assert.equal(health.providers.inference.implementation, "@lifestream/providers-fixture");
  assert.equal(health.providers.inference.fixture, true);
  assert.equal((await fetch(`${base}/api/runtime/v1/profile`)).status, 200);
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
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/activate`, { method: "POST", headers: auth, body: JSON.stringify({ profileId: created.profile.profileId, expectedActiveRevision: null }) })).status, 200);
  const revisionResponse = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/revisions`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "Updated Assistant", adaptivePersonaPolicy: { dimensions: [{ key: "warmth", valueType: "number", minimum: 0, maximum: 1, maxDeltaPerDreamingRun: 0.1, sensitive: false, activation: "automatic" }] } }) }); assert.equal(revisionResponse.status, 201);
  const revision = await revisionResponse.json() as { profile: { profileId: string; revision: number; corePersona: { canonicalName: string; values: string[]; prohibitions: string[] } } }; assert.equal(revision.profile.revision, 2); assert.equal(revision.profile.corePersona.canonicalName, "Updated Assistant"); assert.ok(revision.profile.corePersona.values.length > 0); assert.ok(revision.profile.corePersona.prohibitions.length > 0);
  const activatedResponse = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/activate`, { method: "POST", headers: auth, body: JSON.stringify({ profileId: revision.profile.profileId, expectedActiveRevision: 1 }) }); assert.equal(activatedResponse.status, 200);
  const afterActivation = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}`, { headers: auth })).json() as { profiles: { profileId: string; status: string }[] }; assert.equal(afterActivation.profiles.find((profile) => profile.profileId === created.profile.profileId)?.status, "superseded");
  const exported = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/export`, { headers: auth })).json() as { dataScope: string; assistantId: string; profiles: unknown[] }; assert.equal(exported.dataScope, "assistant-profiles"); assert.equal(exported.assistantId, created.assistantId); assert.equal(exported.profiles.length, 2);
  const importedPreview = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/import`, { method: "POST", headers: auth, body: JSON.stringify({ schemaVersion: "1.0.0", dataScope: "assistant-profiles", assistantId: created.assistantId, expectedRevision: 2, profile: { displayName: "Imported preview", corePersona: { identityStatement: "A reviewed imported definition." } } }) }); assert.equal(importedPreview.status, 200); const importedPreviewBody = await importedPreview.json() as { previewOnly: boolean; imported: boolean; draft: { displayName: string }; changedFields: string[] }; assert.equal(importedPreviewBody.previewOnly, true); assert.equal(importedPreviewBody.imported, true); assert.equal(importedPreviewBody.draft.displayName, "Imported preview"); assert.ok(importedPreviewBody.changedFields.includes("displayName"));
  const exportedProfilePreview = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/import`, { method: "POST", headers: auth, body: JSON.stringify({ schemaVersion: "1.0.0", dataScope: "assistant-profiles", assistantId: created.assistantId, expectedRevision: 2, profile: exported.profiles[1] }) }); assert.equal(exportedProfilePreview.status, 200);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/import`, { method: "POST", headers: auth, body: JSON.stringify({ schemaVersion: "1.0.0", dataScope: "assistant-profiles", assistantId: created.assistantId, expectedRevision: 1, profile: { displayName: "Stale import" } }) })).status, 409);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/import`, { method: "POST", headers: auth, body: JSON.stringify({ schemaVersion: "1.0.0", dataScope: "assistant-profiles", assistantId: created.assistantId, profile: { apiKey: "not-accepted" } }) })).status, 422);
  const preview = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/preview`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "Preview only", expectedRevision: 2 }) }); assert.equal(preview.status, 200);
  const previewBody = await preview.json() as { previewOnly: boolean; draft: { displayName: string }; changedFields: string[] }; assert.equal(previewBody.previewOnly, true); assert.equal(previewBody.draft.displayName, "Preview only"); assert.ok(previewBody.changedFields.includes("displayName"));
  const unchanged = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}`, { headers: auth })).json() as { profiles: unknown[] }; assert.equal(unchanged.profiles.length, 2, "preview must not persist a revision");
  const previewMemories = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories`, { headers: auth })).json() as { memories: unknown[] }; assert.deepEqual(previewMemories.memories, [], "preview must not mutate conversational memory");
  const memoryResponse = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories`, { method: "POST", headers: auth, body: JSON.stringify({ content: "Prefers concise answers" }) }); assert.equal(memoryResponse.status, 201);
  const memoryBody = await memoryResponse.json() as { memory: { id: string; assistantId: string; content: string; lifecycle: { status: string; revision: number }; provenance: { actor: string } } }; assert.equal(memoryBody.memory.assistantId, created.assistantId); assert.equal(memoryBody.memory.lifecycle.status, "candidate"); assert.equal(memoryBody.memory.provenance.actor, "human");
  const transitionResponse = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/${memoryBody.memory.id}/lifecycle`, { method: "POST", headers: auth, body: JSON.stringify({ status: "active", expectedRevision: 1, reason: "Human reviewed" }) }); assert.equal(transitionResponse.status, 200);
  const transitioned = await transitionResponse.json() as { memory: { lifecycle: { status: string; revision: number } }; historyAppended: boolean }; assert.equal(transitioned.memory.lifecycle.status, "active"); assert.equal(transitioned.memory.lifecycle.revision, 2); assert.equal(transitioned.historyAppended, true);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/${memoryBody.memory.id}/lifecycle`, { method: "POST", headers: auth, body: JSON.stringify({ status: "candidate", expectedRevision: 2 }) })).status, 409);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/${memoryBody.memory.id}/lifecycle`, { method: "POST", headers: auth, body: JSON.stringify({ status: "contradicted", expectedRevision: 1 }) })).status, 409);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/${memoryBody.memory.id}/lifecycle`, { method: "POST", headers: auth, body: JSON.stringify({ status: "contradicted", expectedRevision: "1" }) })).status, 422);
  const history = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/${memoryBody.memory.id}/history`, { headers: auth })).json() as { history: { revision: number; eventType: string }[] }; assert.deepEqual(history.history.map((event) => [event.revision, event.eventType]), [[1, "created"], [2, "lifecycleChanged"]]);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/unknown-memory/history`, { headers: auth })).status, 404);
  const correction = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/${memoryBody.memory.id}/correction`, { method: "POST", headers: auth, body: JSON.stringify({ content: "Prefers short answers" }) }); assert.equal(correction.status, 202); const correctionBody = await correction.json() as { applied: boolean; reviewRequired: boolean; event: { revision: number; eventType: string } }; assert.equal(correctionBody.applied, false); assert.equal(correctionBody.reviewRequired, true); assert.deepEqual([correctionBody.event.revision, correctionBody.event.eventType], [3, "correctionProposed"]);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/${memoryBody.memory.id}/correction`, { method: "POST", headers: auth, body: JSON.stringify({ content: "Prefers concise answers" }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/${memoryBody.memory.id}/lifecycle`, { method: "POST", headers: auth, body: JSON.stringify({ status: "contradicted", expectedRevision: 2 }) })).status, 200);
  const postCorrectionHistory = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/${memoryBody.memory.id}/history`, { headers: auth })).json() as { history: { revision: number; eventType: string }[] }; assert.deepEqual(postCorrectionHistory.history.map((event) => [event.revision, event.eventType]), [[1, "created"], [2, "lifecycleChanged"], [3, "correctionProposed"], [4, "lifecycleChanged"]]);
  const unchangedMemory = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories`, { headers: auth })).json() as { memories: { content: string }[] }; assert.equal(unchangedMemory.memories[0]?.content, "Prefers concise answers");
  const adaptationResponse = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/adaptations`, { method: "POST", headers: auth, body: JSON.stringify({ dimensionKey: "warmth", priorValue: 0.5, proposedValue: 0.55, evidence: ["memory-1", "interaction-1"] }) }); assert.equal(adaptationResponse.status, 201); const adaptationBody = await adaptationResponse.json() as { adaptation: { id: string; status: string; createdBy: string } }; assert.equal(adaptationBody.adaptation.status, "proposed"); assert.equal(adaptationBody.adaptation.createdBy, "human");
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/adaptations`, { method: "POST", headers: auth, body: JSON.stringify({ dimensionKey: "warmth", priorValue: 0.5, proposedValue: 0.8, evidence: ["interaction-1"] }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/adaptations`, { method: "POST", headers: auth, body: JSON.stringify({ dimensionKey: "warmth", priorValue: 0.5, proposedValue: 0.5, evidence: ["interaction-1"] }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/adaptations`, { method: "POST", headers: auth, body: JSON.stringify({ dimensionKey: "warmth", priorValue: 0.5, proposedValue: 0.55, evidence: [{ grant: "live" }] }) })).status, 422);
  const decision = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/adaptations/${adaptationBody.adaptation.id}/decision`, { method: "POST", headers: auth, body: JSON.stringify({ status: "active" }) }); assert.equal(decision.status, 200);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/adaptations/${adaptationBody.adaptation.id}/decision`, { method: "POST", headers: auth, body: JSON.stringify({ status: "reversed", expectedStatus: 7 }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/adaptations/${adaptationBody.adaptation.id}/decision`, { method: "POST", headers: auth, body: JSON.stringify({ status: "reversed", expectedStatus: "proposed" }) })).status, 409);
  const listedAdaptations = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/adaptations`, { headers: auth })).json() as { adaptations: { status: string; evidence: string[]; createdBy: string }[] }; assert.deepEqual(listedAdaptations.adaptations.map((adaptation) => adaptation.status), ["active"]); assert.deepEqual(listedAdaptations.adaptations[0]?.evidence, ["memory-1", "interaction-1"]); assert.equal(listedAdaptations.adaptations[0]?.createdBy, "human");
  const adaptationHistory = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/adaptations/${adaptationBody.adaptation.id}/history`, { headers: auth })).json() as { history: { revision: number; eventType: string }[] }; assert.deepEqual(adaptationHistory.history.map((event) => [event.revision, event.eventType]), [[1, "created"], [2, "decision"]]);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/adaptations/${adaptationBody.adaptation.id}/decision`, { method: "POST", headers: auth, body: JSON.stringify({ status: "reversed", expectedStatus: "active" }) })).status, 200);
  const reversedHistory = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/adaptations/${adaptationBody.adaptation.id}/history`, { headers: auth })).json() as { history: { revision: number; eventType: string }[] }; assert.deepEqual(reversedHistory.history.map((event) => [event.revision, event.eventType]), [[1, "created"], [2, "decision"], [3, "decision"]]);
  const memories = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories`, { headers: auth })).json() as { memories: { content: string }[] }; assert.deepEqual(memories.memories.map((memory) => memory.content), ["Prefers concise answers"]);
  const memoryExport = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/export`, { headers: auth })).json() as { dataScope: string; assistantId: string; memories: unknown[] }; assert.equal(memoryExport.dataScope, "assistant-memories"); assert.equal(memoryExport.assistantId, created.assistantId); assert.equal(memoryExport.memories.length, 1);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/import`, { method: "POST", headers: auth, body: JSON.stringify({ dataScope: "assistant-memories", assistantId: created.assistantId, memories: [{ ...(memoryExport.memories[0] as object), assistantId: "foreign-assistant" }] }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/import`, { method: "POST", headers: auth, body: JSON.stringify({ dataScope: "assistant-memories", assistantId: created.assistantId, memories: [{ ...(memoryExport.memories[0] as object), provenance: { grant: "live" } }] }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/import`, { method: "POST", headers: auth, body: JSON.stringify({ dataScope: "assistant-memories", assistantId: created.assistantId, memories: [{ ...(memoryExport.memories[0] as object), lifecycle: { status: "unknown", revision: 1 } }] }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/import`, { method: "POST", headers: auth, body: JSON.stringify({ memories: [memoryExport.memories[0]] }) })).status, 422);
  const importedCandidate = { ...(memoryExport.memories[0] as Record<string, unknown>), id: "imported-memory-id" }; const partialImport = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/import`, { method: "POST", headers: auth, body: JSON.stringify({ dataScope: "assistant-memories", assistantId: created.assistantId, memories: [importedCandidate, memoryExport.memories[0]] }) }); assert.equal(partialImport.status, 422); const afterPartialImport = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories`, { headers: auth })).json() as { memories: unknown[] }; assert.equal(afterPartialImport.memories.length, 1);
  const search = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/search`, { method: "POST", headers: auth, body: JSON.stringify({ query: "CONCISE" }) })).json() as { memories: { content: string }[] }; assert.deepEqual(search.memories.map((memory) => memory.content), ["Prefers concise answers"]);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/search`, { method: "POST", headers: auth, body: JSON.stringify({ query: "" }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories/search`, { method: "POST", headers: auth, body: JSON.stringify({ query: "concise", limit: 0 }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories`, { method: "POST", headers: auth, body: JSON.stringify({ content: "" }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/preview`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "Stale", expectedRevision: 1 }) })).status, 409);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/preview`, { method: "POST", headers: auth, body: JSON.stringify({ apiKey: "not-accepted" }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/activate`, { method: "POST", headers: auth, body: JSON.stringify({ profileId: revision.profileId, expectedActiveRevision: "1" }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/revisions`, { method: "POST", headers: auth, body: JSON.stringify({ corePersona: "not-an-object" }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/revisions`, { method: "POST", headers: auth, body: JSON.stringify({ corePersona: { values: [] } }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/revisions`, { method: "POST", headers: auth, body: JSON.stringify({ adaptivePersonaPolicy: "not-an-object" }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/revisions`, { method: "POST", headers: auth, body: JSON.stringify({ adaptivePersonaPolicy: { dimensions: [{ key: "Warmth", valueType: "number", minimum: 1, maximum: 0 }] } }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/revisions`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "x".repeat(81) }) })).status, 422);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/revisions`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "Stale revision", expectedRevision: 1 }) })).status, 409);
  const rollback = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/rollback`, { method: "POST", headers: auth, body: JSON.stringify({ profileId: created.profile.profileId, expectedActiveRevision: 2 }) }); assert.equal(rollback.status, 201); const rollbackBody = await rollback.json() as { previewOnly: boolean; requiresActivation: boolean; rollbackOf: string; profile: { profileId: string; status: string; rollbackOf: string } }; assert.equal(rollbackBody.previewOnly, false); assert.equal(rollbackBody.requiresActivation, true); assert.equal(rollbackBody.rollbackOf, created.profile.profileId); assert.equal(rollbackBody.profile.status, "draft"); assert.equal(rollbackBody.profile.rollbackOf, created.profile.profileId);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/rollback`, { method: "POST", headers: auth, body: JSON.stringify({ profileId: created.profile.profileId, expectedActiveRevision: 1 }) })).status, 409);
  const rollbackActivation = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/activate`, { method: "POST", headers: auth, body: JSON.stringify({ profileId: rollbackBody.profile.profileId, expectedActiveRevision: 2 }) }); assert.equal(rollbackActivation.status, 200); const activeAfterRollback = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}`, { headers: auth })).json() as { activeProfile: { displayName: string } }; assert.equal(activeAfterRollback.activeProfile.displayName, "Example Assistant");
});

test("shared Assistant administration preserves cross-Assistant isolation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-admin-isolation-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const app = createLifestreamServer({ config: config(root) }); await app.start(); t.after(() => app.shutdown());
  const base = `http://127.0.0.1:${app.address().port}`; const auth = { "content-type": "application/json", "x-lifestream-fixture-session": "s1", "x-lifestream-fixture-principal": "human", origin: base };
  const create = async (displayName: string) => { const response = await fetch(`${base}/api/admin/v1/assistants`, { method: "POST", headers: auth, body: JSON.stringify({ displayName }) }); assert.equal(response.status, 201); return await response.json() as { assistantId: string; profile: { profileId: string } }; };
  const first = await create("First Assistant"); const second = await create("Second Assistant");
  const memoryResponse = await fetch(`${base}/api/admin/v1/assistants/${first.assistantId}/memories`, { method: "POST", headers: auth, body: JSON.stringify({ content: "First-only preference" }) }); assert.equal(memoryResponse.status, 201); const memory = await memoryResponse.json() as { memory: { id: string } };
  const secondMemories = await (await fetch(`${base}/api/admin/v1/assistants/${second.assistantId}/memories`, { headers: auth })).json() as { memories: unknown[] }; assert.deepEqual(secondMemories.memories, []);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${second.assistantId}/memories/${memory.memory.id}/history`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${second.assistantId}/activate`, { method: "POST", headers: auth, body: JSON.stringify({ profileId: first.profile.profileId, expectedActiveRevision: null }) })).status, 404);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${second.assistantId}/import`, { method: "POST", headers: auth, body: JSON.stringify({ schemaVersion: "1.0.0", dataScope: "assistant-profiles", assistantId: first.assistantId, profile: { displayName: "foreign" } }) })).status, 422);
});

test("shared Assistant administration preserves memory continuity across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-admin-restart-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const makeApp = () => createLifestreamServer({ config: config(root) });
  const firstApp = makeApp(); await firstApp.start();
  const base = `http://127.0.0.1:${firstApp.address().port}`; const auth = { "content-type": "application/json", "x-lifestream-fixture-session": "s1", "x-lifestream-fixture-principal": "human", origin: base };
  const createdResponse = await fetch(`${base}/api/admin/v1/assistants`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "Restarted Assistant" }) }); assert.equal(createdResponse.status, 201); const created = await createdResponse.json() as { assistantId: string };
  const memoryResponse = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/memories`, { method: "POST", headers: auth, body: JSON.stringify({ content: "Survives server restart" }) }); assert.equal(memoryResponse.status, 201); const memory = await memoryResponse.json() as { memory: { id: string; lifecycle: { status: string } } }; assert.equal(memory.memory.lifecycle.status, "candidate");
  await firstApp.shutdown();
  const secondApp = makeApp(); await secondApp.start(); t.after(() => secondApp.shutdown());
  const secondBase = `http://127.0.0.1:${secondApp.address().port}`; const secondAuth = { ...auth, origin: secondBase };
  const memories = await (await fetch(`${secondBase}/api/admin/v1/assistants/${created.assistantId}/memories`, { headers: secondAuth })).json() as { memories: { id: string; content: string }[] }; assert.deepEqual(memories.memories.map((record) => [record.id, record.content]), [[memory.memory.id, "Survives server restart"]]);
  const history = await (await fetch(`${secondBase}/api/admin/v1/assistants/${created.assistantId}/memories/${memory.memory.id}/history`, { headers: secondAuth })).json() as { history: { revision: number; eventType: string }[] }; assert.deepEqual(history.history.map((event) => [event.revision, event.eventType]), [[1, "created"]]);
});

test("typed-text runtime streams a canonical manifest and fixture response", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-runtime-")); t.after(async () => rm(root, { recursive: true, force: true }));
  const app = createLifestreamServer({ config: config(root) }); await app.start(); t.after(() => app.shutdown()); const base = `http://127.0.0.1:${app.address().port}`;
  const response = await fetch(`${base}/api/runtime/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-lifestream-fixture-session": "session-1", "x-lifestream-fixture-principal": "human", origin: base }, body: JSON.stringify({ userInput: "hello", readOnlyCapability: { name: "capability.read-only.status", input: { scope: "assistant-neutral" } } }) });
  assert.equal(response.status, 200); const body = await response.text(); assert.match(body, /event: input\.manifest/); assert.match(body, /"schemaVersion":"1\.0\.0"/); assert.match(body, /"sourceRef":"runtime-self-context:v1"/); assert.match(body, /event: capability\.read-only/); assert.match(body, /capability\.read-only\.status/); assert.match(body, /Fixture response: hello/); assert.match(body, /event: interaction\.completed/); assert.match(body, /"provider":\{"profile":"test","implementation":"@lifestream\/providers-fixture","model":"fixture","revision":"workspace","fixture":true\}/);
});

test("development profile selector is explicit, authenticated, and idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-profile-")); t.after(async () => rm(root, { recursive: true, force: true }));
  const app = createLifestreamServer({ config: { ...config(root), profile: "mac-local" } }); await app.start(); t.after(() => app.shutdown()); const base = `http://127.0.0.1:${app.address().port}`;
  const selection = await (await fetch(`${base}/api/runtime/v1/profile`)).json() as { activeProfile: string; selectableProfiles: string[] };
  assert.equal(selection.activeProfile, "mac-local"); assert.deepEqual(selection.selectableProfiles, ["mac-local", "ai5090"]);
  assert.equal((await fetch(`${base}/api/runtime/v1/profile`, { method: "POST", body: JSON.stringify({ profile: "mac-local" }) })).status, 401);
  const selected = await fetch(`${base}/api/runtime/v1/profile`, { method: "POST", headers: { "content-type": "application/json", "x-lifestream-fixture-session": "s1", "x-lifestream-fixture-principal": "human", origin: base }, body: JSON.stringify({ profile: "mac-local" }) });
  assert.equal(selected.status, 200); assert.equal((await selected.json() as { switched: boolean }).switched, false);
});

test("development profile selector atomically swaps a ready profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-profile-swap-")); t.after(async () => rm(root, { recursive: true, force: true }));
  const initial = { ...config(join(root, "mac")), profile: "mac-local" as const };
  const app = createLifestreamServer({ config: initial, profileLoader: (profile) => ({ ...config(join(root, profile)), profile }) }); await app.start(); t.after(() => app.shutdown()); const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { "content-type": "application/json", "x-lifestream-fixture-session": "s1", "x-lifestream-fixture-principal": "human", origin: base };
  const check = await fetch(`${base}/api/runtime/v1/profile`, { method: "POST", headers, body: JSON.stringify({ profile: "ai5090", action: "check" }) });
  assert.equal(check.status, 200); assert.equal((await check.json() as { ready: boolean }).ready, true); assert.equal(app.health.profile, "mac-local", "checking must not switch providers");
  const invalid = await fetch(`${base}/api/runtime/v1/profile`, { method: "POST", headers, body: JSON.stringify({ profile: "ai5090", action: "typo" }) });
  assert.equal(invalid.status, 422); assert.equal(app.health.profile, "mac-local");
  const selected = await fetch(`${base}/api/runtime/v1/profile`, { method: "POST", headers: { "content-type": "application/json", "x-lifestream-fixture-session": "s1", "x-lifestream-fixture-principal": "human", origin: base }, body: JSON.stringify({ profile: "ai5090" }) });
  const body = await selected.json() as { profile: string; switched: boolean; status: string };
  assert.equal(selected.status, 200); assert.deepEqual(body, { ...body, profile: "ai5090", switched: true, status: "ready" }); assert.equal(app.health.profile, "ai5090");
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
test("relationship administration is authenticated, scoped, reviewable and CAS protected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-relationship-")); t.after(async () => rm(root, { recursive: true, force: true }));
  const app = createLifestreamServer({ config: config(root) }); await app.start(); t.after(() => app.shutdown()); const base = `http://127.0.0.1:${app.address().port}`; const auth = { "content-type": "application/json", "x-lifestream-fixture-session": "relationship", "x-lifestream-fixture-principal": "human", origin: base };
  const created = await (await fetch(`${base}/api/admin/v1/assistants`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "Relationship Fixture" }) })).json() as { assistantId: string };
  const relationship = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/relationships`, { method: "POST", headers: auth, body: JSON.stringify({ userId: "human" }) })).json() as { relationship: { relationshipId: string; revision: number } };
  const candidateResponse = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/relationships/${relationship.relationship.relationshipId}/candidates`, { method: "POST", headers: auth, body: JSON.stringify({ content: "Prefers concise replies", source: "synthetic-note", sourceFamily: "fixture", uncertainty: "medium" }) }); assert.equal(candidateResponse.status, 201); const candidate = await candidateResponse.json() as { candidate: { candidateId: string } };
  const decided = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/relationships/${relationship.relationship.relationshipId}/candidates/${candidate.candidate.candidateId}/decision`, { method: "POST", headers: auth, body: JSON.stringify({ decision: "approved", expectedRevision: 2 }) })).json() as { candidate: { status: string } };
  assert.equal(decided.candidate.status, "approved"); assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/relationships/${relationship.relationship.relationshipId}/candidates/${candidate.candidate.candidateId}/decision`, { method: "POST", headers: auth, body: JSON.stringify({ decision: "rejected", expectedRevision: 2 }) })).status, 409);
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/relationships`, { method: "GET", headers: { ...auth, "x-lifestream-fixture-principal": "other" } })).status, 200);
});
test("effective request inspector returns the canonical prepared-memory manifest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-effective-request-")); t.after(async () => rm(root, { recursive: true, force: true }));
  const app = createLifestreamServer({ config: config(root) }); await app.start(); t.after(() => app.shutdown()); const base = `http://127.0.0.1:${app.address().port}`; const auth = { "content-type": "application/json", "x-lifestream-fixture-session": "effective-request", "x-lifestream-fixture-principal": "human", origin: base };
  const created = await (await fetch(`${base}/api/admin/v1/assistants`, { method: "POST", headers: auth, body: JSON.stringify({ displayName: "Inspector Fixture" }) })).json() as { assistantId: string };
  const relationship = await (await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/relationships`, { method: "POST", headers: auth, body: JSON.stringify({ userId: "human" }) })).json() as { relationship: { relationshipId: string } };
  const response = await fetch(`${base}/api/admin/v1/assistants/${created.assistantId}/relationships/${relationship.relationship.relationshipId}/effective-request`, { method: "POST", headers: auth, body: JSON.stringify({ userInput: "How should we proceed?" }) }); assert.equal(response.status, 200); const body = await response.json() as { observedInferenceResponse: boolean; preparedRequest: { manifest: { sections: { kind: string; sourceRef: string; tokenCount: number }[] }; preparedMemory: { sourceRef: string; tokenCount: number } } }; assert.equal(body.observedInferenceResponse, false); assert.equal(body.preparedRequest.preparedMemory.sourceRef, "relationship-context:prepared-v1"); assert.equal(body.preparedRequest.manifest.sections.find((section) => section.kind === "preparedMemory")?.sourceRef, "relationship-context:prepared-v1"); assert.ok(body.preparedRequest.preparedMemory.tokenCount > 0);
});
