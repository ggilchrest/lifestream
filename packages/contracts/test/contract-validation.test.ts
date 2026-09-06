import assert from "node:assert/strict";
import test from "node:test";
import { createContractValidator } from "../src/validator.ts";

test("compiles every exported schema and rejects unknown schema IDs", () => {
  const validator = createContractValidator();
  assert.equal(validator.schemaIds().length, 16);
  assert.equal(validator.validate("unknown", {}).valid, false);
});
