import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createContractValidator } from "../src/validator.ts";

test("compiles every exported schema and rejects unknown schema IDs", () => {
  const validator = createContractValidator();
  assert.equal(validator.schemaIds().length, 24);
  assert.equal(validator.validate("unknown", {}).valid, false);
});

test("approved relationship export is byte-bound and retains both prepared-context versions", () => {
  const lock = JSON.parse(readFileSync(new URL("../../../spec-lock.json", import.meta.url), "utf8")) as { additionalExports: Array<{ artifacts: Array<{ publicPath: string; schemaId: string; sha256: string }> }> };
  const validator = createContractValidator();
  const artifacts = lock.additionalExports[0]!.artifacts;
  assert.equal(artifacts.length, 5);
  for (const artifact of artifacts) {
    const bytes = readFileSync(new URL(`../../../${artifact.publicPath}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
    assert.equal(JSON.parse(bytes.toString()).$id, artifact.schemaId);
    assert.ok(validator.schemaIds().includes(artifact.schemaId));
    assert.equal(validator.validate(artifact.schemaId, {}).valid, false);
  }
  assert.ok(validator.schemaIds().includes("https://lifestream.dev/contracts/prepared-context/1.0.0"));
  assert.ok(validator.schemaIds().includes("https://lifestream.dev/contracts/prepared-context/2.0.0"));
});

// Public synthetic inputs; private structural fixtures are not exported.
test("approved extension exports compile and reject forged or unknown request fields", () => {
  const validator = createContractValidator();
  const receipt = JSON.parse(readFileSync(new URL("../../../implementation/evidence/S083-S084-SCHEMA-EXPORT-1.json", import.meta.url), "utf8")) as { artifacts: Array<{ path: string; schemaId: string; sha256: string }> };
  for (const artifact of receipt.artifacts) {
    const bytes = readFileSync(new URL(`../../../${artifact.path}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
    assert.ok(validator.schemaIds().includes(artifact.schemaId));
  }
  for (const api of ["initiative-api", "understanding-api"]) {
    const id = `https://lifestream.dev/contracts/${api}/1.0.0`;
    const request = { schemaVersion: "1.0.0", operation: "inspect" };
    assert.equal(validator.validate(id, request).valid, true);
    for (const extra of [{ authority: true }, { subjectId: "another-user" }, { schemaVersion: "2.0.0" }, { operation: "enableLive" }]) {
      assert.equal(validator.validate(id, { ...request, ...extra }).valid, false);
    }
  }
});
