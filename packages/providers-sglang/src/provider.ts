import type { InferenceChunk, InferenceProvider, InferenceRequest, ProviderCallContext } from "@lifestream/runtime/inference";

export type SglangConfig = { endpoint: string; model: string; apiKey?: string; maxResponseBytes?: number };

export class SglangInferenceProvider implements InferenceProvider {
  private readonly config: SglangConfig;
  constructor(config: SglangConfig) { this.config = config; }
  async *generate(request: InferenceRequest, context: ProviderCallContext): AsyncIterable<InferenceChunk> {
    if (request.executionMode === "replay") { yield { kind: "error", error: { code: "replay_live_provider_forbidden", message: "live inference is unavailable during replay" } }; return; }
    const controller = new AbortController(); const abort = () => controller.abort(context.signal.reason); context.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(`${this.config.endpoint.replace(/\/$/u, "")}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) }, body: JSON.stringify({ model: this.config.model, stream: true, messages: [{ role: "user", content: request.sections.map((section) => `[${section.kind}]\n${section.content}`).join("\n\n") }] }), signal: controller.signal });
      if (!response.ok || !response.body) { yield { kind: "error", error: { code: "inference_unavailable", message: `inference service returned HTTP ${response.status}` } }; return; }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let emitted = 0; const max = this.config.maxResponseBytes ?? 64_000;
      for (;;) { const next = await reader.read(); if (next.done) break; buffer += decoder.decode(next.value, { stream: true }); for (const line of buffer.split("\n")) { if (!line.startsWith("data: ")) continue; const data = line.slice(6).trim(); if (data === "[DONE]") { yield { kind: "done" }; return; } try { const text = JSON.parse(data)?.choices?.[0]?.delta?.content; if (typeof text === "string" && text.length) { emitted += Buffer.byteLength(text); if (emitted > max) { yield { kind: "error", error: { code: "response_limit", message: "inference response limit exceeded" } }; return; } yield { kind: "text", text }; } } catch { yield { kind: "error", error: { code: "malformed_provider_event", message: "inference provider returned malformed stream data" } }; return; } } buffer = buffer.slice(buffer.lastIndexOf("\n") + 1); }
      yield { kind: "done" };
    } catch (error) { if (context.signal.aborted) { yield { kind: "error", error: { code: "cancelled", message: "inference cancelled" } }; return; } yield { kind: "error", error: { code: "inference_unavailable", message: error instanceof Error ? error.message.replace(/https?:\/\/\S+/gu, "[redacted-endpoint]") : "inference unavailable" } }; }
    finally { context.signal.removeEventListener("abort", abort); }
  }
}
