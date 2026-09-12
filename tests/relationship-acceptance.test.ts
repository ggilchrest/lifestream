import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLifestreamServer } from "../apps/server/src/index.ts";
import { loadConfig } from "../apps/server/src/config/loader.ts";

const config = (root: string) => loadConfig({ defaults: { profile: "test", providers: { inference: "fixture", memory: "fixture", stt: "fixture", tts: "fixture", world: "fixture", capability: "fixture", renderer: "fixture", clock: "fixture" }, storage: { databasePath: join(root, "data", "state.sqlite"), artifactDirectory: join(root, "artifacts") }, authority: { provider: "fixture", authentication: "fixture" }, secretRefs: {} }, profile: {}, environment: {}, cli: {} });
const json = async <T>(response: Response): Promise<T> => await response.json() as T;

test("joined relationship core survives review, comparison, ordinary reply and restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-relationship-acceptance-")); t.after(() => rm(root, { recursive: true, force: true }));
  const start = async () => { const app = createLifestreamServer({ config: config(root) }); await app.start(); return app; };
  const first = await start(); t.after(() => first.shutdown()); let base = `http://127.0.0.1:${first.address().port}`; const auth = () => ({ "content-type": "application/json", "x-lifestream-fixture-session": "joined-acceptance", "x-lifestream-fixture-principal": "human", origin: base });
  const assistant = await json<{ assistantId: string; profile: { profileId: string } }>(await fetch(`${base}/api/admin/v1/assistants`, { method: "POST", headers: auth(), body: JSON.stringify({ displayName: "Joined Fixture Assistant" }) }));
  assert.equal((await fetch(`${base}/api/admin/v1/assistants/${assistant.assistantId}/activate`, { method: "POST", headers: auth(), body: JSON.stringify({ profileId: assistant.profile.profileId, expectedActiveRevision: null }) })).status, 200);
  const relationship = await json<{ relationship: { relationshipId: string; revision: number } }>(await fetch(`${base}/api/admin/v1/assistants/${assistant.assistantId}/relationships`, { method: "POST", headers: auth(), body: JSON.stringify({ userId: "human" }) }));
  const path = `${base}/api/admin/v1/assistants/${assistant.assistantId}/relationships/${relationship.relationship.relationshipId}`;
  const candidate = await json<{ candidate: { candidateId: string } }>(await fetch(`${path}/candidates`, { method: "POST", headers: auth(), body: JSON.stringify({ content: "Prefers concise explanations", source: "synthetic-note", sourceFamily: "fixture-direct", uncertainty: "low", expectedRevision: 1, idempotencyKey: "joined-candidate" }) }));
  assert.equal((await fetch(`${path}/candidates/${candidate.candidate.candidateId}/decision`, { method: "POST", headers: auth(), body: JSON.stringify({ decision: "approved", expectedRevision: 2, idempotencyKey: "joined-decision" }) })).status, 200);
  const draft = await json<{ configuration: { configurationId: string; revision: number } }>(await fetch(`${path}/configurations`, { method: "POST", headers: auth(), body: JSON.stringify({ preset: "concise", controls: { verbosity: 0.2 }, idempotencyKey: "joined-config" }) }));
  assert.equal((await fetch(`${path}/configurations/${draft.configuration.configurationId}/activate`, { method: "POST", headers: auth(), body: JSON.stringify({ expectedRevision: draft.configuration.revision, idempotencyKey: "joined-config-activate" }) })).status, 200);
  const insights = await json<{ insights: unknown[] }>(await fetch(`${path}/insights`, { method: "POST", headers: auth(), body: "{}" })); assert.equal(insights.insights.length, 5);
  const lab = await json<{ lab: { scenarioIds: string[] } }>(await fetch(`${path}/lab`, { method: "POST", headers: auth(), body: JSON.stringify({ scenarioIds: ["scenario-1", "held-out-1"], heldOutScenarioIds: ["held-out-1"], criteria: [{ id: "fit", description: "appropriate communication", weight: 1 }], repeatedRuns: 2 }) })); assert.deepEqual(lab.lab.scenarioIds, ["scenario-1", "held-out-1"]);
  const comparison = await json<{ lab: { status: string; comparison: { resultCount: number; heldOutExcluded: string[] } } }>(await fetch(`${path}/lab/run`, { method: "POST", headers: auth(), body: "{}" })); assert.equal(comparison.lab.status, "completed"); assert.equal(comparison.lab.comparison.resultCount, 12); assert.deepEqual(comparison.lab.comparison.heldOutExcluded, ["held-out-1"]);
  const reply = await (await fetch(`${base}/api/runtime/v1/messages`, { method: "POST", headers: auth(), body: JSON.stringify({ assistantId: assistant.assistantId, relationshipId: relationship.relationship.relationshipId, userInput: "Give a concise response." }) })).text(); assert.match(reply, /relationship-context:prepared-v1/); assert.match(reply, /Fixture response/);
  await first.shutdown(); const second = await start(); t.after(() => second.shutdown()); base = `http://127.0.0.1:${second.address().port}`; const restored = await json<{ relationships: { relationshipId: string; candidates: { status: string }[] }[] }>(await fetch(`${base}/api/admin/v1/assistants/${assistant.assistantId}/relationships`, { headers: auth() })); assert.equal(restored.relationships[0]?.relationshipId, relationship.relationship.relationshipId); assert.equal(restored.relationships[0]?.candidates[0]?.status, "approved");
});
