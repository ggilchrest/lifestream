import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("joined relationship surface exposes the complete review path and boundaries", async () => {
  const js = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(js, /Start relationship review/);
  const tuning=await readFile(new URL("../relationship-tuning.js",import.meta.url),"utf8");
  assert.match(tuning, /Save Draft/);
  const insights=await readFile(new URL("../relationship-insights.js",import.meta.url),"utf8"); assert.match(insights, /Run insight lenses/);
  const lab=await readFile(new URL("../relationship-lab.js",import.meta.url),"utf8"); assert.match(lab, /Prepare Lab/);
  assert.match(lab, /Run comparison/);
  assert.match(tuning, /api\/runtime\/v1\/messages/);
  assert.match(tuning, /Run and Inspect Actual Request/);
  assert.match(insights, /active relationship state unchanged/);
  assert.match(lab, /Held-out/);
  assert.match(lab, /Human review/);
  const builder=await readFile(new URL('../profile-builder.js',import.meta.url),"utf8");
  assert.match(builder,/builder-prerequisite/);
  assert.match(builder,/builder-file-list/);
  assert.match(builder,/renderFileSelection/);
  assert.match(builder,/Start the relationship review first/);
  assert.match(builder,/missingAssistant \|\| missingRelationship/);
});
