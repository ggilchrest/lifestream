import assert from "node:assert/strict";
import test from "node:test";
import { createContractValidator } from "../packages/contracts/src/validator.ts";

test("invalid protocol objects are rejected with safe errors", () => {
  const validator = createContractValidator();
  const result = validator.validate("https://lifestream.dev/contracts/protocol-common/1.0.0", {});
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.deepEqual(Object.keys(result.errors[0] ?? {}).sort(), ["instancePath", "keyword", "message"]);
});
