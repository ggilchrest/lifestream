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
      ttsProfile: { runtime: "MLX-Audio", runtimeVersion: "mlx-audio@0.5.3", model: "mlx-community/VoxCPM2-4bit", modelRevision: "revision", quantization: "4bit", endpoint: "http://tts.invalid", voiceBundleKey: "fixture-voice-design", voiceBundleRevision: 1, mappingRevision: "voxcpm2-map-2", developmentOnly: true },
      storage: { databasePath: ":memory:", artifactDirectory: ".artifacts" }, authority: { provider: "fixture", authentication: "fixture" }, secretRefs: {}
    }, profile: {}, environment: {}, cli: {}
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3.5:2b-q4_K_M", digest: "model" }] });
    if (url.startsWith("http://stt.invalid")) return Response.json({ status: "ready", runtimeRevision: "mlx-audio@0.5.3", modelRevision: "stt-revision", modelArtifactDigest: "sha256:stt-model", mappingRevision: "moonshine-map-1" });
    return Response.json({ status: "ready", runtimeRevision: "mlx-audio@0.5.3", modelRevision: "revision", mappingRevision: "voxcpm2-map-2" });
  };
  try {
    const registry = createProviderRegistry(profile);
    assert.equal(registry.ready, false);
    await registry.probe();
    assert.equal(registry.providers.inference?.status, "healthy");
    assert.equal(registry.providers.stt?.status, "healthy");
    assert.equal(registry.providers.tts?.status, "healthy");
    assert.equal(registry.ready, true);
    let probes = 0;
    globalThis.fetch = async () => { probes++; await new Promise(resolve => setTimeout(resolve, 5)); throw new Error('host stopped'); };
    await Promise.all([registry.probe(), registry.probe(), registry.probe()]);
    assert.equal(probes, 3, 'concurrent callers share one probe per provider');
    assert.equal(registry.ready, false, 'a later outage must replace startup health');
    assert.equal(registry.providers.stt.status, 'unavailable');
    assert.match(registry.providers.stt.reason ?? '', /probe failed/);
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

test("ai5090 profile constructs and probes real inference, STT, and TTS providers", async () => {
  const profile = loadConfig({
    defaults: {
      profile: "ai5090",
      providers: { inference: "ai5090-development", memory: "fixture", stt: "nemo-speech", tts: "voxcpm", world: "fixture", capability: "fixture", renderer: "fixture", clock: "system" },
      providerRequirements: { inference: "required", memory: "required", stt: "required", tts: "required", world: "optional", capability: "optional", renderer: "optional", clock: "required" },
      inferenceProfile: { runtime: "SGLang", runtimeVersion: "v", model: "Qwen", modelRevision: "inference-revision", servedModelName: "qwen", quantization: "q", contextLength: 1, endpoint: "http://inference.invalid", containerImageDigest: "sha256:image", developmentOnly: true },
      sttProfile: { runtime: "NeMo-Speech.cpp", runtimeVersion: "0.1.0", model: "Nemotron", modelRevision: "stt-revision", endpoint: "http://stt.invalid", modelArtifactDigest: "sha256:stt-model", mappingRevision: "nemo-speech-map-1", language: "en-US", developmentOnly: true },
      ttsProfile: { runtime: "PyTorch-CUDA", runtimeVersion: "tts-runtime", model: "VoxCPM2", modelRevision: "tts-revision", quantization: "bf16", endpoint: "http://tts.invalid", voiceBundleKey: "fixture-voice-design", voiceBundleRevision: 1, mappingRevision: "voxcpm2-map-2", developmentOnly: true },
      storage: { databasePath: ":memory:", artifactDirectory: ".artifacts" }, authority: { provider: "fixture", authentication: "fixture" }, secretRefs: {}
    }, profile: {}, environment: {}, cli: {}
  });
  const previousKey = process.env.LIFESTREAM_INFERENCE_API_KEY; process.env.LIFESTREAM_INFERENCE_API_KEY = "test-only-key";
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "http://stt.invalid/health") return Response.json({ status: "ok", version: "0.1.0" });
    if (url === "http://tts.invalid/readyz") return Response.json({ status: "ready", runtimeRevision: "tts-runtime", modelRevision: "tts-revision", mappingRevision: "voxcpm2-map-2" });
    assert.equal(url, "http://inference.invalid/v1/models"); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-key");
    return Response.json({ data: [{ id: "qwen" }] });
  };
  try {
    const registry = createProviderRegistry(profile); await registry.probe();
    assert.equal(registry.providers.inference.fixture, false); assert.equal(registry.providers.inference.status, "healthy");
    assert.equal(registry.providers.stt.fixture, false); assert.equal(registry.providers.stt.status, "healthy");
    assert.equal(registry.providers.tts.fixture, false); assert.equal(registry.providers.tts.status, "healthy");
    assert.equal(registry.ready, true);
    delete process.env.LIFESTREAM_INFERENCE_API_KEY; await registry.probe(); assert.equal(registry.providers.inference.status, "unavailable"); assert.match(registry.providers.inference.reason ?? "", /credential/);
  } finally { globalThis.fetch = original; if (previousKey === undefined) delete process.env.LIFESTREAM_INFERENCE_API_KEY; else process.env.LIFESTREAM_INFERENCE_API_KEY = previousKey; }
});
