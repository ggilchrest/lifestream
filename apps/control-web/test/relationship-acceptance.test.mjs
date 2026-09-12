import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("joined relationship surface exposes the complete review path and boundaries", async () => {
  const js = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(js, /Start relationship review/);
  assert.match(js, /Save draft/);
  assert.match(js, /Run insight lenses/);
  assert.match(js, /Prepare Lab/);
  assert.match(js, /Run comparison/);
  assert.match(js, /effective-request/);
  assert.match(js, /Inspect prepared request/);
  assert.match(js, /active state was changed/);
  assert.match(js, /held-out/);
  assert.match(js, /Human review/);
});
