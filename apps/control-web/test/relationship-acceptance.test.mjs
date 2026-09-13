import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("joined relationship surface exposes the complete review path and boundaries", async () => {
  const js = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(js, /Start relationship review/);
  const tuning=await readFile(new URL("../relationship-tuning.js",import.meta.url),"utf8");
  assert.match(tuning, /Save Draft/);
  assert.match(js, /Run insight lenses/);
  assert.match(js, /Prepare Lab/);
  assert.match(js, /Run comparison/);
  assert.match(tuning, /api\/runtime\/v1\/messages/);
  assert.match(tuning, /Run and Inspect Actual Request/);
  assert.match(js, /active state was changed/);
  assert.match(js, /held-out/);
  assert.match(js, /Human review/);
});
