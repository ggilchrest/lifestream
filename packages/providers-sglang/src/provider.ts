import type { InferenceChunk, InferenceProvider, InferenceRequest, ProviderCallContext } from "@lifestream/runtime/inference";
import { createHash } from "node:crypto";

const canonicalKinds = ["policy", "corePersona", "adaptivePersona", "interactionState", "preparedMemory", "worldContext", "capabilityState", "conversation", "userInput"];
const validCanonicalRequest = (request: InferenceRequest): boolean => {
  if (!Array.isArray(request.sections) || request.sections.length !== canonicalKinds.length || request.manifest?.schemaVersion !== "1.0.0" || !request.manifest.tokenizer || request.manifest.sections?.length !== canonicalKinds.length || !Number.isFinite(Date.parse(request.deadlineAt))) return false;
  return request.sections.every((section, index) => {
    if (!section || section.kind !== canonicalKinds[index] || typeof section.content !== "string" || typeof section.sourceRef !== "string" || !section.sourceRef || typeof section.sourceRevision !== "string" || !section.sourceRevision || !["none", "redacted"].includes(section.redaction) || !Number.isInteger(section.tokenCount) || section.tokenCount < 0) return false;
    const trusted = index < 4;
    if (section.trusted !== trusted || section.contentDigest !== createHash("sha256").update(section.content, "utf8").digest("hex")) return false;
    const manifest = request.manifest.sections[index];
    return Boolean(manifest) && ["kind", "sourceRevision", "sourceRef", "contentDigest", "redaction", "tokenCount"].every((key) => manifest![key as keyof typeof manifest] === section[key as keyof typeof section]);
  });
};

export type SglangConfig = { endpoint: string; model: string; apiKey?: string; maxResponseBytes?: number };

export class SglangInferenceProvider implements InferenceProvider {
  private readonly config: SglangConfig;
  constructor(config: SglangConfig) { this.config = config; }
  async *generate(request: InferenceRequest, context: ProviderCallContext): AsyncIterable<InferenceChunk> {
    if (request.executionMode === "replay") { yield { kind: "error", error: { code: "replay_live_provider_forbidden", message: "live inference is unavailable during replay" } }; return; }
    if (!validCanonicalRequest(request)) { yield { kind: "error", error: { code: "invalid_canonical_request", message: "inference requires the ordered canonical sections and matching trusted-source manifest" } }; return; }
    const remainingMs = Date.parse(request.deadlineAt) - Date.now();
    if (remainingMs <= 0) { yield { kind: "error", error: { code: "deadline_exceeded", message: "inference deadline exceeded" } }; return; }
    const controller = new AbortController(); const abort = () => controller.abort(context.signal.reason); context.signal.addEventListener("abort", abort, { once: true });
    if(context.signal.aborted)controller.abort(context.signal.reason);
    let deadlineExceeded = false;
    const deadlineTimer = setTimeout(() => { deadlineExceeded = true; controller.abort(); }, Math.min(remainingMs, 2_147_483_647));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // Only the runtime-owned spoken policy opts into direct-answer decoding.
      // User text cannot select this mode; typed-text decoding remains unchanged.
      const spoken=request.sections.some(section=>section.kind==='policy'&&section.trusted&&section.sourceRef==='policy:spoken-v1');
      const messages = [
        { role: "system", content: request.sections.slice(0, 4).map((section) => `[${section.kind}; trusted]\n${section.content}`).join("\n\n") },
        { role: "user", content: request.sections.slice(4).map((section) => `[${section.kind}; untrusted]\n${section.content}`).join("\n\n") }
      ];
      const response = await fetch(`${this.config.endpoint.replace(/\/$/u, "")}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) }, body: JSON.stringify({ model: this.config.model, stream: true, ...(spoken?{chat_template_kwargs:{enable_thinking:false}}:{}), messages }), signal: controller.signal });
      if (!response.ok || !response.body) { yield { kind: "error", error: { code: "inference_unavailable", message: `inference service returned HTTP ${response.status}` } }; return; }
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let emitted = 0; const max = this.config.maxResponseBytes ?? 64_000;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines=buffer.split('\n');buffer=lines.pop()??'';
        if(Buffer.byteLength(buffer)>max){yield {kind:'error',error:{code:'response_limit',message:'inference stream frame limit exceeded'}};return;}
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") { yield { kind: "done" }; return; }
          try {
            const choice=JSON.parse(data)?.choices?.[0];
            if(choice?.finish_reason==='length'){yield {kind:'error',error:{code:'response_limit',message:'inference provider reached its generation limit'}};return;}
            const text = choice?.delta?.content;
            if (typeof text === "string" && text.length) { emitted += Buffer.byteLength(text); if (emitted > max) { yield { kind: "error", error: { code: "response_limit", message: "inference response limit exceeded" } }; return; } yield { kind: "text", text }; }
          } catch { yield { kind: "error", error: { code: "malformed_provider_event", message: "inference provider returned malformed stream data" } }; return; }
        }
      }
      yield { kind: "error", error:{code:'malformed_provider_event',message:'inference stream ended without a terminal event'} };
    } catch (error) { if (deadlineExceeded) { yield { kind: "error", error: { code: "deadline_exceeded", message: "inference deadline exceeded" } }; return; } if (context.signal.aborted) { yield { kind: "error", error: { code: "cancelled", message: "inference cancelled" } }; return; } yield { kind: "error", error: { code: "inference_unavailable", message: error instanceof Error ? error.message.replace(/https?:\/\/\S+/gu, "[redacted-endpoint]") : "inference unavailable" } }; }
    finally { clearTimeout(deadlineTimer); context.signal.removeEventListener("abort", abort);controller.abort();await reader?.cancel().catch(()=>{});reader?.releaseLock(); }
  }
}
