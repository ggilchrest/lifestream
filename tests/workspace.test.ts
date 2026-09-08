import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace package exports remain explicit", async () => {
  const paths = [
    "packages/contracts/src/index.ts",
    "packages/runtime/src/index.ts",
    "packages/providers-fixture/src/index.ts",
    "packages/storage-sqlite/src/index.ts"
  ];
  const sources = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  assert.equal(sources[0]?.includes("createContractValidator"), true);
  assert.deepEqual(sources.slice(1), ["export {};\n", "export {};\n", "export { Database } from \"./database.js\";\nexport { AssistantProfileRepository } from \"./assistant-profile.js\";\nexport type { AssistantProfile } from \"./assistant-profile.js\";\n"]);
});
