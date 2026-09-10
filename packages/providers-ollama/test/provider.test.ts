import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { OllamaInferenceProvider } from "../src/provider.ts";

const request = { sections: [{ kind: "userInput", content: "hello" }], manifest: { schemaVersion: "1.0.0", sections: [], tokenizer: "test" }, deadlineAt: new Date(Date.now() + 1_000).toISOString(), executionMode: "live" as const, scope: { assistantId: "a", sessionId: "s", interactionId: "i", endpointId: null } };

test("Ollama adapter streams native NDJSON and pins model/context identity", async (t) => {
  const server = createServer(async (incoming, response) => {
    assert.equal(incoming.url, "/api/chat");
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; stream: boolean; think: boolean; options: { num_ctx: number } };
    assert.equal(body.model, "qwen3.5:2b-q4_K_M");
    assert.equal(body.stream, true);
    assert.equal(body.think, false);
    assert.equal(body.options.num_ctx, 32768);
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write('{"model":"qwen3.5:2b-q4_K_M","message":{"role":"assistant","content":"hello"},"done":false}\n');
    response.end('{"model":"qwen3.5:2b-q4_K_M","message":{"role":"assistant","content":""},"done":true}\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const chunks = [];
  for await (const chunk of new OllamaInferenceProvider({ endpoint: `http://127.0.0.1:${port}`, model: "qwen3.5:2b-q4_K_M", contextLength: 32768 }).generate(request, { signal: new AbortController().signal })) chunks.push(chunk);
  assert.deepEqual(chunks, [{ kind: "text", text: "hello" }, { kind: "done" }]);
});

test("Ollama adapter fails closed for replay, drift, malformed streams, and limits", async () => {
  const replay = [];
  for await (const chunk of new OllamaInferenceProvider({ endpoint: "http://127.0.0.1:1", model: "qwen3.5:2b-q4_K_M", contextLength: 32768 }).generate({ ...request, executionMode: "replay" }, { signal: new AbortController().signal })) replay.push(chunk);
  assert.equal(replay[0]?.error?.code, "replay_live_provider_forbidden");

  for (const [body, expected] of [
    ['{"model":"different","done":true}\n', "inference_unavailable"],
    ["not-json\n", "malformed_provider_event"],
    ['{"model":"qwen3.5:2b-q4_K_M","message":{"content":"too long"},"done":false}\n', "response_limit"]
  ] as const) {
    const provider = new OllamaInferenceProvider({ endpoint: "http://local.invalid", model: "qwen3.5:2b-q4_K_M", contextLength: 32768, maxResponseBytes: 2 });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(body, { status: 200 });
    try {
      const output = [];
      for await (const chunk of provider.generate(request, { signal: new AbortController().signal })) output.push(chunk);
      assert.equal(output.at(-1)?.error?.code, expected);
    } finally { globalThis.fetch = original; }
  }
});
