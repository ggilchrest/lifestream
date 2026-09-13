import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { InferenceChunk, InferenceProvider } from "@lifestream/runtime/inference";
import { streamMessage } from "../src/runtime/inference.ts";

test("typed stream admits one terminal and rejects missing or thrown provider completion", async (t) => {
  for (const mode of ["duplicate", "missing", "throw"] as const) {
    const provider: InferenceProvider = { async *generate(): AsyncIterable<InferenceChunk> { yield { kind: "text", text: "synthetic" }; if (mode === "throw") throw new Error("private provider diagnostics must not escape"); if (mode === "duplicate") { yield { kind: "done" }; yield { kind: "text", text: "late" }; yield { kind: "done" }; } } };
    const server = createServer((_request, response) => { void streamMessage(response, provider, { userInput: "synthetic" }, "session", new AbortController().signal); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`); const body = await response.text();
    assert.equal([...body.matchAll(/event: interaction\.(?:completed|error)/gu)].length, 1); assert.doesNotMatch(body, /private provider diagnostics|"late"/u);
    assert.match(body, mode === "duplicate" ? /event: interaction\.completed/u : /event: interaction\.error/u);
  }
});
