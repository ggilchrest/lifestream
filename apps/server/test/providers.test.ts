import assert from "node:assert/strict";
import test from "node:test";
import { createProviderRegistry } from "../src/composition/providers.ts";
import { loadConfig } from "../src/config/loader.ts";

const config = (provider: string, requirements = { inference: "required", memory: "required", stt: "required", tts: "required", world: "optional", capability: "optional", renderer: "optional", clock: "required" } as const) => loadConfig({
  defaults: {
    profile: "local-dev",
    providers: { inference: provider, memory: "fixture", stt: "fixture", tts: "fixture", world: "fixture", capability: "fixture", renderer: "fixture", clock: "system" },
    providerRequirements: requirements,
    storage: { databasePath: ":memory:", artifactDirectory: ".artifacts" },
    authority: { provider: "fixture", authentication: "fixture" },
    secretRefs: {}
  }, profile: {}, environment: {}, cli: {}
});

test("provider registry constructs explicit fixture/system identities", () => {
  const registry = createProviderRegistry(config("fixture"));
  assert.equal(registry.providers.inference.implementation, "@lifestream/providers-fixture");
  assert.equal(registry.providers.clock.fixture, false);
  assert.equal(registry.ready, true);
});

test("unknown providers fail closed and unavailable requirements affect readiness", () => {
  assert.throws(() => createProviderRegistry(config("missing-provider")), /unknown provider/);
  assert.equal(createProviderRegistry(config("unavailable")).ready, false);
  assert.equal(createProviderRegistry(config("unavailable", { inference: "optional", memory: "required", stt: "required", tts: "required", world: "optional", capability: "optional", renderer: "optional", clock: "required" })).ready, true);
  assert.equal(createProviderRegistry(config("unavailable")).providers.inference.status, "unavailable");
});
