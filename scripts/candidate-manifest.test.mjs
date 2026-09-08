import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../implementation/candidate-manifest.json", import.meta.url)));

test("candidate is bounded and names the existing VoxCPM adapter", () => {
  assert.equal(manifest.claimName, "Lifestream VoxCPM2 TTS Development-Host Candidate");
  assert.equal(manifest.claimClass, "bounded-development-host-candidate");
  assert.equal(manifest.production, false);
  assert.equal(manifest.selectedAdapter.package, "packages/providers-voxcpm");
  assert.equal(manifest.selectedAdapter.modelFamily, "VoxCPM2");
  assert.equal(manifest.selectedAdapter.contract, "TextToSpeechProvider 2.0.0");
  assert.equal(manifest.selectedAdapter.decision, "LS-DEC-032");
  assert.ok(!JSON.stringify(manifest).includes("packages/providers-voxcpm2"));
});

test("candidate carries immutable identity and actual evidence references", () => {
  assert.match(manifest.selectedAdapter.modelSnapshot.revision, /^[a-f0-9]{40}$/);
  assert.match(manifest.selectedAdapter.runtimeCommit, /^[a-f0-9]{40}$/);
  assert.match(manifest.selectedAdapter.modelSnapshot.weightsLfsSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.evidence.map((entry) => entry.slice), ["LS-S029", "LS-S050"]);
  assert.equal(manifest.hostBoundary.isolation, "WSL application-level GPU isolation only");
});

test("all LS-S048 material items are reconciled without independent evidence", () => {
  assert.ok(manifest.lsS048OverlapAudit.length >= 9);
  assert.ok(manifest.lsS048OverlapAudit.every((item) => ["satisfied", "absorbed", "superseded", "deferred"].includes(item.disposition)));
  assert.ok(manifest.lsS048OverlapAudit.some((item) => item.item === "fixture/provider conformance and LS-TEST-065 intent" && item.disposition === "absorbed"));
  assert.ok(manifest.knownExclusions.includes("strict container GPU invisibility under WSL"));
  assert.ok(manifest.knownExclusions.includes("final Tifa voice identity and subjective emotional-fidelity acceptance"));
});
