import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, redactedDigest } from "../src/config/loader.ts";

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
});

test("unknown keys and non-fixture test providers fail closed", () => {
  assert.throws(() => loadConfig({ defaults: { ...base, unknown: true }, profile: {}, environment: {}, cli: {} }), /unknown configuration key/);
  assert.throws(() => loadConfig({ defaults: { ...base, providers: { ...base.providers, memory: "live" } }, profile: {}, environment: {}, cli: {} }), /requires fixture/);
});
