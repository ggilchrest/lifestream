import assert from "node:assert/strict";
import { test } from "node:test";
import { administrationCapabilities } from "../src/admin/personalization-capabilities.ts";
test("shared administration inventory declares ownership, limits, lifecycle and authority independently of identity", () => {
  const rows = administrationCapabilities();
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
  for (const row of rows) for (const field of ["owner", "version", "scope", "access", "lifecycle", "source", "limits", "precedence", "authorization", "apply", "status"] as const) assert.ok(row[field], `${row.key}: ${field}`);
  assert.equal(rows.find(row => row.key === "voice.training")?.status, "deferred");
  assert.match(rows.find(row => row.key === "assistant.preview")!.limits, /no active state, memory, tools or grants/);
  assert.ok(rows.every(row => /never authority/.test(row.authorization)));
});
