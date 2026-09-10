import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, loadProfile, redactedDigest } from "../src/config/loader.ts";

const base = {
  profile: "test",
  providers: { inference: "fixture", memory: "fixture", stt: "fixture", tts: "fixture", world: "fixture", capability: "fixture", renderer: "fixture", clock: "fixture" },
  storage: { databasePath: ":memory:", artifactDirectory: ".artifacts" },
  authority: { provider: "fixture", authentication: "fixture" },
  secretRefs: {}
} as const;

test("configuration precedence and redacted digest are deterministic", () => {
  const first = loadConfig({ defaults: base, profile: {}, environment: { storage: { databasePath: "env" } }, cli: { storage: { databasePath: "cli" }, secretRefs: { token: { kind: "env", name: "TOKEN" } } } });
  const second = loadConfig({ defaults: base, profile: {}, environment: { storage: { databasePath: "env" } }, cli: { storage: { databasePath: "cli" }, secretRefs: { token: { kind: "env", name: "TOKEN" } } } });
  assert.equal(first.storage.databasePath, "cli");
  assert.equal(redactedDigest(first), redactedDigest(second));
  const changed = loadConfig({ defaults: base, profile: {}, environment: {}, cli: { providers: { memory: "fixture" }, providerRequirements: { world: "required" } } });
  assert.notEqual(redactedDigest(first), redactedDigest(changed));
});

test("profiles are explicit and include provider requirements", () => {
  assert.equal(loadProfile("test").profile, "test");
  assert.equal(loadProfile("local-dev").providerRequirements.world, "optional");
  assert.equal(loadProfile("ai5090").providers.inference, "ai5090-development");
  assert.equal(loadProfile("ai5090").providers.stt, "nemo-speech");
  assert.equal(loadProfile("ai5090").providers.tts, "voxcpm");
  assert.equal(loadProfile("ai5090").sttProfile?.model, "nvidia/nemotron-speech-streaming-en-0.6b");
  assert.equal(loadProfile("ai5090").ttsProfile?.model, "openbmb/VoxCPM2");
  const mac = loadProfile("mac-local");
  assert.equal(mac.providers.inference, "ollama-mac-local");
  assert.equal(mac.inferenceProfile?.servedModelName, "qwen3.5:2b-q4_K_M");
  assert.equal(mac.providers.tts, "voxcpm");
  assert.equal(mac.ttsProfile?.model, "mlx-community/VoxCPM2-4bit");
  assert.equal(mac.providers.stt, "moonshine-mlx");
  assert.equal(mac.sttProfile?.model, "moonshine-ai/moonshine-tiny");
  assert.equal(mac.providerRequirements.stt, "required");
});

test("unknown keys and non-fixture test providers fail closed", () => {
  assert.throws(() => loadConfig({ defaults: { ...base, unknown: true }, profile: {}, environment: {}, cli: {} }), /unknown configuration key/);
  assert.throws(() => loadConfig({ defaults: { ...base, providers: { ...base.providers, memory: "live" } }, profile: {}, environment: {}, cli: {} }), /requires fixture/);
  assert.throws(() => loadConfig({ defaults: { ...base, profile: "mac-local", inferenceProfile: { runtime: "Ollama", runtimeVersion: "0.31.1", model: "Qwen", modelRevision: "r", servedModelName: "qwen", quantization: "q4", contextLength: 1, endpoint: "http://127.0.0.1:11434", developmentOnly: true } }, profile: {}, environment: {}, cli: {} }), /runtime artifact digest/);
});
