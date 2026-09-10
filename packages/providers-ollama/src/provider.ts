import type { InferenceChunk, InferenceProvider, InferenceRequest, ProviderCallContext } from "@lifestream/runtime/inference";

export type OllamaConfig = {
  endpoint: string;
  model: string;
  contextLength: number;
  maxResponseBytes?: number;
};

type OllamaEvent = {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  error?: string;
};

export class OllamaInferenceProvider implements InferenceProvider {
  private readonly config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
  }

  async *generate(request: InferenceRequest, context: ProviderCallContext): AsyncIterable<InferenceChunk> {
    if (request.executionMode === "replay") {
      yield { kind: "error", error: { code: "replay_live_provider_forbidden", message: "live inference is unavailable during replay" } };
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(`${this.config.endpoint.replace(/\/$/u, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          stream: true,
          think: false,
          messages: [{ role: "user", content: request.sections.map((section) => `[${section.kind}]\n${section.content}`).join("\n\n") }],
          options: { num_ctx: this.config.contextLength }
        }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        yield { kind: "error", error: { code: "inference_unavailable", message: `inference service returned HTTP ${response.status}` } };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const maximumBytes = this.config.maxResponseBytes ?? 64_000;
      let buffer = "";
      let emittedBytes = 0;
      let terminalSeen = false;
      for (;;) {
        const next = await reader.read();
        buffer += decoder.decode(next.value, { stream: !next.done });
        const lines = buffer.split("\n");
        buffer = next.done ? "" : (lines.pop() ?? "");
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: OllamaEvent;
          try { event = JSON.parse(line) as OllamaEvent; }
          catch {
            yield { kind: "error", error: { code: "malformed_provider_event", message: "inference provider returned malformed stream data" } };
            return;
          }
          if (event.error || (event.model !== undefined && event.model !== this.config.model)) {
            yield { kind: "error", error: { code: "inference_unavailable", message: event.error ? "inference provider reported an error" : "inference provider model identity changed" } };
            return;
          }
          const content = event.message?.content;
          if (typeof content === "string" && content.length > 0) {
            emittedBytes += Buffer.byteLength(content);
            if (emittedBytes > maximumBytes) {
              yield { kind: "error", error: { code: "response_limit", message: "inference response limit exceeded" } };
              return;
            }
            yield { kind: "text", text: content };
          }
          if (event.done === true) {
            terminalSeen = true;
            yield { kind: "done" };
            return;
          }
        }
        if (next.done) break;
      }
      if (!terminalSeen) yield { kind: "error", error: { code: "malformed_provider_event", message: "inference provider ended without a terminal event" } };
    } catch (error) {
      if (context.signal.aborted) {
        yield { kind: "error", error: { code: "cancelled", message: "inference cancelled" } };
        return;
      }
      yield { kind: "error", error: { code: "inference_unavailable", message: error instanceof Error ? error.message.replace(/https?:\/\/\S+/gu, "[redacted-endpoint]") : "inference unavailable" } };
    } finally {
      context.signal.removeEventListener("abort", abort);
    }
  }
}
