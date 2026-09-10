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

test("Mac providers become healthy only when exact Ollama, Moonshine, and Vox identities are ready", async () => {
  const profile = loadConfig({
    defaults: {
      profile: "mac-local",
      providers: { inference: "ollama-mac-local", memory: "fixture", stt: "moonshine-mlx", tts: "voxcpm", world: "fixture", capability: "fixture", renderer: "fixture", clock: "system" },
      providerRequirements: { inference: "required", memory: "required", stt: "required", tts: "required", world: "optional", capability: "optional", renderer: "optional", clock: "required" },
      inferenceProfile: { runtime: "Ollama", runtimeVersion: "0.31.1", model: "Qwen3.5 2B", modelRevision: "sha256:model", servedModelName: "qwen3.5:2b-q4_K_M", quantization: "Q4_K_M", contextLength: 32768, endpoint: "http://local.invalid", modelArtifactDigest: "sha256:model", developmentOnly: true },
      sttProfile: { runtime: "MLX-Audio", runtimeVersion: "mlx-audio@0.5.3", model: "moonshine-ai/moonshine-tiny", modelRevision: "stt-revision", endpoint: "http://stt.invalid", modelArtifactDigest: "sha256:stt-model", mappingRevision: "moonshine-map-1", language: "en", developmentOnly: true },
      ttsProfile: { runtime: "MLX-Audio", runtimeVersion: "mlx-audio@0.5.3", model: "mlx-community/VoxCPM2-4bit", modelRevision: "revision", quantization: "4bit", endpoint: "http://tts.invalid", voiceBundleKey: "fixture-voice-design", voiceBundleRevision: 1, mappingRevision: "voxcpm2-map-1", developmentOnly: true },
      storage: { databasePath: ":memory:", artifactDirectory: ".artifacts" }, authority: { provider: "fixture", authentication: "fixture" }, secretRefs: {}
    }, profile: {}, environment: {}, cli: {}
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3.5:2b-q4_K_M", digest: "model" }] });
    if (url.startsWith("http://stt.invalid")) return Response.json({ status: "ready", runtimeRevision: "mlx-audio@0.5.3", modelRevision: "stt-revision", modelArtifactDigest: "sha256:stt-model", mappingRevision: "moonshine-map-1" });
    return Response.json({ status: "ready", runtimeRevision: "mlx-audio@0.5.3", modelRevision: "revision", mappingRevision: "voxcpm2-map-1" });
  };
  try {
    const registry = createProviderRegistry(profile);
    assert.equal(registry.ready, false);
    await registry.probe();
    assert.equal(registry.providers.inference?.status, "healthy");
    assert.equal(registry.providers.stt?.status, "healthy");
    assert.equal(registry.providers.tts?.status, "healthy");
    assert.equal(registry.ready, true);
  } finally { globalThis.fetch = original; }
});

test("Mac provider health rejects a retagged Ollama model", async () => {
  const profile = loadConfig({
    defaults: {
      profile: "mac-local",
      providers: { inference: "ollama-mac-local", memory: "fixture", stt: "unavailable", tts: "fixture", world: "fixture", capability: "fixture", renderer: "fixture", clock: "system" },
      providerRequirements: { inference: "required", memory: "required", stt: "optional", tts: "required", world: "optional", capability: "optional", renderer: "optional", clock: "required" },
      inferenceProfile: { runtime: "Ollama", runtimeVersion: "0.31.1", model: "Qwen3.5 2B", modelRevision: "sha256:expected", servedModelName: "qwen3.5:2b-q4_K_M", quantization: "Q4_K_M", contextLength: 32768, endpoint: "http://local.invalid", modelArtifactDigest: "sha256:layer", developmentOnly: true },
      storage: { databasePath: ":memory:", artifactDirectory: ".artifacts" }, authority: { provider: "fixture", authentication: "fixture" }, secretRefs: {}
    }, profile: {}, environment: {}, cli: {}
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ models: [{ name: "qwen3.5:2b-q4_K_M", digest: "changed" }] });
  try {
    const registry = createProviderRegistry(profile);
    await registry.probe();
    assert.equal(registry.providers.inference?.status, "unavailable");
    assert.match(registry.providers.inference?.reason ?? "", /identity changed/);
    assert.equal(registry.ready, false);
  } finally { globalThis.fetch = original; }
});
