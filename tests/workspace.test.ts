import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("initial package exports are intentionally empty", async () => {
  const paths = [
    "packages/contracts/src/index.ts",
    "packages/runtime/src/index.ts",
    "packages/providers-fixture/src/index.ts",
    "packages/storage-sqlite/src/index.ts"
  ];
  const sources = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  assert.deepEqual(sources, ["export {};\n", "export {};\n", "export {};\n", "export {};\n"]);
});
